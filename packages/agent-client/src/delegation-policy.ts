// Phase 4: Delegation Policy Validation — policy types and default Eliza-memory policy builder.
// See docs/openkey-phases/phase-4-policy-validation-plan.md for the full design.
//
// This module is the SINGLE SHARED policy module (cohesion §2.1): Phase 6's consent
// harness imports defaultElizaMemoryPolicy / computePolicyHash from here rather than
// defining a parallel module. Keep it a clean, dependency-light public surface.
//
// SECURITY: error messages from this module MUST NEVER include the delegation auth
// token, any auth-bearing header value, or agentKey — nor the serialized blob.

import { createHash } from "node:crypto";
import { deserializeDelegation, expandActionShortNames, parseSpaceUri, principalDidEquals } from "@tinycloud/node-sdk";
import type { PortableDelegation } from "@tinycloud/node-sdk";
import { DEFAULT_DB_HANDLE } from "./config";
import { DelegationPolicyError } from "./errors";

/**
 * Wraps the SDK `deserializeDelegation` in a try/catch and maps any throw to a
 * typed `DelegationPolicyError` with `reason: "MALFORMED"`.
 *
 * SECURITY: the error message MUST NOT include the serialized blob or any
 * auth-bearing header field — only a fixed diagnostic label.
 */
export function deserializeDelegationSafe(serialized: string): PortableDelegation {
  try {
    return deserializeDelegation(serialized);
  } catch (cause) {
    throw new DelegationPolicyError(
      "malformed delegation: could not deserialize",
      "MALFORMED",
      { field: "serialized" },
      { cause },
    );
  }
}

/**
 * Asserts that a delegation object has the minimum required well-formed fields:
 * - `delegateDID` is a non-empty string
 * - `expiry` is coercible to a valid `Date` (ISO string or Date instance)
 *
 * Throws `DelegationPolicyError` with `reason: "MALFORMED"` on any violation.
 * An unparseable expiry is MALFORMED, not EXPIRED — parseability is checked here;
 * staleness is checked by `validateDelegationPolicy`.
 *
 * SECURITY: error messages MUST NOT include the serialized blob or auth-bearing fields.
 */
export function assertWellFormed(delegation: unknown): void {
  const d = delegation as Partial<PortableDelegation & { expiry: unknown }>;

  if (!d.delegateDID || typeof d.delegateDID !== "string") {
    throw new DelegationPolicyError(
      "malformed delegation: missing or invalid delegateDID",
      "MALFORMED",
      { field: "delegateDID" },
    );
  }

  const expiryRaw = d.expiry;
  const expiry = expiryRaw instanceof Date ? expiryRaw : new Date(expiryRaw as unknown as string);
  if (isNaN(expiry.getTime())) {
    throw new DelegationPolicyError(
      "malformed delegation: expiry is not a valid date",
      "MALFORMED",
      { field: "expiry" },
    );
  }
}

/**
 * A single resource entry in a delegation policy.
 * `serviceLong` and `serviceShort` are the two naming forms (e.g. "tinycloud.sql" / "sql").
 * `path` is the resource path; empty string for services that use no path (e.g. capabilities).
 * `requiredActions` must be FULL-URN form (e.g. "tinycloud.sql/read") — never short form.
 * `required` controls whether absence of this resource rejects the delegation.
 */
export interface PolicyResource {
  serviceLong: string;
  serviceShort: string;
  path: string;
  requiredActions: string[];
  required: boolean;
}

/**
 * A delegation policy — the set of resources a delegation must grant for this agent.
 * Passed to `validateDelegationPolicy` (phase4-validate-core) and
 * `computePolicyHash` / `evaluateDelegationStatus` (phase4-policy-hash-status).
 */
export interface DelegationPolicy {
  resources: PolicyResource[];
}

/**
 * Default Eliza-memory delegation policy.
 *
 * Encodes the narrow policy table from the Phase 4 plan:
 *   - tinycloud.sql  path=dbHandle  read+write+admin  required
 *   - tinycloud.capabilities  path=""  capabilities/read  optional
 *
 * The SQL resource path comes from `dbHandle` (never a second hardcoded literal),
 * so config and policy never drift.
 *
 * Required SQL actions include `admin` because Phase 5 runs `ensureSchema()` (DDL)
 * on boot. A future steady-state mode can pass `["tinycloud.sql/read","tinycloud.sql/write"]`.
 */
export function defaultElizaMemoryPolicy(
  dbHandle: string = DEFAULT_DB_HANDLE,
): DelegationPolicy {
  return {
    resources: [
      {
        serviceLong: "tinycloud.sql",
        serviceShort: "sql",
        path: dbHandle,
        requiredActions: [
          "tinycloud.sql/read",
          "tinycloud.sql/write",
          "tinycloud.sql/admin",
        ],
        required: true,
      },
      {
        serviceLong: "tinycloud.capabilities",
        serviceShort: "capabilities",
        path: "",
        requiredActions: ["tinycloud.capabilities/read"],
        required: false,
      },
    ],
  };
}

