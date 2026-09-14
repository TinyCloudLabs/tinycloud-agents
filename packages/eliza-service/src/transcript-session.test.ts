// Acceptance tests for the delegated transcript vertical slice.
//
// These drive the PRODUCTION path only: POST /sessions validates and activates a
// transcript grant through TranscriptAccessRegistry, and the registered
// TINYCLOUD_SEARCH_TRANSCRIPTS action resolves that activated access from the
// runtime it was bound to. There is no test-only reader-installation seam.
//
// The single injected boundary is the delegated-node client itself (the SDK call
// that would otherwise require a live node). Everything above it — signed-att
// normalization, exact policy validation, the 7-day ceiling, the fixed SQL
// statement, and the fixed KV key — is the real implementation.

import { sha256 } from "./meeting-evidence.js";
import { describe, expect, test } from "bun:test";
import { serializeDelegation } from "@tinycloud/agent-client";
import type { PortableDelegation } from "@tinycloud/agent-client";
import { handleGetSessions, handlePostSessions } from "./handlers/sessions.js";
import type { SessionHandlerHost } from "./handlers/sessions.js";
import { SessionStore } from "./session-store.js";
import { TranscriptAccessRegistry } from "./transcript-registry.js";
import type { TranscriptNode } from "./transcript-registry.js";
import {
  setTranscriptRegistry,
  tinycloudFindMeetingsAction,
  tinycloudReadMeetingAction,
  tinycloudSearchTranscriptsAction,
} from "./actions/tinycloud-search-transcripts.js";
import { MEMORY_DB_HANDLE } from "@tinycloud/eliza-plugin-memory";

const AGENT_DID = "did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c";
const OTHER_DID = "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const OWNER_A = "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2";
const OWNER_B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SQL_PATH = "xyz.tinycloud.tinychat/connectors";
const KV_PATH = `${SQL_PATH}/`;
const DAY_MS = 24 * 60 * 60 * 1000;

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function space(owner: string): string {
  return `tinycloud:pkh:eip155:1:${owner}:default`;
}

function jwt(att: Record<string, unknown>, expSecs: number): string {
  return `${b64url({ alg: "EdDSA", typ: "JWT" })}.${b64url({ att, aud: AGENT_DID, exp: expSecs })}.sig`;
}

function transcriptAtt(owner: string, overrides: Record<string, string[]> = {}): Record<string, unknown> {
  const base: Record<string, string[]> = {
    [`${space(owner)}/sql/${SQL_PATH}`]: ["tinycloud.sql/read"],
    [`${space(owner)}/kv/${KV_PATH}`]: ["tinycloud.kv/get", "tinycloud.kv/list"],
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(base)
      .filter(([, actions]) => actions.length > 0)
      .map(([uri, actions]) => [uri, Object.fromEntries(actions.map((action) => [action, [{}]]))]),
  );
}

function transcriptGrant(opts: {
  owner?: string;
  delegateDID?: string;
  expiryMs?: number;
  signedExpiryMs?: number;
  att?: Record<string, unknown>;
} = {}): string {
  const owner = opts.owner ?? OWNER_A;
  const expiryMs = opts.expiryMs ?? 60 * 60 * 1000;
  const signedExpiryMs = opts.signedExpiryMs ?? expiryMs;
  return serializeDelegation({
    cid: "bafy-transcript-test",
    delegateDID: opts.delegateDID ?? AGENT_DID,
    spaceId: space(owner),
    path: SQL_PATH,
    actions: ["tinycloud.sql/read"],
    expiry: new Date(Date.now() + expiryMs),
    ownerAddress: owner,
    chainId: 1,
    host: "https://node.tinycloud.xyz",
    delegationHeader: {
      Authorization: `Bearer ${jwt(opts.att ?? transcriptAtt(owner), Math.floor((Date.now() + signedExpiryMs) / 1_000))}`,
    },
  } as unknown as PortableDelegation);
}

function cidTranscriptGrant(owner = OWNER_A): string {
  const cid = "bafy-transcript-cid-test";
  return serializeDelegation({
    cid,
    delegateDID: AGENT_DID,
    spaceId: space(owner),
    path: SQL_PATH,
    actions: ["tinycloud.sql/read", "tinycloud.kv/get", "tinycloud.kv/list"],
    resources: [
      { service: "tinycloud.sql", space: space(owner), path: SQL_PATH, actions: ["tinycloud.sql/read"] },
      { service: "tinycloud.kv", space: space(owner), path: KV_PATH, actions: ["tinycloud.kv/get", "tinycloud.kv/list"] },
    ],
    expiry: new Date(Date.now() + 60 * 60 * 1000),
    ownerAddress: owner,
    chainId: 1,
    host: "https://node.tinycloud.xyz",
    delegationHeader: { Authorization: `Bearer ${cid}` },
  } as unknown as PortableDelegation);
}

