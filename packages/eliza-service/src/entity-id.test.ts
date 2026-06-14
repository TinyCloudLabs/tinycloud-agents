import { describe, expect, it } from "bun:test";
import { createUniqueUuid } from "@elizaos/core";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { addressToEntityId, stringToUuid } from "./entity-id.js";

const AGENT_ID = "92361e74-91ed-43a2-9656-5cc37ff3a07a" as UUID;

// EIP-55 checksummed address
const ADDR_CHECKSUMMED = "0x7D0333579C19E8Fa149C2dbF8405Cb6f66C373f2";
// Same address, all lowercase
const ADDR_LOWER = "0x7d0333579c19e8fa149c2dbf8405cb6f66c373f2";

describe("stringToUuid", () => {
  it("canary: stringToUuid('hello') matches golden vector", () => {
    expect(stringToUuid("hello")).toBe("aaf4c61d-dcc5-08a2-9abe-de0f3b482cd9");
  });

  it("already-a-UUID passthrough", () => {
    const uuid = "12345678-1234-1234-1234-123456789abc";
    expect(stringToUuid(uuid)).toBe(uuid);
  });

  it("idempotence: same input always yields same output", () => {
    expect(stringToUuid("some-test-input")).toBe(stringToUuid("some-test-input"));
  });
});

describe("addressToEntityId", () => {
  it("byte-equality against @elizaos/core createUniqueUuid for fixed address+agentId", () => {
    // createUniqueUuid(rt, baseUserId) when baseUserId !== rt.agentId:
    //   = stringToUuid(`${baseUserId}:${rt.agentId}`)
    // addressToEntityId(addr, agentId):
    //   = stringToUuid(`${addr.toLowerCase()}:${agentId}`)
    // Equivalence when rt.agentId = agentId and baseUserId = addr.toLowerCase()
    const rtStub = { agentId: AGENT_ID } as unknown as IAgentRuntime;
    const coreResult = createUniqueUuid(rtStub, ADDR_LOWER);
    expect(addressToEntityId(ADDR_LOWER, AGENT_ID)).toBe(coreResult);
  });

  it("checksummed and lowercase address map to the same UUID", () => {
    expect(addressToEntityId(ADDR_LOWER, AGENT_ID)).toBe(
      addressToEntityId(ADDR_CHECKSUMMED, AGENT_ID)
    );
  });

  it("idempotence: same address+agentId always yields same UUID", () => {
    expect(addressToEntityId(ADDR_LOWER, AGENT_ID)).toBe(
      addressToEntityId(ADDR_LOWER, AGENT_ID)
    );
  });
});
