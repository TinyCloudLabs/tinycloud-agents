// Manual live scenarios for the real Eliza x TinyCloud memory stack — DELEGATION MODE.
//
// Mirrors live-eliza-scenarios.ts but exercises the OpenKey-delegated product path:
//   1. (MANUAL) Human signs in with OpenKey/passkey, creates a TinyCloud session,
//      delegates memory SQL policy to the stable agent DID → writes DELEGATION_FILE.
//   2. (Gated) Agent boots in delegation mode, writes long-term memory + session
//      summary via delegated SQL (step 4).
//   3. (Gated) Separate user-authorized client reads the same rows from the user's
//      space (step 5).
//   4. (Gated) Fresh agent process restores from the same delegation file and hydrates
//      memory (step 6).
//
// This is intentionally opt-in and networked. It is NOT part of `bun test`.
// See docs/openkey-phases/phase-7-runbook.md for manual setup steps 1–3.
// See docs/openkey-phases/phase-7-live-scenario-plan.md for full scope.
//
// Gates (each prints {"skipped":true,"reason":...} and exits 0 when triggered):
//   1. TINYCLOUD_LIVE !== "1"   — master gate, same discipline as live-eliza-scenarios.ts
//   2. No DELEGATION_FILE / TINYCLOUD_DELEGATION_FILE
//   3. Phase 3 delegated transport not yet ready (import or construction throws)

import { randomBytes } from "node:crypto";

import {
  AgentRuntime,
  InMemoryDatabaseAdapter,
  createCharacter,
  type Plugin,
  type UUID,
} from "@elizaos/core";

import tinycloudMemoryPlugin, {
  MEMORY_DB_HANDLE,
  MEMORY_SCHEMA,
  TinyCloudMemoryStorageService,
} from "../src/index";

const DEFAULT_HOST = "https://node.tinycloud.xyz";

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
  } catch {
    // Published 2.0.0-beta.1 has a Bun export pointing at missing ./src/index.ts.
    // The shipped node dist exists and is the same runtime plugin surface.
    const mod = await import("../node_modules/@elizaos/plugin-sql/src/dist/node/index.node.js");
    return (mod.default ?? mod.plugin) as Plugin;
  }
}

