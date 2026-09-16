import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElizaServiceFetch, type ElizaServiceHost } from "../server.js";
import { SessionStore } from "../session-store.js";
import { addressToEntityId } from "../entity-id.js";
import { TINYCHAT_AGENT_ID } from "../auth/app-registry.js";

const ENTITY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EXECUTION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MODEL = "moonshotai/kimi-k3";
const secret = "task-test-credential";
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 12, completion_tokens: 3 };
const finished = frame({ choices: [{ delta: {}, finish_reason: "stop" }], usage }) + "data: [DONE]\n\n";
const encoder = new TextEncoder();
const host: ElizaServiceHost = {
  agentDid: "did:test:tasks",
  storageFor: async () => { throw new Error("ordinary tasks must not access native memory"); },
  runtimeFor: async () => { throw new Error("ordinary tasks must not boot native runtime"); },
  preflight: async () => { throw new Error("ordinary tasks do not require a delegation"); },
};
function body(overrides: Record<string, unknown> = {}) {
  return { version: 1, executionId: EXECUTION, entityId: ENTITY, model: { id: MODEL, contextWindowTokens: 10000 },
    messages: [{ role: "user", content: "Say hello." }], allowedTools: [], deadlineAt: Date.now() + 60000, ...overrides };
}
function request(value = body(), options: { path?: string; credential?: string; signal?: AbortSignal } = {}) {
  return new Request(`http://localhost${options.path ?? "/tasks"}`, { method: "POST", headers: { "Content-Type": "application/json", ...(options.credential === "" ? {} : { Authorization: `Bearer ${options.credential ?? secret}` }) }, body: JSON.stringify(value), signal: options.signal });
}
function service(fetchImpl = async (_input: unknown, _init?: RequestInit) => new Response(frame({ id: "completion-1", choices: [{ delta: { content: "Hello!" } }] }) + finished), extras = {}) {
  return createElizaServiceFetch({ host, sessions: new SessionStore(), tasks: {
    apiKey: "fake-local-provider-key", baseUrl: "http://localhost/v1", models: { [MODEL]: 10000 }, fetchImpl, ...extras,
  } });
}
async function events(response: Response): Promise<Array<Record<string, any>>> {
  return (await response.text()).split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
}
let savedSecret: string | undefined;
let savedOtherSecret: string | undefined;
beforeEach(() => { savedSecret = process.env.ELIZA_SERVICE_SECRET; savedOtherSecret = process.env.ARTIFACTORY_SERVICE_SECRET; process.env.ELIZA_SERVICE_SECRET = secret; process.env.ARTIFACTORY_SERVICE_SECRET = "other-app"; });
afterEach(() => { if (savedSecret === undefined) delete process.env.ELIZA_SERVICE_SECRET; else process.env.ELIZA_SERVICE_SECRET = savedSecret; if (savedOtherSecret === undefined) delete process.env.ARTIFACTORY_SERVICE_SECRET; else process.env.ARTIFACTORY_SERVICE_SECRET = savedOtherSecret; });

