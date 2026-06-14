// Phase 4 SDK symbol probe — see docs/openkey-phases/phase-4-policy-validation-plan.md
//
// This describe block is a fail-fast probe that confirms every symbol the Phase 4
// delegation policy validator needs is actually re-exported by @tinycloud/node-sdk 2.3.0.
// node-sdk 2.3.0 is resolved from bun.lock but its root re-export list was grounded
// against 2.2.0-beta.12 on disk; a symbol could be renamed or dropped.
//
// pkhDid is already proven (imported by agent-identity.ts); the rest are probed here.
//
// SERVICE_SHORT_TO_LONG: confirmed MISSING from node-sdk 2.3.0 (not in dist/index.d.ts
// or dist/index.js). Probed via namespace import to avoid ESM module-load crash.
// Phase4 plan fallback: import from @tinycloud/sdk-core directly (phase4-validate-core).

import { describe, expect, test } from "bun:test";
import {
  deserializeDelegation,
  expandActionShortNames,
  pkhDid,
  principalDidEquals,
  serializeDelegation,
} from "@tinycloud/node-sdk";
import type { PortableDelegation } from "@tinycloud/node-sdk";
import * as nodeSdkNs from "@tinycloud/node-sdk";
import { DEFAULT_DB_HANDLE } from "./config";
import {
  assertWellFormed,
  computePolicyHash,
  defaultElizaMemoryPolicy,
  deserializeDelegationSafe,
  evaluateDelegationStatus,
  validateDelegationPolicy,
} from "./delegation-policy";
import { DelegationPolicyError } from "./errors";

describe("node-sdk re-export surface", () => {
  test("deserializeDelegation is a function", () => {
    expect(typeof deserializeDelegation).toBe("function");
  });

  test("serializeDelegation is a function", () => {
    expect(typeof serializeDelegation).toBe("function");
  });

  test("expandActionShortNames is a function", () => {
    expect(typeof expandActionShortNames).toBe("function");
  });

  test("principalDidEquals is a function", () => {
    expect(typeof principalDidEquals).toBe("function");
  });

  test("pkhDid is a function (already proven by agent-identity.ts)", () => {
    expect(typeof pkhDid).toBe("function");
  });

  // SERVICE_SHORT_TO_LONG is NOT re-exported by node-sdk 2.3.0 (confirmed by runtime probe).
  // Fallback per plan: import from @tinycloud/sdk-core in phase4-validate-core.
  test("SERVICE_SHORT_TO_LONG is NOT in node-sdk 2.3.0 — blocker for phase4-validate-core, use sdk-core fallback", () => {
    // Use namespace import so missing export yields undefined rather than a module-load crash.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ssl = (nodeSdkNs as any).SERVICE_SHORT_TO_LONG;
    expect(ssl).toBeUndefined();
  });
});

describe("deserializeDelegationSafe", () => {
  test("throws DelegationPolicyError with reason MALFORMED for invalid JSON", () => {
    expect(() => deserializeDelegationSafe("not json")).toThrow(DelegationPolicyError);
    try {
      deserializeDelegationSafe("not json");
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("MALFORMED");
    }
  });

  test("throws DelegationPolicyError with reason MALFORMED for empty string", () => {
    expect(() => deserializeDelegationSafe("")).toThrow(DelegationPolicyError);
    try {
      deserializeDelegationSafe("");
    } catch (e) {
      expect((e as DelegationPolicyError).reason).toBe("MALFORMED");
    }
  });

  test("error message does not contain the serialized blob", () => {
    const blob = "secret-blob-content-12345";
    try {
      deserializeDelegationSafe(blob);
    } catch (e) {
      expect((e as DelegationPolicyError).message).not.toContain(blob);
    }
  });

  test("error message does not contain Authorization or authHeader", () => {
    try {
      deserializeDelegationSafe("not json");
    } catch (e) {
      const msg = (e as DelegationPolicyError).message.toLowerCase();
      expect(msg).not.toContain("authorization");
      expect(msg).not.toContain("authheader");
    }
  });

  test("throws DelegationPolicyError (not raw Error) so callers can discriminate", () => {
    try {
      deserializeDelegationSafe("{}");
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
    }
  });
});

