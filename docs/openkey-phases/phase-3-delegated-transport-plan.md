# Phase 3: Delegated Transport — Implementation Plan

Status: planning only (no code written). Scope is strictly Phase 3 of
`docs/openkey-auth-plan.md`. Phase 4 (delegation policy validation) is the next
phase and is explicitly out of scope here — see "Hand-off to Phase 4" at the end.

## Phase Goal

Add a second `Transport` implementation — a **delegated transport** — so that
`createAgentClient({ mode: "delegation", ... })` produces a working client whose
SQL flows through a user-granted portable delegation instead of an agent-owned
private-key sign-in. The public SQL API (`client.sql.query/execute/batch`) and
`TinyCloudMemoryStorageService` stay byte-for-byte unchanged: auth selection
lives below the `Transport` seam.

Concretely, after Phase 3:

- `createAgentClient` no longer throws on `mode: "delegation"`. It resolves the
  delegation config, builds a `DelegatedTransport`, and composes it through the
  existing `Worker` + `Session` + `Sql` machinery exactly like private-key mode.
- The `DelegatedTransport`:
  1. Loads the stable agent `TinyCloudNode` from agent key material.
  2. Deserializes the portable delegation (`deserializeDelegation`).
  3. Validates local shape (owner, delegate DID == agent DID, expiry, SQL
     resource for `dbHandle`) — *minimal* shape validation only; deep policy
     validation is Phase 4.
  4. Activates via `node.useDelegation(delegation)` → `DelegatedAccess`.
  5. Implements `query`/`execute`/`batch` over `delegatedAccess.sql.db(dbHandle)`.
- Private-key mode and every existing test stay green. The composition-root test
  `auth-composition.test.ts` is the tripwire and is an explicit acceptance gate
  on the final task.

This is **Path A: Direct Delegated Agent Client** from the plan. No sidecar.

## SDK Grounding Findings

The pinned dependency is `@tinycloud/node-sdk@2.3.0` (see
`packages/agent-client/package.json` and `bun.lock`). That exact version was NOT
installed under the agents repo at planning time (its `node_modules/@tinycloud`
entry is dangling/empty). I grounded against the two closest installed copies in
sibling repos under `/Users/roman/Documents/GitHub/development/repositories`:

- **openkey** → `@tinycloud/node-sdk@2.0.1` (same 2.x major as the 2.3.0 target;
  bundled `dist/core.d.ts`, plus `@tinycloud/sdk-core@2.0.1` and
  `@tinycloud/sdk-services@2.0.1` granular `.d.ts`). **Primary source of truth.**
- **muse-api** → `@tinycloud/node-sdk@1.1.0` (older major; per-file `.d.ts`).
  Used only for contrast — its `DelegatedAccess` exposed `kv` only, NO `sql`.
  The `sql` getter was added in the 2.x line. Do not ground on 1.1.0.

> RISK (version drift, applies to all findings below): I read 2.0.1, not the
> pinned 2.3.0. The 2.x surface is stable and the already-shipped Phase 2
> `agent-identity.ts` compiles against 2.3.0 using `PrivateKeySigner` + `pkhDid`,
> which corroborates the signer/DID findings. Treat every signature below as
> "confirmed for 2.0.x, expected-stable for 2.3.0." The first implementation task
> (`phase3-sdk-probe`) must re-confirm against the actually-installed 2.3.0 build
> before any production wiring, and downgrade any mismatch into a task `risks`
> entry with the fallback noted there.

### Confirmed signatures (node-sdk 2.0.x; expected-stable in 2.3.0)

- **Deserialize a portable delegation**
  `deserializeDelegation(data: string): PortableDelegation`
  — exported from `@tinycloud/node-sdk` root (re-exported from `./core.js`).
  Companion `serializeDelegation(delegation: PortableDelegation): string`.
  Source: `openkey/.../node-sdk/dist/index.d.ts` line 3 (re-export),
  `dist/core.d.ts` lines 409/413.

