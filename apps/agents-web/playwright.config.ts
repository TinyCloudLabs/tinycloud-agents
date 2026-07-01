import { defineConfig } from "@playwright/test";

// Playwright E2E for the real UI, driven by a mock EIP-6963 wallet (no passkey
// signup) — ported from secret-manager's openkey-wallet-secret-flow.pw.ts.
//
// The suite expects a locally-running eliza-service (feat/agents-api) on :3000;
// Vite proxies /api to it (AGENTS_API_TARGET). Start the service first with the
// throwaway env from docs/m4-deploy-prep.md, then run `bun run e2e`.
export default defineConfig({
  testDir: "./e2e/specs",
  testMatch: "**/*.pw.ts",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://localhost:5174",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run dev",
    url: "http://localhost:5174",
    reuseExistingServer: true,
    timeout: 60_000,
    env: {
      AGENTS_API_TARGET: process.env.AGENTS_API_TARGET ?? "http://127.0.0.1:3000",
    },
  },
});
