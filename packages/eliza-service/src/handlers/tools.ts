// POST /tools/:name handler — discrete tool/action dispatch (Milestone E, §4).
//
// Integration model (handoff §4): Eliza is the agent's TOOL layer, RedPill stays
// the responder. RedPill decides a tool call; tinychat dispatches it here; this
// handler runs the named action's handler DIRECTLY and returns a JSON result —
// it does NOT route a whole turn through compose→model→action→evaluator (that is
// POST /messages, which needs the agent TEXT model). A pure-API tool (web search)
// therefore works in prod with no TEXT model registered.
//
// Result is JSON (not SSE): a tool call resolves to one discrete result, unlike a
// streamed conversational turn.
//
// Errors:
//   tool not found                     -> 404 { error: "tool_not_found" }
//   NoDelegationError (per-user tool)  -> 409 { error: "delegation_required" }
//   DelegationExpiredError             -> 409 { error: "delegation_expired" }
//   ToolError(status, code)            -> status { error: code }
//   anything else                      -> 502 { error: "tool_failed" }

import type { Action, Content, HandlerCallback, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { mapDelegationError } from "../errors.js";

/** Minimal host interface consumed by the tools handler; RuntimeHost satisfies it. */
export interface ToolHandlerHost {
  runtimeFor(agentId: string): Promise<IAgentRuntime>;
}

export interface PostToolBody {
  /**
   * Routing identity. Required only by tools that touch the user's own TinyCloud
   * space (those resolve a per-user delegated client by entityId). Pure-API tools
   * such as web search ignore it.
   */
  entityId?: string;
  roomId?: string;
  /** Tool arguments, e.g. { query } for web search. */
  args?: Record<string, unknown>;
}

export interface ToolResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Error a tool action can throw to control the HTTP response.
 * Use for argument/config/upstream failures the dispatcher should surface verbatim.
 */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * Dispatch a single named action and return its result as JSON.
 *
 * agentId is server-trusted (resolved from the service credential by the caller).
 * The action handler is invoked directly with options.args; any Content the action
 * emits via the callback is collected into `frames`, and its ActionResult text/data
 * (if any) is returned alongside.
 */
export async function handlePostTool(
  toolName: string,
  agentId: string,
  body: PostToolBody,
  host: ToolHandlerHost,
): Promise<ToolResult> {
  const runtime = await host.runtimeFor(agentId);
  const actions: Action[] = runtime.actions ?? [];
  const action = actions.find((a) => a.name.toLowerCase() === toolName.toLowerCase());
  if (!action) {
    return { status: 404, body: { error: "tool_not_found", tool: toolName } };
  }

  // The text seed lets actions that fall back to message.content.text (no explicit
  // args) still work when dispatched with { args: { query } }.
  const seedText = typeof body.args?.query === "string" ? (body.args.query as string) : "";
  const message: Memory = {
    id: crypto.randomUUID() as UUID,
    agentId: agentId as UUID,
    entityId: (body.entityId ?? crypto.randomUUID()) as UUID,
    roomId: (body.roomId ?? crypto.randomUUID()) as UUID,
    content: { text: seedText },
    createdAt: Date.now(),
  };

  const frames: Content[] = [];
  const callback: HandlerCallback = async (content: Content) => {
    frames.push(content);
    return [];
  };

  try {
    const result = await action.handler(
      runtime,
      message,
      undefined,
      { args: body.args ?? {} },
      callback,
      [],
    );

    const text =
      frames.map((f) => f.text ?? "").filter(Boolean).join("\n") ||
      (typeof result?.text === "string" ? result.text : "");

    return {
      status: 200,
      body: {
        ok: true,
        tool: action.name,
        result: {
          text,
          data: result?.data ?? null,
          frames,
        },
      },
    };
  } catch (err) {
    const delegationCode = mapDelegationError(err);
    if (delegationCode) return { status: 409, body: { error: delegationCode } };
    if (err instanceof ToolError) return { status: err.status, body: { error: err.code } };
    return { status: 502, body: { error: "tool_failed" } };
  }
}
