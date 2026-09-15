import { describe, expect, test } from "bun:test";
import { readModelRound, TaskUsage } from "./runner.js";
import { TaskError, type TaskRequest } from "./contract.js";

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const request: TaskRequest = { version: 1, executionId: crypto.randomUUID(), entityId: crypto.randomUUID(), model: { id: "local", contextWindowTokens: 10000 }, messages: [{ role: "user", content: "Synthetic parser fixture" }], allowedTools: ["web_search", "tinycloud_read_meeting"], deadlineAt: Date.now() + 60000 };
async function run(deltas: unknown[], options: { onContent?: (text: string, abort: AbortController) => void; done?: boolean; privateSelected?: boolean } = {}) {
  const abort = new AbortController();
  const emitted: string[] = [];
  const usage = new TaskUsage(() => {});
  let result: Awaited<ReturnType<typeof readModelRound>> | undefined;
  let failure: unknown;
  const body = deltas.map(delta => frame({ choices: [{ delta }] })).join("") + frame({ usage: { prompt_tokens: 17, completion_tokens: 5 }, choices: [{ delta: {}, finish_reason: "stop" }] }) + (options.done === false ? "" : "data: [DONE]\n\n");
  try {
    result = await readModelRound(request, { apiKey: "local-parser-only", baseUrl: "http://localhost", models: { local: 10000 }, fetchImpl: async () => new Response(body) }, abort.signal, usage, text => { emitted.push(text); options.onContent?.(text, abort); }, { privateSelected: options.privateSelected });
  } catch (error) { failure = error; }
  return { emitted, result, failure, usage: usage.snapshot() };
}

describe("task model parser edge contracts", () => {
  test("public tool selection preserves eligible prose co-delivered with its structured call", async () => {
    const outcome = await run([{ content: "Checking the public documentation.", tool_calls: [{ index: 0, id: "public-1", function: { name: "web_search", arguments: '{"query":"public docs"}' } }] }]);
    expect(outcome.failure).toBeUndefined();
    expect(outcome.result?.privateSelected).toBe(false);
    expect(outcome.emitted.join("")).toBe("Checking the public documentation.");
  });

  test("suppresses prose co-delivered with a complete private inline call", async () => {
    const outcome = await run([{ content: "PRIVATE_DRAFT_SENTINEL <tool_call>tinycloud_read_meeting<arg_key>focus</arg_key><arg_value>summary</arg_value></tool_call>" }]);
    expect(outcome.failure).toBeUndefined();
    expect(outcome.result?.privateSelected).toBe(true);
    expect(outcome.emitted).toEqual([]);
  });

  test("incomplete inline arguments cannot silently normalize into an empty executable read", async () => {
    const outcome = await run([{ content: "<tool_call>tinycloud_read_meeting<arg_key>focus</arg_key><arg_value>summary</tool_call>" }]);
    expect(outcome.failure).toBeInstanceOf(TaskError);
    expect((outcome.failure as TaskError).code).toBe("upstream_incomplete");
    expect(outcome.result).toBeUndefined();
    expect(outcome.emitted).toEqual([]);
    expect(outcome.usage.promptTokens).toBe(17);
  });

  test("cancellation prevents later content buffered in the same provider chunk", async () => {
    const outcome = await run([{ content: "First ordinary text." }, { content: "LATE_CONTENT_SENTINEL" }], { onContent: (_text, abort) => abort.abort() });
    expect(outcome.emitted).toEqual(["First ordinary text."]);
    expect(outcome.failure).toBeInstanceOf(TaskError);
    expect((outcome.failure as TaskError).code).toBe("task_cancelled");
  });

  test("missing DONE retains reported counters without finalizing provider usage", async () => {
    const outcome = await run([{ content: "Interrupted ordinary text." }], { done: false });
    expect((outcome.failure as TaskError).code).toBe("upstream_incomplete");
    expect(outcome.usage).toMatchObject({ promptTokens: 17, completionTokens: 5, reportedAttempts: 1, finalizedAttempts: 0, usageCompleteness: "partial" });
  });

  test("private selection inherited from an earlier round suppresses every later draft", async () => {
    const outcome = await run([{ content: "PRIVATE_AFTER_EMPTY_READ" }, { content: "PRIVATE_AFTER_FAILED_READ" }], { privateSelected: true });
    expect(outcome.failure).toBeUndefined();
    expect(outcome.result?.privateSelected).toBe(true);
    expect(outcome.emitted).toEqual([]);
    expect(outcome.usage).toMatchObject({ promptTokens: 17, completionTokens: 5, finalizedAttempts: 1, usageCompleteness: "complete" });
  });
});
