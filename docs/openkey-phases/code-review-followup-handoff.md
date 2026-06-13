# Handoff: address the prod-readiness code-review findings

Date: 2026-06-13
Purpose: A fresh agent should **fix** the findings from the high-effort code review
of the delegated-memory prod-readiness work. The review is done; the fixes are not.
Trust the findings below unless the code contradicts them — each was deduped and
verified against the source. **Excluded from scope:** publish/release/changeset/tag/
deploy (same as the parent effort), and re-litigating already-locked decisions (see
"Do NOT do").

Repo: `/Users/roman/Documents/GitHub/tinycloud-agents` (branch `feature/mvp`).
The work under review is commit `b4ae128` (the only commit ahead of `origin/feature/mvp`,
**unpushed**). Read `docs/openkey-phases/prod-readiness-handoff.md` first for the
architecture (signed-att normalization chokepoint, F1, the slot model) — this doc
assumes that context.

---

## TL;DR

- The prod-readiness work shipped and is green (agent-client 212/0, eliza-plugin-memory
  101/0, both typecheck clean). A high-effort review then found **8 issues** — none are
  showstoppers, but three are worth fixing before this goes to PR.
- **Fix in this order:** #2 (slot guard may silently not fire) → #1 (strict JWT
  requirement narrows accepted delegations) → #4 (fragile URI parse) → #5 (security
  by convention) → then the lower-severity #3/#6/#7 and the #8 cleanups.
- Everything is on `feature/mvp`; keep it committed there. No publish/deploy.

---

## Current state (already done — do not redo)

- Signed-att normalization chokepoint (`deserializeAndNormalize`) is the default
  deserializer for `DelegatedTransport`; deep `validateDelegationPolicy` is wired before
  activation; activation failures wrap in `AuthError`; the eliza slot has a fail-fast
  guard; embeddings round-trip-tested; README has a Production Operations section.
- Verify the baseline is still green before you start, and after each fix:
  ```sh
  cd /Users/roman/Documents/GitHub/tinycloud-agents/packages/agent-client && bun run typecheck && bun test
  cd /Users/roman/Documents/GitHub/tinycloud-agents/packages/eliza-plugin-memory && bun run typecheck && bun test
  ```
- The bun shell prints a `virtualenvwrapper`/`pyenv` error banner on every command —
  it's harmless noise from the user's shell profile; ignore it.

---

## The findings to fix (ranked; each has a fix + acceptance criteria)

### #1 — [HIGH] Non-JWT / no-`att` Authorization is hard-rejected as MALFORMED
- **Where:** `packages/agent-client/src/delegation-normalize.ts` — `decodeJwtPayload`
  (throws when `parts.length < 2`) and `normalizeDelegationGrants` (throws when the att
  yields zero resources).
- **Symptom:** any delegation whose `delegationHeader.Authorization` is not a decodable
  ≥2-part JWT with a non-empty `att` now fails at `signIn()` with `MALFORMED`. The old
  path (`deserializeDelegation` + shallow validator) never inspected Authorization.
  The committed `delegation.sample.json:9` (`Bearer SCRUBBED_AUTH_TOKEN_PLACEHOLDER`)
  and the harness fallback `delegation.authHeader || \`Bearer ${cid}\``
  (`tools/delegate-ui/src/delegate.ts:70`) are exactly this shape.
- **Why it matters:** real web-sdk mints DO carry a JWT (the live run passed), so this
  is a *latent narrowing*, not a confirmed live break — but the negative path was never
  exercised, and a mint without `authHeader` is now dead-on-arrival.
