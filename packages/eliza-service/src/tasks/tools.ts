import type { ResolvedApp } from "../auth/service-auth.js";
import { TINYCHAT_AGENT_ID, TINYCHAT_APP_ID } from "../auth/app-registry.js";
import { parseFindMeetingsArgs, parseListMeetingActionsArgs, parseReadMeetingArgs, parseTranscriptSearchArgs } from "../actions/tinycloud-search-transcripts.js";
import { mapDelegationError } from "../errors.js";
import { handlePostTool, isToolAllowedForApp, type ToolHandlerHost, type ToolResult } from "../handlers/tools.js";
import type { RetrievalContext } from "../meeting-evidence.js";
import { TASK_TOOLS, TaskError, fields, object, type TaskRequest } from "./contract.js";
import { withAbort } from "./provider.js";

export interface TaskToolOptions {
  host: ToolHandlerHost;
  /** Server-resolved identity; never populated from a provider tool call. */
  app: ResolvedApp;
  entityId: string;
  roomId: string;
  allowedTools: readonly string[];
  deadlineAt: number;
  signal: AbortSignal;
  calendar?: TaskRequest["calendar"];
  onActivity?: (event: { tool: string; callId: string; status: "running" | "done" | "error" }) => void;
}
export interface TaskToolCall { id: string; name: string; args: unknown }
const failure = (status: number, error: string): ToolResult => ({ status, body: { error } });

/** Sequential direct-action calls. Retry/evidence decisions remain with the task runner. */
export class TaskTools {
  private count = 0;
  private running = false;
  constructor(private readonly options: TaskToolOptions) {}
  get attempts(): number { return this.count; }

  async execute(call: TaskToolCall, retrievalMode?: RetrievalContext["retrievalMode"]): Promise<ToolResult> {
    const options = this.options;
    this.checkTask();
    const name = typeof call.name === "string" ? call.name.toLowerCase() : "";
    if (options.app.appId !== TINYCHAT_APP_ID || options.app.agentId !== TINYCHAT_AGENT_ID || !(TASK_TOOLS as readonly string[]).includes(name) || !options.allowedTools.includes(name) || !isToolAllowedForApp(name, options.app.appId)) return failure(403, "tool_not_allowed");
    if (typeof call.id !== "string" || call.id.length === 0 || call.id.length > 256 || !validArgs(name, call.args)) return failure(400, "invalid_args");
    if (this.count >= 16) return failure(429, "tool_attempt_limit");
    if (this.running) return failure(409, "tool_already_running");
    const duration = Math.min(10_000, options.deadlineAt - Date.now());
    if (duration <= 0) throw new TaskError("turn_timeout");
    const deadlineAt = Date.now() + duration;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    options.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(onAbort, duration);
    this.running = true;
    this.count++;
    let result: ToolResult;
    try {
      options.onActivity?.({ tool: name, callId: call.id, status: "running" });
      this.checkTask();
      result = await withAbort(handlePostTool(name, options.app.agentId, {
        entityId: options.entityId, roomId: options.roomId, args: call.args as Record<string, unknown>,
        context: { ...options.calendar, ...(retrievalMode ? { retrievalMode } : {}), deadlineAt },
      }, {
        // Include runtime acquisition in the operation budget and deny late dispatch.
        runtimeFor: async agentId => {
          if (abort.signal.aborted) throw new TaskError("task_cancelled");
          const runtime = await withAbort(options.host.runtimeFor(agentId), abort.signal);
          if (abort.signal.aborted) throw new TaskError("task_cancelled");
          this.checkTask();
          return runtime;
        },
      }, { signal: abort.signal }), abort.signal);
      this.checkTask();
      if (abort.signal.aborted) result = failure(408, "retrieval_timeout");
    } catch (error) {
      this.checkTask();
      const delegation = mapDelegationError(error);
      result = abort.signal.aborted ? failure(408, "retrieval_timeout") : delegation ? failure(409, delegation) : failure(502, "tool_failed");
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      this.running = false;
    }
    options.onActivity?.({ tool: name, callId: call.id, status: result.status >= 200 && result.status < 300 ? "done" : "error" });
    return result;
  }

  private checkTask(): void {
    if (this.options.signal.aborted) throw new TaskError("task_cancelled");
    if (Date.now() >= this.options.deadlineAt) throw new TaskError("turn_timeout");
  }
}

function validArgs(name: string, args: unknown): args is Record<string, unknown> {
  if (!object(args)) return false;
  switch (name) {
    case "web_search": return fields(args, ["query"]) && typeof args.query === "string" && args.query.trim().length > 0;
    case "tinycloud_find_meetings": return parseFindMeetingsArgs(args) !== null;
    case "tinycloud_read_meeting": return parseReadMeetingArgs(args) !== null;
    case "tinycloud_search_transcripts": return parseTranscriptSearchArgs(args) !== null;
    case "tinycloud_list_meeting_actions": return parseListMeetingActionsArgs(args) !== null;
    default: return false;
  }
}