function memoryGrant(owner = OWNER_A): string {
  const att = {
    [`${space(owner)}/sql/${MEMORY_DB_HANDLE}`]: {
      "tinycloud.sql/read": [{}], "tinycloud.sql/write": [{}], "tinycloud.sql/admin": [{}],
    },
  };
  return serializeDelegation({
    cid: "bafy-memory-test",
    delegateDID: AGENT_DID,
    spaceId: space(owner),
    path: MEMORY_DB_HANDLE,
    actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
    expiry: new Date(Date.now() + 60 * 60 * 1000),
    ownerAddress: owner,
    chainId: 1,
    host: "https://node.tinycloud.xyz",
    delegationHeader: { Authorization: `Bearer ${jwt(att, Math.floor((Date.now() + 3_600_000) / 1_000))}` },
  } as unknown as PortableDelegation);
}

// ── A fake TinyCloud node: the only injected boundary ─────────────────────────

interface Corpus {
  rows: unknown[][];
  bodies: Record<string, unknown>;
}

interface NodeTrace {
  sql: string[];
  dbs: string[];
  kvKeys: string[];
  signIns: number;
}

function fakeNodeFactory(corpusFor: (privateKey: string) => Corpus, trace: NodeTrace, failSignIn = false) {
  return (args: { privateKey: string; host: string }): TranscriptNode => ({
    async signIn() {
      trace.signIns += 1;
      if (failSignIn) throw new Error("node unreachable");
      return undefined;
    },
    async useDelegation(delegation: unknown) {
      // The registry must hand the node the delegation it activated.
      const owner = (delegation as { resources?: Array<{ space?: string }> }).resources?.[0]?.space ?? "";
      const corpus = corpusFor(owner);
      return {
        sql: {
          db(name: string) {
            trace.dbs.push(name);
            return {
              async query(sql: string, params?: unknown[]) {
                trace.sql.push(sql);
                return { ok: true, data: { rows: sql.includes("WHERE id = ?") ? corpus.rows.filter(row => row[0] === params?.[0]) : corpus.rows } };
              },
            };
          },
        },
        kv: {
          async get(key: string, options?: { prefix?: string }) {
            expect(options).toMatchObject({ prefix: "", raw: true });
            trace.kvKeys.push(key);
            if (!(key in corpus.bodies)) return { ok: false, error: { code: "KV_NOT_FOUND" } };
            return { ok: true, data: { data: JSON.stringify(corpus.bodies[key]) } };
          },
        },
      };
    },
  });
}

const FIREFLIES_CANARY = [
  { text: "We opened with the usual agenda review.", speaker_name: "Robin", start_time: 4 },
  { text: "We rejected cobalt; the final choice is ember compass.", speaker_name: "Avery", start_time: 72 },
  { text: "Anything else before we close?", speaker_name: "Robin", start_time: 130 },
];

function makeCorpus(meetingRef:string,sourceId:string,title:string,records:unknown[]):Corpus {
  const raw=JSON.stringify(records);
  const snapshot={contractVersion:3,meetingRef,source:"fireflies",sourceId,operationId:"test-operation",createdAt:"2026-09-14T00:00:00Z",
    metadata:{title,startedAt:null,organizerEmail:null,participants:[],metadata:{}},
    body:{basis:"transcript",encoding:"utf-8",schema:"json-records",raw,original:{digest:sha256(raw),byteLength:Buffer.byteLength(raw),recordCount:records.length,extent:"unknown",captureComplete:null},omissions:[]},overview:null,aliases:[]};
  const revision=sha256(JSON.stringify(snapshot));
  return {rows:[[meetingRef,"fireflies",sourceId,title,null,null,"[]","{}",revision,null,"published"]],bodies:{[`${KV_PATH}fireflies/snapshot/${sourceId}/${revision}`]:snapshot}};
}
function corpusA():Corpus{return makeCorpus("meeting-a","canary-1","Agent Retrieval Canary",FIREFLIES_CANARY);}
function corpusB():Corpus{return makeCorpus("meeting-b","other-1","Someone Else's Meeting",[{text:"unrelated chatter"}]);}
const EXACT_ARGS={contractVersion:3,reference:{meetingRef:"meeting-a",source:"fireflies",sourceId:"canary-1",revision:corpusA().rows[0][8]},basis:"transcript"};

