// SQL surface for the agent-client core (plan §3 "SQL helpers" + §5 table footers).
//
// query / execute / batch route through the Session (which routes through the ONE
// serialized worker): reads take the read lane (queue-jump priority), writes take
// the write lane (bounded queue). Each helper UNWRAPS the transport Result
// discriminant into data-or-typed-SqlError so callers never branch on `ok`.
//
// withRowObjects<T> maps node-sdk POSITIONAL rows + columns into keyed objects —
// the node returns `{ columns, rows: unknown[][] }` (plan §2.5), and most callers
// want `{ id, content, ... }` not `row[columns.indexOf("id")]`.
//
// SECURITY (plan §5): SqlError carries the op kind + a SHORT sql label (leading
// keyword only) — never the full statement, params, or any Authorization header.
//
// HARD CONTRACT: zero host-framework (Eliza) imports — see ./index.ts.

import { SqlError } from "./errors";
import type { Session } from "./session";
import type {
  BatchData,
  ExecuteData,
  QueryData,
  SqlStatement,
  SqlValue,
  Transport,
  TransportResult,
} from "./transport";

/** The public SQL surface composed onto the client (plan §3 client shape). */
export interface SqlApi {
  /** Run a SQL read (read lane). Resolves the {@link QueryData} or throws {@link SqlError}. */
  query(sql: string, params?: SqlValue[]): Promise<QueryData>;
  /** Run a single SQL write/DDL (write lane). Resolves {@link ExecuteData} or throws {@link SqlError}. */
  execute(sql: string, params?: SqlValue[]): Promise<ExecuteData>;
  /** Run multiple statements as one node round-trip (write lane). */
  batch(statements: SqlStatement[]): Promise<BatchData>;
  /** Map positional rows + columns from a {@link QueryData} into keyed objects. */
  withRowObjects<T = Record<string, unknown>>(data: QueryData): T[];
}

/** A short, log-safe label for a statement: its leading keyword (e.g. "SELECT"), never the body. */
function sqlLabel(sql?: string): string | undefined {
  if (!sql) return undefined;
  const first = sql.trimStart().split(/\s+/, 1)[0];
  return first ? first.toUpperCase() : undefined;
}

/** Unwrap a transport Result into its data, or throw a typed {@link SqlError}. */
function unwrap<T>(result: TransportResult<T>, op: string, sql?: string): T {
  if (result.ok) return result.data;
  throw new SqlError(result.error.message, {
    op,
    code: result.error.code,
    sql: sqlLabel(sql),
  });
}

/**
 * Map node-sdk positional rows into keyed objects. Standalone (and re-exported on
 * {@link SqlApi}) so callers can map a {@link QueryData} they already hold.
 */
export function withRowObjects<T = Record<string, unknown>>(data: QueryData): T[] {
  const { columns, rows } = data;
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i += 1) {
      obj[columns[i]] = row[i];
    }
    return obj as T;
  });
}

/**
 * Build the SQL surface over a {@link Session} and {@link Transport}. The session
 * supplies lazy-signIn + auth-retry + serialization; the transport is the raw seam.
 */
export function createSql(session: Session, transport: Transport): SqlApi {
  async function query(sql: string, params?: SqlValue[]): Promise<QueryData> {
    const result = await session.run("read", () => transport.query(sql, params), "query");
    return unwrap(result, "query", sql);
  }

  async function execute(sql: string, params?: SqlValue[]): Promise<ExecuteData> {
    const result = await session.run("write", () => transport.execute(sql, params), "execute");
    return unwrap(result, "execute", sql);
  }

  async function batch(statements: SqlStatement[]): Promise<BatchData> {
    const result = await session.run("write", () => transport.batch(statements), "batch");
    return unwrap(result, "batch", statements[0]?.sql);
  }

  return { query, execute, batch, withRowObjects };
}
