# Delegate UI — Research Findings

> Research notes — implementation complete in src/.
> This harness is a standalone Vite app depending ONLY on published packages.
> It does NOT link any local web-sdk; it does NOT use workspace:, file:, or link: references.

## Published package versions

```
"@tinycloud/web-sdk": "2.3.0"
"@openkey/sdk": "^0.8.4"
```

## 1. OpenKey passkey bridge

**Primary source**: `/Users/roman/Documents/GitHub/development/repositories/tinyboilerplate/packages/client/src/openkey.ts`
**Cross-reference**: `/Users/roman/Documents/GitHub/development/repositories/web-sdk/apps/openkey-vite/src/pages/Home.tsx`

### Flow

1. **Instantiate OpenKey** (openkey.ts:81-84):
   ```ts
   const openkey = new OpenKey({ host: "https://openkey.so", appName: "..." });
   ```
   Import is `import OpenKey from "@openkey/sdk"` (openkey.ts:1).

2. **Connect via widget/postMessage** (openkey.ts:88):
   ```ts
   const authResult = await openkey.connect();
   // authResult: { address: string; keyId: string }
   ```
   `openkey.connect()` opens an OpenKey iframe popup. The user authenticates with their passkey. On success, the popup closes and resolves with the Ethereum address and a `keyId` handle. This is the ONLY network call to openkey.so — it happens inside the popup. There is no direct cross-origin fetch from the app.

3. **Build EIP-1193 provider** (openkey.ts:31-64):
   ```ts
   const eip1193 = new OpenKeyEIP1193Provider(openkey, address, keyId, chainId);
   ```
   The provider implements:
   - `eth_accounts` / `eth_requestAccounts` → `[address]`
   - `eth_chainId` → `"0x1"` (configurable)
   - `personal_sign` → routes hex message through `openkey.signMessage({ message, keyId })` (openkey.ts:52-55)
   - `eth_getBalance` → `"0x0"`

   The openkey-vite variant (`openkey-vite/src/lib/openkey-provider.ts:7-47`) is identical in structure; in that app, the provider is additionally wrapped in `new providers.Web3Provider(eip1193Provider as any)` from ethers v5 (Home.tsx:79) for legacy TinyCloudWeb compatibility.

4. **Create TinyCloudWeb and sign in** (Home.tsx:90-93):
   ```ts
   const tcwProvider = new TinyCloudWeb({ providers: { web3: { driver: web3Provider } }, ... });
   await tcwProvider.signIn();
   ```
   `signIn()` issues a SIWE message and routes the `personal_sign` call through the EIP-1193 provider → OpenKey popup → passkey. Auto-creates the user's TinyCloud space on first sign-in.

### Key constraint

The passkey click in `openkey.connect()` / subsequent `openkey.signMessage()` calls is a **manual runbook step** — WebAuthn cannot be automated. The harness only needs to wire up the provider; the user clicks the popup.

## 2. Delegation creation API

**Primary source**: `/Users/roman/Documents/GitHub/development/repositories/web-sdk/apps/web-sdk-example/src/pages/DelegationModule.tsx`

### Imports (DelegationModule.tsx:2)

```ts
import { TinyCloudWeb, Delegation, PortableDelegation, serializeDelegation } from '@tinycloud/web-sdk';
```

### Creating a delegation (DelegationModule.tsx:111-122)

```ts
const space = tcw.space('default');
const result = await space.delegations.create({
  delegateDID,   // any DID string — did:pkh: is accepted (DelegationModule.tsx:53)
  path,          // e.g. "shared/"
  actions,       // string[] — see below
  expiry,        // Date
});
```

**Confirmed properties:**

(a) `delegateDID` **may be a `did:pkh`** — the field is a plain string; the template stores whatever the user types (DelegationModule.tsx:53, `setDelegateDID`). The agent side imposes a strict-string match so the value must be passed verbatim with correct checksum case.

(b) **SQL actions are accepted** — the template's `availableActions` array (DelegationModule.tsx:58-63) shows `tinycloud.kv/*` variants; the SDK routes through `legacyParamsToPermissionEntries` which splits by service namespace. For SQL delegation the harness should pass:
```ts
actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"]
```
(any subset is valid).

(c) **Serialization** (DelegationModule.tsx:33-36):
```ts
const json = serializeDelegation(portableDelegation);   // → JSON string
const base64 = btoa(json).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
```
`serializeDelegation` from `@tinycloud/web-sdk` returns a JSON string. The agent's Node SDK reads it back via `deserializeDelegation`. For agent handoff, serialize to JSON string (or base64url-encode it for URL transport).

### PortableDelegation transport fields (DelegationModule.tsx:14-27)

```ts
const portableDelegation: PortableDelegation = {
  ...delegation,
  delegationHeader: { Authorization: delegation.authHeader || `Bearer ${delegation.cid}` },
  ownerAddress,   // tcw.address()
  chainId,        // tcw.chainId() || 1
  host,           // TinyCloud node host
};
```

## 3. Vite wiring reference (openkey-vite)

**Source**: `/Users/roman/Documents/GitHub/development/repositories/web-sdk/apps/openkey-vite/vite.config.ts`

```ts
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: { port: 5175, strictPort: true },
  resolve: { alias: { "@": "/src" } },
});
```

The openkey-vite template uses `"@openkey/sdk": "0.7.2"` with `workspace:*` for web-sdk (its package.json:13-14). **The harness must NOT replicate this** — it must use published `"@openkey/sdk": "^0.8.4"` and `"@tinycloud/web-sdk": "2.3.0"` from npm.

## 4. SQL delegation note

Published `@tinycloud/web-sdk@2.3.0` already supports `tinycloud.sql` delegation. `createDelegation` internally routes through `legacyParamsToPermissionEntries`, which splits the `actions` array by service namespace and emits a multi-resource UCAN. No local web-sdk build, no branch linking, no fix is required.

## 5. Harness architecture (planned)

- **Standalone Vite + React app** at `tools/delegate-ui/`
- Dependencies: published `@tinycloud/web-sdk@2.3.0` and `@openkey/sdk@^0.8.4` from npm only
- No `workspace:`, `file:`, or `link:` references
- Auth flow: `new OpenKey({ host }) → openkey.connect() → OpenKeyEIP1193Provider → TinyCloudWeb → signIn()`
- Delegation flow: `tcw.space('default').delegations.create({ delegateDID, path, actions, expiry })` → `serializeDelegation(portableDelegation)` → display/copy JSON
- `delegateDID` field accepts any DID including `did:pkh:*`; value passed verbatim
