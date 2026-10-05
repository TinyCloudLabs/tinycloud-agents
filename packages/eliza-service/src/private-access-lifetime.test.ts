// TinyChat private access lasts for the life of the grant, not an idle timer.
//
// Regression: private tools stopped working 4h after "Connect agent" although the
// grant was valid for 30 days. /tools and /tasks gate on
// RuntimeHost.privateAccessAvailable -> storage.hasDelegation, and the memory
// registry's hasDelegation failed once an entry had been idle for 4h. Only
// /messages refreshed it, and TinyChat does not call /messages. GET /sessions
// then reported "none", so the UI asked the user to connect again.
//
// Real components: HTTP fetch handler, SessionStore, RuntimeHost,
// TinyCloudMemoryStorageService + EntityClientRegistry, TranscriptAccessRegistry,
// and the production transcript action. Only the TinyCloud node boundary is
// faked (memory AgentClient factory and transcript node factory).

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import { serializeDelegation } from "@tinycloud/agent-client";
import type { AgentClient, PortableDelegation, QueryData } from "@tinycloud/agent-client";
import { EntityClientRegistry, MEMORY_DB_HANDLE, TinyCloudMemoryStorageService } from "@tinycloud/eliza-plugin-memory";
import { setTranscriptRegistry, tinycloudSearchTranscriptsAction } from "./actions/tinycloud-search-transcripts.js";
import { TINYCHAT_AGENT_ID } from "./auth/app-registry.js";
import { RuntimeHost } from "./runtime-host.js";
import { createElizaServiceFetch, type ElizaServiceHost } from "./server.js";
import { SessionStore } from "./session-store.js";
import { TranscriptAccessRegistry, type TranscriptNode } from "./transcript-registry.js";

const SECRET = "private-access-lifetime-secret";
const AGENT_DID = "did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c";
const AGENT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OWNER = "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2";
const ENTITY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SQL_PATH = "xyz.tinycloud.tinychat/connectors";
const KV_PATH = `${SQL_PATH}/`;
const SPACE = `tinycloud:pkh:eip155:1:${OWNER}:default`;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GRANT_MS = 30 * DAY; // TinyChat's agent delegation lifetime

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const bearer = (att: Record<string, unknown>, expiryMs: number) =>
  `Bearer ${b64url({ alg: "EdDSA", typ: "JWT" })}.${b64url({ att, aud: AGENT_DID, exp: Math.floor((Date.now() + expiryMs) / 1_000) })}.sig`;
const actions = (names: string[]) => Object.fromEntries(names.map(name => [name, [{}]]));

function memoryGrant(expiryMs = GRANT_MS): string {
  return serializeDelegation({
    cid: "bafy-memory-lifetime", delegateDID: AGENT_DID, spaceId: SPACE, path: MEMORY_DB_HANDLE,
    actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
    expiry: new Date(Date.now() + expiryMs), ownerAddress: OWNER, chainId: 1, host: "https://node.tinycloud.xyz",
    delegationHeader: { Authorization: bearer({ [`${SPACE}/sql/${MEMORY_DB_HANDLE}`]: actions(["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"]) }, expiryMs) },
  } as unknown as PortableDelegation);
}

function transcriptGrant(expiryMs = GRANT_MS): string {
  return serializeDelegation({
    cid: "bafy-transcript-lifetime", delegateDID: AGENT_DID, spaceId: SPACE, path: SQL_PATH, actions: ["tinycloud.sql/read"],
    expiry: new Date(Date.now() + expiryMs), ownerAddress: OWNER, chainId: 1, host: "https://node.tinycloud.xyz",
    delegationHeader: { Authorization: bearer({
      [`${SPACE}/sql/${SQL_PATH}`]: actions(["tinycloud.sql/read"]),
      [`${SPACE}/kv/${KV_PATH}`]: actions(["tinycloud.kv/get", "tinycloud.kv/list"]),
    }, expiryMs) },
  } as unknown as PortableDelegation);
}

