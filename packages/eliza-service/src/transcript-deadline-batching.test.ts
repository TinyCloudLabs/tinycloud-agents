import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readMeeting, searchTranscripts } from "./actions/tinycloud-search-transcripts.js";
import type { TranscriptMetadata, TranscriptReader } from "./actions/tinycloud-search-transcripts.js";
import { discoveryResult } from "./meeting-evidence.js";
import type { BodyResult } from "./meeting-evidence.js";
import { createReader } from "./transcript-registry.js";
import { settle, sleep } from "../../../test/virtual-time.js";

// TC-2441: production search at 30049a53 ran 9.961s of a 10s budget, read 10 of 12 meetings and spent 17 SQL + 10 KV node reads;
// ten of those SQL reads were the per-meeting speaker_names lookup, and the last three KV reads started just before the deadline.

const PREFIX = "xyz.tinycloud.tinychat/connectors";
const REV_PREFIX = `${PREFIX}/exo-voice-note/transcript-rev/`;
const HASH = "3f9a1c2e7b4d8f05a6e1c3b2d9f04e7a";
const VOICE_ID = "5c1f9e2a-7d3b-4e8a-9f60-2b8c4d1e7a93";
function fixture() {
  const db = new Database(":memory:");
  db.run("CREATE TABLE connector_meeting (id TEXT, source TEXT, source_id TEXT, title TEXT, started_at TEXT, organizer_email TEXT, participants TEXT, summary_overview TEXT, summary_action_items TEXT, metadata TEXT)");
  db.run("CREATE TABLE voice_note_transcript (source_id TEXT PRIMARY KEY, rev INTEGER NOT NULL, hash TEXT NOT NULL, body_key TEXT NOT NULL, outcome TEXT NOT NULL, committed_at TEXT NOT NULL)");
  return db;
}
function insert(db: Database, id: string, source: string, sourceId: string, startedAt: string, metadata: unknown = null) {
  db.run("INSERT INTO connector_meeting (id, source, source_id, title, started_at, metadata) VALUES (?, ?, ?, ?, ?, ?)", [id, source, sourceId, `Title ${id}`, startedAt, metadata === null ? null : JSON.stringify(metadata)]);
}
type Node = { sql?: (sql: string, params: unknown[], signal?: AbortSignal) => Promise<unknown>; kv?: (key: string, signal?: AbortSignal) => Promise<unknown> };
function recorded(db: Database, kv: Map<string, unknown>, node: Node = {}, accessDelayMs?: number) {
  const trace = { sql: [] as string[], kv: [] as string[], sqlSignals: [] as Array<AbortSignal | undefined>, kvSignals: [] as Array<AbortSignal | undefined> };
  const access = {
    sql: { db: () => ({ query: async (sql: string, params: unknown[] = [], options?: { signal?: AbortSignal }) => {
      trace.sql.push(sql); trace.sqlSignals.push(options?.signal);
      if (node.sql) return node.sql(sql, params, options?.signal);
      return { ok: true, data: { rows: db.query(sql).values(...(params as never[])) } };
    } }) },
    kv: { get: async (key: string, options?: { signal?: AbortSignal }) => {
      trace.kv.push(key); trace.kvSignals.push(options?.signal);
      if (node.kv) return node.kv(key, options?.signal);
      return kv.has(key) ? { ok: true, data: { data: kv.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND" } };
    } },
  };
  // A delayed provider models a session renewal or activation that the read must wait for before it can dispatch.
  const reader = createReader((accessDelayMs === undefined ? access : async () => { await sleep(accessDelayMs); return access; }) as never);
  return { reader, trace };
}
/** The standalone per-meeting rename lookup that TC-2441 removes from the body read. */
const isSpeakerLookup = (sql: string) => sql.startsWith("SELECT CASE WHEN json_valid(metadata) THEN CASE WHEN json_type(metadata, '$.speaker_names')");

const SENTENCES = [
  { text: "We chose cobalt for launch.", speaker_name: "Speaker A", start_time: 4 },
  { text: "Agreed, cobalt it is.", speaker_name: "Speaker B", start_time: 9 },
];
const speakersOf = (outcome: { evidence: Array<{ kind: string; speaker?: string }> }) => outcome.evidence.filter(item => item.kind === "transcript_excerpt").map(item => item.speaker);

describe("speaker_names ride the batched metadata revalidation", () => {
  test("a search over twelve meetings reads each body once and never queries speaker_names per meeting", async () => {
    const db = fixture();
    const kv = new Map<string, unknown>();
    for (let i = 0; i < 12; i++) {
      insert(db, `ff-${String(i).padStart(2, "0")}`, "fireflies", `src-${i}`, `2026-03-${String(i + 1).padStart(2, "0")}T10:00:00Z`, { speaker_names: { "Speaker A": `Dana ${i}` } });
      kv.set(`${PREFIX}/fireflies/transcript/src-${i}`, SENTENCES);
    }
    const { reader, trace } = recorded(db, kv);
    const result = await searchTranscripts(reader, { query: "cobalt" }, undefined, { retrievalMode: "range" });
    expect(result.data.corpus).toMatchObject({ candidateCount: 12, examinedCount: 12, matchedCount: 12, bodyReadCount: 12, partial: false });
    expect(trace.sql.filter(isSpeakerLookup)).toHaveLength(0);
    expect(trace.kv).toHaveLength(12);
    // Discovery (combined scan + two 8-row pages) plus revalidation (two 8-row pages + combined scan). Was 6 + 12 per-meeting lookups.
    expect(trace.sql).toHaveLength(6);
    db.close();
  });

  test("renames apply to the meeting that carries them, for meetings and voice notes, and leave other labels alone", async () => {
    const db = fixture();
    insert(db, "ff-a", "fireflies", "a", "2026-03-02T09:00:00Z", { speaker_names: { "Speaker A": "Dana" } });
    insert(db, "ff-b", "fireflies", "b", "2026-03-01T09:00:00Z");
    insert(db, `vn-${VOICE_ID}`, "exo-voice-note", VOICE_ID, "2026-03-03T10:00:00Z", { transcription_outcome: "transcribed", speaker_names: { "Speaker B": "Sam" } });
    db.run("INSERT INTO voice_note_transcript VALUES (?, 1, ?, ?, 'transcribed', '2026-03-03T10:00:00Z')", [VOICE_ID, HASH, `${REV_PREFIX}${VOICE_ID}/${HASH}`]);
    const kv = new Map<string, unknown>([[`${PREFIX}/fireflies/transcript/a`, SENTENCES], [`${PREFIX}/fireflies/transcript/b`, SENTENCES], [`${REV_PREFIX}${VOICE_ID}/${HASH}`, SENTENCES]]);
    const { reader, trace } = recorded(db, kv);
    const result = await searchTranscripts(reader, { query: "cobalt" }, undefined, { retrievalMode: "range" });
    const byRef = new Map(result.data.outcomes.map(outcome => [outcome.meetingRef, speakersOf(outcome)]));
    expect(byRef.get("ff-a")).toEqual(["Dana", "Speaker B"]);
    expect(byRef.get("ff-b")).toEqual(["Speaker A", "Speaker B"]);
    expect(byRef.get(`vn-${VOICE_ID}`)).toEqual(["Speaker A", "Sam"]);
    expect(trace.sql.filter(isSpeakerLookup)).toHaveLength(0);
    db.close();
  });

  test("a malformed, empty or oversized map is ignored exactly as before", async () => {
    const oversized = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`Speaker ${i}`, "x".repeat(60)]));
    for (const bad of [["Speaker A", "Dana"], "Dana", { "Speaker A": 7, "Speaker B": "" }, { "Speaker A": "   " }, oversized]) {
      const db = fixture();
      insert(db, "ff-a", "fireflies", "a", "2026-03-02T09:00:00Z", { speaker_names: bad });
      const { reader } = recorded(db, new Map([[`${PREFIX}/fireflies/transcript/a`, SENTENCES]]));
      const outcome = (await searchTranscripts(reader, { query: "cobalt" }, undefined, { retrievalMode: "range" })).data.outcomes[0]!;
      expect(speakersOf(outcome)).toEqual(["Speaker A", "Speaker B"]);
      db.close();
    }
  });

  test("a single-meeting read uses the renames from its own metadata lookup", async () => {
    const db = fixture();
    insert(db, "ff-a", "fireflies", "a", "2026-03-02T09:00:00Z", { speaker_names: { "Speaker A": "Dana" } });
    const { reader, trace } = recorded(db, new Map([[`${PREFIX}/fireflies/transcript/a`, SENTENCES]]));
    const outcome = (await readMeeting(reader, { meetingRef: "ff-a", focus: "speaker", speaker: "Dana" })).data.outcomes[0]!;
    expect(speakersOf(outcome)).toEqual(["Dana"]);
    expect(trace.sql.filter(isSpeakerLookup)).toHaveLength(0);
    db.close();
  });

  test("a body read without fresh metadata still looks the renames up", async () => {
    const db = fixture();
    insert(db, "ff-a", "fireflies", "a", "2026-03-02T09:00:00Z", { speaker_names: { "Speaker A": "Dana" } });
    const { reader, trace } = recorded(db, new Map([[`${PREFIX}/fireflies/transcript/a`, SENTENCES]]));
    const body = await reader.readBody!("fireflies", "a");
    expect((body.value as typeof SENTENCES).map(item => item.speaker_name)).toEqual(["Dana", "Speaker B"]);
    expect(trace.sql.filter(isSpeakerLookup)).toHaveLength(1);
    db.close();
  });
});

