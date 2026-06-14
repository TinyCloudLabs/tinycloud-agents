# Phase 7 — Live Delegated Scenario (Implementation Plan)

Status: PLAN ONLY. No source code changes here.
Scope: strictly Phase 7 of `docs/openkey-auth-plan.md`. Phase 8 (docs) is hand-off only.

## Goal

Add a live/manual end-to-end scenario that proves the delegated-auth product path,
sitting **beside** the existing private-key live scenario rather than replacing it.

The acceptance flow this phase proves (from `docs/openkey-auth-plan.md` §Phase 7 and
§Acceptance Criteria):

1. Human signs in with OpenKey. **(MANUAL)**
2. Human creates or restores a TinyCloud session. **(MANUAL)**
3. Human delegates **only** the memory SQL policy to the stable agent DID. **(MANUAL)**
4. Agent writes a long-term memory and session summary through delegated SQL. **(AUTOMATABLE, gated)**
5. A separate user-authorized client reads the same rows from the user's space. **(AUTOMATABLE, gated)**
6. A fresh agent process restores from the same delegation file and hydrates memory. **(AUTOMATABLE, gated)**
7. Wrong-delegatee, expired-grant, and insufficient-policy fixtures fail clearly. **(AUTOMATABLE, no live passkey required)**

The private-key live scenario (`TINYCLOUD_LIVE=1 bun --bun run test:live:eliza`) must
keep passing unchanged. This phase mirrors its conventions; it does not touch it.

### Dependency note (important)

Phase 7 steps 4–6 exercise the **delegated transport** (`useDelegation` →
`DelegatedAccess.sql`). As of this plan, Phases 3–6 are **not yet implemented**
(`packages/agent-client/src/delegated-transport.ts` does not exist; no `useDelegation(`
call exists in package source; the existing regression gate even *bans* it via the
`first-pr-does-not-activate-delegated-sql` guard). Therefore:

- The Phase 7 **negative-fixture** tasks (step 7) and the **scenario scaffolding/runbook**
  are buildable now and are the bulk of this phase's committed, regression-guarded work.
- The Phase 7 **positive delegated read/write/restore** harness (steps 4–6) must be
  written so it is **env-gated OFF by default** and only runs when Phase 3's delegated
  transport is present AND a human-produced delegation file is supplied. It must degrade
  to a clean "skipped" (exit 0) when either is missing, so committing it never reddens the
  tree before Phase 3 lands. The order below builds the always-runnable parts first, then
  the gated live harness, so each step keeps the tree green.

## How this mirrors the existing private-key live scenario

The existing scenario is `packages/eliza-plugin-memory/scripts/live-eliza-scenarios.ts`,
run via the package script `test:live:eliza` (`bun --bun scripts/live-eliza-scenarios.ts`).
Conventions to copy exactly:

- **Opt-in env gate.** First line of `run()` checks `process.env.TINYCLOUD_LIVE !== "1"`
  and prints `{"skipped": true, "reason": "..."}` then returns (exit 0). It is NOT part of
  `bun test`. The new delegated scenario adds a second gate: a delegation source
  (`TINYCLOUD_DELEGATION_FILE`/`DELEGATION_FILE`) and a stable agent key. If `TINYCLOUD_LIVE=1`
  but no delegation file is present, it prints `{"skipped": true, "reason": "set DELEGATION_FILE..."}`
  and exits 0 — same skip discipline.
- **Single JSON object to stdout** describing each sub-scenario, a top-level `passed`
  boolean, and `process.exit(1)` on failure. Wrap `run()` in `.catch()` that prints
  `{passed:false,error,stack}` and exits 1.
- **Deterministic ids** for agent/entity/room (`AGENT_ID`, `ENTITY_ID`, `ROOM_ID`) and a
  random `scenarioId` prefix on content so reruns don't collide.
- **`bootRuntime` pattern**: build a `createCharacter` with `advancedMemory:true`, plugins
  `["@tinycloud/eliza-plugin-memory","@elizaos/plugin-sql"]`, assert
  `TinyCloudMemoryStorageService` owns the `memoryStorage` slot and Eliza's `MemoryService`
  owns `memory`. Reuse the `loadPluginSql()` Bun-export fallback verbatim.
