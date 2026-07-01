// Per-agent key derivation (plan §2).
//
// Derives a stable, per-agent Ethereum key from a single master key held in the
// CVM, so a service can host many agents without minting or storing a new secret
// per agent:
//
//   agentKey = HMAC-SHA256(normalizeAgentKey(masterKey), "tinycloud-agent:v1:" + agentId)
//   agentDid = agentIdentityFromKey(agentKey).did
//
// Properties:
//  - Deterministic: same (masterKey, agentId) → same agentKey/DID across restarts.
//  - Distinct: different agentIds → different keys/DIDs (HMAC domain separation).
//  - No stored per-agent secret: keys are re-derivable, DIDs stable forever.
//
// SECURITY: the master key is HMAC key material and must never appear in output,
// logs, or error messages. agentIdentityFromKey already refuses empty input.

import { createHmac } from "node:crypto";
import { agentIdentityFromKey, normalizeAgentKey, type AgentIdentity } from "@tinycloud/agent-client";

/** Version-namespaced HMAC message prefix; bump the version to rotate all derived keys. */
export const AGENT_KEY_DERIVATION_PREFIX = "tinycloud-agent:v1:";

/**
 * Derive the 0x-prefixed lowercase hex per-agent key for agentId from masterKey.
 *
 * The HMAC key is the normalized master key material (0x-prefixed lowercase hex),
 * taken as UTF-8 bytes — same canonical form the master key is stored/consumed in
 * elsewhere. The message is the version prefix concatenated with agentId. The
 * 32-byte HMAC-SHA256 digest is the raw private key.
 */
export function deriveAgentKey(masterKey: string, agentId: string): string {
  const normalizedMaster = normalizeAgentKey(masterKey);
  if (!agentId) {
    throw new Error("deriveAgentKey: agentId is empty");
  }
  const digest = createHmac("sha256", normalizedMaster)
    .update(AGENT_KEY_DERIVATION_PREFIX + agentId)
    .digest("hex");
  return `0x${digest}`;
}

/**
 * Derive the full {@link AgentIdentity} (DID + normalized key) for agentId from masterKey.
 */
export async function deriveAgentIdentity(
  masterKey: string,
  agentId: string,
): Promise<AgentIdentity> {
  const agentKey = deriveAgentKey(masterKey, agentId);
  return agentIdentityFromKey(agentKey);
}
