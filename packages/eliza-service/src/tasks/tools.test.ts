import { describe, expect, it } from "bun:test";
import type { Action, IAgentRuntime } from "@elizaos/core";
import { NoDelegationError } from "@tinycloud/eliza-plugin-memory";
import { TINYCHAT_AGENT_ID, TINYCHAT_APP_ID } from "../auth/app-registry.js";
import { TaskTools, type TaskToolOptions } from "./tools.js";

const entityId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const app = { appId: TINYCHAT_APP_ID, agentId: TINYCHAT_AGENT_ID };
const call = { id: "call-1", name: "web_search", args: { query: "hello" } };
function options(overrides: Partial<TaskToolOptions> = {}): TaskToolOptions {
  return { host: { runtimeFor: async () => ({ actions: [] }) as unknown as IAgentRuntime }, app, entityId, roomId: "thread-1", allowedTools: ["web_search", "tinycloud_find_meetings", "tinycloud_read_meeting", "tinycloud_search_transcripts", "tinycloud_list_meeting_actions"], signal: new AbortController().signal, deadlineAt: Date.now() + 60_000, ...overrides };
}
async function bridge(value = options()) {
  return new TaskTools(value);
}
function actionHost(handler: Action["handler"], name = "WEB_SEARCH") {
  return { runtimeFor: async (agentId: string) => {
    expect(agentId).toBe(TINYCHAT_AGENT_ID);
    return { actions: [{ name, handler }] } as unknown as IAgentRuntime;
  } };
}

