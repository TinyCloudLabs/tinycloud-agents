# Phase 6: Consent Harness — Manual Runbook

**Scope:** This runbook covers the two live human gates in Phase 6
(`phase6-manual-openkey-signin` and `phase6-manual-browser-delegation`). Everything
before these gates — the shared policy module, the harness script, and the unit
tests — is automatable and runs in CI. Everything after (booting Eliza in
delegated mode) is Phase 3/5 activation work that is not yet wired. These two
gates are the only steps that require a human with a passkey.

**Placement in the sequence:** Run the steps in this runbook AFTER all automatable
Phase-6 tasks are green (`bun --bun run build && typecheck && test`) and BEFORE
Phase 7's live delegated-SQL flow.

---

## Prerequisites

- `packages/eliza-plugin-memory` builds and its tests pass (`bun --bun run test`
  from that package).
- You have `bun` available (`bun --version`).
- You have a trusted HTTPS origin for OpenKey (see [§3 Trusted Origin](#3-trusted-origin-requirement)).

---

## Step 1 — Generate or choose a dedicated agent key

The agent identity key is **not the user's wallet or main private key**. It belongs
to the agent and is used solely to derive a stable DID that the user can delegate
memory access to. Treat it as service-identity material: stable within a deployment,
rotatable by re-delegating.

> **Critical:** never paste your main wallet key here. A separate low-value key limits
> blast radius to this agent's TinyCloud memory space.

Generate a fresh throwaway key (32 bytes of hex):

```sh
# Option A — openssl
openssl rand -hex 32

# Option B — node
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then store it in exactly **one** of these two ways (not both):

**Inline env var:**
```sh
export TINYCLOUD_AGENT_KEY="<your 64-char hex key>"
```

**Key file (preferred for persistent deployments):**
```sh
echo -n "<your 64-char hex key>" > .tinycloud/agent.key
chmod 600 .tinycloud/agent.key
export TINYCLOUD_AGENT_KEY_FILE="$(pwd)/.tinycloud/agent.key"
```

> **DID stability:** once you delegate to the DID derived from this key, the key is
> frozen for the lifetime of that delegation. Regenerating the key changes the DID,
> which makes the existing delegation invalid. If you need to rotate, generate a
> new key, run the harness again, and re-delegate from scratch.

---

## Step 2 — Run the consent harness

From `packages/eliza-plugin-memory`:

```sh
bun --bun run consent:harness
```

The harness is **fully offline** — it never calls `useDelegation` or touches the
network. It derives the agent DID from your key using the same Phase-2
`agentIdentityFromKey`/`agentIdentityFromFile` helper that the runtime activates
with, so the advertised DID equals the runtime DID.

Optional env overrides (all have defaults):

| Variable | Default | Purpose |
| --- | --- | --- |
| `TINYCLOUD_HOST` | `https://node.tinycloud.xyz` | TinyCloud node endpoint |
| `TINYCLOUD_DB_HANDLE` | `xyz.tinycloud.eliza/memory` | SQL db handle for the memory space |
| `TINYCLOUD_DELEGATION_FILE` | `./.tinycloud/agent-delegation.json` | Where to write the delegation |
| `OPENKEY_DELEGATE_URL` | `https://openkey.tinycloud.xyz/delegate` | Base for the delegate page URL |

The harness prints a human-readable block followed by a JSON object. Note these
fields — you will need them in the next steps:

| Field | What it is |
| --- | --- |
| `agentDid` | The stable `did:pkh:eip155:1:0x…` that the delegation must target |
| `permissions` | The exact permission payload the user must approve (Phase-4 policy) |
| `policyHash` | Stable hash over `permissions` + `agentDid` — used later for stale-policy detection |
| `delegationFilePath` | Absolute path where Eliza expects the delegation file |
| `openKeyDelegateUrl` | Pre-filled OpenKey delegate URL with your DID, host, permissions, and expiry |

JSON-only mode (for scripts):
```sh
bun --bun run consent:harness -- --json
```

---

## Step 3 — [MANUAL GATE: phase6-manual-openkey-signin, LIVE]

**This step requires a human.** A worker agent cannot perform WebAuthn/passkey
authentication. Open the `openKeyDelegateUrl` printed by the harness in a browser
and sign in with your passkey.

```
<openKeyDelegateUrl from harness output>
```

### Trusted origin requirement

WebAuthn passkeys are **origin-bound**. A certificate warning (untrusted HTTPS)
or an origin mismatch will silently break the passkey flow. Use one of:

- **Production/staging:** `https://openkey.tinycloud.xyz/delegate` (default)
- **Local dev with trusted HTTPS:** `https://openkey.localhost/delegate`
  (requires a locally-trusted TLS cert — `mkcert` or equivalent; `bun dev:portless`
  in the OpenKey repo sets this up)
- **http://localhost** only if OpenKey is configured to accept it as a valid RP origin

A plain `https://localhost` with a self-signed cert will fail passkey creation
silently.

**Expected outcome:** you reach the delegate consent screen showing your user
identity and the requested permissions for the agent DID.

---

## Step 4 — [MANUAL GATE: phase6-manual-browser-delegation, LIVE]

**This step requires a human.** After signing in, the browser/TinyCloudWeb shows
the delegation approval screen. Before approving:

1. Confirm the **delegatee DID** shown matches the `agentDid` from the harness.
2. Confirm the **permissions** shown match the `permissions` field from the harness
   JSON. The canonical permission set is:
   - `tinycloud.sql` on `<dbHandle>`: read, write, admin
   - `tinycloud.capabilities`: read
3. Approve. The browser creates a delegation to `agentDid` scoped to your
   TinyCloud memory space.
4. Copy the full serialized delegation (the paste-code shown by the delegate page).

**Write the delegation to the file path printed by the harness:**

```sh
# Paste the serialized delegation when prompted:
cat > "$(cat /dev/stdin)" << 'EOF'
<paste serialized delegation here>
EOF
# Or write it directly:
echo '<serialized delegation>' > /absolute/path/to/.tinycloud/agent-delegation.json
```

Or export it inline (for ephemeral use):

```sh
export TINYCLOUD_DELEGATION='<serialized delegation>'
```

> **Write the full payload.** The serialized delegation must be the complete
> portable delegation object, not a truncated paste-code fragment. If the
> delegate page shows a download option, prefer that over copy-paste.

> **File permissions:** restrict access to the delegation file —
> `chmod 600 .tinycloud/agent-delegation.json`. The file contains
> capability material that grants the agent SQL access to your memory space.

---

## Step 5 — Boot Eliza in delegated mode

Once the delegation file is in place, boot Eliza with:

```sh
TINYCLOUD_AUTH_MODE=delegation \
TINYCLOUD_AGENT_KEY_FILE=.tinycloud/agent.key \       # or TINYCLOUD_AGENT_KEY
TINYCLOUD_DELEGATION_FILE=.tinycloud/agent-delegation.json \
bun --bun run start  # or however you launch Eliza
```

> **Same key as step 1.** `TINYCLOUD_AGENT_KEY[_FILE]` must point to the same
> key you used in step 2. The runtime derives the agent DID from this key and
> checks it against the `delegateDID` in the delegation file. A mismatch causes
> activation to reject the delegation.

### Verify DID parity

The agent DID Eliza activates with must equal the `agentDid` the harness printed.
Look for a startup log line like:

```
[TinyCloud] delegated mode: activating with agentDid=did:pkh:eip155:1:0x...
```

Confirm it matches. If it does not, you either used a different key or regenerated
the key after delegating — repeat from step 1.

> **Activation note:** Delegated SQL activation is Phase 3/5 work and may not be
> fully wired until those phases land. Until then, Eliza will parse and validate
> the delegation config but may still hit an "not yet implemented" guard on first
> delegated SQL call. The harness output and the delegation file are valid inputs
> regardless; Phase 3/5 completion unlocks the live read/write path.

---

## Summary — what each step produces

| Step | Actor | Output |
| --- | --- | --- |
| 1. Generate agent key | Human (once per deployment) | Stable `TINYCLOUD_AGENT_KEY[_FILE]` |
| 2. Run consent harness | Automated (offline) | `agentDid`, `permissions`, `policyHash`, `delegationFilePath`, `openKeyDelegateUrl` |
| 3. Sign in with passkey | **Human (LIVE)** | Browser session on OpenKey delegate page |
| 4. Approve delegation | **Human (LIVE)** | Serialized delegation written to `delegationFilePath` |
| 5. Boot Eliza | Human / CI | Agent activates with `agentDid` matching delegation |

Steps 3 and 4 are **out-of-band** — they are not automatable (WebAuthn cannot be
performed by a worker agent) and are not gated by CI. They happen after all
automatable Phase-6 tasks pass and before Phase 7's live delegated-SQL flow.

---

## Common pitfalls

| Pitfall | Consequence | Fix |
| --- | --- | --- |
| Pasting the user's main wallet key as `TINYCLOUD_AGENT_KEY` | User's wallet DID is used as the agent identity | Use a **separate, dedicated** key for the agent |
| Regenerating the agent key after delegating | DID changes → delegation no longer matches | Keep the key stable; re-delegate if rotation is needed |
| Untrusted HTTPS cert on the OpenKey origin | WebAuthn fails silently or with a vague error | Use a trusted cert (`mkcert`) or `http://localhost` |
| Writing a truncated paste-code instead of the full serialized delegation | Delegation parse error on Eliza boot | Use the delegate page's download button or copy the full payload |
| Setting both `TINYCLOUD_AGENT_KEY` and `TINYCLOUD_AGENT_KEY_FILE` | Harness refuses with a conflict error | Set exactly one |
| Using a different key in Eliza than in the harness | DID mismatch; delegation rejected | Confirm both steps reference the same key file |
| Expecting live SQL reads/writes before Phase 3/5 land | "Not yet implemented" error on first query | Phases 3/5 wire delegated SQL activation; harness and delegation are correct inputs |

---

## Terminology

- **space** — a user's TinyCloud data container; the memory space is user-owned in
  delegated mode. Do not use "orbit" or "namespace".
- **delegation** — a portable signed capability that grants the agent DID SQL
  access to the user's memory space for the duration of the expiry.
- **agentDid** — the stable `did:pkh:eip155:1:0x…` address derived from the agent
  identity key; the delegation target. Distinct from the user's DID and from any
  ephemeral runtime session key.
- **policyHash** — a deterministic hash over the canonical permission set and
  `agentDid`; used by Phase 4's validator for stale-policy detection.

---

## See also

- Phase 6 implementation plan: `docs/openkey-phases/phase-6-consent-harness-plan.md`
- Cross-phase cohesion (§2.1 shared policy module, §4 manual gates):
  `docs/openkey-phases/PHASE-SYNTHESIS.md`
- Auth plan: `docs/openkey-auth-plan.md`
- Harness script: `packages/eliza-plugin-memory/scripts/consent-harness.ts`
- Policy source: `packages/agent-client/src/delegation-policy.ts`
  (`defaultElizaMemoryPolicy`, `computePolicyHash`)
- Plugin README (delegated mode config):
  `packages/eliza-plugin-memory/README.md`
