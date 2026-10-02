import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { classifyBodyFailure, createReader } from "./transcript-registry.js";
import { findMeetings, listMeetingActions, parseFindMeetingsArgs, parseReadMeetingArgs, parseListMeetingActionsArgs, parseTranscriptSearchArgs, readMeeting, searchTranscripts, TRANSCRIPT_SOURCES } from "./actions/tinycloud-search-transcripts.js";
import type { TranscriptMetadata, TranscriptReader } from "./actions/tinycloud-search-transcripts.js";
import { readMeetingEvidence, storedRecap } from "./meeting-evidence.js";
import { TINYCLOUD_MEETING_TOOLS } from "./tasks/tool-contract.js";

const row: TranscriptMetadata = { meetingRef: "old", source: "fireflies", sourceId: "old-source", title: "Design", startedAt: "2025-01-01T10:00:00Z", organizerEmail: null, participantNames: [], participantEmails: [], summaryOverview: null, summaryActionItems: null };
function reader(overrides: Partial<TranscriptMetadata> = {}, body: unknown = [{ text: "Beginning. Middle. Final decision: cobalt." }]): TranscriptReader {
  return { listMetadata: async () => [{ ...row, ...overrides }], getTranscript: async () => body };
}
describe("meeting evidence v2", () => {
  test("accepts bounded additive reader/finder arguments and real dates", () => {
    expect(parseFindMeetingsArgs({ limit: 12, meetingRef: "old" })).toEqual({ limit: 12, meetingRef: "old" });
    expect(parseFindMeetingsArgs({ from: "2026-02-30" })).toBeNull();
    expect(parseFindMeetingsArgs({ from: "2026-09-09", to: "2026-09-01" })).toBeNull();
    expect(parseReadMeetingArgs({ meetingRef: "old", focus: "actions", includeBody: true, assignee: "Sam" })).toMatchObject({ includeBody: true, assignee: "Sam" });
  });
  test("actions alone do not suppress the summary body read", async () => {
    let reads = 0;
    const source = reader({ summaryActionItems: "- Sam will send a memo." });
    source.getTranscript = async () => { reads++; return null; };
    const result = await readMeeting(source, { meetingRef: "old", focus: "summary" });
    expect(reads).toBe(1);
    expect(result.data.contractVersion).toBe(2);
    expect(result.data.outcomes[0].coverage.support).toBe("none");
    expect(result.data.actionItems).toHaveLength(1);
  });
  test("overview avoids body unless detailed evidence is required", async () => {
    let reads = 0;
    const source = reader({ summaryOverview: "Stored overview." });
    source.getTranscript = async () => { reads++; return [{ text: "Final decision: cobalt." }]; };
    expect((await readMeeting(source, { meetingRef: "old", focus: "summary" })).data.outcomes[0].body.state).toBe("not_requested");
    const detailed = await readMeeting(source, { meetingRef: "old", focus: "summary", includeBody: true });
    expect(reads).toBe(1);
    expect(detailed.data.outcomes[0].evidence.some(e => e.text.includes("cobalt"))).toBe(true);
  });
  test("topic search retains stored notes when body is unsupported", async () => {
    const result = await searchTranscripts(reader({ summaryOverview: "Cobalt launch approved.", metadata: { artifactType: "notes" } } as never, { messages: [] }), { meetingRef: "old", query: "cobalt" });
    expect(result.data.outcomes[0]).toMatchObject({ body: { state: "unsupported_shape" }, search: { state: "matched", storedFieldsExamined: true }, coverage: { support: "limited" } });
    expect(result.data.outcomes[0].evidence.some(e => e.kind === "notes")).toBe(true);
  });
  test("short transcript-only summary retains late text", async () => {
    const source = reader({}, Array.from({ length: 10 }, (_, i) => ({ text: i === 9 ? "Late final decision: cobalt." : `Opening ${i}.` })));
    const result = await readMeeting(source, { meetingRef: "old", focus: "summary" });
    expect(result.data.outcomes[0].evidence.map(e => e.text).join(" ")).toContain("Late final decision");
    expect(result.data.outcomes[0].coverage.support).toBe("sufficient");
  });
  test.each(["summary", "transcript"] as const)("broad %s preserves both speakers and source positions", async (focus) => {
    const body = [
      { text: "The security plan uses saffron verification before launch.", speaker_name: "Ava", start_time: 0 },
      { text: "I propose an audit. We have not assigned an owner or decided to proceed.", speaker_name: "Ben", start_time: 75 },
    ];
    const result = await readMeeting(reader({ summaryOverview: "Stored security overview." }, body), { meetingRef: "old", focus, includeBody: true });
    const outcome = result.data.outcomes[0];
    const passages = outcome.evidence.filter(item => item.kind === "transcript_excerpt");
    expect(passages).toHaveLength(2);
    let start = 0;
    for (const [index, sentence] of body.entries()) {
      expect(passages[index]).toMatchObject({ text: sentence.text, speaker: sentence.speaker_name, startSecs: sentence.start_time,
        offsets: { start, end: start + sentence.text.length }, truncated: false });
      start += sentence.text.length + 1;
    }
    expect(outcome.coverage.support).toBe("sufficient");
    expect(outcome.coverage.omissionReasons).toEqual([]);
  });
  test("long broad windows preserve attribution and offsets when they cut source segments", async () => {
    const body = ["Ava", "Ben", "Cara", "Dan"].map((speaker, index) => ({ text: `${speaker}:` + String(index).repeat(5_000), speaker, start_time: index * 60 }));
    const sourceText = body.map(item => item.text).join("\n");
    const outcome = await readMeetingEvidence(reader({}, body), "old", { focus: "summary", includeBody: true });
    const passages = outcome.evidence.filter(item => item.kind === "transcript_excerpt");
    expect(new Set(passages.map(item => item.speaker))).toEqual(new Set(body.map(item => item.speaker)));
    expect(passages.length).toBeLessThanOrEqual(12);
    expect(passages.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(12_000);
    let start = 0;
    for (const sentence of body) {
      for (const passage of passages.filter(item => item.speaker === sentence.speaker)) {
        expect(passage.startSecs).toBe(sentence.start_time);
        expect(passage.offsets!.start).toBeGreaterThanOrEqual(start);
        expect(passage.offsets!.end).toBeLessThanOrEqual(start + sentence.text.length);
        expect(passage.text).toBe(sourceText.slice(passage.offsets!.start, passage.offsets!.end));
      }
      start += sentence.text.length + 1;
    }
    expect(outcome.coverage.omissionReasons).toContain("body_excerpted");
    expect(outcome.coverage.support).toBe("limited");
  });
  test.each([20, 900])("broad attribution has bounded segment count for %i-character sentences", async (length) => {
    const body = Array.from({ length: 80 }, (_, index) => ({ text: `${index}:` + "x".repeat(length), speaker: `Speaker ${index}`, start_time: index }));
    const sourceText = body.map(item => item.text).join("\n");
    const outcome = await readMeetingEvidence(reader({}, body), "old", { focus: "summary", includeBody: true });
    expect(outcome.evidence.length).toBeLessThanOrEqual(12);
    expect(outcome.evidence[0].speaker).toBe("Speaker 0");
    expect(outcome.evidence.at(-1)!.speaker).toBe("Speaker 79");
    for (const passage of outcome.evidence) {
      const index = passage.startSecs!;
      expect(passage.speaker).toBe(body[index].speaker);
      expect(passage.text).toBe(sourceText.slice(passage.offsets!.start, passage.offsets!.end));
    }
    expect(outcome.coverage.omissionReasons).toContain("body_segment_limit");
    expect(outcome.coverage.omittedEvidenceCount).toBeGreaterThan(0);
    expect(outcome.coverage.support).toBe("limited");
    const result = await readMeeting(reader({}, body), { meetingRef: "old", focus: "summary", includeBody: true });
    expect(JSON.stringify({ ok: true, tool: "tinycloud_read_meeting", result: { ...result, frames: [{ text: result.text }] } }).length).toBeLessThanOrEqual(16_000);
  });
  test.each([
    [{}, "transcript_excerpt"],
    [{ source: "google-meet" }, "body_excerpt"],
    [{ source: "google-meet", metadata: { notes_kind: "gemini", notes_association: "standalone" } }, "notes"],
  ] as const)("broad attributed passages preserve source provenance %#", async (metadata, kind) => {
    const body = [{ text: "A supplied speaker statement.", speaker_name: "Ava", start_time: 0 }, { text: "A statement without source attribution." }];
    const outcome = await readMeetingEvidence(reader({ ...metadata, participantNames: ["Ava", "Ben"] } as Partial<TranscriptMetadata>, body), "old", { focus: "summary", includeBody: true });
    expect(outcome.evidence).toHaveLength(2);
    expect(outcome.evidence[0]).toMatchObject({ kind, speaker: "Ava", startSecs: 0, text: body[0].text });
    expect(outcome.evidence[1]).toMatchObject({ kind, text: body[1].text });
    expect(outcome.evidence[1].speaker).toBeUndefined();
    expect(outcome.evidence[1].startSecs).toBeUndefined();
  });
  test("range action includeBody uses shared core and preserves per-record identity", async () => {
    let reads = 0;
    const source = reader({ summaryActionItems: "- Sam will send the memo.\n- Bob will send a draft." });
    source.getTranscript = async () => { reads++; return null; };
    const direct = await readMeeting(source, { meetingRef: "old", focus: "actions", assignee: "Sam", includeBody: true });
    const range = await listMeetingActions(source, { assignee: "Sam", includeBody: true });
    expect(reads).toBe(2);
    expect(range.data.outcomes[0]).toEqual(direct.data.outcomes[0]);
  });
  test("finder includes 12 metadata outcomes without body reads", async () => {
    const source = reader();
    source.listMetadata = async () => Array.from({ length: 15 }, (_, i) => ({ ...row, meetingRef: `ref-${String(i).padStart(2,"0")}`, sourceId: String(i) }));
    source.getTranscript = async () => { throw new Error("must not read"); };
    const result = await findMeetings(source, { limit: 12 });
    expect(result.data.meetings).toHaveLength(12);
    expect(result.data.discovery).toMatchObject({ matchedCount: 15, countKind: "exact", returnedCount: 12 });
    expect(result.data.outcomes.every(o => o.body.state === "not_requested")).toBe(true);
  });
  test("aggregate accepts deterministic oldest ordering", () => {
    // Both public schemas need the same order contract as scoped discovery.
    expect(parseFindMeetingsArgs({ sort: "oldest" })).toMatchObject({ sort: "oldest" });
    expect(parseTranscriptSearchArgs({ query: "cobalt", sort: "oldest" })).toMatchObject({ sort: "oldest" });
    expect(parseListMeetingActionsArgs({ sort: "oldest" })).toMatchObject({ sort: "oldest" });
    expect(parseReadMeetingArgs({ focus: "summary", sort: "ignored" })).toBeNull();
  });
  test("uses the writer's actual Gemini notes provenance", async () => {
    const result = await searchTranscripts(reader({ source: "google-meet", summaryOverview: "Cobalt notes", metadata: { notes_kind: "gemini", notes_association: "standalone" } }), { meetingRef: "old", query: "cobalt" });
    expect(result.data.outcomes[0].evidence.find(item => item.id === "summary")?.kind).toBe("notes");
  });
  test("does not misdecode SDK auto-parsed JSON strings", async () => {
    const source = createReader({ sql: { db: () => ({ query: async () => ({ ok: true, data: { rows: [["old", "fireflies", "old-source"]] } }) }) }, kv: { get: async (_key, options) => ({ ok: true, data: { data: options?.raw ? '"Final decision: cobalt."' : "Final decision: cobalt." } }) } });
    const result = await readMeeting(source, { meetingRef: "old", focus: "summary" });
    expect(result.data.outcomes[0].body.state).toBe("present");
  });
  test("confirmed SDK unauthorized metadata rejects the whole evidence read", async () => {
    const source = createReader({ sql: { db: () => ({ query: async () => ({ ok: false, error: { code: "AUTH_REQUIRED", meta: { status: 403 } } }) }) }, kv: { get: async () => ({}) } });
    await expect(readMeeting(source, { meetingRef: "old", focus: "summary" })).rejects.toMatchObject({ code: "access_denied" });
  });
  test("typed upstream grant revocation remains a revocation instead of ordinary storage failure", async () => {
    const source = createReader({ sql: { db: () => ({ query: async () => ({ ok: true, data: { rows: [["old", "fireflies", "old-source"]] } }) }) }, kv: { get: async () => ({ ok: false, error: { code: "DELEGATION_REVOKED" } }) } });
    await expect(readMeeting(source, { meetingRef: "old", focus: "summary" })).rejects.toMatchObject({ code: "delegation_revoked" });
  });
  test("body timeout preserves already retrieved stored action evidence", async () => {
    const source = reader({ summaryActionItems: "- Sam will send the memo." });
    source.getTranscript = async () => new Promise(() => {});
    const result = await listMeetingActions(source, { includeBody: true }, undefined, { retrievalMode: "range", deadlineAt: Date.now() + 25 });
    expect(result.data.outcomes[0]).toMatchObject({ state: "read", body: { state: "timeout" }, coverage: { bodyAttempted: true, support: "limited" } });
    expect(result.data.outcomes[0].evidence.some(item => item.kind === "action")).toBe(true);
  });
  test("action and attendance bounds explicitly report omissions", async () => {
    const source = reader({ summaryActionItems: "- Sam will " + "send ".repeat(400), participantNames: Array.from({ length: 30 }, (_, i) => `Person ${i}`) });
    const actions = await readMeeting(source, { meetingRef: "old", focus: "actions" });
    expect(actions.data.outcomes[0].evidence.find(item => item.kind === "action")?.truncated).toBe(true);
    const metadata = await findMeetings(source, {});
    expect(metadata.data.outcomes[0].coverage.omissionReasons).toContain("metadata_limit");
    expect(metadata.data.outcomes[0].evidence[0].truncated).toBe(true);
  });
  test("upstream cancellation, timeout and code-only denial remain distinct", () => {
    expect(classifyBodyFailure({ code: "TIMEOUT" }).state).toBe("timeout");
    expect(classifyBodyFailure({ code: "ABORTED" }).state).toBe("cancelled");
    expect(classifyBodyFailure({ code: "SQL_PERMISSION_DENIED" }).state).toBe("access_denied");
  });
  test("body-backed notes support decisions without counting them as stored topic matches", async () => {
    const source = reader({ source: "google-meet", metadata: { notes_kind: "gemini", notes_association: "standalone" } }, [{ text: "The final decision was cobalt." }]);
    const decisions = await readMeeting(source, { meetingRef: "old", focus: "decisions" });
    expect(decisions.data.outcomes[0].coverage.support).toBe("sufficient");
    const topic = await searchTranscripts(source, { meetingRef: "old", query: "cobalt" });
    expect(topic.data.outcomes[0].search.examinedMatches).toBe(1);
  });
  test("conference notes do not relabel the separately stored real transcript", async () => {
    const source = reader({ source: "google-meet", summaryOverview: "Generated notes.", metadata: { notes_kind: "gemini", notes_association: "conference", transcript_count: 1 } }, [{ text: "I chose cobalt.", speaker: "Sam" }]);
    const result = await readMeeting(source, { meetingRef: "old", focus: "speaker", speaker: "Sam" });
    expect(result.data.outcomes[0].evidence.some(item => item.kind === "transcript_excerpt" && item.speaker === "Sam")).toBe(true);
  });
  test("range aggregation retains eight ordered records with at most three body reads in flight", async () => {
    let active = 0; let peak = 0; let reads = 0;
    const source = reader();
    source.listMetadata = async () => Array.from({ length: 8 }, (_, i) => ({ ...row, meetingRef: `ref-${i}`, sourceId: String(i) }));
    source.getTranscript = async (_source, id) => { reads++; peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, Number(id) % 3)); active--; return [{ text: `Cobalt ${id}` }]; };
    const result = await searchTranscripts(source, { query: "cobalt" }, undefined, { retrievalMode: "range" });
    expect(reads).toBe(8); expect(peak).toBeLessThanOrEqual(3);
    expect(result.data.outcomes.map(outcome => outcome.meetingRef)).toEqual(Array.from({ length: 8 }, (_, i) => `ref-${i}`));
  });
});

