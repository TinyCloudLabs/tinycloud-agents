// Session lifecycle for the agent-client core (plan §3 "Session lifecycle").
//
// Responsibilities:
//   1. LAZY signIn — the first call that needs the node signs in (autoCreateSpace
//      is set on the transport, plan §2.5); concurrent first-callers DEDUPE on a
//      single in-flight signIn promise. signIn is ~10s on prod, so it is NOT routed
//      through the worker's hard 10s per-call timeout — it gets a generous budget
//      and the session guarantees at most one signIn in flight at a time.
//   2. PROACTIVE re-signIn at ~50min (config knob; sessions last ~1h —
//      tinyboilerplate precedent). The refresh timer is unref()'d so it can NEVER
//      hold the host process open.
//   3. LAZY re-signIn on a 401/unauthorized failure from the node: EXACTLY ONE
//      re-signIn + ONE retry of the failed call, then surface AuthError. Never a
//      loop (plan §3 lifecycle step 2).
//   4. stop(): clear timers, reject new work, flush in-flight calls bounded to ~5s
//      (plan §3 lifecycle step 4 / §5 stop row).
//
// SECURITY (plan §5 / audit F4): the SDK mints a fresh 60s invocation per call and
// that expiry is NEVER extended here — the short expiry is the security control.
// Nothing in this file logs Authorization headers or request bodies.
//
// HARD CONTRACT: zero host-framework (Eliza) imports — see ./index.ts.

import { AuthError, TinyCloudClientError } from "./errors";
import { consoleLogger, type Logger } from "./logger";
import type { SignInResult, Transport, TransportResult } from "./transport";
import {
  realClock,
  type Clock,
  type Lane,
  type Job,
  type TimerHandle,
  type Worker,
} from "./worker";

/** Bounded flush budget for stop() — best-effort drain of in-flight calls (plan §5). */
export const STOP_FLUSH_MS = 5_000;

/**
 * Case-insensitive markers that mean "the SESSION is no longer valid" (re-signIn
 * + retry). Deliberately specific: the SQLite authorizer denial "not authorized"
 * (e.g. index-creation DDL on prod, plan §2.5) contains "authorized" but NOT
 * "unauthorized" — it is a permanent denial, must NOT trigger a re-signIn loop.
 */
const AUTH_MARKERS = ["401", "unauthorized", "expired", "auth_expired", "unauthenticated"];

function authLike(...parts: (string | undefined)[]): boolean {
  const hay = parts.filter((p): p is string => Boolean(p)).join(" ").toLowerCase();
  return AUTH_MARKERS.some((marker) => hay.includes(marker));
}

/** Construction options for a {@link Session}. */
export interface SessionOptions {
  /** The node I/O seam. */
  transport: Transport;
  /** The serialized worker — every SQL call funnels through it (plan §5 invariant 1). */
  worker: Worker;
  /** Proactive re-signIn cadence (ms). */
  reSignInMs: number;
  /** Timing seam. Defaults to {@link realClock}. */
  clock?: Clock;
  /** Logger. Defaults to consoleLogger. */
  logger?: Logger;
}

/** Outcome of one node attempt: a result (possibly an ok:false non-auth error) or an auth failure. */
type Attempt<T> =
  | { kind: "ok"; result: TransportResult<T> }
  | { kind: "auth"; error: unknown };

/**
 * Owns the signIn lifecycle and wraps every SQL call with lazy-signIn + a single
 * auth-failure retry. SQL helpers (./sql.ts) call {@link Session.run}.
 */
export class Session {
  private readonly transport: Transport;
  private readonly worker: Worker;
  private readonly reSignInMs: number;
  private readonly clock: Clock;
  private readonly logger: Logger;

  /** Cached established session; null until first signIn (or after a forced re-signIn). */
  private established: SignInResult | null = null;
  /** In-flight signIn promise — the dedupe point for concurrent first-callers. */
  private signInInFlight: Promise<SignInResult> | null = null;
  /** Proactive refresh timer; unref()'d so it never holds the process open. */
  private refreshTimer: TimerHandle | null = null;
  /** After stop(): reject new work, let in-flight settle. */
  private stopped = false;
  /** In-flight run() promises — stop() flushes these (bounded). */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(options: SessionOptions) {
    this.transport = options.transport;
    this.worker = options.worker;
    this.reSignInMs = options.reSignInMs;
    this.clock = options.clock ?? realClock;
    this.logger = options.logger ?? consoleLogger;
  }

  /**
   * Lazily establish the session, deduping concurrent callers. Subsequent calls
   * return the cached result until a forced re-signIn invalidates it.
   */
  async ensureSignedIn(): Promise<SignInResult> {
    if (this.stopped) {
      throw new TinyCloudClientError("agent-client: session stopped; cannot sign in");
    }
    if (this.established) return this.established;
    if (this.signInInFlight) return this.signInInFlight;
    this.signInInFlight = this.doSignIn();
    try {
      this.established = await this.signInInFlight;
      return this.established;
    } finally {
      this.signInInFlight = null;
    }
  }

