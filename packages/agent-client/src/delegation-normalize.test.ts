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
import {
  AGENT_DID,
  b64url,
  CAP_URI,
  DB_HANDLE,
  FULL_GRANT_ATT,
  makeJwt,
  OWNER,
  SPACE,
  SQL_URI,
} from "./delegation-fixtures.test";

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

  test("att resource URI in the tinycloud:// authority form rejects LOUDLY (never silently drops the SQL grant) (review #4)", () => {
    // The `tinycloud://my-space/sql/...` authority form yields an empty service segment
    // under a positional split — the old code silently dropped the grant, later
    // surfacing as a confusing MISSING_SQL_RESOURCE. It must now reject as MALFORMED.
    const att = {
      "tinycloud://my-space/sql/xyz.tinycloud.eliza/memory": {
        "tinycloud.sql/admin": [{}],
        "tinycloud.sql/read": [{}],
        "tinycloud.sql/write": [{}],
      },
    };
    try {
      normalizeDelegationGrants(makeDelegation(makeJwt(att)));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("MALFORMED");
    }
  });

  test("att value that is an ARRAY → MALFORMED, not a junk resource (review #7)", () => {
    // An array att value would pass a bare typeof-object check and yield bogus ["0"]
    // actions; it must be a clean MALFORMED reject instead.
    const att = { [SQL_URI]: ["tinycloud.sql/admin"] };
    try {
      normalizeDelegationGrants(makeDelegation(makeJwt(att)));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DelegationPolicyError);
      expect((e as DelegationPolicyError).reason).toBe("MALFORMED");
    }
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
