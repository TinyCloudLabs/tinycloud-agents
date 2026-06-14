import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolveApp, TINYCHAT_APP_ID, TINYCHAT_AGENT_ID } from "./app-registry.js";
import { checkServiceAuth } from "./service-auth.js";

const TEST_SECRET = "test-eliza-service-secret-d-t2";
const WRONG_SECRET = "not-the-right-secret";

let savedSecret: string | undefined;

beforeAll(() => {
  savedSecret = process.env.ELIZA_SERVICE_SECRET;
  process.env.ELIZA_SERVICE_SECRET = TEST_SECRET;
});

afterAll(() => {
  if (savedSecret !== undefined) {
    process.env.ELIZA_SERVICE_SECRET = savedSecret;
  } else {
    delete process.env.ELIZA_SERVICE_SECRET;
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
