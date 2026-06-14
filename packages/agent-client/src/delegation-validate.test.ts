// Tests for validateDelegationShape — Phase 3 / Task 3 (TDD).
//
// All checks use ONLY confirmed 2.3.0 field names from phase-3-sdk-findings.md.
// Error messages must carry field names only, never values (especially never
// delegationHeader.Authorization or agentKey).

import { expect, test } from "bun:test";
import type { PortableDelegation } from "@tinycloud/node-sdk";
import { DelegationShapeError, validateDelegationShape } from "./delegation-validate.ts";

const AGENT_DID = "did:pkh:eip155:1:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const DB_HANDLE = "xyz.tinycloud.eliza/memory";
const FUTURE_EXPIRY = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
const PAST_EXPIRY = new Date(Date.now() - 1000); // 1 second ago

/** Build a minimal valid PortableDelegation for testing. */
function validDelegation(overrides: Partial<Record<string, unknown>> = {}): PortableDelegation {
  return {
    ownerAddress: "0xowner1234567890abcdef1234567890abcdef12",
    delegateDID: AGENT_DID,
    spaceId: "tinycloud:pkh:eip155:1:0xowner1234567890abcdef1234567890abcdef12:default",
    path: DB_HANDLE,
    actions: ["tinycloud.sql/read", "tinycloud.sql/write"],
    expiry: FUTURE_EXPIRY,
    cid: "bafy-fake-cid",
    delegationHeader: { Authorization: "Bearer SUPER-SECRET-TOKEN-MUST-NEVER-LEAK" },
    chainId: 1,
    ...overrides,
  } as unknown as PortableDelegation;
}

// ---------------------------------------------------------------------------
// 1. Valid delegation passes
// ---------------------------------------------------------------------------

test("valid delegation (all required fields + future expiry + SQL actions) passes without throw", () => {
  expect(() =>
    validateDelegationShape(validDelegation(), { agentDid: AGENT_DID, dbHandle: DB_HANDLE }),
  ).not.toThrow();
});

test("valid delegation with resources instead of actions also passes", () => {
  const delegation = validDelegation({
    actions: ["tinycloud.kv/read"],
    resources: [{ service: "sql", space: "space-1", path: DB_HANDLE, actions: ["tinycloud.sql/read"] }],
  });
  expect(() =>
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE }),
  ).not.toThrow();
});

// ---------------------------------------------------------------------------
// 2. Missing ownerAddress rejected — no secret in the error message
// ---------------------------------------------------------------------------

test("missing ownerAddress is rejected with DelegationShapeError", () => {
  const delegation = validDelegation({ ownerAddress: "" });
  expect(() =>
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE }),
  ).toThrow(DelegationShapeError);
});

test("missing ownerAddress error message contains 'ownerAddress' field name", () => {
  const delegation = validDelegation({ ownerAddress: "" });
  let caught: Error | null = null;
  try {
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE });
  } catch (e) {
    caught = e as Error;
  }
  expect(caught).not.toBeNull();
  expect(caught!.message).toContain("ownerAddress");
});

test("missing ownerAddress error does not include Authorization or agent key", () => {
  const agentKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const delegation = validDelegation({ ownerAddress: "" });
  let caught: Error | null = null;
  try {
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE });
  } catch (e) {
    caught = e as Error;
  }
  const msg = caught?.message ?? "";
  expect(msg).not.toContain("Authorization");
  expect(msg).not.toContain("SECRET");
  expect(msg).not.toContain(agentKey);
  expect(msg).not.toContain(AGENT_DID);
  expect(msg).not.toContain("SUPER-SECRET");
});

test("undefined ownerAddress is rejected", () => {
  const delegation = validDelegation({ ownerAddress: undefined });
  expect(() =>
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE }),
  ).toThrow(DelegationShapeError);
});

// ---------------------------------------------------------------------------
// 3. delegateDID != agentDid rejected
// ---------------------------------------------------------------------------

test("delegateDID not matching agentDid is rejected with DelegationShapeError", () => {
  const delegation = validDelegation({ delegateDID: "did:pkh:eip155:1:0xwrongagent" });
  expect(() =>
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE }),
  ).toThrow(DelegationShapeError);
});

test("delegateDID mismatch error contains 'delegateDID' field name", () => {
  const delegation = validDelegation({ delegateDID: "did:pkh:eip155:1:0xwrongagent" });
  let caught: Error | null = null;
  try {
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE });
  } catch (e) {
    caught = e as Error;
  }
  expect(caught!.message).toContain("delegateDID");
});

test("delegateDID mismatch error never includes the DID value", () => {
  const wrongDid = "did:pkh:eip155:1:0xwrongagent";
  const delegation = validDelegation({ delegateDID: wrongDid });
  let caught: Error | null = null;
  try {
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE });
  } catch (e) {
    caught = e as Error;
  }
  const msg = caught?.message ?? "";
  expect(msg).not.toContain(wrongDid);
  expect(msg).not.toContain(AGENT_DID);
  expect(msg).not.toContain("Authorization");
});

test("missing delegateDID is rejected", () => {
  const delegation = validDelegation({ delegateDID: "" });
  expect(() =>
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE }),
  ).toThrow(DelegationShapeError);
});

// ---------------------------------------------------------------------------
// 4. Absent / expired expiry rejected
// ---------------------------------------------------------------------------

