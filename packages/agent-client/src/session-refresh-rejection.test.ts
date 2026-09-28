// Proactive refresh vs. a stored delegation that can no longer activate.
//
// Prod incident (eliza-service, 2026-09): once a user's stored 7-day delegation
// expired, every ~50 min the proactive refresh re-validated it, got
// DelegationShapeError("delegation has expired"), logged, and RE-ARMED — forever.
// Contract pinned here:
//   - a permanent delegation rejection (expired / invalid) stops proactive refresh,
//     logs once, and notifies onDelegationRejected exactly once;
//   - transient failures (AuthError / network) keep the cadence alive.
// MOCK transport + fake clock; ZERO network.

import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { PortableDelegation } from "@tinycloud/node-sdk";
import { resolveDelegationConfig } from "./config.ts";
import { DelegatedTransport } from "./delegated-transport.ts";
import { DB_HANDLE, FULL_SQL_ACTIONS, makeAtt, makeJwt, OWNER } from "./delegation-fixtures.test.ts";
import {
  AuthError,
  DEFAULT_RE_SIGN_IN_MS,
  DelegationPolicyError,
  DelegationShapeError,
  Session,
  Worker,
  createAgentClient,
  isDelegationExpiredError,
  silentLogger,
  type BatchData,
  type Clock,
  type ExecuteData,
  type Logger,
  type QueryData,
  type SignInResult,
  type SqlStatement,
  type TimerHandle,
  type Transport,
  type TransportResult,
} from "./index.ts";

afterEach(() => setSystemTime());

const SESSION: SignInResult = { spaceId: "space-1", address: "0xabc", did: "did:key:z6Mk" };
const OK_QUERY: TransportResult<QueryData> = { ok: true, data: { columns: [], rows: [], rowCount: 0 } };

/** Manual clock: records armed timers; tests fire them explicitly. */
class ManualClock implements Clock {
  private nextId = 1;
  readonly timers = new Map<number, { ms: number; handler: () => void }>();
  now(): number {
    return Date.now();
  }
  setTimeout(handler: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { ms, handler });
    return id;
  }
  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }
  refreshTimers(): number[] {
    return [...this.timers].filter(([, t]) => t.ms === DEFAULT_RE_SIGN_IN_MS).map(([id]) => id);
  }
  /** Fire the single armed refresh timer (fails if zero or several are armed). */
  fireRefresh(): void {
    const ids = this.refreshTimers();
    expect(ids).toHaveLength(1);
    const timer = this.timers.get(ids[0])!;
    this.timers.delete(ids[0]);
    timer.handler();
  }
}

function recordingLogger(): Logger & { warns: Array<{ message: string; meta: unknown[] }> } {
  const warns: Array<{ message: string; meta: unknown[] }> = [];
  return { ...silentLogger, warn: (message: string, ...meta: unknown[]) => { warns.push({ message, meta }); }, warns };
}

/** signIn succeeds once, then follows `failWith` for every later call. */
class FailingAfterFirstTransport implements Transport {
  signIns = 0;
  invalidations = 0;
  constructor(private readonly failWith: () => unknown) {}
  invalidate(): void { this.invalidations++; }
  async signIn(): Promise<SignInResult> {
    this.signIns++;
    if (this.signIns === 1) return SESSION;
    throw this.failWith();
  }
  async query(): Promise<TransportResult<QueryData>> { return OK_QUERY; }
  async execute(): Promise<TransportResult<ExecuteData>> { return { ok: true, data: { changes: 0 } }; }
  async batch(_s: SqlStatement[]): Promise<TransportResult<BatchData>> { return { ok: true, data: { results: [] } }; }
}

