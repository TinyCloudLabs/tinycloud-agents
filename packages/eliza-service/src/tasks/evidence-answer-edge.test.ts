import { describe, expect, test } from "bun:test";
import {
  admitMeetingToolData, createRunEvidence, packRunEvidence,
  type MeetingDiscovery, type MeetingOutcome,
} from "./evidence.js";
import {
  buildCoverage, clarifyMeetingSelection, finalizeMeetingAnswer, hasUsableContent,
  isMetadataRequest, safeMeetingFallback, validateMeetingAnswer,
} from "./answer.js";

// Invented typed records go through real admission and packing; no provider or storage calls.
function record(ref: string, metadata = false): MeetingOutcome {
  const source = "google-meet";
  const meeting = { source, meetingRef: ref, title: "Fixture planning", startedAt: "2026-09-08T10:00:00Z", participants: [], organizerEmail: null };
  return {
    source, meetingRef: ref, meeting, state: metadata ? "metadata" : "read",
    body: { state: metadata ? "not_requested" : "present" },
    search: { state: "not_requested", storedFieldsExamined: !metadata, bodyExamined: !metadata, examinedMatches: 0, retainedMatches: 0 },
    evidence: [{ source, meetingRef: ref, id: "E1", kind: metadata ? "metadata" : "transcript_excerpt",
      text: metadata ? "" : "The fixture team postponed the release.", truncated: false,
      ...(metadata ? { metadata: meeting } : { speaker: "Alice", startSecs: 30, offsets: { start: 0, end: 38 } }) }],
    coverage: { purpose: metadata ? "metadata" : "summary", overviewPresent: false, actionsPresent: false,
      bodyAttempted: !metadata, evidenceRetained: 1, omittedEvidenceCount: 0, omissionReasons: [], support: "sufficient" },
  };
}
function receipt(matchedCount: number, omittedMeetingRefs: string[] = []): MeetingDiscovery {
  return { matchedCount, returnedCount: 1, countKind: "exact", scanLimited: false, excludedUndatedCount: 0,
    interval: { from: "2026-09-07", to: "2026-09-13", timeZone: "Europe/Lisbon" },
    observedAt: "2026-09-15T00:00:00Z", omittedMeetingRefs };
}
function admit(run: ReturnType<typeof createRunEvidence>, outcomes: MeetingOutcome[], discovery?: MeetingDiscovery) {
  return admitMeetingToolData(run, { toolName: "tinycloud_search_transcripts", arguments: { query: "release" },
    data: { contractVersion: 2, outcomes, ...(discovery ? { discovery } : {}) } });
}
function pack(outcomes: MeetingOutcome[], discovery?: MeetingDiscovery) {
  return packRunEvidence(admit(createRunEvidence("fixture-private-context"), outcomes, discovery), { contextWindowTokens: 128_000, contextText: "Summarize the fixture evidence." });
}

