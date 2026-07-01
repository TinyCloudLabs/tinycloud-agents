// Typed error hierarchy for the agent-client core.
//
// SECURITY (plan §5): errors carry SQL-op context for debugging, but NEVER the
// Authorization header, UCAN invocation, or full request dump. Keep it that way.

/** Base class for every error this client raises. */
export class TinyCloudClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    // Preserve prototype chain across the ES5 transpile target.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A node call exceeded the hard socket timeout (plan §5 invariant 4). */
export class TimeoutError extends TinyCloudClientError {
  constructor(
    public readonly timeoutMs: number,
    /** Short op label, e.g. "query" | "execute" | "signIn" — never the request body. */
    public readonly op?: string,
  ) {
    super(`TinyCloud ${op ?? "request"} timed out after ${timeoutMs}ms`);
  }
}

/** The bounded write queue is full; the write is rejected fast (plan §5 invariant 2). */
export class QueueFullError extends TinyCloudClientError {
  constructor(public readonly limit: number) {
    super(`Write queue is full (limit ${limit}); rejecting write`);
  }
}

/** The circuit breaker is open; the call fails fast without touching the node (plan §5 invariant 4). */
export class CircuitOpenError extends TinyCloudClientError {
  constructor(public readonly openUntil?: number) {
    super("Circuit breaker is open; node calls are failing fast");
  }
}

/** signIn failed or the session could not be (re)established. */
export class AuthError extends TinyCloudClientError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Delegation policy validation failed. The `reason` code identifies the
 * first failing check in the reject-matrix (malformed -> delegatee -> expired
 * -> resource presence -> db handle -> actions).
 *
 * SECURITY: messages and context MUST NEVER include delegationHeader /
 * Authorization / authHeader / agentKey or the serialized blob.
 * DIDs, paths, service names, action URNs, and timestamps are non-secret.
 */
export class DelegationPolicyError extends TinyCloudClientError {
  constructor(
    message: string,
    public readonly reason:
      | "MALFORMED"
      | "WRONG_DELEGATEE"
      | "EXPIRED"
      | "MISSING_SQL_RESOURCE"
      | "WRONG_DB_HANDLE"
      | "WRONG_SPACE"
      | "INSUFFICIENT_ACTIONS",
    public readonly context?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * A SQL query/execute/batch returned an error Result (or threw). Carries enough
 * op context to debug — code, the op kind, and a redacted/short SQL label — but
 * never the Authorization header or full request dump (plan §5 security posture).
 */
export class SqlError extends TinyCloudClientError {
  constructor(
    message: string,
    public readonly context: {
      /** "query" | "execute" | "batch" */
      op: string;
      /** Service error code from the node Result, if any. */
      code?: string;
      /** A short SQL label (e.g. the statement's leading keyword), not the full text + params. */
      sql?: string;
    },
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
