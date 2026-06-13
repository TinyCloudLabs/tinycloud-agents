# Phase 5 — Eliza Plugin Integration Plan

Source of truth: `docs/openkey-auth-plan.md` §"Phase 5: Eliza Plugin Integration"
(~line 244), §"Acceptance Criteria", §"Open Questions".
Handoffs: `docs/openkey-auth-implementation-handoff.md`, `docs/openkey-auth-handoff.md`.
Depends on (in-flight, parallel): Phase 3 (delegated transport) and Phase 4
(delegation policy validation) under `docs/openkey-phases/`.

## Goal

Wire the delegated client (built in Phases 3–4) into the Eliza memory storage
service so `TinyCloudMemoryStorageService.start()` works in **delegation** mode,
without the storage service ever branching on auth mode. Auth selection lives in
config (`resolveMemoryClientConfig`) and `createAgentClient`; storage stays
mode-agnostic.

The shipped flow must remain exactly:

```
start()
  -> resolveMemoryClientConfig(runtime)   // picks private-key | delegation
  -> createAgentClient(config)            // picks transport by config.mode
  -> signIn()                             // private-key: sign-in; delegation: activate
  -> ensureSchema()
```

## What already exists vs. what is missing

### Already done (verified in tree)

- **Config resolution is mode-complete.** `packages/eliza-plugin-memory/src/config.ts`
  `resolveMemoryClientConfig(runtime)` already returns a private-key
  `AgentClientConfig` OR a `DelegationAgentClientConfig` based on
  `TINYCLOUD_AUTH_MODE`. Delegation XOR validation (delegation source, agent-key
  source) is present with actionable, secret-free errors. The full env surface
  (`TINYCLOUD_AUTH_MODE`, `TINYCLOUD_DELEGATION[_FILE]`, `TINYCLOUD_AGENT_KEY[_FILE]`,
  `TINYCLOUD_HOST`/alias, `TINYCLOUD_DB_HANDLE`) is wired.
- **Storage flow is already mode-agnostic.** `src/storage.ts` `start()` →
  `startClient(runtime)` calls `resolveMemoryClientConfig` → `createAgentClient`
  → `client.signIn()` → `client.ensureSchema([...MEMORY_SCHEMA])`. There is **no**
  `if (mode === ...)` branch anywhere in storage. The 8 provider methods only ever
  touch `client.sql.*`. This invariant is already satisfied; Phase 5 must *keep*
  it and *test* it, not build it.
- **Client injection seam exists.** `MemoryStorageDeps.client?: AgentClient`
  (src/storage.ts) is honored by `startClient`: a pre-injected client still gets
  `signIn()` + `ensureSchema()` called on it, then is used unchanged. This is the
  seam Phase 5 uses to start delegated mode in tests without live node I/O or a
  real delegation. `__tests__/fake-client.test.ts` already exports `makeFakeClient()`.
- **Cross-layer config parity is pinned.** `__tests__/auth-parity.test.ts` proves
  the eliza resolver and `agent-client`'s `resolveDelegationConfig` agree across
  the 4×4 source matrix and that an eliza-resolved delegation config round-trips
  through `agent-client`.

### Gaps Phase 5 must close

1. **`createAgentClient` rejects delegation mode** (`src/client.ts` lines 60–64,
   `"Delegation transport not yet implemented…"`). This is the only thing stopping
   `start()` from running in delegation mode. **Phases 3–4 remove/replace this
   guard** (they wire `resolveDelegationConfig` → delegated transport). Phase 5
   does **not** edit `client.ts` itself — it depends on Phases 3–4 having landed —
   but Phase 5 owns the consequences in the plugin's tests.
2. **`fail-open.test.ts` asserts the Phase-3 guard.** The test
   `"start() rejects with 'Delegation transport not yet implemented' in delegation mode"`
   becomes false the moment Phases 3–4 land. It must migrate to assert that
   delegation mode **starts** (given a valid injected/fake delegated client config)
   and that delegation-mode `start()` fails-open at the slot only when *config*
   is invalid (missing delegation source / agent key) — not because the transport
   is unimplemented.
3. **No test proves delegated `start()` reaches `signIn` + `ensureSchema`** through
   the real `resolveMemoryClientConfig` → `createAgentClient` path with an injected
   transport. Phase 5 adds it (mode-agnostic-storage proof).
