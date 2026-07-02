// HTTP adapter for the RUN_ARTIFACT_SKILL runtime (TC-70 / D7).
//
// The Artifactory CLI calls this adapter to dispatch a bounded ArtifactSkillRuntime
// run into eliza-service via POST /tools/RUN_ARTIFACT_SKILL. On success, the
// candidate + trace envelope from the service is returned verbatim. On any failure
// path (network, timeout, non-2xx, malformed body, service-reported error) the
// message is routed through `redactArtifactSkillRuntimeError` so no bearer,
// api-key, or worker-injected env material can leak into thrown Errors or logs.
//
// The adapter never reads or forwards delegation material — the sourcePack /
// runtimePolicy come from the caller and the eliza-service side is authenticated
// by the fixed ARTIFACTORY_SERVICE_SECRET bearer at the HTTP boundary. The
// `serviceSecret` is only ever placed on the Authorization header and is never
// echoed into error messages, log output, or the response body.
//
// The adapter respects `input.runtimePolicy.timeoutMs` via an AbortController on
// the fetch call.

import {
  RUN_ARTIFACT_SKILL,
  assertArtifactSkillRuntimeInput,
  redactArtifactSkillRuntimeError,
  type ArtifactSkillRuntime,
  type ArtifactSkillRuntimeInput,
  type ArtifactSkillRuntimeOutput,
} from "./artifact-skill-runtime";

export interface HttpArtifactSkillRuntimeOptions {
  /** Base URL of the eliza-service instance, e.g. "http://127.0.0.1:3000". */
  baseUrl: string;
  /** Service bearer credential (ARTIFACTORY_SERVICE_SECRET on the server side). */
  serviceSecret: string;
  /** Optional fetch override — defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isArtifactSkillRuntimeOutput(value: unknown): value is ArtifactSkillRuntimeOutput {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.candidates)) return false;
  if (!isRecord(value.trace)) return false;
  const trace = value.trace;
  if (typeof trace.procedureVersion !== "string") return false;
  if (typeof trace.modelCalls !== "number") return false;
  if (!Array.isArray(trace.toolCalls)) return false;
  if (!Array.isArray(trace.stageTrace)) return false;
  if (!Array.isArray(trace.droppedCandidates)) return false;
  return true;
}

export function createHttpArtifactSkillRuntime(
  opts: HttpArtifactSkillRuntimeOptions,
): ArtifactSkillRuntime {
  const baseUrl = stripTrailingSlash(opts.baseUrl);
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const url = `${baseUrl}/tools/${RUN_ARTIFACT_SKILL}`;

  return {
    tool: RUN_ARTIFACT_SKILL,
    async run(input: ArtifactSkillRuntimeInput): Promise<ArtifactSkillRuntimeOutput> {
      assertArtifactSkillRuntimeInput(input);

      const controller = new AbortController();
      const timeoutMs = input.runtimePolicy.timeoutMs;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => controller.abort(), timeoutMs)
          : undefined;

      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.serviceSecret}`,
          },
          body: JSON.stringify({ args: input }),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(
            redactArtifactSkillRuntimeError(
              `run_artifact_skill request timed out after ${timeoutMs}ms`,
            ),
          );
        }
        throw new Error(
          redactArtifactSkillRuntimeError(
            `run_artifact_skill request failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (err) {
        throw new Error(
          redactArtifactSkillRuntimeError(
            `run_artifact_skill returned non-JSON response (status ${response.status}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }

      if (!response.ok) {
        const code =
          isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : "unknown";
        throw new Error(
          redactArtifactSkillRuntimeError(
            `run_artifact_skill failed with status ${response.status}: ${code}`,
          ),
        );
      }

      if (!isRecord(parsed) || parsed.ok !== true || !isRecord(parsed.result)) {
        throw new Error(
          redactArtifactSkillRuntimeError(
            "run_artifact_skill returned malformed envelope",
          ),
        );
      }

      const data = parsed.result.data;
      if (!isArtifactSkillRuntimeOutput(data)) {
        throw new Error(
          redactArtifactSkillRuntimeError(
            "run_artifact_skill returned malformed ArtifactSkillRuntimeOutput",
          ),
        );
      }

      return data;
    },
  };
}
