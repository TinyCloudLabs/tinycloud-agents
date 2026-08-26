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

import { parseSpaceUri } from "@tinycloud/node-sdk";
import type { PortableDelegation } from "@tinycloud/node-sdk";
import { DelegationPolicyError } from "./errors";
import { deserializeDelegationSafe } from "./delegation-policy";

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
    // The signed UCAN JWT is the SOLE source of capability truth — a bare
    // `Bearer <cid>` (or any non-JWT) carries no signed `att`, so we cannot derive
    // trustworthy grants and refuse to fall back to the forgeable summary. Name the
    // cause + remediation; never echo the header value (field labels only).
    throw new DelegationPolicyError(
      "malformed delegation: Authorization carries no signed capability JWT " +
        "(expected a UCAN bearer token; mint the delegation via the delegate-ui harness)",
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
 * Parse a UCAN att resource URI into `(space, service, path)`.
 *
 * The canonical resource URI is `<space>/<serviceShort>/<path...>` where `<space>`
 * is the colon-form space id (`tinycloud:pkh:eip155:1:0x...:default`, no `/`). Rather
 * than trust positional segments, the candidate `<space>` is validated with the SDK's
 * own `parseSpaceUri`: it returns null for the `tinycloud://authority/...` form
 * (where `segs[0]` is just `"tinycloud:"`) and any other non-space shape. An att key we
 * cannot map to `<space>/<service>/<path>` is therefore rejected LOUDLY here — never
 * silently dropped, which would otherwise surface downstream as a confusing
 * `MISSING_SQL_RESOURCE` on an otherwise-valid delegation (review #4).
 */
function parseResourceUri(uri: string): { space: string; service: string; path: string } {
  const segs = uri.split("/");
  const space = segs[0] ?? "";
  const service = segs[1] ?? "";
  if (!service || parseSpaceUri(space) === null) {
    throw new DelegationPolicyError(
      "malformed delegation: signed att resource URI is not <space>/<service>/<path>",
      "MALFORMED",
      { field: "delegationHeader.Authorization.att" },
    );
  }
  return { space, service, path: segs.slice(2).join("/") };
}

/**
 * Build the signed grant breakdown from a UCAN `att` claim.
 *
 * `att` shape: `{ "<resource-uri>": { "<ability-urn>": [constraints], ... }, ... }`.
 * Abilities are already full-URN (`tinycloud.sql/read`), so they map directly to
 * `DelegatedResource.actions`. Resource URIs are parsed + validated by
 * {@link parseResourceUri}.
 */
function resourcesFromAtt(att: Record<string, unknown>): GrantResource[] {
  const resources: GrantResource[] = [];
  for (const [uri, abilities] of Object.entries(att)) {
    // An att value MUST be an abilities map (object). An ARRAY would pass a bare
    // typeof-object check and yield bogus `["0"]` "actions" → a junk resource and a
    // confusing INSUFFICIENT_ACTIONS later. Reject it as MALFORMED instead (review #7).
    if (Array.isArray(abilities)) {
      throw new DelegationPolicyError(
        "malformed delegation: signed att value is an array, not an abilities map",
        "MALFORMED",
        { field: "delegationHeader.Authorization.att" },
      );
    }
    if (!abilities || typeof abilities !== "object") continue;
    const actions = Object.keys(abilities as Record<string, unknown>);
    if (actions.length === 0) continue;
    const { space, service, path } = parseResourceUri(uri);
    resources.push({ service, space, path, actions });
  }
  return resources;
}

/**
 * Extract the owner EVM address from the SIGNED side — the space id embedded in the
 * normalized resource URIs (`tinycloud:pkh:eip155:{chain}:0x{owner}:default`). The
 * top-level `ownerAddress` is unsigned and forgeable; this is the authoritative owner.
 * Returns the canonical (EIP-55) address, or null if no resource carries a parseable
 * space (review #6). Run AFTER {@link normalizeDelegationGrants}.
 */
export function signedOwnerAddress(delegation: PortableDelegation): string | null {
  for (const r of delegation.resources ?? []) {
    const parsed = parseSpaceUri(r.space);
    if (parsed?.address) return parsed.address;
  }
  return null;
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
      "malformed delegation: no signed capability JWT in delegationHeader.Authorization " +
        "(mint the delegation via the delegate-ui harness)",
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
  // deserializeDelegationSafe wraps the SDK deserializer + maps throws to MALFORMED
  // (shared with delegation-policy; review #8 dedup — was a byte-identical try/catch).
  return normalizeDelegationGrants(deserializeDelegationSafe(serialized));
}

/**
 * Deserialize a transcript delegation for the node-sdk activation boundary.
 *
 * Current web-sdk multi-resource delegations use `Bearer <cid>` rather than an
 * inline compact UCAN. In that form, `resources` is the exact attenuation the
 * agent asks node-sdk to install as a child session; the TinyCloud host verifies
 * that attenuation against the signed parent addressed by the CID. We therefore
 * accept it only when Authorization and `cid` are identical, then let callers
 * enforce the fixed transcript policy before the host performs cryptographic
 * activation. A wider forged attenuation cannot activate; a narrower one only
 * reduces the child session's authority.
 *
 * Compact-UCAN delegations keep the stronger inline path above: grants are
 * derived from signed `att` and unsigned summaries are discarded.
 */
export function deserializeTranscriptDelegationForActivation(
  serialized: string,
): PortableDelegation {
  const delegation = deserializeDelegationSafe(serialized);
  const auth = delegation.delegationHeader?.Authorization;
  if (typeof auth !== "string" || auth.trim() === "") {
    throw new DelegationPolicyError(
      "malformed transcript delegation: missing Authorization",
      "MALFORMED",
      { field: "delegationHeader.Authorization" },
    );
  }

  const bearer = auth.replace(BEARER_RE, "");
  if (bearer.includes(".")) return normalizeDelegationGrants(delegation);

  if (bearer !== delegation.cid) {
    throw new DelegationPolicyError(
      "malformed transcript delegation: Authorization CID does not match cid",
      "MALFORMED",
      { field: "delegationHeader.Authorization" },
    );
  }
  if (!Array.isArray(delegation.resources) || delegation.resources.length === 0) {
    throw new DelegationPolicyError(
      "malformed transcript delegation: CID form requires resource attenuation",
      "MALFORMED",
      { field: "resources" },
    );
  }

  const resources = delegation.resources.map((resource) => ({
    ...resource,
    actions: [...resource.actions],
  }));
  const actions = [...new Set(resources.flatMap((resource) => resource.actions))];
  // DelegatedAccess configures KVService's automatic prefix from the portable
  // top-level path. Multi-resource delegates may serialize either resource
  // first, so pin that compatibility summary to the explicit KV attenuation;
  // the host still verifies the full resources[] child request against the CID.
  const kvPath = resources.find((resource) => resource.service.replace(/^tinycloud\./, "") === "kv")?.path;
  return { ...delegation, ...(kvPath ? { path: kvPath } : {}), resources, actions };
}