- **Decision to make first (don't guess):** is requiring a signed JWT the intended
  contract? It is the security-correct stance (no signed grant ⇒ no trust). Recommended:
  **keep the strict requirement** but (a) make the error explicit/actionable
  ("delegation has no signed capability JWT; mint via the delegate-ui harness"), and
  (b) add a **negative test through the transport** proving a non-JWT Authorization is
  rejected (currently only the happy path and forged-att are covered).
- **Acceptance:** a `delegated-transport-policy-reject.test.ts` case feeding a serialized
  delegation with `Authorization: "Bearer bafy...cid"` (no dots) asserts `signIn()`
  rejects and `activate` never ran; the error message names the missing-signed-capability
  cause. Do NOT relax it into trusting the unsigned summary (that reopens F1).

### #2 — [HIGH] Slot guard has a lazy-registration false-negative
- **Where:** `packages/eliza-plugin-memory/src/storage.ts` — `assertSlotNotTaken` (reads
  `runtime.getServicesByType("memoryStorage")`), called first in `start()`.
- **Symptom:** if plugin-sql's service is *registered-but-not-yet-resolved* when our
  `start()` runs, `getServicesByType` can return `[]` → the guard passes → plugin-sql
  resolves first and **silently wins the slot** (memory routes to local SQLite). That is
  the exact failure the guard exists to prevent.
- **Evidence:** the new test only passes because it force-resolves the incumbent via
  `await runtime.getServiceLoadPromise("memoryStorage")` *before* calling our `start()`
  (`src/__tests__/slot-precedence.test.ts`). Production plugin-load gives no such
  ordering guarantee.
- **Recommended fix:** strengthen the guard so it can't be fooled by ordering. Options,
  best first: (a) also assert via `runtime.getService("memoryStorage")` identity — the
  slot *winner* is what `getService` (first-registered) resolves, not merely presence;
  re-check after a microtask/`getServiceLoadPromise` if the runtime exposes it; (b) if
  the runtime exposes a "plugins loaded" / post-init hook, run the assertion there
  instead of at our service `start()`. Document whichever invariant you rely on.
- **Acceptance:** a test where the foreign incumbent's load promise is *pending* (not
  resolved) at our `start()` still results in a loud failure (or a correct win that is
  then re-verified), not a silent pass. Keep the existing eager-registration test.

### #3 — [MED] `instanceof` foreign-detection false-positives across duplicate module copies
- **Where:** `packages/eliza-plugin-memory/src/storage.ts` — `assertSlotNotTaken`,
  `!(s instanceof TinyCloudMemoryStorageService)`.
- **Symptom:** two installs of `@tinycloud/eliza-plugin-memory` (version skew, hoisted vs
  nested, dist vs src) yield two class identities. A legitimately-TinyCloud incumbent
  from copy A fails `instanceof` in copy B → flagged "foreign" → loud boot failure whose
  message names the incumbent as *itself*.
- **Recommended fix:** identify "ours" by a stable marker that survives module
  duplication — e.g. a static brand string (`static readonly providerId = "@tinycloud/eliza-plugin-memory"`)
  compared against `(s as {constructor?:{providerId?:string}}).constructor?.providerId`,
  or compare `serviceType` + a capability marker — rather than `instanceof`.
- **Acceptance:** a test registering a *different class object* that carries the same brand
  is treated as "ours" (no throw); a genuinely foreign class still throws.

### #4 — [MED] Positional `uri.split("/")` recap-URI parse is fragile and forks SDK logic
- **Where:** `packages/agent-client/src/delegation-normalize.ts` — `resourcesFromAtt`
  (`segs[0]=space, segs[1]=service, segs.slice(2)=path`).
- **Symptom:** assumes the `tinycloud:pkh:…:default/sql/<path>` colon form. The SDK also
  documents a `tinycloud://my-space/kv/data` authority form; on that, `segs[1]` is empty
  → `service` falsy → the grant is **silently dropped** → deep validator rejects a valid
  delegation with `MISSING_SQL_RESOURCE`. Works for today's live format only.
- **Recommended fix:** use the SDK's own parser instead of a positional split.
  `@tinycloud/node-sdk` re-exports `parseSpaceUri` (reachable today). `@tinycloud/sdk-core`
  has `parseRecapCapabilities` + `DelegatedResourceSchema` ({service, space, path,
  actions}) — the canonical mapping; using it would require adding the sdk-core dep or
  asking for a node-sdk re-export. **Check what's importable first** (grep the installed
  `@tinycloud/node-sdk` and `@tinycloud/sdk-core` `dist/*.d.ts`). If a parser is
  reachable, replace the split; if not, make the split *self-validating* (match on the
  known `/sql/` or `/capabilities/` service boundary and reject URIs that don't, instead
  of silently dropping).
- **Acceptance:** a test with an att key in the `tinycloud://…` form (or any non-colon
  shape) either parses correctly or rejects loudly — never silently drops the SQL grant.

