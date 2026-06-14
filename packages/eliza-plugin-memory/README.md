# @tinycloud/eliza-plugin-memory

An elizaOS 2.0 plugin that **owns the advanced-memory `memoryStorage` service
slot**, backed by a [TinyCloud](https://tinycloud.xyz) space as the system of record
for an agent's long-term memories ("what I know about you") and session summaries.
Two auth modes are supported: in **private-key mode** the agent owns its own
dedicated TinyCloud space; in **delegated mode** the user's TinyCloud space is the
record of truth and the agent reads/writes through a user-granted delegation. Core's
own `MemoryService`, providers, and extraction evaluators run unmodified against
TinyCloud storage — this plugin writes no injection/extraction logic.

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

If you list it **after** `@elizaos/plugin-sql`, plugin-sql would win the slot. To
prevent that from happening *silently* (memories quietly staying in local SQL), the
service **fails fast**: on start it checks the `memoryStorage` slot and, if a foreign
service already holds it, throws a clear, actionable error
(`… the "memoryStorage" slot is already held by AdvancedMemoryStorageService. List
"@tinycloud/eliza-plugin-memory" BEFORE "@elizaos/plugin-sql" …`). Per the fail-open
semantics below, advanced-memory is then disabled for the run and the error is logged
— you get a loud signal to fix plugin order, never a silent misroute.

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

Resolved from the elizaOS runtime settings / environment (see `src/config.ts`).
Two auth modes are supported. Set `TINYCLOUD_AUTH_MODE` to select one.

### Private-key mode (default)

The agent owns its own TinyCloud memory space, identified by a dedicated private key.
This is the existing/dev/simple-agent path. Memory is stored in the agent's space,
not a user's space.

| Setting | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TINYCLOUD_AUTH_MODE` | no | `private-key` | Omit or set to `private-key`. |
| `TINYCLOUD_PRIVATE_KEY` | **yes** | — | Hex private key for the agent's **own** memory space. |
| `TINYCLOUD_HOST` | no | `https://node.tinycloud.xyz` | TinyCloud node endpoint. Self-host for sensitive deployments. |
| `TINYCLOUD_NODE_HOST` | no | — | Legacy alias for `TINYCLOUD_HOST`. Use `TINYCLOUD_HOST` in new configs. |
| `TINYCLOUD_DB_HANDLE` | no | `xyz.tinycloud.eliza/memory` | Full-path SQL db handle. |
| `TINYCLOUD_SPACE_PREFIX` | no | — | node-sdk space `prefix`. |

> **`TINYCLOUD_PRIVATE_KEY` must be a DEDICATED, low-value key — never the
> operator's main wallet (decision D3).** Key compromise = memory-space
> compromise only. Self-host the node for sensitive deployments.

### Delegated mode (user-owned memory)

The user owns the TinyCloud memory space. The agent reads and writes through a
portable delegation signed by the user. The agent has a **stable DID** derived
from its own identity key (`TINYCLOUD_AGENT_KEY` or `TINYCLOUD_AGENT_KEY_FILE`).

The agent key belongs to the agent, not the user. The user delegates the memory
SQL capability to that agent DID via OpenKey/TinyCloud — the agent never holds
the user's key. **Distinct roles:** OpenKey proves the user's identity and signs
consent; the TinyCloud delegation grants the actual memory capability. These are
distinct and must not be conflated.

> **Status: shipped.** The user delegates the `xyz.tinycloud.eliza/memory` SQL
> capability to the stable agent DID via OpenKey/TinyCloud; the agent activates
> delegated access via `TinyCloudNode.useDelegation` and reads/writes the user's
> space through delegated SQL. Obtain a delegation using the consent harness
> (`docs/openkey-phases/phase-6-consent-runbook.md`) and supply it via
> `TINYCLOUD_DELEGATION` or `TINYCLOUD_DELEGATION_FILE`. The Phase 7 live
> delegated scenario (`packages/eliza-plugin-memory/scripts/live-delegated-scenarios.ts`)
> documents the full end-to-end flow. **Not in scope for this release:**
> delegation revocation, policy-hash status verification, and the auth sidecar.

| Setting | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TINYCLOUD_AUTH_MODE` | **yes** | — | Set to `delegation`. |
| `TINYCLOUD_DELEGATION` | one of | — | Inline serialized portable delegation from the user. |
| `TINYCLOUD_DELEGATION_FILE` | one of | — | Path to file containing the serialized delegation. Exactly one of these two is required. |
| `TINYCLOUD_AGENT_KEY` | one of | — | Inline stable agent identity key (hex). DID derived from this key must match `delegateDID` in the delegation. |
| `TINYCLOUD_AGENT_KEY_FILE` | one of | — | Path to file containing the agent identity key. Exactly one of these two is required. |
| `TINYCLOUD_HOST` | no | `https://node.tinycloud.xyz` | TinyCloud node endpoint. |
| `TINYCLOUD_NODE_HOST` | no | — | Legacy alias for `TINYCLOUD_HOST`. |
| `TINYCLOUD_DB_HANDLE` | no | `xyz.tinycloud.eliza/memory` | Full-path SQL db handle. |

**Delegation validation:** The plugin validates the delegation before activating access.
Errors are reported at startup — the service does not silently fall back to private-key mode:
- **Wrong delegatee:** the DID derived from `TINYCLOUD_AGENT_KEY` must match the `delegateDID`
  in the delegation. Mismatch is rejected.
- **Expired:** the delegation's expiry timestamp must be in the future. Expired → rejected.
- **Insufficient policy:** the delegation must grant `tinycloud.sql` read/write/admin on
  `xyz.tinycloud.eliza/memory`. Missing actions → rejected.
- **Malformed:** a delegation that cannot be deserialized is rejected immediately.

> **Validation reads the SIGNED capability, not the file's summary.** The plugin
> normalizes every delegation from the signed `delegationHeader.Authorization` UCAN
> (`att`) before validating — so the top-level `actions`/`resources` summary (which
> web-sdk writes lossily and which is unsigned/forgeable) cannot grant access it was
> not actually signed for. A file whose summary claims `tinycloud.sql/admin` but whose
> signed capability grants none is rejected.

## Operating in production

**Dedicated agent key.** Generate a fresh 32-byte hex key per agent (see
`docs/openkey-phases/phase-7-runbook.md` Step 1A); store it as a file with `chmod 600`
and pass `TINYCLOUD_AGENT_KEY_FILE` (preferred over inline `TINYCLOUD_AGENT_KEY`). Never
the operator's main wallet — the agent key is a low-value service credential whose only
authority is the delegated memory capability.

**Rotating the agent key.** The agent's DID is derived from its key, and a delegation is
bound to that DID (`delegateDID`). To rotate: (1) generate a new agent key, (2) have the
user mint a **new delegation** to the new key's DID (the old delegation cannot be
re-pointed — DID match is exact), (3) swap `TINYCLOUD_AGENT_KEY_FILE` and
`TINYCLOUD_DELEGATION_FILE` together, (4) restart. The old key's delegation simply
expires unused; revoke it upstream if you need immediate cutoff (revocation is upstream,
not in this plugin).

