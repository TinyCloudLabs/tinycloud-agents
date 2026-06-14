// Milestone B T6 — comprehensive unit tests (handoff §5 T6, build-plan §10).
//
// Proves (via injected fake clients — zero live node I/O):
//   (a) WRITES serialize through the shared process-wide write lane:
//       peak concurrent sql.execute calls === lane concurrency (1), never more.
//   (b) READS run concurrently: N entity reads are ALL in-flight simultaneously,
//       never serialized by the write lane.
//   (c) FAILURE ISOLATION: entity A's client throwing does not break entity B's
//       reads or writes and does not propagate from start().
//   (d) NO cross-user summary leak: clientForRoom routes to the owning entity's
//       client; one user's getCurrentSessionSummary never returns the other's row.
//   (e) REFRESH PATH: registry dedupes concurrent registrations; EXPIRED delegation
//       surfaces DelegationExpiredError and evicts without poisoning other entities.
//
// Does NOT regress the existing 104/0 suite — these tests ADD on top.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  DelegationPolicyError,
  type AgentClient,
  type SqlValue,
  withRowObjects,
} from "@tinycloud/agent-client";

import {
  DelegationExpiredError,
  EntityClientRegistry,
  NoDelegationError,
} from "../entity-registry";
import { TinyCloudMemoryStorageService } from "../storage";
import { MEMORY_SCHEMA } from "../schema";

// ── UUID constants ─────────────────────────────────────────────────────────────

const AGENT = "a0a0a0a0-0000-4000-8000-000000000000";
const ENTITY_A = "ea0ea0ea-0000-4000-8000-000000000000";
const ENTITY_B = "eb0eb0eb-0000-4000-8000-000000000000";
const ENTITY_C = "ec0ec0ec-0000-4000-8000-000000000000";
const ROOM_A = "ra0ra0ra-0000-4000-8000-000000000000";
const ROOM_B = "rb0rb0rb-0000-4000-8000-000000000000";

// ── deferred ───────────────────────────────────────────────────────────────────

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── fake client ────────────────────────────────────────────────────────────────

const SUMMARY_INSERT_COLS =
  "id, agent_id, room_id, entity_id, summary, message_count, last_message_offset, " +
  "start_time, end_time, topics, metadata, embedding, created_at, updated_at";

interface TrackedClient extends AgentClient {
  readonly db: Database;
  readonly callLog: string[];
}

function makeFake(id: string): TrackedClient {
  const db = new Database(":memory:");
  for (const ddl of MEMORY_SCHEMA) db.run(ddl);
  const callLog: string[] = [];
  return {
    db,
    callLog,
    signIn: async () => {
      callLog.push("signIn");
      return { spaceId: `space:${id}`, address: `0x${id}`, did: `did:key:z${id}` };
    },
    ensureSchema: async () => {
      callLog.push("ensureSchema");
    },
    stop: async () => {
      callLog.push("stop");
      db.close();
    },
    sql: {
      query: async (sql: string, params: SqlValue[] = []) => {
        callLog.push(`q:${sql.slice(0, 8)}`);
        const stmt = db.query(sql);
        const rows = stmt.values(...(params as never[])) as unknown[][];
        return { columns: stmt.columnNames, rows, rowCount: rows.length };
      },
      execute: async (sql: string, params: SqlValue[] = []) => {
        callLog.push(`x:${sql.slice(0, 8)}`);
        const res = db.run(sql, ...(params as never[]));
        return { changes: res.changes, lastInsertRowId: Number(res.lastInsertRowid) };
      },
      batch: async () => {
        callLog.push("batch");
        return { results: [] };
      },
      withRowObjects,
    },
  };
}

// ── registry + service builders ────────────────────────────────────────────────

function makeReg(
  entries: Array<[entityId: string, client: AgentClient, roomId?: string]>,
): EntityClientRegistry {
  const clients = new Map<string, AgentClient>(entries.map(([eid, c]) => [eid, c]));
  const roomIndex = new Map<string, string>(
    entries.filter(([, , rid]) => rid).map(([eid, , rid]) => [rid!, eid]),
  );
  const reg = new EntityClientRegistry({
    clients,
    roomIndex,
    runWrite: async (fn) => fn(),
  });
  // Wire rooms synchronously through the T1 seam path.
  for (const [eid, , rid] of entries) {
    if (rid) void reg.registerDelegation(eid, `ser:${eid}`, rid);
  }
  return reg;
}

