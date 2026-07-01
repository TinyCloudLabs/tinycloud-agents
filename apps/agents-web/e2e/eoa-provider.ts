// Ephemeral-EOA EIP-1193 provider for the autonomous E2E.
//
// This is the ONLY swap versus the real app: instead of the OpenKey passkey
// provider, we back a raw ethers v5 Wallet. Everything downstream — TinyCloudWeb
// sign-in, delegate.ts minting, api.ts SIWE auth — runs the real client code.
// personal_sign here is the same EIP-191 path OpenKey routes through.
import { Wallet } from "ethers";

export interface EoaProvider {
  provider: {
    request(args: { method: string; params?: unknown[] }): Promise<unknown>;
    // ethers v5 Web3Provider also probes send/sendAsync on legacy providers.
    send?(method: string, params: unknown[]): Promise<unknown>;
  };
  address: string;
  privateKey: string;
}

export function makeEoaProvider(chainId = 1): EoaProvider {
  const wallet = Wallet.createRandom();
  const address = wallet.address;
  const chainHex = "0x" + chainId.toString(16);

  const request = async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return [address];
      case "eth_chainId":
        return chainHex;
      case "personal_sign": {
        // params: [message, address]. Message may be a hex or utf8 string.
        // ethers Wallet.signMessage signs a utf8 string or Bytes; a hex message
        // must be arrayified so it's signed as bytes, not as the literal hex text.
        const message = params[0] as string;
        const { arrayify } = await import("ethers/lib/utils");
        const payload = message.startsWith("0x") ? arrayify(message) : message;
        return wallet.signMessage(payload);
      }
      case "eth_sign": {
        // params: [address, message]
        const message = params[1] as string;
        const { arrayify } = await import("ethers/lib/utils");
        return wallet.signMessage(arrayify(message));
      }
      case "eth_getBalance":
        return "0x0";
      default:
        throw new Error(`EoaProvider: unsupported method ${method}`);
    }
  };

  const provider = {
    request,
    send: (method: string, params: unknown[]) => request({ method, params }),
  };

  return { provider, address, privateKey: wallet.privateKey };
}