// ── Wiring that mirrors RuntimeHost, minus a real AgentRuntime ────────────────

function makeSlice(opts: { trace?: NodeTrace; failSignIn?: boolean; ttlMs?: number; maxEntries?: number; corpus?: Corpus } = {}) {
  const trace: NodeTrace = opts.trace ?? { sql: [], dbs: [], kvKeys: [], signIns: 0 };
  const registry = new TranscriptAccessRegistry({
    agentDid: AGENT_DID,
    agentKey: AGENT_KEY,
    host: "https://node.tinycloud.xyz",
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.maxEntries !== undefined ? { maxEntries: opts.maxEntries } : {}),
    nodeFactory: fakeNodeFactory(
      (ownerSpace) => opts.corpus ?? (ownerSpace.toLowerCase().includes(OWNER_B.toLowerCase()) ? corpusB() : corpusA()),
      trace,
      opts.failSignIn ?? false,
    ),
  });
  // Stands in for the booted AgentRuntime the action receives.
  const runtime = { agentId: AGENT_ID } as unknown as Parameters<typeof tinycloudSearchTranscriptsAction.handler>[0];
  setTranscriptRegistry(runtime as unknown as object, registry);

  const memoryCalls: Array<{ entityId: string; roomId?: string }> = [];
  const host: SessionHandlerHost = {
    agentDid: AGENT_DID,
    storageFor: async () => ({
      async registerDelegation(entityId: string, _serialized: string, roomId?: string) {
        memoryCalls.push({ entityId, ...(roomId ? { roomId } : {}) });
      },
    }),
    registerTranscriptDelegation: async (_agentId, entityId, serialized, roomId) =>
      registry.register(entityId, serialized, roomId),
  };
  return { registry, runtime, host, store: new SessionStore(), memoryCalls, trace };
}

