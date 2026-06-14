import OpenKey, { OpenKeyProvider } from "@openkey/sdk";
import type { AuthResult } from "@openkey/sdk";

export interface ConnectResult {
  address: string;
  keyId: string;
  provider: OpenKeyProvider;
}

// host: reserved for non-default OpenKey deployments; not wired to the form's TinyCloud host field
export async function connectWallet(host = "https://openkey.so"): Promise<ConnectResult> {
  const openkey = new OpenKey({ host, appName: "TinyCloud Delegate" });
  console.log("[openkey] Calling openkey.connect()...");
  const authResult: AuthResult = await openkey.connect();
  console.log("[openkey] connect() done. Address:", authResult.address);
  const provider = new OpenKeyProvider(openkey, authResult);
  return { address: authResult.address, keyId: authResult.keyId, provider };
}
