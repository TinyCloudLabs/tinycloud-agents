import { TinyCloudWeb, type Config } from "@tinycloud/web-sdk";
import { connectWallet } from "./openkey";
import { renderDelegationUI } from "./delegate";

const app = document.getElementById("app")!;

app.innerHTML = `
  <h1>TinyCloud Delegate UI</h1>
  <p>Sign in with your passkey-backed identity, then create the SQL delegation for the agent.</p>

  <label for="delegateDID">Delegate DID</label>
  <input
    id="delegateDID"
    type="text"
    value="did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c"
    spellcheck="false"
  />

  <label for="dbHandle">DB Handle</label>
  <input
    id="dbHandle"
    type="text"
    value="xyz.tinycloud.eliza/memory"
    spellcheck="false"
  />

  <label for="host">Host</label>
  <input
    id="host"
    type="text"
    value="https://node.tinycloud.xyz"
    spellcheck="false"
  />

  <button id="signInBtn">Sign in with passkey</button>
  <div id="status" style="margin-top:16px; font-size:14px;"></div>
  <div id="delegationContainer"></div>
`;

document.getElementById("signInBtn")!.addEventListener("click", async () => {
  const statusEl = document.getElementById("status")!;
  const delegationContainer = document.getElementById("delegationContainer")!;
  const btn = document.getElementById("signInBtn") as HTMLButtonElement;
  const host = (document.getElementById("host") as HTMLInputElement).value.trim();

  btn.disabled = true;
  statusEl.textContent = "Opening OpenKey passkey widget...";

  try {
    const { provider, address } = await connectWallet();
    statusEl.textContent = "Signing in to TinyCloud...";

    const config: Config = {
      providers: { web3: { driver: provider } },
    };
    if (host) {
      config.tinycloudHosts = [host];
    }

    const tcw = new TinyCloudWeb(config);
    await tcw.signIn();

    const signerAddress = tcw.address() ?? address;
    const didPkh = `did:pkh:eip155:1:${signerAddress}`;

    statusEl.innerHTML = [
      "<strong style='color:green'>Signed in!</strong>",
      `<br>Address: <code>${signerAddress}</code>`,
      `<br>DID: <code>${didPkh}</code>`,
    ].join("");

    const delegateDID = (document.getElementById("delegateDID") as HTMLInputElement).value.trim();
    const dbHandle = (document.getElementById("dbHandle") as HTMLInputElement).value.trim();

    renderDelegationUI(tcw, delegationContainer, delegateDID, dbHandle, host);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    statusEl.innerHTML = `<span style="color:red">Error: ${escapeHtml(msg)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
