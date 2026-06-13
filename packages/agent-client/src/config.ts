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
  /** Auth mode discriminant. Optional; defaults to `private-key`. */
  mode?: "private-key";
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

/**
 * Caller-supplied configuration for delegation mode.
 * Requires exactly one delegation source (serializedDelegation XOR delegationFile)
 * and exactly one stable agent key source (agentKey XOR agentKeyFile).
 * SECURITY: never pass secret values through error messages.
 */
export interface DelegationAgentClientConfig {
  /** Auth mode discriminant — required for delegation mode. */
  mode: "delegation";
  /** Inline serialized portable delegation. Provide either this or delegationFile, not both. */
  serializedDelegation?: string;
  /** Path to file containing serialized delegation. Provide either this or serializedDelegation, not both. */
  delegationFile?: string;
  /** Inline stable agent identity key material. Provide either this or agentKeyFile, not both. */
  agentKey?: string;
  /** Path to file containing stable agent identity key material. Provide either this or agentKey, not both. */
  agentKeyFile?: string;
  /** Node endpoint. SINGULAR `host`. Defaults to {@link DEFAULT_HOST}. */
  host?: string;
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

/** Auth config union — private-key mode or delegation mode. */
export type AgentClientAuthConfig = AgentClientConfig | DelegationAgentClientConfig;

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

/** {@link DelegationAgentClientConfig} with every optional knob filled in. */
export interface ResolvedDelegationConfig {
  mode: "delegation";
  /** Serialized portable delegation (set when serializedDelegation was provided). */
  serializedDelegation?: string;
  /** Delegation file path (set when delegationFile was provided). */
  delegationFile?: string;
  /** Inline agent identity key material (set when agentKey was provided). */
  agentKey?: string;
  /** Agent key file path (set when agentKeyFile was provided). */
  agentKeyFile?: string;
  host: string;
  dbHandle: string;
  requestTimeoutMs: number;
  writeQueueLimit: number;
  breakerThreshold: number;
  breakerOpenMs: number;
  reSignInMs: number;
  /**
   * Redacts agentKey and serializedDelegation so that accidental JSON.stringify
   * or logger serialization cannot leak secret key material. Property access
   * (resolved.agentKey) still returns the real value so the transport can consume it.
   */
  toJSON(): object;
}

/**
 * Validate and fill plan-§5 defaults for a delegation config.
 * Throws actionable errors on missing or conflicting inputs.
 * SECURITY: error messages never include the value of agentKey, serializedDelegation,
 * or any other secret material — only the field names.
 */
export function resolveDelegationConfig(
  config: DelegationAgentClientConfig,
): ResolvedDelegationConfig {
  const hasDelegation = !!config.serializedDelegation;
  const hasDelegationFile = !!config.delegationFile;
  if (!hasDelegation && !hasDelegationFile) {
    throw new Error(
      "DelegationAgentClientConfig requires a delegation source: provide serializedDelegation or delegationFile",
    );
  }
  if (hasDelegation && hasDelegationFile) {
    throw new Error(
      "DelegationAgentClientConfig: provide serializedDelegation or delegationFile, not both",
    );
  }

  const hasAgentKey = !!config.agentKey;
  const hasAgentKeyFile = !!config.agentKeyFile;
  if (!hasAgentKey && !hasAgentKeyFile) {
    throw new Error(
      "DelegationAgentClientConfig requires a stable agent key source: provide agentKey or agentKeyFile",
    );
  }
  if (hasAgentKey && hasAgentKeyFile) {
    throw new Error(
      "DelegationAgentClientConfig: provide agentKey or agentKeyFile, not both",
    );
  }

  return {
    mode: "delegation" as const,
    serializedDelegation: config.serializedDelegation,
    delegationFile: config.delegationFile,
    agentKey: config.agentKey,
    agentKeyFile: config.agentKeyFile,
    host: config.host ?? DEFAULT_HOST,
    dbHandle: config.dbHandle ?? DEFAULT_DB_HANDLE,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    writeQueueLimit: config.writeQueueLimit ?? DEFAULT_WRITE_QUEUE_LIMIT,
    breakerThreshold: config.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD,
    breakerOpenMs: config.breakerOpenMs ?? DEFAULT_BREAKER_OPEN_MS,
    reSignInMs: config.reSignInMs ?? DEFAULT_RE_SIGN_IN_MS,
    toJSON() {
      return {
        mode: this.mode,
        serializedDelegation: this.serializedDelegation !== undefined ? "[REDACTED]" : undefined,
        delegationFile: this.delegationFile,
        agentKey: this.agentKey !== undefined ? "[REDACTED]" : undefined,
        agentKeyFile: this.agentKeyFile,
        host: this.host,
        dbHandle: this.dbHandle,
        requestTimeoutMs: this.requestTimeoutMs,
        writeQueueLimit: this.writeQueueLimit,
        breakerThreshold: this.breakerThreshold,
        breakerOpenMs: this.breakerOpenMs,
        reSignInMs: this.reSignInMs,
      };
    },
  };
}
