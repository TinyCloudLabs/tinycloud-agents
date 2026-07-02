import {
  type TinyCloudWeb,
  type PermissionEntry,
  type PortableDelegation,
  PermissionNotInManifestError,
  serializeDelegation,
} from "@tinycloud/web-sdk";
import { KV_ACTIONS, SQL_ACTIONS, CAPABILITIES_ACTIONS } from "./config";
import { submitDelegation, type Agent, type DelegationStatus, type Signer } from "./api";

// Decode a url-safe base64 string (handles `-`/`_` and missing padding).
// Pure browser-safe JS — no node-only crypto / ethers.
function base64UrlDecode(input: string): string {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// web-sdk 2.3.0 serializes the top-level `actions` summary field lossily —
// it emits only ["tinycloud.capabilities/read"] even though the signed
// delegationHeader.Authorization JWT grants all the SQL actions. Both the
// agent's shallow validator and node-sdk's useDelegation derive grants from
// this top-level `actions` array, so an incomplete list gets rejected as
// "no SQL resource". We recover the true grant set from the JWT's `att`
// claim. `actions` is an UNSIGNED summary field, so rewriting it does NOT
// affect the signature inside delegationHeader.
function actionsFromAuthJwt(authHeader: string): string[] | null {
  try {
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    const att = payload?.att;
    if (!att || typeof att !== "object") return null;
    const actions = new Set<string>();
    for (const resource of Object.values(att)) {
      if (resource && typeof resource === "object") {
        for (const ability of Object.keys(resource)) actions.add(ability);
      }
    }
    return actions.size > 0 ? [...actions] : null;
  } catch {
    return null;
  }
}

export interface MintedDelegation {
  // Serialized portable delegation JSON, ready to POST to the agents API.
  serialized: string;
  delegateDID: string;
  actions: string[];
  // Whether the mint required a prompt. false = the derivable session-key path
  // (caps ⊆ manifest recap, e.g. the default agent, silent); true = the
  // requestPermissions escalation modal fired first (a dynamically-named agent
  // whose caps aren't in the static manifest).
  prompted: boolean;
}

// Delegation scope for an agent, taken verbatim from its AgentView. The service
// chooses these; the client does not derive them. The server validates the
// granted KV prefix == pathPrefix and the granted SQL path == dbHandle exactly.
export interface DelegationScope {
  space: string;
  pathPrefix: string;
  dbHandle: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Mint the option-D multi-resource delegation from the signed-in user to
// `delegateDID` (the agent DID) and return the serialized blob for the caller
// to submit to the API (docs/agents-api.md "Mint shape — MULTI-RESOURCE").
//
// ONE delegation covers three resources in the agent's space:
//   - tinycloud.kv  PREFIX grant on scope.pathPrefix (KV is hierarchical)
//   - tinycloud.sql EXACT  grant on scope.dbHandle    (SQL is exact db-name)
//   - tinycloud.capabilities read
//
// This MUST go through the multi-resource `delegateTo(did, PermissionEntry[])`
// SESSION-KEY UCAN path, not `space().delegations.create({ path })` — the latter
// emits a SINGLE resource and cannot express kv-prefix + sql-exact together, and
// the server fail-closes (missing_kv_resource / wrong_space) on the flat shape.
// `skipPrefix: true` keeps the paths exactly as the AgentView gives them.
//
// IMPORTANT: the multi-resource grant can ONLY be minted via the session-key
// path. delegateTo with `forceWalletSign: true` supports AT MOST ONE
// PermissionEntry (it throws otherwise), so a 3-resource grant must be derivable
// from the session recap. That is exactly why the agent's caps are declared in
// the manifest (manifest.ts): for the DEFAULT agent they are a subset of the
// recap, so delegateTo signs silently with the session key (no prompt).
//
// For an agent whose scope is NOT in the static manifest (a dynamically-named
// one), delegateTo throws PermissionNotInManifestError. We then escalate via
// requestPermissions(missing) — a one-time approval modal (the passkey tap) that
// grants the caps to the current session — and retry the now-derivable mint.
export async function mintDelegation(
  tcw: TinyCloudWeb,
  delegateDID: string,
  scope: DelegationScope
): Promise<MintedDelegation> {
  // No space-creation here: scope.space ("agents") is already provisioned at
  // sign-in by autoCreateSpace. Re-creating it via the session key 401s
  // ("agents/space/agents ... tinycloud.space/create" — the owner's primary
  // space can't be re-created by the session key), so the mint just grants
  // within the existing space.
  const permissions: PermissionEntry[] = [
    {
      service: "tinycloud.kv",
      space: scope.space,
      path: scope.pathPrefix,
      actions: KV_ACTIONS,
      skipPrefix: true,
    },
    {
      service: "tinycloud.sql",
      space: scope.space,
      path: scope.dbHandle,
      actions: SQL_ACTIONS,
      skipPrefix: true,
    },
    {
      service: "tinycloud.capabilities",
      space: scope.space,
      path: "",
      actions: CAPABILITIES_ACTIONS,
      skipPrefix: true,
    },
  ];

  let delegation: PortableDelegation;
  let prompted: boolean;
  try {
    // Derivable path: silent when caps ⊆ manifest recap (the default agent).
    const res = await tcw.delegateTo(delegateDID, permissions, {
      expiry: THIRTY_DAYS_MS,
    });
    delegation = res.delegation;
    prompted = res.prompted;
  } catch (err) {
    if (!(err instanceof PermissionNotInManifestError)) throw err;
    // Not in the static manifest (dynamically-named agent): escalate to grant
    // the missing caps to the session, then retry the derivable mint.
    const grant = await tcw.requestPermissions(err.missing);
    if (!grant.approved) {
      throw new Error("delegation permission request was declined");
    }
    const res = await tcw.delegateTo(delegateDID, permissions, {
      expiry: THIRTY_DAYS_MS,
    });
    delegation = res.delegation;
    prompted = true; // the escalation modal was shown
  }

  // delegateTo returns a PortableDelegation with a populated `resources[]`
  // (per-resource service/space/path/actions) — exactly what the server's
  // multi-resource validator reads. Serialize it as-is.
  //
  // The top-level `actions` summary is a lossy single-resource mirror (web-sdk
  // 2.3.0); the server reads `resources[]`, not this field, but we still
  // rewrite it from the signed JWT `att` claim so the flat mirror is faithful.
  // Only the UNSIGNED `actions` field is touched — the signature is untouched.
  const serialized = serializeDelegation(delegation);
  const parsed = JSON.parse(serialized);
  const authHeader = parsed?.delegationHeader?.Authorization ?? "";
  const allActions = [...KV_ACTIONS, ...SQL_ACTIONS, ...CAPABILITIES_ACTIONS];
  const completedActions = actionsFromAuthJwt(authHeader) ?? allActions;
  parsed.actions = completedActions;

  return {
    serialized: JSON.stringify(parsed),
    delegateDID: delegation.delegateDID,
    actions: completedActions,
    prompted,
  };
}

// Mint the delegation for `agent` and register it with the service. Shared by
// the sign-in auto-provision bootstrap and the per-agent Delegate button.
// Returns the resulting delegation status.
export async function delegateAgent(
  tcw: TinyCloudWeb,
  signer: Signer,
  agent: Agent
): Promise<DelegationStatus> {
  const minted = await mintDelegation(tcw, agent.agentDid, {
    space: agent.space,
    pathPrefix: agent.pathPrefix,
    dbHandle: agent.dbHandle,
  });
  const res = await submitDelegation(signer, agent.agentId, minted.serialized);
  return res.status;
}
