# OpenKey Delegated Auth — Phase Synthesis & Cohesion

Date: 2026-06-13
Source plans: `phase-3..8-*-plan.md` in this directory (one per remaining phase).
Status of tree: Phases 0–2 shipped (config union, stable agent DID, eliza env
resolution). Phases 3–8 are designed below and not yet implemented.

This document is the **authority for cross-phase cohesion**. Each phase plan is
authoritative for its own atomic tasks; where two plans collided, the resolution
here wins.

---

## 1. Phase dependency DAG

```
P3 Delegated Transport  ──►  P4 Policy Validation  ──►  P5 Eliza Integration
        │                          │                          │
        │                          ▼                          │
        │                    P6 Consent Harness ◄─────────────┘
        │                          │
        ▼                          ▼
        └──────────────►   P7 Live Scenario   ──►   P8 Docs (gated on 3–7 shipped)
```

- **3 → 4**: Phase 3 lands a `DelegatedTransport` with *shallow* shape validation;
  Phase 4 deepens it into the full policy matrix and slots in **before**
  `useDelegation`. 4 cannot deepen what 3 hasn't created.
- **4 → 6**: the consent harness emits the exact permission set the validator
  checks. They must share one module (see §2.1).
- **3 → 5**: Phase 5's delegated `start()` only works once Phase 3 removes the
  `createAgentClient` "not yet implemented" throw.
- **6 → 7**: Phase 7's live flow consumes the delegation file Phase 6's runbook
  produces. Phase 7's *negative fixtures* need only Phase 4's validator (no live).
- **3–7 → 8**: docs flip to "shipped" only behind a precondition gate.

---

## 2. Cohesion resolutions (these override the individual plans)

### 2.1 — Single shared policy module (resolves P4 ↔ P6 collision)
P4 proposed `delegation-policy.ts` (`defaultElizaMemoryPolicy`, `computePolicyHash`).
P6 proposed a parallel `memory-policy.ts` (`buildMemoryPolicy`, `memoryPolicyHash`).
**Resolution:** ONE module, owned by Phase 4: `packages/agent-client/src/delegation-policy.ts`.
- Phase 4 builds it: `defaultElizaMemoryPolicy(dbHandle)`, `computePolicyHash(policy, agentDID)`, `validateDelegationPolicy(...)`.
- **Phase 6 DROPS its `phase6-shared-memory-policy` and `phase6-policy-hash` tasks** and instead imports `defaultElizaMemoryPolicy`/`computePolicyHash` from `@tinycloud/agent-client`.
- The P6 harness unit test asserting "payload deep-equals the validator's policy" now compares against the **same** exported `defaultElizaMemoryPolicy` the validator uses — drift becomes structurally impossible.

### 2.2 — Secret redaction owned by Phase 3 (resolves P3 ↔ P4 collision)
Both `phase3-secret-redaction` and `phase4-config-redaction` claimed: (a) add
`toJSON` to `ResolvedDelegationConfig` in `config.ts`, and (b) flip the two
`CURRENT POSTURE` characterization tests in `auth-composition.test.ts`.
**Resolution:** Phase 3 owns (a) + (b) — it is the first phase where delegation
material actually flows through a transport, so the posture must change there.
- **Phase 4 DROPS `phase4-config-redaction`.** Phase 4 keeps only *validator-internal*
  non-leak assertions (errors from `delegation-policy.ts` never include
  `delegationHeader`/`Authorization`/`agentKey`) — a different file, no overlap.
- `toJSON` must redact only the *serialized* form; property access
  (`resolved.agentKey`) stays readable so Phase 3's transport can consume it.

### 2.3 — `useDelegation` guard inversion timeline (resolves the guard flagged by P3/P5/P7/P8)
The current regression gate forbids `useDelegation(` in package source
(`first-pr-does-not-activate-delegated-sql`). That guard is correct for phases 0–2
and **wrong from Phase 3 on**. Per-phase regression scripts evolve it:

| Phase | `useDelegation` guard |
|-------|------------------------|
| 0–2 (current) | `! rg 'useDelegation\(' packages/*/src` — must be ABSENT |
| **3** | REMOVE forbid. ADD: `useDelegation(` appears **only** in `delegated-transport.ts`, nowhere else in src |
| **4** | Keep P3's guard. ADD: `useDelegation(` is **absent from `delegation-policy.ts`** (validator stays pure/pre-activation) |
| 5–8 | Inherit "only in `delegated-transport.ts`" |

