// TinyCloudMemoryStorageService — the 8-method MemoryStorageProvider owning the
// "memoryStorage" service slot (plan §5). All node I/O flows through ONE
// @tinycloud/agent-client instance (db handle "xyz.tinycloud.eliza/memory").
//
// This is the ONLY package allowed to import @elizaos/* (plan §3): the shared
// client core stays host-framework-agnostic. The service implements the §5
// per-method contract row-by-row — sort orders, limits, strict entity/room WHERE
// matching, and the exact not-found throw messages — plus the SWR read caches
// (caches.ts) and the cluster fan-out microbatcher (microbatcher.ts).
//
// READS PARSE BEFORE RETURNING (plan §4 bold rule): TEXT timestamps → Date, JSON
// TEXT columns → values. A row whose metadata fails JSON.parse is RETURNED with
// metadata undefined + logged — we own the schema, so we don't silently drop it
// (plan §2.4 parse note).

import {
  Service,
  type IAgentRuntime,
  type MemoryStorageProvider,
  type UUID,
  logger,
} from "@elizaos/core";
import {
  createAgentClient,
  type AgentClient,
  type SqlValue,
} from "@tinycloud/agent-client";

import { SwrCache } from "./caches";
import { resolveMemoryClientConfig } from "./config";
import { Microbatcher } from "./microbatcher";
import { MEMORY_SCHEMA } from "./schema";

// Seam types derived from the host interface (drift-robust — matches the
// reference impl's pattern, advanced-memory-storage.ts).
type LtmRecord = Awaited<ReturnType<MemoryStorageProvider["storeLongTermMemory"]>>;
type LtmInput = Parameters<MemoryStorageProvider["storeLongTermMemory"]>[0];
type LtmCategory = LtmRecord["category"];
type LtmUpdates = Parameters<MemoryStorageProvider["updateLongTermMemory"]>[3];
type SummaryRecord = Awaited<ReturnType<MemoryStorageProvider["storeSessionSummary"]>>;
type SummaryInput = Parameters<MemoryStorageProvider["storeSessionSummary"]>[0];
type SummaryUpdates = Parameters<MemoryStorageProvider["updateSessionSummary"]>[3];

/** Per-method SWR/deadline knobs (plan §5). Injectable for tests (plan T8). */
export interface MemoryStorageTuning {
  /** SWR freshness window for both read caches (~60s, plan §5). */
  ttlMs?: number;
  /** Provider-facing read deadline → stale-or-empty, never throw (~8s, plan §5). */
  readDeadlineMs?: number;
  /** Cluster fan-out coalescing window (~10ms, plan §5 row 2). */
  batchWindowMs?: number;
  /** Default LTM read limit when none supplied (reference parity, plan §2.4). */
  defaultLtmLimit?: number;
  /** Default session-summaries limit when none supplied. */
  defaultSummaryLimit?: number;
}

/** Injectable dependencies for tests — supply a fake client to avoid live node I/O. */
export interface MemoryStorageDeps extends MemoryStorageTuning {
  /** Pre-built client (tests). When absent, {@link start} builds the real one. */
  client?: AgentClient;
}

const DEFAULTS = {
  ttlMs: 60_000,
  readDeadlineMs: 8_000,
  batchWindowMs: 10,
  defaultLtmLimit: 20,
  defaultSummaryLimit: 10,
} as const;

const LTM_COLUMNS =
  "id, agent_id, entity_id, category, content, metadata, embedding, " +
  "confidence, source, created_at, updated_at, last_accessed_at, access_count";

const SUMMARY_COLUMNS =
  "id, agent_id, room_id, entity_id, summary, message_count, last_message_offset, " +
  "start_time, end_time, topics, metadata, embedding, created_at, updated_at";

const KEY_SEP = "\u0000";

