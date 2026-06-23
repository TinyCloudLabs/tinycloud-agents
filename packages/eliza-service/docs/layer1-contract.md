# Layer-1 Contract — `eliza-service` app-auth gate

**Audience:** Milestone E (tinychat wiring). This document describes the exact contract E must satisfy when calling `eliza-service`. Milestone D has implemented the server-side gate; E implements the client side.

---

## 1. Service-credential header

Every request to a guarded endpoint must carry:

```
Authorization: Bearer <ELIZA_SERVICE_SECRET>
```

- `ELIZA_SERVICE_SECRET` is the shared secret for the tinychat app. It is an environment variable on **both** sides: the app backend sets it as the outbound credential; `eliza-service` reads it to build the credential→app map at startup.
- The header format must be exactly `Bearer ` (with a trailing space) followed by the secret value. No other schemes are accepted.
- **Rotation** requires a coordinated redeploy of both the app backend and `eliza-service`. There is no live-rotation mechanism in the MVP.

**Error responses:**

| Condition | Status | Body |
|---|---|---|
| `Authorization` header missing or malformed (no `Bearer ` prefix, empty token) | `401` | `{"error":"unauthorized"}` |
| Credential present but not in the registry (wrong secret, wrong app) | `403` | `{"error":"forbidden"}` |

The credential MUST NOT appear in any response body, log line, error message, or thrown value.

**Guarded endpoints** (all require the service credential):

- `POST /sessions`
- `POST /messages`
- `GET /sessions/:entityId`
- `POST /tools/:name`

---

## 1a. Tool dispatch — `POST /tools/:name` (Milestone E, §4)

Discrete agent-tool/action dispatch. The integration model is: RedPill stays the
conversational responder; when the model emits a tool call, tinychat dispatches it
here and feeds the result back into the RedPill turn. This endpoint runs the named
action's handler **directly** — it does NOT route a whole turn through the agent's
compose→model→action→evaluator pipeline (that is `POST /messages`, which needs the
agent TEXT model). A pure-API tool therefore works in prod with no TEXT model.

**Request**

```
POST /tools/:name
Authorization: Bearer {ELIZA_SERVICE_SECRET}
Content-Type: application/json

{ "args": { ... }, "entityId"?: "...", "roomId"?: "..." }
```

- `:name` matches an action's `name` case-insensitively (e.g. `web_search` → `WEB_SEARCH`).
- `args` carries the tool arguments; for `web_search`, `{ "query": "..." }`.
- `entityId`/`roomId` are optional and only consulted by tools that touch the user's
  own space (those resolve a per-user delegated client). Pure-API tools ignore them.
- `agentId` is **server-trusted** — derived from the credential, never sent by the caller.

**Response** — JSON (not SSE; a tool call resolves to one discrete result):

```
200 { "ok": true, "tool": "WEB_SEARCH",
      "result": { "text": "...", "data": { ... } | null, "frames": [ Content, ... ] } }
```

`result.text` is the summarized result to feed back into the turn; `result.data` is
the structured payload; `result.frames` are the raw `@elizaos/core` Content objects
the action emitted.

**Errors**

| HTTP | Body | Trigger |
|------|------|---------|
| 401 | `{ error: "unauthorized" }` | missing/malformed credential |
| 403 | `{ error: "forbidden" }` | unknown credential |
| 404 | `{ error: "tool_not_found", tool }` | no action with that name |
| 400 | `{ error: "invalid_body" }` | body not `{ args?, entityId?, roomId? }` |
| 400 | `{ error: "invalid_args" }` | tool received unusable args (e.g. empty query) |
| 409 | `{ error: "delegation_required" \| "delegation_expired" }` | a per-user tool with no/expired delegation |
| 500 | `{ error: "tool_misconfigured" }` | tool's server-side config missing (e.g. `TAVILY_API_KEY`) |
| 502 | `{ error: "tool_upstream_error" }` | the tool's upstream API failed |
| 502 | `{ error: "tool_failed" }` | any other action throw |

