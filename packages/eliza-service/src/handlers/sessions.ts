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
import type { SessionStore, SessionScope } from "../session-store.js";

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

export async function handlePostSessions(
  body: PostSessionsBody,
  host: SessionHandlerHost,
  store: SessionStore,
  scope?: SessionScope,
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
  const policy = defaultElizaMemoryPolicy();

  // 1. Deserialize
  let deleg;
  try {
    deleg = deserializeDelegationSafe(serializedDelegation);
  } catch {
    return { status: 400, body: { error: "malformed" } };
  }

  // V2 has a separately activated fixed-policy transcript grant. Compact UCANs
  // are normalized from signed att; current CID-backed children are policy-
  // checked here and cryptographically verified by the host during activation.
  let transcriptDelegation: ReturnType<typeof deserializeTranscriptDelegationForActivation> | undefined;
  if (serializedTranscriptDelegation !== undefined) {
    try {
      transcriptDelegation = deserializeTranscriptDelegationForActivation(serializedTranscriptDelegation);
      validateExactDelegationPolicy(transcriptDelegation, {
        agentDID: host.agentDid,
        policy: defaultTinychatTranscriptPolicy(),
      });
      // The 7-day ceiling is read from the SIGNED `exp` claim when the UCAN
      // carries one; the top-level `expiry` summary is unsigned and forgeable,
      // so a short summary must not launder a long-lived signed grant.
      if (!withinTranscriptExpiryCeiling(serializedTranscriptDelegation, transcriptDelegation)) {
        return { status: 400, body: { error: "delegation_expiry_too_long" } };
      }
      const memoryOwner = signedOwnerAddress(deserializeAndNormalize(serializedDelegation));
      const transcriptOwner = signedOwnerAddress(transcriptDelegation);
      if (!memoryOwner || !transcriptOwner || memoryOwner.toLowerCase() !== transcriptOwner.toLowerCase()) {
        return { status: 400, body: { error: "wrong_delegator" } };
      }
    } catch (e) {
      if (e instanceof DelegationPolicyError) return { status: 400, body: { error: transcriptErrorCode(e) } };
      return { status: 400, body: { error: "malformed" } };
    }
  }

  // 2. Shape validation (shallow: ownerAddress, delegateDID, expiry, SQL presence)
  try {
    validateDelegationShape(deleg, { agentDid: host.agentDid, dbHandle: MEMORY_DB_HANDLE });
  } catch (e) {
    if (e instanceof DelegationShapeError) {
      return { status: 400, body: { error: "invalid_shape", message: e.message } };
    }
    throw e;
  }

  // 3. Policy validation — delegateDID==agentDID + expiry + resource path + actions
  try {
    validateDelegationPolicy(deleg, { agentDID: host.agentDid, policy });
  } catch (e) {
    if (e instanceof DelegationPolicyError) {
      return {
        status: 400,
        body: { error: (e.reason as string).toLowerCase(), message: e.message },
      };
    }
    throw e;
  }

  if (bundled) {
    if (!host.disconnectEntity || !host.registerTranscriptDelegation || !host.privateAccessAvailable) {
      return { status: 503, body: { error: "private_access_unavailable" } };
    }
    // Reserve before the first await. Both old candidates and every admitted
    // lease are unusable from this point, including during bounded cleanup.
    const lease = store.reserve(scope, entityId, body.revision);
    if (!lease) return { status: 409, body: { error: "stale_revision" } };
    const stale = () => ({ status: 409, body: { error: "stale_revision" } });
    try {
      await host.disconnectEntity(agentId, entityId);
      if (!lease.isCurrent()) return stale();
      const storage = await host.storageFor(agentId);
      if (!lease.isCurrent()) return stale();
      await storage.registerDelegation(entityId, serializedDelegation, roomId, lease.isCurrent, lease.isActive);
      if (!lease.isCurrent()) return stale();
      await host.registerTranscriptDelegation(agentId, entityId, serializedTranscriptDelegation!, roomId, lease.isCurrent, lease.isActive);
      if (!lease.isCurrent()) return stale();
      if (!host.privateAccessAvailable(agentId, entityId)) throw new Error("private access unavailable");
      if (!store.commit(scope, entityId, lease, { agentId, serializedDelegation, serializedTranscriptDelegation, roomId })) return stale();
      return { status: 200, body: { entityId, status: "active", transcriptStatus: "active", revision: lease.revision, state: "active" } };
    } catch (error) {
      // Cleanup can only own the current generation. Detachment is synchronous
      // so a new ceremony cannot be deleted by this operation after an await.
      if (!lease.isCurrent()) return stale();
      store.fail(scope, entityId, lease);
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
  const status = evaluateDelegationStatus({ delegation: deleg, policy, agentDID: host.agentDid });
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
  const record = snapshot ? snapshot.record : store.get(entityId);
  if (snapshot && (snapshot.state !== "active" || !host.privateAccessAvailable?.(scope!.agentId, entityId))) {
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

export async function handleDeleteSessions(entityId: string, host: SessionHandlerHost, store: SessionStore, scope: SessionScope): Promise<HandlerResult> {
  if (scope.appId !== "tinychat") return { status: 404, body: { error: "not_found" } };
  const snapshot = store.disconnect(scope, entityId);
  try {
    if (!host.disconnectEntity) throw new Error("private access unavailable");
    await host.disconnectEntity(scope.agentId, entityId);
  } catch {
    return { status: 503, body: { error: "disconnect_unconfirmed", revision: snapshot.revision } };
  }
  return { status: 200, body: { entityId, status: "none", revision: snapshot.revision, state: "disconnected" } };
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

const MAX_TRANSCRIPT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Enforce the transcript grant's 7-day ceiling against the signed UCAN `exp`
 * claim, falling back to the (already policy-validated) top-level expiry only
 * when the token carries no `exp`. Never throws and never echoes token bytes.
 */
function withinTranscriptExpiryCeiling(
  serialized: string,
  delegation: { expiry?: unknown },
): boolean {
  const summary = delegation.expiry instanceof Date
    ? delegation.expiry
    : new Date(delegation.expiry as unknown as string);
  if (!Number.isFinite(summary.getTime())) return false;
  const signedExpSecs = signedExpirySeconds(serialized);
  const effective = signedExpSecs === null
    ? summary.getTime()
    : Math.max(summary.getTime(), signedExpSecs * 1_000);
  return effective - Date.now() <= MAX_TRANSCRIPT_EXPIRY_MS;
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
