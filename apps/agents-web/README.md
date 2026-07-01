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
- `src/tinycloud.ts` — `TinyCloudWeb.signIn()` against `node.tinycloud.xyz`.
- `src/delegate.ts` — mint an SQL delegation to the agent DID. Carries the
  `actionsFromAuthJwt` workaround: web-sdk 2.3.0 serializes the top-level
  `actions` field lossily, so the true grant set is recovered from the signed
  JWT `att` claim. Returns the serialized blob (no file download).
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
(disabled → 403), and both tool/chat error paths (web_search without a Tavily key
→ clean error; chat without a model → clean 409/close). The API E2E also caught
and fixed a real client bug (`listAgents` must unwrap `{ agents: [...] }`).

**Deferred to M4 pre-launch / live-node verification (documented residual):**

- **Delegation-mint round-trip** — minting against the production node requires a
  provisioned/quota'd account; a throwaway address is rejected (the node returns
  403/500 on `/delegate`). This is the M4 "live-node proof #2" gate, not a client
  bug — the client builds the correct delegation up to the node boundary.
- **Manifest sign-in vs. the prod node** — `signIn()` reaches real "agents" space
  creation, then the web-sdk manifest-registry write targets an `applications`
  space that `autoCreateSpace` does not provision (`404 - space not found`).
  Pending a decision on provisioning that space.
- **OpenKey passkey UI leg** — the fully-automated passkey run needs a one-time
  `openkey.so` signup to capture `.passkey.json` (see the `openkey-passkey-test`
  skill); until then the Playwright mock-wallet flow is the autonomous stand-in.
- **HTTPS/mkcert origin** for a passkey run, and **credentialed** web_search/chat
  round-trips (real Tavily + RedPill keys via the deploy env).
