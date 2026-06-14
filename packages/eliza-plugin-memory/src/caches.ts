// SWR (stale-while-revalidate) read cache — the per-method read accelerator that
// keeps our worst-case provider contribution far inside Eliza's 30s budget
// (plan §5 invariant 3, rows 2 & 6).
//
// Behavior (per plan §5):
//   • FRESH hit (age < ttl)  → return cached value immediately.
//   • STALE hit (age ≥ ttl)  → return the stale value NOW, revalidate in the
//                              background (deduped per key).
//   • COLD miss              → await the loader racing a hard deadline; on
//                              timeout OR loader error, return stale-or-fallback.
//                              The read path NEVER throws.
//   • write-through (`set`)  → store callers seed/refresh the cache directly.
//   • invalidate / prefix    → update/delete drop entity- or room-scoped entries.
//
// TTL, clock and the per-read deadline are all injectable so this unit is
// testable without timers or a live node (plan T8 / task note). No host-framework
// (Eliza) imports — this is a pure, separately-testable unit. The default timing
// seam is the agent-client's {@link realClock} (typed setTimeout/now), so this
// package needs no ambient node/DOM globals.

import { realClock, type Clock } from "@tinycloud/agent-client";

/** Monotonic-enough time source (ms). Injected in tests; defaults to the clock. */
export type Now = () => number;

/** A cached value plus the time it was stored. */
export interface SwrEntry<V> {
  value: V;
  storedAt: number;
}

/** Construction knobs for a {@link SwrCache}. */
export interface SwrOptions {
  /** Freshness window (ms). Past this an entry is served stale + revalidated. */
  ttlMs: number;
  /** Timing seam (now + deadline timer). Defaults to the agent-client {@link realClock}. */
  clock?: Clock;
  /** Time source (ms) override. Defaults to `clock.now`. */
  now?: Now;
  /** Notified when a background revalidation fails (the stale value is kept). */
  onRevalidateError?: (key: string, err: unknown) => void;
}

/**
 * A small stale-while-revalidate cache keyed by string. Generic over the cached
 * value type `V` (e.g. `LongTermMemory[]` or `SessionSummary | null`).
 */
export class SwrCache<V> {
  private readonly store = new Map<string, SwrEntry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private readonly now: Now;
  private readonly onRevalidateError: (key: string, err: unknown) => void;

  constructor(opts: SwrOptions) {
    this.ttlMs = opts.ttlMs;
    this.clock = opts.clock ?? realClock;
    this.now = opts.now ?? (() => this.clock.now());
    this.onRevalidateError = opts.onRevalidateError ?? (() => {});
  }

  /** Peek at the raw entry without triggering a load (write-through helpers use this). */
  peek(key: string): SwrEntry<V> | undefined {
    return this.store.get(key);
  }

  /** Write-through: seed or refresh a key with a known-current value. */
  set(key: string, value: V): void {
    this.store.set(key, { value, storedAt: this.now() });
  }

  /** Drop a single key. */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Drop every key beginning with `prefix` (e.g. all entries for one entity). */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  private isFresh(entry: SwrEntry<V>): boolean {
    return this.now() - entry.storedAt < this.ttlMs;
  }

  /**
   * Stale-while-revalidate read with a hard deadline. Never throws.
   *   - fresh hit → cached value
   *   - stale hit → stale value now, revalidate in background
   *   - cold miss → await loader racing `deadlineMs`; timeout/error → fallback
   */
  async read(
    key: string,
    loader: () => Promise<V>,
    deadlineMs: number,
    fallback: V,
  ): Promise<V> {
    const entry = this.store.get(key);
    if (entry) {
      if (this.isFresh(entry)) return entry.value;
      // Stale: serve immediately, refresh in the background (errors swallowed).
      void this.revalidate(key, loader).catch(() => {});
      return entry.value;
    }

    // Cold miss: await the load, but never longer than the deadline.
    try {
      return await this.withDeadline(this.revalidate(key, loader), deadlineMs);
    } catch {
      const latest = this.store.get(key);
      return latest ? latest.value : fallback;
    }
  }

  /** Resolve `p`, or reject with a deadline error after `ms` (via the injected clock). */
  private withDeadline(p: Promise<V>, ms: number): Promise<V> {
    return new Promise<V>((resolve, reject) => {
      const timer = this.clock.setTimeout(
        () => reject(new Error("swr deadline exceeded")),
        ms,
      );
      p.then(
        (value) => {
          this.clock.clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          this.clock.clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** Run (and de-dupe) a single load for `key`, storing the result on success. */
  private revalidate(key: string, loader: () => Promise<V>): Promise<V> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const run = (async (): Promise<V> => {
      try {
        const value = await loader();
        this.set(key, value);
        return value;
      } catch (err) {
        this.onRevalidateError(key, err);
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, run);
    return run;
  }
}
