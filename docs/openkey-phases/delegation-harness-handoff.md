# Handoff: Live Agent-Delegation Harness — recraft the plan

Date: 2026-06-13
Purpose: A fresh agent should recraft the implementation plan for the **live
end-to-end proof** of the agent's delegated-SQL memory, using the verified facts
below. Extensive investigation already happened — **do not repeat it.** Trust the
findings here unless a live run contradicts them.

---

## TL;DR

- **Goal:** A human signs in with an OpenKey **passkey**, mints a **`tinycloud.sql`
  delegation to the agent's stable `did:pkh`**, saves it to a file, and the agent
  uses it for delegated SQL memory (Phase 7 live scenario).
- **No code changes to OpenKey.** No code changes to tinycloud (node-sdk **or** the
  agent in `tinycloud-agents`). Everything uses **published** packages.
- **Build exactly one thing:** a small standalone browser harness (Vite) that does
  passkey login → `createDelegation(sql)` to the `did:pkh` → serialize → download.
- **Do NOT** use OpenKey's `/delegate` page, the `fix/web-sdk-sql-delegation`
  branch, commit `f4fc76c`, a web-sdk rebase, a local web-sdk build, or any
  workspace-linking. All of those were dead ends (see "Dead ends").

---

## Current state (already done — do not redo)

- `tinycloud-agents` Phases 3–8 are **implemented and green** (build/typecheck/test
  pass). The agent's delegated transport + validator already exist:
  - `packages/agent-client/src/delegated-transport.ts` — `useDelegation` + `sql.db(dbHandle)`.
  - `packages/agent-client/src/delegation-validate.ts` — the **shallow** validator
    the transport actually calls (`delegated-transport.ts:212`).
  - `packages/agent-client/src/delegation-policy.ts` — the **deep** policy validator
    (`validateDelegationPolicy`), which is a `TODO(Phase 5)` and **NOT yet wired**
    into the transport.
- A consent harness exists at `packages/eliza-plugin-memory/scripts/consent-harness.ts`.
  It derives the agent DID + a permission payload. **Its OpenKey-delegate-URL output
  is the WRONG mechanism (see Dead ends) and is unused by the recommended path.**
  (A small edit was made to it to point at `openkey.so` + base64url-encode the
  permissions — harmless but now moot; revert or ignore.)
