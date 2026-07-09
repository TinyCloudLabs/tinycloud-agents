// RUN_ARTIFACT_SKILL action — hosted execution seam for the Artifactory pipeline
// (TC-69, D7/D8). Dispatched via POST /tools/RUN_ARTIFACT_SKILL.
//
// D7: Artifactory ships as a CLI holding deterministic pipeline logic and calls
// back into eliza-service to run the ArtifactSkillRuntime. D8: this runs on the
// standard agent runtime (with the user-memory plugin), reusing the existing
// runtime-host path.
//
// M0: STUB semantics only — createStubArtifactSkillRuntime() executes with no
// spend, asserts the authority invariant on the input, and returns a
// contract-shaped output. TC-73 will wire real provider/credential paths.
//
// Errors thrown here are surfaced via handlePostTool → ToolError; message text
// is passed through redactArtifactSkillRuntimeError and runtime output is
// passed through redactArtifactSkillRuntimeOutput so no Bearer/api_key/env
// secret material can leak into the response body.

import type { Action, Plugin } from "@elizaos/core";
import {
  RUN_ARTIFACT_SKILL,
  assertArtifactSkillRuntimeInput,
  createStubArtifactSkillRuntime,
  redactArtifactSkillRuntimeOutput,
  redactArtifactSkillRuntimeError,
  type ArtifactSkillRuntimeInput,
} from "@tinycloud/agent-client";
import { ToolError } from "../handlers/tools.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isArtifactSkillRuntimeInput(value: unknown): value is ArtifactSkillRuntimeInput {
  if (!isRecord(value)) return false;
  if (typeof value.runId !== "string") return false;
  if (!("skillManifest" in value)) return false;
  if (!isRecord(value.sourcePack)) return false;
  const sp = value.sourcePack;
  if (!Array.isArray(sp.refs)) return false;
  if (!Array.isArray(sp.excerpts)) return false;
  if (typeof sp.maxInputTokens !== "number") return false;
  if (!isRecord(value.runtimePolicy)) return false;
  const rp = value.runtimePolicy;
  if (!Array.isArray(rp.allowedTools)) return false;
  if (!Array.isArray(rp.disallowedTools)) return false;
  if (typeof rp.maxModelCalls !== "number") return false;
  if (typeof rp.timeoutMs !== "number") return false;
  if (typeof rp.maxOutputBytes !== "number") return false;
  return true;
}

export const runArtifactSkillAction: Action = {
  name: RUN_ARTIFACT_SKILL,
  description:
    "Execute an artifact-skill run for the Artifactory pipeline. Consumes a bounded " +
    "sourcePack + runtimePolicy from the caller and returns candidates + stage trace. " +
    "Never holds Feed/Listen/Artifacts authority; the authority invariant is asserted " +
    "on every input.",
  similes: [],
  examples: [],
  validate: async () => true,
  handler: async (_runtime, _message, _state, options) => {
    const args = (options as { args?: Record<string, unknown> } | undefined)?.args;
    if (!isArtifactSkillRuntimeInput(args)) {
      throw new ToolError(
        "run_artifact_skill: invalid ArtifactSkillRuntimeInput payload",
        400,
        "invalid_args",
      );
    }

    // Compute the sensitive-value scrub list ONCE up front so every downstream
    // error path — assertion failure, runtime.run() failure, output redaction —
    // uses the same operator-supplied secretRef / env-var name allowlist. These
    // may not match the built-in redactor patterns (custom vault prefixes,
    // lowercase names, etc.) so we scrub them explicitly on top of pattern
    // matches. Derived before the assertion so an assertion that ever grows to
    // embed input values will still be scrubbed on the way out.
    const sensitiveValues = args.secretEnv
      ?.flatMap((secret) => [secret.secretRef, secret.name])
      .filter((value): value is string => typeof value === "string" && value.length > 0) ?? [];

    try {
      assertArtifactSkillRuntimeInput(args);
    } catch (err) {
      throw new ToolError(
        redactArtifactSkillRuntimeError(err, sensitiveValues),
        400,
        "invalid_args",
      );
    }

    const runtime = createStubArtifactSkillRuntime();
    try {
      const output = redactArtifactSkillRuntimeOutput(await runtime.run(args), sensitiveValues);
      return {
        success: true,
        text: "",
        data: output,
      };
    } catch (err) {
      throw new ToolError(
        redactArtifactSkillRuntimeError(err, sensitiveValues),
        502,
        "artifact_skill_failed",
      );
    }
  },
};

export const runArtifactSkillPlugin: Plugin = {
  name: "tinycloud-run-artifact-skill",
  description:
    "Artifactory RUN_ARTIFACT_SKILL runtime seam (stub semantics; TC-69).",
  actions: [runArtifactSkillAction],
};
