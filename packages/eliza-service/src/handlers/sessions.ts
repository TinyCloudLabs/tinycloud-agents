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
  /** The DID this service advertises as the delegation target for agentId. */
  agentDidFor(agentId: string): Promise<string>;
  storageFor(agentId: string): Promise<{
    registerDelegation(entityId: string, serialized: string, roomId?: string): Promise<void>;
  }>;
}

export interface PostSessionsBody {
  agentId: string;
  entityId: string;
  /** Opaque serialized delegation — never log or leak. */
  serializedDelegation: string;
  roomId?: string;
  /**
   * SQL db handle (== delegation `path`) to validate the grant against. The
   * legacy tinychat /sessions route omits it → falls back to MEMORY_DB_HANDLE.
   * The /api/agents delegation route passes the per-agent dbHandle
   * (e.g. "default/memory") so each agent validates against its own path.
   */
  dbHandle?: string;
  /**
   * Space name the delegation MUST be minted against (e.g. "agents"). When set,
   * the policy validator rejects a grant carrying any other space — or, fail-closed,
   * a grant with no verifiable space — as `wrong_space` (400). The legacy tinychat
   * /sessions route omits it (space not checked, unchanged). The /api/agents
   * delegation route passes the agent record's space.
   */
  expectedSpace?: string;
  /**
   * KV prefix (the agent's pathPrefix, e.g. "default/") the delegation MUST grant a
   * `tinycloud.kv` resource on (option D "operate broadly under the prefix"). When
   * set, a required KV resource is added to the policy — absent → `missing_kv_resource`,
   * wrong prefix → `wrong_kv_prefix` (both 400, fail-closed on the /api route). The
   * legacy tinychat /sessions route omits it (no KV requirement, unchanged).
   */
  kvPrefix?: string;
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
  const { agentId, entityId, serializedDelegation, roomId, expectedSpace, kvPrefix } = body;
  const dbHandle = body.dbHandle ?? MEMORY_DB_HANDLE;
  const policy = defaultElizaMemoryPolicy(dbHandle, kvPrefix);
  // Per-agent delegation target: each agent validates against its own DID, not a
  // single service-wide DID.
  const agentDid = await host.agentDidFor(agentId);

  // 1. Deserialize
  let deleg;
  try {
    deleg = deserializeDelegationSafe(serializedDelegation);
  } catch {
    return { status: 400, body: { error: "malformed" } };
  }

  // 2. Shape validation (shallow: ownerAddress, delegateDID, expiry, SQL presence)
  try {
    validateDelegationShape(deleg, { agentDid, dbHandle });
  } catch (e) {
    if (e instanceof DelegationShapeError) {
      return { status: 400, body: { error: "invalid_shape", message: e.message } };
    }
    throw e;
  }

  // 3. Policy validation — delegateDID==agentDID + expiry + resource path + space + actions
  try {
    validateDelegationPolicy(deleg, { agentDID: agentDid, policy, expectedSpace });
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

  // 5. Record in C-local store so GET /sessions can re-evaluate liveness without
  //    touching entity-registry.ts (B's frozen keystone). Persist dbHandle +
  //    expectedSpace + kvPrefix so the GET re-evaluation applies the same checks.
  store.set(entityId, { agentId, serializedDelegation, roomId, dbHandle, expectedSpace, kvPrefix });

  // 6. Return liveness status
  const status = evaluateDelegationStatus({ delegation: deleg, policy, agentDID: agentDid, expectedSpace });
  return { status: 200, body: { entityId, status } };
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

  const policy = defaultElizaMemoryPolicy(record.dbHandle ?? MEMORY_DB_HANDLE, record.kvPrefix);
  // Resolve the delegation target for the agent this session was registered against.
  const agentDid = await host.agentDidFor(record.agentId);

  let delegStatus: "active" | "expired" | "stale" | "none";
  try {
    // evaluateDelegationStatus rethrows non-EXPIRED DelegationPolicyErrors (plan §1 correction #2)
    delegStatus = evaluateDelegationStatus({ delegation: deleg, policy, agentDID: agentDid, expectedSpace: record.expectedSpace });
  } catch (e) {
    if (e instanceof DelegationPolicyError) {
      return {
        status: 400,
        body: { error: (e.reason as string).toLowerCase(), message: e.message },
      };
    }
    throw e;
  }

  return { status: 200, body: { entityId, status: delegStatus } };
}
