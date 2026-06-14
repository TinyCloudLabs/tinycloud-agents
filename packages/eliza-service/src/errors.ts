// Centralized HTTP error mapping for delegation errors (plan §2).
//
// NoDelegationError / DelegationExpiredError are B's typed errors from entity-registry.ts.
// They carry .entityId and .name but NO .code — matched by instanceof.
// (handoff §1; entity-registry.ts lines 16-38)

import {
  DelegationExpiredError,
  NoDelegationError,
} from "@tinycloud/eliza-plugin-memory";

export type DelegationErrorCode = "delegation_required" | "delegation_expired";

/**
 * Maps a registry delegation error to its HTTP error code string.
 * Returns null if the error is not a known delegation error.
 */
export function mapDelegationError(err: unknown): DelegationErrorCode | null {
  if (err instanceof NoDelegationError) return "delegation_required";
  if (err instanceof DelegationExpiredError) return "delegation_expired";
  return null;
}
