import type { Plugin } from "@elizaos/core";
import { RuntimeHost } from "./runtime-host.js";
import { SessionStore } from "./session-store.js";
import { startElizaService } from "./server.js";

export { RuntimeHost, bootStubRuntime } from "./runtime-host.js";
export { createElizaServiceFetch, startElizaService } from "./server.js";
export type { ElizaServiceHost, ElizaServiceOptions, StartElizaServiceOptions } from "./server.js";
export { SessionStore } from "./session-store.js";

export async function main(): Promise<void> {
  const sqlPlugin = await loadSqlPlugin();
  const runtimeHost = new RuntimeHost({
    agentKeyFile: process.env.TINYCLOUD_AGENT_KEY_FILE,
    host: process.env.TINYCLOUD_HOST,
    sqlPlugin,
  });
  await runtimeHost.init();

  const server = startElizaService({
    host: runtimeHost,
    sessions: new SessionStore(),
    hostname: process.env.HOST ?? process.env.TINYCLOUD_ELIZA_SERVICE_HOST ?? "0.0.0.0",
    port: readPort(process.env.PORT ?? process.env.TINYCLOUD_ELIZA_SERVICE_PORT),
  });

  console.log(
    `@tinycloud/eliza-service listening on ${server.hostname}:${server.port} ` +
      `agentDid=${runtimeHost.agentDid}`,
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`@tinycloud/eliza-service received ${signal}; shutting down`);
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
  void main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
