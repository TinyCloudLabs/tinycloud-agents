// Manual live scenarios for the real Eliza x TinyCloud memory stack.
//
// This is intentionally opt-in and networked. It is not part of `bun test`.
// It proves the non-auth product path:
//   1. A real Eliza AgentRuntime writes memory through MemoryService.
//   2. A separate TinyCloud workflow reads the same data directly from SQL.
//   3. A fresh Eliza AgentRuntime hydrates the same memory from TinyCloud.
//
// Auth is deliberately the current MVP auth shape: a dedicated throwaway
// TINYCLOUD_PRIVATE_KEY, not OpenKey/user delegation.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  AgentRuntime,
  InMemoryDatabaseAdapter,
  createCharacter,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import { createAgentClient } from "@tinycloud/agent-client";

import tinycloudMemoryPlugin, {
  MEMORY_DB_HANDLE,
  MEMORY_SCHEMA,
  TinyCloudMemoryStorageService,
} from "../src/index";

const DEFAULT_HOST = "https://node.tinycloud.xyz";
const DEFAULT_KEY_FILE = new URL("../.agents-audit/eliza-live-key.env", import.meta.url);

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-4222-8222-222222222222" as UUID;
const ROOM_ID = "33333333-3333-4333-8333-333333333333" as UUID;

interface MemoryServiceProbe {
  storeLongTermMemory(input: unknown): Promise<{ id: UUID; content: string }>;
  getLongTermMemories(
    entityId: UUID,
    category?: string,
    limit?: number,
  ): Promise<Array<{ id: UUID; content: string }>>;
  storeSessionSummary(input: unknown): Promise<{ id: UUID; summary: string }>;
  getCurrentSessionSummary(roomId: UUID): Promise<{ id: UUID; summary: string } | null>;
}

function envString(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value === "" ? undefined : value;
}

async function loadPluginSql(): Promise<Plugin> {
  try {
    const mod = await import("@elizaos/plugin-sql");
    return (mod.default ?? mod.plugin) as Plugin;
  } catch (err) {
    // Published 2.0.0-beta.1 has a Bun export pointing at missing ./src/index.ts.
    // The shipped node dist exists and is the same runtime plugin surface.
    const mod = await import("../node_modules/@elizaos/plugin-sql/src/dist/node/index.node.js");
    return (mod.default ?? mod.plugin) as Plugin;
  }
}

async function loadOrCreatePrivateKey(): Promise<{ privateKey: string; keyFile?: string }> {
  const provided = envString("TINYCLOUD_PRIVATE_KEY");
  if (provided) return { privateKey: provided };

  const keyFileUrl = envString("TINYCLOUD_PRIVATE_KEY_FILE")
    ? new URL(envString("TINYCLOUD_PRIVATE_KEY_FILE")!, "file://")
    : DEFAULT_KEY_FILE;

  try {
    const existing = await readFile(keyFileUrl, "utf8");
    const match = existing.match(/^TINYCLOUD_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m);
    if (match) return { privateKey: match[1], keyFile: keyFileUrl.pathname };
  } catch {
    // Create below.
  }

  await mkdir(new URL("./", keyFileUrl), { recursive: true });
  const privateKey = "0x" + randomBytes(32).toString("hex");
  await writeFile(
    keyFileUrl,
    `TINYCLOUD_PRIVATE_KEY=${privateKey}\nTINYCLOUD_HOST=${envString("TINYCLOUD_HOST") ?? DEFAULT_HOST}\n`,
    "utf8",
  );
  return { privateKey, keyFile: keyFileUrl.pathname };
}

async function bootRuntime(privateKey: string, host: string, sqlPlugin: Plugin): Promise<AgentRuntime> {
  process.env.TINYCLOUD_PRIVATE_KEY = privateKey;
  process.env.TINYCLOUD_HOST = host;

  const character = createCharacter({
    id: AGENT_ID,
    name: "TinyCloudMemoryScenario",
    advancedMemory: true,
    plugins: ["@tinycloud/eliza-plugin-memory", "@elizaos/plugin-sql"],
    settings: {
      ALLOW_NO_DATABASE: "true",
      TINYCLOUD_PRIVATE_KEY: privateKey,
      TINYCLOUD_HOST: host,
    },
  });

  const runtime = new AgentRuntime({
    agentId: AGENT_ID,
    character,
    plugins: [tinycloudMemoryPlugin, sqlPlugin],
    adapter: new InMemoryDatabaseAdapter(),
    settings: {
      ALLOW_NO_DATABASE: "true",
      TINYCLOUD_PRIVATE_KEY: privateKey,
      TINYCLOUD_HOST: host,
    },
    logLevel: "warn",
  });

  await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

  const storage = await runtime.getServiceLoadPromise("memoryStorage");
  if (!(storage instanceof TinyCloudMemoryStorageService)) {
    throw new Error(
      `Expected TinyCloudMemoryStorageService to own memoryStorage, got ${storage?.constructor?.name}`,
    );
  }

  const memory = await runtime.getServiceLoadPromise("memory");
  if (!memory || memory.constructor.name !== "MemoryService") {
    throw new Error(`Expected Eliza MemoryService, got ${memory?.constructor?.name}`);
  }

  return runtime;
}

