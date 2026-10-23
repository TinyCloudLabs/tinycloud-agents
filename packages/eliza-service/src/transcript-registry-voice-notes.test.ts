import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { findMeetings } from "./actions/tinycloud-search-transcripts.js";
import { createReader } from "./transcript-registry.js";

const PREFIX = "xyz.tinycloud.tinychat/connectors";
const REV_PREFIX = `${PREFIX}/exo-voice-note/transcript-rev/`;
const SOURCE_ID = "5c1f9e2a-7d3b-4e8a-9f60-2b8c4d1e7a93";
const HASH = "3f9a1c2e7b4d8f05a6e1c3b2d9f04e7a";
const OTHER_ID = "0e8d4b7a-2c91-4f3e-8a5b-6d7c9e1f2a40";
const SILENT_HASH = "9b2e7d1c4a6f30e85c1d7b9a2e4f6c08";
const LEGACY_ID = "7a2c5e9d-1b3f-4d6a-8c0e-9f1a2b3c4d5e";
const revKey = (id: string, hash: string) => `${REV_PREFIX}${id}/${hash}`;
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

function insertCommit(db: Database, sourceId: string, hash: string, outcome: string, bodyKey: string) {
  db.run(
    "INSERT INTO voice_note_transcript (source_id, rev, hash, body_key, outcome, committed_at) VALUES (?, 1, ?, ?, ?, '2026-03-02T10:00:00Z')",
    [sourceId, hash, bodyKey, outcome],
  );
}

