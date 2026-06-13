# Phase 3 — SDK Findings: @tinycloud/node-sdk@2.3.0

**Investigation date**: 2026-06-13
**SDK version grounded against**: `@tinycloud/node-sdk@2.3.0` (the actually-installed
build, found at
`packages/agent-client/node_modules/@tinycloud/node-sdk/`).
**Also read**: `@tinycloud/sdk-core@2.3.0` (bun cache at
`node_modules/.bun/@tinycloud+sdk-core@2.3.0+3979d1ea1140de98/node_modules/@tinycloud/sdk-core/dist/index.d.ts`
and `index.js`) and `@tinycloud/sdk-services@2.3.0` (bun cache at
`node_modules/.bun/@tinycloud+sdk-services@2.3.0/node_modules/@tinycloud/sdk-services/dist/sql/index.d.ts`
and `sql/index.js`).

---

## (a) `useDelegation` exact signature and return type

**Location**:
`packages/agent-client/node_modules/@tinycloud/node-sdk/dist/core-BdlIWB-K.d.ts` line 1496

```ts
useDelegation(delegation: PortableDelegation): Promise<DelegatedAccess>
```

- Single argument: a `PortableDelegation` (the deserialized portable object).
- Returns `Promise<DelegatedAccess>`.
- Re-exported from the root `index.d.ts` line 3 via the aliased bundle.

**No deviation from 2.0.x.** Signature is identical to what the plan documented.

---

## (b) `DelegatedAccess.get sql(): ISQLService` — confirmed present

**Location**:
`packages/agent-client/node_modules/@tinycloud/node-sdk/dist/core-BdlIWB-K.d.ts` line 610

```ts
get sql(): ISQLService;
```

Full `DelegatedAccess` getter surface (lines 594–626):
- `get delegation(): PortableDelegation` (line 594)
- `get spaceId(): string` (line 598)
- `get path(): string` (line 602)
- `get kv(): IKVService` (line 606)
- `get sql(): ISQLService` (line 610)  ← confirmed
- `get duckdb(): IDuckDbService` (line 614)
- `get hooks(): IHooksService` (line 618)
- `get restorable(): RestorableSession` (line 626)

**No deviation from 2.0.x.** The `sql` getter was present in 2.x and is confirmed in 2.3.0.

The `DelegatedAccess` constructor (line 590) creates an `SQLService({})` (no
`defaultDatabase` config) and stores it in `this._sql`. The `sql` getter returns
that stored service.

Source reference (implementation):
`packages/agent-client/node_modules/@tinycloud/node-sdk/dist/core.js` lines 1099–1101:
```js
this._sql = new SQLService({});
this._sql.initialize(this._serviceContext);
this._serviceContext.registerService("sql", this._sql);
```

---

## (c) `db()` argument semantics — CRITICAL FINDING, plan assumption needs correction

### How `db(name)` works in `ISQLService`

**Source**: `node_modules/.bun/@tinycloud+sdk-services@2.3.0/.../sql/index.d.ts` line 152,
and `sql/index.js` lines 382–384:

```ts
// Type signature
db(name?: string): IDatabaseHandle;

// Implementation
db(name) {
  return new DatabaseHandle(this, name ?? this.defaultDbName);
}
```

The `name` argument is the **bare database name** passed directly to the server as the
`dbName` segment in the UCAN invocation path:
```js
// sql/index.js line 530
const headers = this.context.invoke(session, "sql", dbName, action);
```

### What the private-key transport passes today

`packages/agent-client/src/node-sdk-transport.ts` line 83:
```ts
return this.node.sql.db(this.dbHandle);
```

Where `this.dbHandle` comes from `config.dbHandle` which defaults to
`"xyz.tinycloud.eliza/memory"` (see `packages/agent-client/src/config.ts` line 13).

This means **the private-key transport is already passing the full handle string
`"xyz.tinycloud.eliza/memory"` as the `db()` name argument**, not a bare name like
`"memory"`.

### How `useDelegation` in wallet mode constructs the sub-delegation