function row(index: number): TranscriptMetadata {
  return { meetingRef: `m-${String(index).padStart(2, "0")}`, source: "fireflies", sourceId: `src-${index}`, title: `Meeting ${index}`,
    startedAt: `2026-03-${String(index + 1).padStart(2, "0")}T10:00:00Z`, participantNames: [], participantEmails: [], organizerEmail: null, summaryOverview: null, summaryActionItems: null };
}
type ReaderOverrides = Partial<TranscriptReader>;
function stubReader(count: number, readBody: NonNullable<TranscriptReader["readBody"]>, overrides: ReaderOverrides = {}) {
  const rows = Array.from({ length: count }, (_, i) => row(count - i));
  const reader: TranscriptReader = {
    listMetadata: async () => rows,
    discoverMetadata: async (args, context) => discoveryResult(rows, rows.length, args, context ?? {}),
    getMetadataBatch: async refs => new Map(rows.filter(r => refs.includes(r.meetingRef)).map(r => [r.meetingRef, r])),
    readBody, getTranscript: async () => null, ...overrides,
  };
  return reader;
}
const present = (text = "the cobalt plan"): BodyResult => ({ state: "present", value: [{ text, speaker_name: "Speaker A" }] });

describe("start cutoff by operation kind", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test("a meeting is not started when less than the KV p95 (990ms) of the budget remains", async () => {
    const started: string[] = [];
    const reader = stubReader(3, async (_source, sourceId) => { started.push(sourceId); return present(); });
    const result = await searchTranscripts(reader, { query: "cobalt" }, undefined, { retrievalMode: "range", deadlineAt: Date.now() + 900 });
    expect(started).toEqual([]);
    expect(result.data.outcomes.map(o => [o.state, o.coverage.omissionReasons])).toEqual([["not_read", ["budget"]], ["not_read", ["budget"]], ["not_read", ["budget"]]]);
    expect(result.data.corpus).toMatchObject({ examinedCount: 0, unreadCount: 3, budgetOmittedCount: 3, bodyReadCount: 0, bodyDeadlineCount: 0, matchedCount: 0, partial: true });
  });

  test("a meeting is started when at least the KV p95 remains", async () => {
    const started: string[] = [];
    const reader = stubReader(3, async (_source, sourceId) => { started.push(sourceId); return present(); });
    const result = await searchTranscripts(reader, { query: "cobalt" }, undefined, { retrievalMode: "range", deadlineAt: Date.now() + 1_000 });
    expect(started).toHaveLength(3);
    expect(result.data.corpus).toMatchObject({ examinedCount: 3, budgetOmittedCount: 0, bodyReadCount: 3, matchedCount: 3, partial: false });
  });

  test("meetings stop starting once the remaining budget drops below the KV p95; started reads are counted, the rest are budget omissions", async () => {
    // 12 meetings, three workers, 400ms per body: waves start at 0, 400, 800 (1100 left) and the wave at 1200 has 700 left, so it is not started.
    const reader = stubReader(12, async () => { await sleep(400); return present(); });
    const result = await settle(searchTranscripts(reader, { query: "cobalt" }, undefined, { retrievalMode: "range", deadlineAt: Date.now() + 1_900 }));
    expect(result.data.corpus).toMatchObject({ candidateCount: 12, examinedCount: 9, unreadCount: 3, budgetOmittedCount: 3, bodyReadCount: 9, bodyDeadlineCount: 0, matchedCount: 9, partial: true });
    expect(result.data.outcomes.filter(o => o.state === "not_read").every(o => o.coverage.omissionReasons.includes("budget") && o.evidence.length === 0)).toBe(true);
  });

  test("the concrete reader starts no SQL read with less than the SQL p95 (1219ms) left, but still starts a KV read with 990ms left", async () => {
    const db = fixture();
    insert(db, "ff-a", "fireflies", "a", "2026-03-02T09:00:00Z");
    const kv = new Map([[`${PREFIX}/fireflies/transcript/a`, [{ text: "cobalt" }]]]);
    const refusedSql = recorded(db, kv);
    await expect(refusedSql.reader.getMetadata!("ff-a", { deadlineAt: Date.now() + 1_218 })).rejects.toMatchObject({ code: "retrieval_timeout" });
    expect(refusedSql.trace.sql).toEqual([]);
    const startedSql = recorded(db, kv);
    expect((await startedSql.reader.getMetadata!("ff-a", { deadlineAt: Date.now() + 1_219 }))?.meetingRef).toBe("ff-a");
    expect(startedSql.trace.sql.length).toBeGreaterThan(0);

    const startedKv = recorded(db, kv);
    expect((await startedKv.reader.readBody!("fireflies", "a", { deadlineAt: Date.now() + 990 }, null)).state).toBe("present");
    expect(startedKv.trace.kv).toHaveLength(1);
    const refusedKv = recorded(db, kv);
    await expect(refusedKv.reader.readBody!("fireflies", "a", { deadlineAt: Date.now() + 989 }, null)).rejects.toMatchObject({ code: "retrieval_timeout" });
    expect(refusedKv.trace.kv).toEqual([]);
    db.close();
  });

  test("the revalidation pass is not started with less than the SQL p95 left; every meeting is then a budget omission and nothing is dispatched", async () => {
    const db = fixture();
    const kv = new Map<string, unknown>();
    for (let i = 0; i < 3; i++) { insert(db, `ff-${i}`, "fireflies", `s-${i}`, `2026-03-0${i + 1}T10:00:00Z`); kv.set(`${PREFIX}/fireflies/transcript/s-${i}`, SENTENCES); }
    const { reader, trace } = recorded(db, kv);
    const discovered = await reader.discoverMetadata!({ limit: 12 } as never);
    trace.sql.length = 0;
    const result = await searchTranscripts({ ...reader, discoverMetadata: async () => discovered }, { query: "cobalt" }, undefined, { retrievalMode: "range", deadlineAt: Date.now() + 1_100 });
    expect(trace.sql).toEqual([]);
    expect(trace.kv).toEqual([]);
    expect(result.data.corpus).toMatchObject({ examinedCount: 0, unreadCount: 3, budgetOmittedCount: 3, matchedCount: 0, partial: true });
    db.close();
  });
});

