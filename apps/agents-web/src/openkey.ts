import OpenKey, { OpenKeyProvider } from "@openkey/sdk";
import type { AuthResult } from "@openkey/sdk";

export interface ConnectResult {
  address: string;
  keyId: string;
  provider: OpenKeyProvider;
}

// Ported from tools/delegate-ui/src/openkey.ts.
// host: reserved for non-default OpenKey deployments; not user-configurable here.
export async function connectWallet(host = "https://openkey.so"): Promise<ConnectResult> {
  const openkey = new OpenKey({ host, appName: "TinyCloud Agents" });
  const authResult: AuthResult = await openkey.connect();
  const provider = new OpenKeyProvider(openkey, authResult);
  return { address: authResult.address, keyId: authResult.keyId, provider };
}
