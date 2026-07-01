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
// AUTH (finalized): SIWE nonce + bearer session, signed via the OpenKey
// EIP-1193 provider.
//   GET  /api/auth/nonce           -> { nonce }
//   build SIWE message (domain agents.tinycloud.xyz + nonce)
//   personal_sign via the OpenKey provider (same path tcw.signIn uses)
//   POST /api/auth/verify {message, signature} -> { token }
//   Authorization: Bearer <token> on all /api/agents* calls
//   401 -> session expired, re-run the flow and retry once.
//
// The EXACT SIWE message fields/shapes come from M2's docs/agents-api.md —
// that contract is authoritative. `buildSiweMessage` below is the one spot to
// reconcile when it lands; everything else (nonce fetch, verify, bearer cache,
// 401 re-auth) is contract-stable.
// ---------------------------------------------------------------------------

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

const BASE = "/api";
const AUTH_DOMAIN = "agents.tinycloud.xyz";

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

// Build the SIWE message to sign, given a server-issued nonce.
//
// PLACEHOLDER shape — reconcile with docs/agents-api.md when M2 lands. The
// service builds and re-parses this message server-side to verify, so its
// exact field set/formatting must match the contract exactly. Kept as EIP-4361
// (SIWE) canonical text as a reasonable default.
function buildSiweMessage(address: string, nonce: string): string {
  const issuedAt = new Date().toISOString();
  return [
    `${AUTH_DOMAIN} wants you to sign in with your Ethereum account:`,
    address,
    ``,
    `Sign in to TinyCloud Agents.`,
    ``,
    `URI: https://${AUTH_DOMAIN}`,
    `Version: 1`,
    `Chain ID: 1`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
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
  const { token } = (await verifyRes.json()) as { token: string };
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
// docs/agents-api.md when M2 publishes it). ---

export type DelegationStatus = "active" | "expired" | "stale" | "none";

export interface Agent {
  agentId: string;
  agentDid: string;
  name: string;
  enabled: boolean;
  // Delegation scope for this agent, chosen by the service. Thread these
  // verbatim into the mint — the client does not derive them. Optional only
  // until the contract lands; the UI falls back to the config stubs.
  space?: string;
  pathPrefix?: string;
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