describe("start cutoff after access acquisition", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test("a SQL read is not dispatched when waiting for access used up its reserve", async () => {
    const db = fixture();
    insert(db, "ff-a", "fireflies", "a", "2026-03-02T09:00:00Z");
    // 1300ms left passes the entry check (>= 1219); the 500ms access wait leaves 800.
    const { reader, trace } = recorded(db, new Map(), {}, 500);
    await expect(settle(reader.getMetadata!("ff-a", { deadlineAt: Date.now() + 1_300 }))).rejects.toMatchObject({ code: "retrieval_timeout" });
    expect(trace.sql).toEqual([]);
    db.close();
  });

  test("a KV read is not dispatched when waiting for access used up its reserve", async () => {
    const db = fixture();
    const { reader, trace } = recorded(db, new Map([[`${PREFIX}/fireflies/transcript/a`, SENTENCES]]), {}, 200);
    // 1100ms left passes the entry check (>= 990); the 200ms access wait leaves 900.
    await expect(settle(reader.readBody!("fireflies", "a", { deadlineAt: Date.now() + 1_100 }, null))).rejects.toMatchObject({ code: "retrieval_timeout" });
    expect(trace.kv).toEqual([]);
    db.close();
  });

  test("reads still dispatch when the budget left after the access wait covers their kind", async () => {
    const db = fixture();
    insert(db, "ff-a", "fireflies", "a", "2026-03-02T09:00:00Z");
    // getMetadata is two sequential SQL reads (row, combined scan), each waiting 100ms for access.
    const { reader, trace } = recorded(db, new Map([[`${PREFIX}/fireflies/transcript/a`, SENTENCES]]), {}, 100);
    expect((await settle(reader.getMetadata!("ff-a", { deadlineAt: Date.now() + 2_500 })))?.meetingRef).toBe("ff-a");
    expect(trace.sql.length).toBeGreaterThan(0);
    expect((await settle(reader.readBody!("fireflies", "a", { deadlineAt: Date.now() + 1_100 }, null))).state).toBe("present");
    expect(trace.kv).toHaveLength(1);
    db.close();
  });

  test("a search whose access wait consumes the budget dispatches nothing and reports every meeting as a budget omission", async () => {
    const db = fixture();
    const kv = new Map<string, unknown>();
    for (let i = 0; i < 3; i++) { insert(db, `ff-${i}`, "fireflies", `s-${i}`, `2026-03-0${i + 1}T10:00:00Z`); kv.set(`${PREFIX}/fireflies/transcript/s-${i}`, SENTENCES); }
    const { reader, trace } = recorded(db, kv);
    const discovered = await reader.discoverMetadata!({ limit: 12 } as never);
    const slow = recorded(db, kv, {}, 400);
    trace.sql.length = 0;
    const result = await settle(searchTranscripts({ ...slow.reader, discoverMetadata: async () => discovered }, { query: "cobalt" }, undefined, { retrievalMode: "range", deadlineAt: Date.now() + 1_400 }));
    expect(slow.trace.sql).toEqual([]);
    expect(slow.trace.kv).toEqual([]);
    expect(result.data.corpus).toMatchObject({ examinedCount: 0, unreadCount: 3, budgetOmittedCount: 3, bodyReadCount: 0, matchedCount: 0, partial: true });
    db.close();
  });
});

