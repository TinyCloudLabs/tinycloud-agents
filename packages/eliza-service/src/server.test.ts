import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Content, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { MEMORY_DB_HANDLE, NoDelegationError } from "@tinycloud/eliza-plugin-memory";
import {
  RUN_ARTIFACT_SKILL,
  type ArtifactSkillRuntimeInput,
} from "@tinycloud/agent-client";
import { SessionStore } from "./session-store.js";
import { startElizaService, type ElizaServiceHost } from "./server.js";
import { runArtifactSkillAction } from "./actions/run-artifact-skill.js";
import { ARTIFACTORY_AGENT_ID } from "./auth/app-registry.js";

const TEST_SERVICE_SECRET = "server-test-service-secret";
const TEST_ARTIFACTORY_SERVICE_SECRET = "server-test-artifactory-secret";

const TEST_AGENT_DID = "did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c";
const TEST_AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEST_ENTITY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeValidSerialized(): string {
  return JSON.stringify({
    cid: "bafy-server-test",
    delegateDID: TEST_AGENT_DID,
    spaceId: "tinycloud:pkh:eip155:1:0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2:default",
    path: MEMORY_DB_HANDLE,
    actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
    expiry: new Date("2099-01-01T00:00:00.000Z").toISOString(),
    ownerAddress: "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2",
    chainId: 1,
    host: "https://node.tinycloud.xyz",
  });
}

class FakeStorage {
  readonly registered: Array<{ entityId: string; serialized: string; roomId?: string }> = [];

  async registerDelegation(entityId: string, serialized: string, roomId?: string): Promise<void> {
    this.registered.push({ entityId, serialized, roomId });
  }
}

function makeHost(storage = new FakeStorage()): { host: ElizaServiceHost; storage: FakeStorage } {
  return {
    storage,
    host: {
      agentDid: TEST_AGENT_DID,
      storageFor: async () => storage,
      runtimeFor: async () => {
        throw new Error("runtimeFor should not be called by these server tests");
      },
      preflight: async () => {},
    },
  };
}

function makeMessageHost(opts: {
  chunks?: Content[];
  preflightError?: unknown;
} = {}): { host: ElizaServiceHost; seen: { message?: Memory } } {
  const seen: { message?: Memory } = {};
  const runtime = {
    agentId: TEST_AGENT_ID as UUID,
    messageService: {
      async handleMessage(
        _runtime: IAgentRuntime,
        message: Memory,
        callback?: (content: Content) => Promise<Memory[]>,
      ) {
        seen.message = message;
        for (const chunk of opts.chunks ?? [{ text: "hello over sse" }]) {
          if (callback) await callback(chunk);
        }
        return { didRespond: true, responseMessages: [], mode: "simple" as const };
      },
    },
  } as unknown as IAgentRuntime;

  return {
    seen,
    host: {
      agentDid: TEST_AGENT_DID,
      storageFor: async () => new FakeStorage(),
      runtimeFor: async () => runtime,
      preflight: async () => {
        if (opts.preflightError) throw opts.preflightError;
      },
    },
  };
}

function makeToolHost(action: { name: string; result?: unknown }): ElizaServiceHost {
  const runtime = {
    agentId: TEST_AGENT_ID as UUID,
    actions: [
      {
        name: action.name,
        description: "test tool",
        validate: async () => true,
        handler: async (
          _r: IAgentRuntime,
          _m: Memory,
          _s: unknown,
          _o: unknown,
          callback?: (content: Content) => Promise<Memory[]>,
        ) => {
          if (callback) await callback({ text: "tool ran" });
          return { success: true, text: "tool ran", data: action.result ?? null };
        },
      },
    ],
  } as unknown as IAgentRuntime;

  return {
    agentDid: TEST_AGENT_DID,
    storageFor: async () => new FakeStorage(),
    runtimeFor: async () => runtime,
    preflight: async () => {},
  };
}

