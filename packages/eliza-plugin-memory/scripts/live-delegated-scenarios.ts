// Manual live scenarios for the real Eliza x TinyCloud memory stack — DELEGATION MODE.
//
// Mirrors live-eliza-scenarios.ts but exercises the OpenKey-delegated product path:
//   1. (MANUAL) Human signs in with OpenKey/passkey, creates a TinyCloud session,
//      delegates memory SQL policy to the stable agent DID → writes DELEGATION_FILE.
//   2. (Gated) Agent boots in delegation mode, writes long-term memory + session
//      summary via delegated SQL (step 4).
//   3. (Gated) Separate user-authorized client reads the same rows from the user's
//      space (step 5).
//   4. (Gated) Fresh agent process restores from the same delegation file and hydrates
//      memory (step 6).
//   5. (Gated) T7: TWO delegations registered on ONE storage service; asserts per-space
//      isolation, cross-reads empty, fresh-process restore per space (handoff §5 T7/§8).
//
// This is intentionally opt-in and networked. It is NOT part of `bun test`.
// See docs/openkey-phases/phase-7-runbook.md for manual setup steps 1–3.
// See docs/openkey-phases/phase-7-live-scenario-plan.md for full scope.
//
// Gates (each prints {"skipped":true,"reason":...} and exits 0 when triggered):
//   1. TINYCLOUD_LIVE !== "1"   — master gate, same discipline as live-eliza-scenarios.ts
//   2. No delegation source (DELEGATION_FILE for single-user, or
//      DELEGATION_FILE_A + DELEGATION_FILE_B for T7 multi-user)
//   3. Phase 3 delegated transport not yet ready (import or construction throws)

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  AgentRuntime,
  InMemoryDatabaseAdapter,
  createCharacter,
  type Plugin,
  type UUID,
} from "@elizaos/core";

import tinycloudMemoryPlugin, {
  MEMORY_DB_HANDLE,
  MEMORY_SCHEMA,
  TinyCloudMemoryStorageService,
  EntityClientRegistry,
} from "../src/index";

const DEFAULT_HOST = "https://node.tinycloud.xyz";

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-4222-8222-222222222222" as UUID;
const ROOM_ID = "33333333-3333-4333-8333-333333333333" as UUID;

// T7 multi-user UUIDs — distinct from the single-user constants above.
const ENTITY_A_T7 = "aa000000-0000-4000-8000-000000000001" as UUID;
const ENTITY_B_T7 = "bb000000-0000-4000-8000-000000000002" as UUID;
const ROOM_A_T7 = "cc000000-0000-4000-8000-000000000003" as UUID;
const ROOM_B_T7 = "dd000000-0000-4000-8000-000000000004" as UUID;

interface MemoryServiceProbe {
  storeLongTermMemory(input: unknown): Promise<{ id: UUID; content: string }>;
  getLongTermMemories(
    entityId: UUID,
    category?: string,
    limit?: number,
  ): Promise<Array<{ id: UUID; content: string }>>;
  storeSessionSummary(input: unknown): Promise<{ id: UUID; summary: string }>;
  getCurrentSessionSummary(roomId: UUID): Promise<{ id: UUID; summary: string } | null>;
}

function envString(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value === "" ? undefined : value;
}

async function loadPluginSql(): Promise<Plugin> {
  try {
    const mod = await import("@elizaos/plugin-sql");
    return (mod.default ?? mod.plugin) as Plugin;
  } catch {
    // Published 2.0.0-beta.1 has a Bun export pointing at missing ./src/index.ts.
    // The shipped node dist exists and is the same runtime plugin surface.
    const mod = await import("../node_modules/@elizaos/plugin-sql/src/dist/node/index.node.js");
    return (mod.default ?? mod.plugin) as Plugin;
  }
}

