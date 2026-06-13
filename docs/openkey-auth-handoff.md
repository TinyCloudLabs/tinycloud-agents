# OpenKey Auth Handoff

Status: ready for an agent to start the proper-auth pass.

This handoff is for the next agent working on TinyCloud auth for
`tinycloud-agents`. The memory stack itself is implemented and tested against the
current MVP auth model: a dedicated agent-owned private key. The missing work is
to replace or extend that with the real OpenKey/user-to-agent delegation flow so
an Eliza agent can operate on a user-authorized TinyCloud space without ever
asking for the user's private key.

## TL;DR

- Current path works:
  `Eliza Runtime -> @tinycloud/eliza-plugin-memory -> @tinycloud/agent-client -> @tinycloud/node-sdk -> https://node.tinycloud.xyz`.
- Current auth shape is intentionally primitive:
  `TINYCLOUD_PRIVATE_KEY` signs in an agent-owned TinyCloud space.
- Proper auth should use OpenKey/passkey for the human identity, then a TinyCloud
  portable delegation from that user to a stable agent/backend DID.
- OpenKey is not the TinyCloud capability grant. OpenKey answers "who is the
  user and can they sign?". The TinyCloud delegation answers "what can this
  agent do in this user's TinyCloud space?".
- Do not ask for or store a user's main private key. The production path should
  be passkey/OpenKey plus delegated access.

## Current TinyCloud Agents Baseline

Repo: `tinycloud-agents`, branch `feature/mvp`.

Implemented packages:

- `packages/agent-client`
  - Host-framework-agnostic TinyCloud client.
  - Wraps `@tinycloud/node-sdk`.
  - Owns session lifecycle, serialized worker, request timeout, write queue,
    circuit breaker, SQL helpers, and schema bootstrap.
  - Today it requires `AgentClientConfig.privateKey`.

- `packages/eliza-plugin-memory`
  - elizaOS 2.0 plugin.
  - Registers `TinyCloudMemoryStorageService` as the `memoryStorage` service.
  - Must be listed before `@elizaos/plugin-sql`.
  - Requires `advancedMemory: true`.
  - Stores long-term memories and session summaries in SQL db handle
    `xyz.tinycloud.eliza/memory`.

Current config:

```env
TINYCLOUD_PRIVATE_KEY=0x...
TINYCLOUD_HOST=https://node.tinycloud.xyz
TINYCLOUD_DB_HANDLE=xyz.tinycloud.eliza/memory
TINYCLOUD_SPACE_PREFIX=
```

Verification already passing:

```sh
bun --bun run build
bun --bun run typecheck
bun --bun run test
TINYCLOUD_LIVE=1 bun --bun run test:live:eliza
```

The live Eliza scenario boots a real `AgentRuntime`, writes memory through
Eliza's `MemoryService`, reads the same rows with a separate TinyCloud client,
then boots a fresh runtime and verifies hydration.

Known auth gap:

- It proves the memory substrate, Eliza slot ownership, SQL schema, direct
  workflow read, and hydration.
- It does not prove OpenKey/passkey login, user consent, delegated user-space
  access, grant expiry, revocation, or multi-user isolation.

## Mental Model For Proper Auth

There are four identities/sessions to keep distinct:

1. **Human OpenKey account**
   - User signs in with passkey/OpenKey.
   - OpenKey can expose OAuth tokens/JWTs and can sign SIWE messages through a
     managed or linked Ethereum key.

2. **Human TinyCloud space**
   - The user's TinyCloud data container.
   - Identified by a `tinycloud:pkh:eip155:...:<prefix>` space id.
   - Created and accessed through SIWE/ReCap capabilities.

3. **Agent/backend DID**
   - Stable operational identity for the Eliza agent or a small auth sidecar.
   - This is the delegation recipient.
   - It should not be the user's DID.
   - It still needs stable key material, but that key belongs to the agent and
     only identifies the delegation recipient. It is not authority over the
     user's TinyCloud data by itself.

