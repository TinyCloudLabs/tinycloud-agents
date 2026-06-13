// §4 schema — the per-space SQLite DDL for the TinyCloud memory store.
//
// VERBATIM from plan §4: two CREATE TABLE IF NOT EXISTS statements, TEXT ISO8601
// timestamps, JSON columns as TEXT, nullable embedding, and **NO INDEXES**
// (CREATE INDEX is DENIED on prod v1.4.2 — "400 SQLite error: not authorized",
// plan §2.5/§4; full scans are fine at these table sizes). The DDL mirrors the
// host types (LongTermMemory / SessionSummary) field-for-field so hydration and
// the v2 hybrid index round-trip losslessly (plan §7).
//
// These statements are handed to the agent-client's memoized ensureSchema, which
// runs them once per client and refuses anything that is not a CREATE TABLE.

/** Full-path SQL db handle for the agent's memory space (plan §3/§4). */
export const MEMORY_DB_HANDLE = "xyz.tinycloud.eliza/memory";

/** `long_term_memories` — "what I know about you" (plan §4). */
export const LONG_TERM_MEMORIES_DDL = `CREATE TABLE IF NOT EXISTS long_term_memories (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  category         TEXT NOT NULL,
  content          TEXT NOT NULL,
  metadata         TEXT,
  embedding        TEXT,
  confidence       REAL,
  source           TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_accessed_at TEXT,
  access_count     INTEGER NOT NULL DEFAULT 0
)`;

/** `session_summaries` — rolling per-room conversation summaries (plan §4). */
export const SESSION_SUMMARIES_DDL = `CREATE TABLE IF NOT EXISTS session_summaries (
  id                  TEXT PRIMARY KEY,
  agent_id            TEXT NOT NULL,
  room_id             TEXT NOT NULL,
  entity_id           TEXT,
  summary             TEXT NOT NULL,
  message_count       INTEGER NOT NULL,
  last_message_offset INTEGER NOT NULL,
  start_time          TEXT NOT NULL,
  end_time            TEXT NOT NULL,
  topics              TEXT,
  metadata            TEXT,
  embedding           TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
)`;

/** The full schema, in the order ensureSchema applies it (plan §4). */
export const MEMORY_SCHEMA: readonly string[] = [
  LONG_TERM_MEMORIES_DDL,
  SESSION_SUMMARIES_DDL,
];
