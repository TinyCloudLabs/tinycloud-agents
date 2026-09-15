import { describe, expect, test } from "bun:test";
import { buildCoverage, validateMeetingAnswer } from "./answer.js";
import { admitMeetingToolData, createRunEvidence, packRunEvidence, type MeetingOutcome } from "./evidence.js";

// Synthetic version of a live failure: seven returned records, six usable partial
// reads, and one metadata-only read whose body timed out. No private text or calls.
function partialEvidence() {
  const outcomes: MeetingOutcome[] = Array.from({ length: 7 }, (_, index) => {
    const source = "google-meet";
    const meetingRef = `fixture-private-record-${index + 1}`;
    const unusable = index === 3;
    const meeting = { source, meetingRef, title: "Fixture planning", startedAt: "2026-09-08T10:00:00Z", participants: [], organizerEmail: null };
    return {
      source, meetingRef, meeting, state: "read",
      body: { state: unusable ? "timeout" : index === 6 ? "present" : "not_requested" },
      search: { state: unusable ? "no_match" : "not_requested", storedFieldsExamined: true, bodyExamined: index === 6, examinedMatches: 0, retainedMatches: 0 },
      evidence: [{ source, meetingRef, id: "E1", kind: unusable ? "metadata" : "action", text: unusable ? "" : "Prepare a fixture checklist.", truncated: false, ...(unusable ? { metadata: meeting } : {}) }],
      coverage: { purpose: "actions", overviewPresent: false, actionsPresent: !unusable, bodyAttempted: unusable || index === 6,
        evidenceRetained: 1, omittedEvidenceCount: index === 0 ? 1 : 0, omissionReasons: index === 0 ? ["fixture_limit"] : [], support: unusable ? "none" : "limited" },
    };
  });
  const discovery = { matchedCount: 7, returnedCount: 7, countKind: "exact" as const, scanLimited: false, excludedUndatedCount: 0,
    interval: { from: "2026-09-07", to: "2026-09-13" }, observedAt: "2026-09-15T00:00:00Z", omittedMeetingRefs: [] };
  const run = admitMeetingToolData(createRunEvidence("fixture-context"), { toolName: "tinycloud_list_meeting_actions", arguments: {}, data: { contractVersion: 2, outcomes, discovery } });
  return packRunEvidence(run, { contextWindowTokens: 128_000, contextText: "Summarize the fixture meetings." });
}

function check(claim: string) {
  return validateMeetingAnswer(`Prepare a checklist [M1:E1]. ${claim}`, partialEvidence(), { requireContent: true });
}

describe("live partial-evidence coverage claims", () => {
  test("fixture retains seven read states but one has no usable content", () => {
    const evidence = partialEvidence();
    expect(evidence.meetings).toHaveLength(7);
    expect(evidence.meetings.every(meeting => meeting.state === "read")).toBe(true);
    expect(evidence.meetings[3]!.coverage.support).toBe("none");
    expect(evidence.meetings[3]!.body.state).toBe("timeout");
    expect(check("One record has no retained content [M4].").ok).toBe(true);
  });

  test("coverage distinguishes a metadata-only read attempt from usable cited and uncited content", () => {
    const coverage = buildCoverage(partialEvidence(), ["M1", "M4"]);
    expect(coverage).toContain("M4 — Read was attempted; no usable content was retained for this answer. Body read timed out.");
    expect(coverage).not.toContain("M4 — Content was read");
    expect(coverage).toContain("M1 — Content was read; this answer cites this record");
    expect(coverage).toContain("M2 — Content was read, but this answer does not cite it");
  });

  test.each([
    "All 7 discovered records for this period were read and included (none omitted from the interval scan; both discovery queries confirmed an exact match of 7 meetings).",
    "**All seven meeting records** were **read** and included.",
    "I read all seven discovered records.",
    "Seven meetings were read.",
    "[M4] was read and summarized.",
  ])("rejects unusable records counted as read: %s", claim => {
    expect(check(claim).codes).toContain("coverage_conflict");
  });

  test.each([
    "Coverage for this meeting is complete.",
    "**Full coverage** of the meetings is available.",
    "This is not complete coverage. Coverage for this meeting is complete.",
  ])("rejects full coverage over partial bodies: %s", claim => {
    expect(check(claim).codes).toContain("coverage_conflict");
  });

  test.each([
    "The only explicit decision recorded is to use the fixture checklist [M2:E1]; no other meeting evidence states a decision.",
    "No other decisions were recorded in the meetings.",
    "In the retained evidence, an action is present. The only explicit decision recorded is to use a checklist [M2:E1].",
  ])("rejects unqualified exhaustive decisions over partial evidence: %s", claim => {
    expect(check(claim).codes).toContain("coverage_conflict");
  });

  test.each([
    "No other decision was found in the retained evidence.",
    "In the retained evidence, the only explicit decision recorded is to use the fixture checklist [M2:E1].",
    "This is **not complete coverage**. Transcripts were not requested for most meetings; summaries rely on retained action items and overviews, which were incomplete.",
    "All 7 records are accounted for, including one unavailable record [M4].",
    "I did not read all seven records. Six records were read; one record has no usable content [M4].",
    "The body is unavailable for one meeting; I cannot claim full coverage.",
  ])("preserves honest partial-evidence wording: %s", claim => {
    expect(check(claim).ok).toBe(true);
  });
});