async function bootDelegatedRuntime(params: {
  delegationFile: string;
  agentKey: string | undefined;
  agentKeyFile: string | undefined;
  host: string;
  sqlPlugin: Plugin;
}): Promise<AgentRuntime> {
  // Inject delegation env vars so resolveMemoryClientConfig picks them up.
  process.env.TINYCLOUD_AUTH_MODE = "delegation";
  process.env.TINYCLOUD_DELEGATION_FILE = params.delegationFile;
  delete process.env.TINYCLOUD_AGENT_KEY;
  delete process.env.TINYCLOUD_AGENT_KEY_FILE;
  if (params.agentKey) process.env.TINYCLOUD_AGENT_KEY = params.agentKey;
  if (params.agentKeyFile) process.env.TINYCLOUD_AGENT_KEY_FILE = params.agentKeyFile;
  process.env.TINYCLOUD_HOST = params.host;

  const settings: Record<string, string> = {
    ALLOW_NO_DATABASE: "true",
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_DELEGATION_FILE: params.delegationFile,
    TINYCLOUD_HOST: params.host,
  };
  if (params.agentKey) settings.TINYCLOUD_AGENT_KEY = params.agentKey;
  if (params.agentKeyFile) settings.TINYCLOUD_AGENT_KEY_FILE = params.agentKeyFile;

  const character = createCharacter({
    id: AGENT_ID,
    name: "TinyCloudDelegatedMemoryScenario",
    advancedMemory: true,
    plugins: ["@tinycloud/eliza-plugin-memory", "@elizaos/plugin-sql"],
    settings,
  });

  const runtime = new AgentRuntime({
    agentId: AGENT_ID,
    character,
    plugins: [tinycloudMemoryPlugin, params.sqlPlugin],
    adapter: new InMemoryDatabaseAdapter(),
    settings,
    logLevel: "warn",
  });

  await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

  const storage = await runtime.getServiceLoadPromise("memoryStorage");
  if (!(storage instanceof TinyCloudMemoryStorageService)) {
    throw new Error(
      `Expected TinyCloudMemoryStorageService to own memoryStorage, got ${storage?.constructor?.name}`,
    );
  }

  const memory = await runtime.getServiceLoadPromise("memory");
  if (!memory || memory.constructor.name !== "MemoryService") {
    throw new Error(`Expected Eliza MemoryService, got ${memory?.constructor?.name}`);
  }

  return runtime;
}

// ── T7 multi-user scenario ────────────────────────────────────────────────────
//
// Registers TWO delegations on ONE TinyCloudMemoryStorageService and asserts
// per-space isolation: A's writes land in A's TinyCloud space; B's in B's;
// cross-reads return empty; fresh-process restore per space rehydrates only
// that user's rows (handoff §5 T7, §8, build-plan §10).
//
// CODE ONLY — the live run requires two real passkey-minted delegations and is
// a MANUAL post-run gate (handoff §8). NOT called when TINYCLOUD_LIVE is unset.

interface T7MultiUserResult {
  passed: boolean;
  perSpaceIsolation: {
    aFoundOwn: boolean;
    aSeesB: boolean;
    bFoundOwn: boolean;
    bSeesA: boolean;
    aFoundOwnSummary: boolean;
    bFoundOwnSummary: boolean;
    crossReadsEmpty: boolean;
    passed: boolean;
  };
  freshProcessRestore: {
    aRestored: boolean;
    bRestored: boolean;
    aRestoreSeesB: boolean;
    bRestoreSeesA: boolean;
    passed: boolean;
  };
}