describe("task evidence/answer edge boundaries", () => {
  test("rejects raw storage references known only from omitted discovery identities", () => {
    const omitted = "private-omitted-record-7";
    const evidence = pack([record("private-read-record-1")], receipt(2, [omitted]));
    expect(validateMeetingAnswer("The release was postponed [M1:E1].", evidence, { requireContent: true }).ok).toBe(true);
    const draft = validateMeetingAnswer(`The release was postponed [M1:E1]. Another record is ${omitted}.`, evidence, { requireContent: true });
    expect(draft.codes).toContain("internal_reference");
    expect(draft.ok).toBe(false);
  });

  test("rejects all-read prose when discovery reports unreturned matching records", () => {
    const evidence = pack([record("private-read-record-1")], receipt(7));
    expect(buildCoverage(evidence)).toContain("6 matching records not returned");
    const draft = validateMeetingAnswer("I read all meetings. The release was postponed [M1:E1].", evidence, { requireContent: true });
    expect(draft.codes).toContain("coverage_conflict");
  });

  test("content questions about meeting risks and outcomes are not discovery-only listings", () => {
    expect(isMetadataRequest("List meeting titles and dates.")).toBe(true);
    for (const question of ["List the risks raised in my meetings.", "Show meeting outcomes.", "Which meetings contain objections to the launch?"]) {
      expect(isMetadataRequest(question)).toBe(false);
    }
  });

  test("preserves explicit title, date and attendee discovery prompts", () => {
    for (const question of ["List the titles of my meetings.", "Show meeting titles, dates, and participants.", "Show attendees for my last meeting.", "When was my last meeting?"]) {
      expect(isMetadataRequest(question)).toBe(true);
    }
  });

  test("rejects an unfinished unknown private citation even alongside a valid citation", () => {
    const evidence = pack([record("private-read-record-1")]);
    for (const label of ["[M9:E1", "[M9:E1\n]", "[T9"]) {
      const draft = validateMeetingAnswer(`The release was postponed [M1:E1]. Additional source ${label}`, evidence, { requireContent: true });
      expect(draft.codes).toContain("unknown_meeting_citation");
    }
  });

  test("clarification candidate titles cannot expose another known record's storage identity", () => {
    const first = record("private-record-one", true);
    const second = record("private-record-two", true);
    first.meeting.title = `Planning copied from ${second.meetingRef}`;
    const evidence = pack([first, second]);
    const result = clarifyMeetingSelection(evidence);
    expect(result.outcome).toBe("clarification");
    expect(result.answer.text).not.toContain(second.meetingRef);
    expect(result.answer.text).toContain("M1");
    expect(result.answer.text).toContain("M2");
  });

  test("one unavailable reread removes its old content and preserves the other record", () => {
    let run = admit(createRunEvidence("fixture-private-context"), [record("private-first-record"), record("private-second-record")]);
    const failure = record("private-first-record");
    failure.state = "unavailable";
    failure.body = { state: "timeout" };
    failure.evidence = [];
    failure.coverage = { ...failure.coverage, evidenceRetained: 0, support: "none" };
    run = admit(run, [failure]);
    const evidence = packRunEvidence(run, { contextWindowTokens: 128_000, contextText: "Question" });
    expect(Object.values(evidence.suppliedCitations).map(citation => citation.meetingId)).toEqual(["M2"]);
    const draft = validateMeetingAnswer("The release was postponed [M2:E1].", evidence, { requireContent: true });
    expect(draft.ok).toBe(true);
    const result = finalizeMeetingAnswer(draft, evidence);
    expect(result.outcome).toBe("partial");
    expect(result.answer.text).toContain("M1 — The read failed; content was unavailable. Body read timed out");
    expect(result.answer.text).not.toContain("reported missing");
  });

  test("metadata and public URLs do not supply private content evidence", () => {
    const evidence = pack([record("private-metadata-only", true)]);
    expect(hasUsableContent(evidence)).toBe(false);
    expect(validateMeetingAnswer("The vendor says launch is ready https://vendor.example/docs/[M9:E1]. The meeting was Tuesday [M1].", evidence, { requireContent: true }).codes).toEqual(["no_usable_evidence"]);
    expect(safeMeetingFallback(evidence, "no_usable_evidence").answer.text).toContain("No supported summary was produced");
    expect(validateMeetingAnswer("Planning occurred Tuesday [M1].", evidence, { requireContent: false }).ok).toBe(true);
    expect(validateMeetingAnswer("Planning occurred Tuesday [M1]. Public docs: https://vendor.example/docs/[M9:E1", evidence, { requireContent: false }).ok).toBe(true);
  });

  test("a narrower retry preserves both count scopes and aliases without summing overlap", () => {
    let run = admit(createRunEvidence("fixture-private-context"), [record("one", true)], { ...receipt(7), countKind: "lower_bound", scanLimited: true });
    run = admit(run, [record("one", true)], { ...receipt(1), interval: { from: "2026-09-08", to: "2026-09-08" } });
    const evidence = packRunEvidence(run, { contextWindowTokens: 128_000, contextText: "Question" });
    expect(evidence.meetings.map(meeting => meeting.id)).toEqual(["M1"]);
    const text = buildCoverage(evidence);
    expect(text).toContain("at least 7 matched; 1 returned; scan limit reached");
    expect(text).toContain("1 matched; 1 returned");
    expect(text).toContain("Query counts describe their own scopes and are not added together");
    expect(text).not.toContain("8 matched");
  });
});
