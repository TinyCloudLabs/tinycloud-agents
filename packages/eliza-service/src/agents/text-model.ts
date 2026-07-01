// OpenAI-compatible TEXT model handler for production (plan §4).
//
// Prod historically boots with NO TEXT model registered (memory/tool layer only),
// so POST /messages cannot generate a real response. This wires an optional
// OpenAI-compatible chat-completions handler configured entirely from env:
//
//   MODEL_API_URL   base URL of an OpenAI-compatible API (e.g. https://api.openai.com/v1)
//   MODEL_API_KEY   bearer key
//   MODEL_NAME      model id (optional; defaults to gpt-4o-mini)
//
// If MODEL_API_URL/MODEL_API_KEY are unset, resolveTextModelConfig returns null and
// _bootProduction registers no TEXT model (tools still work; /messages responds
// without a model as before). No silent fallback — a configured-but-broken model
// surfaces its error to the caller rather than degrading quietly.

import type { IAgentRuntime } from "@elizaos/core";

export interface TextModelConfig {
  apiUrl: string;
  apiKey: string;
  modelName: string;
}

const DEFAULT_MODEL_NAME = "gpt-4o-mini";

/** Resolve the TEXT model config from env, or null when not configured. */
export function resolveTextModelConfig(env: NodeJS.ProcessEnv = process.env): TextModelConfig | null {
  const apiUrl = env.MODEL_API_URL?.trim();
  const apiKey = env.MODEL_API_KEY?.trim();
  if (!apiUrl && !apiKey) return null;
  // Partial config is a misconfiguration, not a valid "off" state — fail loudly.
  if (!apiUrl || !apiKey) {
    throw new Error(
      "TEXT model misconfigured: set BOTH MODEL_API_URL and MODEL_API_KEY, or neither",
    );
  }
  return {
    apiUrl: apiUrl.replace(/\/+$/, ""),
    apiKey,
    modelName: env.MODEL_NAME?.trim() || DEFAULT_MODEL_NAME,
  };
}

/** Extract the prompt string from the runtime's useModel params (Eliza passes {prompt}). */
function readPrompt(params: Record<string, unknown>): string {
  const prompt = params.prompt;
  if (typeof prompt === "string") return prompt;
  const messages = params.messages;
  if (Array.isArray(messages)) {
    return messages
      .map((m) => (m && typeof m === "object" ? String((m as { content?: unknown }).content ?? "") : ""))
      .join("\n");
  }
  return "";
}

/**
 * Build a bare registerModel handler that calls an OpenAI-compatible
 * /chat/completions endpoint and returns the assistant text. Signature matches
 * TestModelHandler in runtime-host.ts (runtime, params) => Promise<string>.
 */
export function createTextModelHandler(config: TextModelConfig) {
  return async (_runtime: IAgentRuntime, params: Record<string, unknown>): Promise<string> => {
    const prompt = readPrompt(params);
    const res = await fetch(`${config.apiUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.modelName,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`TEXT model request failed: ${res.status} ${res.statusText} ${detail}`.trim());
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error("TEXT model response missing choices[0].message.content");
    }
    return text;
  };
}
