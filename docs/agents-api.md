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

Both `/api/auth/*` endpoints are **rate-limited per IP** (default 60/min/IP, keyed on
`x-forwarded-for`); over the limit → `429 { "error": "rate_limit_exceeded" }`. This
bounds signature-retry against a live nonce during its TTL (nonces are consumed only
on a successful verify).

### `GET /api/auth/nonce`

No auth. Returns a single-use nonce (TTL 5 min). Exact response body — the ONLY key
is `nonce`:

```json
200 { "nonce": "eToR9QhpwDZ0NXsoM" }
```

The nonce is an opaque alphanumeric string from `siwe.generateNonce()` (≥ 8 chars).
Treat it as opaque — embed it verbatim in the SIWE message's `nonce` field.

### `POST /api/auth/verify`

No auth. The client builds the **full EIP-4361 message string** (`prepareMessage()`)
and POSTs it **verbatim** alongside the signature — the server re-parses the exact
bytes, so send the string unchanged (no re-serialization, no trimming, preserve
newlines). Exact request body — both keys required, both strings:

```json
{ "message": "<full EIP-4361 message string from prepareMessage()>", "signature": "0x<hex>" }
```

Build the message with the `siwe` package and these fields, then sign the prepared
string via the OpenKey EIP-1193 provider (`personal_sign` — the same path
`tcw.signIn()` uses):

```ts
import { SiweMessage } from "siwe";

const msg = new SiweMessage({
  domain:  "agents.tinycloud.xyz",   // REQUIRED. MUST equal the server's AGENTS_AUTH_DOMAIN.
  address,                            // REQUIRED. OpenKey wallet address, EIP-55 checksummed.
  uri:     "https://agents.tinycloud.xyz",  // REQUIRED by EIP-4361 (any valid URI; not value-checked by the server).
  version: "1",                      // REQUIRED by EIP-4361.
  chainId: 1,                        // REQUIRED by EIP-4361. Signed into the message; not cross-checked server-side.
  nonce,                             // REQUIRED. The exact string from GET /api/auth/nonce.
  // Optional: statement, issuedAt, expirationTime, notBefore, requestId, resources.
  // expirationTime, if present, IS enforced (see "What the server validates").
});
const message = msg.prepareMessage();
const signature = await provider.request({ method: "personal_sign", params: [message, address] });
// POST { message, signature } to /api/auth/verify — message sent verbatim.
```

#### What the server validates

The server runs `SiweMessage.verify({ signature, domain, nonce })` (siwe v3). That call:

1. **domain** — the message's `domain` field MUST equal the server's configured
   domain (`AGENTS_AUTH_DOMAIN`, default `agents.tinycloud.xyz`). Mismatch → reject.
2. **nonce** — the message's `nonce` MUST equal the server-issued nonce, which must
   still be live (issued, unconsumed, within its 5-min TTL). The server checks the
   nonce against its own store BEFORE calling verify, and `verify` also binds it.
3. **address / signature** — the signature MUST recover to the `address` in the
   message (EIP-4361 / EIP-191 personal_sign recovery). Mismatch → reject.
4. **expirationTime** — if the message includes `expirationTime`, `verify` enforces
   it: an already-expired message is rejected (`Expired message.`). Omit it if you
   don't want message-level expiry; the nonce's 5-min TTL already bounds the window.
5. **chainId / version / uri / issuedAt** — parsed and part of the signed payload,
   but NOT cross-checked against an expected value by the server (only their presence
   / EIP-4361 well-formedness matters). The recovered identity is `address`.

On success:

```json
200 { "token": "<64-hex>", "address": "0x<lowercased>", "expiresAt": 1730000000000 }
```

- `token` — opaque, 32 random bytes hex-encoded (64 hex chars). Do not parse it; send
  it back as `Authorization: Bearer <token>`.
- `address` — the recovered owner address, lowercased.
- `expiresAt` — epoch **milliseconds**; session TTL is 24h.

Failures — all `401 { "error": <code> }`:
- `invalid_message` — the message isn't a parseable SIWE/EIP-4361 message.
- `invalid_nonce` — the nonce was never issued, already consumed (single-use), or
  expired (5-min TTL). Fetch a fresh nonce and re-sign. Hard failure — no fallback.
- `invalid_signature` — signature doesn't recover to the message's address, the
  domain doesn't match, or an `expirationTime` in the message has passed. The nonce is
  NOT consumed on this path, so a corrected retry over the same message works until the
  nonce's 5-min TTL lapses.

### Authenticated requests

All `/api/agents*` routes require `Authorization: Bearer <token>`. The token is
**opaque** — there is **no refresh endpoint**. Missing / unknown / expired token →
`401 { "error": "unauthorized" }`. On any such 401 the client re-runs the full
sign-in flow (nonce → sign → verify) to obtain a new token.

## Agents

`AgentView` (returned by create/list/get/patch):

```ts
{
  agentId: string;
  agentDid: string;
  name: string;
  enabled: boolean;
  space: string;       // TinyCloud space the delegation grants in (e.g. "agents")
  pathPrefix: string;  // KV-prefix grant path within the space, e.g. "default/"
  dbHandle: string;    // SQL-exact grant path: `${pathPrefix}memory.db`
  createdAt: string;
}
```

- `agentId` is deterministic per owner: `stringToUuid(ownerAddress.toLowerCase() + ":agent:" + index)`.
- `agentDid` is `did:pkh:eip155:1:{address}`, derived from the service master key
  (stable forever for a given agentId).