export class TinyCloudMemoryStorageService
  extends Service
  implements MemoryStorageProvider
{
  static serviceType = "memoryStorage" as const;

  /**
   * Stable identity brand for the slot guard. Compared as a STRING (not via
   * `instanceof`) so two copies of this module — version skew, hoisted vs nested,
   * dist vs src — that carry distinct class identities are still recognized as
   * "ours" (review #3). Subclasses inherit this static, so a test subclass also
   * brands as ours.
   */
  static readonly providerId = "@tinycloud/eliza-plugin-memory";

  capabilityDescription =
    "Stores Eliza long-term memories and session summaries in a user-owned " +
    "TinyCloud space (system of record for advanced memory).";

  private client: AgentClient | null;

  private readonly ttlMs: number;
  private readonly readDeadlineMs: number;
  private readonly batchWindowMs: number;
  private readonly defaultLtmLimit: number;
  private readonly defaultSummaryLimit: number;

  // Hottest path: entity-keyed LTM cache + room-keyed summary cache (plan §5).
  private readonly ltmCache: SwrCache<LtmRecord[]>;
  private readonly summaryCache: SwrCache<SummaryRecord | null>;
  // Coalesces cluster fan-out into one `entity_id IN (…)` query (plan §5 row 2).
  private readonly ltmBatcher: Microbatcher<LtmRecord[]>;

  constructor(runtime?: IAgentRuntime, deps: MemoryStorageDeps = {}) {
    super(runtime);
    this.client = deps.client ?? null;
    this.ttlMs = deps.ttlMs ?? DEFAULTS.ttlMs;
    this.readDeadlineMs = deps.readDeadlineMs ?? DEFAULTS.readDeadlineMs;
    this.batchWindowMs = deps.batchWindowMs ?? DEFAULTS.batchWindowMs;
    this.defaultLtmLimit = deps.defaultLtmLimit ?? DEFAULTS.defaultLtmLimit;
    this.defaultSummaryLimit = deps.defaultSummaryLimit ?? DEFAULTS.defaultSummaryLimit;

    this.ltmCache = new SwrCache<LtmRecord[]>({
      ttlMs: this.ttlMs,
      onRevalidateError: (key, err) =>
        logger.warn({ key, err: String(err) }, "tinycloud-memory: LTM revalidate failed"),
    });
    this.summaryCache = new SwrCache<SummaryRecord | null>({
      ttlMs: this.ttlMs,
      onRevalidateError: (key, err) =>
        logger.warn({ key, err: String(err) }, "tinycloud-memory: summary revalidate failed"),
    });
    this.ltmBatcher = new Microbatcher<LtmRecord[]>({
      windowMs: this.batchWindowMs,
      runBatch: (group, members) => this.runLtmBatch(group, members),
    });
  }

  // ── lifecycle (plan §3 / §5 start+stop rows) ────────────────────────────────

  static async start(runtime: IAgentRuntime): Promise<Service> {
    // Fail-fast precedence guard FIRST — before any network bring-up (plan §2.2 /
    // handoff GAP 5). We win the shared "memoryStorage" slot only by registering
    // BEFORE @elizaos/plugin-sql (first-registered wins). If a foreign memoryStorage
    // is already in the slot, the operator misordered plugins and our memory would
    // silently route to local SQLite — throw loud instead of failing silently.
    TinyCloudMemoryStorageService.assertSlotNotTaken(runtime);
    const service = new TinyCloudMemoryStorageService(runtime);
    await service.startClient(runtime);
    return service;
  }

  /** True if a STARTED service instance is one of ours (brand survives module dup, #3). */
  private static isOurInstance(s: unknown): boolean {
    return (
      (s as { constructor?: { providerId?: unknown } } | null | undefined)?.constructor
        ?.providerId === TinyCloudMemoryStorageService.providerId
    );
  }

  /** True if a REGISTERED service class is one of ours (the class object carries the static brand). */
  private static isOurClass(c: unknown): boolean {
    return (
      (c as { providerId?: unknown } | null | undefined)?.providerId ===
      TinyCloudMemoryStorageService.providerId
    );
  }

  /** Human label for the foreign incumbent (class or instance) — names only, never secrets. */
  private static describeIncumbent(x: unknown): string {
    // A class object: use its own .name; an instance: its constructor's .name.
    const asClass = (x as { name?: unknown } | null | undefined)?.name;
    if (typeof asClass === "string" && asClass) return asClass;
    const ctorName = (x as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name;
    return typeof ctorName === "string" && ctorName ? ctorName : "another service";
  }

  private static slotTakenError(incumbent: string): Error {
    return new Error(
      `@tinycloud/eliza-plugin-memory: the "memoryStorage" slot is already held by ` +
        `${incumbent}. List "@tinycloud/eliza-plugin-memory" BEFORE "@elizaos/plugin-sql" in ` +
        `character.plugins so it wins the slot (first-registered wins, plan §2.2).`,
    );
  }

  /**
   * Throws (loud, actionable) if a NON-TinyCloud service holds — or is about to
   * win — the "memoryStorage" slot. The slot winner is the FIRST-REGISTERED class
   * (Eliza starts a type's registered classes in registration order, first started
   * wins). Two complementary checks:
   *
   *   (A) Started-instance check (public API): scan getServicesByType for a foreign
   *       STARTED incumbent. Catches the case where a misordered plugin-sql has
   *       already been started before our start() runs.
   *
   *   (B) Winner-class check (review #2): inspect the registered class list
   *       (runtime.serviceTypes[type]) — populated SYNCHRONOUSLY at registration,
   *       BEFORE any start(). serviceTypes[type][0] is the slot winner regardless of
   *       start scheduling / lazy resolution, so this closes the false-negative where
   *       a foreign incumbent is registered-but-not-yet-started (getServicesByType
   *       still returns []). Best-effort + feature-detected: a runtime shape change
   *       degrades to (A), never throws spuriously.
   *
   * Identity is by stable brand (providerId), not instanceof, so duplicate module
   * copies of THIS package are not misflagged as foreign (review #3). Degrades to a
   * no-op on runtimes exposing neither signal.
   *
   * `protected` (not private) so the slot-precedence tests can drive the guard in
   * isolation, without the network bring-up that the public start() would trigger.
   */
  protected static assertSlotNotTaken(runtime: IAgentRuntime): void {
    const TYPE = TinyCloudMemoryStorageService.serviceType;

    // (A) Started-instance check — a foreign incumbent already in the slot.
    const byType = (runtime as { getServicesByType?: (t: string) => unknown[] }).getServicesByType;
    if (typeof byType === "function") {
      const incumbents = (byType.call(runtime, TYPE) as unknown[]) ?? [];
      const foreign = incumbents.find((s) => !TinyCloudMemoryStorageService.isOurInstance(s));
      if (foreign) {
        throw TinyCloudMemoryStorageService.slotTakenError(
          TinyCloudMemoryStorageService.describeIncumbent(foreign),
        );
      }
    }

    // (B) Winner-class check — the first-registered class wins, even if not yet started.
    const registered = (runtime as { serviceTypes?: Map<string, unknown[]> }).serviceTypes;
    const classes = registered instanceof Map ? registered.get(TYPE) : undefined;
    if (Array.isArray(classes) && classes.length > 0) {
      const winner = classes[0];
      if (!TinyCloudMemoryStorageService.isOurClass(winner)) {
        throw TinyCloudMemoryStorageService.slotTakenError(
          TinyCloudMemoryStorageService.describeIncumbent(winner),
        );
      }
    }
  }

  /** signIn → ensureSchema(§4 DDL). Throws on failure → MemoryService disables (fail-open, §2.2). */
  private async startClient(runtime: IAgentRuntime): Promise<void> {
    if (this.client) {
      // Pre-injected client (tests): still ensure session + schema.
      await this.client.signIn();
      await this.client.ensureSchema([...MEMORY_SCHEMA]);
      return;
    }
    const config = resolveMemoryClientConfig(runtime);
    const client = createAgentClient(config);
    await client.signIn();
    await client.ensureSchema([...MEMORY_SCHEMA]);
    this.client = client;
    logger.info({ dbHandle: config.dbHandle }, "tinycloud-memory: storage service started");
  }

  /** Flush in-flight writes (≤5s) + clear timers — delegated to the client. */
  async stop(): Promise<void> {
    await this.client?.stop();
  }

  private requireClient(): AgentClient {
    if (!this.client) {
      throw new Error("TinyCloudMemoryStorageService: client not started");
    }
    return this.client;
  }

  // ── #1 storeLongTermMemory (plan §5 row 1) ──────────────────────────────────

  async storeLongTermMemory(memory: LtmInput): Promise<LtmRecord> {
    const client = this.requireClient();
    const id = newUuid();
    const now = new Date();
    const nowIso = now.toISOString();

    // D7: AWAITED insert — never fire-and-forget (a record we return but never
    // persisted corrupts the slot-owner contract, plan §5 [DECISION]).
    await client.sql.execute(
      `INSERT INTO long_term_memories (${LTM_COLUMNS}) ` +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        memory.agentId,
        memory.entityId,
        memory.category,
        memory.content,
        jsonOrNull(memory.metadata),
        jsonOrNull(memory.embedding),
        numOrNull(memory.confidence),
        strOrNull(memory.source),
        nowIso,
        nowIso,
        dateOrNull(memory.lastAccessedAt),
        0,
      ],
    );

    const record = {
      ...memory,
      id,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    } as LtmRecord;

    this.writeThroughLtm(record);
    return record;
  }

  // ── #2 getLongTermMemories (hottest path, plan §5 row 2) ─────────────────────

  async getLongTermMemories(
    agentId: UUID,
    entityId: UUID,
    opts?: { category?: LtmCategory; limit?: number },
  ): Promise<LtmRecord[]> {
    const category = opts?.category;
    const limit = opts?.limit ?? this.defaultLtmLimit;
    const key = ltmKey(agentId, entityId, category);
    const group = ltmGroup(agentId, category, limit);

    // SWR + microbatcher; deadline → stale-or-empty, NEVER throw on the read path.
    return this.ltmCache.read(
      key,
      () => this.ltmBatcher.request(group, entityId),
      this.readDeadlineMs,
      [],
    );
  }

  /** Coalesced batch: one `entity_id IN (…)` query, over-fetch, per-entity slice. */
  private async runLtmBatch(group: string, members: string[]): Promise<Map<string, LtmRecord[]>> {
    const { agentId, category, limit } = parseLtmGroup(group);
    const client = this.requireClient();

    const placeholders = members.map(() => "?").join(", ");
    const params: SqlValue[] = [agentId, ...members];
    let sql =
      `SELECT ${LTM_COLUMNS} FROM long_term_memories ` +
      `WHERE agent_id = ? AND entity_id IN (${placeholders})`;
    if (category) {
      sql += " AND category = ?";
      params.push(category);
    }
    // Over-fetch so each member can fill its own `limit` (plain IN…LIMIT would
    // truncate to the wrong shape, plan §5 row 2). Ordering matches the §5 contract.
    sql += " ORDER BY updated_at DESC, confidence DESC, created_at DESC LIMIT ?";
    params.push(limit * Math.max(members.length, 1));

    const data = await client.sql.query(sql, params);
    const rows = client.sql.withRowObjects(data);

    // Seed every requested member with [] so absent entities resolve cleanly.
    const out = new Map<string, LtmRecord[]>();
    for (const member of members) out.set(member, []);
    // Rows already arrive in §5 order; grouping preserves it, then slice per entity.
    for (const row of rows) {
      const memory = parseLtmRow(row);
      const bucket = out.get(memory.entityId);
      if (bucket && bucket.length < limit) bucket.push(memory);
    }
    return out;
  }

  // ── #3 updateLongTermMemory (plan §5 row 3) ─────────────────────────────────

  async updateLongTermMemory(
    id: UUID,
    agentId: UUID,
    entityId: UUID,
    updates: LtmUpdates,
  ): Promise<void> {
    const client = this.requireClient();
    const { assignments, params } = buildLtmUpdate(updates);
    params.push(id, agentId, entityId);

    // Strict entity match — the §2.4 documented divergence (no group leniency).
    const result = await client.sql.execute(
      `UPDATE long_term_memories SET ${assignments} ` +
        "WHERE id = ? AND agent_id = ? AND entity_id = ?",
      params,
    );
    if (result.changes === 0) {
      throw new Error(`Long-term memory ${id} not found`);
    }
    this.ltmCache.invalidatePrefix(ltmPrefix(agentId, entityId));
  }

  // ── #4 deleteLongTermMemory (plan §5 row 4) ─────────────────────────────────

  async deleteLongTermMemory(id: UUID, agentId: UUID, entityId: UUID): Promise<void> {
    const client = this.requireClient();
    const result = await client.sql.execute(
      "DELETE FROM long_term_memories WHERE id = ? AND agent_id = ? AND entity_id = ?",
      [id, agentId, entityId],
    );
    if (result.changes === 0) {
      throw new Error(`Long-term memory ${id} not found`);
    }
    this.ltmCache.invalidatePrefix(ltmPrefix(agentId, entityId));
  }

  // ── #5 storeSessionSummary (plan §5 row 5) ──────────────────────────────────

  async storeSessionSummary(summary: SummaryInput): Promise<SummaryRecord> {
    const client = this.requireClient();
    const id = newUuid();
    const now = new Date();
    const nowIso = now.toISOString();
    const entityId = summary.entityId ?? summary.agentId; // fallback agentId (§2.4)

    await client.sql.execute(
      `INSERT INTO session_summaries (${SUMMARY_COLUMNS}) ` +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        summary.agentId,
        summary.roomId,
        entityId,
        summary.summary,
        summary.messageCount,
        summary.lastMessageOffset,
        summary.startTime.toISOString(),
        summary.endTime.toISOString(),
        jsonOrNull(summary.topics),
        jsonOrNull(summary.metadata),
        jsonOrNull(summary.embedding),
        nowIso,
        nowIso,
      ],
    );

    const record = {
      ...summary,
      id,
      entityId,
      createdAt: now,
      updatedAt: now,
    } as SummaryRecord;

    // Write-through the room cache — this is now the most-recently-updated summary.
    this.summaryCache.set(summaryKey(summary.agentId, summary.roomId), record);
    return record;
  }

  // ── #6 getCurrentSessionSummary (per-turn, plan §5 row 6) ────────────────────

  async getCurrentSessionSummary(
    agentId: UUID,
    roomId: UUID,
  ): Promise<SummaryRecord | null> {
    const key = summaryKey(agentId, roomId);
    return this.summaryCache.read(
      key,
      async () => {
        const client = this.requireClient();
        const data = await client.sql.query(
          `SELECT ${SUMMARY_COLUMNS} FROM session_summaries ` +
            "WHERE agent_id = ? AND room_id = ? " +
            "ORDER BY updated_at DESC, created_at DESC LIMIT 1",
          [agentId, roomId],
        );
        const rows = client.sql.withRowObjects(data);
        return rows.length > 0 ? parseSummaryRow(rows[0]) : null;
      },
      this.readDeadlineMs,
      null,
    );
  }

  // ── #7 updateSessionSummary (plan §5 row 7) ─────────────────────────────────

  async updateSessionSummary(
    id: UUID,
    agentId: UUID,
    roomId: UUID,
    updates: SummaryUpdates,
  ): Promise<void> {
    const client = this.requireClient();
    const { assignments, params } = buildSummaryUpdate(updates);
    params.push(id, agentId, roomId);

    const result = await client.sql.execute(
      `UPDATE session_summaries SET ${assignments} ` +
        "WHERE id = ? AND agent_id = ? AND room_id = ?",
      params,
    );
    if (result.changes === 0) {
      throw new Error(`Session summary ${id} not found`);
    }

    // Write-through the room cache when we just updated the current summary;
    // otherwise drop it so the next read refetches.
    const key = summaryKey(agentId, roomId);
    const cur = this.summaryCache.peek(key);
    if (cur?.value && cur.value.id === id) {
      this.summaryCache.set(key, applySummaryUpdates(cur.value, updates));
    } else {
      this.summaryCache.invalidate(key);
    }
  }

  // ── #8 getSessionSummaries (plan §5 row 8) ──────────────────────────────────

  async getSessionSummaries(
    agentId: UUID,
    roomId: UUID,
    limit?: number,
  ): Promise<SummaryRecord[]> {
    const effective = limit ?? this.defaultSummaryLimit;
    if (effective <= 0) return []; // limit ≤ 0 → [] (parity §2.4)

    const client = this.requireClient();
    const data = await client.sql.query(
      `SELECT ${SUMMARY_COLUMNS} FROM session_summaries ` +
        "WHERE agent_id = ? AND room_id = ? " +
        "ORDER BY updated_at DESC, created_at DESC LIMIT ?",
      [agentId, roomId, effective],
    );
    return client.sql.withRowObjects(data).map(parseSummaryRow);
  }

  // ── write-through helper ────────────────────────────────────────────────────

  /** Prepend a freshly stored record into any cached list for its entity (plan §5 row 1). */
  private writeThroughLtm(record: LtmRecord): void {
    // A store affects both the category-specific list and the all-categories list.
    for (const category of [record.category, undefined] as Array<LtmCategory | undefined>) {
      const key = ltmKey(record.agentId, record.entityId, category);
      const entry = this.ltmCache.peek(key);
      if (entry) {
        this.ltmCache.set(key, [record, ...entry.value].sort(compareLtm));
      }
    }
  }
}

