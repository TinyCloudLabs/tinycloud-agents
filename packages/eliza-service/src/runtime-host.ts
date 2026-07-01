// RuntimeHost — boots and caches one AgentRuntime per agentId.
//
// T3 full implementation:
//  - Map<agentId, AgentRuntime>; lazy boot-on-first-use via runtimeFor()/storageFor()
//  - agentDid derived from TINYCLOUD_AGENT_KEY_FILE via agentIdentityFromFile()
//  - Graceful stop(): storageService.stop() per booted runtime, then runtime.stop()
//  - _bootFactory injection seam for unit tests (no live node)
//  - Embedding seam (Milestone F): documented no-op hook at the bottom of boot
//
// Invariants (plan §0/§2/§4):
//  - C consumes B ONLY through storageService.registerDelegation() (T4) and
//    runtime.messageService.handleMessage() (T5). No write path bypasses B's lane.
//  - agentKey / normalizedKey must NEVER appear in console output, error messages,
//    or SSE frames.
//  - Do NOT import the agent-client factory here.

import {
  AgentRuntime,
  InMemoryDatabaseAdapter,
  createCharacter,
} from "@elizaos/core";
import type { IAgentRuntime, ModelTypeName, UUID } from "@elizaos/core";
import { agentIdentityFromFile, type AgentIdentity } from "@tinycloud/agent-client";
import tinycloudMemoryPlugin, {
  TinyCloudMemoryStorageService,
} from "@tinycloud/eliza-plugin-memory";
import { webSearchPlugin } from "./actions/web-search.js";
import { deriveAgentIdentity } from "./agents/derive-key.js";
import { TINYCHAT_AGENT_ID } from "./auth/app-registry.js";

const DEFAULT_AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const DEFAULT_HOST = "https://node.tinycloud.xyz";

/**
 * Bare model handler signature accepted by AgentRuntime.registerModel().
 * (ModelHandler in @elizaos/core wraps this function plus provider/priority; the
 * runtime API takes the function directly.)
 */
export type TestModelHandler = (
  runtime: IAgentRuntime,
  params: Record<string, unknown>,
) => Promise<string>;

export interface BootedRuntime {
  runtime: IAgentRuntime;
  /** Null in stub mode (no TinyCloud plugin registered). */
  storageService: TinyCloudMemoryStorageService | null;
  agentId: UUID;
}

/**
 * Per-agentId boot factory.
 * Injected via RuntimeHostConfig._bootFactory in unit tests so tests never hit a
 * live TinyCloud node. Production code must not set this field.
 */
export type BootFactory = (agentId: UUID) => Promise<BootedRuntime>;

export interface RuntimeHostConfig {
  /**
   * Path to the agent key file. Falls back to the TINYCLOUD_AGENT_KEY_FILE env var.
   * File content must be a hex Ethereum private key (with or without 0x prefix).
   * Used only by init() — not needed for stub mode or when _bootFactory is set.
   */
  agentKeyFile?: string;
  /** TinyCloud node host URL. Defaults to https://node.tinycloud.xyz. */
  host?: string;
  /**
   * @elizaos/plugin-sql plugin instance (required for production boot; caller
   * dynamic-imports it to avoid bun/node rollup false-fails at build time).
   */
  sqlPlugin?: import("@elizaos/core").Plugin;
  /**
   * Stub mode: no TinyCloud plugin, no live node, InMemoryDatabaseAdapter.
   * Used by bootStubRuntime(). Takes lower precedence than _bootFactory.
   */
  stubMode?: boolean;
  /**
   * Override the per-agentId boot factory (unit tests only).
   * When set, every _bootOnce call uses this factory for every agentId instead of
   * the production or stub boot paths.
   * Production code must never set this field.
   */
  _bootFactory?: BootFactory;
  /**
   * TEST-ONLY model injection seam (live harness gate only — NEVER set in prod).
   *
   * Prod boots with no TEXT model registered (decision 3 keeps memory text off
   * third-party services; prod will use a TEE/local model). The Milestone C live
   * gate must drive REAL post-turn extraction, which requires a TEXT model. These
   * handlers are registered onto the runtime AFTER initialize() in _bootProduction
   * so the advanced-memory evaluator can run. Each key is a ModelType
   * (e.g. "TEXT_LARGE"); the value is a bare registerModel handler.
   *
   * Production code must never set this field.
   */
  _modelHandlers?: Partial<Record<ModelTypeName, TestModelHandler>>;
  /**
   * TEST-ONLY extra character settings merged into the production boot's
   * delegationSettings (live harness gate only — NEVER set in prod).
   *
   * Used by the Milestone C live gate to lower the advanced-memory extraction
   * threshold/interval (MEMORY_EXTRACTION_THRESHOLD / MEMORY_EXTRACTION_INTERVAL)
   * so a single fact-bearing turn deterministically fires the long-term memory
   * evaluator. MemoryService reads these via runtime.getSetting() at boot, so they
   * must be present in character.settings before runtime.initialize().
   *
   * Production code must never set this field.
   */
  _extraSettings?: Record<string, string>;
}