  /**
   * Run a node call through the worker (reads → read lane, writes → write lane),
   * with lazy signIn and EXACTLY ONE auth-failure retry. Returns the transport
   * Result; ./sql.ts unwraps it into data-or-SqlError. Non-auth failures (timeout,
   * circuit-open, SQL errors) propagate unchanged.
   */
  run<T>(lane: Lane, op: () => Promise<TransportResult<T>>, label?: string): Promise<TransportResult<T>> {
    if (this.stopped) {
      return Promise.reject(
        new TinyCloudClientError("agent-client: client stopped; rejecting new work"),
      );
    }
    return this.track(this.runWithAuthRetry(lane, op, label));
  }

  /** Clear timers, reject new work, and flush in-flight calls bounded to ~5s. */
  async stop(): Promise<{ flushed: boolean; pending: number }> {
    this.stopped = true;
    if (this.refreshTimer !== null) {
      this.clock.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const pending = [...this.inFlight];
    if (pending.length === 0) return { flushed: true, pending: 0 };

    const settledAll = Promise.allSettled(pending).then(() => true);
    const flushed = await Promise.race([
      settledAll,
      this.delay(STOP_FLUSH_MS).then(() => false),
    ]);
    if (!flushed) {
      this.logger.warn("agent-client: stop() flush budget elapsed; calls still in flight", {
        pending: this.inFlight.size,
      });
    }
    return { flushed, pending: this.inFlight.size };
  }

  // --- internals ---------------------------------------------------------

  private async runWithAuthRetry<T>(
    lane: Lane,
    op: () => Promise<TransportResult<T>>,
    label?: string,
  ): Promise<TransportResult<T>> {
    await this.ensureSignedIn();

    const first = await this.attempt(lane, op, label);
    if (first.kind === "ok") return first.result;

    // Auth failure → EXACTLY ONE re-signIn + ONE retry (never a loop).
    this.logger.warn("agent-client: auth failure; re-signing in once then retrying", {
      op: label,
    });
    await this.reSignIn();

    const second = await this.attempt(lane, op, label);
    if (second.kind === "ok") return second.result;
    throw new AuthError(
      `auth failure persisted after re-signIn (op ${label ?? "request"})`,
      { cause: second.error },
    );
  }

  /** One worker dispatch, classifying the outcome as a result or an auth failure. */
  private async attempt<T>(
    lane: Lane,
    op: () => Promise<TransportResult<T>>,
    label?: string,
  ): Promise<Attempt<T>> {
    try {
      const result = await this.submit(lane, op, label);
      if (!result.ok && authLike(result.error.code, result.error.message)) {
        return { kind: "auth", error: new AuthError(result.error.message) };
      }
      return { kind: "ok", result };
    } catch (error) {
      // Only genuine auth errors trigger a re-signIn; timeouts / circuit-open /
      // other rejections propagate untouched.
      if (this.isAuthError(error)) return { kind: "auth", error };
      throw error;
    }
  }

  private submit<T>(
    lane: Lane,
    op: () => Promise<TransportResult<T>>,
    label?: string,
  ): Promise<TransportResult<T>> {
    const run = op as Job<TransportResult<T>>;
    return lane === "read" ? this.worker.read(run, label) : this.worker.write(run, label);
  }

  private isAuthError(error: unknown): boolean {
    if (error instanceof AuthError) return true;
    if (typeof error === "object" && error !== null) {
      const e = error as { code?: string; message?: string };
      return authLike(e.code, e.message);
    }
    return false;
  }

  /** Force a fresh signIn, invalidating the cached session and deduping concurrent callers. */
  private async reSignIn(): Promise<SignInResult> {
    this.established = null;
    return this.ensureSignedIn();
  }

  private async doSignIn(): Promise<SignInResult> {
    const result = await this.transport.signIn();
    this.scheduleRefresh();
    return result;
  }

  /** (Re)arm the proactive refresh timer; the handle is unref()'d (must not pin the process). */
  private scheduleRefresh(): void {
    if (this.stopped) return;
    if (this.refreshTimer !== null) {
      this.clock.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = this.armUnref(() => {
      void this.proactiveRefresh();
    }, this.reSignInMs);
  }

  private async proactiveRefresh(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.reSignIn();
      // doSignIn re-arms the timer on success.
    } catch (error) {
      this.logger.warn(
        "agent-client: proactive re-signIn failed; will retry lazily on next 401",
        { reason: error instanceof Error ? error.name : "unknown" },
      );
      // Keep the proactive cadence alive even after a failed refresh.
      this.scheduleRefresh();
    }
  }

  /** setTimeout via the clock seam, with .unref() applied when the handle supports it. */
  private armUnref(handler: () => void, ms: number): TimerHandle {
    const handle = this.clock.setTimeout(handler, ms);
    const maybe = handle as { unref?: () => void };
    if (typeof maybe?.unref === "function") maybe.unref();
    return handle;
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.armUnref(() => resolve(), ms);
    });
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise as Promise<unknown>;
    this.inFlight.add(tracked);
    const done = (): void => {
      this.inFlight.delete(tracked);
    };
    promise.then(done, done);
    return promise;
  }
}