**Source**: `core.js` lines 4279–4281 — when building the sub-delegation SIWE for
wallet mode, `useDelegation` reads the FLAT `delegation.path` field to build the
abilities map:
```js
if (sqlActions.length > 0) {
  abilities.sql = { [delegation.path]: sqlActions };
}
```

This means the `PortableDelegation.path` field (the flat single-resource field) IS
used as the SQL path in the derived SIWE session.

### Conclusion for `db()` argument on delegated access

**The delegated `DelegatedAccess.sql.db(name)` expects the SAME argument format as the
private-key `node.sql.db(name)`.** Specifically:

- Both transports should call `sql.db(this.dbHandle)` where `dbHandle` is the full
  handle string (e.g. `"xyz.tinycloud.eliza/memory"`).
- The UCAN path embedded in the delegation `PortableDelegation.path` must match this
  exact string (it is the path that the owner used when creating the delegation).
- `db()` with no argument would use `"default"` (the `defaultDbName` fallback, since
  `DelegatedAccess` constructs `SQLService({})` with no `defaultDatabase`), which is
  WRONG for our use case.

**Verdict**: Use `delegatedAccess.sql.db(dbHandle)` with the same `dbHandle` value as
the private-key transport. This is NOT a deviation — it is the same pattern. The
plan's Risk #1 ("full handle vs relative vs bare") is RESOLVED: use the same full
handle string.

---

## (d) `Delegation` / `PortableDelegation` field names

### `Delegation` base type (from `@tinycloud/sdk-core@2.3.0`)

**Source**: `sdk-core/dist/index.d.ts` lines 1380–1432 (`DelegationSchema` + inferred type).

```ts
type Delegation = {
  cid: string;                    // Content identifier of the delegation UCAN
  delegateDID: string;            // DID of the party RECEIVING the delegation
  spaceId: string;                // Full space URI
  path: string;                   // Resource path granted (single-resource flat field)
  actions: string[];              // Full-URN action strings, e.g. ["tinycloud.sql/read"]
  expiry: Date;                   // When this delegation expires (a JS Date)
  isRevoked: boolean;             // Whether revoked (Zod-parsed; present at runtime)
  delegatorDID?: string;          // DID of the party GRANTING the delegation (optional)
  createdAt?: Date;               // Creation time (optional)
  parentCid?: string;             // Parent delegation CID for sub-delegations (optional)
  allowSubDelegation?: boolean;   // Whether sub-delegation is allowed (optional)
  authHeader?: string;            // Raw Authorization header string (optional)
}
```

### `PortableDelegation` extension (from node-sdk 2.3.0)

**Source**: `core-BdlIWB-K.d.ts` lines 519–542.

```ts
interface PortableDelegation extends Omit<Delegation, "isRevoked"> {
  delegationHeader: { Authorization: string };  // SECRET — structured auth header
  ownerAddress: string;                         // Space owner's Ethereum address
  chainId: number;                              // EIP-155 chain ID
  host?: string;                               // TinyCloud host URL
  disableSubDelegation?: boolean;              // Prevent recipient from sub-delegating
  publicDelegation?: PortableDelegation;       // Companion public-space delegation
  resources?: DelegatedResource[];             // Multi-resource breakdown (2.x addition)
}
```

`PortableDelegation` OMITS `isRevoked` (it cannot be revoked client-side by the
serialized form).

### `DelegatedResource` type (multi-resource breakdown)

**Source**: `sdk-core/dist/index.d.ts` lines 2411–2431.

```ts
type DelegatedResource = {
  service: string;   // Short-form, e.g. "sql", "kv", "duckdb"
  space: string;     // Full space ID URI
  path: string;      // Resource path; empty string if no path segment
  actions: string[]; // Full-URN ability strings
}
```

### Summary of field names for Phase 3 validation

| Purpose | Field path | Notes |
|---------|-----------|-------|
| Delegate DID | `delegation.delegateDID` | Must equal the agent's PKH DID |
| Expiry | `delegation.expiry` | A `Date` object; check `> new Date()` |
| Owner address | `delegation.ownerAddress` | Used as `address` in `SignInResult` |
| Space ID | `delegation.spaceId` | Used as `spaceId` in `SignInResult` |
| SQL resources (flat) | `delegation.actions` (filter `tinycloud.sql/`) and `delegation.path` | Single-resource path |
| SQL resources (multi) | `delegation.resources` filtered by `service === "sql"` | Present only for multi-resource UCANs; absent for legacy single-resource |
| Secret header | `delegation.delegationHeader.Authorization` | NEVER log or include in errors |