/**
 * Returns true if the given resource service string (short or long form) matches the
 * policy resource. The PolicyResource carries both forms (serviceLong / serviceShort),
 * so no external mapping table is needed.
 *
 * NOTE: SERVICE_SHORT_TO_LONG is absent from @tinycloud/node-sdk 2.3.0 (confirmed by
 * the phase4-sdk-symbol-probe test). The PolicyResource dual-name design (serviceLong +
 * serviceShort) is the deliberate workaround — both forms are stored on the policy
 * object so this comparison never needs the external map.
 */
function serviceMatches(resourceService: string, policyResource: PolicyResource): boolean {
  return resourceService === policyResource.serviceShort || resourceService === policyResource.serviceLong;
}

/**
 * Pure, pre-activation delegation policy validator.
 *
 * Validates a deserialized `PortableDelegation` against an explicit policy and agent DID.
 * Throws `DelegationPolicyError` on first failing check in matrix order:
 *   (1) well-formed
 *   (2) delegatee match
 *   (3) expiry
 *   (4) SQL resource presence
 *   (5) SQL resource path (db handle)
 *   (5b) SQL resource space — ONLY when opts.expectedSpace is set (see below)
 *   (6) SQL actions coverage
 *
 * Returns void on success. Pure — no I/O, no network, no `useDelegation` call.
 *
 * SPACE ASSERTION (opts.expectedSpace, optional): when set, the matched SQL
 * resource's space URI must parse to a space whose name === expectedSpace. This
 * enforces the "agent memory lives in the `agents` space" invariant — a delegation
 * minted against another space (e.g. "default") with a matching path is rejected
 * with reason WRONG_SPACE, so the runtime never lands in the wrong space. When
 * expectedSpace is UNSET the space is not checked (legacy behavior). FAIL-CLOSED:
 * if expectedSpace is set but the delegation is the flat/legacy shape (no
 * resources[], so no per-resource space to verify) or the space URI is
 * unparseable, validation rejects with WRONG_SPACE — an unverifiable space is not
 * trusted.
 *
 * SECURITY: error messages MUST NEVER include the delegation auth token, any
 * auth-bearing header value, agentKey, or the serialized blob.
 */
export function validateDelegationPolicy(
  delegation: PortableDelegation,
  opts: { agentDID: string; policy: DelegationPolicy; now?: Date; expectedSpace?: string },
): void {
  // (1) Well-formed: delegateDID present, expiry parseable
  assertWellFormed(delegation);

  // (2) Delegatee match
  if (!principalDidEquals(delegation.delegateDID, opts.agentDID)) {
    throw new DelegationPolicyError(
      `delegation delegatee does not match agent DID: expected ${opts.agentDID}, got ${delegation.delegateDID}`,
      "WRONG_DELEGATEE",
      { expected: opts.agentDID, actual: delegation.delegateDID },
    );
  }

  // (3) Expiry check — coerce defensively (assertWellFormed already verified parseability)
  const expiry =
    delegation.expiry instanceof Date ? delegation.expiry : new Date(delegation.expiry as unknown as string);
  const now = opts.now ?? new Date();
  if (expiry <= now) {
    throw new DelegationPolicyError(
      `delegation expired at ${expiry.toISOString()} (now: ${now.toISOString()})`,
      "EXPIRED",
      { expiry: expiry.toISOString(), now: now.toISOString() },
    );
  }

  // Find the required SQL policy resource — there must be exactly one with required:true
  // in a well-formed defaultElizaMemoryPolicy; iterate only required resources.
  for (const policyResource of opts.policy.resources) {
    if (!policyResource.required) continue;

    // (4) Find the granted resource in the delegation
    let grantedPath: string;
    let grantedActions: string[];
    // Full space URI of the matched resource; only the multi-resource shape carries
    // it. undefined for the flat/legacy shape (no per-resource space).
    let grantedSpaceUri: string | undefined;

    if (delegation.resources !== undefined) {
      // Multi-resource shape: prefer resources[] — search for a matching service entry
      const found = delegation.resources.find(r => serviceMatches(r.service, policyResource));
      if (!found) {
        throw new DelegationPolicyError(
          `delegation missing required resource: service=${policyResource.serviceLong} path=${policyResource.path}`,
          "MISSING_SQL_RESOURCE",
          { requiredService: policyResource.serviceLong, requiredPath: policyResource.path },
        );
      }
      grantedPath = found.path;
      grantedActions = found.actions;
      grantedSpaceUri = found.space;
    } else {
      // Flat (legacy single-resource) shape: synthesize from the flat path + actions fields
      grantedPath = delegation.path;
      grantedActions = delegation.actions;
    }

    // (5) DB handle (resource path) match
    if (grantedPath !== policyResource.path) {
      throw new DelegationPolicyError(
        `delegation SQL resource path mismatch: expected ${policyResource.path}, got ${grantedPath}`,
        "WRONG_DB_HANDLE",
        { expected: policyResource.path, actual: grantedPath },
      );
    }

    // (5b) Space assertion — only when expectedSpace is configured. Fail-closed:
    // an unverifiable space (flat shape / unparseable URI) is rejected, and a space
    // whose name differs from expectedSpace is rejected. Space NAMES are non-secret.
    if (opts.expectedSpace !== undefined) {
      const grantedSpaceName =
        grantedSpaceUri !== undefined ? parseSpaceUri(grantedSpaceUri)?.name : undefined;
      if (grantedSpaceName === undefined || grantedSpaceName === "") {
        throw new DelegationPolicyError(
          `delegation space unverifiable: expected space=${opts.expectedSpace} but the grant carries no parseable space`,
          "WRONG_SPACE",
          { expected: opts.expectedSpace, actual: null },
        );
      }
      if (grantedSpaceName !== opts.expectedSpace) {
        throw new DelegationPolicyError(
          `delegation space mismatch: expected space=${opts.expectedSpace}, got ${grantedSpaceName}`,
          "WRONG_SPACE",
          { expected: opts.expectedSpace, actual: grantedSpaceName },
        );
      }
    }

    // (6) Actions coverage — normalize both sides to full-URN before comparing
    const normalizedGranted = new Set(expandActionShortNames(policyResource.serviceLong, grantedActions));
    const normalizedRequired = expandActionShortNames(policyResource.serviceLong, policyResource.requiredActions);
    const missing = normalizedRequired.filter(a => !normalizedGranted.has(a));
    if (missing.length > 0) {
      throw new DelegationPolicyError(
        `delegation SQL resource insufficient actions; missing: ${missing.join(", ")}`,
        "INSUFFICIENT_ACTIONS",
        { missing },
      );
    }
  }
}

