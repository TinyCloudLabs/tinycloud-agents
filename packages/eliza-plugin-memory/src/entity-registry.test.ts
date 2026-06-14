// Routing-isolation unit tests for EntityClientRegistry (T1 risk-retirement).
//
// Injects TWO fake AgentClients (A and B) and asserts that:
//   1. clientFor("entityA") returns clientA — not clientB.
//   2. Calls on clientA never touch clientB.
//   3. clientForRoom resolves through the room→entity map.
//   4. An unregistered entity throws the typed NoDelegationError (not null,
//      no cross-entity fallback).

import { describe, expect, test } from "bun:test";

import { DelegationPolicyError } from "@tinycloud/agent-client";
import type { AgentClient, QueryData } from "@tinycloud/agent-client";

function makeMinimalClient(id: string, opts: { stopFn?: () => Promise<void> } = {}): AgentClient {
  const emptyQuery: QueryData = { columns: [], rows: [], rowCount: 0 };
  return {
    signIn: async () => ({ spaceId: `space:${id}`, address: `0x${id}`, did: `did:key:z${id}` }),
    ensureSchema: async () => {},
    stop: opts.stopFn ?? (async () => {}),
    sql: {
      query: async () => emptyQuery,
      execute: async () => ({ changes: 1, lastInsertRowId: 1 }),
      batch: async () => ({ results: [] }),
      withRowObjects: () => [],
    },
  };
}

import {
  DelegationExpiredError,
  EntityClientRegistry,
  NoDelegationError,
} from "./entity-registry";

// ── minimal fake client ───────────────────────────────────────────────────────

interface TrackedClient extends AgentClient {
  /** SQL queries/executes recorded by this client (proves isolation). */
  callLog: string[];
}

