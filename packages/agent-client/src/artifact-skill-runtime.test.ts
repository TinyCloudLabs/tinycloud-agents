import { expect, test } from "bun:test";
import {
  RUN_ARTIFACT_SKILL,
  assertArtifactSkillRuntimeInput,
  createStubArtifactSkillRuntime,
  redactArtifactSkillRuntimeError,
  type ArtifactSkillRuntimeInput,
} from "./artifact-skill-runtime.ts";

function input(overrides: Partial<ArtifactSkillRuntimeInput> = {}): ArtifactSkillRuntimeInput {
  return {
    runId: "run-1",
    skillManifest: { packageId: "daily_digest" },
    sourcePack: {
      refs: [],
      excerpts: [],
      maxInputTokens: 12000,
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
      timeoutMs: 1000,
      maxOutputBytes: 4096,
    },
    ...overrides,
  };
}

test("RUN_ARTIFACT_SKILL names the Artifactory runtime tool", () => {
  expect(RUN_ARTIFACT_SKILL).toBe("RUN_ARTIFACT_SKILL");
});

test("stub artifact runtime returns a no-spend SkillRunOutput shape", async () => {
  const runtime = createStubArtifactSkillRuntime();
  const output = await runtime.run(input());

  expect(runtime.tool).toBe(RUN_ARTIFACT_SKILL);
  expect(output.candidates).toEqual([]);
  expect(output.trace.modelCalls).toBe(0);
  expect(output.trace.stageTrace[0]?.authorityUsed).toBe(false);
});

test("runtime input rejects ambient TinyCloud authority", () => {
  expect(() =>
    assertArtifactSkillRuntimeInput(
      input({
        runtimePolicy: {
          ...input().runtimePolicy,
          allowedTools: ["tinycloud"],
        },
      }),
    ),
  ).toThrow(/ambient tinycloud authority/);

  expect(() =>
    assertArtifactSkillRuntimeInput(
      input({
        runtimePolicy: {
          ...input().runtimePolicy,
          disallowedTools: ["shell", "network"],
        },
      }),
    ),
  ).toThrow(/explicitly disallow/);
});

test("runtime input only accepts worker-injected env secrets", () => {
  expect(() =>
    assertArtifactSkillRuntimeInput(
      input({
        secretEnv: [
          {
            name: "OPENAI_API_KEY",
            injection: "env",
            stageId: "generate",
            source: "worker_injected",
          },
        ],
      }),
    ),
  ).not.toThrow();
});

test("runtime error redaction removes provider credentials and bearer material", () => {
  const message = redactArtifactSkillRuntimeError(
    new Error(
      "failed Bearer abc.def.ghi OPENAI_API_KEY=sk-test REDPILL_API_KEY=rp-test api_key=plain",
    ),
  );

  expect(message).not.toContain("abc.def.ghi");
  expect(message).not.toContain("sk-test");
  expect(message).not.toContain("rp-test");
  expect(message).not.toContain("plain");
  expect(message).toContain("[REDACTED]");
});
