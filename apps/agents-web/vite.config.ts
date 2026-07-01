import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA talks to the service at same-origin `/api`. In production the Bun
// server serves this build and the API from one origin. In local dev, proxy
// `/api` to a locally running eliza-service (default :3000) so `api.ts` needs
// no environment awareness.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.AGENTS_API_TARGET ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