async function runMultiUserScenario(params: {
  delegationFileA: string;
  delegationFileB: string;
  agentKey: string | undefined;
  agentKeyFile: string | undefined;
  host: string;
  scenarioId: string;
}): Promise<T7MultiUserResult> {
  const { delegationFileA, delegationFileB, agentKey, agentKeyFile, host, scenarioId } = params;

  // Read both delegation files — the EntityClientRegistry.registerDelegation API
  // takes the inline serialized string, not a file path.
  const [serializedA, serializedB] = await Promise.all([
    readFile(delegationFileA, "utf8").then((s) => s.trim()),
    readFile(delegationFileB, "utf8").then((s) => s.trim()),
  ]);

  const contentA = `scenario:${scenarioId}:user-A long-term memory via TinyCloud delegated SQL`;
  const contentB = `scenario:${scenarioId}:user-B long-term memory via TinyCloud delegated SQL`;
  const summaryTextA = `scenario:${scenarioId}:user-A session summary stored by multi-user harness`;
  const summaryTextB = `scenario:${scenarioId}:user-B session summary stored by multi-user harness`;

  // ── T7.1: Register BOTH delegations on ONE storage service ─────────────────
  // EntityClientRegistry holds agentKey/host and builds per-user delegation-mode
  // clients (each pointing to a different TinyCloud space — derived from the
  // signed owner of each delegation). The service wraps the registry and exposes
  // the same registerDelegation surface that Milestone C will call.
  const registry = new EntityClientRegistry({
    agentKey,
    agentKeyFile,
    host,
    dbHandle: MEMORY_DB_HANDLE,
  });
  const svc = new TinyCloudMemoryStorageService(undefined as never, { registry });

  await svc.registerDelegation(ENTITY_A_T7, serializedA, ROOM_A_T7);
  await svc.registerDelegation(ENTITY_B_T7, serializedB, ROOM_B_T7);

  // ── T7.2: Write memory as user A and as user B ─────────────────────────────
  // storeLongTermMemory routes via clientFor(entityId), sending each write to
  // the owner's TinyCloud space. Both writes go through the single process-wide
  // write lane (single-writer SQLite invariant, handoff §3).
  const [storedA, storedB] = await Promise.all([
    svc.storeLongTermMemory({
      agentId: AGENT_ID,
      entityId: ENTITY_A_T7,
      category: "semantic",
      content: contentA,
      confidence: 0.9,
      source: "live-multi-user-scenario",
      metadata: { scenarioId, user: "A" },
    } as never),
    svc.storeLongTermMemory({
      agentId: AGENT_ID,
      entityId: ENTITY_B_T7,
      category: "semantic",
      content: contentB,
      confidence: 0.9,
      source: "live-multi-user-scenario",
      metadata: { scenarioId, user: "B" },
    } as never),
  ]);

  const [storedSummaryA, storedSummaryB] = await Promise.all([
    svc.storeSessionSummary({
      agentId: AGENT_ID,
      roomId: ROOM_A_T7,
      entityId: ENTITY_A_T7,
      summary: summaryTextA,
      messageCount: 2,
      lastMessageOffset: 2,
      startTime: new Date(Date.now() - 120_000),
      endTime: new Date(),
      topics: ["user-A-scenario"],
      metadata: { scenarioId, user: "A" },
    } as never),
    svc.storeSessionSummary({
      agentId: AGENT_ID,
      roomId: ROOM_B_T7,
      entityId: ENTITY_B_T7,
      summary: summaryTextB,
      messageCount: 2,
      lastMessageOffset: 2,
      startTime: new Date(Date.now() - 120_000),
      endTime: new Date(),
      topics: ["user-B-scenario"],
      metadata: { scenarioId, user: "B" },
    } as never),
  ]);

  // ── T7.3: Assert A's row in A's space, B's in B's; cross-reads empty ───────
  // getLongTermMemories routes via clientFor(entityId) — each entity has its own
  // client pointing to a different TinyCloud space. A's space has no knowledge of
  // B's rows and vice-versa; the assertions make this structural isolation explicit.
  const [memoriesA, memoriesB] = await Promise.all([
    svc.getLongTermMemories(AGENT_ID, ENTITY_A_T7, { category: "semantic" as never, limit: 20 }),
    svc.getLongTermMemories(AGENT_ID, ENTITY_B_T7, { category: "semantic" as never, limit: 20 }),
  ]);

  const aFoundOwn = (memoriesA as Array<{ id: UUID }>).some((m) => m.id === storedA.id);
  const aSeesB = (memoriesA as Array<{ id: UUID }>).some((m) => m.id === storedB.id);
  const bFoundOwn = (memoriesB as Array<{ id: UUID }>).some((m) => m.id === storedB.id);
  const bSeesA = (memoriesB as Array<{ id: UUID }>).some((m) => m.id === storedA.id);

  // getCurrentSessionSummary routes via clientForRoom(roomId) — room→entity index
  // is populated at registerDelegation time (and again inside storeSessionSummary).
  const [summaryReadA, summaryReadB] = await Promise.all([
    svc.getCurrentSessionSummary(AGENT_ID, ROOM_A_T7),
    svc.getCurrentSessionSummary(AGENT_ID, ROOM_B_T7),
  ]);

  const aFoundOwnSummary = (summaryReadA as { id: UUID } | null)?.id === storedSummaryA.id;
  const bFoundOwnSummary = (summaryReadB as { id: UUID } | null)?.id === storedSummaryB.id;
  const aSeesB_summary = (summaryReadA as { id: UUID } | null)?.id === storedSummaryB.id;
  const bSeesA_summary = (summaryReadB as { id: UUID } | null)?.id === storedSummaryA.id;

  const perSpaceIsolationPassed =
    aFoundOwn && !aSeesB && bFoundOwn && !bSeesA &&
    aFoundOwnSummary && bFoundOwnSummary &&
    !aSeesB_summary && !bSeesA_summary;

  // ── T7.4: Fresh-process restore per space ─────────────────────────────────
  // Simulate a fresh process by constructing brand-new registry+service instances
  // with no shared SWR cache. Each new service sees only the rows in its own
  // TinyCloud space — proving that a single delegation is sufficient to restore
  // exactly one user's memory from the durable store.

  // Restore A only — new registry, only A's delegation registered.
  const registryA2 = new EntityClientRegistry({
    agentKey,
    agentKeyFile,
    host,
    dbHandle: MEMORY_DB_HANDLE,
  });
  const svcA2 = new TinyCloudMemoryStorageService(undefined as never, { registry: registryA2 });
  await svcA2.registerDelegation(ENTITY_A_T7, serializedA, ROOM_A_T7);

  const hydratedA = await svcA2.getLongTermMemories(AGENT_ID, ENTITY_A_T7, {
    category: "semantic" as never,
    limit: 20,
  });
  const hydratedSummaryA = await svcA2.getCurrentSessionSummary(AGENT_ID, ROOM_A_T7);

  // Restore B only — new registry, only B's delegation registered.
  const registryB2 = new EntityClientRegistry({
    agentKey,
    agentKeyFile,
    host,
    dbHandle: MEMORY_DB_HANDLE,
  });
  const svcB2 = new TinyCloudMemoryStorageService(undefined as never, { registry: registryB2 });
  await svcB2.registerDelegation(ENTITY_B_T7, serializedB, ROOM_B_T7);

  const hydratedB = await svcB2.getLongTermMemories(AGENT_ID, ENTITY_B_T7, {
    category: "semantic" as never,
    limit: 20,
  });
  const hydratedSummaryB = await svcB2.getCurrentSessionSummary(AGENT_ID, ROOM_B_T7);

  const aRestored =
    (hydratedA as Array<{ id: UUID }>).some((m) => m.id === storedA.id) &&
    (hydratedSummaryA as { id: UUID } | null)?.id === storedSummaryA.id;
  const bRestored =
    (hydratedB as Array<{ id: UUID }>).some((m) => m.id === storedB.id) &&
    (hydratedSummaryB as { id: UUID } | null)?.id === storedSummaryB.id;
  const aRestoreSeesB = (hydratedA as Array<{ id: UUID }>).some((m) => m.id === storedB.id);
  const bRestoreSeesA = (hydratedB as Array<{ id: UUID }>).some((m) => m.id === storedA.id);

  const freshProcessRestorePassed = aRestored && bRestored && !aRestoreSeesB && !bRestoreSeesA;

  // Stop all service instances.
  await Promise.all([svc.stop(), svcA2.stop(), svcB2.stop()]);

  return {
    passed: perSpaceIsolationPassed && freshProcessRestorePassed,
    perSpaceIsolation: {
      aFoundOwn,
      aSeesB,
      bFoundOwn,
      bSeesA,
      aFoundOwnSummary,
      bFoundOwnSummary,
      crossReadsEmpty: !aSeesB && !bSeesA && !aSeesB_summary && !bSeesA_summary,
      passed: perSpaceIsolationPassed,
    },
    freshProcessRestore: {
      aRestored,
      bRestored,
      aRestoreSeesB,
      bRestoreSeesA,
      passed: freshProcessRestorePassed,
    },
  };
}

