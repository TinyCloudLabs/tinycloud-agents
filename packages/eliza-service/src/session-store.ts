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
  roomId?: string;
  /** SQL db handle the delegation was validated against (per-agent path). */
  dbHandle?: string;
}

export class SessionStore {
  private readonly _sessions = new Map<string, SessionRecord>();

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
