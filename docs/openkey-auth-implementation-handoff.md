# OpenKey Auth Implementation Handoff

Date: 2026-06-13

Status: first implementation slice is drafted, audited, and regression-green.
Delegated SQL activation is not implemented yet.

## TL;DR

This branch now has the first OpenKey/user-delegation auth groundwork:

- `@tinycloud/agent-client` has a private-key/delegation auth config union.
- Delegation mode config is parsed and validated, but not activated.
- Stable agent DID helpers derive `did:pkh:eip155:1:{address}` from explicit
  agent-owned key material.
- `@tinycloud/eliza-plugin-memory` can resolve both private-key and delegation
  env surfaces.
- Docs explain the two modes and clearly state delegated SQL is still Phase 3.

The current shipped behavior remains private-key mode. If delegation mode reaches
`createAgentClient`, it intentionally throws:

```text
Delegation transport not yet implemented. Use private-key mode or omit the mode field.
```

Do not treat delegated SQL, OpenKey/passkey consent, sidecar auth, revocation, or
policy hash support as done.

## Current Repo State

Repo: `/Users/roman/Documents/GitHub/tinycloud-agents`
Branch: `feature/mvp`

Modified files:

- `README.md`
- `docs/openkey-auth-handoff.md`
- `packages/agent-client/src/client.ts`
- `packages/agent-client/src/config.test.ts`
- `packages/agent-client/src/config.ts`
- `packages/agent-client/src/index.ts`
- `packages/eliza-plugin-memory/README.md`
- `packages/eliza-plugin-memory/package.json`
- `packages/eliza-plugin-memory/src/__tests__/fail-open.test.ts`
- `packages/eliza-plugin-memory/src/config.ts`
- `packages/eliza-plugin-memory/src/index.ts`

New files:

- `docs/openkey-auth-plan.md`
- `docs/openkey-auth-implementation-handoff.md`
- `packages/agent-client/src/agent-identity.test.ts`
- `packages/agent-client/src/agent-identity.ts`
- `packages/eliza-plugin-memory/src/config.test.ts`

Generated audit scratch `.openkey-auth-audit/` was removed after the workflow
finished.

## Workflow Status

Smithers workflow: `tinycloud-agents-openkey-auth`

Original run:

- `161a35db-8471-4884-9d2d-176bd0e5c3ba`
- Initially failed at `tc-agents-openkey-auth:audit-write` because Claude hit a
  monthly spend limit.
- Later resumed successfully with `smithers retry-task`.
- Intentionally cancelled after two clean audit/fix/regression rounds because
  the workflow gate expected a 0-100 score while the auditor initially returned
  `9` on a 0-10 scale, causing extra audit rounds.

Successful replay:

- `bfa1065e-a163-4177-9def-76053d92145c`
- Replayed from parent frame 21 with `minScore: 9`.
- Finished successfully.
- Final audit: `happy: true`, score `94`, no blocker or major findings.

The Smithers workflow in `/Users/roman/Documents/GitHub/development` has also
been patched so future runs normalize audit scores whether the auditor returns
`9` or `94`.

## Verification

Final clean local gate passed after removing audit scratch:

```sh
TINYCLOUD_AGENTS_CHECK_MODE=regression \
  bun /Users/roman/Documents/GitHub/development/.smithers/scripts/tinycloud-agents-openkey-auth-regression.mjs
```

That gate includes:

- branch guard: `feature/mvp`
- no production branch guard
- plan/handoff existence checks
- `git diff --check`
- package-source guard against `useDelegation(`
- `bun --bun run build`
- `bun --bun run typecheck`
- `bun --bun run test`

Final test count reported by the gate:

```text
53 pass
0 fail
106 expect() calls
```

Live OpenKey/passkey and `TINYCLOUD_LIVE=1` delegated auth were not run. The
existing live path still covers private-key mode only.

## Implemented Details

### Agent Client

Files:

- `packages/agent-client/src/config.ts`
- `packages/agent-client/src/config.test.ts`
- `packages/agent-client/src/client.ts`
- `packages/agent-client/src/agent-identity.ts`
- `packages/agent-client/src/agent-identity.test.ts`
- `packages/agent-client/src/index.ts`

What changed:

- Added `AgentClientAuthConfig` union.
- Preserved `createAgentClient({ privateKey })` compatibility.
- Added `DelegationAgentClientConfig`.
- Added `resolveDelegationConfig`.
- Delegation config accepts exactly one delegation source:
  `serializedDelegation` or `delegationFile`.
- Delegation config accepts exactly one stable agent key source:
  `agentKey` or `agentKeyFile`.
- Added stable agent identity helpers:
  `normalizeAgentKey`, `agentIdentityFromKey`, `agentIdentityFromFile`.
- Exported new types/helpers from the package root.
- `createAgentClient` rejects delegation mode with the explicit Phase 3 guard.

Important: `createAgentClient` currently throws before calling
`resolveDelegationConfig` for direct delegation-mode callers. The Eliza plugin
validates delegation config before it reaches `createAgentClient`. Phase 3 should
wire `resolveDelegationConfig` into the delegated transport path.