- Memory-space scheme: every agent's memory lives in the owner's `space` (currently
  `"agents"` for all) under a per-agent `pathPrefix` — `"default/"` for the owner's
  first (index 0) agent, a slugified name (e.g. `"research-bot/"`) for the rest — so
  multiple agents don't collide. The delegation grants `dbHandle` = `${pathPrefix}memory.db`;
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
400  { "error": "malformed" | "invalid_shape" | "wrong_space"
           | "missing_sql_resource" | "wrong_db_handle"
           | "missing_kv_resource" | "wrong_kv_prefix"
           | "insufficient_actions" | "<policy reason>", "message"?: string }
403  { "error": "agent_disabled" }
404  { "error": "not_found" }
```

#### Mint shape — MULTI-RESOURCE (option D)

The delegation is a **single multi-resource grant** covering three services, all in
the agent's `space` (`view.space` = `"agents"`), minted from the AgentView verbatim:

| service | path | actions | why |
|---|---|---|---|
| `tinycloud.kv` | `view.pathPrefix` (e.g. `"default/"`) | `get`,`put`,`list`,`delete` | KV is **hierarchical** — the prefix grant is the agent's broad "operate under my prefix" access |
| `tinycloud.sql` | `view.dbHandle` (e.g. `"default/memory.db"`) — **EXACT** | `read`,`write`,`admin` | SQL is **exact db-name** at the node, NOT hierarchical — must be the exact handle, not the prefix |
| `tinycloud.capabilities` | `""` | `read` | as before (optional) |

> Why not one `space().delegations.create({ path })`: that emits a SINGLE resource
> and cannot express kv-prefix + sql-exact together. Mint the multi-resource grant
> via the **abilities-map / manifest path** — either `createDelegation` with an
> `abilities` map, or `TinyCloudNode.delegateTo(agentDid, permissions)` driven by a
> manifest whose `PermissionEntry[]` declares these three resources. The abilities
> map shape (short-service → path → full-URN actions):
>
> ```ts
> {
>   kv:  { [view.pathPrefix]:        ["tinycloud.kv/get","tinycloud.kv/put","tinycloud.kv/list","tinycloud.kv/delete"] },
>   sql: { [view.dbHandle]:          ["tinycloud.sql/read","tinycloud.sql/write","tinycloud.sql/admin"] },
>   capabilities: { "": ["tinycloud.capabilities/read"] },
> }
> ```
>
> `delegateDID` MUST equal `view.agentDid`. Keep the `actionsFromAuthJwt` web-sdk
> 2.3.0 workaround if you post-process the serialized blob.

#### Server validation (all `400` on mismatch, fail-closed on the /api route)

- `delegateDID == view.agentDid` — else `wrong_delegatee`.
- **SQL** resource present at EXACT `path == view.dbHandle` — else `missing_sql_resource`
  / `wrong_db_handle`.
- **KV** resource present at `path == view.pathPrefix` (a granted `"/"` whole-space is
  accepted as a superset) — else `missing_kv_resource` / `wrong_kv_prefix`.
- Every matched resource's **space == `view.space`** (`"agents"`) — else `wrong_space`.
  Fail-closed: a grant with no verifiable per-resource space (the flat/legacy single-
  resource serialization) is rejected. This is why you MUST mint the multi-resource
  grant, not a hand-rolled flat blob.
- Required actions covered on each resource — else `insufficient_actions`.

Show the user a "re-delegate" message on any of these; `wrong_space` / `missing_kv_resource`
specifically mean the delegation wasn't minted with the full agents-space multi-resource
shape.

Restart caveat: the registry and delegations are in-memory (v1). After a CVM
redeploy, `/messages` and `/tools` return `409 delegation_required` until the user
re-submits their delegation. Treat 409 as "prompt to re-delegate."

## Use

### `POST /api/agents/:agentId/messages` — SSE

Bearer-authed. Request body (both required strings; `entityId` is server-derived —
do not send it):

```json
{ "text": string, "roomId": string }
```

On success the response is `200` with `Content-Type: text/event-stream`. The wire
format is **exact** (the server writes these bytes literally):

- Each response chunk is one frame: `data: <json>\n\n` — the literal ASCII `data: `
  (with the trailing space), then a single line of JSON, then **two** `\n`.
- `<json>` is Eliza's `Content` object, at minimum `{ "text": string }` (other keys
  may be present; parse `text` and ignore unknown keys). Parse each frame's payload
  with `JSON.parse`.
- The stream terminates with the literal sentinel frame `data: [DONE]\n\n`. `[DONE]`
  is NOT JSON — match it as a literal string before attempting `JSON.parse`.
- There is no `event:` line and no per-frame `id:` — only `data:` frames.

```
data: {"text":"Hello"}\n\n
data: {"text":" world"}\n\n
data: [DONE]\n\n
```

Error responses (returned BEFORE the stream opens — no SSE frame is written on these
paths, so they arrive as normal JSON responses, not `data:` frames):

- `403 { "error": "agent_disabled" }` — the agent is off.
- `409 { "error": "delegation_required" | "delegation_expired" }` — delegation missing
  or expired (treat as "prompt to re-delegate").
- `404 { "error": "not_found" }` — unknown / not-owned agent.
- `400 { "error": "invalid_body" }` — `text`/`roomId` missing or not strings.

Real text responses require the service to be configured with a TEXT model
(`MODEL_API_URL` / `MODEL_API_KEY`); otherwise the pipeline runs without one and the
turn may yield no assistant text.

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
4. Per agent: mint the MULTI-RESOURCE delegation (kv-prefix `view.pathPrefix` + sql-exact `view.dbHandle` + capabilities, in `view.space`) via the abilities-map/manifest path, `delegateDID: view.agentDid` → `POST /api/agents/:id/delegation`. See the Delegation section for the exact shape.
5. Toggle via `PATCH`. Chat via `POST /api/agents/:id/messages` (consume SSE). `web_search` via tools route.

Keep all endpoint paths + the `Authorization` header construction in a single
`apps/agents-web/src/api.ts`.