- **`PortableDelegation` shape** (`dist/core.d.ts` ~line 380-405):
  ```ts
  interface PortableDelegation extends Omit<Delegation, "isRevoked"> {
    delegationHeader: { Authorization: string }; // SECRET — never log
    ownerAddress: string;
    chainId: number;
    host?: string;
    disableSubDelegation?: boolean;
    publicDelegation?: PortableDelegation; // 2.x addition
  }
  ```
  Inherited `Delegation` fields (CID, delegate/delegator DIDs, resources,
  expiry) live in `@tinycloud/sdk-core`. The exact field NAMES for delegate DID,
  expiry, and SQL resources are NOT yet pinned — see UNCONFIRMED below.

- **`TinyCloudNode.useDelegation(...)`** (`dist/core.d.ts` line 981,
  `dist/TinyCloudNode.d.ts` line 417):
  `useDelegation(delegation: PortableDelegation): Promise<DelegatedAccess>`
  — single arg (the deserialized `PortableDelegation`), returns a Promise of
  `DelegatedAccess`. Works in two modes:
  - **session-only** (no `privateKey`): delegation's delegate DID must equal the
    node's session-key DID (`node.sessionDid`, `did:key:...`).
  - **wallet mode** (`privateKey` set): creates a SIWE sub-delegation from the
    PKH identity to the session key; delegation's delegate DID is the PKH DID
    (`node.did` = `did:pkh:eip155:1:{address}`).
  Our agent uses a stable `agentKey`, so we are in **wallet mode** and the
  delegation must target `did:pkh:eip155:1:{agentAddress}` — which is exactly the
  DID `agentIdentityFromKey` already produces. This aligns the
  "advertise == activate" invariant from Phase 2.

- **`DelegatedAccess` shape** (`dist/core.d.ts` lines 421-454): exposes
  `get delegation()`, `get spaceId(): string`, `get path(): string`,
  `get kv(): IKVService`, **`get sql(): ISQLService`**, `get duckdb()`.
  The `sql` getter is present in 2.x (CONFIRMED) — it was absent in 1.1.0.

- **`delegatedAccess.sql.db(dbHandle)` → `IDatabaseHandle`**
  (`sdk-services/dist/sql/ISQLService.d.ts`): `ISQLService.db(name?: string):
  IDatabaseHandle`. `IDatabaseHandle` has:
  ```ts
  query<T>(sql, params?, options?): Promise<Result<QueryResponse<T>>>
  execute(sql, params?, options?): Promise<Result<ExecuteResponse>>
  batch(statements, options?): Promise<Result<BatchResponse>>
  ```
  This is the **identical** handle shape the existing private-key
  `node-sdk-transport.ts` already consumes via `node.sql.db(this.dbHandle)`
  (it imports `IDatabaseHandle` from `@tinycloud/node-sdk`). The two transports
  can share an adapter over `IDatabaseHandle`.

- **Result / error mapping** (`sdk-services/dist/types.d.ts`):
  `Result<T, E = ServiceError> = { ok: true; data: T } | { ok: false; error: E }`.
  `ServiceError = { code: string; message: string; service: string; cause?: Error;
  meta?: Record<string, unknown> }`. The local `TransportResult` / `TransportError`
  already mirror this exactly. The existing `toTransportError` in
  `node-sdk-transport.ts` keeps only `{ code, message, service }` and DROPS
  `cause`/`meta` — that is the redaction we want; the delegated transport reuses it.
  `QueryResponse = { columns: string[]; rows: T[][]; rowCount: number }`,
  `ExecuteResponse = { changes: number; lastInsertRowId: number }`,
  `BatchResponse = { results: ExecuteResponse[] }` — all match the local
  `QueryData`/`ExecuteData`/`BatchData` mapping already in the private-key transport.
  Auth-ish error codes available: `AUTH_EXPIRED`, `AUTH_REQUIRED`,
  `AUTH_UNAUTHORIZED`, `PERMISSION_DENIED` (and SQL-specific
  `SQL_PERMISSION_DENIED`, `SQL_READONLY_VIOLATION`). NOTE the `Session`
  `authLike` matcher keys off substrings `["401","unauthorized","expired",
  "auth_expired","unauthenticated"]` — `AUTH_EXPIRED` and `AUTH_UNAUTHORIZED`
  match (`expired`/`unauthorized`), but `AUTH_REQUIRED` and `PERMISSION_DENIED`
  do NOT. This matters for the lifecycle decision (below).

