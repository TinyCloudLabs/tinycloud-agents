import { mapDelegationError } from "./errors.js";
import { handlePostMessages, type MessageHandlerHost, type PostMessagesBody } from "./handlers/messages.js";
import {
  handleGetSessions,
  handlePostSessions,
  type PostSessionsBody,
  type SessionHandlerHost,
} from "./handlers/sessions.js";
import type { SessionStore } from "./session-store.js";

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
        const parsed = await readJsonObject(request);
        if (!parsed.ok) return parsed.response;
        if (!isPostSessionsBody(parsed.value)) {
          return json(400, { error: "invalid_body" });
        }

        const result = await handlePostSessions(parsed.value, opts.host, opts.sessions);
        return json(result.status, result.body);
      }

      if (request.method === "GET" && url.pathname.startsWith("/sessions/")) {
        const entityId = decodeURIComponent(url.pathname.slice("/sessions/".length));
        if (!entityId || entityId.includes("/")) return json(404, { error: "not_found" });

        const result = await handleGetSessions(entityId, opts.host, opts.sessions);
        return json(result.status, result.body);
      }

      if (request.method === "POST" && url.pathname === "/messages") {
        const parsed = await readJsonObject(request);
        if (!parsed.ok) return parsed.response;
        if (!isPostMessagesBody(parsed.value)) {
          return json(400, { error: "invalid_body" });
        }

        const preflight = await runMessagePreflight(opts.host, parsed.value);
        if (preflight) return preflight;

        return streamMessageResponse(opts.host, parsed.value);
      }

      return json(404, { error: "not_found" });
    } catch {
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
