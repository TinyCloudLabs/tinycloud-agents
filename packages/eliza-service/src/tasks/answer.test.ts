import { describe, expect, it } from "bun:test";
import { admitMeetingToolData, createRunEvidence, packRunEvidence, type MeetingOutcome, type PackedMeetingEvidence } from "./evidence.js";
import * as answerModule from "./answer.js";

async function answer() {
  return answerModule;
}
function meeting(id: string, state = "read", extra: Record<string, unknown> = {}) {
  const meetingRef = `storage-record-${id}`;
  return { id, meetingRef, source: "fireflies", meeting: { meetingRef, source: "fireflies", title: `${id} planning`, startedAt: "2026-09-08T10:00:00Z", participants: [], organizerEmail: null }, state,
    body: { state: "not_requested" }, search: { state: "not_requested", storedFieldsExamined: false, bodyExamined: false, examinedMatches: 0, retainedMatches: 0 },
    evidence: [{ id: `${id}:E1`, meetingRef, source: "fireflies", kind: "summary", text: "The supplied fixture says the release was delayed.", truncated: false }],
    coverage: { purpose: "summary", overviewPresent: true, actionsPresent: false, bodyAttempted: false, evidenceRetained: 1, omittedEvidenceCount: 0, omissionReasons: [], support: "sufficient" }, ...extra };
}
function packed(meetings = [meeting("M1"), meeting("M2")]): PackedMeetingEvidence {
  const result = { contractVersion: 2, meetings, suppliedCitations: { "[M1:E1, Alice, 00:00:30]": { meetingId: "M1", evidenceId: "M1:E1", kind: "summary" }, "[M2:E1, Bob, 00:01:00]": { meetingId: "M2", evidenceId: "M2:E1", kind: "summary" } }, citations: {}, discoveries: [], coverage: { admittedMeetings: meetings.length, includedMeetings: meetings.length }, serialized: "", estimatedTokens: 0 };
  result.serialized = JSON.stringify(result);
  return result as unknown as PackedMeetingEvidence;
}