- **`directReadFromTinyCloud` pattern**: a *separate* client reads the same rows by id to
  prove cross-client visibility.
- **Settings injection via env**: the scenario sets `process.env.*` before `bootRuntime`
  (here: `TINYCLOUD_AUTH_MODE=delegation`, `TINYCLOUD_DELEGATION_FILE`, `TINYCLOUD_AGENT_KEY[_FILE]`,
  `TINYCLOUD_HOST`, `TINYCLOUD_DB_HANDLE`) and threads them into character `settings`.

The new scenario lives next to the old one and reuses its exported constants
(`MEMORY_DB_HANDLE`, `MEMORY_SCHEMA`, `TinyCloudMemoryStorageService`) from `../src/index`.

## Automatable vs manual split

| Step | Mode | Why |
| --- | --- | --- |
| 1 OpenKey/passkey sign-in | MANUAL | WebAuthn cannot be clicked by a worker. Local-origin/cert sensitive. |
| 2 Create/restore TinyCloud session | MANUAL | Depends on the human's authenticated wallet/session from step 1. |
| 3 Human delegates memory SQL policy to agent DID | MANUAL | Real delegation requires the human's signed consent. |
| 4 Agent writes via delegated SQL | AUTOMATABLE (gated) | Given the delegation FILE from step 3, the agent boots in delegation mode and writes programmatically. |
| 5 Separate user client reads back | AUTOMATABLE (gated) | A second client reads the same rows by id. |
| 6 Fresh process restore + hydrate | AUTOMATABLE (gated) | Re-boot from the same delegation file; assert hydration. |
| 7 Negative fixtures (wrong-delegatee / expired / insufficient-policy) | AUTOMATABLE (NO live passkey) | Crafted/expired/insufficient delegation JSON fixtures — no human consent needed. |
| Runbook doc | AUTOMATABLE | Pure markdown describing the manual gates. |

The split's load-bearing insight: **the human only needs to produce the delegation once**
(steps 1–3, written to a file). Everything downstream (steps 4–7) is programmatic and
gated behind env so CI/default test runs skip it and stay green without secrets.

## Env-gating design

Mirror the private-key scenario's gate, with an added delegation-source gate.

```
TINYCLOUD_LIVE=1                       # master gate (same as existing scenario)
DELEGATION_FILE=/path/to/delegation.json   # human-produced (step 3 output)
#   (also accept TINYCLOUD_DELEGATION_FILE; DELEGATION_FILE is the scenario-local alias)
TINYCLOUD_AGENT_KEY=0x...              # OR TINYCLOUD_AGENT_KEY_FILE=...
TINYCLOUD_HOST=https://node.tinycloud.xyz   # optional, defaults to public node
TINYCLOUD_DB_HANDLE=xyz.tinycloud.eliza/memory  # optional, default
```

Skip semantics (each prints `{"skipped":true,"reason":...}` and exits 0):

- `TINYCLOUD_LIVE !== "1"` → skip (default test/CI path; never runs live).
- `TINYCLOUD_LIVE=1` but no delegation source → skip with a reason naming `DELEGATION_FILE`.
- `TINYCLOUD_LIVE=1` + delegation file present but Phase 3 delegated transport not yet
  shipped (detected by a try/catch around `createAgentClient({mode:"delegation",...})`
  throwing the Phase 3 "not yet implemented" guard) → skip with a reason naming Phase 3.

The **negative-fixture test** (step 7) does NOT need `TINYCLOUD_LIVE` — it runs in `bun test`
because it operates on local crafted delegation JSON and only asserts that the
deserialize/validate path **rejects** them. (It must still avoid `useDelegation(` in package
`src/` per the standing gate; rejection happens at validation, before activation, OR the
test lives under `scripts/`/`__tests__` exercising a pure validation helper. See Risks.)

The new package script:

```jsonc
"test:live:eliza:delegated": "bun --bun scripts/live-delegated-scenarios.ts"
```

`test:live:eliza` stays untouched. A combined convenience script may run both.

## Negative-fixture design (no live passkey)

Goal: prove wrong-delegatee, expired-grant, and insufficient-policy delegations fail
**clearly and before any SQL use**, without a human producing a real bad delegation.

