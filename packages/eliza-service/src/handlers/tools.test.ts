import { afterEach, describe, expect, it } from "bun:test";
import type { Action, IAgentRuntime } from "@elizaos/core";
import { NoDelegationError } from "@tinycloud/eliza-plugin-memory";
import { handlePostTool, ToolError, type ToolHandlerHost } from "./tools.js";
import { webSearchAction } from "../actions/web-search.js";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function hostWithActions(actions: Action[]): ToolHandlerHost {
  const runtime = { agentId: AGENT_ID, actions } as unknown as IAgentRuntime;
  return { runtimeFor: async () => runtime };
}

describe("handlePostTool", () => {
  it("returns 404 for an unknown tool", async () => {
    const host = hostWithActions([]);
    const result = await handlePostTool("nope", AGENT_ID, { args: {} }, host);
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "tool_not_found", tool: "nope" });
  });

  it("matches the action name case-insensitively and returns collected frames", async () => {
    const action = {
      name: "ECHO",
      description: "test",
      validate: async () => true,
      handler: async (_r, _m, _s, options, callback) => {
        const args = (options as { args?: { value?: string } }).args ?? {};
        if (callback) await callback({ text: `echo:${args.value}` });
        return { success: true, text: `echo:${args.value}`, data: { value: args.value } };
      },
    } as unknown as Action;

    const result = await handlePostTool("echo", AGENT_ID, { args: { value: "hi" } }, hostWithActions([action]));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      tool: "ECHO",
      result: { text: "echo:hi", data: { value: "hi" } },
    });
  });

  it("maps a NoDelegationError thrown by the action to 409", async () => {
    const action = {
      name: "NEEDS_DELEGATION",
      description: "test",
      validate: async () => true,
      handler: async () => {
        throw new NoDelegationError("entity-1");
      },
    } as unknown as Action;

    const result = await handlePostTool("needs_delegation", AGENT_ID, {}, hostWithActions([action]));
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: "delegation_required" });
  });

  it("surfaces a ToolError's status and code", async () => {
    const action = {
      name: "BAD",
      description: "test",
      validate: async () => true,
      handler: async () => {
        throw new ToolError("boom", 502, "tool_upstream_error");
      },
    } as unknown as Action;

    const result = await handlePostTool("bad", AGENT_ID, {}, hostWithActions([action]));
    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: "tool_upstream_error" });
  });

  it("maps an unexpected throw to 502 tool_failed", async () => {
    const action = {
      name: "THROWS",
      description: "test",
      validate: async () => true,
      handler: async () => {
        throw new Error("unexpected");
      },
    } as unknown as Action;

    const result = await handlePostTool("throws", AGENT_ID, {}, hostWithActions([action]));
    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: "tool_failed" });
  });
});

describe("webSearchAction", () => {
  const realFetch = globalThis.fetch;
  const savedKey = process.env.TAVILY_API_KEY;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = savedKey;
  });

  it("throws tool_misconfigured when TAVILY_API_KEY is absent", async () => {
    delete process.env.TAVILY_API_KEY;
    const host: ToolHandlerHost = hostWithActions([webSearchAction]);
    const result = await handlePostTool("web_search", AGENT_ID, { args: { query: "x" } }, host);
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "tool_misconfigured" });
  });

  it("returns the Tavily answer as the summarized result text", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          answer: "Paris is the capital of France.",
          results: [{ title: "France", url: "https://ex.com", content: "..." }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const host: ToolHandlerHost = hostWithActions([webSearchAction]);
    const result = await handlePostTool(
      "web_search",
      AGENT_ID,
      { args: { query: "capital of France" } },
      host,
    );

    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; tool: string; result: { text: string; data: { answer: string } } };
    expect(body.ok).toBe(true);
    expect(body.tool).toBe("WEB_SEARCH");
    expect(body.result.text).toBe("Paris is the capital of France.");
    expect(body.result.data.answer).toBe("Paris is the capital of France.");
  });

  it("maps a non-200 Tavily response to 502 tool_upstream_error", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;

    const host: ToolHandlerHost = hostWithActions([webSearchAction]);
    const result = await handlePostTool("web_search", AGENT_ID, { args: { query: "x" } }, host);
    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: "tool_upstream_error" });
  });

  it("rejects an empty query with invalid_args", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    const host: ToolHandlerHost = hostWithActions([webSearchAction]);
    const result = await handlePostTool("web_search", AGENT_ID, { args: { query: "   " } }, host);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "invalid_args" });
  });
});
