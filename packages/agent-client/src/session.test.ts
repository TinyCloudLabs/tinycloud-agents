// T5 unit suite for the session auth-retry lifecycle — MOCK transport, ZERO
// network, ZERO host-framework imports. Exercises the "exactly one re-signIn + one retry"
// contract (plan §3 lifecycle step 2) via createAgentClient with an injected
// scripted transport and a FakeClock (so the proactive-refresh timer never fires).

import { expect, test } from "bun:test";
import {
  AuthError,
  createAgentClient,
  silentLogger,
  Session,
  Worker,
  DEFAULT_RE_SIGN_IN_MS,
  type BatchData,
  type Clock,
  type ExecuteData,
  type QueryData,
  type SignInResult,
  type SqlStatement,
  type TimerHandle,
  type Transport,
  type TransportResult,
} from "./index.ts";

class FakeClock implements Clock {
  current = 0;
  private timers = new Map<number, { at: number; handler: () => void }>();
  private nextId = 1;
  now(): number {
    return this.current;
  }
  setTimeout(handler: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + ms, handler });
    return id;
  }
  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }
}

const SESSION: SignInResult = { spaceId: "space-1", address: "0xabc", did: "did:key:z6Mk" };
const AUTH_ERR: TransportResult<QueryData> = {
  ok: false,
  error: { code: "AUTH_EXPIRED", message: "401 unauthorized", service: "sql" },
};
const OK_QUERY: TransportResult<QueryData> = {
  ok: true,
  data: { columns: ["n"], rows: [[1]], rowCount: 1 },
};

/** Returns each scripted query result in order, repeating the last past the end. */
class ScriptedTransport implements Transport {
  signInCount = 0;
  queryCount = 0;
  constructor(private readonly queryScript: TransportResult<QueryData>[]) {}

  async signIn(): Promise<SignInResult> {
    this.signInCount += 1;
    return SESSION;
  }
  async query(): Promise<TransportResult<QueryData>> {
    const i = this.queryCount;
    this.queryCount += 1;
    return this.queryScript[Math.min(i, this.queryScript.length - 1)];
  }
  async execute(): Promise<TransportResult<ExecuteData>> {
    return { ok: true, data: { changes: 1 } };
  }
  async batch(_statements: SqlStatement[]): Promise<TransportResult<BatchData>> {
    return { ok: true, data: { results: [] } };
  }
}

test("401 retry once: a single auth failure triggers one re-signIn + one retry (success)", async () => {
  const transport = new ScriptedTransport([AUTH_ERR, OK_QUERY]);
  const client = createAgentClient(
    { privateKey: "0xkey" },
    { transport, clock: new FakeClock(), logger: silentLogger },
  );

  const data = await client.sql.query("SELECT 1");
  expect(data.rowCount).toBe(1);
  expect(transport.signInCount).toBe(2); // initial lazy signIn + exactly one re-signIn
  expect(transport.queryCount).toBe(2); // first (auth-fail) + one retry
  await client.stop();
});

test("401 retry once: a second consecutive auth failure surfaces AuthError, no further retries", async () => {
  const transport = new ScriptedTransport([AUTH_ERR, AUTH_ERR]);
  const client = createAgentClient(
    { privateKey: "0xkey" },
    { transport, clock: new FakeClock(), logger: silentLogger },
  );

  await expect(client.sql.query("SELECT 1")).rejects.toBeInstanceOf(AuthError);
  expect(transport.signInCount).toBe(2); // initial + one re-signIn, never a loop
  expect(transport.queryCount).toBe(2); // first + retry, then it gives up
  await client.stop();
});

// ---------------------------------------------------------------------------
// proactiveRefresh: false — Session never arms the refresh timer
// ---------------------------------------------------------------------------

test("Session with proactiveRefresh: false never arms the refresh timer (fake clock)", async () => {
  const setTimeoutMs: number[] = [];
  const clock: Clock = {
    now: () => 0,
    setTimeout: (_handler: () => void, ms: number): TimerHandle => {
      setTimeoutMs.push(ms);
      return setTimeoutMs.length as unknown as TimerHandle;
    },
    clearTimeout: () => {},
  };

  const transport = new ScriptedTransport([OK_QUERY]);
  const worker = new Worker({ clock, logger: silentLogger });
  const session = new Session({
    transport,
    worker,
    reSignInMs: DEFAULT_RE_SIGN_IN_MS,
    clock,
    proactiveRefresh: false,
    logger: silentLogger,
  });

  // Trigger signIn + SQL (scheduleRefresh would normally fire here)
  await session.run("read", () => transport.query("SELECT 1"), "test");

  // No refresh timer should have been set with the reSignInMs cadence
  const refreshTimerCalls = setTimeoutMs.filter((ms) => ms === DEFAULT_RE_SIGN_IN_MS);
  expect(refreshTimerCalls).toHaveLength(0);

  await session.stop();
});

// ---------------------------------------------------------------------------
// auth-like SQL failure with proactiveRefresh: false (delegation mode lifecycle)
// ---------------------------------------------------------------------------

test("auth-like SQL failure with proactiveRefresh=false: one re-activation + one retry, then AuthError (no loop)", async () => {
  const transport = new ScriptedTransport([AUTH_ERR, AUTH_ERR]);
  const clock = new FakeClock();
  const worker = new Worker({ clock, logger: silentLogger });
  const session = new Session({
    transport,
    worker,
    reSignInMs: DEFAULT_RE_SIGN_IN_MS,
    clock,
    proactiveRefresh: false,
    logger: silentLogger,
  });

  await expect(
    session.run("read", () => transport.query("SELECT 1"), "delegated-op"),
  ).rejects.toBeInstanceOf(AuthError);

  expect(transport.signInCount).toBe(2); // initial activation + one re-activation
  expect(transport.queryCount).toBe(2); // first (auth-fail) + one retry, then AuthError

  await session.stop();
});

