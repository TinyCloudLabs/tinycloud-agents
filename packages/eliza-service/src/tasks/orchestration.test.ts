import { expect, test } from "bun:test";
import { runTask, TaskUsage } from "./runner.js";
import { TaskTools } from "./tools.js";
import { TINYCHAT_AGENT_ID, TINYCHAT_APP_ID } from "../auth/app-registry.js";
import type { TaskRequest } from "./contract.js";
import type { IAgentRuntime } from "@elizaos/core";
import { ToolError } from "../handlers/tools.js";

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const metadata = { meetingRef: "existing-one", source: "fireflies", title: "Planning", startedAt: "2026-09-08T10:00:00Z", participants: [], organizerEmail: null };
const outcome = (read: boolean) => ({ meetingRef: metadata.meetingRef, source: metadata.source, meeting: metadata, state: read ? "read" : "metadata", body: { state: "not_requested" }, search: { state: "not_requested", storedFieldsExamined: false, bodyExamined: false, examinedMatches: 0, retainedMatches: 0 }, evidence: [{ id: read ? "overview" : "metadata", meetingRef: metadata.meetingRef, source: metadata.source, kind: read ? "summary" : "metadata", text: read ? "The release was delayed." : "", ...(read ? {} : { metadata }), truncated: false }], coverage: { purpose: read ? "summary" : "metadata", overviewPresent: read, actionsPresent: false, bodyAttempted: false, evidenceRetained: 1, omittedEvidenceCount: 0, omissionReasons: [], support: "sufficient" } });

