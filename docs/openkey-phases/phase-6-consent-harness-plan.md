# Phase 6: Consent and Delivery Harness — Implementation Plan

Status: PLANNING ONLY. No source changes proposed here are implemented.
Authority: `docs/openkey-auth-plan.md` §"Phase 6: Consent and Delivery Harness"
(around line 268) and §"Acceptance Criteria" / §"Open Questions" (#2).
Builds on the stable agent DID helper (`packages/agent-client/src/agent-identity.ts`,
Phase 2) and the not-yet-built Phase-4 delegation policy permission set.

## Goal

Give a human a small, boring, automatable local harness that prints everything
needed to grant the agent narrow memory access, then waits for a live human
OpenKey/passkey sign-in + browser delegation, and finally lets Eliza boot in
delegated mode (Phase 5). The harness output must be:

- The **stable agent DID** (the delegation target, derived from the same key
  material the runtime will activate with — no drift between advertised and used
  DID).
- The TinyCloud **host** and **db handle** the agent expects.
- The **required permission JSON** — byte-for-byte the same object the Phase-4
  validator will check, so consent and validation cannot diverge.
- The **expected delegation-file path** the runtime reads on boot.
- Human-readable **OpenKey delegation URL / instructions** to perform the live
  step.

Everything except the live WebAuthn click is automatable and unit-tested.

## Open Question #2 resolution — consent-delivery mechanism

**Recommendation: plain delegation-file handoff first.** Per the plan's own
guidance ("First harness can be manual and boring", "Do this before a sidecar.
It gives correctness without committing to UX"):

- The harness prints the agent DID + permission JSON + an OpenKey delegate URL.
- The human signs in via OpenKey/passkey in the browser, reviews the requested
  permissions, and the browser/TinyCloudWeb creates the delegation to the agent
  DID.
- The browser's delegate page already supports a **paste-code** return path
  (`apps/web/src/routes/delegate/+page.svelte` reads `callback`/paste-code). The
  human pastes the serialized delegation into a file at the harness-printed path
  (default `./.tinycloud/agent-delegation.json`), or exports it as
  `TINYCLOUD_DELEGATION`.
- Eliza then boots with `TINYCLOUD_AUTH_MODE=delegation` +
  `TINYCLOUD_DELEGATION_FILE` (Phase 5).

Why file handoff over callback URL or live paste-code automation:

- **No inbound listener.** A callback URL needs the harness to run an HTTP
  server reachable by the browser, which adds origin/HTTPS/port surface and is
  exactly the "sidecar" the plan defers. A file is local, boring, and inspectable.
- **Deterministic and testable.** File presence/shape is trivially unit-testable;
  an HTTP callback is not.
- **Matches the env surface already shipped.** `TINYCLOUD_DELEGATION_FILE` and
  `TINYCLOUD_DELEGATION` already exist in `eliza-plugin-memory/src/config.ts`.

The OpenKey **delegate URL** (paste-code mode) is printed as the suggested human
path; the **callback-URL** variant is explicitly deferred to Phase 7+ / a future
sidecar and is noted as a non-goal here.

## CRITICAL design decision — single source of truth for the permission policy

Phase 4 (delegation policy validation) is **not yet implemented in code**. The
plan lists it before Phase 6, but the tree is currently at Phase 2. To satisfy
the plan's hard requirement that "generated permission payload matches the policy
validator", Phase 6 must NOT invent a second copy of the permission set.

Therefore the first automatable task introduces one shared module —
`packages/agent-client/src/memory-policy.ts` — that exports:

- `MEMORY_POLICY_PERMISSIONS`: the canonical, frozen permission array for the
  Eliza memory db handle (the exact resources/actions the plan §"Phase 4" table
  lists).
- `buildMemoryPolicy(dbHandle)`: returns the permission payload for a given
  db handle (so a non-default `TINYCLOUD_DB_HANDLE` still produces a matching
  payload).
- `memoryPolicyHash(agentDid, dbHandle)`: a stable hash over the requested
  permissions + agent DID (plan §"Phase 4" policy-hash support; the harness
  reports it and Phase 4 later reuses it for `stale` detection).

Both the Phase-6 harness AND the future Phase-4 validator import this single
module. The harness's emitted `permissions` payload is literally
`buildMemoryPolicy(dbHandle)`. A regression guard then asserts the harness output
deep-equals `buildMemoryPolicy(dbHandle)` — consent and validation share one
object by construction, so they cannot drift.

This is the load-bearing decision: define the policy once, consume it in two
places.

### Canonical permission set (from plan §"Phase 4")

```
[
  { service: "tinycloud.sql",
    path: "<dbHandle>",              // default: xyz.tinycloud.eliza/memory
    actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"] },
  { service: "tinycloud.capabilities",
    path: "",
    actions: ["tinycloud.capabilities/read"] }
]
```

The exact resource/permission serialization (CAIP/ReCap resource URI vs the
object form above) must match whatever the SDK delegation deserializer expects;
the implementer confirms the shape against `@tinycloud/node-sdk`
`ResourceCapability` / `expandPermissionEntries` and uses that ONE shape in the
shared module. The harness never hand-rolls the shape.

## Automatable vs Manual split

| Step | Surface | manual | Notes |
| --- | --- | --- | --- |
| Shared memory-policy module + hash | `agent-client` source | false | Single source of truth for Phase 4 + Phase 6. |
| Harness script (prints DID, host, db handle, permission JSON, file path, OpenKey URL) | `eliza-plugin-memory/scripts` | false | Pure compute over config + `agentIdentityFromKey`. |
| Harness stable-DID guard (refuses unstable/missing key) | harness + unit test | false | Reuses Phase-2 helper; fails loud on missing key. |
| Harness permission payload == Phase-4 policy cross-check | unit + regression | false | deep-equal against `buildMemoryPolicy`. |
| Runbook doc | `docs/` | false | Written, not executed. |
| Regression guards (`...-phase6-regression.mjs`) | development repo `.smithers/scripts` | false | Deterministic, no network. |
| **Human OpenKey/passkey sign-in** | live browser | **true** | WebAuthn — a worker agent cannot click it. Documented gate. |
| **Browser/TinyCloudWeb creates delegation to agent DID** | live browser | **true** | Produces the serialized delegation. Documented gate. |
| **Human writes serialized delegation to file / env** | human | **true** | The boring handoff. Documented gate. |

Make the automatable surface as large as possible: the harness, its tests, the
shared policy module, the cross-check, and the runbook are all `manual: false`.
Only the three live human actions are `manual: true` gates the workflow stops at.

## Harness script — I/O contract

Location: `packages/eliza-plugin-memory/scripts/consent-harness.ts`
(mirrors the existing `scripts/live-eliza-scenarios.ts` convention; opt-in, not
part of `bun test`). Add `"consent:harness": "bun --bun scripts/consent-harness.ts"`
to `packages/eliza-plugin-memory/package.json` scripts.

### Inputs (env, same keys already documented)

- `TINYCLOUD_AGENT_KEY` **or** `TINYCLOUD_AGENT_KEY_FILE` (exactly one — the
  stable agent identity; reuses `resolveDelegationModeConfig` XOR rules).
- `TINYCLOUD_HOST` (optional; default `https://node.tinycloud.xyz`).
- `TINYCLOUD_DB_HANDLE` (optional; default `xyz.tinycloud.eliza/memory`).
- `TINYCLOUD_DELEGATION_FILE` (optional; default `./.tinycloud/agent-delegation.json`)
  — printed as the expected delegation-file path.
- `OPENKEY_DELEGATE_URL` (optional; default `https://openkey.tinycloud.xyz/delegate`
  or local `https://openkey.localhost/delegate`) — base for the suggested URL.
- `--json` flag: emit machine-readable JSON only (for the regression guard and
  for piping). Default (no flag): human-readable block + the JSON.

### Output — exact printed fields

Human-readable block, then a single JSON object (with `--json`, only the JSON):

```json
{
  "agentDid": "did:pkh:eip155:1:0x....",
  "host": "https://node.tinycloud.xyz",
  "dbHandle": "xyz.tinycloud.eliza/memory",
  "permissions": [ /* === buildMemoryPolicy(dbHandle) === */ ],
  "policyHash": "sha256:....",
  "delegationFilePath": "/abs/path/.tinycloud/agent-delegation.json",
  "openKeyDelegateUrl": "https://openkey.tinycloud.xyz/delegate?did=did:pkh:...&host=...&permissions=...&expiry=...",
  "instructions": [
    "1. Open the OpenKey delegate URL above and sign in with your passkey.",
    "2. Review the requested permissions; they must match the permissions field.",
    "3. Approve to create a delegation to the agentDid.",
    "4. Copy the serialized delegation and write it to delegationFilePath",
    "   (or export it as TINYCLOUD_DELEGATION).",
    "5. Boot Eliza with TINYCLOUD_AUTH_MODE=delegation and TINYCLOUD_DELEGATION_FILE set."
  ]
}
```

Hard contract on the script:

- It **computes** `agentDid` via `agentIdentityFromKey` / `agentIdentityFromFile`
  (Phase-2 helper) — the same path the runtime uses, so the advertised DID equals
  the activated DID.
- It **refuses to run** (non-zero exit, clear error, no JSON) if it would emit an
  unstable/missing-key delegation target: missing both key sources, both provided,
  empty key, unreadable key file. It NEVER generates a fresh key.
- It **never prints secret material**: not the agent key, not the key-file
  contents — only the derived DID. Error messages name fields, never values.
- `permissions` is exactly `buildMemoryPolicy(dbHandle)` from the shared module.
- It does **not** call `TinyCloudNode.useDelegation` or touch the network. (Keeps
  the existing regression guard `! rg 'useDelegation\(' packages/...` green; the
  harness lives under `scripts/`, but must stay free of activation regardless.)

## How the emitted permission payload cross-checks the Phase-4 validator

1. `packages/agent-client/src/memory-policy.ts` exports `buildMemoryPolicy`,
   `MEMORY_POLICY_PERMISSIONS`, and `memoryPolicyHash` — the single source.
2. The harness imports `buildMemoryPolicy` and emits its output verbatim as the
   `permissions` field.
3. A unit test (`memory-policy.test.ts`) pins the canonical shape with a snapshot/
   deep-equal so any change to the policy is a deliberate, reviewed change.
4. A harness unit test asserts `harnessOutput.permissions` deep-equals
   `buildMemoryPolicy(dbHandle)` for the default and for a custom db handle.
5. The Phase-4 validator (future) imports the **same** `buildMemoryPolicy` /
   `MEMORY_POLICY_PERMISSIONS` to decide "does this delegation cover the required
   policy?". Because both sides reference one frozen export, a regression guard
   deep-equal is sufficient to prove they cannot drift.

Hand-off note to Phase 4: when Phase 4 is implemented, its validator MUST import
`memory-policy.ts` rather than re-declaring the permission set. This plan creates
that module early specifically so Phase 4 has nowhere to drift to.

## Ordered atomic tasks

Each task keeps the tree green (build + typecheck + test) and leaves all prior
tests green. TDD throughout: failing test(s) first, then implementation.

1. `phase6-shared-memory-policy` — shared permission-policy module + tests.
2. `phase6-policy-hash` — stable policy hash over permissions + agent DID + tests.
3. `phase6-consent-harness-script` — the harness script implementing the I/O
   contract (depends on 1, 2, and the Phase-2 agent-identity helper).
4. `phase6-harness-unit-tests` — stable-DID, refusal, no-secret-leak, and
   permission-cross-check tests for the harness.
5. `phase6-runbook-doc` — the manual runbook documenting the full human flow.
6. `phase6-regression-guards` — deterministic guards in the development repo.
7. `phase6-manual-openkey-signin` — **manual gate**: live passkey sign-in.
8. `phase6-manual-browser-delegation` — **manual gate**: browser creates the
   delegation + human writes it to the file/env.

(Full task objects with prompts are in the JSON appendix at the end of this file.)

## Manual runbook (the live human steps)

Documented in `docs/openkey-phases/phase-6-consent-runbook.md` (written by task 5):

1. Generate/choose a stable agent key (a dedicated low-value key — NOT the user's
   wallet). Store it as `TINYCLOUD_AGENT_KEY` or in a file referenced by
   `TINYCLOUD_AGENT_KEY_FILE`.
2. Run `bun --bun run consent:harness` in `packages/eliza-plugin-memory`. Note the
   printed `agentDid`, `permissions`, `policyHash`, `delegationFilePath`, and the
   OpenKey delegate URL.
3. **[LIVE]** Open the OpenKey delegate URL in a browser. Sign in with your
   passkey. (Local dev: use `https://openkey.localhost/delegate` via
   `bun dev:portless`; a cert warning breaks passkeys, so trusted HTTPS or
   `http://localhost` is required.)
4. **[LIVE]** Review the requested permissions — confirm they match the harness's
   `permissions`. Approve. The browser/TinyCloudWeb creates a delegation to the
   `agentDid`.
5. **[LIVE]** Copy the serialized delegation (paste-code) and write it to
   `delegationFilePath`, or export it as `TINYCLOUD_DELEGATION`.
6. Boot Eliza with `TINYCLOUD_AUTH_MODE=delegation` plus the same
   `TINYCLOUD_AGENT_KEY[_FILE]` and `TINYCLOUD_DELEGATION_FILE`. (Activation is
   Phase 3/5 — until those land, the runtime still rejects delegation mode with
   the intentional "not yet implemented" guard; the harness output is valid
   regardless.)
7. Verify: the agent DID Eliza activates with equals the harness's `agentDid`.

Pitfalls to call out in the runbook: don't paste the user's main private key;
don't regenerate the agent key after delegating (DID changes → delegation no
longer matches); OpenKey WebAuthn needs trusted origin.

## Deterministic regression guards

New script: `development/.smithers/scripts/tinycloud-agents-openkey-phase6-regression.mjs`
(same emit-one-JSON shape as the existing
`tinycloud-agents-openkey-auth-regression.mjs`). Guards:

1. **`harness-prints-required-fields`** — run
   `consent:harness --json` with a fixed test agent key + fixed env, parse stdout
   JSON, assert presence and non-empty of: `agentDid`, `host`, `dbHandle`,
   `permissions`, `policyHash`, `delegationFilePath`, `openKeyDelegateUrl`,
   `instructions`.
2. **`harness-did-is-stable`** — run the harness twice with the same fixed key;
   assert identical `agentDid` and `policyHash` across runs.
3. **`harness-permissions-equal-policy`** — assert the harness `permissions`
   deep-equals `buildMemoryPolicy(dbHandle)` from `memory-policy.ts` (import the
   module in the guard, or assert against a pinned fixture that
   `memory-policy.test.ts` also pins). This is the consent↔validation no-drift
   guard.
4. **`harness-refuses-missing-key`** — run the harness with no agent key sources;
   assert non-zero exit and that stdout/stderr contain NO `0x`-hex secret and no
   partial JSON delegation target.
5. **`no-delegated-sql-activation`** — keep the existing guard
   `! rg 'useDelegation\(' packages/agent-client/src packages/eliza-plugin-memory/src`
   (the harness must not activate). Plus `bun --bun run build`, `typecheck`,
   `test`, `git diff --check`, branch guard (`feature/mvp`).

(Guards 1–4 are the Phase-6-specific deterministic checks; guard 5 carries the
prior baseline forward unchanged.)

## Hand-off to Phase 7

Phase 7 (live delegated scenario) is **out of scope here and not designed in this
plan**. Phase 6 produces exactly the inputs Phase 7 consumes:

- a stable `agentDid` advertised == activated,
- a `delegationFilePath` the runtime reads,
- a `permissions` payload that equals the Phase-4 policy the validator checks.

Phase 7 takes the human-produced delegation file from this harness, boots Eliza
in delegated mode, writes a memory + session summary through delegated SQL, reads
the same rows with a separate user-authorized client, restores from the same file
in a fresh process, and exercises the wrong-delegatee / expired / insufficient-
policy failure fixtures. Phase 7 also decides whether to automate the WebAuthn
step; Phase 6 deliberately leaves it manual so correctness does not block on
fragile passkey automation.

---

## Appendix: atomic task objects

```json
[
  {
    "id": "phase6-shared-memory-policy",
    "title": "Shared memory-policy module (single source of truth for Phase 4 + Phase 6)",
    "files": [
      "packages/agent-client/src/memory-policy.ts",
      "packages/agent-client/src/memory-policy.test.ts",
      "packages/agent-client/src/index.ts"
    ],
    "dependsOn": [],
    "tdd": [
      "memory-policy.test.ts pins MEMORY_POLICY_PERMISSIONS shape (deep-equal/snapshot) before impl",
      "buildMemoryPolicy(default) deep-equals the canonical set",
      "buildMemoryPolicy(custom dbHandle) substitutes path and nothing else",
      "permissions array is frozen / not mutable by callers"
    ],
    "acceptance": "memory-policy.ts exports MEMORY_POLICY_PERMISSIONS and buildMemoryPolicy(dbHandle) using the plan Phase-4 resource/action set (tinycloud.sql read/write/admin on dbHandle + tinycloud.capabilities/read). Shape matches @tinycloud/node-sdk ResourceCapability/permission-entry expectations. Exported from index.ts. build+typecheck+test green; all prior tests green.",
    "risks": [
      "Permission serialization shape must match the SDK deserializer; confirm against node-sdk ResourceCapability/expandPermissionEntries before pinning",
      "Open Question #1 (dedicated app space vs default space) — keep path = dbHandle and leave a TODO; do not over-design"
    ],
    "manual": false
  },
  {
    "id": "phase6-policy-hash",
    "title": "Stable policy hash over permissions + agent DID",
    "files": [
      "packages/agent-client/src/memory-policy.ts",
      "packages/agent-client/src/memory-policy.test.ts",
      "packages/agent-client/src/index.ts"
    ],
    "dependsOn": ["phase6-shared-memory-policy"],
    "tdd": [
      "memoryPolicyHash(did, dbHandle) is deterministic across calls",
      "different agentDid -> different hash",
      "different dbHandle -> different hash",
      "hash is computed over a canonical (stable-ordered) serialization"
    ],
    "acceptance": "memoryPolicyHash(agentDid, dbHandle) returns a stable sha256-style string derived from canonical permissions + agent DID. Exported from index.ts. Reused later by Phase 4 stale-policy detection. build+typecheck+test green.",
    "risks": [
      "Non-canonical JSON ordering would make the hash unstable — must sort keys/actions deterministically",
      "Avoid hashing secret material; hash only DID + permissions"
    ],
    "manual": false
  },
  {
    "id": "phase6-consent-harness-script",
    "title": "Consent harness script implementing the I/O contract",
    "files": [
      "packages/eliza-plugin-memory/scripts/consent-harness.ts",
      "packages/eliza-plugin-memory/package.json"
    ],
    "dependsOn": ["phase6-shared-memory-policy", "phase6-policy-hash"],
    "tdd": [
      "harness logic is factored into a pure buildConsentReport(env) function so it is unit-testable without spawning",
      "buildConsentReport returns the exact field set from the I/O contract",
      "the CLI wrapper prints human block + JSON, and JSON-only with --json"
    ],
    "acceptance": "Script derives agentDid via the Phase-2 agentIdentityFromKey/File helper (advertised DID == runtime DID), reads TINYCLOUD_AGENT_KEY[_FILE] (XOR), TINYCLOUD_HOST, TINYCLOUD_DB_HANDLE, TINYCLOUD_DELEGATION_FILE, OPENKEY_DELEGATE_URL. Emits agentDid, host, dbHandle, permissions=buildMemoryPolicy(dbHandle), policyHash, delegationFilePath (absolute), openKeyDelegateUrl, instructions. Adds consent:harness script entry. Never calls useDelegation or the network. build+typecheck+test green.",
    "risks": [
      "Must not print agent key or key-file contents — only derived DID",
      "OpenKey delegate URL query-param encoding (did/host/permissions/expiry) must match apps/web delegate page param names",
      "Keep harness free of useDelegation( so the existing regression rg-guard stays green"
    ],
    "manual": false
  },
  {
    "id": "phase6-harness-unit-tests",
    "title": "Harness unit tests: stable DID, refusal, no-secret-leak, policy cross-check",
    "files": [
      "packages/eliza-plugin-memory/scripts/consent-harness.test.ts"
    ],
    "dependsOn": ["phase6-consent-harness-script"],
    "tdd": [
      "stable agent key -> stable agentDid + policyHash across two buildConsentReport calls",
      "missing both key sources -> throws / non-zero, output contains no 0x-hex and no partial delegation target",
      "both key sources provided -> clear conflict error",
      "report.permissions deep-equals buildMemoryPolicy(dbHandle) for default and custom dbHandle",
      "no secret (agent key / key-file content) appears anywhere in the emitted report or error messages"
    ],
    "acceptance": "Unit tests cover stable-DID, refusal-on-unstable/missing-key, conflict, no-secret-leak, and the permission cross-check against buildMemoryPolicy. Uses deterministic hardhat test keys (as agent-identity.test.ts does). All tests green; all prior tests green.",
    "risks": [
      "Tests must use throwaway test keys, never real keys",
      "Refusal test must assert on absence of secrets, not just on throwing"
    ],
    "manual": false
  },
  {
    "id": "phase6-runbook-doc",
    "title": "Manual consent runbook documentation",
    "files": [
      "docs/openkey-phases/phase-6-consent-runbook.md",
      "packages/eliza-plugin-memory/README.md"
    ],
    "dependsOn": ["phase6-consent-harness-script"],
    "tdd": [],
    "acceptance": "Runbook documents the full flow: generate dedicated agent key, run consent:harness, the three LIVE steps (passkey sign-in, browser delegation, write delegation to file/env), then boot Eliza in delegation mode. States agent key != user key, DID stability requirement, OpenKey trusted-origin requirement, and that activation is Phase 3/5. README links the runbook. No code change; docs honest about manual scope.",
    "risks": [
      "Do not overpromise live delegated readiness; activation is later phases",
      "Keep terminology 'space' (not orbit/namespace)"
    ],
    "manual": false
  },
  {
    "id": "phase6-regression-guards",
    "title": "Deterministic Phase-6 regression guards",
    "files": [
      "/Users/roman/Documents/GitHub/development/.smithers/scripts/tinycloud-agents-openkey-phase6-regression.mjs"
    ],
    "dependsOn": ["phase6-harness-unit-tests", "phase6-runbook-doc"],
    "tdd": [],
    "acceptance": "Guard script emits one JSON object (same shape as the existing auth regression). Checks: harness-prints-required-fields, harness-did-is-stable, harness-permissions-equal-policy, harness-refuses-missing-key, no-delegated-sql-activation (rg useDelegation guard kept), plus build/typecheck/test/diff-check/branch guards. Deterministic, no network, no live passkey.",
    "risks": [
      "Guard must supply a fixed throwaway agent key via env so the harness is deterministic",
      "Must not require network; assert harness stays offline"
    ],
    "manual": false
  },
  {
    "id": "phase6-manual-openkey-signin",
    "title": "[MANUAL GATE] Live human OpenKey/passkey sign-in",
    "files": [],
    "dependsOn": ["phase6-consent-harness-script", "phase6-runbook-doc"],
    "tdd": [],
    "acceptance": "Human opens the harness-printed OpenKey delegate URL and authenticates with a passkey. This is a documented gate, not a worker task; the workflow stops and waits here. Verified by the human reaching the delegate consent screen for the correct agentDid.",
    "risks": [
      "WebAuthn cannot be performed by a Smithers worker agent",
      "Local origin / HTTPS cert warnings break passkeys"
    ],
    "manual": true
  },
  {
    "id": "phase6-manual-browser-delegation",
    "title": "[MANUAL GATE] Browser creates delegation to agent DID + human writes it to file/env",
    "files": [],
    "dependsOn": ["phase6-manual-openkey-signin"],
    "tdd": [],
    "acceptance": "Human reviews requested permissions (matching the harness permissions), approves, the browser/TinyCloudWeb creates a delegation to the agentDid, and the human writes the serialized delegation to the harness-printed delegationFilePath (or TINYCLOUD_DELEGATION). Documented gate; workflow waits. Verified by a delegation file present at the expected path whose delegatee equals agentDid.",
    "risks": [
      "Human could regenerate the agent key after delegating -> DID mismatch",
      "Serialized delegation must be the full portable payload, not a truncated paste"
    ],
    "manual": true
  }
]
```
