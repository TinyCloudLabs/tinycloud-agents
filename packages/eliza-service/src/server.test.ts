import { afterEach, describe, expect, it } from "bun:test";
import type { Content, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { MEMORY_DB_HANDLE, NoDelegationError } from "@tinycloud/eliza-plugin-memory";
import { SessionStore } from "./session-store.js";
import { startElizaService, type ElizaServiceHost } from "./server.js";

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
      storageFor: async () => new FakeStorage(),
      runtimeFor: async () => runtime,
      preflight: async () => {
        if (opts.preflightError) throw opts.preflightError;
      },
    },
  };
}

describe("eliza-service HTTP server", () => {
  let server: ReturnType<typeof startElizaService> | undefined;

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
      headers: { "content-type": "application/json" },
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
      headers: { "content-type": "application/json" },
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
      headers: { "content-type": "application/json" },
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
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "malformed_json" });
  });
});