**Key for Phase 3 shape validation**: Both `delegation.path` and `delegation.actions`
are ALWAYS present (required by `DelegationSchema`). For a SQL delegation, validate:
1. `delegation.delegateDID === agentDid`
2. `delegation.expiry > new Date()`
3. Either `delegation.actions.some(a => a.startsWith("tinycloud.sql/"))` (flat path
   covers the dbHandle) OR `delegation.resources?.some(r => r.service === "sql")`
   (multi-resource covers it).

For Phase 3's SHALLOW check, checking `actions` for any `tinycloud.sql/` action is
sufficient — deep path/action matrix validation is Phase 4.

---

## (e) `useDelegation` + `signIn()` requirement; re-activation idempotency

### Wallet mode REQUIRES a prior `signIn()`

**Source**: `core.js` lines 4263–4265 (the wallet-mode branch of `useDelegation`):

```js
const mySession = this.auth?.tinyCloudSession;
if (!mySession) {
  throw new Error("Not signed in. Call signIn() first.");
}
```

**CONFIRMED**: In wallet mode (when `privateKey` is provided in the config),
`useDelegation` will throw synchronously with `"Not signed in. Call signIn() first."`
if there is no active `tinyCloudSession` on the auth layer. A prior `node.signIn()`
is mandatory.

**Implication for the delegated transport**: The `DelegatedTransport.signIn()` must
call `node.signIn()` BEFORE calling `node.useDelegation(delegation)`. The
`TinyCloudNodeConfig.autoCreateSpace` flag should be `false` for the delegated
transport (the agent is accessing ANOTHER USER's space, not its own — creating a
space would be wrong and also fails without one).

**Revised construction**:
```ts
const node = new TinyCloudNode({
  privateKey: agentKey,
  host: config.host,
  autoCreateSpace: false,   // Never create a space for the agent in delegated mode
});
await node.signIn();                            // Required before useDelegation
const access = await node.useDelegation(delegation);
```

This is a **deviation from the Phase 3 plan's expectation** (plan §"Wallet mode"
paragraph said "do NOT call node.signIn() unless Task 1 proved it's required"). Task 1
(this document) has proved it IS required. Update Task 4's prompt accordingly.

### `useDelegation` performs network I/O

**Source**: `core.js` lines 4308–4313 (inside the wallet-mode branch):

```js
const activateResult = await activateSessionWithHost2(
  targetHost,
  invokerSession.delegationHeader
);
if (!activateResult.success) {
  throw new Error(`Failed to activate delegated session: ${activateResult.error}`);
}
```

`activateSessionWithHost` (sdk-core `index.js` lines 2244–2272) makes a real HTTP
POST to `${host}/delegate`. **Activation is a network call**, not pure in-memory work.