/**
 * RuntimeHost — hosts one or more AgentRuntimes keyed by agentId.
 *
 * One runtime now, structured behind Map<agentId, AgentRuntime> so a second
 * character can be added later without a rewrite. All runtimes share the same
 * agent key (loaded from TINYCLOUD_AGENT_KEY_FILE). In tests, all runtimes share
 * whatever storage service the injected _bootFactory returns.
 *
 * C reaches B ONLY through:
 *   storageService.registerDelegation(entityId, serialized, roomId?) — T4
 *   runtime.messageService.handleMessage(runtime, message, callback)  — T5
 */
export class RuntimeHost {
  private readonly _runtimes = new Map<string, BootedRuntime>();
  /** Pending boot promises per agentId — deduplicates concurrent first-boot calls. */
  private readonly _pending = new Map<string, Promise<BootedRuntime>>();

  private _agentDid = "";
  private _normalizedKey = "";
  /** Per-agentId identity cache (DID + derived key). Master-key agentId maps to the master identity. */
  private readonly _identities = new Map<string, AgentIdentity>();
  /** Deduplicates concurrent first-derive calls per agentId. */
  private readonly _identityPending = new Map<string, Promise<AgentIdentity>>();

  readonly config: RuntimeHostConfig;

  constructor(config: RuntimeHostConfig = {}) {
    this.config = config;
  }

  /**
   * Derive the stable agent DID from the key file and cache it.
   * Must be called once before agentDid / runtimeFor / storageFor in production mode.
   * Idempotent: subsequent calls are no-ops.
   */
  async init(): Promise<void> {
    if (this._agentDid) return;
    const keyFile = this.config.agentKeyFile ?? process.env.TINYCLOUD_AGENT_KEY_FILE;
    if (!keyFile) {
      throw new Error(
        "RuntimeHost.init: agent key file not configured — " +
          "set TINYCLOUD_AGENT_KEY_FILE or pass agentKeyFile in config",
      );
    }
    const identity = await agentIdentityFromFile(keyFile);
    this._agentDid = identity.did;
    this._normalizedKey = identity.normalizedKey;
    // Back-compat: tinychat's frozen agentId keeps the master-key identity (DID unchanged).
    // Every other agentId derives a distinct per-agent key via identityFor().
    this._identities.set(TINYCHAT_AGENT_ID, identity);
  }

  /**
   * The stable DID this service advertises as the delegation target.
   * Format: did:pkh:eip155:1:{address}
   * Available after init() resolves.
   */
  get agentDid(): string {
    return this._agentDid;
  }

  /**
   * Resolve (deriving + caching once) the {@link AgentIdentity} for agentId.
   *
   * The tinychat master-key agentId is seeded in init() and returns the master
   * identity unchanged (DID stable for back-compat). Every other agentId derives
   * a distinct per-agent key via HMAC(masterKey, "tinycloud-agent:v1:"+agentId).
   * Requires init() to have run so the master key is loaded.
   */
  async identityFor(agentId: string): Promise<AgentIdentity> {
    const cached = this._identities.get(agentId);
    if (cached) return cached;

    const pending = this._identityPending.get(agentId);
    if (pending) return pending;

    if (!this._normalizedKey) {
      throw new Error("RuntimeHost.identityFor: call init() before deriving agent identities");
    }

    const promise = deriveAgentIdentity(this._normalizedKey, agentId).then((identity) => {
      this._identities.set(agentId, identity);
      this._identityPending.delete(agentId);
      return identity;
    });
    this._identityPending.set(agentId, promise);
    return promise;
  }

  /**
   * Convenience: the DID to advertise as the delegation target for agentId.
   * Threaded into the sessions handlers so each agent validates delegations against
   * its own DID rather than the single service DID.
   */
  async agentDidFor(agentId: string): Promise<string> {
    return (await this.identityFor(agentId)).did;
  }

