// @tinycloud/agent-client — shared, host-framework-agnostic client core.
// Wraps @tinycloud/node-sdk: session lifecycle, one serialized request worker,
// bounded write queue, circuit breaker, hard timeouts, SQL helpers.
//
// HARD CONTRACT: this package has ZERO host-framework imports (a future
// OpenClaw plugin consumes it too — plan §3). Eliza types live only in
// @tinycloud/eliza-plugin-memory.
//
// T2 surface: config + errors + logger + the Transport seam + the real node-sdk
// transport. T3 adds the serialized worker (queue/breaker/timeouts). T4 adds the
// session lifecycle, the SQL surface, memoized ensureSchema, and createAgentClient
// — the public composition root the host plugins consume.

export const AGENT_CLIENT_VERSION = "0.1.0";

export {
  DEFAULT_HOST,
  DEFAULT_DB_HANDLE,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_WRITE_QUEUE_LIMIT,
  DEFAULT_BREAKER_THRESHOLD,
  DEFAULT_BREAKER_OPEN_MS,
  DEFAULT_RE_SIGN_IN_MS,
  resolveConfig,
  resolveDelegationConfig,
} from "./config";
export type {
  AgentClientConfig,
  AgentClientAuthConfig,
  DelegationAgentClientConfig,
  ResolvedAgentClientConfig,
  ResolvedDelegationConfig,
} from "./config";

export {
  TinyCloudClientError,
  TimeoutError,
  QueueFullError,
  CircuitOpenError,
  AuthError,
  SqlError,
  DelegationPolicyError,
} from "./errors";

export { consoleLogger, silentLogger } from "./logger";
export type { Logger } from "./logger";

export type {
  Transport,
  TransportResult,
  TransportError,
  QueryData,
  ExecuteData,
  BatchData,
  SignInResult,
  SqlValue,
  SqlStatement,
} from "./transport";

export { NodeSdkTransport } from "./node-sdk-transport";
export { DelegatedTransport } from "./delegated-transport";
export type { DelegatedSqlAccess, DelegatedTransportDeps, DelegatedActivateFn } from "./delegated-transport";
export { validateDelegationShape, DelegationShapeError } from "./delegation-validate";

export { Worker, realClock } from "./worker";
export type {
  Clock,
  TimerHandle,
  Lane,
  BreakerState,
  Job,
  WorkerOptions,
} from "./worker";

export { Session, STOP_FLUSH_MS } from "./session";
export type { SessionOptions } from "./session";

export { createSql, withRowObjects } from "./sql";
export type { SqlApi } from "./sql";

export { createEnsureSchema } from "./schema";
export type { EnsureSchema } from "./schema";

export { createAgentClient } from "./client";
export type { AgentClient, AgentClientDeps } from "./client";

export {
  RUN_ARTIFACT_SKILL,
  assertArtifactSkillRuntimeInput,
  createStubArtifactSkillRuntime,
  redactArtifactSkillRuntimeError,
} from "./artifact-skill-runtime";
export type {
  ArtifactSkillRuntime,
  ArtifactSkillRuntimeInput,
  ArtifactSkillRuntimeOutput,
  ArtifactSkillRuntimePolicy,
  ArtifactSkillRuntimeTool,
} from "./artifact-skill-runtime";

export { normalizeAgentKey, agentIdentityFromKey, agentIdentityFromFile } from "./agent-identity";
export type { AgentIdentity } from "./agent-identity";

export { defaultElizaMemoryPolicy, deserializeDelegationSafe, assertWellFormed, validateDelegationPolicy, computePolicyHash, evaluateDelegationStatus } from "./delegation-policy";
export type { DelegationPolicy, PolicyResource } from "./delegation-policy";

export { deserializeAndNormalize, normalizeDelegationGrants } from "./delegation-normalize";

export { serializeDelegation, deserializeDelegation } from "@tinycloud/node-sdk";
export type { PortableDelegation } from "@tinycloud/node-sdk";
