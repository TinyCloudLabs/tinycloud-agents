// Block 1 — PARITY suite vs plugin-sql's OBSERVABLE semantics (plan §2.4), run
// against the bun:sqlite-backed fake agent-client. Asserts sort orders, the
// default LTM limit, the limit<=0 → [] rule, the storeSessionSummary entityId→
// agentId fallback, the EXACT not-found throw messages, Date/parsed-JSON read
// shapes, and malformed-metadata → undefined+logged. MINUS the §2.4 divergences:
// we assert our STRICT entity-match (a cluster-member id on update/delete throws
// not-found) and do NOT replicate group-membership leniency / BFS anchoring.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { logger } from "@elizaos/core";

import { TinyCloudMemoryStorageService } from "../storage";
import { makeFakeClient, seedLtm, seedSummary, type FakeClient } from "./fake-client.test";

const AGENT = "11111111-1111-4111-8111-111111111111";
const ENTITY = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";

// Tight timing so the SWR/microbatcher resolve fast and deterministically.
const TUNING = { batchWindowMs: 1, ttlMs: 60_000, readDeadlineMs: 5_000 };

function makeService(client: FakeClient): TinyCloudMemoryStorageService {
  return new TinyCloudMemoryStorageService(undefined as never, { client, ...TUNING });
}

let client: FakeClient;
let svc: TinyCloudMemoryStorageService;

beforeEach(() => {
  client = makeFakeClient();
  svc = makeService(client);
});

afterEach(async () => {
  await svc.stop();
});

// ── sort orders ───────────────────────────────────────────────────────────────

test("getLongTermMemories sorts updated_at DESC, confidence DESC, created_at DESC", async () => {
  // Disambiguates each tier independently.
  seedLtm(client.db, { id: "X", agentId: AGENT, entityId: ENTITY, confidence: 0.9, updatedAt: "2024-01-03T00:00:00.000Z", createdAt: "2024-01-01T00:00:00.000Z" });
  seedLtm(client.db, { id: "Y", agentId: AGENT, entityId: ENTITY, confidence: 0.9, updatedAt: "2024-01-03T00:00:00.000Z", createdAt: "2024-01-02T00:00:00.000Z" });
  seedLtm(client.db, { id: "Z", agentId: AGENT, entityId: ENTITY, confidence: 0.95, updatedAt: "2024-01-03T00:00:00.000Z", createdAt: "2024-01-01T00:00:00.000Z" });
  seedLtm(client.db, { id: "W", agentId: AGENT, entityId: ENTITY, confidence: 0.5, updatedAt: "2024-01-05T00:00:00.000Z", createdAt: "2024-01-01T00:00:00.000Z" });

  const rows = await svc.getLongTermMemories(AGENT as never, ENTITY as never);
  expect(rows.map((r) => r.id)).toEqual(["W", "Z", "Y", "X"]);
});

test("getSessionSummaries sorts updated_at DESC, created_at DESC", async () => {
  seedSummary(client.db, { id: "A", agentId: AGENT, roomId: ROOM, updatedAt: "2024-01-02T00:00:00.000Z", createdAt: "2024-01-01T00:00:00.000Z" });
  seedSummary(client.db, { id: "B", agentId: AGENT, roomId: ROOM, updatedAt: "2024-01-02T00:00:00.000Z", createdAt: "2024-01-02T00:00:00.000Z" });
  seedSummary(client.db, { id: "C", agentId: AGENT, roomId: ROOM, updatedAt: "2024-01-04T00:00:00.000Z", createdAt: "2024-01-01T00:00:00.000Z" });

  const rows = await svc.getSessionSummaries(AGENT as never, ROOM as never);
  expect(rows.map((r) => r.id)).toEqual(["C", "B", "A"]);
});

