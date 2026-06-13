# Handoff: TinyCloud × Eliza delegated-memory — plan the path to prod-ready

Date: 2026-06-13
Purpose: A fresh agent should **plan** (then execute) the work to take the
TinyCloud × Eliza delegated-SQL-memory integration from "MVP, live-proven" to
**prod-ready** — **excluding** publishing, releasing, and actual deployment.
Extensive investigation and a full live round-trip already happened this session —
**do not repeat it.** Trust the findings below unless a live run contradicts them.

Repo: `/Users/roman/Documents/GitHub/tinycloud-agents` (branch `feature/mvp`).

---

## TL;DR

- **Where we are:** the happy path is functionally complete and **proven live** end-to-end
  against prod `node.tinycloud.xyz` (passkey → minted `tinycloud.sql` delegation to the
  agent `did:pkh` → agent does delegated SQL memory: write, cross-client read, fresh-process
  restore — all green). Both packages build/typecheck and pass unit tests
  (agent-client 192/0, eliza-plugin-memory 98/0).
- **Why it's NOT prod-ready:** the security gate is incomplete and a few things are
  unhardened. The single biggest item is that **deep policy validation is written and tested
  but NOT wired into the live path**, and — critically — the way it (and the shallow
  validator) currently read grants is from **UNSIGNED, forgeable** fields.
- **The plan must cover** GAPs 1–6 below. **Out of scope:** `npm publish`, version/release,
  changesets, deploying an Eliza agent. In-scope = code, tests, hardening, commit/review.

---

## Current state (already done — do not redo)

- **Phases 3–8 implemented and green** (build/typecheck/unit tests pass), but **all
  uncommitted** on `feature/mvp` (20+ modified/untracked files). Nothing merged or released.
- **Live proof PASSED 2026-06-13** via `packages/eliza-plugin-memory/scripts/live-delegated-scenarios.ts`
  (steps 4–6). Re-run anytime with:
  ```sh
  cd packages/eliza-plugin-memory
  TINYCLOUD_LIVE=1 \
  TINYCLOUD_DELEGATION_FILE="$(pwd)/.tinycloud/agent-delegation.json" \
  TINYCLOUD_AGENT_KEY_FILE="$(git rev-parse --show-toplevel)/.tinycloud/agent.key" \
  TINYCLOUD_HOST="https://node.tinycloud.xyz" \
  bun --bun scripts/live-delegated-scenarios.ts
  ```
- **The delegation harness** that mints the file is at `tools/delegate-ui` (standalone Vite,
  published `@tinycloud/web-sdk@2.3.0` + `@openkey/sdk@^0.8.4`). It works; a raw, unedited
  harness mint now validates and runs live. See `[[delegate-ui-harness-built]]`.
- **Two live-only bugs were found and fixed this session** (both uncommitted):
  1. `tools/delegate-ui/src/delegate.ts` — `actionsFromAuthJwt()` completes the (lossy)
     top-level `actions` summary from the signed JWT before download. *(See GAP 2 — this is a
     client-side mitigation, not the durable fix.)*
  2. `packages/agent-client/src/delegated-transport.ts` — `defaultActivate` now calls
     `await node.signIn()` before `node.useDelegation()` (node-sdk 2.3.0 wallet-mode requires
     an established session). Regression test: `delegated-transport-activate-order.test.ts`.

---

## Hard-won findings (the load-bearing facts)

### F1 — The validators read UNSIGNED, forgeable fields. This is the heart of the work.
- A `PortableDelegation`'s real, signed capability lives in
  `delegation.delegationHeader.Authorization` — a JWT whose `att` (attenuations) grants, e.g.:
  ```
  ".../sql/xyz.tinycloud.eliza/memory"          → tinycloud.sql/{read,write,admin}
  ".../capabilities/xyz.tinycloud.eliza/memory" → tinycloud.capabilities/read
  aud → did:pkh:eip155:1:0x83cD9777…  (the agent)
  ```
