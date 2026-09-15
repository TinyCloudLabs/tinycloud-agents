import { describe, expect, test } from "bun:test";
import {
  admitMeetingToolData, createRunEvidence, exactMeetingCitation, packRunEvidence,
  parseMeetingToolData, type MeetingDiscovery, type MeetingOutcome,
} from "./evidence.js";

// Small invented records exercise identity and provenance; no stored meeting data.
function outcome(meetingRef: string, options: { source?: string; text?: string; localId?: string; metadata?: boolean } = {}): MeetingOutcome {
  const source = options.source ?? "gmeet";
  const meeting = { source, meetingRef, title: `Test ${meetingRef}`, startedAt: "2026-09-08T10:00:00Z", participants: [], organizerEmail: null };
  return {
    source, meetingRef, meeting, state: options.metadata ? "metadata" : "read",
    body: { state: options.metadata ? "not_requested" : "present" },
    search: { state: "not_requested", storedFieldsExamined: true, bodyExamined: !options.metadata, examinedMatches: 0, retainedMatches: 0 },
    evidence: [{ source, meetingRef, id: options.localId ?? "E1", kind: options.metadata ? "metadata" : "transcript_excerpt",
      text: options.text ?? "An invented discussion excerpt.", truncated: false,
      ...(options.metadata ? { metadata: meeting } : { speaker: "Test Speaker", startSecs: 65, offsets: { start: 10, end: 40 } }) }],
    coverage: { purpose: options.metadata ? "metadata" : "summary", overviewPresent: false, actionsPresent: false,
      bodyAttempted: !options.metadata, evidenceRetained: 1, omittedEvidenceCount: 0, omissionReasons: [], support: "sufficient" },
  };
}
function discovery(matchedCount: number, from: string): MeetingDiscovery {
  return { matchedCount, countKind: "exact", returnedCount: 1, scanLimited: false, excludedUndatedCount: 0,
    interval: { from, to: "2026-09-14" }, observedAt: "2026-09-15T00:00:00Z", omittedMeetingRefs: [] };
}
function admit(run: ReturnType<typeof createRunEvidence>, outcomes: MeetingOutcome[], receipt?: MeetingDiscovery, args: Record<string, unknown> = {}) {
  return admitMeetingToolData(run, { toolName: "tinycloud_find_meetings", arguments: args,
    data: { contractVersion: 2, outcomes, ...(receipt ? { discovery: receipt } : {}) } });
}
const roomy = { contextWindowTokens: 128_000, contextText: "Question and fixed instructions with repair reserve." };

