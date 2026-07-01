// Static SPA fallback tests (M4).
//
// Exercises createElizaServiceFetch with a real staticDir on disk: real assets are
// served, unknown routes fall back to index.html, missing assets 404, path
// traversal is blocked, and API/legacy routes always win over the static fallback.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { createElizaServiceFetch, type ElizaServiceHost } from "./server.js";
import { SessionStore } from "./session-store.js";
import { AgentStore } from "./agents/agent-store.js";
import { UserAuth } from "./auth/user-auth.js";

const AGENT_DID = "did:pkh:eip155:1:0x000000000000000000000000000000000000dEaD";

function makeHost(): ElizaServiceHost {
  return {
    agentDid: AGENT_DID,
    agentDidFor: async () => AGENT_DID,
    storageFor: async () => ({ async registerDelegation() {} }),
    runtimeFor: async () => ({}) as IAgentRuntime,
    preflight: async () => {},
  };
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agents-static-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>agents</title>");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "app.js"), "console.log('hi');");
  writeFileSync(join(dir, "assets", "app.css"), "body{}");
  // A secret file OUTSIDE the static root to prove traversal can't reach it.
  writeFileSync(join(dir, "..", "outside-secret.txt"), "TOP SECRET");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(dir, "..", "outside-secret.txt"), { force: true });
});

function fetchWith(staticDir?: string) {
  return createElizaServiceFetch({
    host: makeHost(),
    sessions: new SessionStore(),
    api: { auth: new UserAuth({ domain: "agents.test" }), agents: new AgentStore() },
    staticDir,
  });
}

describe("static SPA fallback", () => {
  it("serves index.html at /", async () => {
    const res = await fetchWith(dir)(new Request("https://agents.test/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>agents</title>");
  });

  it("serves a real asset with the right content-type", async () => {
    const res = await fetchWith(dir)(new Request("https://agents.test/assets/app.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toContain("console.log");
  });

  it("falls back to index.html for an unknown SPA route (no extension)", async () => {
    const res = await fetchWith(dir)(new Request("https://agents.test/agents/some-id"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("404s a missing asset that has a file extension", async () => {
    const res = await fetchWith(dir)(new Request("https://agents.test/assets/missing.js"));
    expect(res.status).toBe(404);
  });

  it("blocks path traversal outside the static root", async () => {
    // Encoded and raw traversal attempts must NOT read outside-secret.txt.
    for (const p of [
      "/../outside-secret.txt",
      "/..%2Foutside-secret.txt",
      "/assets/../../outside-secret.txt",
    ]) {
      const res = await fetchWith(dir)(new Request(`https://agents.test${p}`));
      const body = await res.text();
      expect(body).not.toContain("TOP SECRET");
      // Either the SPA index (200 html) or a 404 — never the secret file.
      if (res.status === 200) expect(res.headers.get("content-type")).toContain("text/html");
    }
  });

  it("does not serve static for non-GET methods", async () => {
    const res = await fetchWith(dir)(new Request("https://agents.test/", { method: "POST" }));
    expect(res.status).toBe(404);
  });

  it("returns 404 (not static) when staticDir is unset", async () => {
    const res = await fetchWith(undefined)(new Request("https://agents.test/"));
    expect(res.status).toBe(404);
  });
});

describe("static fallback never shadows API or legacy routes", () => {
  it("/health still returns the health JSON even with staticDir set", async () => {
    const res = await fetchWith(dir)(new Request("https://agents.test/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; agentDid: string };
    expect(body.ok).toBe(true);
    expect(body.agentDid).toBe(AGENT_DID);
  });

  it("/api/auth/nonce still returns a nonce (not index.html)", async () => {
    const res = await fetchWith(dir)(new Request("https://agents.test/api/auth/nonce"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nonce: string };
    expect(typeof body.nonce).toBe("string");
  });

  it("unknown /api/* path is handled by the API dispatcher as JSON, not the SPA index", async () => {
    // /api/* is claimed by handleApi before the static fallback. An unauthenticated
    // GET to an unknown /api path hits the auth gate first -> 401 JSON (never the
    // SPA index.html). The point: /api/* is never served the static index.
    const res = await fetchWith(dir)(new Request("https://agents.test/api/nope"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
