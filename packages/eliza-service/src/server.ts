import { mapDelegationError } from "./errors.js";
import { handlePostMessages, type MessageHandlerHost, type PostMessagesBody } from "./handlers/messages.js";
import {
  handleGetSessions,
  handleDeleteSessions,
  handlePostSessions,
  type PostSessionsBody,
  type SessionHandlerHost,
} from "./handlers/sessions.js";
import { handlePostTool, isToolAllowedForApp, type PostToolBody } from "./handlers/tools.js";
import type { SessionStore, SessionLease } from "./session-store.js";
import { TINYCHAT_APP_ID } from "./auth/app-registry.js";
import { checkServiceAuth } from "./auth/service-auth.js";
import { defaultRateLimiter } from "./rate-limit.js";
import { TaskHandler } from "./handlers/tasks.js";
import type { TaskConfig } from "./tasks/contract.js";

interface BunServer {
  hostname: string;
  port: number;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

declare const Bun: {
  serve(opts: {
    hostname: string;
    port: number;
    idleTimeout?: number;
    fetch(request: Request): Response | Promise<Response>;
  }): BunServer;
};

export type ElizaServiceHost = SessionHandlerHost
  & Pick<MessageHandlerHost, "runtimeFor" | "preflight">;

export interface ElizaServiceOptions {
  host: ElizaServiceHost;
  sessions: SessionStore;
  tasks?: TaskConfig;
}

export interface StartElizaServiceOptions extends ElizaServiceOptions {
  hostname?: string;
  port?: number;
  /**
   * Bun.serve idle-connection timeout in seconds (default Bun value is 10).
   * SSE /messages turns that drive a real model + post-turn extraction can exceed
   * 10s; raise this so the server does not close the stream mid-turn.
   */
  idleTimeout?: number;
}

export function startElizaService(opts: StartElizaServiceOptions): BunServer {
  return Bun.serve({
    hostname: opts.hostname ?? "127.0.0.1",
    port: opts.port ?? 3000,
    ...(opts.idleTimeout !== undefined ? { idleTimeout: opts.idleTimeout } : {}),
    fetch: createElizaServiceFetch(opts),
  });
}

export function createElizaServiceFetch(opts: ElizaServiceOptions) {
  const tasks = new TaskHandler(opts.tasks, opts.host, opts.sessions);
  const messages = new Map<string, Set<AbortController>>();
  opts.sessions.onInvalidate((scope, entityId) => {
    tasks.cancelEntity(scope, entityId);
    for (const controller of messages.get(JSON.stringify([scope.appId, scope.agentId, entityId])) ?? []) controller.abort();
  });
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return json(200, { ok: true, agentDid: opts.host.agentDid });
      }

      if (request.method === "GET" && url.pathname === "/capabilities") {
        const auth = checkServiceAuth(request);
        if (!auth.ok) return auth.response;
        const revision = process.env.BUILD_REVISION ?? process.env.GIT_SHA;
        return json(200, { meetingRetrieval: { contractVersion: 2 }, buildRevision: revision && /^[a-f0-9]{40,64}$/i.test(revision) ? revision : "unknown", chatTasks: tasks.capabilities(auth.resolved) });
      }

      if (request.method === "POST" && url.pathname === "/tasks") {
        const auth = checkServiceAuth(request);
        if (!auth.ok) return auth.response;
        return tasks.post(request, auth.resolved);
      }

