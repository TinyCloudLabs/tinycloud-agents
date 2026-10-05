// Held TinyChat sessions: persistence and restore-after-restart.
//
// Joins the in-memory SessionStore (access revisions) to the durable
// DelegationStore (the agent's own space):
// - sync() publishes an entity's CURRENT state: active → stored record,
//   revoked → tombstone, none/disconnected → deleted, activating/restoring →
//   unchanged (or the staged record of a POST that is about to commit).
// - start() lists stored records and reloads them in the background with
//   limited concurrency, eagerly up to the registry capacity and lazily on
//   demand after that. settle() lets a request for a waiting entity jump the
//   queue. Until an entity has settled, callers answer 503
//   private_access_restoring, never "none".
//
// Reloading an entity:
// - The record is untrusted input: every delegation is re-validated with the
//   same checks as POST /sessions, then re-activated on the node (which
//   verifies the signatures) under the PERSISTED revision, so revisions
//   TinyChat already holds stay valid.
// - Expired bundles load as active but unregistered, so they report
//   "expired". 7 days after expiry they are deleted.
// - A node revocation observed on activation becomes a tombstone ("revoked").
// - Node errors back off and retry; the entity keeps reporting "restoring".
// - Local state always wins: an entity that already has state in this process
//   (a Disconnect or a new connection) is never overwritten by a reload.

import {
  DelegationPolicyError,
  defaultElizaMemoryPolicy,
  defaultTinychatTranscriptPolicy,
  deserializeDelegationSafe,
  deserializeTranscriptDelegationForActivation,
  evaluateDelegationStatus,
} from "@tinycloud/agent-client";
import { DelegationExpiredError } from "@tinycloud/eliza-plugin-memory";
import type { DelegationStore, DesiredRecord, HeldSession } from "./delegation-store.js";
import { heldSessionExpiry } from "./delegation-store.js";
import { activateBundle, bundleRecord, validateBundle, type SessionHandlerHost, type SessionPersistence } from "./handlers/sessions.js";
import type { SessionLease, SessionRecord, SessionScope, SessionStore } from "./session-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Expired and revoked records are kept this long after expiry, then deleted. */
export const EXPIRED_GRANT_RETENTION_MS = 7 * DAY_MS;

export interface HeldSessionsOptions {
  store: DelegationStore;
  sessions: SessionStore;
  host: SessionHandlerHost;
  /** The application scope whose sessions are held (TinyChat). */
  scope: SessionScope;
  /** Parallel reloads (default 8). */
  concurrency?: number;
  /** Reload eagerly up to this many entities (default: registry capacity). */
  eagerLimit?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Content-free operational log line. Defaults to console.log. */
  log?: (line: string) => void;
}

type Outcome = "done" | "retry";

export interface HeldSessionsHealth {
  state: "indexing" | "restoring" | "ready" | "stopped";
  /** Stored entities not yet reloaded (eager queue, lazy backlog, in flight, backing off). */
  restoring: number;
}

export class HeldSessions implements SessionPersistence {
  private readonly store: DelegationStore;
  private readonly sessions: SessionStore;
  private readonly host: SessionHandlerHost;
  private readonly scope: SessionScope;
  private readonly concurrency: number;
  private readonly eagerLimit: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly log: (line: string) => void;

  private phase: "idle" | "indexing" | "ready" | "stopped" = "idle";
  private indexed?: Promise<void>;
  private resolveIndexed?: () => void;
  /** Stored, not yet settled. */
  private readonly pending = new Set<string>();
  /** Eager order; lazy entities are pending but not queued. */
  private readonly queue: string[] = [];
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly backoff = new Map<string, { attempts: number; until: number; timer?: ReturnType<typeof setTimeout> }>();
  private readonly leases = new Map<string, SessionLease>();
  private readonly settledWaiters = new Map<string, Set<() => void>>();
  private indexTimer?: ReturnType<typeof setTimeout>;
  private running = 0;
  private readonly counts = { restored: 0, expired: 0, revoked: 0, invalid: 0, deleted: 0 };