### #5 — [MED] The signed-att security boundary is enforced by convention, not structure
- **Where:** `packages/agent-client/src/delegated-transport.ts` — `deserialize:
  deps.deserialize ?? deserializeAndNormalize`.
- **Symptom:** normalization is only the *default* of an injectable dep. Any construction
  site passing `deserialize: deserializeDelegation` (a refactor, a copied test shipped as
  a fixture) silently bypasses normalization and re-opens the F1 forgery hole —
  `validateDelegationPolicy` would read the forgeable summary again.
- **Recommended fix:** make the signed-att derivation structural. Best: call
  `normalizeDelegationGrants(...)` **unconditionally inside `signIn()`** on the output of
  `deps.deserialize(...)`, so the deps seam controls *how bytes deserialize* but never
  *whether grants are signed-derived*. Tests that today inject a fake `deserialize`
  returning a hand-built delegation (with a real `delegationHeader.Authorization`) must
  still pass; the few fakes that return a delegation with a bogus/absent Authorization
  will need a minimal real JWT (reuse the `makeJwt` helper). Audit `delegated-transport.test.ts`
  fakes for this before flipping it.
- **Acceptance:** there is no construction path that reaches `validateDelegationPolicy`
  with un-normalized (summary-trusting) data. Add a test that constructing a transport
  and injecting `deserialize: deserializeDelegation` (raw) still ends up validating
  signed-derived grants (forgery still rejected).

### #6 — [MED-LOW] `SignInResult.address` is the unsigned, forgeable `ownerAddress`
- **Where:** `packages/agent-client/src/delegated-transport.ts` — `signIn()` builds
  `SignInResult` with `address: delegation.ownerAddress`.
- **Symptom:** normalization re-derives `resources`/`actions` from the signed att but
  never the owner address, so the address surfaced to the app/logs can be attacker-set
  while grants are signed-correct. Access stays server-enforced (mislabel, not breach).
- **Recommended fix:** derive the address from the signed side — the att resource URIs
  carry the space id (`tinycloud:pkh:eip155:1:0x<owner>:default`); extract the owner from
  the normalized resource `space` (or cross-check `ownerAddress` against it and reject on
  mismatch). At minimum, document that `SignInResult.address` is advisory and not a
  signed identity.
- **Acceptance:** `SignInResult.address` matches the owner in the signed space URI, or a
  mismatch between `ownerAddress` and the signed space is rejected.

### #7 — [LOW] `resourcesFromAtt` treats a JSON array att-value as an abilities map
- **Where:** `packages/agent-client/src/delegation-normalize.ts` — the
  `typeof abilities === "object"` guard in `resourcesFromAtt`.
- **Symptom:** an att value that is an array passes the guard; `Object.keys([...])` yields
  `["0"]` as bogus "actions" → junk resource → confusing `INSUFFICIENT_ACTIONS` instead
  of a clean `MALFORMED`. Defensive only (a real server signs proper objects).
- **Fix:** add `!Array.isArray(abilities)` to the guard (and/or validate ability keys look
  like `<service>/<action>` URNs). **Acceptance:** an att with an array value → `MALFORMED`,
  not a junk resource.

### #8 — [LOW · cleanup] Duplication
- `deserializeAndNormalize`'s deserialize try/catch (`delegation-normalize.ts`) is
  byte-identical to the exported `deserializeDelegationSafe` (`delegation-policy.ts`) —
  call the latter instead.
- `b64url` / `makeJwt` / `makeAtt` + the `SPACE`/`AGENT_DID`/`DB_HANDLE` constants are
  duplicated across `delegation-normalize.test.ts` and
  `delegated-transport-policy-reject.test.ts` — extract one shared test-fixtures module so
  the signed-att wire format lives in ONE place (currently hand-encoded in 3).
- (Optional, noted by the efficiency angle) `defaultActivate` re-reads `agentKeyFile` and
  re-runs `normalizeAgentKey`, though `signIn()` already resolved an `AgentIdentity` whose
  `.normalizedKey` could be threaded in — one fewer disk read + less time key material sits
  in memory. And the shallow `validateDelegationShape` is now largely subsumed by
  `validateDelegationPolicy`; the parent handoff explicitly allowed "keep as a cheap
  pre-check OR fold it in" — folding it in removes a lockstep-maintenance hazard.

---