- **`PrivateKeySigner`** (`dist/index.d.ts` lines 21-52):
  `new PrivateKeySigner(privateKey: string, chainId?: number)` with
  `getAddress(): Promise<string>`, `getChainId()`, `signMessage()`. Matches the
  Phase 2 `agent-identity.ts` usage. CONFIRMED in 2.0.1 root export.

- **`pkhDid`**: already imported and compiling in shipped `agent-identity.ts`
  against 2.3.0. NOTE: it is NOT in the 2.0.1 root `index.d.ts` export list — so
  it was either added between 2.0.1 and 2.3.0, or is exported via a subpath. This
  is a Phase-2 fact, not Phase-3, and Phase 3 should NOT re-import `pkhDid`; it
  should call the existing `agentIdentityFromKey` / `agentIdentityFromFile`
  helpers, which already encapsulate it.

### Unconfirmed / OPEN RISKS

1. **`DelegatedAccess.sql.db(dbHandle)` argument semantics.** The delegated
   space's path is fixed by the delegation (`delegatedAccess.path` /
   `delegatedAccess.spaceId`). It is UNCONFIRMED whether `db(name)` for the
   delegated handle expects the SAME full `xyz.tinycloud.eliza/memory` handle as
   private-key mode, or a path RELATIVE to the delegation's granted resource, or
   the bare db name. **Fallback**: probe both `db(dbHandle)` and `db()` (default)
   in `phase3-sdk-probe`; pick whichever the delegated `DelegatedAccess` accepts;
   record the answer; thread it through config. This is the single most likely
   integration surprise.