      const cancelTask = /^\/tasks\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancelTask) {
        const auth = checkServiceAuth(request);
        if (!auth.ok) return auth.response;
        return tasks.cancel(request, auth.resolved, cancelTask[1]);
      }

      if (request.method === "POST" && url.pathname === "/sessions") {
        const auth = checkServiceAuth(request);
        if (!auth.ok) return auth.response;

        const parsed = await readJsonObject(request);
        if (!parsed.ok) return parsed.response;
        if (!isPostSessionsBody(parsed.value)) {
          return json(400, { error: "invalid_body" });
        }

        // agentId is server-trusted: override caller-supplied value with the identity
        // resolved from the credential map so callers cannot route into another app's space.
        const sessionsBody: PostSessionsBody = { ...parsed.value, agentId: auth.resolved.agentId };
        const result = await handlePostSessions(sessionsBody, opts.host, opts.sessions, auth.resolved);
        return json(result.status, result.body);
      }

      if ((request.method === "GET" || request.method === "DELETE") && url.pathname.startsWith("/sessions/")) {
        const auth = checkServiceAuth(request);
        if (!auth.ok) return auth.response;

        const entityId = decodeURIComponent(url.pathname.slice("/sessions/".length));
        if (!entityId || entityId.includes("/")) return json(404, { error: "not_found" });

        const result = request.method === "DELETE"
          ? await handleDeleteSessions(entityId, opts.host, opts.sessions, auth.resolved)
          : await handleGetSessions(entityId, opts.host, opts.sessions, auth.resolved);
        return json(result.status, result.body);
      }

      if (request.method === "POST" && url.pathname === "/messages") {
        const auth = checkServiceAuth(request);
        if (!auth.ok) return auth.response;

        const parsed = await readJsonObject(request);
        if (!parsed.ok) return parsed.response;
        if (!isPostMessagesBody(parsed.value)) {
          return json(400, { error: "invalid_body" });
        }

        // agentId is server-trusted: override caller-supplied value with the identity
        // resolved from the credential map so callers cannot route into another app's space.
        const messagesBody: PostMessagesBody = { ...parsed.value, agentId: auth.resolved.agentId };

        const rateLimit = defaultRateLimiter.check(auth.resolved.appId, messagesBody.entityId);
        if (!rateLimit.allowed) {
          return json(429, { error: "rate_limit_exceeded" });
        }

        const lease = auth.resolved.appId === TINYCHAT_APP_ID ? opts.sessions.lease(auth.resolved, messagesBody.entityId) : undefined;
        if (lease && (!lease.active || !lease.isActive() || !opts.host.privateAccessAvailable?.(auth.resolved.agentId, messagesBody.entityId))) return json(409, { error: "delegation_required" });
        const key = JSON.stringify([auth.resolved.appId, auth.resolved.agentId, messagesBody.entityId]);
        const controller = new AbortController();
        const controllers = messages.get(key) ?? new Set<AbortController>();
        controllers.add(controller); messages.set(key, controllers);
        const abort = () => controller.abort();
        request.signal.addEventListener("abort", abort, { once: true });
        const cleanup = () => { controllers.delete(controller); if (!controllers.size && messages.get(key) === controllers) messages.delete(key); request.signal.removeEventListener("abort", abort); };
        try {
          const preflight = await runMessagePreflight(opts.host, messagesBody);
          if (preflight) { cleanup(); return preflight; }
          if (request.signal.aborted || controller.signal.aborted || lease && !lease.isCurrent()) { cleanup(); return json(409, { error: "delegation_required" }); }
          return streamMessageResponse(opts.host, messagesBody, controller, lease, cleanup);
        } catch (error) { cleanup(); throw error; }
      }

      if (request.method === "POST" && url.pathname.startsWith("/tools/")) {
        const auth = checkServiceAuth(request);
        if (!auth.ok) return auth.response;

        const toolName = decodeURIComponent(url.pathname.slice("/tools/".length));
        if (!toolName || toolName.includes("/")) {
          return json(404, { error: "tool_not_found" });
        }

        // App-identity gate: app-restricted tools (RUN_ARTIFACT_SKILL) must be
        // rejected before any body parsing or runtime boot. Same 404 shape as an
        // unknown tool so restricted tools are not disclosed to other apps.
        if (!isToolAllowedForApp(toolName, auth.resolved.appId)) {
          return json(404, { error: "tool_not_found", tool: toolName });
        }

        const parsed = await readJsonObject(request);
        if (!parsed.ok) return parsed.response;
        if (!isPostToolBody(parsed.value)) {
          return json(400, { error: "invalid_body" });
        }

        // agentId is server-trusted: resolved from the credential, never caller-supplied.
        const toolBody: PostToolBody = parsed.value;
        const lease = auth.resolved.appId === TINYCHAT_APP_ID ? opts.sessions.lease(auth.resolved, toolBody.entityId ?? "") : undefined;
        const access = lease ? { isCurrent: lease.isCurrent, isActive: () => lease.active && lease.isActive() && opts.host.privateAccessAvailable?.(auth.resolved.agentId, toolBody.entityId ?? "") === true && (toolBody.accessRevision === undefined || toolBody.accessRevision === lease.revision) } : undefined;
        const result = await handlePostTool(toolName, auth.resolved.agentId, parsed.value, opts.host, { signal: request.signal, access });
        if (access && (!access.isCurrent() || toolName.toLowerCase() !== "web_search" && !access.isActive())) return json(409, { error: "delegation_required" });
        return json(result.status, result.body);
      }

      return json(404, { error: "not_found" });
    } catch {
      // Unexpected handler throws are intentionally logged without details to
      // avoid leaking request bodies or downstream secret-bearing payloads.
      console.error("[eliza-service] unhandled request error");
      return json(500, { error: "internal_error" });
    }
  };
}

