import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readMeeting } from "./actions/tinycloud-search-transcripts.js";
import { createReader } from "./transcript-registry.js";

// TC-2190: the note/meeting row stores `speaker_names` (original label -> display name) in its metadata (TC-2189).
const PREFIX = "xyz.tinycloud.tinychat/connectors";
const VOICE_ID = "5c1f9e2a-7d3b-4e8a-9f60-2b8c4d1e7a93";
const HASH = "3f9a1c2e7b4d8f05a6e1c3b2d9f04e7a";
const VOICE_KEY = `${PREFIX}/exo-voice-note/transcript-rev/${VOICE_ID}/${HASH}`;
const MEETING_KEY = `${PREFIX}/fireflies/transcript/ff-1`;
const SENTENCES = [
  { text: "We chose cobalt for launch.", speaker_name: "Speaker A", start_time: 4 },
  { text: "Agreed, ship it.", speaker_name: "Speaker B", start_time: 9 },
  { text: "Me too.", speaker_name: "Me", start_time: 12 },
];

function fixture(metadataFor: { voice?: unknown; meeting?: unknown }) {
  const db = new Database(":memory:");
  db.run("CREATE TABLE connector_meeting (id TEXT, source TEXT, source_id TEXT, title TEXT, started_at TEXT, organizer_email TEXT, participants TEXT, summary_overview TEXT, summary_action_items TEXT, metadata TEXT)");
  db.run("CREATE TABLE voice_note_transcript (source_id TEXT PRIMARY KEY, rev INTEGER NOT NULL, hash TEXT NOT NULL, body_key TEXT NOT NULL, outcome TEXT NOT NULL, committed_at TEXT NOT NULL)");
  db.run("INSERT INTO connector_meeting (id, source, source_id, started_at, metadata) VALUES (?, 'exo-voice-note', ?, '2026-03-02T10:00:00Z', ?)",
    [`vn-${VOICE_ID}`, VOICE_ID, JSON.stringify({ transcription_outcome: "transcribed", ...(metadataFor.voice as object) })]);
  db.run("INSERT INTO voice_note_transcript VALUES (?, 1, ?, ?, 'transcribed', '2026-03-02T10:00:00Z')", [VOICE_ID, HASH, VOICE_KEY]);
  db.run("INSERT INTO connector_meeting (id, source, source_id, started_at, metadata) VALUES ('ff-1', 'fireflies', 'ff-1', '2026-03-02T11:00:00Z', ?)",
    [JSON.stringify({ ...(metadataFor.meeting as object) })]);
  const kv = new Map<string, unknown>([[VOICE_KEY, SENTENCES], [MEETING_KEY, SENTENCES]]);
  const r = createReader({
    sql: { db: () => ({ query: async (sql: string, params?: unknown[]) => ({ ok: true, data: { rows: db.query(sql).values(...((params ?? []) as never[])) } }) }) },
    kv: { get: async (key: string) => kv.has(key) ? { ok: true, data: { data: kv.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND" } } },
  } as never);
  return { r, close: () => db.close() };
}

const speakers = (value: unknown) => (value as Array<{ speaker_name: string }>).map(item => item.speaker_name);

describe("transcript bodies use the speaker_names stored on the note", () => {
  const names = { speaker_names: { "Speaker A": "Dana", Me: "Sam" } };

  test("a voice note presents renamed speakers and leaves unrenamed ones unchanged", async () => {
    const { r, close } = fixture({ voice: names });
    expect(speakers(await r.getTranscript("exo-voice-note", VOICE_ID))).toEqual(["Dana", "Speaker B", "Sam"]);
    close();
  });

  test("a meeting presents renamed speakers and leaves unrenamed ones unchanged", async () => {
    const { r, close } = fixture({ meeting: names });
    expect(speakers(await r.getTranscript("fireflies", "ff-1"))).toEqual(["Dana", "Speaker B", "Sam"]);
    close();
  });

  test("renaming one note does not rename the same label on another note", async () => {
    const { r, close } = fixture({ voice: names });
    expect(speakers(await r.getTranscript("fireflies", "ff-1"))).toEqual(["Speaker A", "Speaker B", "Me"]);
    close();
  });

  test("sentence text and timing are untouched", async () => {
    const { r, close } = fixture({ meeting: names });
    const body = await r.getTranscript("fireflies", "ff-1") as typeof SENTENCES;
    expect(body.map(({ text, start_time }) => ({ text, start_time }))).toEqual(SENTENCES.map(({ text, start_time }) => ({ text, start_time })));
    close();
  });

  test("a note without speaker_names reads exactly as stored", async () => {
    const { r, close } = fixture({ voice: {}, meeting: {} });
    expect(await r.getTranscript("exo-voice-note", VOICE_ID)).toEqual(SENTENCES);
    expect(await r.getTranscript("fireflies", "ff-1")).toEqual(SENTENCES);
    close();
  });

  test("a malformed map is ignored rather than breaking the read", async () => {
    for (const bad of [["Speaker A", "Dana"], "Dana", { "Speaker A": 7, "Speaker B": "" }, { constructor: "Hacker" }]) {
      const { r, close } = fixture({ meeting: { speaker_names: bad } });
      expect(await r.getTranscript("fireflies", "ff-1")).toEqual(SENTENCES);
      close();
    }
  });
});

describe("renamed speakers answer speaker questions as attributed evidence", () => {
  test("asking for the renamed speaker finds their lines cited under the new name, for notes and meetings", async () => {
    const names = { speaker_names: { "Speaker A": "Dana" } };
    const { r, close } = fixture({ voice: names, meeting: names });
    for (const meetingRef of [`vn-${VOICE_ID}`, "ff-1"]) {
      const outcome = (await readMeeting(r, { meetingRef, focus: "speaker", speaker: "Dana" })).data.outcomes[0];
      expect(outcome.evidence).toEqual([expect.objectContaining({ kind: "transcript_excerpt", speaker: "Dana", text: "We chose cobalt for launch.", startSecs: 4 })]);
      // The original label no longer names anyone on this note.
      const original = (await readMeeting(r, { meetingRef, focus: "speaker", speaker: "Speaker A" })).data.outcomes[0];
      expect(original.evidence.filter(item => item.kind === "transcript_excerpt")).toEqual([]);
    }
    close();
  });

  test("an unrenamed speaker is still found by the original label", async () => {
    const { r, close } = fixture({ meeting: { speaker_names: { "Speaker A": "Dana" } } });
    const outcome = (await readMeeting(r, { meetingRef: "ff-1", focus: "speaker", speaker: "Speaker B" })).data.outcomes[0];
    expect(outcome.evidence).toEqual([expect.objectContaining({ kind: "transcript_excerpt", speaker: "Speaker B", text: "Agreed, ship it." })]);
    close();
  });
});
