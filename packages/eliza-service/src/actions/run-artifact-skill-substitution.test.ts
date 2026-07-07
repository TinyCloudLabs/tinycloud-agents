// M0.4 substitution proof (TC-70): the same ArtifactSkillRuntime contract runs
// against both the stub runtime and the HTTP adapter, with the HTTP variant
// routed at a locally spawned eliza-service instance on a free port. This
// verifies the two implementations are behaviorally interchangeable for the
// no-spend seam that the Artifactory CLI depends on.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import {
  RUN_ARTIFACT_SKILL,
  createHttpArtifactSkillRuntime,
  createStubArtifactSkillRuntime,
} from "@tinycloud/agent-client";
import {
  makeContractRuntimeInput,
  runArtifactSkillRuntimeContract,
} from "../../../agent-client/src/artifact-skill-runtime-contract.testing.ts";
import { ARTIFACTORY_AGENT_ID } from "../auth/app-registry.js";
import { SessionStore } from "../session-store.js";
import { startElizaService, type ElizaServiceHost } from "../server.js";
import { runArtifactSkillAction } from "./run-artifact-skill.js";

const TEST_AGENT_DID = "did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c";
const TEST_ARTIFACTORY_SERVICE_SECRET = "tc70-substitution-artifactory-secret";

interface SpawnedService {
  server: ReturnType<typeof startElizaService>;
  baseUrl: string;
}

function spawnRealService(): SpawnedService {
  const runtime = {
    agentId: ARTIFACTORY_AGENT_ID as UUID,
    actions: [runArtifactSkillAction],
  } as unknown as IAgentRuntime;
  const host: ElizaServiceHost = {
    agentDid: TEST_AGENT_DID,
    // storageFor is unused by the /tools path; a minimal stub keeps the type happy.
    storageFor: async () => ({ registerDelegation: async () => {} }) as never,
    runtimeFor: async (agentId) => {
      if (agentId !== ARTIFACTORY_AGENT_ID) {
        throw new Error("substitution test host routes only the artifactory agent");
      }
      return runtime;
    },
    preflight: async () => {},
  };
  const server = startElizaService({ host, sessions: new SessionStore(), port: 0 });
  return { server, baseUrl: `http://${server.hostname}:${server.port}` };
}

describe("RUN_ARTIFACT_SKILL substitution proof (stub ⇄ http real server)", () => {
  let spawned: SpawnedService | undefined;
  let savedArtifactorySecret: string | undefined;

  beforeAll(() => {
    savedArtifactorySecret = process.env.ARTIFACTORY_SERVICE_SECRET;
    process.env.ARTIFACTORY_SERVICE_SECRET = TEST_ARTIFACTORY_SERVICE_SECRET;
    spawned = spawnRealService();
  });

  afterAll(async () => {
    await spawned?.server.stop(true);
    spawned = undefined;
    if (savedArtifactorySecret !== undefined) {
      process.env.ARTIFACTORY_SERVICE_SECRET = savedArtifactorySecret;
    } else {
      delete process.env.ARTIFACTORY_SERVICE_SECRET;
    }
  });

  runArtifactSkillRuntimeContract("stub runtime (baseline)", () =>
    createStubArtifactSkillRuntime(),
  );

  runArtifactSkillRuntimeContract("http runtime (real spawned eliza-service)", () => {
    if (!spawned) throw new Error("real eliza-service test instance not started");
    return createHttpArtifactSkillRuntime({
      baseUrl: spawned.baseUrl,
      serviceSecret: TEST_ARTIFACTORY_SERVICE_SECRET,
    });
  });

  it("http adapter reaches the real /tools/RUN_ARTIFACT_SKILL endpoint and returns stub.v1", async () => {
    if (!spawned) throw new Error("real eliza-service test instance not started");
    const runtime = createHttpArtifactSkillRuntime({
      baseUrl: spawned.baseUrl,
      serviceSecret: TEST_ARTIFACTORY_SERVICE_SECRET,
    });
    const output = await runtime.run(makeContractRuntimeInput({ runId: "sub-1" }));
    expect(output.trace.procedureVersion).toBe("stub.v1");
    expect(output.candidates).toEqual([]);
    expect(output.trace.stageTrace[0]?.authorityUsed).toBe(false);
    expect(runtime.tool).toBe(RUN_ARTIFACT_SKILL);
  });

  it("http adapter surfaces auth failures as a redacted error without leaking the bearer", async () => {
    if (!spawned) throw new Error("real eliza-service test instance not started");
    const wrongBearer = "wrong-bearer-that-must-not-appear-in-thrown-error";
    const runtime = createHttpArtifactSkillRuntime({
      baseUrl: spawned.baseUrl,
      serviceSecret: wrongBearer,
    });

    let caught: unknown;
    try {
      await runtime.run(makeContractRuntimeInput());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // eliza-service returns 403 for a well-formed-but-unknown bearer, 401 for
    // a missing or malformed Authorization header — the adapter must surface
    // either without leaking the credential material back to the caller.
    expect(message).toMatch(/40[13]/);
    expect(message).not.toContain(wrongBearer);
  });

  it("http adapter surfaces 400 invalid_args for a policy that grants ambient tinycloud authority (server-side gate)", async () => {
    if (!spawned) throw new Error("real eliza-service test instance not started");
    const runtime = createHttpArtifactSkillRuntime({
      baseUrl: spawned.baseUrl,
      serviceSecret: TEST_ARTIFACTORY_SERVICE_SECRET,
    });
    // Bypass client-side assertion by mutating the input past the guard: use the
    // raw `fetch` seam directly through the adapter is not possible (assertion
    // runs first), so instead we cover the same rejection at the HTTP layer via
    // a hand-rolled fetch to the real server.
    const bad = makeContractRuntimeInput({
      runtimePolicy: {
        ...makeContractRuntimeInput().runtimePolicy,
        allowedTools: ["tinycloud"],
      },
    });
    await expect(runtime.run(bad)).rejects.toThrow(/ambient tinycloud authority/);

    const res = await fetch(`${spawned.baseUrl}/tools/${RUN_ARTIFACT_SKILL}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_ARTIFACTORY_SERVICE_SECRET}`,
      },
      body: JSON.stringify({ args: bad }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_args" });
  });
});
