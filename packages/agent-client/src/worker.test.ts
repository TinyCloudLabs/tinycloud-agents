// T5 unit suite for the serialized Worker — MOCK jobs, ZERO network, ZERO host-framework imports.
//
// Drives serialization, read priority, the circuit breaker, the bounded write
// queue, and timeout-advances-queue against an injectable FakeClock so breaker
// windows (120s) and call timeouts (10s) resolve deterministically in <1ms
// (plan §9 testability seam). Never touches a live node.

import { expect, test } from "bun:test";
import {
  CircuitOpenError,
  QueueFullError,
  silentLogger,
  TimeoutError,
  Worker,
  type Clock,
  type TimerHandle,
} from "./index.ts";

/** A manually-advanced clock — timers fire only when the test advances time. */
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
  /** Advance the clock, firing every timer now due, earliest-deadline first. */
  advance(ms: number): void {
    this.current += ms;
    const due = [...this.timers.entries()]
      .filter(([, t]) => t.at <= this.current)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, t] of due) {
      this.timers.delete(id);
      t.handler();
    }
  }
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("serialization: N concurrent calls run strictly one-at-a-time, in order", async () => {
  const worker = new Worker({ clock: new FakeClock(), logger: silentLogger });
  const order: number[] = [];
  let active = 0;
  let maxActive = 0;

  const jobs = Array.from({ length: 8 }, (_unused, i) =>
    worker.read(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      // Yield so a broken worker would interleave a second dispatch here.
      await Promise.resolve();
      order.push(i);
      active -= 1;
      return i;
    }, "job"),
  );

  const results = await Promise.all(jobs);
  expect(maxActive).toBe(1); // invariant 1: never more than one in flight
  expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); // FIFO within a lane
  expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
});

test("read priority: a read enqueued behind queued writes runs before them", async () => {
  const worker = new Worker({ clock: new FakeClock(), logger: silentLogger });
  const order: string[] = [];
  const gate = deferred();

  // Occupy the single in-flight slot so the rest queue up behind it.
  const blocker = worker.write(async () => {
    await gate.promise;
    order.push("blocker");
  }, "blocker");
  const w1 = worker.write(async () => void order.push("w1"), "w1");
  const w2 = worker.write(async () => void order.push("w2"), "w2");
  // Enqueued LAST, yet must jump ahead of the two queued writes.
  const r = worker.read(async () => void order.push("r"), "r");

  gate.resolve();
  await Promise.all([blocker, w1, w2, r]);
  expect(order).toEqual(["blocker", "r", "w1", "w2"]);
});

test("breaker: opens after 5 consecutive failures and then fails fast without a node call", async () => {
  const worker = new Worker({
    clock: new FakeClock(),
    logger: silentLogger,
    breakerThreshold: 5,
    breakerOpenMs: 1000,
  });
  let calls = 0;
  const failing = () =>
    worker.write(async () => {
      calls += 1;
      throw new Error("boom");
    });

  for (let i = 0; i < 5; i += 1) await failing().catch(() => {});
  expect(worker.breakerState).toBe("open");
  expect(calls).toBe(5);

  // Open → fail fast with CircuitOpenError; the transport must NOT be invoked.
  await expect(
    worker.write(async () => {
      calls += 1;
      return 1;
    }),
  ).rejects.toBeInstanceOf(CircuitOpenError);
  expect(calls).toBe(5); // unchanged — no node call while open
});

test("breaker: half-open single probe closes on success", async () => {
  const clock = new FakeClock();
  const worker = new Worker({
    clock,
    logger: silentLogger,
    breakerThreshold: 5,
    breakerOpenMs: 1000,
  });
  for (let i = 0; i < 5; i += 1) {
    await worker.write(async () => {
      throw new Error("boom");
    }).catch(() => {});
  }
  expect(worker.breakerState).toBe("open");

  clock.advance(1000); // open window elapses → next call is the single probe
  const value = await worker.write(async () => "ok");
  expect(value).toBe("ok");
  expect(worker.breakerState).toBe("closed");
});

test("breaker: half-open probe failure re-opens the breaker", async () => {
  const clock = new FakeClock();
  const worker = new Worker({
    clock,
    logger: silentLogger,
    breakerThreshold: 5,
    breakerOpenMs: 1000,
  });
  for (let i = 0; i < 5; i += 1) {
    await worker.write(async () => {
      throw new Error("boom");
    }).catch(() => {});
  }
  expect(worker.breakerState).toBe("open");

  clock.advance(1000);
  await worker.write(async () => {
    throw new Error("probe-fail");
  }).catch(() => {});
  expect(worker.breakerState).toBe("open"); // re-opened, not closed
});

test("queue bound: the 51st pending write rejects QueueFullError; earlier ones unaffected", async () => {
  const worker = new Worker({ clock: new FakeClock(), logger: silentLogger }); // default limit 50
  const gate = deferred();
  const blocker = worker.write(async () => {
    await gate.promise;
  }, "blocker");

  const queued = Array.from({ length: 50 }, (_unused, i) =>
    worker.write(async () => i, "w"),
  );
  expect(worker.writeQueueDepth).toBe(50);

  // 51st queued write (52nd submitted overall) rejects immediately.
  await expect(worker.write(async () => 999, "overflow")).rejects.toBeInstanceOf(
    QueueFullError,
  );

  gate.resolve();
  await blocker;
  const results = await Promise.all(queued);
  expect(results).toHaveLength(50);
  expect(results[0]).toBe(0);
  expect(results[49]).toBe(49);
});

test("timeout advances the queue: a stuck call rejects at the deadline; the next call still runs", async () => {
  const clock = new FakeClock();
  const worker = new Worker({ clock, logger: silentLogger, requestTimeoutMs: 100 });

  const stuck = worker.write(() => new Promise<never>(() => {}), "stuck");
  let nextRan = false;
  const next = worker.write(async () => {
    nextRan = true;
    return "next";
  }, "next");

  clock.advance(100); // fire the hard-timeout timer for the stuck call
  await expect(stuck).rejects.toBeInstanceOf(TimeoutError);

  // The timed-out call released the slot — the queue advanced.
  expect(await next).toBe("next");
  expect(nextRan).toBe(true);
});