// ── cache-key + group helpers ─────────────────────────────────────────────────

function ltmKey(agentId: UUID, entityId: UUID, category?: LtmCategory): string {
  return `${agentId}${KEY_SEP}${entityId}${KEY_SEP}${category ?? ""}`;
}

function ltmPrefix(agentId: UUID, entityId: UUID): string {
  return `${agentId}${KEY_SEP}${entityId}${KEY_SEP}`;
}

function summaryKey(agentId: UUID, roomId: UUID): string {
  return `${agentId}${KEY_SEP}${roomId}`;
}

function ltmGroup(agentId: UUID, category: LtmCategory | undefined, limit: number): string {
  return `${agentId}${KEY_SEP}${category ?? ""}${KEY_SEP}${limit}`;
}

function parseLtmGroup(group: string): {
  agentId: UUID;
  category: LtmCategory | undefined;
  limit: number;
} {
  const [agentId, category, limit] = group.split(KEY_SEP);
  return {
    agentId: agentId as UUID,
    category: category ? (category as LtmCategory) : undefined,
    limit: Number(limit),
  };
}

// ── row parsing (plan §4 bold rule: TEXT → Date, JSON TEXT → values) ──────────

type Row = Record<string, unknown>;

function parseLtmRow(row: Row): LtmRecord {
  return {
    id: row.id as UUID,
    agentId: row.agent_id as UUID,
    entityId: row.entity_id as UUID,
    category: row.category as LtmCategory,
    content: (row.content as string) ?? "",
    metadata: parseJsonObject(row.metadata, "long_term_memories.metadata", row.id),
    embedding: parseJsonArray(row.embedding, "long_term_memories.embedding", row.id) as
      | number[]
      | undefined,
    confidence: numOrUndef(row.confidence),
    source: strOrUndef(row.source),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    lastAccessedAt: row.last_accessed_at
      ? new Date(row.last_accessed_at as string)
      : undefined,
    accessCount: numOrUndef(row.access_count) ?? 0,
  } as LtmRecord;
}

