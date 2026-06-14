// T5 unit suite for ensureSchema memoization — MOCK transport, ZERO network,
// ZERO host-framework imports. Proves the DDL bootstrap hits the transport exactly once per
// statement across repeated AND concurrent ensureSchema calls (plan §3/§4).

import { expect, test } from "bun:test";
import {
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

/** Counts execute() calls so we can assert DDL runs at most once per statement. */
class CountingTransport implements Transport {
  executeCount = 0;
  executed: string[] = [];
  async signIn(): Promise<SignInResult> {
    return { spaceId: "space-1", address: "0xabc", did: "did:key:z6Mk" };
  }
  async query(): Promise<TransportResult<QueryData>> {
    return { ok: true, data: { columns: [], rows: [], rowCount: 0 } };
  }
  async execute(sql: string): Promise<TransportResult<ExecuteData>> {
    this.executeCount += 1;
    this.executed.push(sql);
    return { ok: true, data: { changes: 0 } };
  }
  async batch(_statements: SqlStatement[]): Promise<TransportResult<BatchData>> {
    return { ok: true, data: { results: [] } };
  }
}

test("ensureSchema memoization: DDL hits the transport once across concurrent + repeated calls", async () => {
  const transport = new CountingTransport();
  const client = createAgentClient(
    { privateKey: "0xkey" },
    { transport, clock: new FakeClock(), logger: silentLogger },
  );
  const statements = ["CREATE TABLE a (id TEXT)", "CREATE TABLE b (id TEXT)"];

  // Concurrent first-callers dedupe on the single in-flight promise...
  await Promise.all([
    client.ensureSchema(statements),
    client.ensureSchema(statements),
    client.ensureSchema(statements),
  ]);
  // ...and later repeats are memoized (no node I/O at all).
  await client.ensureSchema(statements);
  await client.ensureSchema(statements);

  expect(transport.executeCount).toBe(statements.length); // each DDL exactly once
  expect(transport.executed).toEqual(statements);
  await client.stop();
});