test("getCurrentSessionSummary returns the most-recently-updated summary", async () => {
  seedSummary(client.db, { id: "old", agentId: AGENT, roomId: ROOM, updatedAt: "2024-01-01T00:00:00.000Z", createdAt: "2024-01-01T00:00:00.000Z" });
  seedSummary(client.db, { id: "new", agentId: AGENT, roomId: ROOM, updatedAt: "2024-01-09T00:00:00.000Z", createdAt: "2024-01-02T00:00:00.000Z" });

  const cur = await svc.getCurrentSessionSummary(AGENT as never, ROOM as never);
  expect(cur?.id).toBe("new");
});

// ── default LTM limit 20 ──────────────────────────────────────────────────────

test("getLongTermMemories defaults to a limit of 20", async () => {
  for (let i = 0; i < 25; i += 1) {
    const day = String(i + 1).padStart(2, "0");
    seedLtm(client.db, {
      id: `m-${i}`,
      agentId: AGENT,
      entityId: ENTITY,
      updatedAt: `2024-02-${day}T00:00:00.000Z`,
      createdAt: `2024-02-${day}T00:00:00.000Z`,
    });
  }
  const rows = await svc.getLongTermMemories(AGENT as never, ENTITY as never);
  expect(rows).toHaveLength(20);
  // The 20 most-recent (m-24 down to m-5).
  expect(rows[0].id).toBe("m-24");
  expect(rows[19].id).toBe("m-5");
});

// ── getSessionSummaries limit<=0 → [] (no DB call) ────────────────────────────

test("getSessionSummaries returns [] for limit <= 0", async () => {
  seedSummary(client.db, { id: "A", agentId: AGENT, roomId: ROOM, updatedAt: "2024-01-01T00:00:00.000Z", createdAt: "2024-01-01T00:00:00.000Z" });
  expect(await svc.getSessionSummaries(AGENT as never, ROOM as never, 0)).toEqual([]);
  expect(await svc.getSessionSummaries(AGENT as never, ROOM as never, -5)).toEqual([]);
});

// ── storeSessionSummary entityId fallback → agentId ───────────────────────────

test("storeSessionSummary falls back entityId to agentId when absent", async () => {
  const rec = await svc.storeSessionSummary({
    agentId: AGENT,
    roomId: ROOM,
    summary: "s",
    messageCount: 3,
    lastMessageOffset: 3,
    startTime: new Date("2024-01-01T00:00:00.000Z"),
    endTime: new Date("2024-01-01T00:05:00.000Z"),
  } as never);

  expect(rec.entityId).toBe(AGENT);

  // And it is what landed in the row, too.
  const data = await client.sql.query(
    "SELECT entity_id FROM session_summaries WHERE id = ?",
    [rec.id],
  );
  expect(client.sql.withRowObjects(data)[0].entity_id).toBe(AGENT);
});

// ── EXACT not-found throw messages ────────────────────────────────────────────

test("updateLongTermMemory on a missing row throws the exact not-found message", async () => {
  const id = "no-such-ltm";
  await expect(
    svc.updateLongTermMemory(id as never, AGENT as never, ENTITY as never, { content: "x" } as never),
  ).rejects.toThrow(`Long-term memory ${id} not found`);
});

test("deleteLongTermMemory on a missing row throws the exact not-found message", async () => {
  const id = "absent-ltm";
  await expect(
    svc.deleteLongTermMemory(id as never, AGENT as never, ENTITY as never),
  ).rejects.toThrow(`Long-term memory ${id} not found`);
});

test("updateSessionSummary on a missing row throws the exact not-found message", async () => {
  const id = "absent-summary";
  await expect(
    svc.updateSessionSummary(id as never, AGENT as never, ROOM as never, { summary: "x" } as never),
  ).rejects.toThrow(`Session summary ${id} not found`);
});

// ── reads return Date objects + parsed JSON columns ───────────────────────────

