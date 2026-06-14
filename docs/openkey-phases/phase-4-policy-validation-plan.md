# Phase 4: Delegation Policy Validation — Implementation Plan

Status: PLANNING. No code written. Scope is strictly Phase 4 of
`docs/openkey-auth-plan.md` ("## Phase 4: Delegation Policy Validation", ~line 213).

This plan is SDK-grounded against `@tinycloud/node-sdk` 2.3.0 (the version pinned
in `packages/agent-client/package.json` and `bun.lock`), read from the installed
`@tinycloud/sdk-core@2.3.0` type declarations under
`node_modules/.bun/@tinycloud+sdk-core@2.3.0+.../dist/index.d.ts`, plus the
`@tinycloud/node-sdk` 2.2.0-beta.12 dist re-export surface available on disk at
`../tinychat/node_modules/@tinycloud/node-sdk`.

---

## Goal

Add a pure, local **delegation policy validator** to `@tinycloud/agent-client`
that inspects a *deserialized* `PortableDelegation` and accepts it only when it
satisfies the narrow Eliza-memory policy. The validator runs IN FRONT of any
`TinyCloudNode.useDelegation(...)` activation (Phase 3's delegated transport),
so a misconfigured or wrong delegation fails with a precise, typed error before a
single network call.

The validator:

- is a **pure function** over a deserialized delegation (no I/O, no network, no
  `useDelegation` call), so it stays compatible with the deterministic regression
  guard `first-pr-does-not-activate-delegated-sql`
  (`! rg -n 'useDelegation\s*\(' packages/agent-client/src ...`).
- rejects: wrong delegatee, expired grant, malformed serialized delegation,
  missing SQL resource, insufficient SQL actions, wrong memory db handle.
- optionally derives a **stable policy hash** from the requested permissions +
  agent DID and reports `active | expired | stale | none` status (see
  "Policy-hash decision").
- adds a **redaction guard** (`toJSON`) on the resolved delegation config, closing
  the Phase-3 TODO that `auth-composition.test.ts` currently *characterizes* as a
  known leak. (This flips two characterization tests deliberately — see
  "Interaction with `auth-composition.test.ts`".)

### Where it sits

```
delegated-transport.ts (Phase 3)
  deserializeDelegation(serialized)            // SDK -> PortableDelegation
  validateDelegationPolicy(delegation, policy) // <-- PHASE 4 (this plan), throws on reject
  node.useDelegation(serialized)               // Phase 3, only reached if valid
  delegatedAccess.sql.db(dbHandle)             // Phase 3
```

Phase 3 may not exist yet when this lands. The validator is intentionally
**standalone and decoupled**: it takes an already-deserialized `PortableDelegation`
plus an explicit policy object and returns/throws. It does not import
`delegated-transport.ts`. Phase 3 calls it; if Phase 3 lands first, it calls it;
if Phase 4 lands first, the validator is unit-tested against fixtures and wired in
by Phase 3 later. A single thin `deserializeDelegationSafe(serialized)` wrapper
(maps SDK deserialize throw -> typed `DelegationPolicyError`) is included here so
the "malformed serialized delegation" reject case is testable without Phase 3.

---

## SDK grounding findings (CRITICAL)

Read from `@tinycloud/sdk-core@2.3.0` (installed) and `@tinycloud/node-sdk`
2.2.0-beta.12 dist (on disk). `@tinycloud/node-sdk` re-exports the sdk-core
symbols below from its root entrypoint (verified in its `dist/index.d.ts`
`export { ... } from '@tinycloud/sdk-core'` line), so `agent-client` keeps its
single-import-surface convention (`from "@tinycloud/node-sdk"`).

### CONFIRMED

- **`deserializeDelegation(data: string): PortableDelegation`** and
  **`serializeDelegation(delegation): string`** are exported from
  `@tinycloud/node-sdk` (re-exported from `./core`). `deserializeDelegation`
  THROWS on malformed input (no Result wrapper) — so the "malformed" reject path
  is a try/catch, not a discriminant check.
- **`PortableDelegation`** extends `Omit<Delegation, "isRevoked">` and adds:
  - `ownerAddress: string`  ← **owner address** (space owner).
  - `chainId: number`.
  - `host?: string`.
  - `disableSubDelegation?: boolean`.
  - `publicDelegation?: PortableDelegation`.
  - `resources?: DelegatedResource[]`  ← **multi-resource grant breakdown**.
  - `delegationHeader: { Authorization: string }` (the live token; redact in logs).
- **`Delegation`** (the base, `z.infer<typeof DelegationSchema>`) exposes the flat
  single-resource fields directly:
  - `delegateDID: string`  ← **delegatee DID**.
  - `delegatorDID?: string`.
  - `expiry: Date`  ← **expiry** (a real `Date`; schema is `z.ZodDate`, JSON ISO
    strings are coerced on deserialize).
  - `spaceId: string`.
  - `path: string`  ← single-resource path (mirrors `resources[0].path`).
  - `actions: string[]`  ← single-resource actions (full-URN form).
  - `cid: string`, `createdAt?: Date`, `parentCid?`, `allowSubDelegation?`,
    `authHeader?`.
- **`DelegatedResource`** (`z.infer<typeof DelegatedResourceSchema>`), one entry
  per `(service, space, path, actions)`:
  - `service: string`  ← **short form** ("sql", "kv", "duckdb", "capabilities",
    "hooks").
  - `space: string`  ← full space id, e.g. `tinycloud:pkh:eip155:1:0x...:default`.
  - `path: string`  ← `""` when the resource URI had no path segment.
  - `actions: string[]`  ← **full-URN** ability strings, e.g.
    `["tinycloud.sql/read", "tinycloud.sql/write"]`.
- **Resource/ability set is cleanly exposed.** Both the flat (`path` + `actions`)
  and structured (`resources[]`) shapes are available. The doc-comment is explicit:
  when `resources` is absent, only the flat `path` + `actions` are authoritative
  (legacy single-resource); when present, `resources` is the full picture and the
  flat fields mirror `resources[0]`. **The validator MUST handle both shapes**
  (prefer `resources` when present, fall back to flat).
- **Service name mapping** is available:
  - `SERVICE_SHORT_TO_LONG: Readonly<Record<string,string>>` and
    `SERVICE_LONG_TO_SHORT` (e.g. `"sql"` ↔ `"tinycloud.sql"`).
  - `expandActionShortNames(service, actions): string[]` — expands short action
    names to full URNs; passes already-expanded URNs through unchanged.
- **Identity helpers** are available:
  - `pkhDid(address, chainId?): string` (already imported by `agent-identity.ts`
    from `@tinycloud/node-sdk` — so its node-sdk re-export is confirmed for 2.3.0).
  - `parsePkhDid(did): PkhDidParts | null`,
    `principalDidEquals(a, b): boolean`, `didEquals(a, b, options?)`.
  - For the delegatee match the validator SHOULD use `principalDidEquals` (or
    `didEquals`) rather than raw `===`, because the agent DID (`did:pkh:eip155:1:0x..`)
    and the delegation's `delegateDID` may differ in case / canonicalization.
- **Subset check** helper exists: `isCapabilitySubset(requested, granted):
  SubsetCheckResult` over `PermissionEntry[]`. This is a candidate for the
  "insufficient actions / missing resource" check, but it operates on
  `PermissionEntry` (long-form `service`, short or URN `actions`, manifest `space`
  semantics), not on `DelegatedResource` directly — a small adapter is needed.
  The plan keeps the first implementation as an explicit hand-rolled action-set
  check (simpler, fully testable, no manifest-space ambiguity) and notes
  `isCapabilitySubset` as a future consolidation.

### UNCONFIRMED / RISK

- **node-sdk 2.3.0 is not installed in `tinycloud-agents/node_modules`.** Only
  `@tinycloud/sdk-core@2.3.0` is present (under `.bun`). The node-sdk *root
  re-export list* was read from 2.2.0-beta.12 on disk. RISK: a symbol could be
  re-exported in beta.12 but renamed/dropped in 2.3.0, or vice-versa. Mitigation:
  the very first task is a **probe test** that imports every symbol the validator
  needs from `@tinycloud/node-sdk` and asserts they are functions/defined; this
  fails fast and visibly if a re-export differs in 2.3.0. `pkhDid` is already
  proven (used by `agent-identity.ts`); `expandActionShortNames`,
  `principalDidEquals`, `SERVICE_SHORT_TO_LONG`, `deserializeDelegation`,
  `serializeDelegation` are the ones to probe.
- **`expiry` runtime type.** Schema is `z.ZodDate`. After `deserializeDelegation`
  of JSON transport, `expiry` SHOULD be a `Date`. RISK: if a hand-built fixture or
  a transport edge delivers an ISO string, a naive `expiry.getTime()` throws.
  Mitigation: the validator coerces defensively (`new Date(expiry)` if not already
  a `Date`) and treats an unparseable expiry as **malformed**, not expired.
- **`resources[].space` vs `path` for the db handle.** The Eliza db handle
  `xyz.tinycloud.eliza/memory` is the **resource path**, not the space id. Grounding
  confirms `DelegatedResource.path` carries the path and `.space` carries the full
  space URI. RISK: whether the user's delegation encodes the handle exactly as
  `xyz.tinycloud.eliza/memory` in `path`, or with a manifest prefix applied
  (`skipPrefix` semantics from `PermissionEntry`), cannot be confirmed without a
  live delegation fixture. Mitigation: the db-handle check matches the configured
  `dbHandle` against `resources[].path` (and the flat `path` fallback) with an
  exact match first; a documented `risks` entry flags that a prefixing scheme may
  require a normalization step, and the validator surfaces the *expected vs actual*
  path in the error (path is not secret) to make a live mismatch diagnosable.
- **`isRevoked` is omitted from `PortableDelegation`** (it's `Omit<..,"isRevoked">`).
  So local validation cannot detect server-side revocation; revocation is a
  Phase 7+ live concern. The validator does NOT attempt a revocation check. (Noted
  so no task assumes it.)

---

## The narrow policy table

The validator is configured with an explicit policy object (no magic constants
buried in logic). Default policy for Eliza memory:

| Service (long)          | Service (short) | Path                          | Required actions (full-URN)                                              | Required? |
| ----------------------- | --------------- | ----------------------------- | ------------------------------------------------------------------------ | --------- |
| `tinycloud.sql`         | `sql`           | `xyz.tinycloud.eliza/memory`  | `tinycloud.sql/read`, `tinycloud.sql/write`, `tinycloud.sql/admin`       | yes       |
| `tinycloud.capabilities`| `capabilities`  | `` (empty path)               | `tinycloud.capabilities/read`                                            | optional¹ |

¹ `tinycloud.capabilities/read` is listed in the plan and handoff as a likely
introspection need but is not strictly required by the current memory schema.
The policy object marks it `required: false` by default so its absence does not
reject; if present it must not be *insufficient*. This keeps the reject-matrix
focused on the SQL resource, which is the load-bearing grant.

The path/db-handle the validator enforces comes from `ResolvedDelegationConfig.dbHandle`
(default `DEFAULT_DB_HANDLE = "xyz.tinycloud.eliza/memory"`), NOT a second hardcoded
literal, so config and policy never drift.

Open Question #4 (is `tinycloud.sql/admin` truly required after schema creation?)
is surfaced by making the SQL action set a **policy field**, not a constant: a
future steady-state mode can pass `["tinycloud.sql/read","tinycloud.sql/write"]`.
The default keeps `admin` because Phase 5 still runs `ensureSchema()` (DDL) on boot.

---

## Validation reject-matrix

The validator returns a structured result OR throws a typed
`DelegationPolicyError` with a stable `reason` code. Each row is one failing
fixture test (TDD-first).

| `reason` code            | Trigger                                                                                  | Error message contains (non-secret)            |
| ------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `MALFORMED`              | `deserializeDelegation` throws, or required fields (`delegateDID`/`expiry`) absent/unparseable | "malformed delegation" + which field           |
| `WRONG_DELEGATEE`        | `delegateDID` does not match the configured stable agent DID (via `principalDidEquals`)  | expected agent DID + actual delegatee DID       |
| `EXPIRED`                | `expiry` <= now (configurable `now`/clock for tests)                                       | expiry timestamp (ISO) + now                   |
| `MISSING_SQL_RESOURCE`   | no `resources[]` entry (and no flat fallback) with `service` ∈ {`sql`,`tinycloud.sql`} for the policy path | required service + path                          |
| `WRONG_DB_HANDLE`        | a SQL resource exists but its `path` != policy `dbHandle`                                  | expected db handle + actual path                |
| `INSUFFICIENT_ACTIONS`   | the matched SQL resource's `actions` (normalized to full-URN) do not cover the required SQL action set | missing action URNs                              |

Notes:
- **Never leak**: error messages MUST NOT include `delegationHeader.Authorization`,
  `authHeader`, the serialized blob, or agent key material. DIDs, paths, service
  names, action URNs, and timestamps are non-secret and SHOULD be included for
  diagnosability.
- **Ordering**: checks run in the matrix order above (malformed -> delegatee ->
  expired -> resource presence -> db handle -> actions). First failure wins, so the
  error is the most fundamental problem. Tests assert each fixture trips the
  *expected* reason even when it could trip a later one.
- **Action normalization**: a resource may carry short or full-URN actions. Normalize
  both the granted actions and the required actions to full-URN via
  `expandActionShortNames(service, actions)` before set-comparison, so
  `["read","write","admin"]` and `["tinycloud.sql/read",...]` compare equal.
- **Multi-resource preference**: if `resources` is present, iterate it; else
  synthesize a single pseudo-resource from the flat (`service` inferred from path /
  policy, `path`, `actions`). This handles both the multi-resource WASM path and the
  legacy single-resource shape.

---

## Policy-hash decision

**Decision: land a MINIMAL, deterministic policy-hash in Phase 4, but keep STATUS
reporting (`active | expired | stale | none`) as a thin pure function with NO
persistence.** Persistence/where-it-lives is deferred (Open Question #3).

Rationale:
- The hash is cheap, pure, and deterministic: `sha256(canonical(policy) + "|" +
  agentDID)` over a stable canonical JSON of `{ service, path, actions(sorted) }[]`
  + the agent DID. It has no SDK dependency and no I/O, so it cannot destabilize
  the tree and is trivially unit-testable (same inputs -> same hash; reordered
  actions -> same hash; changed path -> different hash).
- It directly enables the plan's required test "policy mismatch is reported as
  stale when policy hashes are implemented" and the handoff's
  `DelegationStatus = "active" | "expired" | "none" | "stale"` vocabulary.
- What is **deferred** (Open Question #3): *storing* the hash + grant status across
  process restarts and *advertising* it over an endpoint
  (tinyboilerplate's `/server-info` pattern). That belongs to the consent/sidecar
  work (Phase 6+) or a future `agent-client` status store. Phase 4 only provides
  the pure `computePolicyHash(policy, agentDID)` and
  `evaluateDelegationStatus({ delegation, policy, agentDID, storedHash?, now })`
  building blocks and a `stale` determination when a caller passes a `storedHash`
  that differs from the freshly computed one. No file/DB writes.

So: **hash + pure status function land now; persistence/transport of status is a
Phase 6+ hand-off.** This is the smallest slice that satisfies the Phase 4
acceptance test for `stale` without committing to Open Question #3's storage venue.

---

## Interaction with `auth-composition.test.ts` (redaction)

`auth-composition.test.ts` currently has two CHARACTERIZATION tests that assert the
*current* leak posture:

- `"CURRENT POSTURE: resolved delegation config holds key material in cleartext"`
- `"CURRENT POSTURE: JSON.stringify ... exposes secrets (Phase-3 redaction TODO)"`

The file's own comments say: *"When Phase 3 adds a `toJSON` redaction, flip these
to `.not.toContain(...)`."* Phase 3's plan may or may not do this. Phase 4 OWNS the
secret-handling hardening (the reject-matrix errors must never leak, and the
policy-hash reads the resolved config). Therefore Phase 4 adds the `toJSON`
redaction to `ResolvedDelegationConfig` and **deliberately flips** those two tests
in the SAME task, with a comment pointing back to this plan. This is an explicit,
reviewed change of posture — not a silent break.

If Phase 3 has already added the redaction by the time Phase 4 runs, the redaction
task becomes a no-op assertion-only task (verify the guard exists; flip not needed).
The task prompt instructs the worker to detect this and adapt.

---

## Ordered atomic tasks

All tasks: branch `feature/mvp`, package `@tinycloud/agent-client`, zero
host-framework imports, TDD (failing tests first), `manual: false`. Each task must
leave `bun --bun run build`, `bun --bun run typecheck`, `bun --bun run test` GREEN,
and must NOT introduce a `useDelegation(` call in package source (regression guard).

See the task list below; full worker prompts are inline.

---

## Proposed deterministic regression guards

These extend `.smithers/scripts/tinycloud-agents-openkey-auth-regression.mjs`
(or a Phase-4 sibling) so the policy validator stays honest. All are pure shell
checks, deterministic, no network.

1. **`policy-validator-source-exists`** —
   `test -f packages/agent-client/src/delegation-policy.ts` (and its
   `delegation-policy.test.ts`). Proves the validator landed where Phase 3 expects.
2. **`validator-does-not-activate-delegated-sql`** — reuse/extend the existing
   `! rg -n 'useDelegation\s*\(' packages/agent-client/src ...` guard. The Phase 4
   validator must remain pre-activation and pure; this proves it never reaches for
   `useDelegation`.
3. **`validator-does-not-leak-secrets`** —
   `! rg -n 'delegationHeader|authHeader|Authorization' packages/agent-client/src/delegation-policy.ts`
   — the validator file must never reference the auth-bearing fields, structurally
   guaranteeing the reject-matrix errors cannot interpolate them.
4. **`redaction-guard-present`** —
   `rg -q 'toJSON' packages/agent-client/src/config.ts` — proves the
   `ResolvedDelegationConfig` redaction landed (closes the auth-composition TODO).
   Pairs with the unit test that `JSON.stringify(resolved)` no longer contains the
   secret values.

(Plus the existing gate — build, typecheck, test, diff-check, branch guard — runs
unchanged and is the final acceptance for every task.)

---

## Hand-off to Phase 5

Phase 5 (Eliza plugin integration) is OUT OF SCOPE here. Phase 4 hands Phase 5:

- `validateDelegationPolicy(delegation, policy)` and the default Eliza-memory
  policy builder (`eliza memory policy from resolved config`), so Phase 5 / Phase 3's
  transport validates before activation and surfaces a typed `DelegationPolicyError`
  to the plugin's fail-closed write path.
- `computePolicyHash(policy, agentDID)` + `evaluateDelegationStatus(...)` so a later
  `/server-info`-style surface (Phase 6+) and the plugin's status reporting can
  reuse one definition of `active | expired | stale | none`.
- The redaction guard on `ResolvedDelegationConfig`, so Phase 5's config logging is
  safe by construction.
- Open Question #3 (where policy hash/status persists) and #4 (admin truly required
  steady-state) remain open and are explicitly flagged for the Phase 5/6 owner. The
  policy object's action set being a field, not a constant, is the seam they use.

---

## Task definitions (authoritative; mirror the returned JSON)

### phase4-sdk-symbol-probe
- title: Probe @tinycloud/node-sdk 2.3.0 re-exports the validator needs
- files: `packages/agent-client/src/delegation-policy.test.ts`
- dependsOn: []
- tdd: failing test importing `{ deserializeDelegation, serializeDelegation,
  expandActionShortNames, principalDidEquals, SERVICE_SHORT_TO_LONG, pkhDid }`
  from `@tinycloud/node-sdk`, asserting each is a function / defined object.
- prompt: Add a single focused test file `delegation-policy.test.ts` whose FIRST
  describe block (`"node-sdk re-export surface"`) imports the symbols the Phase 4
  validator will use from `@tinycloud/node-sdk` and asserts their types
  (`expect(typeof deserializeDelegation).toBe("function")`, etc.). This is a
  fail-fast probe because node-sdk 2.3.0 is resolved from bun.lock but its root
  re-export list was grounded against 2.2.0-beta.12 on disk. Do NOT implement the
  validator yet — only the import probe. If any symbol is missing under 2.3.0,
  STOP and report it in `blockers` (do not invent a workaround); the plan's RISK
  section anticipates a rename and the fallback is to import the missing helper
  from `@tinycloud/sdk-core` instead. Run build, typecheck, test.
- acceptance: probe test passes; all six symbols resolve from `@tinycloud/node-sdk`
  (or the worker reports the exact missing symbol in blockers). Tree green.
- risks: a symbol renamed/dropped in 2.3.0 vs beta.12 (then: import from sdk-core).
- manual: false

### phase4-policy-types
- title: Policy types + default Eliza-memory policy builder
- files: `packages/agent-client/src/delegation-policy.ts`,
  `packages/agent-client/src/delegation-policy.test.ts`,
  `packages/agent-client/src/index.ts`
- dependsOn: [phase4-sdk-symbol-probe]
- tdd: tests for `defaultElizaMemoryPolicy(dbHandle)` producing the SQL resource
  (path = dbHandle, actions = read/write/admin, required) + optional capabilities
  entry; test that the policy path tracks the passed dbHandle (no hardcoded second
  literal).
- prompt: Define `DelegationPolicy` (a `{ resources: PolicyResource[] }` where
  `PolicyResource = { serviceLong: string; serviceShort: string; path: string;
  requiredActions: string[]; required: boolean }`) and a
  `defaultElizaMemoryPolicy(dbHandle = DEFAULT_DB_HANDLE): DelegationPolicy`
  builder that encodes the narrow policy table from
  `docs/openkey-phases/phase-4-policy-validation-plan.md`. The SQL resource path
  MUST come from the `dbHandle` argument; `capabilities` is `required:false`.
  Export the type and builder from `index.ts`. TDD first. No validation logic yet.
  Run build, typecheck, test.
- acceptance: builder tests pass; default policy has SQL read/write/admin on the
  passed db handle and an optional capabilities/read entry; exported from index.
- risks: action short/long form mismatch — store required actions as full-URN and
  document it.
- manual: false

### phase4-deserialize-safe
- title: Safe deserialize wrapper + MALFORMED reject
- files: `packages/agent-client/src/delegation-policy.ts`,
  `packages/agent-client/src/delegation-policy.test.ts`,
  `packages/agent-client/src/errors.ts`,
  `packages/agent-client/src/errors.test.ts`,
  `packages/agent-client/src/index.ts`
- dependsOn: [phase4-policy-types]
- tdd: failing tests: `deserializeDelegationSafe("not json")` -> throws
  `DelegationPolicyError` with `reason: "MALFORMED"`; a delegation object missing
  `delegateDID` or with an unparseable `expiry` -> `MALFORMED`; error message
  never contains the input blob.
- prompt: Add a typed `DelegationPolicyError extends TinyCloudClientError` to
  `errors.ts` carrying `{ reason: "MALFORMED"|"WRONG_DELEGATEE"|"EXPIRED"|
  "MISSING_SQL_RESOURCE"|"WRONG_DB_HANDLE"|"INSUFFICIENT_ACTIONS" }` plus
  non-secret context. Add `deserializeDelegationSafe(serialized: string):
  PortableDelegation` to `delegation-policy.ts` that wraps the SDK
  `deserializeDelegation` in try/catch and maps any throw to a `MALFORMED`
  `DelegationPolicyError`. Also export a small `assertWellFormed(delegation)` that
  checks `delegateDID` present and `expiry` coercible to a valid `Date` (else
  `MALFORMED`). Error messages MUST NOT include the serialized blob or any
  `Authorization`/`authHeader`. TDD first. Run build, typecheck, test.
- acceptance: malformed-input and missing-field fixtures throw `MALFORMED`; error
  text excludes the blob/headers; `DelegationPolicyError` exported.
- risks: `expiry` arriving as ISO string vs Date — coerce defensively; unparseable
  => MALFORMED not EXPIRED.
- manual: false

### phase4-validate-core
- title: Core validateDelegationPolicy — delegatee, expiry, SQL resource, db handle, actions
- files: `packages/agent-client/src/delegation-policy.ts`,
  `packages/agent-client/src/delegation-policy.test.ts`,
  `packages/agent-client/src/index.ts`
- dependsOn: [phase4-deserialize-safe]
- tdd: the full reject-matrix as failing tests FIRST — wrong delegatee
  (`WRONG_DELEGATEE`), expired (`EXPIRED`, with injected `now`), missing SQL
  resource (`MISSING_SQL_RESOURCE`), wrong db handle (`WRONG_DB_HANDLE`),
  insufficient actions (`INSUFFICIENT_ACTIONS`) — plus a happy-path fixture that
  passes. Cover BOTH multi-resource (`resources[]`) and flat (`path`+`actions`)
  delegation shapes. Assert each fixture trips its expected reason in matrix order.
- prompt: Implement `validateDelegationPolicy(delegation: PortableDelegation,
  opts: { agentDID: string; policy: DelegationPolicy; now?: Date }): void`
  (throws `DelegationPolicyError` on first failure; returns void on success) in
  matrix order: (1) well-formed (reuse `assertWellFormed`); (2) delegatee match via
  `principalDidEquals(delegation.delegateDID, agentDID)` -> `WRONG_DELEGATEE`;
  (3) `expiry` coerced to Date, `<= (now ?? new Date())` -> `EXPIRED`; (4) find a
  SQL resource: prefer `delegation.resources` (match `service` against policy
  short/long via `SERVICE_SHORT_TO_LONG`), else synthesize from flat
  `path`+`actions`; absent -> `MISSING_SQL_RESOURCE`; (5) matched resource `path`
  != policy SQL path -> `WRONG_DB_HANDLE`; (6) normalize granted + required actions
  to full-URN via `expandActionShortNames` and require the granted set ⊇ required
  set -> else `INSUFFICIENT_ACTIONS` listing the missing URNs. Optional
  `capabilities` resource: if the policy entry is `required:false`, its absence
  does not reject. Error messages carry DIDs/paths/actions/timestamps only — NEVER
  `Authorization`/`authHeader`/blob. Export `validateDelegationPolicy`. TDD first.
  Run build, typecheck, test.
- acceptance: every reject-matrix fixture throws its expected `reason` in order;
  happy-path passes; both delegation shapes covered; no secret material in any
  error string (assert in tests).
- risks: db-handle prefixing scheme (manifest prefix vs raw) unverifiable without a
  live fixture — exact-match first, surface expected-vs-actual path; `isCapabilitySubset`
  not used in v1 (hand-rolled set check) to avoid manifest-space ambiguity.
- manual: false

### phase4-policy-hash-status
- title: Deterministic policy hash + pure delegation status (active/expired/stale/none)
- files: `packages/agent-client/src/delegation-policy.ts`,
  `packages/agent-client/src/delegation-policy.test.ts`,
  `packages/agent-client/src/index.ts`
- dependsOn: [phase4-validate-core]
- tdd: `computePolicyHash(policy, agentDID)` is deterministic (same inputs => same
  hash; reordered actions => same hash; changed path/agentDID => different hash);
  `evaluateDelegationStatus(...)` returns `"expired"` for a past-expiry delegation,
  `"stale"` when a passed `storedHash` differs from the freshly computed one,
  `"none"` when no delegation given, `"active"` for a valid current grant whose
  hash matches.
- prompt: Add `computePolicyHash(policy: DelegationPolicy, agentDID: string):
  string` = hex sha256 (`node:crypto`) over a canonical JSON of the policy's
  required resources (`{ serviceLong, path, requiredActions sorted }` array sorted
  by `serviceLong+path`) + `"|"` + `agentDID`. Add a PURE
  `evaluateDelegationStatus(args: { delegation?: PortableDelegation; policy:
  DelegationPolicy; agentDID: string; storedHash?: string; now?: Date }):
  "active"|"expired"|"stale"|"none"` — no I/O, no persistence: `none` if no
  delegation; run `validateDelegationPolicy` (catch EXPIRED -> `"expired"`; catch
  other reasons -> rethrow or map per tests); if `storedHash` provided and !==
  `computePolicyHash(...)` -> `"stale"`; else `"active"`. Do NOT add any file/DB
  persistence (Open Question #3 deferred). Export both. TDD first. Run build,
  typecheck, test.
- acceptance: hash deterministic & order-insensitive on actions; status function
  returns the four states per fixtures with no I/O; both exported.
- risks: hash canonicalization must sort actions AND resources to stay stable;
  status function must stay pure (no persistence) — persistence is Phase 6+.
- manual: false

### phase4-config-redaction
- title: toJSON redaction on ResolvedDelegationConfig + flip auth-composition characterization
- files: `packages/agent-client/src/config.ts`,
  `packages/agent-client/src/config.test.ts`,
  `packages/agent-client/src/auth-composition.test.ts`
- dependsOn: [phase4-validate-core]
- tdd: failing test: `JSON.stringify(resolveDelegationConfig({... agentKey:
  "0xSECRET", serializedDelegation: "SECRET" ...}))` does NOT contain `0xSECRET`
  or `SECRET`; the resolved object still EXPOSES the values via property access
  (so Phase 3 can still consume them) — only serialization is redacted.
- prompt: Add a non-enumerable `toJSON()` (or a redacting wrapper) to the object
  returned by `resolveDelegationConfig` so `JSON.stringify` replaces
  `agentKey` and `serializedDelegation` with a redaction marker
  (e.g. `"[redacted]"`), while direct property reads (`resolved.agentKey`) still
  return the real value for downstream consumption. Then update the TWO
  characterization tests in `auth-composition.test.ts`
  (`"CURRENT POSTURE: resolved delegation config holds key material in cleartext"`
  and `"CURRENT POSTURE: JSON.stringify ... exposes secrets"`) to the NEW posture:
  property access still returns secrets (keep that assertion), but
  `JSON.stringify(...)` `.not.toContain(...)` the secret values. Add a comment in
  the test referencing `docs/openkey-phases/phase-4-policy-validation-plan.md` as
  the deliberate posture change. IF a Phase-3 redaction already exists, only verify
  and flip the assertions (no duplicate guard). All OTHER existing tests MUST stay
  green. Run build, typecheck, test.
- acceptance: `JSON.stringify` of a resolved delegation config no longer contains
  secret values; property reads still return them; the two characterization tests
  flipped deliberately with a plan reference; full suite green.
- risks: a careless `toJSON` could hide fields Phase 3 reads via serialization —
  keep property access intact; only serialization is redacted.
- manual: false

### phase4-regression-guards
- title: Add Phase-4 deterministic regression guards
- files: `.smithers/scripts/tinycloud-agents-openkey-auth-regression.mjs` (in the
  `development` repo — see note), or a Phase-4 sibling script
- dependsOn: [phase4-policy-hash-status, phase4-config-redaction]
- tdd: n/a (shell guards); the guards themselves are the test. Add them and run the
  regression gate to prove green.
- prompt: NOTE — the regression script lives in
  `/Users/roman/Documents/GitHub/development/.smithers/scripts/`, OUTSIDE the
  `tinycloud-agents` repo. The workflow's `COMMON_BOUNDARIES` forbid editing the
  `development` repo from the worker. Therefore this task is for the WORKFLOW OWNER
  (the human/orchestrator running Smithers), not the in-repo worker: extend the
  regression script with the four guards from this plan's "Proposed deterministic
  regression guards" section (`policy-validator-source-exists`,
  `validator-does-not-activate-delegated-sql` [reuse existing],
  `validator-does-not-leak-secrets`, `redaction-guard-present`). If, instead, the
  team chooses to keep guards in-repo, add a `packages/agent-client/`-local check
  script. Decide placement at orchestration time. Run the gate to confirm green.
- acceptance: the four guards run deterministically and pass against the Phase-4
  tree; build/typecheck/test still green.
- risks: cross-repo edit boundary — this task may need to run OUTSIDE the worker's
  scope (orchestrator/human), or be reframed as an in-repo guard script.
- manual: false

### phase4-final-green-gate
- title: Final acceptance — entire suite incl. auth-composition green; no useDelegation
- files: [] (verification only)
- dependsOn: [phase4-policy-hash-status, phase4-config-redaction, phase4-regression-guards]
- tdd: n/a — runs the full gate.
- prompt: Run the full deterministic gate: `bun --bun run build`,
  `bun --bun run typecheck`, `bun --bun run test`, and confirm
  `! rg -n 'useDelegation\s*\(' packages/agent-client/src packages/eliza-plugin-memory/src`
  still holds (Phase 4 is pre-activation; the validator must NOT call
  `useDelegation`). Confirm `auth-composition.test.ts` and all prior tests are
  green (with the two characterization tests deliberately flipped). Report counts.
  Make NO code changes; if anything is red, report it in `blockers` for a fix round.
- acceptance: full suite green; `useDelegation(` absent from package source;
  auth-composition + all prior tests pass; redaction + policy-validator guards pass.
- risks: none beyond surfacing a regression from an earlier task.
- manual: false
