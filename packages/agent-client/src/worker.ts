// The ONE serialized request worker for ALL TinyCloud node I/O.
//
// Plan §5 resilience invariants (cited, not improvised):
//   1. Strict serialization — at most one transport call in flight, EVER. KV/SQL
//      drop responses under concurrency (TinyChat scar, plan §2.5). Every node
//      call in the whole client funnels through this worker.
//   2. Two lanes — READS have queue-jump priority over WRITES (per-turn reads must
//      not sit behind post-turn writes), FIFO within each lane.
//   3. Bounded write queue (default 50) — enqueueing past the bound rejects
//      IMMEDIATELY with QueueFullError + a warn carrying the queued count; never
//      silently buffer (plan §5 invariant 2).
//   4. Circuit breaker — N consecutive failures (default 5) open it for 120s;
//      while open every call fails fast with CircuitOpenError (callers serve
//      stale); half-open allows exactly ONE probe — success closes, failure
//      re-opens (plan §5 invariant 4).
//   5. Hard timeout (default 10s) on EVERY dispatched call — the transport promise
//      races a timer; on timeout the caller is rejected with TimeoutError AND the
//      queue advances (a timed-out call must NEVER wedge the worker). The abandoned
//      promise's late settle is ignored (optionally debug-logged). Timeouts count
//      as breaker failures.
//
// TESTABILITY (plan §9 item 5): timing is injectable via the {@link Clock} seam so
// T5 can exercise breaker open/half-open and timeout-advances-queue without real
// 120s / 10s waits.
//
// HARD CONTRACT: zero host-framework (Eliza) imports — see ./index.ts.

import {
  DEFAULT_BREAKER_OPEN_MS,
  DEFAULT_BREAKER_THRESHOLD,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_WRITE_QUEUE_LIMIT,
} from "./config";
import { CircuitOpenError, QueueFullError, TimeoutError } from "./errors";
import { consoleLogger, type Logger } from "./logger";

/** Opaque timer handle returned by {@link Clock.setTimeout}. */
export type TimerHandle = unknown;

/**
 * Injectable timing seam. Production uses {@link realClock}; tests pass a fake
 * clock to drive breaker windows and call timeouts deterministically (plan §9).
 */
