// /api/agents server integration tests (M2).
//
// Exercises the real createElizaServiceFetch dispatcher with a real UserAuth +
// AgentStore. SIWE messages are signed with a viem test account so the nonce ->
// verify -> bearer -> agents loop runs end to end without a live wallet.

import { describe, expect, it } from "bun:test";
import { SiweMessage } from "siwe";
import { privateKeyToAccount } from "viem/accounts";
import type { IAgentRuntime } from "@elizaos/core";
import { createElizaServiceFetch, type ElizaServiceHost } from "./server.js";
import { SessionStore } from "./session-store.js";
import { AgentStore } from "./agents/agent-store.js";
import { UserAuth } from "./auth/user-auth.js";

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

  it("returns 404 for another owner's agent (no ownership leak)", async () => {
    const { fetch, agents } = makeFetch();
    const token = await signIn(fetch);
    // Seed an agent owned by someone else directly in the store.
    const other = agents.create("0x2222222222222222222222222222222222222222", "theirs");
    const res = await fetch(authed(`/api/agents/${other.agentId}`, token));
    expect(res.status).toBe(404);
  });
});