function parseSummaryRow(row: Row): SummaryRecord {
  return {
    id: row.id as UUID,
    agentId: row.agent_id as UUID,
    roomId: row.room_id as UUID,
    entityId: strOrUndef(row.entity_id) as UUID | undefined,
    summary: (row.summary as string) ?? "",
    messageCount: numOrUndef(row.message_count) ?? 0,
    lastMessageOffset: numOrUndef(row.last_message_offset) ?? 0,
    startTime: new Date(row.start_time as string),
    endTime: new Date(row.end_time as string),
    topics: parseJsonArray(row.topics, "session_summaries.topics", row.id) as
      | string[]
      | undefined,
    metadata: parseJsonObject(row.metadata, "session_summaries.metadata", row.id),
    embedding: parseJsonArray(row.embedding, "session_summaries.embedding", row.id) as
      | number[]
      | undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  } as SummaryRecord;
}

// ── UPDATE builders (camelCase field → snake_case column) ─────────────────────

const LTM_UPDATE_COLUMNS: Record<string, { col: string; ser: (v: unknown) => SqlValue }> = {
  category: { col: "category", ser: (v) => strOrNull(v) },
  content: { col: "content", ser: (v) => strOrNull(v) },
  metadata: { col: "metadata", ser: (v) => jsonOrNull(v) },
  embedding: { col: "embedding", ser: (v) => jsonOrNull(v) },
  confidence: { col: "confidence", ser: (v) => numOrNull(v) },
  source: { col: "source", ser: (v) => strOrNull(v) },
  lastAccessedAt: { col: "last_accessed_at", ser: (v) => dateOrNull(v) },
  accessCount: { col: "access_count", ser: (v) => numOrNull(v) },
};

