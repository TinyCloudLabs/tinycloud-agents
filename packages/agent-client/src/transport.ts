// The Transport seam: the SINGLE boundary all TinyCloud node I/O crosses.
//
// Everything above this line (worker, queue, breaker, SQL helpers — T3/T4) talks
// to the node ONLY through a Transport. T5 swaps in a mock implementation to test
// the resilience machinery without a live node. The real implementation over
// @tinycloud/node-sdk is ./node-sdk-transport.ts.
//
// Types here MIRROR the node-sdk Result/QueryResponse shapes (plan §2.5) but are
// defined locally so the seam stays small and trivially mockable. Rows are
// POSITIONAL arrays — index columns via `columns.indexOf(name)` (plan §2.5).
//
// HARD CONTRACT: zero host-framework (Eliza) imports — see ./index.ts.

/** Allowed SQL bind-parameter value (mirrors node-sdk `SqlValue`). */
export type SqlValue = null | number | string | Uint8Array;

/** A SQL statement plus its positional params (for batch). */
export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

/**
 * Structured error from a node Result. Mirrors the node-sdk `ServiceError` minus
 * anything sensitive — NEVER carries the Authorization header or request dump.
 */
export interface TransportError {
  /** Programmatic code, e.g. "SQL_ERROR", "AUTH_EXPIRED". */
  code: string;
  message: string;
  /** Producing service, e.g. "sql". */
  service?: string;
}

/** Result discriminant returned by every node call (mirrors node-sdk `Result<T>`). */
export type TransportResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: TransportError };

/** query() payload — rows are POSITIONAL; index via `columns.indexOf(name)`. */
export interface QueryData {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

/** execute() payload. */
export interface ExecuteData {
  changes: number;
  lastInsertRowId?: number;
}

/** batch() payload. */
export interface BatchData {
  results: ExecuteData[];
}

/** What signIn() resolves once the session is established. */
export interface SignInResult {
  spaceId: string;
  address: string;
  did: string;
}

/**
 * The seam. A Transport is the only thing that touches the network. It performs
 * NO serialization, queueing, retry, or timeout itself — those live in the layer
 * above (T3/T4) so they can be tested against a mock Transport.
 */
export interface Transport {
  /** Establish (or re-establish) the session; creates the space on first run. */
  signIn(): Promise<SignInResult>;
  /** Run a SQL read. */
  query(sql: string, params?: SqlValue[]): Promise<TransportResult<QueryData>>;
  /** Run a single SQL write/DDL. */
  execute(sql: string, params?: SqlValue[]): Promise<TransportResult<ExecuteData>>;
  /** Run multiple statements as one node round-trip. */
  batch(statements: SqlStatement[]): Promise<TransportResult<BatchData>>;
}
