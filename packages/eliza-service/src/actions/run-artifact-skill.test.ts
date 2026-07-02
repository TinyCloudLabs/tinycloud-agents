import { describe, expect, it } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import {
  RUN_ARTIFACT_SKILL,
  redactArtifactSkillRuntimeError,
  type ArtifactSkillRuntimeInput,
  type ArtifactSkillRuntimeOutput,
} from "@tinycloud/agent-client";
import { handlePostTool, type ToolHandlerHost } from "../handlers/tools.js";
import { runArtifactSkillAction } from "./run-artifact-skill.js";

const AGENT_ID = "b5c9f7e2-1a3d-4e5f-8b7a-9c0d1e2f3a4b";

function host(): ToolHandlerHost {
  const runtime = {
    agentId: AGENT_ID,
    actions: [runArtifactSkillAction],
  } as unknown as IAgentRuntime;
  return { runtimeFor: async () => runtime };
}

function validInput(overrides: Partial<ArtifactSkillRuntimeInput> = {}): ArtifactSkillRuntimeInput {
  return {
    runId: "run-tc69-1",
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
      timeoutMs: 1000,
      maxOutputBytes: 4096,
    },
    ...overrides,
  };
}

describe("runArtifactSkillAction", () => {
  it("registers under the canonical RUN_ARTIFACT_SKILL tool name", () => {
    expect(runArtifactSkillAction.name).toBe(RUN_ARTIFACT_SKILL);
  });

  it("returns a contract-shaped ArtifactSkillRuntimeOutput via stub semantics", async () => {
    const result = await handlePostTool(
      "run_artifact_skill",
      AGENT_ID,
      { args: validInput() as unknown as Record<string, unknown> },
      host(),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      ok: boolean;
      tool: string;
      result: { data: ArtifactSkillRuntimeOutput };
    };
    expect(body.ok).toBe(true);
    expect(body.tool).toBe(RUN_ARTIFACT_SKILL);
    const output = body.result.data;
    expect(output.candidates).toEqual([]);
    expect(output.trace.modelCalls).toBe(0);
    expect(output.trace.procedureVersion).toBe("stub.v1");
    expect(output.trace.stageTrace[0]?.authorityUsed).toBe(false);
  });

  it("rejects a malformed payload with 400 invalid_args", async () => {
    const result = await handlePostTool(
      "run_artifact_skill",
      AGENT_ID,
      { args: { runId: 42 } },
      host(),
    );

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "invalid_args" });
  });

  it("rejects ambient tinycloud authority with 400 invalid_args", async () => {
    const input = validInput({
      runtimePolicy: {
        ...validInput().runtimePolicy,
        allowedTools: ["tinycloud"],
      },
    });

    const result = await handlePostTool(
      "run_artifact_skill",
      AGENT_ID,
      { args: input as unknown as Record<string, unknown> },
      host(),
    );

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "invalid_args" });
  });

  it("rejects a policy that fails to explicitly disallow tinycloud", async () => {
    const input = validInput({
      runtimePolicy: {
        ...validInput().runtimePolicy,
        disallowedTools: ["shell"],
      },
    });

    const result = await handlePostTool(
      "run_artifact_skill",
      AGENT_ID,
      { args: input as unknown as Record<string, unknown> },
      host(),
    );

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "invalid_args" });
  });

  it("redacts bearer tokens and provider credentials from error messages", () => {
    const redacted = redactArtifactSkillRuntimeError(
      new Error(
        "leak Bearer sk-live-abc123 OPENAI_API_KEY=sk-openai-xyz api_key=plain-secret",
      ),
    );

    expect(redacted).not.toContain("sk-live-abc123");
    expect(redacted).not.toContain("sk-openai-xyz");
    expect(redacted).not.toContain("plain-secret");
    expect(redacted).toContain("[REDACTED]");
  });
});