describe("assertWellFormed", () => {
  const makeValidDelegation = () => ({
    delegateDID: "did:pkh:eip155:1:0xABCDEF1234567890",
    expiry: new Date(Date.now() + 1000 * 60 * 60),
    spaceId: "tinycloud:pkh:eip155:1:0xOWNER:default",
    path: "xyz.tinycloud.eliza/memory",
    actions: ["tinycloud.sql/read"],
    cid: "bafy",
    ownerAddress: "0xOWNER",
    chainId: 1,
  });

  test("does not throw for a well-formed delegation", () => {
    expect(() => assertWellFormed(makeValidDelegation())).not.toThrow();
  });

  test("throws MALFORMED when delegateDID is missing", () => {
    const d = { ...makeValidDelegation(), delegateDID: undefined };
    try {
      assertWellFormed(d);
      expect(true).toBe(false); // should not reach here
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("MALFORMED");
    }
  });

  test("throws MALFORMED when delegateDID is empty string", () => {
    const d = { ...makeValidDelegation(), delegateDID: "" };
    try {
      assertWellFormed(d);
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("MALFORMED");
    }
  });

  test("throws MALFORMED when expiry is an unparseable string", () => {
    const d = { ...makeValidDelegation(), expiry: "not-a-date" as unknown as Date };
    try {
      assertWellFormed(d);
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("MALFORMED");
    }
  });

  test("does NOT throw EXPIRED for a past expiry — MALFORMED only for unparseable expiry", () => {
    // Past date is parseable — assertWellFormed only checks parseability, not staleness
    const d = { ...makeValidDelegation(), expiry: new Date(2000, 0, 1) };
    expect(() => assertWellFormed(d)).not.toThrow();
  });

  test("accepts expiry as an ISO string (defensive coercion)", () => {
    const d = { ...makeValidDelegation(), expiry: new Date(Date.now() + 60000).toISOString() as unknown as Date };
    expect(() => assertWellFormed(d)).not.toThrow();
  });

  test("error message does not contain any auth-bearing field names", () => {
    const d = { ...makeValidDelegation(), delegateDID: undefined };
    try {
      assertWellFormed(d);
    } catch (e) {
      const msg = (e as DelegationPolicyError).message.toLowerCase();
      expect(msg).not.toContain("authorization");
      expect(msg).not.toContain("authheader");
      expect(msg).not.toContain("delegationheader");
    }
  });
});