async function run(): Promise<void> {
  // Gate 1: master gate — same discipline as live-eliza-scenarios.ts
  if (envString("TINYCLOUD_LIVE") !== "1") {
    console.log(
      JSON.stringify({
        skipped: true,
        reason: "set TINYCLOUD_LIVE=1 to run live Eliza x TinyCloud delegated scenarios",
      }),
    );
    return;
  }

  // Gate 2: delegation source — requires at least one of:
  //   • DELEGATION_FILE / TINYCLOUD_DELEGATION_FILE  (single-user, steps 4–6)
  //   • DELEGATION_FILE_A + DELEGATION_FILE_B         (T7 multi-user per-space isolation)
  // The human produces these files by following the runbook (phase-7-runbook.md).
  const delegationFile =
    envString("DELEGATION_FILE") ?? envString("TINYCLOUD_DELEGATION_FILE");
  const delegationFileA = envString("DELEGATION_FILE_A");
  const delegationFileB = envString("DELEGATION_FILE_B");

  if (!delegationFile && !(delegationFileA && delegationFileB)) {
    console.log(
      JSON.stringify({
        skipped: true,
        reason:
          "provide a delegation source: " +
          "DELEGATION_FILE (or TINYCLOUD_DELEGATION_FILE) for the single-user scenario, " +
          "or DELEGATION_FILE_A + DELEGATION_FILE_B for the T7 multi-user per-space isolation scenario " +
          "(docs/openkey-phases/phase-7-runbook.md)",
      }),
    );
    return;
  }

  // Gate 3: Phase 3 not-ready guard.
  // Import createAgentClient lazily inside try/catch so a tree without
  // delegated-transport.ts (pre-Phase 3) never throws at module load time.
  // Probe delegation mode construction — a "not yet implemented" guard from
  // Phase 3 would throw here, triggering the skip below.
  type AgentClientMod = typeof import("@tinycloud/agent-client");
  let agentClientMod: AgentClientMod;
  const probeFile = delegationFile ?? delegationFileA!;
  try {
    agentClientMod = await import("@tinycloud/agent-client");
    agentClientMod.createAgentClient({
      mode: "delegation",
      delegationFile: probeFile,
      agentKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      JSON.stringify({
        skipped: true,
        reason: `Phase 3 delegated transport is not yet ready: ${msg}`,
      }),
    );
    return;
  }

  // All gates passed. Phase 3 ready, delegation source supplied, TINYCLOUD_LIVE=1.
  const { createAgentClient } = agentClientMod;
  const host = envString("TINYCLOUD_HOST") ?? DEFAULT_HOST;
  const scenarioId = randomBytes(6).toString("hex");

  // Resolve real agent key — Gate 3's probe used a dummy key.
  const agentKey = envString("TINYCLOUD_AGENT_KEY");
  const agentKeyFile = envString("TINYCLOUD_AGENT_KEY_FILE");
  if (!agentKey && !agentKeyFile) {
    console.log(
      JSON.stringify({
        skipped: true,
        reason:
          "set TINYCLOUD_AGENT_KEY (or TINYCLOUD_AGENT_KEY_FILE) to the stable agent identity key",
      }),
    );
    return;
  }

  // Collect results from whichever scenario(s) run.
  let singleUserResult: {
    passed: boolean;
    step4_delegatedWrite: Record<string, unknown>;
    step5_crossClientRead: Record<string, unknown>;
    step6_freshProcessRestore: Record<string, unknown>;
  } | null = null;

  let multiUserResult: T7MultiUserResult | null = null;

  // ── Single-user scenario (steps 4–6) — runs when DELEGATION_FILE is set ────
  if (delegationFile) {
    const sqlPlugin = await loadPluginSql();
    const content = `scenario:${scenarioId}:delegated-agent wrote long-term memory via TinyCloud delegation`;
    const summaryText = `scenario:${scenarioId}:delegated session summary stored by Eliza MemoryService`;

    // Read delegation content once — used for registerDelegation in both runtime1 and runtime2.
    // T4 multi-tenant storage routes via clientFor(entityId); an empty registry throws
    // NoDelegationError, so we must register before any memory operation.
    const serializedDelegation = (await readFile(delegationFile, "utf8")).trim();

    // ─── Step 4: Delegated write ─────────────────────────────────────────────
    // Boot AgentRuntime in TINYCLOUD_AUTH_MODE=delegation using DELEGATION_FILE +
    // agent key. Assert TinyCloudMemoryStorageService owns memoryStorage. Then write
    // a long-term memory and a session summary via MemoryService.
    const runtime1 = await bootDelegatedRuntime({
      delegationFile,
      agentKey,
      agentKeyFile,
      host,
      sqlPlugin,
    });
    const memory1 = (await runtime1.getServiceLoadPromise("memory")) as MemoryServiceProbe;

    // Register delegation before any memory operation — routes clientFor(ENTITY_ID) in
    // the multi-tenant storage to the correct per-user AgentClient (T4 rework).
    const svc1 = (await runtime1.getServiceLoadPromise("memoryStorage")) as TinyCloudMemoryStorageService;
    await svc1.registerDelegation(ENTITY_ID, serializedDelegation, ROOM_ID);

    const storedMemory = await memory1.storeLongTermMemory({
      agentId: AGENT_ID,
      entityId: ENTITY_ID,
      category: "semantic",
      content,
      confidence: 0.92,
      source: "live-delegated-scenarios",
      metadata: { scenarioId, action: "delegated-execute-and-remember" },
    });
    const storedSummary = await memory1.storeSessionSummary({
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      entityId: ENTITY_ID,
      summary: summaryText,
      messageCount: 4,
      lastMessageOffset: 4,
      startTime: new Date(Date.now() - 60_000),
      endTime: new Date(),
      topics: ["delegated-live-scenario"],
      metadata: { scenarioId, workflow: "eliza-delegated-runtime" },
    });

    const immediateMemories = await memory1.getLongTermMemories(ENTITY_ID, "semantic", 20);
    const immediateSummary = await memory1.getCurrentSessionSummary(ROOM_ID);
    await runtime1.stop();

    const step4Passed =
      immediateMemories.some((m) => m.id === storedMemory.id) &&
      immediateSummary?.id === storedSummary.id;

    // ─── Step 5: Cross-client read (separate user-authorized client) ──────────
    // A SEPARATE createAgentClient call reads the same rows by id from the user's
    // SQL space, proving delegated writes landed in the USER's space (not an isolated
    // agent-owned space as would be the case with private-key mode).
    //
    // The read client uses the same delegation file — this is the delegation-only seam.
    // If a web-sdk user session (TinyCloudWeb.signIn + no agent key) becomes available
    // via the runbook, prefer that for a stronger proof. See runbook §step-5-note.
    const crossClientRead = await (async () => {
      const client2 = createAgentClient(
        agentKey != null
          ? {
              mode: "delegation" as const,
              delegationFile,
              host,
              dbHandle: MEMORY_DB_HANDLE,
              agentKey,
            }
          : {
              mode: "delegation" as const,
              delegationFile,
              host,
              dbHandle: MEMORY_DB_HANDLE,
              agentKeyFile: agentKeyFile as string,
            },
      );
      try {
        await client2.signIn();
        await client2.ensureSchema([...MEMORY_SCHEMA]);
        const memoryRows = client2.sql.withRowObjects<{ id: string; content: string }>(
          await client2.sql.query(
            "SELECT id, content FROM long_term_memories WHERE id = ?",
            [storedMemory.id],
          ),
        );
        const summaryRows = client2.sql.withRowObjects<{ id: string; summary: string }>(
          await client2.sql.query(
            "SELECT id, summary FROM session_summaries WHERE id = ?",
            [storedSummary.id],
          ),
        );
        return {
          memoryFound: memoryRows[0]?.id === storedMemory.id,
          memoryContent: memoryRows[0]?.content,
          summaryFound: summaryRows[0]?.id === storedSummary.id,
          summaryText: summaryRows[0]?.summary,
        };
      } finally {
        await client2.stop();
      }
    })();

    const step5Passed = crossClientRead.memoryFound && crossClientRead.summaryFound;

    // ─── Step 6: Fresh-process restore + hydrate ─────────────────────────────
    // Stop, boot a FRESH runtime from the SAME delegation file, and assert that
    // long-term memory + session summary hydrate from TinyCloud.
    const runtime2 = await bootDelegatedRuntime({
      delegationFile,
      agentKey,
      agentKeyFile,
      host,
      sqlPlugin,
    });
    const memory2 = (await runtime2.getServiceLoadPromise("memory")) as MemoryServiceProbe;

    // Register delegation before reading — clientForRoom(ROOM_ID) throws NoDelegationError
    // on a fresh registry until the delegation is registered (T4 multi-tenant storage).
    const svc2 = (await runtime2.getServiceLoadPromise("memoryStorage")) as TinyCloudMemoryStorageService;
    await svc2.registerDelegation(ENTITY_ID, serializedDelegation, ROOM_ID);

    const hydratedMemories = await memory2.getLongTermMemories(ENTITY_ID, "semantic", 20);
    const hydratedSummary = await memory2.getCurrentSessionSummary(ROOM_ID);
    await runtime2.stop();

    const hydratedMemory = hydratedMemories.find((m) => m.id === storedMemory.id);
    const step6Passed = Boolean(hydratedMemory) && hydratedSummary?.id === storedSummary.id;

    singleUserResult = {
      passed: step4Passed && step5Passed && step6Passed,
      step4_delegatedWrite: {
        memoryId: storedMemory.id,
        immediateReadFound: immediateMemories.some((m) => m.id === storedMemory.id),
        summaryId: storedSummary.id,
        immediateSummaryFound: immediateSummary?.id === storedSummary.id,
        passed: step4Passed,
      },
      step5_crossClientRead: {
        ...crossClientRead,
        note: "Read via separate createAgentClient (same delegation file) — proves rows are in USER space",
        passed: step5Passed,
      },
      step6_freshProcessRestore: {
        memoryFound: Boolean(hydratedMemory),
        memoryContent: hydratedMemory?.content,
        summaryFound: hydratedSummary?.id === storedSummary.id,
        summaryText: hydratedSummary?.summary,
        passed: step6Passed,
      },
    };
  }

  // ── T7 multi-user scenario — runs when DELEGATION_FILE_A + DELEGATION_FILE_B set
  if (delegationFileA && delegationFileB) {
    multiUserResult = await runMultiUserScenario({
      delegationFileA,
      delegationFileB,
      agentKey,
      agentKeyFile,
      host,
      scenarioId,
    });
  }

  const passed =
    (singleUserResult?.passed ?? true) && (multiUserResult?.passed ?? true);

  console.log(
    JSON.stringify(
      {
        passed,
        host,
        scenarioId,
        scenarios: {
          ...(singleUserResult
            ? {
                step4_delegatedWrite: singleUserResult.step4_delegatedWrite,
                step5_crossClientRead: singleUserResult.step5_crossClientRead,
                step6_freshProcessRestore: singleUserResult.step6_freshProcessRestore,
              }
            : {}),
          ...(multiUserResult
            ? {
                t7_multiUserIsolation: {
                  note: "T7: two delegations on one storage service — per-space isolation + cross-reads empty + fresh-process restore",
                  ...multiUserResult,
                },
              }
            : {}),
        },
      },
      null,
      2,
    ),
  );

  if (!passed) process.exit(1);
}

void run().catch((err) => {
  console.log(
    JSON.stringify(
      {
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