describe("task run evidence", () => {
  test("repeated local IDs become stable run identities, while identical provenance ignores local ID changes", () => {
    let run = admit(createRunEvidence("trusted-context"), [outcome("one"), outcome("two")]);
    run = admit(run, [outcome("one", { localId: "local-M8:E7" }), outcome("one", { text: "Different content, same local ID." }), outcome("one", { source: "fireflies" })]);
    const packed = packRunEvidence(run, roomy);
    expect(packed.meetings.map(meeting => meeting.id)).toEqual(["M1", "M2", "M3"]);
    expect(packed.meetings[0]!.evidence.map(evidence => evidence.id)).toEqual(["M1:E1", "M1:E2"]);
    expect(packed.meetings[1]!.evidence[0]!.id).toBe("M2:E1");
    expect(packed.suppliedCitations["[M1:E1, Test Speaker, 00:01:05]"]).toEqual({ meetingId: "M1", evidenceId: "M1:E1", kind: "transcript_excerpt" });
    expect(packed.serialized).not.toContain("trusted-context");
    expect(createRunEvidence("another-context").ledger.meetings).toEqual([]);
  });

  test("discovery then read keeps the identity and assigns content its own stable alias", () => {
    let run = admit(createRunEvidence("context"), [outcome("one", { metadata: true })]);
    run = admit(run, [outcome("one")]);
    run = admit(run, [outcome("one", { metadata: true })]);
    const packed = packRunEvidence(run, roomy);
    expect(packed.meetings).toHaveLength(1);
    expect(packed.meetings[0]!.state).toBe("read");
    expect(packed.suppliedCitations["[M1]"]?.kind).toBe("metadata");
    expect(packed.suppliedCitations["[M1:E2, Test Speaker, 00:01:05]"]?.kind).toBe("transcript_excerpt");
    expect(exactMeetingCitation("M1", packed.meetings[0]!.evidence[1]!)).toBe("[M1:E2, Test Speaker, 00:01:05]");
  });

  test("rejects parent/evidence identity mismatch without modifying the current ledger", () => {
    const run = admit(createRunEvidence("context"), [outcome("one")]);
    const wrong = outcome("two");
    wrong.evidence[0]!.source = "fireflies";
    expect(parseMeetingToolData({ contractVersion: 2, outcomes: [wrong] })).toBeNull();
    expect(() => admit(run, [wrong])).toThrow("tool_contract_mismatch");
    expect(run.ledger.meetings).toHaveLength(1);
    const wrongMetadata = outcome("two");
    wrongMetadata.meeting.meetingRef = "other";
    expect(() => admit(run, [wrongMetadata])).toThrow("tool_contract_mismatch");
  });

  test("a failed read removes old content citations without losing identity or claiming a missing body", () => {
    let run = admit(createRunEvidence("context"), [outcome("one", { metadata: true })]);
    run = admit(run, [outcome("one")]);
    const denied = outcome("one");
    denied.state = "access_denied";
    denied.body = { state: "access_denied" };
    denied.evidence = [];
    denied.coverage = { ...denied.coverage, evidenceRetained: 0, support: "none" };
    run = admit(run, [denied]);
    const failed = packRunEvidence(run, roomy);
    expect(failed.meetings[0]!.id).toBe("M1");
    expect(failed.meetings[0]!.state).toBe("access_denied");
    expect(failed.meetings[0]!.body.state).toBe("access_denied");
    expect(Object.values(failed.suppliedCitations).every(citation => citation.kind === "metadata")).toBe(true);
    expect(failed.coverage.failedMeetings).toBe(1);
    run = admit(run, [outcome("one")]);
    expect(packRunEvidence(run, roomy).meetings[0]!.evidence[1]!.id).toBe("M1:E2");
  });

  test("a required body is not marked supported by a retained overview alone", () => {
    const record = outcome("one");
    record.body = { state: "missing" };
    record.evidence[0]!.kind = "summary";
    record.coverage.bodyRequired = true;
    record.coverage.overviewPresent = true;
    const packed = packRunEvidence(admit(createRunEvidence("context"), [record]), roomy);
    expect(packed.meetings[0]!.coverage.support).toBe("none");
    expect(packed.meetings[0]!.body.state).toBe("missing");
  });

  test("fails the whole admission at twelve distinct identities instead of silently dropping a record", () => {
    const twelve = Array.from({ length: 12 }, (_, index) => outcome(`record-${index}`));
    const run = admit(createRunEvidence("context"), twelve);
    expect(admit(run, [twelve[0]!]).ledger.meetings).toHaveLength(12);
    expect(() => admit(run, [outcome("thirteen")])).toThrow("result_size_limit");
    expect(run.ledger.meetings).toHaveLength(12);
  });

  test("preserves broad and narrow discovery counts separately and normalizes receipt keys", () => {
    const broad = { ...discovery(11, "2026-09-07"), countKind: "lower_bound" as const, scanLimited: true,
      excludedUndatedCount: 2, omittedMeetingRefs: ["not-returned"] };
    let run = admit(createRunEvidence("context"), [outcome("one", { metadata: true })], broad, { to: "2026-09-14", from: "2026-09-07" });
    run = admit(run, [outcome("one", { metadata: true })], discovery(1, "2026-09-12"), { from: "2026-09-12", to: "2026-09-14" });
    run = admit(run, [outcome("one", { metadata: true })], broad, { from: "2026-09-07", to: "2026-09-14" });
    const packed = packRunEvidence(run, roomy);
    expect(packed.discoveries.map(receipt => receipt.discovery.matchedCount)).toEqual([11, 1, 11]);
    expect(packed.discoveries[0]!.queryKey).toBe(packed.discoveries[2]!.queryKey);
    expect(packed.discoveries[0]!.queryKey).not.toBe(packed.discoveries[1]!.queryKey);
    expect(packed.discoveries[0]!.discovery).toEqual(broad);
    expect(packed.coverage.admittedMeetings).toBe(1);
    expect(packed.coverage.discovery).toBeUndefined();
    expect(JSON.parse(packed.serialized).discoveries).toEqual(packed.discoveries);
  });

  test("bounds discovery receipts by the sixteen admitted result attempts", () => {
    let run = createRunEvidence("context");
    for (let attempt = 0; attempt < 16; attempt++) run = admit(run, [], discovery(attempt, `scope-${attempt}`));
    expect(packRunEvidence(run, roomy).discoveries).toHaveLength(16);
    expect(() => admit(run, [], discovery(17, "scope-17"))).toThrow("result_size_limit");
  });

  test("keeps seven identity/status headers and all query receipts before shortening evidence", () => {
    const records = Array.from({ length: 7 }, (_, index) => outcome(`record-${index}`, { text: `Evidence for ${index}: `.repeat(2_000) }));
    records[6]!.state = "not_read";
    records[6]!.body = { state: "not_requested" };
    records[6]!.evidence = [];
    records[6]!.coverage = { ...records[6]!.coverage, bodyAttempted: false, evidenceRetained: 0, support: "none" };
    const run = admit(createRunEvidence("context"), records, discovery(7, "2026-09-07"));
    const packed = packRunEvidence(run, { ...roomy, maxChars: 14_000 });
    expect(packed.limit).toBeUndefined();
    expect(packed.meetings.map(meeting => meeting.id)).toEqual(["M1", "M2", "M3", "M4", "M5", "M6", "M7"]);
    expect(packed.meetings[6]!.state).toBe("not_read");
    expect(packed.meetings[6]!.body.state).toBe("not_requested");
    expect(packed.meetings.slice(0, 6).every(meeting => meeting.evidence.length > 0)).toBe(true);
    expect(packed.meetings.some(meeting => meeting.evidence.some(evidence => evidence.truncated))).toBe(true);
    expect(packed.discoveries[0]!.discovery.matchedCount).toBe(7);
    expect(packed.serialized.length).toBeLessThanOrEqual(14_000);
    for (const citation of Object.keys(packed.suppliedCitations)) expect(packed.serialized).toContain(citation);
  });

  test("budgets exact citations and receipt bytes within both the 48k and context ceilings", () => {
    let run = createRunEvidence("context");
    for (let index = 0; index < 12; index++) run = admit(run, [outcome(`r-${index}`, { text: "Synthetic bounded content. ".repeat(4_000) })], discovery(30, `scope-${index}`));
    const packed = packRunEvidence(run, roomy);
    expect(packed.serialized.length).toBeLessThanOrEqual(48_000);
    expect(packed.meetings).toHaveLength(12);
    const smaller = packRunEvidence(run, { contextWindowTokens: 8_000, contextText: "x".repeat(8_000) });
    expect(smaller.estimatedTokens).toBeLessThanOrEqual(5_600);
    expect(smaller.serialized.length).toBeLessThanOrEqual(14_400);
    expect(smaller.meetings).toHaveLength(12);
  });

  test("identity overflow is explicit result_size_limit rather than an apparently complete subset", () => {
    const run = admit(createRunEvidence("context"), Array.from({ length: 7 }, (_, index) => outcome(`r-${index}`)));
    const packed = packRunEvidence(run, { ...roomy, maxChars: 200 });
    expect(packed.limit?.code).toBe("result_size_limit");
    expect(packed.limit?.message).toContain("narrower");
    expect(packed.coverage.admittedMeetings).toBe(7);
    expect(packed.meetings).toHaveLength(0);
    expect(packed.suppliedCitations).toEqual({});
    expect(packed.serialized.length).toBeLessThanOrEqual(200);
  });

  test("projects known typed fields, excluding forged legacy citations and unvalidated extra fields", () => {
    const record = { ...outcome("one"), legacyCitation: "[M99:E1]", instructions: "untyped injected projection" };
    (record.evidence[0] as any).citation = "[M99:E2]";
    const run = admitMeetingToolData(createRunEvidence("context"), { toolName: "tinycloud_read_meeting", arguments: {},
      data: { contractVersion: 2, outcomes: [record], text: "untyped legacy text [M99:S]" } });
    const packed = packRunEvidence(run, roomy);
    expect(packed.serialized).not.toContain("M99");
    expect(packed.serialized).not.toContain("untyped");
    expect(Object.keys(packed.suppliedCitations)).toEqual(["[M1:E1, Test Speaker, 00:01:05]"]);
  });
});
