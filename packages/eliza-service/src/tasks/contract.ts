import { isToolAllowedForApp } from "../handlers/tools.js";

export const TASK_BODY_BYTES = 1_048_576 + 16_384;
export const TASK_FRAME_BYTES = 131_072;
export const TASK_TEXT_CHARS = 64_000;
export const ACCOUNTING_GRACE_MS = 2_000;
export const TASK_TOOLS = ["web_search", "tinycloud_find_meetings", "tinycloud_read_meeting", "tinycloud_search_transcripts", "tinycloud_list_meeting_actions"] as const;

export interface TaskMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}
export interface TaskRequest {
  version: 1;
  executionId: string;
  entityId: string;
  roomId?: string;
  model: { id: string; contextWindowTokens: number };
  messages: TaskMessage[];
  calendar?: { localDate: string; timeZone: string };
  allowedTools: string[];
  deadlineAt: number;
}
export interface TaskConfig {
  apiKey: string;
  baseUrl: string;
  models: Record<string, number>;
  maxDurationMs?: number;
  capacity?: number;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}
export interface UsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  startedAttempts: number;
  reportedAttempts: number;
  finalizedAttempts: number;
  usageCompleteness: "complete" | "partial";
}
export class TaskError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function fields(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
export function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
/** Existing ElizaOS routing IDs force a version-0 nibble; execution IDs do not. */
export function entityUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function message(value: unknown): value is TaskMessage {
  if (!object(value) || !fields(value, ["role", "content", "tool_call_id", "tool_calls"]) || !["user", "assistant", "system", "tool"].includes(value.role as string) || typeof value.content !== "string") return false;
  if (value.role === "tool" ? !text(value.tool_call_id) : value.tool_call_id !== undefined) return false;
  if (value.tool_calls !== undefined) {
    if (value.role !== "assistant" || !Array.isArray(value.tool_calls) || value.tool_calls.length === 0) return false;
    if (!value.tool_calls.every(call => object(call) && fields(call, ["id", "type", "function"]) && text(call.id) && call.type === "function" && object(call.function) && fields(call.function, ["name", "arguments"]) && text(call.function.name) && typeof call.function.arguments === "string")) return false;
  }
  return true;
}
function calendar(value: unknown): boolean {
  if (!object(value) || !fields(value, ["localDate", "timeZone"]) || typeof value.localDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.localDate) || typeof value.timeZone !== "string" || value.timeZone.length > 100) return false;
  const date = new Date(`${value.localDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.localDate) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value.timeZone }); return true; } catch { return false; }
}

export function validateTask(value: unknown, config: TaskConfig, appId: string): TaskRequest {
  if (!object(value) || !fields(value, ["version", "executionId", "entityId", "roomId", "model", "messages", "calendar", "allowedTools", "deadlineAt"]) || value.version !== 1 || !uuid(value.executionId) || !entityUuid(value.entityId)) throw new TaskError("invalid_task");
  if (value.roomId !== undefined && (!text(value.roomId) || value.roomId.length > 256)) throw new TaskError("invalid_room");
  if (!object(value.model) || !fields(value.model, ["id", "contextWindowTokens"]) || !text(value.model.id) || !Number.isSafeInteger(value.model.contextWindowTokens) || (value.model.contextWindowTokens as number) <= 0) throw new TaskError("invalid_model");
  const allowedContext = Object.prototype.hasOwnProperty.call(config.models, value.model.id) ? config.models[value.model.id] : undefined;
  if (!allowedContext || (value.model.contextWindowTokens as number) > allowedContext) throw new TaskError("model_not_allowed", 403);
  if (!Array.isArray(value.messages) || value.messages.length === 0 || !value.messages.every(message)) throw new TaskError("invalid_messages");
  if (value.calendar !== undefined && !calendar(value.calendar)) throw new TaskError("invalid_calendar");
  if (!Array.isArray(value.allowedTools) || new Set(value.allowedTools).size !== value.allowedTools.length || !value.allowedTools.every(name => typeof name === "string" && (TASK_TOOLS as readonly string[]).includes(name) && isToolAllowedForApp(name, appId))) throw new TaskError("tool_not_allowed", 403);
  if (!Number.isSafeInteger(value.deadlineAt) || (value.deadlineAt as number) <= Date.now()) throw new TaskError("expired_task");
  const admitted = value as unknown as TaskRequest;
  return { ...admitted, messages: fitContext(admitted.messages, admitted.model.contextWindowTokens) };
}

/** Preserve the existing protected history policy, then fail explicitly if it cannot fit. */
function fitContext(messages: TaskMessage[], contextTokens: number): TaskMessage[] {
  const result = [...messages];
  const estimate = () => result.reduce((sum, item) => sum + Math.ceil(JSON.stringify(item).length / 4), 0);
  while (estimate() > contextTokens * 0.7) {
    const firstUser = result.findIndex(item => item.role === "user");
    let lastUser = -1;
    for (let i = result.length - 1; i >= 0; i--) if (result[i].role === "user") { lastUser = i; break; }
    const drop = result.findIndex((item, i) => i < result.length - 6 && item.role !== "system" && i !== firstUser && i !== lastUser);
    if (drop < 0) throw new TaskError("context_size_limit");
    result.splice(drop, 1);
  }
  return result;
}

export function taskConfigFromEnv(env: Record<string, string | undefined> = process.env): TaskConfig | undefined {
  if (!env.REDPILL_API_KEY || !env.ELIZA_TASK_MODELS_JSON) return undefined;
  let models: unknown;
  try { models = JSON.parse(env.ELIZA_TASK_MODELS_JSON); } catch { throw new TaskError("invalid_task_configuration"); }
  const config = { apiKey: env.REDPILL_API_KEY, baseUrl: env.REDPILL_BASE_URL ?? "https://api.redpill.ai/v1", models: models as Record<string, number> };
  assertTaskConfig(config);
  return config;
}
export function assertTaskConfig(config: TaskConfig): void {
  if (!config.apiKey || !object(config.models) || Object.keys(config.models).length === 0 || !Object.entries(config.models).every(([id, count]) => id.length > 0 && Number.isSafeInteger(count) && count > 0) || !Number.isSafeInteger(config.maxDurationMs ?? 300_000) || (config.maxDurationMs ?? 300_000) <= 0 || (config.maxDurationMs ?? 300_000) > 300_000 || !Number.isSafeInteger(config.capacity ?? 1_000) || (config.capacity ?? 1_000) <= 0) throw new TaskError("invalid_task_configuration");
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { throw new TaskError("invalid_task_configuration"); }
  if (url.username || url.password || !["https:", "http:"].includes(url.protocol) || (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new TaskError("invalid_task_configuration");
}
