// C-local session store — keeps a Map<entityId, SessionRecord> so liveness can
// be re-evaluated via GET /sessions/:entityId WITHOUT touching B's EntityClientRegistry.
//
// C already holds the serialized delegation from POST /sessions; this store
// caches it so the GET handler can re-deserialize and call evaluateDelegationStatus
// without adding any accessor to entity-registry.ts (B's frozen keystone).
//
// Invariants:
// - All writes go through set() after registerDelegation succeeds (never before).
// - Reading this store never reaches the TinyCloud node or SQLite.
// - agentKey / serializedDelegation are stored as-is (opaque to this layer) but
//   MUST NOT appear in any log output — this responsibility lives in the callers.

export interface SessionRecord {
  agentId: string;
  /** Stored verbatim — never log or leak this value. */
  serializedDelegation: string;
  /** V2 only: independently scoped transcript delegation. */
  serializedTranscriptDelegation?: string;
  roomId?: string;
  /** Earliest signed expiry of the bundle (epoch ms), when known. */
  exp?: number;
  /** Signed expiry of each grant (epoch ms), when known. */
  expiries?: { memory?: number; transcripts?: number };
}

export interface SessionScope { appId: string; agentId: string }
export interface SessionSnapshot {
  revision: string;
  /**
   * "restoring": a persisted grant is being reloaded after a restart; its
   * revision is the persisted one. "revoked": a reloaded grant the node
   * reported revoked (a tombstone, no delegation material).
   */
  state: "none" | "activating" | "active" | "disconnected" | "restoring" | "revoked";
  record?: SessionRecord;
  /** Tombstones only: expiry of the revoked bundle, for garbage collection. */
  exp?: number;
  /** Tombstones only: when the revocation was observed (epoch ms). */
  revokedAt?: number;
}
export interface SessionLease {
  revision: string;
  /** Whether the bundle was active when this lease was captured. */
  active: boolean;
  isCurrent(): boolean;
  isActive(): boolean;
}

export class SessionStore {
  private readonly _sessions = new Map<string, SessionRecord>();
  private readonly instance = crypto.randomUUID();
  private sequence = 0;
  private readonly access = new Map<string, SessionSnapshot>();
  /** Activation records awaiting a durable write before commit (POST /sessions). */
  private readonly persisting = new Map<string, { revision: string; record: SessionRecord }>();
  private readonly listeners = new Set<(scope: SessionScope, entityId: string) => void>();

  snapshot(scope: SessionScope, entityId: string): SessionSnapshot {
    const key = this.key(scope, entityId);
    let state = this.access.get(key);
    if (!state) {
      state = { revision: this.nextRevision(), state: "none" };
      this.access.set(key, state);
    }
    return { ...state };
  }

  lease(scope: SessionScope, entityId: string): SessionLease {
    const snapshot = this.snapshot(scope, entityId);
    const isCurrent = () => this.access.get(this.key(scope, entityId))?.revision === snapshot.revision;
    return {
      revision: snapshot.revision,
      active: snapshot.state === "active",
      isCurrent,
      isActive: () => isCurrent() && this.access.get(this.key(scope, entityId))?.state === "active",
    };
  }

  reserve(scope: SessionScope, entityId: string, expectedRevision?: string): SessionLease | null {
    if (expectedRevision !== undefined && this.snapshot(scope, entityId).revision !== expectedRevision) return null;
    this.replace(scope, entityId, "activating");
    return this.lease(scope, entityId);
  }

  commit(scope: SessionScope, entityId: string, lease: SessionLease, record: SessionRecord): boolean {
    if (!lease.isCurrent() || this.snapshot(scope, entityId).state !== "activating") return false;
    this.access.set(this.key(scope, entityId), { revision: lease.revision, state: "active", record });
    this.persisting.delete(this.key(scope, entityId));
    return true;
  }