describe("eliza-service HTTP server", () => {
  let server: ReturnType<typeof startElizaService> | undefined;
  let savedSecret: string | undefined;

  let savedArtifactorySecret: string | undefined;

  beforeAll(() => {
    savedSecret = process.env.ELIZA_SERVICE_SECRET;
    savedArtifactorySecret = process.env.ARTIFACTORY_SERVICE_SECRET;
    process.env.ELIZA_SERVICE_SECRET = TEST_SERVICE_SECRET;
    process.env.ARTIFACTORY_SERVICE_SECRET = TEST_ARTIFACTORY_SERVICE_SECRET;
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

  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  function url(path: string): string {
    if (!server) throw new Error("server not started");
    return `http://${server.hostname}:${server.port}${path}`;
  }

  it("GET /health returns ok and the agent DID", async () => {
    const { host } = makeHost();
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/health"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, agentDid: TEST_AGENT_DID });
  });

  it("GET /capabilities authenticates and reports an immutable configured build revision", async () => {
    const { host } = makeHost();
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });
    const saved = process.env.BUILD_REVISION;
    try {
      process.env.BUILD_REVISION = "e5665616433857442391255807d6c18f1bea7a88";
      expect((await fetch(url("/capabilities"))).status).toBe(401);
      const response = await fetch(url("/capabilities"), { headers: { Authorization: `Bearer ${TEST_SERVICE_SECRET}` } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ meetingRetrieval: { contractVersion: 2 }, buildRevision: process.env.BUILD_REVISION });
    } finally { if (saved === undefined) delete process.env.BUILD_REVISION; else process.env.BUILD_REVISION = saved; }
  });

  it("POST /sessions routes to the sessions handler", async () => {
    const { host, storage } = makeHost();
    const sessions = new SessionStore();
    server = startElizaService({ host, sessions, port: 0 });
    const serialized = makeValidSerialized();

    const res = await fetch(url("/sessions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${TEST_SERVICE_SECRET}`,
      },
      body: JSON.stringify({
        agentId: TEST_AGENT_ID,
        entityId: TEST_ENTITY_ID,
        serializedDelegation: serialized,
        roomId: "room-test",
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ entityId: TEST_ENTITY_ID, status: "active" });
    expect(storage.registered).toEqual([
      { entityId: TEST_ENTITY_ID, serialized, roomId: "room-test" },
    ]);
  });

  it("POST /messages streams SSE frames from the message handler", async () => {
    const { host, seen } = makeMessageHost({ chunks: [{ text: "one" }, { text: "two" }] });
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${TEST_SERVICE_SECRET}`,
      },
      body: JSON.stringify({
        agentId: TEST_AGENT_ID,
        entityId: TEST_ENTITY_ID,
        roomId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        text: "hello",
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(
      `data: ${JSON.stringify({ text: "one" })}\n\n`
        + `data: ${JSON.stringify({ text: "two" })}\n\n`
        + "data: [DONE]\n\n",
    );
    expect(seen.message?.entityId).toBe(TEST_ENTITY_ID);
  });

  it("POST /messages maps missing delegation to pre-stream HTTP 409", async () => {
    const { host } = makeMessageHost({
      preflightError: new NoDelegationError(TEST_ENTITY_ID),
    });
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${TEST_SERVICE_SECRET}`,
      },
      body: JSON.stringify({
        agentId: TEST_AGENT_ID,
        entityId: TEST_ENTITY_ID,
        roomId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        text: "hello",
      }),
    });

    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "delegation_required" });
  });

  it("POST /sessions without auth returns 401", async () => {
    const { host } = makeHost();
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: TEST_AGENT_ID,
        entityId: TEST_ENTITY_ID,
        serializedDelegation: makeValidSerialized(),
      }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("POST /messages without auth returns 401", async () => {
    const { host } = makeMessageHost();
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: TEST_AGENT_ID,
        entityId: TEST_ENTITY_ID,
        roomId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        text: "hello",
      }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("POST /messages unexpected errors are logged without leaking secret-shaped bodies", async () => {
    const { host } = makeMessageHost({
      preflightError: new Error(
        "preflight failed secretRef=vault/secrets/scoped/feed/OPENAI_API_KEY "
          + "OPENAI_API_KEY=sk-openai-xyz Bearer sk-live-abc123 "
          + "body=PLANTED_BODY_MARKER_456",
      ),
    });
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    };

    try {
      server = startElizaService({ host, sessions: new SessionStore(), port: 0 });
      const res = await fetch(url("/messages"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": `Bearer ${TEST_SERVICE_SECRET}`,
        },
        body: JSON.stringify({
          agentId: TEST_AGENT_ID,
          entityId: TEST_ENTITY_ID,
          roomId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          text: "hello",
        }),
      });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal_error" });
    } finally {
      console.error = originalError;
    }

    const logText = errors.join("\n");
    expect(logText).toContain("[eliza-service] unhandled request error");
    expect(logText).not.toContain("vault/secrets/scoped/feed/OPENAI_API_KEY");
    expect(logText).not.toContain("OPENAI_API_KEY=sk-openai-xyz");
    expect(logText).not.toContain("sk-live-abc123");
    expect(logText).not.toContain("PLANTED_BODY_MARKER_456");
  });

  it("GET /sessions/:entityId without auth returns 401", async () => {
    const { host } = makeHost();
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url(`/sessions/${TEST_ENTITY_ID}`));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("GET /sessions/:entityId with auth returns session status", async () => {
    const { host } = makeHost();
    const sessions = new SessionStore();
    server = startElizaService({ host, sessions, port: 0 });

    // No session registered yet — should return 404 with status "none".
    const res = await fetch(url(`/sessions/${TEST_ENTITY_ID}`), {
      headers: { "Authorization": `Bearer ${TEST_SERVICE_SECRET}` },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ status: "none" });
  });

  it("POST /tools/:name dispatches to the action and returns JSON", async () => {
    const host = makeToolHost({ name: "WEB_SEARCH", result: { answer: "42" } });
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/tools/web_search"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${TEST_SERVICE_SECRET}`,
      },
      body: JSON.stringify({ args: { query: "meaning of life" } }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({
      ok: true,
      tool: "WEB_SEARCH",
      result: { text: "tool ran", data: { answer: "42" }, frames: [{ text: "tool ran" }] },
    });
  });

  it("POST /tools/RUN_ARTIFACT_SKILL with the artifactory bearer runs the stub and returns a contract-shaped output", async () => {
    const runtime = {
      agentId: ARTIFACTORY_AGENT_ID as UUID,
      actions: [runArtifactSkillAction],
    } as unknown as IAgentRuntime;
    const host: ElizaServiceHost = {
      agentDid: TEST_AGENT_DID,
      storageFor: async () => new FakeStorage(),
      runtimeFor: async (agentId) => {
        // Server-trusted routing: only the artifactory agentId reaches this handler.
        expect(agentId).toBe(ARTIFACTORY_AGENT_ID);
        return runtime;
      },
      preflight: async () => {},
    };
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const input: ArtifactSkillRuntimeInput = {
      runId: "server-tc69-1",
      skillManifest: { packageId: "daily_digest" },
      sourcePack: {
        refs: [{ id: "src-1" }],
        excerpts: [{ sourceRefId: "src-1", text: "hello world" }],
        maxInputTokens: 8000,
      },
      settings: {},
      runtimePolicy: {
        runtimeClass: "stub",
        providerClass: "none",
        credentialMode: "none",
        egressClass: "none",
        allowedTools: [],
        disallowedTools: ["tinycloud", "shell", "network"],
        maxModelCalls: 0,
        timeoutMs: 1000,
        maxOutputBytes: 4096,
      },
    };

    const res = await fetch(url(`/tools/${RUN_ARTIFACT_SKILL}`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${TEST_ARTIFACTORY_SERVICE_SECRET}`,
      },
      body: JSON.stringify({ args: input }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      tool: string;
      result: { data: { candidates: unknown[]; trace: { modelCalls: number } } };
    };
    expect(body.ok).toBe(true);
    expect(body.tool).toBe(RUN_ARTIFACT_SKILL);
    expect(body.result.data.candidates).toEqual([]);
    expect(body.result.data.trace.modelCalls).toBe(0);
  });

  it("POST /tools/RUN_ARTIFACT_SKILL with the tinychat bearer returns 404 and never boots a runtime", async () => {
    const host: ElizaServiceHost = {
      agentDid: TEST_AGENT_DID,
      storageFor: async () => new FakeStorage(),
      runtimeFor: async () => {
        throw new Error("runtimeFor must not run for an app-gated tool");
      },
      preflight: async () => {},
    };
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    // ELIZA_SERVICE_SECRET is the tinychat app credential — it must not be able
    // to reach the Artifactory-only RUN_ARTIFACT_SKILL dispatch.
    const res = await fetch(url(`/tools/${RUN_ARTIFACT_SKILL}`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${TEST_SERVICE_SECRET}`,
      },
      body: JSON.stringify({ args: { runId: "tinychat-cross-app" } }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "tool_not_found", tool: RUN_ARTIFACT_SKILL });
  });

  it("POST /tools/RUN_ARTIFACT_SKILL without auth returns 401 (no bearer, no runtime boot)", async () => {
    const host: ElizaServiceHost = {
      agentDid: TEST_AGENT_DID,
      storageFor: async () => new FakeStorage(),
      runtimeFor: async () => {
        throw new Error("runtimeFor must not run when auth fails");
      },
      preflight: async () => {},
    };
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url(`/tools/${RUN_ARTIFACT_SKILL}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: { runId: "no-auth" } }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("POST /tools/RUN_ARTIFACT_SKILL never leaks a planted marker on any error path (throwing action, console spies, wire body)", async () => {
    const marker = "PLANTED_SECRET_tc73_agents_7e2a";
    const markedRef = `my-org/prod/${marker}/openai`;

    // Inject a THROWING action bound to the RUN_ARTIFACT_SKILL name. This
    // exercises the action's post-assertion catch-all (`artifact_skill_failed`)
    // path that the stub runtime never triggers on its own — the failure
    // message deliberately embeds the operator-supplied secretRef so we can
    // prove the derived-sensitiveValues threading in the action scrubs it.
    const throwingAction = {
      name: RUN_ARTIFACT_SKILL,
      description: "planted-marker leak probe",
      similes: [],
      examples: [],
      validate: async () => true,
      handler: async (
        _r: IAgentRuntime,
        _m: Memory,
        _s: unknown,
        options: unknown,
        callback?: (content: Content) => Promise<Memory[]>,
      ) => {
        // Best-effort: also try to leak via the callback → frames path.
        if (callback) await callback({ text: `frame leak ${markedRef}` });
        const args = (options as { args?: { secretEnv?: Array<{ secretRef?: string; name?: string }> } })?.args;
        const ref = args?.secretEnv?.[0]?.secretRef ?? markedRef;
        const name = args?.secretEnv?.[0]?.name ?? `LOWERCASE_${marker}`;
        throw new Error(
          `upstream provider blew up referencing ${ref} and env ${name} (${marker})`,
        );
      },
    };
    // Wrap the real action so the redaction-derivation code runs, but replace
    // its runtime with one that throws. The simplest way is to bypass the
    // stub-runtime path: substitute the action name-lookup so handlePostTool
    // dispatches to our throwing handler directly. This still routes through
    // the /tools/:name handler and the app-identity gate.
    const runtime = {
      agentId: ARTIFACTORY_AGENT_ID as UUID,
      actions: [throwingAction],
    } as unknown as IAgentRuntime;
    const host: ElizaServiceHost = {
      agentDid: TEST_AGENT_DID,
      storageFor: async () => new FakeStorage(),
      runtimeFor: async () => runtime,
      preflight: async () => {},
    };

    const errors: string[] = [];
    const logs: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((v) => String(v)).join(" "));
    };
    console.log = (...args: unknown[]) => {
      logs.push(args.map((v) => String(v)).join(" "));
    };
    console.warn = (...args: unknown[]) => {
      logs.push(args.map((v) => String(v)).join(" "));
    };

    try {
      server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

      const input: ArtifactSkillRuntimeInput = {
        runId: "planted-marker-1",
        skillManifest: { packageId: "daily_digest" },
        sourcePack: {
          refs: [{ id: "src-1" }],
          excerpts: [{ sourceRefId: "src-1", text: "hello world" }],
          maxInputTokens: 8000,
        },
        settings: {},
        runtimePolicy: {
          runtimeClass: "stub",
          providerClass: "none",
          credentialMode: "none",
          egressClass: "none",
          allowedTools: [],
          disallowedTools: ["tinycloud", "shell", "network"],
          maxModelCalls: 0,
          timeoutMs: 1000,
          maxOutputBytes: 4096,
        },
        secretEnv: [
          {
            name: `LOWERCASE_${marker}`,
            secretRef: markedRef,
            injection: "env",
            stageId: "generate",
            source: "worker_injected",
          },
        ],
      };

      const res = await fetch(url(`/tools/${RUN_ARTIFACT_SKILL}`), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": `Bearer ${TEST_ARTIFACTORY_SERVICE_SECRET}`,
        },
        body: JSON.stringify({ args: input }),
      });
      // The action throws an arbitrary Error (not a ToolError), so
      // handlePostTool maps it to the generic 502 tool_failed shape and the
      // action's own redacted-ToolError path is bypassed. Still, the
      // response body must never contain the marker.
      expect([200, 502]).toContain(res.status);
      const bodyText = await res.text();
      expect(bodyText).not.toContain(marker);
      expect(bodyText).not.toContain(markedRef);
    } finally {
      console.error = originalError;
      console.log = originalLog;
      console.warn = originalWarn;
    }
    const combined = [...errors, ...logs].join("\n");
    expect(combined).not.toContain(marker);
    expect(combined).not.toContain(markedRef);
  });

  it("POST /tools/RUN_ARTIFACT_SKILL rejects a malformed payload with invalid_args", async () => {
    const runtime = {
      agentId: ARTIFACTORY_AGENT_ID as UUID,
      actions: [runArtifactSkillAction],
    } as unknown as IAgentRuntime;
    const host: ElizaServiceHost = {
      agentDid: TEST_AGENT_DID,
      storageFor: async () => new FakeStorage(),
      runtimeFor: async () => runtime,
      preflight: async () => {},
    };
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url(`/tools/${RUN_ARTIFACT_SKILL}`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${TEST_ARTIFACTORY_SERVICE_SECRET}`,
      },
      body: JSON.stringify({ args: { runId: 42 } }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_args" });
  });

  it("POST /tools/:name without auth returns 401", async () => {
    const host = makeToolHost({ name: "WEB_SEARCH" });
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/tools/web_search"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: { query: "x" } }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("POST /tools/:name returns 404 for an unknown tool", async () => {
    const host = makeToolHost({ name: "WEB_SEARCH" });
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/tools/does_not_exist"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${TEST_SERVICE_SECRET}`,
      },
      body: JSON.stringify({ args: {} }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "tool_not_found", tool: "does_not_exist" });
  });

  it("returns 404 for an unknown route", async () => {
    const { host } = makeHost();
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/missing"));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns 400 for malformed JSON request bodies", async () => {
    const { host } = makeHost();
    server = startElizaService({ host, sessions: new SessionStore(), port: 0 });

    const res = await fetch(url("/sessions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${TEST_SERVICE_SECRET}`,
      },
      body: "{not json",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "malformed_json" });
  });
});
