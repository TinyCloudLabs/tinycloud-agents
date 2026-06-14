// EntityClientRegistry — routes SQL calls to the per-user delegated AgentClient
// that owns the user's TinyCloud space.
//
// T3 FULL: real delegation-mode client build, LRU+TTL, concurrent-registration
// dedup, and per-user failure isolation.
//
// T1 test seam preserved: inject pre-built clients via deps.clients.

import { createAgentClient, DelegationPolicyError, deserializeDelegationSafe } from "@tinycloud/agent-client";
import type { AgentClient, DelegationAgentClientConfig } from "@tinycloud/agent-client";

import { MEMORY_DB_HANDLE, MEMORY_SCHEMA } from "./schema";
import { runWrite as processRunWrite } from "./write-lane";

/** Thrown when no delegation is registered for the requested entity or room. */
export class NoDelegationError extends Error {
  readonly entityId: string;
  constructor(entityId: string) {
    super(`NoDelegationError: no delegation registered for entity "${entityId}"`);
    this.name = "NoDelegationError";
    this.entityId = entityId;
  }
}

/**
 * Thrown when signIn signals EXPIRED (DelegationPolicyError reason="EXPIRED")
 * or when a client's idle TTL lapses in clientFor.
 */
export class DelegationExpiredError extends Error {
  readonly entityId: string;
  constructor(entityId: string, options?: { cause?: unknown }) {
    super(`DelegationExpiredError: delegation expired for entity "${entityId}"`);
    this.name = "DelegationExpiredError";
    this.entityId = entityId;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

interface RegistryEntry {
  client: AgentClient;
  lastUsed: number;
  registeredAt: number;
  /** Expiry extracted from the signed delegation (build-plan §7). Undefined when unknown. */
  delegationExpiry?: Date;
}

/**
 * Constructor deps.
 *
 * Two seams:
 *   1. T1 test seam — inject pre-built clients via `clients`.
 *   2. T3 prod path — supply `createClient` factory (or default createAgentClient)
 *      plus `agentKey`/`agentKeyFile`, `host`, `dbHandle`, `runWrite`.
 */
export interface EntityClientRegistryDeps {
  /** Pre-built clients keyed by entityId (T1 test seam). */
  clients?: Map<string, AgentClient>;
  /** Per-entity delegation expiry for the T1 pre-built client seam (tests only). */
  clientExpiries?: Map<string, Date>;
  /** Pre-populated room→entityId index. */
  roomIndex?: Map<string, string>;
  /**
   * Factory for building delegation-mode clients.
   * Default: createAgentClient from @tinycloud/agent-client.
   * Tests inject a mock here to avoid live node I/O.
   */
  createClient?: (config: DelegationAgentClientConfig) => AgentClient;
  /**
   * Write lane for routing ensureSchema writes.
   * Default: the process-wide runWrite from write-lane.ts.
   *
   * FOR TEST INJECTION ONLY — must be combined with deps.clients (T1 pre-built seam)
   * or deps.createClient (T3 mock factory). Supplying runWrite without either seam
   * bypasses the process-wide SQLite single-writer lane and is a configuration error;
   * the constructor throws to prevent accidental prod misuse.
   */
  runWrite?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Shared stable agent key (all users delegate to the same agent DID). */
  agentKey?: string;
  /** Path to file containing the stable agent key. */
  agentKeyFile?: string;
  /** TinyCloud node host. */
  host?: string;
  /** SQL db handle (FIXED — only the space varies). Defaults to MEMORY_DB_HANDLE. */
  dbHandle?: string;
  /**
   * Max concurrent clients in the LRU cache.
   * Env: ELIZA_REGISTRY_MAX_CLIENTS. Default 256.
   */
  maxClients?: number;
  /**
   * Client idle TTL in ms — entries unused longer than this are evicted on clientFor.
   * Env: ELIZA_REGISTRY_TTL_MS. Default 4h.
   */
  ttlMs?: number;
}

const DEFAULT_MAX_CLIENTS = Number(process.env.ELIZA_REGISTRY_MAX_CLIENTS) || 256;
const DEFAULT_TTL_MS = Number(process.env.ELIZA_REGISTRY_TTL_MS) || 4 * 60 * 60 * 1000;

/**
 * Maps entityId → AgentClient and roomId → entityId for per-user delegation routing.
 *
 * Public API (stable across T1→T3):
 *   registerDelegation(entityId, serializedDelegation, roomId?)  async
 *   clientFor(entityId): AgentClient          — throws NoDelegationError / DelegationExpiredError
 *   clientForRoom(roomId): AgentClient        — resolves via room→entity map, then clientFor
 *
 * Invariants:
 *   - One user's bad/expired delegation throws only in its own call, never in another's.
 *   - LRU eviction calls client.stop() and drops room mappings.
 *   - Concurrent registerDelegation calls for the same entity are deduplicated.
 */
export class EntityClientRegistry {
  private readonly entries: Map<string, RegistryEntry>;
  private readonly roomToEntity: Map<string, string>;
  private readonly createClientFn: (config: DelegationAgentClientConfig) => AgentClient;
  private readonly runWriteFn: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly agentKey?: string;
  private readonly agentKeyFile?: string;
  private readonly host?: string;
  private readonly dbHandle: string;
  private readonly maxClients: number;
  private readonly ttlMs: number;
  /**
   * In-flight registerDelegation promises per entityId — deduplicates concurrent
   * first-time registrations so only one client build runs per entity.
   */
  private readonly pending: Map<string, Promise<void>>;

  constructor(deps: EntityClientRegistryDeps = {}) {
    // Guard: runWrite without a test seam (clients or createClient) indicates accidental
    // prod misuse that would bypass the process-wide SQLite single-writer invariant.
    if (deps.runWrite !== undefined && deps.clients === undefined && deps.createClient === undefined) {
      throw new Error(
        "EntityClientRegistryDeps: runWrite override requires deps.clients or deps.createClient " +
          "(test-only seam). Supplying runWrite alone bypasses the process-wide write lane.",
      );
    }
    this.createClientFn = deps.createClient ?? ((config) => createAgentClient(config));
    this.runWriteFn = deps.runWrite ?? processRunWrite;
    this.agentKey = deps.agentKey;
    this.agentKeyFile = deps.agentKeyFile;
    this.host = deps.host;
    this.dbHandle = deps.dbHandle ?? MEMORY_DB_HANDLE;
    this.maxClients = deps.maxClients ?? DEFAULT_MAX_CLIENTS;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.pending = new Map();

    // Populate from pre-built clients (T1 test seam).
    const now = Date.now();
    this.entries = new Map();
    if (deps.clients) {
      for (const [entityId, client] of deps.clients) {
        const delegationExpiry = deps.clientExpiries?.get(entityId);
        this.entries.set(entityId, { client, lastUsed: now, registeredAt: now, delegationExpiry });
      }
    }

    this.roomToEntity = deps.roomIndex ? new Map(deps.roomIndex) : new Map();
  }

  /**
   * Register a delegation for the given entity and optionally bind a room.
   *
   * - Wire the room→entity mapping synchronously (before any await) so callers
   *   that do not await (T1 test seam) see the mapping immediately.
   * - If a pre-built client is in the map (T1 seam), just updates lastUsed and returns.
   * - Otherwise, builds a delegation-mode client, calls signIn, then routes ensureSchema
   *   through the write lane. Concurrent calls for the same entity are deduplicated.
   *
   * @throws {DelegationExpiredError} when signIn signals the delegation is EXPIRED.
   * @throws re-throws any other signIn / ensureSchema errors to the caller only.
   */
  async registerDelegation(
    entityId: string,
    serializedDelegation: string,
    roomId?: string,
  ): Promise<void> {
    // Wire room synchronously FIRST — before any await — for T1 sync test compatibility.
    if (roomId) this.roomToEntity.set(roomId, entityId);

    // Pre-built client (T1 seam) — just touch lastUsed.
    const existing = this.entries.get(entityId);
    if (existing) {
      existing.lastUsed = Date.now();
      return;
    }

    // Deduplicate concurrent first-time registrations for the same entity.
    const inFlight = this.pending.get(entityId);
    if (inFlight) {
      await inFlight;
      return;
    }

    const work = this._buildEntry(entityId, serializedDelegation);
    this.pending.set(entityId, work);
    try {
      await work;
    } finally {
      this.pending.delete(entityId);
    }
  }

  /**
   * Return the AgentClient registered for entityId.
   * Updates lastUsed (LRU touch) on success.
   *
   * @throws {NoDelegationError} when no client is registered for this entity.
   * @throws {DelegationExpiredError} when the entry's idle TTL has lapsed.
   */
  clientFor(entityId: string): AgentClient {
    const entry = this.entries.get(entityId);
    if (!entry) {
      throw new NoDelegationError(entityId);
    }

    // Check signed delegation expiry first — enables re-mint UX trigger (build-plan §7).
    if (entry.delegationExpiry !== undefined && Date.now() >= entry.delegationExpiry.getTime()) {
      void this._evict(entityId);
      throw new DelegationExpiredError(entityId);
    }

    if (Date.now() - entry.lastUsed > this.ttlMs) {
      // Evict async (fire and forget) — the entry is gone from the caller's perspective.
      void this._evict(entityId);
      throw new DelegationExpiredError(entityId);
    }

    entry.lastUsed = Date.now();
    return entry.client;
  }

  /**
   * Return the AgentClient for the entity that owns roomId.
   *
   * @throws {NoDelegationError} when the room has no entity mapping, or the
   *   mapped entity has no registered client.
   * @throws {DelegationExpiredError} when the mapped entity's TTL has lapsed.
   */
  clientForRoom(roomId: string): AgentClient {
    const entityId = this.roomToEntity.get(roomId);
    if (!entityId) {
      throw new NoDelegationError(roomId);
    }
    return this.clientFor(entityId);
  }

  /**
   * Wire a room→entity mapping without accepting or consuming a serializedDelegation.
   * Used by storeSessionSummary after a successful write to bind room routing when
   * the entity's client is already registered.
   * Precondition: entityId must already be registered (clientFor succeeded above).
   */
  bindRoom(entityId: string, roomId: string): void {
    this.roomToEntity.set(roomId, entityId);
  }

  /**
   * Stop all registered clients: flush timers, reject queued work, close connections.
   * Called by TinyCloudMemoryStorageService.stop() so process shutdown cleanly
   * tears down per-user clients rather than leaving refresh timers dangling.
   */
  async stop(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map((e) => e.client.stop()));
    this.entries.clear();
    this.roomToEntity.clear();
  }

  // ── private helpers ──────────────────────────────────────────────────────────

  private async _buildEntry(entityId: string, serializedDelegation: string): Promise<void> {
    // Extract delegation expiry for proactive re-mint UX (build-plan §7).
    // Malformed serializations: signIn will also fail below; expiry stays undefined.
    let delegationExpiry: Date | undefined;
    try {
      const parsed = deserializeDelegationSafe(serializedDelegation);
      const rawExpiry = (parsed as { expiry?: unknown }).expiry;
      if (rawExpiry !== undefined) {
        const d = rawExpiry instanceof Date ? rawExpiry : new Date(rawExpiry as string);
        if (!isNaN(d.getTime())) delegationExpiry = d;
      }
    } catch {
      // Malformed — signIn below will also reject; delegationExpiry stays undefined.
    }

    const config: DelegationAgentClientConfig = {
      mode: "delegation",
      serializedDelegation,
      host: this.host,
      dbHandle: this.dbHandle,
      agentKey: this.agentKey,
      agentKeyFile: this.agentKeyFile,
    };

    const client = this.createClientFn(config);

    try {
      await client.signIn();
    } catch (err) {
      // Flush the half-built client before surfacing the error.
      await client.stop().catch(() => {});
      if (isExpiredError(err)) {
        throw new DelegationExpiredError(entityId, { cause: err });
      }
      throw err;
    }

    // Route ensureSchema through the write lane (single-writer SQLite invariant).
    await this.runWriteFn(() => client.ensureSchema([...MEMORY_SCHEMA]));

    // Make room (LRU eviction) before inserting the new entry.
    if (this.entries.size >= this.maxClients) {
      await this._evictLru();
    }

    const now = Date.now();
    this.entries.set(entityId, { client, lastUsed: now, registeredAt: now, delegationExpiry });
  }

  private async _evict(entityId: string): Promise<void> {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    this.entries.delete(entityId);
    // Drop all room mappings that pointed to this entity.
    for (const [room, eid] of this.roomToEntity) {
      if (eid === entityId) this.roomToEntity.delete(room);
    }
    await entry.client.stop().catch(() => {});
  }

  private async _evictLru(): Promise<void> {
    let lruKey: string | undefined;
    let lruTime = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.lastUsed < lruTime) {
        lruTime = entry.lastUsed;
        lruKey = key;
      }
    }
    if (lruKey !== undefined) {
      await this._evict(lruKey);
    }
  }
}

function isExpiredError(err: unknown): boolean {
  return err instanceof DelegationPolicyError && err.reason === "EXPIRED";
}