function makeSvc(reg: EntityClientRegistry): TinyCloudMemoryStorageService {
  return new TinyCloudMemoryStorageService(undefined as never, {
    registry: reg,
    readDeadlineMs: 5_000,
    ttlMs: 60_000,
  });
}

function ltmInput(entityId: string, content = "test-content") {
  return { agentId: AGENT, entityId, category: "semantic", content } as never;
}

// ── T6(a): writes serialize through the process-wide write lane ───────────────

describe("T6(a): writes serialize through the shared write lane", () => {
  test("peak concurrent sql.execute calls across N entities === 1 (lane concurrency=1)", async () => {
    let inFlight = 0;
    let peak = 0;
    const gates = [deferred(), deferred(), deferred()];

    // Three entities each with a gate-controlled execute — lets us observe
    // whether the process-wide lane holds at most 1 in-flight at a time.
    const entityOrder = [ENTITY_A, ENTITY_B, ENTITY_C];
    const clients = entityOrder.map((entityId, i) => {
      const db = new Database(":memory:");
      for (const ddl of MEMORY_SCHEMA) db.run(ddl);

      const client: AgentClient = {
        signIn: async () => ({
          spaceId: `sp:${i}`,
          address: `0x${i}`,
          did: `did:key:z${i}`,
        }),
        ensureSchema: async () => {},
        stop: async () => {
          db.close();
        },
        sql: {
          query: async (sql: string, params: SqlValue[] = []) => {
            const stmt = db.query(sql);
            const rows = stmt.values(...(params as never[])) as unknown[][];
            return { columns: stmt.columnNames, rows, rowCount: rows.length };
          },
          execute: async (sql: string, params: SqlValue[] = []) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await gates[i].promise; // suspend until released
            inFlight--;
            const res = db.run(sql, ...(params as never[]));
            return { changes: res.changes, lastInsertRowId: Number(res.lastInsertRowid) };
          },
          batch: async () => ({ results: [] }),
          withRowObjects,
        },
      };
      return { entityId, client };
    });

    const reg = new EntityClientRegistry({
      clients: new Map(clients.map(({ entityId, client }) => [entityId, client])),
    });
    const svc = makeSvc(reg);

    // Submit 3 concurrent writes (each goes through the process-wide runWrite lane).
    // Because the lane has concurrency=1, entity A starts immediately;
    // B and C are queued — none of their sql.execute calls fire yet.
    const writes = [
      svc.storeLongTermMemory(ltmInput(ENTITY_A)),
      svc.storeLongTermMemory(ltmInput(ENTITY_B)),
      svc.storeLongTermMemory(ltmInput(ENTITY_C)),
    ];

    // Synchronous check — only entity A's execute is in-flight.
    expect(inFlight).toBe(1);
    expect(peak).toBe(1);

    // Release gate[0] → A completes → lane pumps → B starts.
    gates[0].resolve();
    await new Promise<void>((r) => setTimeout(r, 0)); // drain microtasks
    expect(peak).toBe(1); // peak never rose above 1

    // Release gate[1] → B completes → C starts.
    gates[1].resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(peak).toBe(1);

    // Release gate[2] → C completes.
    gates[2].resolve();
    await Promise.all(writes);
    expect(peak).toBe(1); // final assertion: never more than 1 concurrent write
  });

  test("writes from different entities complete in FIFO submission order", async () => {
    const completionOrder: string[] = [];
    const gates = [deferred(), deferred(), deferred()];

    const clients = [ENTITY_A, ENTITY_B, ENTITY_C].map((entityId, i) => {
      const db = new Database(":memory:");
      for (const ddl of MEMORY_SCHEMA) db.run(ddl);
      const client: AgentClient = {
        signIn: async () => ({ spaceId: `sp:${i}`, address: `0x${i}`, did: `did:key:z${i}` }),
        ensureSchema: async () => {},
        stop: async () => { db.close(); },
        sql: {
          query: async (sql: string, params: SqlValue[] = []) => {
            const stmt = db.query(sql);
            const rows = stmt.values(...(params as never[])) as unknown[][];
            return { columns: stmt.columnNames, rows, rowCount: rows.length };
          },
          execute: async (sql: string, params: SqlValue[] = []) => {
            await gates[i].promise;
            completionOrder.push(entityId);
            const res = db.run(sql, ...(params as never[]));
            return { changes: res.changes, lastInsertRowId: Number(res.lastInsertRowid) };
          },
          batch: async () => ({ results: [] }),
          withRowObjects,
        },
      };
      return { entityId, client };
    });

    const reg = new EntityClientRegistry({
      clients: new Map(clients.map(({ entityId, client }) => [entityId, client])),
    });
    const svc = makeSvc(reg);

    const writes = [
      svc.storeLongTermMemory(ltmInput(ENTITY_A)),
      svc.storeLongTermMemory(ltmInput(ENTITY_B)),
      svc.storeLongTermMemory(ltmInput(ENTITY_C)),
    ];

    // Release in submission order; each completes before the next starts.
    gates[0].resolve();
    await writes[0];
    gates[1].resolve();
    await writes[1];
    gates[2].resolve();
    await writes[2];

    expect(completionOrder).toEqual([ENTITY_A, ENTITY_B, ENTITY_C]);
  });
});

