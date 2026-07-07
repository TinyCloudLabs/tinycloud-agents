// Shared M0.4 substitution contract for ArtifactSkillRuntime implementations.
//
// One suite runs against BOTH `createStubArtifactSkillRuntime` and
// `createHttpArtifactSkillRuntime` (against a live eliza-service test server) so
// the "no-spend stub" and the "real HTTP call to the hosted runtime" satisfy the
// same shape/authority/redaction invariants. Exported from the package so the
// eliza-service integration tests can execute it against a locally spawned
// service instance without duplicating assertions.

import { describe, expect, it } from "bun:test";
import {
  RUN_ARTIFACT_SKILL,
  type ArtifactSkillRuntime,
  type ArtifactSkillRuntimeInput,
} from "./artifact-skill-runtime";

export function makeContractRuntimeInput(
  overrides: Partial<ArtifactSkillRuntimeInput> = {},
): ArtifactSkillRuntimeInput {
  return {
    runId: "contract-run-1",
    skillManifest: { packageId: "daily_digest" },
    sourcePack: {
      refs: [{ id: "src-1" }],
      excerpts: [{ sourceRefId: "src-1", text: "hello world" }],
      maxInputTokens: 8000,
    },
    settings: {},
    runtimePolicy: {
      runtimeClass: "stub",
      providerClass: "none",
      credentialMode: "none",
      egressClass: "none",
      allowedTools: [],
      disallowedTools: ["tinycloud", "shell", "network"],
      maxModelCalls: 0,
      timeoutMs: 5000,
      maxOutputBytes: 4096,
    },
    ...overrides,
  };
}

/**
 * Register the substitution contract as a `describe` block. Callers pass a
 * factory so each `it` gets a fresh runtime — this matters for the HTTP variant
 * where the underlying fetch keeps no state but a stub might.
 */
export function runArtifactSkillRuntimeContract(
  label: string,
  makeRuntime: () => ArtifactSkillRuntime | Promise<ArtifactSkillRuntime>,
): void {
  describe(`ArtifactSkillRuntime contract: ${label}`, () => {
    it("advertises the canonical RUN_ARTIFACT_SKILL tool name", async () => {
      const runtime = await makeRuntime();
      expect(runtime.tool).toBe(RUN_ARTIFACT_SKILL);
    });

    it("returns a no-spend, contract-shaped SkillRunOutput", async () => {
      const runtime = await makeRuntime();
      const output = await runtime.run(makeContractRuntimeInput());

      expect(Array.isArray(output.candidates)).toBe(true);
      expect(output.candidates).toEqual([]);
      expect(typeof output.trace.procedureVersion).toBe("string");
      expect(output.trace.procedureVersion.length).toBeGreaterThan(0);
      expect(output.trace.modelCalls).toBe(0);
      expect(Array.isArray(output.trace.toolCalls)).toBe(true);
      expect(Array.isArray(output.trace.stageTrace)).toBe(true);
      expect(output.trace.stageTrace.length).toBeGreaterThan(0);
      expect(output.trace.stageTrace[0]?.authorityUsed).toBe(false);
      expect(Array.isArray(output.trace.droppedCandidates)).toBe(true);
    });

    it("rejects ambient TinyCloud authority in runtimePolicy.allowedTools", async () => {
      const runtime = await makeRuntime();
      const bad = makeContractRuntimeInput({
        runtimePolicy: {
          ...makeContractRuntimeInput().runtimePolicy,
          allowedTools: ["tinycloud"],
        },
      });
      await expect(runtime.run(bad)).rejects.toThrow();
    });

    it("rejects a policy that fails to explicitly disallow tinycloud", async () => {
      const runtime = await makeRuntime();
      const bad = makeContractRuntimeInput({
        runtimePolicy: {
          ...makeContractRuntimeInput().runtimePolicy,
          disallowedTools: ["shell"],
        },
      });
      await expect(runtime.run(bad)).rejects.toThrow();
    });

    it("rejects an empty runId", async () => {
      const runtime = await makeRuntime();
      const bad = makeContractRuntimeInput({ runId: "" });
      await expect(runtime.run(bad)).rejects.toThrow();
    });
  });
}
