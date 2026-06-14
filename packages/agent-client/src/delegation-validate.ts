// Pure delegation shape validation — Phase 3 / Task 3.
//
// SHALLOW checks only: field presence, delegate-DID match, expiry, SQL resource.
// Deep policy matrix (action/path/resource/policy-hash) is Phase 4.
//
// HARD CONTRACT: error messages carry FIELD NAMES only, never values.
//   delegationHeader.Authorization and agentKey MUST NOT appear in any error.
// HARD CONTRACT: zero host-framework (Eliza) imports.

import type { PortableDelegation } from "@tinycloud/node-sdk";

/** Thrown when a PortableDelegation fails shallow shape validation. */
export class DelegationShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegationShapeError";
  }
}

/**
 * Validate the shallow shape of a deserialized PortableDelegation.
 *
 * Checks (in order, using ONLY confirmed 2.3.0 field names from phase-3-sdk-findings.md):
 *   1. ownerAddress — present and non-empty (PortableDelegation.ownerAddress)
 *   2. delegateDID — present and equals agentDid (Delegation.delegateDID)
 *   3. expiry — present, valid Date, not yet expired (Delegation.expiry)
 *   4. SQL resource — at least one tinycloud.sql/ action in Delegation.actions,
 *      or at least one SQL-service entry in PortableDelegation.resources
 *
 * Phase 4 / TODO markers indicate where the full policy matrix is added.
 * The dbHandle parameter is retained for Phase 4 path-match validation.
 *
 * @throws {DelegationShapeError} with a field-name-only message on failure
 */
export function validateDelegationShape(
  delegation: PortableDelegation,
  { agentDid, dbHandle: _dbHandle }: { agentDid: string; dbHandle: string },
): void {
  // 1. ownerAddress must be present (non-empty string).
  //    Confirmed field: PortableDelegation.ownerAddress (sdk-findings.md §d)
  if (!delegation.ownerAddress || delegation.ownerAddress.trim() === "") {
    throw new DelegationShapeError("missing required field: ownerAddress");
  }

  // 2. delegateDID must be present and match agentDid.
  //    Confirmed field: Delegation.delegateDID (sdk-findings.md §d)
  if (!delegation.delegateDID || delegation.delegateDID.trim() === "") {
    throw new DelegationShapeError("missing required field: delegateDID");
  }
  if (delegation.delegateDID !== agentDid) {
    throw new DelegationShapeError("delegateDID does not match agent DID");
  }

  // 3. expiry must be a valid, non-expired Date.
  //    Confirmed field: Delegation.expiry (sdk-findings.md §d, type: Date)
  //    Cast to allow defensive runtime checks on potentially malformed data.
  const expiry = delegation.expiry as Date | null | undefined;
  if (!expiry) {
    throw new DelegationShapeError("missing required field: expiry");
  }
  const expiryMs =
    expiry instanceof Date ? expiry.getTime() : new Date(expiry as string | number).getTime();
  if (isNaN(expiryMs)) {
    throw new DelegationShapeError("expiry is not a valid Date");
  }
  if (expiryMs <= Date.now()) {
    throw new DelegationShapeError("delegation has expired: check expiry");
  }

  // 4. At least one SQL resource must be present.
  //    Phase 3 depth: any tinycloud.sql/ action in actions is sufficient.
  //    Confirmed fields: Delegation.actions, PortableDelegation.resources (sdk-findings.md §d)
  //    Phase 4 / TODO: validate that the matched SQL resource path equals _dbHandle.
  //    Phase 4 / TODO: validate specific required SQL actions (read/write/admin).
  //    Phase 4 / TODO: validate delegatorDID and policy hash against _dbHandle.
  const hasSqlAction =
    Array.isArray(delegation.actions) &&
    delegation.actions.some((a) => a.startsWith("tinycloud.sql/"));
  const hasSqlResource =
    delegation.resources?.some((r) => r.service === "sql") ?? false;

  if (!hasSqlAction && !hasSqlResource) {
    throw new DelegationShapeError(
      "no SQL resource found covering dbHandle: check actions or resources",
    );
  }
}