2. **`PortableDelegation` field names for delegate DID / expiry / SQL resources.**
   The inherited `Delegation` (from `sdk-core`) field names were not read to the
   leaf. Local shape validation (delegate DID match, expiry present, SQL resource
   covers `dbHandle`) needs the exact property paths. **Fallback**: the
   `phase3-sdk-probe` task reads `sdk-core`'s `Delegation` / `DelegationChain`
   `.d.ts` (or logs a real deserialized object's keys) and the validation task is
   written against the confirmed shape. Until confirmed, validation must be
   conservative: validate ONLY what is provably present, never reject on an
   assumed-but-absent field.

3. **`useDelegation` re-activation idempotency.** Whether calling
   `node.useDelegation(delegation)` twice on the same node (for the retry path) is
   safe, or whether each activation needs a FRESH `TinyCloudNode`, is UNCONFIRMED.
   **Fallback**: the lifecycle re-activation rebuilds the `TinyCloudNode` from the
   stored agent key + serialized delegation rather than re-calling on the old
   instance. This is cheap (no network until first SQL) and side-effect-free.

4. **Wallet-mode vs session-only construction for the agent.** Plan Phase 2 left
   this open. Wallet mode (construct `TinyCloudNode({ privateKey: agentKey, host
   })`, do NOT call `signIn()`, then `useDelegation`) is the expected path because
   the delegation targets the PKH DID. **Fallback**: if wallet-mode `useDelegation`
   without a prior `signIn()` fails, fall back to session-only mode by deriving
   the session DID and requiring the delegation target it — but that breaks the
   "stable PKH delegation target" model, so it would escalate to a plan question,
   not a silent switch. The probe task settles this.

5. **`useDelegation` may perform network I/O on activation.** If activation hits
   the node (e.g. to validate/anchor the sub-delegation), it must be funneled
   through the `Worker`/timeout machinery, not run raw in the constructor.
   **Decision**: activation happens lazily inside `signIn()` (which the `Session`
   already gates and dedupes), NOT in the transport constructor — see Lifecycle.

## Session-Refresh-vs-Delegation Lifecycle Decision

The existing `Session` (`session.ts`) assumes a refreshable sign-in: it arms a
proactive `reSignIn` timer (~50min) and, on an auth-like failure, does exactly
one `reSignIn()` + one retry. A portable delegation is **not** refreshable the
same way — it has a fixed expiry baked into `delegationHeader.Authorization`, and
re-running `useDelegation` from the SAME serialized delegation cannot extend that
expiry. Once the delegation expires, only a NEW user-granted delegation fixes it.

**Policy (the deliberate design):**

- **`signIn()` == "activate the delegation."** The delegated `Transport.signIn()`
  builds the agent `TinyCloudNode`, deserializes + shape-validates the delegation,
  calls `useDelegation`, caches the `DelegatedAccess`, and returns a `SignInResult`
  shaped from the delegation (`spaceId` = `delegatedAccess.spaceId`, `address` =
  delegation `ownerAddress`, `did` = the agent DID). The existing lazy-signIn +
  concurrency-dedupe in `Session.ensureSignedIn()` is reused unchanged.

- **Proactive refresh is DISABLED for delegated mode.** Re-running activation on a
  timer cannot extend a fixed-expiry delegation, so the ~50min timer is pure
  churn. Implementation: pass `reSignInMs` as `Infinity` (or a new
  `proactiveRefresh: false` option) for the delegated `Session`, so `scheduleRefresh`
  never arms a timer. The `Session` already `unref()`s the timer and tolerates its
  absence; this is the smallest change. **Do not** add a delegated-only refresh
  that silently no-ops — make the disable explicit and tested.

- **One retry on auth failure, then a TYPED auth error.** On an auth-like failure
  (per `Session.authLike`), do exactly one re-activation (rebuild node from stored
  agent key + serialized delegation, re-`useDelegation`) + one retry of the failed
  SQL call, then surface `AuthError`. This reuses `Session.runWithAuthRetry`
  verbatim — the only change is that the delegated transport's `signIn()` does
  re-activation instead of a fresh wallet sign-in. Re-activation of an
  **expired** delegation will fail again on the retry and surface `AuthError`,
  which is the correct terminal state (the user must re-delegate). No loop.

- **Expiry surfaced honestly.** An expired delegation should fail closed with an
  auth-flavored error, never silently fall back to plugin-sql (a hard non-goal).
  Deep "report `expired` vs `stale`" status is Phase 4; Phase 3 only needs the
  fail-closed + typed-error behavior.

Net effect: the delegated `Session` is the SAME class with `proactiveRefresh`
turned off and a transport whose `signIn()` re-activates instead of re-signs.
No new lifecycle class. The auth-retry path is shared and already tested.

## Atomic Tasks (ordered)

Each task leaves the tree green (build + typecheck + test) and is independently
verifiable. TDD: failing tests first. All tasks `manual: false`.

> Test-harness note: the existing tests use a fake `Transport` (see
> `auth-composition.test.ts`'s `fakeTransport`). The delegated transport's unit
> tests follow the same pattern by injecting a **fake `DelegatedAccess`-like SQL
> source** and a **fake `useDelegation` activator** into `DelegatedTransport` via
> a small `deps` seam — so no live node, no real key signing, and no network are
> needed for the transport's behavior tests. Real-SDK activation is exercised only
> by the live Phase 7 scenario, not these unit tests.

### Task 1 — `phase3-sdk-probe`
- **id**: `phase3-sdk-probe`
- **title**: Pin node-sdk 2.3.0 delegated-SQL + delegation-shape facts
- **files**: [`docs/openkey-phases/phase-3-sdk-findings.md`]
- **dependsOn**: []
- **tdd**: none (read-only investigation; output is a findings doc, not code)
- **prompt**: Against the ACTUALLY-installed `@tinycloud/node-sdk@2.3.0` (run
  `bun pm ls`/`find node_modules` to locate it; if absent, `bun install` first),
  read the real `.d.ts`/dist and record, in a short markdown findings file: (a) the
  exact `useDelegation` signature and return type; (b) that `DelegatedAccess` has
  `get sql(): ISQLService`; (c) the exact `db()` argument the delegated `sql`
  handle expects for our `dbHandle` (full handle vs relative vs bare — probe both
  if needed by reading the SQLService/DatabaseHandle impl); (d) the `Delegation` /
  `PortableDelegation` field names for delegate DID, expiry, and SQL resources;
  (e) whether `useDelegation` requires a prior `signIn()` in wallet mode and
  whether re-activation is idempotent. Do NOT write transport code. Flag any 2.3.0
  deviation from the 2.0.x facts in this plan.
- **acceptance**: `docs/openkey-phases/phase-3-sdk-findings.md` exists and answers
  (a)-(e) with file:line citations from the installed 2.3.0 build; build/typecheck/
  test still green (no source changed).
- **risks**: 2.3.0 may not be installable offline; `db()` semantics may require a
  live node to confirm definitively (fall back to documenting both candidates and
  letting Task 5's integration test pick).
- **manual**: false

### Task 2 — `phase3-delegated-transport-skeleton`
- **id**: `phase3-delegated-transport-skeleton`
- **title**: DelegatedTransport class implementing the Transport seam (no activation yet)
- **files**: [`packages/agent-client/src/delegated-transport.ts`,
  `packages/agent-client/src/delegated-transport.test.ts`,
  `packages/agent-client/src/index.ts`]
- **dependsOn**: [`phase3-sdk-probe`]
- **tdd**:
  - `delegated-transport.test.ts`: "DelegatedTransport implements the Transport
    interface (signIn/query/execute/batch are functions)".
  - "query/execute/batch before signIn throw/return a typed not-activated error
    (no silent null)".
  - "query/execute/batch delegate to an injected fake DelegatedAccess SQL handle
    and map QueryResponse/ExecuteResponse/BatchResponse to QueryData/ExecuteData/
    BatchData identically to the private-key transport" (reuse the same expected
    shapes as `auth-composition.test.ts`).
  - "SDK Result error is mapped to a redacted TransportError carrying only
    {code,message,service} — cause/meta/Authorization never appear".
- **prompt**: Create `DelegatedTransport implements Transport`. Constructor takes
  the resolved delegation config + a `deps` seam: `{ deserialize?, activate?,
  agentIdentity? }` defaulting to the real `@tinycloud/node-sdk`
  `deserializeDelegation` and a real activator that builds the wallet-mode
  `TinyCloudNode` and calls `useDelegation`. Implement `query/execute/batch` over
  the activated `DelegatedAccess.sql.db(dbHandle)` by REUSING the existing
  `mapResult`/`toTransportError` adapter logic from `node-sdk-transport.ts`
  (extract it into a shared `sql-handle-adapter.ts` helper if cleaner, keeping
  `node-sdk-transport.ts` behavior identical). Leave `signIn()` activation for
  Task 4 — for now `signIn()` may throw "not activated" and SQL methods assert an
  active handle. Export `DelegatedTransport` from `index.ts`. Do NOT wire it into
  `createAgentClient` yet.
- **acceptance**: `delegated-transport.test.ts` passes; private-key
  `node-sdk-transport` tests and `auth-composition.test.ts` unchanged and green;
  build + typecheck + test green.
- **risks**: extracting a shared adapter must not change the private-key
  transport's mapping (the composition test pins it); `DelegatedAccess.sql` typing
  depends on Task 1 confirming the `sql` getter.
- **manual**: false

### Task 3 — `phase3-delegation-shape-validation`
- **id**: `phase3-delegation-shape-validation`
- **title**: Minimal local delegation shape validation (pre-activation guard)
- **files**: [`packages/agent-client/src/delegation-validate.ts`,
  `packages/agent-client/src/delegation-validate.test.ts`,
  `packages/agent-client/src/delegated-transport.ts`,
  `packages/agent-client/src/index.ts`]
- **dependsOn**: [`phase3-sdk-probe`, `phase3-delegated-transport-skeleton`]
- **tdd**:
  - "valid delegation (owner + delegate DID == agent DID + future expiry + SQL
    resource for dbHandle) passes".
  - "missing owner address rejected with actionable error (no secret in message)".
  - "delegate DID != agent DID rejected".
  - "absent/expired expiry rejected".
  - "missing SQL resource for the configured dbHandle rejected".
  - "error messages never include delegationHeader.Authorization or agentKey".
- **prompt**: Add a pure `validateDelegationShape(delegation, { agentDid,
  dbHandle }): void | throws` using ONLY the field names confirmed in Task 1.
  This is SHALLOW shape validation (presence + delegate-DID match + not-expired +
  a SQL resource referencing `dbHandle`), NOT the full action/policy matrix —
  that is Phase 4. Wire it into `DelegatedTransport` so activation refuses a
  malformed delegation before calling `useDelegation`. All errors carry field
  names only, never values. If Task 1 could not confirm a field name, validate
  conservatively (skip that check, leave a `// Phase 4 / TODO` marker) rather than
  reject on a guessed field.
- **acceptance**: `delegation-validate.test.ts` passes; secret-non-leak assertions
  green; build + typecheck + test green.
- **risks**: over-strict validation could reject valid real delegations if a field
  name is wrong — hence "validate only what Task 1 confirmed."
- **manual**: false

### Task 4 — `phase3-activation-and-lifecycle`
- **id**: `phase3-activation-and-lifecycle`
- **title**: Activate via useDelegation in signIn(); disable proactive refresh; one-retry re-activation
- **files**: [`packages/agent-client/src/delegated-transport.ts`,
  `packages/agent-client/src/delegated-transport.test.ts`,
  `packages/agent-client/src/session.ts`,
  `packages/agent-client/src/session.test.ts`]
- **dependsOn**: [`phase3-delegated-transport-skeleton`,
  `phase3-delegation-shape-validation`]
- **tdd**:
  - "DelegatedTransport.signIn() activates exactly once: loads agent identity,
    deserializes, validates, calls the (fake) activator, caches DelegatedAccess;
    a second signIn() without invalidation reuses it (activator called once)".
  - "signIn() returns SignInResult with spaceId from DelegatedAccess.spaceId,
    address from delegation ownerAddress, did from agent identity".
  - "Session with proactive refresh disabled never arms the refresh timer
    (fake clock records zero setTimeout for the refresh cadence)".
  - "auth-like SQL failure triggers exactly one re-activation + one retry, then
    AuthError on persistent failure (no loop)" — driven through Session with a
    fake delegated transport.
- **prompt**: Implement `DelegatedTransport.signIn()` per the Lifecycle section:
  build wallet-mode `TinyCloudNode({ privateKey: <resolved agent key>, host })`
  (do NOT call node.signIn() unless Task 1 proved it's required), deserialize +
  validate + `useDelegation`, cache `DelegatedAccess`. Re-activation (for the
  retry path) rebuilds from the stored agent key + serialized delegation. Add a
  `proactiveRefresh?: boolean` (or treat `reSignInMs === Infinity`) option to
  `Session`/`SessionOptions` so the delegated `Session` never arms the refresh
  timer; keep private-key default behavior identical. Reuse
  `Session.runWithAuthRetry` for the one-retry-then-AuthError path unchanged.
- **acceptance**: new transport + session tests pass; ALL existing `session.test.ts`
  private-key cases unchanged and green; build + typecheck + test green.
- **risks**: `useDelegation` may need a prior `signIn()` or may do network I/O
  (Task 1 / risk #5) — if so, route activation through the worker rather than the
  constructor; re-activation idempotency (risk #3) handled by rebuilding the node.
- **manual**: false

### Task 5 — `phase3-wire-create-agent-client`
- **id**: `phase3-wire-create-agent-client`
- **title**: Wire delegation mode through createAgentClient (remove the Phase-3 throw)
- **files**: [`packages/agent-client/src/client.ts`,
  `packages/agent-client/src/config.ts`,
  `packages/agent-client/src/auth-composition.test.ts`]
- **dependsOn**: [`phase3-activation-and-lifecycle`]
- **tdd**:
  - Update `auth-composition.test.ts` Seam 4: replace "createAgentClient
    (delegation) fails closed before constructing the client" with
    "createAgentClient (delegation) composes a working client over an injected
    delegated transport (signIn/sql/stop wire through the seam)".
  - "delegation mode reuses the SAME Worker/Session resilience knobs as
    private-key mode" (Seam 5 stays green; the shared-defaults invariant holds).
  - "createAgentClient (delegation) still rejects a structurally invalid
    delegation config with an actionable, secret-free error" (calls
    `resolveDelegationConfig`).
- **prompt**: In `createAgentClient`, branch on `config.mode === "delegation"`:
  call `resolveDelegationConfig`, construct a `DelegatedTransport` (unless
  `deps.transport` is injected), build the `Worker`, build the `Session` with
  proactive refresh disabled, then compose `sql`/`ensureSchema` exactly as
  private-key mode. Remove the "Delegation transport not yet implemented" throw.
  The injected-`deps.transport` path must work for BOTH modes so tests stay
  transport-agnostic. Address the handoff's known finding: `createAgentClient`
  should now call `resolveDelegationConfig` so direct delegation callers get the
  same validation as Eliza callers. Update the two affected `auth-composition.test.ts`
  cases (delegation now composes; keep the resolver-defaults and private-key cases
  intact). PRESERVE every private-key assertion.
- **acceptance**: full `auth-composition.test.ts` green with the updated
  delegation case; the private-key composition case and Seam-5 defaults case
  unchanged; ENTIRE existing suite green; build + typecheck + test green. This is
  the explicit composition-root acceptance gate: private-key behavior and all
  prior tests must remain green.
- **risks**: editing `auth-composition.test.ts` must not weaken the private-key
  coverage; the delegation-fails-closed semantics move from "always throws" to
  "throws only on invalid config" — make that intentional and tested.
- **manual**: false

### Task 6 — `phase3-secret-redaction`
- **id**: `phase3-secret-redaction`
- **title**: Redact key/delegation material in ResolvedDelegationConfig + transport errors
- **files**: [`packages/agent-client/src/config.ts`,
  `packages/agent-client/src/auth-composition.test.ts`,
  `packages/agent-client/src/delegated-transport.ts`,
  `packages/agent-client/src/delegated-transport.test.ts`]
- **dependsOn**: [`phase3-wire-create-agent-client`]
- **tdd**:
  - FLIP the two `auth-composition.test.ts` "CURRENT POSTURE" tests: a
    `JSON.stringify` of a resolved delegation config must NOT contain `agentKey`
    or `serializedDelegation` values (add a `toJSON` redaction guard).
  - "DelegatedTransport never includes delegationHeader.Authorization, agentKey,
    or serializedDelegation in any thrown error or log line" (assert over a forced
    activation failure and a forced SQL error).
- **prompt**: Address the handoff's deferred redaction TODO. Add a `toJSON`
  redaction (or store secrets behind a non-enumerable/redacted field) on
  `ResolvedDelegationConfig` so accidental `JSON.stringify`/log cannot leak
  `agentKey` or `serializedDelegation`. Audit `DelegatedTransport` and the
  activation path for any error/log that could carry `delegationHeader.Authorization`
  or key material and scrub them (the existing `toTransportError` already drops
  cause/meta — verify the activation errors do too). Update the two
  `auth-composition.test.ts` posture tests to assert redaction (they were written
  to flip here on purpose).
- **acceptance**: flipped posture tests pass (`.not.toContain` secrets); transport
  secret-non-leak tests pass; build + typecheck + test green; full suite green.
- **risks**: a `toJSON` that drops fields could break a consumer that reads
  `resolved.agentKey` programmatically — keep the property readable on the object,
  redact only the serialized form.
- **manual**: false

## Proposed Deterministic Regression Guards (Phase 3 script)

The Phase 3 regression script is a per-phase clone of
`tinycloud-agents-openkey-auth-regression.mjs`. The crucial change: the Phase-1
guard `first-pr-does-not-activate-delegated-sql` (which FORBIDS `useDelegation(`)
must be REMOVED/INVERTED — Phase 3 is exactly when activation lands. Keep all the
branch/diff/build/typecheck/test guards. Add:

1. **`delegated-transport-exists-and-exported`** —
   `test -f packages/agent-client/src/delegated-transport.ts && rg -q
   'export class DelegatedTransport' packages/agent-client/src/delegated-transport.ts
   && rg -q 'DelegatedTransport' packages/agent-client/src/index.ts`.
   Asserts the new transport exists and is exported (replaces the inverted "no
   useDelegation" guard).

2. **`delegated-transport-activates-via-usedelegation`** —
   `rg -q 'useDelegation\s*\(' packages/agent-client/src/delegated-transport.ts`.
   The INVERSE of the Phase-1 guard: activation must now exist, and it must live
   ONLY in `delegated-transport.ts` (optionally also assert it does NOT appear in
   `node-sdk-transport.ts` to keep the private-key path clean).

3. **`no-secret-leak-in-errors`** —
   `! rg -n 'delegationHeader|\.agentKey|serializedDelegation' packages/agent-client/src
   | rg -v 'redact|toJSON|// ' | rg 'throw|console\.|logger\.'` (heuristic: no
   error/log line interpolates raw secret fields). Pairs with the Task-6
   redaction tests as a static tripwire.

4. **`private-key-transport-and-composition-unchanged-green`** — run the focused
   suite `bun --bun test packages/agent-client/src/auth-composition.test.ts
   packages/agent-client/src/node-sdk-transport*.test.ts
   packages/agent-client/src/session.test.ts` and require pass. Guarantees the
   private-key path and composition root never regress (in addition to the full
   `bun --bun run test`).

(Plus the inherited guards: `current-branch=feature/mvp`, `no-production-branch`,
`plan-doc-exists`, `diff-check`, `build`, `typecheck`, `test`.)

## Hand-off to Phase 4 (Delegation Policy Validation)

Phase 3 deliberately stops at SHALLOW shape validation. Phase 4 owns the full
policy matrix and status reporting:

- Deep action/resource validation: `tinycloud.sql/{read,write,admin}` for
  `xyz.tinycloud.eliza/memory` and `tinycloud.capabilities/read`; reject wrong
  delegatee, expired grant, malformed delegation, missing SQL resource,
  insufficient SQL actions, wrong db handle — each with a DISTINCT typed error.
- Policy-hash derivation + `active | expired | stale | none` status reporting.
- The `// Phase 4 / TODO` markers Task 3 leaves where a field name was unconfirmed
  or a check was intentionally shallow are the explicit seam Phase 4 picks up.
- Phase 3's `validateDelegationShape` is the lower bound Phase 4 extends — Phase 4
  should layer the policy checks on top, not rewrite the shape guard.
- Live OpenKey/passkey consent (Phase 6) and the live delegated scenario (Phase 7)
  remain untouched here; Phase 3's transport is exercised by unit tests with
  injected fakes only.
