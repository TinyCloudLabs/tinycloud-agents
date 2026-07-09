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

  it("redacts secret refs and inline credential material from the service response", async () => {
    const h = track(
      spawn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            tool: RUN_ARTIFACT_SKILL,
            result: {
              data: {
                ...stubOutput(),
                candidates: [
                  {
                    title: "vault/secrets/scoped/feed/OPENAI_API_KEY",
                    body: { text: "OPENAI_API_KEY=sk-test" },
                  },
                ],
                trace: {
                  ...stubOutput().trace,
                  toolCalls: [{ name: "demo", purpose: "secretRef=vault/secrets/scoped/feed/OPENAI_API_KEY" }],
                  stageTrace: [
                    {
                      stageId: "stub",
                      declaredCapabilities: [],
                      grantedCapabilities: [],
                      authorityUsed: false,
                      deniedReasons: ["Bearer sk-live-abc123"],
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const runtime = createHttpArtifactSkillRuntime({ baseUrl: h.baseUrl, serviceSecret: BEARER });
    const input = makeContractRuntimeInput({
      secretEnv: [
        {
          name: "OPENAI_API_KEY",
          secretRef: "vault/secrets/scoped/feed/OPENAI_API_KEY",
          injection: "env",
          stageId: "stub",
          source: "worker_injected",
        },
      ],
    });

    const output = await runtime.run(input);

    expect(JSON.stringify(output)).not.toContain("vault/secrets/scoped/feed/OPENAI_API_KEY");
    expect(JSON.stringify(output)).not.toContain("sk-test");
    expect(JSON.stringify(output)).not.toContain("sk-live-abc123");
    expect(output.candidates[0]?.title).toContain("[REDACTED]");
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
        new Response(
          JSON.stringify({
            error: "tool_failed secretRef=vault/secrets/scoped/feed/OPENAI_API_KEY OPENAI_API_KEY=sk-oai-abc",
            body: { text: "PLANTED_BODY_MARKER_123" },
          }),
          {
            status: 502,
            headers: { "content-type": "application/json" },
          },
        ),
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
    expect(message).not.toContain(BAD_BEARER_SNIPPET);
    expect(message).not.toContain("tool_failed");
    expect(message).not.toContain("vault/secrets/scoped/feed/OPENAI_API_KEY");
    expect(message).not.toContain("OPENAI_API_KEY");
    expect(message).not.toContain("PLANTED_BODY_MARKER_123");
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

  it("rejects malformed nested stageTrace entries", async () => {
    const malformed = stubOutput();
    (malformed.trace as { stageTrace: unknown }).stageTrace = [
      { stageId: 42, declaredCapabilities: "not-an-array" },
    ];
    const h = track(
      spawn(async () =>
        new Response(
          JSON.stringify({ ok: true, tool: RUN_ARTIFACT_SKILL, result: { data: malformed } }),
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

  it("rejects malformed nested droppedCandidates entries", async () => {
    const malformed = stubOutput();
    (malformed.trace as { droppedCandidates: unknown }).droppedCandidates = [
      { reason: 7, localCandidateId: { nested: "object" } },
    ];
    const h = track(
      spawn(async () =>
        new Response(
          JSON.stringify({ ok: true, tool: RUN_ARTIFACT_SKILL, result: { data: malformed } }),
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

  // Planted-marker regression: operator-supplied secretRef material (custom
  // vault prefix, lowercase name) is threaded through `input.secretEnv` into
  // every error path AND the 200 output redactor. The marker must NEVER appear
  // in thrown Errors, in the returned ArtifactSkillRuntimeOutput, or on any
  // console.* method the adapter might touch.
  describe("planted-marker redaction (input.secretEnv → error paths + output)", () => {
    const MARKER = "PLANTED_SECRET_tc73_agents_7e2a";
    const MARKED_REF = `my-org/prod/${MARKER}/openai`;

    function markedInput() {
      return makeContractRuntimeInput({
        secretEnv: [
          {
            // secret.name is the *env var* the runtime expects. In real use this
            // is often an all-caps identifier; here we use the bare marker so
            // any raw appearance of the marker anywhere in the redactor's input
            // is caught by the sensitiveValues allowlist (proving the wiring
            // covers bare-token forms, not just KEY=value or vault/ path forms).
            name: MARKER,
            secretRef: MARKED_REF,
            injection: "env",
            stageId: "stub",
            source: "worker_injected",
          },
        ],
      });
    }

    async function withConsoleSpy<T>(fn: () => Promise<T>): Promise<{ result: T; logText: string }> {
      const captured: string[] = [];
      const originalError = console.error;
      const originalLog = console.log;
      const originalWarn = console.warn;
      const originalInfo = console.info;
      const push = (...args: unknown[]) => {
        captured.push(args.map((value) => (value instanceof Error ? value.message : String(value))).join(" "));
      };
      console.error = push;
      console.log = push;
      console.warn = push;
      console.info = push;
      try {
        const result = await fn();
        return { result, logText: captured.join("\n") };
      } finally {
        console.error = originalError;
        console.log = originalLog;
        console.warn = originalWarn;
        console.info = originalInfo;
      }
    }

    it("scrubs the marker from a 502 non-2xx error path (body embeds the marker)", async () => {
      const h = track(
        spawn(async () =>
          new Response(
            JSON.stringify({
              error: `upstream ${MARKED_REF} LOWERCASE_${MARKER} api_key=${MARKER}`,
            }),
            { status: 502, headers: { "content-type": "application/json" } },
          ),
        ),
      );
      const runtime = createHttpArtifactSkillRuntime({ baseUrl: h.baseUrl, serviceSecret: BEARER });

      const { logText } = await withConsoleSpy(async () => {
        let caught: unknown;
        try {
          await runtime.run(markedInput());
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        const message = (caught as Error).message;
        expect(message).toMatch(/502/);
        expect(message).not.toContain(MARKER);
        expect(message).not.toContain(MARKED_REF);
      });
      expect(logText).not.toContain(MARKER);
    });

    it("scrubs the marker from a malformed-envelope path (server 200 with garbage body)", async () => {
      const h = track(
        spawn(async () =>
          new Response(
            JSON.stringify({ envelope_from: MARKED_REF, marker: MARKER }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      );
      const runtime = createHttpArtifactSkillRuntime({ baseUrl: h.baseUrl, serviceSecret: BEARER });

      const { logText } = await withConsoleSpy(async () => {
        let caught: unknown;
        try {
          await runtime.run(markedInput());
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        const message = (caught as Error).message;
        expect(message).toMatch(/malformed envelope/);
        expect(message).not.toContain(MARKER);
        expect(message).not.toContain(MARKED_REF);
      });
      expect(logText).not.toContain(MARKER);
    });

    it("scrubs the marker from a non-JSON response error", async () => {
      const h = track(
        spawn(async () =>
          new Response(`<html>${MARKED_REF} ${MARKER}</html>`, {
            status: 502,
            headers: { "content-type": "text/html" },
          }),
        ),
      );
      const runtime = createHttpArtifactSkillRuntime({ baseUrl: h.baseUrl, serviceSecret: BEARER });

      const { logText } = await withConsoleSpy(async () => {
        let caught: unknown;
        try {
          await runtime.run(markedInput());
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        const message = (caught as Error).message;
        expect(message).toMatch(/non-JSON/);
        expect(message).not.toContain(MARKER);
        expect(message).not.toContain(MARKED_REF);
      });
      expect(logText).not.toContain(MARKER);
    });

    it("scrubs the marker from a 200 body that embeds it verbatim (candidate + trace)", async () => {
      const h = track(
        spawn(async () =>
          new Response(
            JSON.stringify({
              ok: true,
              tool: RUN_ARTIFACT_SKILL,
              result: {
                data: {
                  ...stubOutput(),
                  candidates: [
                    {
                      title: `uses ${MARKED_REF}`,
                      body: { text: `LOWERCASE_${MARKER}=${MARKER}` },
                    },
                  ],
                  trace: {
                    ...stubOutput().trace,
                    toolCalls: [{ name: "demo", purpose: `secretRef=${MARKED_REF}` }],
                    stageTrace: [
                      {
                        stageId: "stub",
                        declaredCapabilities: [],
                        grantedCapabilities: [],
                        authorityUsed: false,
                        deniedReasons: [`missing ${MARKER}`],
                      },
                    ],
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      );
      const runtime = createHttpArtifactSkillRuntime({ baseUrl: h.baseUrl, serviceSecret: BEARER });

      const output = await runtime.run(markedInput());
      const serialized = JSON.stringify(output);
      expect(serialized).not.toContain(MARKER);
      expect(serialized).not.toContain(MARKED_REF);
      expect(serialized).toContain("[REDACTED]");
    });

    it("scrubs the marker on a network error path (fetch rejects with a marker-embedded reason)", async () => {
      const runtime = createHttpArtifactSkillRuntime({
        baseUrl: "http://127.0.0.1:1",
        serviceSecret: BEARER,
        fetch: (async () => {
          throw new Error(`connect ECONNREFUSED ${MARKED_REF} ${MARKER}`);
        }) as unknown as typeof fetch,
      });

      const { logText } = await withConsoleSpy(async () => {
        let caught: unknown;
        try {
          await runtime.run(markedInput());
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        const message = (caught as Error).message;
        expect(message).not.toContain(MARKER);
        expect(message).not.toContain(MARKED_REF);
      });
      expect(logText).not.toContain(MARKER);
    });
  });
});