test("Eliza owns find, read and clean cited synthesis with aggregate usage and no private draft delivery", async () => {
  const dispatched: string[] = [];
  const providerRequests: any[] = [];
  const emitted: string[] = [];
  const request: TaskRequest = { version: 1, executionId: crypto.randomUUID(), entityId: crypto.randomUUID(), roomId: "one-room", model: { id: "test-model", contextWindowTokens: 20000 }, messages: [{ role: "system", content: "ACCOUNT_MEMORY_SENTINEL" }, { role: "user", content: "Summarize my latest meeting." }], calendar: { localDate: "2026-09-15", timeZone: "Europe/Lisbon" }, allowedTools: ["tinycloud_find_meetings", "tinycloud_read_meeting"], deadlineAt: Date.now() + 60000 };
  const host = { runtimeFor: async () => ({ actions: [false, true].map(read => ({ name: read ? "TINYCLOUD_READ_MEETING" : "TINYCLOUD_FIND_MEETINGS", handler: async () => {
    dispatched.push(read ? "read" : "find");
    return { success: true, data: { contractVersion: 2, outcomes: [outcome(read)], ...(read ? {} : { discovery: { matchedCount: 1, countKind: "exact", returnedCount: 1, scanLimited: false, excludedUndatedCount: 0, orderProven: true, interval: {}, observedAt: "2026-09-15", omittedMeetingRefs: [] } }) } };
  } })) } as unknown as IAgentRuntime) };
  const signal = new AbortController().signal;
  const tools = new TaskTools({ host, app: { appId: TINYCHAT_APP_ID, agentId: TINYCHAT_AGENT_ID }, entityId: request.entityId, roomId: request.roomId!, allowedTools: request.allowedTools, deadlineAt: request.deadlineAt, signal });
  const usage = new TaskUsage(() => {});
  const result = await runTask(request, { apiKey: "fake", baseUrl: "http://localhost", models: { "test-model": 20000 }, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init!.body as string); providerRequests.push(body);
    const index = providerRequests.length;
    const delta = index === 1 ? { content: "Hidden discovery draft", tool_calls: [{ index: 0, id: "find1", function: { name: "tinycloud_find_meetings", arguments: '{"sort":"newest","selectFirst":true}' } }] }
      : index === 2 ? { content: "Hidden reading draft", tool_calls: [{ index: 0, id: "read1", function: { name: "tinycloud_read_meeting", arguments: '{"meetingRef":"existing-one","focus":"summary"}' } }] }
      : { content: "The release was delayed [M1:E2]." };
    return new Response(frame({ id: `provider-${index}`, choices: [{ delta }] }) + frame({ choices: [{ delta: {}, finish_reason: index <= 2 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + "data: [DONE]\n\n");
  } }, signal, usage, text => emitted.push(text), { tools });
  expect(dispatched).toEqual(["find", "read"]);
  expect(providerRequests).toHaveLength(3);
  expect(providerRequests[0].messages.some((m: any) => m.content.includes("ACCOUNT_MEMORY_SENTINEL"))).toBe(true);
  expect(JSON.stringify(providerRequests[2])).not.toContain("ACCOUNT_MEMORY_SENTINEL");
  expect(providerRequests[2].tools).toBeUndefined();
  expect(providerRequests[2].reasoning_effort).toBe("low");
  expect(emitted).toEqual([]);
  expect(result).toMatchObject({ outcome: "success", answer: { kind: "meeting_prose", delivery: "buffered" }, answerIsProviderVerbatim: false });
  expect(result.answer?.text).toContain("release was delayed");
  expect(result.answer?.text).toContain("Coverage");
  expect(result.answer?.text).not.toContain("existing-one");
  expect(usage.snapshot()).toMatchObject({ promptTokens: 30, completionTokens: 15, startedAttempts: 3, finalizedAttempts: 3, usageCompleteness: "complete" });
});

const discovery = { matchedCount: 1, countKind: "exact", returnedCount: 1, scanLimited: false, excludedUndatedCount: 0, orderProven: true, interval: {}, observedAt: "2026-09-15", omittedMeetingRefs: [] };

type Step = { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }>; status?: number };
function scenario(steps: Step[], options: { question?: string; calendar?: TaskRequest["calendar"]; tool?: (name: string, args: any, index: number) => unknown; signal?: AbortSignal } = {}) {
  const requests: any[] = [];
  const dispatched: string[] = [];
  const emitted: string[] = [];
  const delegation: string[] = [];
  const request: TaskRequest = { version: 1, executionId: crypto.randomUUID(), entityId: crypto.randomUUID(), roomId: "fixture-room", model: { id: "fixture-model", contextWindowTokens: 40000 }, messages: [{ role: "system", content: "PRIVATE_ACCOUNT_MEMORY" }, { role: "user", content: options.question ?? "Summarize my latest meeting." }], calendar: options.calendar, allowedTools: ["tinycloud_find_meetings", "tinycloud_read_meeting", "web_search"], deadlineAt: Date.now() + 60000 };
  const signal = options.signal ?? new AbortController().signal;
  const tools = new TaskTools({ app: { appId: TINYCHAT_APP_ID, agentId: TINYCHAT_AGENT_ID }, entityId: request.entityId, roomId: request.roomId!, allowedTools: request.allowedTools, deadlineAt: request.deadlineAt, signal,
    host: { runtimeFor: async () => ({ actions: request.allowedTools.map(name => ({ name: name.toUpperCase(), handler: async (_runtime: unknown, _message: unknown, _state: unknown, operation: any) => {
      dispatched.push(name);
      const data = options.tool ? await options.tool(name, operation.args, dispatched.length) : { contractVersion: 2, outcomes: [outcome(name === "tinycloud_read_meeting")], ...(name === "tinycloud_find_meetings" ? { discovery } : {}) };
      return { success: true, data };
    } })) } as unknown as IAgentRuntime) } });
  const usage = new TaskUsage(() => {});
  const pending = runTask(request, { apiKey: "fake", baseUrl: "http://localhost", models: { "fixture-model": 40000 }, fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(init!.body as string));
    const step = steps[requests.length - 1];
    if (!step) throw new Error("Unexpected extra provider attempt");
    if (step.status) return new Response("", { status: step.status });
    const delta = { ...(step.text ? { content: step.text } : {}), ...(step.calls ? { tool_calls: step.calls.map((call, index) => ({ index, id: `call-${requests.length}-${index}`, function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) };
    return new Response(frame({ id: `completion-${requests.length}`, choices: [{ delta }] }) + frame({ choices: [{ delta: {}, finish_reason: step.calls?.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + "data: [DONE]\n\n");
  } }, signal, usage, text => emitted.push(text), { tools, onDelegationError: code => delegation.push(code) });
  return { pending, requests, dispatched, emitted, usage, delegation };
}
const find: Step = { calls: [{ name: "tinycloud_find_meetings", args: { sort: "newest", selectFirst: true } }] };
const read: Step = { calls: [{ name: "tinycloud_read_meeting", args: { meetingRef: metadata.meetingRef, focus: "summary" } }] };

test("transient discovery retries once locally, then still reads and synthesizes inside a short task budget", async () => {
  const run = scenario([find, read, { text: "The release was delayed [M1:E2]." }], { tool(name, _args, attempt) {
    if (attempt === 1) throw new ToolError("controlled transient", 502, "tool_failed");
    return { contractVersion: 2, outcomes: [outcome(name === "tinycloud_read_meeting")], ...(name === "tinycloud_find_meetings" ? { discovery } : {}) };
  } });
  expect((await run.pending).outcome).toBe("success");
  expect(run.dispatched).toEqual(["tinycloud_find_meetings", "tinycloud_find_meetings", "tinycloud_read_meeting"]);
  expect(run.requests).toHaveLength(3);
});

test("fourth ordinary request is clean no-tools and one extra citation repair excludes rejected prose", async () => {
  const other = structuredClone(outcome(false));
  other.meetingRef = "existing-two"; other.meeting.meetingRef = other.meetingRef;
  other.evidence[0].meetingRef = other.meetingRef; other.evidence[0].metadata!.meetingRef = other.meetingRef;
  const run = scenario([
    { calls: [{ name: "tinycloud_find_meetings", args: {} }] }, read,
    { calls: [{ name: "tinycloud_find_meetings", args: { title: "Planning" } }] },
    { text: "REJECTED_PRIVATE_CONCLUSION [M99:E9]." },
    { text: "The release was delayed [M1:E2]." },
  ], { question: "Summarize my meetings.", tool(name) { return { contractVersion: 2, outcomes: name === "tinycloud_read_meeting" ? [outcome(true)] : [outcome(false), other] }; } });
  const result = await run.pending;
  expect(run.requests).toHaveLength(5);
  expect(run.requests[3].tools).toBeUndefined(); expect(run.requests[4].tools).toBeUndefined();
  expect(JSON.stringify(run.requests[4])).not.toContain("REJECTED_PRIVATE_CONCLUSION");
  expect(JSON.stringify(run.requests[4])).not.toContain("PRIVATE_ACCOUNT_MEMORY");
  expect(run.emitted).toEqual([]);
  expect(result.outcome).toBe("partial");
  expect(result.answer?.text).toContain("M2 — Discovered; content was not read");
  expect(run.usage.snapshot()).toMatchObject({ startedAttempts: 5, reportedAttempts: 5, finalizedAttempts: 5, promptTokens: 50, completionTokens: 25 });
});

test("a failed citation repair returns one honest fallback and never exposes either rejected draft", async () => {
  const run = scenario([find, read, { text: "BAD_DRAFT [M9:E1]." }, { text: "BAD_REPAIR [M8:E1]." }]);
  const result = await run.pending;
  expect(result).toMatchObject({ outcome: "partial", code: "citation_validation_failed", answer: { kind: "safe_fallback", delivery: "buffered" }, answerIsProviderVerbatim: false });
  expect(result.answer?.text).not.toContain("BAD_");
  expect(run.emitted).toEqual([]);
  expect(run.requests).toHaveLength(4);
});

test("public-source turns stream and earlier-round prose prevents a final-provider badge", async () => {
  const run = scenario([{ text: "Checking the docs. ", calls: [{ name: "web_search", args: { query: "vendor docs" } }] }, { text: "The docs describe the feature [Vendor](https://vendor.example/docs)." }], { question: "What do the vendor docs say?", tool() { return { query: "vendor docs", answer: "Public synthesis", results: [{ title: "Vendor docs", url: "https://vendor.example/docs", snippet: "Returned public fact." }] }; } });
  const result = await run.pending;
  expect(result).toMatchObject({ outcome: "success", answer: { kind: "model_text", delivery: "streamed" }, answerIsProviderVerbatim: false });
  expect(run.emitted.join("")).toContain("Checking the docs");
  expect(run.emitted.join("")).toContain("The docs describe");
  expect(JSON.stringify(run.requests[1])).toContain("Returned public fact.");
  expect(result.answer).not.toHaveProperty("text");
});

test("access denial stops the task without private fallback or another provider request", async () => {
  const run = scenario([find], { tool() { throw new ToolError("controlled denial", 403, "access_denied"); } });
  await expect(run.pending).rejects.toThrow("access_denied");
  expect(run.dispatched).toHaveLength(1); expect(run.requests).toHaveLength(1); expect(run.delegation).toEqual(["access_denied"]);
  expect(run.usage.snapshot().promptTokens).toBe(10);
});

test("missing calendar and existing ambiguous-selection outcomes complete as clarification", async () => {
  const missing = scenario([find], { question: "Summarize my meetings from last week." });
  expect((await missing.pending).outcome).toBe("clarification"); expect(missing.requests).toHaveLength(1);
  expect(missing.dispatched).toEqual([]);
  expect(missing.usage.snapshot()).toMatchObject({ startedAttempts: 1, finalizedAttempts: 1, promptTokens: 10, completionTokens: 5 });
  const selection = scenario([read], { tool() { throw new ToolError("pick a meeting", 409, "meeting_selection_required"); } });
  expect((await selection.pending).outcome).toBe("clarification"); expect(selection.requests).toHaveLength(1);
});

test("later provider failure preserves all earlier usage and never retries provider transport", async () => {
  const run = scenario([find, { status: 503 }]);
  await expect(run.pending).rejects.toThrow("upstream_failed");
  expect(run.requests).toHaveLength(2);
  expect(run.usage.snapshot()).toMatchObject({ promptTokens: 10, completionTokens: 5, startedAttempts: 2, reportedAttempts: 1, finalizedAttempts: 1, usageCompleteness: "partial" });
});

test("an explicitly selected newest result keeps its 445-match receipt without reading unrelated records", async () => {
  const run = scenario([find, read, { text: "The release was delayed [M1:E2]." }], { tool(name) {
    return { contractVersion: 2, outcomes: [outcome(name === "tinycloud_read_meeting")], ...(name === "tinycloud_find_meetings" ? { discovery: { ...discovery, matchedCount: 445 } } : {}) };
  } });
  const result = await run.pending;
  expect(run.dispatched).toEqual(["tinycloud_find_meetings", "tinycloud_read_meeting"]);
  expect(run.requests).toHaveLength(3);
  expect(result.answer.text).toContain("445");
  expect(result.answer.text).not.toContain("M2");
});

test("one returned candidate without proven order or an exact singleton count is a clarification", async () => {
  const run = scenario([find], { tool() {
    return { contractVersion: 2, outcomes: [outcome(false)], discovery: { ...discovery, matchedCount: 445, orderProven: false, scanLimited: true, countKind: "lower_bound" } };
  } });
  expect((await run.pending).outcome).toBe("clarification");
  expect(run.dispatched).toHaveLength(1);
});

test("mixed synthesis keeps returned public snippets and URLs apart from private evidence", async () => {
  const run = scenario([find, { calls: [...read.calls!, { name: "web_search", args: { query: "vendor documentation" } }] }, {
    text: "The release was delayed [M1:E2]. The vendor supports phased releases [Vendor docs](https://vendor.example/docs).",
  }], { question: "Compare our latest meeting decision with the vendor documentation.", tool(name) {
    if (name === "web_search") return { query: "vendor documentation", results: [{ title: "Vendor docs", url: "https://vendor.example/docs", snippet: "Phased releases are supported." }] };
    return { contractVersion: 2, outcomes: [outcome(name === "tinycloud_read_meeting")], ...(name === "tinycloud_find_meetings" ? { discovery } : {}) };
  } });
  const result = await run.pending;
  expect(run.dispatched).toEqual(["tinycloud_find_meetings", "tinycloud_read_meeting", "web_search"]);
  expect(run.requests).toHaveLength(3);
  const synthesis = JSON.stringify(run.requests[2]);
  expect(synthesis).toContain("Phased releases are supported.");
  expect(synthesis).toContain("Public web sources:");
  expect(synthesis).not.toContain("PRIVATE_ACCOUNT_MEMORY");
  expect(result.answer.text).toContain("[M1:E2]");
  expect(result.answer.text).toContain("https://vendor.example/docs");
  expect(result.answer.text).toContain("### Public sources");
  expect(run.emitted).toEqual([]);
});

test("a typed denied outcome triggers reconnect metadata before any synthesis", async () => {
  const denied = { ...outcome(false), state: "access_denied", evidence: [], coverage: { ...outcome(false).coverage, evidenceRetained: 0, support: "none" } };
  const run = scenario([find], { tool() { return { contractVersion: 2, outcomes: [denied], discovery }; } });
  await expect(run.pending).rejects.toThrow("access_denied");
  expect(run.requests).toHaveLength(1);
  expect(run.delegation).toEqual(["access_denied"]);
});

test("an early private planning draft with no usable evidence switches to the deterministic fallback", async () => {
  const run = scenario([find, { text: "PRIVATE_PLANNING_DRAFT claims a decision without reading." }]);
  const result = await run.pending;
  expect(run.requests).toHaveLength(2);
  expect(run.emitted).toEqual([]);
  expect(result).toMatchObject({ outcome: "partial", code: "no_usable_evidence", answer: { kind: "safe_fallback" } });
  expect(result.answer.text).not.toContain("PRIVATE_PLANNING_DRAFT");
});