Source of truth for the shape: `@tinycloud/node-sdk` `PortableDelegation`
(`serializeDelegation`/`deserializeDelegation`). It is plain JSON:
`{ delegationHeader:{Authorization}, ownerAddress, chainId, host?, expiry:ISO, ...Delegation
fields incl. delegate DID + resources/capabilities, cid }`.

Fixture-construction strategy — **mutate a captured/sample serialized delegation** so
fixtures stay structurally valid except for the one field under test:

1. **Seed fixture.** Capture one real serialized delegation produced during a manual run
   (step 3) into `packages/eliza-plugin-memory/scripts/fixtures/delegation.sample.json`,
   with all secrets/headers scrubbed/placeholdered, OR hand-author a minimal structurally
   valid `PortableDelegation` JSON if no live capture is available. This is the "valid
   baseline" the negatives are derived from. (Document which approach was used.)
2. **wrong-delegatee fixture.** Clone the baseline; replace the delegate DID with a
   *different* `did:pkh:eip155:1:{otherAddress}` than the agent identity the test loads.
   Expectation: validation rejects because `delegateDID !== stable agent DID`, with a
   typed/clear error that does NOT leak the Authorization header.
3. **expired fixture.** Clone the baseline; set `expiry` to a past ISO timestamp
   (e.g. `new Date(Date.now() - 60_000).toISOString()`). Expectation: reported as
   **expired** specifically (not a generic failure).
4. **insufficient-policy fixture.** Clone the baseline; remove the SQL resource for
   `xyz.tinycloud.eliza/memory` (or strip `tinycloud.sql/write`, leaving only `/read`, or
   point it at the wrong db handle). Expectation: rejected as insufficient/missing SQL
   resource with a clear message naming the missing capability — before SQL use.
5. (Optional, cheap) **malformed fixture.** Non-JSON / missing `expiry` → rejected as
   malformed. Already implied by Phase 3/4 validation; include if it costs nothing.

Each fixture is generated by a tiny deterministic helper (pure function: takes the baseline
JSON + a mutation, returns serialized string) so the test has no network dependency and is
fully reproducible. Fixtures are committed as static JSON (or generated at test time from a
committed baseline + mutation) so the regression guard can assert their presence.

These negative tests are the **only** part of step 7 that runs in the default `bun test`
gate. They give deterministic coverage of the rejection paths without any live passkey,
network, or human consent.

## Ordered atomic tasks

Each task: small, leaves build+typecheck+test green, prior tests stay green, live scenario
OFF by default. Tasks are ordered so always-runnable scaffolding/fixtures land before the
gated live harness.

### phase7-runbook-doc
- title: Write the manual delegated-scenario runbook
- files: `docs/openkey-phases/phase-7-runbook.md`
- dependsOn: []
- tdd: ["No code; deterministic guard `phase7-runbook-doc-exists` asserts the file exists and names the manual gates (OpenKey sign-in, delegation to agent DID, DELEGATION_FILE)."]
- prompt: |
    Author the MANUAL runbook for steps 1–3 of the Phase 7 acceptance flow. It must tell a
    human operator exactly how to: (a) print the stable agent DID + requested permission
    JSON + db handle + host (reuse the Phase 6 consent-harness output if present, else
    document `agentIdentityFromKey`/`agentIdentityFromFile` usage); (b) sign in with
    OpenKey/passkey and create/restore a TinyCloud session (reference web-sdk
    `TinyCloudWeb.signIn`/`restoreSession` and OpenKey local dev: `bun dev` / `bun dev:portless`);
    (c) create a delegation to the agent DID granting ONLY the `xyz.tinycloud.eliza/memory`
    SQL policy (`tinycloud.sql/read|write|admin` + optional `tinycloud.capabilities/read`),
    serialize it, and write it to `DELEGATION_FILE`; (d) hand off to the automatable scenario
    via `TINYCLOUD_LIVE=1 DELEGATION_FILE=... TINYCLOUD_AGENT_KEY=... bun run test:live:eliza:delegated`.
    Include the OpenKey WebAuthn local-origin/cert pitfalls and the "never the user's main
    key" warning. State explicitly which steps are MANUAL and why automation is deferred.