**Implication** (confirming Risk #5 from the plan): `useDelegation` must run inside
the `Worker`/timeout machinery, not raw in the transport constructor. The plan's
decision to run activation lazily inside `signIn()` is correct, and the `signIn()`
already gets gated through `Session.ensureSignedIn()` which runs inside the worker.

### Re-activation idempotency

**Source**: `useDelegation` in `core.js` (lines 4219–4346) — each call:
1. Reads `this.auth.tinyCloudSession` (the wallet-mode SIWE session).
2. Calls `this.wasmBindings.prepareSession` (generates a fresh ephemeral SIWE for
   the sub-delegation, using the current session key).
3. Signs with `this.signer.signMessage`.
4. Calls `completeSessionSetup` (WASM).
5. POSTs to `${host}/delegate` (network I/O).
6. Returns a FRESH `DelegatedAccess`.

Each call produces a **fresh sub-delegation SIWE** signed against the CURRENT wallet
session. This means:

- Multiple calls on the same `TinyCloudNode` instance ARE safe (each creates an
  independent `DelegatedAccess`; there is no mutable state clash).
- However, each call produces a new sub-delegation SIWE with a new expiry (capped at
  1 hour from now, `core.js` line 4289–4290), so the returned `DelegatedAccess`
  objects have different lifetimes.
- The `auth.tinyCloudSession` underlying the parent wallet sign-in also has a limited
  lifetime (default 1 hour from `signIn()`). If the wallet session expires, calling
  `useDelegation` again on the same node will still fail because
  `this.auth.tinyCloudSession` will have expired.

**Verdict for re-activation (Risk #3 from plan)**: Re-activating by calling
`useDelegation` again on the SAME node may work if the wallet session is still fresh,
but fails if the wallet session itself has expired (~1h). The plan's fallback —
**rebuilding the `TinyCloudNode` from the stored agent key + serialized delegation**
for the retry path — is the correct and safest approach. Each rebuild gets a fresh
wallet sign-in (new `tinyCloudSession`) and a fresh sub-delegation.

---

## Summary of deviations from 2.0.x facts in the plan

| Finding | Plan said | 2.3.0 reality | Action |
|---------|-----------|---------------|--------|
| `useDelegation` requires prior `signIn()` | "do NOT call signIn() unless proved required" | **CONFIRMED REQUIRED** in wallet mode | Task 4 must call `node.signIn()` before `useDelegation`; use `autoCreateSpace: false` |
| `db()` argument | OPEN RISK (full vs relative vs bare) | **Same full-handle string** as private-key transport (e.g. `"xyz.tinycloud.eliza/memory"`) | No change to transport code logic; just confirm `db(dbHandle)` |
| `useDelegation` does network I/O | Risk #5 — suspected | **CONFIRMED**: POSTs to `${host}/delegate` | Activate inside `signIn()` (already the plan decision) |
| Re-activation idempotency | Risk #3 — unconfirmed | Safe on same node if wallet session is fresh; rebuild node for retry path | Plan fallback is correct |
| `RestorableSession` type added | Not in 2.0.x plan | Added in 2.3.0 (lines 564–574 in core d.ts); useful for session persistence but not needed for Phase 3 | Note only |
| `DelegatedAccess.hooks` getter | Not mentioned in plan | Added in 2.3.0 (line 618 in d.ts) | No impact on Phase 3 |

---

## File reference index

| File | Content |
|------|---------|
| `packages/agent-client/node_modules/@tinycloud/node-sdk/dist/core-BdlIWB-K.d.ts` | `TinyCloudNode`, `DelegatedAccess`, `PortableDelegation`, `deserializeDelegation`, `serializeDelegation`, `RestorableSession` type definitions |
| `packages/agent-client/node_modules/@tinycloud/node-sdk/dist/index.d.ts` | Root re-export surface for `@tinycloud/node-sdk` |
| `packages/agent-client/node_modules/@tinycloud/node-sdk/dist/core.js` | Runtime implementation: `useDelegation` (line 4219), `DelegatedAccess` constructor (line 1084) |
| `node_modules/.bun/@tinycloud+sdk-core@2.3.0+.../dist/index.d.ts` | `Delegation` type (via `DelegationSchema`, line 1380), `DelegatedResource` (line 2411) |
| `node_modules/.bun/@tinycloud+sdk-services@2.3.0/node_modules/@tinycloud/sdk-services/dist/sql/index.d.ts` | `ISQLService`, `IDatabaseHandle`, `SQLService`, response types |
| `node_modules/.bun/@tinycloud+sdk-services@2.3.0/node_modules/@tinycloud/sdk-services/dist/sql/index.js` | `SQLService.db()` (line 382), `invokeSQL` (line 528) |
| `node_modules/.bun/@tinycloud+sdk-core@2.3.0+.../dist/index.js` | `activateSessionWithHost` (line 2244) |
| `node_modules/.bun/@tinycloud+sdk-services@2.3.0/node_modules/@tinycloud/sdk-services/dist/index.js` | `ErrorCodes` (lines 2–43): `AUTH_EXPIRED`, `AUTH_REQUIRED`, `AUTH_UNAUTHORIZED`, `PERMISSION_DENIED`, `SQL_PERMISSION_DENIED`, `SQL_READONLY_VIOLATION` |