describe("storage classification and scoped discovery", () => {
  function storage(body: unknown, rows: unknown[][] = [["old", "fireflies", "old-source", "Design", "2025-01-01T10:00:00Z", null, [], null, null]]) {
    const calls: Array<{ sql: string; params: unknown }> = [];
    const source = createReader({ sql: { db: () => ({ query: async (sql, params) => { calls.push({ sql, params }); return { ok: true, data: { rows } }; } }) }, kv: { get: async () => body } });
    return { source, calls };
  }
  test.each([
    [{ ok: false, error: { code: "KV_NOT_FOUND", message: "Key not found: fixture" } }, "missing"],
    [{ ok: false, error: { code: "KV_NOT_FOUND", message: "HTTP 404: Space not found", status: 404 } }, "unavailable"],
    [{ ok: false, error: { code: "KV_NOT_FOUND" } }, "unavailable"],
    [{ ok: true, data: { data: "not-json" } }, "invalid_json"],
    [{ ok: true, data: { data: '{"messages":[]}' } }, "unsupported_shape"],
    [{ ok: true, data: { data: '""' } }, "empty"],
  ])("distinguishes storage outcome %#", async (response, state) => {
    const { source } = storage(response);
    expect((await readMeeting(source, { meetingRef: "old", focus: "summary" })).data.outcomes[0].body.state).toBe(state);
  });
  test("exact lookup is parameterized and never uses the discovery ceiling", async () => {
    const { source, calls } = storage({ ok: true, data: { data: '"body"' } });
    await readMeeting(source, { meetingRef: "old", focus: "summary" });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("WHERE id = ?");
    expect(calls[0].sql).not.toContain("LIMIT 501");
    expect(calls[0].params).toEqual(["old"]);
  });
  test("raw malformed sentinel rows cannot conceal scan overflow", async () => {
    const { source, calls } = storage({}, Array.from({ length: 501 }, () => [null]));
    const result = await findMeetings(source, { from: "2025-01-01", to: "2025-01-01", source: "fireflies", limit: 12 }, "Europe/Lisbon");
    expect(result.data.discovery).toMatchObject({ countKind: "lower_bound", scanLimited: true, matchedCount: 0 });
    expect(calls[0].sql).toContain("source = ?");
    expect(calls[0].params).toContain("fireflies");
  });
  test("first-result proof follows actual instants across mixed ISO offsets at the scan ceiling", async () => {
    const db = new Database(":memory:");
    try {
      db.run("CREATE TABLE connector_meeting (id TEXT, source TEXT, source_id TEXT, title TEXT, started_at TEXT, organizer_email TEXT, participants TEXT, summary_overview TEXT, summary_action_items TEXT, metadata TEXT)");
      const insert = db.prepare("INSERT INTO connector_meeting (id, source, source_id, started_at) VALUES (?, 'fireflies', ?, ?)");
      for (let i = 0; i < 501; i++) insert.run(`early-${i}`, `early-${i}`, "2026-01-01T10:00:00+14:00");
      insert.run("actual-latest", "latest", "2026-01-01T00:00:00-12:00");
      const source = createReader({ sql: { db: () => ({ query: async (sql, params) => ({ ok: true, data: { rows: db.query(sql).values(...(params ?? [])) } }) }) }, kv: { get: async () => ({}) } });
      const result = await findMeetings(source, { selectFirst: true, sort: "newest" });
      expect(result.data.meetings[0].meetingRef).toBe("actual-latest");
      expect(result.data.discovery?.orderProven).toBe(true);
    } finally { db.close(); }
  });
  test("oversize, mixed arrays, and normalized sentence limits disclose decoding coverage", async () => {
    const cases = [[JSON.stringify("x".repeat(1_048_576)), "size_limit"], [JSON.stringify([{ text: "usable" }, { alien: true }]), "present"], [JSON.stringify([{ alien: true }]), "unsupported_shape"]] as const;
    for (const [body, state] of cases) {
      const { source } = storage({ ok: true, data: { data: body } });
      const result = await readMeeting(source, { meetingRef: "old", focus: "summary" });
      expect(result.data.outcomes[0].body.state).toBe(state);
      if (state === "present") expect(result.data.outcomes[0].body.partialDecoding).toBe(true);
    }
  });
});