  /**
   * Return (booting if needed) the AgentRuntime for agentId.
   * Second call with the same agentId returns the cached instance — boots exactly once.
   */
  async runtimeFor(agentId: string): Promise<IAgentRuntime> {
    return (await this._bootOnce(agentId as UUID)).runtime;
  }

  /**
   * Return (booting if needed) the storage service for agentId.
   * Second call with the same agentId returns the cached instance — boots exactly once.
   * Throws if the booted runtime has no storage service (stub mode without plugin).
   */
  async storageFor(agentId: string): Promise<TinyCloudMemoryStorageService> {
    const booted = await this._bootOnce(agentId as UUID);
    if (!booted.storageService) {
      throw new Error(
        `RuntimeHost.storageFor: no storage service for agentId ${agentId} ` +
          "(stub mode has no TinyCloud plugin; use production boot or inject via _bootFactory)",
      );
    }
    return booted.storageService;
  }

  /**
   * Pre-flight the per-user delegation before opening an SSE response.
   *
   * T1 proved delegation registry failures are swallowed inside Eliza's state
   * composition path, so /messages must check the registry before streaming.
   * This is a read-only liveness probe; it does not construct clients or write.
   */
  async preflight(agentId: string, entityId: string): Promise<void> {
    const storage = await this.storageFor(agentId);
    const registry = (
      storage as unknown as {
        requireRegistry?: () => { clientFor(entityId: string): unknown };
      }
    ).requireRegistry?.call(storage);

    if (!registry?.clientFor) {
      throw new Error("RuntimeHost.preflight: storage registry unavailable");
    }

    registry.clientFor(entityId);
  }

  /**
   * Boot (or return cached) the full BootedRuntime for agentId.
   * Convenience entry point used by bootStubRuntime() and callers that need the
   * full BootedRuntime object rather than just the runtime or storage service.
   */
  async boot(agentId: UUID): Promise<BootedRuntime> {
    return this._bootOnce(agentId);
  }

  /**
   * Graceful shutdown.
   * For each booted runtime: stops its storage service (flushes all per-user
   * AgentClient instances via B's EntityClientRegistry), then stops the runtime.
   * Clears the internal map so the host can be GC'd cleanly.
   */
  async stop(): Promise<void> {
    for (const { runtime, storageService } of this._runtimes.values()) {
      if (storageService) await storageService.stop();
      await runtime.stop();
    }
    this._runtimes.clear();
    this._pending.clear();
  }

  // ── Embedding seam (Milestone F) ─────────────────────────────────────────────
  // F will register the local 384-dim embedder here after booting each runtime and
  // flip longTermVectorSearchEnabled on the runtime's character settings.
  // Leave as a documented no-op until F is wired.
  //
  // protected async _registerEmbedder(_runtime: IAgentRuntime): Promise<void> {
  //   // F: await localEmbedderPlugin.register(runtime);
  //   // F: runtime.character.settings.longTermVectorSearchEnabled = true;
  // }

  // ── Internal: boot lifecycle ─────────────────────────────────────────────────

  private _bootOnce(agentId: UUID): Promise<BootedRuntime> {
    const cached = this._runtimes.get(agentId);
    if (cached) return Promise.resolve(cached);

    const pending = this._pending.get(agentId);
    if (pending) return pending;

    const bootFn: () => Promise<BootedRuntime> = this.config._bootFactory
      ? () => this.config._bootFactory!(agentId)
      : this.config.stubMode
        ? () => this._bootStub(agentId)
        : () => this._bootProduction(agentId);

    const promise = bootFn().then((booted) => {
      this._runtimes.set(agentId, booted);
      this._pending.delete(agentId);
      return booted;
    });

    this._pending.set(agentId, promise);
    return promise;
  }

  // ── Stub boot (T1 spike, no live node) ───────────────────────────────────────

  private async _bootStub(agentId: UUID): Promise<BootedRuntime> {
    const character = createCharacter({
      id: agentId,
      name: "TinyCloudElizaServiceStub",
      // No advancedMemory in stub mode — keeps the provider set minimal and avoids
      // TinyCloud-plugin initialization errors (no private key, no live node).
      advancedMemory: false,
    });

    const runtime = new AgentRuntime({
      agentId,
      character,
      plugins: [],
      adapter: new InMemoryDatabaseAdapter(),
      settings: { ALLOW_NO_DATABASE: "true" },
      // Disable shouldRespond evaluation so handleMessage always attempts a response
      // even without room context or LLM model — required for the T1 spike test.
      checkShouldRespond: false,
      logLevel: "error",
    });

    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

    return { runtime, storageService: null, agentId };
  }

