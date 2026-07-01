import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Content, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { MEMORY_DB_HANDLE, NoDelegationError } from "@tinycloud/eliza-plugin-memory";
import { SessionStore } from "./session-store.js";
import { startElizaService, type ElizaServiceHost } from "./server.js";

const TEST_SERVICE_SECRET = "server-test-service-secret";

const TEST_AGENT_DID = "did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c";
const TEST_AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEST_ENTITY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeValidSerialized(): string {
  return JSON.stringify({
    cid: "bafy-server-test",
    delegateDID: TEST_AGENT_DID,
    spaceId: "tinycloud:pkh:eip155:1:0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2:default",
    path: MEMORY_DB_HANDLE,
    actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
    expiry: new Date("2099-01-01T00:00:00.000Z").toISOString(),
    ownerAddress: "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2",
    chainId: 1,
    host: "https://node.tinycloud.xyz",
  });
}

class FakeStorage {
  readonly registered: Array<{ entityId: string; serialized: string; roomId?: string }> = [];

  async registerDelegation(entityId: string, serialized: string, roomId?: string): Promise<void> {
    this.registered.push({ entityId, serialized, roomId });
  }
}

function makeHost(storage = new FakeStorage()): { host: ElizaServiceHost; storage: FakeStorage } {
  return {
    storage,
    host: {
      agentDid: TEST_AGENT_DID,
      agentDidFor: async () => TEST_AGENT_DID,
      storageFor: async () => storage,
      runtimeFor: async () => {
        throw new Error("runtimeFor should not be called by these server tests");
      },
      preflight: async () => {},
    },
  };
}

function makeMessageHost(opts: {
  chunks?: Content[];
  preflightError?: unknown;
} = {}): { host: ElizaServiceHost; seen: { message?: Memory } } {
  const seen: { message?: Memory } = {};
  const runtime = {
    agentId: TEST_AGENT_ID as UUID,
    messageService: {
      async handleMessage(
        _runtime: IAgentRuntime,
        message: Memory,
        callback?: (content: Content) => Promise<Memory[]>,
      ) {
        seen.message = message;
        for (const chunk of opts.chunks ?? [{ text: "hello over sse" }]) {
          if (callback) await callback(chunk);
        }
        return { didRespond: true, responseMessages: [], mode: "simple" as const };
      },
    },
  } as unknown as IAgentRuntime;

  return {
    seen,
    host: {
      agentDid: TEST_AGENT_DID,
      agentDidFor: async () => TEST_AGENT_DID,
      storageFor: async () => new FakeStorage(),
      runtimeFor: async () => runtime,
      preflight: async () => {
        if (opts.preflightError) throw opts.preflightError;
      },
    },
  };
}

function makeToolHost(action: { name: string; result?: unknown }): ElizaServiceHost {
  const runtime = {
    agentId: TEST_AGENT_ID as UUID,
    actions: [
      {
        name: action.name,
        description: "test tool",
        validate: async () => true,
        handler: async (
          _r: IAgentRuntime,
          _m: Memory,
          _s: unknown,
          _o: unknown,
          callback?: (content: Content) => Promise<Memory[]>,
        ) => {
          if (callback) await callback({ text: "tool ran" });
          return { success: true, text: "tool ran", data: action.result ?? null };
        },
      },
    ],
  } as unknown as IAgentRuntime;

  return {
    agentDid: TEST_AGENT_DID,
    agentDidFor: async () => TEST_AGENT_DID,
    storageFor: async () => new FakeStorage(),
    runtimeFor: async () => runtime,
    preflight: async () => {},
  };
}