4. **Delegated TinyCloud access**
   - A portable delegation from the human's TinyCloud authority to the agent DID.
   - Delivered to the agent/backend.
   - Activated with `TinyCloudNode.useDelegation()` or equivalent.
   - Cached/stored with expiry and policy metadata.

The target architecture is:

```text
Browser / OpenKey
  -> TinyCloudWeb sign-in
  -> create/materialize delegation to agent DID
  -> POST serialized delegation to agent/backend
  -> agent/backend validates owner + delegatee + policy
  -> TinyCloudNode.useDelegation(serialized)
  -> @tinycloud/agent-client uses delegated SQL access
  -> Eliza MemoryService reads/writes memories
```

## Source Map

Use these sources first. They are already present in the sibling development
workspace.

### OpenKey

Local repo: `/Users/roman/Documents/GitHub/development/repositories/openkey`

Read:

- `README.md`
  - OpenKey is an OAuth-compatible passkey-first identity provider.
  - It manages Ethereum keys in a TEE.
  - Local dev: `bun install`, `bun db:push`, `bun dev`.
  - API default: `http://localhost:3000`.
  - Web default: `http://localhost:5173`.
  - Portless HTTPS option: `bun dev:portless`, serving
    `https://openkey.localhost` and `https://api.openkey.localhost`.

- `apps/api/src/auth.ts`
  - better-auth config.
  - Passkey/email/Google/OAuth provider setup.

- `apps/api/src/middleware/oauth.ts`
  - `requireSessionOrOAuthBearer`.
  - Important because backend routes can accept either browser session cookie or
    OAuth bearer token.

- `apps/api/src/routes/keys.ts`
  - Key signing endpoints:
    `POST /api/keys/:keyId/sign`,
    `POST /api/keys/:keyId/sign-typed-data`.

- `apps/api/src/routes/delegate.ts`
  - Current OpenKey-backed TinyCloud delegation route.
  - `POST /api/delegate` handles managed keys: unseals key in TEE, signs SIWE,
    activates delegation with TinyCloud host, returns delegation material.
  - `POST /api/delegate/prepare` prepares a SIWE ReCap message for an external
    wallet/key.
  - `POST /api/delegate/complete` completes external-key delegation with a
    wallet signature.
  - Supports caller-supplied `permissions` and `expiry`.
  - Enforces single-space non-raw permission groups.

- `apps/web/src/routes/delegate/+page.svelte`
  - Browser consent UI for CLI-style delegation.
  - Reads query params: `did`, `jwk`, `callback`, `host`, `permissions`,
    `expiry`.
  - Lets the user sign in with passkey, pick/generate a key, review requested
    permissions, then returns delegation data through callback or paste code.

### TinyCloud Web SDK / Node SDK

Local repo: `/Users/roman/Documents/GitHub/development/repositories/web-sdk`

Read:

- `packages/web-sdk/src/modules/tcw.ts`
  - `TinyCloudWeb.signIn()`.
  - `TinyCloudWeb.restoreSession(address)`.
  - `TinyCloudWeb.createDelegation(...)`.
  - `TinyCloudWeb.materializeDelegation(...)`.
  - `TinyCloudWeb.delegateTo(...)`.
  - `TinyCloudWeb.useDelegation(...)`.

- `packages/web-sdk/src/delegation.ts`
  - `serializeDelegation(...)`.
  - `deserializeDelegation(...)`.
  - Portable delegation transport shape.

- `packages/node-sdk/src/TinyCloudNode.ts`
  - `TinyCloudNode.useDelegation(...)`.
  - This returns `DelegatedAccess`.

- `packages/node-sdk/src/DelegatedAccess.ts`
  - The delegated `kv`, `sql`, and `duckdb` service surface.

- `packages/node-sdk/src/delegation.ts`
  - Node-side `PortableDelegation`, `serializeDelegation`, and
    `deserializeDelegation`.

Key gotcha:

- In session-only mode, `useDelegation()` requires the delegation's `delegateDID`
  to match the session key DID.
