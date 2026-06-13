// NO-NETWORK, NO-passkey deterministic negative-fixture rejection tests for Phase 7.
//
// CI-runnable correctness proof: the three negative-fixture cases (wrong-delegatee,
// expired, insufficient-policy) are REJECTED with clear, field-specific errors and
// NO leaked Authorization header value or agent key.
//
// Validation surface: Phase 4 validateDelegationPolicy from delegation-policy.ts.
// Fixtures: Phase 7 fixture mutator helper (scripts/fixtures/make-delegation-fixtures.ts).
//
// CASE NAMES referenced by regression guard phase7-negative-fixtures-present:
//   wrong-delegatee / wrongDelegatee / expired / insufficient
//
// HARD CONTRACT:
//   - NO network. NO TINYCLOUD_LIVE. NO useDelegation call.
//   - NO real secret material in assertions or fixtures.
//   - Rejection happens at validation, BEFORE any activation or SQL use.
//   - No introduction of useDelegation( into package src/.

import { expect, test } from "bun:test";
import {
  DelegationPolicyError,
  defaultElizaMemoryPolicy,
  deserializeDelegationSafe,
  validateDelegationPolicy,
} from "@tinycloud/agent-client";
import {
  withExpired,
  withInsufficientPolicy,
  withWrongDelegatee,
} from "./fixtures/make-delegation-fixtures.ts";

// The stable agent DID encoded in the committed baseline fixture (Hardhat test account #0).
// This is the DID the agent "claims to be" — the validator asserts the delegation's
// delegateDID equals this.
const AGENT_DID = "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

// A different deterministic DID (Hardhat test account #1) used to craft the wrong-delegatee
// fixture. It must not equal AGENT_DID.
const OTHER_DID = "did:pkh:eip155:1:0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

// A date well in the past — used to craft the expired fixture.
const PAST_DATE = new Date("2020-01-01T00:00:00.000Z");

// The scrubbed Authorization placeholder in the committed sample fixture.
// Error messages MUST NOT contain this value (or any auth-bearing header text).
const AUTH_PLACEHOLDER = "SCRUBBED_AUTH_TOKEN_PLACEHOLDER";

// Default Eliza-memory policy: read + write + admin on the default db handle.
// Shared with Phase 6 consent harness (cohesion §2.1).
const POLICY = defaultElizaMemoryPolicy();

// ---------------------------------------------------------------------------
// wrong-delegatee — the fixture grants access to OTHER_DID, not our AGENT_DID
// ---------------------------------------------------------------------------

test("wrong-delegatee: validateDelegationPolicy throws DelegationPolicyError", () => {
  const delegation = deserializeDelegationSafe(withWrongDelegatee(OTHER_DID));
  expect(() =>
    validateDelegationPolicy(delegation, { agentDID: AGENT_DID, policy: POLICY }),
  ).toThrow(DelegationPolicyError);
});

test("wrongDelegatee: reason is WRONG_DELEGATEE", () => {
  const delegation = deserializeDelegationSafe(withWrongDelegatee(OTHER_DID));
  let caught: DelegationPolicyError | undefined;
  try {
    validateDelegationPolicy(delegation, { agentDID: AGENT_DID, policy: POLICY });
  } catch (e) {
    if (e instanceof DelegationPolicyError) caught = e;
  }
  expect(caught).toBeDefined();
  expect(caught!.reason).toBe("WRONG_DELEGATEE");
});

test("wrong-delegatee: error message mentions delegatee mismatch (both DIDs appear)", () => {
  const delegation = deserializeDelegationSafe(withWrongDelegatee(OTHER_DID));
  let caught: DelegationPolicyError | undefined;
  try {
    validateDelegationPolicy(delegation, { agentDID: AGENT_DID, policy: POLICY });
  } catch (e) {
    if (e instanceof DelegationPolicyError) caught = e;
  }
  expect(caught).toBeDefined();
  expect(caught!.message).toMatch(/delegat/i);
  // Both the expected and actual DID appear in the message for clear diagnosis.
  expect(caught!.message).toContain(AGENT_DID);
  expect(caught!.message).toContain(OTHER_DID);
});

test("wrong-delegatee: error message does not leak Authorization header value", () => {
  const delegation = deserializeDelegationSafe(withWrongDelegatee(OTHER_DID));
  let caught: DelegationPolicyError | undefined;
  try {
    validateDelegationPolicy(delegation, { agentDID: AGENT_DID, policy: POLICY });
  } catch (e) {
    if (e instanceof DelegationPolicyError) caught = e;
  }
  expect(caught).toBeDefined();
  expect(caught!.message).not.toContain(AUTH_PLACEHOLDER);
  expect(caught!.message).not.toContain("Authorization");
  expect(caught!.message).not.toMatch(/Bearer/);
});

// ---------------------------------------------------------------------------
// expired — the delegation's expiry timestamp is in the past
// ---------------------------------------------------------------------------

test("expired: validateDelegationPolicy throws DelegationPolicyError", () => {
  const delegation = deserializeDelegationSafe(withExpired(PAST_DATE));
  expect(() =>
    validateDelegationPolicy(delegation, { agentDID: AGENT_DID, policy: POLICY }),
  ).toThrow(DelegationPolicyError);
});

test("expired: reason is EXPIRED", () => {
  const delegation = deserializeDelegationSafe(withExpired(PAST_DATE));
  let caught: DelegationPolicyError | undefined;
  try {
    validateDelegationPolicy(delegation, { agentDID: AGENT_DID, policy: POLICY });
  } catch (e) {
    if (e instanceof DelegationPolicyError) caught = e;
  }
  expect(caught).toBeDefined();
  expect(caught!.reason).toBe("EXPIRED");
});

