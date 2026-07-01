# syntax=docker/dockerfile:1.7
#
# @tinycloud/eliza-service — Phala CVM image.
#
# Build context MUST be the repo root (the Bun workspace), NOT this package dir,
# so the workspace deps (@tinycloud/agent-client, @tinycloud/eliza-plugin-memory)
# resolve and can be built:
#
#   docker build -f packages/eliza-service/Dockerfile -t eliza-service .
#
# Why we build the workspace deps (instead of running raw TS):
#   All three packages declare `main`/`exports` -> `dist/index.js`. Bun resolves
#   the @tinycloud/* imports through the `exports` field to `dist/index.js`
#   (verified with Bun.resolveSync), so the deps' `dist/` MUST exist before the
#   service can import them. Bun runs TS directly, but the *dependency* imports
#   are package-name imports, not relative .ts paths — hence the per-package
#   `tsc` build, in dependency order. There is no WASM and no postinstall, so the
#   image stays a single stage on the official Bun image.
FROM oven/bun:1.3.9 AS app
WORKDIR /app

# Workspace manifests + lockfile first for a cacheable install layer.
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
# apps/ holds the agents-web SPA (M3). Uncomment once apps/agents-web exists so the
# workspace install resolves it (root package.json workspaces already includes apps/*).
# COPY apps ./apps

RUN bun install --frozen-lockfile

# Build workspace deps in dependency order, then the service.
#   agent-client  -> eliza-plugin-memory -> eliza-service
RUN cd packages/agent-client        && bun run build \
 && cd ../eliza-plugin-memory       && bun run build \
 && cd ../eliza-service             && bun run build

# ── agents-web SPA build → PUBLIC_DIR (M4, gated on M3) ───────────────────────
# The Bun server serves this dir after API/legacy routes miss (server.ts
# serveStatic; PUBLIC_DIR below). Uncomment the two lines once apps/agents-web
# exists and its `build` script emits dist/:
#   RUN cd apps/agents-web && bun run build
#   RUN cp -r apps/agents-web/dist /app/packages/eliza-service/public
# Until then PUBLIC_DIR points at a dir that may not exist; serveStatic returns
# null (falls through to 404) when index.html is absent, so the service still runs.
ENV PUBLIC_DIR=/app/packages/eliza-service/public

WORKDIR /app/packages/eliza-service

# Entrypoint materializes the agent key file from the TINYCLOUD_AGENT_KEY env var
# when present (Phala CVMs inject secrets as env vars, not files).
COPY packages/eliza-service/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Bun binds 0.0.0.0:3000 by default (server.ts readPort default, index.ts HOST
# default). The dstack-ingress sidecar terminates TLS on :443 and forwards here.
ENV PORT=3000 \
    HOST=0.0.0.0
EXPOSE 3000

# Run the built entry. dist/index.js's import.meta.main guard calls main(),
# which boots RuntimeHost (derives agentDid from TINYCLOUD_AGENT_KEY_FILE) and
# starts Bun.serve.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["bun", "dist/index.js"]
