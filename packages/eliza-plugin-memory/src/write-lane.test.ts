import { describe, expect, test } from "bun:test";
import { WriteLane, WriteLaneOverflowError } from "./write-lane";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Manually-controlled promise (no real timers). */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("WriteLane — concurrency=1 (default)", () => {
  test("executes strictly serially: peak in-flight never exceeds 1", async () => {
    const lane = new WriteLane({ concurrency: 1 });
    let inFlight = 0;
    let peakInFlight = 0;

    const ds = [deferred(), deferred(), deferred()];
    const promises = ds.map((d, i) =>
      lane.runWrite(async () => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await d.promise;
        inFlight--;
        return i;
      }),
    );

    // Only fn0 should be in-flight synchronously after queueing all three
    expect(inFlight).toBe(1);
    expect(peakInFlight).toBe(1);

    // Release one at a time; peak must never rise above 1
    ds[0].resolve();
    await promises[0];
    expect(peakInFlight).toBe(1);

    ds[1].resolve();
    await promises[1];
    expect(peakInFlight).toBe(1);

    ds[2].resolve();
    await promises[2];
    expect(peakInFlight).toBe(1);
  });

  test("FIFO ordering: tasks execute in submission order", async () => {
    const lane = new WriteLane({ concurrency: 1 });
    const order: number[] = [];
    const ds = [deferred(), deferred(), deferred()];

    const promises = ds.map((d, i) =>
      lane.runWrite(async () => {
        await d.promise;
        order.push(i);
      }),
    );

    for (let i = 0; i < ds.length; i++) {
      ds[i].resolve();
      await promises[i];
    }

    expect(order).toEqual([0, 1, 2]);
  });

  test("throwing fn releases the slot so the next write proceeds", async () => {
    const lane = new WriteLane({ concurrency: 1 });
    const d = deferred();

    const p1 = lane.runWrite(async () => {
      await d.promise;
      throw new Error("intentional failure");
    });

    const ran: boolean[] = [];
    const p2 = lane.runWrite(async () => {
      ran.push(true);
    });

    d.resolve();

    await expect(p1).rejects.toThrow("intentional failure");
    await p2;
    expect(ran).toEqual([true]);
  });

  test("runWrite returns the value produced by fn", async () => {
    const lane = new WriteLane({ concurrency: 1 });
    const result = await lane.runWrite(async () => 42);
    expect(result).toBe(42);
  });
});

describe("WriteLane — queue overflow", () => {
  test("rejects with WriteLaneOverflowError when queue is full", async () => {
    // concurrency 1 (slot) + maxQueueDepth 2 (pending) = max 3 accepted, 4th overflows
    const lane = new WriteLane({ concurrency: 1, maxQueueDepth: 2 });
    const d = deferred();

    const p0 = lane.runWrite(() => d.promise); // takes the slot
    const p1 = lane.runWrite(async () => {}); // queued (slot 0)
    const p2 = lane.runWrite(async () => {}); // queued (slot 1, queue full at 2)
    const p3 = lane.runWrite(async () => {}); // OVERFLOW

    await expect(p3).rejects.toBeInstanceOf(WriteLaneOverflowError);

    // Drain the lane so the test doesn't hang
    d.resolve();
    await p0;
    await p1;
    await p2;
  });

  test("WriteLaneOverflowError.queueDepth equals the depth at rejection time", async () => {
    const lane = new WriteLane({ concurrency: 1, maxQueueDepth: 1 });
    const d = deferred();

    lane.runWrite(() => d.promise); // takes slot
    lane.runWrite(async () => {}); // fills queue to depth 1

    let err: WriteLaneOverflowError | undefined;
    try {
      await lane.runWrite(async () => {}); // overflow — depth is 1 when rejected
    } catch (e) {
      err = e as WriteLaneOverflowError;
    }

    expect(err).toBeInstanceOf(WriteLaneOverflowError);
    expect(err?.queueDepth).toBe(1);

    d.resolve();
  });

  test("after an overflow, the lane continues serving queued items", async () => {
    const lane = new WriteLane({ concurrency: 1, maxQueueDepth: 1 });
    const d = deferred();

    const p0 = lane.runWrite(() => d.promise); // takes slot
    const p1 = lane.runWrite(async () => "ok"); // queued
    await expect(lane.runWrite(async () => {})).rejects.toBeInstanceOf(WriteLaneOverflowError);

    d.resolve();
    await p0;
    const result = await p1;
    expect(result).toBe("ok");
  });
});

describe("WriteLane — concurrency=2", () => {
  test("peak in-flight is exactly 2", async () => {
    const lane = new WriteLane({ concurrency: 2 });
    let inFlight = 0;
    let peakInFlight = 0;

    const ds = [deferred(), deferred(), deferred(), deferred()];
    const promises = ds.map((d) =>
      lane.runWrite(async () => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await d.promise;
        inFlight--;
      }),
    );

    // First two run immediately; last two queue
    expect(inFlight).toBe(2);
    expect(peakInFlight).toBe(2);

    ds[0].resolve();
    ds[1].resolve();
    await promises[0];
    await promises[1];

    // After the first two finish, the queued two start
    ds[2].resolve();
    ds[3].resolve();
    await promises[2];
    await promises[3];

    // Peak must never have exceeded 2
    expect(peakInFlight).toBe(2);
  });

  test("both slots fill before the third is admitted", async () => {
    const lane = new WriteLane({ concurrency: 2 });
    let inFlight = 0;

    const d0 = deferred();
    const d1 = deferred();
    const d2 = deferred();

    const p0 = lane.runWrite(async () => { inFlight++; await d0.promise; inFlight--; });
    const p1 = lane.runWrite(async () => { inFlight++; await d1.promise; inFlight--; });
    // At this point, two are in-flight; fn2 queues
    expect(inFlight).toBe(2);

    const p2 = lane.runWrite(async () => { inFlight++; await d2.promise; inFlight--; });
    expect(inFlight).toBe(2); // still 2; fn2 is queued

    // Release one slot — fn2 should start immediately
    d0.resolve();
    await p0;
    expect(inFlight).toBe(2); // fn1 + fn2 now in-flight

    d1.resolve();
    await p1;
    d2.resolve();
    await p2;
  });
});

describe("WriteLane — error isolation", () => {
  test("throws from earlier fn do not prevent later fn from running", async () => {
    const lane = new WriteLane({ concurrency: 1 });
    const results: string[] = [];

    const d = deferred();
    const pFail = lane.runWrite(async () => {
      await d.promise;
      throw new Error("boom");
    });
    const pOk = lane.runWrite(async () => {
      results.push("ran");
    });

    d.resolve();
    await expect(pFail).rejects.toThrow("boom");
    await pOk;
    expect(results).toEqual(["ran"]);
  });

  test("multiple consecutive throws still release the slot", async () => {
    const lane = new WriteLane({ concurrency: 1 });
    const ran: number[] = [];

    for (let i = 0; i < 3; i++) {
      const d = deferred();
      const idx = i;
      const p = lane.runWrite(async () => {
        await d.promise;
        if (idx < 2) throw new Error(`fail ${idx}`);
        ran.push(idx);
      });
      d.resolve();
      // The throw must not propagate out of the lane machinery
      await p.catch(() => {});
    }

    expect(ran).toEqual([2]);
  });
});