export interface Clock {
  now(): number;
  setTimeout(handler: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Real wall-clock + global timers. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Which lane a unit of work runs in. Reads jump the queue ahead of writes. */
export type Lane = "read" | "write";

/** Circuit-breaker state (plan §5 invariant 4). */
export type BreakerState = "closed" | "open" | "half-open";

/** A unit of node work: a thunk the worker runs at most one-at-a-time. */
export type Job<T> = () => Promise<T>;

/** Tunable worker knobs; every default comes from plan §5 (see ./config). */
export interface WorkerOptions {
  /** Hard per-call timeout (ms). Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /** Bounded write-queue depth. Defaults to {@link DEFAULT_WRITE_QUEUE_LIMIT}. */
  writeQueueLimit?: number;
  /** Consecutive failures before the breaker opens. Defaults to {@link DEFAULT_BREAKER_THRESHOLD}. */
  breakerThreshold?: number;
  /** Breaker open duration (ms). Defaults to {@link DEFAULT_BREAKER_OPEN_MS}. */
  breakerOpenMs?: number;
  /** Timing seam. Defaults to {@link realClock}. */
  clock?: Clock;
  /** Logger for the queue-full warn / late-settle debug. Defaults to consoleLogger. */
  logger?: Logger;
}

interface QueuedJob {
  readonly lane: Lane;
  readonly run: Job<unknown>;
  /** Short op label (e.g. "query" | "execute"), never a request body (plan §5 security). */
  readonly label: string | undefined;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * The serialized worker. Submit work with {@link Worker.read} / {@link Worker.write};
 * the returned promise settles with the job's result, a TimeoutError, a
 * QueueFullError, or a CircuitOpenError.
 */
export class Worker {
  private readonly requestTimeoutMs: number;
  private readonly writeQueueLimit: number;
  private readonly breakerThreshold: number;
  private readonly breakerOpenMs: number;
  private readonly clock: Clock;
  private readonly logger: Logger;

  // Two lanes; reads are pulled before writes (plan §5 invariant 2).
  private readonly readQueue: QueuedJob[] = [];
  private readonly writeQueue: QueuedJob[] = [];

  // Invariant 1: at most one job in flight at any time.
  private running = false;

  // Breaker state (invariant 4).
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(options: WorkerOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.writeQueueLimit = options.writeQueueLimit ?? DEFAULT_WRITE_QUEUE_LIMIT;
    this.breakerThreshold = options.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
    this.breakerOpenMs = options.breakerOpenMs ?? DEFAULT_BREAKER_OPEN_MS;
    this.clock = options.clock ?? realClock;
    this.logger = options.logger ?? consoleLogger;
  }

  /** Submit a READ. Reads jump ahead of queued writes. */
  read<T>(run: Job<T>, label?: string): Promise<T> {
    return this.submit("read", run, label);
  }

  /**
   * Submit a WRITE. Rejects IMMEDIATELY with {@link QueueFullError} (plus a warn
   * carrying the queued count) when the bounded write queue is full — never buffers
   * silently (plan §5 invariant 2).
   */
  write<T>(run: Job<T>, label?: string): Promise<T> {
    if (this.writeQueue.length >= this.writeQueueLimit) {
      this.logger.warn("agent-client: write queue full; rejecting write", {
        queued: this.writeQueue.length,
        limit: this.writeQueueLimit,
        op: label,
      });
      return Promise.reject(new QueueFullError(this.writeQueueLimit));
    }
    return this.submit("write", run, label);
  }

  /** Current breaker state — for tests/observability, not a control surface. */
  get breakerState(): BreakerState {
    return this.state;
  }

  /** Pending read-lane depth. */
  get readQueueDepth(): number {
    return this.readQueue.length;
  }

  /** Pending write-lane depth. */
  get writeQueueDepth(): number {
    return this.writeQueue.length;
  }

  /** Whether a job is currently dispatched (invariant 1 — never more than one). */
  get inFlight(): boolean {
    return this.running;
  }

  private submit<T>(lane: Lane, run: Job<T>, label?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob = {
        lane,
        run: run as Job<unknown>,
        label,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      (lane === "read" ? this.readQueue : this.writeQueue).push(job);
      this.pump();
    });
  }

  /** Pull the next job: reads first (priority lane), then writes; FIFO within each. */
  private nextJob(): QueuedJob | undefined {
    return this.readQueue.shift() ?? this.writeQueue.shift();
  }

  /**
   * Kick the queue. Synchronous up to the point it claims the single in-flight
   * slot, so two concurrent pump() calls can never both dispatch (invariant 1).
   */
  private pump(): void {
    if (this.running) return;
    const job = this.nextJob();
    if (job === undefined) return;
    this.running = true;
    void this.runJob(job);
  }

  private async runJob(job: QueuedJob): Promise<void> {
    try {
      if (this.breakerGate() === "reject") {
        // Open, not yet time to probe: fail fast, no node call (invariant 4).
        job.reject(new CircuitOpenError(this.openUntil));
        return;
      }
      try {
        const value = await this.dispatch(job);
        this.recordSuccess();
        job.resolve(value);
      } catch (error) {
        // Transport rejection OR our own TimeoutError — both count as breaker
        // failures (plan §5 invariant 4 / invariant 5).
        this.recordFailure();
        job.reject(error);
      }
    } finally {
      // Always release the slot and advance — a timed-out or failed call must
      // NEVER wedge the worker (invariant 5).
      this.running = false;
      this.pump();
    }
  }

  /**
   * Race the job against the hard timeout. On timeout, reject the caller and let
   * runJob advance the queue; the abandoned job promise's late settle is ignored
   * (optionally debug-logged). Plan §5 invariant 5.
   */
  private dispatch(job: QueuedJob): Promise<unknown> {
    const timeoutMs = this.requestTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const timer = this.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new TimeoutError(timeoutMs, job.label));
      }, timeoutMs);

      job.run().then(
        (value) => {
          if (settled) {
            // Late settle after timeout — ignored (invariant 5). Never log the value.
            this.logger.debug("agent-client: ignoring late success after timeout", {
              op: job.label,
            });
            return;
          }
          settled = true;
          this.clock.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) {
            this.logger.debug("agent-client: ignoring late failure after timeout", {
              op: job.label,
            });
            return;
          }
          settled = true;
          this.clock.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * Decide whether the next job may touch the node.
   *   • closed     → run.
   *   • open, window not elapsed → reject (fail fast).
   *   • open, window elapsed     → transition to half-open and allow this ONE probe.
   *   • half-open  → run (only reachable if a probe is mid-flight; serialization
   *                  guarantees there is at most one).
   */
  private breakerGate(): "run" | "reject" {
    if (this.state === "open") {
      if (this.clock.now() >= this.openUntil) {
        this.state = "half-open";
        return "run";
      }
      return "reject";
    }
    return "run";
  }

  private recordSuccess(): void {
    // A probe success closes the breaker; a normal success resets the counter.
    this.state = "closed";
    this.consecutiveFailures = 0;
  }

  private recordFailure(): void {
    if (this.state === "half-open") {
      // Probe failed → re-open immediately (invariant 4).
      this.openBreaker();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.breakerThreshold) {
      this.openBreaker();
    }
  }

  private openBreaker(): void {
    this.state = "open";
    this.openUntil = this.clock.now() + this.breakerOpenMs;
  }
}
