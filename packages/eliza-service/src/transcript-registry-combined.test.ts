import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { findMeetings, parseFindMeetingsArgs } from "./actions/tinycloud-search-transcripts.js";
import { FILTER_PROPERTIES } from "./tasks/tool-contract.js";
import { createReader } from "./transcript-registry.js";

type Row = [id: string, source: string, sourceId: string, startedAt: string | null, metadata: string | null];

const MERGED = "merged-1";
const member = (source: string, sourceId: string) => ({ source, source_id: sourceId });
const combined = (members: unknown[]) => JSON.stringify({ merge: { v: 1, members } });

function fixture(rows: Row[]) {
  const db = new Database(":memory:");
  db.run("CREATE TABLE connector_meeting (id TEXT, source TEXT, source_id TEXT, title TEXT, started_at TEXT, organizer_email TEXT, participants TEXT, summary_overview TEXT, summary_action_items TEXT, metadata TEXT)");
  const insert = db.prepare("INSERT INTO connector_meeting (id, source, source_id, started_at, metadata) VALUES (?, ?, ?, ?, ?)");
  for (const [id, source, sourceId, startedAt, metadata] of rows) insert.run(id, source, sourceId, startedAt, metadata);
  return db;
}

const reader = (db: Database, failCombinedRead?: { code: string }) => createReader({
  sql: { db: () => ({ query: async (sql: string, params?: unknown[]) => {
    if (failCombinedRead && sql.startsWith("SELECT source, source_id, metadata")) return { ok: false, error: failCombinedRead };
    return { ok: true, data: { rows: db.query(sql).values(...((params ?? []) as never[])) } };
  } }) },
  kv: { get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND" } }) },
} as never);

const mergedRow: Row = ["r-merged", "exo-merged", MERGED, "2026-03-02T10:00:00Z", combined([member("fireflies", "ff-1"), member("google-meet", "gm-1")])];
const memberRows: Row[] = [
  ["r-ff", "fireflies", "ff-1", "2026-03-02T09:00:00Z", null],
  ["r-gm", "google-meet", "gm-1", "2026-03-02T09:30:00Z", null],
];
const decoy: Row = ["r-decoy", "fireflies", "ff-other", "2026-03-01T10:00:00Z", null];

describe("combined-meeting exclusion in the registry", () => {
  test("list shows the combined meeting and neither member", async () => {
    const db = fixture([mergedRow, ...memberRows, decoy]);
    const refs = (await reader(db).listMetadata()).map(row => row.meetingRef).sort();
    expect(refs).toEqual(["r-decoy", "r-merged"]);
    db.close();
  });

  test("a source filter that excludes the combined row still hides its members", async () => {
    const db = fixture([mergedRow, ...memberRows, decoy]);
    const result = await findMeetings(reader(db), { source: "fireflies" } as never);
    expect(result.data.meetings.map(row => row.meetingRef)).toEqual(["r-decoy"]);
    db.close();
  });

  test("a date window that excludes the combined row still hides its members", async () => {
    const db = fixture([["r-merged", "exo-merged", MERGED, "2026-03-05T10:00:00Z", combined([member("fireflies", "ff-1"), member("google-meet", "gm-1")])], ...memberRows, decoy]);
    const result = await findMeetings(reader(db), { from: "2026-03-01", to: "2026-03-02" } as never);
    expect(result.data.meetings.map(row => row.meetingRef)).toEqual(["r-decoy"]);
    db.close();
  });

  test("a source filter for exo-merged returns the combined meeting", async () => {
    const db = fixture([mergedRow, ...memberRows, decoy]);
    const result = await findMeetings(reader(db), { source: "exo-merged" } as never);
    expect(result.data.meetings.map(row => row.meetingRef)).toEqual(["r-merged"]);
    db.close();
  });

  test("get of a member is null; get of the combined row and of a decoy resolve", async () => {
    const db = fixture([mergedRow, ...memberRows, decoy]);
    const source = reader(db);
    expect(await source.getMetadata!("r-ff")).toBeNull();
    expect((await source.getMetadata!("r-merged"))?.meetingRef).toBe("r-merged");
    expect((await source.getMetadata!("r-decoy"))?.meetingRef).toBe("r-decoy");
    db.close();
  });

  test("with no combined rows, list returns every row", async () => {
    const db = fixture([...memberRows, decoy]);
    const refs = (await reader(db).listMetadata()).map(row => row.meetingRef).sort();
    expect(refs).toEqual(["r-decoy", "r-ff", "r-gm"]);
    db.close();
  });

  test("an unreadable combined row hides nothing and is not listed", async () => {
    const db = fixture([["r-bad", "exo-merged", "bad-1", "2026-03-02T10:00:00Z", "not json"], ...memberRows]);
    const refs = (await reader(db).listMetadata()).map(row => row.meetingRef).sort();
    expect(refs).toEqual(["r-ff", "r-gm"]);
    db.close();
  });

  test("a failed exclusion read proceeds without hiding anything", async () => {
    const db = fixture([mergedRow, ...memberRows, decoy]);
    const refs = (await reader(db, { code: "UNKNOWN" }).listMetadata()).map(row => row.meetingRef).sort();
    expect(refs).toEqual(["r-decoy", "r-ff", "r-gm", "r-merged"]);
    db.close();
  });

  test("an access failure during the exclusion read propagates", async () => {
    const db = fixture([mergedRow, ...memberRows]);
    await expect(reader(db, { code: "AUTH_REQUIRED" }).listMetadata()).rejects.toMatchObject({ code: "access_denied" });
    db.close();
  });
});

describe("exo-merged as a source", () => {
  test("the source filter accepts exo-merged and still rejects unknown sources", () => {
    expect(parseFindMeetingsArgs({ source: "exo-merged" })).toMatchObject({ source: "exo-merged" });
    expect(parseFindMeetingsArgs({ source: "not-a-source" })).toBeNull();
    expect(FILTER_PROPERTIES.source.enum).toContain("exo-merged");
  });
});
