// ---------------------------------------------------------------------------
// Delegation policy constants.
//
// The space and path (dbHandle) are chosen by the service and come back on each
// AgentView — the client never derives them (see api.ts Agent + delegate.ts).
// Only the SQL action set is fixed client-side.
// ---------------------------------------------------------------------------

// Option D multi-resource delegation grant (docs/agents-api.md "Mint shape").
// One delegation covers three services in the agent's space:
//   - tinycloud.kv  PREFIX on pathPrefix (KV is hierarchical → "operate broadly")
//   - tinycloud.sql EXACT on dbHandle    (SQL is exact db-name at the node)
//   - tinycloud.capabilities read        (optional, as before)
// Full-URN form; the web-sdk passes already-expanded URNs through unchanged.
export const KV_ACTIONS = [
  "tinycloud.kv/get",
  "tinycloud.kv/put",
  "tinycloud.kv/list",
  "tinycloud.kv/delete",
];

export const SQL_ACTIONS = [
  "tinycloud.sql/read",
  "tinycloud.sql/write",
  "tinycloud.sql/admin",
];

export const CAPABILITIES_ACTIONS = ["tinycloud.capabilities/read"];
