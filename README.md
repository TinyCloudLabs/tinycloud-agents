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

## Quick start

The plugin makes a user-owned TinyCloud space the system of record for an
elizaOS 2.0 agent's long-term memories and session summaries.

### 1. Install

```sh
bun add @tinycloud/eliza-plugin-memory @elizaos/plugin-sql @elizaos/core
```

(`@tinycloud/agent-client` — the shared client core — comes in transitively; you
do not install it directly.)

### 2. Configure the environment

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `TINYCLOUD_PRIVATE_KEY` | **yes** | — | Hex private key for the agent's **own** memory space. Use a **dedicated, low-value** key — *never* the operator's main wallet (decision D3). Key compromise = memory-space compromise only. |
| `TINYCLOUD_HOST` | no | `https://node.tinycloud.xyz` | TinyCloud node endpoint. **Self-host for sensitive deployments** (content is plaintext-at-rest today — see Caveats). |
| `TINYCLOUD_DB_HANDLE` | no | `xyz.tinycloud.eliza/memory` | Full-path SQL db handle. |
| `TINYCLOUD_SPACE_PREFIX` | no | — | node-sdk space `prefix`. |

### 3. Wire the character — TWO mandatory steps

Both are required; miss either and advanced-memory storage does not run on
TinyCloud (see `packages/eliza-plugin-memory/README.md` for the full rationale).

```jsonc
{
  "advancedMemory": true,            // (§2.1) gates the whole advanced-memory feature
  "plugins": [
    "@tinycloud/eliza-plugin-memory", // (§2.2) MUST be listed BEFORE plugin-sql to win the slot
    "@elizaos/plugin-sql"
  ]
}
```

- **Ordering is the contract.** plugin-sql registers its *own* `memoryStorage`
  service unconditionally; elizaOS resolves a duplicated slot to the
  **first-registered** instance. List ours **before** `@elizaos/plugin-sql` or
  plugin-sql wins and your memories stay in the local SQL database.
- **`advancedMemory: true`** gates `MemoryService` + the two evaluators + the two
  providers. Without it the slot is never consulted, however it is ordered.

## Hydration & portability

Same key ⇒ same space ⇒ memory on the first turn, with no export/import step. A
fresh install pointed at the same `TINYCLOUD_PRIVATE_KEY` resolves the same space
and serves the agent's accumulated memory on its very first message.

Full walkthrough — including the roomId-stability caveat for session summaries
(long-term memories hydrate fully; old summaries may orphan harmlessly) — in
[docs/hydration.md](docs/hydration.md).

## Live scenario testing

The deterministic test suite is offline. To test the real product path against a
TinyCloud node, run the opt-in live Eliza scenario suite:

```sh
bun --bun run test:live:eliza
TINYCLOUD_LIVE=1 bun --bun run test:live:eliza
```

Without `TINYCLOUD_LIVE=1`, the command prints a skipped JSON result and exits
successfully. With `TINYCLOUD_LIVE=1`, it uses `TINYCLOUD_PRIVATE_KEY` if set;
otherwise it generates and saves a throwaway key in the ignored file
`packages/eliza-plugin-memory/.agents-audit/eliza-live-key.env`.

The suite boots a real Eliza `AgentRuntime` with `advancedMemory: true`, registers
`@tinycloud/eliza-plugin-memory` before `@elizaos/plugin-sql`, writes long-term
memory and a session summary through Eliza's `MemoryService`, reads the same rows
from a separate TinyCloud client workflow, then boots a fresh runtime with the
same key and verifies hydration.

This tests the current MVP auth shape: an agent-owned dedicated key. It does not
test OpenKey/passkey login or user-to-agent delegation.

## Multi-tenancy

- **One space per agent** (default; plan §6). The space is derived from the agent's
  `TINYCLOUD_PRIVATE_KEY`. Every query filters on `agent_id`, `entity_id`, and
  (for summaries) `room_id`, so per-person and per-agent isolation is enforced at
  the query level.
- **Shared space** (one key, multiple characters) is **supported for
  single-operator setups, discouraged otherwise**. Queries stay correct, but one
  key = one trust domain (every agent process can read every agent's memories with
  raw SQL), cross-process writers re-expose the node's concurrency limits, and
  delegation churn multiplies.
- **Never share a space across a trust boundary.** There is no row-level isolation
  between mutually distrusting parties.

## Honest caveats

Stated plainly (plan §10; sign-offs recorded 2026-06-12). These are deliberate MVP
trade-offs, not oversights.

- **Plaintext-at-rest on the node today.** TinyCloud content is operator-readable;
  E2EE is roadmap. Because this plugin *owns* the slot, the TinyCloud space is the
  **only** copy of long-term memory. For sensitive deployments, **self-host the
  node** or consciously accept operator readability.
- **Outage write-loss.** During a node outage, writes **throw and are lost** —
  there is no local shadow copy. Loss is bounded: facts re-extract from local
  message history over subsequent turns. If unacceptable, run the (phase-2) coexist
  tier instead of slot ownership.
- **Fail-open, not fail-over** (§2.2). If our service fails to start, elizaOS
  **disables** advanced-memory storage for the run — it does **not** fall back to
  plugin-sql's instance even though plugin-sql also started. The agent keeps
  running memory-less; turns are unaffected.
- **Divergences from plugin-sql** (§2.4). We match plugin-sql's *observable*
  semantics (sort orders, limits, not-found throws) but deliberately do **not**
  replicate its identity-group leniency on update/delete (we use strict
  `entity_id` equality) or its BFS entity anchoring (we trust core's normalization
  and store verbatim). Rows are not byte-interchangeable with plugin-sql's.
- **Beta churn.** The seam is elizaOS 2.0 **beta** API on a fast-moving repo. We
  pin `@elizaos/core@2.0.0-beta.1` + `@elizaos/plugin-sql@2.0.0-beta.1`; a CI seam
  check asserts our class stays assignable and checksums the seam types against
  fixtures, converting silent upstream breakage into loud CI failure (§8). Re-pin
  and re-verify at 2.0 GA.

## Docs

- [docs/hydration.md](docs/hydration.md) — hydration / portability walkthrough.
- [docs/registry-entry.md](docs/registry-entry.md) — staged draft of the elizaOS
  registry entry (the actual registry PR is a post-publish step).
- `packages/eliza-plugin-memory/README.md` — activation, configuration, and
  failure semantics in depth.

## Status

MVP built on `feature/mvp` (two-package Bun workspace per the layout above);
driven by a workflow from the plan doc. Private until MVP ships.
