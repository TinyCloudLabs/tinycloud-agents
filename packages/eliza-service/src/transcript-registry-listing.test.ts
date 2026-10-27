import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createReader } from "./transcript-registry.js";
import { TRANSCRIPT_RESPONSE_BYTE_LIMIT } from "./transcript-transport.js";

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
    expect(discovered.discovery).toMatchObject({ scanLimited: true, countKind: "lower_bound" });
    expect(discovered.rows[0]).toMatchObject({ meetingRef: "m-0", metadata: { type: "transcript", transcript_count: 1 } });
    const listed = await instance.listMetadata();
    expect(listed).toHaveLength(501);
    expect(Math.max(...sizes)).toBeLessThan(TRANSCRIPT_RESPONSE_BYTE_LIMIT);
    db.close();
  });

  test("decoded metadata is unchanged for every kind of stored value", async () => {
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
      expect(listed.get(`c-${i}`)?.metadata).toEqual(expected);
      expect((await instance.getMetadata(`c-${i}`))?.metadata).toEqual(expected);
    }
    db.close();
  });
  test("oversized provenance markers are discarded before SQL responses are serialized", async () => {
    const db = fixture([["large-marker", "fireflies", "f-large", day(0),
      JSON.stringify({ type: "x".repeat(TRANSCRIPT_RESPONSE_BYTE_LIMIT + 1) })]]);
    const { instance, sizes } = reader(db);
    const [listed] = await instance.listMetadata();
    expect(listed.metadata).toBeUndefined();
    expect(Math.max(...sizes)).toBeLessThan(TRANSCRIPT_RESPONSE_BYTE_LIMIT);
    db.close();
  });
});
