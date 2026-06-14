# delegate-ui — OpenKey Delegation Harness

A browser-based harness for minting a TinyCloud SQL delegation for the Eliza memory
agent. You sign in with your passkey via the OpenKey widget, then create a signed
delegation that grants the agent read/write/admin access to your memory space.

Uses **published** `@tinycloud/web-sdk@2.3.0` and `@openkey/sdk@^0.8.4`. There is no
local web-sdk build, no workspace link, no `fix/web-sdk-sql-delegation` branch — the
published 2.3.0 package already supports SQL delegation.

---

## Key distinctions before you start

- The **agent key** (`TINYCLOUD_AGENT_KEY`) is a dedicated service-identity credential.
  It is NOT your personal wallet and must never be one. Its blast radius is limited to
  the agent's TinyCloud memory space.
- The **delegation** grants ONLY `tinycloud.sql/read|write|admin` on the `dbHandle`
  (default `xyz.tinycloud.eliza/memory`). It does not touch any other resource.
- The **delegateDID** (`did:pkh:eip155:1:0x…`) is derived from the agent key. It is
  the delegatee identity — not the user's wallet address.

---

## End-to-end manual runbook

### Step 1 — Build prerequisites

```sh
cd tools/delegate-ui
bun install
bun --bun run dev
```

Vite starts on `http://localhost:5173` (or the next available port). Leave this running
while you complete the steps below.

### Step 2 — Open the harness in a browser

Open `http://localhost:5173` in a browser that supports WebAuthn/passkeys (Chrome,
Firefox, Safari, or Edge on a desktop with a platform authenticator or a security key).

**Origin and passkey trust:**

WebAuthn credentials are origin-bound. The credential only works on the exact origin
(scheme + host + port) it was originally created on. Do NOT use a self-signed TLS cert
on localhost — browsers reject it and WebAuthn fails with a vague `NotAllowedError`.
Plain `http://localhost` works for local passkey testing in most browsers.

| Environment | Origin to use |
| --- | --- |
| Local dev (this harness) | `http://localhost:5173` (Vite default) |
| Production | `https://openkey.tinycloud.xyz` |

If you see `NotAllowedError: The operation either timed out or was not allowed`, the
most common cause is an origin mismatch or an untrusted certificate.

### Step 3 — Fill in the form fields

The harness pre-populates sensible defaults. Verify or update each field:

| Field | Default | Notes |
| --- | --- | --- |
| **Delegate DID** | `did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c` | The agent's stable identity DID, derived from `TINYCLOUD_AGENT_KEY`. If you are using a different agent key, regenerate via the consent harness (`bun --bun run consent:harness` in `packages/eliza-plugin-memory`) and use the printed `agentDid`. |
| **DB Handle** | `xyz.tinycloud.eliza/memory` | The SQL handle for the agent's memory space. Change only if you overrode `TINYCLOUD_DB_HANDLE`. |
| **Host** | `https://node.tinycloud.xyz` | TinyCloud node endpoint. Change only if you are using a non-default node. |

The delegateDID is passed VERBATIM to the delegation — case and checksum are preserved
exactly as entered. Do not alter the checksum capitalization.

### Step 4 — Sign in with passkey

Click **"Sign in with passkey"**. The OpenKey SDK widget opens in a popup or overlay.
Approve the sign-in using your passkey or security key when the browser prompts.

After approval, the harness shows:

```
Signed in!
Address: 0x…
DID: did:pkh:eip155:1:0x…
```

Confirm the address matches the TinyCloud space you intend to grant access from (this
is your user identity, not the agent identity).

### Step 5 — Create the delegation

The delegation details table appears below the sign-in confirmation:

| Field | Expected value |
| --- | --- |
| Delegate DID | Must match the `agentDid` from the consent harness exactly |
| Path | `xyz.tinycloud.eliza/memory` (or your custom `dbHandle`) |
| Actions | `tinycloud.sql/read`, `tinycloud.sql/write`, `tinycloud.sql/admin`, `tinycloud.capabilities/read` |
| Expiry | 30 days from now |