- In wallet/signed-in mode, it can create a SIWE sub-delegation from the current
  session.

### TinyBoilerplate

Local repo: `/Users/roman/Documents/GitHub/development/repositories/tinyboilerplate`

This repo has the closest complete app pattern for real auth.

Read:

- `CLAUDE.md`
  - High-level app creation contract.
  - Browser signs in user with OpenKey/TinyCloud.
  - Backend has its own operational identity.
  - Browser obtains a user-owned delegation to the backend.
  - `/api/server-info` advertises backend DID, policy hash, expiry, and requested
    permissions.

- `packages/client/src/openkey.ts`
  - `OpenKeyEIP1193Provider`.
  - Converts OpenKey signing into the EIP-1193 provider shape that
    `TinyCloudWeb` expects.

- `packages/client/src/tinycloud.ts`
  - `createTinyCloudWeb(...)`.
  - `createAndSignIn(...)`.
  - `restoreTinyCloudWebSession(...)`.

- `packages/client/src/delegation.ts`
  - `createManifestDelegation(...)`.
  - Uses `TinyCloudWeb.materializeDelegation(...)` or `delegateTo(...)`.
  - Serializes single or multi-space delegation bundles.
  - `sendDelegation(...)`, `checkDelegationStatus(...)`, `revokeDelegation(...)`.

- `packages/core/src/index.ts`
  - `ServerInfo`, `DelegatingServerInfo`, `ServerInfoPermission`.
  - `StoredDelegation`.
  - `DelegationStatus = "active" | "expired" | "none" | "stale"`.
  - `deriveApiHost(...)`.

- `templates/app-starter/backend/src/routes/delegations.ts`
  - Server-side delegation acceptance.
  - Validates authenticated user matches delegation owner.
  - Validates delegation delegatee matches backend DID.
  - Validates granted resources cover backend policy.
  - Activates with `TinyCloudNode.useDelegation(...)`.
  - Stores delegation and caches delegated access.

- `templates/app-starter/backend/src/portable-delegation.ts`
  - Deserializes single delegations and `tinycloud.delegation-bundle`.
  - Extracts identity, expiry, and resources.
  - Activates multi-resource grants and routes KV access by prefix.

- `packages/server/src/delegation-store.ts`
  - Persists serialized delegation plus metadata.

- `packages/server/src/delegation-cache.ts`
  - In-memory delegated access cache.

### Agent Runtime / Sidecar Pattern

Local path:
`/Users/roman/Documents/GitHub/development/repositories/tinyboilerplate/packages/agent-runtime`

Read:

- `packages/agent-runtime/docker/README.md`
  - A small `delegation-endpoint` sidecar receives serialized delegations on
    `:4097`.
  - It activates via `node.useDelegation()`.
  - It writes a normal `tc` profile into `/root/.tinycloud/profiles/default/`.
  - It exposes `/health`, `/delegation`, `/refresh`.

This is useful prior art if you choose an auth sidecar for Eliza rather than
embedding delegation receipt directly into the plugin.

### Existing Architecture Notes

Local docs:

- `/Users/roman/Documents/GitHub/development/docs/delegation-architecture.md`
  - Server-as-delegated-actor model.
  - Server/agent has its own DID.
  - User creates delegation to that DID.
  - Server stores delegation per user.
  - On expiry, server prompts re-delegation.

- `/Users/roman/Documents/GitHub/development/docs/agent-surface-recalibration-notes.md`
  - Manifest v1 and `tc auth request` substrate.
  - Runtime grants stored in
    `~/.tinycloud/profiles/<profile>/additional-delegations.json`.
  - Sidecar `/info` + `/delegation` pattern.
  - Per-space ability support.

- `/Users/roman/Documents/GitHub/development/repositories/tinycloud-node/docs/delegation-flow.md`
  - TinyCloud SIWE root and UCAN/portable delegation hierarchy.

- `/Users/roman/Documents/GitHub/development/repositories/tinycloud-node/docs/sharing-links-flow.md`
  - Portable delegation serialization/activation/revocation patterns.

