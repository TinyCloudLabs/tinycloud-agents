// T5 unit suite for the session auth-retry lifecycle — MOCK transport, ZERO
// network, ZERO host-framework imports. Exercises the "exactly one re-signIn + one retry"
// contract (plan §3 lifecycle step 2) via createAgentClient with an injected
// scripted transport and a FakeClock (so the proactive-refresh timer never fires).

import { expect, test } from "bun:test";
import {
  AuthError,
  createAgentClient,
  silentLogger,
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
