// AgentStore tests (M2): deterministic agentIds, idempotent create, ownership.

import { describe, expect, it } from "bun:test";
import { AgentStore, agentIdFor } from "./agent-store.js";
import { stringToUuid } from "../entity-id.js";

const OWNER = "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2";
const OWNER_LOWER = OWNER.toLowerCase();
const OTHER = "0x1111111111111111111111111111111111111111";

describe("agentIdFor", () => {
  it("is deterministic and lowercases the owner (checksummed == lowercase)", () => {
    const expected = stringToUuid(`${OWNER_LOWER}:agent:0`);
    expect(agentIdFor(OWNER, 0)).toBe(expected);
    expect(agentIdFor(OWNER, 0)).toBe(agentIdFor(OWNER_LOWER, 0));
  });

  it("different indices give different agentIds", () => {
    expect(agentIdFor(OWNER, 0)).not.toBe(agentIdFor(OWNER, 1));
  });
});

describe("AgentStore.create", () => {
  it("assigns index 0 then 1 for an owner's first two agents", () => {
    const store = new AgentStore();
    const a = store.create(OWNER, "first");
    const b = store.create(OWNER, "second");
    expect(a.index).toBe(0);
    expect(b.index).toBe(1);
    expect(a.agentId).toBe(agentIdFor(OWNER, 0));
    expect(b.agentId).toBe(agentIdFor(OWNER, 1));
  });

  it("stores the lowercased owner and enabled=true", () => {
    const store = new AgentStore();
    const a = store.create(OWNER, "x");
    expect(a.ownerAddress).toBe(OWNER_LOWER);
    expect(a.enabled).toBe(true);
    expect(a.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps per-owner index sequences independent", () => {
    const store = new AgentStore();
    store.create(OWNER, "a");
    const other0 = store.create(OTHER, "b");
    expect(other0.index).toBe(0);
  });
});

describe("AgentStore.get / listByOwner", () => {
  it("get returns the record by agentId", () => {
    const store = new AgentStore();
    const a = store.create(OWNER, "x");
    expect(store.get(a.agentId)).toBe(a);
    expect(store.get("nope")).toBeUndefined();
  });

  it("listByOwner returns only the owner's records in index order", () => {
    const store = new AgentStore();
    const a0 = store.create(OWNER, "a");
    store.create(OTHER, "b");
    const a1 = store.create(OWNER, "c");
    const list = store.listByOwner(OWNER);
    expect(list.map((r) => r.agentId)).toEqual([a0.agentId, a1.agentId]);
  });

  it("listByOwner matches regardless of address casing", () => {
    const store = new AgentStore();
    const a = store.create(OWNER, "x");
    expect(store.listByOwner(OWNER_LOWER).map((r) => r.agentId)).toEqual([a.agentId]);
    expect(store.listByOwner(OWNER.toUpperCase()).map((r) => r.agentId)).toEqual([a.agentId]);
  });
});

describe("AgentStore.setEnabled", () => {
  it("toggles enabled for the owner", () => {
    const store = new AgentStore();
    const a = store.create(OWNER, "x");
    expect(store.setEnabled(a.agentId, OWNER, false)?.enabled).toBe(false);
    expect(store.get(a.agentId)?.enabled).toBe(false);
  });

  it("returns undefined for a non-owner (no cross-owner mutation)", () => {
    const store = new AgentStore();
    const a = store.create(OWNER, "x");
    expect(store.setEnabled(a.agentId, OTHER, false)).toBeUndefined();
    expect(store.get(a.agentId)?.enabled).toBe(true);
  });

  it("returns undefined for an unknown agentId", () => {
    const store = new AgentStore();
    expect(store.setEnabled("nope", OWNER, false)).toBeUndefined();
  });
});
