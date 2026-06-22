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

RUN bun install --frozen-lockfile

# Build workspace deps in dependency order, then the service.
#   agent-client  -> eliza-plugin-memory -> eliza-service
RUN cd packages/agent-client        && bun run build \
 && cd ../eliza-plugin-memory       && bun run build \
 && cd ../eliza-service             && bun run build

WORKDIR /app/packages/eliza-service

# Bun binds 0.0.0.0:3000 by default (server.ts readPort default, index.ts HOST
# default). The dstack-ingress sidecar terminates TLS on :443 and forwards here.
ENV PORT=3000 \
    HOST=0.0.0.0
EXPOSE 3000

# Run the built entry. dist/index.js's import.meta.main guard calls main(),
# which boots RuntimeHost (derives agentDid from TINYCLOUD_AGENT_KEY_FILE) and
# starts Bun.serve.
CMD ["bun", "dist/index.js"]
