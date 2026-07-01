// /api/agents server integration tests (M2).
//
// Exercises the real createElizaServiceFetch dispatcher with a real UserAuth +
// AgentStore. SIWE messages are signed with a viem test account so the nonce ->
// verify -> bearer -> agents loop runs end to end without a live wallet.

import { describe, expect, it } from "bun:test";
import { SiweMessage } from "siwe";
import { privateKeyToAccount } from "viem/accounts";
import type { IAgentRuntime } from "@elizaos/core";
import { MEMORY_DB_HANDLE } from "@tinycloud/eliza-plugin-memory";
import { createElizaServiceFetch, type ElizaServiceHost } from "./server.js";
import { SessionStore } from "./session-store.js";
import { AgentStore } from "./agents/agent-store.js";
import { UserAuth } from "./auth/user-auth.js";
import { addressToEntityId } from "./entity-id.js";
import { createRateLimiter } from "./rate-limit.js";

const DOMAIN = "agents.test";
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(PK);
const AGENT_DID = "did:pkh:eip155:1:0x000000000000000000000000000000000000dEaD";

function makeHost(): ElizaServiceHost {
  return {
    agentDid: AGENT_DID,
    agentDidFor: async () => AGENT_DID,
    storageFor: async () => ({ async registerDelegation() {} }),
    runtimeFor: async () => ({}) as IAgentRuntime,
    preflight: async () => {},
  };
}

function makeFetch() {
  const auth = new UserAuth({ domain: DOMAIN });
  const agents = new AgentStore();
  const fetch = createElizaServiceFetch({
    host: makeHost(),
    sessions: new SessionStore(),
    api: { auth, agents },
  });
  return { fetch, auth, agents };
}