  /**
   * Mark an activated, not yet committed record as the state to persist. The
   * grant store writes it only while this lease is still current.
   */
  stage(scope: SessionScope, entityId: string, lease: SessionLease, record: SessionRecord): boolean {
    if (!lease.isCurrent() || this.snapshot(scope, entityId).state !== "activating") return false;
    this.persisting.set(this.key(scope, entityId), { revision: lease.revision, record });
    return true;
  }

  /** Record staged by stage() for the current activating revision, if any. */
  staged(scope: SessionScope, entityId: string): { revision: string; record: SessionRecord } | undefined {
    const current = this.peek(scope, entityId);
    const staged = this.persisting.get(this.key(scope, entityId));
    return current?.state === "activating" && staged?.revision === current.revision ? staged : undefined;
  }

  /** Current state without creating an entry. */
  peek(scope: SessionScope, entityId: string): SessionSnapshot | undefined {
    const state = this.access.get(this.key(scope, entityId));
    return state ? { ...state } : undefined;
  }

  /** True once this process has any access state for the entity. */
  known(scope: SessionScope, entityId: string): boolean {
    return this.access.has(this.key(scope, entityId));
  }

  /**
   * Begin reloading a persisted grant under its persisted revision. Refuses
   * when the entity already has state in this process (for example a
   * Disconnect or a new connection), so a reload can never override either.
   */
  beginRestore(scope: SessionScope, entityId: string, revision: string): SessionLease | null {
    if (this.known(scope, entityId)) return null;
    this.access.set(this.key(scope, entityId), { revision, state: "restoring" });
    return this.lease(scope, entityId);
  }

  /**
   * Finish a reload with the persisted revision. Expired bundles are restored
   * the same way but are never registered, so they report "expired".
   */
  restore(scope: SessionScope, entityId: string, lease: SessionLease, record: SessionRecord): boolean {
    if (!lease.isCurrent() || this.snapshot(scope, entityId).state !== "restoring") return false;
    this.access.set(this.key(scope, entityId), { revision: lease.revision, state: "active", record });
    return true;
  }

  /** Keep a revoked grant as a tombstone so revocation is still reported. */
  tombstone(scope: SessionScope, entityId: string, lease: SessionLease, marks: { exp?: number; revokedAt: number }): boolean {
    const state = this.snapshot(scope, entityId).state;
    if (!lease.isCurrent() || (state !== "restoring" && state !== "revoked")) return false;
    this.access.set(this.key(scope, entityId), { revision: lease.revision, state: "revoked", ...marks });
    return true;
  }

  /** Abandon a reload that can never succeed; the entity reads as never connected. */
  abandonRestore(scope: SessionScope, entityId: string, lease: SessionLease): void {
    if (lease.isCurrent() && this.snapshot(scope, entityId).state === "restoring") this.replace(scope, entityId, "none");
  }

  fail(scope: SessionScope, entityId: string, lease: SessionLease): void {
    if (lease.isCurrent()) this.replace(scope, entityId, "none");
  }

  disconnect(scope: SessionScope, entityId: string): SessionSnapshot {
    this.replace(scope, entityId, "disconnected");
    return this.snapshot(scope, entityId);
  }

  onInvalidate(listener: (scope: SessionScope, entityId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private replace(scope: SessionScope, entityId: string, state: SessionSnapshot["state"]): void {
    this.persisting.delete(this.key(scope, entityId));
    this.access.set(this.key(scope, entityId), { revision: this.nextRevision(), state });
    for (const listener of this.listeners) listener(scope, entityId);
  }

  private key(scope: SessionScope, entityId: string): string { return JSON.stringify([scope.appId, scope.agentId, entityId]); }
  private nextRevision(): string { return `${this.instance}:${++this.sequence}`; }

  set(entityId: string, record: SessionRecord): void {
    this._sessions.set(entityId, record);
  }

  get(entityId: string): SessionRecord | undefined {
    return this._sessions.get(entityId);
  }

  has(entityId: string): boolean {
    return this._sessions.has(entityId);
  }

  /** Number of sessions currently tracked. Useful for diagnostics; never expose secrets. */
  get size(): number {
    return this._sessions.size;
  }
}