/** Let the fire-and-forget doProactiveRefresh chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function makeSession(transport: Transport, clock: ManualClock, logger: Logger, onDelegationRejected?: (e: Error) => void) {
  return new Session({
    transport,
    worker: new Worker({ clock, logger: silentLogger }),
    reSignInMs: DEFAULT_RE_SIGN_IN_MS,
    clock,
    proactiveRefresh: true,
    logger,
    onDelegationRejected,
  });
}

const expiredShapeError = () => new DelegationShapeError("delegation has expired: check expiry", { expired: true });

test("expired stored delegation: proactive refresh stops, logs once, notifies once", async () => {
  const clock = new ManualClock();
  const logger = recordingLogger();
  const rejected: Error[] = [];
  const transport = new FailingAfterFirstTransport(expiredShapeError);
  const session = makeSession(transport, clock, logger, (e) => rejected.push(e));

  await session.run("read", () => transport.query(), "q");
  expect(clock.refreshTimers()).toHaveLength(1);

  clock.fireRefresh();
  await settle();

  expect(transport.signIns).toBe(2);
  // NOT re-armed: this is the fix for the infinite ~50-min loop.
  expect(clock.refreshTimers()).toHaveLength(0);
  expect(rejected).toHaveLength(1);
  expect(isDelegationExpiredError(rejected[0])).toBe(true);
  expect(logger.warns).toHaveLength(1);
  expect(logger.warns[0].message).toContain("stopping proactive refresh");
  expect(logger.warns[0].meta[0]).toEqual({ reason: "DelegationShapeError", expired: true });

  // Lazy use afterwards fails fast with the same local error, without re-arming,
  // re-logging, or re-notifying.
  await expect(session.run("read", () => transport.query(), "q")).rejects.toBeInstanceOf(DelegationShapeError);
  await expect(session.run("read", () => transport.query(), "q")).rejects.toBeInstanceOf(DelegationShapeError);
  expect(clock.refreshTimers()).toHaveLength(0);
  expect(rejected).toHaveLength(1);
  expect(logger.warns).toHaveLength(1);

  await session.stop();
});

test("policy-level EXPIRED rejection is also permanent", async () => {
  const clock = new ManualClock();
  const logger = recordingLogger();
  const rejected: Error[] = [];
  const transport = new FailingAfterFirstTransport(
    () => new DelegationPolicyError("delegation expired", "EXPIRED"),
  );
  const session = makeSession(transport, clock, logger, (e) => rejected.push(e));

  await session.run("read", () => transport.query(), "q");
  clock.fireRefresh();
  await settle();

  expect(clock.refreshTimers()).toHaveLength(0);
  expect(rejected).toHaveLength(1);
  expect(logger.warns).toHaveLength(1);
  expect(logger.warns[0].meta[0]).toEqual({ reason: "DelegationPolicyError", expired: true });
  await session.stop();
});

test("transient AuthError on proactive refresh keeps retrying every cycle (unchanged behavior)", async () => {
  const clock = new ManualClock();
  const logger = recordingLogger();
  const rejected: Error[] = [];
  const transport = new FailingAfterFirstTransport(
    () => new AuthError("DelegatedTransport: delegation activation failed (signIn/useDelegation)"),
  );
  const session = makeSession(transport, clock, logger, (e) => rejected.push(e));

  await session.run("read", () => transport.query(), "q");
  for (let cycle = 1; cycle <= 3; cycle++) {
    clock.fireRefresh();
    await settle();
    // Re-armed after each transient failure.
    expect(clock.refreshTimers()).toHaveLength(1);
    expect(logger.warns).toHaveLength(cycle);
    expect(logger.warns[cycle - 1].message).toContain("will retry lazily on next 401");
  }
  expect(transport.signIns).toBe(4);
  expect(rejected).toHaveLength(0);
  await session.stop();
});

test("a network-style (non-Error) failure keeps retrying too", async () => {
  const clock = new ManualClock();
  const logger = recordingLogger();
  const transport = new FailingAfterFirstTransport(() => new TypeError("fetch failed"));
  const session = makeSession(transport, clock, logger);

  await session.run("read", () => transport.query(), "q");
  clock.fireRefresh();
  await settle();
  expect(clock.refreshTimers()).toHaveLength(1);
  clock.fireRefresh();
  await settle();
  expect(clock.refreshTimers()).toHaveLength(1);
  expect(transport.signIns).toBe(3);
  await session.stop();
});

test("a throwing onDelegationRejected callback does not break the session", async () => {
  const clock = new ManualClock();
  const transport = new FailingAfterFirstTransport(expiredShapeError);
  const session = makeSession(transport, clock, silentLogger, () => { throw new Error("host bug"); });

  await session.run("read", () => transport.query(), "q");
  clock.fireRefresh();
  await settle();
  expect(clock.refreshTimers()).toHaveLength(0);
  await expect(session.run("read", () => transport.query(), "q")).rejects.toBeInstanceOf(DelegationShapeError);
  await session.stop();
});

test("a lazy re-signIn that hits the expired delegation disarms an already-armed refresh timer", async () => {
  const clock = new ManualClock();
  const logger = recordingLogger();
  const rejected: Error[] = [];
  const transport = new FailingAfterFirstTransport(expiredShapeError);
  const session = makeSession(transport, clock, logger, (e) => rejected.push(e));

  await session.run("read", () => transport.query(), "q");
  expect(clock.refreshTimers()).toHaveLength(1);

  // A 401 forces the lazy re-signIn path before the timer fires.
  const unauthorized: TransportResult<QueryData> = { ok: false, error: { code: "401", message: "unauthorized" } };
  await expect(session.run("read", async () => unauthorized, "q")).rejects.toBeInstanceOf(DelegationShapeError);

  expect(clock.refreshTimers()).toHaveLength(0);
  expect(rejected).toHaveLength(1);
  expect(logger.warns.filter((w) => w.message.includes("stopping proactive refresh"))).toHaveLength(1);
  await session.stop();
});

// ---------------------------------------------------------------------------
// End-to-end through the REAL DelegatedTransport validation path: a delegation
// valid at activation expires while the session idles; the next proactive
// refresh must stop instead of looping.
// ---------------------------------------------------------------------------

const AGENT_DID = "did:pkh:eip155:1:0xfakeagent";

function delegationExpiringAt(expiry: Date): PortableDelegation {
  const space = `tinycloud:pkh:eip155:1:${OWNER}:default`;
  const att = makeAtt({ sqlActions: FULL_SQL_ACTIONS, space });
  return {
    ownerAddress: OWNER,
    delegateDID: AGENT_DID,
    spaceId: space,
    path: DB_HANDLE,
    actions: [...FULL_SQL_ACTIONS],
    expiry,
    cid: "fake-cid",
    delegationHeader: { Authorization: makeJwt(att, { aud: AGENT_DID }) },
    chainId: 1,
  } as unknown as PortableDelegation;
}

test("real DelegatedTransport: delegation expiring while idle stops the refresh loop via createAgentClient", async () => {
  const start = new Date("2030-01-01T00:00:00Z");
  setSystemTime(start);
  const expiry = new Date(start.getTime() + 60 * 60 * 1000); // valid for 1h
  let activations = 0;
  const transport = new DelegatedTransport(
    resolveDelegationConfig({ mode: "delegation", serializedDelegation: "stored", agentKey: "0x01" }),
    {
      deserialize: () => delegationExpiringAt(expiry),
      agentIdentity: async () => ({ did: AGENT_DID, normalizedKey: "0x01" }),
      activate: async () => {
        activations++;
        return { spaceId: `tinycloud:pkh:eip155:1:${OWNER}:default`, sql: { db: () => ({}) as never } };
      },
    },
  );
  const clock = new ManualClock();
  const logger = recordingLogger();
  const rejected: Error[] = [];
  const client = createAgentClient(
    { mode: "delegation", serializedDelegation: "stored", agentKey: "0x01" },
    { transport, clock, logger, onDelegationRejected: (e) => rejected.push(e) },
  );

  await client.signIn();
  expect(activations).toBe(1);
  expect(clock.refreshTimers()).toHaveLength(1);

  // First refresh while still valid: succeeds and re-arms.
  setSystemTime(new Date(start.getTime() + 50 * 60 * 1000));
  clock.fireRefresh();
  await settle();
  expect(activations).toBe(2);
  expect(clock.refreshTimers()).toHaveLength(1);

  // Second refresh after the delegation expired: stops for good.
  setSystemTime(new Date(start.getTime() + 100 * 60 * 1000));
  clock.fireRefresh();
  await settle();
  expect(activations).toBe(2); // no network activation attempted for an expired grant
  expect(clock.refreshTimers()).toHaveLength(0);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toBeInstanceOf(DelegationShapeError);
  expect(logger.warns).toHaveLength(1);

  await client.stop();
});
