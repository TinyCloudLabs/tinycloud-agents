// Phase 6: Harness unit tests — stable DID, refusal, no-secret-leak, policy cross-check.
//
// Tests the pure buildConsentReport function using deterministic hardhat test keys.
// NEVER uses real production keys — only the well-known hardhat test private keys.
//
// Cross-check contract: report.permissions must deep-equal defaultElizaMemoryPolicy(dbHandle)
// imported from @tinycloud/agent-client (Phase 4). This is the consent<->validation
// no-drift guard: the harness and the Phase-4 validator share one policy object, so they
// cannot diverge even if the policy is updated.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { defaultElizaMemoryPolicy } from "@tinycloud/agent-client";
import { buildConsentReport } from "./consent-harness.ts";

// Deterministic hardhat test keys — never real production keys.
const KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEY_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// Fixed expiry keeps openKeyDelegateUrl stable across calls in the same test run.
const FIXED_EXPIRY = "2030-01-01T00:00:00.000Z";

// Default db handle — must match DEFAULT_HARNESS_DB_HANDLE in the harness and
// DEFAULT_DB_HANDLE in @tinycloud/agent-client.
const DEFAULT_DB_HANDLE = "xyz.tinycloud.eliza/memory";

// ---------------------------------------------------------------------------
// Stable DID + policyHash across two buildConsentReport calls
// ---------------------------------------------------------------------------

test("stable agent key -> stable agentDid across two buildConsentReport calls", async () => {
  const r1 = await buildConsentReport({ TINYCLOUD_AGENT_KEY: KEY_A, CONSENT_EXPIRY_ISO: FIXED_EXPIRY });
  const r2 = await buildConsentReport({ TINYCLOUD_AGENT_KEY: KEY_A, CONSENT_EXPIRY_ISO: FIXED_EXPIRY });
  expect(r1.agentDid).toBe(r2.agentDid);
  expect(r1.agentDid).toMatch(/^did:pkh:eip155:1:0x[0-9a-fA-F]{40}$/);
});

