import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// The SPA talks to the service at same-origin `/api`. In production the Bun
// server serves this build and the API from one origin. In local dev, proxy
// `/api` to a locally running eliza-service (default :3000) so `api.ts` needs
// no environment awareness.
//
// HTTPS is opt-in for the passkey E2E only: WebAuthn requires a secure origin,
// so set AGENTS_HTTPS_CERT / AGENTS_HTTPS_KEY (mkcert files) to serve over TLS.
// Unset (the default, incl. the mock-wallet E2E) keeps plain HTTP.
const httpsCert = process.env.AGENTS_HTTPS_CERT;
const httpsKey = process.env.AGENTS_HTTPS_KEY;
const https =
  httpsCert && httpsKey
    ? { cert: readFileSync(httpsCert), key: readFileSync(httpsKey) }
    : undefined;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    https,
    proxy: {
      "/api": {
        target: process.env.AGENTS_API_TARGET ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
