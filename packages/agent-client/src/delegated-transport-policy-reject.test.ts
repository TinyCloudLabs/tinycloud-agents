// LIVE-transport negative-path tests (handoff GAP 3 / F4).
//
// Unlike live-delegated-negative.test.ts (which calls validateDelegationPolicy
// DIRECTLY, unit-level), these drive the REAL DelegatedTransport.signIn() path
// with the REAL deserializeAndNormalize chokepoint wired in. They prove every
// bad delegation is REJECTED BEFORE a single activate()/useDelegation call.
//
// The headline case is `forged-unsigned-actions`: a delegation whose top-level
// `actions` claims tinycloud.sql/* but whose SIGNED att grants none. It MUST be
// rejected — proving the transport gates on the signed side, not the forgeable
// summary (F1 Consequence B).
//
// NO network: activate is injected as a spy that records calls and returns a
// fake handle. A reject must throw with activateCalls === 0.

import { expect, test } from "bun:test";
import type { DelegatedSqlAccess } from "./delegated-transport";
import { DelegatedTransport } from "./delegated-transport";
import { resolveDelegationConfig } from "./config";
import type { AgentIdentity } from "./agent-identity";
import { DelegationPolicyError } from "./errors";
import { AGENT_DID, AGENT_KEY, DB_HANDLE, makeAtt, makeJwt, OTHER_DID, OWNER, SPACE } from "./delegation-fixtures.test";

/**
 * Serialize a delegation with INDEPENDENTLY controllable signed `att` and
 * top-level `actions` summary — so we can craft a forgery (signed ≠ summary).
 * Built as raw JSON (not serializeDelegation) precisely so the summary is not
 * re-derived; deserializeDelegation parses it like the committed sample does.
 */
function buildSerialized(opts: {
  att: Record<string, unknown>;
  topActions: string[];
  delegateDID?: string;
  expiry?: Date;
}): string {
  const { att, topActions, delegateDID = AGENT_DID, expiry = new Date("2099-01-01T00:00:00.000Z") } = opts;
  return JSON.stringify({
    cid: "bafytest",
    delegateDID,
    spaceId: SPACE,
    path: DB_HANDLE,
    actions: topActions,
    expiry: expiry.toISOString(),
    delegationHeader: { Authorization: makeJwt(att) },
    ownerAddress: OWNER,
    chainId: 1,
    host: "https://node.tinycloud.xyz",
  });
}

const fakeIdentity: AgentIdentity = { did: AGENT_DID, normalizedKey: AGENT_KEY };

function fakeAccess(): DelegatedSqlAccess {
  return { spaceId: SPACE, sql: { db: () => ({} as never) } };
}

/** Build a transport with the REAL deserializeAndNormalize (NOT injected) + an activate spy. */
function makeTransport(serialized: string) {
  let activateCalls = 0;
  const transport = new DelegatedTransport(
    resolveDelegationConfig({ mode: "delegation", serializedDelegation: serialized, agentKey: AGENT_KEY, dbHandle: DB_HANDLE }),
    {
      // deserialize NOT injected → real signed-att normalization runs.
      activate: async () => {
        activateCalls++;
        return fakeAccess();
      },
      agentIdentity: async () => fakeIdentity,
    },
  );
  return { transport, activated: () => activateCalls };
}

