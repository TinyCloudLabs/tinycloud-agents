// Layer-1 service-credential gate.
//
// Usage in server.ts:
//   const auth = checkServiceAuth(request);
//   if (!auth.ok) return auth.response;
//   // auth.resolved.{ appId, agentId } available to downstream handlers
//
// SECURITY: never log, expose, or include the credential/Authorization header in
// any response body, error message, or thrown value.

import { resolveApp } from "./app-registry.js";
import type { ResolvedApp } from "./app-registry.js";

export type { ResolvedApp };

export type AuthResult =
  | { ok: true; resolved: ResolvedApp }
  | { ok: false; response: Response };

const BEARER_PREFIX = "Bearer ";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Extract a Bearer token from the Authorization header and resolve it to an app.
// Missing or malformed header → 401.
// Unknown credential → 403.
// Valid credential → { ok: true, resolved: { appId, agentId } }.
export function checkServiceAuth(request: Request): AuthResult {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return { ok: false, response: jsonResponse(401, { error: "unauthorized" }) };
  }
  if (!authHeader.startsWith(BEARER_PREFIX)) {
    return { ok: false, response: jsonResponse(401, { error: "unauthorized" }) };
  }
  const credential = authHeader.slice(BEARER_PREFIX.length);
  if (!credential) {
    return { ok: false, response: jsonResponse(401, { error: "unauthorized" }) };
  }
  const resolved = resolveApp(credential);
  if (!resolved) {
    return { ok: false, response: jsonResponse(403, { error: "forbidden" }) };
  }
  return { ok: true, resolved };
}