**Delegation expiry & re-mint cadence.** A delegation carries a fixed expiry (observed
~7 days), capped by the parent sign-in window (child expiry ≤ parent). It **cannot** be
extended by re-running activation — re-minting requires the user to sign a fresh
delegation (consent runbook). Plan a re-mint cadence shorter than the expiry. After
expiry the service rejects at startup with the `Expired` reason above (fail-open: memory
is disabled, not silently degraded). Surface the expiry to operators — read
`delegation.expiry` from `TINYCLOUD_DELEGATION_FILE` — and alert before it lapses.

**Embeddings.** If no `TEXT_EMBEDDING` model is configured, memories are stored with a
null embedding (writes/reads still work; semantic ranking is simply unavailable). The
storage layer round-trips full-dimension embedding vectors intact; configure a
`TEXT_EMBEDDING` model to enable semantic recall.

## Multi-tenancy

**Private-key mode:** one space per agent (derived from `TINYCLOUD_PRIVATE_KEY`). Every query
filters on `agent_id`, `entity_id`, and/or `room_id`, so a shared space stays correct at the
query level — but sharing a space across trust boundaries is **discouraged** (one
key = one trust domain; cross-process writers re-expose node concurrency).
Supported for single-operator setups, never across trust boundaries.

**Delegated mode:** the memory space is user-owned (scoped to the user's TinyCloud identity)
and is not derived from `TINYCLOUD_PRIVATE_KEY`. The agent reads and writes through the
user-granted delegation; the space owner is the human, not the agent. The agent identity
key (`TINYCLOUD_AGENT_KEY` / `TINYCLOUD_AGENT_KEY_FILE`) is the agent's own service
credential — it is **NOT the user's key**; the user's key never leaves the user's control.

## Delegated mode — consent runbook

To set up a user-owned memory space (delegated mode), a human must perform two
live WebAuthn/passkey steps that cannot be automated. The full flow — generate an
agent key, run the consent harness, sign in with a passkey, approve the delegation
in-browser, and boot Eliza — is documented in:

`docs/openkey-phases/phase-6-consent-runbook.md`

The runbook covers both manual gates (`phase6-manual-openkey-signin` and
`phase6-manual-browser-delegation`), all pitfalls, and the DID-stability
requirement.

## See also

The authoritative design lives in
`development/docs/specs/eliza-tinycloud-memory-provider.md` (§2.1 activation flag,
§2.2 slot-conflict / registration-order mechanics, §3 architecture, §5 per-method
contract).
