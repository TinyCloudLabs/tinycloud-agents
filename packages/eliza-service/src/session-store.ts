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
}

export interface SessionScope { appId: string; agentId: string }
export interface SessionSnapshot {
  revision: string;
  state: "none" | "activating" | "active" | "disconnected";
  record?: SessionRecord;
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
    return true;
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
