// ---------------------------------------------------------------------------
// The ONLY place endpoint paths and auth-header construction live.
//
// Loose coupling is a hard requirement: the service (M2) is still landing and
// its contract may shift. Every path string and the `Authorization` header
// format are confined to this file. UI code calls the typed functions below
// and never sees a URL or a header.
//
// Base URL is same-origin `/api` (Vite proxies it in dev; the Bun server
// serves it in prod). Auth follows plan §2: per-request EIP-191 personal_sign
// over a canonical payload, sent as `Authorization: TCW1 <b64(payload)>.<sig>`.
// ---------------------------------------------------------------------------

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

const BASE = "/api";
const AUTH_DOMAIN = "agents.tinycloud.xyz";

// A signer is anything that can produce an EIP-191 personal_sign over a string.
// TinyCloudWeb's ethers Web3Provider satisfies this; keeping the interface
// narrow means the auth scheme can be swapped (SIWE session, OpenKey JWT)
// without touching call sites.
export interface Signer {
  address: string;
  signMessage(message: string): Promise<string>;
}

export function signerFromTcw(tcw: TinyCloudWeb): Signer {
  const address = tcw.address();
  if (!address) throw new Error("not signed in");
  const ethSigner = tcw.provider.getSigner();
  return {
    address,
    signMessage: (message) => ethSigner.signMessage(message),
  };
}

function base64(obj: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj))));
}

// Build the per-request Authorization header. The signed payload binds the
// request to a method + path + fresh timestamp so the service can reject
// stale/replayed signatures (plan §2: reject timestamps older than ~5 min).
async function authHeader(signer: Signer, method: string, path: string): Promise<string> {
  const payload = {
    domain: AUTH_DOMAIN,
    address: signer.address,
    method,
    path,
    timestamp: new Date().toISOString(),
  };
  const encoded = base64(payload);
  const signature = await signer.signMessage(encoded);
  return `TCW1 ${encoded}.${signature}`;
}

// Signals the UI should prompt the user to (re-)delegate before retrying.
export class DelegationRequiredError extends Error {
  constructor(public agentId: string) {
    super("delegation_required");
    this.name = "DelegationRequiredError";
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  signer: Signer,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: await authHeader(signer, method, path),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 409) {
    const detail = await res.json().catch(() => ({}));
    if (detail?.error === "delegation_required" || detail?.code === "delegation_required") {
      const agentId = path.split("/")[3] ?? "";
      throw new DelegationRequiredError(agentId);
    }
  }

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new ApiError(res.status, detail?.message ?? res.statusText, detail?.error ?? detail?.code);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// --- Types (mirror the plan §2 endpoint table; reconcile with the committed
// docs/agents-api.md when M2 publishes it). ---

export type DelegationStatus = "active" | "expired" | "stale" | "none";

export interface Agent {
  agentId: string;
  agentDid: string;
  name: string;
  enabled: boolean;
  delegationStatus?: DelegationStatus;
  createdAt?: string;
}

// --- Endpoints ---

export function createAgent(signer: Signer, name?: string): Promise<Agent> {
  return request(signer, "POST", "/agents", { name });
}

export function listAgents(signer: Signer): Promise<Agent[]> {
  return request(signer, "GET", "/agents");
}

export function getAgent(signer: Signer, agentId: string): Promise<Agent> {
  return request(signer, "GET", `/agents/${agentId}`);
}

export function submitDelegation(
  signer: Signer,
  agentId: string,
  serializedDelegation: string,
  roomId?: string
): Promise<{ status: DelegationStatus }> {
  return request(signer, "POST", `/agents/${agentId}/delegation`, {
    serializedDelegation,
    roomId,
  });
}

export function setEnabled(signer: Signer, agentId: string, enabled: boolean): Promise<Agent> {
  return request(signer, "PATCH", `/agents/${agentId}`, { enabled });
}

// --- Chat (SSE) ---
// Streams the assistant turn. The service emits `data:` frames terminated by a
// final `data: [DONE]` line. `onChunk` receives each text delta; the promise
// resolves when the stream closes.
export async function sendMessage(
  signer: Signer,
  agentId: string,
  text: string,
  onChunk: (delta: string) => void,
  roomId?: string
): Promise<void> {
  const path = `/agents/${agentId}/messages`;
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      Authorization: await authHeader(signer, "POST", path),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text, roomId }),
  });

  if (res.status === 409) {
    throw new DelegationRequiredError(agentId);
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new ApiError(res.status, detail?.message ?? res.statusText, detail?.error ?? detail?.code);
  }
  if (!res.body) throw new ApiError(500, "no response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trimStart();
      if (data === "[DONE]") return;
      // Frames may be raw text or JSON `{ "delta": "..." }`; handle both.
      try {
        const parsed = JSON.parse(data);
        const delta = typeof parsed === "string" ? parsed : parsed.delta ?? parsed.text ?? "";
        if (delta) onChunk(delta);
      } catch {
        onChunk(data);
      }
    }
  }
}

// --- Tools ---
export function callTool<T = unknown>(
  signer: Signer,
  agentId: string,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  return request(signer, "POST", `/agents/${agentId}/tools/${name}`, args);
}