**First tool — `web_search` (Tavily).** Requires `TAVILY_API_KEY` in the service env.
Pure-API, no delegation, no TEXT model. `args: { query }`.

---

## 2. appId → agentId map (FROZEN tinychat entry)

The service credential resolves to an `(appId, agentId)` pair. The map is built from environment at startup; secrets are never hardcoded.

| appId | agentId | Env var holding the secret |
|---|---|---|
| `tinychat` | `92361e74-91ed-43a2-9656-5cc37ff3a07a` | `ELIZA_SERVICE_SECRET` |
| *(second app)* | *(its character agentId)* | *(its own env var)* |

The `tinychat` entry is **frozen** — the agentId `92361e74-91ed-43a2-9656-5cc37ff3a07a` MUST NOT change. It is the character/agent all tinychat users share. To add a second app, push a new entry to the registry in `packages/eliza-service/src/auth/app-registry.ts` with its own `appId`, `agentId`, and secret env var; no existing entry changes.

The agent DID that all users delegate to:

```
did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c
```

This is derived from the `agent.key` file at service boot via `agentIdentityFromFile`. The Layer-2 delegation validation (Milestone C) checks that `delegateDID == agentDID`.

---

## 3. entityId derivation — byte-identical to `@elizaos/core createUniqueUuid`

### 3.1 Algorithm

The entityId for a wallet address is:

```
entityId = stringToUuid(`${address.toLowerCase()}:${agentId}`)
```

where `stringToUuid` is **NOT** a standard `uuidv5` — it uses a quirky version-0 byte twiddling that differs from RFC 4122. Using any standard UUID library (`uuid.v5`, etc.) will produce a different result and silently route the user to the wrong (or empty) memory space.

The exact algorithm for `stringToUuid(target: string)`:

1. If `target` already matches `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` → return it as-is.
2. `escaped = encodeURIComponent(target)`
3. `buf = sha1(escaped)` — take the **first 16 bytes**
4. Mutate:
   - `bytes[8] = (bytes[8] & 63) | 128` — set RFC variant bits
   - `bytes[6] = (bytes[6] & 15) | 0` — **force version nibble to 0** (NOT `| 0x50` as standard UUIDv5 would)
