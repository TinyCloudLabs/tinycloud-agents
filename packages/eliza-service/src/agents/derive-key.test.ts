// Per-agent key derivation tests (plan §2, M1).
//
// Verify: determinism (same input → same key), distinctness (different agentId or
// master → different key), normalization tolerance, and that derived identities
// are valid did:pkh values distinct from the master identity.

import { describe, expect, it } from "bun:test";
import { agentIdentityFromKey } from "@tinycloud/agent-client";
import {
  AGENT_KEY_DERIVATION_PREFIX,
  deriveAgentKey,
  deriveAgentIdentity,
} from "./derive-key.js";

// Deterministic hardhat test keys — never real keys.
const MASTER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const MASTER_2 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("deriveAgentKey — determinism", () => {
  it("same (master, agentId) yields the same key across calls", () => {
    expect(deriveAgentKey(MASTER, AGENT_A)).toBe(deriveAgentKey(MASTER, AGENT_A));
  });

  it("produces a 0x-prefixed 32-byte hex key", () => {
    expect(deriveAgentKey(MASTER, AGENT_A)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("deriveAgentKey — distinctness", () => {
  it("different agentIds yield different keys", () => {
    expect(deriveAgentKey(MASTER, AGENT_A)).not.toBe(deriveAgentKey(MASTER, AGENT_B));
  });

  it("different master keys yield different keys for the same agentId", () => {
    expect(deriveAgentKey(MASTER, AGENT_A)).not.toBe(deriveAgentKey(MASTER_2, AGENT_A));
  });
});

describe("deriveAgentKey — normalization and validation", () => {
  it("normalizes the master key (unprefixed / uppercase / whitespace) to one result", () => {
    const canonical = deriveAgentKey(MASTER, AGENT_A);
    const unprefixed = MASTER.slice(2);
    expect(deriveAgentKey(unprefixed, AGENT_A)).toBe(canonical);
    expect(deriveAgentKey(`  ${MASTER.toUpperCase()}  `, AGENT_A)).toBe(canonical);
  });

  it("throws on an empty master key", () => {
    expect(() => deriveAgentKey("", AGENT_A)).toThrow();
  });

  it("throws on an empty agentId", () => {
    expect(() => deriveAgentKey(MASTER, "")).toThrow(/agentId is empty/);
  });

  it("uses the v1 domain-separation prefix", () => {
    expect(AGENT_KEY_DERIVATION_PREFIX).toBe("tinycloud-agent:v1:");
  });
});

describe("deriveAgentIdentity", () => {
  it("returns a did:pkh identity distinct from the master identity", async () => {
    const master = await agentIdentityFromKey(MASTER);
    const derived = await deriveAgentIdentity(MASTER, AGENT_A);

    expect(derived.did).toMatch(/^did:pkh:eip155:1:0x[0-9a-fA-F]{40}$/);
    expect(derived.did).not.toBe(master.did);
    expect(derived.normalizedKey).toBe(deriveAgentKey(MASTER, AGENT_A));
  });

  it("distinct agentIds get distinct DIDs", async () => {
    const a = await deriveAgentIdentity(MASTER, AGENT_A);
    const b = await deriveAgentIdentity(MASTER, AGENT_B);
    expect(a.did).not.toBe(b.did);
  });
});
