// ---------------------------------------------------------------------------
// Single source of truth for the space/path delegation scheme.
//
// Design change (Sam, 2026-07-01): agents no longer delegate from the user's
// "default" space at `xyz.tinycloud.eliza/memory`. Each user gets a canonical
// space named "agents"; the default agent's memory lives under the "default/"
// prefix inside it. Signing in conceptually = signing in to your default agent.
//
// The exact prefix scheme is still being finalized upstream — keep these values
// here (not inline in delegate.ts) so the final scheme is a one-file change.
// ---------------------------------------------------------------------------

// The canonical per-user space that holds all agent memory.
export const AGENTS_SPACE = "agents";

// Path prefix for the default agent's memory inside the "agents" space.
// Provisional pending the finalized scheme.
export const DEFAULT_AGENT_PREFIX = "default/";

// Build the delegation path (db handle) for a given agent prefix.
export function memoryPath(prefix: string = DEFAULT_AGENT_PREFIX): string {
  return `${prefix}memory`;
}

// SQL policy the Eliza memory agent requires.
export const SQL_ACTIONS = [
  "tinycloud.sql/read",
  "tinycloud.sql/write",
  "tinycloud.sql/admin",
  "tinycloud.capabilities/read",
];