test("LTM reads return Date objects and parsed JSON columns (not strings)", async () => {
  seedLtm(client.db, {
    id: "typed",
    agentId: AGENT,
    entityId: ENTITY,
    metadata: JSON.stringify({ topic: "coffee", liked: true }),
    embedding: JSON.stringify([0.1, 0.2, 0.3]),
    confidence: 0.91,
    source: "evaluator",
    createdAt: "2024-03-01T00:00:00.000Z",
    updatedAt: "2024-03-02T00:00:00.000Z",
    lastAccessedAt: "2024-03-03T00:00:00.000Z",
    accessCount: 4,
  });

  const [row] = await svc.getLongTermMemories(AGENT as never, ENTITY as never);
  expect(row.createdAt).toBeInstanceOf(Date);
  expect(row.updatedAt).toBeInstanceOf(Date);
  expect(row.lastAccessedAt).toBeInstanceOf(Date);
  expect(row.createdAt.toISOString()).toBe("2024-03-01T00:00:00.000Z");
  expect(row.metadata).toEqual({ topic: "coffee", liked: true });
  expect(row.embedding).toEqual([0.1, 0.2, 0.3]);
  expect(row.confidence).toBe(0.91);
  expect(row.accessCount).toBe(4);
});

// ── embeddings round-trip through the PUBLIC store→get seam (handoff GAP 5) ────
// The live run had no TEXT_EMBEDDING model so memories were stored without
// embeddings. The model generation + vector ranking live in Eliza core; the part
// WE own is persisting/returning the embedding vector intact. These prove the
// write-path serialization + read-path parse survive a realistic-dimension vector
// and the null case. (A real-model end-to-end pass remains a manual prod gate.)

test("storeLongTermMemory → getLongTermMemories round-trips a realistic-dimension embedding intact", async () => {
  // Deterministic 384-dim vector (a common embedding size). No RNG (Math.random is unavailable).
  const vec = Array.from({ length: 384 }, (_, i) => Number(((i % 13) / 13).toFixed(6)));
  await svc.storeLongTermMemory({
    agentId: AGENT,
    entityId: ENTITY,
    category: "fact",
    content: "the user prefers oat milk",
    embedding: vec,
    confidence: 0.8,
    source: "evaluator",
  } as never);

  const [row] = await svc.getLongTermMemories(AGENT as never, ENTITY as never);
  expect(Array.isArray(row.embedding)).toBe(true);
  expect(row.embedding).toHaveLength(384);
  expect(row.embedding).toEqual(vec); // full vector survives store(JSON) → get(parse)
});

test("storeLongTermMemory with no embedding reads back null (the live no-TEXT_EMBEDDING case)", async () => {
  await svc.storeLongTermMemory({
    agentId: AGENT,
    entityId: ENTITY,
    category: "fact",
    content: "no embedding generated",
    confidence: 0.5,
    source: "evaluator",
  } as never);

  const [row] = await svc.getLongTermMemories(AGENT as never, ENTITY as never);
  expect(row.embedding ?? null).toBeNull();
});

test("summary reads return Date objects and parsed topics/metadata", async () => {
  seedSummary(client.db, {
    id: "ts",
    agentId: AGENT,
    roomId: ROOM,
    topics: JSON.stringify(["a", "b"]),
    metadata: JSON.stringify({ keyPoints: ["k1"] }),
    startTime: "2024-04-01T00:00:00.000Z",
    endTime: "2024-04-01T01:00:00.000Z",
    createdAt: "2024-04-01T00:00:00.000Z",
    updatedAt: "2024-04-02T00:00:00.000Z",
  });

  const cur = await svc.getCurrentSessionSummary(AGENT as never, ROOM as never);
  expect(cur?.startTime).toBeInstanceOf(Date);
  expect(cur?.endTime).toBeInstanceOf(Date);
  expect(cur?.createdAt).toBeInstanceOf(Date);
  expect(cur?.topics).toEqual(["a", "b"]);
  expect(cur?.metadata).toEqual({ keyPoints: ["k1"] });
});

// ── malformed metadata → undefined + logged (NOT dropped) ─────────────────────