const SUMMARY_UPDATE_COLUMNS: Record<string, { col: string; ser: (v: unknown) => SqlValue }> = {
  entityId: { col: "entity_id", ser: (v) => strOrNull(v) },
  summary: { col: "summary", ser: (v) => strOrNull(v) },
  messageCount: { col: "message_count", ser: (v) => numOrNull(v) },
  lastMessageOffset: { col: "last_message_offset", ser: (v) => numOrNull(v) },
  startTime: { col: "start_time", ser: (v) => dateOrNull(v) },
  endTime: { col: "end_time", ser: (v) => dateOrNull(v) },
  topics: { col: "topics", ser: (v) => jsonOrNull(v) },
  metadata: { col: "metadata", ser: (v) => jsonOrNull(v) },
  embedding: { col: "embedding", ser: (v) => jsonOrNull(v) },
};

function buildUpdate(
  updates: Record<string, unknown>,
  columns: Record<string, { col: string; ser: (v: unknown) => SqlValue }>,
): { assignments: string; params: SqlValue[] } {
  const sets: string[] = [];
  const params: SqlValue[] = [];
  for (const [field, spec] of Object.entries(columns)) {
    if (Object.prototype.hasOwnProperty.call(updates, field)) {
      sets.push(`${spec.col} = ?`);
      params.push(spec.ser(updates[field]));
    }
  }
  // Always bump updated_at = now (plan §5 rows 3 & 7).
  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  return { assignments: sets.join(", "), params };
}

