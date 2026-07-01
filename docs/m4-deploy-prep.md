# M4 — agents.tinycloud.xyz deploy prep notes

Working notes for M4 (static serving + Phala deploy). M4 is blocked on M3 (frontend
`apps/agents-web` build output) until that lands. This file captures the hard gates
and the frontend-independent groundwork so nothing is lost.

## M4 VERIFICATION CHECKLIST (team-lead — both live-node proofs are HARD GATES)

Both items require a real TinyCloud node and CANNOT run in this sandbox. Both must
be GREEN, then team-lead must give explicit approval, BEFORE any prod deploy:

- [ ] **Live-node proof #1 (M1 harness):** `test:live:eliza:delegated` passes against
      a real node with settings-only config (no `process.env.TINYCLOUD_*` mutation).
      Proves the M1 env-mutation removal end to end.
- [ ] **Live-node proof #2 (M2.1 real delegation round-trip):** mint a delegation in
      the owner's `agents` space at path `default/memory`, register it via
      `POST /api/agents/:id/delegation`, and confirm a real read/write round-trips
      through `sql.db(dbHandle)` at the granted per-agent path.
- [ ] `https://agents.tinycloud.xyz/health` returns ok.
- [ ] tinychat regression: legacy `/sessions` + `/messages` with `ELIZA_SERVICE_SECRET`
      still work (the master-key agentId path is unchanged).
- [ ] team-lead explicit go/no-go on the prod deploy.

### Detail — live delegated harness (proof #1)

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

## Frontend-independent groundwork — DONE (committed, tested)

1. ✅ Static-fallback route in `server.ts` (`serveStatic`): GET requests that miss
   every API and legacy route serve a file from `staticDir` (wired from `PUBLIC_DIR`
   in main()), with `index.html` SPA fallback. Path-traversal-safe (escapes rejected).
   Never shadows `/api/*` or legacy routes (they match first). Unset `PUBLIC_DIR` →
   404 (unchanged). Missing dir/index → returns null → 404 (service still runs).
   Tests: `packages/eliza-service/src/static-serving.test.ts` (10 cases incl.
   traversal, index fallback, method/route precedence).
2. ✅ Root `package.json` `workspaces`: added `apps/*`.
3. ✅ `docker-compose.phala.yml`: passes `AGENTS_AUTH_DOMAIN`, `PUBLIC_DIR`,
   `MODEL_API_URL`/`MODEL_API_KEY`/`MODEL_NAME` through to eliza-service.
   `DEPLOY.md` env template updated: `PHALA_INGRESS_DOMAIN=agents.tinycloud.xyz` +
   the new vars + the note that `TINYCLOUD_AGENT_KEY` (derivation master) is unchanged.
   (`.env.phala` itself is gitignored — operator fills it from DEPLOY.md step 3.)
4. ⏳ `Dockerfile`: `ENV PUBLIC_DIR=/app/packages/eliza-service/public` set; the
   `apps/agents-web` build + `cp dist → public` lines + `COPY apps ./apps` are
   present but COMMENTED, gated on M3. Uncomment once `apps/agents-web` exists and
   its `build` emits `dist/`.

## Remaining for M4 (BLOCKED on M3)

- Uncomment the Dockerfile apps-web build/copy + `COPY apps ./apps`.
- Build the image at repo root: `docker build -f packages/eliza-service/Dockerfile -t eliza-service .`
- Fill `.env.phala` (DEPLOY.md §3, agents.tinycloud.xyz values), provide the agent
  key (§4), `phala cvms create` (§5).
- Run the HARD GATE above (live delegated harness) — then get team-lead approval —
  BEFORE the prod deploy. Verify `https://agents.tinycloud.xyz/health` + full flow +
  tinychat regression (legacy /sessions + /messages with ELIZA_SERVICE_SECRET).

## Local run recipe (frontend E2E — verified booting)

The agents-web E2E runs the service locally against a throwaway master key. Boot is
network-free (the DID is derived locally); a live node is only needed when a
delegation is actually registered/used.

```sh
bun install && bun run build          # exports point at gitignored dist/
mkdir -p .tinycloud
printf '0x%s' "$(openssl rand -hex 32)" > .tinycloud/agent.key   # throwaway master key

TINYCLOUD_AGENT_KEY_FILE=./.tinycloud/agent.key \
AGENTS_AUTH_DOMAIN=localhost \
TINYCLOUD_HOST=https://node.tinycloud.xyz \
HOST=127.0.0.1 PORT=3000 \
bun packages/eliza-service/dist/index.js
```

- `TINYCLOUD_AGENT_KEY_FILE` REQUIRED (init() throws without it). Keep the key file
  stable across restarts in a run so derived DIDs / delegations keep matching.
- `AGENTS_AUTH_DOMAIN` MUST equal the frontend origin's host — the signed
  `SiweMessage.domain` must match it exactly.
- `PUBLIC_DIR` unset in dev (SPA served by Vite separately; API-only).
- Intentionally absent (must fail cleanly, not crash boot): `ELIZA_SERVICE_SECRET`
  (legacy routes only), `TAVILY_API_KEY` (web_search errors cleanly), `MODEL_API_URL`/
  `MODEL_API_KEY` (no TEXT model → /messages SSE opens + [DONE], no assistant text).
- CORS: the server sets NO CORS headers (prod is same-origin via the static
  fallback). For cross-origin Vite dev, proxy `/api` through Vite
  (`server.proxy: { '/api': 'http://127.0.0.1:3000' }`) so the browser sees
  same-origin (matches prod). An env-gated dev CORS mode can be added if needed.

## Deploy discipline

- Never deploy uncommitted code. Every deploy maps to a commit + PR.
- Prepare everything, then STOP for team-lead approval before running the prod
  deploy (per team-lead instruction). Do not deploy autonomously.
