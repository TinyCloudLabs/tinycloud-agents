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
ELIZA_REVISION=$(git rev-parse HEAD)
docker build --platform linux/amd64 --build-arg BUILD_REVISION="$ELIZA_REVISION" -f packages/eliza-service/Dockerfile -t "ghcr.io/tinycloudlabs/eliza-service:$ELIZA_REVISION" .
```

(`--platform linux/amd64` if building on Apple Silicon for an amd64 CVM.)

Build from a committed, clean checkout so the revision identifies the image's
source. CI should pass its immutable commit SHA as `BUILD_REVISION`. The service
exposes the revision and `meetingRetrieval.contractVersion: 2` from authenticated
`GET /capabilities`; an omitted/invalid revision is reported as `unknown`, which
keeps TinyChat's version-2 meeting controller unavailable. Health alone does not
establish contract compatibility or deployment provenance.

The transcript transport propagates SQL/KV abort signals and deadline cancellation
through the pinned SDK 2.6.0. It caps retained decoded input at 1 MiB before the
SDK buffers or parses KV, SQL and error bodies, cancelling streams that exceed
the limit. Native fetch has already allocated the crossing chunk; native queues,
decompression and later bounded decoding/parsing copies remain outside this
buffer bound. No process-memory ceiling or deployed memory acceptance is
established. Verify memory behavior and latency in the target environment before
enabling the new controller; no SDK upgrade is bundled here.

## 2. Push to GHCR

```bash
echo "$GITHUB_PAT" | docker login ghcr.io -u <github-user> --password-stdin
docker push "ghcr.io/tinycloudlabs/eliza-service:$ELIZA_REVISION"
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
ELIZA_SERVICE_IMAGE=ghcr.io/tinycloudlabs/eliza-service@sha256:<pushed digest>
ELIZA_INGRESS_IMAGE=ghcr.io/tinycloudlabs/eliza-service:ingress-latest

# service
ELIZA_SERVICE_SECRET=<must match tinychat backend's ELIZA_SERVICE_SECRET>
TINYCLOUD_AGENT_KEY=<existing production agent private key>
TINYCLOUD_AGENT_KEY_FILE=/run/secrets/agent.key
TINYCLOUD_HOST=https://tee.node.tinycloud.xyz
TAVILY_API_KEY=<tavily key>

# tasks remain disabled until both the key and model map are configured
REDPILL_API_KEY=<approved existing RedPill key>
REDPILL_BASE_URL=https://api.redpill.ai/v1
ELIZA_TASK_MODELS_JSON={"moonshotai/kimi-k3":1048576,"z-ai/glm-5.3":1048576,"z-ai/glm-5.2":1048576,"qwen/qwen3.6-35b-a3b":262144}

# ingress / DNS (Cloudflare)
PHALA_INGRESS_DOMAIN=eliza.tinycloud.xyz
PHALA_GATEWAY_CNAME=<phala gateway domain for this CVM>
CLOUDFLARE_API_TOKEN=<cloudflare token>
CERTBOT_EMAIL=<ops email>
```

## 4. Provide the agent key (REQUIRED, never committed)

The agent DID is derived from this key and **must match tinychat's `AGENT_DID`**.
The current compose forwards the encrypted `TINYCLOUD_AGENT_KEY` environment
value. `docker-entrypoint.sh` materializes it as a mode-600 file at
`TINYCLOUD_AGENT_KEY_FILE` (default `/run/secrets/agent.key`). The value is a hex
Ethereum private key (with or without `0x`). Preserve the existing production
key when updating a CVM; never copy a local validation identity into deployment.
A bind-mounted key is an alternative for local Docker only.

## 5. Create the CVM

```bash
phala cvms create \
  --name eliza-service \
  --compose docker-compose.phala.yml \
  --env-file .env.phala
