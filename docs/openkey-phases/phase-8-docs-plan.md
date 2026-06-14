# Phase 8: Documentation Updates — Implementation Plan

Status: PLAN ONLY. This is the **final** phase of the OpenKey delegated-auth
effort. It runs **after** Phases 3-7 have landed (delegated transport, policy
validation, plugin integration, consent harness, live delegated scenario). Phase
8 flips the docs from "delegated SQL is not yet wired (Phase 3+)" to "delegated
mode is shipped and proven", and records final acceptance against the plan's
`## Acceptance Criteria`.

Authoritative source: `docs/openkey-auth-plan.md` → `## Phase 8: Documentation
Updates` (line ~316) and `## Acceptance Criteria` (line ~334).

> **Hard precondition for executing this plan:** Phases 3-7 are actually
> complete in the tree — `TinyCloudNode.useDelegation` is wired behind the
> `Transport` interface, delegated SQL reads/writes work, and a live (or
> documented-manual) delegated scenario has passed. If any of those is still
> open, **do not** run Phase 8: flipping the docs to "shipped" while the code is
> unwired would make the docs lie. The first regression guard below
> (`code-supports-shipped-claims`) enforces this by requiring `useDelegation(` to
> be present in package source before any "shipped" doc language is allowed. Note
> that this **inverts** the first-PR regression guard
> (`first-pr-does-not-activate-delegated-sql`), which asserts the *absence* of
> `useDelegation(`. The Phase 8 regression variant must drop / replace that guard.

---

## Goal

Make every user- and developer-facing doc in `tinycloud-agents` describe the
**shipped** two-mode auth reality accurately and consistently:

1. **Private-key mode** stores memory in an **agent-owned** TinyCloud space.
2. **Delegated mode** stores memory in the **user's** TinyCloud space.
3. The agent has a **stable DID** (`did:pkh:eip155:1:{address}`) derived from its
   own identity key, stable across process restarts.
4. **The agent key is NOT the user's key** — it is service identity material;
   compromise grants only the delegated memory capability, never the user's
   account.
5. **OpenKey proves the user and signs consent; the TinyCloud delegation grants
   the actual memory capability.** OpenKey answers "who is the user and can they
   sign"; the portable delegation answers "what may this agent do in the user's
   space". These are distinct and must not be conflated.

Secondary goal: keep the **documented env surface** byte-consistent with the
real `SETTING_KEYS` in `packages/eliza-plugin-memory/src/config.ts` and with the
Phase 6 consent harness output, and remove all stale "not yet implemented" /
"Phase 3+" hedges for capabilities that now ship.

### Framing constraint (project policy)

This is **developer/auth documentation**: be accurate and concrete about the
auth model (DIDs, delegations, ReCap abilities, OpenKey). The provider-agnostic
policy applies to **marketing-style copy** — do not introduce LLM/model/provider
product names into prose. Existing developer prose ("elizaOS", "TinyCloud",
"OpenKey", `@tinycloud/...`) stays. Do not add model/provider product names.

---

## Doc inventory: files, sections, and the exact claim that flips

### A. `README.md` (repo root)

