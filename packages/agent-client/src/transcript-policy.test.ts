// Exact-attenuation policy tests for the TinyChat transcript grant.
//
// Every case builds a SIGNED `att` claim and runs it through the normalizer, so
// a forged top-level `resources`/`actions` summary can never influence a verdict.

import { describe, expect, test } from "bun:test";
import { serializeDelegation } from "@tinycloud/node-sdk";
import type { PortableDelegation } from "@tinycloud/node-sdk";
import { AGENT_DID, OTHER_DID, OWNER, SPACE, makeJwt } from "./delegation-fixtures.test";
import { deserializeAndNormalize, signedOwnerAddress } from "./delegation-normalize";
import { defaultTinychatTranscriptPolicy, validateExactDelegationPolicy } from "./delegation-policy";
import { DelegationPolicyError } from "./errors";

const SQL_PATH = "xyz.tinycloud.tinychat/connectors";
const KV_PATH = `${SQL_PATH}/`;

function transcriptAtt(overrides: Record<string, string[]> = {}, opts: { space?: string } = {}): Record<string, unknown> {
  const space = opts.space ?? SPACE;
  const base: Record<string, string[]> = {
    [`${space}/sql/${SQL_PATH}`]: ["tinycloud.sql/read"],
    [`${space}/kv/${KV_PATH}`]: ["tinycloud.kv/get", "tinycloud.kv/list"],
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(base)
      .filter(([, actions]) => actions.length > 0)
      .map(([uri, actions]) => [uri, Object.fromEntries(actions.map((action) => [action, [{}]]))]),
  );
}

export function transcriptDelegation(
  att: Record<string, unknown>,
  opts: { delegateDID?: string; expiryMs?: number; forgedActions?: string[] } = {},
): string {
  const delegation = {
    delegateDID: opts.delegateDID ?? AGENT_DID,
    ownerAddress: OWNER,
    expiry: new Date(Date.now() + (opts.expiryMs ?? 60 * 60 * 1000)),
    path: SQL_PATH,
    // Deliberately WRONG and unsigned: the normalizer must overwrite it.
    actions: opts.forgedActions ?? ["tinycloud.sql/admin"],
    delegationHeader: { Authorization: `Bearer ${makeJwt(att)}` },
  } as unknown as PortableDelegation;
  return serializeDelegation(delegation);
}

function validate(serialized: string): void {
  validateExactDelegationPolicy(deserializeAndNormalize(serialized), {
    agentDID: AGENT_DID,
    policy: defaultTinychatTranscriptPolicy(),
  });
}

describe("transcript delegation policy", () => {
  test("accepts exactly SQL read plus KV get/list", () => {
    expect(() => validate(transcriptDelegation(transcriptAtt()))).not.toThrow();
  });

  test("accepts the SDK-emitted capabilities/read entry at whatever path it was minted at", () => {
    const att = transcriptAtt({ [`${SPACE}/capabilities/${SQL_PATH}`]: ["tinycloud.capabilities/read"] });
    expect(() => validate(transcriptDelegation(att))).not.toThrow();
  });

  test("rejects a capabilities entry that carries more than read", () => {
    const att = transcriptAtt({ [`${SPACE}/capabilities/${SQL_PATH}`]: ["tinycloud.capabilities/read", "tinycloud.capabilities/delegate"] });
    expect(() => validate(transcriptDelegation(att))).toThrow(DelegationPolicyError);
  });

  test("rejects an extra SQL action", () => {
    const att = transcriptAtt({ [`${SPACE}/sql/${SQL_PATH}`]: ["tinycloud.sql/read", "tinycloud.sql/write"] });
    expect(() => validate(transcriptDelegation(att))).toThrow(DelegationPolicyError);
  });

  test("rejects an extra KV action", () => {
    const att = transcriptAtt({ [`${SPACE}/kv/${KV_PATH}`]: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put"] });
    expect(() => validate(transcriptDelegation(att))).toThrow(DelegationPolicyError);
  });

  test("rejects a broader KV path", () => {
    const att = transcriptAtt({
      [`${SPACE}/kv/${KV_PATH}`]: [],
      [`${SPACE}/kv/`]: ["tinycloud.kv/get", "tinycloud.kv/list"],
    });
    expect(() => validate(transcriptDelegation(att))).toThrow(DelegationPolicyError);
  });

  test("rejects an extra resource outside the transcript ceiling", () => {
    const att = transcriptAtt({ [`${SPACE}/sql/xyz.tinycloud.eliza/memory`]: ["tinycloud.sql/read"] });
    expect(() => validate(transcriptDelegation(att))).toThrow(DelegationPolicyError);
  });

  test("rejects a missing required resource", () => {
    const att = transcriptAtt({ [`${SPACE}/kv/${KV_PATH}`]: [] });
    expect(() => validate(transcriptDelegation(att))).toThrow(DelegationPolicyError);
  });

  test("rejects the wrong delegatee", () => {
    expect(() => validate(transcriptDelegation(transcriptAtt(), { delegateDID: OTHER_DID }))).toThrow(DelegationPolicyError);
  });

  test("rejects an already-expired grant", () => {
    expect(() => validate(transcriptDelegation(transcriptAtt(), { expiryMs: -1_000 }))).toThrow(DelegationPolicyError);
  });

  test("ignores a forged top-level actions summary", () => {
    const att = transcriptAtt({ [`${SPACE}/sql/${SQL_PATH}`]: ["tinycloud.sql/read", "tinycloud.sql/admin"] });
    // Forged summary claims the narrow set; the SIGNED att is what must reject.
    expect(() => validate(transcriptDelegation(att, { forgedActions: ["tinycloud.sql/read"] }))).toThrow(DelegationPolicyError);
  });

  test("owner is read from the signed space, not the unsigned ownerAddress field", () => {
    const owner = signedOwnerAddress(deserializeAndNormalize(transcriptDelegation(transcriptAtt())));
    expect(owner?.toLowerCase()).toBe(OWNER.toLowerCase());
  });
});
