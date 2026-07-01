import { TinyCloudWeb, type Config } from "@tinycloud/web-sdk";
import { connectWallet } from "./openkey";
import { AGENTS_SPACE, tinyCloudAgentsManifest } from "./manifest";

// The TinyCloud node that owns the user's memory space. This is the storage
// backend the delegation is scoped to — distinct from the agents API origin.
export const TINYCLOUD_HOST = "https://node.tinycloud.xyz";

export interface Session {
  tcw: TinyCloudWeb;
  address: string;
  did: string;
}

// OpenKey passkey -> EIP-1193 provider -> TinyCloudWeb(spacePrefix/autoCreate/
// manifest) -> signIn(). Modeled on secret-manager's vault-client.initTinyCloud.
// `autoCreateSpace: true` provisions the "agents" space during signIn (no manual
// ensureAgentsSpace), and the manifest grants the app's own session access to it.
export async function signIn(): Promise<Session> {
  const { provider, address } = await connectWallet();

  const config: Config = {
    provider,
    tinycloudHosts: [TINYCLOUD_HOST],
    spacePrefix: AGENTS_SPACE,
    autoCreateSpace: true,
    manifest: tinyCloudAgentsManifest(),
  };

  const tcw = new TinyCloudWeb(config);
  await tcw.signIn();

  const signerAddress = tcw.address() ?? address;
  const did = `did:pkh:eip155:1:${signerAddress}`;
  return { tcw, address: signerAddress, did };
}
