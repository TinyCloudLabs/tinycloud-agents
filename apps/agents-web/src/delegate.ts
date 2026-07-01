import {
  type TinyCloudWeb,
  type Delegation,
  type PortableDelegation,
  serializeDelegation,
} from "@tinycloud/web-sdk";
import { TINYCLOUD_HOST } from "./tinycloud";
import { AGENTS_SPACE, SQL_ACTIONS, memoryPath } from "./config";

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

function toPortableDelegation(
  delegation: Delegation,
  ownerAddress: string,
  chainId: number,
  host: string
): PortableDelegation {
  // PortableDelegation omits isRevoked; destructure it out before spreading
  const { isRevoked: _omitted, ...rest } = delegation;
  return {
    ...rest,
    delegationHeader: {
      Authorization: delegation.authHeader || `Bearer ${delegation.cid}`,
    },
    ownerAddress,
    chainId,
    host,
  };
}

export interface MintedDelegation {
  // Serialized portable delegation JSON, ready to POST to the agents API.
  serialized: string;
  delegateDID: string;
  actions: string[];
}

// Ensure the given space exists before minting against it.
// `space.delegations.create()` requires the space to already exist on the host.
async function ensureSpace(tcw: TinyCloudWeb, spaceName: string): Promise<void> {
  const exists = await tcw.spaces.exists(spaceName);
  if (exists.ok && exists.data) return;
  const created = await tcw.spaces.create(spaceName);
  if (!created.ok) {
    throw new Error(`failed to create "${spaceName}" space: ${created.error.message}`);
  }
}

// Delegation scope for an agent. The service chooses `space` and `pathPrefix`
// and returns them on the agent record; the client threads them verbatim. The
// defaults are pre-contract stubs only (see config.ts).
export interface DelegationScope {
  space?: string;
  pathPrefix?: string;
}

// Mint an SQL delegation from the signed-in user to `delegateDID` (the agent
// DID). Ported from tools/delegate-ui/src/delegate.ts, minus the download/DOM
// bits — returns the serialized blob for the caller to submit to the API.
//
// Per the design change: the delegation is scoped to the user's canonical
// "agents" space at the agent's memory path (default agent -> "default/"
// prefix), not the "default" space at xyz.tinycloud.eliza/memory. The concrete
// space/prefix come from the agent record; the config values are fallbacks.
export async function mintDelegation(
  tcw: TinyCloudWeb,
  delegateDID: string,
  scope: DelegationScope = {}
): Promise<MintedDelegation> {
  const spaceName = scope.space ?? AGENTS_SPACE;
  await ensureSpace(tcw, spaceName);

  const space = tcw.space(spaceName);
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const result = await space.delegations.create({
    delegateDID,
    path: memoryPath(scope.pathPrefix),
    actions: SQL_ACTIONS,
    expiry,
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  const delegation = result.data;
  const ownerAddress = tcw.address() ?? "";
  const chainId = tcw.chainId() ?? 1;
  const portableDelegation = toPortableDelegation(
    delegation,
    ownerAddress,
    chainId,
    TINYCLOUD_HOST
  );

  // Complete the lossy top-level `actions` summary so it faithfully reflects
  // the grants actually signed into delegationHeader.Authorization. Prefer
  // deriving from the JWT; fall back to the requested SQL_ACTIONS. Only the
  // unsigned `actions` field is touched — the signature is untouched.
  const serialized = serializeDelegation(portableDelegation);
  const parsed = JSON.parse(serialized);
  const authHeader = parsed?.delegationHeader?.Authorization ?? "";
  const completedActions = actionsFromAuthJwt(authHeader) ?? SQL_ACTIONS;
  parsed.actions = completedActions;

  return {
    serialized: JSON.stringify(parsed),
    delegateDID: delegation.delegateDID,
    actions: completedActions,
  };
}
