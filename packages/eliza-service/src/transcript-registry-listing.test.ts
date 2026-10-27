import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createReader } from "./transcript-registry.js";
import { findMeetings } from "./actions/tinycloud-search-transcripts.js";
import { TRANSCRIPT_RESPONSE_BYTE_LIMIT } from "./transcript-transport.js";
import { metadataOutcome } from "./meeting-evidence.js";

type Row = [id: string, source: string, sourceId: string, startedAt: string, metadata: string | null, summary?: string];

function fixture(rows: Row[]) {
  const db = new Database(":memory:");
  db.run("CREATE TABLE connector_meeting (id TEXT, source TEXT, source_id TEXT, title TEXT, started_at TEXT, organizer_email TEXT, participants TEXT, summary_overview TEXT, summary_action_items TEXT, metadata TEXT)");
  const insert = db.prepare("INSERT INTO connector_meeting (id, source, source_id, title, started_at, participants, summary_overview, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const [id, source, sourceId, startedAt, metadata, summary] of rows) {
    insert.run(id, source, sourceId, `Meeting ${id}`, startedAt, JSON.stringify([{ name: "Ada", email: "ada@example.invalid" }]), summary ?? null, metadata);
  }
  return db;
}

/** Records SQL response sizes as the transcript transport would count them. */
function reader(db: Database) {
  const sizes: number[] = [];
  const instance = createReader({
    sql: { db: () => ({ query: async (sql: string, params?: unknown[]) => {
      const response = { ok: true, data: { rows: db.query(sql).values(...((params ?? []) as never[])) } };
      sizes.push(new TextEncoder().encode(JSON.stringify(response)).byteLength);
      return response;
    } }) },
    kv: { get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND" } }) },
  } as never);
  return { instance, sizes };
}

const day = (index: number) => new Date(Date.UTC(2026, 9, 21) - index * 3_600_000).toISOString();
const transcript = "Ada: we agreed to ship the importer on Friday.\n".repeat(1_100);

describe("meeting listing keeps transcripts stored in metadata out of the response", () => {
  test("501 transcript-heavy rows list under the transport cap", async () => {
    const rows: Row[] = Array.from({ length: 501 }, (_, i) => [`m-${i}`, "tinycloud-transcriber", `t-${i}`, day(i),
      JSON.stringify({ transcript_text: transcript, type: "transcript", transcript_count: 1 }), "Short recap. ".repeat(80)]);
    const db = fixture(rows);
    const raw = db.query("SELECT sum(length(metadata)) AS bytes FROM connector_meeting").get() as { bytes: number };
    expect(raw.bytes).toBeGreaterThan(20 * TRANSCRIPT_RESPONSE_BYTE_LIMIT);

    const { instance, sizes } = reader(db);
    const discovered = await instance.discoverMetadata!({ limit: 12 } as never, {});
    expect(discovered.rows).toHaveLength(12);
    expect(discovered.discovery).toMatchObject({ scanLimited: true, countKind: "lower_bound", nextCursor: 12 });
    expect(discovered.rows[0]).toMatchObject({ meetingRef: "m-0", metadata: { type: "transcript", transcript_count: 1 } });
    const lastFew = await findMeetings(instance, { limit: 12 } as never);
    expect(lastFew.data.meetings).toHaveLength(12);
    expect(lastFew.data.discovery).toMatchObject({ nextCursor: 12, scanLimited: true });
    const listed = await instance.listMetadata();
    expect(listed).toHaveLength(501);
    expect(Math.max(...sizes)).toBeLessThan(TRANSCRIPT_RESPONSE_BYTE_LIMIT);
    db.close();
  });

  test("metadata projection preserves valid markers and caps overlong provenance for listing", async () => {
    const cases: Array<[metadata: string | null, expected: Record<string, unknown> | undefined]> = [
      [JSON.stringify({ type: "transcript", kind: "notes", transcript_count: 3, transcript_text: transcript }), { type: "transcript", kind: "notes", transcript_count: 3 }],
      [JSON.stringify({ artifactType: "gemini_notes", notes_association: "réunion", provider: { raw: "x".repeat(5_000) } }), { artifactType: "gemini_notes", notes_association: "réunion" }],
      [JSON.stringify({ artifact_type: { nested: true }, document_type: 5, documentType: ["a"], notes_kind: "x".repeat(150) }), undefined],
      ['{"transcript_count":2.0}', { transcript_count: 2 }],
      ['{"transcript_count":2.5}', undefined],
      ['{"transcript_count":-1}', undefined],
      ['{"transcript_count":"3"}', undefined],
      ["[1,2]", undefined],
      ["not json", undefined],
      [null, undefined],
    ];
    const db = fixture(cases.map(([metadata], i) => [`c-${i}`, "fireflies", `f-${i}`, day(i), metadata]));
    const { instance } = reader(db);
    const listed = new Map((await instance.listMetadata()).map(row => [row.meetingRef, row]));
    for (const [i, [, expected]] of cases.entries()) {
      expect(listed.get(`c-${i}`)?.metadata).toEqual(i === 2 ? { notes_kind: "x".repeat(99) } : expected);
      expect(listed.get(`c-${i}`)?.listingTruncated).toBe(i === 2);
      expect((await instance.getMetadata(`c-${i}`))?.metadata).toEqual(expected);
    }
    db.close();
  });
  test("oversized provenance markers are capped before SQL responses are serialized", async () => {
    const db = fixture([["large-marker", "fireflies", "f-large", day(0),
      JSON.stringify({ type: "x".repeat(TRANSCRIPT_RESPONSE_BYTE_LIMIT + 1) })]]);
    const { instance, sizes } = reader(db);
    const [listed] = await instance.listMetadata();
    expect(listed.metadata).toEqual({ type: "x".repeat(99) });
    expect(listed.listingTruncated).toBe(true);
    expect(Math.max(...sizes)).toBeLessThan(TRANSCRIPT_RESPONSE_BYTE_LIMIT);
    db.close();
  });
  test("unbounded merge-member arrays cannot overflow listing or exclusion responses", async () => {
    const members = Array.from({ length: 20_000 }, (_, i) => ({
      source: "fireflies", source_id: `f-${i}-${"x".repeat(32)}`,
    }));
    const metadata = JSON.stringify({ merge: { v: 1, members } });
    const db = fixture([
      ["combined", "exo-merged", "merged-1", day(0), metadata],
      ["member", "fireflies", members[0].source_id, day(1), null],
      ["ordinary", "fireflies", "ordinary-1", day(2), metadata],
    ]);
    const { instance, sizes } = reader(db);
    const listed = await instance.listMetadata();
    expect(listed.map(row => row.meetingRef)).toContain("member");
    expect(listed.map(row => row.meetingRef)).toContain("ordinary");
    expect(listed.map(row => row.meetingRef)).not.toContain("combined");
    expect(Math.max(...sizes)).toBeLessThan(TRANSCRIPT_RESPONSE_BYTE_LIMIT);
    db.close();
  });
  test("combined exclusions page through more rows than one capped response", async () => {
    const combined: Row[] = Array.from({ length: 3_000 }, (_, i) => [`${"m".repeat(120)}${String(i).padStart(8, "0")}`, "exo-merged", "\u0001".repeat(512), day(i),
      JSON.stringify({ merge: { v: 1, members: [{ source: "fireflies", source_id: `capture-${i}` }] }, padding: "x".repeat(400) })]);
    const members: Row[] = Array.from({ length: 3_000 }, (_, i) => [`capture-${i}`, "fireflies", `capture-${i}`, day(i), null]);
    const db = fixture([...combined, ...members]);
    const { instance, sizes } = reader(db);
    const listed = await instance.listMetadata();
    expect(listed).toHaveLength(250);
    expect(listed.some(row => row.source === "fireflies")).toBe(false);
    expect(Math.max(...sizes)).toBeLessThan(TRANSCRIPT_RESPONSE_BYTE_LIMIT);
    db.close();
  });
  test("byte-budgets max-sized list rows, marks clipped display fields, and skips oversized IDs", async () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE connector_meeting (id TEXT, source TEXT, source_id TEXT, title TEXT, started_at TEXT, organizer_email TEXT, participants TEXT, summary_overview TEXT, summary_action_items TEXT, metadata TEXT)");
    const insert = db.prepare("INSERT INTO connector_meeting VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const participantPrefix = '[{"name":"Ada","pad":"';
    const participantSuffix = '"}]';
    const participantFillerLength = 4_096 - participantPrefix.length - participantSuffix.length;
    const participantEscape = "\\u0001";
    const participantFiller = participantEscape.repeat(Math.floor(participantFillerLength / participantEscape.length));
    const participants = `${participantPrefix}${participantFiller}${" ".repeat(participantFillerLength - participantFiller.length)}${participantSuffix}`;
    const markers = Object.fromEntries(["artifactType", "artifact_type", "type", "kind", "documentType", "document_type", "notes_kind", "notes_association"].map(key => [key, "\u0001".repeat(99)]));
    for (let i = 0; i < 32; i++) {
      const id = `${"a".repeat(120)}${String(i).padStart(8, "0")}`;
      insert.run(id, "exo-local", "\u0001".repeat(512), "\u0001".repeat(512), `${day(i)}${" ".repeat(64 - day(i).length)}`, "\u0001".repeat(254), participants,
        "\u0001".repeat(4096), "\u0001".repeat(4096), JSON.stringify({ ...markers, transcript_count: 1 }));
    }
    insert.run("clipped-row", "exo-local", "clip", "t".repeat(600), day(40), "o".repeat(254), participants, "r".repeat(5000), "a".repeat(5000), JSON.stringify({ type: "m".repeat(200) }));
    insert.run("x".repeat(1025), "exo-local", "oversize", "Oversized ID", day(41), "o".repeat(254), participants, "r".repeat(4096), "a".repeat(4096), "{}");
    insert.run("invalid-participants", "exo-local", "invalid-participants", "Invalid attendees", day(42), null, "\u0001".repeat(4096), "summary", "actions", "{}");
    const { instance, sizes } = reader(db);
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const listed = await instance.listMetadata();
      expect(listed).toHaveLength(34);
      expect(listed.find(row => row.meetingRef === "invalid-participants")).toMatchObject({
        participantNames: [], metadataLimited: false, listingTruncated: true,
      });
      expect(listed[0]).toMatchObject({ listingTruncated: false, participantNames: ["Ada"], summaryOverview: "\u0001".repeat(4096), summaryActionItems: "\u0001".repeat(4096) });
      expect(listed[0].meetingRef).toHaveLength(128);
      expect(listed[0].sourceId).toHaveLength(512);
      expect(listed[0].title).toBe("\u0001".repeat(512));
      expect(listed[0].organizerEmail).toBe("\u0001".repeat(254));
      expect(listed[0].metadata?.type).toBe("\u0001".repeat(99));
      const clipped = listed.find(row => row.meetingRef === "clipped-row")!;
      expect(clipped).toMatchObject({
        title: "t".repeat(512), summaryOverview: "r".repeat(4096), summaryActionItems: "a".repeat(4096), listingTruncated: true, metadata: { type: "m".repeat(99) },
      });
      expect(metadataOutcome(clipped).coverage.omissionReasons).toContain("metadata_limit");
      expect(await instance.getMetadata!("clipped-row")).toMatchObject({
        title: "t".repeat(600), summaryOverview: "r".repeat(5000), summaryActionItems: "a".repeat(5000),
      });
      expect(listed.map(row => row.meetingRef)).not.toContain("x".repeat(1025));
      expect(Math.max(...sizes)).toBeLessThan(TRANSCRIPT_RESPONSE_BYTE_LIMIT);
      expect(warnings).toContainEqual(["transcript_listing_oversized_ids_skipped", { count: 1 }]);
    } finally {
      console.warn = originalWarn;
      db.close();
    }
  });
});
