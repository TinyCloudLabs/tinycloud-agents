import { timingSafeEqual } from "node:crypto";

// Frozen canonical tinychat registration.
export const TINYCHAT_APP_ID = "tinychat";
export const TINYCHAT_AGENT_ID = "92361e74-91ed-43a2-9656-5cc37ff3a07a";

interface AppEntry {
  appId: string;
  agentId: string;
  secret: string;
}

export interface ResolvedApp {
  appId: string;
  agentId: string;
}

// Build the credential→app map from environment variables.
// MVP: ELIZA_SERVICE_SECRET is the shared secret for the tinychat app.
// To add a second app, push another entry with its own appId/agentId/secret.
// Secrets are NEVER hardcoded here — always sourced from env.
function buildRegistry(): AppEntry[] {
  const entries: AppEntry[] = [];
  const tinySecret = process.env.ELIZA_SERVICE_SECRET;
  if (tinySecret) {
    entries.push({ appId: TINYCHAT_APP_ID, agentId: TINYCHAT_AGENT_ID, secret: tinySecret });
  }
  return entries;
}

// Resolve a bearer credential to an app identity.
// Returns null for unknown or empty credentials.
export function resolveApp(credential: string): ResolvedApp | null {
  if (!credential) return null;
  const credBuf = Buffer.from(credential, "utf8");
  const entry = buildRegistry().find(e => {
    const secretBuf = Buffer.from(e.secret, "utf8");
    return secretBuf.length === credBuf.length && timingSafeEqual(secretBuf, credBuf);
  });
  if (!entry) return null;
  return { appId: entry.appId, agentId: entry.agentId };
}