describe("in-process task tool bridge", () => {
  it("normalizes admitted names and forwards only trusted identity/context to the existing handler", async () => {
    const activity: unknown[] = [];
    const args = { query: "hello" };
    const resultData = { returned: "bounded fixture" };
    const tools = await bridge(options({ calendar: { localDate: "2026-09-15", timeZone: "Europe/Lisbon" }, onActivity: event => activity.push(event), host: actionHost(async (_runtime, message, _state, operation, callback) => {
      expect(message).toMatchObject({ agentId: TINYCHAT_AGENT_ID, entityId, roomId: "thread-1" });
      const forwarded = operation as any;
      expect(forwarded.args).toEqual(args);
      expect(forwarded.context).toMatchObject({ localDate: "2026-09-15", timeZone: "Europe/Lisbon", retrievalMode: "selected" });
      expect(forwarded.context.signal).toBeInstanceOf(AbortSignal);
      expect(forwarded.context.deadlineAt - Date.now()).toBeLessThanOrEqual(10_000);
      await callback?.({ text: "tool text" });
      return { success: true, data: resultData };
    }) }));
    expect(await tools.execute({ ...call, name: "WEB_SEARCH" }, "selected")).toEqual({ status: 200, body: { ok: true, tool: "WEB_SEARCH", result: { text: "tool text", data: resultData, frames: [{ text: "tool text" }] } } });
    expect(tools.attempts).toBe(1);
    expect(activity).toEqual([{ tool: "web_search", callId: "call-1", status: "running" }, { tool: "web_search", callId: "call-1", status: "done" }]);
  });

  it("denies non-TinyChat apps, unadmitted names and artifact actions before runtime acquisition", async () => {
    let boots = 0;
    const host = { runtimeFor: async () => { boots++; return { actions: [] } as unknown as IAgentRuntime; } };
    const denied = await bridge(options({ host, allowedTools: ["web_search"] }));
    for (const name of ["RUN_ARTIFACT_SKILL", "tinycloud_read_meeting", "other", " web_search"]) expect((await denied.execute({ ...call, name })).status).toBe(403);
    const otherApp = await bridge(options({ host, app: { appId: "artifactory", agentId: TINYCHAT_AGENT_ID } }));
    expect((await otherApp.execute(call)).status).toBe(403);
    expect(boots).toBe(0);
    expect(denied.attempts).toBe(0);
  });

  it("rejects model routing, paths, signals and invalid meeting arguments before runtime acquisition", async () => {
    let boots = 0;
    const tools = await bridge(options({ host: { runtimeFor: async () => { boots++; return {} as IAgentRuntime; } } }));
    const routing = ["agentId", "appId", "entityId", "roomId", "host", "path", "sql", "signal", "deadlineAt"];
    for (const name of ["web_search", "tinycloud_find_meetings", "tinycloud_read_meeting", "tinycloud_search_transcripts", "tinycloud_list_meeting_actions"]) {
      for (const field of routing) expect((await tools.execute({ id: "call", name, args: { [field]: "forged" } })).status).toBe(400);
    }
    expect((await tools.execute({ id: "call", name: "tinycloud_read_meeting", args: { focus: "speaker" } })).status).toBe(400);
    expect(boots).toBe(0);
  });

  it("preserves a selected follow-up without inventing a meetingRef or a range scope", async () => {
    const tools = await bridge(options({ host: actionHost(async (_runtime, _message, _state, operation) => {
      expect((operation as any).args).toEqual({ focus: "summary" });
      expect((operation as any).context.retrievalMode).toBeUndefined();
      return { success: true, data: { contractVersion: 2, outcomes: [] } };
    }, "TINYCLOUD_READ_MEETING") }));
    const result = await tools.execute({ id: "follow-up", name: "tinycloud_read_meeting", args: { focus: "summary" } });
    expect(result.status).toBe(200);
    expect((result.body.result as any).data).toEqual({ contractVersion: 2, outcomes: [] });
  });

  it("rejects the seventeenth dispatched attempt without retrying or acquiring a runtime", async () => {
    let boots = 0;
    const tools = await bridge(options({ host: { runtimeFor: async () => { boots++; return { actions: [] } as unknown as IAgentRuntime; } } }));
    for (let i = 0; i < 16; i++) expect((await tools.execute({ ...call, id: `call-${i}` })).status).toBe(404);
    expect((await tools.execute(call)).body).toEqual({ error: "tool_attempt_limit" });
    expect(tools.attempts).toBe(16);
    expect(boots).toBe(16);
  });

  it("cancels runtime acquisition and never invokes an action after its late resolution", async () => {
    const abort = new AbortController();
    let resolve!: (runtime: IAgentRuntime) => void;
    let actions = 0;
    const tools = await bridge(options({ signal: abort.signal, host: { runtimeFor: () => new Promise(value => { resolve = value; }) } }));
    const pending = tools.execute(call);
    abort.abort();
    await expect(pending).rejects.toThrow("task_cancelled");
    resolve({ actions: [{ name: "WEB_SEARCH", handler: async () => { actions++; return { success: true }; } }] } as unknown as IAgentRuntime);
    await Promise.resolve(); await Promise.resolve();
    expect(actions).toBe(0);
  });

  it("uses the task deadline while waiting on runtime acquisition", async () => {
    const tools = await bridge(options({ deadlineAt: Date.now() + 25, host: { runtimeFor: () => new Promise(() => {}) } }));
    await expect(tools.execute(call)).rejects.toThrow("turn_timeout");
  });

  it("rejects concurrent calls and aborts an uncooperative action at the independent 10-second ceiling", async () => {
    let signal: AbortSignal | undefined;
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const tools = await bridge(options({ host: actionHost(async (_runtime, _message, _state, operation) => {
      signal = (operation as any).context.signal;
      ready();
      return new Promise(() => {});
    }) }));
    const pending = tools.execute(call);
    await started;
    expect(await tools.execute({ ...call, id: "concurrent" })).toEqual({ status: 409, body: { error: "tool_already_running" } });
    const timedOut = await pending;
    // The bridge abort and the handler's retrieval deadline share the same
    // ceiling. Either timer may win; both preserve the typed timeout contract.
    expect([408, 504]).toContain(timedOut.status);
    expect(timedOut.body).toEqual({ error: "retrieval_timeout" });
    expect(signal?.aborted).toBe(true);
    expect(tools.attempts).toBe(1);
  }, 15000);

  it("does not start work after cancellation and retains typed delegation failures", async () => {
    const abort = new AbortController(); abort.abort();
    let boots = 0;
    const host = { runtimeFor: async () => { boots++; throw new NoDelegationError(entityId); } };
    const cancelled = await bridge(options({ host, signal: abort.signal }));
    await expect(cancelled.execute(call)).rejects.toThrow("task_cancelled");
    expect(boots).toBe(0);
    const tools = await bridge(options({ host }));
    expect(await tools.execute(call)).toEqual({ status: 409, body: { error: "delegation_required" } });
  });
});
