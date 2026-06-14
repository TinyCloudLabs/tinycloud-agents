/** Thrown when runWrite is called but the pending queue is at capacity. */
export class WriteLaneOverflowError extends Error {
  readonly queueDepth: number;
  constructor(queueDepth: number) {
    super(`WriteLaneOverflowError: write lane queue full (depth ${queueDepth})`);
    this.name = "WriteLaneOverflowError";
    this.queueDepth = queueDepth;
  }
}

export interface WriteLaneOptions {
  /** Max simultaneous in-flight writes. Default 1. */
  concurrency?: number;
  /** Max pending queue depth before runWrite rejects. Default 100. */
  maxQueueDepth?: number;
}

// Internal queue entry — type safety is enforced per-call in runWrite<T>.
// biome-ignore lint/suspicious/noExplicitAny: internal erasure
type AnyFn = () => Promise<any>;
// biome-ignore lint/suspicious/noExplicitAny: internal erasure
type Resolve = (value: any) => void;
type Reject = (reason: unknown) => void;

interface QueueEntry {
  fn: AnyFn;
  resolve: Resolve;
  reject: Reject;
}

/**
 * Process-wide async write lane.
 *
 * Serializes all writes to a SQLite node (prod: single-writer) by running at
 * most `concurrency` (default 1, env ELIZA_WRITE_LANE_CONCURRENCY) writes
 * simultaneously. Excess writes queue FIFO; once the queue exceeds
 * `maxQueueDepth` (env ELIZA_WRITE_LANE_MAX_QUEUE) the call rejects
 * immediately with WriteLaneOverflowError instead of growing unbounded.
 *
 * Reads are NOT laned — never pass a read through runWrite.
 */
export class WriteLane {
  private readonly concurrency: number;
  private readonly maxQueueDepth: number;
  private inFlight = 0;
  private readonly queue: QueueEntry[] = [];

  constructor(opts: WriteLaneOptions = {}) {
    this.concurrency = opts.concurrency ?? 1;
    this.maxQueueDepth = opts.maxQueueDepth ?? 100;
  }

  runWrite<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.inFlight < this.concurrency) {
        this.inFlight++;
        this.execute(fn, resolve, reject);
      } else {
        if (this.queue.length >= this.maxQueueDepth) {
          reject(new WriteLaneOverflowError(this.queue.length));
          return;
        }
        this.queue.push({ fn, resolve, reject });
      }
    });
  }

  private async execute<T>(
    fn: () => Promise<T>,
    resolve: (value: T) => void,
    reject: Reject,
  ): Promise<void> {
    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this.inFlight--;
      this.pump();
    }
  }

  private pump(): void {
    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.inFlight++;
      this.execute(next.fn, next.resolve, next.reject);
    }
  }
}

const _concurrency = Number(process.env.ELIZA_WRITE_LANE_CONCURRENCY) || 1;
const _maxQueueDepth = Number(process.env.ELIZA_WRITE_LANE_MAX_QUEUE) || 100;

/** Shared process-wide lane — all writes across all user spaces go here. */
export const writeLane = new WriteLane({
  concurrency: _concurrency,
  maxQueueDepth: _maxQueueDepth,
});

/** Route a write through the process-wide lane. */
export const runWrite = <T>(fn: () => Promise<T>): Promise<T> =>
  writeLane.runWrite(fn);
