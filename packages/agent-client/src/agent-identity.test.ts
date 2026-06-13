import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  agentIdentityFromFile,
  agentIdentityFromKey,
  normalizeAgentKey,
} from "./agent-identity.ts";

// Deterministic hardhat test keys — never real production keys.
const KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEY_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// ---------------------------------------------------------------------------
// normalizeAgentKey — synchronous, no SDK required
// ---------------------------------------------------------------------------

test("normalizeAgentKey strips whitespace and lowercases", () => {
  expect(normalizeAgentKey("  0xABC123  ")).toBe("0xabc123");
});

test("normalizeAgentKey adds 0x prefix when absent", () => {
  expect(normalizeAgentKey("abc123")).toBe("0xabc123");
});

test("normalizeAgentKey handles 0X uppercase prefix", () => {
  expect(normalizeAgentKey("0XABC123")).toBe("0xabc123");
});

test("normalizeAgentKey throws on empty string", () => {
  expect(() => normalizeAgentKey("")).toThrow(/empty/);
});

test("normalizeAgentKey throws on whitespace-only string", () => {
  expect(() => normalizeAgentKey("   ")).toThrow(/empty/);
});

// ---------------------------------------------------------------------------
// agentIdentityFromKey — DID stability (Phase 2 core requirement)
// ---------------------------------------------------------------------------

test("same configured key yields the same DID across calls", async () => {
  const id1 = await agentIdentityFromKey(KEY_A);
  const id2 = await agentIdentityFromKey(KEY_A);
  expect(id1.did).toBe(id2.did);
});

test("same DID is stable across simulated process-restart calls", async () => {
  // Simulates two independent process starts using the same key: each call
  // constructs a fresh PrivateKeySigner with no shared state.
  const [id1, id2] = await Promise.all([
    agentIdentityFromKey(KEY_A),
    agentIdentityFromKey(KEY_A),
  ]);
  expect(id1.did).toBe(id2.did);
});

test("different keys yield different DIDs", async () => {
  const id1 = await agentIdentityFromKey(KEY_A);
  const id2 = await agentIdentityFromKey(KEY_B);
  expect(id1.did).not.toBe(id2.did);
});

test("DID has expected did:pkh:eip155:1: shape", async () => {
  const { did } = await agentIdentityFromKey(KEY_A);
  expect(did).toMatch(/^did:pkh:eip155:1:0x[0-9a-fA-F]{40}$/);
});

test("key with and without 0x prefix yields the same DID", async () => {
  const withPrefix = await agentIdentityFromKey(KEY_A);
  const withoutPrefix = await agentIdentityFromKey(KEY_A.slice(2));
  expect(withPrefix.did).toBe(withoutPrefix.did);
});

test("normalizedKey is stored on AgentIdentity", async () => {
  const { normalizedKey } = await agentIdentityFromKey(KEY_A);
  expect(normalizedKey).toBe(KEY_A.toLowerCase());
});

// ---------------------------------------------------------------------------
// agentIdentityFromKey — refusing to silently generate a delegation target
// ---------------------------------------------------------------------------

test("agentIdentityFromKey throws on empty string — refuses unstable DID", async () => {
  await expect(agentIdentityFromKey("")).rejects.toThrow(/empty/);
});

test("agentIdentityFromKey throws on whitespace string — refuses unstable DID", async () => {
  await expect(agentIdentityFromKey("   ")).rejects.toThrow(/empty/);
});

// ---------------------------------------------------------------------------
// agentIdentityFromFile — stable DID from file
// ---------------------------------------------------------------------------

test("agentIdentityFromFile gives the same DID as agentIdentityFromKey", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-identity-test-"));
  const filePath = join(dir, "agent.key");
  writeFileSync(filePath, KEY_A + "\n"); // trailing newline as real files have
  const fromFile = await agentIdentityFromFile(filePath);
  const fromKey = await agentIdentityFromKey(KEY_A);
  expect(fromFile.did).toBe(fromKey.did);
});

test("agentIdentityFromFile normalizes whitespace and missing 0x from file content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-identity-test-"));
  const filePath = join(dir, "agent.key");
  writeFileSync(filePath, "  " + KEY_A.slice(2) + "  \n"); // no 0x, extra whitespace
  const fromFile = await agentIdentityFromFile(filePath);
  const fromKey = await agentIdentityFromKey(KEY_A);
  expect(fromFile.did).toBe(fromKey.did);
});