function buildLtmUpdate(updates: LtmUpdates): { assignments: string; params: SqlValue[] } {
  return buildUpdate(updates as Record<string, unknown>, LTM_UPDATE_COLUMNS);
}

function buildSummaryUpdate(updates: SummaryUpdates): { assignments: string; params: SqlValue[] } {
  return buildUpdate(updates as Record<string, unknown>, SUMMARY_UPDATE_COLUMNS);
}

/** Apply partial updates to a cached summary for write-through (plan §5 row 7). */
function applySummaryUpdates(current: SummaryRecord, updates: SummaryUpdates): SummaryRecord {
  return { ...current, ...(updates as Partial<SummaryRecord>), updatedAt: new Date() };
}

// ── ordering (plan §5 row 2: updatedAt desc, confidence desc, createdAt desc) ─

function compareLtm(a: LtmRecord, b: LtmRecord): number {
  const byUpdated = b.updatedAt.getTime() - a.updatedAt.getTime();
  if (byUpdated !== 0) return byUpdated;
  const byConfidence = (b.confidence ?? 0) - (a.confidence ?? 0);
  if (byConfidence !== 0) return byConfidence;
  return b.createdAt.getTime() - a.createdAt.getTime();
}

// ── value (de)serialization ───────────────────────────────────────────────────

