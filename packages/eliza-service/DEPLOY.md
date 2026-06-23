# Deploying `@tinycloud/eliza-service` to a Phala CVM

This runbook mirrors how tinychat / listen deploy: build a Bun image, push to
GHCR, then `phala cvms create` with `docker-compose.phala.yml` and a TLS
`dstack-ingress` sidecar. The agent (eliza-service) hosts ElizaOS runtimes backed
by TinyCloud delegated memory.

> **Who runs what:** the artifacts (Dockerfile, compose, this runbook) are
> committed. The **operator** runs `docker build/push`, `phala cvms create`, and
> sets the secrets below. Nothing here hardcodes a key.

---

## 0. Key facts before you start

- **Stateless container.** The Eliza runtime boots with an in-memory DB
  (`InMemoryDatabaseAdapter`, `ALLOW_NO_DATABASE=true`). All durable memory is
  written to the **remote** TinyCloud node (`TINYCLOUD_HOST`) over delegated SQL.
  There is **no local SQLite file** in the CVM — the single-writer-SQLite
  constraint lives on the node, not here. The container is safe to restart and
  needs **no data volume** (only the ingress holds a TLS-cert volume).
- **Build context is the repo root** (the Bun workspace), not this package dir —
  the Dockerfile builds the two workspace deps (`@tinycloud/agent-client`,
  `@tinycloud/eliza-plugin-memory`) before the service, because Bun resolves the
  `@tinycloud/*` imports to each package's built `dist/index.js`.
- **Port 3000.** The service binds `0.0.0.0:3000`; the ingress terminates TLS on
  `:443` and forwards to it.

---

## 1. Build the image

From the repo root (`tinycloud-agents/`):

```bash
docker build -f packages/eliza-service/Dockerfile -t ghcr.io/tinycloudlabs/eliza-service:latest .
```

(`--platform linux/amd64` if building on Apple Silicon for an amd64 CVM.)

## 2. Push to GHCR

```bash
echo "$GITHUB_PAT" | docker login ghcr.io -u <github-user> --password-stdin
docker push ghcr.io/tinycloudlabs/eliza-service:latest
```

Make the GHCR **package** public (or grant the CVM pull access). Note: package
visibility is set on the package, independent of repo visibility.

You also need an ingress image at `ghcr.io/tinycloudlabs/eliza-service:ingress-latest`
(the standard dstack-ingress image, same as listen's `listen-backend:ingress-latest`).
Tag/push the org's dstack-ingress image under that name, or override
`ELIZA_INGRESS_IMAGE` in the env file to point at an existing ingress image.

## 3. Prepare the env file (`.env.phala`)

```dotenv
# image
ELIZA_SERVICE_IMAGE=ghcr.io/tinycloudlabs/eliza-service:latest
ELIZA_INGRESS_IMAGE=ghcr.io/tinycloudlabs/eliza-service:ingress-latest

# service
ELIZA_SERVICE_SECRET=<must match tinychat backend's ELIZA_SERVICE_SECRET>
TINYCLOUD_AGENT_KEY_FILE=/run/secrets/agent.key
TINYCLOUD_HOST=https://tee.node.tinycloud.xyz
TAVILY_API_KEY=<tavily key>

# agent key source (bind-mount form; OR use a Phala secret — see step 4)
AGENT_KEY_HOST_PATH=./.tinycloud/agent.key

# ingress / DNS (Cloudflare)
PHALA_INGRESS_DOMAIN=eliza.tinycloud.xyz
PHALA_GATEWAY_CNAME=<phala gateway domain for this CVM>
CLOUDFLARE_API_TOKEN=<cloudflare token>
CERTBOT_EMAIL=<ops email>
```

## 4. Provide the agent key (REQUIRED, never committed)

The agent DID is derived from this key and **must match tinychat's `AGENT_DID`**.
Two ways to supply it:

- **(A) Phala secret (preferred):** upload the key as a CVM secret mounted at
  `/run/secrets/agent.key`, leave `TINYCLOUD_AGENT_KEY_FILE=/run/secrets/agent.key`,
  and comment out the `volumes:` bind-mount in `docker-compose.phala.yml`.
- **(B) Bind-mount:** keep the compose `volumes:` entry and set
  `AGENT_KEY_HOST_PATH` to the key path on the CVM host.

The file content is a hex Ethereum private key (with or without `0x`).

## 5. Create the CVM

```bash
phala cvms create \
  --name eliza-service \
  --compose docker-compose.phala.yml \
  --env-file .env.phala
```

> Use `phala cvms create` to bootstrap a NEW CVM. For subsequent rollouts of a
> new image, use the Phala update/deploy flow rather than re-creating.

## 6. Verify

```bash
# health — confirm the agentDid matches tinychat's AGENT_DID
curl -s https://eliza.tinycloud.xyz/health
# => {"ok":true,"agentDid":"did:pkh:eip155:1:0x…"}
```

---

## Operator decisions (3 things only you can set)

1. **Agent identity / DID.** Prod MUST boot with a key whose DID matches the DID
   that tinychat users delegate to (`AGENT_DID` in tinychat). The **local dev**
   key resolves to `did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c`
   — decide whether prod reuses this identity or uses a fresh prod key, then set
   tinychat's `AGENT_DID` to whatever the prod `/health` reports. They must be
   byte-identical or every delegation will target the wrong agent.
2. **SQLite persistence.** None required — the CVM is stateless (durable memory is
   on the node). Do not add a memory data volume. (Only the ingress cert volume
   exists.)
3. **Tavily key.** `TAVILY_API_KEY` powers the `web_search` tool. Without it the
   service still boots, but `web_search` returns `500 {"error":"tool_misconfigured"}`.

---

## 7. Point tinychat at the deployed eliza-service

After the CVM is up and `/health` reports the expected DID, set tinychat's CVM
env:

- `AGENT_DID` = the DID from `/health` (step 6).
- `ELIZA_SERVICE_URL` = `https://eliza.tinycloud.xyz` (your `PHALA_INGRESS_DOMAIN`).
- `ELIZA_SERVICE_SECRET` = the **same** secret you set in `.env.phala` (byte-identical).

Redeploy tinychat's CVM so it picks up the new env, then run a tinychat chat turn
end-to-end to confirm the delegation + memory round-trip.
