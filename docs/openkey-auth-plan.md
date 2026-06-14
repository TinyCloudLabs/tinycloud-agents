# OpenKey Auth Implementation Plan

Status: first implementation slice drafted (config shape + stable agent DID + docs).
Phase 3+ (delegated SQL activation, live OpenKey/passkey proof) is pending.

Companion handoff: `docs/openkey-auth-handoff.md`.

## Goal

Move `tinycloud-agents` from the current MVP auth model, where the agent signs in
with `TINYCLOUD_PRIVATE_KEY` and owns its own TinyCloud space, to a proper user
consent model:

```text
Human signs in with OpenKey/passkey
  -> human owns the TinyCloud memory space
  -> human delegates a narrow SQL policy to a stable agent DID
  -> Eliza memory reads/writes through delegated TinyCloud access
```

The current private-key mode must continue to work. It is useful for local
development, simple single-agent deployments, and regression testing.

## Non-Goals

- Do not ask for, accept, or store a user's main private key.
- Do not replace OpenKey with a wallet-only flow.
- Do not silently fall back to `@elizaos/plugin-sql` when TinyCloud delegated
  auth fails.
- Do not broaden permissions beyond the memory SQL handle unless a later feature
  needs it.
- Do not build a production sidecar before proving the direct delegated client.

## Identity Model

Keep these identities separate:

| Identity | DID shape | Purpose |
| --- | --- | --- |
| Human identity | `did:pkh:eip155:{chainId}:{address}` | The OpenKey-authenticated user and TinyCloud space owner. |
| Agent identity | `did:pkh:eip155:1:{address}` | The stable delegatee that receives user-granted memory access. |
| Runtime session key | `did:key:...#...` | SDK session key used to invoke TinyCloud services. |

The agent must have its own stable DID. If the DID changes on every process
start, existing user delegations will no longer match and
`TinyCloudNode.useDelegation()` should reject them.

The key material behind the agent DID is allowed because it belongs to the agent,
not the user. Treat it as service identity material: stable, rotatable, and
re-delegatable.

## Architecture Decision

Use **Path A: Direct Delegated Agent Client** first.

`@tinycloud/agent-client` already routes all TinyCloud I/O through the
`Transport` interface. Delegated auth should fit below that boundary:

```text
TinyCloudMemoryStorageService
  -> createAgentClient(...)
  -> Session / Worker / SQL helpers
  -> Transport
       private-key mode: TinyCloudNode.signIn() + node.sql
       delegated mode: TinyCloudNode.useDelegation() + delegatedAccess.sql
```

This keeps the Eliza plugin mostly unchanged and avoids prematurely building an
HTTP sidecar. A sidecar can come later if the product needs a separate "Connect
Agent" browser flow.

## Phase 0: Preserve Baseline

Before changing auth:

```sh
bun --bun run build
bun --bun run typecheck
bun --bun run test
TINYCLOUD_LIVE=1 bun --bun run test:live:eliza
```

The non-live baseline was last verified on 2026-06-13:

```sh
bun --bun run build
bun --bun run typecheck
bun --bun run test
```

Do not proceed with auth refactors if the private-key baseline is already red.

## Phase 1: Auth Config Shape

Add an explicit auth union in `packages/agent-client/src/config.ts`.

Proposed public shape:

```ts
type AgentClientAuthConfig =
  | {
      mode?: "private-key";
      privateKey: string;
      prefix?: string;
    }
  | {
      mode: "delegation";
      serializedDelegation: string;
      agentKey?: string;
      agentKeyFile?: string;
    };
```

Keep backward compatibility:

```ts
createAgentClient({ privateKey: "0x..." });
```

should continue to resolve to private-key mode.

Add env/runtime keys in `packages/eliza-plugin-memory/src/config.ts`:

| Key | Mode | Purpose |
| --- | --- | --- |
| `TINYCLOUD_AUTH_MODE` | both | `private-key` or `delegation`; default `private-key` when `TINYCLOUD_PRIVATE_KEY` is present. |
| `TINYCLOUD_PRIVATE_KEY` | private-key | Existing agent-owned TinyCloud space key. |
| `TINYCLOUD_AGENT_KEY` | delegation | Stable agent identity key material. |
| `TINYCLOUD_AGENT_KEY_FILE` | delegation | File path for stable agent identity key material. |
| `TINYCLOUD_DELEGATION` | delegation | Serialized portable delegation. |
| `TINYCLOUD_DELEGATION_FILE` | delegation | File path containing serialized portable delegation. |
| `TINYCLOUD_HOST` | both | TinyCloud node host. |
| `TINYCLOUD_DB_HANDLE` | both | Full SQL db handle, default `xyz.tinycloud.eliza/memory`. |