## Recommended Implementation Shape

There are two plausible integration paths. Prefer the first unless product needs
the sidecar.

### Path A: Direct Delegated Agent Client

Extend `@tinycloud/agent-client` to support delegated auth in addition to
private-key auth.

Proposed config shape:

```ts
type AgentClientAuth =
  | {
      mode: "private-key";
      privateKey: string;
      prefix?: string;
    }
  | {
      mode: "delegation";
      serializedDelegation: string;
      agentPrivateKey: string;
      host?: string;
    };
```

Implementation idea:

1. Keep the existing private-key path unchanged.
2. Add a `DelegatedNodeSdkTransport` or generalize `NodeSdkTransport`.
3. On sign-in/activation:
   - Create/load a stable agent identity from `agentPrivateKey` or an explicit
     agent key file.
   - Deserialize the portable delegation.
   - Activate with `TinyCloudNode.useDelegation(...)`.
   - Use returned `DelegatedAccess.sql` instead of `node.sql`.
4. Keep the public SQL/client surface unchanged so
   `TinyCloudMemoryStorageService` does not need to care which auth mode is
   active.

Likely edge:

- `useDelegation()` delegatee matching means the agent DID used in the user's
  delegation must be the same DID the runtime uses when activating. Do not
  generate a new session key every process start unless the delegation targets
  that key and can be refreshed.
- `agentPrivateKey` is acceptable here only because it is the agent's identity
  key, not the user's account key. Treat it like a low-value service key and
  rotate/re-delegate if it is lost.

### Path B: Auth Sidecar

Run a tiny local service beside Eliza:

- `GET /info`
  - Returns agent DID, name, expiry, policy hash, and requested TinyCloud
    permissions.
- `POST /delegation`
  - Accepts `{ serialized }`.
  - Validates owner/delegatee/policy.
  - Activates and writes either:
    - a local file consumed by `@tinycloud/agent-client`, or
    - a normal `tc` profile compatible with the existing sidecar pattern.
- `GET /delegation`
  - Returns status: `none`, `active`, `expired`, or `stale`.

Use this if the product flow wants a browser "Connect Agent" step independent of
Eliza's process lifecycle.

## Permission Policy For Eliza Memory

The current memory schema needs SQL read/write/admin for the app db handle:

- service: `tinycloud.sql`
- path/db handle: `xyz.tinycloud.eliza/memory`
- actions:
  - `tinycloud.sql/read`
  - `tinycloud.sql/write`
  - `tinycloud.sql/admin`

It may also need:

- `tinycloud.capabilities/read` for capability introspection.

Start narrow. Do not request broad KV/SQL for all paths unless the implementation
actually needs it.

Open question to settle before coding:

- Should the delegated memories live in the user's normal TinyCloud space under
  `xyz.tinycloud.eliza/memory`, or should the user delegate a separate
  app-specific memory space/prefix to the agent?

Current MVP stores memories in the agent-owned space. Proper auth probably wants
user-owned memory so another workflow can read it after user consent. That is the
whole point of replacing private-key auth.

## Suggested Work Plan

1. **Onboard on primitives**
   - Read the source map above.
   - Run current `tinycloud-agents` verification to establish baseline.

2. **Pick the auth transport**
   - Direct delegated client is probably smallest.
   - Sidecar is better if a browser needs to connect to a long-running local
     agent.

3. **Add auth-mode types without changing behavior**
   - Preserve current `TINYCLOUD_PRIVATE_KEY` path.
   - Add explicit delegated mode config and tests around config resolution.

4. **Activate delegated SQL in `agent-client`**
   - Deserialize portable delegation.
   - Activate via `TinyCloudNode.useDelegation(...)`.
   - Adapt `DelegatedAccess.sql.db(dbHandle)` or equivalent to the existing
     `Transport` interface.

5. **Add delivery/restore mechanism**
   - For direct mode, read `TINYCLOUD_DELEGATION_FILE` or
     `TINYCLOUD_DELEGATION`.
   - For sidecar mode, persist serialized delegation plus metadata and expose
     status.

