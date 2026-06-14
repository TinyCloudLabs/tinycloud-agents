// scripts/live-smoke.ts — MANUAL live verification of the TinyCloud memory stack
// against a real prod node. SANCTIONED by the handoff, but deliberately OUT of the
// automated path: NOT wired into `bun test`, NOT run by the deterministic
// regression, NOT run by CI. A human runs it by hand:
//
//     TINYCLOUD_LIVE=1 bun --bun run scripts/live-smoke.ts
//
// Without TINYCLOUD_LIVE=1 it prints a {"skipped":true,…} JSON line and exits 0,
// so it is safe to invoke unconditionally (e.g. a smoke gate that only "arms" when
// the env flag is set).
//
// KEY (plan §3, agent-holds-key): uses TINYCLOUD_PRIVATE_KEY when set, otherwise
// generates a THROWAWAY key (0x + randomBytes(32) hex — exactly like the Bun spike,
// spikes/eliza-bun-spike/spike.ts). A throwaway key mints a brand-new, low-value
// space that is simply ABANDONED afterwards — the node has no cleanup/delete API
// and none is needed (delegation churn is a node-ops concern, plan §10.9).
//
// HOST: TINYCLOUD_HOST (default https://node.tinycloud.xyz). Self-host for sensitive
// data — content is plaintext-at-rest today (plan §10.1).
//
// SECURITY (plan §5 / audit F4): we never log Authorization headers, UCAN
// invocations, or full request dumps; the SDK's 60s invocation expiry is left at its
// default (the node has no replay protection — the short expiry IS the control).
//
// LATENCY (plan §2.5): signIn ~10s, each SQL call ~1.3–2.9s. Every step is STRICTLY
// SEQUENTIAL and individually deadline-bounded — we NEVER Promise.all against the
// node (KV/SQL drop responses under concurrency).

import { randomBytes } from "node:crypto";

import {
  createAgentClient,
  type AgentClientConfig,
} from "@tinycloud/agent-client";
import {
  MEMORY_DB_HANDLE,
  MEMORY_SCHEMA,
  TinyCloudMemoryStorageService,
} from "@tinycloud/eliza-plugin-memory";

/** Public prod node (plan §3). */
const DEFAULT_HOST = "https://node.tinycloud.xyz";

/** Per-step budgets (plan §2.5 prod reality, generous over typical latency). */
const SIGN_IN_BUDGET_MS = 30_000; // ~10s typical
const SQL_BUDGET_MS = 15_000; // ~1.3–2.9s typical