### Eliza Plugin

Files:

- `packages/eliza-plugin-memory/src/config.ts`
- `packages/eliza-plugin-memory/src/config.test.ts`
- `packages/eliza-plugin-memory/src/__tests__/fail-open.test.ts`
- `packages/eliza-plugin-memory/README.md`
- `packages/eliza-plugin-memory/package.json`
- `packages/eliza-plugin-memory/src/index.ts`

What changed:

- Added `TINYCLOUD_AUTH_MODE=private-key|delegation`.
- Kept `TINYCLOUD_PRIVATE_KEY` behavior for private-key mode.
- Added delegation env surface:
  `TINYCLOUD_DELEGATION`, `TINYCLOUD_DELEGATION_FILE`,
  `TINYCLOUD_AGENT_KEY`, `TINYCLOUD_AGENT_KEY_FILE`.
- Kept `TINYCLOUD_HOST`, `TINYCLOUD_NODE_HOST`, `TINYCLOUD_DB_HANDLE`, and
  `TINYCLOUD_SPACE_PREFIX` behavior.
- Added config tests for private-key mode, delegation mode, missing/conflicting
  inputs, legacy host alias behavior, and secret-non-leakage.
- Added fail-open test proving delegation mode currently rejects with the
  intentional "not yet implemented" error.
- Adjusted docs/metadata so generic descriptions say "TinyCloud space" instead
  of implying every mode is user-owned.

## Important Non-Goals Still Holding

The first slice intentionally does not:

- call `TinyCloudNode.useDelegation`
- deserialize or activate portable delegations
- construct `DelegatedAccess`
- add an auth sidecar
- run OpenKey/passkey consent
- implement revocation status
- implement policy hash or stale-policy detection
- broaden permissions beyond the memory SQL handle
- ask for, accept, or store a user's main private key

The regression script enforces the first item with:

```sh
! rg -n 'useDelegation\s*\(' packages/agent-client/src packages/eliza-plugin-memory/src
```

## Known Minor Findings

The final audit had no blocker or major findings. It left Phase 3-oriented notes:

- `createAgentClient` should call `resolveDelegationConfig` once the delegated
  transport exists, so direct callers get the same actionable validation as
  Eliza callers.
- Delegation XOR validation is currently duplicated in `agent-client` and
  `eliza-plugin-memory`; Phase 3 should consider centralizing it.
- `ResolvedDelegationConfig` stores raw `serializedDelegation` and `agentKey`
  strings. Before delegated transport ships, consider a redaction strategy or
  `toJSON` guard so accidental logs cannot expose key material.
- Add SDK/transport auth-error tests in Phase 3 to prove no Authorization header
  or secret material leaks through error messages.

## Recommended Next PR: Phase 3 Delegated Transport

Start from `docs/openkey-auth-plan.md`, Phase 3.

Suggested implementation order:

1. Add `packages/agent-client/src/delegated-transport.ts`.
2. Deserialize portable delegation using the current `@tinycloud/node-sdk` API.
3. Load stable agent identity using the existing helper.
4. Validate:
   - delegation is present and well-formed
   - delegate DID matches the stable agent DID
   - expiry is present and not expired
   - SQL resource includes `dbHandle`
   - actions cover the memory needs
5. Activate with `TinyCloudNode.useDelegation(...)`.
6. Implement the existing `Transport` API using `delegatedAccess.sql.db(dbHandle)`.
7. Decide delegated session lifecycle:
   - `signIn()` means "activate delegation"
   - proactive refresh disabled or re-activation from serialized delegation
   - auth-like failures retry activation once, then surface typed auth error
8. Keep `TinyCloudMemoryStorageService` storage logic mode-agnostic.

Expected tests for the next PR:

- delegated transport activates once and reuses delegated SQL
- wrong delegatee is rejected before SQL use
- expired delegation is rejected clearly
- missing SQL resource or insufficient action is rejected clearly
- SDK auth/request errors are wrapped without leaking headers/secrets
- private-key transport behavior remains unchanged

## Smithers Workflow Notes

Workflow files live in `/Users/roman/Documents/GitHub/development`:

- `.smithers/workflows/tinycloud-agents-openkey-auth.tsx`
- `.smithers/scripts/tinycloud-agents-openkey-auth-regression.mjs`
- `.smithers/scripts/read-audit.mjs`

Useful commands:

```sh
smithers inspect bfa1065e-a163-4177-9def-76053d92145c
smithers logs bfa1065e-a163-4177-9def-76053d92145c
smithers workflow inspect tinycloud-agents-openkey-auth
```

Future runs should no longer loop just because an audit returns `9` instead of
`90`; the workflow normalizes 0-10 scores to 0-100 internally.

## Before Handing Off Further

Recommended final checks before staging/commit:

```sh
git diff --check
bun --bun run build
bun --bun run typecheck
bun --bun run test
```

Do not claim live delegated OpenKey auth until Phase 3+ and a real OpenKey/passkey
consent harness pass.