describe("a body that never reached the node is not a body attempt", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });
  const VOICE_KEY = `${REV_PREFIX}${VOICE_ID}/${HASH}`;
  const SQL_QUERY = (db: Database) => async (sql: string, params: unknown[]) => ({ ok: true, data: { rows: db.query(sql).values(...(params as never[])) } });
  function voiceNoteRow(): TranscriptMetadata {
    return { meetingRef: `vn-${VOICE_ID}`, source: "exo-voice-note", sourceId: VOICE_ID, title: "Note", startedAt: "2026-03-03T10:00:00Z",
      participantNames: [], participantEmails: [], organizerEmail: null, summaryOverview: null, summaryActionItems: null, speakerNames: null };
  }
  function voiceNoteDb() {
    const db = fixture();
    insert(db, `vn-${VOICE_ID}`, "exo-voice-note", VOICE_ID, "2026-03-03T10:00:00Z", { transcription_outcome: "transcribed" });
    db.run("INSERT INTO voice_note_transcript VALUES (?, 1, ?, ?, 'transcribed', '2026-03-03T10:00:00Z')", [VOICE_ID, HASH, VOICE_KEY]);
    return db;
  }
  /** The concrete reader's body path behind an already-revalidated row, so the test starts at the body read. */
  function atBodyRead(concrete: TranscriptReader, row: TranscriptMetadata): TranscriptReader {
    return { ...concrete, discoverMetadata: async (args, context) => discoveryResult([row], 1, args, context ?? {}), getMetadataBatch: async refs => new Map(refs.map(ref => [ref, row])) };
  }
  const notStarted = (result: Awaited<ReturnType<typeof searchTranscripts>>) => {
    expect(result.data.outcomes[0]).toMatchObject({ state: "not_read", body: { state: "not_requested" }, coverage: { bodyAttempted: false, omissionReasons: expect.arrayContaining(["budget"]) } });
    expect(result.data.corpus).toMatchObject({ examinedCount: 0, unreadCount: 1, budgetOmittedCount: 1, bodyReadCount: 0, bodyDeadlineCount: 0, bodyTransportTimeoutCount: 0, transcriptFallbackCount: 0, transcriptRead: false, matchedCount: 0, partial: true });
    expect(result.text).toContain("Meetings not started: 1. Body reads interrupted: 0.");
  };

  test("a voice note whose SQL lookups leave less than the KV reserve is not started, and no KV read is dispatched", async () => {
    const db = voiceNoteDb();
    // Index and commit lookups take 600ms each: the commit starts with 1400 left (>= 1219), the KV body read would start with 800 (< 990).
    const { reader, trace } = recorded(db, new Map([[VOICE_KEY, SENTENCES]]), { sql: async (sql, params) => { await sleep(600); return SQL_QUERY(db)(sql, params); } });
    const result = await settle(searchTranscripts(atBodyRead(reader, voiceNoteRow()), { query: "cobalt" }, undefined, { retrievalMode: "range", deadlineAt: Date.now() + 2_000 }));
    expect(trace.sql).toHaveLength(2);
    expect(trace.kv).toEqual([]);
    notStarted(result);
    db.close();
  });

  test("a voice note whose SQL lookup is still running at the deadline is not started either", async () => {
    const db = voiceNoteDb();
    const { reader, trace } = recorded(db, new Map([[VOICE_KEY, SENTENCES]]), { sql: async (sql, params) => {
      if (sql.includes("FROM voice_note_transcript WHERE source_id")) await sleep(10_000); // ignores the abort
      return SQL_QUERY(db)(sql, params);
    } });
    const result = await settle(searchTranscripts(atBodyRead(reader, voiceNoteRow()), { query: "cobalt" }, undefined, { retrievalMode: "range", deadlineAt: Date.now() + 2_000 }));
    expect(trace.kv).toEqual([]);
    notStarted(result);
    db.close();
  });

  test("a voice note whose KV body read was dispatched and then cut off by the deadline is an attempted, interrupted body", async () => {
    const db = voiceNoteDb();
    const { reader, trace } = recorded(db, new Map(), { kv: async () => { await sleep(10_000); return { ok: true, data: { data: SENTENCES } }; } });
    const result = await settle(searchTranscripts(atBodyRead(reader, voiceNoteRow()), { query: "cobalt" }, undefined, { retrievalMode: "range", deadlineAt: Date.now() + 2_000 }));
    expect(trace.kv).toEqual([VOICE_KEY]);
    expect(result.data.outcomes[0]).toMatchObject({ state: "read", body: { state: "timeout", reasonCode: "retrieval_timeout" }, coverage: { bodyAttempted: true } });
    expect(result.data.corpus).toMatchObject({ budgetOmittedCount: 0, bodyDeadlineCount: 1, bodyReadCount: 0, transcriptFallbackCount: 1, matchedCount: 0, partial: true });
    expect(result.text).toContain("Meetings not started: 0. Body reads interrupted: 1.");
    db.close();
  });

  test("a body read whose access wait leaves less than the KV reserve is not started, and no KV read is dispatched", async () => {
    const db = fixture();
    const row = { ...voiceNoteRow(), meetingRef: "ff-a", source: "fireflies" as const, sourceId: "a" };
    const { reader, trace } = recorded(db, new Map([[`${PREFIX}/fireflies/transcript/a`, SENTENCES]]), {}, 300);
    // 1100 left passes the cutoff on entry (>= 990); the 300ms access wait leaves 800.
    const result = await settle(searchTranscripts(atBodyRead(reader, row), { query: "cobalt" }, undefined, { retrievalMode: "range", deadlineAt: Date.now() + 1_100 }));
    expect(trace.kv).toEqual([]);
    notStarted(result);
    db.close();
  });
});

