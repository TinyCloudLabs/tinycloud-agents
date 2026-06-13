// @tinycloud/agent-client — shared, host-framework-agnostic client core.
// Wraps @tinycloud/node-sdk: session lifecycle, one serialized request worker,
// bounded write queue, circuit breaker, hard timeouts, SQL helpers.
//
// HARD CONTRACT: this package has ZERO host-framework imports (a future
// OpenClaw plugin consumes it too — plan §3). Eliza types live only in
// @tinycloud/eliza-plugin-memory.
//
// T2 surface: config + errors + logger + the Transport seam + the real node-sdk
// transport. T3 adds the serialized worker (queue/breaker/timeouts). Session +
// SQL helpers land in T4.

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
} from "./config";
export type { AgentClientConfig, ResolvedAgentClientConfig } from "./config";

export {
  TinyCloudClientError,
  TimeoutError,
  QueueFullError,
  CircuitOpenError,
  AuthError,
  SqlError,
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

export { Worker, realClock } from "./worker";
export type {
  Clock,
  TimerHandle,
  Lane,
  BreakerState,
  Job,
  WorkerOptions,
} from "./worker";
