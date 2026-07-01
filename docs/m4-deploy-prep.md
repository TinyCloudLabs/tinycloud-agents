# M4 — agents.tinycloud.xyz deploy prep notes

Working notes for M4 (static serving + Phala deploy). M4 is blocked on M3 (frontend
`apps/agents-web` build output) until that lands. This file captures the hard gates
and the frontend-independent groundwork so nothing is lost.

## HARD GATE (team-lead, do not skip) — live delegated harness

Before ANY prod deploy, the live delegated harness MUST pass against a real
TinyCloud node with **settings-only** config (no `process.env.TINYCLOUD_*`
mutation — those were removed in M1, commit f61200f):

```sh
TINYCLOUD_LIVE=1 bun --bun run --filter '@tinycloud/eliza-plugin-memory' test:live:eliza:delegated
# script: packages/eliza-plugin-memory/scripts/live-delegated-scenarios.ts
```

Why it's owed: M1 removed the env mutations in `_bootProduction` so per-agent keys
flow through `character.settings` only. That change is unit-tested (two agents get
distinct `TINYCLOUD_AGENT_KEY` settings, `process.env` untouched) but the
settings-only path has NOT been proven end to end against a live node in this
sandbox (no node access). Treat a green run of the delegated harness as the
gate that confirms it.

Additionally, with the M2.1 agents-space scheme, the live check should exercise a
per-agent `dbHandle` (e.g. `default/memory`) end to end: mint a delegation in the
owner's `agents` space at path `default/memory`, register it via
`POST /api/agents/:id/delegation`, and confirm a real read/write round-trips —
because `sql.db(dbHandle)` must match the granted path (see docs/agents-api.md and
the delegation-space findings below).

## Delegation-space finding (relevant to what the live test must prove)

- The serialized delegation ENCODES the space (`resources[].space` full URI, e.g.
  `tinycloud:pkh:eip155:1:0x<owner>:agents`) but the policy validator does NOT
  check the space name — it validates delegateDID + PATH (== dbHandle) + expiry +
  actions (`packages/agent-client/src/delegation-policy.ts`).
- Operationally the space is resolved from the SIGNED capability at
  `node.useDelegation()` activation; SQL routes through `sql.db(config.dbHandle)`
  (`delegated-transport.ts:297`). So the live test must confirm the agent actually
  reads/writes the owner's `agents` space at the per-agent path — this is the only
  place the space vs path coupling is proven for real.

## Frontend-independent groundwork (can do before M3 lands)

1. Static-fallback route in `server.ts`: after all API/legacy route matches fail,
   for GET serve files from `PUBLIC_DIR` (Bun.file), falling back to `index.html`
   for SPA routing. Must NOT shadow `/api/*` or the legacy tinychat routes
   (`/health`, `/sessions`, `/messages`, `/tools`). Gate the whole thing on
   `PUBLIC_DIR` being set so tests/other deploys are unaffected.
2. Root `package.json` `workspaces`: add `apps/*` so the frontend package is part
   of the workspace (currently only `packages/*`).
3. `.env.phala` / `docker-compose.phala.yml`: `PHALA_INGRESS_DOMAIN=agents.tinycloud.xyz`;
   new env vars introduced by M2/M2.1 that prod needs:
   - `AGENTS_AUTH_DOMAIN` (defaults `agents.tinycloud.xyz`) — SIWE domain.
   - `MODEL_API_URL` / `MODEL_API_KEY` (+ optional `MODEL_NAME`) — TEXT model, if
     real chat is wanted; omit both to run tools-only.
   - Master key stays the existing `TINYCLOUD_AGENT_KEY` (no new secret).
4. `Dockerfile`: build `apps/agents-web` (once it exists), copy its `dist/` into the
   image, set `PUBLIC_DIR` to it. This step DEPENDS on M3.

## Deploy discipline

- Never deploy uncommitted code. Every deploy maps to a commit + PR.
- Prepare everything, then STOP for team-lead approval before running the prod
  deploy (per team-lead instruction). Do not deploy autonomously.