test("missing expiry (undefined) is rejected with DelegationShapeError", () => {
  const delegation = validDelegation({ expiry: undefined });
  expect(() =>
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE }),
  ).toThrow(DelegationShapeError);
});

test("missing expiry error contains 'expiry' field name", () => {
  const delegation = validDelegation({ expiry: undefined });
  let caught: Error | null = null;
  try {
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE });
  } catch (e) {
    caught = e as Error;
  }
  expect(caught!.message).toContain("expiry");
});

test("expired Date expiry is rejected with DelegationShapeError", () => {
  const delegation = validDelegation({ expiry: PAST_EXPIRY });
  expect(() =>
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE }),
  ).toThrow(DelegationShapeError);
});

test("expired expiry error contains 'expiry' field name but not the timestamp value", () => {
  const delegation = validDelegation({ expiry: PAST_EXPIRY });
  let caught: Error | null = null;
  try {
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE });
  } catch (e) {
    caught = e as Error;
  }
  expect(caught!.message).toContain("expiry");
  expect(caught!.message).not.toContain(PAST_EXPIRY.toISOString());
  expect(caught!.message).not.toContain(String(PAST_EXPIRY.getTime()));
});

test("invalid (NaN) expiry is rejected", () => {
  const delegation = validDelegation({ expiry: new Date("not-a-date") });
  expect(() =>
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE }),
  ).toThrow(DelegationShapeError);
});

test("delegation expiring exactly now (at boundary) is rejected", () => {
  // <= Date.now() should reject; test with slightly past time
  const delegation = validDelegation({ expiry: new Date(Date.now() - 1) });
  expect(() =>
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE }),
  ).toThrow(DelegationShapeError);
});

// ---------------------------------------------------------------------------
// 5. Missing SQL resource for dbHandle rejected
// ---------------------------------------------------------------------------

test("delegation with no SQL actions and no SQL resources is rejected", () => {
  const delegation = validDelegation({ actions: ["tinycloud.kv/read"], resources: undefined });
  expect(() =>
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE }),
  ).toThrow(DelegationShapeError);
});

test("no SQL resource error contains 'actions' or 'resources' field name", () => {
  const delegation = validDelegation({ actions: [], resources: undefined });
  let caught: Error | null = null;
  try {
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE });
  } catch (e) {
    caught = e as Error;
  }
  const msg = caught!.message;
  const mentionsField = msg.includes("actions") || msg.includes("resources");
  expect(mentionsField).toBe(true);
});

test("empty actions array with no resources is rejected", () => {
  const delegation = validDelegation({ actions: [] });
  expect(() =>
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE }),
  ).toThrow(DelegationShapeError);
});

test("kv-only actions with no SQL resources is rejected", () => {
  const delegation = validDelegation({
    actions: ["tinycloud.kv/read", "tinycloud.kv/write"],
    resources: [{ service: "kv", space: "space-1", path: "kv-path", actions: ["tinycloud.kv/read"] }],
  });
  expect(() =>
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE }),
  ).toThrow(DelegationShapeError);
});

test("delegation with only a SQL resource entry (no SQL actions) passes", () => {
  const delegation = validDelegation({
    actions: ["tinycloud.kv/read"],
    resources: [{ service: "sql", space: "space-1", path: DB_HANDLE, actions: ["tinycloud.sql/read"] }],
  });
  expect(() =>
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE }),
  ).not.toThrow();
});

// ---------------------------------------------------------------------------
// 6. Error messages never include secret material
// ---------------------------------------------------------------------------

test("no validation error ever includes delegationHeader.Authorization value", () => {
  const secretToken = "SUPER-SECRET-TOKEN-MUST-NEVER-LEAK";
  const cases: PortableDelegation[] = [
    validDelegation({ ownerAddress: "" }),
    validDelegation({ delegateDID: "did:pkh:eip155:1:0xwrong" }),
    validDelegation({ expiry: PAST_EXPIRY }),
    validDelegation({ actions: [], resources: undefined }),
  ];

  for (const delegation of cases) {
    let caught: Error | null = null;
    try {
      validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE });
    } catch (e) {
      caught = e as Error;
    }
    if (caught) {
      expect(caught.message).not.toContain(secretToken);
      expect(caught.message).not.toContain("Authorization");
      expect(caught.message).not.toContain("Bearer");
    }
  }
});

test("no validation error includes agentKey value", () => {
  const agentKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const delegation = validDelegation({ delegateDID: "did:pkh:eip155:1:0xwrong" });
  let caught: Error | null = null;
  try {
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: agentKey });
  } catch (e) {
    caught = e as Error;
  }
  // If it throws, the error must not include the agentKey value in the dbHandle position
  if (caught) {
    // dbHandle is the Phase 4 / TODO path — it should not appear in messages at Phase 3
    expect(caught.message).not.toContain(agentKey);
  }
});

test("DelegationShapeError has correct name property", () => {
  const delegation = validDelegation({ ownerAddress: "" });
  let caught: unknown = null;
  try {
    validateDelegationShape(delegation, { agentDid: AGENT_DID, dbHandle: DB_HANDLE });
  } catch (e) {
    caught = e;
  }
  expect(caught instanceof DelegationShapeError).toBe(true);
  expect((caught as DelegationShapeError).name).toBe("DelegationShapeError");
});
