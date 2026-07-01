// POST /sessions + GET /sessions/:entityId handler tests (T3/T4 TDD).
//
// All tests use fake storage + fake host — no live TinyCloud node, no real AgentRuntime.
// Delegation fixtures are raw JSON objects that pass the full validation chain
// (deserializeSafe → validateShape → validatePolicy → evaluateStatus).
//
// Test invariants:
// - Valid delegation calls registerDelegation exactly once with (entityId, serialized, roomId).
// - Wrong-delegatee / malformed delegations return 400 and do NOT call registerDelegation.
// - GET returns the right status for a known entity and 404/"none" for an unknown one.
// - No live node is required (TINYCLOUD_LIVE must be unset).

import { describe, expect, it } from "bun:test";
import { SessionStore } from "../session-store.js";
import { handleGetSessions, handlePostSessions } from "./sessions.js";
import type { SessionHandlerHost } from "./sessions.js";
import { MEMORY_DB_HANDLE } from "@tinycloud/eliza-plugin-memory";

// Known-good agent DID matching the agent-client test fixtures
// (did:pkh:eip155:1: + checksummed EVM address from .tinycloud/agent.key)
const TEST_AGENT_DID = "did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c";
const WRONG_AGENT_DID = "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const TEST_AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEST_ENTITY_ID = "entity-test-001";

/**
 * Build a serialized PortableDelegation in the flat format (path + actions at top level).
 * deserializeDelegation() (node-sdk) does JSON.parse + expiry coercion — no JWT needed for
 * pure shape/policy validation (JWT is only required for activate/useDelegation in transport).
 */
function makeValidSerialized(opts: {
  delegateDID?: string;
  expiry?: string;
  path?: string;
  actions?: string[];
} = {}): string {
  return JSON.stringify({
    cid: "bafy-sessions-test",
    delegateDID: opts.delegateDID ?? TEST_AGENT_DID,
    spaceId: "tinycloud:pkh:eip155:1:0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2:default",
    path: opts.path ?? MEMORY_DB_HANDLE,
    actions: opts.actions ?? ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
    expiry: opts.expiry ?? new Date("2099-01-01T00:00:00.000Z").toISOString(),
    ownerAddress: "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2",
    chainId: 1,
    host: "https://node.tinycloud.xyz",
  });
}

// ── Fake storage service ──────────────────────────────────────────────────────

class FakeStorage {
  calls: Array<{ entityId: string; serialized: string; roomId: string | undefined }> = [];

  async registerDelegation(entityId: string, serialized: string, roomId?: string): Promise<void> {
    this.calls.push({ entityId, serialized, roomId });
  }
}

function makeHost(agentDid = TEST_AGENT_DID, storage?: FakeStorage): {
  host: SessionHandlerHost;
  storage: FakeStorage;
} {
  const s = storage ?? new FakeStorage();
  const host: SessionHandlerHost = {
    agentDidFor: async () => agentDid,
    storageFor: async () => s,
  };
  return { host, storage: s };
}

// ── POST /sessions ─────────────────────────────────────────────────────────────

describe("handlePostSessions — valid delegation", () => {
  it("calls registerDelegation exactly once with (entityId, serialized, undefined) and returns 200", async () => {
    const { host, storage } = makeHost();
    const store = new SessionStore();
    const serialized = makeValidSerialized();

    const result = await handlePostSessions(
      { agentId: TEST_AGENT_ID, entityId: TEST_ENTITY_ID, serializedDelegation: serialized },
      host,
      store,
    );

    expect(result.status).toBe(200);
    expect((result.body as { entityId: string }).entityId).toBe(TEST_ENTITY_ID);
    expect((result.body as { status: string }).status).toBe("active");
    expect(storage.calls).toHaveLength(1);
    expect(storage.calls[0]).toEqual({ entityId: TEST_ENTITY_ID, serialized, roomId: undefined });
  });

  it("passes roomId to registerDelegation when provided", async () => {
    const { host, storage } = makeHost();
    const store = new SessionStore();
    const serialized = makeValidSerialized();

    const result = await handlePostSessions(
      {
        agentId: TEST_AGENT_ID,
        entityId: TEST_ENTITY_ID,
        serializedDelegation: serialized,
        roomId: "room-abc",
      },
      host,
      store,
    );

    expect(result.status).toBe(200);
    expect(storage.calls).toHaveLength(1);
    expect(storage.calls[0]).toEqual({ entityId: TEST_ENTITY_ID, serialized, roomId: "room-abc" });
  });

  it("records the session in the C-local store after registerDelegation succeeds", async () => {
    const { host } = makeHost();
    const store = new SessionStore();
    const serialized = makeValidSerialized();

    expect(store.get(TEST_ENTITY_ID)).toBeUndefined();

    await handlePostSessions(
      { agentId: TEST_AGENT_ID, entityId: TEST_ENTITY_ID, serializedDelegation: serialized },
      host,
      store,
    );

    const rec = store.get(TEST_ENTITY_ID);
    expect(rec).toBeDefined();
    expect(rec!.agentId).toBe(TEST_AGENT_ID);
    expect(rec!.serializedDelegation).toBe(serialized);
    expect(rec!.roomId).toBeUndefined();
  });
});

