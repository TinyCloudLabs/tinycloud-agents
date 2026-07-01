import { TinyCloudWeb, type Config } from "@tinycloud/web-sdk";
import { connectWallet } from "./openkey";

// The TinyCloud node that owns the user's memory space. This is the storage
// backend the delegation is scoped to — distinct from the agents API origin.
export const TINYCLOUD_HOST = "https://node.tinycloud.xyz";

export interface Session {
  tcw: TinyCloudWeb;
  address: string;
  did: string;
}

// Ported from tools/delegate-ui/src/main.ts sign-in handler:
// OpenKey passkey -> EIP-1193 provider -> new TinyCloudWeb(...) -> signIn().
export async function signIn(): Promise<Session> {
  const { provider, address } = await connectWallet();

  const config: Config = {
    providers: { web3: { driver: provider } },
    tinycloudHosts: [TINYCLOUD_HOST],
  };

  const tcw = new TinyCloudWeb(config);
  await tcw.signIn();

  const signerAddress = tcw.address() ?? address;
  const did = `did:pkh:eip155:1:${signerAddress}`;
  return { tcw, address: signerAddress, did };
}