describe("TinyChat task HTTP seam", () => {
  it("rejects overlapping tasks for a room until the first task settles", async () => {
    let complete!: () => void;
    let calls = 0;
    const handler = service(async () => {
      calls++;
      if (calls === 1) await new Promise<void>(resolve => { complete = resolve; });
      return new Response(frame({ choices: [{ delta: { content: "Done." } }] }) + finished);
    });
    const first = await handler(request(body({ roomId: "room-one" })));
    const second = body({ executionId: crypto.randomUUID(), roomId: "room-one" });
    expect((await handler(request(second))).status).toBe(409);
    expect((await handler(request({ ...second, entityId: "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa" }))).status).toBe(409);
    expect(calls).toBe(1);
    complete();
    await first.text();
    const after = await handler(request(second));
    expect(after.status).toBe(200);
    await after.text();
  });

  it("accepts and cancels the existing ElizaOS entity ID derived from a wallet", async () => {
    const entityId = addressToEntityId("0x1111111111111111111111111111111111111111", TINYCHAT_AGENT_ID);
    expect(entityId[14]).toBe("0");
    const handler = service();
    const response = await handler(request(body({ entityId })));
    expect(response.status).toBe(200);
    expect((await events(response)).at(-1)?.outcome).toBe("success");
    const cancelled = await handler(request({ version: 1, entityId, reason: "client_cancelled" } as any, { path: `/tasks/${EXECUTION}/cancel` }));
    expect(cancelled.status).toBe(200);
    expect((await handler(request(body({ executionId: entityId })))).status).toBe(400);
  });

  it("advertises authenticated additive capability and disables unconfigured tasks", async () => {
    const handler = createElizaServiceFetch({ host, sessions: new SessionStore() });
    const unauthenticated = await handler(new Request("http://localhost/capabilities"));
    expect(unauthenticated.status).toBe(401);
    const capability = await (await handler(new Request("http://localhost/capabilities", { headers: { Authorization: `Bearer ${secret}` } }))).json();
    expect(capability.meetingRetrieval).toEqual({ contractVersion: 2 });
    expect(capability.chatTasks).toEqual({ version: 1, enabled: false, cancellation: true, providerProfile: "tinychat-redpill", models: [] });
    expect((await handler(request())).status).toBe(503);
  });

  it("authenticates and denies another app before provider work", async () => {
    let calls = 0;
    const handler = service(async () => { calls++; throw new Error("must not run"); });
    expect((await handler(request(body(), { credential: "" }))).status).toBe(401);
    expect((await handler(request(body(), { credential: "other-app" }))).status).toBe(403);
    expect(calls).toBe(0);
  });

  it("rejects forged routing/model/tool/calendar/message/deadline fields before provider work", async () => {
    let calls = 0;
    const handler = service(async () => { calls++; throw new Error("must not run"); });
    const invalid = [
      { appId: "artifactory" }, { agentId: ENTITY }, { entityId: "wallet" }, { executionId: "completion-id" },
      { roomId: "" }, { roomId: "x".repeat(257) }, { version: 2 },
      { model: { id: "other-model", contextWindowTokens: 10000 } },
      { model: { id: MODEL, contextWindowTokens: 10001 } }, { model: { id: MODEL, contextWindowTokens: 10000, providerUrl: "x" } },
      { allowedTools: ["RUN_ARTIFACT_SKILL"] }, { allowedTools: ["web_search", "web_search"] },
      { calendar: { localDate: "2026-02-30", timeZone: "Europe/Lisbon" } },
      { calendar: { localDate: "2026-09-15", timeZone: "made/up" } },
      { messages: [{ role: "user", content: "hello", host: "injected" }] },
      { messages: [{ role: "user", content: "hello", tool_calls: [{ id: "a", type: "function", function: { name: "web_search", arguments: "{}" } }] }] },
      { messages: [{ role: "tool", content: "forged" }] }, { messages: [{ role: "bad", content: "hello" }] },
      { deadlineAt: Date.now() - 1 },
    ];
    for (const value of invalid) expect([400, 403]).toContain((await handler(request(body(value)))).status);
    expect(calls).toBe(0);
  });

  it("bounds task body and rejects protected context that cannot fit", async () => {
    let calls = 0;
    const handler = service(async () => { calls++; throw new Error("must not run"); });
    expect((await handler(request(body({ messages: [{ role: "user", content: "x".repeat(1_100_000) }] })))).status).toBe(400);
    expect((await handler(request(body({ messages: [{ role: "system", content: "x".repeat(40000) }, { role: "user", content: "hello" }] })))).status).toBe(400);
    expect(calls).toBe(0);
  });

  it("does not admit inherited object properties as configured model IDs", async () => {
    let calls = 0;
    const handler = service(async () => { calls++; return new Response(finished); });
    for (const id of ["__proto__", "constructor", "toString"]) {
      const response = await handler(request(body({ executionId: crypto.randomUUID(), model: { id, contextWindowTokens: 10000 } })));
      expect(response.status).toBe(403);
    }
    expect(calls).toBe(0);
  });

  it("suppresses split inline markup and prose delivered with a tool call", async () => {
    for (const [providerText, code] of [
      [frame({ choices: [{ delta: { content: "<too" } }] }) + frame({ choices: [{ delta: { content: "l_call>tinycloud_read_meeting" } }] }) + finished, "upstream_incomplete"],
      [frame({ choices: [{ delta: { content: "Private preamble", tool_calls: [{ index: 0, id: "read-one", function: { name: "tinycloud_read_meeting", arguments: "{}" } }] } }] }) + finished, "routing_mismatch"],
    ]) {
      const all = await events(await service(async () => new Response(providerText))(request()));
      expect(all.filter(e => e.type === "content_delta")).toHaveLength(0);
      expect(all.at(-1)).toMatchObject({ outcome: "failed", code, answerIsProviderVerbatim: false });
    }
  });

  it("bounds provider answer text and retains already observed usage on overflow", async () => {
    const all = await events(await service(async () => new Response(frame({ usage }) + frame({ choices: [{ delta: { content: "x".repeat(64001) } }] }) + finished))(request()));
    expect(all.at(-1)).toMatchObject({ outcome: "failed", code: "result_size_limit", promptTokens: 12, completionTokens: 3 });
    expect(all.filter(e => e.type === "content_delta").map(e => e.text).join("").length).toBeLessThanOrEqual(64000);
  });

  it("streams ordinary text before completion and retains cumulative usage exactly once", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let seen: any;
    const handler = service(async (_input, init) => { seen = JSON.parse(init!.body as string); return new Response(new ReadableStream({ start(c) { controller = c; } })); });
    const response = await handler(request());
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let observed = new TextDecoder().decode((await reader.read()).value);
    expect(observed).toContain('"type":"accepted"');
    controller.enqueue(encoder.encode(frame({ id: "completion-1", choices: [{ delta: { content: "Hello" } }] })));
    while (!observed.includes('"text":"Hello"')) observed += new TextDecoder().decode((await reader.read()).value);
    expect(seen).toMatchObject({ model: MODEL, stream: true, stream_options: { include_usage: true } });
    expect(seen.messages.filter((message: { role: string }) => message.role === "user")).toEqual([{ role: "user", content: "Say hello." }]);
    expect(seen).not.toHaveProperty("entityId");
    controller.enqueue(encoder.encode(frame({ usage }) + frame({ usage }) + finished));
    controller.close();
    for (;;) { const item = await reader.read(); if (item.done) break; observed += new TextDecoder().decode(item.value); }
    const all = observed.split("\n\n").filter(s => s.startsWith("data: ")).map(s => JSON.parse(s.slice(6)));
    expect(all.map(e => e.seq)).toEqual(all.map((_, i) => i + 1));
    expect(all.filter(e => e.type === "final")).toHaveLength(1);
    expect(all.at(-1)).toMatchObject({ type: "final", model: MODEL, outcome: "success", promptTokens: 12, completionTokens: 3, startedAttempts: 1, reportedAttempts: 1, finalizedAttempts: 1, usageCompleteness: "complete", answer: { kind: "model_text", delivery: "streamed" }, finalProviderCompletionId: "completion-1", answerIsProviderVerbatim: true });
    expect(all.at(-1).answer).not.toHaveProperty("text");
  });

  it("retains reported usage when a later provider frame is malformed or unfinished", async () => {
    for (const ending of ["data: invalid-json\n\n", "", frame({ choices: [{ delta: {}, finish_reason: "stop" }] })]) {
      const handler = service(async () => new Response(frame({ usage }) + ending));
      const all = await events(await handler(request()));
      expect(all.at(-1)).toMatchObject({ outcome: "failed", code: "upstream_incomplete", promptTokens: 12, completionTokens: 3, reportedAttempts: 1, finalizedAttempts: 0, usageCompleteness: "partial" });
    }
  });

  it("keeps last valid counters when a provider usage report regresses", async () => {
    const all = await events(await service(async () => new Response(frame({ usage }) + frame({ usage: { prompt_tokens: 1, completion_tokens: 2 } }) + finished))(request()));
    expect(all.at(-1)).toMatchObject({ outcome: "failed", promptTokens: 12, completionTokens: 3, reportedAttempts: 1, usageCompleteness: "partial" });
  });

  it("reports missing usage as partial even when ordinary answer succeeds", async () => {
    const all = await events(await service(async () => new Response(frame({ choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n"))(request()));
    expect(all.at(-1)).toMatchObject({ outcome: "success", promptTokens: 0, completionTokens: 0, startedAttempts: 1, reportedAttempts: 0, finalizedAttempts: 0, usageCompleteness: "partial" });
  });

  it("rejects duplicate IDs, isolates cancel ownership, and retains terminal tombstones", async () => {
    const handler = service();
    await events(await handler(request()));
    expect((await handler(request())).status).toBe(409);
    const cancel = { version: 1, entityId: ENTITY, reason: "client_cancelled" };
    const path = `/tasks/${EXECUTION}/cancel`;
    expect((await handler(request(cancel as any, { path }))).status).toBe(200);
    expect((await handler(request(cancel as any, { path }))).status).toBe(200);
    expect((await handler(request({ ...cancel, entityId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } as any, { path }))).status).toBe(404);
  });

  it("cancels an uncooperative provider without awaiting it and starts no later work", async () => {
    let calls = 0;
    let signal!: AbortSignal;
    const handler = service(async (_input, init) => { calls++; signal = init!.signal!; return new Promise<Response>(() => {}); });
    const response = await handler(request());
    const cancelled = await handler(request({ version: 1, entityId: ENTITY, reason: "client_cancelled" } as any, { path: `/tasks/${EXECUTION}/cancel` }));
    expect(cancelled.status).toBe(200);
    const all = await events(response);
    expect(all.at(-1)).toMatchObject({ outcome: "cancelled", usageCompleteness: "partial", startedAttempts: 1 });
    expect(signal.aborted).toBe(true);
    expect(calls).toBe(1);
  });

  it("enforces the absolute task deadline against an ignored upstream abort", async () => {
    const all = await events(await service(async () => new Promise<Response>(() => {}))(request(body({ deadlineAt: Date.now() + 30 }))));
    expect(all.at(-1)).toMatchObject({ outcome: "timed_out", code: "turn_timeout", startedAttempts: 1 });
  });

  it("rejects an already-aborted request before provider execution", async () => {
    let calls = 0;
    const handler = service(async () => { calls++; throw new Error("must not run"); });
    const abort = new AbortController(); abort.abort();
    expect((await handler(request(body(), { signal: abort.signal }))).status).toBe(400);
    expect(calls).toBe(0);
  });

  it("response cancellation aborts provider work and capacity never evicts remembered runs", async () => {
    let signal!: AbortSignal;
    const handler = service(async (_input, init) => { signal = init!.signal!; return new Promise<Response>(() => {}); }, { capacity: 1 });
    const response = await handler(request());
    expect((await handler(request(body({ executionId: crypto.randomUUID() })))).status).toBe(429);
    await response.body!.cancel();
    expect(signal.aborted).toBe(true);
    expect((await handler(request())).status).toBe(409);
  });
});

describe("task private access generations", () => {
  it("filters private offers when no active server-side bundle exists", async () => {
    let offered: any[] = [];
    const handler = service(async (_input, init) => { offered = JSON.parse(String(init?.body)).tools ?? []; return new Response(finished); });
    await events(await handler(request(body({ allowedTools: ["web_search", "tinycloud_read_meeting"] }))));
    expect(offered.map(tool => tool.function.name)).toEqual(["web_search"]);
  });
  it("disconnect discards queued content and cancels only the affected entity while keeping usage", async () => {
    const store = new SessionStore(); const scope = { appId: "tinychat", agentId: TINYCHAT_AGENT_ID };
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    const handler = createElizaServiceFetch({ host: { ...host, disconnectEntity: async () => {}, privateAccessAvailable: () => true }, sessions: store, tasks: {
      apiKey: "fake-local-provider-key", baseUrl: "http://localhost/v1", models: { [MODEL]: 10000 },
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ async start(c) {
        c.enqueue(encoder.encode(frame({ usage }) + frame({ choices: [{ delta: { content: "PRIVATE QUEUED" } }] })));
        await waiting; try { c.enqueue(encoder.encode(finished)); c.close(); } catch { /* Cancelled body. */ }
      } })),
    } });
    const response = await handler(request());
    await new Promise(resolve => setTimeout(resolve, 0));
    const deleted = await handler(new Request(`http://localhost/sessions/${ENTITY}`, { method: "DELETE", headers: { Authorization: `Bearer ${secret}` } }));
    expect(deleted.status).toBe(200); release();
    const all = await events(response);
    expect(all[0].type).toBe("accepted");
    expect(JSON.stringify(all)).not.toContain("PRIVATE QUEUED");
    expect(all.at(-1)).toMatchObject({ outcome: "cancelled", promptTokens: 12, completionTokens: 3 });
    expect(store.snapshot(scope, ENTITY).state).toBe("disconnected");
  });
});

it("cannot upgrade a task admitted while the bundle was still activating", async () => {
  const sessions = new SessionStore(); const scope = { appId: "tinychat", agentId: TINYCHAT_AGENT_ID };
  const candidate = sessions.reserve(scope, ENTITY)!;
  let finish!: (value: Response) => void; let actionCalls = 0; let offered: any[] = [];
  const handler = createElizaServiceFetch({ sessions, host: { ...host, privateAccessAvailable: () => true,
    runtimeFor: async () => ({ actions: [{ name: "TINYCLOUD_READ_MEETING", handler: async () => { actionCalls++; return { text: "private" }; } }] }) as any,
  }, tasks: { apiKey: "local", baseUrl: "http://localhost/v1", models: { [MODEL]: 10000 }, fetchImpl: async (_url, init) => {
    offered = JSON.parse(String(init?.body)).tools;
    return new Promise<Response>(resolve => { finish = resolve; });
  } } });
  const response = await handler(request(body({ allowedTools: ["web_search", "tinycloud_read_meeting"] })));
  sessions.commit(scope, ENTITY, candidate, { agentId: scope.agentId, serializedDelegation: "controlled" });
  finish(new Response(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "private", function: { name: "tinycloud_read_meeting", arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage }) + "data: [DONE]\n\n"));
  const all = await events(response);
  expect(offered.map(tool => tool.function.name)).toEqual(["web_search"]);
  expect(actionCalls).toBe(0);
  expect(all.at(-1)).toMatchObject({ outcome: "failed", code: "routing_mismatch", promptTokens: 12, completionTokens: 3 });
});