4. **Regression guard `first-pr-does-not-activate-delegated-sql`**
   (`! rg 'useDelegation\\(' …`) in
   `.smithers/scripts/tinycloud-agents-openkey-auth-regression.mjs` is a *first-PR*
   guard. Once Phases 3–4 legitimately call `useDelegation(`, this guard inverts
   the intended meaning. Phase 5 flags this as a hand-off to the workflow owner
   (the regression script lives in the `development` repo and is **out of Phase 5
   write scope** — note it, do not edit it here). Phase 5's own deterministic guards
   live in this plan (below) and run against `tinycloud-agents`.

## Mode-agnostic-storage invariant (and how to test it)

**Invariant:** `TinyCloudMemoryStorageService` contains zero references to auth
mode. The only mode-aware code is `config.ts` (chooses the config shape) and
`agent-client/client.ts` (chooses the transport). Storage consumes the opaque
`AgentClient` surface (`sql`, `ensureSchema`, `signIn`, `stop`) identically in
both modes.

How Phase 5 tests it:

- **Static guard (cheap, deterministic):** a unit test greps the storage source
  for mode tokens (`"delegation"`, `"private-key"`, `TINYCLOUD_AUTH_MODE`,
  `useDelegation`) and asserts none appear. This fails loudly if a future edit
  leaks auth branching into storage.
- **Behavioral parity:** a test starts the service twice — once with a private-key
  runtime config and once with a delegation runtime config — both through the real
  `resolveMemoryClientConfig` → `createAgentClient`, each with an **injected
  `transport`** (via `createAgentClient(config, { transport })`) so no live node is
  touched. Both runs must reach `signIn` + `ensureSchema` and then service identical
  reads/writes. (If injecting a transport into the delegated path is impractical
  before Phase 3 lands its transport seam, fall back to the `deps.client` injection
  on the service, which `startClient` already honors — see `phase5-inject-fake-delegated-client`.)

## Test-migration plan (exact assertions that flip)

All migrations are in `packages/eliza-plugin-memory/src/__tests__/fail-open.test.ts`.
Everything else in that file (read fail-open, write fail-closed, no-unhandled-rejection,
private-key missing-key) stays **unchanged**.

| Test | Old assertion (today) | New assertion (after Phases 3–4) | Why |
| --- | --- | --- | --- |
| `start() rejects with 'Delegation transport not yet implemented' in delegation mode` | `start(runtime)` rejects `/Delegation transport not yet implemented/` | **Removed / replaced.** Delegation mode no longer throws the Phase-3 guard. Replace with `phase5-delegation-start-succeeds`: with a valid delegated config and an injected fake delegated client/transport, `start()` resolves and returns a `TinyCloudMemoryStorageService`. | The Phase-3 guard is deleted by Phases 3–4; asserting it would fail the build. |
| `start() rejects when TINYCLOUD_PRIVATE_KEY is missing in private-key mode` | rejects `/PRIVATE_KEY/` | **Unchanged** — but its title/intent is explicitly scoped to *private-key mode* (it already is). Add a sibling delegation-mode fail-open test (`phase5-delegation-misconfig-fails-open`) asserting that delegation-mode `start()` with a **missing delegation source** rejects with the config error (`/delegation source/`), proving fail-open still holds in delegation mode for *config* errors. | Phase 5 must keep "missing-key fail-open" applying only to private-key mode, and add the delegation-mode analogue per plan §5. |

Read fail-open (`getLongTermMemories`/`getCurrentSessionSummary` return `[]`/`null`)
and write fail-closed (`store*`/`update*`/`delete*` throw `CircuitOpenError`) tests
**do not change** — they already inject a client via `makeService(client)` and are
mode-agnostic by construction.

## Ordered atomic tasks

Each task keeps the tree green (build + typecheck + `bun --bun run test`) on
completion, except where a deliberate assertion is migrated (called out in
`phase5-migrate-failopen-delegation-assertion`).

> Sequencing note: `phase5-*` tasks assume Phases 3–4 have merged so
> `createAgentClient({ mode: "delegation", … })` no longer throws. `dependsOn`
> entries reference the Phase 3/4 completion implicitly; within Phase 5 the order
> below is authoritative.

1. `phase5-audit-mode-agnostic-storage` — confirm storage has no mode branch; add
   the static guard test.
2. `phase5-inject-fake-delegated-client` — prove delegation-mode `start()` via the
   `deps.client` seam (no Phase 3 transport dependency — runs even before/after 3–4).
3. `phase5-delegation-start-via-config` — prove delegation-mode `start()` through
   the real `resolveMemoryClientConfig` → `createAgentClient` with an injected
   transport (requires Phase 3).
4. `phase5-migrate-failopen-delegation-assertion` — flip the
   "not yet implemented" assertion; add the delegation-mode config fail-open test.
5. `phase5-parity-both-modes-readwrite` — behavioral parity: identical reads/writes
   in both modes via injected clients.
