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

## Auth (pending reconciliation)

`src/api.ts` currently signs each request with EIP-191 (`Authorization: TCW1
<b64(payload)>.<sig>`) per the plan §2 stub. The committed service contract
(`docs/agents-api.md`, from M2) is authoritative — when it lands, the auth
construction is swapped in one place (`authHeader` / `signerFromTcw`).
