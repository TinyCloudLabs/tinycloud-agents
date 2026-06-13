# Hydration & portability walkthrough

> Authoritative design: `development/docs/specs/eliza-tinycloud-memory-provider.md`
> §7 (hydration / portability) and §10.5 (the roomId-stability caveat). This page
> is the operator-facing walkthrough of that design — the plan is the contract.

The payoff of owning the `memoryStorage` slot with a user-owned TinyCloud space is
**portability**: an agent's accumulated knowledge of people is durable across
reinstalls, machine moves, and (with the same key) framework redeployments. There
is no export/import step — the space *is* the system of record.

## The story: same key ⇒ same space ⇒ memory on the first turn

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

## Caveat: long-term memories hydrate fully; old session summaries may orphan

This is the one honest asymmetry (plan §10.5):

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