/** Reject `p` after `ms` so a hung node never wedges the smoke run. */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${ms}ms budget`)),
      ms,
    );
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function envString(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value === "" ? undefined : value;
}

// ── env gate: arm only when explicitly requested ─────────────────────────────
if (envString("TINYCLOUD_LIVE") !== "1") {
  console.log(
    JSON.stringify({
      skipped: true,
      reason: "set TINYCLOUD_LIVE=1 to run the live smoke against a prod node",
      host: envString("TINYCLOUD_HOST") ?? DEFAULT_HOST,
    }),
  );
  process.exit(0);
}

// Deterministic, well-formed UUIDs for the storage-level probe (plan §6 partitions).
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const ENTITY_ID = "22222222-2222-4222-8222-222222222222";
const ROOM_ID = "33333333-3333-4333-8333-333333333333";

async function main(): Promise<void> {
  const timings: Record<string, number> = {};
  const since = () => performance.now();
  const mark = (key: string, start: number) => {
    timings[key] = Math.round(performance.now() - start);
  };

  // Throwaway key unless the operator supplies one (plan §3). Same recipe as spike.ts.
  const usingThrowawayKey = envString("TINYCLOUD_PRIVATE_KEY") === undefined;
  const privateKey =
    envString("TINYCLOUD_PRIVATE_KEY") ?? "0x" + randomBytes(32).toString("hex");
  const host = envString("TINYCLOUD_HOST") ?? DEFAULT_HOST;

  const config: AgentClientConfig = { privateKey, host, dbHandle: MEMORY_DB_HANDLE };
  const client = createAgentClient(config);

  let spaceId = "";
  try {
    // ── STEP 1: client-level round-trip ──────────────────────────────────────
    let start = since();
    const session = await withDeadline(client.signIn(), SIGN_IN_BUDGET_MS, "signIn");
    spaceId = session.spaceId;
    mark("signIn", start);

    start = since();
    await withDeadline(client.ensureSchema([...MEMORY_SCHEMA]), SQL_BUDGET_MS, "ensureSchema");
    mark("ensureSchema", start);

    const probeId = "smoke-" + randomBytes(6).toString("hex");
    const probeContent = "probe-" + randomBytes(8).toString("hex");
    const nowIso = new Date().toISOString();

    start = since();
    await withDeadline(
      client.sql.execute(
        "INSERT INTO long_term_memories " +
          "(id, agent_id, entity_id, category, content, metadata, embedding, " +
          "confidence, source, created_at, updated_at, last_accessed_at, access_count) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          probeId,
          AGENT_ID,
          ENTITY_ID,
          "semantic",
          probeContent,
          null,
          null,
          null,
          "live-smoke",
          nowIso,
          nowIso,
          null,
          0,
        ],
      ),
      SQL_BUDGET_MS,
      "client.insert",
    );
    mark("clientInsert", start);

    start = since();
    const selected = await withDeadline(
      client.sql.query("SELECT id, content FROM long_term_memories WHERE id = ?", [probeId]),
      SQL_BUDGET_MS,
      "client.select",
    );
    mark("clientSelect", start);

    const [probeRow] = client.sql.withRowObjects<{ id: string; content: string }>(selected);
    if (!probeRow || probeRow.content !== probeContent) {
      throw new Error(
        `client round-trip mismatch (wrote=${probeContent} read=${probeRow?.content})`,
      );
    }

    // ── STEP 2: storage-level over the SAME client ───────────────────────────
    // Reuse the signed-in client: the service is already past start() (no re-signIn).
    const service = new TinyCloudMemoryStorageService(undefined as never, { client });

    start = since();
    const storedLtm = await withDeadline(
      service.storeLongTermMemory({
        agentId: AGENT_ID,
        entityId: ENTITY_ID,
        category: "semantic",
        content: "live-smoke: agent likes espresso",
        metadata: { topic: "coffee", probe: probeContent },
        confidence: 0.9,
        source: "live-smoke",
      } as never),
      SQL_BUDGET_MS,
      "storeLongTermMemory",
    );
    mark("storeLongTermMemory", start);

    start = since();
    const ltms = await withDeadline(
      service.getLongTermMemories(AGENT_ID as never, ENTITY_ID as never),
      SQL_BUDGET_MS,
      "getLongTermMemories",
    );
    mark("getLongTermMemories", start);

    const foundLtm = ltms.find((m) => m.id === storedLtm.id);
    if (!foundLtm) {
      throw new Error("stored long-term memory not found via getLongTermMemories");
    }
    if (!(foundLtm.createdAt instanceof Date)) {
      throw new Error("getLongTermMemories did not parse createdAt into a Date");
    }
    const ltmMeta = foundLtm.metadata as Record<string, unknown> | undefined;
    if (!ltmMeta || ltmMeta.topic !== "coffee") {
      throw new Error("getLongTermMemories did not parse metadata JSON");
    }

    start = since();
    const storedSummary = await withDeadline(
      service.storeSessionSummary({
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        entityId: ENTITY_ID,
        summary: "live-smoke session summary " + probeContent,
        messageCount: 16,
        lastMessageOffset: 16,
        startTime: new Date(Date.now() - 60_000),
        endTime: new Date(),
        topics: ["coffee"],
        metadata: { keyPoints: ["likes espresso"] },
      } as never),
      SQL_BUDGET_MS,
      "storeSessionSummary",
    );
    mark("storeSessionSummary", start);

    start = since();
    const currentSummary = await withDeadline(
      service.getCurrentSessionSummary(AGENT_ID as never, ROOM_ID as never),
      SQL_BUDGET_MS,
      "getCurrentSessionSummary",
    );
    mark("getCurrentSessionSummary", start);

    if (!currentSummary) {
      throw new Error("getCurrentSessionSummary returned null after a store");
    }
    if (currentSummary.id !== storedSummary.id) {
      throw new Error("getCurrentSessionSummary returned a different summary");
    }
    if (!(currentSummary.startTime instanceof Date)) {
      throw new Error("getCurrentSessionSummary did not parse startTime into a Date");
    }

    // ── STEP 3: verdict ──────────────────────────────────────────────────────
    console.log(
      JSON.stringify(
        { passed: true, spaceId, usingThrowawayKey, timings },
        null,
        2,
      ),
    );
    await client.stop();
    process.exit(0);
  } catch (err) {
    console.log(
      JSON.stringify(
        {
          passed: false,
          spaceId,
          usingThrowawayKey,
          timings,
          error: err instanceof Error ? err.message : String(err),
        },
        null,
        2,
      ),
    );
    try {
      await client.stop();
    } catch {
      // best-effort cleanup; the throwaway space is abandoned regardless.
    }
    process.exit(1);
  }
}

void main();
