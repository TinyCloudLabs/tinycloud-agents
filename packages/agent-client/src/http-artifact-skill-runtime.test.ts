import { afterEach, describe, expect, it } from "bun:test";
import {
  RUN_ARTIFACT_SKILL,
  createStubArtifactSkillRuntime,
  type ArtifactSkillRuntimeOutput,
} from "./artifact-skill-runtime";
import { createHttpArtifactSkillRuntime } from "./http-artifact-skill-runtime";
import {
  makeContractRuntimeInput,
  runArtifactSkillRuntimeContract,
} from "./artifact-skill-runtime-contract.testing";

const BEARER = "test-artifactory-service-secret";
const BAD_BEARER_SNIPPET = "test-artifactory-service-secret";

interface BunServer {
  hostname: string;
  port: number;
  stop(closeActive?: boolean): void | Promise<void>;
}

declare const Bun: {
  serve(opts: {
    hostname: string;
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): BunServer;
};

function stubOutput(): ArtifactSkillRuntimeOutput {
  return {
    candidates: [],
    trace: {
      procedureVersion: "stub.v1",
      modelCalls: 0,
      toolCalls: [],
      stageTrace: [
        {
          stageId: "stub",
          declaredCapabilities: [],
          grantedCapabilities: [],
          authorityUsed: false,
          deniedReasons: [],
        },
      ],
      droppedCandidates: [],
    },
  };
}

type ServeFetch = (request: Request) => Response | Promise<Response>;

interface HarnessResult {
  server: BunServer;
  observed: { authorization?: string; body?: unknown };
  baseUrl: string;
}

function spawn(handler: ServeFetch): HarnessResult {
  const observed: { authorization?: string; body?: unknown } = {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      observed.authorization = request.headers.get("authorization") ?? undefined;
      try {
        observed.body = await request.clone().json();
      } catch {
        observed.body = undefined;
      }
      return handler(request);
    },
  });
  return { server, observed, baseUrl: `http://${server.hostname}:${server.port}` };
}

// -- Contract suite: HTTP variant runs against a Bun.serve stub that mimics the
// eliza-service /tools/RUN_ARTIFACT_SKILL envelope. The real-service substitution
// proof lives in packages/eliza-service (it spawns startElizaService).
runArtifactSkillRuntimeContract("stub runtime", () => createStubArtifactSkillRuntime());