describe("task prose answer policy", () => {
  it("recognizes explicit metadata listings conservatively without treating content requests as metadata", async () => {
    const { isMetadataRequest } = await answer();
    for (const question of ["List my meetings from September 7–13.", "Show meeting titles and dates.", "Find meetings with Alice.", "Which meetings did I have last week?"]) expect(isMetadataRequest(question)).toBe(true);
    for (const question of ["Summarize my meetings.", "Show meeting decisions.", "Find meetings where we agreed to launch.", "Show what we discussed in meetings.", "What happened in the last meeting?", "Find meetings and give me a recap."]) expect(isMetadataRequest(question)).toBe(false);
  });
  it("builds clean synthesis and repair from the latest question/current evidence with public sources separate", async () => {
    const { buildSynthesisMessages } = await answer();
    const evidence = packed();
    const options = { question: "Compare the meeting decision with the vendor documentation.", scope: { from: "2026-09-07", to: "2026-09-13", timeZone: "Europe/Lisbon" }, evidence,
      publicSources: [{ title: "Vendor docs", url: "https://vendor.example/docs", snippet: "Public source fixture." }],
      memory: "MEMORY_MUST_NOT_APPEAR", history: "HISTORY_MUST_NOT_APPEAR", rejectedDraft: "REJECTED_MUST_NOT_APPEAR", repairCodes: ["unknown_meeting_citation", "arbitrary-private-text"] };
    const messages = buildSynthesisMessages(options as any);
    expect(messages.map(m => m.role)).toEqual(["system", "user"]);
    const content = messages.map(m => m.content).join("\n");
    expect(content).toContain("2026-09-07"); expect(content).toContain("2026-09-13"); expect(content).toContain("Europe/Lisbon");
    expect(content).toContain("Private meeting evidence"); expect(content).toContain("Public web sources");
    expect(content).toContain("https://vendor.example/docs"); expect(content).toContain("unknown_meeting_citation");
    for (const marker of ["MEMORY_MUST_NOT_APPEAR", "HISTORY_MUST_NOT_APPEAR", "REJECTED_MUST_NOT_APPEAR", "arbitrary-private-text"]) expect(content).not.toContain(marker);
    expect(content).toContain("structural provenance");
  });

  it("expands an unambiguous short citation and retains actual public URLs", async () => {
    const { validateMeetingAnswer } = await answer();
    const result = validateMeetingAnswer("The release was delayed [M1:E1]. Public docs say X [Vendor](https://vendor.example/docs).", packed(), { requireContent: true });
    expect(result).toMatchObject({ ok: true, codes: [], citedMeetingIds: ["M1"] });
    expect(result.text).toContain("[M1:E1, Alice, 00:00:30]");
    expect(result.text).toContain("[Vendor](https://vendor.example/docs)");
  });

  it("never expands citation-shaped text inside a public URL", async () => {
    const { validateMeetingAnswer } = await answer();
    const result = validateMeetingAnswer("Decision [M1:E1]. See https://vendor.example/docs/[M1:E1].", packed(), { requireContent: true });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("https://vendor.example/docs/[M1:E1]");
  });

  it("rejects unknown labels, changed attribution and cross-meeting aliases despite one valid citation", async () => {
    const { validateMeetingAnswer } = await answer();
    for (const bad of ["[M9:E1]", "[M1:E1, Bob, 00:01:00]", "[M2:E1, Alice, 00:00:30]", "[M1:made-up]", "[T1]"]) {
      expect(validateMeetingAnswer(`Known [M1:E1]. Unknown ${bad}.`, packed(), { requireContent: true }).codes).toContain("unknown_meeting_citation");
    }
  });

  it("does not expand ambiguous shorthand or treat metadata as substantive content", async () => {
    const { validateMeetingAnswer } = await answer();
    const evidence = packed();
    evidence.suppliedCitations["[M1:E1, Alternative attribution]"] = { meetingId: "M1", evidenceId: "M1:E1", kind: "summary" };
    expect(validateMeetingAnswer("Decision [M1:E1].", evidence, { requireContent: true }).ok).toBe(false);
    const metadata = packed([meeting("M1", "metadata", { evidence: [{ id: "M1:E1", kind: "metadata", text: "", metadata: { title: "Planning" } }] })]);
    metadata.suppliedCitations = { "[M1]": { meetingId: "M1", evidenceId: "M1:E1", kind: "metadata" } };
    expect(validateMeetingAnswer("The meeting was on Tuesday [M1].", metadata, { requireContent: false }).ok).toBe(true);
    expect(validateMeetingAnswer("They agreed to launch [M1].", metadata, { requireContent: true }).codes).toContain("no_usable_evidence");
  });

  it("requires a retained content citation even when other evidence exists", async () => {
    const { validateMeetingAnswer } = await answer();
    expect(validateMeetingAnswer("The release was delayed.", packed(), { requireContent: true }).codes).toContain("missing_content_citation");
    const evidence = packed();
    evidence.suppliedCitations["[M1]"] = { meetingId: "M1", evidenceId: "M1:E2", kind: "metadata" };
    expect(validateMeetingAnswer("It was delayed [M1].", evidence, { requireContent: true }).codes).toContain("missing_content_citation");
  });

  it("does not treat an overview as usable when the requested body was required but unavailable", async () => {
    const { hasUsableContent, validateMeetingAnswer } = await answer();
    const evidence = packed([meeting("M1", "read", { body: { state: "missing" }, coverage: { purpose: "transcript", bodyRequired: true, omittedEvidenceCount: 0, omissionReasons: [], support: "none" } })]);
    expect(hasUsableContent(evidence)).toBe(false);
    expect(validateMeetingAnswer("Transcript conclusions [M1:E1].", evidence, { requireContent: true }).codes).toContain("no_usable_evidence");
  });

  it("renders all seven statuses and keeps read-but-uncited, body-not-requested and actually missing distinct", async () => {
    const { buildCoverage } = await answer();
    const evidence = packed([
      meeting("M1"), meeting("M2"), meeting("M3", "metadata", { evidence: [] }),
      meeting("M4", "not_read", { evidence: [] }), meeting("M5", "unavailable", { evidence: [], body: { state: "timeout" } }),
      meeting("M6", "read", { body: { state: "missing" } }),
      meeting("M7", "read", { coverage: { purpose: "summary", omittedEvidenceCount: 2, omissionReasons: ["package_budget"], support: "limited" }, evidence: [] }),
    ]);
    const text = buildCoverage(evidence, ["M1"]);
    for (let n = 1; n <= 7; n++) expect(text).toContain(`M${n}`);
    expect(text).toContain("M2 — Content was read, but this answer does not cite it");
    expect(text).toContain("M3 — Discovered; content was not read");
    expect(text).toContain("Body was not requested");
    expect(text).toContain("M6 — Content was read, but this answer does not cite it. The stored body was reported missing");
    expect(text).toContain("Evidence was omitted or shortened");
    expect(text).not.toContain("storage-record-"); expect(text).not.toContain("summarized");
  });

  it("preserves each query count/limit without adding overlapping totals or printing omitted references", async () => {
    const { buildCoverage } = await answer();
    const evidence = packed();
    evidence.discoveries = [
      { queryKey: "query-1", toolName: "tinycloud_find_meetings", arguments: {}, discovery: { matchedCount: 7, returnedCount: 2, countKind: "exact", scanLimited: false, excludedUndatedCount: 1, interval: { from: "2026-09-07", to: "2026-09-13" }, omittedMeetingRefs: ["raw-omitted-ref"], observedAt: "2026-09-15" } },
      { queryKey: "query-2", toolName: "tinycloud_find_meetings", arguments: {}, discovery: { matchedCount: 3, returnedCount: 1, countKind: "lower_bound", scanLimited: true, excludedUndatedCount: 0, interval: { from: "2026-09-08", to: "2026-09-08" }, omittedMeetingRefs: [], observedAt: "2026-09-15" } },
    ] as any;
    const text = buildCoverage(evidence);
    expect(text).toContain("Query 1"); expect(text).toContain("7 matched; 2 returned");
    expect(text).toContain("Query 2"); expect(text).toContain("at least 3 matched; 1 returned");
    expect(text).toContain("scan limit"); expect(text).toContain("1 undated");
    expect(text).not.toContain("10 matched"); expect(text).not.toContain("raw-omitted-ref");
  });

  it("detects explicit false read totals and raw storage references", async () => {
    const { validateMeetingAnswer } = await answer();
    const evidence = packed([meeting("M1"), meeting("M2", "not_read", { evidence: [] })]);
    expect(validateMeetingAnswer("I read all 2 meetings. Decision [M1:E1].", evidence, { requireContent: true }).codes).toContain("coverage_conflict");
    expect(validateMeetingAnswer("The record storage-record-M1 says this [M1:E1].", evidence, { requireContent: true }).codes).toContain("internal_reference");
  });

  it("finalizes cited prose once with deterministic coverage and no provider-verbatim badge", async () => {
    const { validateMeetingAnswer, finalizeMeetingAnswer } = await answer();
    const evidence = packed();
    const final = finalizeMeetingAnswer(validateMeetingAnswer("Decision [M1:E1].", evidence, { requireContent: true }), evidence);
    expect(final).toMatchObject({ outcome: "partial", answer: { kind: "meeting_prose", delivery: "buffered" }, answerIsProviderVerbatim: false });
    expect(final.answer.text.match(/Decision/g)).toHaveLength(1);
    expect(final.answer.text).toContain("Content was read, but this answer does not cite it");
  });

  it("appends only returned public source provenance and bounds complete final answer text", async () => {
    const { validateMeetingAnswer, finalizeMeetingAnswer } = await answer();
    const evidence = packed();
    const result = validateMeetingAnswer("Decision [M1:E1].", evidence, { requireContent: true });
    const final = finalizeMeetingAnswer(result, evidence, [{ title: "Vendor docs", url: "https://vendor.example/docs", snippet: "SNIPPET_NOT_FOR_COVERAGE" }]);
    expect(final.answer.text).toContain("### Public sources"); expect(final.answer.text).toContain("https://vendor.example/docs"); expect(final.answer.text).not.toContain("SNIPPET_NOT_FOR_COVERAGE");
    expect(() => finalizeMeetingAnswer({ ...result, text: "x".repeat(64000) }, evidence)).toThrow("result_size_limit");
  });

  it("returns deterministic no-evidence/repair fallback without fabricated conclusions", async () => {
    const { safeMeetingFallback, hasUsableContent } = await answer();
    const evidence = packed([meeting("M1", "metadata", { evidence: [] })]); evidence.suppliedCitations = {};
    expect(hasUsableContent(evidence)).toBe(false);
    const final = safeMeetingFallback(evidence, "no_usable_evidence");
    expect(final).toMatchObject({ outcome: "partial", code: "no_usable_evidence", answer: { kind: "safe_fallback", delivery: "buffered" }, answerIsProviderVerbatim: false });
    expect(final.answer.text).toContain("No supported summary was produced");
    expect(final.answer.text).toContain("content was not read");
    expect(safeMeetingFallback(packed(), "citation_validation_failed").answer.text).not.toContain("release was delayed");
  });

  it("clarifies selection or calendar normally, without choosing a meeting or implying a read", async () => {
    const { clarifyMeetingSelection, clarifyCalendar } = await answer();
    const selection = clarifyMeetingSelection(packed([meeting("M1", "metadata"), meeting("M2", "metadata")]));
    expect(selection).toMatchObject({ outcome: "clarification", answerIsProviderVerbatim: false });
    expect(selection.answer.text).toContain("Which meeting");
    expect(selection.answer.text).toContain("M1 planning");
    expect(selection.answer.text).not.toContain("storage-record-");
    expect(clarifyCalendar()).toMatchObject({ outcome: "clarification", answerIsProviderVerbatim: false });
  });

  it("does not turn access denial into clarification, fallback or public-source synthesis", async () => {
    const { clarifyMeetingSelection, safeMeetingFallback, buildSynthesisMessages } = await answer();
    const evidence = packed([meeting("M1", "access_denied", { evidence: [] })]);
    expect(() => clarifyMeetingSelection(evidence)).toThrow("access_denied");
    expect(() => safeMeetingFallback(evidence, "no_usable_evidence")).toThrow("access_denied");
    expect(() => buildSynthesisMessages({ question: "Summarize", evidence, publicSources: [] })).toThrow("access_denied");
  });

  it("validates the actual run pack's stable citations across two tool-local E1 records", async () => {
    const { validateMeetingAnswer, finalizeMeetingAnswer } = await answer();
    const records = [meeting("source-A"), meeting("source-B")] as unknown as MeetingOutcome[];
    records.forEach((record, index) => {
      record.evidence[0] = { ...record.evidence[0]!, id: "E1", kind: "transcript_excerpt", speaker: index ? "Bob" : "Alice", startSecs: 30, offsets: { start: 0, end: 40 } };
    });
    const run = admitMeetingToolData(createRunEvidence("private-access-context"), { toolName: "tinycloud_read_meeting", arguments: { focus: "summary" }, data: { contractVersion: 2, outcomes: records } });
    const evidence = packRunEvidence(run, { contextWindowTokens: 128000, contextText: "Question and fixed instructions" });
    const result = validateMeetingAnswer("First release delay [M1:E1]. Second release delay [M2:E1].", evidence, { requireContent: true });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("[M1:E1, Alice, 00:00:30]");
    expect(result.text).toContain("[M2:E1, Bob, 00:00:30]");
    const final = finalizeMeetingAnswer(result, evidence);
    expect(final.outcome).toBe("success");
    expect(final.answer.text).not.toContain("private-access-context");
    expect(final.answer.text).not.toContain("storage-record-");
  });
});