test("stable agent key -> stable policyHash across two buildConsentReport calls", async () => {
  const r1 = await buildConsentReport({ TINYCLOUD_AGENT_KEY: KEY_A, CONSENT_EXPIRY_ISO: FIXED_EXPIRY });
  const r2 = await buildConsentReport({ TINYCLOUD_AGENT_KEY: KEY_A, CONSENT_EXPIRY_ISO: FIXED_EXPIRY });
  expect(r1.policyHash).toBe(r2.policyHash);
  expect(r1.policyHash.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Refusal: missing both key sources
// ---------------------------------------------------------------------------

test("missing both key sources -> throws", async () => {
  await expect(buildConsentReport({})).rejects.toThrow();
});

test("missing both key sources -> error names the fields, no 0x-hex secret in message", async () => {
  let error: Error | undefined;
  try {
    await buildConsentReport({});
  } catch (e) {
    error = e as Error;
  }
  expect(error).toBeDefined();
  const message = error!.message;
  // Must name the expected source fields so the operator knows what to set.
  expect(message).toMatch(/TINYCLOUD_AGENT_KEY/);
  // Must NOT contain any 0x-prefixed hex that could be key or auth material (20+ hex chars).
  expect(message).not.toMatch(/0x[0-9a-fA-F]{20,}/);
});

test("missing both key sources -> error has no partial delegation target (no did:pkh, no eip155)", async () => {
  let error: Error | undefined;
  try {
    await buildConsentReport({});
  } catch (e) {
    error = e as Error;
  }
  expect(error).toBeDefined();
  expect(error!.message).not.toMatch(/did:pkh/);
  expect(error!.message).not.toMatch(/eip155/);
});

// ---------------------------------------------------------------------------
// Conflict: both key sources provided -> clear field-named error, no values
// ---------------------------------------------------------------------------

test("both TINYCLOUD_AGENT_KEY and TINYCLOUD_AGENT_KEY_FILE -> conflict error names both fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "consent-harness-test-"));
  const keyFilePath = join(dir, "agent.key");
  writeFileSync(keyFilePath, KEY_B + "\n");

  let error: Error | undefined;
  try {
    await buildConsentReport({
      TINYCLOUD_AGENT_KEY: KEY_A,
      TINYCLOUD_AGENT_KEY_FILE: keyFilePath,
      CONSENT_EXPIRY_ISO: FIXED_EXPIRY,
    });
  } catch (e) {
    error = e as Error;
  }
  expect(error).toBeDefined();
  const message = error!.message;
  // Both conflicting field names must appear in the error.
  expect(message).toMatch(/TINYCLOUD_AGENT_KEY/);
  expect(message).toMatch(/TINYCLOUD_AGENT_KEY_FILE/);
  // Key values must NOT appear.
  expect(message).not.toMatch(/0x[0-9a-fA-F]{20,}/);
});

// ---------------------------------------------------------------------------
// Policy cross-check: report.permissions deep-equals defaultElizaMemoryPolicy(dbHandle)
// This is the consent<->validation no-drift guard.
// ---------------------------------------------------------------------------

test("report.permissions deep-equals defaultElizaMemoryPolicy for default db handle", async () => {
  const report = await buildConsentReport({
    TINYCLOUD_AGENT_KEY: KEY_A,
    CONSENT_EXPIRY_ISO: FIXED_EXPIRY,
  });
  expect(report.dbHandle).toBe(DEFAULT_DB_HANDLE);
  expect(report.permissions).toEqual(defaultElizaMemoryPolicy(DEFAULT_DB_HANDLE));
});

test("report.permissions deep-equals defaultElizaMemoryPolicy for custom TINYCLOUD_DB_HANDLE", async () => {
  const customDbHandle = "custom.tinycloud.myapp/data";
  const report = await buildConsentReport({
    TINYCLOUD_AGENT_KEY: KEY_A,
    TINYCLOUD_DB_HANDLE: customDbHandle,
    CONSENT_EXPIRY_ISO: FIXED_EXPIRY,
  });
  expect(report.dbHandle).toBe(customDbHandle);
  expect(report.permissions).toEqual(defaultElizaMemoryPolicy(customDbHandle));
});

test("report.permissions does NOT equal defaultElizaMemoryPolicy for a different db handle (drift guard integrity)", async () => {
  const report = await buildConsentReport({
    TINYCLOUD_AGENT_KEY: KEY_A,
    CONSENT_EXPIRY_ISO: FIXED_EXPIRY,
  });
  // If the harness incorrectly hardcodes the path instead of substituting dbHandle,
  // the custom-db-handle deep-equal test above would fail. This test is a meta-guard
  // that confirms the deep-equal comparison itself distinguishes different db handles.
  expect(report.permissions).not.toEqual(defaultElizaMemoryPolicy("other.handle/different-db"));
});

// ---------------------------------------------------------------------------
// No-secret-leak: agent key never appears in emitted report or error messages
// ---------------------------------------------------------------------------

test("emitted report serialization does not contain agent key hex value", async () => {
  const report = await buildConsentReport({
    TINYCLOUD_AGENT_KEY: KEY_A,
    CONSENT_EXPIRY_ISO: FIXED_EXPIRY,
  });
  const serialized = JSON.stringify(report).toLowerCase();
  // The raw key hex (without 0x prefix) must not appear anywhere in the report.
  expect(serialized).not.toContain(KEY_A.slice(2).toLowerCase());
});

test("emitted report does not contain key-file contents when using TINYCLOUD_AGENT_KEY_FILE", async () => {
  const dir = mkdtempSync(join(tmpdir(), "consent-harness-test-"));
  const keyFilePath = join(dir, "agent.key");
  writeFileSync(keyFilePath, KEY_B + "\n");

  const report = await buildConsentReport({
    TINYCLOUD_AGENT_KEY_FILE: keyFilePath,
    CONSENT_EXPIRY_ISO: FIXED_EXPIRY,
  });
  const serialized = JSON.stringify(report).toLowerCase();
  expect(serialized).not.toContain(KEY_B.slice(2).toLowerCase());
});

test("error on unresolvable key does not expose the key value in the message", async () => {
  // "invalid-hex-not-a-key" is not valid key material; the harness must wrap the
  // underlying error and name only the field, never the value.
  let error: Error | undefined;
  let report: Awaited<ReturnType<typeof buildConsentReport>> | undefined;
  try {
    report = await buildConsentReport({
      TINYCLOUD_AGENT_KEY: "invalid-hex-not-a-key",
      CONSENT_EXPIRY_ISO: FIXED_EXPIRY,
    });
  } catch (e) {
    error = e as Error;
  }
  // At least one of error or report must be set.
  expect(error !== undefined || report !== undefined).toBe(true);
  if (error) {
    // Error must name the field, never dump the value.
    expect(error.message).toMatch(/TINYCLOUD_AGENT_KEY/);
    expect(error.message).not.toContain("invalid-hex-not-a-key");
  }
  if (report) {
    // If the SDK somehow accepted the invalid key, the value must not appear in output.
    expect(JSON.stringify(report)).not.toContain("invalid-hex-not-a-key");
  }
});