  // ── Production boot (delegation + multi-tenant; env/settings shape mirrors
  //    live-delegated-scenarios.ts bootDelegatedRuntime(), minus the boot
  //    delegation — per-user delegations arrive via registerDelegation()) ──────

  private async _bootProduction(agentId: UUID): Promise<BootedRuntime> {
    const { host = DEFAULT_HOST, sqlPlugin } = this.config;
    if (!this._normalizedKey) {
      throw new Error(
        "RuntimeHost._bootProduction: call init() before booting production runtimes",
      );
    }
    if (!sqlPlugin) {
      throw new Error(
        "RuntimeHost._bootProduction: sqlPlugin required — " +
          "pass @elizaos/plugin-sql instance in config",
      );
    }

    // Resolve the PER-AGENT key for this agentId. The EntityClientRegistry reads
    // TINYCLOUD_AGENT_KEY from character.settings via resolveMemoryClientConfig, so
    // config flows entirely through delegationSettings below — NO process.env
    // mutation (a global write would race/cross-contaminate two agents booting on
    // different keys). Multi-tenant shared mode has no dedicated agent memory-space
    // key, so TINYCLOUD_PRIVATE_KEY is left unset.
    const { normalizedKey: agentKey } = await this.identityFor(agentId);

    const delegationSettings: Record<string, string> = {
      ALLOW_NO_DATABASE: "true",
      TINYCLOUD_AUTH_MODE: "delegation",
      TINYCLOUD_MULTI_TENANT: "1",
      TINYCLOUD_AGENT_KEY: agentKey,
      TINYCLOUD_HOST: host,
      // TEST-ONLY: live-gate threshold overrides (no-op in prod where _extraSettings
      // is unset). Must be in character.settings before initialize() so MemoryService
      // picks them up via runtime.getSetting().
      ...(this.config._extraSettings ?? {}),
    };

    const character = createCharacter({
      id: agentId,
      name: "TinyCloudElizaService",
      advancedMemory: true,
      plugins: ["@tinycloud/eliza-plugin-memory", "@elizaos/plugin-sql"],
      settings: delegationSettings,
    });

    // webSearchPlugin is passed as an instance only (no character.plugins string):
    // it is a local plugin with no installable package name to resolve. Its action
    // is pure-API (no useModel) so it works with no TEXT model registered in prod.
    const runtime = new AgentRuntime({
      agentId,
      character,
      plugins: [tinycloudMemoryPlugin, sqlPlugin, webSearchPlugin],
      adapter: new InMemoryDatabaseAdapter(),
      settings: delegationSettings,
      logLevel: "warn",
    });

    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

    // TEST-ONLY model injection (live-gate only; _modelHandlers is unset in prod).
    // registerModel works post-initialize: handlers are pushed into runtime.models
    // and resolved lazily by useModel(). Required so the advanced-memory evaluator
    // (useModel TEXT_LARGE) and the response pipeline have a TEXT model to call.
    if (this.config._modelHandlers) {
      for (const [modelType, handler] of Object.entries(this.config._modelHandlers)) {
        if (handler) {
          (runtime as unknown as {
            registerModel(t: string, h: TestModelHandler, provider: string): void;
          }).registerModel(modelType, handler, "tinycloud-eliza-service-test");
        }
      }
    }

    // Resolve the storage service the same way live-eliza-scenarios.ts does (line 122).
    const storageService = await runtime.getServiceLoadPromise("memoryStorage");
    if (!(storageService instanceof TinyCloudMemoryStorageService)) {
      throw new Error(
        `RuntimeHost._bootProduction: expected TinyCloudMemoryStorageService ` +
          `for agentId ${agentId}, got: ${storageService?.constructor?.name}`,
      );
    }

    // Embedding seam (Milestone F): _registerEmbedder would be called here.
    // await this._registerEmbedder(runtime);

    return { agentId, runtime, storageService };
  }
}

/**
 * Convenience function for T1 spike tests: boots a single stub runtime with no
 * TinyCloud plugin and no live node. storageService is null in the returned BootedRuntime.
 */
export async function bootStubRuntime(agentId?: UUID): Promise<BootedRuntime> {
  const id = agentId ?? DEFAULT_AGENT_ID;
  const host = new RuntimeHost({ stubMode: true });
  return host.boot(id);
}