## Do NOT do (already decided or verified non-issues)

1. **Do NOT add a least-privilege (no-`admin`) policy mode** — the user explicitly chose
   to keep `read+write+admin` in `defaultElizaMemoryPolicy` (admin is needed for
   `ensureSchema` DDL). The review flagged "no mode drops admin"; that is intended, not a
   bug.
2. **Do NOT "fix" the `AuthError` wrapping to preserve auth markers** — Session never
   classifies signIn-path errors (`isAuthError`/`authLike` run only inside the SQL
   `attempt()` path), so wrapping `activate()` failures changes no retry behavior. Verified.
3. **Do NOT touch the case-sensitive `delegateDID` compare in `delegation-validate.ts:51`**
   as part of this pass — it's pre-existing (not in this diff) and the live run proves the
   casing aligns in practice. If you want to harden it later, use the SDK's
   `principalDidEquals` (already imported in `delegation-policy.ts`), but it's out of scope
   here.
4. **Do NOT relax normalization to trust the unsigned top-level `actions`/`resources`** for
   any fix — that reopens F1 (the whole point of the chokepoint). #1 and #5 must stay on
   the signed side.
5. **Do NOT publish/release/changeset/tag/deploy, or push the branch.** Same scope wall as
   the parent effort.

---

## Pointers

- Normalizer: `packages/agent-client/src/delegation-normalize.ts`
  (`deserializeAndNormalize`, `normalizeDelegationGrants`, `resourcesFromAtt`,
  `decodeJwtPayload`).
- Transport wiring: `packages/agent-client/src/delegated-transport.ts`
  (default `deserialize` dep; `validateDelegationPolicy` call; `activate` try/catch;
  `SignInResult` build).
- Deep validator + the helper to dedupe against:
  `packages/agent-client/src/delegation-policy.ts` (`validateDelegationPolicy`,
  `deserializeDelegationSafe`, `serviceMatches` dual-form, `defaultElizaMemoryPolicy`).
- Shallow validator: `packages/agent-client/src/delegation-validate.ts`.
- Session lifecycle (caller of `signIn`): `packages/agent-client/src/session.ts`
  (`ensureSignedIn`, `runWithAuthRetry` ~L176/185/189, `reSignIn`).
- Slot guard + test: `packages/eliza-plugin-memory/src/storage.ts` (`assertSlotNotTaken`,
  `start`); `packages/eliza-plugin-memory/src/__tests__/slot-precedence.test.ts`.
- New tests to extend: `packages/agent-client/src/delegation-normalize.test.ts`,
  `packages/agent-client/src/delegated-transport-policy-reject.test.ts` (shared `makeJwt`/
  `b64url`/`makeAtt` helpers live here).
- SDK symbols to check for #4: grep `@tinycloud/node-sdk` and `@tinycloud/sdk-core`
  `dist/*.d.ts` under `node_modules/.bun/` for `parseSpaceUri`, `parseRecapCapabilities`,
  `DelegatedResourceSchema`, `SERVICE_SHORT_TO_LONG`.
- Real signed att to test against (gitignored secret, do not commit):
  `packages/eliza-plugin-memory/.tinycloud/agent-delegation.json` — decode
  `delegationHeader.Authorization` part 2 (base64url) to see the live `att` URI shape.
- Live re-run (only if you change activation behavior; manual passkey not needed for these
  fixes):
  ```sh
  cd packages/eliza-plugin-memory
  TINYCLOUD_LIVE=1 \
  TINYCLOUD_DELEGATION_FILE="$(pwd)/.tinycloud/agent-delegation.json" \
  TINYCLOUD_AGENT_KEY_FILE="$(git rev-parse --show-toplevel)/.tinycloud/agent.key" \
  TINYCLOUD_HOST="https://node.tinycloud.xyz" \
  bun --bun scripts/live-delegated-scenarios.ts
  ```

---

## Definition of done

- #1–#7 fixed (or, for #1, an explicit decision recorded + the negative test added);
  #8 cleanups applied.
- Both packages typecheck clean and all tests pass; every fix lands with a test that
  fails before and passes after.
- Changes committed on `feature/mvp` (not pushed). `.tinycloud/` stays gitignored and
  never staged (`git check-ignore` confirms; `.gitignore:9`).
- No publish/release/deploy.
