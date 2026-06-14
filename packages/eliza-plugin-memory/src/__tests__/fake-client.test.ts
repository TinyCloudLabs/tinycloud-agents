// Shared test double: an in-memory @tinycloud/agent-client backed by bun:sqlite.
//
// The storage service issues ordinary parameterised SQLite (INSERT / SELECT …
// ORDER BY … LIMIT / UPDATE / DELETE with `?` placeholders), so a real bun:sqlite
// `:memory:` database gives us byte-accurate ORDER BY, LIMIT and rowcount (`changes`)
// semantics with ZERO network — exactly what the §2.4 parity suite needs. This is
// the "mocked agent-client (in-memory rows)" the task calls for.
//
// Kept as a *.test.ts (not a plain helper .ts) on purpose: the package tsconfig
// excludes **/*.test.ts from `tsc`, and `tsc` has no Bun ambient types — so a
// helper importing `bun:sqlite` MUST live in a test file or it would break the
// package typecheck/build. It carries a self-test so it is a real suite, not an
// empty file.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import {
  withRowObjects,
  type AgentClient,
  type SqlValue,
} from "@tinycloud/agent-client";

import { MEMORY_SCHEMA } from "../schema";

/** An {@link AgentClient} whose SQL surface runs against an in-memory SQLite db. */
export interface FakeClient extends AgentClient {
  /** The backing database — tests seed raw rows through it to control timestamps. */
  db: Database;
  /** signIn() call count (lifecycle assertions). */
  signInCalls(): number;
}

/** Build an in-memory client with both §4 tables already created. */
export function makeFakeClient(): FakeClient {
  const db = new Database(":memory:");
  for (const ddl of MEMORY_SCHEMA) db.run(ddl);
  let signIns = 0;

  return {
    db,
    signInCalls: () => signIns,
    signIn: async () => {
      signIns += 1;
      return { spaceId: "space:test", address: "0xtest", did: "did:key:ztest" };
    },
    // Schema is created up-front; ensureSchema is a memoised no-op here.
    ensureSchema: async () => {},
    stop: async () => {
      db.close();
    },
    sql: {
      query: async (sql: string, params: SqlValue[] = []) => {
        const stmt = db.query(sql);
        const rows = stmt.values(...(params as never[])) as unknown[][];
        return { columns: stmt.columnNames, rows, rowCount: rows.length };
      },
      execute: async (sql: string, params: SqlValue[] = []) => {
        const res = db.run(sql, ...(params as never[]));
        return { changes: res.changes, lastInsertRowId: Number(res.lastInsertRowid) };
      },
      batch: async (statements) => {
        const results = statements.map((s) => {
          const res = db.run(s.sql, ...((s.params ?? []) as never[]));
          return { changes: res.changes, lastInsertRowId: Number(res.lastInsertRowid) };
        });
        return { results };
      },
      withRowObjects,
    },
  };
}

/** Columns for a raw long_term_memories insert (matches the service's column list). */
const LTM_COLS =
  "id, agent_id, entity_id, category, content, metadata, embedding, " +
  "confidence, source, created_at, updated_at, last_accessed_at, access_count";

export interface RawLtm {
  id: string;
  agentId: string;
  entityId: string;
  category?: string;
  content?: string;
  metadata?: string | null; // raw TEXT — pass invalid JSON to exercise the parse path
  embedding?: string | null;
  confidence?: number | null;
  source?: string | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string | null;
  accessCount?: number;
}

/** Insert a long_term_memories row verbatim — tests control every timestamp/field. */
export function seedLtm(db: Database, r: RawLtm): void {
  db.run(
    `INSERT INTO long_term_memories (${LTM_COLS}) ` +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      r.id,
      r.agentId,
      r.entityId,
      r.category ?? "semantic",
      r.content ?? "content",
      r.metadata ?? null,
      r.embedding ?? null,
      r.confidence ?? null,
      r.source ?? null,
      r.createdAt,
      r.updatedAt,
      r.lastAccessedAt ?? null,
      r.accessCount ?? 0,
    ] as never[],
  );
}

const SUMMARY_COLS =
  "id, agent_id, room_id, entity_id, summary, message_count, last_message_offset, " +
  "start_time, end_time, topics, metadata, embedding, created_at, updated_at";

export interface RawSummary {
  id: string;
  agentId: string;
  roomId: string;
  entityId?: string | null;
  summary?: string;
  messageCount?: number;
  lastMessageOffset?: number;
  startTime?: string;
  endTime?: string;
  topics?: string | null;
  metadata?: string | null;
  embedding?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Insert a session_summaries row verbatim. */
export function seedSummary(db: Database, r: RawSummary): void {
  db.run(
    `INSERT INTO session_summaries (${SUMMARY_COLS}) ` +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      r.id,
      r.agentId,
      r.roomId,
      r.entityId ?? null,
      r.summary ?? "summary",
      r.messageCount ?? 0,
      r.lastMessageOffset ?? 0,
      r.startTime ?? "2024-01-01T00:00:00.000Z",
      r.endTime ?? "2024-01-01T00:10:00.000Z",
      r.topics ?? null,
      r.metadata ?? null,
      r.embedding ?? null,
      r.createdAt,
      r.updatedAt,
    ] as never[],
  );
}

// ── self-test: the double must behave like the real SQL surface ───────────────

test("fake client: execute reports changes and query returns positional rows", async () => {
  const client = makeFakeClient();
  const ins = await client.sql.execute(
    `INSERT INTO long_term_memories (${LTM_COLS}) ` +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "id-1",
      "agent-1",
      "entity-1",
      "semantic",
      "hi",
      null,
      null,
      0.9,
      null,
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:00:00.000Z",
      null,
      0,
    ],
  );
  expect(ins.changes).toBe(1);

  const data = await client.sql.query(
    "SELECT id, content FROM long_term_memories WHERE agent_id = ?",
    ["agent-1"],
  );
  expect(data.columns).toEqual(["id", "content"]);
  const rows = client.sql.withRowObjects(data);
  expect(rows[0]).toEqual({ id: "id-1", content: "hi" });

  // A WHERE that matches nothing reports 0 changes (the not-found seam).
  const miss = await client.sql.execute(
    "UPDATE long_term_memories SET content = ? WHERE id = ?",
    ["x", "nope"],
  );
  expect(miss.changes).toBe(0);
});
