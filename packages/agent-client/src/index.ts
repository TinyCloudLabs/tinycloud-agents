// @tinycloud/agent-client — shared, host-framework-agnostic client core.
// Wraps @tinycloud/node-sdk: session lifecycle, one serialized request worker,
// bounded write queue, circuit breaker, hard timeouts, SQL helpers.
//
// HARD CONTRACT: this package has ZERO host-framework imports (a future
// OpenClaw plugin consumes it too — plan §3). Eliza types live only in
// @tinycloud/eliza-plugin-memory.
//
// Placeholder export — real implementation lands in T2.
export const AGENT_CLIENT_VERSION = "0.1.0";
