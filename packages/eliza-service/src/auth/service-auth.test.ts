import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  ARTIFACTORY_AGENT_ID,
  ARTIFACTORY_APP_ID,
  resolveApp,
  TINYCHAT_APP_ID,
  TINYCHAT_AGENT_ID,
} from "./app-registry.js";
import { checkServiceAuth } from "./service-auth.js";

const TEST_SECRET = "test-eliza-service-secret-d-t2";
const TEST_ARTIFACTORY_SECRET = "test-artifactory-service-secret-tc69";
const WRONG_SECRET = "not-the-right-secret";

let savedSecret: string | undefined;
let savedArtifactorySecret: string | undefined;

beforeAll(() => {
  savedSecret = process.env.ELIZA_SERVICE_SECRET;
  savedArtifactorySecret = process.env.ARTIFACTORY_SERVICE_SECRET;
  process.env.ELIZA_SERVICE_SECRET = TEST_SECRET;
  process.env.ARTIFACTORY_SERVICE_SECRET = TEST_ARTIFACTORY_SECRET;
});

afterAll(() => {
  if (savedSecret !== undefined) {
    process.env.ELIZA_SERVICE_SECRET = savedSecret;
  } else {
    delete process.env.ELIZA_SERVICE_SECRET;
  }
  if (savedArtifactorySecret !== undefined) {
    process.env.ARTIFACTORY_SERVICE_SECRET = savedArtifactorySecret;
  } else {
    delete process.env.ARTIFACTORY_SERVICE_SECRET;
  }
});

function makeRequest(authHeader?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authHeader !== undefined) {
    headers["Authorization"] = authHeader;
  }
  return new Request("http://localhost:3000/sessions", { method: "POST", headers });
}

describe("resolveApp (app-registry)", () => {
  it("tinychat credential resolves to the frozen tinychat appId and agentId", () => {
    const result = resolveApp(TEST_SECRET);
    expect(result).not.toBeNull();
    expect(result?.appId).toBe(TINYCHAT_APP_ID);
    expect(result?.agentId).toBe(TINYCHAT_AGENT_ID);
    expect(result?.agentId).toBe("92361e74-91ed-43a2-9656-5cc37ff3a07a");
  });

  it("artifactory credential resolves to the frozen artifactory appId and agentId", () => {
    const result = resolveApp(TEST_ARTIFACTORY_SECRET);
    expect(result).not.toBeNull();
    expect(result?.appId).toBe(ARTIFACTORY_APP_ID);
    expect(result?.agentId).toBe(ARTIFACTORY_AGENT_ID);
    expect(result?.agentId).toBe("b5c9f7e2-1a3d-4e5f-8b7a-9c0d1e2f3a4b");
  });

  it("tinychat and artifactory credentials resolve to distinct apps", () => {
    const tiny = resolveApp(TEST_SECRET);
    const arti = resolveApp(TEST_ARTIFACTORY_SECRET);
    expect(tiny?.appId).toBe(TINYCHAT_APP_ID);
    expect(arti?.appId).toBe(ARTIFACTORY_APP_ID);
    expect(tiny?.agentId).not.toBe(arti?.agentId);
  });

  it("unknown credential returns null", () => {
    expect(resolveApp(WRONG_SECRET)).toBeNull();
  });

  it("empty string credential returns null", () => {
    expect(resolveApp("")).toBeNull();
  });
});

describe("checkServiceAuth", () => {
  it("valid Bearer credential passes and resolves the tinychat agentId", async () => {
    const req = makeRequest(`Bearer ${TEST_SECRET}`);
    const result = checkServiceAuth(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.appId).toBe(TINYCHAT_APP_ID);
      expect(result.resolved.agentId).toBe(TINYCHAT_AGENT_ID);
      expect(result.resolved.agentId).toBe("92361e74-91ed-43a2-9656-5cc37ff3a07a");
    }
  });

  it("missing Authorization header returns 401", async () => {
    const req = makeRequest();
    const result = checkServiceAuth(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body).toEqual({ error: "unauthorized" });
    }
  });

  it("malformed header (Basic scheme instead of Bearer) returns 401", async () => {
    const req = makeRequest(`Basic ${TEST_SECRET}`);
    const result = checkServiceAuth(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body).toEqual({ error: "unauthorized" });
    }
  });

  it("malformed header (Bearer with empty token) returns 401", async () => {
    const req = makeRequest("Bearer ");
    const result = checkServiceAuth(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body).toEqual({ error: "unauthorized" });
    }
  });

  it("wrong/unknown credential returns 403", async () => {
    const req = makeRequest(`Bearer ${WRONG_SECRET}`);
    const result = checkServiceAuth(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body).toEqual({ error: "forbidden" });
    }
  });
});