- acceptance: "Runbook exists, lists steps 1–3 as manual with concrete commands, names DELEGATION_FILE handoff and the agent DID/permission/host/db-handle surface, and warns about WebAuthn local-origin + user-key safety."
- risks: ["Runbook drifts from actual env var names — cross-check against eliza-plugin config SETTING_KEYS.", "Over-promises automation; must clearly label manual gates."]
- manual: true

### phase7-fixtures-baseline
- title: Add committed delegation baseline + fixture generator helper
- files: `packages/eliza-plugin-memory/scripts/fixtures/delegation.sample.json`, `packages/eliza-plugin-memory/scripts/fixtures/make-delegation-fixtures.ts`
- dependsOn: ["phase7-runbook-doc"]
- tdd: ["Add a unit test (`scripts/fixtures/make-delegation-fixtures.test.ts` or `src/__tests__/`) asserting the generator: produces a structurally valid baseline (parses via deserializeDelegation), and each mutation (wrongDelegatee/expired/insufficient) changes exactly the intended field while leaving others intact. Test runs in `bun test` (no network)."]
- prompt: |
    Create a committed, secrets-scrubbed baseline `PortableDelegation` JSON (captured from a
    manual run if available, else a minimal hand-authored valid shape) and a pure helper
    `make-delegation-fixtures.ts` exporting `baseline()`, `withWrongDelegatee(otherDid)`,
    `withExpired(pastDate)`, and `withInsufficientPolicy()` — each returning a *serialized*
    delegation string built by mutating one field of the baseline. Use node-sdk
    `serializeDelegation`/`deserializeDelegation` so shapes stay real. NO secret material or
    real Authorization tokens in committed JSON — use scrubbed placeholders. NO network, NO
    useDelegation in package `src/` (helper lives under `scripts/`). Add the unit test proving
    each mutation is surgical.
- acceptance: "Baseline JSON + generator helper committed; unit test green in `bun test`; no real secrets in fixtures; build+typecheck+test stay green."
- risks: ["Accidentally committing a real Authorization header — must scrub.", "Hand-authored baseline diverging from real node-sdk shape — round-trip through deserialize/serialize to validate."]
- manual: false

### phase7-negative-fixture-test
- title: Add deterministic negative-fixture rejection test
- files: `packages/eliza-plugin-memory/scripts/live-delegated-negative.test.ts` (or `src/__tests__/delegated-negative.test.ts`)
- dependsOn: ["phase7-fixtures-baseline"]
- tdd: ["Test asserts wrong-delegatee, expired, and insufficient-policy fixtures are REJECTED by the validation surface with clear, field-specific errors and no leaked Authorization header. If Phase 3/4 validation helper is not yet present, assert against a thin local validator stub that this test pins, so the test is green now and tightened when Phase 4 lands (document the seam)."]
- prompt: |
    Write a no-network test that loads each negative fixture from the generator and asserts it
    is rejected *clearly and before any SQL use*: wrong-delegatee → error mentions delegatee
    mismatch; expired → error/Status specifically says expired; insufficient-policy → error
    names the missing SQL resource/action. Assert error messages NEVER contain the
    Authorization header value or agent key. Prefer to call the Phase 4 policy validator if it
    exists; otherwise validate via the same local checks Phase 4 will own (deserialize, compare
    delegate DID to a loaded `agentIdentityFromKey` DID, compare `expiry` to now, scan
    resources for the memory SQL handle/actions) and leave a clearly-marked TODO to point the
    test at the real validator in Phase 4. Must run in default `bun test` and stay green. Must
    NOT introduce `useDelegation(` into package `src/`.
- acceptance: "Three negative cases rejected with clear field-specific errors; no secret leakage; runs in default `bun test`; `first-pr-does-not-activate-delegated-sql` guard still passes (no useDelegation in src)."
- risks: ["Standing regression gate bans useDelegation in packages/*/src — keep validation pre-activation or under scripts/.", "Coupling to Phase 4 internals before they exist — use a pinned seam + TODO so the test is stable.", "Leaking secrets in assertion messages — assert on absence explicitly."]
- manual: false

