# Phase 7: Live Delegated Scenario — Manual Runbook (Steps 1–3)

**Scope:** This runbook covers the three MANUAL human gates that precede the
automatable Phase 7 acceptance flow. Steps 4–6 (agent write, cross-client read,
fresh-process restore) are automated and run via `test:live:eliza:delegated` once
these steps produce a delegation file. Step 7 (negative-fixture rejection tests) runs
in the default `bun test` without any manual steps.

**Why automation is deferred for steps 1–3:**

- **Step 1 (OpenKey/passkey sign-in):** WebAuthn passkeys are hardware-bound and
  origin-gated. A worker agent cannot click the browser credential prompt or satisfy
  a biometric/security-key challenge. No automation is possible.
- **Step 2 (TinyCloud session):** The session is authenticated by the user's signed
  consent from step 1. It depends on a live human presence.
- **Step 3 (delegation creation):** A delegation is a signed capability asserting the
  user's consent to grant the agent SQL access to their memory space. Real delegations
  require the human's cryptographic signature — a worker cannot forge one and must not
  do so.

**Placement in the sequence:** Run these steps AFTER all automatable Phase-7 scaffolding
tasks are green (`bun --bun run build && bun --bun run typecheck && bun --bun run test`)
and AFTER the Phase-6 manual gates have been completed at least once (so you already
have a stable agent key). If the Phase-6 consent-harness output is still available, it
contains the exact `agentDid`, `permissions`, and `delegationFilePath` needed here —
re-use it rather than re-running the harness from scratch.

---

## Prerequisites

