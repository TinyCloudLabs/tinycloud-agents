// Unit tests for the signed-att normalization chokepoint (handoff GAP 1 / F1).
//
// These prove the normalizer derives grants from the SIGNED `att` and discards
// the forgeable top-level summary — the security property the whole prod-readiness
// effort hinges on.

import { describe, expect, test } from "bun:test";
import type { PortableDelegation } from "@tinycloud/node-sdk";
import { serializeDelegation } from "@tinycloud/node-sdk";
import { DelegationPolicyError } from "./errors";
import { deserializeAndNormalize, normalizeDelegationGrants } from "./delegation-normalize";

const OWNER = "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2";
const AGENT_DID = "did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c";
const DB_HANDLE = "xyz.tinycloud.eliza/memory";
const SPACE = `tinycloud:pkh:eip155:1:${OWNER}:default`;
const SQL_URI = `${SPACE}/sql/${DB_HANDLE}`;
const CAP_URI = `${SPACE}/capabilities/${DB_HANDLE}`;

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Build an (unsigned, for-test) UCAN-shaped JWT carrying the given `att`. */
function makeJwt(att: Record<string, unknown>): string {
  const header = b64url({ alg: "EdDSA", typ: "JWT" });
  const payload = b64url({ att, aud: AGENT_DID, exp: 9999999999 });
  return `${header}.${payload}.sig`; // signature is never verified by the normalizer
}

/** A PortableDelegation with a controllable Authorization header + top-level summary. */
function makeDelegation(
  authHeader: string,
  topLevel: { actions?: string[]; resources?: unknown } = {},
): PortableDelegation {
  return {
    cid: "bafytest",
    delegateDID: AGENT_DID,
    delegatorDID: `did:pkh:eip155:1:${OWNER}`,
    spaceId: SPACE,
    path: DB_HANDLE,
    actions: topLevel.actions ?? ["tinycloud.capabilities/read"],
    expiry: new Date("2099-01-01T00:00:00.000Z"),
    isRevoked: false,
    allowSubDelegation: false,
    createdAt: new Date("2026-06-13T00:00:00.000Z"),
    authHeader,
    delegationHeader: { Authorization: authHeader },
    ownerAddress: OWNER,
    chainId: 1,
    host: "https://node.tinycloud.xyz",
    ...(topLevel.resources !== undefined ? { resources: topLevel.resources } : {}),
  } as unknown as PortableDelegation;
}

const FULL_GRANT_ATT = {
  [CAP_URI]: { "tinycloud.capabilities/read": [{}] },
  [SQL_URI]: {
    "tinycloud.sql/admin": [{}],
    "tinycloud.sql/read": [{}],
    "tinycloud.sql/write": [{}],
  },
};