### 2.4 — Regression scripts are authored by the orchestrator, not the workers
Every Smithers worker runs with `cwd = tinycloud-agents` and `COMMON_BOUNDARIES`
forbids editing the `development` repo. The per-phase regression `.mjs` scripts
live in `development/.smithers/scripts/`. Therefore **the human/orchestrator
authors each phase's regression script when building the workflow**; the tasks in
the plans that say "edit the regression script" are reclassified as
orchestrator-owned, not worker tasks. (Phase 4's `phase4-regression-guards` and
Phase 7's `phase7-regression-guards` are the explicit cases.)

---

## 3. Unified atomic-task sequence (post-cohesion)

Per-phase task ids as returned by planners, with the cohesion edits applied
(✂ = dropped, ➕ = added scope). Full task detail (prompts, tdd, acceptance) is in
each phase plan file.

**Phase 3 — Delegated Transport** (`delegated-transport.ts`)
1. `phase3-sdk-probe` — pin node-sdk 2.3.0 `useDelegation`/`db()` semantics
2. `phase3-delegated-transport-skeleton`
3. `phase3-delegation-shape-validation` (shallow; deepened by P4)
4. `phase3-activation-and-lifecycle` (signIn=activate, no proactive refresh, 1 retry)
5. `phase3-wire-create-agent-client` (remove the throw; flips auth-composition delegation case)
6. `phase3-secret-redaction` ➕ owns config `toJSON` + flips the 2 CURRENT POSTURE tests

**Phase 4 — Policy Validation** (`delegation-policy.ts`)
1. `phase4-sdk-symbol-probe`
2. `phase4-policy-types` — `defaultElizaMemoryPolicy(dbHandle)` (shared w/ P6)
3. `phase4-deserialize-safe` — MALFORMED path
4. `phase4-validate-core` — reject matrix (wrong delegatee / expired / missing SQL / wrong db handle / insufficient actions)
5. `phase4-policy-hash-status` — `computePolicyHash` + pure `evaluateDelegationStatus` (shared w/ P6)
6. ✂ `phase4-config-redaction` — DROPPED (moved to P3 §2.2)
7. `phase4-final-green-gate`

**Phase 5 — Eliza Integration** (mostly test migration; config already done)
1. `phase5-audit-mode-agnostic-storage` (static guard)
2. `phase5-inject-fake-delegated-client`
3. `phase5-delegation-start-via-config` (needs P3)
4. `phase5-migrate-failopen-delegation-assertion` (flips the "not yet implemented" test)
5. `phase5-parity-both-modes-readwrite`

**Phase 6 — Consent Harness** (`scripts/consent-harness.ts`)
1. ✂ `phase6-shared-memory-policy` — DROPPED (use P4's module, §2.1)
2. ✂ `phase6-policy-hash` — DROPPED (use P4's `computePolicyHash`, §2.1)
3. `phase6-consent-harness-script` ➕ imports policy from `@tinycloud/agent-client`
4. `phase6-harness-unit-tests` (cross-check vs `defaultElizaMemoryPolicy`)
5. `phase6-runbook-doc`
6. 🔒 `phase6-manual-openkey-signin` — MANUAL GATE
7. 🔒 `phase6-manual-browser-delegation` — MANUAL GATE

**Phase 7 — Live Scenario** (`scripts/live-delegated-scenarios.ts`)
1. `phase7-runbook-doc`
2. `phase7-fixtures-baseline` (scrubbed baseline delegation JSON + mutator)
3. `phase7-negative-fixture-test` (wrong-delegatee / expired / insufficient — CI-runnable, uses P4 validator)
4. `phase7-delegated-scenario-skipgate` (env-gated, skips to exit 0 by default)
5. `phase7-delegated-scenario-live-flow` (steps 4–6; runs only with `TINYCLOUD_LIVE=1` + real delegation file)
6. 🔒 manual steps 1–3 (human OpenKey sign-in, session, real delegation) — runbook gates

**Phase 8 — Docs** (gated)
1. `phase8-precondition-gate` (refuse to flip docs unless 3–7 shipped)
2. `phase8-readme-delegated-status-flip`
3. `phase8-readme-env-surface-parity` (incl. undocumented `TINYCLOUD_NODE_HOST`)
4. `phase8-readme-live-delegated-scenario`
5. `phase8-plugin-readme-flip`
6. `phase8-hydration-delegated`
7. `phase8-handoff-facts-update`
8. `phase8-final-acceptance-check`

---

## 4. Manual gates — why "fully autonomous, all phases" is not achievable

A Smithers worker cannot perform a live WebAuthn/passkey sign-in or click an
in-browser delegation approval. The following are **human-only** and are modeled
as documented gates the workflow stops at:

- P6: `phase6-manual-openkey-signin`, `phase6-manual-browser-delegation`
- P7: live steps 1–3 (human signs in, creates the real delegation to the agent DID)

**Everything else is automatable**, including P7's negative fixtures (crafted by
mutating a scrubbed baseline delegation — no passkey needed) and the post-delegation
read/write/restore flow (runs once a delegation file exists). So the autonomous
loop can fully carry **3 → 4 → 5 → 8** plus all automatable scaffolding of 6 & 7;
the live end-to-end *proof* requires one human pass through the P6/P7 runbooks.

---

## 5. Workflow architecture

One Smithers workflow **per phase** (matching the repo convention that every
workflow is a single concern; gives resumability and cost-isolation, and the
manual gates naturally break the chain). Each clones
`tinycloud-agents-openkey-auth.tsx`:

```
Sequence[
  setup (deterministic guard: branch + plan exists + seams present),
  impl-task-1 … impl-task-N   (sequential, each leaves tree green),
  Loop until happy, maxIterations 4 [
    audit-write  → audit-capture → fix → regression(phase-N script)
  ]
]
happy = auditClean(minScore=90, 0-10/0-100 normalized) && regression.passed && fix.changed==false
```

- Each phase gets its own regression script
  `tinycloud-agents-openkey-phaseN-regression.mjs` (orchestrator-authored, §2.4)
  carrying that phase's guards from §2.3 + the inherited build/typecheck/test/diff/branch baseline.
- "Move to next phase" = the prior phase workflow ends green; the next is launched
  (manually or chained). Phases 6/7 pause at their manual gates.

---

## 6. Net cohesion deltas vs raw plans

- Dropped 3 tasks (P4 config-redaction, P6 shared-policy, P6 policy-hash) → consolidated.
- Moved redaction + characterization-test flip to P3.
- Reassigned regression-script edits to orchestrator (cross-repo boundary).
- Defined the single `useDelegation` guard evolution so no phase contradicts another.
- Total automatable atomic tasks ≈ 33; manual gates = 4 (2 in P6, 2 in P7 runbook).