Expected tests:

- private-key config still resolves exactly as before.
- delegated mode requires a delegation source.
- delegated mode requires exactly one stable agent key source.
- missing or conflicting inputs produce actionable errors.
- errors never include secret key material or authorization headers.

## Phase 2: Stable Agent DID

Add a small helper owned by `agent-client` to load the agent identity.

Requirements:

- Load from direct env string or a file path.
- Normalize key material consistently.
- Expose the resulting DID before a user creates a delegation.
- Never generate a new persistent agent DID silently during delegated mode.

Open implementation choice:

- If `TinyCloudNode` can be initialized with stable session key material, use
  session-only mode and make the user delegate directly to that session DID.
- If the SDK only supports stable DID through wallet/private-key mode, use the
  agent key as a wallet-mode identity, sign in the agent, and activate a
  user-granted delegation targeted at that agent DID.

The implementation must prove which path the current SDK supports. The rule is
simple: the DID advertised to the user must equal the DID used by
`TinyCloudNode.useDelegation()`.

Expected tests:

- same configured agent key yields the same DID across process starts.
- different configured agent key yields a different DID.
- delegated boot refuses to proceed when it cannot determine the stable agent
  DID.

## Phase 3: Delegated Transport

Add a delegated transport without changing the public SQL API.

Candidate files:

- `packages/agent-client/src/delegated-transport.ts`
- `packages/agent-client/src/node-sdk-transport.ts`
- `packages/agent-client/src/client.ts`
- `packages/agent-client/src/transport.ts`

Delegated transport behavior:

1. Deserialize the portable delegation with `@tinycloud/node-sdk`.
2. Validate local shape before activation:
   - has owner address
   - has delegate DID
   - has expiry
   - includes a SQL resource for `dbHandle`
3. Create/load the stable agent `TinyCloudNode`.
4. Activate with `TinyCloudNode.useDelegation(...)`.
5. Store the resulting `DelegatedAccess`.
6. Implement `query`, `execute`, and `batch` using `delegatedAccess.sql.db(dbHandle)`.

The current `Session` class assumes a refreshable sign-in lifecycle. Delegated
mode may not be refreshable in the same way, so add a deliberate policy:

- `signIn()` means "activate the delegation."
- Proactive refresh can be disabled for delegated mode or changed to
  re-activation from the same serialized delegation.
- On auth-like failures, retry activation once, then surface a typed auth error.

Expected tests:

- delegated transport activates once and reuses delegated SQL.
- delegated SQL maps SDK result errors into transport errors without leaking
  sensitive headers.
- auth-like delegated failures trigger one reactivation and one retry.
- private-key transport behavior is unchanged.

## Phase 4: Delegation Policy Validation

Start narrow:

| Service | Path | Actions |
| --- | --- | --- |
| `tinycloud.sql` | `xyz.tinycloud.eliza/memory` | `tinycloud.sql/read`, `tinycloud.sql/write`, `tinycloud.sql/admin` |
| `tinycloud.capabilities` | empty path | `tinycloud.capabilities/read` |

Validation should reject:

- wrong delegatee
- expired grant
- malformed serialized delegation
- missing SQL resource
- insufficient SQL actions
- wrong memory db handle

Policy hash support can be added now or immediately after direct mode:

- Derive a stable hash from requested permissions and agent DID.
- Store/report the hash alongside delegation status.
- Report `stale` when the configured policy no longer matches the stored grant.

Expected tests:

- wrong delegatee is rejected before SQL use.
- insufficient actions are rejected with a clear error.
- expired grant is reported as expired.
- policy mismatch is reported as stale when policy hashes are implemented.

## Phase 5: Eliza Plugin Integration

Update `packages/eliza-plugin-memory/src/config.ts` to resolve either auth mode.

Keep the storage service flow intact:

```text
start()
  -> resolveMemoryClientConfig(runtime)
  -> createAgentClient(config)
  -> signIn()
  -> ensureSchema()
```

The storage implementation should not branch on auth mode. Auth selection belongs
in config and `agent-client`.

Expected tests:

- existing missing `TINYCLOUD_PRIVATE_KEY` fail-open test is updated so it only
  applies to private-key mode.
- delegated mode can start with injected fake/delegated client config.
- read fail-open and write fail-closed behavior remains unchanged.

## Phase 6: Consent and Delivery Harness

First harness can be manual and boring.

Flow:

1. Start a tiny local script that prints:
   - agent DID
   - requested permissions
   - suggested OpenKey delegation URL or instructions
2. User signs in through OpenKey/passkey.
3. Browser/TinyCloudWeb creates a delegation to the agent DID.
4. Serialized delegation is written to a file or pasted into env.
5. Eliza boots in delegated mode.

Do this before a sidecar. It gives correctness without committing to UX.

Minimum script outputs:

- agent DID
- TinyCloud host
- db handle
- required permission JSON
- delegation file path expected by the runtime

Expected tests:

- script prints stable DID for a stable agent key.
- script refuses to run if it would generate an unstable delegation target.
- generated permission payload matches the policy validator.

## Phase 7: Live Delegated Scenario

Add a live/manual scenario beside the existing private-key scenario.

Acceptance flow:

1. Human signs in with OpenKey.
2. Human creates or restores a TinyCloud session.
3. Human delegates only the memory SQL policy to the stable agent DID.
4. Agent writes a long-term memory and session summary through delegated SQL.
5. A separate user-authorized client reads the same rows from the user's space.
6. Fresh agent process restores from the same delegation file and hydrates memory.
7. Wrong delegatee, expired grant, and insufficient policy fixtures fail clearly.

This should be documented as manual at first. WebAuthn automation is useful later,
but it should not block the correctness pass.

## Phase 8: Documentation Updates

Update:

- `README.md`
- `packages/eliza-plugin-memory/README.md`
- `docs/hydration.md`
- `docs/openkey-auth-handoff.md` if facts change during implementation

Docs should say:

- Private-key mode stores memory in an agent-owned space.
- Delegated mode stores memory in the user's TinyCloud space.
- The agent has a stable DID.
- The agent key is not the user's key.
- OpenKey proves the user and signs consent; TinyCloud delegation grants the
  actual memory capability.

## Acceptance Criteria

Proper auth is ready when all of this is true:

- Existing private-key build, typecheck, unit tests, and live Eliza scenario still
  pass.
- Delegated mode does not require the user's private key.
- Agent DID is stable across process restarts.
- User can delegate only `xyz.tinycloud.eliza/memory` SQL access to that DID.
- Agent writes long-term memories and session summaries through delegated access.
- A user-authorized workflow can read those same rows from the user's space.
- Fresh agent process can restore the delegated grant and hydrate memories.
- Wrong delegatee, expired grant, insufficient policy, and malformed delegation
  are rejected clearly.
- No auth failure silently falls back to local/plugin SQL.

## Open Questions

1. Should delegated memory always live in the user's default TinyCloud space, or
   should OpenKey/TinyCloud create a dedicated app-specific memory space/prefix?
2. Should the first consent harness use an OpenKey callback URL, paste-code flow,
   or plain delegation file handoff?
3. Should policy hash and status live in `agent-client`, a future sidecar, or both?
4. Is `tinycloud.sql/admin` truly required after initial schema creation, or can a
   later steady-state mode run with read/write only?
5. Does current `TinyCloudNode` expose a supported way to persist the exact
   session DID used in session-only delegation mode?

## Recommended First PR

Keep the first PR small:

1. Add auth union config with backward-compatible private-key defaults. ✓ done
2. Add delegated-mode config parsing and tests. ✓ done
3. Add stable agent DID helper and tests. ✓ done
4. Add docs for the intended env surface. ✓ done
5. Do not activate delegated SQL yet. ✓ (correctly deferred)

That PR makes the new auth shape explicit without risking the working memory
path. The second PR adds delegated transport activation once stable DID behavior
is proven against the SDK.

**What the first PR does NOT include:**
- Delegated SQL activation (`TinyCloudNode.useDelegation`) — Phase 3.
- Live OpenKey/passkey proof or consent harness — Phase 6.
- Auth sidecar — Phase 6+ / product decision.
- Revocation or policy-hash status — Phase 4+.

The live scenario (`TINYCLOUD_LIVE=1 bun --bun run test:live:eliza`) continues
to test private-key mode only. Delegated live tests are Phase 7 work.
