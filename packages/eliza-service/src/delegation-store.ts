// Delegation store: the delegations this agent holds, kept in the agent's OWN
// TinyCloud space so they survive restarts and redeploys.
//
// TinyChat "Connect agent" bundles (memory + transcript delegations plus the
// session's access revision) are the first use. Records are plain JSON under
// readable keys, `delegations/v1/{appId}/{agentId}/{entityId}`; other kinds of
// delegation the agent receives can live under the same layout later.
//
// Why plain: a delegation is not a bearer secret. Only the delegatee can invoke
// it, because every invocation needs a signature from the agent's own key. The
// store never holds that key, session keys or invocations.
//
// Invariants:
// - Delegation material never reaches a log, error message or HTTP body (log
//   hygiene). Logs carry counts and stable codes only.
// - Writes for one entity are serialized, and each write publishes the
//   service's LATEST in-memory state for that entity when it runs. A slow write
//   from an older request therefore cannot land after a newer Disconnect.
// - Reloaded records are untrusted input: callers re-validate every delegation
//   (policy, delegatee, expiry, ceilings) and re-activate it on the node, which
//   verifies the signatures.

import { TinyCloudNode } from "@tinycloud/node-sdk";
import { AGENT_SESSION_EXPIRATION_MS } from "@tinycloud/agent-client";

/** Dedicated space name in the agent's account. */
export const DELEGATION_STORE_SPACE = "eliza-delegations";
const KEY_PREFIX = "delegations/v1";
const MAX_REVISION_LENGTH = 256;
const SEGMENT = /^[A-Za-z0-9._:-]{1,128}$/;

export class DelegationStoreError extends Error {
  constructor(readonly code: "store_unavailable" | "invalid_key") {
    super(`delegation store: ${code}`);
    this.name = "DelegationStoreError";
  }
}

export interface HolderScope { appId: string; agentId: string }

/** One TinyChat connection the agent holds. */
export interface HeldSession {
  v: 1;
  kind: "tinychat-session";
  appId: string;
  agentId: string;
  entityId: string;
  /** The access revision TinyChat holds; restored verbatim. */
  revision: string;
  /** "active": a connected bundle. "revoked": a tombstone without delegations. */
  state: "active" | "revoked";
  delegations: { memory?: string; transcripts?: string };
  /** Signed expiries, epoch ms. */
  expiries: { memory?: number; transcripts?: number };
  roomId?: string;
  revokedAt?: number;
  storedAt: number;
}

export type ReadResult = { ok: true; session: HeldSession } | { ok: false; reason: "invalid" };

export function delegationKey(scope: HolderScope, entityId: string): string {
  return `${scopePrefix(scope)}${segment(entityId)}`;
}

export function scopePrefix(scope: HolderScope): string {
  return `${KEY_PREFIX}/${segment(scope.appId)}/${segment(scope.agentId)}/`;
}

function segment(value: string): string {
  if (!SEGMENT.test(value) || value.includes("..")) throw new DelegationStoreError("invalid_key");
  return value;
}

/** Parse and shape-check a stored record. Never echoes record content. */
export function parseHeldSession(scope: HolderScope, entityId: string, raw: string): ReadResult {
  let value: HeldSession;
  try { value = JSON.parse(raw) as HeldSession; } catch { return { ok: false, reason: "invalid" }; }
  const optionalString = (field: unknown) => field === undefined || typeof field === "string";
  const optionalTime = (field: unknown) => field === undefined || (typeof field === "number" && Number.isFinite(field));
  const valid = !!value && typeof value === "object"
    && value.v === 1 && value.kind === "tinychat-session"
    && value.appId === scope.appId && value.agentId === scope.agentId && value.entityId === entityId
    && typeof value.revision === "string" && value.revision.length > 0 && value.revision.length <= MAX_REVISION_LENGTH
    && (value.state === "active" || value.state === "revoked")
    && !!value.delegations && typeof value.delegations === "object"
    && optionalString(value.delegations.memory) && optionalString(value.delegations.transcripts)
    && (value.state === "revoked" || (typeof value.delegations.memory === "string" && typeof value.delegations.transcripts === "string"))
    && !!value.expiries && typeof value.expiries === "object"
    && optionalTime(value.expiries.memory) && optionalTime(value.expiries.transcripts)
    && optionalString(value.roomId) && optionalTime(value.revokedAt)
    && typeof value.storedAt === "number" && Number.isFinite(value.storedAt);
  return valid ? { ok: true, session: value } : { ok: false, reason: "invalid" };
}

/** Earliest known expiry of a held session (epoch ms), or undefined. */
export function heldSessionExpiry(session: Pick<HeldSession, "expiries">): number | undefined {
  const values = [session.expiries.memory, session.expiries.transcripts].filter((value): value is number => value !== undefined);
  return values.length ? Math.min(...values) : undefined;
}

