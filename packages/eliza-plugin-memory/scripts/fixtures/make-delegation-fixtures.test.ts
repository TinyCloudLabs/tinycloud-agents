// TDD tests for the Phase 7 delegation baseline + fixture mutator helper.
//
// Runs in the default `bun test` gate (added to the package test script).
// NO network, NO TINYCLOUD_LIVE, NO useDelegation call.
//
// Asserts:
//  - baseline() deserializes via SDK deserializeDelegation without throwing
//  - each mutation (wrongDelegatee / expired / insufficientPolicy) changes
//    EXACTLY the intended field while leaving all others intact
//  - committed sample JSON contains NO real Authorization token

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { deserializeDelegation } from "@tinycloud/agent-client";
import {
  baseline,
  withExpired,
  withInsufficientPolicy,
  withWrongDelegatee,
} from "./make-delegation-fixtures.ts";

const SAMPLE_PATH = join(import.meta.dir, "delegation.sample.json");
// Hardhat test account #1 — deterministic, never a real production key
const OTHER_DID = "did:pkh:eip155:1:0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const PAST_DATE = new Date("2020-01-01T00:00:00.000Z");

/** Remove one field from an object for field-by-field comparison. */
function withoutField(obj: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...obj };
  delete copy[field];
  return copy;
}

// ---------------------------------------------------------------------------
// baseline — round-trips through SDK codec
// ---------------------------------------------------------------------------

test("baseline() deserializes via deserializeDelegation without throwing", () => {
  expect(() => deserializeDelegation(baseline())).not.toThrow();
});

test("baseline() produces a PortableDelegation with expected required fields", () => {
  const d = deserializeDelegation(baseline());
  expect(typeof d.ownerAddress).toBe("string");
  expect(d.ownerAddress.length).toBeGreaterThan(0);
  expect(typeof d.delegateDID).toBe("string");
  expect(d.delegateDID.length).toBeGreaterThan(0);
  expect(d.expiry).toBeInstanceOf(Date);
  expect(d.delegationHeader?.Authorization).toBeTruthy();
  expect(Array.isArray(d.actions)).toBe(true);
});

test("baseline() expiry is in the far future (year 2099)", () => {
  const d = deserializeDelegation(baseline());
  expect(d.expiry.getFullYear()).toBe(2099);
  expect(d.expiry.getTime()).toBeGreaterThan(Date.now());
});

test("baseline() actions include all three SQL capabilities", () => {
  const d = deserializeDelegation(baseline());
  expect(d.actions).toContain("tinycloud.sql/read");
  expect(d.actions).toContain("tinycloud.sql/write");
  expect(d.actions).toContain("tinycloud.sql/admin");
});

// ---------------------------------------------------------------------------
// withWrongDelegatee — changes ONLY delegateDID
// ---------------------------------------------------------------------------

test("withWrongDelegatee changes delegateDID to the supplied DID", () => {
  const d = deserializeDelegation(withWrongDelegatee(OTHER_DID));
  expect(d.delegateDID).toBe(OTHER_DID);
});

test("withWrongDelegatee delegateDID differs from baseline", () => {
  const base = deserializeDelegation(baseline());
  const mutated = deserializeDelegation(withWrongDelegatee(OTHER_DID));
  expect(mutated.delegateDID).not.toBe(base.delegateDID);
});

test("withWrongDelegatee changes ONLY delegateDID — all other fields identical", () => {
  const base = deserializeDelegation(baseline()) as Record<string, unknown>;
  const mutated = deserializeDelegation(withWrongDelegatee(OTHER_DID)) as Record<string, unknown>;
  expect(JSON.stringify(withoutField(mutated, "delegateDID"))).toBe(
    JSON.stringify(withoutField(base, "delegateDID")),
  );
});

// ---------------------------------------------------------------------------
// withExpired — changes ONLY expiry
// ---------------------------------------------------------------------------

test("withExpired produces a past expiry matching the supplied date", () => {
  const d = deserializeDelegation(withExpired(PAST_DATE));
  expect(d.expiry.toISOString()).toBe(PAST_DATE.toISOString());
});

test("withExpired expiry is in the past", () => {
  const d = deserializeDelegation(withExpired(PAST_DATE));
  expect(d.expiry.getTime()).toBeLessThan(Date.now());
});

test("withExpired changes ONLY expiry — all other fields identical", () => {
  const base = deserializeDelegation(baseline()) as Record<string, unknown>;
  const mutated = deserializeDelegation(withExpired(PAST_DATE)) as Record<string, unknown>;
  expect(JSON.stringify(withoutField(mutated, "expiry"))).toBe(
    JSON.stringify(withoutField(base, "expiry")),
  );
});

// ---------------------------------------------------------------------------
// withInsufficientPolicy — changes ONLY actions
// ---------------------------------------------------------------------------

test("withInsufficientPolicy removes write and admin actions", () => {
  const d = deserializeDelegation(withInsufficientPolicy());
  expect(d.actions.some((a) => a.endsWith("/write"))).toBe(false);
  expect(d.actions.some((a) => a.endsWith("/admin"))).toBe(false);
});

test("withInsufficientPolicy retains read action", () => {
  const d = deserializeDelegation(withInsufficientPolicy());
  expect(d.actions).toContain("tinycloud.sql/read");
});

test("withInsufficientPolicy changes ONLY actions — all other fields identical", () => {
  const base = deserializeDelegation(baseline()) as Record<string, unknown>;
  const mutated = deserializeDelegation(withInsufficientPolicy()) as Record<string, unknown>;
  expect(JSON.stringify(withoutField(mutated, "actions"))).toBe(
    JSON.stringify(withoutField(base, "actions")),
  );
});

// ---------------------------------------------------------------------------
// Committed sample JSON — no real secrets
// ---------------------------------------------------------------------------

test("committed sample JSON has a placeholder Authorization header, not a real token", () => {
  const raw = readFileSync(SAMPLE_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  expect(parsed.delegationHeader.Authorization).toBe("Bearer SCRUBBED_AUTH_TOKEN_PLACEHOLDER");
});

test("committed sample JSON contains no real JWT in Authorization header", () => {
  const raw = readFileSync(SAMPLE_PATH, "utf-8");
  // Real JWTs start with eyJ (base64url-encoded JSON object header)
  expect(raw).not.toMatch(/Bearer eyJ/);
});

test("committed sample JSON contains no real hex private key in Authorization header", () => {
  const raw = readFileSync(SAMPLE_PATH, "utf-8");
  // Reject hex keys of 20+ characters that would follow "Bearer 0x"
  expect(raw).not.toMatch(/Bearer 0x[0-9a-fA-F]{20,}/);
});

test("baseline() Authorization header is the placeholder, never a real token", () => {
  const d = deserializeDelegation(baseline());
  expect(d.delegationHeader.Authorization).toBe("Bearer SCRUBBED_AUTH_TOKEN_PLACEHOLDER");
  expect(d.delegationHeader.Authorization).not.toMatch(/eyJ/);
});
