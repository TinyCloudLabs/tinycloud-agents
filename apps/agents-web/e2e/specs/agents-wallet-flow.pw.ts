import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Mock-wallet UI E2E, ported from secret-manager's openkey-wallet-secret-flow.pw.ts.
// A mock EIP-6963 wallet (well-known Hardhat test key) is announced to the page;
// sign-in clicks "or use an external wallet" inside the OpenKey iframe and picks
// it — driving the REAL UI end to end with no passkey signup.
//
// Requires a locally-running eliza-service on :3000 (see docs/m4-deploy-prep.md
// local run recipe) with AGENTS_AUTH_DOMAIN=localhost:5174 so the SIWE domain
// (window.location.host) matches. The delegation-mint leg needs a real
// provisioned node account; against a throwaway key it will not complete (that's
// the M4 live-node gate) — the auto-provision bootstrap treats it as non-fatal.

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TEST_WALLET_NAME = "TinyCloud Test Wallet";

// ethers v5 UMD (has ethers.Wallet + ethers.utils.arrayify used below).
// Resolve via the package so the hoisted bun store location doesn't matter.
const require = createRequire(import.meta.url);
const ETHERS_UMD_PATH = join(
  dirname(require.resolve("ethers/package.json")),
  "dist/ethers.umd.min.js",
);

function exposeTestShadowRoots() {
  return () => {
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function attachShadow(init: ShadowRootInit) {
      return originalAttachShadow.call(this, { ...init, mode: "open" });
    };
  };
}

function mockBrowserWalletProvider() {
  return ({ address, privateKey, walletName }: { address: string; privateKey: string; walletName: string }) => {
    const requests: string[] = [];
    const ethers = (window as any).ethers;
    const wallet = new ethers.Wallet(privateKey);
    const provider = {
      selectedAddress: address,
      chainId: "0x1",
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        requests.push(method);
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return [address];
          case "eth_chainId":
            return "0x1";
          case "personal_sign": {
            const message = params?.[0];
            if (typeof message !== "string") throw new Error("personal_sign missing message");
            if (message.startsWith("0x")) return wallet.signMessage(ethers.utils.arrayify(message));
            return wallet.signMessage(message);
          }
          case "wallet_getPermissions":
          case "wallet_requestPermissions":
            return [{ parentCapability: "eth_accounts" }];
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain":
            return null;
          default:
            return null;
        }
      },
      on: () => provider,
      removeListener: () => provider,
      isConnected: () => true,
    };
    const announceProvider = () => {
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: {
            info: {
              uuid: "8fd9b04a-e8a0-4c43-9d87-5af504aa1f0d",
              name: walletName,
              icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28'%3E%3Crect width='28' height='28' rx='6' fill='%23111827'/%3E%3C/svg%3E",
              rdns: "xyz.tinycloud.test-wallet",
            },
            provider,
          },
        }),
      );
    };
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
    Object.defineProperty(window, "__walletRequests", { value: requests, configurable: true });
    window.addEventListener("eip6963:requestProvider", announceProvider);
    announceProvider();
  };
}

test("sign in with mock wallet -> default agent auto-provisions", async ({ page }) => {
  await page.addInitScript(exposeTestShadowRoots());
  await page.addInitScript({ path: ETHERS_UMD_PATH });
  await page.addInitScript(mockBrowserWalletProvider(), {
    address: TEST_ADDRESS,
    privateKey: TEST_PRIVATE_KEY,
    walletName: TEST_WALLET_NAME,
  });

  await page.goto("/");
  await page.getByTestId("connect-openkey").click();

  // Choose the external mock wallet inside the OpenKey connect iframe.
  await page
    .frameLocator('iframe[src*="openkey.so/widget/embed/connect"]')
    .getByText(/or use an external wallet/i)
    .click();
  await expect(page.getByText(TEST_WALLET_NAME)).toBeVisible();
  await page.getByText(TEST_WALLET_NAME).click();

  // autoCreateSpace prompts a space-creation modal only on the FIRST sign-in for
  // a fresh space (the mock wallet signs it). On later runs the space already
  // exists and no modal appears — so this is best-effort with a short wait.
  const createSpace = page.getByRole("button", { name: /create tinycloud space/i });
  if (await createSpace.isVisible({ timeout: 8_000 }).catch(() => false)) {
    await createSpace.click();
    await expect(createSpace).toBeHidden({ timeout: 60_000 });
  }

  // Signed in: the owner DID is shown, and the sign-in bootstrap auto-provisions
  // the default agent (idempotent create). The agent card must appear.
  await expect(page.getByTestId("auth-did")).toContainText(`did:pkh:eip155:1:${TEST_ADDRESS}`);
  const card = page.getByTestId("agent-card").first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByTestId("agent-did")).toContainText("did:pkh:");

  // Enable/disable toggle round-trips.
  const toggle = card.getByTestId("toggle-enabled");
  await expect(toggle).toHaveText(/disable/i); // default agent starts enabled
  await toggle.click();
  await expect(toggle).toHaveText(/enable/i);

  // The mock wallet actually signed the SIWE message (proves the auth path).
  await expect
    .poll(() => page.evaluate(() => (window as any).__walletRequests))
    .toContain("personal_sign");
});