const httpContractHarness = spawn(async () =>
  new Response(
    JSON.stringify({ ok: true, tool: RUN_ARTIFACT_SKILL, result: { data: stubOutput(), frames: [] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  ),
);
runArtifactSkillRuntimeContract("http runtime (endpoint-envelope stand-in)", () =>
  createHttpArtifactSkillRuntime({ baseUrl: httpContractHarness.baseUrl, serviceSecret: BEARER }),
);

describe("createHttpArtifactSkillRuntime — adapter behavior", () => {
  const servers: BunServer[] = [];
  afterEach(async () => {
    while (servers.length) {
      const s = servers.pop();
      if (s) await s.stop(true);
    }
  });

  function track(h: HarnessResult): HarnessResult {
    servers.push(h.server);
    return h;
  }

  it("advertises the canonical tool name without a network call", () => {
    const runtime = createHttpArtifactSkillRuntime({
      baseUrl: "http://127.0.0.1:1",
      serviceSecret: BEARER,
    });
    expect(runtime.tool).toBe(RUN_ARTIFACT_SKILL);
  });

  it("POSTs the input under { args } to /tools/RUN_ARTIFACT_SKILL with a Bearer header", async () => {
    const h = track(
      spawn(async () =>
        new Response(
          JSON.stringify({ ok: true, tool: RUN_ARTIFACT_SKILL, result: { data: stubOutput() } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const runtime = createHttpArtifactSkillRuntime({ baseUrl: h.baseUrl, serviceSecret: BEARER });

    const input = makeContractRuntimeInput({ runId: "http-1" });
    const output = await runtime.run(input);

    expect(output.trace.procedureVersion).toBe("stub.v1");
    expect(h.observed.authorization).toBe(`Bearer ${BEARER}`);
    expect(h.observed.body).toEqual({ args: input as unknown as Record<string, unknown> });
  });

  it("tolerates a trailing slash on baseUrl", async () => {
    const h = track(
      spawn(async (req) => {
        const url = new URL(req.url);
        if (url.pathname !== `/tools/${RUN_ARTIFACT_SKILL}`) {
          return new Response(JSON.stringify({ error: "wrong_path" }), { status: 404 });
        }
        return new Response(
          JSON.stringify({ ok: true, tool: RUN_ARTIFACT_SKILL, result: { data: stubOutput() } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const runtime = createHttpArtifactSkillRuntime({
      baseUrl: `${h.baseUrl}/`,
      serviceSecret: BEARER,
    });
    const output = await runtime.run(makeContractRuntimeInput());
    expect(output.trace.modelCalls).toBe(0);
  });

  it("aborts and throws a redacted timeout error when the response exceeds runtimePolicy.timeoutMs", async () => {
    const h = track(
      spawn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return new Response("{}", { status: 200 });
      }),
    );
    const runtime = createHttpArtifactSkillRuntime({
      baseUrl: h.baseUrl,
      serviceSecret: `${BEARER}-timeout`,
    });
    const input = makeContractRuntimeInput({
      runtimePolicy: {
        ...makeContractRuntimeInput().runtimePolicy,
        timeoutMs: 25,
      },
    });

    let caught: unknown;
    try {
      await runtime.run(input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/timed out/i);
    // Redaction boundary: the bearer must never appear in the thrown message.
    expect(message).not.toContain(BAD_BEARER_SNIPPET);
  });

  it("throws a redacted error on 502 tool_failed responses", async () => {
    const h = track(
      spawn(async () =>
        new Response(JSON.stringify({ error: "tool_failed" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const runtime = createHttpArtifactSkillRuntime({
      baseUrl: h.baseUrl,
      serviceSecret: `${BEARER}-502`,
    });

    let caught: unknown;
    try {
      await runtime.run(makeContractRuntimeInput());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/502/);
    expect(message).toMatch(/tool_failed/);
    expect(message).not.toContain(BAD_BEARER_SNIPPET);
  });

  it("throws a redacted error on 401 unauthorized responses (without leaking the bearer)", async () => {
    const h = track(
      spawn(async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const runtime = createHttpArtifactSkillRuntime({
      baseUrl: h.baseUrl,
      serviceSecret: `${BEARER}-401`,
    });

    let caught: unknown;
    try {
      await runtime.run(makeContractRuntimeInput());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/401/);
    expect(message).not.toContain(BAD_BEARER_SNIPPET);
  });

  it("throws a redacted error on malformed envelope (missing ok)", async () => {
    const h = track(
      spawn(async () =>
        new Response(JSON.stringify({ result: { data: stubOutput() } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const runtime = createHttpArtifactSkillRuntime({
      baseUrl: h.baseUrl,
      serviceSecret: BEARER,
    });

    await expect(runtime.run(makeContractRuntimeInput())).rejects.toThrow(/malformed envelope/);
  });

  it("throws a redacted error when the data field is not an ArtifactSkillRuntimeOutput", async () => {
    const h = track(
      spawn(async () =>
        new Response(
          JSON.stringify({ ok: true, tool: RUN_ARTIFACT_SKILL, result: { data: { candidates: "nope" } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const runtime = createHttpArtifactSkillRuntime({
      baseUrl: h.baseUrl,
      serviceSecret: BEARER,
    });

    await expect(runtime.run(makeContractRuntimeInput())).rejects.toThrow(/malformed ArtifactSkillRuntimeOutput/);
  });

  it("throws a redacted error when the server returns non-JSON", async () => {
    const h = track(
      spawn(async () =>
        new Response("<html>oops</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const runtime = createHttpArtifactSkillRuntime({
      baseUrl: h.baseUrl,
      serviceSecret: BEARER,
    });

    await expect(runtime.run(makeContractRuntimeInput())).rejects.toThrow(/non-JSON/);
  });

  it("asserts the authority invariant client-side before making a network call", async () => {
    let hit = false;
    const h = track(
      spawn(async () => {
        hit = true;
        return new Response("{}", { status: 200 });
      }),
    );
    const runtime = createHttpArtifactSkillRuntime({
      baseUrl: h.baseUrl,
      serviceSecret: BEARER,
    });

    const bad = makeContractRuntimeInput({
      runtimePolicy: {
        ...makeContractRuntimeInput().runtimePolicy,
        allowedTools: ["tinycloud"],
      },
    });
    await expect(runtime.run(bad)).rejects.toThrow(/ambient tinycloud authority/);
    expect(hit).toBe(false);
  });

  it("redacts bearer tokens carried in server error bodies", async () => {
    const h = track(
      spawn(async () =>
        new Response(
          JSON.stringify({
            error: "leaky Bearer sk-live-secret-token OPENAI_API_KEY=sk-oai-abc",
          }),
          { status: 502, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const runtime = createHttpArtifactSkillRuntime({
      baseUrl: h.baseUrl,
      serviceSecret: BEARER,
    });

    let caught: unknown;
    try {
      await runtime.run(makeContractRuntimeInput());
    } catch (err) {
      caught = err;
    }
    // The error body is not passed through verbatim — only the code field is
    // read, so provider material embedded in a malicious server response cannot
    // resurface in the thrown Error. Explicit assertions defend both paths.
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain("sk-live-secret-token");
    expect(message).not.toContain("sk-oai-abc");
  });
});