| Section / anchor | Current claim | Flips to |
|---|---|---|
| `### 2. Configure the environment` → **Delegated mode** Status callout (lines ~64-69) | "Config parsing and the stable agent DID helper are implemented and tested. Delegated SQL activation (`TinyCloudNode.useDelegation`) and live OpenKey/passkey consent are **not yet wired** — this is the next PR. You can supply delegation env vars and verify they parse, but the agent will not yet read/write through delegated SQL." | **Remove the "not yet wired" hedge.** Replace with a shipped statement: delegated mode reads/writes the user's space through `TinyCloudNode.useDelegation`-activated delegated SQL; reference the consent harness (Phase 6) for obtaining a delegation; note the live delegated scenario (Phase 7). Keep any genuinely-still-deferred items (e.g. revocation/policy-hash status, auth sidecar) as explicitly-scoped "not in scope" notes if they remain unbuilt after Phase 7 — do **not** silently claim them. |
| Delegated mode env table (lines ~70-78) | Lists `TINYCLOUD_AUTH_MODE`, `TINYCLOUD_DELEGATION`, `TINYCLOUD_DELEGATION_FILE`, `TINYCLOUD_AGENT_KEY`, `TINYCLOUD_AGENT_KEY_FILE`, `TINYCLOUD_HOST`, `TINYCLOUD_DB_HANDLE`. | Verify against `SETTING_KEYS`. **Missing today:** the legacy host alias `TINYCLOUD_NODE_HOST` (`SETTING_KEYS.hostAlias`) is not documented in either mode's table. Add it (or a footnote) so the doc covers every `SETTING_KEYS` entry. No new vars should appear unless Phases 3-7 added settings — if they did, table must include them. |
| `## Live scenario testing` (lines ~113-135) | "This tests the current MVP auth shape (private-key mode)… It does not test OpenKey/passkey login or user-to-agent delegation." | Add a paragraph (or new subsection) documenting the **delegated** live scenario shipped in Phase 7: human OpenKey sign-in → user delegates memory SQL to the stable agent DID → agent writes through delegated SQL → separate user-authorized client reads the same rows → fresh process restores from the delegation and hydrates. State whether it is gated (e.g. `TINYCLOUD_LIVE=1` + delegation fixture) and whether it is automated or documented-manual (per Phase 7's "manual at first" stance). Do not claim automation that does not exist. |
| Identity-model statement (new, recommended) | README has no consolidated identity-model statement; it is implied. | Add a short "Identity model" note carrying the five required claims (agent-owned vs user space; stable agent DID; agent key ≠ user key; OpenKey proves+signs consent, delegation grants capability). This is the canonical home of the five required claims for the README guard. |
| `## Docs` list (lines ~178-188) | Links plan + handoff. | Verify links resolve; if a consent-harness doc (Phase 6) or this phases dir was added, link it. Ensure no link points at a removed/renamed file. |

### B. `packages/eliza-plugin-memory/README.md`

| Section / anchor | Current claim | Flips to |
|---|---|---|
| Opening sentence (line ~3) | "making a user-owned TinyCloud space the system of record" | This currently overstates for private-key mode (which is agent-owned). Reconcile: state **both** modes — private-key = agent-owned space; delegated = user-owned space. (This is a pre-existing inaccuracy that Phase 8 should correct while flipping status.) |
| `### Delegated mode (user-owned memory)` Status callout (lines ~98-102) | "Config parsing and the stable agent DID helper are implemented and tested. Delegated SQL activation and live OpenKey/passkey consent are **not yet wired** — these are Phase 3+ work… Do not overpromise sidecar, revocation, or live delegated auth readiness." | **Remove the "not yet wired" hedge.** State delegated mode is shipped: the user delegates the memory SQL capability to the agent DID via OpenKey/TinyCloud; the agent activates it and reads/writes the user's space. Keep an honest, explicitly-scoped note for anything still genuinely unbuilt after Phase 7 (e.g. revocation/policy-hash status, sidecar) rather than a blanket hedge. |
| Delegated mode env table (lines ~104-112) | Same 7 vars as README. | Same consistency check: cover every `SETTING_KEYS` entry incl. `TINYCLOUD_NODE_HOST` alias. Keep the two README tables (root + plugin) mutually consistent. |
| `## Multi-tenancy` → "Delegated mode" paragraph (lines ~122-124) | Already says memory is user-owned, scoped to the user's identity, via the user-granted delegation. | Mostly correct; verify it no longer reads as aspirational once status flips. Add the "agent key ≠ user key" clause if absent. |
| `### Private-key mode (default)` callout | "agent owns its own TinyCloud memory space" | Already correct; ensure wording stays consistent with the README identity-model note. |

### C. `docs/hydration.md`

| Section / anchor | Current claim | Flips to |
|---|---|---|
| Opening line (line ~7) | "owning the `memoryStorage` slot with a user-owned TinyCloud space" | Inaccurate for the walkthrough that follows, which is entirely **private-key / agent-owned** (`TINYCLOUD_PRIVATE_KEY` → same space). Correct the framing: the hydration story is told for private-key (agent-owned) mode; then add a short **delegated-mode hydration** note. |
| "The story: same key ⇒ same space" (lines ~12-41) | Describes only private-key key→space hydration. | Add a parallel **delegated-mode hydration** subsection: a fresh agent process restores from the **same serialized delegation** (`TINYCLOUD_DELEGATION` / `TINYCLOUD_DELEGATION_FILE`) + the **same stable agent key**, re-activates delegated access, and hydrates the **user's** space — mirroring Phase 7 acceptance step 6 ("Fresh agent process restores from the same delegation file and hydrates memory"). Make explicit that the durable space is the **user's**, not the agent's, in this mode. |
| roomId-stability caveat (lines ~43-66) | Mode-agnostic; still valid. | No change needed beyond confirming it applies to both modes. |

> `docs/hydration.md` **exists** (confirmed). The Phase 8 prompt's "find it; if
> absent, note it" resolves to: present, edit in place.

### D. `docs/openkey-auth-handoff.md` (update only if facts changed)

| Section / anchor | Current claim | Flips to (only if facts changed during 3-7) |
|---|---|---|
| Top `Status:` (lines ~3-4) | "first implementation slice drafted… Next: delegated SQL activation (Phase 3) and live OpenKey/passkey consent (Phase 6)." | If 3-7 shipped: update status to reflect that delegated auth is implemented and the acceptance matrix passed (or which items remain). |
| `### Done` / `### Not yet done (Phase 3+)` (lines ~562-580) | Lists delegated SQL activation, transport, consent harness, live delegated scenario as **not yet done**. | Move the now-shipped items from "Not yet done" to "Done". Leave genuinely-unbuilt items (sidecar, revocation/policy-hash) where they are, accurately. |
| `## Current Readiness Statement` (line ~560) | Reflects first-slice readiness. | Update to final readiness if facts changed. |

> Scope note: `docs/openkey-auth-handoff.md` is the **onboarding/source map**.
> Phase 8 edits it **only where facts changed** (per plan line 323). The source
> map sections (OpenKey routes, web-sdk APIs, tinyboilerplate prior art) are
> reference material and should be left intact unless they became wrong.

### E. Out of scope (verified, do not edit)

- `docs/openkey-auth-plan.md` — the authoritative plan; Phase 8 does not rewrite
  the plan. (Its per-phase `✓ done` markers in "Recommended First PR" may be
  refreshed only if a separate decision says so; default is **leave alone**.)
- `docs/openkey-auth-implementation-handoff.md` — a point-in-time record of the
  **first PR**. It is history; do not retro-edit it. (If a final implementation
  handoff is wanted, that is a Phase 3-7 deliverable, not Phase 8 docs.)
- `docs/registry-entry.md` — verified to contain **no** auth/delegation/private-key
  status claims (grep clean). Out of scope.

---

## Consistency-check approach

The core risk in a docs phase is **drift**: prose that claims env vars the code
does not read, or hedges the code no longer needs. Three deterministic checks
close that gap. They are plain `grep`/`rg` scripts (no build/typecheck/test
dependency — docs edits must not touch those gates).

1. **Env surface parity.** Extract the env var string literals from
   `SETTING_KEYS` in `packages/eliza-plugin-memory/src/config.ts` (the values:
   `TINYCLOUD_AUTH_MODE`, `TINYCLOUD_PRIVATE_KEY`, `TINYCLOUD_HOST`,
   `TINYCLOUD_NODE_HOST`, `TINYCLOUD_DB_HANDLE`, `TINYCLOUD_SPACE_PREFIX`,
   `TINYCLOUD_DELEGATION`, `TINYCLOUD_DELEGATION_FILE`, `TINYCLOUD_AGENT_KEY`,
   `TINYCLOUD_AGENT_KEY_FILE`). Assert each appears in `README.md` **and** in
   `packages/eliza-plugin-memory/README.md` (or, for the legacy alias, at least
   one of them with a clear "legacy alias" note). The check reads `SETTING_KEYS`
   dynamically so a future env var addition forces a doc update.

2. **Harness parity (Phase 6).** The consent harness prints `agent DID`,
   `TinyCloud host`, `db handle`, required permission JSON, and the delegation
   file path the runtime expects. Assert the docs name the same delegation env
   vars (`TINYCLOUD_DELEGATION` / `TINYCLOUD_DELEGATION_FILE`) and the same
   `db handle` default (`xyz.tinycloud.eliza/memory`, sourced from
   `DEFAULT_DB_HANDLE` / `MEMORY_DB_HANDLE`) that the harness uses, so the
   "how to get a delegation" doc path matches the harness it documents.

3. **Stale-hedge / shipped-language guard.** Assert no doc still contains the
   first-PR hedges (`not yet wired`, `not yet implemented`, "Delegated SQL
   activation … — Phase 3", "first implementation slice" in README/plugin-README)
   **for capabilities that now ship**, AND assert the five required identity
   claims are present. This guard is gated on the code precondition (check #0
   below) so it never runs against an unwired tree.

0. **Code precondition (gates the flip).** `rg 'useDelegation\s*\(' packages/agent-client/src`
   must **match** (delegated SQL is wired) before the stale-hedge guard is
   allowed to demand shipped language. This prevents Phase 8 from being executed
   prematurely and is the inverse of the first-PR guard.

---

## Ordered atomic tasks

```jsonc
[
  {
    "id": "phase8-precondition-gate",
    "title": "Verify Phases 3-7 shipped before flipping docs",
    "files": [
      "packages/agent-client/src",
      "packages/eliza-plugin-memory/src"
    ],
    "dependsOn": [],
    "tdd": [
      "guard: `rg 'useDelegation\\s*\\(' packages/agent-client/src` matches (delegated SQL is wired)",
      "guard: a delegated transport/source path exists (e.g. delegated-transport.ts present)",
      "guard: delegated live scenario artifact from Phase 7 exists or is documented-manual"
    ],
    "prompt": "Confirm the delegated-auth code from Phases 3-7 is present in the tree BEFORE any docs are flipped to 'shipped'. Run `rg 'useDelegation\\s*\\(' packages/agent-client/src` and confirm it matches. Confirm the delegated transport file and delegated-mode plugin integration exist. Confirm the Phase 7 live delegated scenario is present (automated or documented-manual). If ANY of these is missing, STOP and report that Phase 8 cannot run yet — do not edit any docs. Return a short JSON: { ready: boolean, evidence: string[], missing: string[] }.",
    "acceptance": "Reports ready=true only when delegated SQL activation, delegated transport, delegated plugin integration, and the Phase 7 scenario are all present. Otherwise ready=false and no docs are touched.",
    "risks": [
      "Running Phase 8 against an unwired tree would make docs lie",
      "False positive if useDelegation appears only in a comment/test — check it is real package source"
    ],
    "manual": false
  },
  {
    "id": "phase8-readme-delegated-status-flip",
    "title": "README: flip delegated-mode status from 'not yet wired' to shipped + identity-model note",
    "files": ["README.md"],
    "dependsOn": ["phase8-precondition-gate"],
    "tdd": [
      "doc-lint: README no longer contains 'not yet wired' or 'first implementation slice' in the delegated-mode section",
      "doc-lint: README contains all five required identity claims (agent-owned space; user space; stable agent DID; agent key is not the user's key; OpenKey proves/signs consent while delegation grants capability)"
    ],
    "prompt": "In README.md, rewrite the Delegated mode Status callout (the '> **Status (first implementation slice):**' block under '### 2. Configure the environment') to describe delegated mode as SHIPPED: the user owns the TinyCloud memory space; the agent activates a user-signed portable delegation via TinyCloudNode.useDelegation and reads/writes the user's space through delegated SQL; point to the consent harness (Phase 6) for obtaining a delegation and the live delegated scenario (Phase 7). Add a concise 'Identity model' note carrying all five required claims: (1) private-key mode = agent-owned space, (2) delegated mode = user's space, (3) the agent has a stable DID did:pkh:eip155:1:{address}, (4) the agent key is NOT the user's key (service identity material), (5) OpenKey proves the user and signs consent while the TinyCloud delegation grants the actual memory capability. Keep any genuinely-unbuilt item (revocation/policy-hash status, sidecar) as an explicitly-scoped 'not in scope' note — do not silently claim it. Keep developer prose; introduce no model/provider product names. Do not touch build/test config.",
    "acceptance": "Delegated-mode section reads as shipped; the five identity claims are present and accurate; no stale first-PR hedge remains; no provider product names added.",
    "risks": [
      "Overstating revocation/sidecar if those remain unbuilt after Phase 7",
      "Accidentally weakening the agent-key-is-not-user-key security statement"
    ],
    "manual": false
  },
  {
    "id": "phase8-readme-env-surface-parity",
    "title": "README: env tables cover every SETTING_KEYS var incl. TINYCLOUD_NODE_HOST alias",
    "files": ["README.md"],
    "dependsOn": ["phase8-readme-delegated-status-flip"],
    "tdd": [
      "doc-lint: every value in SETTING_KEYS appears in README.md",
      "doc-lint: TINYCLOUD_NODE_HOST documented as the legacy alias of TINYCLOUD_HOST"
    ],
    "prompt": "Reconcile README.md env-var tables (private-key mode and delegated mode) against SETTING_KEYS in packages/eliza-plugin-memory/src/config.ts. Ensure every env var the code reads is documented: TINYCLOUD_AUTH_MODE, TINYCLOUD_PRIVATE_KEY, TINYCLOUD_HOST, TINYCLOUD_NODE_HOST (legacy alias of TINYCLOUD_HOST), TINYCLOUD_DB_HANDLE, TINYCLOUD_SPACE_PREFIX, TINYCLOUD_DELEGATION, TINYCLOUD_DELEGATION_FILE, TINYCLOUD_AGENT_KEY, TINYCLOUD_AGENT_KEY_FILE. Add the TINYCLOUD_NODE_HOST legacy alias (a row or footnote) since it is currently undocumented. Do not invent vars the code does not read. Keep the db-handle default consistent with DEFAULT_DB_HANDLE (xyz.tinycloud.eliza/memory).",
    "acceptance": "README documents all 10 SETTING_KEYS values; the legacy host alias is explained; no undocumented or fictional vars.",
    "risks": ["Documenting a var the code does not actually read", "Drift between the two README env tables"],
    "manual": false
  },
  {
    "id": "phase8-readme-live-delegated-scenario",
    "title": "README: document the Phase 7 live delegated scenario",
    "files": ["README.md"],
    "dependsOn": ["phase8-readme-delegated-status-flip"],
    "tdd": [
      "doc-lint: '## Live scenario testing' section mentions delegated/user-to-agent delegation and no longer says it 'does not test user-to-agent delegation' unconditionally"
    ],
    "prompt": "Update the '## Live scenario testing' section of README.md to document the delegated live scenario added in Phase 7 alongside the existing private-key scenario. Describe the flow: human OpenKey sign-in -> user delegates only xyz.tinycloud.eliza/memory SQL to the stable agent DID -> agent writes a long-term memory + session summary through delegated SQL -> a separate user-authorized client reads the same rows from the user's space -> a fresh agent process restores from the same delegation and hydrates. State exactly how it is invoked (gating env, fixture/delegation file) and whether it is automated or documented-manual, matching the real Phase 7 implementation. Do NOT claim WebAuthn automation if Phase 7 shipped it as manual. Remove or qualify the old blanket statement that the live suite does not test delegation.",
    "acceptance": "Live-testing section accurately documents both private-key and delegated scenarios and how to run each; no overclaimed automation.",
    "risks": ["Claiming automation that Phase 7 left manual", "Wrong invocation/env details"],
    "manual": false
  },
  {
    "id": "phase8-plugin-readme-flip",
    "title": "plugin README: flip delegated status + reconcile user-owned overstatement + env parity",
    "files": ["packages/eliza-plugin-memory/README.md"],
    "dependsOn": ["phase8-precondition-gate"],
    "tdd": [
      "doc-lint: plugin README delegated section no longer contains 'not yet wired' / 'Phase 3+' hedge",
      "doc-lint: opening paragraph describes BOTH modes (agent-owned private-key, user-owned delegated) rather than implying all memory is user-owned",
      "doc-lint: every SETTING_KEYS value appears in the plugin README"
    ],
    "prompt": "In packages/eliza-plugin-memory/README.md: (1) Fix the opening sentence that says the plugin makes 'a user-owned TinyCloud space the system of record' — reconcile it to cover BOTH modes: private-key mode = agent-owned space; delegated mode = the user's space. (2) Rewrite the '### Delegated mode (user-owned memory)' Status callout to describe delegated mode as SHIPPED (the user delegates memory SQL to the stable agent DID via OpenKey/TinyCloud; the agent activates it and reads/writes the user's space), removing the 'not yet wired'/'Phase 3+ work' hedge; keep any still-unbuilt item as an explicitly-scoped note. (3) Reconcile both env tables against SETTING_KEYS (include the TINYCLOUD_NODE_HOST legacy alias). (4) Ensure the Multi-tenancy 'Delegated mode' paragraph states the agent key is not the user's key. Keep developer prose; no model/provider product names.",
    "acceptance": "Plugin README accurately describes both modes as shipped, opening overstatement corrected, env surface complete, agent-key-not-user-key present.",
    "risks": ["Leaving the opening 'user-owned' overstatement uncorrected", "Env table drift vs README"],
    "manual": false
  },
  {
    "id": "phase8-hydration-delegated",
    "title": "hydration.md: correct framing + add delegated-mode hydration",
    "files": ["docs/hydration.md"],
    "dependsOn": ["phase8-precondition-gate"],
    "tdd": [
      "doc-lint: hydration.md opening no longer frames the private-key walkthrough as 'user-owned'",
      "doc-lint: hydration.md contains a delegated-mode hydration subsection mentioning restoring from the same serialized delegation + stable agent key into the user's space"
    ],
    "prompt": "In docs/hydration.md: (1) Correct the opening framing — the existing 'same key => same space' walkthrough is private-key (agent-owned) mode; do not call it 'user-owned'. (2) Add a parallel 'Delegated-mode hydration' subsection: a fresh agent process restores from the SAME serialized delegation (TINYCLOUD_DELEGATION / TINYCLOUD_DELEGATION_FILE) plus the SAME stable agent key (TINYCLOUD_AGENT_KEY / TINYCLOUD_AGENT_KEY_FILE), re-activates delegated access, and hydrates the USER's space — mirroring Phase 7 acceptance step 6. Make explicit the durable space is the user's, not the agent's, in delegated mode. (3) Confirm the roomId-stability caveat applies to both modes. Keep the existing private-key narrative intact.",
    "acceptance": "hydration.md covers both private-key and delegated hydration accurately; opening framing fixed; durable-space ownership stated per mode.",
    "risks": ["Implying delegated hydration needs the user's key (it must not)", "Breaking the existing private-key narrative"],
    "manual": false
  },
  {
    "id": "phase8-handoff-facts-update",
    "title": "openkey-auth-handoff.md: update status/readiness only where facts changed",
    "files": ["docs/openkey-auth-handoff.md"],
    "dependsOn": [
      "phase8-readme-delegated-status-flip",
      "phase8-plugin-readme-flip",
      "phase8-hydration-delegated"
    ],
    "tdd": [
      "doc-lint: handoff 'Not yet done (Phase 3+)' list no longer contains items that Phases 3-7 shipped (delegated SQL activation, delegated transport, live delegated scenario)",
      "doc-lint: handoff top Status line reflects implemented delegated auth"
    ],
    "prompt": "Update docs/openkey-auth-handoff.md ONLY where facts changed after Phases 3-7. Move the now-shipped items (delegated SQL activation, delegated transport behind the Transport interface, live delegated Eliza scenario, plugin delegated integration) from '### Not yet done (Phase 3+)' to '### Done'. Update the top 'Status:' line and the '## Current Readiness Statement' to reflect that delegated auth is implemented and which acceptance-matrix items pass. Leave genuinely-unbuilt items (auth sidecar, revocation/policy-hash status) accurately in the not-done list. Do NOT rewrite the source-map reference sections (OpenKey routes, web-sdk APIs, tinyboilerplate prior art) unless they became wrong. Keep it an onboarding doc, not marketing.",
    "acceptance": "Handoff status/readiness/done-vs-not-done reflect shipped reality; source-map sections preserved; unbuilt items remain honestly listed.",
    "risks": ["Over-editing the reference source map", "Claiming sidecar/revocation done when they are not"],
    "manual": false
  },
  {
    "id": "phase8-final-acceptance-check",
    "title": "Cross-doc consistency sweep + acceptance-criteria sign-off",
    "files": [
      "README.md",
      "packages/eliza-plugin-memory/README.md",
      "docs/hydration.md",
      "docs/openkey-auth-handoff.md"
    ],
    "dependsOn": [
      "phase8-readme-env-surface-parity",
      "phase8-readme-live-delegated-scenario",
      "phase8-plugin-readme-flip",
      "phase8-hydration-delegated",
      "phase8-handoff-facts-update"
    ],
    "tdd": [
      "guard: env-surface parity (every SETTING_KEYS value documented)",
      "guard: no stale 'not yet wired'/'not yet implemented' hedge for shipped capabilities",
      "guard: five identity claims present across the doc set",
      "guard: no model/provider product name introduced into prose"
    ],
    "prompt": "Run a final cross-doc consistency sweep over README.md, packages/eliza-plugin-memory/README.md, docs/hydration.md, and docs/openkey-auth-handoff.md. Verify: (a) every SETTING_KEYS env var is documented and the two README env tables agree; (b) no doc still hedges shipped delegated auth as 'not yet wired'/'Phase 3+'; (c) the five required identity claims appear and are mutually consistent across docs (agent-owned vs user space; stable agent DID; agent key != user key; OpenKey proves+signs consent, delegation grants capability); (d) no model/provider product names were introduced into prose; (e) the plan's '## Acceptance Criteria' items that are documentation-observable are reflected truthfully. Produce a short checklist mapping each plan Acceptance Criterion to where it is now documented (or noting it is code/test-only). Fix any residual drift. Return JSON: { consistent: boolean, fixes: string[], acceptanceMapping: object }.",
    "acceptance": "All four guards pass; acceptance-criteria mapping produced; any residual drift fixed in place.",
    "risks": ["Two README tables drifting", "Acceptance criterion silently undocumented"],
    "manual": false
  }
]
```

Ordering rationale: `phase8-precondition-gate` first (refuses to flip docs
against an unwired tree). The three README tasks, the plugin-README task, and
the hydration task fan out from the gate; the handoff update depends on the
content flips so its "done/not-done" list matches the new prose; the final
acceptance sweep depends on everything and is the sign-off. All tasks are small,
single-file (except the read-only gate and the read-mostly final sweep), and
none touches build/typecheck/test config.

---

## Deterministic regression guards

These extend (and partly invert) the existing
`/Users/roman/Documents/GitHub/development/.smithers/scripts/tinycloud-agents-openkey-auth-regression.mjs`.
A Phase 8 regression variant must **drop** the first-PR guard
`first-pr-does-not-activate-delegated-sql` (which asserts `useDelegation(` is
absent) and replace it with `code-supports-shipped-claims` below. All guards are
deterministic `grep`/`rg` + file checks; none depends on network or live auth.

1. **`code-supports-shipped-claims`** (inverts the first-PR guard):
   `rg -n 'useDelegation\s*\(' packages/agent-client/src` MUST match. Gate: docs
   may only claim delegated SQL ships if the code wires `useDelegation`. Exit
   non-zero if absent.

2. **`readme-documents-all-setting-keys`**: parse the `SETTING_KEYS` object
   values out of `packages/eliza-plugin-memory/src/config.ts`, then assert each
   value string appears in `README.md` AND in
   `packages/eliza-plugin-memory/README.md` (legacy alias `TINYCLOUD_NODE_HOST`
   may appear in either with an alias note). Reading the keys dynamically means a
   future env var addition fails this guard until documented.

3. **`no-stale-not-implemented-claims`**: assert `README.md` and
   `packages/eliza-plugin-memory/README.md` contain NONE of the first-PR hedges
   for shipped capabilities — `rg -i 'not yet wired|not yet implemented|first
   implementation slice'` over those two files must return no matches. (Run only
   after guard #1 passes, so it never demands shipped language on an unwired
   tree.)

4. **`identity-claims-present`**: assert the five required claims are present in
   the doc set. Concretely, require matches across README/plugin-README for:
   agent-owned space (private-key), user('s) space (delegated), "stable" agent
   DID, "agent key" + "not"/"never" + "user" (agent-key-is-not-user-key), and
   OpenKey + (proves/consent) + delegation + (capability/grant). Exit non-zero if
   any claim is missing.

---

## Final acceptance (against `docs/openkey-auth-plan.md` → `## Acceptance Criteria`)

Phase 8 closes the effort. The plan's acceptance criteria are mostly
code/test-observable (Phases 0-7) and Phase 8's job is to ensure the docs reflect
them truthfully:

| Acceptance criterion (plan) | Phase 8 documentation obligation |
|---|---|
| Private-key build/typecheck/tests + live Eliza scenario still pass | README "Live scenario testing" keeps the private-key path documented and accurate. |
| Delegated mode does not require the user's private key | The "agent key is NOT the user's key" claim + delegated-mode env surface (no user key var) are documented. |
| Agent DID stable across restarts | README/handoff/hydration state the stable agent DID and stable-key→same-DID behavior. |
| User can delegate only `xyz.tinycloud.eliza/memory` SQL | Live-scenario + delegated-mode docs name the narrow memory SQL policy. |
| Agent writes memories/summaries through delegated access | Delegated-mode status (now shipped) + live scenario document this. |
| User-authorized workflow reads the same rows | Live delegated scenario documents the separate-client read. |
| Fresh process restores grant + hydrates | hydration.md delegated-mode subsection documents this. |
| Wrong delegatee / expired / insufficient / malformed rejected clearly | Documented as the delegated-mode failure semantics (sourced from Phase 4). |
| No auth failure falls back to local/plugin SQL | Existing fail-open (NOT fail-over) docs already cover this; verify it stays. |

**finalAcceptanceCheck:** After Phase 8, run the Phase 8 regression variant
(guards 1-4 above) plus `bun --bun run build && bun --bun run typecheck &&
bun --bun run test` to confirm docs edits broke nothing, then confirm by
inspection that every plan `## Acceptance Criteria` line is either (a) reflected
truthfully in the docs per the table above, or (b) explicitly a code/test-only
item proven in Phases 0-7. The effort is done when all four doc guards pass, the
build/typecheck/test baseline is green, and no doc still hedges a shipped
capability as "not yet wired".