- `bun` available (`bun --version`).
- Automatable Phase-7 tasks green (`bun --bun run build && bun --bun run typecheck && bun --bun run test` from repo root, or from `packages/eliza-plugin-memory`).
- A **dedicated agent key** (`TINYCLOUD_AGENT_KEY` or `TINYCLOUD_AGENT_KEY_FILE`) that
  you previously used for Phase-6, OR a new key generated using the instructions in
  [§1 below](#step-1-manual-print-the-agent-surface). If you already completed Phase-6
  step 1, skip step 1A here and use the same key.
- A browser that supports WebAuthn/passkeys (Chrome, Firefox, Safari, Edge — all work
  on desktop with a platform authenticator or a security key).
- A trusted HTTPS origin for OpenKey (see [§WebAuthn origin pitfalls](#webauthn-origin-pitfalls)).

---

## Step 1 [MANUAL] — Print the stable agent surface

**This step is MANUAL** because the consent-harness tool is offline and non-interactive,
but a human must review the output before presenting it to OpenKey.

### Step 1A — Ensure you have a stable agent key (skip if you completed Phase-6 step 1)

> **Critical:** never use the operator's main wallet key as the agent key. The agent
> key is a dedicated service-identity credential. Its blast radius is limited to the
> agent's TinyCloud memory space; your main wallet controls far more.

Generate a fresh 32-byte hex key if you do not already have one:

```sh
# Option A — openssl
openssl rand -hex 32

# Option B — node
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store in exactly **one** of these two forms (not both — the plugin rejects the conflict):

```sh
# Inline (short-lived environments):
export TINYCLOUD_AGENT_KEY="<64-char hex>"

# File (preferred for persistent deployments):
mkdir -p .tinycloud
echo -n "<64-char hex>" > .tinycloud/agent.key
chmod 600 .tinycloud/agent.key
export TINYCLOUD_AGENT_KEY_FILE="$(pwd)/.tinycloud/agent.key"
```

Env var names match the plugin's `SETTING_KEYS`: `TINYCLOUD_AGENT_KEY` and
`TINYCLOUD_AGENT_KEY_FILE`.

> **DID stability:** the delegation targets the `did:pkh:eip155:1:{address}` derived
> from this key. If you regenerate the key, the DID changes and any existing delegation
> becomes invalid. Keep the key frozen for the lifetime of the delegation; re-delegate
> when you rotate.

### Step 1B — Run the consent harness to print the agent surface

If the Phase-6 consent-harness output is still available in your terminal, you already
have all the values below — skip to [step 2](#step-2-manual-sign-in-with-openkey-and-create-a-tinycloud-session).

Otherwise, run the harness from `packages/eliza-plugin-memory`:

```sh
# With key inline:
TINYCLOUD_AGENT_KEY="$TINYCLOUD_AGENT_KEY" \
  bun --bun run consent:harness

# With key file:
TINYCLOUD_AGENT_KEY_FILE="$TINYCLOUD_AGENT_KEY_FILE" \
  bun --bun run consent:harness
```

Optional env overrides (all have sensible defaults):

| Variable | Default | Purpose |
| --- | --- | --- |
| `TINYCLOUD_HOST` | `https://node.tinycloud.xyz` | TinyCloud node endpoint |
| `TINYCLOUD_DB_HANDLE` | `xyz.tinycloud.eliza/memory` | SQL db handle (memory space) |
| `TINYCLOUD_DELEGATION_FILE` | `./.tinycloud/agent-delegation.json` | Path the live scenario reads |
| `OPENKEY_DELEGATE_URL` | `https://openkey.tinycloud.xyz/delegate` | Base URL for the OpenKey delegate page |

The harness prints a human-readable summary followed by a JSON block. Note these
fields — you will use them in steps 2 and 3:

| Field | What it is |
| --- | --- |
| `agentDid` | The stable `did:pkh:eip155:1:0x…` the delegation MUST target |
| `permissions` | The exact permission set the user must approve (Phase-4 canonical policy) |
| `host` | TinyCloud node endpoint the delegation is scoped to |
| `dbHandle` | SQL handle — must be `xyz.tinycloud.eliza/memory` (the `TINYCLOUD_DB_HANDLE` value) |
| `policyHash` | Stable hash for drift detection (informational here; Phase-4 validator uses it) |
| `delegationFilePath` | Absolute path where the live scenario (`test:live:eliza:delegated`) reads the delegation |
| `openKeyDelegateUrl` | Pre-filled URL to open in the browser — brings you to the OpenKey consent screen |

JSON-only mode (for scripted capture):

```sh
TINYCLOUD_AGENT_KEY="$TINYCLOUD_AGENT_KEY" \
  bun --bun run consent:harness -- --json > /tmp/consent-report.json
```

The canonical permission set that the delegation must grant is:

```json
{
  "resource": "xyz.tinycloud.eliza/memory",
  "actions": ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
  "optional": ["tinycloud.capabilities/read"]
}
```

This comes from `defaultElizaMemoryPolicy(dbHandle)` in
`packages/agent-client/src/delegation-policy.ts`. Do **not** widen it — the Phase-4
validator and the live scenario only require these capabilities, and broader grants
are a security anti-pattern.

---

## Step 2 [MANUAL] — Sign in with OpenKey and create or restore a TinyCloud session

**This step is MANUAL** because WebAuthn cannot be performed by an automated worker.

### Step 2A — Start OpenKey locally (local dev only; skip for production/staging)

If you are working against the production OpenKey (`https://openkey.tinycloud.xyz`),
open the `openKeyDelegateUrl` from step 1 directly and skip to step 2B.

For local OpenKey development:

```sh
# Standard local dev (port 3000 or configured port):
cd /path/to/openkey-repo
bun dev

# Portless / trusted-HTTPS local dev (recommended for passkey testing):
bun dev:portless
```

See [§WebAuthn origin pitfalls](#webauthn-origin-pitfalls) before starting — the
origin must be trusted for passkeys to work.

### Step 2B — Sign in with passkey via OpenKey

Open the `openKeyDelegateUrl` printed by the consent harness in a browser:

```
<paste openKeyDelegateUrl from consent-harness output here>
```

This URL is pre-filled with `did=<agentDid>`, `host=<host>`, `permissions=<permissions>`,
and `expiry=<ISO>`. OpenKey reads these parameters to pre-populate the delegation
approval form.

Sign in using your passkey or WebAuthn credential when prompted. This call corresponds
to the web-sdk's `TinyCloudWeb.signIn()` method — the OpenKey UI invokes it on your
behalf after you approve.

### Step 2C — Verify or restore an existing TinyCloud session

If OpenKey presents a "restore session" option, confirm that the displayed session
belongs to your TinyCloud space (the user identity that should own the memory space).
This corresponds to the web-sdk's `TinyCloudWeb.restoreSession()` path.

If no active session exists, the sign-in step (2B) creates a new one. You do not
need to manage session keys directly — the OpenKey UI handles this.

**Expected outcome:** you land on the delegate consent screen showing your user
identity, the `agentDid` as the delegatee, and the requested `permissions`. Proceed
to step 3.

---

## Step 3 [MANUAL] — Create the delegation and write it to `DELEGATION_FILE`

**This step is MANUAL** because the delegation is a signed consent that requires the
human's authenticated browser session. No worker can produce it.

### Step 3A — Verify the delegation details before approving

Before clicking "Approve" or "Delegate":

1. **Delegatee DID:** confirm the DID shown matches the `agentDid` printed by the
   consent harness exactly (character-for-character). A mismatch means the wrong
   agent will receive access.
2. **Permissions:** confirm the permissions shown are ONLY:
   - `tinycloud.sql/read`, `tinycloud.sql/write`, `tinycloud.sql/admin` on
     `xyz.tinycloud.eliza/memory` (or the value of `TINYCLOUD_DB_HANDLE` if overridden)
   - `tinycloud.capabilities/read` (optional — may or may not appear)
   Do NOT approve if broader permissions are listed (e.g. `tinycloud.sql` on `*` or
   any non-memory handle).
3. **Host:** confirm the host shown matches the `TINYCLOUD_HOST` value (default:
   `https://node.tinycloud.xyz`).
4. **Expiry:** note the expiry. Default is 30 days from the harness run. If the
   delegation will expire before your testing is complete, set a longer expiry by
   overriding `CONSENT_EXPIRY_ISO` before re-running the harness.

### Step 3B — Approve and capture the serialized delegation

Approve the delegation in the browser. OpenKey will:

1. Call `TinyCloudWeb.createDelegation(agentDid, permissions, expiry)` (or equivalent)
   using your authenticated session.
2. Display or offer to download the **serialized portable delegation** — a JSON object
   with fields including `delegationHeader`, `ownerAddress`, `chainId`, `host`, `expiry`,
   the delegate DID, resources/capabilities, and a `cid`.

> **Write the FULL payload.** The serialized delegation is the complete JSON object,
> not a truncated paste-code or QR-code fragment. If the delegate page offers a
> download button, prefer it over copy-paste to avoid truncation.

### Step 3C — Write the delegation to `DELEGATION_FILE`

Write the full serialized delegation to the path that the live scenario will read.
Use the `delegationFilePath` from the consent-harness output (default:
`.tinycloud/agent-delegation.json`):

```sh
# Confirm the target path:
echo "$DELEGATION_FILE"
# If unset, use the consent-harness delegationFilePath value:
DELEGATION_FILE=".tinycloud/agent-delegation.json"   # adjust to your path

mkdir -p "$(dirname "$DELEGATION_FILE")"

# Paste the serialized delegation (JSON) when prompted:
cat > "$DELEGATION_FILE"
# (paste, then Ctrl+D to close stdin)

# OR write it directly if you have it in a variable:
printf '%s\n' "$SERIALIZED_DELEGATION" > "$DELEGATION_FILE"

# OR if the delegate page offered a download:
mv ~/Downloads/delegation-*.json "$DELEGATION_FILE"

# Restrict file permissions — the file grants SQL access to the memory space:
chmod 600 "$DELEGATION_FILE"
```

The scenario accepts the file path via either `DELEGATION_FILE` or
`TINYCLOUD_DELEGATION_FILE` (both are checked; `DELEGATION_FILE` takes precedence as
the scenario-local alias). The plugin config reads it via the `SETTING_KEYS.delegationFile`
key (`TINYCLOUD_DELEGATION_FILE`).

### Step 3D — Quick sanity check (no network)

Verify the file is valid JSON and contains the expected fields:

```sh
# Must parse as JSON and contain the delegatee DID:
node -e "
  const d = JSON.parse(require('fs').readFileSync('$DELEGATION_FILE', 'utf-8'));
  console.log('delegate DID:', d.delegateDid || d.delegate?.did || '(check field name)');
  console.log('expiry:', d.expiry);
  console.log('host:', d.host);
  // Must NOT print the Authorization header value to the terminal:
  console.log('auth present:', !!d.delegationHeader?.Authorization);
"
```

> **Never print the `delegationHeader.Authorization` value.** It is capability
> material. The check above only prints whether the field exists (a boolean), not its
> value.

---

## Handoff to the automatable scenario

Once the delegation file is in place, the remaining steps (4–6: agent write, cross-client
read, fresh-process restore) are automated:

```sh
TINYCLOUD_LIVE=1 \
DELEGATION_FILE="$DELEGATION_FILE" \
TINYCLOUD_AGENT_KEY="$TINYCLOUD_AGENT_KEY" \       # or TINYCLOUD_AGENT_KEY_FILE
TINYCLOUD_HOST="https://node.tinycloud.xyz" \      # omit if using the default
TINYCLOUD_DB_HANDLE="xyz.tinycloud.eliza/memory" \ # omit if using the default
  bun run test:live:eliza:delegated
```

Or with a key file:

```sh
TINYCLOUD_LIVE=1 \
DELEGATION_FILE="$DELEGATION_FILE" \
TINYCLOUD_AGENT_KEY_FILE="$TINYCLOUD_AGENT_KEY_FILE" \
  bun run test:live:eliza:delegated
```

The scenario (`packages/eliza-plugin-memory/scripts/live-delegated-scenarios.ts`)
will print a JSON object to stdout. A successful run ends with `"passed": true`. Any
failure prints `"passed": false` with per-step details and exits with code 1.

The existing private-key scenario is **untouched** and continues to run separately:

```sh
TINYCLOUD_LIVE=1 bun run test:live:eliza
```

Never set `TINYCLOUD_LIVE=1` in CI or in default `bun test` — the scenarios are
opt-in only.

---

## WebAuthn origin pitfalls

WebAuthn passkeys are **origin-bound**. The credential is only available on the exact
origin (scheme + host + port) it was created on. A mismatch, an untrusted certificate,
or a certificate warning will silently block sign-in.

| Environment | Recommended origin | Setup |
| --- | --- | --- |
| Production / staging | `https://openkey.tinycloud.xyz` | No setup; use this unless developing OpenKey locally |
| Local dev with trusted HTTPS | `https://openkey.localhost` | Run `bun dev:portless` in the OpenKey repo; use `mkcert` to create a locally-trusted cert for `openkey.localhost` |
| Local dev, plain HTTP | `http://localhost` | Only works if OpenKey is configured to accept `http://localhost` as a valid WebAuthn RP origin; may require setting `OPENKEY_RP_ORIGIN=http://localhost` |

**What NOT to use:**
- `https://localhost` with a self-signed cert — browsers distrust it and WebAuthn
  fails silently or with a vague `NotAllowedError`.
- Any origin that differs from the origin where the passkey was originally registered.

If you see `NotAllowedError: The operation either timed out or was not allowed.`, the
most common cause is an origin mismatch or untrusted certificate. Run
`bun dev:portless` in the OpenKey repo and use the `openkey.localhost` origin instead.

---

## Security reminders

- **Never the user's main key.** `TINYCLOUD_AGENT_KEY` must be a dedicated key for
  this agent's service identity — not your personal wallet or any key that controls
  other assets. The agent key grants the ability to use whatever delegations the user
  issues to the derived DID; a broad delegation would let the agent access more than
  intended.
- **Scope the delegation narrowly.** Grant ONLY `tinycloud.sql/read|write|admin` on
  `xyz.tinycloud.eliza/memory` (plus optional `tinycloud.capabilities/read`). Do not
  approve broader handles or wildcard policies — the Phase-4 validator will reject
  insufficient-scope delegations, but you should catch over-broad ones at the approval
  step.
- **Restrict file permissions.** `chmod 600 "$DELEGATION_FILE"`. The delegation file
  contains capability material.
- **The `delegationHeader.Authorization` value is a secret.** Never log it, paste it
  into docs or test assertions, or commit it. Negative-fixture test files use scrubbed
  placeholders, not real Authorization values.

---

## Environment variable reference

All env var names used in this runbook are drawn verbatim from the plugin's
`SETTING_KEYS` in `packages/eliza-plugin-memory/src/config.ts`:

| Variable | `SETTING_KEYS` field | Purpose |
| --- | --- | --- |
| `TINYCLOUD_AUTH_MODE` | `authMode` | Must be `"delegation"` in delegated mode |
| `TINYCLOUD_AGENT_KEY` | `agentKey` | Inline stable agent identity key (hex) |
| `TINYCLOUD_AGENT_KEY_FILE` | `agentKeyFile` | File path for stable agent identity key |
| `TINYCLOUD_DELEGATION_FILE` | `delegationFile` | Path to the delegation JSON file |
| `TINYCLOUD_DELEGATION` | `delegation` | Inline serialized delegation (alternative to file) |
| `TINYCLOUD_HOST` | `host` | TinyCloud node endpoint |
| `TINYCLOUD_DB_HANDLE` | `dbHandle` | SQL db handle (default: `xyz.tinycloud.eliza/memory`) |

The scenario also reads `DELEGATION_FILE` as a scenario-local alias for
`TINYCLOUD_DELEGATION_FILE`. Both are accepted; `DELEGATION_FILE` takes precedence
in the scenario script.

`TINYCLOUD_LIVE=1` is the master gate for both the private-key and delegated live
scenarios. It is NOT a plugin setting and is never read by the plugin itself — it is
read by the scenario runner before any plugin code runs.

---

## Step summary

| Step | Actor | Mode | Output |
| --- | --- | --- | --- |
| 1A. Generate agent key | Human (once per deployment) | Offline | `TINYCLOUD_AGENT_KEY[_FILE]` |
| 1B. Run consent harness | Automated (offline) | Offline | `agentDid`, `permissions`, `host`, `dbHandle`, `delegationFilePath`, `openKeyDelegateUrl` |
| 2. Sign in with OpenKey/passkey | **Human (LIVE)** | Browser | Authenticated session on the OpenKey delegate page |
| 3. Approve delegation + write file | **Human (LIVE)** | Browser + shell | `$DELEGATION_FILE` written with the serialized portable delegation |
| 4–6. Agent write/read/restore | Automated (`TINYCLOUD_LIVE=1`) | Gated live | `{"passed":true}` from `test:live:eliza:delegated` |
| 7. Negative fixture rejection | Automated | Default `bun test` | Three rejection cases green in CI |

Steps 2–3 are **human-only** and **out-of-band** from CI. Everything else is
automatable.

---

## See also

- Phase 7 implementation plan: `docs/openkey-phases/phase-7-live-scenario-plan.md`
- Phase 6 manual runbook (OpenKey consent for Eliza boot):
  `docs/openkey-phases/phase-6-consent-runbook.md`
- Cross-phase cohesion (§4 manual gates):
  `docs/openkey-phases/PHASE-SYNTHESIS.md`
- Auth plan: `docs/openkey-auth-plan.md`
- Auth handoff: `docs/openkey-auth-handoff.md`
- Consent harness: `packages/eliza-plugin-memory/scripts/consent-harness.ts`
- Plugin config / `SETTING_KEYS`:
  `packages/eliza-plugin-memory/src/config.ts`
- Policy source (`defaultElizaMemoryPolicy`, `computePolicyHash`):
  `packages/agent-client/src/delegation-policy.ts`
- Live delegated scenario (automatable steps 4–6):
  `packages/eliza-plugin-memory/scripts/live-delegated-scenarios.ts`