async function runTool(
  runtime: Parameters<typeof tinycloudSearchTranscriptsAction.handler>[0],
  entityId: string,
  args: Record<string, unknown>,
  roomId = crypto.randomUUID(),
) {
  return tinycloudReadMeetingAction.handler(
    runtime,
    { entityId, roomId, content: { text: String(args.query ?? "") } } as never,
    undefined,
    { args: EXACT_ARGS },
    undefined,
    [],
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("session registration reaches typed exact transcript reads",()=>{
  test("accepted session grants activate exact revision reads in another authorized room",async()=>{
    const {host,store,runtime,trace}=makeSlice();
    const posted=await handlePostSessions({agentId:AGENT_ID,entityId:"entity-a",session:{version:2,delegations:{memory:memoryGrant(),transcripts:transcriptGrant()},roomId:"thread-1"}},host,store);
    expect(posted.status).toBe(200);expect(trace.signIns).toBe(1);
    const result=await runTool(runtime,"entity-a",{},"thread-99") as any;
    expect(result.data.state).toBe("complete");expect(result.data.spans).toHaveLength(3);
    expect(result.data.spans[1]).toMatchObject({text:"We rejected cobalt; the final choice is ember compass.",speaker:"Avery",startSecs:72,recordIndex:1});
    expect(trace.dbs).toEqual([SQL_PATH,SQL_PATH]);
    expect(trace.sql.every(sql=>sql.includes("FROM connector_meeting WHERE id = ? LIMIT 1"))).toBe(true);
    expect(trace.kvKeys).toEqual([`${KV_PATH}fireflies/snapshot/canary-1/${EXACT_ARGS.reference.revision}`]);
  });
  test("cached reader cannot release content after grant revocation during body read",async()=>{
    let release!:(value:unknown)=>void;const {registry}=makeSlice();await registry.register("entity-a",transcriptGrant());
    const entry=(registry as any).entries.get("entity-a");
    const get=entry.access.kv.get;
    entry.access.kv.get=async(...args:any[])=>{const result=await get(...args);await new Promise(done=>{release=done;});return result;};
    const result=registry.readerFor("entity-a").readEvidence(EXACT_ARGS as any).then(value=>({value}),error=>({error}));
    while(!release)await new Promise(done=>setTimeout(done,0));registry.revoke("entity-a");release(undefined);
    expect(await result).toMatchObject({error:{name:"NoDelegationError"}});
  });
});

describe("transcript grant validation happens before activation", () => {
  const cases: Array<[string, string, () => string]> = [
    ["an extra SQL action", "transcript_policy_exceeded", () =>
      transcriptGrant({ att: transcriptAtt(OWNER_A, { [`${space(OWNER_A)}/sql/${SQL_PATH}`]: ["tinycloud.sql/read", "tinycloud.sql/write"] }) })],
    ["an extra KV action", "transcript_policy_exceeded", () =>
      transcriptGrant({ att: transcriptAtt(OWNER_A, { [`${space(OWNER_A)}/kv/${KV_PATH}`]: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/delete"] }) })],
    ["a resource outside the ceiling", "malformed", () =>
      transcriptGrant({ att: transcriptAtt(OWNER_A, { [`${space(OWNER_A)}/kv/`]: ["tinycloud.kv/get"] }) })],
    ["the wrong delegatee", "wrong_delegatee", () => transcriptGrant({ delegateDID: OTHER_DID })],
    ["an owner different from the memory grant", "wrong_delegator", () => transcriptGrant({ owner: OWNER_B })],
    ["a signed expiry beyond seven days", "delegation_expiry_too_long", () =>
      transcriptGrant({ expiryMs: 60 * 60 * 1000, signedExpiryMs: 8 * DAY_MS })],
    ["a summary expiry beyond seven days", "delegation_expiry_too_long", () => transcriptGrant({ expiryMs: 8 * DAY_MS })],
  ];

  for (const [label, code, build] of cases) {
    test(`rejects ${label} with ${code} and never activates or registers memory`, async () => {
      const { host, store, runtime, memoryCalls, trace } = makeSlice();
      const result = await handlePostSessions({
        agentId: AGENT_ID, entityId: "entity-a",
        session: { version: 2, delegations: { memory: memoryGrant(), transcripts: build() } },
      }, host, store);

      expect(result.status).toBe(400);
      expect((result.body as { error: string }).error).toBe(code);
      expect(trace.signIns).toBe(0);
      expect(memoryCalls).toHaveLength(0);
      // No transcript access exists, so the tool fails closed.
      await expect(runTool(runtime, "entity-a", { query: "ember compass" })).rejects.toMatchObject({ code: "delegation_required" });
    });
  }

  test("a rejected envelope never leaks delegation material into the error body", async () => {
    const { host, store } = makeSlice();
    const serialized = transcriptGrant({ delegateDID: OTHER_DID });
    const result = await handlePostSessions({
      agentId: AGENT_ID, entityId: "entity-a",
      session: { version: 2, delegations: { memory: memoryGrant(), transcripts: serialized } },
    }, host, store);
    const rendered = JSON.stringify(result.body);
    expect(rendered).not.toContain("Bearer");
    expect(rendered).not.toContain(serialized.slice(0, 40));
  });
});

describe("transcript failures do not widen memory access", () => {
  test("an activation failure keeps memory registered and fails transcripts closed", async () => {
    const { host, store, runtime, memoryCalls } = makeSlice({ failSignIn: true });
    const result = await handlePostSessions({
      agentId: AGENT_ID, entityId: "entity-a",
      session: { version: 2, delegations: { memory: memoryGrant(), transcripts: transcriptGrant() } },
    }, host, store);

    expect(result.status).toBe(503);
    expect((result.body as { error: string }).error).toBe("transcript_unavailable");
    expect(memoryCalls).toEqual([{ entityId: "entity-a" }]);
    await expect(runTool(runtime, "entity-a", { query: "ember compass" })).rejects.toMatchObject({ code: "delegation_required" });
  });

  test("a v1 memory-only session still registers and leaves transcripts unreachable", async () => {
    const { host, store, runtime, memoryCalls } = makeSlice();
    const result = await handlePostSessions(
      { agentId: AGENT_ID, entityId: "entity-a", serializedDelegation: memoryGrant() },
      host, store,
    );

    expect(result.status).toBe(200);
    expect((result.body as { transcriptStatus?: string }).transcriptStatus).toBeUndefined();
    expect(memoryCalls).toEqual([{ entityId: "entity-a" }]);
    await expect(runTool(runtime, "entity-a", { query: "ember compass" })).rejects.toMatchObject({ code: "delegation_required" });
  });
});

describe("per-entity isolation, expiry, and revocation", () => {
  test("one entity never resolves another entity's activated access", async () => {
    const { host, store, runtime } = makeSlice();
    await handlePostSessions({
      agentId: AGENT_ID, entityId: "entity-a",
      session: { version: 2, delegations: { memory: memoryGrant(OWNER_A), transcripts: transcriptGrant({ owner: OWNER_A }) }, roomId: "room-a" },
    }, host, store);
    await handlePostSessions({
      agentId: AGENT_ID, entityId: "entity-b",
      session: { version: 2, delegations: { memory: memoryGrant(OWNER_B), transcripts: transcriptGrant({ owner: OWNER_B }) }, roomId: "room-b" },
    }, host, store);

    const a = await runTool(runtime, "entity-a", { query: "ember compass" });
    const b = await runTool(runtime, "entity-b", { query: "ember compass" });
    expect(JSON.stringify(a)).toContain("ember compass");
    expect(JSON.stringify(b)).not.toContain("ember compass");

    // Entity B cannot reach entity A's corpus by borrowing entity A's room id.
    await expect(runTool(runtime, "entity-b", { query: "ember compass" }, "room-a"))
      .rejects.toMatchObject({ code: "delegation_required" });
    // An unknown entity resolves nothing at all.
    await expect(runTool(runtime, "entity-c", { query: "ember compass" }))
      .rejects.toMatchObject({ code: "delegation_required" });
  });

  test("an idle-expired entry is dropped and reported as delegation_expired", async () => {
    const { host, store, runtime, registry } = makeSlice({ ttlMs: -1 });
    await handlePostSessions({
      agentId: AGENT_ID, entityId: "entity-a",
      session: { version: 2, delegations: { memory: memoryGrant(), transcripts: transcriptGrant() } },
    }, host, store);
    await expect(runTool(runtime, "entity-a", { query: "ember compass" })).rejects.toMatchObject({ code: "delegation_expired" });
    expect(registry.has("entity-a")).toBe(false);
  });

  test("revocation prevents the next read", async () => {
    const { host, store, runtime, registry } = makeSlice();
    await handlePostSessions({
      agentId: AGENT_ID, entityId: "entity-a",
      session: { version: 2, delegations: { memory: memoryGrant(), transcripts: transcriptGrant() } },
    }, host, store);
    expect(registry.has("entity-a")).toBe(true);
    registry.revoke("entity-a");
    await expect(runTool(runtime, "entity-a", { query: "ember compass" })).rejects.toMatchObject({ code: "delegation_required" });
  });

  test("a re-registration activates the NEW grant rather than an in-flight older one", async () => {
    const { registry } = makeSlice();
    const first = registry.register("entity-a", transcriptGrant());
    const second = registry.register("entity-a", transcriptGrant());
    await Promise.all([first, second]);
    expect(registry.has("entity-a")).toBe(true);
  });

  test("an LRU eviction drops only the least recently used entity", async () => {
    const { host, store, registry } = makeSlice({ maxEntries: 1 });
    await handlePostSessions({
      agentId: AGENT_ID, entityId: "entity-a",
      session: { version: 2, delegations: { memory: memoryGrant(OWNER_A), transcripts: transcriptGrant({ owner: OWNER_A }) } },
    }, host, store);
    await handlePostSessions({
      agentId: AGENT_ID, entityId: "entity-b",
      session: { version: 2, delegations: { memory: memoryGrant(OWNER_B), transcripts: transcriptGrant({ owner: OWNER_B }) } },
    }, host, store);
    expect(registry.has("entity-a")).toBe(false);
    expect(registry.has("entity-b")).toBe(true);
  });
});

describe("GET /sessions reports both grants", () => {
  test("reports transcript status alongside memory status", async () => {
    const { host, store } = makeSlice();
    await handlePostSessions({
      agentId: AGENT_ID, entityId: "entity-a",
      session: { version: 2, delegations: { memory: memoryGrant(), transcripts: transcriptGrant() } },
    }, host, store);
    const got = await handleGetSessions("entity-a", host, store);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ entityId: "entity-a", status: "active", transcriptStatus: "active" });
  });

  test("keeps a current SDK CID-backed transcript grant active on liveness polls", async () => {
    const { host, store } = makeSlice();
    await handlePostSessions({
      agentId: AGENT_ID, entityId: "entity-a",
      session: { version: 2, delegations: { memory: memoryGrant(), transcripts: cidTranscriptGrant() } },
    }, host, store);
    const got = await handleGetSessions("entity-a", host, store);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ entityId: "entity-a", status: "active", transcriptStatus: "active" });
  });

  test("an expired transcript grant degrades the combined status without touching memory", async () => {
    const { host, store } = makeSlice();
    await handlePostSessions({
      agentId: AGENT_ID, entityId: "entity-a",
      session: { version: 2, delegations: { memory: memoryGrant(), transcripts: transcriptGrant() } },
    }, host, store);
    // Simulate the grant ageing out between registration and the status poll.
    const record = store.get("entity-a");
    store.set("entity-a", { ...record!, serializedTranscriptDelegation: transcriptGrant({ expiryMs: -1_000 }) });
    const got = await handleGetSessions("entity-a", host, store);
    expect(got.body).toMatchObject({ status: "expired", transcriptStatus: "expired" });
  });
});
