import type { SessionStore, SessionLease, SessionScope } from "../session-store.js";
import type { ResolvedApp } from "../auth/service-auth.js";
import { TINYCHAT_APP_ID } from "../auth/app-registry.js";
import { ACCOUNTING_GRACE_MS, TASK_BODY_BYTES, TASK_FRAME_BYTES, TaskError, assertTaskConfig, entityUuid, fields, object, uuid, validateTask, type TaskConfig, type TaskRequest } from "../tasks/contract.js";
import { withAbort } from "../tasks/provider.js";
import { runTask, TaskUsage } from "../tasks/runner.js";
import { TaskTools } from "../tasks/tools.js";
import type { ToolHandlerHost } from "./tools.js";

type CancelReason = "client_cancelled" | "turn_timeout" | "transport_failed";
interface Registration { entityKey: string; lease?: SessionLease; abort: AbortController; terminal: boolean; expiresAt: number; roomKey?: string; reason?: CancelReason }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** One service process owns active IDs and content-free terminal tombstones. */
export class TaskHandler {
  private readonly registrations = new Map<string, Registration>();
  private readonly activeRooms = new Set<string>();
  constructor(private readonly config?: TaskConfig, private readonly host?: ToolHandlerHost, private readonly sessions?: SessionStore) { if (config) assertTaskConfig(config); }

  capabilities(app: ResolvedApp) {
    const enabled = app.appId === TINYCHAT_APP_ID && this.config !== undefined;
    return { version: 1, enabled, cancellation: true, providerProfile: "tinychat-redpill", models: enabled ? Object.keys(this.config!.models) : [] };
  }

  async post(request: Request, app: ResolvedApp): Promise<Response> {
    if (app.appId !== TINYCHAT_APP_ID) return json(403, { error: "forbidden" });
    if (!this.config) return json(503, { error: "tasks_unavailable" });
    try {
      if (request.signal.aborted) throw new TaskError("cancelled_before_admission");
      const body = validateTask(await readBody(request, TASK_BODY_BYTES), this.config, app.appId);
      if (request.signal.aborted) throw new TaskError("cancelled_before_admission");
      const duration = Math.min(body.deadlineAt - Date.now(), this.config.maxDurationMs ?? 300_000);
      if (duration <= 0) throw new TaskError("expired_task");
      const deadlineAt = Date.now() + duration;
      this.prune();
      const key = this.key(app, body.entityId, body.executionId);
      if (this.registrations.has(key)) return json(409, { error: "duplicate_execution" });
      if (this.registrations.size >= (this.config.capacity ?? 1_000)) return json(429, { error: "task_capacity" });
      // Existing room selection is mutable and shared by direct tool calls.
      // Serialize overlapping room work, including attempts from another entity.
      const roomKey = body.roomId ? JSON.stringify([app.appId, app.agentId, body.roomId]) : undefined;
      if (roomKey && this.activeRooms.has(roomKey)) return json(409, { error: "room_busy" });
      const lease = this.sessions?.lease(app, body.entityId);
      const active = lease ? lease.active && lease.isActive() && this.host?.privateAccessAvailable?.(app.agentId, body.entityId) === true && (body.accessRevision === undefined || body.accessRevision === lease.revision) : false;
      const admitted = { ...body, allowedTools: body.allowedTools.filter(name => name === "web_search" || active) };
      const registration: Registration = { entityKey: JSON.stringify([app.appId, app.agentId, body.entityId]), lease, abort: new AbortController(), terminal: false, expiresAt: deadlineAt + ACCOUNTING_GRACE_MS, roomKey };
      this.registrations.set(key, registration);
      if (roomKey) this.activeRooms.add(roomKey);
      return this.stream(request, app, { ...admitted, deadlineAt, roomId: body.roomId ?? `task:${body.executionId}` }, registration, duration);
    } catch (error) {
      return json(error instanceof TaskError ? error.status : 400, { error: error instanceof TaskError ? error.code : "invalid_task" });
    }
  }

  async cancel(request: Request, app: ResolvedApp, executionId: string): Promise<Response> {
    if (app.appId !== TINYCHAT_APP_ID) return json(403, { error: "forbidden" });
    try {
      const body = await readBody(request, 16_384);
      if (!uuid(executionId) || !object(body) || !fields(body, ["version", "entityId", "reason"]) || body.version !== 1 || !entityUuid(body.entityId) || !["client_cancelled", "turn_timeout", "transport_failed"].includes(body.reason as string)) throw new TaskError("invalid_cancel");
      this.prune();
      const registration = this.registrations.get(this.key(app, body.entityId, executionId));
      if (!registration) return json(404, { error: "task_not_found" });
      this.abort(registration, body.reason as CancelReason);
      return json(200, { version: 1, executionId, cancelled: true });
    } catch (error) { return json(400, { error: error instanceof TaskError ? error.code : "invalid_cancel" }); }
  }

  cancelEntity(scope: SessionScope, entityId: string): void {
    const key = JSON.stringify([scope.appId, scope.agentId, entityId]);
    for (const entry of this.registrations.values()) if (entry.entityKey === key) this.abort(entry, "client_cancelled");
  }

