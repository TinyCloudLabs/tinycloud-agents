import { describe, expect, test } from "bun:test";
import { combinedMemberKeys, isCombinedMember, partitionCombined, readCombinedMembers } from "./combined-meetings.js";

interface Row { id: string; source: string; sourceId: string; metadata?: string | null }

const MERGED_ID = "merged-1";
const combinedMetadata = (members: unknown) => JSON.stringify({ merge: { v: 1, members } });
const MEMBERS = [
  { source: "fireflies", source_id: "ff-1" },
  { source: "google-meet", source_id: "gm-1" },
];
const baseRows: Row[] = [
  { id: "r-ff", source: "fireflies", sourceId: "ff-1" },
  { id: "r-gm", source: "google-meet", sourceId: "gm-1" },
  { id: "r-other", source: "fireflies", sourceId: "ff-other" },
  { id: "r-local", source: "exo-local", sourceId: "local-1" },
];
const combinedRow: Row = { id: "r-merged", source: "exo-merged", sourceId: MERGED_ID, metadata: combinedMetadata(MEMBERS) };

const project = (row: Row) => ({ source: row.source, sourceId: row.sourceId, metadata: row.metadata });
const visibleIds = (rows: Row[]) => partitionCombined(rows, project).visible.map(row => row.sourceId).sort();

describe("combined meetings", () => {
  test("lists the combined meeting and neither of its members; other meetings are unaffected", () => {
    expect(visibleIds([...baseRows, combinedRow])).toEqual([MERGED_ID, "ff-other", "local-1"].sort());
  });

  test("with no combined rows the result is exactly the input, in order", () => {
    const result = partitionCombined(baseRows, project);
    expect(result.visible).toEqual(baseRows);
    expect(result.hiddenKeys.size).toBe(0);
  });

  test("membership is by source AND source_id: a same-id row of another source is not a member", () => {
    const rows: Row[] = [
      { id: "r-a", source: "fireflies", sourceId: "shared" },
      { id: "r-b", source: "google-meet", sourceId: "shared" },
      { id: "r-merged", source: "exo-merged", sourceId: MERGED_ID, metadata: combinedMetadata([{ source: "fireflies", source_id: "shared" }]) },
    ];
    expect(partitionCombined(rows, project).visible.map(row => `${row.source}/${row.sourceId}`).sort()).toEqual(["exo-merged/merged-1", "google-meet/shared"]);
  });

  test("member identity is not normalised", () => {
    const rows: Row[] = [
      { id: "r-a", source: "fireflies", sourceId: "FF-1" },
      { id: "r-b", source: "fireflies", sourceId: " ff-1" },
      { id: "r-c", source: "Fireflies", sourceId: "ff-1" },
      { id: "r-merged", source: "exo-merged", sourceId: MERGED_ID, metadata: combinedMetadata([{ source: "fireflies", source_id: "ff-1" }]) },
    ];
    expect(visibleIds(rows)).toEqual([" ff-1", "FF-1", "ff-1", MERGED_ID].sort());
  });

  const unreadable: Array<[string, string | null]> = [
    ["metadata is not JSON", "{not json"],
    ["metadata is NULL", null],
    ["metadata is a JSON array", "[1,2]"],
    ["metadata has no merge record", JSON.stringify({ transcript_text: "x" })],
    ["merge.members is empty", combinedMetadata([])],
    ["merge.members is not an array", JSON.stringify({ merge: { members: "ff-1" } })],
    ["a member lacks source_id", combinedMetadata([MEMBERS[0], { source: "google-meet" }])],
    ["a member has an empty source", combinedMetadata([{ source: "", source_id: "x" }, MEMBERS[1]])],
    ["a member has a non-text source_id", combinedMetadata([MEMBERS[0], { source: "google-meet", source_id: 7 }])],
    ["a member is not an object", combinedMetadata([MEMBERS[0], 5])],
    ["a member is a bare string", combinedMetadata([MEMBERS[0], "gm-1"])],
  ];
  for (const [name, metadata] of unreadable) {
    test(`a combined row whose ${name} is itself excluded and hides nothing`, () => {
      expect(visibleIds([...baseRows, { ...combinedRow, metadata }])).toEqual(["ff-1", "ff-other", "gm-1", "local-1"]);
    });
  }

  test("an unreadable combined row does not disturb a readable one next to it", () => {
    const rows: Row[] = [
      ...baseRows,
      combinedRow,
      { id: "r-bad", source: "exo-merged", sourceId: "bad-1", metadata: "{oops" },
      { id: "r-bad2", source: "exo-merged", sourceId: "bad-2", metadata: combinedMetadata([{ source: "fireflies", source_id: "ff-other" }, 7]) },
    ];
    // ff-other is named only by the unreadable bad-2 row: still listed.
    expect(visibleIds(rows)).toEqual([MERGED_ID, "ff-other", "local-1"].sort());
  });

  test("members come only from combined rows", () => {
    const rows: Row[] = [
      ...baseRows,
      { id: "r-x", source: "exo-local", sourceId: "local-2", metadata: combinedMetadata(MEMBERS) },
    ];
    expect(visibleIds(rows)).toEqual(["ff-1", "ff-other", "gm-1", "local-1", "local-2"]);
  });

  test("an exo-merged member is never hidden: a combined row naming itself or another combined meeting hides nothing extra", () => {
    const other: Row = { id: "r-m2", source: "exo-merged", sourceId: "merged-2", metadata: combinedMetadata([{ source: "exo-local", source_id: "local-1" }]) };
    const self: Row = { ...combinedRow, metadata: combinedMetadata([...MEMBERS, { source: "exo-merged", source_id: MERGED_ID }, { source: "exo-merged", source_id: "merged-2" }]) };
    expect(visibleIds([...baseRows, self, other])).toEqual([MERGED_ID, "merged-2", "ff-other"].sort());
  });

  test("metadata may be an already-parsed object", () => {
    const row = { source: "exo-merged", sourceId: MERGED_ID, metadata: { merge: { members: MEMBERS } } };
    expect([...combinedMemberKeys([row])].sort()).toEqual(["fireflies/ff-1", "google-meet/gm-1"]);
    expect(readCombinedMembers(undefined)).toBeNull();
  });

  test("hiddenKeys and isCombinedMember let a caller test rows listed elsewhere", () => {
    const hiddenKeys = combinedMemberKeys([combinedRow], project);
    expect([...hiddenKeys].sort()).toEqual(["fireflies/ff-1", "google-meet/gm-1"]);
    expect(isCombinedMember(baseRows[0], hiddenKeys, project)).toBe(true);
    expect(isCombinedMember(baseRows[2], hiddenKeys, project)).toBe(false);
    expect(isCombinedMember(combinedRow, hiddenKeys, project)).toBe(false);
  });
});
