// Regression: a SECOND signIn() on the same node-sdk authorization must succeed.
//
// node-sdk <=2.6.x renamed the hard-coded "default" session key on signIn() and
// never recreated it, so any second signIn() on the same TinyCloudNode threw
// "Key default does not exist." (took down tinychat's backend). NodeSdkTransport
// re-signs-in on the SAME node for every proactive/lazy refresh, so this matters
// here. >=2.7.0 renames the ACTIVE key instead. This drives the real WASM session
// manager + SIWE preparation offline: only fetch (node /info and /delegate) is
// stubbed, so no network I/O happens.
//
// It also pins that AGENT_SESSION_EXPIRATION_MS (30 days) reaches the signed SIWE.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  MemorySessionStorage,
  NodeUserAuthorization,
  NodeWasmBindings,
  PrivateKeySigner,
} from "@tinycloud/node-sdk";
import { AGENT_SESSION_EXPIRATION_MS } from "./config.ts";

const HOST = "https://node.tinycloud.xyz";
const DAY_MS = 24 * 60 * 60 * 1000;

let realFetch: typeof globalThis.fetch;
const requests: string[] = [];

beforeEach(() => {
  realFetch = globalThis.fetch;
  requests.length = 0;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubNode(protocol: number): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (url === `${HOST}/info`) return Response.json({ protocol, features: [] });
    if (url === `${HOST}/delegate`) return Response.json({ activated: [], skipped: [] });
    return new Response("unexpected request in offline test", { status: 599 });
  }) as typeof globalThis.fetch;
}

function expirationOf(siwe: string): number {
  const match = /Expiration Time: (\S+)/.exec(siwe);
  expect(match).not.toBeNull();
  return Date.parse(match![1]);
}

test("node-sdk: a second signIn() on the same authorization succeeds (no 'Key default does not exist')", async () => {
  const wasm = new NodeWasmBindings();
  await wasm.ensureInitialized?.();
  stubNode(wasm.protocolVersion());

  // Throwaway key: never a real identity.
  const signer = new PrivateKeySigner(`0x${randomBytes(32).toString("hex")}`);
  const auth = new NodeUserAuthorization({
    signer,
    signStrategy: { type: "auto-sign" },
    sessionStorage: new MemorySessionStorage(),
    domain: "eliza-service.test",
    wasmBindings: wasm,
    tinycloudHosts: [HOST],
    autoDiscoverLocalNode: false,
    sessionExpirationMs: AGENT_SESSION_EXPIRATION_MS,
  });

  const first = await auth.signIn();
  // session-${Date.now()} key ids: make sure the second sign-in gets a new one.
  await new Promise((r) => setTimeout(r, 5));
  const second = await auth.signIn();
  await new Promise((r) => setTimeout(r, 5));
  const third = await auth.signIn();

  expect(second.sessionKey).not.toBe(first.sessionKey);
  expect(third.sessionKey).not.toBe(second.sessionKey);
  expect(auth.tinyCloudSession?.sessionKey).toBe(third.sessionKey);
  expect(requests.filter((u) => u.endsWith("/delegate"))).toHaveLength(3);

  // 30-day session lifetime reaches the signed SIWE message.
  const lifetime = expirationOf(third.siwe) - Date.now();
  expect(lifetime).toBeGreaterThan(29 * DAY_MS);
  expect(lifetime).toBeLessThanOrEqual(30 * DAY_MS);
});
