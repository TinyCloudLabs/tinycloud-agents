import { mapDelegationError } from "./errors.js";
import { handlePostMessages, type MessageHandlerHost, type PostMessagesBody } from "./handlers/messages.js";
import {
  handleGetSessions,
  handlePostSessions,
  type PostSessionsBody,
  type SessionHandlerHost,
} from "./handlers/sessions.js";
import { handlePostTool, type PostToolBody } from "./handlers/tools.js";
import {
  handleAgentDelegation,
  handleCreateAgent,
  handleGetAgent,
  handleListAgents,
  handlePatchAgent,
  ownerEntityId,
  requireOwned,
  type AgentsHandlerHost,
} from "./handlers/agents.js";
import type { AgentStore } from "./agents/agent-store.js";
import type { SessionStore } from "./session-store.js";
import { checkServiceAuth } from "./auth/service-auth.js";
import type { UserAuth, AuthenticatedUser } from "./auth/user-auth.js";
import { createRateLimiter, defaultRateLimiter, type RateLimiter } from "./rate-limit.js";

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
  & Pick<MessageHandlerHost, "runtimeFor" | "preflight">
  & AgentsHandlerHost
  & { readonly agentDid: string };

export interface ElizaServiceOptions {
  host: ElizaServiceHost;
  sessions: SessionStore;
  /**
   * Optional /api/agents surface. When provided, the server serves the
   * OpenKey-authenticated owner API under /api/*; when omitted, only the legacy
   * tinychat routes (/health, /sessions, /messages, /tools) are served.
   */
  api?: {
    auth: UserAuth;
    agents: AgentStore;
    /** Per-owner create limiter. Defaults to 30/min. */
    createLimiter?: RateLimiter;
  };
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
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return json(200, { ok: true, agentDid: opts.host.agentDid });
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
        const result = await handlePostSessions(sessionsBody, opts.host, opts.sessions);
        return json(result.status, result.body);
      }

      if (request.method === "GET" && url.pathname.startsWith("/sessions/")) {
        const auth = checkServiceAuth(request);
        if (!auth.ok) return auth.response;

        const entityId = decodeURIComponent(url.pathname.slice("/sessions/".length));
        if (!entityId || entityId.includes("/")) return json(404, { error: "not_found" });

        const result = await handleGetSessions(entityId, opts.host, opts.sessions);
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

        const preflight = await runMessagePreflight(opts.host, messagesBody);
        if (preflight) return preflight;

        return streamMessageResponse(opts.host, messagesBody);
      }

      if (request.method === "POST" && url.pathname.startsWith("/tools/")) {
        const auth = checkServiceAuth(request);
        if (!auth.ok) return auth.response;

        const toolName = decodeURIComponent(url.pathname.slice("/tools/".length));
        if (!toolName || toolName.includes("/")) {
          return json(404, { error: "tool_not_found" });
        }

        const parsed = await readJsonObject(request);
        if (!parsed.ok) return parsed.response;
        if (!isPostToolBody(parsed.value)) {
          return json(400, { error: "invalid_body" });
        }

        // agentId is server-trusted: resolved from the credential, never caller-supplied.
        const result = await handlePostTool(toolName, auth.resolved.agentId, parsed.value, opts.host);
        return json(result.status, result.body);
      }

      if (opts.api && url.pathname.startsWith("/api/")) {
        return handleApi(request, url, opts, opts.api);
      }

      return json(404, { error: "not_found" });
    } catch (err) {
      // Surface the cause (message + stack only — never the request body, which may
      // carry the serialized delegation per the security invariant) so an
      // unexpected handler throw is debuggable instead of a silent 500.
      console.error(
        "[eliza-service] unhandled request error:",
        err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
      );
      return json(500, { error: "internal_error" });
    }
  };
}

// Default per-owner create limiter (30 creates/min) when the caller does not
// supply one. Keyed by (owner, "create") through the (appId, entityId) signature.
const defaultCreateLimiter = createRateLimiter({ maxRequests: 30, windowMs: 60_000 });

type ApiConfig = NonNullable<ElizaServiceOptions["api"]>;

/**
 * Dispatch /api/* routes for the OpenKey-authenticated owner surface.
 *
 * Auth split:
 *  - /api/auth/nonce and /api/auth/verify are UNAUTHENTICATED (they establish the
 *    session).
 *  - Everything else requires a valid Bearer session -> owner address.
 *
 * Disabled agents return 403 agent_disabled for delegation/messages/tools (but not
 * for GET/PATCH, so an owner can still inspect and re-enable them).
 */