  private key(app: ResolvedApp, entityId: string, executionId: string): string {
    return JSON.stringify([app.appId, app.agentId, entityId.toLowerCase(), executionId.toLowerCase()]);
  }
  private prune(): void {
    for (const [key, entry] of this.registrations) if (entry.terminal && entry.expiresAt <= Date.now()) this.registrations.delete(key);
  }
  private abort(entry: Registration, reason: CancelReason): void {
    if (entry.terminal || entry.abort.signal.aborted) return;
    entry.reason = reason;
    entry.abort.abort();
  }

  private stream(request: Request, app: ResolvedApp, body: TaskRequest, entry: Registration, duration: number): Response {
    const encoder = new TextEncoder();
    let closed = false;
    let seq = 0;
    const onAbort = () => this.abort(entry, "transport_failed");
    request.signal.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => this.abort(entry, "turn_timeout"), duration);
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        const send = (type: string, payload: object) => {
          if (closed) throw new TaskError("task_cancelled");
          if (type !== "usage" && type !== "final" && entry.lease && !entry.lease.isCurrent()) throw new TaskError("task_cancelled");
          const frame = encoder.encode(`data: ${JSON.stringify({ type, executionId: body.executionId, seq: ++seq, ...payload })}\n\n`);
          if (frame.byteLength > TASK_FRAME_BYTES) throw new TaskError("result_size_limit");
          // Leave final accounting room even when content delivery saturates the queue.
          if (type !== "final" && (controller.desiredSize ?? 0) < frame.byteLength + 16_384) {
            this.abort(entry, "transport_failed");
            throw new TaskError("result_size_limit");
          }
          controller.enqueue(frame);
        };
        const usage = new TaskUsage(snapshot => send("usage", snapshot));
        const heartbeat = setInterval(() => {
          if (!closed && (controller.desiredSize ?? 0) > 64) controller.enqueue(encoder.encode(": heartbeat\n\n"));
        }, 1_000);
        void (async () => {
          let terminal: object;
          try {
            send("accepted", { version: 1, model: body.model.id, deadlineAt: body.deadlineAt });
            const tools = new TaskTools({
              host: this.host ?? { runtimeFor: async () => { throw new TaskError("task_tools_unavailable"); } },
              app, entityId: body.entityId, roomId: body.roomId!, allowedTools: body.allowedTools,
              access: entry.lease, deadlineAt: body.deadlineAt, signal: entry.abort.signal, calendar: body.calendar,
              onActivity: event => send("activity", event),
            });
            terminal = await runTask(body, this.config!, entry.abort.signal, usage, text => send("content_delta", { text }), {
              tools, onDelegationError: code => {
                if (["delegation_required", "delegation_expired", "delegation_revoked"].includes(code)) send("delegation_error", { code });
              },
            });
            if (entry.abort.signal.aborted) throw new TaskError("task_cancelled");
          } catch (error) {
            const timedOut = entry.reason === "turn_timeout" || error instanceof TaskError && error.code === "turn_timeout";
            terminal = { outcome: timedOut ? "timed_out" : entry.abort.signal.aborted ? "cancelled" : "failed", code: timedOut ? "turn_timeout" : error instanceof TaskError ? error.code : "agent_failed", answerIsProviderVerbatim: false };
          }
          try { if (!closed) send("final", { model: body.model.id, ...terminal, ...usage.snapshot() }); }
          catch { /* Transport loss cannot prevent settling the active registration. */ }
          finally {
            entry.terminal = true;
            if (entry.roomKey) this.activeRooms.delete(entry.roomKey);
            clearTimeout(deadline);
            clearInterval(heartbeat);
            request.signal.removeEventListener("abort", onAbort);
            if (!closed) { closed = true; controller.close(); }
          }
        })();
      },
      cancel: () => { closed = true; this.abort(entry, "transport_failed"); },
    }, { highWaterMark: 262_144, size: chunk => chunk!.byteLength });
    return new Response(fenceTaskStream(stream, entry.lease), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }
}

async function readBody(request: Request, limit: number): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new TaskError("invalid_content_type");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new TaskError("task_body_size_limit");
  if (!request.body) throw new TaskError("invalid_body");
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const item = await withAbort(reader.read(), request.signal);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) throw new TaskError("task_body_size_limit");
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new TaskError("malformed_json"); }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Read-side fence also removes frames queued before disconnect but not delivered. */
function fenceTaskStream(source: ReadableStream<Uint8Array>, lease?: SessionLease): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const next = await reader.read();
        if (next.done) { controller.close(); return; }
        if (lease && !lease.isCurrent()) {
          const frame = new TextDecoder().decode(next.value);
          if (!frame.startsWith("data: ")) continue;
          const event = JSON.parse(frame.slice(6));
          if (event.type === "final") {
            const { answer, evidence, finalProviderCompletionId, ...accounting } = event;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...accounting, outcome: "cancelled", code: "task_cancelled", answerIsProviderVerbatim: false })}\n\n`));
            return;
          }
          if (event.type !== "usage" && event.type !== "accepted") continue;
        }
        controller.enqueue(next.value); return;
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
}
