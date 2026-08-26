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
  signedOwnerAddress,
  validateExactDelegationPolicy,
  DelegationShapeError,
  DelegationPolicyError,
} from "@tinycloud/agent-client";
import { MEMORY_DB_HANDLE } from "@tinycloud/eliza-plugin-memory";
import type { SessionStore } from "../session-store.js";

/**
 * Minimal host interface consumed by sessions handlers.
 * RuntimeHost satisfies this interface; tests inject a fake.
 */
export interface SessionHandlerHost {
  readonly agentDid: string;
  storageFor(agentId: string): Promise<{
    registerDelegation(entityId: string, serialized: string, roomId?: string): Promise<void>;
  }>;
  registerTranscriptDelegation?(agentId: string, entityId: string, serializedDelegation: string, roomId?: string): Promise<void>;
}

export interface PostSessionsBody {
  agentId: string;
  entityId: string;
  /** Opaque serialized delegation — never log or leak. */
  serializedDelegation?: string;
  roomId?: string;
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
): Promise<HandlerResult> {
  const { agentId, entityId } = body;
  const envelope = body.session;
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

  // V2 has a separately activated fixed-policy transcript grant. Its signed att,
  // not top-level summaries, is the only capability input accepted here.
  let transcriptDelegation: ReturnType<typeof deserializeAndNormalize> | undefined;
  if (serializedTranscriptDelegation !== undefined) {
    try {
      transcriptDelegation = deserializeAndNormalize(serializedTranscriptDelegation);
      validateExactDelegationPolicy(transcriptDelegation, {
        agentDID: host.agentDid,
        policy: defaultTinychatTranscriptPolicy(),
      });
      const expiry = transcriptDelegation.expiry instanceof Date ? transcriptDelegation.expiry : new Date(transcriptDelegation.expiry as unknown as string);
      if (expiry.getTime() - Date.now() > 7 * 24 * 60 * 60 * 1000) {
        return { status: 400, body: { error: "delegation_expiry_too_long" } };
      }
      const memoryOwner = signedOwnerAddress(deserializeAndNormalize(serializedDelegation));
      const transcriptOwner = signedOwnerAddress(transcriptDelegation);
      if (!memoryOwner || !transcriptOwner || memoryOwner.toLowerCase() !== transcriptOwner.toLowerCase()) {
        return { status: 400, body: { error: "wrong_delegator" } };
      }
    } catch (e) {
      if (e instanceof DelegationPolicyError) return { status: 400, body: { error: (e.reason as string).toLowerCase() } };
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

  // 4. Register via B's seam — the ONLY write path from C into B's registry
  const storage = await host.storageFor(agentId);
  await storage.registerDelegation(entityId, serializedDelegation, roomId);
  if (serializedTranscriptDelegation) {
    if (!host.registerTranscriptDelegation) return { status: 503, body: { error: "transcript_unavailable" } };
    await host.registerTranscriptDelegation(agentId, entityId, serializedTranscriptDelegation, roomId);
  }

  // 5. Record in C-local store so GET /sessions can re-evaluate liveness without
  //    touching entity-registry.ts (B's frozen keystone)
  store.set(entityId, { agentId, serializedDelegation, serializedTranscriptDelegation, roomId });

  // 6. Return liveness status
  const status = evaluateDelegationStatus({ delegation: deleg, policy, agentDID: host.agentDid });
  return { status: 200, body: { entityId, status: serializedTranscriptDelegation ? status : status } };
}

export async function handleGetSessions(
  entityId: string,
  host: SessionHandlerHost,
  store: SessionStore,
): Promise<HandlerResult> {
  const record = store.get(entityId);
  if (!record) {
    return { status: 404, body: { status: "none" } };
  }

  let deleg;
  try {
    deleg = deserializeDelegationSafe(record.serializedDelegation);
  } catch {
    return { status: 404, body: { status: "none" } };
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

  if (record.serializedTranscriptDelegation) {
    try {
      const transcript = deserializeAndNormalize(record.serializedTranscriptDelegation);
      const transcriptStatus = evaluateDelegationStatus({
        delegation: transcript,
        policy: defaultTinychatTranscriptPolicy(),
        agentDID: host.agentDid,
      });
      if (transcriptStatus !== "active") delegStatus = transcriptStatus;
    } catch (e) {
      if (e instanceof DelegationPolicyError && e.reason === "EXPIRED") delegStatus = "expired";
      else return { status: 400, body: { error: "invalid_transcript_delegation" } };
    }
  }

  return { status: 200, body: { entityId, status: delegStatus } };
}