- **But** web-sdk 2.3.0's `serializeDelegation` writes the top-level **`actions`** summary as
  only `["tinycloud.capabilities/read"]` and emits **no `resources`** field — even though the
  signed JWT grants SQL. And `deserializeDelegation` is a plain `JSON.parse` (it does NOT
  reconstruct `actions`/`resources` from the header — verified in node-sdk core.js).
- Both agent-side validators read those top-level fields:
  - `validateDelegationShape` (shallow, **the only one currently wired**,
    `delegated-transport.ts:~214`) checks `delegation.actions.some(a => a.startsWith("tinycloud.sql/"))`
    or `delegation.resources?.some(r => r.service === "sql")`.
  - `validateDelegationPolicy` (deep, **NOT wired**) prefers `delegation.resources[]`, and when
    `resources === undefined` (the raw web-sdk case) falls back to flat `delegation.path` +
    `delegation.actions` (`delegation-policy.ts:~205-235`).
- **Consequence A (correctness):** on a raw web-sdk mint, `resources` is undefined and `actions`
  is lossy, so the deep validator's flat branch sees `actions = [capabilities/read]` → fails
  check (6) `INSUFFICIENT_ACTIONS`. Wiring it naively **breaks raw harness output** unless the
  client-side `actionsFromAuthJwt` mitigation ran first.
- **Consequence B (security):** these top-level fields are **unsigned**. A hand-crafted file
  could claim `actions: ["tinycloud.sql/admin"]` while the signed JWT grants nothing — and pass
  both client validators. (Server-side enforcement via the bearer header still denies real
  access, but the client validators give *false confidence*.)
- **Therefore the prod-correct move: derive granted resources/actions from the SIGNED JWT `att`,
  not the unsigned summary.** A pure base64url-decode of `Authorization.split(".")[1]` → parse
  `att` keys is enough (proven this session in `actionsFromAuthJwt` and throwaway scripts). Make
  that the source of truth for validation. Then both validators are trustworthy, raw harness
  output validates, and the client-side `actions` completion becomes belt-and-suspenders.

### F2 — `node.signIn()` is now load-bearing on every activation.
- `defaultActivate` builds a fresh `TinyCloudNode({ privateKey, host })`, calls `signIn()`
  (real SIWE as the agent's own pkh; may auto-touch the agent's own space), then `useDelegation`.
  `Session.reSignIn()`/`invalidate()` rebuild the node → re-`signIn()` each retry. Confirm this
  is idempotent/cheap and that signIn failures surface cleanly (see GAP 4).

### F3 — Duplicate `memoryStorage` serviceType is benign but order-dependent.
- `@elizaos/plugin-sql` registers `AdvancedMemoryStorageService` for the same `memoryStorage`
  serviceType. We win because **first-registered wins** (asserted in
  `src/__tests__/slot-precedence.test.ts`; our `storage.ts:86` sets `serviceType = "memoryStorage"`).
  A warning is logged. It's a latent fragility, not a bug (see GAP 5).

### F4 — Negative-path tests exist but only at the UNIT level.
- `scripts/live-delegated-negative.test.ts` calls `validateDelegationPolicy` **directly**
  (wrong-delegatee / expired / insufficient / header-non-leak). It does NOT prove the live
  `DelegatedTransport.signIn` path rejects bad delegations — because the deep validator isn't
  wired yet.

---

## The prod-readiness gaps to address (plan these)

### GAP 1 — [P0, security] Wire deep policy validation, sourced from the SIGNED capability
- Wire `validateDelegationPolicy(delegation, { agentDID: identity.did, policy: defaultElizaMemoryPolicy(this.config.dbHandle) })`
  at the explicit `TODO(Phase 5)` site in `delegated-transport.ts` (after `validateDelegationShape`,
  **before** `deps.activate` — so `WRONG_DELEGATEE` / `WRONG_DB_HANDLE` / `INSUFFICIENT_ACTIONS` /
  `EXPIRED` reject before any network call).
