# agents-web

The SPA for agents.tinycloud.xyz. Sign in with an OpenKey passkey, create
agents, delegate access to your TinyCloud memory space, chat, and run tools.

## Dev

```sh
bun install                 # from repo root (apps/* is a workspace)
cd apps/agents-web
bun run dev                 # Vite on :5174, proxies /api -> :3000
```

Point the proxy at a running eliza-service:

```sh
AGENTS_API_TARGET=http://localhost:3000 bun run dev
```

Build:

```sh
bun run build               # -> dist/ (served by the Bun server in prod)
```

## Layout

- `src/openkey.ts` — OpenKey passkey connect (ported from `tools/delegate-ui`).
- `src/manifest.ts` — the app manifest. It declares the app in the user's
  account AND makes the default agent's caps **first-class**: `tinycloud.kv`
  prefix `default/` + `tinycloud.sql` exact `default/memory.db` +
  `tinycloud.capabilities` read, space `agents`. This is **load-bearing, not
  cosmetic** (see `delegate.ts`).
- `src/tinycloud.ts` — `TinyCloudWeb.signIn()` against `node.tinycloud.xyz`,
  manifest passed at construction (secret-manager's proven single-signIn
  pattern; a post-signIn `spaces.create` of a sibling space 401s).
- `src/delegate.ts` — mint the option-D **multi-resource** delegation to the
  agent DID (kv-prefix on `pathPrefix` + sql-exact on `dbHandle` +
  capabilities), threading `space`/`pathPrefix`/`dbHandle` verbatim from the
  AgentView. It **must** go through the session-key `delegateTo(did,
  PermissionEntry[])` path: `delegateTo` with `forceWalletSign: true` accepts
  **at most one** PermissionEntry (it throws on multi-entry), so a 3-resource
  grant can only be minted via the derivable session-key UCAN path — which
  requires the caps to be a subset of the session recap. That is *why* the
  default agent's caps are baked into the manifest (`manifest.ts`): it makes the
  default-agent mint derivable and silent (no prompt). A dynamically-named agent
  (not in the static manifest) throws `PermissionNotInManifestError`; we then
  escalate once via `tcw.requestPermissions(missing)` and retry the derivable
  mint. Also carries the `actionsFromAuthJwt` workaround: web-sdk 2.3.0
  serializes the top-level `actions` field lossily, so the flat mirror is
  rewritten from the signed JWT `att` claim (the server reads `resources[]`, not
  this field). Returns the serialized blob (no file download).
- `src/api.ts` — THE loose-coupling seam. Every endpoint path and the
  `Authorization` header format live here and nowhere else. Base URL is
  same-origin `/api`. A 409 `delegation_required` is surfaced as a re-delegate
  prompt.
- `src/App.tsx`, `src/components/*` — sign-in gate, create/list, per-agent card
  (delegation badge, Delegate/Re-delegate, enable/disable), SSE chat, web_search.

## Auth

SIWE nonce + bearer session, signed via the OpenKey EIP-1193 provider (all in
`src/api.ts`):

1. `GET /api/auth/nonce` → `{ nonce }`
2. Build the SIWE message (domain `window.location.host` per EIP-4361 + nonce)
   and `personal_sign` it via the OpenKey provider (the same path `tcw.signIn()`
   uses). The server validates the domain against `AGENTS_AUTH_DOMAIN`
   (`agents.tinycloud.xyz` in prod, `localhost:<port>` for local E2E).
3. `POST /api/auth/verify { message, signature }` → `{ token }` (opaque bearer).
4. `Authorization: Bearer <token>` on all `/api/agents*` calls. A 401 clears the
   cached token and re-runs the flow once; a 409 `delegation_required` prompts
   re-delegation.

The exact SIWE message fields come from `docs/agents-api.md` (M2). Only
`buildSiweMessage` in `api.ts` needs reconciling when that contract lands;
everything else (nonce fetch, verify, bearer cache, 401 re-auth) is stable.

## Testing & verification status

Two E2E harnesses live under `e2e/`:

- `e2e/harness.ts` — API-level, an ephemeral-EOA signer swapped for OpenKey,
  driven headlessly via a browser (`e2e.html`).
- `e2e/specs/agents-wallet-flow.pw.ts` — Playwright, real UI, a mock EIP-6963
  wallet clicking "or use an external wallet" in the OpenKey iframe. `bun run e2e`
  (needs a local eliza-service on :3000 with `AGENTS_AUTH_DOMAIN=localhost:5174`).

**Verified (against a local service + the real node, no passkey):** SIWE
nonce→verify→bearer auth, agent create (DID returned), list, enable/disable gate
(disabled → 403), a **real `web_search` round-trip** (with a real Tavily key the
tool returns a live result), and the chat gate (409 `delegation_required` when no
delegation is registered). The API E2E also caught and fixed a real client bug
(`listAgents` must unwrap `{ agents: [...] }`).

**Text model (chat) — config verified, in-service round-trip is an M4 item.** The
prod chat model is RedPill (OpenAI-compatible). Verified working values:
`MODEL_API_URL=https://api.redpill.ai/v1`, `MODEL_API_KEY=<REDPILL_API_KEY>`,
`MODEL_NAME=openai/gpt-4o-mini` (a direct completion returns a real reply; the
service boots cleanly with these). A full in-service chat SSE turn additionally
needs a registered delegation, which is gated by the same live-node account
requirement as the mint leg — so it lands with M4.

**Live E2E — BLOCKED at sign-in on a web-sdk 2.3.0 registry-write bug (both
auth paths).** Neither the passkey nor the mock-wallet (eth-account) path gets
past sign-in against the prod node, so the mint/chat/web_search/toggle legs are
not yet proven end to end:

- **Manifest-registry write 404 (web-sdk 2.3.0)** — inside `tcw.signIn()`, after
  the `agents` space is created, the SDK writes the manifest registry record and
  throws `Failed to write manifest registry record applications/xyz.tinycloud.agents:
  404 - space not found`. Traced to node-sdk 2.3.0's `writeManifestRegistryRecords`
  doing a raw `accountKV.put` into the owner's `account` space that the node 404s.
  This reproduces with BOTH the passkey account and the Hardhat mock EOA, so it is
  NOT a provisioning/quota gate — it's the SDK's account-registry write path.
  web-sdk **2.4.0** (which secret-manager runs successfully with the same Hardhat
  key against the same prod node) reworks this path entirely
  (`account.applications.register` + `ensureOwnedSpaceHostedById` + retry). The fix
  is almost certainly the monorepo `@tinycloud/*` 2.3.0 → 2.4.0 bump; the mint
  contract (`delegateTo`, the `DelegatedResource {service,space,path,actions}`
  schema the server validates) is unchanged across the bump, so the option-D mint
  needs no code change.
- **OpenKey passkey UI leg** — the CDP virtual-authenticator run
  (`.claude/skills/openkey-passkey-test/run-agents-e2e.ts`, HTTPS via mkcert +
  `AGENTS_HTTPS_CERT`/`AGENTS_HTTPS_KEY`) drives the flow, but OpenKey's
  `verify-authentication` returns `400 AUTHENTICATION_FAILED` because the assertion
  is cross-origin (`origin: https://openkey.so`, `topOrigin: https://localhost:5174`).
  Needs an OpenKey top-origin allowlist / credential re-registration from this
  origin. The mock-wallet (eth-account) flow is the autonomous stand-in and is
  blocked only by the same 2.3.0 registry 404 above.
- **Credentialed** web_search / chat round-trips (real Tavily + RedPill keys) —
  unblock once sign-in passes.