describe("Exo Local meetings", () => {
  // Row and body exactly as TinyChat's localTranscriber/connectorStore write them (see its
  // localTranscriber.test.ts): source exo-local, source_id local:<session>, no recap, and a
  // Fireflies-shaped sentence array with You (mic) / Others (system audio) channel speakers.
  const sentences = [
    { index: 0, speaker_name: "You", text: "Hello there. again", start_time: 0, end_time: 3.9 },
    { index: 1, speaker_name: "Others", text: "Hi back.", start_time: 4.0, end_time: 4.6 },
  ];
  const metadata = { capture: "local", transcript_provider: "whispercpp", model: "QuantizedTinyEn", language: "en", transcript_text: "Hello there. again\nHi back.", speaker_labels: "channel-you-others" };
  function exoLocal() {
    const db = new Database(":memory:");
    db.run("CREATE TABLE connector_meeting (id TEXT, source TEXT, source_id TEXT, title TEXT, started_at TEXT, organizer_email TEXT, participants TEXT, summary_overview TEXT, summary_action_items TEXT, metadata TEXT)");
    db.prepare("INSERT INTO connector_meeting VALUES (?, 'exo-local', 'local:sess-1', 'Local recording Sep 28, 6:00 PM', '2026-09-28T18:00:00.000Z', NULL, ?, NULL, NULL, ?)")
      .run("0b6f5a52-4f0e-4c55-9d1e-6a3e0c2b7f10", JSON.stringify([{ name: "You", email: null }, { name: "Others", email: null }]), JSON.stringify(metadata));
    const keys: string[] = []; const params: unknown[] = [];
    const source = createReader({
      sql: { db: () => ({ query: async (sql, values) => { params.push(...(values ?? [])); return { ok: true, data: { rows: db.query(sql).values(...(values ?? [])) } }; } }) },
      kv: { get: async (key, options) => { keys.push(key); return key === "xyz.tinycloud.tinychat/connectors/exo-local/transcript/local:sess-1" && options?.raw
        ? { ok: true, data: { data: JSON.stringify(sentences) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "Key not found" } }; } },
    });
    return { source, keys, params, close: () => db.close() };
  }
  test("discovers TinyChat's Exo Local rows instead of silently dropping them", async () => {
    const { source, params, close } = exoLocal();
    try {
      expect(await source.listMetadata()).toHaveLength(1);
      const found = await findMeetings(source, { source: "exo-local" });
      expect(params).toContain("exo-local");
      expect(found.data.meetings).toEqual([expect.objectContaining({ meetingRef: "0b6f5a52-4f0e-4c55-9d1e-6a3e0c2b7f10", source: "exo-local", participants: ["You", "Others"] })]);
      // Opaque provider metadata, including the duplicated transcript text, stays out of metadata results.
      expect(JSON.stringify(found)).not.toContain("transcript_text");
      expect(JSON.stringify(found)).not.toContain("Hello there");
    } finally { close(); }
  });
  test("reads the You/Others body from the writer's key as an attributed transcript", async () => {
    const { source, keys, close } = exoLocal();
    try {
      const summary = (await readMeeting(source, { meetingRef: "0b6f5a52-4f0e-4c55-9d1e-6a3e0c2b7f10", focus: "summary" })).data.outcomes[0];
      expect(keys).toEqual(["xyz.tinycloud.tinychat/connectors/exo-local/transcript/local:sess-1"]);
      expect(summary).toMatchObject({ source: "exo-local", state: "read", body: { state: "present" }, coverage: { bodyAttempted: true, support: "sufficient" } });
      expect(summary.evidence.map(item => [item.kind, item.speaker, item.startSecs, item.text])).toEqual([
        ["transcript_excerpt", "You", 0, "Hello there. again"],
        ["transcript_excerpt", "Others", 4, "Hi back."],
      ]);
      const speaker = (await readMeeting(source, { meetingRef: "0b6f5a52-4f0e-4c55-9d1e-6a3e0c2b7f10", focus: "speaker", speaker: "Others" })).data.outcomes[0];
      expect(speaker.evidence).toEqual([expect.objectContaining({ kind: "transcript_excerpt", speaker: "Others", text: "Hi back." })]);
      expect(speaker.coverage.support).toBe("sufficient");
    } finally { close(); }
  });
  test("tool arguments and the TinyChat tool contract accept exactly the readable sources", async () => {
    expect(parseFindMeetingsArgs({ source: "exo-local" })).toEqual({ source: "exo-local" });
    expect(parseTranscriptSearchArgs({ query: "release", source: "exo-local" })).toMatchObject({ source: "exo-local" });
    expect(parseListMeetingActionsArgs({ source: "exo-local" })).toEqual({ source: "exo-local" });
    expect(parseFindMeetingsArgs({ source: "exo-remote" })).toBeNull();
    for (const tool of TINYCLOUD_MEETING_TOOLS) {
      const properties = tool.function.parameters.properties as { source?: { enum: readonly string[] } };
      if (properties.source) expect([...properties.source.enum]).toEqual([...TRANSCRIPT_SOURCES]);
    }
    // Unknown stored sources still never form a KV key.
    const reader = createReader({ sql: { db: () => ({ query: async () => ({ ok: true, data: { rows: [["x", "exo-remote", "local:sess-1"]] } }) }) }, kv: { get: async () => { throw new Error("must not read"); } } });
    expect(await reader.listMetadata()).toEqual([]);
    await expect(reader.readBody!("exo-remote" as never, "local:sess-1")).rejects.toMatchObject({ code: "invalid_stored_metadata" });
  });
});