async function runMessagePreflight(
  host: ElizaServiceHost,
  body: PostMessagesBody,
): Promise<Response | null> {
  try {
    await host.preflight(body.agentId, body.entityId);
    return null;
  } catch (err) {
    const code = mapDelegationError(err);
    if (code) return json(409, { error: code });
    throw err;
  }
}

function streamMessageResponse(host: ElizaServiceHost, body: PostMessagesBody, abort: AbortController, lease: SessionLease | undefined, cleanup: () => void): Response {
  const encoder = new TextEncoder();
  const messageHost: MessageHandlerHost = {
    runtimeFor: host.runtimeFor.bind(host),
    preflight: async () => {},
  };

  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const writer = {
        write(frame: string): void {
          if (!closed && !abort.signal.aborted && (!lease || lease.isCurrent())) controller.enqueue(encoder.encode(frame));
        },
        close(): void {
          if (!closed) { closed = true; controller.close(); }
        },
      };

      void handlePostMessages(body, messageHost, writer, { signal: abort.signal, access: lease }).catch((err) => {
        if (!closed) { closed = true; controller.error(err); }
      }).finally(cleanup);
    },
    cancel() { closed = true; abort.abort(); cleanup(); },
  });
  const reader = stream.getReader();
  const fenced = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const next = await reader.read();
        if (next.done) { controller.close(); return; }
        if (abort.signal.aborted || lease && !lease.isCurrent()) continue;
        controller.enqueue(next.value); return;
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });

  return new Response(fenced, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

async function readJsonObject(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return { ok: false, response: json(400, { error: "malformed_json" }) };
  }

  if (!isObject(value)) {
    return { ok: false, response: json(400, { error: "invalid_body" }) };
  }

  return { ok: true, value };
}

function isPostSessionsBody(value: unknown): value is PostSessionsBody {
  if (!isObject(value)) return false;
  const session = value.session;
  const v2 = isObject(session)
    && session.version === 2
    && isObject(session.delegations)
    && typeof session.delegations.memory === "string"
    && typeof session.delegations.transcripts === "string"
    && (session.roomId === undefined || typeof session.roomId === "string");
  return (
    typeof value.agentId === "string"
    && typeof value.entityId === "string"
    && (typeof value.serializedDelegation === "string" || v2)
    && (value.roomId === undefined || typeof value.roomId === "string")
  );
}

function isPostToolBody(value: unknown): value is PostToolBody {
  if (!isObject(value)) return false;
  return (
    (value.accessRevision === undefined || (typeof value.accessRevision === "string" && value.accessRevision.length > 0 && value.accessRevision.length <= 256))
    && (value.entityId === undefined || typeof value.entityId === "string")
    && (value.roomId === undefined || typeof value.roomId === "string")
    && (value.args === undefined || isObject(value.args))
    && (value.context === undefined || (isObject(value.context)
      && (value.context.retrievalMode === undefined || ["selected", "single", "range"].includes(value.context.retrievalMode as string))
      && (value.context.localDate === undefined || typeof value.context.localDate === "string")
      && (value.context.timeZone === undefined || typeof value.context.timeZone === "string")
      && (value.context.deadlineAt === undefined || (typeof value.context.deadlineAt === "number" && Number.isFinite(value.context.deadlineAt)))))
  );
}

function isPostMessagesBody(value: unknown): value is PostMessagesBody {
  if (!isObject(value)) return false;
  return (
    typeof value.agentId === "string"
    && typeof value.entityId === "string"
    && typeof value.roomId === "string"
    && typeof value.text === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