describe("normalizeDelegationGrants — signed-att derivation", () => {
  test("derives resources[] from the signed att (service/space/path/actions)", () => {
    const d = makeDelegation(makeJwt(FULL_GRANT_ATT));
    const out = normalizeDelegationGrants(d);

    const sql = out.resources?.find((r) => r.service === "sql");
    expect(sql).toBeDefined();
    expect(sql!.space).toBe(SPACE);
    expect(sql!.path).toBe(DB_HANDLE);
    expect([...sql!.actions].sort()).toEqual([
      "tinycloud.sql/admin",
      "tinycloud.sql/read",
      "tinycloud.sql/write",
    ]);

    const cap = out.resources?.find((r) => r.service === "capabilities");
    expect(cap).toBeDefined();
    expect(cap!.path).toBe(DB_HANDLE);
    expect(cap!.actions).toEqual(["tinycloud.capabilities/read"]);
  });

  test("corrects the lossy top-level `actions` summary to the full signed set", () => {
    // Input claims ONLY capabilities/read (the web-sdk 2.3.0 lossy case).
    const d = makeDelegation(makeJwt(FULL_GRANT_ATT), {
      actions: ["tinycloud.capabilities/read"],
    });
    const out = normalizeDelegationGrants(d);
    expect([...out.actions].sort()).toEqual([
      "tinycloud.capabilities/read",
      "tinycloud.sql/admin",
      "tinycloud.sql/read",
      "tinycloud.sql/write",
    ]);
  });

  test("SECURITY: discards forged top-level actions/resources not backed by the signed att", () => {
    // Forgery: top-level claims sql/admin + a fake resources[] entry, but the
    // signed att grants ONLY capabilities/read.
    const d = makeDelegation(makeJwt({ [CAP_URI]: { "tinycloud.capabilities/read": [{}] } }), {
      actions: ["tinycloud.sql/admin", "tinycloud.sql/read", "tinycloud.sql/write"],
      resources: [{ service: "sql", space: SPACE, path: DB_HANDLE, actions: ["tinycloud.sql/admin"] }],
    });
    const out = normalizeDelegationGrants(d);

    // The forged SQL grant is gone — only the signed capabilities resource remains.
    expect(out.resources?.some((r) => r.service === "sql")).toBe(false);
    expect(out.actions).toEqual(["tinycloud.capabilities/read"]);
  });

  test("does not mutate the input delegation", () => {
    const d = makeDelegation(makeJwt(FULL_GRANT_ATT), { actions: ["tinycloud.capabilities/read"] });
    const before = d.actions;
    normalizeDelegationGrants(d);
    expect(d.actions).toBe(before); // same reference, untouched
    expect(d.resources).toBeUndefined();
  });
});

describe("normalizeDelegationGrants — MALFORMED rejects (no unsigned fallback)", () => {
  test("missing Authorization header", () => {
    const d = makeDelegation("");
    expect(() => normalizeDelegationGrants(d)).toThrow(DelegationPolicyError);
  });

  test("non-JWT Authorization (Bearer <cid> fallback) is rejected", () => {
    const d = makeDelegation("Bearer bafytest");
    try {
      normalizeDelegationGrants(d);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("MALFORMED");
    }
  });

  test("att claim absent", () => {
    const jwt = `${b64url({ alg: "EdDSA" })}.${b64url({ aud: AGENT_DID })}.sig`;
    expect(() => normalizeDelegationGrants(makeDelegation(jwt))).toThrow(DelegationPolicyError);
  });

  test("empty att grants no resources", () => {
    expect(() => normalizeDelegationGrants(makeDelegation(makeJwt({})))).toThrow(
      DelegationPolicyError,
    );
  });

  test("SECURITY: no MALFORMED error message leaks the Authorization header", () => {
    const secret = makeJwt(FULL_GRANT_ATT).replace(".sig", ".SUPERSECRETSIG");
    const d = makeDelegation(secret);
    // Force a downstream failure: strip att so it throws AFTER decoding.
    const broken = makeDelegation(`${b64url({ alg: "x" })}.${b64url({ foo: 1 })}.${secret}`);
    try {
      normalizeDelegationGrants(broken);
    } catch (e) {
      expect((e as Error).message).not.toContain("SUPERSECRETSIG");
      expect(JSON.stringify((e as DelegationPolicyError).context ?? {})).not.toContain("SUPERSECRETSIG");
    }
  });
});

describe("deserializeAndNormalize — full round-trip through the SDK deserializer", () => {
  test("deserializes a serialized blob then normalizes from the signed att", () => {
    const d = makeDelegation(makeJwt(FULL_GRANT_ATT));
    const serialized = serializeDelegation(d);
    const out = deserializeAndNormalize(serialized);
    expect(out.resources?.some((r) => r.service === "sql")).toBe(true);
    expect(out.actions).toContain("tinycloud.sql/write");
  });

  test("undeserializable input throws MALFORMED", () => {
    expect(() => deserializeAndNormalize("{not valid")).toThrow(DelegationPolicyError);
  });
});