async function expectRejectBeforeActivate(serialized: string) {
  const { transport, activated } = makeTransport(serialized);
  let threw = false;
  try {
    await transport.signIn();
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  // The critical invariant: NO activation/useDelegation happened.
  expect(activated()).toBe(0);
}

// ---------------------------------------------------------------------------
// Control: a fully valid signed delegation activates (proves negatives reject
// for the RIGHT reason, not some unrelated setup failure).
// ---------------------------------------------------------------------------

test("control: valid signed delegation passes both validators and activates once", async () => {
  const serialized = buildSerialized({
    att: makeAtt({ sqlActions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"] }),
    // Lossy summary (web-sdk 2.3.0 reality) — normalization corrects it from the att.
    topActions: ["tinycloud.capabilities/read"],
  });
  const { transport, activated } = makeTransport(serialized);
  const result = await transport.signIn();
  expect(result.did).toBe(AGENT_DID);
  expect(activated()).toBe(1);
});

// ---------------------------------------------------------------------------
// Negative paths — each rejects BEFORE activate.
// ---------------------------------------------------------------------------

test("wrong-delegatee: rejects before activate", async () => {
  await expectRejectBeforeActivate(
    buildSerialized({
      att: makeAtt({ sqlActions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"] }),
      topActions: ["tinycloud.sql/read"],
      delegateDID: OTHER_DID, // not our agent
    }),
  );
});

test("wrong-db-handle: signed att grants SQL on a different path → rejects before activate", async () => {
  await expectRejectBeforeActivate(
    buildSerialized({
      att: makeAtt({
        sqlActions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
        sqlPath: "xyz.tinycloud.other/db", // ≠ DB_HANDLE
      }),
      topActions: ["tinycloud.sql/read"],
    }),
  );
});

test("insufficient-actions: signed att lacks admin → rejects before activate", async () => {
  await expectRejectBeforeActivate(
    buildSerialized({
      att: makeAtt({ sqlActions: ["tinycloud.sql/read", "tinycloud.sql/write"] }), // no admin
      topActions: ["tinycloud.sql/read"],
    }),
  );
});

test("expired: rejects before activate", async () => {
  await expectRejectBeforeActivate(
    buildSerialized({
      att: makeAtt({ sqlActions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"] }),
      topActions: ["tinycloud.sql/read"],
      expiry: new Date("2020-01-01T00:00:00.000Z"),
    }),
  );
});

// ---------------------------------------------------------------------------
// THE forgery test: top-level actions claim sql/admin, signed att grants NONE.
// Normalization strips the forged summary → reject. Proves we gate on the
// signed side (F1 Consequence B).
// ---------------------------------------------------------------------------

test("forged-unsigned-actions: top-level claims sql/admin but signed att grants none → rejects before activate", async () => {
  const forged = buildSerialized({
    att: makeAtt({ caps: true }), // capabilities/read ONLY — NO sql grant in the signed att
    topActions: ["tinycloud.sql/admin", "tinycloud.sql/read", "tinycloud.sql/write"], // FORGED summary
  });
  await expectRejectBeforeActivate(forged);
});

// ---------------------------------------------------------------------------
// Non-JWT Authorization: a delegation with no signed capability JWT (a bare
// `Bearer <cid>`) is hard-rejected — the strict contract (no signed att ⇒ no
// trust). The reject is actionable and never reaches activate (review #1).
// ---------------------------------------------------------------------------

test("non-JWT Authorization (Bearer <cid>, no signed att) rejects before activate with an actionable cause (review #1)", async () => {
  // Raw JSON so the non-JWT Authorization survives (serializeDelegation would not
  // re-derive it). This is exactly the committed sample / harness-fallback shape.
  const serialized = JSON.stringify({
    cid: "bafytestcid",
    delegateDID: AGENT_DID,
    spaceId: SPACE,
    path: DB_HANDLE,
    actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
    expiry: new Date("2099-01-01T00:00:00.000Z").toISOString(),
    delegationHeader: { Authorization: "Bearer bafytestcid" }, // not a JWT (no dots)
    ownerAddress: OWNER,
    chainId: 1,
    host: "https://node.tinycloud.xyz",
  });
  const { transport, activated } = makeTransport(serialized);
  let caught: unknown = null;
  try {
    await transport.signIn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(DelegationPolicyError);
  expect((caught as DelegationPolicyError).reason).toBe("MALFORMED");
  // Names the missing-signed-capability cause (actionable), without leaking the header.
  expect((caught as Error).message).toMatch(/signed capability/i);
  expect((caught as Error).message).not.toContain("bafytestcid");
  // The critical invariant: NO activation/useDelegation happened.
  expect(activated()).toBe(0);
});

test("forged delegation rejection error does not leak the signed JWT", async () => {
  const forged = buildSerialized({
    att: makeAtt({ caps: true }),
    topActions: ["tinycloud.sql/admin"],
  });
  const { transport } = makeTransport(forged);
  try {
    await transport.signIn();
    throw new Error("expected rejection");
  } catch (e) {
    const blob = `${(e as Error).message}|${JSON.stringify((e as { context?: unknown }).context ?? {})}`;
    expect(blob).not.toContain("eyJ"); // no base64url JWT segment
    expect(blob).not.toContain("Bearer");
  }
});