Before clicking, verify that the **delegateDID** shown matches the agent DID exactly
(character-for-character, including checksum case). A mismatch means the wrong agent
receives the capability.

Click **"Create Delegation"**. The harness calls `space.delegations.create()` and
displays the result. Confirm:

- `delegateDID` in the result table equals the agent DID you entered.
- `Actions` includes `tinycloud.sql/read`, `tinycloud.sql/write`, `tinycloud.sql/admin`.

### Step 6 — Download and install the delegation file

Click **"Download agent-delegation.json"**. Save the file to:

```
/Users/roman/Documents/GitHub/tinycloud-agents/packages/eliza-plugin-memory/.tinycloud/agent-delegation.json
```

Then restrict permissions:

```sh
chmod 600 /Users/roman/Documents/GitHub/tinycloud-agents/packages/eliza-plugin-memory/.tinycloud/agent-delegation.json
```

The file contains capability material (`delegationHeader.Authorization`). Never print,
log, or commit this value. The file should never be added to version control.

Quick sanity check (no network required):

```sh
node -e "
  const d = JSON.parse(require('fs').readFileSync(
    'packages/eliza-plugin-memory/.tinycloud/agent-delegation.json', 'utf-8'));
  console.log('delegateDID:', d.delegateDid || d.delegate?.did || '(check field)');
  console.log('expiry:', d.expiry);
  console.log('host:', d.host);
  console.log('auth present:', !!d.delegationHeader?.Authorization);
"
```

### Step 7 — Run the Phase 7 live delegated scenario

With the delegation file in place, run the automated steps (agent write, cross-client
read, fresh-process restore):

```sh
cd packages/eliza-plugin-memory

TINYCLOUD_LIVE=1 \
DELEGATION_FILE="$(pwd)/.tinycloud/agent-delegation.json" \
TINYCLOUD_AGENT_KEY="<your-agent-hex-key>" \
  bun run test:live:eliza:delegated
```

Or with a key file:

```sh
TINYCLOUD_LIVE=1 \
DELEGATION_FILE="$(pwd)/.tinycloud/agent-delegation.json" \
TINYCLOUD_AGENT_KEY_FILE="$(pwd)/.tinycloud/agent.key" \
  bun run test:live:eliza:delegated
```

A successful run prints `"passed": true` to stdout. Any failure prints `"passed": false`
with per-step details and exits with code 1.

See `docs/openkey-phases/phase-7-runbook.md` for the full Phase 7 runbook including
negative-fixture rejection tests (step 7, automated, runs in default `bun test`).

---

## Security reminders

- `TINYCLOUD_AGENT_KEY` must be a dedicated key for this agent's service identity,
  not your personal wallet or any key that controls other assets.
- Grant ONLY the four listed actions on the specific `dbHandle`. Do not approve
  wildcard handles or broader permission sets.
- `chmod 600` the delegation file — it contains capability material.
- Never print, log, or commit `delegationHeader.Authorization`.
- Do not set `TINYCLOUD_LIVE=1` in CI or default `bun test` — the live scenarios
  are opt-in only.

---

## Dev commands

```sh
bun install          # install dependencies
bun --bun run dev    # start Vite dev server (http://localhost:5173)
bun --bun run build  # production build → dist/
bun --bun run typecheck  # tsc --noEmit
```

---

## See also

- Phase 7 runbook: `docs/openkey-phases/phase-7-runbook.md`
- Consent harness: `packages/eliza-plugin-memory/scripts/consent-harness.ts`
- Live delegated scenario: `packages/eliza-plugin-memory/scripts/live-delegated-scenarios.ts`
- Plugin config / `SETTING_KEYS`: `packages/eliza-plugin-memory/src/config.ts`
- Delegation policy: `packages/agent-client/src/delegation-policy.ts`
- Auth plan: `docs/openkey-auth-plan.md`
- Auth handoff: `docs/openkey-auth-handoff.md`
