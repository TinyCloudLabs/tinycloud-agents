import { describe, expect, test } from "bun:test";
import { TASK_FRAME_BYTES, TaskError, type TaskConfig } from "./contract.js";
import { providerEvents } from "./provider.js";

const encoder = new TextEncoder();
function config(chunks: Uint8Array[]): TaskConfig {
  return { apiKey: "controlled-provider", baseUrl: "http://localhost/v1", models: { local: 1000 }, fetchImpl: async () => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } })) };
}
async function read(chunks: Uint8Array[]) {
  const values: Record<string, unknown>[] = [];
  let failure: unknown;
  try { for await (const value of providerEvents(config(chunks), "local", [{ role: "user", content: "hello" }], new AbortController().signal)) values.push(value); }
  catch (error) { failure = error; }
  return { values, failure };
}

describe("task provider byte framing", () => {
  test("preserves split UTF-8 and every supported LF/CRLF separator across socket chunks", async () => {
    for (const separator of ["\n\n", "\r\n\r\n", "\n\r\n", "\r\n\n"]) {
      const bytes = encoder.encode(`data: ${JSON.stringify({ text: "🦋 café" })}${separator}data: [DONE]${separator}`);
      const result = await read(Array.from(bytes, byte => Uint8Array.of(byte)));
      expect(result.values).toEqual([{ text: "🦋 café" }]);
      expect(result.failure).toBeUndefined();
    }
  });

  test("retains complete usage before a later complete frame with malformed UTF-8", async () => {
    const good = encoder.encode('data: {"usage":{"prompt_tokens":17,"completion_tokens":5}}\n\n');
    const bad = encoder.encode('data: {"text":"');
    const end = encoder.encode('"}\n\n');
    const bytes = new Uint8Array(good.length + bad.length + 1 + end.length);
    bytes.set(good); bytes.set(bad, good.length); bytes[good.length + bad.length] = 0xff; bytes.set(end, good.length + bad.length + 1);
    const result = await read([bytes]);
    expect(result.values).toEqual([{ usage: { prompt_tokens: 17, completion_tokens: 5 } }]);
    expect(result.failure).toBeInstanceOf(TaskError);
    expect((result.failure as TaskError).code).toBe("upstream_incomplete");
  });

  test("bounds oversized frames while accepting the exact byte limit plus CRLF separator", async () => {
    const overhead = encoder.encode('data: {"text":""}').length;
    const exact = `data: ${JSON.stringify({ text: "x".repeat(TASK_FRAME_BYTES - overhead) })}`;
    expect(encoder.encode(exact).length).toBe(TASK_FRAME_BYTES);
    const accepted = await read([encoder.encode(`${exact}\r\n\r\ndata: [DONE]\r\n\r\n`)]);
    expect(accepted.failure).toBeUndefined();
    expect(accepted.values).toHaveLength(1);
    const overflow = await read([encoder.encode(`${exact}x\r\n\r\n`)]);
    expect((overflow.failure as TaskError).code).toBe("result_size_limit");
    const unframed = await read([encoder.encode("x".repeat(TASK_FRAME_BYTES + 100))]);
    expect((unframed.failure as TaskError).code).toBe("result_size_limit");
  });
});