test("expired: error message specifically says EXPIRED, not a generic failure", () => {
  const delegation = deserializeDelegationSafe(withExpired(PAST_DATE));
  let caught: DelegationPolicyError | undefined;
  try {
    validateDelegationPolicy(delegation, { agentDID: AGENT_DID, policy: POLICY });
  } catch (e) {
    if (e instanceof DelegationPolicyError) caught = e;
  }
  expect(caught).toBeDefined();
  expect(caught!.message.toLowerCase()).toMatch(/expir/);
  // The past expiry timestamp itself appears in the message for clear diagnosis.
  expect(caught!.message).toContain(PAST_DATE.toISOString());
});

test("expired: error message does not leak Authorization header value", () => {
  const delegation = deserializeDelegationSafe(withExpired(PAST_DATE));
  let caught: DelegationPolicyError | undefined;
  try {
    validateDelegationPolicy(delegation, { agentDID: AGENT_DID, policy: POLICY });
  } catch (e) {
    if (e instanceof DelegationPolicyError) caught = e;
  }
  expect(caught).toBeDefined();
  expect(caught!.message).not.toContain(AUTH_PLACEHOLDER);
  expect(caught!.message).not.toContain("Authorization");
  expect(caught!.message).not.toMatch(/Bearer/);
});

// ---------------------------------------------------------------------------
// insufficient-policy — delegation grants only tinycloud.sql/read, missing write+admin
// ---------------------------------------------------------------------------

test("insufficient: validateDelegationPolicy throws DelegationPolicyError", () => {
  const delegation = deserializeDelegationSafe(withInsufficientPolicy());
  expect(() =>
    validateDelegationPolicy(delegation, { agentDID: AGENT_DID, policy: POLICY }),
  ).toThrow(DelegationPolicyError);
});

test("insufficient: reason is INSUFFICIENT_ACTIONS", () => {
  const delegation = deserializeDelegationSafe(withInsufficientPolicy());
  let caught: DelegationPolicyError | undefined;
  try {
    validateDelegationPolicy(delegation, { agentDID: AGENT_DID, policy: POLICY });
  } catch (e) {
    if (e instanceof DelegationPolicyError) caught = e;
  }
  expect(caught).toBeDefined();
  expect(caught!.reason).toBe("INSUFFICIENT_ACTIONS");
});

test("insufficient-policy: error names the missing SQL resource or action for the memory db handle", () => {
  const delegation = deserializeDelegationSafe(withInsufficientPolicy());
  let caught: DelegationPolicyError | undefined;
  try {
    validateDelegationPolicy(delegation, { agentDID: AGENT_DID, policy: POLICY });
  } catch (e) {
    if (e instanceof DelegationPolicyError) caught = e;
  }
  expect(caught).toBeDefined();
  // Error must name the missing SQL capability — write and/or admin should appear.
  const msg = caught!.message;
  const namesMissing =
    msg.includes("write") || msg.includes("admin") || msg.includes("missing");
  expect(namesMissing).toBe(true);
  // The missing actions context is also available on the error object.
  const missing = caught!.context?.["missing"] as string[] | undefined;
  expect(Array.isArray(missing)).toBe(true);
  expect(missing!.length).toBeGreaterThan(0);
});

test("insufficient-policy: error does not leak Authorization header value", () => {
  const delegation = deserializeDelegationSafe(withInsufficientPolicy());
  let caught: DelegationPolicyError | undefined;
  try {
    validateDelegationPolicy(delegation, { agentDID: AGENT_DID, policy: POLICY });
  } catch (e) {
    if (e instanceof DelegationPolicyError) caught = e;
  }
  expect(caught).toBeDefined();
  expect(caught!.message).not.toContain(AUTH_PLACEHOLDER);
  expect(caught!.message).not.toContain("Authorization");
  expect(caught!.message).not.toMatch(/Bearer/);
});

// ---------------------------------------------------------------------------
// Cross-cutting: no secret leakage across all three negative cases
// ---------------------------------------------------------------------------

test("no error message contains Authorization header value or agent-key material across all negative cases", () => {
  const cases: Array<[string, () => string]> = [
    ["wrong-delegatee", () => withWrongDelegatee(OTHER_DID)],
    ["expired", () => withExpired(PAST_DATE)],
    ["insufficient-policy", () => withInsufficientPolicy()],
  ];
  for (const [label, makeFixture] of cases) {
    const delegation = deserializeDelegationSafe(makeFixture());
    let caught: DelegationPolicyError | undefined;
    try {
      validateDelegationPolicy(delegation, { agentDID: AGENT_DID, policy: POLICY });
    } catch (e) {
      if (e instanceof DelegationPolicyError) caught = e;
    }
    expect(caught, `${label}: expected DelegationPolicyError`).toBeDefined();
    const msg = caught!.message;
    expect(msg, `${label}: must not contain auth placeholder`).not.toContain(AUTH_PLACEHOLDER);
    expect(msg, `${label}: must not contain Authorization`).not.toContain("Authorization");
    expect(msg, `${label}: must not contain Bearer`).not.toMatch(/Bearer/);
    // No 64-char hex private key (agent key) should appear in any error message.
    expect(msg, `${label}: must not contain hex private key`).not.toMatch(/0x[0-9a-fA-F]{64}/);
  }
});