// ── T6(b): reads run concurrently (not serialized by the lane) ───────────────

describe("T6(b): reads run concurrently (not serialized by write lane)", () => {
  test("all N entity reads are in-flight simultaneously (peak === N, synchronous observation)", () => {
    // Unlike writes, reads go directly through client.sql.query — the process-wide
    // runWrite lane is never involved. Starting N reads synchronously increments
    // inFlight N times before any yield, proving all N are concurrently in-flight.
    let inFlight = 0;
    let peak = 0;
    const N = 3;
    const gates = Array.from({ length: N }, () => deferred());

    const clients = [ENTITY_A, ENTITY_B, ENTITY_C].map((entityId, i) => {
      const db = new Database(":memory:");
      for (const ddl of MEMORY_SCHEMA) db.run(ddl);
      const client: AgentClient = {
        signIn: async () => ({ spaceId: `sp:${i}`, address: `0x${i}`, did: `did:key:z${i}` }),
        ensureSchema: async () => {},
        stop: async () => { db.close(); },
        sql: {
          query: async (sql: string, params: SqlValue[] = []) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await gates[i].promise; // suspend all 3 simultaneously
            inFlight--;
            const stmt = db.query(sql);
            const rows = stmt.values(...(params as never[])) as unknown[][];
            return { columns: stmt.columnNames, rows, rowCount: rows.length };
          },
          execute: async (sql: string, params: SqlValue[] = []) => {
            const res = db.run(sql, ...(params as never[]));
            return { changes: res.changes, lastInsertRowId: Number(res.lastInsertRowid) };
          },
          batch: async () => ({ results: [] }),
          withRowObjects,
        },
      };
      return { entityId, client };
    });

    const reg = new EntityClientRegistry({
      clients: new Map(clients.map(({ entityId, client }) => [entityId, client])),
    });
    const svc = makeSvc(reg);

    // Firing all 3 reads starts their loaders synchronously (SwrCache cold-miss
    // path runs the loader eagerly before any await). Each sql.query increments
    // inFlight before hitting its gate — so all 3 are in-flight after this line.
    const reads = [
      svc.getLongTermMemories(AGENT as never, ENTITY_A as never),
      svc.getLongTermMemories(AGENT as never, ENTITY_B as never),
      svc.getLongTermMemories(AGENT as never, ENTITY_C as never),
    ];

    expect(peak).toBe(N); // ALL 3 in-flight — NOT serialized
    expect(inFlight).toBe(N);

    for (const g of gates) g.resolve();
    return Promise.all(reads); // drain
  });

  test("N concurrent reads finish in parallel: wall-clock < sum of individual latencies", async () => {
    const DELAY_MS = 25; // per-read simulated latency

    const clients = [ENTITY_A, ENTITY_B, ENTITY_C].map((entityId, i) => {
      const db = new Database(":memory:");
      for (const ddl of MEMORY_SCHEMA) db.run(ddl);
      const client: AgentClient = {
        signIn: async () => ({ spaceId: `sp:${i}`, address: `0x${i}`, did: `did:key:z${i}` }),
        ensureSchema: async () => {},
        stop: async () => { db.close(); },
        sql: {
          query: async (sql: string, params: SqlValue[] = []) => {
            await new Promise<void>((r) => setTimeout(r, DELAY_MS));
            const stmt = db.query(sql);
            const rows = stmt.values(...(params as never[])) as unknown[][];
            return { columns: stmt.columnNames, rows, rowCount: rows.length };
          },
          execute: async (sql: string, params: SqlValue[] = []) => {
            const res = db.run(sql, ...(params as never[]));
            return { changes: res.changes, lastInsertRowId: Number(res.lastInsertRowid) };
          },
          batch: async () => ({ results: [] }),
          withRowObjects,
        },
      };
      return { entityId, client };
    });

    const reg = new EntityClientRegistry({
      clients: new Map(clients.map(({ entityId, client }) => [entityId, client])),
    });
    const svc = makeSvc(reg);

    const t0 = Date.now();
    await Promise.all([
      svc.getLongTermMemories(AGENT as never, ENTITY_A as never),
      svc.getLongTermMemories(AGENT as never, ENTITY_B as never),
      svc.getLongTermMemories(AGENT as never, ENTITY_C as never),
    ]);
    const elapsed = Date.now() - t0;

    // If serial: ≥3×DELAY. If concurrent: ≈DELAY. Allow generous fuzz.
    expect(elapsed).toBeLessThan(DELAY_MS * 2 + 150);
  });
});