describe("deadline abort and late results", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test("a dispatched KV read receives an abort at the deadline and its late value changes no count", async () => {
    const db = fixture();
    insert(db, "ff-a", "fireflies", "a", "2026-03-02T09:00:00Z");
    const startedAt = Date.now();
    const deadlineAt = startedAt + 2_000;
    let abortedAt = 0;
    const { reader, trace } = recorded(db, new Map(), {
      // A node that ignores the abort and still answers 200ms after the deadline.
      kv: async (_key, signal) => { signal?.addEventListener("abort", () => { abortedAt = Date.now(); }); await sleep(2_200); return { ok: true, data: { data: SENTENCES } }; },
    });
    const result = await settle(searchTranscripts(reader, { query: "cobalt" }, undefined, { retrievalMode: "range", deadlineAt }));
    expect(trace.kv).toHaveLength(1);
    expect(trace.kvSignals[0]?.aborted).toBe(true);
    expect(abortedAt).toBeGreaterThanOrEqual(deadlineAt);
    expect(Date.now()).toBeLessThan(deadlineAt + 100);
    expect(result.data.outcomes[0]!.body).toMatchObject({ state: "timeout", reasonCode: "retrieval_timeout" });
    expect(result.data.outcomes[0]!.evidence.filter(item => item.kind === "transcript_excerpt")).toEqual([]);
    expect(result.data.corpus).toMatchObject({ bodyReadCount: 0, bodyDeadlineCount: 1, matchedCount: 0, partial: true });
    db.close();
  });

  test("a dispatched SQL read receives an abort at the deadline", async () => {
    const db = fixture();
    insert(db, "ff-a", "fireflies", "a", "2026-03-02T09:00:00Z");
    const deadlineAt = Date.now() + 1_400;
    const { reader, trace } = recorded(db, new Map(), { sql: async (_sql, _params, signal) => { const { promise, resolve } = Promise.withResolvers<void>(); signal?.addEventListener("abort", () => resolve()); await promise; return { ok: false, error: { code: "ABORTED" } }; } });
    await expect(settle(reader.getMetadata!("ff-a", { deadlineAt }))).rejects.toMatchObject({ code: "retrieval_timeout" });
    expect(trace.sqlSignals[0]?.aborted).toBe(true);
    expect(Date.now()).toBeLessThan(deadlineAt + 100);
    db.close();
  });

  test("a body read by an injected reader receives an abort at the deadline and its late value changes no count", async () => {
    let received: AbortSignal | undefined;
    const reader = stubReader(1, async (_source, _sourceId, context) => {
      received = context?.signal;
      await sleep(1_300); // ignores the abort and answers after the deadline
      return present();
    });
    const deadlineAt = Date.now() + 1_100;
    const result = await settle(searchTranscripts(reader, { query: "cobalt" }, undefined, { retrievalMode: "range", deadlineAt }));
    expect(Date.now()).toBeLessThan(deadlineAt + 100);
    expect(received?.aborted).toBe(true);
    expect(result.data.outcomes[0]!.evidence).toEqual([]);
    expect(result.data.outcomes[0]!.body).toMatchObject({ state: "timeout", reasonCode: "retrieval_timeout" });
    expect(result.data.corpus).toMatchObject({ examinedCount: 1, bodyReadCount: 0, bodyDeadlineCount: 1, matchedCount: 0, partial: true });
  });

  test("a batched revalidation by an injected reader receives an abort at the deadline and its late answer is discarded", async () => {
    let received: AbortSignal | undefined;
    const bodies: string[] = [];
    const reader = stubReader(2, async (_source, sourceId) => { bodies.push(sourceId); return present(); }, {
      getMetadataBatch: async (refs, context) => { received = context?.signal; await sleep(500); return new Map(refs.map(ref => [ref, row(Number(ref.slice(2)))])); },
    });
    const result = await settle(searchTranscripts(reader, { query: "cobalt" }, undefined, { retrievalMode: "range", deadlineAt: Date.now() + 300 }));
    expect(received?.aborted).toBe(true);
    expect(bodies).toEqual([]);
    expect(result.data.corpus).toMatchObject({ examinedCount: 0, unreadCount: 2, budgetOmittedCount: 2, bodyReadCount: 0, matchedCount: 0, partial: true });
  });

  test("reads finished before the deadline stay counted, the interrupted one is a body deadline, the one that could not start is a budget omission", async () => {
    // Six meetings, three workers. src-6 never answers in time; the others take 700ms: wave two starts at 700 (1200 left), the last meeting would start at 1400 (500 left).
    const reader = stubReader(6, async (_source, sourceId) => { await sleep(sourceId === "src-6" ? 5_000 : 700); return present(); });
    const result = await settle(searchTranscripts(reader, { query: "cobalt" }, undefined, { retrievalMode: "range", deadlineAt: Date.now() + 1_900 }));
    expect(result.data.corpus).toMatchObject({ candidateCount: 6, examinedCount: 5, unreadCount: 1, budgetOmittedCount: 1, bodyReadCount: 4, bodyDeadlineCount: 1, bodyTransportTimeoutCount: 0, matchedCount: 4, partial: true });
    expect(result.text).toContain("Meetings not started: 1. Body reads interrupted: 1.");
  });
});