// ---------------------------------------------------------------------------
// Session.reSignIn() calls transport.invalidate() if present
// (delegation re-activation contract — audit §Lifecycle minor finding)
// ---------------------------------------------------------------------------

test("Session.reSignIn() calls transport.invalidate() if present before re-signing in", async () => {
  let invalidateCalls = 0;

  class InvalidatableTransport extends ScriptedTransport {
    invalidate(): void { invalidateCalls++; }
  }

  const transport = new InvalidatableTransport([AUTH_ERR, OK_QUERY]);
  const client = createAgentClient(
    { privateKey: "0xkey" },
    { transport, clock: new FakeClock(), logger: silentLogger },
  );

  const data = await client.sql.query("SELECT 1");
  expect(data.rowCount).toBe(1);
  // Auth failure → reSignIn() → transport.invalidate() called once before re-activation
  expect(invalidateCalls).toBe(1);
  // signIn() still called twice (initial + re-signIn)
  expect(transport.signInCount).toBe(2);
  await client.stop();
});

test("Session.reSignIn() is safe when transport has no invalidate() (private-key transport)", async () => {
  // ScriptedTransport has no invalidate() — the optional call must not throw.
  const transport = new ScriptedTransport([AUTH_ERR, OK_QUERY]);
  const client = createAgentClient(
    { privateKey: "0xkey" },
    { transport, clock: new FakeClock(), logger: silentLogger },
  );

  const data = await client.sql.query("SELECT 1");
  expect(data.rowCount).toBe(1);
  expect(transport.signInCount).toBe(2);
  await client.stop();
});

// ---------------------------------------------------------------------------
// proactiveRefresh: true for delegation mode — timer arms and fires
// invalidate()+reSignIn() at ~50min (T5 flip)
// ---------------------------------------------------------------------------

test("delegation-mode Session (proactiveRefresh: true) arms the refresh timer at DEFAULT_RE_SIGN_IN_MS", async () => {
  const scheduledMs: number[] = [];
  const clock: Clock = {
    now: () => 0,
    setTimeout(handler: () => void, ms: number): TimerHandle {
      scheduledMs.push(ms);
      return scheduledMs.length as unknown as TimerHandle;
    },
    clearTimeout() {},
  };

  const transport = new ScriptedTransport([OK_QUERY]);
  const worker = new Worker({ clock, logger: silentLogger });
  const session = new Session({
    transport,
    worker,
    reSignInMs: DEFAULT_RE_SIGN_IN_MS,
    clock,
    proactiveRefresh: true,
    logger: silentLogger,
  });

  await session.run("read", () => transport.query("SELECT 1"), "test");

  // Exactly one refresh timer should have been scheduled at the reSignInMs cadence
  const refreshTimers = scheduledMs.filter((ms) => ms === DEFAULT_RE_SIGN_IN_MS);
  expect(refreshTimers).toHaveLength(1);

  await session.stop();
});

test("delegation-mode Session refresh timer fires invalidate()+reSignIn() at ~50min", async () => {
  const timerHandlers: (() => void)[] = [];
  const timerMs: number[] = [];
  const clock: Clock = {
    now: () => 0,
    setTimeout(handler: () => void, ms: number): TimerHandle {
      timerMs.push(ms);
      timerHandlers.push(handler);
      return timerHandlers.length as unknown as TimerHandle;
    },
    clearTimeout() {},
  };

  let invalidateCalls = 0;
  let signInCalls = 0;
  // Resolved when the proactive re-signIn completes (signInCalls reaches 2)
  let resolveReSignIn!: () => void;
  const reSignInDone = new Promise<void>((r) => { resolveReSignIn = r; });

  class DelegationTransport implements Transport {
    invalidate(): void { invalidateCalls++; }
    async signIn(): Promise<SignInResult> {
      signInCalls++;
      if (signInCalls === 2) resolveReSignIn();
      return SESSION;
    }
    async query(): Promise<TransportResult<QueryData>> { return OK_QUERY; }
    async execute(): Promise<TransportResult<ExecuteData>> { return { ok: true, data: { changes: 0 } }; }
    async batch(_statements: SqlStatement[]): Promise<TransportResult<BatchData>> {
      return { ok: true, data: { results: [] } };
    }
  }

  const transport = new DelegationTransport();
  const worker = new Worker({ clock, logger: silentLogger });
  const session = new Session({
    transport,
    worker,
    reSignInMs: DEFAULT_RE_SIGN_IN_MS,
    clock,
    proactiveRefresh: true,
    logger: silentLogger,
  });

  // Trigger initial signIn and arm the timer
  await session.run("read", () => transport.query("SELECT 1"), "test");
  expect(signInCalls).toBe(1);

  // Find and fire the refresh timer (the one scheduled at DEFAULT_RE_SIGN_IN_MS)
  const refreshIdx = timerMs.indexOf(DEFAULT_RE_SIGN_IN_MS);
  expect(refreshIdx).toBeGreaterThanOrEqual(0);
  timerHandlers[refreshIdx]();

  // Wait for the async doProactiveRefresh → reSignIn → invalidate+signIn chain
  await reSignInDone;

  expect(invalidateCalls).toBe(1);   // transport.invalidate() called before re-activation
  expect(signInCalls).toBe(2);       // initial + proactive re-signIn

  await session.stop();
});