### phase7-delegated-scenario-skipgate
- title: Scaffold the gated delegated live scenario (skip-by-default)
- files: `packages/eliza-plugin-memory/scripts/live-delegated-scenarios.ts`, `packages/eliza-plugin-memory/package.json`
- dependsOn: ["phase7-negative-fixture-test"]
- tdd: ["Run `bun run test:live:eliza:delegated` with no env → asserts it prints `{\"skipped\":true,...}` and exits 0. Add a guard `phase7-delegated-scenario-exists-and-gated` (rg) that the script exists and contains the `TINYCLOUD_LIVE` + delegation-source gate."]
- prompt: |
    Create `live-delegated-scenarios.ts` mirroring `live-eliza-scenarios.ts` structure but for
    delegation mode, and wire the `test:live:eliza:delegated` package script. Implement ONLY
    the gating/skeleton in this task: the master `TINYCLOUD_LIVE !== "1"` skip, the
    delegation-source skip (no `DELEGATION_FILE`/`TINYCLOUD_DELEGATION_FILE`), and the Phase-3-
    not-ready skip (try `createAgentClient({mode:"delegation",...})`, catch the "not yet
    implemented" guard, print skip). Reuse `loadPluginSql`, deterministic ids, and the
    JSON-to-stdout + `.catch()` exit conventions. Do NOT implement the positive write/read/
    restore yet — leave a clearly-marked section that the next task fills. Default `bun test`
    must stay untouched (this is a script, not a test).
- acceptance: "Script exists, wired to package script, exits 0 with a skip JSON in all three skip conditions; build+typecheck+test green; `test:live:eliza` untouched."
- risks: ["Importing Phase 3 transport at module top-level could throw before the gate — import lazily/inside try/catch.", "Accidentally running live in CI — gates must be the first thing executed."]
- manual: false

### phase7-delegated-scenario-live-flow
- title: Implement gated steps 4–6 (delegated write, cross-client read, fresh-process restore)
- files: `packages/eliza-plugin-memory/scripts/live-delegated-scenarios.ts`
- dependsOn: ["phase7-delegated-scenario-skipgate"]
- tdd: ["Manual/live verification only (gated). Deterministic CI guard remains the skip-default + existence checks. Document the live command and expected `passed:true` JSON. Live run requires Phase 3 delegated transport shipped + a real DELEGATION_FILE."]
- prompt: |
    Fill the positive flow inside the already-built gate: (4) boot an Eliza AgentRuntime in
    `TINYCLOUD_AUTH_MODE=delegation` using `DELEGATION_FILE` + agent key, assert
    `TinyCloudMemoryStorageService` owns `memoryStorage`, then write a long-term memory and a
    session summary via `MemoryService` (reuse the existing scenario's store calls and
    deterministic ids/scenarioId). (5) With a SEPARATE user-authorized client, read the same
    rows by id from the user's space and assert they match — this proves the rows landed in the
    USER's space, not an agent-owned space. (6) Stop, boot a FRESH runtime from the SAME
    delegation file, and assert memory + summary hydrate. Emit one JSON object with per-step
    booleans and a top-level `passed`; `process.exit(1)` on any failure. Keep all of this behind
    the Phase-3-ready / DELEGATION_FILE / TINYCLOUD_LIVE gates so default runs still skip.
    Do not add `useDelegation(` to package `src/` — it must come from the agent-client delegated
    transport (Phase 3), invoked through the normal client API in this script.
- acceptance: "When run live with Phase 3 present + valid DELEGATION_FILE: agent writes through delegated SQL, separate user client reads the same rows, fresh process hydrates, JSON reports `passed:true`. With no/empty env: still skips, exit 0. Default `bun test` unaffected."
- risks: ["Reading back via the 'user-authorized client' requires a user-side read path; if only the delegation file is available, document that the read-back client may itself use a user delegation/session captured in the runbook (note the seam).", "Delegated session lifecycle (no refresh) — follow Phase 3 policy; one reactivation retry.", "Cannot be CI-gated green; rely on existence+skip guards + manual sign-off."]
- manual: false

### phase7-regression-guards
- title: Wire Phase 7 deterministic regression guards into the gate
- files: `docs/openkey-phases/phase-7-live-scenario-plan.md` (reference), gate script in `/Users/roman/Documents/GitHub/development/.smithers/scripts/tinycloud-agents-openkey-auth-regression.mjs`
- dependsOn: ["phase7-delegated-scenario-live-flow"]
- tdd: ["Run the regression gate; assert the new guards pass on the built tree and the existing checks stay green."]
- prompt: |
    Add the Phase 7 deterministic guards to the existing regression script (see "Proposed
    deterministic regression guards" below). They must be pure existence/structure/skip checks
    (live steps cannot run in the gate). Keep the existing
    `first-pr-does-not-activate-delegated-sql` guard semantics consistent with Phase 3's status
    when this lands (if Phase 3 has shipped, relax that specific guard to allow useDelegation in
    the delegated-transport file only; otherwise leave it). Re-run build+typecheck+test in the
    gate.
- acceptance: "Gate emits its JSON with the new Phase 7 guards passing and all prior checks green."
- risks: ["The `no useDelegation in src` guard conflicts with Phase 3 once shipped — scope the relaxation narrowly to the delegated-transport file, not all of src."]
- manual: false

## Manual runbook (summary; full text in `docs/openkey-phases/phase-7-runbook.md`)

1. Print the agent surface: stable agent DID (`did:pkh:eip155:1:{address}` from
   `TINYCLOUD_AGENT_KEY[_FILE]`), requested permission JSON (`tinycloud.sql/read|write|admin`
   on `xyz.tinycloud.eliza/memory`, optional `tinycloud.capabilities/read`), host, db handle.
2. Start OpenKey locally (`bun dev` or `bun dev:portless`); sign in with passkey.
3. In a TinyCloud-web flow, sign in / restore the user's TinyCloud session.
4. Create a delegation to the agent DID granting ONLY the memory SQL policy; serialize it.
5. Write the serialized delegation to `DELEGATION_FILE`.
6. Run the automatable scenario:
   `TINYCLOUD_LIVE=1 DELEGATION_FILE=/path/delegation.json TINYCLOUD_AGENT_KEY=0x... bun run test:live:eliza:delegated`
7. Confirm JSON `passed:true`. Negative fixtures are covered separately by `bun test`.

Pitfalls to restate in the runbook: WebAuthn needs `http://localhost` or trusted HTTPS;
never use the user's main key; agent DID must equal the delegation's delegatee.

## Proposed deterministic regression guards

Live steps cannot execute in the gate, so guards are existence/structure/skip checks:

1. **`phase7-runbook-doc-exists`** — `test -f docs/openkey-phases/phase-7-runbook.md` AND it
   names the manual gates (`grep -q "OpenKey"` and `grep -q "DELEGATION_FILE"`).
2. **`phase7-negative-fixtures-present`** — fixtures + generator exist
   (`test -f packages/eliza-plugin-memory/scripts/fixtures/make-delegation-fixtures.ts`) and the
   negative-fixture test file exists and references all three cases
   (`rg -q "wrongDelegatee|wrong-delegatee" ... && rg -q "expired" ... && rg -q "insufficient"`).
3. **`phase7-delegated-scenario-exists-and-gated`** — the live script exists and is gated:
   `rg -q "TINYCLOUD_LIVE" scripts/live-delegated-scenarios.ts` AND
   `rg -q "DELEGATION_FILE|TINYCLOUD_DELEGATION_FILE" scripts/live-delegated-scenarios.ts`.
4. **`phase7-default-tests-green`** — `bun --bun run build && typecheck && test` (the negative-
   fixture test runs here; the live delegated scenario stays skipped because no
   `TINYCLOUD_LIVE`). This is the proof that committing Phase 7 keeps the tree green.

## Hand-off to Phase 8 (docs only — NOT designed here)

Phase 8 must update `README.md`, `packages/eliza-plugin-memory/README.md`, `docs/hydration.md`,
and `docs/openkey-auth-handoff.md` to: document the two `test:live:*` scenarios (private-key
vs delegated), point operators at `docs/openkey-phases/phase-7-runbook.md` for the manual
delegation steps, and state that delegated memory lives in the **user's** space (the whole
point of replacing private-key auth). Phase 8 also records that the delegated live scenario is
manual-gated and that the negative fixtures are the CI-runnable correctness proof.
