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
import { DelegationStore, MemoryDelegationKv, type DelegationKv } from "./delegation-store.js";
import { HeldSessions } from "./held-sessions.js";

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

/** The TinyCloud node boundary, shared across simulated restarts. */
interface FakeNode { revoked: boolean; activationRevoked: boolean; down: boolean; signIns: number }
const newNode = (): FakeNode => ({ revoked: false, activationRevoked: false, down: false, signIns: 0 });

function makeService(opts: { node?: FakeNode; kv?: DelegationKv; memoryGrantMs?: number; transcriptGrantMs?: number; eagerLimit?: number; statusWaitMs?: number; retryBaseMs?: number } = {}) {
  const node = opts.node ?? newNode();
  const transcriptRegistry = new TranscriptAccessRegistry({
    agentDid: AGENT_DID, agentKey: AGENT_KEY, host: "https://node.tinycloud.xyz",
    nodeFactory: (): TranscriptNode => ({
      async signIn() { if (node.down) throw new Error("fetch failed"); node.signIns++; },
      async useDelegation() {
        if (node.activationRevoked) throw Object.assign(new Error("delegation has been revoked"), { code: "DELEGATION_REVOKED", status: 401 });
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
        signIn: async () => {
          if (node.down) throw new Error("fetch failed");
          // The node's message for activating a child of a revoked grant (no code).
          if (node.activationRevoked) throw new Error("Failed to activate session: 401 - delegation-parent-revoked: bafy-memory-lifetime");
          return { spaceId: SPACE, address: OWNER, did: AGENT_DID };
        },
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
  const sessions = new SessionStore();
  const store = opts.kv ? new DelegationStore(opts.kv, { retryBaseMs: 5, retryMaxMs: 20 }) : undefined;
  const held = store ? new HeldSessions({
    store, sessions, host, scope: { appId: "tinychat", agentId: TINYCHAT_AGENT_ID },
    retryBaseMs: opts.retryBaseMs ?? 5, retryMaxMs: Math.max(20, opts.retryBaseMs ?? 0), log: () => {}, eagerLimit: opts.eagerLimit,
  }) : undefined;
  const fetch = createElizaServiceFetch({ host, sessions, held, restoreWaitMs: { status: opts.statusWaitMs ?? 50, access: 200 } });
  held?.start();
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
    session: { version: 2, delegations: { memory: memoryGrant(opts.memoryGrantMs), transcripts: transcriptGrant(opts.transcriptGrantMs) } },
  });
  const tool = (accessRevision?: string) => call("POST", "/tools/tinycloud_search_transcripts", {
    entityId: ENTITY, ...(accessRevision ? { accessRevision } : {}), args: { query: "ember compass" },
  });
  const message = () => call("POST", "/messages", { agentId: TINYCHAT_AGENT_ID, entityId: ENTITY, roomId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", text: "hi" });
  const available = () => runtimeHost.privateAccessAvailable(TINYCHAT_AGENT_ID, ENTITY);
  return { call, session, connect, tool, message, available, runtimeHost, node, memoryClients, held, store, sessions };
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

// ── Restart (TC-687): grants persist in the agent's own space ─────────────────

const STORED_KEY = `delegations/v1/tinychat/${TINYCHAT_AGENT_ID}/${ENTITY}`;

/** Agent-space KV with failure injection; survives simulated restarts. */
class FlakyKv extends MemoryDelegationKv {
  failList = false;
  failGet = false;
  failPut = false;
  failDelete = false;
  override async list(prefix: string) { if (this.failList) throw new Error("node down"); return super.list(prefix); }
  override async get(key: string) { if (this.failGet) throw new Error("node down"); return super.get(key); }
  override async put(key: string, value: string) { if (this.failPut) throw new Error("node down"); return super.put(key, value); }
  override async delete(key: string) { if (this.failDelete) throw new Error("node down"); return super.delete(key); }
}

/** A fresh process: new SessionStore, host and registries; same node and agent space. */
async function boot(kv: FlakyKv, node: FakeNode, idle = true) {
  const service = makeService({ kv, node });
  if (idle) await service.held!.whenIdle();
  return service;
}

async function eventually(check: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error("condition not reached");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe("TinyChat private access survives a restart", () => {
  test("a restart keeps the grant, its revision and tool access", async () => {
    const kv = new FlakyKv(); const node = newNode();
    const before = await boot(kv, node);
    const connected = await before.connect();
    expect(connected).toMatchObject({ status: 200, body: { status: "active", state: "active" } });
    const revision = connected.body.revision as string;
    expect(kv.data.has(STORED_KEY)).toBe(true);

    const after = await boot(kv, node);
    expect(after.available()).toBe(true);
    expect(await after.session()).toMatchObject({ status: 200, body: { status: "active", transcriptStatus: "active", revision, state: "active" } });
    const result = await after.tool(revision);
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).toContain("ember compass");
    expect(await after.call("GET", "/health")).toMatchObject({ status: 200, body: { ok: true, grants: { state: "ready", restoring: 0 } } });
    // A second restart is equally transparent.
    const again = await boot(kv, node);
    expect(await again.session()).toMatchObject({ status: 200, body: { status: "active", revision } });
  });

  test("the stored record is plain session state plus the grants, with no agent key material", async () => {
    const kv = new FlakyKv();
    const s = await boot(kv, newNode());
    const revision = (await s.connect()).body.revision as string;
    const raw = kv.data.get(STORED_KEY)!;
    expect(JSON.parse(raw)).toMatchObject({
      v: 1, kind: "tinychat-session", appId: "tinychat", agentId: TINYCHAT_AGENT_ID, entityId: ENTITY,
      revision, state: "active", delegations: { memory: expect.any(String), transcripts: expect.any(String) },
      expiries: { memory: expect.any(Number), transcripts: expect.any(Number) },
    });
    expect(raw).not.toContain(AGENT_KEY.slice(2));
  });

  test("Disconnect then restart reports none", async () => {
    const kv = new FlakyKv(); const node = newNode();
    const before = await boot(kv, node);
    const revision = (await before.connect()).body.revision as string;
    expect(await before.call("DELETE", `/sessions/${ENTITY}`)).toMatchObject({ status: 200, body: { status: "none", state: "disconnected" } });
    expect(kv.data.has(STORED_KEY)).toBe(false);

    const after = await boot(kv, node);
    expect(await after.session()).toMatchObject({ status: 404, body: { status: "none" } });
    expect(await after.tool(revision)).toEqual({ status: 409, body: { error: "delegation_required" } });
    expect(after.available()).toBe(false);
  });

  test("a failed delete still detaches access, blocks reload, and is retried until durable", async () => {
    const kv = new FlakyKv(); const node = newNode();
    const s = await boot(kv, node);
    const revision = (await s.connect()).body.revision as string;
    kv.failDelete = true;
    const stopped = await s.call("DELETE", `/sessions/${ENTITY}`);
    expect(stopped).toMatchObject({ status: 503, body: { error: "disconnect_unconfirmed" } });
    expect(s.available()).toBe(false);
    expect(await s.tool(revision)).toEqual({ status: 409, body: { error: "delegation_required" } });
    // The stored grant is still there, but this process never reloads it.
    expect(kv.data.has(STORED_KEY)).toBe(true);
    expect(await s.session()).toMatchObject({ status: 404, body: { status: "none", state: "disconnected" } });

    kv.failDelete = false; // the node recovers; the background retry lands the delete
    await eventually(() => !kv.data.has(STORED_KEY));
    const after = await boot(kv, node);
    expect(await after.session()).toMatchObject({ status: 404, body: { status: "none" } });
  });

  test("a failed write on connect returns 503 and is never reported connected", async () => {
    const kv = new FlakyKv(); const node = newNode();
    const s = await boot(kv, node);
    kv.failPut = true;
    expect(await s.connect()).toEqual({ status: 503, body: { error: "private_access_unavailable" } });
    expect(s.available()).toBe(false);
    expect(await s.session()).toMatchObject({ status: 404, body: { status: "none" } });
    kv.failPut = false;
    const after = await boot(kv, node);
    expect(await after.session()).toMatchObject({ status: 404, body: { status: "none" } });
  });

  test("an expired grant reports expired after a restart and is deleted 7 days after expiry", async () => {
    const kv = new FlakyKv(); const node = newNode();
    const revision = (await (await boot(kv, node)).connect()).body.revision as string;
    const signIns = node.signIns;
    advance(GRANT_MS + MINUTE);

    const after = await boot(kv, node);
    expect(after.available()).toBe(false);
    expect(await after.session()).toMatchObject({ status: 200, body: { status: "expired", transcriptStatus: "expired", revision, state: "active" } });
    expect(await after.tool(revision)).toEqual({ status: 409, body: { error: "delegation_expired" } });
    expect(node.signIns).toBe(signIns); // never activated

    advance(7 * DAY);
    const later = await boot(kv, node);
    expect(await later.session()).toMatchObject({ status: 404, body: { status: "none" } });
    await eventually(() => !kv.data.has(STORED_KEY));
  });

  test("a grant the node revoked reports revoked after a restart, until the user reconnects", async () => {
    const kv = new FlakyKv(); const node = newNode();
    const revision = (await (await boot(kv, node)).connect()).body.revision as string;
    node.activationRevoked = true;

    const after = await boot(kv, node);
    expect(after.available()).toBe(false);
    expect(await after.session()).toEqual({ status: 200, body: { entityId: ENTITY, status: "revoked", revision, state: "revoked" } });
    expect(await after.tool(revision)).toEqual({ status: 409, body: { error: "delegation_revoked" } });
    await eventually(() => JSON.parse(kv.data.get(STORED_KEY) ?? "{}").state === "revoked");
    expect(JSON.parse(kv.data.get(STORED_KEY)!)).toMatchObject({ revision, state: "revoked", delegations: {} });

    // The tombstone itself survives restarts.
    const again = await boot(kv, node);
    expect(await again.session()).toMatchObject({ status: 200, body: { status: "revoked", revision } });

    // Reconnecting with a fresh grant replaces the tombstone.
    node.activationRevoked = false;
    const reconnected = await again.connect();
    expect(reconnected).toMatchObject({ status: 200, body: { status: "active" } });
    expect((await again.tool(reconnected.body.revision as string)).status).toBe(200);
    expect(JSON.parse(kv.data.get(STORED_KEY)!)).toMatchObject({ state: "active", revision: reconnected.body.revision });
  });

  test("a node outage during restore reports restoring (503), never none", async () => {
    const kv = new FlakyKv(); const node = newNode();
    const revision = (await (await boot(kv, node)).connect()).body.revision as string;

    // 1. The agent space is unreachable: nothing is known yet.
    kv.failList = true;
    const listing = await boot(kv, node, false);
    expect(await listing.session()).toEqual({ status: 503, body: { error: "private_access_restoring" } });
    expect(await listing.tool(revision)).toEqual({ status: 503, body: { error: "private_access_restoring" } });
    expect((await listing.call("GET", "/health")).body).toMatchObject({ ok: true, grants: { state: "indexing" } });
    kv.failList = false;
    await listing.held!.whenIdle();
    expect(await listing.session()).toMatchObject({ status: 200, body: { status: "active", revision } });

    // 2. The record is listed but the node cannot activate it yet.
    node.down = true;
    const activating = await boot(kv, node);
    expect(await activating.session()).toMatchObject({ status: 503, body: { error: "private_access_restoring" } });
    expect((await activating.call("GET", "/health")).body).toMatchObject({ grants: { state: "restoring", restoring: 1 } });
    node.down = false;
    await eventually(async () => (await activating.session()).status === 200);
    expect(await activating.session()).toMatchObject({ status: 200, body: { status: "active", revision } });
    expect((await activating.tool(revision)).status).toBe(200);
  });

  test("a reload that keeps failing never locks the user out of reconnecting", async () => {
    const kv = new FlakyKv(); const node = newNode();
    const revision = (await (await boot(kv, node)).connect()).body.revision as string;
    node.down = true;
    // A long backoff keeps the failed reload pending while the user reconnects.
    const s = makeService({ kv, node, retryBaseMs: 60_000 });
    await s.held!.whenIdle();
    // The 503 carries the persisted revision so the client can reconnect with it.
    expect(await s.session()).toEqual({ status: 503, body: { error: "private_access_restoring", revision, state: "restoring" } });
    node.down = false;
    const reconnected = await s.connect(revision);
    expect(reconnected).toMatchObject({ status: 200, body: { status: "active" } });
    expect(reconnected.body.revision).not.toBe(revision);
    expect((await s.tool(reconnected.body.revision as string)).status).toBe(200);
    // The superseded reload is dropped, not merely outrun.
    expect(s.held!.health()).toEqual({ state: "ready", restoring: 0 });
    expect(await s.session()).toMatchObject({ status: 200, body: { revision: reconnected.body.revision, state: "active" } });
  });

  test("a stored grant is re-validated on reload; one that fails is not restored", async () => {
    const kv = new FlakyKv(); const node = newNode();
    await (await boot(kv, node)).connect();
    const signIns = node.signIns;
    const stored = JSON.parse(kv.data.get(STORED_KEY)!);
    // Someone with write access to the agent space swaps in a grant for another delegatee.
    const other = JSON.parse(stored.delegations.memory);
    other.delegateDID = "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    kv.data.set(STORED_KEY, JSON.stringify({ ...stored, delegations: { ...stored.delegations, memory: JSON.stringify(other) } }));

    const after = await boot(kv, node);
    expect(after.available()).toBe(false);
    expect(await after.session()).toMatchObject({ status: 404, body: { status: "none" } });
    expect(node.signIns).toBe(signIns);
  });

  test("a stored grant longer than the 30-day ceiling is not restored", async () => {
    const kv = new FlakyKv(); const node = newNode();
    const s = await boot(kv, node);
    await s.connect();
    const stored = JSON.parse(kv.data.get(STORED_KEY)!);
    kv.data.set(STORED_KEY, JSON.stringify({ ...stored, delegations: { ...stored.delegations, memory: memoryGrant(60 * DAY) } }));
    const after = await boot(kv, node);
    expect(await after.session()).toMatchObject({ status: 404, body: { status: "none" } });
  });

  test("a request for a waiting entity jumps the reload queue", async () => {
    const kv = new FlakyKv(); const node = newNode();
    const revision = (await (await boot(kv, node)).connect()).body.revision as string;
    // Eager reloading disabled: the record waits until a request asks for it.
    const lazy = makeService({ kv, node, eagerLimit: 0, statusWaitMs: 1_000 });
    await lazy.held!.whenIdle();
    expect(lazy.available()).toBe(false);
    expect((await lazy.call("GET", "/health")).body).toMatchObject({ grants: { state: "restoring", restoring: 1 } });
    expect(await lazy.session()).toMatchObject({ status: 200, body: { status: "active", revision } });
    expect(lazy.available()).toBe(true);
    expect((await lazy.call("GET", "/health")).body).toMatchObject({ grants: { state: "ready", restoring: 0 } });
  });

  test("connect, restart, revoke, outage and Disconnect log no delegation material", async () => {
    const lines: string[] = [];
    const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
    for (const name of Object.keys(saved) as Array<keyof typeof saved>) console[name] = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    const kv = new FlakyKv(); const node = newNode();
    try {
      const s = makeService({ kv, node });
      await s.held!.whenIdle();
      await s.connect();
      node.down = true;
      const down = await boot(kv, node);
      await down.session();
      node.down = false;
      node.activationRevoked = true;
      await boot(kv, node);
      node.activationRevoked = false;
      kv.failDelete = true;
      await s.call("DELETE", `/sessions/${ENTITY}`);
      kv.failDelete = false;
      await eventually(() => !kv.data.has(STORED_KEY));
    } finally {
      Object.assign(console, saved);
    }
    const text = lines.join("\n");
    const grant = JSON.parse(memoryGrant());
    const token = String(grant.delegationHeader.Authorization).split(" ")[1];
    for (const secret of [token.split(".")[1], "Bearer ", AGENT_KEY.slice(2), "bafy-memory-lifetime", "bafy-transcript-lifetime", OWNER, SPACE]) {
      expect(text).not.toContain(secret);
    }
  });
});