// `gets` records every KV key the reader asks for, so a test can prove a key was never read.
function reader(db: Database, kv: Map<string, unknown>, gets: string[] = []) {
  return createReader({
    sql: { db: () => ({ query: async (sql: string, params?: unknown[]) => ({ ok: true, data: { rows: db.query(sql).values(...((params ?? []) as never[])) } }) }) },
    kv: {
      get: async (key: string) => {
        gets.push(key);
        return kv.has(key) ? { ok: true, data: { data: kv.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND" } };
      },
    },
  } as never);
}

const sentences = (text: string) => [{ text }];

describe("voice notes in the registry", () => {
  test("a committed note is listed and read from its committed revision", async () => {
    const db = fixture({ index: true });
    insertMeeting(db, `vn-${SOURCE_ID}`, "exo-voice-note", SOURCE_ID, { transcription_outcome: "transcribed" });
    insertCommit(db, SOURCE_ID, HASH, "transcribed", revKey(SOURCE_ID, HASH));
    const kv = new Map<string, unknown>([[revKey(SOURCE_ID, HASH), sentences("committed revision text")], [PLAIN_KEY(SOURCE_ID), []]]);
    const gets: string[] = [];
    const r = reader(db, kv, gets);
    expect((await r.listMetadata()).map(row => row.meetingRef)).toEqual([`vn-${SOURCE_ID}`]);
    expect(JSON.stringify(await r.getTranscript("exo-voice-note", SOURCE_ID))).toContain("committed revision text");
    expect(gets).toContain(revKey(SOURCE_ID, HASH));
    expect(gets).not.toContain(PLAIN_KEY(SOURCE_ID));
    db.close();
  });

  test("a pasted note with no commit is not listed, found, or read", async () => {
    const db = fixture({ index: true });
    insertMeeting(db, "vn-paste", "exo-voice-note", "paste-1", { source: "pasted", transcription_outcome: "pending" });
    const kv = new Map<string, unknown>([[PLAIN_KEY("paste-1"), sentences("plain-key body")]]);
    const gets: string[] = [];
    const r = reader(db, kv, gets);
    expect(await r.listMetadata()).toEqual([]);
    expect(await r.getMetadata("vn-paste")).toBeNull();
    expect((await findMeetings(r, { source: "exo-voice-note" } as never)).data.meetings).toEqual([]);
    expect((await r.readBody("exo-voice-note", "paste-1")).state).toBe("missing");
    expect(gets).toEqual([]);
    db.close();
  });

  test("a note committed as no_speech is neither listed nor readable", async () => {
    const db = fixture({ index: true });
    const silentKey = revKey("silent-1", SILENT_HASH);
    insertMeeting(db, "vn-silent", "exo-voice-note", "silent-1", { transcription_outcome: "no_speech" });
    insertCommit(db, "silent-1", SILENT_HASH, "no_speech", silentKey);
    const kv = new Map<string, unknown>([[silentKey, sentences("should stay hidden")]]);
    const gets: string[] = [];
    const r = reader(db, kv, gets);
    expect(await r.listMetadata()).toEqual([]);
    expect((await r.readBody("exo-voice-note", "silent-1")).state).toBe("missing");
    expect(gets).toEqual([]);
    db.close();
  });

  // Each forged body key must be rejected before any KV read; the rev-prefix check alone let these through.
  const forgedKeys: Array<[string, string, string]> = [
    ["another source id under the rev prefix", HASH, `${REV_PREFIX}${OTHER_ID}/${HASH}`],
    ["traversal to another source's transcript", HASH, `${REV_PREFIX}../../fireflies/transcript/ff-1`],
    ["traversal to another app's secret", HASH, `${REV_PREFIX}../../../other.app/secret`],
    ["extra path segment after the hash", HASH, `${revKey(SOURCE_ID, HASH)}/extra`],
    ["a non-hex revision hash", "h", `${REV_PREFIX}${SOURCE_ID}/h`],
  ];
  for (const [label, hash, bodyKey] of forgedKeys) {
    test(`a committed body_key with ${label} is never read`, async () => {
      const db = fixture({ index: true });
      insertMeeting(db, `vn-${SOURCE_ID}`, "exo-voice-note", SOURCE_ID, { transcription_outcome: "transcribed" });
      insertCommit(db, SOURCE_ID, hash, "transcribed", bodyKey);
      const kv = new Map<string, unknown>([[bodyKey, sentences("forged body")]]);
      const gets: string[] = [];
      const r = reader(db, kv, gets);
      expect((await r.readBody("exo-voice-note", SOURCE_ID)).state).toBe("missing");
      expect(JSON.stringify(await r.getTranscript("exo-voice-note", SOURCE_ID))).not.toContain("forged body");
      expect(gets).toEqual([]);
      db.close();
    });
  }

  test("a legacy note with transcript text but no outcome and no commit is neither listed nor read", async () => {
    const db = fixture({ index: true });
    insertMeeting(db, `vn-${LEGACY_ID}`, "exo-voice-note", LEGACY_ID, { transcript_text: "legacy text" });
    const kv = new Map<string, unknown>([[PLAIN_KEY(LEGACY_ID), sentences("legacy body")]]);
    const gets: string[] = [];
    const r = reader(db, kv, gets);
    expect(await r.listMetadata()).toEqual([]);
    expect((await r.readBody("exo-voice-note", LEGACY_ID)).state).toBe("missing");
    expect(gets).toEqual([]);
    db.close();
  });

  test("without a commit table, a transcribed mirror is listed and read from the plain key", async () => {
    const db = fixture({ index: false });
    insertMeeting(db, "vn-mirror", "exo-voice-note", "mirror-1", { transcription_outcome: "transcribed", transcript_text: "mirror text" });
    insertMeeting(db, "vn-pending", "exo-voice-note", "pending-1", { transcription_outcome: "pending" });
    const kv = new Map<string, unknown>([[PLAIN_KEY("mirror-1"), sentences("mirror body")]]);
    const r = reader(db, kv);
    expect((await r.listMetadata()).map(row => row.meetingRef)).toEqual(["vn-mirror"]);
    expect(JSON.stringify(await r.getTranscript("exo-voice-note", "mirror-1"))).toContain("mirror body");
    db.close();
  });

  test("other sources are listed regardless of voice-note state", async () => {
    const db = fixture({ index: true });
    insertMeeting(db, "ff-meeting", "fireflies", "ff-1", null);
    insertMeeting(db, "vn-paste", "exo-voice-note", "paste-1", { transcription_outcome: "pending" });
    const r = reader(db, new Map());
    expect((await r.listMetadata()).map(row => row.meetingRef)).toEqual(["ff-meeting"]);
    db.close();
  });
});
