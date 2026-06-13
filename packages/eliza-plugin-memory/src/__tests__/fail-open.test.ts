// Block 3 — FAIL-OPEN (plan §2.2 / §5 failure column). With a DEAD client
// (transport rejects everything) the per-turn READS degrade quietly — empty/null
// after the injected deadline, never a throw — while WRITES throw typed errors,
// and nothing leaks as an unhandled rejection. Separately, start() failure
// PROPAGATES so MemoryService can disable storage entirely (fail-open, not
// fail-over).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { CircuitOpenError, type AgentClient } from "@tinycloud/agent-client";

import { TinyCloudMemoryStorageService } from "../storage";

const AGENT = "11111111-1111-4111-8111-111111111111";
const ENTITY = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";

/** A client whose every SQL op rejects with a typed error (node "down"). */
function deadClient(): AgentClient {
  const down = () => Promise.reject(new CircuitOpenError("breaker open"));
  return {
    signIn: async () => ({ spaceId: "s", address: "a", did: "d" }),
    ensureSchema: async () => {},
    stop: async () => {},
    sql: {
      query: () => down(),
      execute: () => down(),
      batch: () => down(),
      withRowObjects: () => [],
    },
  };
}

/** A client whose reads HANG forever (exercises the read deadline path). */
function hangingClient(): AgentClient {
  const never = () => new Promise<never>(() => {});
  return {
    signIn: async () => ({ spaceId: "s", address: "a", did: "d" }),
    ensureSchema: async () => {},
    stop: async () => {},
    sql: {
      query: () => never(),
      execute: () => never(),
      batch: () => never(),
      withRowObjects: () => [],
    },
  };
}

// Catch any unhandled rejection escaping the service for the duration of a test.
const unhandled: unknown[] = [];
const onUnhandled = (err: unknown) => {
  unhandled.push(err);
};

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

function makeService(client: AgentClient): TinyCloudMemoryStorageService {
  return new TinyCloudMemoryStorageService(undefined as never, {
    client,
    batchWindowMs: 1,
    ttlMs: 60_000,
    readDeadlineMs: 40,
  });
}

// ── reads fail open ───────────────────────────────────────────────────────────

test("getLongTermMemories returns [] (never throws) when the client rejects", async () => {
  const svc = makeService(deadClient());
  const rows = await svc.getLongTermMemories(AGENT as never, ENTITY as never);
  expect(rows).toEqual([]);
});

test("getCurrentSessionSummary returns null (never throws) when the client rejects", async () => {
  const svc = makeService(deadClient());
  const cur = await svc.getCurrentSessionSummary(AGENT as never, ROOM as never);
  expect(cur).toBeNull();
});

test("getLongTermMemories returns [] after the injected deadline when reads hang", async () => {
  const svc = makeService(hangingClient());
  const started = performance.now();
  const rows = await svc.getLongTermMemories(AGENT as never, ENTITY as never);
  const elapsed = performance.now() - started;
  expect(rows).toEqual([]);
  // It returned via the ~40ms deadline, not by hanging indefinitely.
  expect(elapsed).toBeLessThan(2_000);
});

test("getCurrentSessionSummary returns null after the injected deadline when reads hang", async () => {
  const svc = makeService(hangingClient());
  const cur = await svc.getCurrentSessionSummary(AGENT as never, ROOM as never);
  expect(cur).toBeNull();
});

// ── writes fail closed (typed throw) ──────────────────────────────────────────

test("storeLongTermMemory throws a typed error when the client is down", async () => {
  const svc = makeService(deadClient());
  await expect(
    svc.storeLongTermMemory({
      agentId: AGENT,
      entityId: ENTITY,
      category: "semantic",
      content: "x",
    } as never),
  ).rejects.toBeInstanceOf(CircuitOpenError);
});

test("updateLongTermMemory throws a typed error when the client is down", async () => {
  const svc = makeService(deadClient());
  await expect(
    svc.updateLongTermMemory("id" as never, AGENT as never, ENTITY as never, { content: "x" } as never),
  ).rejects.toBeInstanceOf(CircuitOpenError);
});

test("deleteLongTermMemory throws a typed error when the client is down", async () => {
  const svc = makeService(deadClient());
  await expect(
    svc.deleteLongTermMemory("id" as never, AGENT as never, ENTITY as never),
  ).rejects.toBeInstanceOf(CircuitOpenError);
});

test("storeSessionSummary throws a typed error when the client is down", async () => {
  const svc = makeService(deadClient());
  await expect(
    svc.storeSessionSummary({
      agentId: AGENT,
      roomId: ROOM,
      summary: "s",
      messageCount: 1,
      lastMessageOffset: 1,
      startTime: new Date("2024-01-01T00:00:00.000Z"),
      endTime: new Date("2024-01-01T00:01:00.000Z"),
    } as never),
  ).rejects.toBeInstanceOf(CircuitOpenError);
});

// ── no unhandled rejection escapes the read fail-open path ─────────────────────

test("a failing read leaks no unhandled rejection", async () => {
  const svc = makeService(deadClient());
  await svc.getLongTermMemories(AGENT as never, ENTITY as never);
  await svc.getCurrentSessionSummary(AGENT as never, ROOM as never);
  // Let any deferred microtasks/rejections settle.
  await new Promise((r) => setTimeout(r, 50));
  expect(unhandled).toEqual([]);
});

// ── start() failure propagates (→ MemoryService disables storage) ─────────────

test("start() rejects when TINYCLOUD_PRIVATE_KEY is missing in private-key mode (fail-open at the slot)", async () => {
  const runtime = { getSetting: () => undefined } as never;
  await expect(TinyCloudMemoryStorageService.start(runtime)).rejects.toThrow(/PRIVATE_KEY/);
});

test("start() rejects with an error when the delegation agent key is invalid (Phase 3: delegation mode is live)", async () => {
  // Phase 3 implemented delegation mode, so the "not yet implemented" throw is gone.
  // A structurally valid config but with an invalid agent key now fails during
  // signIn/ensureSchema (key validation happens lazily, not at construction).
  const settings: Record<string, string> = {
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_DELEGATION: "fake-serialized-delegation",
    TINYCLOUD_AGENT_KEY: "0xfakeagentkey",
  };
  const runtime = { getSetting: (key: string) => settings[key] ?? undefined } as never;
  await expect(TinyCloudMemoryStorageService.start(runtime)).rejects.toThrow();
});
