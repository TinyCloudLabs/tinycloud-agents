import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { findMeetings } from "./actions/tinycloud-search-transcripts.js";
import { createReader } from "./transcript-registry.js";

const PREFIX = "xyz.tinycloud.tinychat/connectors";
const REV_KEY = `${PREFIX}/exo-voice-note/transcript-rev/rec-1/h1`;
const PLAIN_KEY = (sourceId: string) => `${PREFIX}/exo-voice-note/transcript/${sourceId}`;

function fixture(options: { index: boolean }) {
  const db = new Database(":memory:");
  db.run("CREATE TABLE connector_meeting (id TEXT, source TEXT, source_id TEXT, title TEXT, started_at TEXT, organizer_email TEXT, participants TEXT, summary_overview TEXT, summary_action_items TEXT, metadata TEXT)");
  if (options.index) {
    db.run("CREATE TABLE voice_note_transcript (source_id TEXT PRIMARY KEY, rev INTEGER NOT NULL, hash TEXT NOT NULL, body_key TEXT NOT NULL, outcome TEXT NOT NULL, committed_at TEXT NOT NULL)");
  }
  return db;
}

function insertMeeting(db: Database, id: string, source: string, sourceId: string, metadata: unknown) {
  db.run(
    "INSERT INTO connector_meeting (id, source, source_id, started_at, metadata) VALUES (?, ?, ?, ?, ?)",
    [id, source, sourceId, "2026-03-02T10:00:00Z", metadata === null ? null : JSON.stringify(metadata)],
  );
}

function insertCommit(db: Database, sourceId: string, outcome: string, bodyKey: string) {
  db.run(
    "INSERT INTO voice_note_transcript (source_id, rev, hash, body_key, outcome, committed_at) VALUES (?, 1, 'h1', ?, ?, '2026-03-02T10:00:00Z')",
    [sourceId, bodyKey, outcome],
  );
}

function reader(db: Database, kv: Map<string, unknown>) {
  return createReader({
    sql: { db: () => ({ query: async (sql: string, params?: unknown[]) => ({ ok: true, data: { rows: db.query(sql).values(...((params ?? []) as never[])) } }) }) },
    kv: { get: async (key: string) => kv.has(key) ? { ok: true, data: { data: kv.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND" } } },
  } as never);
}

const sentences = (text: string) => [{ text }];

describe("voice notes in the registry", () => {
  test("a committed note is listed and read from its committed revision", async () => {
    const db = fixture({ index: true });
    insertMeeting(db, "r-rec", "exo-voice-note", "rec-1", { transcription_outcome: "transcribed" });
    insertCommit(db, "rec-1", "transcribed", REV_KEY);
    const kv = new Map<string, unknown>([[REV_KEY, sentences("committed revision text")], [PLAIN_KEY("rec-1"), []]]);
    const r = reader(db, kv);
    expect((await r.listMetadata()).map(row => row.meetingRef)).toEqual(["r-rec"]);
    expect(JSON.stringify(await r.getTranscript("exo-voice-note", "rec-1"))).toContain("committed revision text");
    db.close();
  });

  test("a pasted note with no commit is not listed, found, or read", async () => {
    const db = fixture({ index: true });
    insertMeeting(db, "r-paste", "exo-voice-note", "paste-1", { source: "pasted", transcription_outcome: "pending" });
    const kv = new Map<string, unknown>([[PLAIN_KEY("paste-1"), []]]);
    const r = reader(db, kv);
    expect(await r.listMetadata()).toEqual([]);
    expect(await r.getMetadata("r-paste")).toBeNull();
    expect((await findMeetings(r, { source: "exo-voice-note" } as never)).data.meetings).toEqual([]);
    db.close();
  });

  test("a note committed as no_speech is neither listed nor readable", async () => {
    const db = fixture({ index: true });
    const silentKey = `${PREFIX}/exo-voice-note/transcript-rev/silent-1/h1`;
    insertMeeting(db, "r-silent", "exo-voice-note", "silent-1", { transcription_outcome: "no_speech" });
    insertCommit(db, "silent-1", "no_speech", silentKey);
    const kv = new Map<string, unknown>([[silentKey, sentences("should stay hidden")]]);
    const r = reader(db, kv);
    expect(await r.listMetadata()).toEqual([]);
    expect((await r.readBody("exo-voice-note", "silent-1")).state).toBe("missing");
    db.close();
  });

  test("a body_key outside the voice-note revision prefix is not read", async () => {
    const db = fixture({ index: true });
    insertMeeting(db, "r-odd", "exo-voice-note", "odd-1", { transcription_outcome: "transcribed" });
    insertCommit(db, "odd-1", "transcribed", `${PREFIX}/fireflies/transcript/ff-1`);
    const kv = new Map<string, unknown>([[`${PREFIX}/fireflies/transcript/ff-1`, sentences("other source body")]]);
    expect((await reader(db, kv).readBody("exo-voice-note", "odd-1")).state).toBe("missing");
    db.close();
  });

  test("without a commit table, a transcribed mirror is listed and read from the plain key", async () => {
    const db = fixture({ index: false });
    insertMeeting(db, "r-mirror", "exo-voice-note", "mirror-1", { transcription_outcome: "transcribed", transcript_text: "mirror text" });
    insertMeeting(db, "r-pending", "exo-voice-note", "pending-1", { transcription_outcome: "pending" });
    const kv = new Map<string, unknown>([[PLAIN_KEY("mirror-1"), sentences("mirror body")]]);
    const r = reader(db, kv);
    expect((await r.listMetadata()).map(row => row.meetingRef)).toEqual(["r-mirror"]);
    expect(JSON.stringify(await r.getTranscript("exo-voice-note", "mirror-1"))).toContain("mirror body");
    db.close();
  });

  test("other sources are listed regardless of voice-note state", async () => {
    const db = fixture({ index: true });
    insertMeeting(db, "r-ff", "fireflies", "ff-1", null);
    insertMeeting(db, "r-paste", "exo-voice-note", "paste-1", { transcription_outcome: "pending" });
    const r = reader(db, new Map());
    expect((await r.listMetadata()).map(row => row.meetingRef)).toEqual(["r-ff"]);
    db.close();
  });
});
