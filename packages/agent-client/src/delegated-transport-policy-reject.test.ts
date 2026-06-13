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

const OWNER = "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2";
const AGENT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const AGENT_DID = "did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c";
const OTHER_DID = "did:pkh:eip155:1:0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const DB_HANDLE = "xyz.tinycloud.eliza/memory";
const SPACE = `tinycloud:pkh:eip155:1:${OWNER}:default`;

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** A UCAN-shaped JWT carrying `att` (signature is never verified by the client). */
function makeJwt(att: Record<string, unknown>): string {
  return `${b64url({ alg: "EdDSA", typ: "JWT" })}.${b64url({ att, aud: AGENT_DID })}.sig`;
}

/** Build a UCAN `att` granting the given SQL actions (at sqlPath) + optional capabilities. */
function makeAtt(opts: { sqlActions?: string[]; sqlPath?: string; caps?: boolean }): Record<string, unknown> {
  const { sqlActions, sqlPath = DB_HANDLE, caps = true } = opts;
  const att: Record<string, unknown> = {};
  if (caps) att[`${SPACE}/capabilities/${DB_HANDLE}`] = { "tinycloud.capabilities/read": [{}] };
  if (sqlActions && sqlActions.length) {
    const inner: Record<string, unknown> = {};
    for (const a of sqlActions) inner[a] = [{}];
    att[`${SPACE}/sql/${sqlPath}`] = inner;
  }
  return att;
}

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