async function handleApi(
  request: Request,
  url: URL,
  opts: ElizaServiceOptions,
  api: ApiConfig,
): Promise<Response> {
  const { auth, agents } = api;
  const createLimiter = api.createLimiter ?? defaultCreateLimiter;
  const path = url.pathname;

  // ── Unauthenticated auth endpoints ──
  if (request.method === "GET" && path === "/api/auth/nonce") {
    return json(200, { nonce: auth.issueNonce() });
  }
  if (request.method === "POST" && path === "/api/auth/verify") {
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return parsed.response;
    const { message, signature } = parsed.value;
    if (typeof message !== "string" || typeof signature !== "string") {
      return json(400, { error: "invalid_body" });
    }
    const result = await auth.verifySiwe({ message, signature });
    if (!result.ok) return json(401, { error: result.error });
    return json(200, { token: result.token, address: result.address, expiresAt: result.expiresAt });
  }

  // ── Everything below requires a session ──
  const user = auth.authenticate(request);
  if (!user) return json(401, { error: "unauthorized" });

  // POST /api/agents — create (rate-limited per owner)
  if (request.method === "POST" && path === "/api/agents") {
    if (!createLimiter.check(user.address, "create").allowed) {
      return json(429, { error: "rate_limit_exceeded" });
    }
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return parsed.response;
    const result = await handleCreateAgent(user.address, parsed.value, agents, opts.host);
    return json(result.status, result.body);
  }

  // GET /api/agents — list
  if (request.method === "GET" && path === "/api/agents") {
    const result = await handleListAgents(user.address, agents, opts.host);
    return json(result.status, result.body);
  }

  // /api/agents/:agentId[/subresource]
  if (path.startsWith("/api/agents/")) {
    const rest = path.slice("/api/agents/".length);
    const segments = rest.split("/").map(decodeURIComponent);
    const agentId = segments[0];
    if (!agentId) return json(404, { error: "not_found" });

    // GET /api/agents/:agentId
    if (request.method === "GET" && segments.length === 1) {
      const result = await handleGetAgent(user.address, agentId, agents, opts.host);
      return json(result.status, result.body);
    }

    // PATCH /api/agents/:agentId
    if (request.method === "PATCH" && segments.length === 1) {
      const parsed = await readJsonObject(request);
      if (!parsed.ok) return parsed.response;
      const result = await handlePatchAgent(user.address, agentId, parsed.value, agents, opts.host);
      return json(result.status, result.body);
    }

    // POST /api/agents/:agentId/delegation
    if (request.method === "POST" && segments.length === 2 && segments[1] === "delegation") {
      const gate = disabledGate(user, agentId, agents);
      if (gate) return gate;
      const parsed = await readJsonObject(request);
      if (!parsed.ok) return parsed.response;
      const result = await handleAgentDelegation(
        user.address,
        agentId,
        parsed.value,
        agents,
        opts.sessions,
        opts.host,
      );
      return json(result.status, result.body);
    }

    // POST /api/agents/:agentId/messages — SSE
    if (request.method === "POST" && segments.length === 2 && segments[1] === "messages") {
      const gate = disabledGate(user, agentId, agents);
      if (gate) return gate;
      const entityId = ownerEntityId(user.address, agentId, agents);
      if (!entityId) return json(404, { error: "not_found" });
      const parsed = await readJsonObject(request);
      if (!parsed.ok) return parsed.response;
      const text = parsed.value.text;
      const roomId = parsed.value.roomId;
      if (typeof text !== "string" || typeof roomId !== "string") {
        return json(400, { error: "invalid_body" });
      }
      const body: PostMessagesBody = { agentId, entityId, roomId, text };
      const preflight = await runMessagePreflight(opts.host, body);
      if (preflight) return preflight;
      return streamMessageResponse(opts.host, body);
    }

    // POST /api/agents/:agentId/tools/:name
    if (request.method === "POST" && segments.length === 3 && segments[1] === "tools") {
      const gate = disabledGate(user, agentId, agents);
      if (gate) return gate;
      const entityId = ownerEntityId(user.address, agentId, agents);
      if (!entityId) return json(404, { error: "not_found" });
      const toolName = segments[2];
      if (!toolName) return json(404, { error: "tool_not_found" });
      const parsed = await readJsonObject(request);
      if (!parsed.ok) return parsed.response;
      if (!isPostToolBody(parsed.value)) return json(400, { error: "invalid_body" });
      // entityId is server-derived from the authed owner, overriding any caller value.
      const toolBody: PostToolBody = { ...parsed.value, entityId };
      const result = await handlePostTool(toolName, agentId, toolBody, opts.host);
      return json(result.status, result.body);
    }
  }

  return json(404, { error: "not_found" });
}

/**
 * 403 agent_disabled when the owned agent is off; 404 when unknown/not owned.
 * Returns null when the agent is owned and enabled (proceed).
 */
function disabledGate(
  user: AuthenticatedUser,
  agentId: string,
  agents: AgentStore,
): Response | null {
  const record = requireOwned(agentId, user.address, agents);
  if (!record) return json(404, { error: "not_found" });
  if (!record.enabled) return json(403, { error: "agent_disabled" });
  return null;
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

function streamMessageResponse(host: ElizaServiceHost, body: PostMessagesBody): Response {
  const encoder = new TextEncoder();
  const messageHost: MessageHandlerHost = {
    runtimeFor: host.runtimeFor.bind(host),
    preflight: async () => {},
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const writer = {
        write(frame: string): void {
          controller.enqueue(encoder.encode(frame));
        },
        close(): void {
          controller.close();
        },
      };

      void handlePostMessages(body, messageHost, writer).catch((err) => {
        controller.error(err);
      });
    },
  });

  return new Response(stream, {
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
  return (
    typeof value.agentId === "string"
    && typeof value.entityId === "string"
    && typeof value.serializedDelegation === "string"
    && (value.roomId === undefined || typeof value.roomId === "string")
  );
}

function isPostToolBody(value: unknown): value is PostToolBody {
  if (!isObject(value)) return false;
  return (
    (value.entityId === undefined || typeof value.entityId === "string")
    && (value.roomId === undefined || typeof value.roomId === "string")
    && (value.args === undefined || isObject(value.args))
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
