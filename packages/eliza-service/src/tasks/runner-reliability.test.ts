import { expect, test } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import { TINYCHAT_AGENT_ID, TINYCHAT_APP_ID } from "../auth/app-registry.js";
import { ToolError } from "../handlers/tools.js";
import type { TaskRequest } from "./contract.js";
import { runTask, TaskUsage } from "./runner.js";
import { TaskTools } from "./tools.js";

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const row = (ref = "record-one") => ({ meetingRef: ref, source: "fireflies", title: "Planning", startedAt: "2026-09-08T10:00:00Z", participants: [], organizerEmail: null });
function record(read: boolean, ref = "record-one") {
  const metadata = row(ref);
  return { meetingRef: ref, source: "fireflies", meeting: metadata, state: read ? "read" : "metadata", body: { state: "not_requested" },
    search: { state: "not_requested", storedFieldsExamined: false, bodyExamined: false, examinedMatches: 0, retainedMatches: 0 },
    evidence: [{ id: read ? "summary" : "metadata", meetingRef: ref, source: "fireflies", kind: read ? "summary" : "metadata", text: read ? "The release was delayed." : "", ...(read ? {} : { metadata }), truncated: false }],
    coverage: { purpose: read ? "summary" : "metadata", overviewPresent: read, actionsPresent: false, bodyAttempted: false, evidenceRetained: 1, omittedEvidenceCount: 0, omissionReasons: [], support: "sufficient" } };
}
const discovery = { matchedCount: 1, countKind: "exact", returnedCount: 1, scanLimited: false, excludedUndatedCount: 0, orderProven: true, interval: {}, observedAt: "2026-09-15", omittedMeetingRefs: [] };
const found = () => ({ contractVersion: 2, outcomes: [record(false)], discovery });
const readData = (ref = "record-one") => ({ contractVersion: 2, outcomes: [record(true, ref)] });
type Call = { name: string; args: Record<string, unknown> };
type Step = { text?: string; calls?: Call[]; status?: number; waitMs?: number };
const find: Call = { name: "tinycloud_find_meetings", args: { title: "Planning", sort: "newest", selectFirst: true } };
const read: Call = { name: "tinycloud_read_meeting", args: { meetingRef: "record-one", focus: "summary" } };
function run(steps: Step[], options: {
  question?: string; calendar?: TaskRequest["calendar"]; deadlineMs?: number; controller?: AbortController;
  action?: (name: string, operation: any, index: number) => unknown;
} = {}) {
  const requests: any[] = [];
  const operations: Array<{ name: string; args: Record<string, unknown>; context: Record<string, unknown> }> = [];
  const emitted: string[] = [];
  const controller = options.controller ?? new AbortController();
  const request: TaskRequest = { version: 1, executionId: crypto.randomUUID(), entityId: crypto.randomUUID(), roomId: "selected-room", model: { id: "test-model", contextWindowTokens: 40000 }, messages: [{ role: "system", content: "ACCOUNT_MEMORY_SENTINEL" }, { role: "user", content: "OLD_HISTORY_SENTINEL" }, { role: "assistant", content: "OLD_ASSISTANT_SENTINEL" }, { role: "user", content: options.question ?? "Summarize my latest meeting." }], calendar: options.calendar, allowedTools: ["tinycloud_find_meetings", "tinycloud_read_meeting", "web_search"], deadlineAt: Date.now() + (options.deadlineMs ?? 60000) };
  const tools = new TaskTools({ app: { appId: TINYCHAT_APP_ID, agentId: TINYCHAT_AGENT_ID }, entityId: request.entityId, roomId: request.roomId!, allowedTools: request.allowedTools, calendar: request.calendar, deadlineAt: request.deadlineAt, signal: controller.signal, host: { runtimeFor: async () => ({ actions: request.allowedTools.map(name => ({ name: name.toUpperCase(), handler: async (_runtime: unknown, _message: unknown, _state: unknown, operation: any) => {
    operations.push({ name, ...operation });
    return { success: true, data: options.action ? await options.action(name, operation, operations.length) : name === "tinycloud_find_meetings" ? found() : readData() };
  } })) } as unknown as IAgentRuntime) } });
  const usage = new TaskUsage(() => {});
  const pending = runTask(request, { apiKey: "test", baseUrl: "http://localhost", models: { "test-model": 40000 }, fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(init!.body as string));
    const step = steps[requests.length - 1];
    if (!step) throw new Error("unexpected provider request");
    if (step.waitMs) await new Promise(resolve => setTimeout(resolve, step.waitMs));
    if (step.status) return new Response("", { status: step.status });
    const delta = { ...(step.text ? { content: step.text } : {}), ...(step.calls ? { tool_calls: step.calls.map((call, index) => ({ index, id: `call-${requests.length}-${index}`, function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) };
    return new Response(frame({ choices: [{ delta }] }) + frame({ choices: [{ delta: {}, finish_reason: step.calls?.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + "data: [DONE]\n\n");
  } }, controller.signal, usage, text => emitted.push(text), { tools });
  return { pending, requests, operations, emitted, usage, tools };
}

test("A3: a normalized model-requested repeat uses the same local retry budget before a third-round read", async () => {
  const repeated = { name: find.name, args: { selectFirst: true, sort: "newest", title: " Planning " } };
  const task = run([{ calls: [find] }, { calls: [repeated] }, { calls: [read] }, { text: "The release was delayed [M1:E2]." }], { action(name, _operation, index) {
    if (index === 1) throw new ToolError("temporary", 502, "tool_failed");
    return name === find.name ? found() : readData();
  } });
  expect((await task.pending).outcome).toBe("success");
  expect(task.operations.map(operation => operation.name)).toEqual([find.name, find.name, read.name]);
  expect(task.tools.attempts).toBe(3);
  expect(task.requests).toHaveLength(4);
  expect(JSON.stringify(task.requests[2])).toContain("tool_repeat_limit");
  expect(task.requests[3].tools).toBeUndefined();
});

test("A3: sixteen sequential attempts force a no-tools answer and never dispatch a seventeenth", async () => {
  const calls = Array.from({ length: 16 }, (_, index) => ({ name: "web_search", args: { query: `query ${index}` } }));
  const task = run([{ calls }, { text: "No source results were returned." }], { question: "Check the public documentation.", action() { return { results: [] }; } });
  expect((await task.pending).outcome).toBe("success");
  expect(task.tools.attempts).toBe(16);
  expect(task.operations).toHaveLength(16);
  expect(task.requests[1].tools).toBeUndefined();
});

test("A6: an immediate selected-room follow-up reaches the action without a fabricated reference or range", async () => {
  const task = run([{ calls: [{ name: read.name, args: { focus: "summary" } }] }, { text: "The release was delayed [M1:E1]." }], { question: "What did we decide?" });
  expect((await task.pending).outcome).toBe("success");
  expect(task.operations).toHaveLength(1);
  expect(task.operations[0]!.args).toEqual({ focus: "summary" });
  expect(task.operations[0]!.context.retrievalMode).toBeUndefined();
});

test("A6: explicit new dates override model-supplied old discovery dates and carry range scope", async () => {
  const task = run([{ calls: [{ name: find.name, args: { from: "2026-01-01", to: "2026-01-05" } }] }, { text: "Planning [M1]." }], {
    question: "List my meetings from 2026-09-01 to 2026-09-07.", calendar: { localDate: "2026-09-15", timeZone: "Europe/Lisbon" },
  });
  expect((await task.pending).outcome).toBe("success");
  expect(task.operations[0]!.args).toEqual({ from: "2026-09-01", to: "2026-09-07" });
  expect(task.operations[0]!.context.retrievalMode).toBe("range");
  expect(task.operations[0]!.context.timeZone).toBe("Europe/Lisbon");
});

test("A7: current-run tool compaction retains caller context once and clean synthesis drops all earlier context", async () => {
  const task = run([{ calls: [find] }, { calls: [read] }, { text: "The release was delayed [M1:E2]." }]);
  await task.pending;
  const planning = JSON.stringify(task.requests[1]);
  expect(planning.split("ACCOUNT_MEMORY_SENTINEL")).toHaveLength(2);
  expect(planning).toContain("OLD_HISTORY_SENTINEL");
  const clean = JSON.stringify(task.requests[2]);
  for (const marker of ["ACCOUNT_MEMORY_SENTINEL", "OLD_HISTORY_SENTINEL", "OLD_ASSISTANT_SENTINEL"]) expect(clean).not.toContain(marker);
  expect(task.emitted).toEqual([]);
});

test("A10: one failed read preserves permitted evidence, exact failure coverage and all provider usage", async () => {
  const task = run([{ calls: [{ name: find.name, args: {} }] }, { calls: [read, { name: read.name, args: { focus: "summary", meetingRef: "record-two" } }] }, { text: "The release was delayed [M1:E2]." }], {
    question: "Summarize my meetings.", action(name, operation) {
      if (name === find.name) return { contractVersion: 2, outcomes: [record(false), record(false, "record-two")], discovery: { ...discovery, matchedCount: 2, returnedCount: 2 } };
      if (operation.args.meetingRef === "record-two") throw new ToolError("unavailable", 502, "meeting_unavailable");
      return readData();
    },
  });
  const result = await task.pending;
  expect(result.outcome).toBe("partial");
  expect(result.answer.text).toContain("M2");
  expect(result.answer.text).toContain("unavailable");
  expect(result.answer.text).not.toContain("missing from storage");
  expect(task.tools.attempts).toBe(4);
  expect(task.usage.snapshot()).toMatchObject({ promptTokens: 30, completionTokens: 15, startedAttempts: 3, finalizedAttempts: 3, usageCompleteness: "complete" });
});

test("A10: a provider failure during clean citation repair retains the completed draft's usage", async () => {
  const task = run([{ calls: [find] }, { calls: [read] }, { text: "REJECTED_DRAFT [M99:E1]." }, { status: 503 }]);
  await expect(task.pending).rejects.toThrow("upstream_failed");
  expect(task.requests).toHaveLength(4);
  expect(task.emitted).toEqual([]);
  expect(task.usage.snapshot()).toMatchObject({ promptTokens: 30, completionTokens: 15, startedAttempts: 4, reportedAttempts: 3, finalizedAttempts: 3, usageCompleteness: "partial" });
});

test("A3/A10: task cancellation after a tool resolves prevents later dispatch and keeps completed planning usage", async () => {
  const controller = new AbortController();
  const task = run([{ calls: [find, read] }], { controller, action() { controller.abort(); return found(); } });
  await expect(task.pending).rejects.toThrow("task_cancelled");
  expect(task.operations).toHaveLength(1);
  expect(task.requests).toHaveLength(1);
  expect(task.emitted).toEqual([]);
  expect(task.usage.snapshot()).toMatchObject({ promptTokens: 10, completionTokens: 5, startedAttempts: 1, finalizedAttempts: 1 });
});

test("A16: a separate web lookup after private reads fits before the fourth clean synthesis request", async () => {
  const task = run([
    { calls: [find] },
    { calls: [read] },
    { calls: [{ name: "web_search", args: { query: "vendor phased release documentation" } }] },
    { text: "The release was delayed [M1:E2]. The vendor supports phased releases [Vendor docs](https://vendor.example/docs)." },
  ], {
    question: "Compare our latest meeting decision with the vendor documentation.",
    action(name) {
      if (name === "web_search") return { results: [{ title: "Vendor docs", url: "https://vendor.example/docs", snippet: "Phased releases are supported." }] };
      return name === find.name ? found() : readData();
    },
  });
  const result = await task.pending;
  expect(task.operations.map(operation => operation.name)).toEqual([find.name, read.name, "web_search"]);
  expect(task.requests).toHaveLength(4);
  expect(task.requests[2].tools?.map((tool: any) => tool.function.name)).toEqual(["web_search"]);
  expect(JSON.stringify(task.requests[2])).not.toContain("ACCOUNT_MEMORY_SENTINEL");
  expect(JSON.stringify(task.requests[2])).not.toContain("OLD_HISTORY_SENTINEL");
  expect(JSON.stringify(task.requests[2])).toContain("You may request web_search");
  expect(task.requests[3].tools).toBeUndefined();
  expect(JSON.stringify(task.requests[3])).toContain("Phased releases are supported.");
  expect(JSON.stringify(task.requests[3])).not.toContain("ACCOUNT_MEMORY_SENTINEL");
  expect(JSON.stringify(task.requests[3])).not.toContain("OLD_HISTORY_SENTINEL");
  expect(task.emitted).toEqual([]);
  expect(result).toMatchObject({ outcome: "success", answer: { kind: "meeting_prose", delivery: "buffered" }, answerIsProviderVerbatim: false });
  expect(result.answer.text).toContain("[M1:E2]");
  expect(result.answer.text).toContain("https://vendor.example/docs");
  expect(task.usage.snapshot()).toMatchObject({ promptTokens: 40, completionTokens: 20, startedAttempts: 4, finalizedAttempts: 4, usageCompleteness: "complete" });
});

test("A6/A13: quoted relative meeting text in an ordinary language question does not require a calendar", async () => {
  const task = run([{ text: "It is a request to summarize meetings from the preceding week." }], {
    question: 'Explain the grammar of the sentence "Summarize my meetings last week."',
  });
  const result = await task.pending;
  expect(task.requests).toHaveLength(1);
  expect(task.operations).toEqual([]);
  expect(task.emitted.join("")).toBe("It is a request to summarize meetings from the preceding week.");
  expect(result).toMatchObject({ outcome: "success", answer: { kind: "model_text", delivery: "streamed" }, answerIsProviderVerbatim: true });
});


test("an early clean round can finish immediately while advertising only public search", async () => {
  const task = run([{ calls: [find] }, { calls: [read] }, { text: "The release was delayed [M1:E2]." }]);
  const result = await task.pending;
  expect(task.requests).toHaveLength(3);
  expect(task.requests[2].tools?.map((tool: any) => tool.function.name)).toEqual(["web_search"]);
  expect(result.outcome).toBe("success");
  expect(task.emitted).toEqual([]);
});

test("private tools remain unavailable after entering an early clean round", async () => {
  const task = run([{ calls: [find] }, { calls: [read] }, { calls: [{ name: read.name, args: { meetingRef: "record-two", focus: "summary" } }] }]);
  await expect(task.pending).rejects.toThrow("routing_mismatch");
  expect(task.operations.map(operation => operation.name)).toEqual([find.name, read.name]);
  expect(task.requests[2].tools?.map((tool: any) => tool.function.name)).toEqual(["web_search"]);
  expect(task.emitted).toEqual([]);
});

test("citation repair advertises no tools even after a web-enabled clean round", async () => {
  const task = run([{ calls: [find] }, { calls: [read] }, { text: "Rejected [M99:E1]." }, { text: "The release was delayed [M1:E2]." }]);
  expect((await task.pending).outcome).toBe("success");
  expect(task.requests).toHaveLength(4);
  expect(task.requests[2].tools?.map((tool: any) => tool.function.name)).toEqual(["web_search"]);
  expect(task.requests[3].tools).toBeUndefined();
  expect(JSON.stringify(task.requests[3])).toContain("Do not request another tool call");
  expect(JSON.stringify(task.requests[3])).not.toContain("You may request web_search");
});

test("a provider cannot dispatch web search from the forced fourth request or citation repair", async () => {
  const web = { name: "web_search", args: { query: "vendor documentation" } };
  const fourth = run([{ calls: [find] }, { calls: [read] }, { calls: [web] }, { calls: [{ name: "web_search", args: { query: "another source" } }] }], {
    action(name) { return name === "web_search" ? { results: [] } : name === find.name ? found() : readData(); },
  });
  await expect(fourth.pending).rejects.toThrow("upstream_incomplete");
  expect(fourth.requests[3].tools).toBeUndefined();
  expect(fourth.operations.map(operation => operation.name)).toEqual([find.name, read.name, "web_search"]);

  const repair = run([{ calls: [find] }, { calls: [read] }, { text: "Rejected [M99:E1]." }, { calls: [web] }]);
  await expect(repair.pending).rejects.toThrow("upstream_incomplete");
  expect(repair.requests[3].tools).toBeUndefined();
  expect(repair.operations.map(operation => operation.name)).toEqual([find.name, read.name]);
});
