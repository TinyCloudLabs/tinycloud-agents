// Configuration for the agent-client core.
//
// HARD CONTRACT: zero host-framework (Eliza) imports — see ./index.ts.
// All knob defaults come from plan §5 (resilience + security posture).

/** Default TinyCloud node endpoint. `host` is SINGULAR (node-sdk gotcha, plan §2.5). */
export const DEFAULT_HOST = "https://node.tinycloud.xyz";

/**
 * Default SQL db handle — the FULL path (known gotcha, plan §3/§4): the handle
 * is `xyz.tinycloud.<app>/<db>`, not a bare db name.
 */
export const DEFAULT_DB_HANDLE = "xyz.tinycloud.eliza/memory";

/** Hard socket-timeout per node call (plan §5 invariant 4). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Bounded write-queue depth; past this, writes reject fast (plan §5 invariant 2). */
export const DEFAULT_WRITE_QUEUE_LIMIT = 50;

/** Consecutive failures before the circuit breaker opens (plan §5 invariant 4). */
export const DEFAULT_BREAKER_THRESHOLD = 5;

/** How long the breaker stays open once tripped (plan §5 invariant 4). */
export const DEFAULT_BREAKER_OPEN_MS = 120_000;

/** Proactive re-signIn cadence — sessions last ~1h, refresh at ~50min (plan §3 lifecycle). */
export const DEFAULT_RE_SIGN_IN_MS = 50 * 60_000;

/**
 * Caller-supplied configuration. Only `privateKey` is required; everything else
 * has a plan-dictated default (see {@link resolveConfig}).
 */
export interface AgentClientConfig {
  /** Hex-encoded private key (with or without 0x). The agent owns its memory space. */
  privateKey: string;
  /** Node endpoint. SINGULAR `host`. Defaults to {@link DEFAULT_HOST}. */
  host?: string;
  /** Space prefix for this agent's space (node-sdk `prefix`). Optional. */
  prefix?: string;
  /** Full-path SQL db handle. Defaults to {@link DEFAULT_DB_HANDLE}. */
  dbHandle?: string;
  /** Hard per-call socket timeout (ms). Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /** Bounded write-queue depth. Defaults to {@link DEFAULT_WRITE_QUEUE_LIMIT}. */
  writeQueueLimit?: number;
  /** Consecutive failures before the breaker opens. Defaults to {@link DEFAULT_BREAKER_THRESHOLD}. */
  breakerThreshold?: number;
  /** Breaker open duration (ms). Defaults to {@link DEFAULT_BREAKER_OPEN_MS}. */
  breakerOpenMs?: number;
  /** Proactive re-signIn interval (ms). Defaults to {@link DEFAULT_RE_SIGN_IN_MS}. */
  reSignInMs?: number;
}

/** {@link AgentClientConfig} with every optional knob filled in. */
export interface ResolvedAgentClientConfig {
  privateKey: string;
  host: string;
  prefix?: string;
  dbHandle: string;
  requestTimeoutMs: number;
  writeQueueLimit: number;
  breakerThreshold: number;
  breakerOpenMs: number;
  reSignInMs: number;
}

/**
 * Apply plan-§5 defaults to a caller config. Throws if `privateKey` is missing —
 * the agent-holds-key model has no other auth path.
 */
export function resolveConfig(config: AgentClientConfig): ResolvedAgentClientConfig {
  if (!config.privateKey) {
    throw new Error("AgentClientConfig.privateKey is required");
  }
  return {
    privateKey: config.privateKey,
    host: config.host ?? DEFAULT_HOST,
    prefix: config.prefix,
    dbHandle: config.dbHandle ?? DEFAULT_DB_HANDLE,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    writeQueueLimit: config.writeQueueLimit ?? DEFAULT_WRITE_QUEUE_LIMIT,
    breakerThreshold: config.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD,
    breakerOpenMs: config.breakerOpenMs ?? DEFAULT_BREAKER_OPEN_MS,
    reSignInMs: config.reSignInMs ?? DEFAULT_RE_SIGN_IN_MS,
  };
}
