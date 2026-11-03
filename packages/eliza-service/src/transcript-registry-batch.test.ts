import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { searchTranscripts } from "./actions/tinycloud-search-transcripts.js";
import { createReader } from "./transcript-registry.js";

// TC-2421: a search over discovered meetings revalidates them with one batched
// metadata read instead of repeating the exact lookup, combined-meeting scan and
// voice-note commit check once per meeting.

const PREFIX = "xyz.tinycloud.tinychat/connectors";
const REV_PREFIX = `${PREFIX}/exo-voice-note/transcript-rev/`;
const HASH = "3f9a1c2e7b4d8f05a6e1c3b2d9f04e7a";
const VOICE_ID = "5c1f9e2a-7d3b-4e8a-9f60-2b8c4d1e7a93";
const PASTED_ID = "0e8d4b7a-2c91-4f3e-8a5b-6d7c9e1f2a40";

function fixture() {
  const db = new Database(":memory:");
  db.run("CREATE TABLE connector_meeting (id TEXT, source TEXT, source_id TEXT, title TEXT, started_at TEXT, organizer_email TEXT, participants TEXT, summary_overview TEXT, summary_action_items TEXT, metadata TEXT)");
  db.run("CREATE TABLE voice_note_transcript (source_id TEXT PRIMARY KEY, rev INTEGER NOT NULL, hash TEXT NOT NULL, body_key TEXT NOT NULL, outcome TEXT NOT NULL, committed_at TEXT NOT NULL)");
  return db;
}
function insert(db: Database, id: string, source: string, sourceId: string, startedAt: string, metadata: unknown = null) {
  db.run("INSERT INTO connector_meeting (id, source, source_id, title, started_at, metadata) VALUES (?, ?, ?, ?, ?, ?)", [id, source, sourceId, `Title ${id}`, startedAt, metadata === null ? null : JSON.stringify(metadata)]);
}
function recorded(db: Database, kv: Map<string, unknown>, onQuery?: (sql: string) => void) {
  const trace = { sql: [] as string[], kv: [] as string[] };
  const reader = createReader({
    sql: { db: () => ({ query: async (sql: string, params?: unknown[]) => {
      trace.sql.push(sql); onQuery?.(sql);
      return { ok: true, data: { rows: db.query(sql).values(...((params ?? []) as never[])) } };
    } }) },
    kv: { get: async (key: string) => {
      trace.kv.push(key);
      return kv.has(key) ? { ok: true, data: { data: kv.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND" } };
    } },
  } as never);
  return { reader, trace };
}
const isExactLookup = (sql: string) => sql.includes("FROM connector_meeting WHERE id = ?");
const isCombinedScan = (sql: string) => sql.includes("source = ? AND CASE WHEN json_valid(metadata) THEN json_type(metadata, '$.merge.members')");

describe("batched metadata revalidation", () => {
  test("one search over twelve meetings does no per-meeting exact lookup and scans combined rows once more than discovery", async () => {
    const db = fixture();
    const kv = new Map<string, unknown>();
    for (let i = 0; i < 12; i++) {
      const id = `ff-${String(i).padStart(2, "0")}`;
      insert(db, id, "fireflies", `src-${i}`, `2026-03-${String(i + 1).padStart(2, "0")}T10:00:00Z`);
      kv.set(`${PREFIX}/fireflies/transcript/src-${i}`, [{ text: `the cobalt plan ${i}` }]);
    }
    const { reader, trace } = recorded(db, kv);
    const result = await searchTranscripts(reader, { query: "cobalt" }, undefined, { retrievalMode: "range" });
    expect(result.data.corpus).toMatchObject({ candidateCount: 12, examinedCount: 12, matchedCount: 12, partial: false });
    expect(trace.sql.filter(isExactLookup)).toHaveLength(0);
    // Discovery's own combined scan plus the fresh revalidation scan; never one per meeting.
    expect(trace.sql.filter(isCombinedScan).length).toBeLessThanOrEqual(2);
    // Every transcript body is still read, once each.
    expect(trace.kv).toHaveLength(12);
    db.close();
  });

  test("a combined row created after discovery hides its member from revalidation", async () => {
    const db = fixture();
    insert(db, "r-ff", "fireflies", "ff-1", "2026-03-02T09:00:00Z");
    insert(db, "r-other", "fireflies", "ff-other", "2026-03-01T09:00:00Z");
    const { reader } = recorded(db, new Map());
    expect([...(await reader.getMetadataBatch!(["r-ff", "r-other"])).keys()].sort()).toEqual(["r-ff", "r-other"]);
    const members = [{ source: "fireflies", source_id: "ff-1" }, { source: "google-meet", source_id: "gm-1" }];
    insert(db, "r-merged", "exo-merged", "merged-1", "2026-03-02T10:00:00Z", { merge: { v: 1, members } });
    expect([...(await reader.getMetadataBatch!(["r-ff", "r-other", "r-merged"])).keys()].sort()).toEqual(["r-merged", "r-other"]);
    db.close();
  });

  test("a meeting deleted after discovery is reported not found without a body read", async () => {
    const db = fixture();
    insert(db, "r-gone", "fireflies", "gone-1", "2026-03-02T09:00:00Z");
    insert(db, "r-kept", "fireflies", "kept-1", "2026-03-01T09:00:00Z");
    const kv = new Map<string, unknown>([[`${PREFIX}/fireflies/transcript/gone-1`, [{ text: "cobalt" }]], [`${PREFIX}/fireflies/transcript/kept-1`, [{ text: "cobalt" }]]]);
    const { reader, trace } = recorded(db, kv);
    const discovered = await reader.discoverMetadata!({ limit: 12 } as never);
    expect(discovered.rows.map(row => row.meetingRef).sort()).toEqual(["r-gone", "r-kept"]);
    db.run("DELETE FROM connector_meeting WHERE id = 'r-gone'");
    const result = await searchTranscripts({ ...reader, discoverMetadata: async () => discovered }, { query: "cobalt" });
    expect(result.data.outcomes.map(o => [o.meetingRef, o.state])).toEqual([["r-gone", "meeting_not_found"], ["r-kept", "read"]]);
    expect(trace.kv).toEqual([`${PREFIX}/fireflies/transcript/kept-1`]);
    expect(result.data.corpus).toMatchObject({ examinedCount: 1, unreadCount: 1, partial: true });
    db.close();
  });

  test("returns only the requested references even when the node ignores the id predicate", async () => {
    const db = fixture();
    insert(db, "r-a", "fireflies", "a", "2026-03-02T09:00:00Z");
    insert(db, "r-b", "fireflies", "b", "2026-03-01T09:00:00Z");
    const reader = createReader({
      sql: { db: () => ({ query: async (sql: string, params: unknown[] = []) => {
        const predicate = sql.match(/id IN \(([?, ]+)\)/);
        const ignored = predicate ? params.slice(predicate[1]!.split("?").length - 1) : params;
        return { ok: true, data: { rows: db.query(predicate ? sql.replace(predicate[0], "1 = 1") : sql).values(...(ignored as never[])) } };
      } }) },
      kv: { get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND" } }) },
    } as never);
    expect([...(await reader.getMetadataBatch!(["r-a"])).keys()]).toEqual(["r-a"]);
    db.close();
  });

  test("voice notes need a transcribed commit row, checked once for the whole batch", async () => {
    const db = fixture();
    insert(db, `vn-${VOICE_ID}`, "exo-voice-note", VOICE_ID, "2026-03-02T10:00:00Z", { transcription_outcome: "transcribed" });
    insert(db, `vn-${PASTED_ID}`, "exo-voice-note", PASTED_ID, "2026-03-02T11:00:00Z", { transcription_outcome: "transcribed" });
    insert(db, "r-ff", "fireflies", "ff-1", "2026-03-02T09:00:00Z");
    db.run("INSERT INTO voice_note_transcript VALUES (?, 1, ?, ?, 'transcribed', '2026-03-02T10:00:00Z')", [VOICE_ID, HASH, `${REV_PREFIX}${VOICE_ID}/${HASH}`]);
    const { reader, trace } = recorded(db, new Map());
    const batch = await reader.getMetadataBatch!([`vn-${VOICE_ID}`, `vn-${PASTED_ID}`, "r-ff"]);
    expect([...batch.keys()].sort()).toEqual(["r-ff", `vn-${VOICE_ID}`]);
    expect(trace.sql.filter(sql => sql.includes("FROM voice_note_transcript"))).toHaveLength(1);
    db.close();
  });

  test("an unsafe reference is rejected before any query", async () => {
    const db = fixture();
    const { reader, trace } = recorded(db, new Map());
    await expect(reader.getMetadataBatch!(["ok", "../escape"])).rejects.toMatchObject({ code: "invalid_args" });
    expect(trace.sql).toEqual([]);
    db.close();
  });
});

describe("storage TIMEOUT versus the tool deadline through the concrete reader", () => {
  test("an SDK transport TIMEOUT on a body is reported as a storage timeout, never as a spent budget", async () => {
    const db = fixture();
    insert(db, "r-a", "fireflies", "a", "2026-03-02T09:00:00Z");
    const reader = createReader({
      sql: { db: () => ({ query: async (sql: string, params?: unknown[]) => ({ ok: true, data: { rows: db.query(sql).values(...((params ?? []) as never[])) } }) }) },
      kv: { get: async () => ({ ok: false, error: { code: "TIMEOUT", message: "request timed out" } }) },
    } as never);
    const result = await searchTranscripts(reader, { query: "cobalt" }, undefined, { retrievalMode: "range", deadlineAt: Date.now() + 5_000 });
    expect(result.data.outcomes[0]!.body).toMatchObject({ state: "timeout", reasonCode: "TIMEOUT" });
    expect(result.data.corpus).toMatchObject({ budgetOmittedCount: 0, bodyDeadlineCount: 0, bodyTransportTimeoutCount: 1, bodyReadCount: 0 });
    expect(result.text).toContain("Body reads that timed out in storage: 1.");
    expect(result.text).not.toContain("time budget");
    db.close();
  });
});