// ── KV backends ──────────────────────────────────────────────────────────────

/** The agent-space KV surface the store needs. Values are JSON strings. */
export interface DelegationKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** All keys under prefix, full key paths. */
  list(prefix: string): Promise<string[]>;
}

/** In-memory KV for tests. */
export class MemoryDelegationKv implements DelegationKv {
  readonly data = new Map<string, string>();
  async get(key: string) { return this.data.get(key) ?? null; }
  async put(key: string, value: string) { this.data.set(key, value); }
  async delete(key: string) { this.data.delete(key); }
  async list(prefix: string) { return [...this.data.keys()].filter(key => key.startsWith(prefix)).sort(); }
}

type KvResult<T> = { ok: true; data: T } | { ok: false; error?: { code?: unknown; message?: unknown; status?: unknown } };

/** Minimal TinyCloudNode surface (injectable for tests). */
export interface DelegationStoreNode {
  signIn(): Promise<unknown>;
  kv: {
    get(key: string, options?: { raw?: boolean }): Promise<KvResult<{ data?: unknown }>>;
    put(key: string, value: unknown): Promise<KvResult<unknown>>;
    delete(key: string): Promise<KvResult<unknown>>;
    list(options?: { path?: string; limit?: number; cursor?: string }): Promise<KvResult<{ keys: string[]; truncated?: boolean; nextCursor?: string }>>;
  };
}

/**
 * KV in the agent's own TinyCloud space. Mirrors the TinyChat backend's
 * delegation store: a TinyCloudNode with the service key and a dedicated space
 * name, Result-checked operations, and one re-sign-in on auth failures.
 */
export class TinyCloudDelegationKv implements DelegationKv {
  private readonly node: DelegationStoreNode;
  private signedIn?: Promise<unknown>;

  constructor(opts: { privateKey: string; host: string; space?: string; node?: DelegationStoreNode }) {
    this.node = opts.node ?? new TinyCloudNode({
      privateKey: opts.privateKey,
      host: opts.host,
      prefix: opts.space ?? DELEGATION_STORE_SPACE,
      autoCreateSpace: true,
      sessionExpirationMs: AGENT_SESSION_EXPIRATION_MS,
    }) as unknown as DelegationStoreNode;
  }

  async get(key: string): Promise<string | null> {
    const result = await this.call(() => this.node.kv.get(key, { raw: true }));
    if (!result.ok) {
      if (isMissingKey(result)) return null;
      throw new DelegationStoreError("store_unavailable");
    }
    const value = result.data?.data;
    if (typeof value === "string") return value;
    if (value && typeof value === "object") return JSON.stringify(value);
    return null;
  }

  async put(key: string, value: string): Promise<void> {
    const result = await this.call(() => this.node.kv.put(key, value));
    if (!result.ok) throw new DelegationStoreError("store_unavailable");
  }

  async delete(key: string): Promise<void> {
    const result = await this.call(() => this.node.kv.delete(key));
    if (!result.ok && !isMissingKey(result)) throw new DelegationStoreError("store_unavailable");
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10_000; page++) {
      const result = await this.call(() => this.node.kv.list({ path: prefix, limit: 500, ...(cursor ? { cursor } : {}) }));
      if (!result.ok) {
        if (isMissingKey(result)) return keys;
        throw new DelegationStoreError("store_unavailable");
      }
      keys.push(...result.data.keys.filter(key => key.startsWith(prefix)));
      if (!result.data.truncated || !result.data.nextCursor) return keys;
      cursor = result.data.nextCursor;
    }
    throw new DelegationStoreError("store_unavailable");
  }

  private async call<T>(operation: () => Promise<KvResult<T>>): Promise<KvResult<T>> {
    try {
      await this.ensureSignedIn();
      let result = await operation();
      if (!result.ok && isAuthFailure(result)) {
        this.signedIn = undefined;
        await this.ensureSignedIn();
        result = await operation();
      }
      return result;
    } catch {
      this.signedIn = undefined;
      throw new DelegationStoreError("store_unavailable");
    }
  }

  private ensureSignedIn(): Promise<unknown> {
    if (!this.signedIn) {
      const attempt = this.node.signIn();
      this.signedIn = attempt;
      attempt.catch(() => { if (this.signedIn === attempt) this.signedIn = undefined; });
    }
    return this.signedIn;
  }
}

function isMissingKey(result: { ok: false; error?: { code?: unknown; message?: unknown } }): boolean {
  return result.error?.code === "KV_NOT_FOUND" && typeof result.error.message === "string" && /^Key not found/i.test(result.error.message);
}

function isAuthFailure(result: { ok: false; error?: { code?: unknown; status?: unknown } }): boolean {
  const code = result.error?.code;
  return code === "AUTH_REQUIRED" || code === "AUTH_EXPIRED" || code === "AUTH_UNAUTHORIZED" || result.error?.status === 401;
}

