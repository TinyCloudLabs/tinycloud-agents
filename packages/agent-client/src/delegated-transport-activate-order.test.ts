// Regression test for defaultActivate signIn()→useDelegation() ordering.
//
// Locks down a real bug: node-sdk 2.3.0's wallet-mode useDelegation REQUIRES an
// established SIWE session (auth.tinyCloudSession). Calling useDelegation()
// without a prior signIn() throws "Not signed in. Call signIn() first."
// defaultActivate must therefore call node.signIn() BEFORE node.useDelegation().
//
// This file intercepts the real @tinycloud/node-sdk TinyCloudNode via
// mock.module so no node is constructed and no network call happens. The mock
// is scoped to this file and restored in afterAll to avoid leaking into the
// rest of the suite.

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { PortableDelegation } from "@tinycloud/node-sdk";
import * as realNodeSdk from "@tinycloud/node-sdk";
import { resolveDelegationConfig } from "./config.ts";

// Records the order of SDK method calls across an activation.
let calls: string[] = [];
// Sentinel access object returned by the mocked useDelegation.
const SENTINEL_ACCESS = {
  spaceId: "tinycloud:pkh:eip155:1:0xowner:default",
  sql: { db: () => ({}) },
};

// Replace the real TinyCloudNode with a fake whose signIn/useDelegation push to
// `calls` so we can assert ordering. Only the symbols defaultActivate imports
// from the module need to be preserved (TinyCloudNode is the only one it uses
// at runtime; deserializeDelegation is referenced but not exercised here).
class FakeTinyCloudNode {
  signIn = mock(async () => {
    calls.push("signIn");
    return { session: "fake-siwe-session" };
  });
  useDelegation = mock(async (_delegation: PortableDelegation) => {
    calls.push("useDelegation");
    return SENTINEL_ACCESS;
  });
}

// Spread the real module so every other export (pkhDid, PrivateKeySigner,
// deserializeDelegation, …) keeps working for sibling modules like
// agent-identity.ts; only TinyCloudNode is swapped for the recording fake.
mock.module("@tinycloud/node-sdk", () => ({
  ...realNodeSdk,
  TinyCloudNode: FakeTinyCloudNode,
}));

afterAll(() => {
  // Undo the module mock so it cannot leak into other test files.
  mock.restore();
});

beforeEach(() => {
  calls = [];
});

const AGENT_KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function fakeDelegation(): PortableDelegation {
  return {
    ownerAddress: "0xowner1234567890abcdef1234567890abcdef12",
    delegateDID: "did:pkh:eip155:1:0xfakeagent",
    spaceId: "tinycloud:pkh:eip155:1:0xowner:default",
    path: "xyz.tinycloud.eliza/memory",
    actions: ["tinycloud.sql/read", "tinycloud.sql/write"],
    expiry: new Date(Date.now() + 60 * 60 * 1000),
    cid: "fake-cid",
    delegationHeader: { Authorization: "Bearer SECRET-NEVER-LOGGED" },
    chainId: 1,
  } as unknown as PortableDelegation;
}

test("defaultActivate calls signIn() BEFORE useDelegation() (node-sdk 2.3.0 wallet-mode requires a session)", async () => {
  // Dynamic import AFTER mock.module so defaultActivate binds to the fake SDK.
  const { defaultActivate } = await import("./delegated-transport.ts");

  const config = resolveDelegationConfig({
    mode: "delegation",
    serializedDelegation: "fake-serialized-delegation",
    agentKey: AGENT_KEY, // inline key → no readFileSync, no file access
  });

  const access = await defaultActivate(config, fakeDelegation());

  // Ordering: signIn must precede useDelegation, each called exactly once.
  expect(calls).toEqual(["signIn", "useDelegation"]);
  expect(calls.indexOf("signIn")).toBeLessThan(calls.indexOf("useDelegation"));

  // Returned access is the sentinel produced by useDelegation.
  expect(access).toBe(SENTINEL_ACCESS as never);
});
