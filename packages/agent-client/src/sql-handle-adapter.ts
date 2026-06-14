// Shared SQL adapter: IDatabaseHandle → Transport Result mapping.
//
// Both NodeSdkTransport and DelegatedTransport route their node results through
// this module so the query/execute/batch mapping is byte-identical between the
// two auth modes. NEVER put auth-specific logic here.
//
// HARD CONTRACT: zero host-framework (Eliza) imports — see ./index.ts.

import type { IDatabaseHandle } from "@tinycloud/node-sdk";
import type {
  BatchData,
  ExecuteData,
  QueryData,
  SqlStatement,
  SqlValue,
  TransportError,
  TransportResult,
} from "./transport";

/**
 * The node-sdk Result discriminant, structurally. We don't import the node-sdk's
 * Result/ServiceError (not re-exported from its entrypoint), so we describe
 * the success/error shapes we read locally.
 */
export type SdkResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; service?: string } };

/** Map a node-sdk ServiceError shape to a redacted {@link TransportError} (drops `cause`/`meta`). */
export function toTransportError(error: {
  code: string;
  message: string;
  service?: string;
}): TransportError {
  return { code: error.code, message: error.message, service: error.service };
}

/** Adapt a node-sdk Result to a Transport Result, mapping data on success. */
export function mapResult<T, U>(result: SdkResult<T>, mapData: (data: T) => U): TransportResult<U> {
  if (result.ok) return { ok: true, data: mapData(result.data) };
  return { ok: false, error: toTransportError(result.error) };
}

/** Run query() over an IDatabaseHandle and map to {@link QueryData}. */
export async function adapterQuery(
  handle: IDatabaseHandle,
  sql: string,
  params?: SqlValue[],
): Promise<TransportResult<QueryData>> {
  const result = await handle.query(sql, params);
  return mapResult(result, (data) => ({
    columns: data.columns,
    rows: data.rows as unknown[][],
    rowCount: data.rowCount,
  }));
}

/** Run execute() over an IDatabaseHandle and map to {@link ExecuteData}. */
export async function adapterExecute(
  handle: IDatabaseHandle,
  sql: string,
  params?: SqlValue[],
): Promise<TransportResult<ExecuteData>> {
  const result = await handle.execute(sql, params);
  return mapResult(result, (data) => ({
    changes: data.changes,
    lastInsertRowId: data.lastInsertRowId,
  }));
}

/** Run batch() over an IDatabaseHandle and map to {@link BatchData}. */
export async function adapterBatch(
  handle: IDatabaseHandle,
  statements: SqlStatement[],
): Promise<TransportResult<BatchData>> {
  const result = await handle.batch(statements);
  return mapResult(result, (data) => ({
    results: data.results.map((r) => ({
      changes: r.changes,
      lastInsertRowId: r.lastInsertRowId,
    })),
  }));
}
