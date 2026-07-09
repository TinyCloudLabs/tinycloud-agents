import { expect, test } from "bun:test";
import {
  RUN_ARTIFACT_SKILL,
  assertArtifactSkillRuntimeInput,
  createStubArtifactSkillRuntime,
  redactArtifactSkillRuntimeOutput,
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
            secretRef: "vault/secrets/scoped/feed/OPENAI_API_KEY",
            injection: "env",
            stageId: "generate",
            source: "worker_injected",
          },
        ],
      }),
    ),
  ).not.toThrow();
});

test("runtime input rejects worker-injected env secrets without exact secret refs", () => {
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
  ).toThrow(/exact secret refs/);
});

test("runtime output redaction removes secret paths and inline secret material", () => {
  const output = redactArtifactSkillRuntimeOutput(
    {
      trace: {
        procedureVersion: "test.v1",
        modelCalls: 1,
        toolCalls: [
          { name: "demo", purpose: "secretRef=vault/secrets/scoped/feed/OPENAI_API_KEY missing OPENAI_API_KEY" },
        ],
        stageTrace: [
          {
            stageId: "stub",
            declaredCapabilities: [],
            grantedCapabilities: [],
            authorityUsed: false,
            deniedReasons: ["Bearer sk-live-abc123", "missing OPENAI_API_KEY", "api_key=plain-secret"],
          },
        ],
        droppedCandidates: [{ reason: "vault/secrets/scoped/feed/OPENAI_API_KEY" }],
      },
      candidates: [
        {
          title: "uses vault/secrets/scoped/feed/OPENAI_API_KEY",
          body: { text: "OPENAI_API_KEY=sk-test" },
        },
      ],
    },
    ["vault/secrets/scoped/feed/OPENAI_API_KEY"],
  );

  expect(JSON.stringify(output)).not.toContain("vault/secrets/scoped/feed/OPENAI_API_KEY");
  expect(JSON.stringify(output)).not.toContain("OPENAI_API_KEY");
  expect(JSON.stringify(output)).not.toContain("sk-live-abc123");
  expect(JSON.stringify(output)).not.toContain("plain-secret");
  expect(JSON.stringify(output)).not.toContain("sk-test");
});

test("runtime error redaction removes provider credentials and bearer material", () => {
  const message = redactArtifactSkillRuntimeError(
    new Error(
      "failed Bearer abc.def.ghi missing OPENAI_API_KEY OPENAI_API_KEY=sk-test REDPILL_API_KEY=rp-test api_key=plain",
    ),
  );

  expect(message).not.toContain("abc.def.ghi");
  expect(message).not.toContain("sk-test");
  expect(message).not.toContain("rp-test");
  expect(message).not.toContain("plain");
  expect(message).not.toContain("OPENAI_API_KEY");
  expect(message).toContain("[REDACTED]");
});

// Planted-marker: a "vault-shaped" secretRef that does NOT match the built-in
// SECRET_PATH_PATTERN / SECRET_NAME_PATTERN / KEY_VALUE_PATTERN patterns (custom
// prefix, lowercase, no =value suffix) is a real leak class that only the
// sensitiveValues allowlist can catch. Regression guard for the runtime
// callers threading `input.secretEnv` into `redactArtifactSkillRuntimeError`.
test("runtime error redaction scrubs sensitiveValues that miss the built-in patterns", () => {
  const marker = "PLANTED_SECRET_tc73_agents_7e2a";
  const message = redactArtifactSkillRuntimeError(
    new Error(`upstream referenced my-org/prod/${marker}/openai in stage generate`),
    [`my-org/prod/${marker}/openai`, marker],
  );
  expect(message).not.toContain(marker);
  expect(message).not.toContain("my-org/prod");
  expect(message).toContain("[REDACTED]");
});

test("runtime error redaction tolerates non-Error thrown values while still scrubbing", () => {
  const marker = "PLANTED_SECRET_tc73_agents_7e2a";
  const message = redactArtifactSkillRuntimeError(
    `raw-throw ${marker} api_key=leaked`,
    [marker],
  );
  expect(message).not.toContain(marker);
  expect(message).not.toContain("leaked");
});