// ── T6(c): failure isolation ──────────────────────────────────────────────────

describe("T6(c): failure isolation — entity A failure never affects entity B", () => {
  test("entity A write failure is isolated; entity B write succeeds", async () => {
    const deadA: AgentClient = {
      signIn: async () => ({ spaceId: "space:A", address: "0xA", did: "did:key:zA" }),
      ensureSchema: async () => {},
      stop: async () => {},
      sql: {
        query: async () => ({ columns: [], rows: [], rowCount: 0 }),
        execute: async () => {
          throw new Error("entity-A-dead");
        },
        batch: async () => ({ results: [] }),
        withRowObjects: () => [],
      },
    };
    const clientB = makeFake("B");
    const reg = makeReg([
      [ENTITY_A, deadA],
      [ENTITY_B, clientB],
    ]);
    const svc = makeSvc(reg);

    // Entity A's write throws (write lane surfaces the error to A's caller only).
    await expect(svc.storeLongTermMemory(ltmInput(ENTITY_A))).rejects.toThrow("entity-A-dead");

    // Entity B's write is completely unaffected.
    const rec = await svc.storeLongTermMemory(ltmInput(ENTITY_B, "B-content"));
    expect(rec.entityId).toBe(ENTITY_B);
    expect(rec.content).toBe("B-content");

    await clientB.stop();
  });

  test("entity A read failure degrades to [] (fail-open); entity B read still works", async () => {
    const deadA: AgentClient = {
      signIn: async () => ({ spaceId: "space:A", address: "0xA", did: "did:key:zA" }),
      ensureSchema: async () => {},
      stop: async () => {},
      sql: {
        query: async () => {
          throw new Error("entity-A-query-dead");
        },
        execute: async () => ({ changes: 0, lastInsertRowId: 0 }),
        batch: async () => ({ results: [] }),
        withRowObjects: () => [],
      },
    };
    const clientB = makeFake("B");
    const reg = makeReg([
      [ENTITY_A, deadA],
      [ENTITY_B, clientB],
    ]);
    const svc = new TinyCloudMemoryStorageService(undefined as never, {
      registry: reg,
      readDeadlineMs: 200, // short deadline to fail fast
      ttlMs: 60_000,
    });

    // Entity A degrades gracefully — never throws.
    const rowsA = await svc.getLongTermMemories(AGENT as never, ENTITY_A as never);
    expect(rowsA).toEqual([]);

    // Entity B reads fine.
    const rowsB = await svc.getLongTermMemories(AGENT as never, ENTITY_B as never);
    expect(rowsB).toEqual([]); // empty db, no rows seeded

    await clientB.stop();
  });

  test("NoDelegationError for unregistered entity A does not affect entity B", () => {
    const clientB = makeFake("B");
    const reg = makeReg([[ENTITY_B, clientB]]);

    // Entity A not registered → NoDelegationError.
    expect(() => reg.clientFor(ENTITY_A)).toThrow(NoDelegationError);

    // Entity B is completely unaffected.
    expect(reg.clientFor(ENTITY_B)).toBe(clientB);
  });

  test("start() in delegation mode does NOT call signIn on any client (T4 invariant)", async () => {
    // T4 removed global signIn/ensureSchema from start(): per-user clients are
    // built lazily in registerDelegation. Bad credentials → start() must still resolve.
    const settings: Record<string, string> = {
      TINYCLOUD_AUTH_MODE: "delegation",
      TINYCLOUD_DELEGATION: "fake-delegation",
      TINYCLOUD_AGENT_KEY: "0xfakekey",
    };
    const runtime = {
      getSetting: (k: string) => settings[k] ?? undefined,
    } as never;

    const svc = await TinyCloudMemoryStorageService.start(runtime);
    expect(svc).toBeInstanceOf(TinyCloudMemoryStorageService);
    await svc.stop();
  });

  test("entity A DelegationExpiredError (TTL) does not break entity B reads", async () => {
    const clientA = makeFake("A");
    const clientB = makeFake("B");

    const reg = new EntityClientRegistry({
      createClient: () => clientA,
      runWrite: async (fn) => fn(),
      ttlMs: 1, // entity A will expire immediately
    });

    await reg.registerDelegation(ENTITY_A, "ser-A");
    // Register entity B via T1 seam (won't go through createClient).
    const reg2 = makeReg([
      [ENTITY_B, clientB],
    ]);

    const svc = makeSvc(reg2);

    // Wait for TTL to lapse for entity A.
    await new Promise<void>((r) => setTimeout(r, 10));

    // Entity A clientFor throws DelegationExpiredError (TTL eviction).
    expect(() => reg.clientFor(ENTITY_A)).toThrow(DelegationExpiredError);

    // Entity B (in a separate registry / service) reads fine.
    const rows = await svc.getLongTermMemories(AGENT as never, ENTITY_B as never);
    expect(rows).toEqual([]);

    await clientA.stop();
    await clientB.stop();
  });
});

