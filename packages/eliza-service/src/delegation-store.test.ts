import { describe, expect, test } from "bun:test";
import {
  DelegationStore,
  DelegationStoreError,
  MemoryDelegationKv,
  TinyCloudDelegationKv,
  delegationKey,
  delegationStoreEnabled,
  parseHeldSession,
  type DelegationStoreNode,
  type HeldSession,
} from "./delegation-store.js";

const scope = { appId: "tinychat", agentId: "92361e74-91ed-43a2-9656-5cc37ff3a07a" };
const ENTITY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function held(revision: string, overrides: Partial<HeldSession> = {}): HeldSession {
  return {
    v: 1, kind: "tinychat-session", ...scope, entityId: ENTITY, revision, state: "active",
    delegations: { memory: "synthetic-memory", transcripts: "synthetic-transcripts" },
    expiries: { memory: 1, transcripts: 2 }, storedAt: 0, ...overrides,
  };
}

/** KV whose operations wait until released, to force overlapping writes. */
class GatedKv extends MemoryDelegationKv {
  readonly gates: Array<() => void> = [];
  failDeletes = 0;
  override async put(key: string, value: string) { await new Promise<void>(resolve => this.gates.push(resolve)); return super.put(key, value); }
  override async delete(key: string) {
    if (this.failDeletes > 0) { this.failDeletes--; throw new Error("node down"); }
    return super.delete(key);
  }
}

