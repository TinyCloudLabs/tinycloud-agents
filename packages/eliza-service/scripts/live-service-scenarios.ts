// Manual live scenarios for @tinycloud/eliza-service.
//
// This file is intentionally inert by default. It makes no network calls unless
// TINYCLOUD_LIVE=1 is set. The live path requires two real, passkey-minted
// delegations to this service's stable agent DID.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IAgentRuntime, Plugin, UUID } from "@elizaos/core";
import { RuntimeHost, SessionStore, startElizaService } from "../src/index.js";

const DEFAULT_HOST = "https://node.tinycloud.xyz";

// ── RedPill-backed TEXT model (HARNESS-ONLY) ──────────────────────────────────
//
// Decision 3 keeps memory text off third-party services in PROD; prod boots with
// NO TEXT model and will wire a TEE/local model. RedPill is acceptable ONLY for
// this live gate, injected via RuntimeHost._modelHandlers (test-only seam) — it is
// NEVER baked into production runtime-host.ts. The key is read from the env at
// runtime (runner sources tinychat/backend/.env) and is never logged.

const REDPILL_DEFAULT_FALLBACK_MODEL = "openai/gpt-4o-mini";

interface RedPillEnv {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function readRedPillEnv(): RedPillEnv | null {
  const apiKey = envString("REDPILL_API_KEY");
  if (!apiKey) return null;
  const baseUrl = (envString("REDPILL_BASE_URL") ?? "https://api.redpill.ai/v1").replace(
    /\/+$/,
    "",
  );
  const model = envString("REDPILL_DEFAULT_MODEL") ?? REDPILL_DEFAULT_FALLBACK_MODEL;
  return { apiKey, baseUrl, model };
}

/**
 * Build a bare registerModel handler that proxies to RedPill's OpenAI-compatible
 * /chat/completions endpoint. Returns the assistant message content (string).
 *
 * - Forwards `responseFormat: { type: "json_object" }` when the caller (the
 *   advanced-memory evaluator) asks for JSON, so the merged-evaluator schema call
 *   gets a parseable object back.
 * - Never logs the API key or the model/memory text.
 */
function makeRedPillHandler(env: RedPillEnv) {
  return async (_runtime: IAgentRuntime, params: Record<string, unknown>): Promise<string> => {
    const prompt =
      typeof params.prompt === "string"
        ? params.prompt
        : typeof params.input === "string"
          ? params.input
          : "";

    const responseFormat = params.responseFormat as { type?: string } | undefined;
    const wantsJson = responseFormat?.type === "json_object";
    // The post-turn evaluator passes the merged JSON schema. We CANNOT forward it as
    // a strict json_schema response_format: the runtime merges ALL registered
    // evaluators' schemas, and some nested array items omit additionalProperties,
    // which OpenAI strict mode rejects with HTTP 400 → empty completion → nothing
    // stored (observed live). Instead we keep json_object mode and inline the schema
    // as an explicit instruction so the model emits the exact required shape
    // ({"longTermMemory":{"memories":[{"category","content","confidence"}]}}) rather
    // than a bare array or a `text` field, which the evaluator's parser would drop.
    const responseSchema = params.responseSchema as Record<string, unknown> | undefined;

    const messages: Array<{ role: string; content: string }> = [];
    if (responseSchema && typeof responseSchema === "object") {
      messages.push({
        role: "system",
        content:
          "You are a strict JSON generator. Respond with a single JSON object that " +
          "exactly matches this JSON Schema. For every property that is an object " +
          "with a `memories` array, each memory MUST use the keys `category`, " +
          "`content`, and `confidence` (do not rename `content` to `text`, and do " +
          "not return a bare array). Output JSON only, no prose.\n\nJSON Schema:\n" +
          JSON.stringify(responseSchema),
      });
    }
    messages.push({ role: "user", content: prompt });

    const body: Record<string, unknown> = {
      model: env.model,
      messages,
      // Reasoning-class models (e.g. gpt-5-mini) spend output tokens on hidden
      // reasoning before emitting content. With a tight budget on the long post-turn
      // evaluator prompt the model can return an EMPTY completion (finish_reason
      // "length") → parsed as null → nothing stored. A generous budget leaves room.
      max_completion_tokens: 16000,
    };
    // NOTE: deliberately do NOT forward `temperature`. The evaluator passes
    // temperature:0, but reasoning-class models reject any non-default temperature.
    // Omitting it lets the model use its default.
    if (responseSchema || wantsJson) {
      body.response_format = { type: "json_object" };
    }

    const response = await fetch(`${env.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // Redact any echoed bearer token; never surface the key.
      const detail = redact(await response.text());
      throw new Error(`RedPill chat/completions failed: HTTP ${response.status}: ${detail}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("RedPill chat/completions returned no string content");
    }
    if (envString("LIVE_DEBUG") === "1") {
      // Diagnostic only (no key, no memory text beyond the model's own structured
      // echo). Shows whether the evaluator's schema reached the handler and what
      // shape came back.
      const hasSchema = Boolean(responseSchema);
      const isEvalCall = content.includes("longTermMemory") || hasSchema;
      if (isEvalCall) {
        console.error(`[redpill] evalCall hasSchema=${hasSchema} out=${content.slice(0, 240)}`);
      } else {
        console.error(`[redpill] textCall len=${content.length}`);
      }
    }
    return content;
  };
}
const DEFAULT_AGENT_KEY_FILE = new URL("../../../.tinycloud/agent.key", import.meta.url)
  .pathname;
const DEFAULT_DELEGATION_FILE_A = new URL(
  "../../eliza-plugin-memory/.tinycloud/delegation-A.json",
  import.meta.url,
).pathname;
const DEFAULT_DELEGATION_FILE_B = new URL(
  "../../eliza-plugin-memory/.tinycloud/delegation-B.json",
  import.meta.url,
).pathname;

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const ENTITY_A = "aa000000-0000-4000-8000-000000000001" as UUID;
const ENTITY_B = "bb000000-0000-4000-8000-000000000002" as UUID;
const ROOM_A = "cc000000-0000-4000-8000-000000000003" as UUID;
const ROOM_B = "dd000000-0000-4000-8000-000000000004" as UUID;

interface ScenarioSummary {
  passed: boolean;
  summary: string;
  skipped?: boolean;
  /** Distinguishes an environment-gating BLOCKED outcome from a true FAIL. */
  blocked?: boolean;
  reason?: string;
  details?: unknown;
}

interface MemoryProbe {
  getLongTermMemories(
    agentId: UUID,
    entityId: UUID,
    opts?: { category?: string; limit?: number },
  ): Promise<Array<{ id: UUID; content?: string; summary?: string; metadata?: unknown }>>;
}

function envString(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value === "" ? undefined : value;
}

async function loadPluginSql(): Promise<Plugin> {
  try {
    const mod = await import("@elizaos/plugin-sql");
    return pluginFromModule(mod);
  } catch {
    const mod = await import(
      new URL("../node_modules/@elizaos/plugin-sql/src/dist/node/index.node.js", import.meta.url)
        .href
    );
    return pluginFromModule(mod);
  }
}

function pluginFromModule(mod: unknown): Plugin {
  const plugin = (
    mod as {
      default?: Plugin;
      sqlPlugin?: Plugin;
      plugin?: Plugin;
    }
  ).default ?? (mod as { sqlPlugin?: Plugin }).sqlPlugin ?? (mod as { plugin?: Plugin }).plugin;

  if (!plugin) {
    throw new Error("@tinycloud/eliza-service live harness: plugin-sql export not found");
  }
  return plugin;
}

async function readDelegation(path: string): Promise<string> {
  return (await readFile(path, "utf8")).trim();
}

async function postJson<T>(url: string, body: unknown, label: string): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${redact(text)}`);
  }

  return (text ? JSON.parse(text) : null) as T;
}

async function postMessage(url: string, body: unknown, label: string): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${redact(text)}`);
  }
  if (!text.includes("data: [DONE]")) {
    throw new Error(`${label} did not finish with an SSE [DONE] frame`);
  }

  return text;
}