describe("handlePostSessions — malformed delegation", () => {
  it("returns 400 { error: 'malformed' } for non-JSON input", async () => {
    const { host, storage } = makeHost();
    const store = new SessionStore();

    const result = await handlePostSessions(
      { agentId: TEST_AGENT_ID, entityId: TEST_ENTITY_ID, serializedDelegation: "not-json-at-all" },
      host,
      store,
    );

    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toBe("malformed");
    expect(storage.calls).toHaveLength(0);
  });

  it("returns 400 { error: 'malformed' } for empty string", async () => {
    const { host, storage } = makeHost();
    const store = new SessionStore();

    const result = await handlePostSessions(
      { agentId: TEST_AGENT_ID, entityId: TEST_ENTITY_ID, serializedDelegation: "" },
      host,
      store,
    );

    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toBe("malformed");
    expect(storage.calls).toHaveLength(0);
  });
});

describe("handlePostSessions — invalid delegation shape", () => {
  it("returns 400 and does NOT call registerDelegation when the memory SQL resource is missing", async () => {
    const { host, storage } = makeHost();
    const store = new SessionStore();
    const serialized = makeValidSerialized({ path: "tinycloud.sql/other-db" });

    const result = await handlePostSessions(
      { agentId: TEST_AGENT_ID, entityId: TEST_ENTITY_ID, serializedDelegation: serialized },
      host,
      store,
    );

    expect(result.status).toBe(400);
    expect(storage.calls).toHaveLength(0);
    expect(store.get(TEST_ENTITY_ID)).toBeUndefined();
  });
});

describe("handlePostSessions — wrong delegatee", () => {
  it("returns 400 and does NOT call registerDelegation for a wrong-delegatee delegation", async () => {
    const { host, storage } = makeHost(); // host.agentDid = TEST_AGENT_DID
    const store = new SessionStore();
    // delegation delegates to WRONG_AGENT_DID, not TEST_AGENT_DID
    const serialized = makeValidSerialized({ delegateDID: WRONG_AGENT_DID });

    const result = await handlePostSessions(
      { agentId: TEST_AGENT_ID, entityId: TEST_ENTITY_ID, serializedDelegation: serialized },
      host,
      store,
    );

    expect(result.status).toBe(400);
    expect(storage.calls).toHaveLength(0);
  });

  it("does not record a wrong-delegatee session in the C-local store", async () => {
    const { host } = makeHost();
    const store = new SessionStore();
    const serialized = makeValidSerialized({ delegateDID: WRONG_AGENT_DID });

    await handlePostSessions(
      { agentId: TEST_AGENT_ID, entityId: TEST_ENTITY_ID, serializedDelegation: serialized },
      host,
      store,
    );

    expect(store.get(TEST_ENTITY_ID)).toBeUndefined();
  });
});

// ── GET /sessions/:entityId ───────────────────────────────────────────────────

describe("handleGetSessions — unknown entity", () => {
  it("returns 404 { status: 'none' } for an entity not in the store", async () => {
    const { host } = makeHost();
    const store = new SessionStore();

    const result = await handleGetSessions("unknown-entity-xyz", host, store);

    expect(result.status).toBe(404);
    expect((result.body as { status: string }).status).toBe("none");
  });
});

describe("handleGetSessions — known entity (active delegation)", () => {
  it("returns 200 with status 'active' for a just-registered entity", async () => {
    const { host } = makeHost();
    const store = new SessionStore();
    const serialized = makeValidSerialized();

    // Register via POST first
    await handlePostSessions(
      { agentId: TEST_AGENT_ID, entityId: TEST_ENTITY_ID, serializedDelegation: serialized },
      host,
      store,
    );

    const result = await handleGetSessions(TEST_ENTITY_ID, host, store);

    expect(result.status).toBe(200);
    expect((result.body as { entityId: string }).entityId).toBe(TEST_ENTITY_ID);
    expect((result.body as { status: string }).status).toBe("active");
  });

  it("returns the entityId in the response body", async () => {
    const { host } = makeHost();
    const store = new SessionStore();
    const serialized = makeValidSerialized();

    await handlePostSessions(
      { agentId: TEST_AGENT_ID, entityId: TEST_ENTITY_ID, serializedDelegation: serialized },
      host,
      store,
    );

    const result = await handleGetSessions(TEST_ENTITY_ID, host, store);
    expect((result.body as { entityId: string }).entityId).toBe(TEST_ENTITY_ID);
  });
});

describe("handleGetSessions — expired delegation", () => {
  it("returns 200 with status 'expired' for an entity whose stored delegation has expired", async () => {
    const { host } = makeHost();
    const store = new SessionStore();
    // Build an expired delegation and insert directly (POST would reject it at validateDelegationShape)
    const expiredSerialized = makeValidSerialized({
      expiry: new Date("2000-01-01T00:00:00.000Z").toISOString(),
    });
    store.set(TEST_ENTITY_ID, {
      agentId: TEST_AGENT_ID,
      serializedDelegation: expiredSerialized,
    });

    const result = await handleGetSessions(TEST_ENTITY_ID, host, store);

    expect(result.status).toBe(200);
    expect((result.body as { status: string }).status).toBe("expired");
  });
});
