// POST /sessions and GET /sessions/:entityId handlers (plan §2, T3/T4).
//
// Validation chain (plan §2 invariants):
//   1. deserializeDelegationSafe        → 400 "malformed" on throw
//   2. validateDelegationShape          → 400 "invalid_shape" on DelegationShapeError
//   3. validateDelegationPolicy         → 400 (e.reason.toLowerCase()) on DelegationPolicyError
//   4. storageFor(agentId).registerDelegation(entityId, serialized, roomId?)
//   5. store.set(entityId, record)      → C-local liveness cache (no B-registry accessor)
//   6. evaluateDelegationStatus         → { entityId, status } in 200 body
//
// TinyChat bundles are persisted before POST confirms and deleted before DELETE
// confirms (SessionPersistence, see held-sessions.ts), so a restart neither
// loses a connection nor undoes a Disconnect. validateBundle() is shared with
// the reload path.
//
// GET /sessions/:entityId re-deserializes from the C-local store. Non-EXPIRED
// DelegationPolicyErrors from evaluateDelegationStatus are rethrown → 400.
//
// Security invariants:
// - serializedDelegation / agentKey MUST NOT appear in any error message, log, or throw.
// - registerDelegation is the ONLY write path to B's registry from C.
// - No AgentClient is constructed here; no write methods are called directly.

import {
  deserializeDelegationSafe,
  validateDelegationShape,
  validateDelegationPolicy,
  defaultElizaMemoryPolicy,
  evaluateDelegationStatus,
  defaultTinychatTranscriptPolicy,
  deserializeAndNormalize,
  deserializeTranscriptDelegationForActivation,
  signedOwnerAddress,
  validateExactDelegationPolicy,
  DelegationShapeError,
  DelegationPolicyError,
} from "@tinycloud/agent-client";
import { MEMORY_DB_HANDLE } from "@tinycloud/eliza-plugin-memory";
import type { SessionLease, SessionRecord, SessionStore, SessionScope } from "../session-store.js";

/** Durable publication of an entity's session state (see held-sessions.ts). */
export interface SessionPersistence {
  /** Resolves true once the entity's latest state is durable. */
  sync(scope: SessionScope, entityId: string): Promise<boolean>;
  /** Stop restoring this entity (a Disconnect arrived first). */
  forget?(scope: SessionScope, entityId: string): void;
}

/**
 * Minimal host interface consumed by sessions handlers.
 * RuntimeHost satisfies this interface; tests inject a fake.
 */
export interface SessionHandlerHost {
  readonly agentDid: string;
  storageFor(agentId: string): Promise<{
    registerDelegation(entityId: string, serialized: string, roomId?: string, isCurrent?: () => boolean, canUse?: () => boolean): Promise<void>;
  }>;
  registerTranscriptDelegation?(agentId: string, entityId: string, serializedDelegation: string, roomId?: string, isCurrent?: () => boolean, canUse?: () => boolean): Promise<void>;
  /** Detach both clients synchronously, then return their bounded cleanup. */
  disconnectEntity?(agentId: string, entityId: string): Promise<void>;
  /** Installed, unexpired candidates; session state separately controls admission. */
  privateAccessAvailable?(agentId: string, entityId: string): boolean;
}