6. **Build an OpenKey/TinyCloud consent harness**
   - Browser flow: OpenKey passkey -> TinyCloudWeb sign-in -> delegation to
     agent DID -> handoff to runtime.
   - For automation, keep a manual real-auth path first. WebAuthn automation is
     fragile and local-origin sensitive.

7. **Extend live scenarios**
   - Keep current private-key scenario.
   - Add delegated scenario:
     user/agent identities are distinct, agent writes through delegation, direct
     user/workflow client reads the result.

## Acceptance Test Matrix

Minimum tests before calling proper auth ready:

- Existing offline tests pass.
- Existing `TINYCLOUD_LIVE=1 bun --bun run test:live:eliza` private-key scenario
  still passes.
- OpenKey login/signing path can create or restore a user TinyCloud session.
- User can create a delegation to a stable agent DID with only the memory policy.
- Agent can write a long-term memory and session summary through delegated SQL.
- A separate workflow/client using the user's TinyCloud authority can read the
  same rows.
- Fresh agent process can restore the delegated grant and hydrate memories.
- Wrong delegatee is rejected.
- Wrong owner/authenticated user is rejected.
- Insufficient policy is rejected.
- Expired grant reports `expired`, not a generic failure.
- Policy hash change reports `stale`.
- Revoked/removed grant stops reads and writes.
- Two users' delegated memories do not cross-contaminate.

Nice-to-have tests:

- Multi-space delegation bundle activation if memories ever span multiple
  spaces/resources.
- Local OpenKey portless HTTPS path.
- CLI/paste-code fallback if browser callback cannot reach the agent.
- Full LLM-driven Eliza turn that causes the evaluator to extract a memory,
  beyond the current `MemoryService` boundary test.

## Local Dev Commands

OpenKey:

```sh
cd /Users/roman/Documents/GitHub/development/repositories/openkey
bun install
bun db:push
bun dev
```

OpenKey with trusted local HTTPS:

```sh
cd /Users/roman/Documents/GitHub/development/repositories/openkey
cp .env.portless.example .env.portless
bun db:push
bun dev:portless
```

TinyCloud agents:

```sh
cd /Users/roman/Documents/GitHub/tinycloud-agents
bun install --frozen-lockfile
bun --bun run build
bun --bun run typecheck
bun --bun run test
TINYCLOUD_LIVE=1 bun --bun run test:live:eliza
```

TinyBoilerplate reference checks:

```sh
cd /Users/roman/Documents/GitHub/development/repositories/tinyboilerplate
bun install --frozen-lockfile
bun run build
bun run test
```

## Pitfalls

- Do not ask for the user's private key. For a real user account, use OpenKey and
  delegation.
- Do not conflate OpenKey OAuth/JWT with TinyCloud capability grants.
- Do not generate a new agent DID after the user has delegated to the old one.
- Do not silently fall back to plugin-sql. The current plugin intentionally owns
  the `memoryStorage` slot.
- Do not use `namespace` or `orbit` terminology. Use `space`.
- Do not request broad app data access by default. Start with the memory SQL
  policy and expand only when a workflow needs it.
- OpenKey WebAuthn local testing needs `http://localhost` or trusted HTTPS.
  A browser certificate warning can break passkeys.
- `@elizaos/plugin-sql@2.0.0-beta.1` has a Bun export wart: package import can
  point at a missing `./src/index.ts`; the live scenario harness has a fallback
  to the shipped node dist.

## Current Readiness Statement

Everything below auth is ready to start testing proper auth against:

- Eliza runtime integration.
- TinyCloud memory storage service ownership.
- SQL schema and query behavior.
- Separate workflow reads.
- Fresh-runtime hydration.
- Live prod TinyCloud node path at `https://node.tinycloud.xyz`.

The next work should focus on identity, consent, delegation materialization,
delegation activation, and lifecycle handling. Once those pass the acceptance
matrix above, this becomes battle-ready for the auth layer.
