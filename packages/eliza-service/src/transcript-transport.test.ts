import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { DelegatedAccess } from "@tinycloud/node-sdk";
import type { InvokeFunction, PortableDelegation, TinyCloudSession } from "@tinycloud/node-sdk";
import { createReader } from "./transcript-registry.js";
import { readMeeting } from "./actions/tinycloud-search-transcripts.js";
import { createTranscriptFetch, createTranscriptServices, TRANSCRIPT_RESPONSE_BYTE_LIMIT as LIMIT } from "./transcript-transport.js";

function streamed(payload: string, init: ResponseInit = {}, chunkSize = 65_536) {
  const bytes = new TextEncoder().encode(payload);
  let delivered = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (delivered === bytes.byteLength) { controller.close(); return; }
      const chunk = bytes.slice(delivered, delivered + chunkSize);
      delivered += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), init);
  return { response, state: () => ({ delivered, cancelled }) };
}

describe("transcript response byte limit", () => {
  test("stops before SDK buffering when a decoded response exceeds 1 MiB", async () => {
    const input = streamed("x".repeat(2 * LIMIT));
    const fetch = createTranscriptFetch(async () => input.response);
    await expect(fetch("http://synthetic.invalid/invoke")).rejects.toMatchObject({ code: "TRANSCRIPT_RESPONSE_SIZE_LIMIT" });
    expect(input.state()).toEqual({ delivered: LIMIT + 65_536, cancelled: true });
  });

  for (const size of [LIMIT - 1, LIMIT]) test(`retains a ${size}-byte response without using its text/json methods`, async () => {
    const payload = "x".repeat(size);
    const input = streamed(payload);
    input.response.text = async () => { throw new Error("upstream buffering forbidden"); };
    input.response.json = async () => { throw new Error("upstream buffering forbidden"); };
    const response = await createTranscriptFetch(async () => input.response)("http://synthetic.invalid/invoke");
    expect(await response.text()).toBe(payload);
    expect(input.state()).toEqual({ delivered: size, cancelled: false });
  });

  const headerCases: Record<string, string>[] = [{}, { "content-length": "1" }, { "content-length": String(8 * LIMIT) }, { "content-encoding": "gzip", "content-length": "20" }];
  for (const headers of headerCases) {
    test(`counts decoded chunks independently of ${JSON.stringify(headers)}`, async () => {
      const input = streamed("🙂".repeat(LIMIT / 4 + 1), { headers }, 257);
      const fetch = createTranscriptFetch(async () => input.response);
      await expect(fetch("http://synthetic.invalid/invoke")).rejects.toMatchObject({ code: "TRANSCRIPT_RESPONSE_SIZE_LIMIT" });
      expect(input.state().cancelled).toBe(true);
    });
  }

  test("allows split multibyte text exactly at the byte limit", async () => {
    const payload = "🙂".repeat(LIMIT / 4);
    const input = streamed(payload, { headers: { "content-length": "0" } }, 257);
    const response = await createTranscriptFetch(async () => input.response)("http://synthetic.invalid/invoke");
    expect(await response.text()).toBe(payload);
  });

  test("cancels a pending body read when the source ignores the fetch signal", async () => {
    const abort = new AbortController();
    let cancelled = false;
    let started!: () => void;
    const pulling = new Promise<void>(resolve => { started = resolve; });
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() { started(); return new Promise(() => {}); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
    const result = createTranscriptFetch(async () => response)("http://synthetic.invalid/invoke", { signal: abort.signal });
    await pulling;
    abort.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });

  test("does not call fetch for an already aborted request", async () => {
    let called = false;
    const abort = new AbortController(); abort.abort();
    const result = createTranscriptFetch(async () => { called = true; return new Response("late"); })("http://synthetic.invalid/invoke", { signal: abort.signal });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(called).toBe(false);
  });

  test("rejects promptly and cancels a late response from a fetch that ignores abort", async () => {
    const abort = new AbortController();
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const result = createTranscriptFetch(() => pending)("http://synthetic.invalid/invoke", { signal: abort.signal });
    abort.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    const input = streamed("late"); release(input.response);
    await Promise.resolve(); await Promise.resolve();
    expect(input.state()).toEqual({ delivered: 0, cancelled: true });
  });

  for (const status of [401, 403, 404, 500]) test(`bounds error response ${status} and retains its status on overflow`, async () => {
    const input = streamed("x".repeat(2 * LIMIT), { status });
    await expect(createTranscriptFetch(async () => input.response)("http://synthetic.invalid/invoke"))
      .rejects.toMatchObject({ code: "TRANSCRIPT_RESPONSE_SIZE_LIMIT", status });
    expect(input.state().cancelled).toBe(true);
  });

  test("bounds native fetch's gzip expansion rather than compressed Content-Length", async () => {
    const compressed = gzipSync("x".repeat(2 * LIMIT));
    expect(compressed.byteLength).toBeLessThan(LIMIT);
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-encoding": "gzip", "content-length": compressed.byteLength });
      response.end(compressed);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing loopback test address");
      await expect(createTranscriptFetch(globalThis.fetch.bind(globalThis))(`http://127.0.0.1:${address.port}/invoke`))
        .rejects.toMatchObject({ code: "TRANSCRIPT_RESPONSE_SIZE_LIMIT", status: 200 });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  });
});

const PATH = "xyz.tinycloud.tinychat/connectors";
const SESSION = {
  delegationHeader: { Authorization: "Bearer synthetic-activated-session" },
  delegationCid: "synthetic-activated-cid", spaceId: "synthetic-owner-space",
  verificationMethod: "did:key:synthetic-session", jwk: {}, address: "synthetic-owner", chainId: 1,
  sessionKey: "{}", siwe: "", signature: "",
} satisfies TinyCloudSession;
const GRANT = {
  cid: "synthetic-portable-cid", delegationHeader: { Authorization: "Bearer synthetic-parent" },
  delegateDID: "did:key:synthetic-session", spaceId: SESSION.spaceId, path: `${PATH}/`,
  actions: ["tinycloud.kv/get", "tinycloud.sql/read"], expiry: new Date(Date.now() + 3_600_000),
  ownerAddress: SESSION.address, chainId: 1, host: "http://synthetic.invalid",
} satisfies PortableDelegation;

function services(fetch: Parameters<typeof createTranscriptServices>[3], invoke: InvokeFunction = () => ({ Authorization: "synthetic-invocation" })) {
  const access = new DelegatedAccess(SESSION, GRANT, GRANT.host, invoke);
  return createTranscriptServices(access, "http://wrong-fallback.invalid", { invoke }, fetch);
}

describe("pinned SDK transcript service integration", () => {
  test("uses the activated session, delegated host, SDK actions and prefix through public APIs", async () => {
    const calls: Parameters<InvokeFunction>[] = [];
    const requests: Array<{ url: string; body?: unknown }> = [];
    const service = services(async (url, init) => {
      requests.push({ url, body: init?.body });
      expect(init?.headers).toEqual({ Authorization: "synthetic-invocation" });
      return new Response(init?.body ? '{"rows":[]}' : '"bounded body"');
    }, (...args) => { calls.push(args); return { Authorization: "synthetic-invocation" }; });
    await service.kv.get("child", { raw: true });
    await service.sql.db(PATH).query("SELECT id FROM connector_meeting WHERE id = ?", ["meeting"]);
    expect(calls.map(call => call.slice(1))).toEqual([
      ["kv", `${PATH}/child`, "tinycloud.kv/get"],
      ["sql", PATH, "tinycloud.sql/read"],
    ]);
    for (const call of calls) expect(call[0]).toMatchObject({
      delegationHeader: SESSION.delegationHeader, delegationCid: SESSION.delegationCid,
      spaceId: SESSION.spaceId, verificationMethod: SESSION.verificationMethod, jwk: SESSION.jwk,
    });
    expect(requests.map(request => request.url)).toEqual([`${GRANT.host}/invoke`, `${GRANT.host}/invoke`]);
    expect(JSON.parse(requests[1].body as string)).toEqual({ action: "query", sql: "SELECT id FROM connector_meeting WHERE id = ?", params: ["meeting"] });
  });

  test("returns typed body size_limit through the real SDK without consuming a 2 MiB stream", async () => {
    const input = streamed(JSON.stringify("x".repeat(2 * LIMIT)));
    const reader = createReader(services(async () => input.response));
    expect(await reader.readBody!("fireflies", "synthetic")).toMatchObject({ state: "size_limit", reasonCode: "TRANSCRIPT_RESPONSE_SIZE_LIMIT" });
    expect(input.state()).toEqual({ delivered: LIMIT + 65_536, cancelled: true });
  });

  test("bounds oversized SQL metadata before SDK json parsing", async () => {
    const input = streamed(JSON.stringify({ rows: [["synthetic", "fireflies", "synthetic", "Synthetic", "2026-09-01T12:00:00Z", null, "[]", "s".repeat(2 * LIMIT), null, "{}"]] }));
    input.response.json = async () => { throw new Error("unbounded upstream json forbidden"); };
    const reader = createReader(services(async () => input.response));
    await expect(reader.getMetadata!("synthetic")).rejects.toMatchObject({ code: "transcript_unavailable" });
    expect(input.state()).toEqual({ delivered: LIMIT + 65_536, cancelled: true });
  });

  for (const status of [401, 403]) for (const body of ["permission denied", "Space not found", "x".repeat(2 * LIMIT)]) {
    test(`preserves access denial for HTTP ${status} with ${body.length} error bytes`, async () => {
      for (const operation of ["kv", "sql"]) {
        const input = streamed(body, { status });
        const reader = createReader(services(async () => input.response));
        const result = operation === "kv" ? reader.readBody!("fireflies", "synthetic") : reader.getMetadata!("synthetic");
        await expect(result).rejects.toMatchObject({ code: "access_denied" });
        if (body.length > LIMIT) expect(input.state().cancelled).toBe(true);
      }
    });
  }

  test("does not call a truncated HTTP 404 body a missing transcript", async () => {
    const input = streamed("x".repeat(2 * LIMIT), { status: 404 });
    const reader = createReader(services(async () => input.response));
    expect(await reader.readBody!("fireflies", "synthetic")).toMatchObject({ state: "unavailable", reasonCode: "TRANSCRIPT_RESPONSE_SIZE_LIMIT" });
  });

  test("preserves stored summary evidence when the transcript body exceeds the transport limit", async () => {
    const row = ["synthetic", "fireflies", "synthetic", "Synthetic", "2026-09-01T12:00:00Z", null, "[]", "The team chose September 12 for launch.", null, "{}"];
    const input = streamed(JSON.stringify("x".repeat(2 * LIMIT)));
    const reader = createReader(services(async (_url, init) => init?.body ? new Response(JSON.stringify({ rows: [row] })) : input.response));
    const result = await readMeeting(reader, { meetingRef: "synthetic", focus: "summary", includeBody: true });
    expect(JSON.stringify(result.data)).toContain("September 12");
    expect(JSON.stringify(result.data)).toContain("size_limit");
    expect(input.state().cancelled).toBe(true);
  });

  for (const status of [401, 403]) test(`HTTP ${status} availability wording suppresses already retrieved summary evidence`, async () => {
    const row = ["synthetic", "fireflies", "synthetic", "Synthetic", "2026-09-01T12:00:00Z", null, "[]", "Private summary must not escape.", null, "{}"];
    const reader = createReader(services(async (_url, init) => init?.body
      ? new Response(JSON.stringify({ rows: [row] }))
      : new Response("Space not found", { status })));
    await expect(readMeeting(reader, { meetingRef: "synthetic", focus: "summary", includeBody: true }))
      .rejects.toMatchObject({ code: "access_denied" });
  });

  test("propagates a retrieval deadline into real SDK cancellation", async () => {
    let cancelled = false;
    let sdkSignal: AbortSignal | undefined;
    const reader = createReader(services(async (_url, init) => {
      sdkSignal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        pull() { return new Promise(() => {}); }, cancel() { cancelled = true; },
      }));
    }));
    await expect(reader.readBody!("fireflies", "synthetic", { deadlineAt: Date.now() + 20 })).rejects.toMatchObject({ code: "retrieval_timeout" });
    expect(sdkSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  test("isolates concurrent capped, successful and cancelled SDK body reads", async () => {
    const oversized = streamed(JSON.stringify("x".repeat(2 * LIMIT)));
    const exact = streamed(JSON.stringify("x".repeat(LIMIT - 2)));
    const abort = new AbortController();
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    let cancelled = false;
    let cancellationFinished!: () => void;
    const cancellation = new Promise<void>(resolve => { cancellationFinished = resolve; });
    const reader = createReader(services(async (_url, init) => {
      const path = (init?.headers as Record<string, string>).path;
      if (path.endsWith("/large")) return oversized.response;
      if (path.endsWith("/exact")) return exact.response;
      return new Response(new ReadableStream<Uint8Array>({
        pull() { started(); return new Promise(() => {}); }, cancel() { cancelled = true; cancellationFinished(); },
      }));
    }, (_session, _service, path) => ({ path })));
    const reads = [
      reader.readBody!("fireflies", "large"),
      reader.readBody!("fireflies", "exact"),
      reader.readBody!("fireflies", "cancel", { signal: abort.signal }),
    ];
    const outcomes = Promise.allSettled(reads);
    await pending; abort.abort();
    expect(await outcomes).toMatchObject([
      { status: "fulfilled", value: { state: "size_limit" } },
      { status: "fulfilled", value: { state: "present" } },
      { status: "rejected", reason: { code: "retrieval_cancelled" } },
    ]);
    expect(oversized.state()).toEqual({ delivered: LIMIT + 65_536, cancelled: true });
    expect(exact.state()).toEqual({ delivered: LIMIT, cancelled: false });
    await cancellation;
    expect(cancelled).toBe(true);
  });
});
