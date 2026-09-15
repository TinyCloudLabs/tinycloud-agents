import { expect, test } from "bun:test";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { disableLocalAccountWrites } from "./local-validation-node.js";

test("disables only pinned SDK automatic account writers and retains activation", async () => {
  let writes = 0;
  const write = () => { writes++; throw new Error("Production account write"); };
  const signIn = async () => "signed";
  const useDelegation = async () => "activated";
  const node = { bootstrapAccountIfNeeded: write, ensureRequestedEncryptionNetworks: write, ensureOwnedSpaceHostedById: write, scheduleAccountRegistrySync: write, signIn, useDelegation };
  disableLocalAccountWrites(node);
  expect(await node.bootstrapAccountIfNeeded()).toBe(false);
  await node.ensureRequestedEncryptionNetworks();
  await node.ensureOwnedSpaceHostedById();
  node.scheduleAccountRegistrySync();
  expect(writes).toBe(0);
  expect(node.signIn).toBe(signIn);
  expect(node.useDelegation).toBe(useDelegation);
});

test("refuses an unsupported SDK before login and accepts the pinned real client", () => {
  expect(() => disableLocalAccountWrites({})).toThrow();
  const node = new TinyCloudNode({ privateKey: `0x${"04".repeat(32)}`, host: "https://node.example", autoCreateSpace: false });
  expect(() => disableLocalAccountWrites(node)).not.toThrow();
});