const MEETING_ROW = [
  "meeting-a", "fireflies", "canary-1", "Agent Retrieval Canary", "2029-12-30T10:00:00.000Z",
  "avery@example.test", JSON.stringify([{ name: "Avery", email: "avery@example.test" }]),
  "The team approved ember compass.", "Avery will send the decision memo.",
];
const BODY = [{ text: "We rejected cobalt; the final choice is ember compass.", speaker_name: "Avery", start_time: 72 }];

function makeService() {
  const node = { revoked: false, signIns: 0 };
  const transcriptRegistry = new TranscriptAccessRegistry({
    agentDid: AGENT_DID, agentKey: AGENT_KEY, host: "https://node.tinycloud.xyz",
    nodeFactory: (): TranscriptNode => ({
      async signIn() { node.signIns++; },
      async useDelegation() {
        return {
          sql: { db: () => ({ query: async () => ({ ok: true, data: { rows: [MEETING_ROW] } }) }) },
          kv: { get: async () => node.revoked
            ? { ok: false, error: { code: "DELEGATION_REVOKED", status: 403 } }
            : { ok: true, data: { data: JSON.stringify(BODY) } } },
        };
      },
    }),
  });
  const memoryClients: AgentClient[] = [];
  const registry = new EntityClientRegistry({
    runWrite: async fn => fn(),
    createClient: () => {
      const empty: QueryData = { columns: [], rows: [], rowCount: 0 };
      const client: AgentClient = {
        signIn: async () => ({ spaceId: SPACE, address: OWNER, did: AGENT_DID }),
        ensureSchema: async () => {}, stop: async () => {},
        sql: { query: async () => empty, execute: async () => ({ changes: 0, lastInsertRowId: undefined }), batch: async () => ({ results: [] }), withRowObjects: () => [] },
      };
      memoryClients.push(client);
      return client;
    },
  });
  const storage = new TinyCloudMemoryStorageService(undefined as never, { registry });
  const runtime = { agentId: TINYCHAT_AGENT_ID, actions: [tinycloudSearchTranscriptsAction], stop: async () => {} } as unknown as IAgentRuntime;
  setTranscriptRegistry(runtime as unknown as object, transcriptRegistry);
  const runtimeHost = new RuntimeHost({ _bootFactory: async agentId => ({ agentId, runtime, storageService: storage, transcriptRegistry }) });
  // RuntimeHost.agentDid comes from a key file in production; delegate everything else.
  const host: ElizaServiceHost = {
    agentDid: AGENT_DID,
    storageFor: id => runtimeHost.storageFor(id),
    runtimeFor: id => runtimeHost.runtimeFor(id),
    preflight: (id, entity) => runtimeHost.preflight(id, entity),
    registerTranscriptDelegation: (...args) => runtimeHost.registerTranscriptDelegation(...args),
    disconnectEntity: (id, entity) => runtimeHost.disconnectEntity(id, entity),
    privateAccessAvailable: (id, entity) => runtimeHost.privateAccessAvailable(id, entity),
  };
  const fetch = createElizaServiceFetch({ host, sessions: new SessionStore() });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(new Request(`http://localhost${path}`, {
      method, headers: { Authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const session = () => call("GET", `/sessions/${ENTITY}`);
  const connect = async (revision?: string) => call("POST", "/sessions", {
    agentId: TINYCHAT_AGENT_ID, entityId: ENTITY, revision: revision ?? (await session()).body.revision,
    session: { version: 2, delegations: { memory: memoryGrant(), transcripts: transcriptGrant() } },
  });
  const tool = (accessRevision?: string) => call("POST", "/tools/tinycloud_search_transcripts", {
    entityId: ENTITY, ...(accessRevision ? { accessRevision } : {}), args: { query: "ember compass" },
  });
  const message = () => call("POST", "/messages", { agentId: TINYCHAT_AGENT_ID, entityId: ENTITY, roomId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", text: "hi" });
  const available = () => runtimeHost.privateAccessAvailable(TINYCHAT_AGENT_ID, ENTITY);
  return { call, session, connect, tool, message, available, runtimeHost, node, memoryClients };
}

const advance = (ms: number) => setSystemTime(new Date(Date.now() + ms));
let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env.ELIZA_SERVICE_SECRET;
  process.env.ELIZA_SERVICE_SECRET = SECRET;
  setSystemTime(new Date("2030-01-01T00:00:00Z"));
});
afterEach(() => {
  setSystemTime();
  if (savedSecret === undefined) delete process.env.ELIZA_SERVICE_SECRET;
  else process.env.ELIZA_SERVICE_SECRET = savedSecret;
});

describe("TinyChat private access lasts for the life of the grant", () => {
  test("private tools, liveness, and preflight survive more than 4h (and days) of idle time", async () => {
    const s = makeService();
    const connected = await s.connect();
    expect(connected).toMatchObject({ status: 200, body: { status: "active", transcriptStatus: "active" } });
    const revision = connected.body.revision as string;

    for (const idle of [4 * HOUR + MINUTE, 3 * DAY, 20 * DAY]) {
      advance(idle); // no request of any kind in between
      expect(s.available()).toBe(true);
      expect(await s.session()).toMatchObject({ status: 200, body: { status: "active", transcriptStatus: "active", revision, state: "active" } });
      const result = await s.tool(revision);
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.body)).toContain("ember compass");
      await expect(s.runtimeHost.preflight(TINYCHAT_AGENT_ID, ENTITY)).resolves.toBeUndefined();
    }
    expect(s.memoryClients).toHaveLength(1); // same client, never silently rebuilt
  });

  test("Disconnect after a long idle period still removes access", async () => {
    const s = makeService();
    const revision = (await s.connect()).body.revision as string;
    advance(5 * HOUR);
    const stopped = await s.call("DELETE", `/sessions/${ENTITY}`);
    expect(stopped).toMatchObject({ status: 200, body: { status: "none", state: "disconnected" } });
    expect(s.available()).toBe(false);
    expect(await s.session()).toMatchObject({ status: 404, body: { status: "none", state: "disconnected" } });
    expect(await s.tool(revision)).toEqual({ status: 409, body: { error: "delegation_required" } });
    expect(await s.tool()).toEqual({ status: 409, body: { error: "delegation_required" } });
    expect(await s.message()).toEqual({ status: 409, body: { error: "delegation_required" } });
  });

  test("stale revisions are still fenced after a long idle period", async () => {
    const s = makeService();
    const first = (await s.connect()).body.revision as string;
    advance(5 * HOUR);
    const second = await s.connect();
    expect(second.status).toBe(200);
    expect(second.body.revision).not.toBe(first);
    // A caller still holding the replaced revision cannot use the new grant ...
    expect(await s.tool(first)).toEqual({ status: 409, body: { error: "delegation_required" } });
    // ... nor start a ceremony against it.
    expect(await s.connect(first)).toEqual({ status: 409, body: { error: "stale_revision" } });
    expect((await s.tool(second.body.revision as string)).status).toBe(200);
  });

  test("grant expiry still removes access and is reported as expired, not as never connected", async () => {
    const s = makeService();
    const revision = (await s.connect()).body.revision as string;
    advance(GRANT_MS + MINUTE);
    expect(s.available()).toBe(false);
    expect(await s.session()).toMatchObject({ status: 200, body: { status: "expired", transcriptStatus: "expired", revision } });
    expect(await s.tool(revision)).toEqual({ status: 409, body: { error: "delegation_expired" } });
    expect(await s.message()).toEqual({ status: 409, body: { error: "delegation_expired" } });
    // A stale caller revision is a fencing outcome and stays generic.
    expect(await s.tool("someone-else's-revision")).toEqual({ status: 409, body: { error: "delegation_required" } });
    // Reconnecting with a fresh grant restores access.
    const again = await s.connect();
    expect(again.status).toBe(200);
    expect((await s.tool(again.body.revision as string)).status).toBe(200);
  });

  test("a node revocation observed by a tool surfaces delegation_revoked and ends access", async () => {
    const s = makeService();
    const revision = (await s.connect()).body.revision as string;
    advance(5 * HOUR);
    s.node.revoked = true;
    expect(await s.tool(revision)).toEqual({ status: 409, body: { error: "delegation_revoked" } });
    expect(s.available()).toBe(false);
    expect(await s.tool(revision)).toEqual({ status: 409, body: { error: "delegation_required" } });
    expect(await s.session()).toMatchObject({ status: 404, body: { status: "none" } });
  });
});