6. `phase5-regression-guards` — add the Phase-5 deterministic guards (below) and
   note the hand-off on the `useDelegation` first-PR guard.

```json
[
  {
    "id": "phase5-audit-mode-agnostic-storage",
    "title": "Pin the mode-agnostic-storage invariant with a static guard test",
    "files": [
      "packages/eliza-plugin-memory/src/__tests__/mode-agnostic-storage.test.ts",
      "packages/eliza-plugin-memory/src/storage.ts"
    ],
    "dependsOn": [],
    "tdd": [
      "Add a test that reads src/storage.ts as text and asserts it contains none of: \"TINYCLOUD_AUTH_MODE\", /mode\\s*===/, \"useDelegation\", the string literal \"delegation\", the string literal \"private-key\".",
      "Run the test; it should PASS against the current storage.ts (which already has no branch) — this is a characterization/guard test, not a red-then-green change."
    ],
    "prompt": "Create packages/eliza-plugin-memory/src/__tests__/mode-agnostic-storage.test.ts. Read packages/eliza-plugin-memory/src/storage.ts via Bun's import.meta / fs.readFileSync and assert the storage source does NOT reference auth-mode tokens (TINYCLOUD_AUTH_MODE, `mode ===`, useDelegation, the bare literals \"delegation\" and \"private-key\"). This pins the plan-§5 invariant that auth selection lives in config + agent-client, never in storage. Do NOT edit storage.ts; if the assertion fails, the storage service has illegally gained an auth branch — report it as a blocker rather than relaxing the test. Keep build/typecheck/test green.",
    "acceptance": "New test passes; build + typecheck + `bun --bun run test` green; storage.ts unchanged.",
    "risks": [
      "False positives if an unrelated comment legitimately contains a banned token — scope the assertion to executable lines or use precise regexes and document the intent."
    ],
    "manual": false
  },
  {
    "id": "phase5-inject-fake-delegated-client",
    "title": "Prove delegation-mode start() via the deps.client injection seam",
    "files": [
      "packages/eliza-plugin-memory/src/__tests__/delegated-start.test.ts",
      "packages/eliza-plugin-memory/src/__tests__/fake-client.test.ts"
    ],
    "dependsOn": ["phase5-audit-mode-agnostic-storage"],
    "tdd": [
      "Reuse makeFakeClient() (already exported from fake-client.test.ts) which counts signIn() calls and backs SQL with bun:sqlite.",
      "Construct `new TinyCloudMemoryStorageService(runtime, { client: fake })` where runtime supplies delegation-mode settings, call start()'s body via the instance (or call the static start with a runtime whose config resolves to delegation but inject the client through deps).",
      "Assert signIn() was called exactly once and ensureSchema ran (a subsequent store/read round-trips through the in-memory db).",
      "This task does NOT depend on Phase 3's transport: it exercises the `deps.client` path in startClient, which bypasses createAgentClient entirely."
    ],
    "prompt": "Add packages/eliza-plugin-memory/src/__tests__/delegated-start.test.ts. Goal: prove the storage service can START in delegation mode using an injected client, with no live node and no dependency on the Phase-3 transport. Import makeFakeClient from ./fake-client.test (or refactor the helper into an importable module if the test runner disallows cross-test imports — prefer keeping it in fake-client.test.ts and importing the export). Build a service with `{ client: fakeClient }` deps and a runtime configured for TINYCLOUD_AUTH_MODE=delegation (valid delegation + agent key settings). Drive the same start path the service uses (the deps.client branch of startClient): assert signIn() called once, ensureSchema effective (a store+read round-trips), and that no read/write throws on the happy path. Storage must be touched only through its public surface. Keep the tree green.",
    "acceptance": "Delegation-mode service starts with an injected fake client; signIn called once; a stored LTM is readable back; build/typecheck/test green.",
    "risks": [
      "Cross-test import of makeFakeClient: Bun allows importing exports from a *.test.ts, but if it double-runs the self-test, isolate the helper or accept the harmless extra assertion. Document the choice."
    ],
    "manual": false
  },
  {
    "id": "phase5-delegation-start-via-config",
    "title": "Prove delegation-mode start() through resolveMemoryClientConfig -> createAgentClient with injected transport",
    "files": [
      "packages/eliza-plugin-memory/src/__tests__/delegated-start.test.ts"
    ],
    "dependsOn": ["phase5-inject-fake-delegated-client"],
    "tdd": [
      "Requires Phase 3: createAgentClient({ mode: 'delegation', … }) must no longer throw and must accept deps.transport.",
      "Build a runtime with delegation settings, let resolveMemoryClientConfig produce the config, pass it to createAgentClient with an injected fake Transport (no live node), and confirm signIn (delegation = activate) + ensureSchema run.",
      "If createAgentClient still throws the Phase-3 guard at task time, mark this task BLOCKED on Phase 3 in the task JSON blockers and land only phase5-inject-fake-delegated-client until 3 merges."
    ],
    "prompt": "Extend delegated-start.test.ts to cover the REAL config path: runtime(delegation settings) -> resolveMemoryClientConfig -> createAgentClient(config, { transport: fakeTransport }) -> signIn -> ensureSchema. Use an injected Transport (the agent-client AgentClientDeps.transport seam) so nothing hits the network. Assert the delegated client signs in (activates) and ensureSchema issues only CREATE TABLE. This proves the end-to-end mode-agnostic wiring: the SAME storage start path runs delegation purely because config.mode === 'delegation' routed createAgentClient to the delegated transport. Do not edit storage.ts or client.ts. If Phase 3's delegated transport seam is not yet present, record a blocker and skip the transport-level assertion (the deps.client test already covers start()).",
    "acceptance": "With Phase 3 merged: delegation config flows through createAgentClient with an injected transport and start() completes; build/typecheck/test green. Without Phase 3: task records the blocker and leaves phase5-inject-fake-delegated-client as the start() proof.",
    "risks": [
      "Hard dependency on Phase 3's transport injection seam. Keep the assertion behind a capability check so Phase 5 isn't blocked from landing the deps.client proof."
    ],
    "manual": false
  },
  {
    "id": "phase5-migrate-failopen-delegation-assertion",
    "title": "Flip the 'Delegation transport not yet implemented' fail-open assertion",
    "files": [
      "packages/eliza-plugin-memory/src/__tests__/fail-open.test.ts"
    ],
    "dependsOn": ["phase5-delegation-start-via-config"],
    "tdd": [
      "Remove the test asserting start() rejects /Delegation transport not yet implemented/ (the guard is deleted by Phases 3–4).",
      "Replace it with: (a) `start() in delegation mode with valid config + injected delegated client resolves` and (b) `start() in delegation mode fails open when the delegation source is missing` (rejects with the config error /delegation source/).",
      "Leave the private-key missing-key test unchanged; confirm its title/comment scope it to private-key mode."
    ],
    "prompt": "Migrate packages/eliza-plugin-memory/src/__tests__/fail-open.test.ts. DELETE the assertion `start() rejects with 'Delegation transport not yet implemented' in delegation mode` — that error no longer exists after Phases 3–4. Replace with two tests: (1) delegation-mode start() with a valid delegated config and an injected fake delegated client RESOLVES (proves delegation no longer fail-opens at the slot just for being delegation); (2) delegation-mode start() with TINYCLOUD_AUTH_MODE=delegation but NO delegation source rejects with the actionable config error (/delegation source/), proving fail-open at the slot still holds for misconfiguration. Keep ALL other fail-open tests byte-identical: read fail-open ([]/null), write fail-closed (CircuitOpenError), no-unhandled-rejection, and the private-key missing-key test (which stays scoped to private-key mode). Keep the tree green.",
    "acceptance": "The 'not yet implemented' assertion is gone; two replacement tests pass; read fail-open + write fail-closed + private-key missing-key tests unchanged and green; build/typecheck/test green.",
    "risks": [
      "Ordering coupling: if this lands before Phases 3–4 remove the guard, the new 'resolves' test fails. Guard with dependsOn on Phase 3/4 completion; do not merge ahead of them."
    ],
    "manual": false
  },
  {
    "id": "phase5-parity-both-modes-readwrite",
    "title": "Behavioral parity: identical reads/writes in private-key and delegation modes",
    "files": [
      "packages/eliza-plugin-memory/src/__tests__/mode-agnostic-storage.test.ts"
    ],
    "dependsOn": ["phase5-migrate-failopen-delegation-assertion"],
    "tdd": [
      "Start two services, one per mode, each with an injected makeFakeClient() backed by an independent in-memory db.",
      "Run the same store/get/update/delete sequence against both; assert identical observable results (rows, ordering, not-found throws).",
      "This proves storage behavior is byte-identical regardless of mode — the user-facing acceptance of plan §5."
    ],
    "prompt": "Add a parity block to mode-agnostic-storage.test.ts: instantiate the storage service twice (private-key-configured runtime and delegation-configured runtime), each with its own injected fake client (makeFakeClient). Execute an identical operation script — storeLongTermMemory, getLongTermMemories, updateLongTermMemory, deleteLongTermMemory, storeSessionSummary, getCurrentSessionSummary — against both and assert the observable results match exactly (same rows, same ORDER BY, same not-found error messages). The point: the auth mode never changes storage behavior. Use the public service surface only. Keep build/typecheck/test green.",
    "acceptance": "Both modes produce identical read/write results across the operation script; build/typecheck/test green.",
    "risks": [
      "newUuid() randomness makes ids differ between runs — compare on content/ordering, not generated ids."
    ],
    "manual": false
  },
  {
    "id": "phase5-regression-guards",
    "title": "Add Phase-5 deterministic regression guards + flag the first-PR useDelegation guard hand-off",
    "files": [
      "packages/eliza-plugin-memory/src/__tests__/mode-agnostic-storage.test.ts",
      "docs/openkey-phases/phase-5-eliza-integration-plan.md"
    ],
    "dependsOn": ["phase5-parity-both-modes-readwrite"],
    "tdd": [
      "Ensure the static no-auth-branch guard and the both-modes-parity assertion are part of the standard `bun --bun run test` run (so the workflow regression picks them up).",
      "Document (do NOT edit) that the development-repo regression guard `first-pr-does-not-activate-delegated-sql` (! rg useDelegation) must be removed/replaced by the workflow owner once Phases 3–4 legitimately call useDelegation()."
    ],
    "prompt": "Finalize Phase 5's deterministic guards inside the eliza-plugin-memory test suite (so they run under `bun --bun run test`): (1) storage has no auth-mode branch (static guard), (2) delegation-mode start() succeeds with an injected client, (3) both modes are read/write identical, (4) delegation-mode misconfig fails open at the slot. Then update this plan's 'Hand-off to the workflow owner' section confirming the development-repo regression script's `first-pr-does-not-activate-delegated-sql` guard is now obsolete (Phases 3–4 call useDelegation legitimately) and must be removed or inverted by whoever owns `.smithers/scripts/tinycloud-agents-openkey-auth-regression.mjs`. Do NOT edit files under the development repo. Keep the tree green.",
    "acceptance": "All four guards run under `bun --bun run test` and pass; plan documents the workflow-owner hand-off; no development-repo files touched.",
    "risks": [
      "The `useDelegation` first-PR guard is in another repo and out of Phase 5 write scope — Phase 5 can only flag it, not fix it. If left unflagged the workflow regression goes red after Phases 3–4."
    ],
    "manual": false
  }
]
```

