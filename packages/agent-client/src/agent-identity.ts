// Stable agent identity — Phase 2 of the OpenKey auth plan.
//
// Derives a deterministic did:pkh:eip155:1:{address} from a configured agent
// private key so users can delegate to it before TinyCloudNode.useDelegation
// is wired (Phase 3). The DID is stable across process restarts for the same
// key; a different key gives a different DID.
//
// SECURITY: never generate a persistent delegation target silently. Callers
// must supply explicit key material; missing or empty input throws.
//
// HARD CONTRACT: zero host-framework (Eliza) imports — see ./index.ts.

import { readFileSync } from "node:fs";
import { PrivateKeySigner, pkhDid } from "@tinycloud/node-sdk";

/** The resolved agent identity. */
export interface AgentIdentity {
  /** Stable DID to advertise as the delegation target. Format: did:pkh:eip155:1:{address} */
  did: string;
  /** Normalized key material: 0x-prefixed lowercase hex. */
  normalizedKey: string;
}

/**
 * Normalize raw hex agent key material.
 * Strips surrounding whitespace, adds 0x prefix if absent, lowercases.
 * Throws if the result is empty — refusing to silently produce an unstable target.
 */
export function normalizeAgentKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Agent key is empty — cannot compute a stable agent DID");
  }
  const withPrefix =
    trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed : `0x${trimmed}`;
  return withPrefix.toLowerCase();
}

/**
 * Derive a stable {@link AgentIdentity} from raw hex key material.
 * Same key → same DID across calls and process restarts.
 */
export async function agentIdentityFromKey(rawKey: string): Promise<AgentIdentity> {
  const normalizedKey = normalizeAgentKey(rawKey);
  const signer = new PrivateKeySigner(normalizedKey);
  const address = await signer.getAddress();
  const did = pkhDid(address);
  return { did, normalizedKey };
}

/**
 * Load a stable {@link AgentIdentity} from a file containing hex key material.
 * File content is trimmed before use; trailing newlines and whitespace are ignored.
 */
export async function agentIdentityFromFile(filePath: string): Promise<AgentIdentity> {
  const raw = readFileSync(filePath, "utf-8");
  return agentIdentityFromKey(raw);
}