describe("defaultElizaMemoryPolicy", () => {
  test("returns a policy with two resources", () => {
    const policy = defaultElizaMemoryPolicy();
    expect(policy.resources).toHaveLength(2);
  });

  test("SQL resource uses DEFAULT_DB_HANDLE as path by default", () => {
    const policy = defaultElizaMemoryPolicy();
    const sql = policy.resources.find(r => r.serviceShort === "sql");
    expect(sql).toBeDefined();
    expect(sql!.path).toBe(DEFAULT_DB_HANDLE);
  });

  test("SQL resource path tracks the passed dbHandle argument", () => {
    const customHandle = "xyz.tinycloud.myapp/customdb";
    const policy = defaultElizaMemoryPolicy(customHandle);
    const sql = policy.resources.find(r => r.serviceShort === "sql");
    expect(sql!.path).toBe(customHandle);
    // Must NOT be the default literal — proves no second hardcoded copy
    expect(sql!.path).not.toBe(DEFAULT_DB_HANDLE);
  });

  test("SQL resource has serviceLong tinycloud.sql and serviceShort sql", () => {
    const policy = defaultElizaMemoryPolicy();
    const sql = policy.resources.find(r => r.serviceShort === "sql");
    expect(sql!.serviceLong).toBe("tinycloud.sql");
    expect(sql!.serviceShort).toBe("sql");
  });

  test("SQL resource requiredActions are full-URN read/write/admin", () => {
    const policy = defaultElizaMemoryPolicy();
    const sql = policy.resources.find(r => r.serviceShort === "sql");
    expect(sql!.requiredActions).toContain("tinycloud.sql/read");
    expect(sql!.requiredActions).toContain("tinycloud.sql/write");
    expect(sql!.requiredActions).toContain("tinycloud.sql/admin");
    expect(sql!.requiredActions).toHaveLength(3);
  });

  test("SQL resource is required: true", () => {
    const policy = defaultElizaMemoryPolicy();
    const sql = policy.resources.find(r => r.serviceShort === "sql");
    expect(sql!.required).toBe(true);
  });

  test("capabilities resource has serviceLong tinycloud.capabilities and serviceShort capabilities", () => {
    const policy = defaultElizaMemoryPolicy();
    const caps = policy.resources.find(r => r.serviceShort === "capabilities");
    expect(caps).toBeDefined();
    expect(caps!.serviceLong).toBe("tinycloud.capabilities");
    expect(caps!.serviceShort).toBe("capabilities");
  });

  test("capabilities resource has empty path", () => {
    const policy = defaultElizaMemoryPolicy();
    const caps = policy.resources.find(r => r.serviceShort === "capabilities");
    expect(caps!.path).toBe("");
  });

  test("capabilities resource requiredActions contains tinycloud.capabilities/read", () => {
    const policy = defaultElizaMemoryPolicy();
    const caps = policy.resources.find(r => r.serviceShort === "capabilities");
    expect(caps!.requiredActions).toContain("tinycloud.capabilities/read");
    expect(caps!.requiredActions).toHaveLength(1);
  });

  test("capabilities resource is required: false (optional)", () => {
    const policy = defaultElizaMemoryPolicy();
    const caps = policy.resources.find(r => r.serviceShort === "capabilities");
    expect(caps!.required).toBe(false);
  });

  test("different dbHandle args produce different SQL paths (no shared reference)", () => {
    const p1 = defaultElizaMemoryPolicy("a/b");
    const p2 = defaultElizaMemoryPolicy("c/d");
    const sql1 = p1.resources.find(r => r.serviceShort === "sql")!;
    const sql2 = p2.resources.find(r => r.serviceShort === "sql")!;
    expect(sql1.path).toBe("a/b");
    expect(sql2.path).toBe("c/d");
    expect(sql1.path).not.toBe(sql2.path);
  });
});

// ---------------------------------------------------------------------------
// validateDelegationPolicy — full reject matrix (phase4-validate-core)
// ---------------------------------------------------------------------------

