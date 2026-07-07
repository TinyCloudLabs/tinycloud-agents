import { timingSafeEqual } from "node:crypto";

// Frozen canonical tinychat registration.
export const TINYCHAT_APP_ID = "tinychat";
export const TINYCHAT_AGENT_ID = "92361e74-91ed-43a2-9656-5cc37ff3a07a";

// Frozen Artifactory registration (TC-69 / D7). The Artifactory CLI authenticates
// against eliza-service as its own app so that credential compromise on one side
// (tinychat vs. Artifactory) cannot cross-route into the other app's runtime.
export const ARTIFACTORY_APP_ID = "artifactory";
export const ARTIFACTORY_AGENT_ID = "b5c9f7e2-1a3d-4e5f-8b7a-9c0d1e2f3a4b";

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
// - ELIZA_SERVICE_SECRET     → tinychat app
// - ARTIFACTORY_SERVICE_SECRET → artifactory app (TC-69 / D7)
// To add a further app, push another entry with its own appId/agentId/secret.
// Secrets are NEVER hardcoded here — always sourced from env.
function buildRegistry(): AppEntry[] {
  const entries: AppEntry[] = [];
  const tinySecret = process.env.ELIZA_SERVICE_SECRET;
  if (tinySecret) {
    entries.push({ appId: TINYCHAT_APP_ID, agentId: TINYCHAT_AGENT_ID, secret: tinySecret });
  }
  const artifactorySecret = process.env.ARTIFACTORY_SERVICE_SECRET;
  if (artifactorySecret) {
    entries.push({
      appId: ARTIFACTORY_APP_ID,
      agentId: ARTIFACTORY_AGENT_ID,
      secret: artifactorySecret,
    });
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