async function bootDelegatedRuntime(params: {
  delegationFile: string;
  agentKey: string | undefined;
  agentKeyFile: string | undefined;
  host: string;
  sqlPlugin: Plugin;
}): Promise<AgentRuntime> {
  // Inject delegation env vars so resolveMemoryClientConfig picks them up.
  process.env.TINYCLOUD_AUTH_MODE = "delegation";
  process.env.TINYCLOUD_DELEGATION_FILE = params.delegationFile;
  delete process.env.TINYCLOUD_AGENT_KEY;
  delete process.env.TINYCLOUD_AGENT_KEY_FILE;
  if (params.agentKey) process.env.TINYCLOUD_AGENT_KEY = params.agentKey;
  if (params.agentKeyFile) process.env.TINYCLOUD_AGENT_KEY_FILE = params.agentKeyFile;
  process.env.TINYCLOUD_HOST = params.host;

  const settings: Record<string, string> = {
    ALLOW_NO_DATABASE: "true",
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_DELEGATION_FILE: params.delegationFile,
    TINYCLOUD_HOST: params.host,
  };
  if (params.agentKey) settings.TINYCLOUD_AGENT_KEY = params.agentKey;
  if (params.agentKeyFile) settings.TINYCLOUD_AGENT_KEY_FILE = params.agentKeyFile;

  const character = createCharacter({
    id: AGENT_ID,
    name: "TinyCloudDelegatedMemoryScenario",
    advancedMemory: true,
    plugins: ["@tinycloud/eliza-plugin-memory", "@elizaos/plugin-sql"],
    settings,
  });

  const runtime = new AgentRuntime({
    agentId: AGENT_ID,
    character,
    plugins: [tinycloudMemoryPlugin, params.sqlPlugin],
    adapter: new InMemoryDatabaseAdapter(),
    settings,
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

async function run(): Promise<void> {
  // Gate 1: master gate — same discipline as live-eliza-scenarios.ts
  if (envString("TINYCLOUD_LIVE") !== "1") {
    console.log(
      JSON.stringify({
        skipped: true,
        reason: "set TINYCLOUD_LIVE=1 to run live Eliza x TinyCloud delegated scenarios",
      }),
    );
    return;
  }

  // Gate 2: delegation source — requires DELEGATION_FILE or TINYCLOUD_DELEGATION_FILE.
  // The human produces this file by following the runbook (docs/openkey-phases/phase-7-runbook.md).
  const delegationFile =
    envString("DELEGATION_FILE") ?? envString("TINYCLOUD_DELEGATION_FILE");
  if (!delegationFile) {
    console.log(
      JSON.stringify({
        skipped: true,
        reason:
          "set DELEGATION_FILE (or TINYCLOUD_DELEGATION_FILE) to the path of a serialized " +
          "portable delegation produced by the runbook (docs/openkey-phases/phase-7-runbook.md)",
      }),
    );
    return;
  }

  // Gate 3: Phase 3 not-ready guard.
  // Import createAgentClient lazily inside try/catch so a tree without
  // delegated-transport.ts (pre-Phase 3) never throws at module load time.
  // Probe delegation mode construction — a "not yet implemented" guard from
  // Phase 3 would throw here, triggering the skip below.
  type AgentClientMod = typeof import("@tinycloud/agent-client");
  let agentClientMod: AgentClientMod;
  try {
    agentClientMod = await import("@tinycloud/agent-client");
    agentClientMod.createAgentClient({
      mode: "delegation",
      delegationFile,
      agentKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      JSON.stringify({
        skipped: true,
        reason: `Phase 3 delegated transport is not yet ready: ${msg}`,
      }),
    );
    return;
  }

  // All gates passed. Phase 3 ready, DELEGATION_FILE supplied, TINYCLOUD_LIVE=1.
  const { createAgentClient } = agentClientMod;
  const host = envString("TINYCLOUD_HOST") ?? DEFAULT_HOST;
  const sqlPlugin = await loadPluginSql();
  const scenarioId = randomBytes(6).toString("hex");

  // Resolve real agent key — Gate 3's probe used a dummy key.
  const agentKey = envString("TINYCLOUD_AGENT_KEY");
  const agentKeyFile = envString("TINYCLOUD_AGENT_KEY_FILE");
  if (!agentKey && !agentKeyFile) {
    console.log(
      JSON.stringify({
        skipped: true,
        reason:
          "set TINYCLOUD_AGENT_KEY (or TINYCLOUD_AGENT_KEY_FILE) to the stable agent identity key",
      }),
    );
    return;
  }

  const content = `scenario:${scenarioId}:delegated-agent wrote long-term memory via TinyCloud delegation`;
  const summaryText = `scenario:${scenarioId}:delegated session summary stored by Eliza MemoryService`;

  // ─── Step 4: Delegated write ─────────────────────────────────────────────
  // Boot AgentRuntime in TINYCLOUD_AUTH_MODE=delegation using DELEGATION_FILE +
  // agent key. Assert TinyCloudMemoryStorageService owns memoryStorage. Then write
  // a long-term memory and a session summary via MemoryService.
  const runtime1 = await bootDelegatedRuntime({
    delegationFile,
    agentKey,
    agentKeyFile,
    host,
    sqlPlugin,
  });
  const memory1 = (await runtime1.getServiceLoadPromise("memory")) as MemoryServiceProbe;

  const storedMemory = await memory1.storeLongTermMemory({
    agentId: AGENT_ID,
    entityId: ENTITY_ID,
    category: "semantic",
    content,
    confidence: 0.92,
    source: "live-delegated-scenarios",
    metadata: { scenarioId, action: "delegated-execute-and-remember" },
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
    topics: ["delegated-live-scenario"],
    metadata: { scenarioId, workflow: "eliza-delegated-runtime" },
  });

  const immediateMemories = await memory1.getLongTermMemories(ENTITY_ID, "semantic", 20);
  const immediateSummary = await memory1.getCurrentSessionSummary(ROOM_ID);
  await runtime1.stop();

  const step4Passed =
    immediateMemories.some((m) => m.id === storedMemory.id) &&
    immediateSummary?.id === storedSummary.id;

  // ─── Step 5: Cross-client read (separate user-authorized client) ──────────
  // A SEPARATE createAgentClient call reads the same rows by id from the user's
  // SQL space, proving delegated writes landed in the USER's space (not an isolated
  // agent-owned space as would be the case with private-key mode).
  //
  // The read client uses the same delegation file — this is the delegation-only seam.
  // If a web-sdk user session (TinyCloudWeb.signIn + no agent key) becomes available
  // via the runbook, prefer that for a stronger proof. See runbook §step-5-note.
  const crossClientRead = await (async () => {
    const client2 = createAgentClient(
      agentKey != null
        ? {
            mode: "delegation" as const,
            delegationFile,
            host,
            dbHandle: MEMORY_DB_HANDLE,
            agentKey,
          }
        : {
            mode: "delegation" as const,
            delegationFile,
            host,
            dbHandle: MEMORY_DB_HANDLE,
            agentKeyFile: agentKeyFile as string,
          },
    );
    try {
      await client2.signIn();
      await client2.ensureSchema([...MEMORY_SCHEMA]);
      const memoryRows = client2.sql.withRowObjects<{ id: string; content: string }>(
        await client2.sql.query(
          "SELECT id, content FROM long_term_memories WHERE id = ?",
          [storedMemory.id],
        ),
      );
      const summaryRows = client2.sql.withRowObjects<{ id: string; summary: string }>(
        await client2.sql.query(
          "SELECT id, summary FROM session_summaries WHERE id = ?",
          [storedSummary.id],
        ),
      );
      return {
        memoryFound: memoryRows[0]?.id === storedMemory.id,
        memoryContent: memoryRows[0]?.content,
        summaryFound: summaryRows[0]?.id === storedSummary.id,
        summaryText: summaryRows[0]?.summary,
      };
    } finally {
      await client2.stop();
    }
  })();

  const step5Passed = crossClientRead.memoryFound && crossClientRead.summaryFound;

  // ─── Step 6: Fresh-process restore + hydrate ─────────────────────────────
  // Stop, boot a FRESH runtime from the SAME delegation file, and assert that
  // long-term memory + session summary hydrate from TinyCloud.
  const runtime2 = await bootDelegatedRuntime({
    delegationFile,
    agentKey,
    agentKeyFile,
    host,
    sqlPlugin,
  });
  const memory2 = (await runtime2.getServiceLoadPromise("memory")) as MemoryServiceProbe;
  const hydratedMemories = await memory2.getLongTermMemories(ENTITY_ID, "semantic", 20);
  const hydratedSummary = await memory2.getCurrentSessionSummary(ROOM_ID);
  await runtime2.stop();

  const hydratedMemory = hydratedMemories.find((m) => m.id === storedMemory.id);
  const step6Passed = Boolean(hydratedMemory) && hydratedSummary?.id === storedSummary.id;

  const passed = step4Passed && step5Passed && step6Passed;

  console.log(
    JSON.stringify(
      {
        passed,
        host,
        scenarioId,
        scenarios: {
          step4_delegatedWrite: {
            memoryId: storedMemory.id,
            immediateReadFound: immediateMemories.some((m) => m.id === storedMemory.id),
            summaryId: storedSummary.id,
            immediateSummaryFound: immediateSummary?.id === storedSummary.id,
            passed: step4Passed,
          },
          step5_crossClientRead: {
            ...crossClientRead,
            note: "Read via separate createAgentClient (same delegation file) — proves rows are in USER space",
            passed: step5Passed,
          },
          step6_freshProcessRestore: {
            memoryFound: Boolean(hydratedMemory),
            memoryContent: hydratedMemory?.content,
            summaryFound: hydratedSummary?.id === storedSummary.id,
            summaryText: hydratedSummary?.summary,
            passed: step6Passed,
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