describe("delegation store layout", () => {
  test("records live under readable per-app, per-agent, per-entity keys", () => {
    expect(delegationKey(scope, ENTITY)).toBe(`delegations/v1/tinychat/${scope.agentId}/${ENTITY}`);
    for (const bad of ["", "a/b", "..", "a\\b", "x".repeat(129)]) {
      expect(() => delegationKey(scope, bad)).toThrow(DelegationStoreError);
    }
  });

  test("a record only parses for the scope and entity its key names", () => {
    const raw = JSON.stringify(held("r1"));
    expect(parseHeldSession(scope, ENTITY, raw)).toMatchObject({ ok: true });
    expect(parseHeldSession({ ...scope, appId: "other" }, ENTITY, raw)).toEqual({ ok: false, reason: "invalid" });
    expect(parseHeldSession(scope, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", raw)).toEqual({ ok: false, reason: "invalid" });
    expect(parseHeldSession(scope, ENTITY, "{not json")).toEqual({ ok: false, reason: "invalid" });
    expect(parseHeldSession(scope, ENTITY, JSON.stringify(held("r1", { delegations: {} })))).toEqual({ ok: false, reason: "invalid" });
    // A tombstone carries no delegations.
    expect(parseHeldSession(scope, ENTITY, JSON.stringify(held("r1", { state: "revoked", delegations: {}, revokedAt: 5 })))).toMatchObject({ ok: true });
  });

  test("list returns entity ids for one scope only", async () => {
    const kv = new MemoryDelegationKv();
    const store = new DelegationStore(kv);
    await store.sync(scope, ENTITY, () => ({ kind: "put", session: held("r1") }));
    await kv.put(`delegations/v1/other/${scope.agentId}/${ENTITY}`, "{}");
    expect(await store.list(scope)).toEqual([ENTITY]);
    expect(await store.read(scope, ENTITY)).toMatchObject({ ok: true, session: { revision: "r1" } });
    expect(await store.read(scope, "cccccccc-cccc-4ccc-8ccc-cccccccccccc")).toBeNull();
  });
});

describe("ordered writes", () => {
  test("a slow write cannot land after a later Disconnect", async () => {
    const kv = new GatedKv();
    const store = new DelegationStore(kv);
    let state: "active" | "disconnected" = "active";
    const desired = () => state === "active" ? { kind: "put" as const, session: held("r1") } : { kind: "delete" as const };
    const connect = store.sync(scope, ENTITY, desired);
    await Promise.resolve();
    state = "disconnected";
    const disconnect = store.sync(scope, ENTITY, desired);
    kv.gates.shift()!(); // the slow put finally lands
    expect(await connect).toBe(true);
    expect(await disconnect).toBe(true);
    expect(kv.data.size).toBe(0);
  });

  test("a queued write publishes the state current when it runs", async () => {
    const kv = new GatedKv();
    const store = new DelegationStore(kv);
    let revision = "r1";
    const desired = () => ({ kind: "put" as const, session: held(revision) });
    const first = store.sync(scope, ENTITY, desired);
    await Promise.resolve();
    revision = "r2";
    const second = store.sync(scope, ENTITY, desired);
    revision = "r3";
    const third = store.sync(scope, ENTITY, desired); // coalesces with the queued second write
    kv.gates.shift()!();
    await first;
    await new Promise(resolve => setTimeout(resolve, 0));
    kv.gates.shift()!();
    expect(await second).toBe(true);
    expect(await third).toBe(true);
    expect(JSON.parse(kv.data.get(delegationKey(scope, ENTITY))!).revision).toBe("r3");
    expect(kv.gates).toHaveLength(0);
  });

  test("a failed delete is reported and retried until it lands", async () => {
    const kv = new GatedKv();
    const store = new DelegationStore(kv, { retryBaseMs: 1, retryMaxMs: 4 });
    await kv.data.set(delegationKey(scope, ENTITY), JSON.stringify(held("r1")));
    kv.failDeletes = 3;
    expect(await store.sync(scope, ENTITY, () => ({ kind: "delete" }))).toBe(false);
    expect(store.pendingRetries).toBe(1);
    const deadline = Date.now() + 1_000;
    while (kv.data.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
    expect(kv.data.size).toBe(0);
    expect(store.pendingRetries).toBe(0);
  });

  test("a failed put is reported and not retried", async () => {
    const kv = new MemoryDelegationKv();
    kv.put = async () => { throw new Error("node down"); };
    const store = new DelegationStore(kv, { retryBaseMs: 1 });
    expect(await store.sync(scope, ENTITY, () => ({ kind: "put", session: held("r1") }))).toBe(false);
    expect(store.pendingRetries).toBe(0);
  });
});

describe("TinyCloud agent-space KV", () => {
  function fakeNode() {
    const data = new Map<string, string>();
    const calls = { signIn: 0, failAuthOnce: false, down: false };
    const node: DelegationStoreNode = {
      async signIn() { calls.signIn++; if (calls.down) throw new Error("fetch failed"); },
      kv: {
        async get(key) {
          if (calls.failAuthOnce) { calls.failAuthOnce = false; return { ok: false, error: { code: "AUTH_EXPIRED", status: 401 } }; }
          const value = data.get(key);
          return value === undefined ? { ok: false, error: { code: "KV_NOT_FOUND", message: `Key not found: ${key}`, service: "kv" } } : { ok: true, data: { data: value } };
        },
        async put(key, value) { data.set(key, String(value)); return { ok: true, data: undefined }; },
        async delete(key) { data.delete(key); return { ok: true, data: undefined }; },
        async list(options) {
          const keys = [...data.keys()].filter(key => key.startsWith(options?.path ?? "")).sort();
          const start = options?.cursor ? Number(options.cursor) : 0;
          const page = keys.slice(start, start + 1);
          const truncated = start + 1 < keys.length;
          return { ok: true, data: { keys: page, truncated, ...(truncated ? { nextCursor: String(start + 1) } : {}) } };
        },
      },
    };
    return { node, data, calls };
  }

  test("signs in once, maps a missing key to null, and pages through list", async () => {
    const { node, calls } = fakeNode();
    const kv = new TinyCloudDelegationKv({ privateKey: "unused", host: "http://127.0.0.1", node });
    expect(await kv.get("delegations/v1/a/b/c")).toBeNull();
    await kv.put("delegations/v1/a/b/c", "1");
    await kv.put("delegations/v1/a/b/d", "2");
    await kv.put("delegations/v1/x/b/e", "3");
    expect(await kv.list("delegations/v1/a/b/")).toEqual(["delegations/v1/a/b/c", "delegations/v1/a/b/d"]);
    expect(await kv.get("delegations/v1/a/b/c")).toBe("1");
    expect(calls.signIn).toBe(1);
  });

  test("re-signs in once on an auth failure", async () => {
    const { node, calls } = fakeNode();
    const kv = new TinyCloudDelegationKv({ privateKey: "unused", host: "http://127.0.0.1", node });
    await kv.put("k", "v");
    calls.failAuthOnce = true;
    expect(await kv.get("k")).toBe("v");
    expect(calls.signIn).toBe(2);
  });

  test("an unreachable node is a typed, content-free error", async () => {
    const { node, calls } = fakeNode();
    calls.down = true;
    const kv = new TinyCloudDelegationKv({ privateKey: "unused", host: "http://127.0.0.1", node });
    const error = await kv.get("k").catch(e => e);
    expect(error).toBeInstanceOf(DelegationStoreError);
    expect(error.message).toBe("delegation store: store_unavailable");
    calls.down = false;
    expect(await kv.get("k")).toBeNull(); // a later call signs in again
  });

  test("a failed Result is an error, not a silent success", async () => {
    const { node } = fakeNode();
    node.kv.put = async () => ({ ok: false, error: { code: "STORAGE_FULL", status: 507 } });
    const kv = new TinyCloudDelegationKv({ privateKey: "unused", host: "http://127.0.0.1", node });
    await expect(kv.put("k", "v")).rejects.toBeInstanceOf(DelegationStoreError);
  });
});

describe("configuration", () => {
  test("persistence is on by default; off only in development or test", () => {
    expect(delegationStoreEnabled({})).toBe(true);
    expect(delegationStoreEnabled({ ELIZA_DELEGATION_STORE: "on" })).toBe(true);
    expect(delegationStoreEnabled({ ELIZA_DELEGATION_STORE: "off", NODE_ENV: "development" })).toBe(false);
    expect(() => delegationStoreEnabled({ ELIZA_DELEGATION_STORE: "off" })).toThrow();
    expect(() => delegationStoreEnabled({ ELIZA_DELEGATION_STORE: "off", NODE_ENV: "production" })).toThrow();
    expect(() => delegationStoreEnabled({ ELIZA_DELEGATION_STORE: "maybe" })).toThrow();
  });
});