- Smithers workflow `openkey-delegate-harness.{tsx,mjs}` in `development/.smithers/`
  was authored targeting the fix branch — **it must be rewritten** to the standalone
  form below (it's based on a now-disproven assumption).

---

## Hard-won findings (the load-bearing facts)

### 1. How to mint the delegation — `web-sdk createDelegation`, published 2.3.0
- **Published `@tinycloud/web-sdk@2.3.0` already supports SQL delegation.** Its
  `createDelegation({ delegateDID, path, actions, expiry })` routes through
  `legacyParamsToPermissionEntries` (`node-sdk` `delegateToHelpers.ts:29`), which
  splits actions by service namespace (`tinycloud.kv`, `tinycloud.sql`, …) and emits
  one multi-resource UCAN. SQL actions are handled correctly.
- **`origin/master` == tag `v2.3.0` == published** (0 commits after the tag).
- The high-level API is `space.delegations.create({ delegateDID, path, actions, expiry })`
  or `tcw.createDelegation(...)`. Output is a `PortableDelegation`; serialize with
  `serializeDelegation()` → JSON string (round-trips through node-sdk
  `deserializeDelegation`).
- Template to copy: `repositories/web-sdk/apps/web-sdk-example/src/pages/DelegationModule.tsx`.

### 2. OpenKey passkey → signer — `@openkey/sdk` widget → EIP-1193 → TinyCloudWeb
- `@openkey/sdk` (published **0.8.7**, use `^0.8.4`) default export `OpenKey`.
- `openkey.connect()` (passkey, **widget/iframe + postMessage** flow) → an
  **EIP-1193 provider** (`OpenKeyProvider`) backed by the user's TEE-managed key.
- `new TinyCloudWeb({ provider })` → `await tcw.signIn()` (auto-creates the user's space).
- **Canonical template:** `repositories/tinyboilerplate/packages/client/src/openkey.ts`
  (`connectWallet()` returns `{ address, web3Provider }`). Also working examples:
  `repositories/web-sdk/apps/openkey-vite` and `apps/openkey-example`.
- **CORS:** direct cross-origin calls from a localhost page to `api.openkey.so` are
  **blocked** (`vary: Origin`, no `allow-origin` for localhost). The SDK **widget
  flow sidesteps this** (postMessage to openkey.so). Do not raw-`fetch` the API.

### 3. The delegation contract the agent enforces (target this exactly)
- `delegateDID` must **exactly string-equal** the agent's `did:pkh` — the shallow
  validator uses strict `!==` (`delegation-validate.ts:50`). Pass it **verbatim**
  (checksum case preserved). Do NOT lowercase/normalize.
- `actions` must include at least one `tinycloud.sql/` action (shallow validator);
  for full memory use grant `tinycloud.sql/read`, `tinycloud.sql/write`,
  `tinycloud.sql/admin` (+ optional `tinycloud.capabilities/read`).
- `path` = the db handle `xyz.tinycloud.eliza/memory`.
- `expiry` must be in the future.
- The agent reads the file via `deserializeDelegation` → `useDelegation` →
  `delegatedAccess.sql.db("xyz.tinycloud.eliza/memory")`. SQL is scoped by the
  bearer token + db name (not the delegation `path`), so the granted SQL actions are
  what matter.
- Agent DID derivation: `agentIdentityFromKey(TINYCLOUD_AGENT_KEY)` → chainId **1**.
  Current throwaway test key lives at `tinycloud-agents/.tinycloud/agent.key`;
  its DID is `did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c`.

### 4. Exact `createDelegation` params (recommended)
```js
space.delegations.create({
  delegateDID: "<agent did:pkh, verbatim>",            // default test: did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c
  path: "xyz.tinycloud.eliza/memory",
  actions: ["tinycloud.sql/read","tinycloud.sql/write","tinycloud.sql/admin","tinycloud.capabilities/read"],
  expiry: new Date(Date.now() + 30*24*60*60*1000),
})
// then serializeDelegation(result) -> save to the agent's delegation file
```

---

## What to build (the recraft target)

A **standalone Vite + TS harness** (no SDK-repo entanglement):
- Location suggestion: `tinycloud-agents/tools/delegate-ui/` (or a fresh dir/repo).
- Deps: **published** `@tinycloud/web-sdk@2.3.0` + `@openkey/sdk@^0.8.4`. Nothing local.
- UI: inputs for `delegateDID` (default the agent DID above), `dbHandle`
  (default `xyz.tinycloud.eliza/memory`), `host` (default `https://node.tinycloud.xyz`);
  a "Sign in with passkey & create delegation" button; output = downloadable
  `agent-delegation.json` + a copyable textarea; show the minted delegation's
  `delegateDID` + `actions` so the user can confirm SQL grants are present.
- Flow: `OpenKey.connect()` (widget) → EIP-1193 provider → `new TinyCloudWeb({provider})`
  → `signIn()` → `space.delegations.create({...})` → `serializeDelegation()` → download.
- Runbook: run dev server (localhost or trusted HTTPS — self-signed breaks WebAuthn),
  click passkey, approve, download, save to
  `tinycloud-agents/packages/eliza-plugin-memory/.tinycloud/agent-delegation.json`
  (chmod 600), then run the agent's Phase 7 live delegated scenario.

The **live passkey click is manual** (WebAuthn can't be automated) — keep it as a
runbook step outside any automated DAG, same pattern as the phase-6/7 manual gates.

---

## Confirmation: scope of changes

- **OpenKey:** no code changes. Used as a published dependency via its SDK widget.
  (Operational caveat only: the harness's web origin may need to be in OpenKey's
  allowed origins for the passkey widget — config, not code, and only if the widget
  rejects the origin at runtime.)
- **tinycloud (node-sdk + agent):** no code changes. `node-sdk@2.3.0` already does
  `useDelegation`/SQL; the agent's transport + validator already consume it.
  (Operational caveat only: the first live delegated run is the first exercise of the
  agent's new transport against the live node — a real bug there could need a small
  agent fix, but none is planned/expected.)

---

## Dead ends (do NOT pursue — already disproven)

1. **OpenKey `/delegate` page** (`openkey.so/delegate`): it is the **CLI auth flow** —
   it requires a `jwk` and delegates to an **ephemeral session key (`did:key`)**, NOT
   to a stable `did:pkh`. Cannot mint the agent's delegation. (`apps/web/src/routes/delegate/+page.svelte:171`,
   `apps/api/src/routes/delegate.ts:517` — `jwk` required.)
2. **`fix/web-sdk-sql-delegation` branch / commit `f4fc76c` / rebasing it:** `f4fc76c`
   patched the *old* kv-lumping code; master/2.3.0 **superseded** it with the
   multi-resource permission-entry refactor (`legacyParamsToPermissionEntries`). The
   fix is **obsolete**. Rebasing it onto master **conflicts** in `tcw.ts` (the patched
   lines no longer exist on master) and is pointless. Do not rebase, do not build from
   this branch.
3. **"Published 2.3.0 is KV-only":** an earlier wrong conclusion (it read the
   public-space/session path `core.js:3307`, not `createDelegation`). Published 2.3.0
   **does** support SQL delegation. Ignore that claim.
4. **Local web-sdk build / workspace-linking the harness to `repositories/web-sdk`:**
   unnecessary — use published `web-sdk@2.3.0`.

---

## Pointers

- web-sdk delegation template: `repositories/web-sdk/apps/web-sdk-example/src/pages/DelegationModule.tsx`
- OpenKey+web-sdk bridge templates: `repositories/tinyboilerplate/packages/client/src/openkey.ts`,
  `repositories/web-sdk/apps/openkey-vite`, `apps/openkey-example`
- Agent contract: `tinycloud-agents/packages/agent-client/src/delegation-validate.ts`,
  `delegated-transport.ts`, `delegation-policy.ts`
- Agent DID + key: `tinycloud-agents/.tinycloud/agent.key`; regenerate the DID with
  `cd packages/eliza-plugin-memory && TINYCLOUD_AGENT_KEY_FILE=<path> bun --bun run consent:harness`
  (use only its `agentDid` output; ignore its OpenKey URL).
- Phase 7 live scenario (the consumer of the delegation file):
  `tinycloud-agents/packages/eliza-plugin-memory/scripts/live-delegated-scenarios.ts`
  + `docs/openkey-phases/phase-7-runbook.md`.
- Smithers workflow conventions to follow when authoring the build workflow: clone
  `development/.smithers/workflows/tinycloud-agents-openkey-phase3.tsx` (setup → impl
  tasks → audit→capture→fix→regression loop until happy; deterministic regression
  `.mjs` gate; validate with `smithers graph <file>` + `node --check`). The existing
  `openkey-delegate-harness.{tsx,mjs}` is a starting point but must be retargeted to
  the standalone+published form (drop all fix-branch/`f4fc76c`/workspace machinery).

---

## Open question for the planner to resolve

- The deep policy validator (`validateDelegationPolicy`) is **not wired** into the
  transport yet (only the shallow validator runs). Decide whether the live proof
  should (a) rely on the shallow validator + node-side enforcement (simplest), or
  (b) first wire `validateDelegationPolicy` (Phase 5 TODO) for stricter pre-activation
  checks. The shallow path is sufficient for a first live proof.