async function directReadFromTinyCloud(params: {
  privateKey: string;
  host: string;
  memoryId: UUID;
  summaryId: UUID;
}) {
  const client = createAgentClient({
    privateKey: params.privateKey,
    host: params.host,
    dbHandle: MEMORY_DB_HANDLE,
  });

  try {
    await client.signIn();
    await client.ensureSchema([...MEMORY_SCHEMA]);

    const memoryRows = client.sql.withRowObjects<{ id: string; content: string }>(
      await client.sql.query("SELECT id, content FROM long_term_memories WHERE id = ?", [
        params.memoryId,
      ]),
    );
    const summaryRows = client.sql.withRowObjects<{ id: string; summary: string }>(
      await client.sql.query("SELECT id, summary FROM session_summaries WHERE id = ?", [
        params.summaryId,
      ]),
    );

    return {
      memoryFound: memoryRows[0]?.id === params.memoryId,
      memoryContent: memoryRows[0]?.content,
      summaryFound: summaryRows[0]?.id === params.summaryId,
      summaryText: summaryRows[0]?.summary,
    };
  } finally {
    await client.stop();
  }
}

async function run(): Promise<void> {
  if (envString("TINYCLOUD_LIVE") !== "1") {
    console.log(
      JSON.stringify({
        skipped: true,
        reason: "set TINYCLOUD_LIVE=1 to run live Eliza x TinyCloud scenarios",
      }),
    );
    return;
  }

  const host = envString("TINYCLOUD_HOST") ?? DEFAULT_HOST;
  const { privateKey, keyFile } = await loadOrCreatePrivateKey();
  const sqlPlugin = await loadPluginSql();
  const scenarioId = randomBytes(6).toString("hex");
  const content = `scenario:${scenarioId}:Eliza executed a task and learned that Citrine prefers espresso`;
  const summaryText = `scenario:${scenarioId}:session summary persisted by Eliza MemoryService`;

  const runtime1 = await bootRuntime(privateKey, host, sqlPlugin);
  const memory1 = (await runtime1.getServiceLoadPromise("memory")) as MemoryServiceProbe;

  const storedMemory = await memory1.storeLongTermMemory({
    agentId: AGENT_ID,
    entityId: ENTITY_ID,
    category: "semantic",
    content,
    confidence: 0.92,
    source: "live-eliza-scenarios",
    metadata: { scenarioId, action: "execute-and-remember" },
  });
  const storedSummary = await memory1.storeSessionSummary({
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    entityId: ENTITY_ID,
    summary: summaryText,
    messageCount: 4,
    lastMessageOffset: 4,
    startTime: new Date(Date.now() - 60_000),
    endTime: new Date(),
    topics: ["live scenario"],
    metadata: { scenarioId, workflow: "eliza-runtime" },
  });

  const immediateMemories = await memory1.getLongTermMemories(ENTITY_ID, "semantic", 20);
  const immediateSummary = await memory1.getCurrentSessionSummary(ROOM_ID);
  await runtime1.stop();

  const directRead = await directReadFromTinyCloud({
    privateKey,
    host,
    memoryId: storedMemory.id,
    summaryId: storedSummary.id,
  });

  const runtime2 = await bootRuntime(privateKey, host, sqlPlugin);
  const memory2 = (await runtime2.getServiceLoadPromise("memory")) as MemoryServiceProbe;
  const hydratedMemories = await memory2.getLongTermMemories(ENTITY_ID, "semantic", 20);
  const hydratedSummary = await memory2.getCurrentSessionSummary(ROOM_ID);
  await runtime2.stop();

  const hydratedMemory = hydratedMemories.find((memory) => memory.id === storedMemory.id);
  const passed =
    immediateMemories.some((memory) => memory.id === storedMemory.id) &&
    immediateSummary?.id === storedSummary.id &&
    directRead.memoryFound &&
    directRead.summaryFound &&
    Boolean(hydratedMemory) &&
    hydratedSummary?.id === storedSummary.id;

  console.log(
    JSON.stringify(
      {
        passed,
        host,
        keyFile,
        scenarioId,
        scenarios: {
          elizaRuntimeWroteMemory: {
            memoryId: storedMemory.id,
            immediateReadFound: immediateMemories.some(
              (memory) => memory.id === storedMemory.id,
            ),
            summaryId: storedSummary.id,
            immediateSummaryFound: immediateSummary?.id === storedSummary.id,
          },
          directTinyCloudWorkflowRead: directRead,
          freshElizaRuntimeHydrated: {
            memoryFound: Boolean(hydratedMemory),
            memoryContent: hydratedMemory?.content,
            summaryFound: hydratedSummary?.id === storedSummary.id,
            summaryText: hydratedSummary?.summary,
          },
        },
      },
      null,
      2,
    ),
  );

  if (!passed) process.exit(1);
}

void run().catch((err) => {
  console.log(
    JSON.stringify(
      {
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