it("another account's running task and connection survive disconnect", async () => {
  const other = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const sessions = new SessionStore(); const scope = { appId: "tinychat", agentId: TINYCHAT_AGENT_ID };
  const candidate = sessions.reserve(scope, other)!;
  sessions.commit(scope, other, candidate, { agentId: scope.agentId, serializedDelegation: "other-controlled" });
  let finish!: (value: Response) => void;
  const handler = createElizaServiceFetch({ sessions, host: { ...host, privateAccessAvailable: () => true, disconnectEntity: async () => {} }, tasks: {
    apiKey: "local", baseUrl: "http://localhost/v1", models: { [MODEL]: 10000 }, fetchImpl: async () => new Promise<Response>(resolve => { finish = resolve; }),
  } });
  const response = await handler(request(body({ entityId: other })));
  const deleted = await handler(new Request(`http://localhost/sessions/${ENTITY}`, { method: "DELETE", headers: { Authorization: `Bearer ${secret}` } }));
  expect(deleted.status).toBe(200);
  finish(new Response(frame({ choices: [{ delta: { content: "other account answer" } }] }) + finished));
  const all = await events(response);
  expect(JSON.stringify(all)).toContain("other account answer");
  expect(all.at(-1)).toMatchObject({ outcome: "success", promptTokens: 12, completionTokens: 3 });
  expect(candidate.isActive()).toBe(true);
});