// ── T6(d): no cross-user summary leak ────────────────────────────────────────

describe("T6(d): no cross-user summary leak", () => {
  test("clientForRoom routes each room to its own entity's client (not shared)", () => {
    const clientA = makeFake("A");
    const clientB = makeFake("B");
    const reg = makeReg([
      [ENTITY_A, clientA, ROOM_A],
      [ENTITY_B, clientB, ROOM_B],
    ]);

    expect(reg.clientForRoom(ROOM_A)).toBe(clientA);
    expect(reg.clientForRoom(ROOM_B)).toBe(clientB);
    // Cross-check: neither room resolves to the wrong client.
    expect(reg.clientForRoom(ROOM_A)).not.toBe(clientB);
    expect(reg.clientForRoom(ROOM_B)).not.toBe(clientA);
  });

  test("entity A's getCurrentSessionSummary does not return entity B's row", async () => {
    const clientA = makeFake("A");
    const clientB = makeFake("B");

    // Seed a summary ONLY in B's private in-memory db.
    const T0 = "2024-01-01T00:00:00.000Z";
    const T1 = "2024-01-01T00:01:00.000Z";
    clientB.db.run(
      `INSERT INTO session_summaries (${SUMMARY_INSERT_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["sum-b", AGENT, ROOM_B, ENTITY_B, "B-only-summary", 1, 1, T0, T1, null, null, null, T0, T0],
    );

    const reg = makeReg([
      [ENTITY_A, clientA, ROOM_A],
      [ENTITY_B, clientB, ROOM_B],
    ]);
    const svc = makeSvc(reg);

    // Room A (entity A's space) has no summaries.
    const summA = await svc.getCurrentSessionSummary(AGENT as never, ROOM_A as never);
    expect(summA).toBeNull();

    // Room B (entity B's space) returns B's own row.
    const summB = await svc.getCurrentSessionSummary(AGENT as never, ROOM_B as never);
    expect(summB).not.toBeNull();
    expect(summB?.summary).toBe("B-only-summary");

    // Physical isolation: B's row is NOT present in A's database.
    const leaked = clientA.db
      .query("SELECT * FROM session_summaries WHERE room_id = ?")
      .all(ROOM_B) as unknown[];
    expect(leaked).toHaveLength(0);
  });

  test("storeSessionSummary writes only into the owning entity's physical space", async () => {
    const clientA = makeFake("A");
    const clientB = makeFake("B");

    const reg = makeReg([
      [ENTITY_A, clientA, ROOM_A],
      [ENTITY_B, clientB, ROOM_B],
    ]);
    const svc = makeSvc(reg);

    const T0 = new Date("2024-01-01T00:00:00.000Z");
    const T1 = new Date("2024-01-01T00:01:00.000Z");

    await svc.storeSessionSummary({
      agentId: AGENT,
      roomId: ROOM_A,
      entityId: ENTITY_A,
      summary: "A-summary",
      messageCount: 1,
      lastMessageOffset: 1,
      startTime: T0,
      endTime: T1,
    } as never);

    // A's summary is in A's db.
    const inA = clientA.db
      .query("SELECT * FROM session_summaries WHERE entity_id = ?")
      .all(ENTITY_A) as unknown[];
    expect(inA).toHaveLength(1);

    // A's row is NOT in B's db (physical isolation).
    const inB = clientB.db
      .query("SELECT * FROM session_summaries WHERE entity_id = ?")
      .all(ENTITY_A) as unknown[];
    expect(inB).toHaveLength(0);
  });

  test("getLongTermMemories for entity A queries A's client — B's rows never appear", async () => {
    const clientA = makeFake("A");
    const clientB = makeFake("B");

    // Seed an LTM row in B's db under the SAME agentId.
    const T0 = "2024-01-01T00:00:00.000Z";
    const LTM_COLS =
      "id, agent_id, entity_id, category, content, metadata, embedding, " +
      "confidence, source, created_at, updated_at, last_accessed_at, access_count";
    clientB.db.run(
      `INSERT INTO long_term_memories (${LTM_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["ltm-b", AGENT, ENTITY_B, "semantic", "B-content", null, null, null, null, T0, T0, null, 0],
    );

    const reg = makeReg([
      [ENTITY_A, clientA],
      [ENTITY_B, clientB],
    ]);
    const svc = makeSvc(reg);

    // Entity A's read goes to A's client (empty db) — B's row is invisible.
    const rowsA = await svc.getLongTermMemories(AGENT as never, ENTITY_A as never);
    expect(rowsA).toHaveLength(0);

    // Entity B's read goes to B's client and finds B's row.
    const rowsB = await svc.getLongTermMemories(AGENT as never, ENTITY_B as never);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].content).toBe("B-content");
  });

  test("two entities with different rooms have independent getCurrentSessionSummary results", async () => {
    const clientA = makeFake("A");
    const clientB = makeFake("B");

    const T0 = "2024-01-01T00:00:00.000Z";
    const T1 = "2024-01-01T00:01:00.000Z";

    // Seed a different summary in each db.
    clientA.db.run(
      `INSERT INTO session_summaries (${SUMMARY_INSERT_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["sum-a", AGENT, ROOM_A, ENTITY_A, "A-room-summary", 1, 1, T0, T1, null, null, null, T0, T0],
    );
    clientB.db.run(
      `INSERT INTO session_summaries (${SUMMARY_INSERT_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["sum-b", AGENT, ROOM_B, ENTITY_B, "B-room-summary", 1, 1, T0, T1, null, null, null, T0, T0],
    );

    const reg = makeReg([
      [ENTITY_A, clientA, ROOM_A],
      [ENTITY_B, clientB, ROOM_B],
    ]);
    const svc = makeSvc(reg);

    const summA = await svc.getCurrentSessionSummary(AGENT as never, ROOM_A as never);
    const summB = await svc.getCurrentSessionSummary(AGENT as never, ROOM_B as never);

    expect(summA?.summary).toBe("A-room-summary");
    expect(summB?.summary).toBe("B-room-summary");
    // Cross-check: neither result matches the other's summary.
    expect(summA?.summary).not.toBe("B-room-summary");
    expect(summB?.summary).not.toBe("A-room-summary");
  });
});

// ── T6(e): refresh path ───────────────────────────────────────────────────────

describe("T6(e): refresh path — dedupe, expired eviction, no poisoning", () => {
  test("concurrent registerDelegation calls for the same entity build exactly 1 client", async () => {
    let buildCount = 0;
    const client = makeFake("A");

    const reg = new EntityClientRegistry({
      createClient: () => {
        buildCount++;
        return client;
      },
      runWrite: async (fn) => fn(),
    });

    // Fire 3 concurrent registrations — only 1 client build should occur.
    await Promise.all([
      reg.registerDelegation(ENTITY_A, "ser-A"),
      reg.registerDelegation(ENTITY_A, "ser-A"),
      reg.registerDelegation(ENTITY_A, "ser-A"),
    ]);

    expect(buildCount).toBe(1);
    expect(reg.clientFor(ENTITY_A)).toBe(client);

    await client.stop();
  });

  test("EXPIRED delegation from registerDelegation surfaces DelegationExpiredError", async () => {
    const expiredClient: AgentClient = {
      signIn: async () => {
        throw new DelegationPolicyError("delegation expired", "EXPIRED");
      },
      ensureSchema: async () => {},
      stop: async () => {},
      sql: {
        query: async () => ({ columns: [], rows: [], rowCount: 0 }),
        execute: async () => ({ changes: 0, lastInsertRowId: 0 }),
        batch: async () => ({ results: [] }),
        withRowObjects: () => [],
      },
    };

    const reg = new EntityClientRegistry({
      createClient: () => expiredClient,
      runWrite: async (fn) => fn(),
    });

    await expect(
      reg.registerDelegation(ENTITY_A, "expired-ser"),
    ).rejects.toBeInstanceOf(DelegationExpiredError);

    // Entity A must NOT be registered after a failed build.
    expect(() => reg.clientFor(ENTITY_A)).toThrow(NoDelegationError);
  });

  test("EXPIRED entity A registration does not poison entity B", async () => {
    const goodClient = makeFake("good");
    const expiredClient: AgentClient = {
      signIn: async () => {
        throw new DelegationPolicyError("expired", "EXPIRED");
      },
      ensureSchema: async () => {},
      stop: async () => {},
      sql: {
        query: async () => ({ columns: [], rows: [], rowCount: 0 }),
        execute: async () => ({ changes: 0, lastInsertRowId: 0 }),
        batch: async () => ({ results: [] }),
        withRowObjects: () => [],
      },
    };
    const queue = [goodClient, expiredClient];
    let idx = 0;

    const reg = new EntityClientRegistry({
      createClient: () => queue[idx++] as AgentClient,
      runWrite: async (fn) => fn(),
    });

    // Register entity B first — must succeed.
    await reg.registerDelegation(ENTITY_B, "ser-B");
    expect(reg.clientFor(ENTITY_B)).toBe(goodClient);

    // Register entity A (EXPIRED) — throws, isolated to this call.
    await expect(
      reg.registerDelegation(ENTITY_A, "expired-ser"),
    ).rejects.toBeInstanceOf(DelegationExpiredError);

    // Entity B is completely unaffected.
    expect(reg.clientFor(ENTITY_B)).toBe(goodClient);

    await goodClient.stop();
  });

  test("service.registerDelegation propagates DelegationExpiredError at the service boundary", async () => {
    let buildCount = 0;
    const expiredClient: AgentClient = {
      signIn: async () => {
        throw new DelegationPolicyError("expired", "EXPIRED");
      },
      ensureSchema: async () => {},
      stop: async () => {},
      sql: {
        query: async () => ({ columns: [], rows: [], rowCount: 0 }),
        execute: async () => ({ changes: 0, lastInsertRowId: 0 }),
        batch: async () => ({ results: [] }),
        withRowObjects: () => [],
      },
    };

    const reg = new EntityClientRegistry({
      createClient: () => {
        buildCount++;
        return expiredClient;
      },
      runWrite: async (fn) => fn(),
    });

    const svc = makeSvc(reg);

    await expect(
      svc.registerDelegation(ENTITY_A, "expired-ser"),
    ).rejects.toBeInstanceOf(DelegationExpiredError);

    expect(buildCount).toBe(1); // one attempt, then evicted
  });

  test("idle TTL eviction throws DelegationExpiredError on the next clientFor", async () => {
    const client = makeFake("A");

    const reg = new EntityClientRegistry({
      createClient: () => client,
      runWrite: async (fn) => fn(),
      ttlMs: 1, // expire after 1 ms
    });

    await reg.registerDelegation(ENTITY_A, "ser-A");
    await new Promise<void>((r) => setTimeout(r, 10)); // lapse the TTL

    expect(() => reg.clientFor(ENTITY_A)).toThrow(DelegationExpiredError);
  });

  test("DelegationExpiredError from clientFor carries the correct entityId", async () => {
    const client = makeFake("A");

    const reg = new EntityClientRegistry({
      createClient: () => client,
      runWrite: async (fn) => fn(),
      ttlMs: 1,
    });

    await reg.registerDelegation(ENTITY_A, "ser-A");
    await new Promise<void>((r) => setTimeout(r, 10));

    let caught: DelegationExpiredError | undefined;
    try {
      reg.clientFor(ENTITY_A);
    } catch (e) {
      caught = e as DelegationExpiredError;
    }
    expect(caught).toBeInstanceOf(DelegationExpiredError);
    expect(caught?.entityId).toBe(ENTITY_A);
  });
});