## Deterministic regression guards (Phase 5)

These run under `tinycloud-agents`'s `bun --bun run test` and are deterministic
(no network, no live node, injected clients only):

1. **no-auth-branch-in-storage** — `storage.ts` source contains no auth-mode token
   (`TINYCLOUD_AUTH_MODE`, `mode ===`, `useDelegation`, literal `"delegation"`/
   `"private-key"`). Pins the mode-agnostic invariant.
2. **delegation-start-succeeds** — delegation-mode `start()` with a valid config +
   injected delegated client resolves to a started service (signIn called once,
   ensureSchema effective). Pins that the Phase-3 guard is gone and delegation boots.
3. **both-modes-readwrite-identical** — the same operation script yields identical
   observable results in private-key and delegation modes. Pins behavioral parity.
4. **delegation-misconfig-fails-open** — delegation-mode `start()` with a missing
   delegation source rejects with the actionable config error (fail-open at the
   slot for misconfiguration, not fail-over).

## Hand-off to the workflow owner (development repo, out of Phase 5 scope)

- `.smithers/scripts/tinycloud-agents-openkey-auth-regression.mjs` contains
  `first-pr-does-not-activate-delegated-sql` =
  `! rg 'useDelegation\\(' packages/agent-client/src packages/eliza-plugin-memory/src`.
  Once Phases 3–4 legitimately call `useDelegation(`, this guard inverts the intended
  meaning and will fail the regression gate. The workflow owner must **remove or
  invert** it. Phase 5 only flags this; it does not edit the development repo.
- The Phase-5 deterministic guards above live inside `tinycloud-agents` tests, so
  the existing `run("test", "bun --bun run test")` step picks them up automatically.

## Hand-off to Phase 6 (do not design here)

Phase 5 ends when delegation-mode `start()` works against an injected/fake delegated
client and the storage service is proven mode-agnostic. Phase 6 (consent + delivery
harness) builds the real OpenKey/passkey → TinyCloudWeb delegation → file/env handoff
that produces the `TINYCLOUD_DELEGATION` material Phase 5 consumes. Phase 5 must NOT
implement the consent script, the OpenKey callback, or any live passkey flow — it
only proves the runtime accepts a delegated config once that material exists.