export interface PostSessionsBody {
  agentId: string;
  entityId: string;
  /** Opaque serialized delegation — never log or leak. */
  serializedDelegation?: string;
  roomId?: string;
  revision?: string;
  /** V2 envelope. v1 serializedDelegation remains accepted during migration. */
  session?: { version: 2; delegations: { memory: string; transcripts: string }; roomId?: string };
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

/** A bundle that passed every registration check. */
export interface ValidatedBundle {
  memory: string;
  transcripts?: string;
  roomId?: string;
  /** Effective signed expiries, epoch ms. */
  expiries: { memory?: number; transcripts?: number };
}

export type BundleValidation = { ok: true; bundle: ValidatedBundle } | { ok: false; result: HandlerResult };

/**
 * Every registration check, shared by POST /sessions and by reloading a stored
 * grant after a restart (stored records are untrusted input):
 *   1. deserializeDelegationSafe         → 400 "malformed"
 *   2. transcript exact policy, 30-day ceiling and owner match
 *   3. validateDelegationShape           → 400 "invalid_shape"
 *   4. validateDelegationPolicy          → 400 (reason)
 *   5. memory 30-day ceiling             → 400 "delegation_expiry_too_long"
 * Signatures are verified by the node when the grants are activated.
 */
export function validateBundle(input: { memory: string; transcripts?: string; roomId?: string }, agentDid: string): BundleValidation {
  const { memory: serializedDelegation, transcripts: serializedTranscriptDelegation } = input;
  const policy = defaultElizaMemoryPolicy();
  const fail = (status: number, body: unknown): BundleValidation => ({ ok: false, result: { status, body } });

  // 1. Deserialize
  let deleg;
  try {
    deleg = deserializeDelegationSafe(serializedDelegation);
  } catch {
    return fail(400, { error: "malformed" });
  }

  // V2 has a separately activated fixed-policy transcript grant. Compact UCANs
  // are normalized from signed att; current CID-backed children are policy-
  // checked here and cryptographically verified by the host during activation.
  let transcriptExpiry: number | undefined;
  if (serializedTranscriptDelegation !== undefined) {
    try {
      const transcriptDelegation = deserializeTranscriptDelegationForActivation(serializedTranscriptDelegation);
      validateExactDelegationPolicy(transcriptDelegation, {
        agentDID: agentDid,
        policy: defaultTinychatTranscriptPolicy(),
      });
      // The 30-day ceiling is read from the SIGNED `exp` claim when the UCAN
      // carries one; the top-level `expiry` summary is unsigned and forgeable,
      // so a short summary must not launder a long-lived signed grant.
      transcriptExpiry = effectiveExpiry(serializedTranscriptDelegation, transcriptDelegation) ?? undefined;
      if (transcriptExpiry === undefined || transcriptExpiry - Date.now() > MAX_GRANT_EXPIRY_MS) {
        return fail(400, { error: "delegation_expiry_too_long" });
      }
      const memoryOwner = signedOwnerAddress(deserializeAndNormalize(serializedDelegation));
      const transcriptOwner = signedOwnerAddress(transcriptDelegation);
      if (!memoryOwner || !transcriptOwner || memoryOwner.toLowerCase() !== transcriptOwner.toLowerCase()) {
        return fail(400, { error: "wrong_delegator" });
      }
    } catch (e) {
      if (e instanceof DelegationPolicyError) return fail(400, { error: transcriptErrorCode(e) });
      return fail(400, { error: "malformed" });
    }
  }

  // 2. Shape validation (shallow: ownerAddress, delegateDID, expiry, SQL presence)
  try {
    validateDelegationShape(deleg, { agentDid, dbHandle: MEMORY_DB_HANDLE });
  } catch (e) {
    if (e instanceof DelegationShapeError) return fail(400, { error: "invalid_shape", message: e.message });
    throw e;
  }

  // 3. Policy validation — delegateDID==agentDID + expiry + resource path + actions
  try {
    validateDelegationPolicy(deleg, { agentDID: agentDid, policy });
  } catch (e) {
    if (e instanceof DelegationPolicyError) {
      return fail(400, { error: (e.reason as string).toLowerCase(), message: e.message });
    }
    throw e;
  }

  // 4. The memory grant has the same 30-day ceiling as the transcript grant.
  //    Without it a memory-only grant had no maximum lifetime once idle
  //    expiry was removed, and persisting grants would extend that further.
  const memoryExpiry = effectiveExpiry(serializedDelegation, deleg);
  if (memoryExpiry === null || memoryExpiry - Date.now() > MAX_GRANT_EXPIRY_MS) {
    return fail(400, { error: "delegation_expiry_too_long" });
  }

  return { ok: true, bundle: {
    memory: serializedDelegation,
    transcripts: serializedTranscriptDelegation,
    roomId: input.roomId,
    expiries: { memory: memoryExpiry, ...(transcriptExpiry !== undefined ? { transcripts: transcriptExpiry } : {}) },
  } };
}

/**
 * Activate a validated TinyChat bundle under a reserved lease: detach any old
 * candidates, register memory then transcripts, and require both installed.
 * Returns false when the lease was superseded. Throws activation failures.
 */
export async function activateBundle(
  host: SessionHandlerHost,
  agentId: string,
  entityId: string,
  lease: SessionLease,
  bundle: ValidatedBundle,
): Promise<boolean> {
  if (!host.disconnectEntity || !host.registerTranscriptDelegation || !host.privateAccessAvailable || bundle.transcripts === undefined) {
    throw new Error("private access unavailable");
  }
  await host.disconnectEntity(agentId, entityId);
  if (!lease.isCurrent()) return false;
  const storage = await host.storageFor(agentId);
  if (!lease.isCurrent()) return false;
  await storage.registerDelegation(entityId, bundle.memory, bundle.roomId, lease.isCurrent, lease.isActive);
  if (!lease.isCurrent()) return false;
  await host.registerTranscriptDelegation(agentId, entityId, bundle.transcripts, bundle.roomId, lease.isCurrent, lease.isActive);
  if (!lease.isCurrent()) return false;
  if (!host.privateAccessAvailable(agentId, entityId)) throw new Error("private access unavailable");
  return true;
}

export function bundleRecord(agentId: string, bundle: ValidatedBundle): SessionRecord {
  const expiries = [bundle.expiries.memory, bundle.expiries.transcripts].filter((value): value is number => value !== undefined);
  return {
    agentId,
    serializedDelegation: bundle.memory,
    serializedTranscriptDelegation: bundle.transcripts,
    roomId: bundle.roomId,
    ...(expiries.length ? { exp: Math.min(...expiries) } : {}),
    expiries: { ...bundle.expiries },
  };
}

export async function handlePostSessions(
  body: PostSessionsBody,
  host: SessionHandlerHost,
  store: SessionStore,
  scope?: SessionScope,
  persistence?: SessionPersistence,
): Promise<HandlerResult> {
  const { agentId, entityId } = body;
  const envelope = body.session;
  const bundled = scope?.appId === "tinychat";
  if (bundled) {
    if (typeof body.revision !== "string" || body.revision !== store.snapshot(scope, entityId).revision) {
      return { status: 409, body: { error: "stale_revision" } };
    }
    if (envelope?.version !== 2 || typeof envelope.delegations?.memory !== "string" || typeof envelope.delegations?.transcripts !== "string") {
      return { status: 400, body: { error: "bundle_required" } };
    }
  }
  const serializedDelegation = envelope?.delegations.memory ?? body.serializedDelegation;
  const serializedTranscriptDelegation = envelope?.delegations.transcripts;
  const roomId = envelope?.roomId ?? body.roomId;
  if (typeof serializedDelegation !== "string") return { status: 400, body: { error: "invalid_body" } };

  const validation = validateBundle({ memory: serializedDelegation, transcripts: serializedTranscriptDelegation, roomId }, host.agentDid);
  if (!validation.ok) return validation.result;
  const bundle = validation.bundle;

  if (bundled) {
    if (!host.disconnectEntity || !host.registerTranscriptDelegation || !host.privateAccessAvailable) {
      return { status: 503, body: { error: "private_access_unavailable" } };
    }
    // Reserve before the first await. Both old candidates and every admitted
    // lease are unusable from this point, including during bounded cleanup.
    const lease = store.reserve(scope, entityId, body.revision);
    if (!lease) return { status: 409, body: { error: "stale_revision" } };
    // A new ceremony replaces any pending reload of the stored grant.
    persistence?.forget?.(scope, entityId);
    const stale = () => ({ status: 409, body: { error: "stale_revision" } });
    try {
      if (!await activateBundle(host, agentId, entityId, lease, bundle)) return stale();
      const record = bundleRecord(agentId, bundle);
      // Persist before confirming: a connection a restart would lose is never
      // reported as connected. The write publishes this record only while the
      // lease is current, ordered after every earlier write for the entity.
      if (persistence) {
        if (!store.stage(scope, entityId, lease, record)) return stale();
        const durable = await persistence.sync(scope, entityId);
        if (!lease.isCurrent()) return stale();
        if (!durable) throw new Error("private access not persisted");
      }
      if (!store.commit(scope, entityId, lease, record)) return stale();
      return { status: 200, body: { entityId, status: "active", transcriptStatus: "active", revision: lease.revision, state: "active" } };
    } catch (error) {
      // Cleanup can only own the current generation. Detachment is synchronous
      // so a new ceremony cannot be deleted by this operation after an await.
      if (!lease.isCurrent()) return stale();
      store.fail(scope, entityId, lease);
      // Publish "none" so a write that landed late cannot be restored later.
      if (persistence) void persistence.sync(scope, entityId);
      try { await host.disconnectEntity(agentId, entityId); } catch { /* inactive; report failure below */ }
      return { status: error instanceof DelegationPolicyError ? 400 : 503,
        body: { error: error instanceof DelegationPolicyError ? transcriptErrorCode(error) : "private_access_unavailable" } };
    }
  }

  // Unrelated applications retain their existing memory-only contract.
  const storage = await host.storageFor(agentId);
  await storage.registerDelegation(entityId, serializedDelegation, roomId);
  if (serializedTranscriptDelegation) {
    if (!host.registerTranscriptDelegation) return { status: 503, body: { error: "transcript_unavailable" } };
    try {
      await host.registerTranscriptDelegation(agentId, entityId, serializedTranscriptDelegation, roomId);
    } catch (e) {
      // Activation failed (node unreachable, or the grant fails the exact policy
      // at activation time). Memory registration stands; transcripts fail closed
      // with a stable code and no delegation material in the body.
      if (e instanceof DelegationPolicyError) return { status: 400, body: { error: transcriptErrorCode(e) } };
      return { status: 503, body: { error: "transcript_unavailable" } };
    }
  }

  // 5. Record in C-local store so GET /sessions can re-evaluate liveness without
  //    touching entity-registry.ts (B's frozen keystone)
  store.set(entityId, { agentId, serializedDelegation, serializedTranscriptDelegation, roomId });

  // 6. Return liveness status
  const status = evaluateDelegationStatus({ delegation: deserializeDelegationSafe(serializedDelegation), policy: defaultElizaMemoryPolicy(), agentDID: host.agentDid });
  return {
    status: 200,
    body: {
      entityId,
      status,
      // Additive, and only on the v2 envelope so the v1 response stays exactly
      // as it was: v2 callers can tell WHICH grant needs reconnecting instead
      // of re-minting both.
      ...(serializedTranscriptDelegation ? { transcriptStatus: "active" } : {}),
    },
  };
}

export async function handleGetSessions(
  entityId: string,
  host: SessionHandlerHost,
  store: SessionStore,
  scope?: SessionScope,
): Promise<HandlerResult> {
  const snapshot = scope?.appId === "tinychat" ? store.snapshot(scope, entityId) : undefined;
  const metadata = snapshot ? { revision: snapshot.revision, state: snapshot.state } : {};
  // A stored grant is still being reloaded after a restart: never report "none".
  if (snapshot?.state === "restoring") {
    return { status: 503, body: { error: "private_access_restoring", ...metadata } };
  }
  // A reloaded grant the node reported revoked stays reported until reconnect.
  if (snapshot?.state === "revoked") {
    return { status: 200, body: { entityId, status: "revoked", ...metadata } };
  }
  const record = snapshot ? snapshot.record : store.get(entityId);
  // Installed access is gone. A lapsed signed grant still reports "expired" (the
  // reconnect reason) through the evaluation below; anything else stays "none".
  if (snapshot && (snapshot.state !== "active"
    || (!host.privateAccessAvailable?.(scope!.agentId, entityId) && !(record && storedGrantExpired(record, host.agentDid))))) {
    return { status: 404, body: { status: "none", ...metadata } };
  }
  if (!record) {
    return { status: 404, body: { status: "none", ...metadata } };
  }

  let deleg;
  try {
    deleg = deserializeDelegationSafe(record.serializedDelegation);
  } catch {
    return { status: 404, body: { status: "none", ...metadata } };
  }

  const policy = defaultElizaMemoryPolicy();

  let delegStatus: "active" | "expired" | "stale" | "none";
  try {
    // evaluateDelegationStatus rethrows non-EXPIRED DelegationPolicyErrors (plan §1 correction #2)
    delegStatus = evaluateDelegationStatus({ delegation: deleg, policy, agentDID: host.agentDid });
  } catch (e) {
    if (e instanceof DelegationPolicyError) {
      return {
        status: 400,
        body: { error: (e.reason as string).toLowerCase(), message: e.message },
      };
    }
    throw e;
  }

  let transcriptStatus: string | undefined;
  if (record.serializedTranscriptDelegation) {
    try {
      const transcript = deserializeTranscriptDelegationForActivation(record.serializedTranscriptDelegation);
      transcriptStatus = evaluateDelegationStatus({
        delegation: transcript,
        policy: defaultTinychatTranscriptPolicy(),
        agentDID: host.agentDid,
      });
    } catch (e) {
      if (e instanceof DelegationPolicyError && e.reason === "EXPIRED") transcriptStatus = "expired";
      else return { status: 400, body: { error: "invalid_transcript_delegation" } };
    }
    // Agent enablement requires BOTH grants, so the combined status degrades to
    // the weaker one; `transcriptStatus` says which grant caused it.
    if (transcriptStatus !== "active") delegStatus = transcriptStatus as typeof delegStatus;
  }

  return { status: 200, body: { entityId, status: delegStatus, ...(transcriptStatus ? { transcriptStatus } : {}), ...metadata } };
}

export async function handleDeleteSessions(entityId: string, host: SessionHandlerHost, store: SessionStore, scope: SessionScope, persistence?: SessionPersistence): Promise<HandlerResult> {
  if (scope.appId !== "tinychat") return { status: 404, body: { error: "not_found" } };
  const snapshot = store.disconnect(scope, entityId);
  // Remove the stored grant before confirming, so a restart never undoes a
  // Disconnect. A failed delete keeps retrying in the background; in-memory
  // access is detached regardless.
  persistence?.forget?.(scope, entityId);
  const removed = persistence ? persistence.sync(scope, entityId) : Promise.resolve(true);
  let detached = true;
  try {
    if (!host.disconnectEntity) throw new Error("private access unavailable");
    await host.disconnectEntity(scope.agentId, entityId);
  } catch {
    detached = false;
  }
  if (!await removed || !detached) {
    return { status: 503, body: { error: "disconnect_unconfirmed", revision: snapshot.revision } };
  }
  return { status: 200, body: { entityId, status: "none", revision: snapshot.revision, state: "disconnected" } };
}

/**
 * True when either stored signed grant has passed its expiry. Explains why
 * private access is unavailable; it never grants or restores access.
 */
export function storedGrantExpired(record: SessionRecord, agentDid: string): boolean {
  const expired = (status: () => string): boolean => {
    try { return status() === "expired"; } catch (e) { return e instanceof DelegationPolicyError && e.reason === "EXPIRED"; }
  };
  const transcript = record.serializedTranscriptDelegation;
  return expired(() => evaluateDelegationStatus({
    delegation: deserializeDelegationSafe(record.serializedDelegation), policy: defaultElizaMemoryPolicy(), agentDID: agentDid,
  })) || (transcript !== undefined && expired(() => evaluateDelegationStatus({
    delegation: deserializeTranscriptDelegationForActivation(transcript), policy: defaultTinychatTranscriptPolicy(), agentDID: agentDid,
  })));
}

/** Map a policy rejection to a stable, non-revealing session error code. */
function transcriptErrorCode(error: DelegationPolicyError): string {
  switch (error.reason) {
    case "WRONG_DELEGATEE": return "wrong_delegatee";
    case "EXPIRED": return "delegation_expired";
    case "INSUFFICIENT_ACTIONS": return "transcript_policy_exceeded";
    default: return "malformed";
  }
}

/** TinyChat mints its agent delegations for at most 30 days; allow up to that. */
const MAX_GRANT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Effective expiry (epoch ms) for ceiling checks: the later of the signed UCAN
 * `exp` claim and the top-level summary, so a short unsigned summary cannot
 * launder a long-lived signed grant. Null when the summary is unreadable.
 * Never throws and never echoes token bytes.
 */
function effectiveExpiry(
  serialized: string,
  delegation: { expiry?: unknown },
): number | null {
  const summary = delegation.expiry instanceof Date
    ? delegation.expiry
    : new Date(delegation.expiry as unknown as string);
  if (!Number.isFinite(summary.getTime())) return null;
  const signedExpSecs = signedExpirySeconds(serialized);
  return signedExpSecs === null
    ? summary.getTime()
    : Math.max(summary.getTime(), signedExpSecs * 1_000);
}

function signedExpirySeconds(serialized: string): number | null {
  try {
    const parsed = JSON.parse(serialized) as { delegationHeader?: { Authorization?: unknown } };
    const auth = parsed.delegationHeader?.Authorization;
    if (typeof auth !== "string") return null;
    const segment = auth.replace(/^Bearer\s+/i, "").split(".")[1];
    if (!segment) return null;
    const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}
