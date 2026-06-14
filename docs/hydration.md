# Hydration & portability walkthrough

> Authoritative design: `development/docs/specs/eliza-tinycloud-memory-provider.md`
> §7 (hydration / portability) and §10.5 (the roomId-stability caveat). This page
> is the operator-facing walkthrough of that design — the plan is the contract.

The payoff of owning the `memoryStorage` slot with a TinyCloud space is
**portability**: an agent's accumulated knowledge of people is durable across
reinstalls, machine moves, and (with the same key or delegation) framework
redeployments. There is no export/import step — the space *is* the system of record.

The plugin operates in two auth modes that differ in **who owns the durable space**:

- **Private-key mode (default):** the agent owns its own TinyCloud space, derived
  from `TINYCLOUD_PRIVATE_KEY`. Memory is agent-owned.
- **Delegated mode:** the user owns the TinyCloud space. The agent holds a
  user-signed portable delegation and writes into the user's space through
  delegated SQL. Memory is user-owned.

Both modes share the same hydration property: the durable space is restored on
every fresh process without an export/import step.

## Private-key mode: same key ⇒ same space ⇒ memory on the first turn

1. **First run.** `TINYCLOUD_PRIVATE_KEY` signs in to a TinyCloud space (created on
   first use, `autoCreateSpace: true`). The service runs `CREATE TABLE IF NOT
   EXISTS` for `long_term_memories` and `session_summaries`. As the agent talks,
   core's extraction evaluators write long-term memories and session summaries
   into that space (post-turn, off the user path).

2. **Tear down.** Delete the local Eliza install, move to a new machine, or
   redeploy under a fresh database. The local message history, facts pool, caches,
   and RAG documents — all of which live in local `plugin-sql`, not TinyCloud —
   are gone.

3. **Fresh install + the same key.** Point a brand-new Eliza install at the **same**
   `TINYCLOUD_PRIVATE_KEY`. `signIn` resolves the **same space** (the space is
   derived from the key). The `CREATE TABLE IF NOT EXISTS` statements are no-ops —
   the tables already hold the agent's history.

4. **Memory on the first turn.** On the very first message, core's
   `LONG_TERM_MEMORY` and `SUMMARIZED_CONTEXT` providers query the slot and serve
   the agent's accumulated memory straight into the prompt. No warm-up, no
   re-learning. The agent already knows what it knew.

Everything the write path needs for a lossless round-trip is stored in full
(plan §4, §7): the complete memory `content` (never truncated — the 5000-char cap
in the provider is a *render* cap, not a storage cap), `category`, `metadata`
JSON, `confidence`, `source`, every timestamp, and `entity_id` / `agent_id` /
`room_id` verbatim. The nullable `embedding` column keeps the door open for a
phase-2 hybrid local index (local FTS/vector as a *derived cache*, TinyCloud as the
durable source of truth, rebuilt by a full-table hydrate on install).

## Delegated-mode hydration: same delegation + same agent key ⇒ user's space ⇒ memory on the first turn

In delegated mode the **durable space is the user's**, not the agent's. A fresh
agent process does not need the user's private key — the user signed a portable
delegation once (via OpenKey), and that delegation is all the agent needs to
re-activate access.

1. **Obtain a delegation (one-time, human step).** The user signs in with OpenKey,
   grants the agent DID (`did:pkh:eip155:1:{address}`) exactly the
   `xyz.tinycloud.eliza/memory` SQL capability, and the resulting delegation is
   serialized to a file (see the Phase 6 consent harness runbook).

2. **First run.** Set `TINYCLOUD_AUTH_MODE=delegation`,
   `TINYCLOUD_DELEGATION_FILE=/path/to/delegation.json` (or supply the base64
   string in `TINYCLOUD_DELEGATION`), and `TINYCLOUD_AGENT_KEY_FILE=/path/to/key`
   (or `TINYCLOUD_AGENT_KEY`). The plugin validates the delegation, calls
   `TinyCloudNode.useDelegation`, and the agent writes long-term memories and
   session summaries into the **user's** space.

3. **Tear down.** The local Eliza install is removed or moved to a new machine.
   The local message history, facts pool, caches, and RAG documents are gone.

4. **Fresh install + the same delegation file + the same agent key.** Point a
   brand-new Eliza install at the **same** `TINYCLOUD_DELEGATION_FILE` (or
   `TINYCLOUD_DELEGATION`) and the **same** `TINYCLOUD_AGENT_KEY`. The plugin
   re-validates the delegation, re-activates delegated SQL access, and resolves
   the **same user's space**. `CREATE TABLE IF NOT EXISTS` is a no-op — the
   tables already hold the agent's history in the user's space.

5. **Memory on the first turn.** The `LONG_TERM_MEMORY` and `SUMMARIZED_CONTEXT`
   providers query the user's space and serve the accumulated memory into the
   prompt. No warm-up, no re-learning.

**The agent key is not the user's key.** The agent key (`TINYCLOUD_AGENT_KEY`) is
service identity material that identifies the agent DID. Compromise of the agent
key grants only the capabilities in the delegation (narrowly scoped to
`xyz.tinycloud.eliza/memory` SQL) — it never grants access to the user's full
TinyCloud account. The user retains the ability to revoke the delegation at any
time.

## Caveat: long-term memories hydrate fully; old session summaries may orphan

This asymmetry applies in **both** private-key and delegated mode (plan §10.5):

- **Long-term memories — the valuable store — hydrate fully and reliably.** They
  key on `entity_id`, which core derives deterministically from a platform
  identity. The same person resolves to the same `entity_id` on a fresh database,
  so every read finds the rows.

- **Session summaries key on `room_id`.** Their hydration depends on Eliza
  deterministically deriving the *same* room UUID for the *same* channel on a fresh
  local database. That derivation is asserted plausible but **not verified** end to
  end (plan §10.5, open question 5).

- **Worst case is benign.** If a fresh install derives different room UUIDs, old
  session summaries become unreachable **orphans** — they still occupy the space
  harmlessly, and new summaries accumulate under the new room ids. No data is lost
  or corrupted; only the *continuity* of pre-reinstall session summaries is at
  risk. The long-term memory store — the part that actually encodes "what the agent
  knows about you" — is unaffected.

If session-summary continuity across reinstalls matters for your deployment, treat
it as unverified until the live integration suite exercises room-UUID stability on
a fresh database.
