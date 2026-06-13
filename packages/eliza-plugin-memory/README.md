# @tinycloud/eliza-plugin-memory

An elizaOS 2.0 plugin that **owns the advanced-memory `memoryStorage` service
slot**, making a user-owned [TinyCloud](https://tinycloud.xyz) space the system of
record for an agent's long-term memories ("what I know about you") and session
summaries. Core's own `MemoryService`, providers, and extraction evaluators run
unmodified against TinyCloud storage — this plugin writes no injection/extraction
logic.

Payoff: memory becomes **portable and durable**. A fresh install with the same key
⇒ the agent remembers.

## Activation — TWO required steps

Both are mandatory. Miss either and advanced-memory storage does not run on
TinyCloud.

### 1. List this plugin BEFORE `@elizaos/plugin-sql` in `character.plugins`

Order is the contract. plugin-sql registers its **own** `memoryStorage` service
unconditionally, and elizaOS resolves a duplicated service slot to the
**first-registered** instance (`getService` returns `instances[0]`). So whichever
plugin appears first in `character.plugins` wins the slot:

```jsonc
{
  "plugins": [
    "@tinycloud/eliza-plugin-memory", // MUST come first to win the slot
    "@elizaos/plugin-sql"
  ]
}
```

If you list it **after** `@elizaos/plugin-sql`, plugin-sql wins and your memories
stay in the local SQL database — TinyCloud is never used.

### 2. Set `character.advancedMemory: true`

```jsonc
{
  "advancedMemory": true
}
```

This flag gates the entire advanced-memory feature (`MemoryService` + the two
evaluators + the two providers). Without it, the `memoryStorage` slot is never
consulted, so this plugin — however it is ordered — does nothing.

## Failure semantics — fail-open, NOT fail-over

If this plugin's service **fails to start** (e.g. the TinyCloud node is
unreachable at boot), elizaOS does **not** fall back to plugin-sql's instance even
though plugin-sql also started. The waiting `MemoryService` sees the slot reject,
logs a warning, and **disables advanced-memory storage entirely** for the run.

- **Fail-open**: the agent keeps running; turns are unaffected; reads return empty
  and writes are swallowed by the evaluator runner. Nothing this plugin does can
  break a turn.
- **NOT fail-over**: storage does not silently route to plugin-sql. It is off until
  the next successful start.

This is a deliberate consequence of owning the slot. If you need write durability
through a node outage, run the (phase-2) coexist tier instead of slot ownership.

## Configuration

Resolved from the elizaOS runtime settings / environment (see `src/config.ts`):

| Setting | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TINYCLOUD_PRIVATE_KEY` | **yes** | — | Hex private key for the agent's **own** memory space. |
| `TINYCLOUD_HOST` | no | `https://node.tinycloud.xyz` | TinyCloud node endpoint. Self-host for sensitive deployments. |
| `TINYCLOUD_DB_HANDLE` | no | `xyz.tinycloud.eliza/memory` | Full-path SQL db handle (the db-handle prefix). |
| `TINYCLOUD_SPACE_PREFIX` | no | — | node-sdk space `prefix`. |

> **`TINYCLOUD_PRIVATE_KEY` must be a DEDICATED, low-value key — never the
> operator's main wallet (decision D3).** This plugin owns the slot, so the node
> operator can read the agent's entire long-term memory, and it is the *only*
> copy (content is plaintext-at-rest today; E2EE is roadmap). Key compromise =
> memory-space compromise only. Self-host the node for sensitive deployments.

## Multi-tenancy

One space per agent (derived from `TINYCLOUD_PRIVATE_KEY`). Every query filters on
`agent_id`, `entity_id`, and/or `room_id`, so a shared space stays correct at the
query level — but sharing a space across trust boundaries is **discouraged** (one
key = one trust domain; cross-process writers re-expose node concurrency).
Supported for single-operator setups, never across trust boundaries.

## See also

The authoritative design lives in
`development/docs/specs/eliza-tinycloud-memory-provider.md` (§2.1 activation flag,
§2.2 slot-conflict / registration-order mechanics, §3 architecture, §5 per-method
contract).