5. Format as `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

The full seed string is `${address.toLowerCase()}:${agentId}` — address first, colon separator, agentId second.

### 3.2 Where the util lives

```
packages/eliza-service/src/entity-id.ts
```

Exports:

- `stringToUuid(target: string | number): string` — the core primitive
- `addressToEntityId(address: string, agentId: string): string` — the consumer-facing function E should call

E must either import this util directly (if the repos share a package) or copy the implementation and pin it with a golden-vector test asserting byte-equality against `@elizaos/core createUniqueUuid`.

### 3.3 Golden vectors (pin these in E's test suite)

**Canary — "hello":**

```
stringToUuid("hello") === "aaf4c61d-dcc5-08a2-9abe-de0f3b482cd9"
```

Note the version nibble `0` in position 15 of the UUID (`08a2` — the `0` is the version). A standard `uuidv5("hello", <ns>)` would give `5` there. This confirms the implementation is NOT RFC uuidv5.

**Lowercase-vs-checksummed parity (PINNED):**

For `agentId = "92361e74-91ed-43a2-9656-5cc37ff3a07a"` and any address:

```
addressToEntityId("0x7d0333579c19e8fa149c2dbf8405cb6f66c373f2", agentId)
=== addressToEntityId("0x7D0333579C19E8Fa149C2dbF8405Cb6f66C373f2", agentId)
```

Both produce the same UUID because `addressToEntityId` lowercases the address before seeding. This must hold; sha1 is case-sensitive and would produce different hashes for different casings.

**Byte-equality against core (required test):**

```ts
import { createUniqueUuid } from "@elizaos/core";
const rtStub = { agentId } as IAgentRuntime;
// Pass the LOWERCASE address to createUniqueUuid (core does not lowercase internally).
expect(addressToEntityId(addrLower, agentId)).toBe(createUniqueUuid(rtStub, addrLower));
```

If this assertion ever fails, E's routing is broken regardless of whether other tests pass.

---

## 4. Address-casing rule (PINNED)

**entityId is always seeded from the lowercased Ethereum address.**

E's app backend receives `req.user.address` from the SIWE→JWT middleware. That address MUST be lowercased before being used as the entityId seed (and before being sent to `eliza-service` in the request body). The delegation's `signed-owner` field is also expected to be lowercased. These must agree:

```
lowercase(req.user.address) == lowercase(delegation.signed-owner address)
```

If the routing key (`entityId` derived from the address in the body) and the delegated-space key (derived from the owner in the delegation) disagree due to casing, `registerDelegation` and the subsequent `clientFor` resolve to different slots in B's entity registry — the user's memory is unreachable.

**Rule:** normalize to lowercase before computing entityId and before forwarding to `eliza-service`. Never send the EIP-55 checksummed form as the identity seed.

---

## 5. Rate-limit semantics

`POST /messages` enforces a per-`(appId, entityId)` fixed-window rate limit before opening the SSE stream.

| Attribute | Value |
|---|---|
| Bucket key | `appId + entityId` |
| Default max | 60 requests per window |
| Default window | 60 000 ms (1 minute) |
| Response on exceed | `429 Too Many Requests` |
| Store | In-memory (see limitation below) |
| Checked | Before the SSE stream opens — the message is never processed if the limit is hit |

**Single-instance limitation:** buckets are in-process and are NOT shared across multiple service instances. If the service scales horizontally, each instance tracks its own counter independently; the effective per-user limit becomes `N × instances`. This is acceptable for the single-process MVP. A shared store (Redis, Upstash, etc.) would be needed for horizontal scale.

The rate limiter is instantiated in `packages/eliza-service/src/rate-limit.ts` (`createRateLimiter`). The default singleton (`defaultRateLimiter`) is used by the server; tests inject a deterministic clock via `createRateLimiter({ now: () => fixedTime })`.

---

## 6. Trust model

Layer-1 (this gate) and Layer-2 (Milestone C's delegation validation) form two independent security boundaries:

**Layer-1 — service credential (what D built):**
- Establishes WHICH app is calling.
- Trusts the app backend to have authenticated its user via SIWE→JWT and to forward an accurate `address` (and therefore `entityId`).
- The credential is symmetric (shared secret); its strength is equivalent to the secrecy of `ELIZA_SERVICE_SECRET`.
- `eliza-service` does NOT re-verify the user's SIWE session — it trusts the app's auth middleware to have done so.

**Layer-2 — per-user delegation (Milestone C, cryptographic backstop):**
- Establishes WHICH user's data the request may access.
- A valid `serializedDelegation` (UCAN/EIP-712 delegation from the user's wallet to the agent DID) is validated on `POST /sessions`: `delegateDID == agentDID`, policy checks, expiry.
- Even if the Layer-1 credential were compromised, the attacker could not read or write another user's data without also possessing a valid delegation signed by that user's wallet private key.

The two layers are cumulative: Layer-1 rejects unauthenticated app calls; Layer-2 rejects unauthorized per-user data access. D adds Layer-1 IN FRONT of C's Layer-2 handlers without modifying them.

---

## Summary checklist for Milestone E

- [ ] Set `ELIZA_SERVICE_SECRET` as an env var on the tinychat backend; send it as `Authorization: Bearer <secret>` on every `eliza-service` call.
- [ ] Derive `entityId` using `addressToEntityId(req.user.address, TINYCHAT_AGENT_ID)` from `packages/eliza-service/src/entity-id.ts` (or a byte-identical copy). Do NOT use a standard `uuidv5` library.
- [ ] Pass the **lowercased** address as the entityId seed; verify the delegation's signed-owner is also lowercased so routing and delegation keys agree.
- [ ] Include a golden-vector test asserting byte-equality against `@elizaos/core createUniqueUuid` and the lowercase-vs-checksummed parity case.
- [ ] Handle `401` (missing/malformed credential) and `403` (wrong credential) from `eliza-service`.
- [ ] Handle `429` (rate limit exceeded) from `POST /messages`.