/**
 * Generate a RFC-4122 v4 UUID for a new row id. Uses Math.random rather than a
 * crypto global on purpose: row ids are not a security control here (the UCAN
 * invocation is — plan §5), and this keeps the package free of ambient node/DOM
 * globals. Collision probability is negligible at memory-row volumes.
 */
function newUuid(): UUID {
  let out = "";
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += "-";
    } else if (i === 14) {
      out += "4";
    } else {
      const r = Math.floor(Math.random() * 16);
      const v = i === 19 ? (r & 0x3) | 0x8 : r;
      out += v.toString(16);
    }
  }
  return out as UUID;
}

function jsonOrNull(value: unknown): SqlValue {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function numOrNull(value: unknown): SqlValue {
  return value === undefined || value === null ? null : Number(value);
}

function strOrNull(value: unknown): SqlValue {
  return value === undefined || value === null ? null : String(value);
}

function dateOrNull(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function numOrUndef(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : Number(value);
}

function strOrUndef(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

/** Parse a JSON object column; on failure return undefined + log (never drop the row, §2.4). */
function parseJsonObject(
  value: unknown,
  column: string,
  rowId: unknown,
): Record<string, unknown> | undefined {
  const parsed = tryParseJson(value, column, rowId);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/** Parse a JSON array column; on failure return undefined + log. */
function parseJsonArray(value: unknown, column: string, rowId: unknown): unknown[] | undefined {
  const parsed = tryParseJson(value, column, rowId);
  return Array.isArray(parsed) ? parsed : undefined;
}

function tryParseJson(value: unknown, column: string, rowId: unknown): unknown {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    logger.warn(
      { column, rowId: String(rowId), err: String(err) },
      "tinycloud-memory: malformed JSON column, returned undefined",
    );
    return undefined;
  }
}