/**
 * Computes a deterministic hex SHA-256 hash over the policy's resources and the agent DID.
 *
 * The canonical input is:
 *   JSON.stringify(resources sorted by serviceLong+path, each with requiredActions sorted)
 *   + "|" + agentDID
 *
 * This is stable: reordering resources or their requiredActions produces the same hash,
 * but changing any path, serviceLong, requiredAction, or agentDID produces a different hash.
 *
 * ALL policy resources are included in the hash (including optional required:false entries),
 * not just the required ones. This captures the full policy contract: a future policy that
 * adds/changes an optional resource produces a different hash (triggering "stale"), which is
 * the correct behavior. The plan wording "required resources" referred to policy intent, not
 * the required:true field.
 *
 * Part of the SHARED delegation-policy module (cohesion §2.1) — consumed by Phase 6's
 * consent harness as well as evaluateDelegationStatus below.
 */
export function computePolicyHash(policy: DelegationPolicy, agentDID: string): string {
  const canonical = policy.resources
    .map(r => ({
      serviceLong: r.serviceLong,
      path: r.path,
      requiredActions: [...r.requiredActions].sort(),
    }))
    .sort((a, b) => {
      const ka = a.serviceLong + a.path;
      const kb = b.serviceLong + b.path;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  const input = JSON.stringify(canonical) + "|" + agentDID;
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Pure delegation status evaluation — no I/O, no persistence.
 *
 * Returns:
 *   "none"    — no delegation provided
 *   "expired" — delegation fails validation with reason EXPIRED
 *   "stale"   — delegation is valid but storedHash !== computePolicyHash(policy, agentDID)
 *   "active"  — delegation is valid and hash matches (or no storedHash was provided)
 *
 * Any non-EXPIRED DelegationPolicyError from validateDelegationPolicy is rethrown.
 *
 * Open Question #3 (persistence of this status) is deferred to Phase 6+. This function
 * is intentionally stateless: callers own the storedHash lifecycle.
 */
export function evaluateDelegationStatus(args: {
  delegation?: PortableDelegation;
  policy: DelegationPolicy;
  agentDID: string;
  storedHash?: string;
  now?: Date;
  /** When set, enforce the space assertion (see validateDelegationPolicy). */
  expectedSpace?: string;
}): "active" | "expired" | "stale" | "none" {
  const { delegation, policy, agentDID, storedHash, now, expectedSpace } = args;

  if (!delegation) return "none";

  try {
    validateDelegationPolicy(delegation, { agentDID, policy, now, expectedSpace });
  } catch (e) {
    if (e instanceof DelegationPolicyError && e.reason === "EXPIRED") return "expired";
    throw e;
  }

  if (storedHash !== undefined && storedHash !== computePolicyHash(policy, agentDID)) {
    return "stale";
  }

  return "active";
}
