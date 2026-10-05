import type { Plugin } from "@elizaos/core";
import { RuntimeHost } from "./runtime-host.js";
import { SessionStore } from "./session-store.js";
import { startElizaService } from "./server.js";
import { createLocalValidationHost, localValidationFromEnv } from "./local-validation-host.js";
import { taskConfigFromEnv } from "./tasks/contract.js";
import { agentIdentityFromFile } from "@tinycloud/agent-client";
import { DelegationStore, TinyCloudDelegationKv, delegationStoreEnabled } from "./delegation-store.js";
import { HeldSessions } from "./held-sessions.js";
import { TINYCHAT_AGENT_ID, TINYCHAT_APP_ID } from "./auth/app-registry.js";

export { RuntimeHost, bootStubRuntime } from "./runtime-host.js";
export { createElizaServiceFetch, startElizaService } from "./server.js";
export type { ElizaServiceHost, ElizaServiceOptions, StartElizaServiceOptions } from "./server.js";
export { SessionStore } from "./session-store.js";
export { DelegationStore, MemoryDelegationKv, TinyCloudDelegationKv } from "./delegation-store.js";
export { HeldSessions } from "./held-sessions.js";

export async function main(): Promise<void> {
  const tasks = taskConfigFromEnv();
  const localValidation = localValidationFromEnv(process.env);
  const runtimeHost = localValidation
    ? await createLocalValidationHost({
      agentKeyFile: process.env.TINYCLOUD_AGENT_KEY_FILE ?? "",
      host: process.env.TINYCLOUD_HOST ?? "https://node.tinycloud.xyz",
    })
    : new RuntimeHost({
      agentKeyFile: process.env.TINYCLOUD_AGENT_KEY_FILE,
      host: process.env.TINYCLOUD_HOST,
      sqlPlugin: await loadSqlPlugin(),
    });
  if (runtimeHost instanceof RuntimeHost) await runtimeHost.init();

  // TinyChat grants persist in the agent's own space and reload after a
  // restart. Local validation forbids account writes, so it stays memory-only
  // unless ELIZA_DELEGATION_STORE=on is set explicitly.
  const sessions = new SessionStore();
  const persist = localValidation
    ? process.env.ELIZA_DELEGATION_STORE === "on"
    : delegationStoreEnabled(process.env);
  let delegationStore: DelegationStore | undefined;
  let held: HeldSessions | undefined;
  if (persist) {
    const identity = await agentIdentityFromFile(process.env.TINYCLOUD_AGENT_KEY_FILE ?? "");
    delegationStore = new DelegationStore(new TinyCloudDelegationKv({
      privateKey: identity.normalizedKey,
      host: process.env.TINYCLOUD_HOST ?? "https://node.tinycloud.xyz",
    }));
    held = new HeldSessions({
      store: delegationStore,
      sessions,
      host: runtimeHost,
      scope: { appId: TINYCHAT_APP_ID, agentId: TINYCHAT_AGENT_ID },
    });
  } else {
    console.log("@tinycloud/eliza-service delegation store disabled; grants are lost on restart");
  }

  const server = startElizaService({
    host: runtimeHost,
    sessions,
    held,
    tasks,
    hostname: process.env.HOST ?? process.env.TINYCLOUD_ELIZA_SERVICE_HOST ?? "0.0.0.0",
    port: readPort(process.env.PORT ?? process.env.TINYCLOUD_ELIZA_SERVICE_PORT),
  });

  console.log(
    `@tinycloud/eliza-service listening on ${server.hostname}:${server.port} ` +
      `agentDid=${runtimeHost.agentDid}`,
  );
  // Listen first: until each stored grant is reloaded, its requests get 503
  // private_access_restoring instead of "none".
  held?.start();

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`@tinycloud/eliza-service received ${signal}; shutting down`);
    held?.stop();
    // Give queued grant writes (e.g. a Disconnect's delete) a bounded chance to land.
    await delegationStore?.flush(5_000);
    delegationStore?.stop();
    await runtimeHost.stop();
    await server.stop(true);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

async function loadSqlPlugin(): Promise<Plugin> {
  let mod: unknown;
  try {
    mod = await import("@elizaos/plugin-sql");
  } catch {
    mod = await import(
      new URL("../node_modules/@elizaos/plugin-sql/src/dist/node/index.node.js", import.meta.url)
        .href
    );
  }
  const plugin = (
    mod as {
      default?: Plugin;
      sqlPlugin?: Plugin;
      plugin?: Plugin;
    }
  ).default ?? (mod as { sqlPlugin?: Plugin }).sqlPlugin ?? (mod as { plugin?: Plugin }).plugin;
  if (!plugin) {
    throw new Error("@tinycloud/eliza-service: @elizaos/plugin-sql did not export a plugin");
  }
  return plugin;
}

function readPort(value: string | undefined): number {
  if (!value) return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("@tinycloud/eliza-service: invalid port");
  }
  return port;
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  void main().catch(() => {
    console.error("@tinycloud/eliza-service fatal startup error");
    process.exit(1);
  });
}