- **Do NOT wire it against the unsigned summary.** Per F1, first **normalize from the signed JWT
  `att`**. Strongly consider a single chokepoint: a `deserializeAndNormalize(serialized)` that
  runs `deserializeDelegation` then decodes `delegationHeader.Authorization` and **populates
  `resources`/`actions` from the att**. Route the transport through it so BOTH validators "just
  work" on signed-derived data, and the result is trustworthy. (This also subsumes GAP 2.)
- Keep the shallow validator as a cheap pre-check or fold it in — but the authoritative gate must
  read the signed side.

### GAP 2 — [P1] Eliminate dependence on the lossy/unsigned `actions` summary
- The web-sdk 2.3.0 `serializeDelegation` lossiness (F1) is the root cause. **Preferred fix:
  GAP 1's signed-att normalization makes the summary irrelevant to security/activation** — do
  that, in this repo. The harness's `actionsFromAuthJwt` then stays only for a human-readable UI
  / nicety, not as a load-bearing correctness step.
- Optionally file an upstream issue against web-sdk/node-sdk to populate `resources`/`actions`
  from the header in `serializeDelegation`/`deserializeDelegation`. **Do not** attempt to patch
  web-sdk from inside this repo (separate repo, out of scope).

### GAP 3 — [P1, test] Enforce negative paths through the LIVE transport, incl. a forgery fixture
- Once GAP 1 is wired, add tests that `DelegatedTransport.signIn()` **rejects before any
  `useDelegation` call**: wrong-delegatee, wrong-db-handle, insufficient-actions, expired.
- Add a **forged-unsigned-actions** fixture: top-level `actions` claims `tinycloud.sql/*` but the
  signed `att` grants none → MUST reject. This is the test that proves we validate the signed
  side (F1 Consequence B). Reuse `scripts/fixtures/make-delegation-fixtures.ts`.

### GAP 4 — [P2, robustness] Harden the new `signIn()`-on-every-activation path
- Verify `defaultActivate`'s `signIn()` is idempotent/cheap on reactivation; that
  `Session.reSignIn()`/`invalidate()` still behave; and that a `signIn()` network failure
  produces a clean typed error (no agent-key/header leakage — honor the HARD CONTRACT in
  `delegated-transport.ts` header). Consider caching the signed-in node/session within a single
  transport lifetime if reactivation cost matters. Ordering is already regression-tested.

### GAP 5 — [P2, operational hardening]
- **serviceType slot:** decide between (a) keep first-registered-wins + assert the invariant and
  document the load-order dependency (cheapest; `slot-precedence.test.ts` already guards it), or
  (b) make it load-order-robust (distinct serviceType / `getServicesByType`). Pick one; remove
  the fragility or pin it with a test + doc.
- **Embeddings:** the live run had no `TEXT_EMBEDDING` model → memories stored without embeddings.
  Exercise the semantic-search memory path with a real embedding model before declaring prod-ready.
- **Agent key provisioning:** the live proof used a throwaway `.tinycloud/agent.key`. Define the
  dedicated-agent-key story (generation per phase-7 runbook already exists; add secret handling /
  rotation guidance). Never the operator's main wallet key.
- **Delegation expiry:** observed ~7 days, session-capped by the parent sign-in window (child
  expiry ≤ parent). Document the re-mint cadence and surface expiry to operators.
- **OpenKey origin allow-listing** for the real `delegate-ui` origin (config, not code) — note it
  for the eventual deploy, but the allow-list entry itself is an ops task.

### GAP 6 — [P1, hygiene] Commit / review the working tree (NOT release)
- Get phases 3–8 + this session's fixes committed and reviewed on a branch. Confirm `.tinycloud/`
  (agent key + delegation file) is gitignored — these are secrets and must never be committed.
  **Scope stops at committed + reviewed; no publish/release/tag/deploy.**

---

## Dead ends / do NOT do (already decided or disproven)

1. **Do NOT trust the unsigned top-level `actions`/`resources` for any security or activation
   decision** — they're forgeable and lossy (F1). Validate the signed `att`.