test("a row with malformed metadata is returned with metadata undefined and logged", async () => {
  const origWarn = logger.warn;
  let warned = false;
  // Same module singleton the service calls; property is read at call time.
  (logger as { warn: unknown }).warn = (...args: unknown[]) => {
    warned = true;
    return (origWarn as (...a: unknown[]) => unknown).apply(logger, args);
  };
  try {
    seedLtm(client.db, {
      id: "bad-meta",
      agentId: AGENT,
      entityId: ENTITY,
      content: "still here",
      metadata: "{not valid json", // malformed TEXT
      createdAt: "2024-05-01T00:00:00.000Z",
      updatedAt: "2024-05-01T00:00:00.000Z",
    });

    const [row] = await svc.getLongTermMemories(AGENT as never, ENTITY as never);
    expect(row.id).toBe("bad-meta"); // NOT dropped
    expect(row.content).toBe("still here");
    expect(row.metadata).toBeUndefined();
    expect(warned).toBe(true); // logged
  } finally {
    (logger as { warn: unknown }).warn = origWarn;
  }
});

// ── §2.4 DIVERGENCE: strict entity match (no group-membership leniency) ───────

test("updateLongTermMemory with a cluster-member entityId throws not-found (strict match)", async () => {
  // Row belongs to ENTITY; updating it under a *different* entity id must throw
  // not-found — we deliberately do NOT honour plugin-sql's identity-group leniency.
  seedLtm(client.db, {
    id: "owned",
    agentId: AGENT,
    entityId: ENTITY,
    createdAt: "2024-06-01T00:00:00.000Z",
    updatedAt: "2024-06-01T00:00:00.000Z",
  });
  const OTHER = "44444444-4444-4444-8444-444444444444";

  await expect(
    svc.updateLongTermMemory("owned" as never, AGENT as never, OTHER as never, { content: "x" } as never),
  ).rejects.toThrow("Long-term memory owned not found");

  // The original row is untouched.
  const data = await client.sql.query("SELECT entity_id FROM long_term_memories WHERE id = ?", ["owned"]);
  expect(client.sql.withRowObjects(data)[0].entity_id).toBe(ENTITY);
});

test("deleteLongTermMemory with a cluster-member entityId throws not-found (strict match)", async () => {
  seedLtm(client.db, {
    id: "owned2",
    agentId: AGENT,
    entityId: ENTITY,
    createdAt: "2024-06-02T00:00:00.000Z",
    updatedAt: "2024-06-02T00:00:00.000Z",
  });
  const OTHER = "55555555-5555-4555-8555-555555555555";

  await expect(
    svc.deleteLongTermMemory("owned2" as never, AGENT as never, OTHER as never),
  ).rejects.toThrow("Long-term memory owned2 not found");

  // Still present — strict match refused the cross-entity delete.
  const data = await client.sql.query("SELECT id FROM long_term_memories WHERE id = ?", ["owned2"]);
  expect(data.rowCount).toBe(1);
});

// ── round-trip: a stored LTM reads back through getLongTermMemories ────────────

test("storeLongTermMemory persists and reads back via getLongTermMemories", async () => {
  const stored = await svc.storeLongTermMemory({
    agentId: AGENT,
    entityId: ENTITY,
    category: "semantic",
    content: "likes espresso",
    metadata: { topic: "coffee" },
    confidence: 0.88,
    source: "evaluator",
  } as never);

  expect(typeof stored.id).toBe("string");
  expect(stored.createdAt).toBeInstanceOf(Date);
  expect(stored.accessCount).toBe(0);

  // Fresh service (cold cache) reads it straight from the db.
  const fresh = makeService(client);
  try {
    const [row] = await fresh.getLongTermMemories(AGENT as never, ENTITY as never);
    expect(row.id).toBe(stored.id);
    expect(row.content).toBe("likes espresso");
    expect(row.metadata).toEqual({ topic: "coffee" });
    expect(row.confidence).toBe(0.88);
  } finally {
    // shared db; don't close it here (afterEach closes via svc.stop()).
  }
});
