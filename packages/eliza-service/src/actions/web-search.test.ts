import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { webSearchAction } from "./web-search.js";

let previousFetch: typeof fetch;
let previousKey: string | undefined;
beforeEach(() => { previousFetch = globalThis.fetch; previousKey = process.env.TAVILY_API_KEY; process.env.TAVILY_API_KEY = "fake-local-key"; });
afterEach(() => { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = previousKey; });
function run(signal: AbortSignal, callback = async () => []) {
  return webSearchAction.handler({} as IAgentRuntime, { content: { text: "query" } } as Memory, undefined, { args: { query: "query" }, context: { signal, deadlineAt: Date.now() + 60_000 } }, callback, []);
}

describe("web-search cancellation", () => {
  it("does not fetch after cancellation and passes the operation signal to fetch", async () => {
    let calls = 0;
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input, init) => { calls++; signal = init?.signal; return new Response('{"answer":"public answer","results":[]}'); }) as typeof fetch;
    const abort = new AbortController(); abort.abort();
    await expect(run(abort.signal)).rejects.toHaveProperty("code", "retrieval_cancelled");
    expect(calls).toBe(0);
    const active = new AbortController();
    await run(active.signal);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("settles an ignored fetch abort and cancels a response that arrives later", async () => {
    let resolve!: (response: Response) => void;
    let ready!: () => void;
    const started = new Promise<void>(r => { ready = r; });
    let cancelled = 0;
    let callbacks = 0;
    globalThis.fetch = (async () => { ready(); return new Promise<Response>(r => { resolve = r; }); }) as typeof fetch;
    const abort = new AbortController();
    const pending = run(abort.signal, async () => { callbacks++; return []; });
    await started;
    abort.abort();
    await expect(pending).rejects.toHaveProperty("code", "retrieval_cancelled");
    resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(cancelled).toBe(1);
    expect(callbacks).toBe(0);
  });

  it("aborts response-body reading without emitting a late callback", async () => {
    let ready!: () => void;
    const reading = new Promise<void>(r => { ready = r; });
    let cancelled = 0;
    let callbacks = 0;
    globalThis.fetch = (async () => new Response(new ReadableStream({ pull() { ready(); }, cancel() { cancelled++; } }))) as typeof fetch;
    const abort = new AbortController();
    const pending = run(abort.signal, async () => { callbacks++; return []; });
    await reading;
    await Promise.resolve();
    abort.abort();
    await expect(pending).rejects.toHaveProperty("code", "retrieval_cancelled");
    expect(cancelled).toBe(1);
    expect(callbacks).toBe(0);
  });
});
