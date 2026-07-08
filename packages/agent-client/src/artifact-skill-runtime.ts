export const RUN_ARTIFACT_SKILL = "RUN_ARTIFACT_SKILL" as const;

export type ArtifactSkillRuntimeTool = typeof RUN_ARTIFACT_SKILL;

export type ArtifactSkillRuntimePolicy = {
  runtimeClass: "feed_hosted" | "hosted_private" | "local" | "stub";
  providerClass: "first_party" | "user_byok" | "local" | "none";
  credentialMode: "feed_hosted" | "user_byok_api_key" | "user_oauth_token" | "none";
  egressClass: "none" | "model_provider" | "media_provider" | "tool_provider";
  allowedTools: string[];
  disallowedTools: string[];
  maxModelCalls: number;
  timeoutMs: number;
  maxOutputBytes: number;
  budgetId?: string;
};

export type ArtifactSkillRuntimeInput = {
  runId: string;
  skillManifest: unknown;
  sourcePack: {
    refs: unknown[];
    excerpts: { sourceRefId: string; text: string; quoteLineRefs?: string[] }[];
    maxInputTokens: number;
  };
  artifactPack?: unknown;
  settings: unknown;
  runtimePolicy: ArtifactSkillRuntimePolicy;
  secretEnv?: {
    name: string;
    secretRef?: string;
    injection: "env";
    stageId: string;
    source: "worker_injected";
  }[];
  priorContext?: unknown;
};

export type ArtifactSkillRuntimeOutput = {
  candidates: unknown[];
  trace: {
    procedureVersion: string;
    modelCalls: number;
    toolCalls: { name: string; purpose: string }[];
    stageTrace: {
      stageId: string;
      declaredCapabilities: string[];
      grantedCapabilities: string[];
      authorityUsed: boolean;
      deniedReasons: string[];
    }[];
    droppedCandidates: { reason: string; title?: string; localCandidateId?: string }[];
  };
};

export type ArtifactSkillRuntime = {
  tool: ArtifactSkillRuntimeTool;
  run(input: ArtifactSkillRuntimeInput): Promise<ArtifactSkillRuntimeOutput>;
};

export function assertArtifactSkillRuntimeInput(input: ArtifactSkillRuntimeInput): void {
  if (!input.runId.trim()) throw new Error("runId is required");
  if (!Array.isArray(input.sourcePack.refs)) throw new Error("sourcePack.refs must be an array");
  if (!Array.isArray(input.sourcePack.excerpts)) throw new Error("sourcePack.excerpts must be an array");
  if (input.runtimePolicy.allowedTools.includes("tinycloud")) {
    throw new Error("runtime policy must not grant ambient tinycloud authority");
  }
  if (!input.runtimePolicy.disallowedTools.includes("tinycloud")) {
    throw new Error("runtime policy must explicitly disallow ambient tinycloud authority");
  }
  for (const secret of input.secretEnv ?? []) {
    if (secret.source !== "worker_injected" || secret.injection !== "env") {
      throw new Error("runtime secrets must be worker-injected env material only");
    }
    if (typeof secret.secretRef !== "string" || !secret.secretRef.trim()) {
      throw new Error("runtime secrets must include exact secret refs");
    }
  }
}

const SECRET_PATH_PATTERN = /(?:vault\/)?secrets\/[A-Za-z0-9._/-]+/gi;
const KEY_VALUE_PATTERN = /\b[A-Za-z0-9_]*(?:api[_-]?key|secret|token|password)=[^\s&]+/gi;
const SECRET_NAME_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?:_API_KEY|_API_TOKEN|_TOKEN|_SECRET|_PASSWORD|_KEY)\b/g;

export function redactArtifactSkillRuntimeText(text: string, sensitiveValues: readonly string[] = []): string {
  let redacted = text;
  for (const value of sensitiveValues) {
    if (!value) continue;
    redacted = redacted.replace(new RegExp(`\\b${escapeRegExp(value)}=([^\\s&]+)`, "g"), "[REDACTED]");
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted
    .replace(SECRET_PATH_PATTERN, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(KEY_VALUE_PATTERN, "[REDACTED]")
    .replace(SECRET_NAME_PATTERN, "[REDACTED]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactArtifactSkillRuntimeOutput<T>(value: T, sensitiveValues: readonly string[] = []): T {
  if (typeof value === "string") {
    return redactArtifactSkillRuntimeText(value, sensitiveValues) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactArtifactSkillRuntimeOutput(entry, sensitiveValues)) as T;
  }
  if (!value || typeof value !== "object") return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = redactArtifactSkillRuntimeOutput(entry, sensitiveValues);
  }
  return redacted as T;
}

export function createStubArtifactSkillRuntime(): ArtifactSkillRuntime {
  return {
    tool: RUN_ARTIFACT_SKILL,
    async run(input) {
      assertArtifactSkillRuntimeInput(input);
      return {
        candidates: [],
        trace: {
          procedureVersion: "stub.v1",
          modelCalls: 0,
          toolCalls: [],
          stageTrace: [
            {
              stageId: "stub",
              declaredCapabilities: [],
              grantedCapabilities: [],
              authorityUsed: false,
              deniedReasons: [],
            },
          ],
          droppedCandidates: [],
        },
      };
    },
  };
}

export function redactArtifactSkillRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactArtifactSkillRuntimeText(message, []);
}