2. **Do NOT wire `validateDelegationPolicy` against the unsigned summary and call it done** —
   that's the trap: it breaks raw harness output AND validates forgeable data.
3. **Do NOT remove the agent's `node.signIn()` before `useDelegation`** — node-sdk 2.3.0 wallet
   mode requires it ("Not signed in. Call signIn() first."); it's regression-tested.
4. **Do NOT patch web-sdk/node-sdk serialization from inside this repo** — separate repos, out of
   scope. Solve via signed-att normalization here; file an upstream issue if desired.
5. **Do NOT publish, release, version-bump, changeset, or deploy** — explicitly out of scope.
6. **Do NOT re-mint a delegation to "test"** unless needed — a working file is already at
   `packages/eliza-plugin-memory/.tinycloud/agent-delegation.json` (expires ~2026-06-20). The
   live passkey mint is manual (WebAuthn) anyway.

---

## Pointers

- Transport + wiring site: `packages/agent-client/src/delegated-transport.ts`
  (`defaultActivate` ~L97; `validateDelegationShape` call ~L214; `TODO(Phase 5)` ~L221).
- Shallow validator: `packages/agent-client/src/delegation-validate.ts` (`validateDelegationShape`).
- Deep validator (written, tested, UNWIRED): `packages/agent-client/src/delegation-policy.ts`
  (`validateDelegationPolicy`, `defaultElizaMemoryPolicy(dbHandle)`, `DelegationPolicyError`).
- Ordering regression: `packages/agent-client/src/delegated-transport-activate-order.test.ts`.
- Storage service / slot: `packages/eliza-plugin-memory/src/storage.ts` (`serviceType="memoryStorage"`,
  `startClient` → `signIn` → `ensureSchema`); `src/__tests__/slot-precedence.test.ts`.
- Negative tests (unit-level only): `packages/eliza-plugin-memory/scripts/live-delegated-negative.test.ts`;
  fixtures: `packages/eliza-plugin-memory/scripts/fixtures/make-delegation-fixtures.ts`.
- Live scenario (the prod proof): `packages/eliza-plugin-memory/scripts/live-delegated-scenarios.ts`
  + `docs/openkey-phases/phase-7-runbook.md`.
- Config / delegation mode: `packages/agent-client/src/config.ts`,
  `packages/eliza-plugin-memory/src/config.ts` (`TINYCLOUD_AUTH_MODE=delegation`).
- Harness (mints the file): `tools/delegate-ui/src/{delegate,openkey,main}.ts` (`actionsFromAuthJwt`).
- Design plans (read for intent, but trust THIS doc on current reality):
  `docs/openkey-phases/phase-4-policy-validation-plan.md`, `phase-5-eliza-integration-plan.md`,
  `PHASE-SYNTHESIS.md`, and the prior `delegation-harness-handoff.md`.
- Agent identity / key: `packages/agent-client/src/agent-identity.ts`;
  throwaway test key `.tinycloud/agent.key` → DID `did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c`.

---

## Open questions for the planner to resolve

1. **Normalization shape:** add a `deserializeAndNormalize` chokepoint that rewrites
   `resources`/`actions` from the signed `att` (cleanest — both validators read normalized,
   signed-derived data), OR teach each validator to decode the att itself? Recommend the
   chokepoint.
2. **Policy strictness:** `defaultElizaMemoryPolicy` requires `sql/{read,write,admin}` (admin for
   `ensureSchema` DDL). Confirm `admin` is genuinely required in prod, or scope it down to reduce
   the agent's blast radius (least privilege).
3. **serviceType:** keep first-registered-wins (document + assert) or move to a distinct type /
   `getServicesByType`? Decide before prod so behavior isn't plugin-load-order-dependent.
4. **Scope check:** confirm "prod-ready minus publish/release/deploy" means: code complete +
   hardened + fully tested (incl. live negative paths) + committed/reviewed — and that a real
   embedding-model memory pass is in scope (recommended yes).
