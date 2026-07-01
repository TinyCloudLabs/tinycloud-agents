// ---------------------------------------------------------------------------
// Delegation policy constants.
//
// The space and path (dbHandle) are chosen by the service and come back on each
// AgentView — the client never derives them (see api.ts Agent + delegate.ts).
// Only the SQL action set is fixed client-side.
// ---------------------------------------------------------------------------

// SQL policy the Eliza memory agent requires.
export const SQL_ACTIONS = [
  "tinycloud.sql/read",
  "tinycloud.sql/write",
  "tinycloud.sql/admin",
  "tinycloud.capabilities/read",
];
