// /api/agents handler tests (M2): create/list/get/patch/delegation, ownership.

import { describe, expect, it } from "bun:test";
import { AgentStore, agentIdFor } from "../agents/agent-store.js";
import { SessionStore } from "../session-store.js";
import { addressToEntityId } from "../entity-id.js";
import {
  handleCreateAgent,
  handleGetAgent,
  handleListAgents,
  handlePatchAgent,
  handleAgentDelegation,
  ownerEntityId,
  type AgentsHandlerHost,
} from "./agents.js";

const OWNER = "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2";
const OTHER = "0x1111111111111111111111111111111111111111";
const AGENT_DID = "did:pkh:eip155:1:0x000000000000000000000000000000000000dEaD";

// Host stub: agentDidFor returns a fixed DID; storageFor records registerDelegation.
function makeHost(): { host: AgentsHandlerHost; registered: Array<{ entityId: string }> } {
  const registered: Array<{ entityId: string }> = [];
  const host: AgentsHandlerHost = {
    agentDidFor: async () => AGENT_DID,
    storageFor: async () => ({
      async registerDelegation(entityId: string) {
        registered.push({ entityId });
      },
    }),
  };
  return { host, registered };
}

describe("handleCreateAgent", () => {
  it("creates the owner's agent and returns 201 with a DID", async () => {
    const store = new AgentStore();
    const { host } = makeHost();
    const res = await handleCreateAgent(OWNER, { name: "My Agent" }, store, host);
    expect(res.status).toBe(201);
    const body = res.body as { agentId: string; agentDid: string; name: string; enabled: boolean };
    expect(body.agentId).toBe(agentIdFor(OWNER, 0));
    expect(body.agentDid).toBe(AGENT_DID);
    expect(body.name).toBe("My Agent");
    expect(body.enabled).toBe(true);
  });

  it("defaults the name when blank", async () => {
    const store = new AgentStore();
    const { host } = makeHost();
    const res = await handleCreateAgent(OWNER, { name: "  " }, store, host);
    expect((res.body as { name: string }).name).toBe("agent");
  });
});

describe("handleListAgents / handleGetAgent", () => {
  it("lists only the owner's agents", async () => {
    const store = new AgentStore();
    const { host } = makeHost();
    await handleCreateAgent(OWNER, { name: "a" }, store, host);
    await handleCreateAgent(OTHER, { name: "b" }, store, host);
    const res = await handleListAgents(OWNER, store, host);
    const body = res.body as { agents: Array<{ name: string }> };
    expect(body.agents.map((a) => a.name)).toEqual(["a"]);
  });

  it("get returns 404 for a non-owned agent", async () => {
    const store = new AgentStore();
    const { host } = makeHost();
    const created = await handleCreateAgent(OWNER, { name: "a" }, store, host);
    const agentId = (created.body as { agentId: string }).agentId;
    const res = await handleGetAgent(OTHER, agentId, store, host);
    expect(res.status).toBe(404);
  });
});

describe("handlePatchAgent", () => {
  it("toggles enabled for the owner", async () => {
    const store = new AgentStore();
    const { host } = makeHost();
    const created = await handleCreateAgent(OWNER, { name: "a" }, store, host);
    const agentId = (created.body as { agentId: string }).agentId;
    const res = await handlePatchAgent(OWNER, agentId, { enabled: false }, store, host);
    expect(res.status).toBe(200);
    expect((res.body as { enabled: boolean }).enabled).toBe(false);
  });

  it("rejects a non-boolean enabled", async () => {
    const store = new AgentStore();
    const { host } = makeHost();
    const created = await handleCreateAgent(OWNER, { name: "a" }, store, host);
    const agentId = (created.body as { agentId: string }).agentId;
    const res = await handlePatchAgent(OWNER, agentId, { enabled: "yes" }, store, host);
    expect(res.status).toBe(400);
  });

  it("returns 404 for a non-owner", async () => {
    const store = new AgentStore();
    const { host } = makeHost();
    const created = await handleCreateAgent(OWNER, { name: "a" }, store, host);
    const agentId = (created.body as { agentId: string }).agentId;
    const res = await handlePatchAgent(OTHER, agentId, { enabled: false }, store, host);
    expect(res.status).toBe(404);
  });
});

describe("ownerEntityId", () => {
  it("derives entityId server-side from (owner, agentId)", () => {
    const store = new AgentStore();
    const rec = store.create(OWNER, "a");
    expect(ownerEntityId(OWNER, rec.agentId, store)).toBe(addressToEntityId(OWNER, rec.agentId));
  });

  it("returns null for a non-owned agent", () => {
    const store = new AgentStore();
    const rec = store.create(OWNER, "a");
    expect(ownerEntityId(OTHER, rec.agentId, store)).toBeNull();
  });
});

describe("handleAgentDelegation", () => {
  it("404s for a non-owned agent (before touching storage)", async () => {
    const store = new AgentStore();
    const { host, registered } = makeHost();
    const rec = store.create(OWNER, "a");
    const res = await handleAgentDelegation(
      OTHER,
      rec.agentId,
      { serializedDelegation: "x" },
      store,
      new SessionStore(),
      host,
    );
    expect(res.status).toBe(404);
    expect(registered).toHaveLength(0);
  });

  it("400s when serializedDelegation is missing", async () => {
    const store = new AgentStore();
    const { host } = makeHost();
    const rec = store.create(OWNER, "a");
    const res = await handleAgentDelegation(OWNER, rec.agentId, {}, store, new SessionStore(), host);
    expect(res.status).toBe(400);
  });
});
