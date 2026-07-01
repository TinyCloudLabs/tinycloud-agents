// ---------------------------------------------------------------------------
// The ONLY place endpoint paths and auth-header construction live.
//
// Loose coupling is a hard requirement: the service (M2) is still landing and
// its contract may shift. Every path string and the `Authorization` header
// construction are confined to this file. UI code calls the typed functions
// below and never sees a URL or a header.
//
// Base URL is same-origin `/api` (Vite proxies it in dev; the Bun server
// serves it in prod).
//
// AUTH: SIWE nonce + bearer session, signed via the OpenKey EIP-1193 provider
// (docs/agents-api.md).
//   GET  /api/auth/nonce           -> { nonce }
//   build a SIWE message (siwe SiweMessage.prepareMessage(): domain
//     window.location.host, address, chainId 1, nonce) and personal_sign it
//     via the OpenKey provider (same path tcw.signIn uses)
//   POST /api/auth/verify {message, signature} -> { token, address, expiresAt }
//   Authorization: Bearer <token> on all /api/agents* calls
//   401 { error: "unauthorized" } -> session expired, re-run the flow and retry.
// ---------------------------------------------------------------------------

import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { SiweMessage } from "siwe";

const BASE = "/api";

// A signer is anything that can produce an EIP-191 personal_sign over a string.
// TinyCloudWeb's ethers Web3Provider (backed by the OpenKey provider) satisfies
// this; keeping the interface narrow keeps the auth wiring swappable.
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

// Build the SIWE message to sign, given a server-issued nonce. Uses the `siwe`
// library's canonical serialization so it matches the server's SiweMessage
// parse byte-for-byte.
//
// Per EIP-4361 the `domain` MUST be the origin actually serving the page —
// window.location.host — not a hardcoded value. The server validates it against
// AGENTS_AUTH_DOMAIN (agents.tinycloud.xyz in prod, localhost:<port> for local
// E2E), so hardcoding would break the domain binding on any non-prod origin.
function buildSiweMessage(address: string, nonce: string): string {
  return new SiweMessage({
    domain: window.location.host,
    address,
    statement: "Sign in to TinyCloud Agents.",
    uri: window.location.origin,
    version: "1",
    chainId: 1,
    nonce,
  }).prepareMessage();
}

// Per-session bearer token cache. Acquired lazily on the first authed request
// and refreshed on 401. Confined to this module.
let bearerToken: string | null = null;

async function authenticate(signer: Signer): Promise<string> {
  const nonceRes = await fetch(`${BASE}/auth/nonce`);
  if (!nonceRes.ok) throw new ApiError(nonceRes.status, "failed to fetch auth nonce");
  const { nonce } = (await nonceRes.json()) as { nonce: string };

  const message = buildSiweMessage(signer.address, nonce);
  const signature = await signer.signMessage(message);

  const verifyRes = await fetch(`${BASE}/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  if (!verifyRes.ok) {
    const detail = await verifyRes.json().catch(() => ({}));
    throw new ApiError(verifyRes.status, detail?.message ?? "auth verify failed", detail?.error);
  }
  const { token } = (await verifyRes.json()) as {
    token: string;
    address: string;
    expiresAt: number;
  };
  bearerToken = token;
  return token;
}

// Return a valid bearer token, authenticating if we don't have one cached.
async function ensureToken(signer: Signer): Promise<string> {
  return bearerToken ?? (await authenticate(signer));
}

// Clears the cached session (e.g. after a 401) so the next call re-authenticates.
export function clearSession(): void {
  bearerToken = null;
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

// Issue an authed request. On 401 (expired session) we clear the token,
// re-authenticate once, and retry.
async function authedFetch(
  signer: Signer,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const send = async (token: string): Promise<Response> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  let res = await send(await ensureToken(signer));
  if (res.status === 401) {
    clearSession();
    res = await send(await authenticate(signer));
  }
  return res;
}

async function request<T>(
  signer: Signer,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await authedFetch(signer, method, path, body);

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
// docs/agents-api.md (final). ---

export type DelegationStatus = "active" | "expired" | "stale" | "none";

// Matches the AgentView in the contract.
export interface Agent {
  agentId: string;
  agentDid: string;
  name: string;
  enabled: boolean;
  // Delegation scope for this agent, chosen by the service. Thread these
  // verbatim into the mint — the client does not derive them. The server
  // validates the granted path == dbHandle exactly, so use dbHandle as-is.
  space: string;
  pathPrefix: string;
  dbHandle: string;
  delegationStatus?: DelegationStatus;
  createdAt?: string;
}

// --- Endpoints ---

export function createAgent(signer: Signer, name?: string): Promise<Agent> {
  return request(signer, "POST", "/agents", { name });
}

export async function listAgents(signer: Signer): Promise<Agent[]> {
  // Contract: GET /api/agents -> { agents: AgentView[] }.
  const { agents } = await request<{ agents: Agent[] }>(signer, "GET", "/agents");
  return agents;
}

export function getAgent(signer: Signer, agentId: string): Promise<Agent> {
  return request(signer, "GET", `/agents/${agentId}`);
}

// Register the user's minted delegation. The server derives entityId from the
// authed owner + agentId — do not send it. Returns the resulting delegation
// status (active|expired|stale).
export function submitDelegation(
  signer: Signer,
  agentId: string,
  serializedDelegation: string,
  roomId?: string
): Promise<{ entityId: string; status: "active" | "expired" | "stale" }> {
  return request(signer, "POST", `/agents/${agentId}/delegation`, {
    serializedDelegation,
    roomId,
  });
}

export function setEnabled(signer: Signer, agentId: string, enabled: boolean): Promise<Agent> {
  return request(signer, "PATCH", `/agents/${agentId}`, { enabled });
}

// --- Chat (SSE) ---
// Streams the assistant turn. Per the contract each chunk is a
// `data: <json Content>\n\n` frame, terminated by `data: [DONE]\n\n`; the
// elizaOS Content carries the reply in its `text` field. `onChunk` receives
// each text delta; the promise resolves when the stream closes.
export async function sendMessage(
  signer: Signer,
  agentId: string,
  text: string,
  onChunk: (delta: string) => void,
  roomId: string
): Promise<void> {
  const path = `/agents/${agentId}/messages`;
  const res = await authedFetch(signer, "POST", path, { text, roomId });

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
      // Each frame is a JSON Content object; the reply text is in `text`.
      // Tolerate raw strings / `delta` too in case the shape shifts.
      try {
        const parsed = JSON.parse(data);
        const delta = typeof parsed === "string" ? parsed : parsed.text ?? parsed.delta ?? "";
        if (delta) onChunk(delta);
      } catch {
        onChunk(data);
      }
    }
  }
}

// --- Tools ---
// Body is { args?, roomId? } per the contract; the response is the raw tool
// result JSON. Only `web_search` exists today (needs no delegation).
export function callTool<T = unknown>(
  signer: Signer,
  agentId: string,
  name: string,
  args: Record<string, unknown>,
  roomId?: string
): Promise<T> {
  return request(signer, "POST", `/agents/${agentId}/tools/${name}`, { args, roomId });
}
