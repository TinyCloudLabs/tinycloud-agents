// Memoized schema bootstrap for the agent-client core (plan §3 lifecycle + §4).
//
// ensureSchema(statements) runs the given CREATE TABLE IF NOT EXISTS statements
// exactly ONCE per client instance:
//   • MEMOIZED — after a successful run, later calls resolve immediately (no node I/O).
//   • DE-DUPED — concurrent callers share the single in-flight promise.
//   • RETRYABLE on failure — if the run throws, the memo is NOT set, so a later
//     call retries (the schema must eventually exist).
//
// CREATE TABLE ONLY. CREATE INDEX is DENIED on prod v1.4.2 ("400 SQLite error:
// not authorized", plan §2.5/§4) — we never emit it; ensureSchema rejects any
// non-CREATE-TABLE statement loudly rather than letting it 400 at runtime.
//
// Statements run serially through the write lane (the worker serializes node I/O
// anyway); ~2–3s per DDL is fine at start (plan §5 start row).
//
// HARD CONTRACT: zero host-framework (Eliza) imports — see ./index.ts.

import { consoleLogger, type Logger } from "./logger";
import type { SqlApi } from "./sql";

/** ensureSchema(statements): idempotent, memoized schema bootstrap. */
export type EnsureSchema = (statements: string[]) => Promise<void>;

/** Reject anything that is not a CREATE TABLE — CREATE INDEX is denied on prod (plan §2.5/§4). */
function assertCreateTableOnly(statement: string): void {
  const normalized = statement.trimStart().toUpperCase();
  if (!normalized.startsWith("CREATE TABLE")) {
    const leading = statement.trimStart().split(/\s+/, 2).join(" ").toUpperCase();
    throw new Error(
      "ensureSchema accepts CREATE TABLE statements only " +
        "(CREATE INDEX is denied on prod v1.4.2 — plan §2.5/§4); " +
        `refusing to emit: ${leading}`,
    );
  }
}

/**
 * Build a memoized {@link EnsureSchema} bound to a {@link SqlApi}. The returned
 * function is safe to call on every start; it does the DDL work at most once.
 */
export function createEnsureSchema(sql: SqlApi, logger: Logger = consoleLogger): EnsureSchema {
  let done = false;
  let inFlight: Promise<void> | null = null;

  return function ensureSchema(statements: string[]): Promise<void> {
    if (done) return Promise.resolve();
    if (inFlight) return inFlight;

    const run = (async (): Promise<void> => {
      for (const statement of statements) {
        assertCreateTableOnly(statement);
      }
      for (const statement of statements) {
        await sql.execute(statement);
      }
      done = true;
      logger.debug("agent-client: schema ensured", { tables: statements.length });
    })();

    // De-dupe concurrent callers on this promise; clear it on settle so a failure
    // (done still false) is retryable on the next call.
    inFlight = run;
    const clear = (): void => {
      inFlight = null;
    };
    run.then(clear, clear);
    return run;
  };
}