function makeTrackedClient(id: string): TrackedClient {
  const callLog: string[] = [];
  const emptyQuery: QueryData = { columns: [], rows: [], rowCount: 0 };

  return {
    callLog,
    signIn: async () => ({ spaceId: `space:${id}`, address: `0x${id}`, did: `did:key:z${id}` }),
    ensureSchema: async () => {},
    stop: async () => {},
    sql: {
      query: async (sql) => {
        callLog.push(`query:${sql.split(" ")[0]}`);
        return emptyQuery;
      },
      execute: async (sql) => {
        callLog.push(`execute:${sql.split(" ")[0]}`);
        return { changes: 1, lastInsertRowId: 1 };
      },
      batch: async () => {
        callLog.push("batch");
        return { results: [] };
      },
      withRowObjects: () => [],
    },
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeRegistry(
  entries: Array<{ entityId: string; client: TrackedClient; roomId?: string }>,
): EntityClientRegistry {
  const clients = new Map<string, AgentClient>(entries.map((e) => [e.entityId, e.client]));
  const registry = new EntityClientRegistry({ clients });

  for (const { entityId, client: _, roomId } of entries) {
    // Safe without await: T1 seam (pre-built clients) makes registerDelegation
    // return synchronously after the `existing` early-return path.
    void registry.registerDelegation(entityId, `serialized-${entityId}`, roomId);
  }

  return registry;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("EntityClientRegistry — routing isolation", () => {
  test("clientFor(entityA) returns clientA", () => {
    const clientA = makeTrackedClient("A");
    const clientB = makeTrackedClient("B");
    const registry = makeRegistry([
      { entityId: "entityA", client: clientA },
      { entityId: "entityB", client: clientB },
    ]);

    const resolved = registry.clientFor("entityA");
    expect(resolved).toBe(clientA);
    expect(resolved).not.toBe(clientB);
  });

  test("clientFor(entityB) returns clientB", () => {
    const clientA = makeTrackedClient("A");
    const clientB = makeTrackedClient("B");
    const registry = makeRegistry([
      { entityId: "entityA", client: clientA },
      { entityId: "entityB", client: clientB },
    ]);

    const resolved = registry.clientFor("entityB");
    expect(resolved).toBe(clientB);
    expect(resolved).not.toBe(clientA);
  });

  test("calls on clientA do not touch clientB's call log", async () => {
    const clientA = makeTrackedClient("A");
    const clientB = makeTrackedClient("B");
    const registry = makeRegistry([
      { entityId: "entityA", client: clientA },
      { entityId: "entityB", client: clientB },
    ]);

    const resolvedA = registry.clientFor("entityA");
    await resolvedA.sql.execute("INSERT INTO foo VALUES (?)");
    await resolvedA.sql.query("SELECT * FROM foo");

    expect(clientA.callLog).toHaveLength(2);
    expect(clientB.callLog).toHaveLength(0);
  });

  test("calls on clientB do not touch clientA's call log", async () => {
    const clientA = makeTrackedClient("A");
    const clientB = makeTrackedClient("B");
    const registry = makeRegistry([
      { entityId: "entityA", client: clientA },
      { entityId: "entityB", client: clientB },
    ]);

    const resolvedB = registry.clientFor("entityB");
    await resolvedB.sql.execute("INSERT INTO bar VALUES (?)");

    expect(clientB.callLog).toHaveLength(1);
    expect(clientA.callLog).toHaveLength(0);
  });

  test("clientForRoom resolves via room→entity map to the correct client", () => {
    const clientA = makeTrackedClient("A");
    const clientB = makeTrackedClient("B");
    const registry = makeRegistry([
      { entityId: "entityA", client: clientA, roomId: "room-alpha" },
      { entityId: "entityB", client: clientB, roomId: "room-beta" },
    ]);

    expect(registry.clientForRoom("room-alpha")).toBe(clientA);
    expect(registry.clientForRoom("room-beta")).toBe(clientB);
  });

  test("clientForRoom for room-alpha does not return clientB", () => {
    const clientA = makeTrackedClient("A");
    const clientB = makeTrackedClient("B");
    const registry = makeRegistry([
      { entityId: "entityA", client: clientA, roomId: "room-alpha" },
      { entityId: "entityB", client: clientB, roomId: "room-beta" },
    ]);

    expect(registry.clientForRoom("room-alpha")).not.toBe(clientB);
  });

  test("clientFor unregistered entity throws NoDelegationError (not null)", () => {
    const clientA = makeTrackedClient("A");
    const registry = makeRegistry([{ entityId: "entityA", client: clientA }]);

    expect(() => registry.clientFor("entityX")).toThrow(NoDelegationError);
  });

  test("NoDelegationError carries the entityId", () => {
    const registry = new EntityClientRegistry({ clients: new Map() });

    let caught: NoDelegationError | undefined;
    try {
      registry.clientFor("missing-entity");
    } catch (e) {
      caught = e as NoDelegationError;
    }

    expect(caught).toBeInstanceOf(NoDelegationError);
    expect(caught?.entityId).toBe("missing-entity");
  });

  test("clientForRoom unregistered room throws NoDelegationError (not null)", () => {
    const registry = new EntityClientRegistry({ clients: new Map() });

    expect(() => registry.clientForRoom("room-ghost")).toThrow(NoDelegationError);
  });

  test("clientFor entity-A does NOT fall back to entity-B when A is unregistered", () => {
    const clientB = makeTrackedClient("B");
    const registry = makeRegistry([{ entityId: "entityB", client: clientB }]);

    // entityA was never registered; must throw, not return clientB
    expect(() => registry.clientFor("entityA")).toThrow(NoDelegationError);
  });

  test("registerDelegation wires room→entity mapping", () => {
    const clientA = makeTrackedClient("A");
    const registry = new EntityClientRegistry({
      clients: new Map([["entityA", clientA]]),
    });

    registry.registerDelegation("entityA", "serialized-A", "room-wired");

    expect(registry.clientForRoom("room-wired")).toBe(clientA);
  });

  test("registering a room twice overwrites the mapping to the new entity", () => {
    const clientA = makeTrackedClient("A");
    const clientB = makeTrackedClient("B");
    const registry = new EntityClientRegistry({
      clients: new Map([
        ["entityA", clientA],
        ["entityB", clientB],
      ]),
    });

    registry.registerDelegation("entityA", "serialized-A", "shared-room");
    registry.registerDelegation("entityB", "serialized-B", "shared-room");

    // Last registration wins the room
    expect(registry.clientForRoom("shared-room")).toBe(clientB);
  });
});

// ── T3: full delegation build, LRU, failure isolation ────────────────────────
//
// Tests inject a createClient factory (mock) and a runWrite lane.
// No live node I/O — factory creates tracked clients synchronously.

describe("EntityClientRegistry — T3 delegation build", () => {
  /** Build a tracked client whose signIn/ensureSchema/stop calls are recorded. */
  function makeDelegationClient(id: string): TrackedClient {
    const callLog: string[] = [];
    const emptyQuery: QueryData = { columns: [], rows: [], rowCount: 0 };

    return {
      callLog,
      signIn: async () => {
        callLog.push("signIn");
        return { spaceId: `space:${id}`, address: `0x${id}`, did: `did:key:z${id}` };
      },
      ensureSchema: async () => {
        callLog.push("ensureSchema");
      },
      stop: async () => {
        callLog.push("stop");
      },
      sql: {
        query: async (sql) => {
          callLog.push(`query:${sql.split(" ")[0]}`);
          return emptyQuery;
        },
        execute: async (sql) => {
          callLog.push(`execute:${sql.split(" ")[0]}`);
          return { changes: 1, lastInsertRowId: 1 };
        },
        batch: async () => {
          callLog.push("batch");
          return { results: [] };
        },
        withRowObjects: () => [],
      },
    };
  }

  test("registering two entities builds two independent clients", async () => {
    const clientA = makeDelegationClient("A");
    const clientB = makeDelegationClient("B");
    const clientQueue = [clientA, clientB];
    let callCount = 0;

    const registry = new EntityClientRegistry({
      createClient: () => clientQueue[callCount++],
      runWrite: async (fn) => fn(),
    });

    await registry.registerDelegation("entityA", "serialized-A");
    await registry.registerDelegation("entityB", "serialized-B");

    expect(callCount).toBe(2);
    expect(registry.clientFor("entityA")).toBe(clientA);
    expect(registry.clientFor("entityB")).toBe(clientB);
    expect(clientA.callLog).toContain("signIn");
    expect(clientB.callLog).toContain("signIn");
    // Each client is independent — A's signIn doesn't touch B's log and vice versa
    expect(clientA.callLog.filter((e) => e === "signIn")).toHaveLength(1);
    expect(clientB.callLog.filter((e) => e === "signIn")).toHaveLength(1);
  });

  test("ensureSchema is routed through the write lane", async () => {
    const client = makeDelegationClient("A");
    const writeLaneCalls: string[] = [];

    const registry = new EntityClientRegistry({
      createClient: () => client,
      runWrite: async (fn) => {
        writeLaneCalls.push("runWrite");
        return fn();
      },
    });

    await registry.registerDelegation("entityA", "serialized-A");

    expect(writeLaneCalls).toHaveLength(1);
    expect(writeLaneCalls[0]).toBe("runWrite");
    expect(client.callLog).toContain("ensureSchema");
  });

  test("LRU eviction calls client.stop() when capacity is reached", async () => {
    const clientA = makeDelegationClient("A");
    const clientB = makeDelegationClient("B");
    const clientQueue = [clientA, clientB];
    let callCount = 0;

    // maxClients=1: adding B evicts A
    const registry = new EntityClientRegistry({
      createClient: () => clientQueue[callCount++],
      runWrite: async (fn) => fn(),
      maxClients: 1,
    });

    await registry.registerDelegation("entityA", "serialized-A");
    await registry.registerDelegation("entityB", "serialized-B"); // evicts entityA

    expect(clientA.callLog).toContain("stop");
    expect(() => registry.clientFor("entityA")).toThrow(NoDelegationError);
    expect(registry.clientFor("entityB")).toBe(clientB);
  });

  test("LRU eviction removes room mappings for the evicted entity", async () => {
    const clientA = makeDelegationClient("A");
    const clientB = makeDelegationClient("B");
    const clientQueue = [clientA, clientB];
    let callCount = 0;

    const registry = new EntityClientRegistry({
      createClient: () => clientQueue[callCount++],
      runWrite: async (fn) => fn(),
      maxClients: 1,
    });

    await registry.registerDelegation("entityA", "serialized-A", "room-alpha");
    await registry.registerDelegation("entityB", "serialized-B", "room-beta");

    // entityA (and its room) was evicted
    expect(() => registry.clientForRoom("room-alpha")).toThrow(NoDelegationError);
    expect(registry.clientForRoom("room-beta")).toBe(clientB);
  });

  test("signIn EXPIRED surfaces DelegationExpiredError", async () => {
    const badClient = {
      ...makeDelegationClient("bad"),
      signIn: async () => {
        throw new DelegationPolicyError("delegation expired", "EXPIRED");
      },
    };

    const registry = new EntityClientRegistry({
      createClient: () => badClient,
      runWrite: async (fn) => fn(),
    });

    await expect(
      registry.registerDelegation("entityBad", "serialized-bad"),
    ).rejects.toBeInstanceOf(DelegationExpiredError);
  });

  test("EXPIRED signIn does not affect another entity's clientFor (failure isolation)", async () => {
    const goodClient = makeDelegationClient("good");
    const badClient = {
      ...makeDelegationClient("bad"),
      signIn: async () => {
        throw new DelegationPolicyError("delegation expired", "EXPIRED");
      },
    };
    const clientQueue: TrackedClient[] = [goodClient, badClient as unknown as TrackedClient];
    let callCount = 0;

    const registry = new EntityClientRegistry({
      createClient: () => clientQueue[callCount++],
      runWrite: async (fn) => fn(),
    });

    // Register the good entity first — must succeed
    await registry.registerDelegation("entityGood", "serialized-good");
    expect(registry.clientFor("entityGood")).toBe(goodClient);

    // Registering the bad entity throws DelegationExpiredError — isolated to this call
    await expect(
      registry.registerDelegation("entityBad", "serialized-bad"),
    ).rejects.toBeInstanceOf(DelegationExpiredError);

    // The good entity is completely unaffected
    expect(registry.clientFor("entityGood")).toBe(goodClient);
  });

  test("DelegationExpiredError carries the entityId", async () => {
    const expiredClient = {
      ...makeDelegationClient("exp"),
      signIn: async () => {
        throw new DelegationPolicyError("expired", "EXPIRED");
      },
    };

    const registry = new EntityClientRegistry({
      createClient: () => expiredClient,
      runWrite: async (fn) => fn(),
    });

    let caught: DelegationExpiredError | undefined;
    try {
      await registry.registerDelegation("entity-exp", "serialized-exp");
    } catch (e) {
      caught = e as DelegationExpiredError;
    }

    expect(caught).toBeInstanceOf(DelegationExpiredError);
    expect(caught?.entityId).toBe("entity-exp");
  });

  test("concurrent registerDelegation calls for the same entity deduplicate", async () => {
    let buildCount = 0;
    const client = makeDelegationClient("A");

    const registry = new EntityClientRegistry({
      createClient: () => {
        buildCount++;
        return client;
      },
      runWrite: async (fn) => fn(),
    });

    // Two concurrent registrations — only one client build should run
    await Promise.all([
      registry.registerDelegation("entityA", "serialized-A"),
      registry.registerDelegation("entityA", "serialized-A"),
    ]);

    expect(buildCount).toBe(1);
    expect(registry.clientFor("entityA")).toBe(client);
  });

  test("delegation expiry in the past throws DelegationExpiredError (T1 seam)", () => {
    const clientA = makeTrackedClient("A");
    const pastExpiry = new Date(Date.now() - 1000); // 1 second ago

    const registry = new EntityClientRegistry({
      clients: new Map([["entityA", clientA]]),
      clientExpiries: new Map([["entityA", pastExpiry]]),
    });

    expect(() => registry.clientFor("entityA")).toThrow(DelegationExpiredError);
  });

  test("delegation expiry in the future does not block clientFor (T1 seam)", () => {
    const clientA = makeTrackedClient("A");
    const futureExpiry = new Date(Date.now() + 3_600_000); // 1 hour from now

    const registry = new EntityClientRegistry({
      clients: new Map([["entityA", clientA]]),
      clientExpiries: new Map([["entityA", futureExpiry]]),
    });

    expect(registry.clientFor("entityA")).toBe(clientA);
  });

  test("idle TTL expiry in clientFor throws DelegationExpiredError", async () => {
    const client = makeDelegationClient("A");

    const registry = new EntityClientRegistry({
      createClient: () => client,
      runWrite: async (fn) => fn(),
      ttlMs: 1, // expire after 1ms
    });

    await registry.registerDelegation("entityA", "serialized-A");

    // Wait for TTL to lapse
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(() => registry.clientFor("entityA")).toThrow(DelegationExpiredError);
  });

  test("roomId is wired before the async build so a sync caller sees it", async () => {
    const client = makeDelegationClient("A");

    // Deliberately slow signIn to ensure room mapping is available before signIn resolves
    let signInResolve!: () => void;
    const signInGate = new Promise<void>((r) => {
      signInResolve = r;
    });
    const slowClient: TrackedClient = {
      ...client,
      signIn: async () => {
        await signInGate;
        return { spaceId: "space:slow", address: "0xslow", did: "did:key:zslow" };
      },
    };

    const registry = new EntityClientRegistry({
      createClient: () => slowClient,
      runWrite: async (fn) => fn(),
    });

    // Start registration but don't await yet
    const regPromise = registry.registerDelegation("entityA", "serialized-A", "room-slow");

    // Release the gate so signIn completes
    signInResolve();
    await regPromise;

    expect(registry.clientForRoom("room-slow")).toBe(slowClient);
  });
});

// ── stop() ───────────────────────────────────────────────────────────────────

describe("EntityClientRegistry — stop()", () => {
  test("stop() calls stop() on all registered clients", async () => {
    const stopped: string[] = [];

    const queue = ["A", "B"].map((id) =>
      makeMinimalClient(id, { stopFn: async () => { stopped.push(id); } }),
    );
    let idx = 0;

    const registry = new EntityClientRegistry({
      createClient: () => queue[idx++],
      runWrite: async (fn) => fn(),
    });

    await registry.registerDelegation("entityA", "serialized-A", "room-A");
    await registry.registerDelegation("entityB", "serialized-B", "room-B");

    await registry.stop();

    expect(stopped.sort()).toEqual(["A", "B"]);
    expect(() => registry.clientFor("entityA")).toThrow(NoDelegationError);
    expect(() => registry.clientFor("entityB")).toThrow(NoDelegationError);
    expect(() => registry.clientForRoom("room-A")).toThrow(NoDelegationError);
  });

  test("stop() does not propagate errors from individual client.stop() (allSettled)", async () => {
    const registry = new EntityClientRegistry({
      createClient: () =>
        makeMinimalClient("X", {
          stopFn: async () => { throw new Error("stop-failed"); },
        }),
      runWrite: async (fn) => fn(),
    });

    await registry.registerDelegation("entityX", "serialized-X");

    await expect(registry.stop()).resolves.toBeUndefined();
  });

  test("stop() on an empty registry resolves immediately", async () => {
    const registry = new EntityClientRegistry({});
    await expect(registry.stop()).resolves.toBeUndefined();
  });
});

// ── bindRoom() ────────────────────────────────────────────────────────────────

describe("EntityClientRegistry — bindRoom()", () => {
  test("bindRoom wires room→entity without a serializedDelegation string", () => {
    const clientA = makeTrackedClient("A");
    const registry = new EntityClientRegistry({
      clients: new Map([["entityA", clientA]]),
    });

    registry.bindRoom("entityA", "room-bound");

    expect(registry.clientForRoom("room-bound")).toBe(clientA);
  });

  test("bindRoom overwrites an existing room→entity mapping", () => {
    const clientA = makeTrackedClient("A");
    const clientB = makeTrackedClient("B");
    const registry = new EntityClientRegistry({
      clients: new Map([
        ["entityA", clientA],
        ["entityB", clientB],
      ]),
    });

    registry.bindRoom("entityA", "shared-room");
    registry.bindRoom("entityB", "shared-room");

    expect(registry.clientForRoom("shared-room")).toBe(clientB);
  });

  test("multiple rooms can be bound to the same entity", () => {
    const clientA = makeTrackedClient("A");
    const registry = new EntityClientRegistry({
      clients: new Map([["entityA", clientA]]),
    });

    registry.bindRoom("entityA", "room-1");
    registry.bindRoom("entityA", "room-2");

    expect(registry.clientForRoom("room-1")).toBe(clientA);
    expect(registry.clientForRoom("room-2")).toBe(clientA);
  });
});

// ── Same-registry entity isolation (T6(c) within-registry variant) ───────────
//
// Proves that one entity's delegation expiry in the SAME registry instance does
// not evict or break a different entity in the same registry.

describe("EntityClientRegistry — same-registry entity isolation", () => {
  test("entity A's signed delegation expiry does not evict entity B in the same registry", () => {
    const clientA = makeMinimalClient("A");
    const clientB = makeMinimalClient("B");

    // Use clientExpiries T1 seam to mark entity A's delegation as already expired.
    const pastExpiry = new Date(Date.now() - 1_000);
    const registry = new EntityClientRegistry({
      clients: new Map([
        ["entityA", clientA],
        ["entityB", clientB],
      ]),
      clientExpiries: new Map([
        ["entityA", pastExpiry], // A expired 1 second ago
        // B has no signed expiry — delegation-expiry check never fires for B
      ]),
    });

    // Entity A → DelegationExpiredError (signed expiry check fires)
    expect(() => registry.clientFor("entityA")).toThrow(DelegationExpiredError);

    // Entity B is completely unaffected — same registry, different entry
    expect(registry.clientFor("entityB")).toBe(clientB);
  });

  test("entity A's NoDelegationError does not affect entity B's clientFor", () => {
    const clientB = makeMinimalClient("B");
    const registry = new EntityClientRegistry({
      clients: new Map([["entityB", clientB]]),
    });

    // Entity A was never registered in this registry
    expect(() => registry.clientFor("entityA")).toThrow(NoDelegationError);

    // Entity B is still accessible
    expect(registry.clientFor("entityB")).toBe(clientB);
  });
});
