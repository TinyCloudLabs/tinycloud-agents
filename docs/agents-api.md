# agents.tinycloud.xyz — API Contract (TC-64, M2)

The API the `apps/agents-web` frontend builds against. Same-origin: all paths are
under `/api` on `https://agents.tinycloud.xyz`. Served by the same Bun process as
the legacy tinychat routes (`/health`, `/sessions`, `/messages`, `/tools`), which
are unchanged.

Implemented in `packages/eliza-service`:
`src/auth/user-auth.ts`, `src/agents/agent-store.ts`, `src/handlers/agents.ts`,
`src/server.ts` (`handleApi`).

## Authentication — SIWE nonce + bearer session

OpenKey is a **client-side** passkey wallet: it produces an address and signs
messages; there is no server SDK. The server proves ownership of an address by
verifying a SIWE signature, then issues a short-lived opaque bearer session.

> Replay protection is a **server-issued single-use nonce** (SIWE standard), not a
> timestamp — per the repo's cryptographic-verifiability principle. The nonce is
> consumed on the first successful verify.

### `GET /api/auth/nonce`

No auth. Returns a single-use nonce (TTL 5 min).

```json
200 { "nonce": "eToR9QhpwDZ0NXsoM" }
```

### `POST /api/auth/verify`

No auth. Body:

```json
{ "message": "<SIWE message string, prepareMessage()>", "signature": "0x..." }
```

The client builds a SIWE message with `domain = agents.tinycloud.xyz`, the user's
address, chainId 1, and the issued `nonce`, then signs it via the OpenKey EIP-1193
provider (`personal_sign` — the same path `tcw.signIn()` uses). On success:

```json
200 { "token": "<64-hex>", "address": "0x<lowercased>", "expiresAt": 1730000000000 }
```

Failures: `401 { "error": "invalid_message" | "invalid_nonce" | "invalid_signature" }`.
Session TTL is 24h.

### Authenticated requests

All routes below require `Authorization: Bearer <token>`. Missing/expired/unknown
token → `401 { "error": "unauthorized" }`.

## Agents

`AgentView` (returned by create/list/get/patch):

```ts
{
  agentId: string;
  agentDid: string;
  name: string;
  enabled: boolean;
  space: string;       // TinyCloud space to mint the delegation in: tcw.space(space)
  pathPrefix: string;  // per-agent prefix within the space, e.g. "default/"
  dbHandle: string;    // delegation `path` to grant: `${pathPrefix}memory`
  createdAt: string;
}
```

- `agentId` is deterministic per owner: `stringToUuid(ownerAddress.toLowerCase() + ":agent:" + index)`.
- `agentDid` is `did:pkh:eip155:1:{address}`, derived from the service master key
  (stable forever for a given agentId).
- Memory-space scheme: every agent's memory lives in the owner's `space` (currently
  `"agents"` for all) under a per-agent `pathPrefix` — `"default/"` for the owner's
  first (index 0) agent, a slugified name (e.g. `"research-bot/"`) for the rest — so
  multiple agents don't collide. The delegation grants `dbHandle` = `${pathPrefix}memory`;
  the server validates against exactly that path and boots the agent runtime with
  `TINYCLOUD_DB_HANDLE = dbHandle` so writes land where the grant allows. **Mint the
  delegation using `space`, `dbHandle`, and `agentDid` straight from the AgentView — do
  not hardcode them.**

### `POST /api/agents`

Create the owner's next agent (idempotent per owner+index). Rate-limited per owner
(30/min → `429 { "error": "rate_limit_exceeded" }`).

```json
Body: { "name"?: string }         // blank/missing → "agent"
201  { AgentView }
```

### `GET /api/agents`

```json
200 { "agents": AgentView[] }      // caller's agents, creation order
```

### `GET /api/agents/:agentId`

`200 { AgentView }` — or `404 { "error": "not_found" }` if unknown or not owned
(ownership is never leaked; unknown and not-owned are indistinguishable).

### `PATCH /api/agents/:agentId`

```json
Body: { "enabled": boolean }
200  { AgentView }
400  { "error": "invalid_body" }   // enabled not a boolean
404  { "error": "not_found" }
```

## Delegation

### `POST /api/agents/:agentId/delegation`

Register the user's TinyCloud delegation for this agent. The `entityId` is derived
**server-side** from the authed owner + agentId — do not send it.

```json
Body: { "serializedDelegation": string, "roomId"?: string }
200  { "entityId": string, "status": "active" | "expired" | "stale" }
400  { "error": "malformed" | "invalid_shape" | "<policy reason>", "message"?: string }
403  { "error": "agent_disabled" }
404  { "error": "not_found" }
```

The `serializedDelegation` is the blob produced by
`tools/delegate-ui/src/delegate.ts` — mint with `@tinycloud/web-sdk@2.3.0`, but
**parameterize the space and path from the AgentView** (do not use the old fixed
`space("default")` / `xyz.tinycloud.eliza/memory`):

```ts
tcw.space(view.space).delegations.create({
  delegateDID: view.agentDid,   // MUST equal the AgentView.agentDid
  path: view.dbHandle,          // e.g. "default/memory"
  actions: SQL_ACTIONS,
  expiry,
});
```

Then **rewrite the top-level `actions` from the JWT `att` claim** (web-sdk 2.3.0
serializes `actions` lossily — see `actionsFromAuthJwt` in delegate.ts, carry it
over verbatim). The server validates `delegateDID == agentDid` and the granted
`path == dbHandle`; a mismatch on either → 400.

Restart caveat: the registry and delegations are in-memory (v1). After a CVM
redeploy, `/messages` and `/tools` return `409 delegation_required` until the user
re-submits their delegation. Treat 409 as "prompt to re-delegate."

## Use

### `POST /api/agents/:agentId/messages` — SSE

```json
Body: { "text": string, "roomId": string }
```

Server-Sent Events: each response chunk is a `data: <json Content>\n\n` frame,
terminated by `data: [DONE]\n\n`. `entityId` is server-derived.

- `403 { "error": "agent_disabled" }` when the agent is off.
- `409 { "error": "delegation_required" | "delegation_expired" }` (pre-stream) when
  the delegation is missing/expired. No SSE frame is written on the 409 path.
- Real text responses require the service to be configured with a TEXT model
  (`MODEL_API_URL` / `MODEL_API_KEY`); otherwise the pipeline runs without one.

### `POST /api/agents/:agentId/tools/:name`

```json
Body: { "args"?: object, "roomId"?: string }
200  { ... tool result ... }
403  { "error": "agent_disabled" }
404  { "error": "tool_not_found" }
409  { "error": "delegation_required" | "delegation_expired" }
```

Only tool today is `web_search` (pure-API; needs no delegation and no TEXT model).
`entityId` is server-derived.

## Frontend flow summary

1. `openkey.connect()` → address + EIP-1193 provider.
2. `GET /api/auth/nonce` → build SIWE message → sign via provider → `POST /api/auth/verify` → store token.
3. `POST /api/agents` (or `GET` to list). Show each agent's `agentDid` + copy button.
4. Per agent: mint the delegation with `tcw.space(view.space).delegations.create({ delegateDID: view.agentDid, path: view.dbHandle, ... })` (ported delegate.ts) → `POST /api/agents/:id/delegation`.
5. Toggle via `PATCH`. Chat via `POST /api/agents/:id/messages` (consume SSE). `web_search` via tools route.

Keep all endpoint paths + the `Authorization` header construction in a single
`apps/agents-web/src/api.ts`.
