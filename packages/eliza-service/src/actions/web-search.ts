// Web search action (Tavily) — the first agent tool (Milestone E, §4).
//
// Pure-API: the handler calls Tavily directly and never invokes runtime.useModel,
// so it runs in production with NO TEXT model registered (decision 3 / handoff §4.1)
// and needs NO per-user delegation (external API, touches no user space).
//
// Dispatched via POST /tools/web_search (handlers/tools.ts). RedPill emits the
// tool call; tinychat couriers it here; the summarized result flows back into the
// RedPill turn.

import type { Action, Content, Memory, Plugin } from "@elizaos/core";
import { ToolError } from "../handlers/tools.js";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const MAX_RESULTS = 5;

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

interface TavilyResponse {
  answer?: string;
  results?: TavilyResult[];
}

/** Read the query from explicit tool args first, else fall back to message text. */
function readQuery(message: Memory, options: unknown): string {
  const args = (options as { args?: Record<string, unknown> } | undefined)?.args;
  const fromArgs = args && typeof args.query === "string" ? args.query : undefined;
  const fromMessage = typeof message.content?.text === "string" ? message.content.text : undefined;
  return (fromArgs ?? fromMessage ?? "").trim();
}

/** Prefer Tavily's synthesized answer; otherwise summarize the top results. */
function summarize(data: TavilyResponse): string {
  if (data.answer && data.answer.trim()) return data.answer.trim();
  const top = (data.results ?? [])
    .slice(0, 3)
    .map(
      (r) =>
        `- ${r.title ?? "(untitled)"}: ${(r.content ?? "").slice(0, 280)}` +
        (r.url ? ` (${r.url})` : ""),
    )
    .join("\n");
  return top || "No results found.";
}

export const webSearchAction: Action = {
  name: "WEB_SEARCH",
  description:
    "Search the public web via Tavily and return a concise summary plus source links. " +
    "Use for current events, facts, and anything outside the model's knowledge.",
  similes: ["SEARCH_WEB", "SEARCH", "GOOGLE", "LOOKUP"],
  routingHint: "current events / facts / 'search the web for X' -> WEB_SEARCH; no delegation needed",
  examples: [],
  validate: async (_runtime, message, _state, options) => readQuery(message, options).length > 0,
  handler: async (_runtime, message, _state, options, callback) => {
    const query = readQuery(message, options);
    if (!query) {
      throw new ToolError("web_search: empty query", 400, "invalid_args");
    }
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new ToolError("web_search: TAVILY_API_KEY not configured", 500, "tool_misconfigured");
    }

    let res: Response;
    try {
      res = await fetch(TAVILY_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: MAX_RESULTS,
          include_answer: true,
          search_depth: "basic",
        }),
      });
    } catch {
      throw new ToolError("web_search: upstream request failed", 502, "tool_upstream_error");
    }
    if (!res.ok) {
      throw new ToolError(`web_search: tavily responded ${res.status}`, 502, "tool_upstream_error");
    }

    const data = (await res.json()) as TavilyResponse;
    const text = summarize(data);
    const content: Content = { text };
    if (callback) await callback(content);

    return {
      success: true,
      text,
      data: {
        query,
        answer: data.answer ?? null,
        results: (data.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
          title: r.title ?? null,
          url: r.url ?? null,
          snippet: r.content ?? null,
        })),
      },
    };
  },
};

export const webSearchPlugin: Plugin = {
  name: "tinycloud-web-search",
  description: "Web search tool (Tavily) exposed as an agent action for tool dispatch.",
  actions: [webSearchAction],
};
