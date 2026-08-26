import { describe, expect, test } from "bun:test";
import { parseTranscriptSearchArgs } from "./tinycloud-search-transcripts.js";

describe("tinycloud_search_transcripts arguments", () => {
  test("accepts only the bounded public contract", () => {
    expect(parseTranscriptSearchArgs({ query: "decision", source: "fireflies", recent: true })).toEqual({
      query: "decision", source: "fireflies", recent: true,
    });
  });

  test("rejects raw paths, SQL, and unknown arguments", () => {
    expect(parseTranscriptSearchArgs({ query: "decision", sql: "select *" })).toBeNull();
    expect(parseTranscriptSearchArgs({ query: "decision", path: "connectors/secret" })).toBeNull();
  });
});
