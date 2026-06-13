// Signed-att normalization — the delegation chokepoint.
//
// WHY (handoff F1): web-sdk 2.3.0 `serializeDelegation` writes a LOSSY top-level
// `actions` summary (e.g. only `["tinycloud.capabilities/read"]`) and emits no
// `resources` field — even when the delegation grants SQL. Both fields are
// UNSIGNED and forgeable. The real, signed capability lives in
// `delegationHeader.Authorization` — a UCAN JWT whose `att` claim is the
// authoritative `(resource-uri → abilities)` grant map.
//
// This module decodes that JWT and REWRITES `resources`/`actions` from the
// signed `att`, so every downstream validator reads trustworthy, signed-derived
// data instead of the forgeable summary. Routing the transport through
// `deserializeAndNormalize` closes the false-confidence gap (F1 Consequence B):
// a hand-crafted file claiming `actions: ["tinycloud.sql/admin"]` whose signed
// `att` grants nothing is normalized down to the (empty) signed grant and then
// rejected by the policy validator.
//
// SECURITY: this is a pure base64url decode — it does NOT verify the JWT
// signature. Real cryptographic enforcement happens server-side at the node via
// the bearer header. The value here is making the CLIENT validators read the
// signed grant rather than the forgeable summary.
//
// HARD CONTRACT: never place the Authorization header, the JWT, agentKey, or the
// serialized blob in any error message — field labels only.

import { deserializeDelegation } from "@tinycloud/node-sdk";
import type { PortableDelegation } from "@tinycloud/node-sdk";
import { DelegationPolicyError } from "./errors";

/** A single signed-derived grant entry. Matches node-sdk's DelegatedResource. */
type GrantResource = NonNullable<PortableDelegation["resources"]>[number];

const BEARER_RE = /^Bearer\s+/i;

/**
 * Decode the (unverified) payload of a UCAN bearer JWT.
 * Throws MALFORMED if the header is not a decodable JWT — we never fall back to
 * the unsigned summary, so an unreadable signed side is a hard reject.
 */
function decodeJwtPayload(authHeader: string): Record<string, unknown> {
  const jwt = authHeader.replace(BEARER_RE, "");
  const parts = jwt.split(".");
  if (parts.length < 2) {
    throw new DelegationPolicyError(
      "malformed delegation: Authorization is not a JWT",
      "MALFORMED",
      { field: "delegationHeader.Authorization" },
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (cause) {
    throw new DelegationPolicyError(
      "malformed delegation: Authorization payload is not decodable JSON",
      "MALFORMED",
      { field: "delegationHeader.Authorization" },
      { cause },
    );
  }
  if (!payload || typeof payload !== "object") {
    throw new DelegationPolicyError(
      "malformed delegation: Authorization payload is not an object",
      "MALFORMED",
      { field: "delegationHeader.Authorization" },
    );
  }
  return payload as Record<string, unknown>;
}

/**
 * Build the signed grant breakdown from a UCAN `att` claim.
 *
 * `att` shape: `{ "<resource-uri>": { "<ability-urn>": [constraints], ... }, ... }`.
 * Each resource URI is `<space>/<serviceShort>/<path...>` where `<space>` (e.g.
 * `tinycloud:pkh:eip155:1:0x...:default`) contains no `/`. So splitting on `/`:
 *   parts[0] = space, parts[1] = service, parts.slice(2).join("/") = path.
 * Abilities are already full-URN (`tinycloud.sql/read`), so they map directly to
 * `DelegatedResource.actions`.
 */
function resourcesFromAtt(att: Record<string, unknown>): GrantResource[] {
  const resources: GrantResource[] = [];
  for (const [uri, abilities] of Object.entries(att)) {
    if (!abilities || typeof abilities !== "object") continue;
    const actions = Object.keys(abilities as Record<string, unknown>);
    if (actions.length === 0) continue;
    const segs = uri.split("/");
    const service = segs[1] ?? "";
    if (!service) continue; // not a recognizable <space>/<service>/<path> URI
    resources.push({
      service,
      space: segs[0] ?? "",
      path: segs.slice(2).join("/"),
      actions,
    });
  }
  return resources;
}

/**
 * Rewrite a PortableDelegation's `resources`/`actions` from its SIGNED
 * `delegationHeader.Authorization` `att` claim. The signed att is the SOLE
 * source of truth — any forged top-level `resources`/`actions` are discarded
 * (overwritten, not merged). Returns a shallow copy; the input is not mutated.
 *
 * @throws {DelegationPolicyError} reason `MALFORMED` when the signed capability
 *   is missing, undecodable, or grants nothing.
 */
export function normalizeDelegationGrants(delegation: PortableDelegation): PortableDelegation {
  const auth = delegation.delegationHeader?.Authorization;
  if (!auth || typeof auth !== "string" || auth.trim() === "") {
    throw new DelegationPolicyError(
      "malformed delegation: missing delegationHeader.Authorization",
      "MALFORMED",
      { field: "delegationHeader.Authorization" },
    );
  }

  const payload = decodeJwtPayload(auth);
  const att = payload.att;
  if (!att || typeof att !== "object") {
    throw new DelegationPolicyError(
      "malformed delegation: signed capability has no att claim",
      "MALFORMED",
      { field: "delegationHeader.Authorization.att" },
    );
  }

  const resources = resourcesFromAtt(att as Record<string, unknown>);
  if (resources.length === 0) {
    throw new DelegationPolicyError(
      "malformed delegation: signed capability grants no resources",
      "MALFORMED",
      { field: "delegationHeader.Authorization.att" },
    );
  }

  // Union of all signed abilities — corrects the lossy top-level `actions`
  // summary so the shallow validator (which reads `actions`) also sees the
  // true, signed grant set.
  const actions = [...new Set(resources.flatMap((r) => r.actions))];

  return { ...delegation, resources, actions };
}

/**
 * Deserialize a serialized PortableDelegation and normalize its grants from the
 * signed `att`. This is the delegation chokepoint — the default `deserialize`
 * for DelegatedTransport so the live path always validates against signed data.
 *
 * @throws {DelegationPolicyError} reason `MALFORMED` on deserialize failure or
 *   when the signed capability cannot be read.
 */
export function deserializeAndNormalize(serialized: string): PortableDelegation {
  let delegation: PortableDelegation;
  try {
    delegation = deserializeDelegation(serialized);
  } catch (cause) {
    throw new DelegationPolicyError(
      "malformed delegation: could not deserialize",
      "MALFORMED",
      { field: "serialized" },
      { cause },
    );
  }
  return normalizeDelegationGrants(delegation);
}
