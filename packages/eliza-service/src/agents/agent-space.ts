// Per-agent memory-space scheme (M2.1).
//
// Each agent's memory lives in the owner's "agents" TinyCloud space, under a
// per-agent path prefix, so multiple agents owned by the same user do not collide:
//
//   space      = AGENTS_SPACE ("agents")
//   pathPrefix = "default/"           for the owner's default (index 0) agent
//              = "<slug(name)>/"       for every other agent
//   dbHandle   = `${pathPrefix}memory` (e.g. "default/memory", "research-bot/memory")
//
// The delegation is minted client-side with tcw.space(space).delegations.create({
// path: dbHandle, ... }); the server validates against the SAME dbHandle and boots
// the agent runtime with TINYCLOUD_DB_HANDLE = dbHandle so writes land where the
// grant allows. Everything is parameterized off these constants — no hardcoded
// "default"/"memory" literals elsewhere.

/** The TinyCloud space (under the owner) that holds all of an owner's agents' memory. */
export const AGENTS_SPACE = "agents";

/** Path prefix for the owner's default (index 0) agent. */
export const DEFAULT_AGENT_PATH_PREFIX = "default/";

/** Trailing path segment naming the memory database within an agent's prefix. */
export const MEMORY_PATH_SEGMENT = "memory";

/**
 * Slugify an agent name into a path-safe prefix segment: lowercase, non-alnum runs
 * collapsed to "-", trimmed. Falls back to "agent" when the result is empty so a
 * name of only punctuation still yields a usable prefix.
 */
export function slugifyAgentName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "agent";
}

/**
 * Compute the path prefix for an agent. index 0 (the owner's default agent) uses
 * DEFAULT_AGENT_PATH_PREFIX; all others use the slugified name.
 */
export function pathPrefixFor(index: number, name: string): string {
  if (index === 0) return DEFAULT_AGENT_PATH_PREFIX;
  return `${slugifyAgentName(name)}/`;
}

/** The SQL db handle (delegation `path`) for a given path prefix. */
export function dbHandleFor(pathPrefix: string): string {
  return `${pathPrefix}${MEMORY_PATH_SEGMENT}`;
}