describe("eliza-service HTTP server", () => {
  let server: ReturnType<typeof startElizaService> | undefined;
  let savedSecret: string | undefined;

  beforeAll(() => {
    savedSecret = process.env.ELIZA_SERVICE_SECRET;
    process.env.ELIZA_SERVICE_SECRET = TEST_SERVICE_SECRET;
  });

  afterAll(() => {
    if (savedSecret !== undefined) {
      process.env.ELIZA_SERVICE_SECRET = savedSecret;
    } else {
      delete process.env.ELIZA_SERVICE_SECRET;
    }
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  function url(path: string): string {
    if (!server) throw new Error("server not started");
    return `http://${server.hostname}:${server.port}${path}`;
  }

  it("GET /health returns ok and the agent DID", async () => {
    const { host } = makeHost();
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/health"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, agentDid: TEST_AGENT_DID });
  });

  it("POST /sessions routes to the sessions handler", async () => {
    const { host, storage } = makeHost();
    const sessions = new SessionStore();
    server = startElizaService({ host, sessions, port: 0 });
    const serialized = makeValidSerialized();

    const res = await fetch(url("/sessions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${TEST_SERVICE_SECRET}`,
      },
      body: JSON.stringify({
        agentId: TEST_AGENT_ID,
        entityId: TEST_ENTITY_ID,
        serializedDelegation: serialized,
        roomId: "room-test",
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ entityId: TEST_ENTITY_ID, status: "active" });
    expect(storage.registered).toEqual([
      { entityId: TEST_ENTITY_ID, serialized, roomId: "room-test" },
    ]);
  });

  it("POST /messages streams SSE frames from the message handler", async () => {
    const { host, seen } = makeMessageHost({ chunks: [{ text: "one" }, { text: "two" }] });
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${TEST_SERVICE_SECRET}`,
      },
      body: JSON.stringify({
        agentId: TEST_AGENT_ID,
        entityId: TEST_ENTITY_ID,
        roomId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        text: "hello",
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(
      `data: ${JSON.stringify({ text: "one" })}\n\n`
        + `data: ${JSON.stringify({ text: "two" })}\n\n`
        + "data: [DONE]\n\n",
    );
    expect(seen.message?.entityId).toBe(TEST_ENTITY_ID);
  });

  it("POST /messages maps missing delegation to pre-stream HTTP 409", async () => {
    const { host } = makeMessageHost({
      preflightError: new NoDelegationError(TEST_ENTITY_ID),
    });
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${TEST_SERVICE_SECRET}`,
      },
      body: JSON.stringify({
        agentId: TEST_AGENT_ID,
        entityId: TEST_ENTITY_ID,
        roomId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        text: "hello",
      }),
    });

    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "delegation_required" });
  });

  it("POST /sessions without auth returns 401", async () => {
    const { host } = makeHost();
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: TEST_AGENT_ID,
        entityId: TEST_ENTITY_ID,
        serializedDelegation: makeValidSerialized(),
      }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("POST /messages without auth returns 401", async () => {
    const { host } = makeMessageHost();
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: TEST_AGENT_ID,
        entityId: TEST_ENTITY_ID,
        roomId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        text: "hello",
      }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("GET /sessions/:entityId without auth returns 401", async () => {
    const { host } = makeHost();
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url(`/sessions/${TEST_ENTITY_ID}`));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("GET /sessions/:entityId with auth returns session status", async () => {
    const { host } = makeHost();
    const sessions = new SessionStore();
    server = startElizaService({ host, sessions, port: 0 });

    // No session registered yet — should return 404 with status "none".
    const res = await fetch(url(`/sessions/${TEST_ENTITY_ID}`), {
      headers: { "Authorization": `Bearer ${TEST_SERVICE_SECRET}` },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ status: "none" });
  });

  it("POST /tools/:name dispatches to the action and returns JSON", async () => {
    const host = makeToolHost({ name: "WEB_SEARCH", result: { answer: "42" } });
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/tools/web_search"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${TEST_SERVICE_SECRET}`,
      },
      body: JSON.stringify({ args: { query: "meaning of life" } }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({
      ok: true,
      tool: "WEB_SEARCH",
      result: { text: "tool ran", data: { answer: "42" }, frames: [{ text: "tool ran" }] },
    });
  });

  it("POST /tools/:name without auth returns 401", async () => {
    const host = makeToolHost({ name: "WEB_SEARCH" });
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/tools/web_search"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: { query: "x" } }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("POST /tools/:name returns 404 for an unknown tool", async () => {
    const host = makeToolHost({ name: "WEB_SEARCH" });
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/tools/does_not_exist"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${TEST_SERVICE_SECRET}`,
      },
      body: JSON.stringify({ args: {} }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "tool_not_found", tool: "does_not_exist" });
  });

  it("returns 404 for an unknown route", async () => {
    const { host } = makeHost();
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/missing"));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns 400 for malformed JSON request bodies", async () => {
    const { host } = makeHost();
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/sessions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${TEST_SERVICE_SECRET}`,
      },
      body: "{not json",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "malformed_json" });
  });
});