describe("validateDelegationPolicy", () => {
  const AGENT_DID = "did:pkh:eip155:1:0xAgentAddress1234567890";
  const OWNER_ADDRESS = "0xOwnerAddress";
  const DB_HANDLE = DEFAULT_DB_HANDLE; // "xyz.tinycloud.eliza/memory"
  const FUTURE = new Date(Date.now() + 1000 * 60 * 60); // 1 hour from now
  const policy = defaultElizaMemoryPolicy(DB_HANDLE);

  // Helpers to build test delegation objects.
  // resources[] shape (multi-resource) — resources is defined.
  function makeMultiResource(overrides: Record<string, unknown> = {}): PortableDelegation {
    return {
      delegateDID: AGENT_DID,
      expiry: FUTURE,
      spaceId: `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:default`,
      path: DB_HANDLE,
      actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
      cid: "bafytest",
      ownerAddress: OWNER_ADDRESS,
      chainId: 1,
      resources: [
        {
          service: "sql",
          space: `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:default`,
          path: DB_HANDLE,
          actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
        },
      ],
      ...overrides,
    } as unknown as PortableDelegation;
  }

  // Flat (single-resource) shape — resources is absent.
  function makeFlat(overrides: Record<string, unknown> = {}): PortableDelegation {
    return {
      delegateDID: AGENT_DID,
      expiry: FUTURE,
      spaceId: `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:default`,
      path: DB_HANDLE,
      actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
      cid: "bafytest",
      ownerAddress: OWNER_ADDRESS,
      chainId: 1,
      // no resources field
      ...overrides,
    } as unknown as PortableDelegation;
  }

  // --- Happy path ---

  test("passes for a valid multi-resource delegation", () => {
    expect(() => validateDelegationPolicy(makeMultiResource(), { agentDID: AGENT_DID, policy })).not.toThrow();
  });

  test("passes for a valid flat (single-resource) delegation", () => {
    expect(() => validateDelegationPolicy(makeFlat(), { agentDID: AGENT_DID, policy })).not.toThrow();
  });

  test("passes when capabilities resource is absent and policy marks it required:false", () => {
    const d = makeMultiResource({
      resources: [
        {
          service: "sql",
          space: `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:default`,
          path: DB_HANDLE,
          actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
        },
        // no capabilities entry — required:false so absence is fine
      ],
    });
    expect(() => validateDelegationPolicy(d, { agentDID: AGENT_DID, policy })).not.toThrow();
  });

  test("passes when SQL actions are provided in short form (normalized via expandActionShortNames)", () => {
    const d = makeMultiResource({
      resources: [
        {
          service: "sql",
          space: `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:default`,
          path: DB_HANDLE,
          actions: ["read", "write", "admin"], // short form — must normalize to full URN
        },
      ],
    });
    expect(() => validateDelegationPolicy(d, { agentDID: AGENT_DID, policy })).not.toThrow();
  });

  // --- WRONG_DELEGATEE ---

  test("throws WRONG_DELEGATEE when delegateDID does not match agentDID (multi-resource)", () => {
    const d = makeMultiResource({ delegateDID: "did:pkh:eip155:1:0xWrongAddress" });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("WRONG_DELEGATEE");
    }
  });

  test("throws WRONG_DELEGATEE when delegateDID does not match agentDID (flat shape)", () => {
    const d = makeFlat({ delegateDID: "did:pkh:eip155:1:0xWrongAddress" });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("WRONG_DELEGATEE");
    }
  });

  test("WRONG_DELEGATEE error message contains expected agentDID and actual delegateDID", () => {
    const wrongDID = "did:pkh:eip155:1:0xWrongAddress";
    const d = makeMultiResource({ delegateDID: wrongDID });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
    } catch (e) {
      const msg = (e as DelegationPolicyError).message;
      expect(msg).toContain(AGENT_DID);
      expect(msg).toContain(wrongDID);
    }
  });

  test("WRONG_DELEGATEE error message does not contain secret material", () => {
    const d = makeMultiResource({ delegateDID: "did:pkh:eip155:1:0xWrongAddress" });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
    } catch (e) {
      const msg = (e as DelegationPolicyError).message.toLowerCase();
      expect(msg).not.toContain("authorization");
      expect(msg).not.toContain("authheader");
      expect(msg).not.toContain("delegationheader");
    }
  });

  // --- EXPIRED ---

  test("throws EXPIRED when expiry is strictly before now (multi-resource, injected now)", () => {
    const pastExpiry = new Date(2020, 0, 1);
    const nowAfter = new Date(2026, 0, 1);
    const d = makeMultiResource({ expiry: pastExpiry });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy, now: nowAfter });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("EXPIRED");
    }
  });

  test("throws EXPIRED when expiry is exactly equal to now (boundary: <= means expired at equal)", () => {
    const exact = new Date(2025, 5, 1, 12, 0, 0, 0);
    const d = makeMultiResource({ expiry: exact });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy, now: exact });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("EXPIRED");
    }
  });

  test("throws EXPIRED when expiry is in the past (flat shape, injected now)", () => {
    const pastExpiry = new Date(2020, 0, 1);
    const nowAfter = new Date(2026, 0, 1);
    const d = makeFlat({ expiry: pastExpiry });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy, now: nowAfter });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("EXPIRED");
    }
  });

  test("EXPIRED error message contains expiry ISO and now ISO", () => {
    const pastExpiry = new Date(2020, 0, 1);
    const nowAfter = new Date(2026, 0, 1);
    const d = makeMultiResource({ expiry: pastExpiry });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy, now: nowAfter });
    } catch (e) {
      const msg = (e as DelegationPolicyError).message;
      expect(msg).toContain(pastExpiry.toISOString());
      expect(msg).toContain(nowAfter.toISOString());
    }
  });

  test("EXPIRED error message does not contain secret material", () => {
    const pastExpiry = new Date(2020, 0, 1);
    const nowAfter = new Date(2026, 0, 1);
    const d = makeMultiResource({ expiry: pastExpiry });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy, now: nowAfter });
    } catch (e) {
      const msg = (e as DelegationPolicyError).message.toLowerCase();
      expect(msg).not.toContain("authorization");
      expect(msg).not.toContain("authheader");
      expect(msg).not.toContain("delegationheader");
    }
  });

  // Matrix order: WRONG_DELEGATEE fires before EXPIRED
  test("WRONG_DELEGATEE fires before EXPIRED when both conditions hold", () => {
    const pastExpiry = new Date(2020, 0, 1);
    const nowAfter = new Date(2026, 0, 1);
    const d = makeMultiResource({ delegateDID: "did:pkh:eip155:1:0xWrongAddr", expiry: pastExpiry });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy, now: nowAfter });
      expect(true).toBe(false);
    } catch (e) {
      expect((e as DelegationPolicyError).reason).toBe("WRONG_DELEGATEE");
    }
  });

  // --- MISSING_SQL_RESOURCE ---

  test("throws MISSING_SQL_RESOURCE when resources[] is present but contains no SQL entry", () => {
    const d = makeMultiResource({
      resources: [
        { service: "kv", space: "tinycloud:pkh:eip155:1:0xOwner:default", path: "some/path", actions: ["tinycloud.kv/get"] },
      ],
    });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("MISSING_SQL_RESOURCE");
    }
  });

  test("throws MISSING_SQL_RESOURCE when resources[] is an empty array", () => {
    const d = makeMultiResource({ resources: [] });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("MISSING_SQL_RESOURCE");
    }
  });

  test("MISSING_SQL_RESOURCE error message contains required service and path", () => {
    const d = makeMultiResource({ resources: [] });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
    } catch (e) {
      const msg = (e as DelegationPolicyError).message;
      expect(msg).toContain("tinycloud.sql");
      expect(msg).toContain(DB_HANDLE);
    }
  });

  test("MISSING_SQL_RESOURCE error message does not contain secret material", () => {
    const d = makeMultiResource({ resources: [] });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
    } catch (e) {
      const msg = (e as DelegationPolicyError).message.toLowerCase();
      expect(msg).not.toContain("authorization");
      expect(msg).not.toContain("authheader");
      expect(msg).not.toContain("delegationheader");
    }
  });

  // Matrix order: EXPIRED fires before MISSING_SQL_RESOURCE
  test("EXPIRED fires before MISSING_SQL_RESOURCE when both conditions hold", () => {
    const pastExpiry = new Date(2020, 0, 1);
    const nowAfter = new Date(2026, 0, 1);
    const d = makeMultiResource({ expiry: pastExpiry, resources: [] });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy, now: nowAfter });
      expect(true).toBe(false);
    } catch (e) {
      expect((e as DelegationPolicyError).reason).toBe("EXPIRED");
    }
  });

  // --- WRONG_DB_HANDLE ---

  test("throws WRONG_DB_HANDLE when SQL resource path does not match policy dbHandle (multi-resource)", () => {
    const d = makeMultiResource({
      resources: [
        {
          service: "sql",
          space: `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:default`,
          path: "wrong/db/handle",
          actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
        },
      ],
    });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("WRONG_DB_HANDLE");
    }
  });

  test("throws WRONG_DB_HANDLE when flat path does not match policy dbHandle", () => {
    const d = makeFlat({ path: "wrong/db/handle" });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("WRONG_DB_HANDLE");
    }
  });

  test("WRONG_DB_HANDLE error message contains expected path and actual path", () => {
    const d = makeFlat({ path: "wrong/db/handle" });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
    } catch (e) {
      const msg = (e as DelegationPolicyError).message;
      expect(msg).toContain(DB_HANDLE);
      expect(msg).toContain("wrong/db/handle");
    }
  });

  test("WRONG_DB_HANDLE error message does not contain secret material", () => {
    const d = makeFlat({ path: "wrong/db/handle" });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
    } catch (e) {
      const msg = (e as DelegationPolicyError).message.toLowerCase();
      expect(msg).not.toContain("authorization");
      expect(msg).not.toContain("authheader");
      expect(msg).not.toContain("delegationheader");
    }
  });

  // Matrix order: MISSING_SQL_RESOURCE fires before WRONG_DB_HANDLE
  test("MISSING_SQL_RESOURCE fires before WRONG_DB_HANDLE when resources[] has no SQL", () => {
    const d = makeMultiResource({
      resources: [
        { service: "kv", space: "x", path: "wrong/path", actions: [] },
      ],
    });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
      expect(true).toBe(false);
    } catch (e) {
      expect((e as DelegationPolicyError).reason).toBe("MISSING_SQL_RESOURCE");
    }
  });

  // --- INSUFFICIENT_ACTIONS ---

  test("throws INSUFFICIENT_ACTIONS when SQL actions are incomplete (multi-resource)", () => {
    const d = makeMultiResource({
      resources: [
        {
          service: "sql",
          space: `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:default`,
          path: DB_HANDLE,
          actions: ["tinycloud.sql/read"], // missing write and admin
        },
      ],
    });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("INSUFFICIENT_ACTIONS");
    }
  });

  test("throws INSUFFICIENT_ACTIONS when flat actions are incomplete", () => {
    const d = makeFlat({ actions: ["tinycloud.sql/read"] });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("INSUFFICIENT_ACTIONS");
    }
  });

  test("INSUFFICIENT_ACTIONS error message contains the missing action URNs", () => {
    const d = makeFlat({ actions: ["tinycloud.sql/read"] }); // missing write + admin
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
    } catch (e) {
      const msg = (e as DelegationPolicyError).message;
      expect(msg).toContain("tinycloud.sql/write");
      expect(msg).toContain("tinycloud.sql/admin");
    }
  });

  test("INSUFFICIENT_ACTIONS error message does not contain secret material", () => {
    const d = makeFlat({ actions: ["tinycloud.sql/read"] });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
    } catch (e) {
      const msg = (e as DelegationPolicyError).message.toLowerCase();
      expect(msg).not.toContain("authorization");
      expect(msg).not.toContain("authheader");
      expect(msg).not.toContain("delegationheader");
    }
  });

  // Matrix order: WRONG_DB_HANDLE fires before INSUFFICIENT_ACTIONS
  test("WRONG_DB_HANDLE fires before INSUFFICIENT_ACTIONS when both conditions hold", () => {
    const d = makeMultiResource({
      resources: [
        {
          service: "sql",
          space: `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:default`,
          path: "wrong/path",
          actions: ["tinycloud.sql/read"], // also insufficient
        },
      ],
    });
    try {
      validateDelegationPolicy(d, { agentDID: AGENT_DID, policy });
      expect(true).toBe(false);
    } catch (e) {
      expect((e as DelegationPolicyError).reason).toBe("WRONG_DB_HANDLE");
    }
  });

  // --- Multi-resource: long-form service name in resources[].service ---

  test("recognizes SQL resource when resources[].service is long form 'tinycloud.sql'", () => {
    const d = makeMultiResource({
      resources: [
        {
          service: "tinycloud.sql", // long form
          space: `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:default`,
          path: DB_HANDLE,
          actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
        },
      ],
    });
    expect(() => validateDelegationPolicy(d, { agentDID: AGENT_DID, policy })).not.toThrow();
  });

  // --- Security: exhaustive check across all rejection scenarios ---

  test("no rejection error message contains Authorization, authHeader, or delegationHeader", () => {
    const nowAfter = new Date(2026, 0, 1);
    const scenarios: Array<() => void> = [
      () => validateDelegationPolicy(makeMultiResource({ delegateDID: "did:pkh:eip155:1:0xWrong" }), { agentDID: AGENT_DID, policy }),
      () => validateDelegationPolicy(makeMultiResource({ expiry: new Date(2020, 0, 1) }), { agentDID: AGENT_DID, policy, now: nowAfter }),
      () => validateDelegationPolicy(makeMultiResource({ resources: [] }), { agentDID: AGENT_DID, policy }),
      () => validateDelegationPolicy(makeMultiResource({ resources: [{ service: "sql", space: "x", path: "wrong", actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"] }] }), { agentDID: AGENT_DID, policy }),
      () => validateDelegationPolicy(makeFlat({ actions: ["tinycloud.sql/read"] }), { agentDID: AGENT_DID, policy }),
    ];
    for (const scenario of scenarios) {
      try {
        scenario();
      } catch (e) {
        const msg = (e as DelegationPolicyError).message.toLowerCase();
        expect(msg).not.toContain("authorization");
        expect(msg).not.toContain("authheader");
        expect(msg).not.toContain("delegationheader");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// computePolicyHash (phase4-policy-hash-status)
// ---------------------------------------------------------------------------

describe("computePolicyHash", () => {
  const AGENT_DID = "did:pkh:eip155:1:0xAgentAddress1234567890";
  const policy = defaultElizaMemoryPolicy();

  test("returns a non-empty hex string", () => {
    const hash = computePolicyHash(policy, AGENT_DID);
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe("string");
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex = 64 chars
  });

  test("is deterministic — same inputs produce the same hash", () => {
    const h1 = computePolicyHash(policy, AGENT_DID);
    const h2 = computePolicyHash(policy, AGENT_DID);
    expect(h1).toBe(h2);
  });

  test("reordered requiredActions produce the same hash", () => {
    const policyA: typeof policy = {
      resources: [
        {
          serviceLong: "tinycloud.sql",
          serviceShort: "sql",
          path: DEFAULT_DB_HANDLE,
          requiredActions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
          required: true,
        },
      ],
    };
    const policyB: typeof policy = {
      resources: [
        {
          serviceLong: "tinycloud.sql",
          serviceShort: "sql",
          path: DEFAULT_DB_HANDLE,
          requiredActions: ["tinycloud.sql/admin", "tinycloud.sql/read", "tinycloud.sql/write"], // reordered
          required: true,
        },
      ],
    };
    expect(computePolicyHash(policyA, AGENT_DID)).toBe(computePolicyHash(policyB, AGENT_DID));
  });

  test("different path produces a different hash", () => {
    const policyA: typeof policy = {
      resources: [
        {
          serviceLong: "tinycloud.sql",
          serviceShort: "sql",
          path: "xyz.tinycloud.eliza/memory",
          requiredActions: ["tinycloud.sql/read"],
          required: true,
        },
      ],
    };
    const policyB: typeof policy = {
      resources: [
        {
          serviceLong: "tinycloud.sql",
          serviceShort: "sql",
          path: "xyz.tinycloud.eliza/other",
          requiredActions: ["tinycloud.sql/read"],
          required: true,
        },
      ],
    };
    expect(computePolicyHash(policyA, AGENT_DID)).not.toBe(computePolicyHash(policyB, AGENT_DID));
  });

  test("different agentDID produces a different hash", () => {
    const h1 = computePolicyHash(policy, "did:pkh:eip155:1:0xAAAAAAAA");
    const h2 = computePolicyHash(policy, "did:pkh:eip155:1:0xBBBBBBBB");
    expect(h1).not.toBe(h2);
  });

  test("reordered resources (by serviceLong+path) produce the same hash", () => {
    const policyA: typeof policy = {
      resources: [
        { serviceLong: "tinycloud.capabilities", serviceShort: "capabilities", path: "", requiredActions: ["tinycloud.capabilities/read"], required: false },
        { serviceLong: "tinycloud.sql", serviceShort: "sql", path: DEFAULT_DB_HANDLE, requiredActions: ["tinycloud.sql/read"], required: true },
      ],
    };
    const policyB: typeof policy = {
      resources: [
        { serviceLong: "tinycloud.sql", serviceShort: "sql", path: DEFAULT_DB_HANDLE, requiredActions: ["tinycloud.sql/read"], required: true },
        { serviceLong: "tinycloud.capabilities", serviceShort: "capabilities", path: "", requiredActions: ["tinycloud.capabilities/read"], required: false },
      ],
    };
    expect(computePolicyHash(policyA, AGENT_DID)).toBe(computePolicyHash(policyB, AGENT_DID));
  });
});

// ---------------------------------------------------------------------------
// evaluateDelegationStatus (phase4-policy-hash-status)
// ---------------------------------------------------------------------------

describe("evaluateDelegationStatus", () => {
  const AGENT_DID = "did:pkh:eip155:1:0xAgentAddress1234567890";
  const OWNER_ADDRESS = "0xOwnerAddress";
  const DB_HANDLE = DEFAULT_DB_HANDLE;
  const FUTURE = new Date(Date.now() + 1000 * 60 * 60); // 1 hour from now
  const policy = defaultElizaMemoryPolicy(DB_HANDLE);

  function makeValidDelegation(overrides: Record<string, unknown> = {}): PortableDelegation {
    return {
      delegateDID: AGENT_DID,
      expiry: FUTURE,
      spaceId: `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:default`,
      path: DB_HANDLE,
      actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
      cid: "bafytest",
      ownerAddress: OWNER_ADDRESS,
      chainId: 1,
      resources: [
        {
          service: "sql",
          space: `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:default`,
          path: DB_HANDLE,
          actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
        },
      ],
      ...overrides,
    } as unknown as PortableDelegation;
  }

  test("returns 'none' when no delegation is provided", () => {
    expect(evaluateDelegationStatus({ policy, agentDID: AGENT_DID })).toBe("none");
  });

  test("returns 'none' when delegation is undefined", () => {
    expect(evaluateDelegationStatus({ delegation: undefined, policy, agentDID: AGENT_DID })).toBe("none");
  });

  test("returns 'active' for a valid current grant with no storedHash", () => {
    const status = evaluateDelegationStatus({ delegation: makeValidDelegation(), policy, agentDID: AGENT_DID });
    expect(status).toBe("active");
  });

  test("returns 'active' for a valid current grant when storedHash matches", () => {
    const delegation = makeValidDelegation();
    const storedHash = computePolicyHash(policy, AGENT_DID);
    const status = evaluateDelegationStatus({ delegation, policy, agentDID: AGENT_DID, storedHash });
    expect(status).toBe("active");
  });

  test("returns 'expired' for a past-expiry delegation", () => {
    const pastExpiry = new Date(2020, 0, 1);
    const nowAfter = new Date(2026, 0, 1);
    const delegation = makeValidDelegation({ expiry: pastExpiry });
    const status = evaluateDelegationStatus({ delegation, policy, agentDID: AGENT_DID, now: nowAfter });
    expect(status).toBe("expired");
  });

  test("returns 'stale' when storedHash differs from freshly computed hash", () => {
    const delegation = makeValidDelegation();
    const status = evaluateDelegationStatus({
      delegation,
      policy,
      agentDID: AGENT_DID,
      storedHash: "0000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(status).toBe("stale");
  });

  test("'stale' check occurs after delegation validation passes (not 'expired')", () => {
    // A valid delegation with a mismatched storedHash should be stale, not active
    const delegation = makeValidDelegation();
    const wrongHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const status = evaluateDelegationStatus({ delegation, policy, agentDID: AGENT_DID, storedHash: wrongHash });
    expect(status).toBe("stale");
  });

  test("rethrows non-EXPIRED DelegationPolicyError (WRONG_DELEGATEE)", () => {
    const delegation = makeValidDelegation({ delegateDID: "did:pkh:eip155:1:0xWrong" });
    expect(() => evaluateDelegationStatus({ delegation, policy, agentDID: AGENT_DID })).toThrow(DelegationPolicyError);
    try {
      evaluateDelegationStatus({ delegation, policy, agentDID: AGENT_DID });
    } catch (e) {
      expect((e as DelegationPolicyError).reason).toBe("WRONG_DELEGATEE");
    }
  });

  test("is pure — calling it multiple times with the same args returns the same result", () => {
    const delegation = makeValidDelegation();
    const args = { delegation, policy, agentDID: AGENT_DID };
    const r1 = evaluateDelegationStatus(args);
    const r2 = evaluateDelegationStatus(args);
    expect(r1).toBe(r2);
    expect(r1).toBe("active");
  });
});