  constructor(opts: HeldSessionsOptions) {
    this.store = opts.store;
    this.sessions = opts.sessions;
    this.host = opts.host;
    this.scope = opts.scope;
    this.concurrency = Math.max(1, opts.concurrency ?? 8);
    this.eagerLimit = Math.max(0, opts.eagerLimit ?? registryCapacity());
    this.retryBaseMs = opts.retryBaseMs ?? 1_000;
    this.retryMaxMs = opts.retryMaxMs ?? 60_000;
    this.log = opts.log ?? (line => console.log(line));
    this.indexed = new Promise(resolve => { this.resolveIndexed = resolve; });
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  sync(scope: SessionScope, entityId: string): Promise<boolean> {
    if (!this.holds(scope)) return Promise.resolve(true);
    return this.store.sync(scope, entityId, () => this.desired(scope, entityId));
  }

  forget(scope: SessionScope, entityId: string): void {
    if (!this.holds(scope)) return;
    this.settle(entityId);
  }

  private desired(scope: SessionScope, entityId: string): DesiredRecord {
    const current = this.sessions.peek(scope, entityId);
    if (!current) return { kind: "keep" };
    switch (current.state) {
      case "active":
        return current.record?.serializedTranscriptDelegation !== undefined
          ? { kind: "put", session: heldSession(scope, entityId, current.revision, current.record) }
          : { kind: "keep" };
      case "activating": {
        const staged = this.sessions.staged(scope, entityId);
        return staged ? { kind: "put", session: heldSession(scope, entityId, staged.revision, staged.record) } : { kind: "keep" };
      }
      case "revoked":
        return { kind: "put", session: {
          v: 1, kind: "tinychat-session", appId: scope.appId, agentId: scope.agentId, entityId,
          revision: current.revision, state: "revoked", delegations: {},
          expiries: current.exp !== undefined ? { memory: current.exp } : {},
          revokedAt: current.revokedAt ?? Date.now(), storedAt: Date.now(),
        } };
      case "restoring":
        return { kind: "keep" };
      case "none":
      case "disconnected":
        return { kind: "delete" };
    }
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  /** List stored grants and begin reloading them in the background. */
  start(): void {
    if (this.phase !== "idle") return;
    this.phase = "indexing";
    void this.index(0);
  }

  /** True while the scope's index is loading or this entity awaits reload. */
  isRestoring(scope: SessionScope, entityId: string): boolean {
    if (!this.holds(scope) || this.phase === "idle" || this.phase === "stopped") return false;
    return this.phase === "indexing" || this.pending.has(entityId) || this.sessions.peek(scope, entityId)?.state === "restoring";
  }

  /**
   * Prioritize one entity and wait (bounded) for it to settle. Resolves true
   * when the entity is no longer restoring.
   */
  async settled(scope: SessionScope, entityId: string, waitMs: number): Promise<boolean> {
    if (!this.isRestoring(scope, entityId)) return true;
    const deadline = Date.now() + waitMs;
    if (this.phase === "indexing") {
      await withTimeout(this.indexed!, waitMs);
      if (this.phase === "indexing") return false;
    }
    if (!this.isRestoring(scope, entityId)) return true;
    if (this.pending.has(entityId)) {
      const waiting = new Promise<void>(resolve => {
        const set = this.settledWaiters.get(entityId) ?? new Set();
        set.add(resolve);
        this.settledWaiters.set(entityId, set);
      });
      this.prioritize(entityId);
      await withTimeout(waiting, Math.max(0, deadline - Date.now()));
    }
    return !this.isRestoring(scope, entityId);
  }

  health(): HeldSessionsHealth {
    const state = this.phase === "idle" ? "ready" : this.phase === "indexing" ? "indexing" : this.phase === "stopped" ? "stopped" : this.pending.size ? "restoring" : "ready";
    return { state, restoring: this.pending.size };
  }

  /** Resolves once the index is loaded and no eager reload is queued or running (tests, e2e). */
  async whenIdle(): Promise<void> {
    await this.indexed;
    while (this.running > 0 || this.queue.some(entityId => this.pending.has(entityId))) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  stop(): void {
    this.phase = "stopped";
    if (this.indexTimer) clearTimeout(this.indexTimer);
    for (const entry of this.backoff.values()) if (entry.timer) clearTimeout(entry.timer);
    this.resolveIndexed?.();
  }

  private async index(attempt: number): Promise<void> {
    if (this.phase !== "indexing") return;
    let entityIds: string[];
    try {
      entityIds = await this.store.list(this.scope);
    } catch {
      const delay = this.delay(attempt + 1);
      this.log(`[eliza-service] delegation store unavailable; retrying grant index in ${delay}ms`);
      this.indexTimer = setTimeout(() => { void this.index(attempt + 1); }, delay);
      (this.indexTimer as { unref?: () => void }).unref?.();
      return;
    }
    if (this.phase !== "indexing") return;
    for (const entityId of entityIds) {
      // Local state recorded while indexing (a Disconnect, a new connection) wins.
      if (this.sessions.known(this.scope, entityId)) continue;
      this.pending.add(entityId);
    }
    this.queue.push(...[...this.pending].slice(0, this.eagerLimit));
    this.phase = "ready";
    this.log(`[eliza-service] grant index loaded: stored=${entityIds.length} eager=${this.queue.length} lazy=${this.pending.size - this.queue.length}`);
    this.resolveIndexed?.();
    this.pump();
  }

  private prioritize(entityId: string): void {
    if (!this.pending.has(entityId) || this.inflight.has(entityId)) return;
    const index = this.queue.indexOf(entityId);
    if (index >= 0) this.queue.splice(index, 1);
    const waiting = this.backoff.get(entityId);
    // A request jumps the queue but does not bypass an active backoff.
    if (waiting && waiting.until > Date.now()) return;
    void this.run(entityId);
  }

  private pump(): void {
    while (this.phase === "ready" && this.running < this.concurrency && this.queue.length) {
      const entityId = this.queue.shift()!;
      if (!this.pending.has(entityId) || this.inflight.has(entityId)) continue;
      const waiting = this.backoff.get(entityId);
      if (waiting && waiting.until > Date.now()) continue; // its timer re-queues it
      void this.run(entityId);
    }
  }

  private run(entityId: string): Promise<void> {
    const existing = this.inflight.get(entityId);
    if (existing) return existing;
    this.running++;
    const work = (async () => {
      let outcome: Outcome;
      try {
        outcome = await this.restore(entityId);
      } catch {
        outcome = "retry";
      }
      if (outcome === "retry" && this.phase === "ready" && this.pending.has(entityId)) this.retryLater(entityId);
      else this.settle(entityId);
    })().finally(() => {
      this.running--;
      this.inflight.delete(entityId);
      this.pump();
    });
    this.inflight.set(entityId, work);
    return work;
  }

  private retryLater(entityId: string): void {
    const previous = this.backoff.get(entityId);
    const attempts = (previous?.attempts ?? 0) + 1;
    const delay = this.delay(attempts);
    const entry: { attempts: number; until: number; timer?: ReturnType<typeof setTimeout> } = { attempts, until: Date.now() + delay };
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      entry.until = 0; // the timer, not the wall clock, ends the backoff
      if (this.pending.has(entityId)) { this.queue.unshift(entityId); this.pump(); }
    }, delay);
    (entry.timer as { unref?: () => void }).unref?.();
    this.backoff.set(entityId, entry);
  }

  private settle(entityId: string): void {
    this.pending.delete(entityId);
    const waiting = this.backoff.get(entityId);
    if (waiting?.timer) clearTimeout(waiting.timer);
    this.backoff.delete(entityId);
    const lease = this.leases.get(entityId);
    this.leases.delete(entityId);
    if (lease) this.sessions.abandonRestore(this.scope, entityId, lease); // no-op unless still restoring
    for (const resolve of this.settledWaiters.get(entityId) ?? []) resolve();
    this.settledWaiters.delete(entityId);
  }

  /** Reload one entity. Never throws delegation material. */
  private async restore(entityId: string): Promise<Outcome> {
    const scope = this.scope;
    let lease = this.leases.get(entityId);
    if (lease && !lease.isCurrent()) return "done"; // superseded locally
    if (!lease && this.sessions.known(scope, entityId)) return "done";

    const read = await this.store.read(scope, entityId); // throws → retry
    if (lease ? !lease.isCurrent() : this.sessions.known(scope, entityId)) return "done";
    if (!read) return "done";
    if (!read.ok) { this.counts.invalid++; this.log("[eliza-service] stored grant ignored: invalid record"); return "done"; }
    const held = read.session;

    if (!lease) {
      const begun = this.sessions.beginRestore(scope, entityId, held.revision);
      if (!begun) return "done";
      lease = begun;
      this.leases.set(entityId, lease);
    }

    const exp = heldSessionExpiry(held);
    if (exp !== undefined && Date.now() >= exp + EXPIRED_GRANT_RETENTION_MS) {
      // Retention over: forget it locally and delete the stored record.
      this.sessions.abandonRestore(scope, entityId, lease);
      this.leases.delete(entityId);
      this.counts.deleted++;
      void this.sync(scope, entityId);
      return "done";
    }

    if (held.state === "revoked") {
      this.sessions.tombstone(scope, entityId, lease, { exp, revokedAt: held.revokedAt ?? held.storedAt });
      this.leases.delete(entityId);
      this.counts.revoked++;
      return "done";
    }

    const record: SessionRecord = {
      agentId: scope.agentId,
      serializedDelegation: held.delegations.memory!,
      serializedTranscriptDelegation: held.delegations.transcripts!,
      roomId: held.roomId,
      ...(exp !== undefined ? { exp } : {}),
      expiries: { ...held.expiries },
    };

    // Expired: re-validate everything except time, then load unregistered so
    // it reports "expired" (the reconnect reason) instead of "none".
    if (expiredBundle(record, this.host.agentDid)) {
      if (!validExpiredBundle(record, this.host.agentDid)) return this.invalid(entityId, lease);
      this.sessions.restore(scope, entityId, lease, record);
      this.leases.delete(entityId);
      this.counts.expired++;
      return "done";
    }

    const validation = validateBundle({ memory: record.serializedDelegation, transcripts: record.serializedTranscriptDelegation, roomId: record.roomId }, this.host.agentDid);
    if (!validation.ok) return this.invalid(entityId, lease);

    try {
      if (!await activateBundle(this.host, scope.agentId, entityId, lease, validation.bundle)) return "done";
    } catch (error) {
      if (!lease.isCurrent()) return "done";
      try { await this.host.disconnectEntity?.(scope.agentId, entityId); } catch { /* detached below */ }
      if (!lease.isCurrent()) return "done";
      if (isRevocation(error)) {
        this.sessions.tombstone(scope, entityId, lease, { exp, revokedAt: Date.now() });
        this.leases.delete(entityId);
        this.counts.revoked++;
        void this.sync(scope, entityId);
        return "done";
      }
      if (error instanceof DelegationExpiredError || (error instanceof DelegationPolicyError && error.reason === "EXPIRED")) {
        this.sessions.restore(scope, entityId, lease, record);
        this.leases.delete(entityId);
        this.counts.expired++;
        return "done";
      }
      if (error instanceof DelegationPolicyError) return this.invalid(entityId, lease);
      this.log(`[eliza-service] grant reload failed (${errorCode(error)}); will retry`);
      return "retry";
    }
    if (!this.sessions.restore(scope, entityId, lease, bundleRecord(scope.agentId, validation.bundle))) return "done";
    this.leases.delete(entityId);
    this.counts.restored++;
    return "done";
  }

  private invalid(entityId: string, lease: SessionLease): Outcome {
    // Not deleted: a policy change must not silently destroy stored grants.
    // The record is replaced by the next connection or removed by Disconnect.
    this.sessions.abandonRestore(this.scope, entityId, lease);
    this.leases.delete(entityId);
    this.counts.invalid++;
    this.log("[eliza-service] stored grant ignored: failed re-validation");
    return "done";
  }

  private delay(attempt: number): number {
    return Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(attempt - 1, 16));
  }

