# tinycloud-agents

TinyCloud memory plugins for AI agent frameworks. A user-owned TinyCloud space
becomes the system of record for an agent's long-term memories and session
summaries — portable and durable across reinstalls (same key ⇒ the agent
remembers).

## Planned layout

Two-package Bun workspace (`packages/*`):

| Package | npm name | Role |
|---|---|---|
| `packages/agent-client` | `@tinycloud/agent-client` | **Shared client core.** Host-framework-agnostic wrapper around `@tinycloud/node-sdk` — session lifecycle, one serialized request worker, bounded write queue, circuit breaker, hard timeouts, SQL helpers, schema bootstrap. **Zero `@elizaos/*` imports** (a future OpenClaw plugin consumes it too). |
| `packages/eliza-plugin-memory` | `@tinycloud/eliza-plugin-memory` | **elizaOS 2.0 plugin** owning the `memoryStorage` service slot (8-method `MemoryStorageProvider`). |

## Authoritative design

The build plan is the authority:
`development/docs/specs/eliza-tinycloud-memory-provider.md` (TinyCloudLabs
development repo) — verified constraints, architecture `[DECISION]`s, schema,
per-method behavior mapping, work plan. Both pre-build gates passed 2026-06-12
(Bun spike vs prod; published `@elizaos/core@2.0.0-beta.1` seam diff).

## Status

Empty by design: implementation will be driven by a Smithers workflow from the
plan doc. Private until MVP ships.