async function signIn(fetch: (r: Request) => Promise<Response>): Promise<string> {
  const nonceRes = await fetch(new Request("https://agents.test/api/auth/nonce"));
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const siwe = new SiweMessage({
    domain: DOMAIN,
    address: account.address,
    uri: `https://${DOMAIN}`,
    version: "1",
    chainId: 1,
    nonce,
  });
  const message = siwe.prepareMessage();
  const signature = await account.signMessage({ message });
  const verifyRes = await fetch(
    new Request("https://agents.test/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    }),
  );
  expect(verifyRes.status).toBe(200);
  return ((await verifyRes.json()) as { token: string }).token;
}

function authed(path: string, token: string, init: RequestInit = {}): Request {
  return new Request(`https://agents.test${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
}

describe("/api auth", () => {
  it("nonce -> verify issues a token", async () => {
    const { fetch } = makeFetch();
    const token = await signIn(fetch);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects agents calls without a token", async () => {
    const { fetch } = makeFetch();
    const res = await fetch(new Request("https://agents.test/api/agents"));
    expect(res.status).toBe(401);
  });

  it("rate-limits /api/auth/nonce per IP (429 after the limit)", async () => {
    // 2 requests/min per IP; the 3rd from the same IP is 429.
    const authLimiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const fetch = createElizaServiceFetch({
      host: makeHost(),
      sessions: new SessionStore(),
      api: { auth: new UserAuth({ domain: DOMAIN }), agents: new AgentStore(), authLimiter },
    });
    const req = () =>
      new Request("https://agents.test/api/auth/nonce", { headers: { "x-forwarded-for": "203.0.113.5" } });
    expect((await fetch(req())).status).toBe(200);
    expect((await fetch(req())).status).toBe(200);
    const limited = await fetch(req());
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toBe("rate_limit_exceeded");
  });

  it("rate-limits /api/auth/verify per IP and buckets are per-IP", async () => {
    const authLimiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const fetch = createElizaServiceFetch({
      host: makeHost(),
      sessions: new SessionStore(),
      api: { auth: new UserAuth({ domain: DOMAIN }), agents: new AgentStore(), authLimiter },
    });
    const verify = (ip: string) =>
      fetch(
        new Request("https://agents.test/api/auth/verify", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ message: "x", signature: "0x" }),
        }),
      );
    // First from IP A is allowed through to verify (401 invalid, not rate-limited).
    expect((await verify("198.51.100.1")).status).toBe(401);
    // Second from IP A is rate-limited.
    expect((await verify("198.51.100.1")).status).toBe(429);
    // A different IP has its own bucket — allowed through to verify again.
    expect((await verify("198.51.100.2")).status).toBe(401);
  });
});

describe("/api/agents lifecycle", () => {
  it("create -> list -> get -> disable -> gate", async () => {
    const { fetch } = makeFetch();
    const token = await signIn(fetch);

    // create
    const createRes = await fetch(
      authed("/api/agents", token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { agentId: string; agentDid: string; enabled: boolean };
    expect(created.agentDid).toBe(AGENT_DID);
    expect(created.enabled).toBe(true);

    // list
    const listRes = await fetch(authed("/api/agents", token));
    const list = (await listRes.json()) as { agents: Array<{ agentId: string }> };
    expect(list.agents.map((a) => a.agentId)).toEqual([created.agentId]);

    // get
    const getRes = await fetch(authed(`/api/agents/${created.agentId}`, token));
    expect(getRes.status).toBe(200);

    // disable
    const patchRes = await fetch(
      authed(`/api/agents/${created.agentId}`, token, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { enabled: boolean }).enabled).toBe(false);

    // disabled gate on delegation
    const delRes = await fetch(
      authed(`/api/agents/${created.agentId}/delegation`, token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serializedDelegation: "x" }),
      }),
    );
    expect(delRes.status).toBe(403);
    expect(((await delRes.json()) as { error: string }).error).toBe("agent_disabled");
  });

  it("delegation: a fixture whose delegateDID matches the agentDid validates and registers the server-derived entityId", async () => {
    // Host whose agentDidFor returns AGENT_DID and records the entityId registered.
    const registered: string[] = [];
    const host: ElizaServiceHost = {
      agentDid: AGENT_DID,
      agentDidFor: async () => AGENT_DID,
      storageFor: async () => ({
        async registerDelegation(entityId: string) {
          registered.push(entityId);
        },
      }),
      runtimeFor: async () => ({}) as IAgentRuntime,
      preflight: async () => {},
    };
    const auth = new UserAuth({ domain: DOMAIN });
    const agents = new AgentStore();
    const fetch = createElizaServiceFetch({ host, sessions: new SessionStore(), api: { auth, agents } });

    const token = await signIn(fetch);
    const created = (await (
      await fetch(
        authed("/api/agents", token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "d" }),
        }),
      )
    ).json()) as { agentId: string; space: string; pathPrefix: string; dbHandle: string };

    // The default (index 0) agent uses space "agents", pathPrefix "default/",
    // dbHandle "default/memory".
    expect(created.space).toBe("agents");
    expect(created.pathPrefix).toBe("default/");
    expect(created.dbHandle).toBe("default/memory");

    // A delegation whose delegateDID == the agent's DID, whose path == the agent's
    // dbHandle, AND whose resource space == the agent's space passes the full
    // deserialize -> shape -> policy (incl. fail-closed space assertion) chain.
    // Multi-resource shape: resources[].space carries the space the server checks.
    const ownerAddr = "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2";
    const spaceUri = `tinycloud:pkh:eip155:1:${ownerAddr}:${created.space}`;
    const actions = ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"];
    const serializedDelegation = JSON.stringify({
      cid: "bafy-api-deleg-test",
      delegateDID: AGENT_DID,
      spaceId: spaceUri,
      path: created.dbHandle,
      actions,
      resources: [{ service: "sql", space: spaceUri, path: created.dbHandle, actions }],
      expiry: new Date("2099-01-01T00:00:00.000Z").toISOString(),
      ownerAddress: ownerAddr,
      chainId: 1,
      host: "https://node.tinycloud.xyz",
    });

    const res = await fetch(
      authed(`/api/agents/${created.agentId}/delegation`, token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serializedDelegation }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entityId: string; status: string };
    expect(body.status).toBe("active");
    // entityId is derived server-side from (owner, agentId) — never caller-supplied.
    const expectedEntityId = addressToEntityId(account.address, created.agentId);
    expect(body.entityId).toBe(expectedEntityId);
    expect(registered).toEqual([expectedEntityId]);
  });

  it("delegation: a fixture whose delegateDID does NOT match the agentDid is rejected", async () => {
    const { fetch } = makeFetch();
    const token = await signIn(fetch);
    const created = (await (
      await fetch(
        authed("/api/agents", token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "d" }),
        }),
      )
    ).json()) as { agentId: string };

    const serializedDelegation = JSON.stringify({
      cid: "bafy-api-deleg-wrong",
      delegateDID: "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      spaceId: "tinycloud:pkh:eip155:1:0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2:default",
      path: MEMORY_DB_HANDLE,
      actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
      expiry: new Date("2099-01-01T00:00:00.000Z").toISOString(),
      ownerAddress: "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2",
      chainId: 1,
      host: "https://node.tinycloud.xyz",
    });

    const res = await fetch(
      authed(`/api/agents/${created.agentId}/delegation`, token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serializedDelegation }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("delegation: a grant minted against the WRONG space is rejected wrong_space (400)", async () => {
    const { fetch } = makeFetch();
    const token = await signIn(fetch);
    const created = (await (
      await fetch(
        authed("/api/agents", token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "d" }),
        }),
      )
    ).json()) as { agentId: string; dbHandle: string };

    // Correct delegateDID + correct path, but the resource space is "default" not
    // "agents" — the fail-closed space assertion must reject it.
    const ownerAddr = "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2";
    const wrongSpaceUri = `tinycloud:pkh:eip155:1:${ownerAddr}:default`;
    const actions = ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"];
    const serializedDelegation = JSON.stringify({
      cid: "bafy-wrong-space",
      delegateDID: AGENT_DID,
      spaceId: wrongSpaceUri,
      path: created.dbHandle,
      actions,
      resources: [{ service: "sql", space: wrongSpaceUri, path: created.dbHandle, actions }],
      expiry: new Date("2099-01-01T00:00:00.000Z").toISOString(),
      ownerAddress: ownerAddr,
      chainId: 1,
      host: "https://node.tinycloud.xyz",
    });

    const res = await fetch(
      authed(`/api/agents/${created.agentId}/delegation`, token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serializedDelegation }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("wrong_space");
  });

  it("delegation: a flat-shape grant (no verifiable space) is rejected wrong_space (400, fail-closed)", async () => {
    const { fetch } = makeFetch();
    const token = await signIn(fetch);
    const created = (await (
      await fetch(
        authed("/api/agents", token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "d" }),
        }),
      )
    ).json()) as { agentId: string; dbHandle: string };

    // Flat shape: correct delegateDID + path, but NO resources[] -> no space to
    // verify -> fail closed on the /api route.
    const ownerAddr = "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2";
    const serializedDelegation = JSON.stringify({
      cid: "bafy-flat-nospace",
      delegateDID: AGENT_DID,
      spaceId: `tinycloud:pkh:eip155:1:${ownerAddr}:agents`,
      path: created.dbHandle,
      actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
      expiry: new Date("2099-01-01T00:00:00.000Z").toISOString(),
      ownerAddress: ownerAddr,
      chainId: 1,
      host: "https://node.tinycloud.xyz",
    });

    const res = await fetch(
      authed(`/api/agents/${created.agentId}/delegation`, token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serializedDelegation }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("wrong_space");
  });

  it("returns 404 for another owner's agent (no ownership leak)", async () => {
    const { fetch, agents } = makeFetch();
    const token = await signIn(fetch);
    // Seed an agent owned by someone else directly in the store.
    const other = agents.create("0x2222222222222222222222222222222222222222", "theirs");
    const res = await fetch(authed(`/api/agents/${other.agentId}`, token));
    expect(res.status).toBe(404);
  });
});