```

> Use `phala cvms create` to bootstrap a NEW CVM. For subsequent rollouts of a
> new image, use the Phala update/deploy flow rather than re-creating.

### Updating an existing service

Resolve the existing CVM and its current composition through established operator
access. Save its immutable application image/digest and composition for rollback,
then update only the application image and required environment forwarding. Keep
the current ingress, identity, service credential, storage host and other settings.
Do not substitute this bootstrap example for a deployed composition with different
ingress or routing.

Supply the full preserved environment through the existing encrypted-env update
path, adding `REDPILL_API_KEY`, `REDPILL_BASE_URL` and `ELIZA_TASK_MODELS_JSON`.
All three names must also reach the CVM's `allowed_envs`. An env file alone does
not add allowed names on an existing CVM. The supported Phala env update accepts
`encrypted_env` and `env_keys`; when it returns `precondition_required`, retry
with the returned `compose_hash`. Preserve existing allowed names and all existing
values, then verify the resulting names and running service. Do not log plaintext
secrets or commit the env file. No GitHub deployment workflow is installed here.

Verify the model map against TinyChat's offered catalog and current approved
provider model IDs before rollout. The sample includes four offered models;
release validation is limited to Kimi K3 and GLM 5.3. Configuring fewer service
models than TinyChat offers causes explicit rejection for unsupported selections.

## 6. Verify

```bash
# health — confirm the agentDid matches tinychat's AGENT_DID
curl -s https://eliza.tinycloud.xyz/health
# => {"ok":true,"agentDid":"did:pkh:eip155:1:0x…"}
```

---

## Operator decisions (3 things only you can set)

1. **Agent identity / DID.** Existing-service updates preserve the production
   key and TinyChat's `AGENT_DID`; verify `/health` still matches that expected
   DID. Identity selection is only a new-service bootstrap decision. Do not
   replace the key or change delegation targets during an application rollout.
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

## TinyChat tasks and rollout

The authenticated `/capabilities` response includes `chatTasks` version 1. With
`REDPILL_API_KEY`, the approved `REDPILL_BASE_URL` (default
`https://api.redpill.ai/v1`), and `ELIZA_TASK_MODELS_JSON` configured, TinyChat can
submit `/tasks` and cancel through `/tasks/:executionId/cancel`. The model map is
a JSON object from exact approved model ID to its context-token ceiling. It does
not load model configuration or credentials from requests. Missing configuration
leaves tasks disabled with HTTP 503; malformed configured values reject startup.

The local task runner owns ordinary provider answers and sequential read-only
meeting/public-web tools. Ordinary eligible text streams; private selection
makes buffering irreversible. Reported usage survives later failures, and
cancellation settles without waiting for an uncooperative provider. Keep general
rollout gated on the end-to-end acceptance checks.

Deploy the compatible service before enabling TinyChat's `ELIZA_TASKS_ENABLED`.
Keep that flag `false` for the initial backend deployment. Before a canary, set
a nonempty explicit `ELIZA_TASKS_TEST_ACCOUNTS` list; enabled with an empty list
admits all authenticated accounts. Backend flags are read at startup, so use the
normal deployment/restart path for changes. Preserve backend RedPill credentials
and the legacy meeting settings for ordinary chat and rollback.

Authenticate `GET /capabilities` and check the immutable `buildRevision`,
`chatTasks.version: 1`, `enabled: true`, `cancellation: true`,
`providerProfile: "tinychat-redpill"`, and the complete configured model list.
Keep local-validation flags unset/false in production. Verify task and cancel
reach the same service process and deployed stream timeouts allow the 300-second
task budget. Roll back routing by disabling the backend task flag first; retain
the compatible service until in-flight tasks finish or cancel.

A task allows at most four ordinary provider requests and sixteen tool attempts,
including at most one transient retry per normalized tool/arguments key. Private
answer rounds use clean context containing only the latest question, resolved
calendar scope, current-run meeting evidence and separate public sources. Before
the fourth request, a clean round may advertise **only admitted `web_search`** to
fetch missing public sources; it never reopens private tools or includes account
memory/history. A valid answer without a tool call finishes that round immediately.
Thus a private answer can finish in three requests, while discovery → read → web
lookup → answer fits within four. The fourth request and the optional single
citation repair are strictly no-tools. Repair receives validation codes and fresh
evidence, never the rejected draft; all attempts contribute to aggregate usage.

Missing calendar context is checked after the provider selects an admitted private
tool and before its dispatch. Clarification accounts for that provider request;
ordinary questions that quote relative meeting dates continue normally.

Active runs and content-free execution tombstones remain in one service process.
The registry holds at most 1,000 remembered runs, rejects excess admission, and
retains terminal IDs through the effective deadline plus 2 seconds. Task execution
is capped at 300 seconds. Cancellation requires the same app/agent/entity owner.
There is no persistent replay or cross-process exactly-once guarantee.
An overlapping task for the same app, agent and room is rejected with HTTP 409
until the active task settles, including a request from a different entity.

For read-only local validation, set `ELIZA_LOCAL_VALIDATION=true`,
`NODE_ENV=development`, and a loopback `HOST`, then run `bun src/index.ts` from this
package using the pinned workspace toolchain. This mode retains signed delegation
activation and the real transcript tools, and bypasses native memory schema and
message/evaluator paths. Normal startup retains the existing runtime. Keep test
chat history, account-memory extraction and billing isolated in TinyChat as well.