function redact(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [REDACTED]")
    .replace(/0x[0-9a-fA-F]{64}/g, "0x[REDACTED]");
}

/** Send one /messages turn and assert the SSE stream completes. */
async function sendTurn(
  baseUrl: string,
  entityId: UUID,
  roomId: UUID,
  text: string,
  label: string,
): Promise<string> {
  return postMessage(
    `${baseUrl}/messages`,
    { agentId: AGENT_ID, entityId, roomId, text },
    label,
  );
}

/** Poll getLongTermMemories until `token` appears or `timeoutMs` elapses. */
async function pollForToken(
  storage: MemoryProbe,
  entityId: UUID,
  token: string,
  timeoutMs: number,
): Promise<{ found: boolean; memories: unknown[] }> {
  const deadline = Date.now() + timeoutMs;
  let memories: Awaited<ReturnType<MemoryProbe["getLongTermMemories"]>> = [];
  for (;;) {
    memories = await storage.getLongTermMemories(AGENT_ID, entityId, { limit: 50 });
    if (memories.some((memory) => JSON.stringify(memory).includes(token))) {
      return { found: true, memories };
    }
    if (Date.now() >= deadline) {
      return { found: false, memories };
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function runLive(): Promise<ScenarioSummary> {
  const agentKeyFile = envString("TINYCLOUD_AGENT_KEY_FILE") ?? DEFAULT_AGENT_KEY_FILE;
  const delegationFileA = envString("DELEGATION_FILE_A") ?? DEFAULT_DELEGATION_FILE_A;
  const delegationFileB = envString("DELEGATION_FILE_B") ?? DEFAULT_DELEGATION_FILE_B;
  const hostUrl = envString("TINYCLOUD_HOST") ?? DEFAULT_HOST;
  const scenarioId = randomBytes(6).toString("hex");

  // Distinctive proper-noun tokens the LLM preserves verbatim — these prove REAL
  // extraction (not an echoed opaque marker) AND per-user isolation.
  const tokenA = `FALCON-${scenarioId}`;
  const tokenB = `OSPREY-${scenarioId}`;
  const factA = `Please remember this fact about me: my project codename is ${tokenA}.`;
  const factB = `Please remember this fact about me: my project codename is ${tokenB}.`;

  // RedPill is REQUIRED for this gate (it drives the real extraction model). If the
  // key is absent the gate is BLOCKED, not a fake pass.
  const redpill = readRedPillEnv();
  if (!redpill) {
    return {
      passed: false,
      blocked: true,
      summary: "BLOCKED: REDPILL_API_KEY not set — cannot drive real extraction.",
      details: {
        blocker: "redpill_env_missing",
        hint: "set -a; source tinychat/backend/.env; set +a (REDPILL_API_KEY/REDPILL_BASE_URL/REDPILL_DEFAULT_MODEL)",
      },
    };
  }

  const [serializedA, serializedB, sqlPlugin] = await Promise.all([
    readDelegation(delegationFileA),
    readDelegation(delegationFileB),
    loadPluginSql(),
  ]);

  // TEST-ONLY: register a RedPill TEXT model and lower the extraction threshold so
  // the advanced-memory long-term evaluator fires deterministically per turn. The
  // evaluator makes a single useModel(TEXT_LARGE) call; the response pipeline also
  // prefers TEXT_LARGE. TEXT_SMALL/TEXT_NANO are registered so the summary
  // evaluator (TEXT_NANO→TEXT_SMALL fallback) and other pipeline paths resolve too.
  const redpillHandler = makeRedPillHandler(redpill);
  const runtimeHost = new RuntimeHost({
    agentKeyFile,
    host: hostUrl,
    sqlPlugin,
    _modelHandlers: {
      TEXT_LARGE: redpillHandler,
      TEXT_SMALL: redpillHandler,
      TEXT_NANO: redpillHandler,
    },
    _extraSettings: {
      // Default threshold=30/interval=10 (≈15 turns). Lower so a single fact-bearing
      // turn crosses the bar and re-fires each subsequent turn.
      MEMORY_EXTRACTION_THRESHOLD: "1",
      MEMORY_EXTRACTION_INTERVAL: "1",
      MEMORY_LONG_TERM_ENABLED: "true",
    },
  });
  await runtimeHost.init();
  const sessions = new SessionStore();
  const server = startElizaService({
    host: runtimeHost,
    sessions,
    hostname: "127.0.0.1",
    port: 0,
    // Real model + post-turn extraction per turn can exceed Bun's 10s default,
    // which would close the SSE stream mid-turn. Raise the idle timeout.
    idleTimeout: 240,
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;

  try {
    const sessionA = await postJson<{ status: string }>(
      `${baseUrl}/sessions`,
      {
        agentId: AGENT_ID,
        entityId: ENTITY_A,
        serializedDelegation: serializedA,
        roomId: ROOM_A,
      },
      "POST /sessions user A",
    );
    const sessionB = await postJson<{ status: string }>(
      `${baseUrl}/sessions`,
      {
        agentId: AGENT_ID,
        entityId: ENTITY_B,
        serializedDelegation: serializedB,
        roomId: ROOM_B,
      },
      "POST /sessions user B",
    );

    console.log(
      `[live] sessions active (A=${sessionA.status}, B=${sessionB.status}); ` +
        `sending fact-bearing turns through POST /messages…`,
    );

    // Send the personal fact, then check extraction; repeat per-user until both
    // tokens land or the attempt budget is exhausted. Each turn appends ≥1 message
    // memory, crossing the (lowered) extraction threshold + interval so the
    // post-turn long-term evaluator re-fires every turn. Looping de-flakes the
    // inherent per-turn LLM variance (one user may extract before the other).
    const storage = (await runtimeHost.storageFor(AGENT_ID)) as unknown as MemoryProbe;
    const MAX_ROUNDS = 8;
    let sseA = "";
    let sseB = "";
    let resultA: Awaited<ReturnType<typeof pollForToken>> = { found: false, memories: [] };
    let resultB: Awaited<ReturnType<typeof pollForToken>> = { found: false, memories: [] };

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      // Only keep messaging the user whose token has not landed yet.
      const sends: Array<Promise<void>> = [];
      if (!resultA.found) {
        sends.push(
          sendTurn(baseUrl, ENTITY_A, ROOM_A, factA, `POST /messages user A (round ${round})`).then(
            (sse) => {
              sseA = sse;
            },
          ),
        );
      }
      if (!resultB.found) {
        sends.push(
          sendTurn(baseUrl, ENTITY_B, ROOM_B, factB, `POST /messages user B (round ${round})`).then(
            (sse) => {
              sseB = sse;
            },
          ),
        );
      }
      await Promise.all(sends);
      console.log(`[live] round ${round}/${MAX_ROUNDS} streamed`);

      // Extraction + the long-term write are async and serialize through B's lane.
      // Poll each not-yet-found user's OWN space for a short window before re-sending.
      const polls: Array<Promise<void>> = [];
      if (!resultA.found) {
        polls.push(
          pollForToken(storage, ENTITY_A, tokenA, 15_000).then((r) => {
            resultA = r;
          }),
        );
      }
      if (!resultB.found) {
        polls.push(
          pollForToken(storage, ENTITY_B, tokenB, 15_000).then((r) => {
            resultB = r;
          }),
        );
      }
      await Promise.all(polls);
      console.log(
        `[live] round ${round} extraction status: aFound=${resultA.found} bFound=${resultB.found}`,
      );
      if (resultA.found && resultB.found) break;
    }

    // Refresh both reads once more so the isolation check sees the final state.
    if (!resultA.memories.length || !resultA.found) {
      resultA = await pollForToken(storage, ENTITY_A, tokenA, 0);
    }
    if (!resultB.memories.length || !resultB.found) {
      resultB = await pollForToken(storage, ENTITY_B, tokenB, 0);
    }

    const aFoundOwn = resultA.found;
    const bFoundOwn = resultB.found;
    // Isolation: A's space must NOT contain B's token and vice-versa.
    const aSeesB = resultA.memories.some((memory) => JSON.stringify(memory).includes(tokenB));
    const bSeesA = resultB.memories.some((memory) => JSON.stringify(memory).includes(tokenA));

    const passed =
      sessionA.status === "active"
      && sessionB.status === "active"
      && sseA.includes("data: [DONE]")
      && sseB.includes("data: [DONE]")
      && aFoundOwn
      && bFoundOwn
      && !aSeesB
      && !bSeesA;

    return {
      passed,
      summary: passed
        ? "PASS: eliza-service live extraction → per-user space → isolation proven end-to-end."
        : "FAIL: eliza-service live extraction scenario did not prove per-user isolation.",
      details: {
        host: hostUrl,
        agentDid: runtimeHost.agentDid,
        extractionModel: redpill.model,
        sessionA: sessionA.status,
        sessionB: sessionB.status,
        sseACompleted: sseA.includes("data: [DONE]"),
        sseBCompleted: sseB.includes("data: [DONE]"),
        tokensProbed: { tokenA, tokenB },
        perUserExtraction: {
          aFoundOwn,
          aSeesB,
          bFoundOwn,
          bSeesA,
          crossReadsEmpty: !aSeesB && !bSeesA,
          aMemoryCount: resultA.memories.length,
          bMemoryCount: resultB.memories.length,
        },
      },
    };
  } finally {
    await server.stop(true);
    await runtimeHost.stop();
  }
}

async function run(): Promise<void> {
  if (envString("TINYCLOUD_LIVE") !== "1") {
    const skipped: ScenarioSummary = {
      passed: true,
      skipped: true,
      summary: "SKIP: eliza-service live harness is gated.",
      reason: "set TINYCLOUD_LIVE=1 with TINYCLOUD_AGENT_KEY_FILE, DELEGATION_FILE_A, and DELEGATION_FILE_B",
    };
    console.log(JSON.stringify(skipped, null, 2));
    return;
  }

  const result = await runLive();
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exit(1);
}

void run().catch((err) => {
  console.log(
    JSON.stringify(
      {
        passed: false,
        summary: "FAIL: eliza-service live HTTP delegation scenario errored.",
        error: redact(err instanceof Error ? err.message : String(err)),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
