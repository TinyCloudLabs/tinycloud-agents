import { expect, test } from "bun:test";
import { readModelRound, TaskUsage } from "./runner.js";
import type { TaskRequest } from "./contract.js";

const request: TaskRequest = { version: 1, executionId: crypto.randomUUID(), entityId: crypto.randomUUID(), model: { id: "test", contextWindowTokens: 10000 }, messages: [{ role: "user", content: "Read the latest meeting." }], allowedTools: ["tinycloud_read_meeting"], deadlineAt: Date.now() + 60000 };
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
async function run(deltas: unknown[], privateSelected = false) {
  const emitted: string[] = [];
  const usage = new TaskUsage(() => {});
  const chunks = deltas.map(delta => frame({ choices: [{ delta }] })).join("");
  const result = await readModelRound(request, { apiKey: "fake", baseUrl: "http://localhost", models: { test: 10000 }, fetchImpl: async () => new Response(chunks + frame({ usage: { prompt_tokens: 9, completion_tokens: 3 }, choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n") }, new AbortController().signal, usage, text => emitted.push(text), { tools: [], privateSelected });
  return { result, emitted: emitted.join(""), usage: usage.snapshot() };
}

test("buffers content co-delivered with private selection and accumulates split structured arguments", async () => {
  const { result, emitted, usage } = await run([
    { content: "Private draft", tool_calls: [{ index: 0, id: "call1", function: { name: "tinycloud_read_meeting", arguments: '{"focus":' } }] },
    { content: " more private draft", tool_calls: [{ index: 0, function: { arguments: '"summary"}' } }] },
  ]);
  expect(emitted).toBe("");
  expect(result.privateSelected).toBe(true);
  expect(result.calls).toEqual([{ id: "call1", name: "tinycloud_read_meeting", args: '{"focus":"summary"}' }]);
  expect(usage).toMatchObject({ promptTokens: 9, completionTokens: 3, finalizedAttempts: 1 });
});

test("keeps already-streamed initial prose but buffers all later private deltas", async () => {
  const { result, emitted } = await run([{ content: "I will check. " }, { tool_calls: [{ index: 0, id: "call1", function: { name: "tinycloud_read_meeting", arguments: '{"focus":"summary"}' } }] }, { content: "Private draft" }]);
  expect(emitted).toBe("I will check. ");
  expect(result.privateSelected).toBe(true);
  expect((await run([{ content: "No meeting found; private draft" }], true)).emitted).toBe("");
});

test("normalizes split inline calls without leaking markup", async () => {
  const { emitted, result } = await run([{ content: "<too" }, { content: "l_call>tinycloud_read_meeting<arg_key>focus</arg_key><arg_value>summary</arg_value></tool_call>" }]);
  expect(emitted).toBe("");
  expect(result.privateSelected).toBe(true);
  expect(result.calls).toMatchObject([{ name: "tinycloud_read_meeting", args: '{"focus":"summary"}' }]);
});

test("ordinary text stays incremental and public tool selection does not select private buffering", async () => {
  expect((await run([{ content: "Hello" }, { content: " world" }])).emitted).toBe("Hello world");
  const result = await run([{ tool_calls: [{ index: 0, id: "web1", function: { name: "web_search", arguments: '{"query":"docs"}' } }] }, { content: "Checking public sources." }]);
  expect(result.result.privateSelected).toBe(false);
  expect(result.emitted).toBe("Checking public sources.");
});
