import {
  TinyCloudWeb,
  type Delegation,
  type PortableDelegation,
  serializeDelegation,
} from "@tinycloud/web-sdk";

const SQL_ACTIONS = [
  "tinycloud.sql/read",
  "tinycloud.sql/write",
  "tinycloud.sql/admin",
  "tinycloud.capabilities/read",
];

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

export function renderDelegationUI(
  tcw: TinyCloudWeb,
  container: HTMLElement,
  delegateDID: string,
  dbHandle: string,
  host: string
): void {
  container.innerHTML = `
    <hr style="margin:24px 0;" />
    <h2>Create Delegation</h2>
    <table style="border-collapse:collapse; margin-bottom:16px;">
      <tr><td style="padding:4px 8px; font-weight:bold;">Delegate DID</td><td><code>${escapeHtml(delegateDID)}</code></td></tr>
      <tr><td style="padding:4px 8px; font-weight:bold;">Path</td><td><code>${escapeHtml(dbHandle)}</code></td></tr>
      <tr><td style="padding:4px 8px; font-weight:bold;">Actions</td><td><code>${SQL_ACTIONS.map(escapeHtml).join(", ")}</code></td></tr>
      <tr><td style="padding:4px 8px; font-weight:bold;">Expiry</td><td>30 days from now</td></tr>
    </table>
    <button id="delegateBtn">Create Delegation</button>
    <div id="delegateStatus" style="margin-top:16px; font-size:14px;"></div>
  `;

  document.getElementById("delegateBtn")!.addEventListener("click", async () => {
    const statusEl = document.getElementById("delegateStatus")!;
    const btn = document.getElementById("delegateBtn") as HTMLButtonElement;

    btn.disabled = true;
    statusEl.textContent = "Creating delegation...";

    try {
      const space = tcw.space("default");
      const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const result = await space.delegations.create({
        delegateDID,
        path: dbHandle,
        actions: SQL_ACTIONS,
        expiry,
      });

      if (!result.ok) {
        statusEl.innerHTML = `<span style="color:red">Error: ${escapeHtml(result.error.message)}</span>`;
        btn.disabled = false;
        return;
      }

      const delegation = result.data;
      const ownerAddress = tcw.address() ?? "";
      const chainId = tcw.chainId() ?? 1;
      const portableDelegation = toPortableDelegation(delegation, ownerAddress, chainId, host);

      // Complete the lossy top-level `actions` summary so it faithfully
      // reflects the grants actually signed into delegationHeader.Authorization.
      // Prefer deriving from the JWT; fall back to the requested SQL_ACTIONS.
      // Only the unsigned `actions` field is touched — the signature is untouched.
      const serialized = serializeDelegation(portableDelegation);
      const parsed = JSON.parse(serialized);
      const authHeader = parsed?.delegationHeader?.Authorization ?? "";
      const completedActions =
        actionsFromAuthJwt(authHeader) ?? SQL_ACTIONS;
      parsed.actions = completedActions;
      const json = JSON.stringify(parsed, null, 2);

      const downloadDelegation = () => {
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "agent-delegation.json";
        a.click();
        URL.revokeObjectURL(url);
      };

      statusEl.innerHTML = `
        <div style="color:green; margin-bottom:12px;"><strong>Delegation minted!</strong></div>
        <table style="border-collapse:collapse; margin-bottom:12px;">
          <tr>
            <td style="padding:4px 8px; font-weight:bold; vertical-align:top;">delegateDID</td>
            <td><code style="word-break:break-all;">${escapeHtml(delegation.delegateDID)}</code></td>
          </tr>
          <tr>
            <td style="padding:4px 8px; font-weight:bold; vertical-align:top;">Actions</td>
            <td>${completedActions.map(escapeHtml).join("<br>")}</td>
          </tr>
        </table>
        <button id="downloadBtn" style="margin-bottom:12px;">Download agent-delegation.json</button>
        <br>
        <label for="delegationJson"><strong>JSON (copy):</strong></label><br>
        <textarea
          id="delegationJson"
          readonly
          style="width:100%;height:180px;font-family:monospace;font-size:11px;margin-top:4px;"
        >${escapeHtml(json)}</textarea>
      `;

      document.getElementById("downloadBtn")!.addEventListener("click", downloadDelegation);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      statusEl.innerHTML = `<span style="color:red">Error: ${escapeHtml(msg)}</span>`;
    } finally {
      btn.disabled = false;
    }
  });
}