// ── Store ────────────────────────────────────────────────────────────────────

/** What the service currently wants persisted for one entity. */
export type DesiredRecord = { kind: "put"; session: HeldSession } | { kind: "delete" } | { kind: "keep" };

interface EntityQueue {
  tail: Promise<void>;
  /** A write is queued and has not yet read the desired state. */
  queued?: Promise<boolean>;
  retry?: ReturnType<typeof setTimeout>;
  attempts: number;
}

/**
 * Held delegations with per-entity write ordering.
 *
 * `sync()` queues a write that reads the desired state when it RUNS, not when
 * it was queued. Writes for one entity run strictly one at a time, so the last
 * write always publishes the latest state.
 */
export class DelegationStore {
  private readonly queues = new Map<string, EntityQueue>();
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private stopped = false;

  constructor(private readonly kv: DelegationKv, opts: { retryBaseMs?: number; retryMaxMs?: number } = {}) {
    this.retryBaseMs = opts.retryBaseMs ?? 1_000;
    this.retryMaxMs = opts.retryMaxMs ?? 60_000;
  }

  /** Entity ids with a stored record in this scope. */
  async list(scope: HolderScope): Promise<string[]> {
    const prefix = scopePrefix(scope);
    return (await this.kv.list(prefix))
      .map(key => key.slice(prefix.length))
      .filter(entityId => SEGMENT.test(entityId) && !entityId.includes(".."));
  }

  /** Read one record. `null` when none is stored. Throws when the store is unreachable. */
  async read(scope: HolderScope, entityId: string): Promise<ReadResult | null> {
    const raw = await this.kv.get(delegationKey(scope, entityId));
    return raw === null ? null : parseHeldSession(scope, entityId, raw);
  }

  /**
   * Publish the desired state for an entity, ordered after every earlier write
   * for it. Resolves true when the published state is durable; false when the
   * write failed. Failed deletes keep retrying in the background.
   */
  sync(scope: HolderScope, entityId: string, desired: () => DesiredRecord): Promise<boolean> {
    let key: string;
    try { key = delegationKey(scope, entityId); } catch { return Promise.resolve(false); }
    const queue = this.queues.get(key) ?? { tail: Promise.resolve(), attempts: 0 };
    this.queues.set(key, queue);
    if (queue.queued) return queue.queued;
    if (queue.retry) { clearTimeout(queue.retry); queue.retry = undefined; }
    const run: Promise<boolean> = queue.tail.then(async () => {
      if (queue.queued === run) queue.queued = undefined;
      const want = desired();
      try {
        if (want.kind === "put") await this.kv.put(key, JSON.stringify(want.session));
        else if (want.kind === "delete") await this.kv.delete(key);
        queue.attempts = 0;
        return true;
      } catch {
        // A Disconnect must become durable even after the caller was told
        // disconnect_unconfirmed, so a failed delete keeps retrying.
        if (want.kind === "delete" && !this.stopped) this.scheduleRetry(queue, scope, entityId, desired);
        return false;
      }
    });
    queue.queued = run;
    queue.tail = run.then(() => {}, () => {});
    void queue.tail.then(() => { if (!queue.queued && !queue.retry && this.queues.get(key) === queue) this.queues.delete(key); });
    return run;
  }

  /** Entities with a failed delete still being retried. */
  get pendingRetries(): number {
    let count = 0;
    for (const queue of this.queues.values()) if (queue.retry) count++;
    return count;
  }

  /** Wait (bounded) for queued writes, e.g. on shutdown. */
  async flush(timeoutMs = 5_000): Promise<void> {
    const pending = [...this.queues.values()].map(queue => queue.tail);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled(pending), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    if (timer) clearTimeout(timer);
  }

  stop(): void {
    this.stopped = true;
    for (const queue of this.queues.values()) if (queue.retry) { clearTimeout(queue.retry); queue.retry = undefined; }
  }

  private scheduleRetry(queue: EntityQueue, scope: HolderScope, entityId: string, desired: () => DesiredRecord): void {
    queue.attempts++;
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(queue.attempts - 1, 16));
    queue.retry = setTimeout(() => {
      queue.retry = undefined;
      void this.sync(scope, entityId, desired);
    }, delay);
    (queue.retry as { unref?: () => void }).unref?.();
  }
}

/** `ELIZA_DELEGATION_STORE=off` disables persistence (development/test only). */
export function delegationStoreEnabled(env: Record<string, string | undefined>): boolean {
  const value = env.ELIZA_DELEGATION_STORE;
  if (value === undefined || value === "" || value === "on") return true;
  if (value === "off") {
    if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
      throw new Error("ELIZA_DELEGATION_STORE=off requires NODE_ENV=development or test");
    }
    return false;
  }
  throw new Error("ELIZA_DELEGATION_STORE must be on or off");
}