  private holds(scope: SessionScope): boolean {
    return scope.appId === this.scope.appId && scope.agentId === this.scope.agentId;
  }
}

function heldSession(scope: SessionScope, entityId: string, revision: string, record: SessionRecord): HeldSession {
  return {
    v: 1, kind: "tinychat-session", appId: scope.appId, agentId: scope.agentId, entityId, revision, state: "active",
    delegations: { memory: record.serializedDelegation, transcripts: record.serializedTranscriptDelegation },
    expiries: { ...(record.expiries ?? {}) },
    ...(record.roomId !== undefined ? { roomId: record.roomId } : {}),
    storedAt: Date.now(),
  };
}

/** Either grant's signed expiry has passed. */
function expiredBundle(record: SessionRecord, agentDid: string): boolean {
  return statusOf(record, agentDid).some(status => status === "expired");
}

/** Every check except time passes (delegatee, resources, actions). */
function validExpiredBundle(record: SessionRecord, agentDid: string): boolean {
  return statusOf(record, agentDid).every(status => status === "active" || status === "expired");
}

function statusOf(record: SessionRecord, agentDid: string): string[] {
  const evaluate = (fn: () => string): string => {
    try { return fn(); } catch (e) { return e instanceof DelegationPolicyError && e.reason === "EXPIRED" ? "expired" : "invalid"; }
  };
  const transcripts = record.serializedTranscriptDelegation;
  return [
    evaluate(() => evaluateDelegationStatus({ delegation: deserializeDelegationSafe(record.serializedDelegation), policy: defaultElizaMemoryPolicy(), agentDID: agentDid })),
    transcripts === undefined ? "invalid" : evaluate(() => evaluateDelegationStatus({ delegation: deserializeTranscriptDelegationForActivation(transcripts), policy: defaultTinychatTranscriptPolicy(), agentDID: agentDid })),
  ];
}

/** The node rejected a grant as revoked (code or message, anywhere in the cause chain). */
export function isRevocation(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 6; depth++) {
    const value = current as { code?: unknown; message?: unknown; cause?: unknown; error?: unknown };
    if (typeof value.code === "string" && /REVOKED/i.test(value.code)) return true;
    if (typeof value.message === "string" && /\brevoked\b/i.test(value.message)) return true;
    current = value.cause ?? value.error;
  }
  return false;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code)) return code;
  const name = (error as { name?: unknown })?.name;
  return typeof name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "error";
}

function registryCapacity(): number {
  const memory = Number(process.env.ELIZA_REGISTRY_MAX_CLIENTS) || 256;
  const transcripts = Number(process.env.ELIZA_TRANSCRIPT_REGISTRY_MAX_CLIENTS) || 256;
  return Math.min(memory, transcripts);
}

async function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]);
  if (timer) clearTimeout(timer);
}