describe("placeholder recaps", () => {
  // Production: a Google Meet notes recap whose Summary section is only Gemini's notice.
  const gemini = "A summary wasn't produced because there wasn't enough conversation in a supported language.";
  test.each([
    "", "   ", "N/A", "None.", "-", "TBD", "Pending", "No summary.", "Not available", "Summary unavailable", "No summary available.",
    gemini, gemini.replaceAll("'", "’"), "Gemini couldn't create notes because there wasn't enough conversation in a supported language.",
    "Notes could not be generated.", "The summary has not been generated yet.", "No summary was generated because the meeting was too short.",
    "There was not enough speech to generate a summary.", "- Summary wasn't produced for this meeting.",
  ])("%p counts as missing, so a summary reads the body", async (summaryOverview) => {
    expect(storedRecap(summaryOverview)).toBeNull();
    let reads = 0;
    const source = reader({ summaryOverview });
    source.getTranscript = async () => { reads++; return [{ text: "We chose cobalt for the launch.", speaker_name: "Ava", start_time: 12 }]; };
    const outcome = (await readMeeting(source, { meetingRef: "old", focus: "summary" })).data.outcomes[0];
    expect(reads).toBe(1);
    expect(outcome.coverage.overviewPresent).toBe(false);
    expect(outcome.evidence.map(item => [item.kind, item.text])).toEqual([["transcript_excerpt", "We chose cobalt for the launch."]]);
    expect(outcome).toMatchObject({ body: { state: "present" }, coverage: { support: "sufficient" } });
  });
  test.each([
    "Cobalt notes", "Budget approved for Q3.", "Discussed adding Portuguese as a supported language for the app.",
    "The Q3 summary wasn't produced on time, so Ava will draft it by Friday.",
    "Team agreed there was not enough discussion of hiring; Ben will schedule a follow-up.",
    "Notes were taken by Ava; the team approved the launch.", "予算と採用計画を議論した。",
  ])("real recap %p still answers a summary without a body read", async (summaryOverview) => {
    expect(storedRecap(summaryOverview)).toBe(summaryOverview);
    let reads = 0;
    const source = reader({ summaryOverview });
    source.getTranscript = async () => { reads++; return null; };
    const outcome = (await readMeeting(source, { meetingRef: "old", focus: "summary" })).data.outcomes[0];
    expect(reads).toBe(0);
    expect(outcome).toMatchObject({ body: { state: "not_requested" }, coverage: { overviewPresent: true, support: "sufficient" } });
    expect(outcome.evidence).toEqual([expect.objectContaining({ id: "summary", kind: "summary", text: summaryOverview })]);
  });
  test("a long recap that quotes a notice is not a placeholder", () => {
    const recap = `${gemini} ${"The team then reviewed the launch plan and chose cobalt. ".repeat(12)}`;
    expect(recap.length).toBeGreaterThan(600);
    expect(storedRecap(recap)).toBe(recap.trim());
  });
  test("conference notes with a placeholder summary read the stored meeting transcript", async () => {
    const source = reader({ source: "google-meet", summaryOverview: gemini, metadata: { notes_kind: "gemini", notes_association: "conference", transcript_count: 1 } },
      [{ text: "Let's ship on Thursday.", speaker_name: "Sam", start_time: 30 }]);
    const outcome = (await readMeeting(source, { meetingRef: "old", focus: "summary" })).data.outcomes[0];
    expect(outcome.evidence).toEqual([expect.objectContaining({ kind: "transcript_excerpt", speaker: "Sam", text: "Let's ship on Thursday." })]);
    expect(outcome.evidence.some(item => item.text.includes("supported language"))).toBe(false);
  });
});
