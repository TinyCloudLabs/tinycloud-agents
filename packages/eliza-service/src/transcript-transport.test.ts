import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { DelegatedAccess } from "@tinycloud/node-sdk";
import type { InvokeFunction, PortableDelegation, TinyCloudSession } from "@tinycloud/node-sdk";
import { createReader } from "./transcript-registry.js";
import { sha256 } from "./meeting-evidence.js";
import { tinycloudReadMeetingAction, setTranscriptRegistry } from "./actions/tinycloud-search-transcripts.js";
import { handlePostTool } from "./handlers/tools.js";
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
  test("stops before SDK buffering when a decoded response exceeds 2 MiB", async () => {
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

});
function snapshotFixture(text="Synthetic transcript",sourceId="synthetic") {
  const snapshot=JSON.stringify({contractVersion:3,meetingRef:sourceId,source:"fireflies",sourceId,operationId:"op",createdAt:"2026-09-14T00:00:00Z",
    metadata:{title:"Fixture",startedAt:null,organizerEmail:null,participants:[],metadata:{}},body:{basis:"transcript",encoding:"utf-8",schema:"text",raw:text,
    original:{digest:sha256(text),byteLength:Buffer.byteLength(text),recordCount:1,extent:"unknown",captureComplete:null},omissions:[]},overview:null,aliases:[]});
  const revision=sha256(snapshot), row=[sourceId,"fireflies",sourceId,"Fixture",null,null,"[]","{}",revision,null,"published"];
  const args={contractVersion:3,reference:{meetingRef:sourceId,source:"fireflies",sourceId,revision},basis:"transcript"} as const;
  return {snapshot,row,args};
}
function exactReader(fixture:ReturnType<typeof snapshotFixture>,body:()=>Promise<Response> = async()=>new Response(fixture.snapshot)) {
  return createReader(services(async (_url,init)=>init?.body ? new Response(JSON.stringify({rows:[fixture.row]})) : body()));
}
describe("pinned SDK version 3 evidence transport",()=>{
  test("transports a complete 1 MiB original body through SDK, exact action and full dispatcher framing",async()=>{
    const fixture=snapshotFixture("🙂".repeat(1_048_576/4));let calls=0;
    const reader=exactReader(fixture,async()=>{calls++;return streamed(fixture.snapshot,{},257).response;});
    const runtime={actions:[tinycloudReadMeetingAction]} as any;setTranscriptRegistry(runtime,{readerFor:()=>reader});
    const response=await handlePostTool("tinycloud_read_meeting","synthetic-agent",{entityId:"owner",args:fixture.args},{runtimeFor:async()=>runtime});
    expect(response.status).toBe(200);const result=(response.body as any).result;
    expect(result.data.state).toBe("complete");expect(result.data.spans[0].text).toBe("🙂".repeat(1_048_576/4));
    expect(result.frames).toEqual([]);expect(result.text).toBe("");expect(Buffer.byteLength(JSON.stringify(response.body))).toBeLessThanOrEqual(LIMIT);expect(calls).toBe(1);
  });
  test("returns capacity when complete stored snapshot exceeds the framing limit",async()=>{
    const fixture=snapshotFixture();const input=streamed("x".repeat(2*LIMIT));
    const result=await exactReader(fixture,async()=>input.response).readEvidence(fixture.args);
    expect(result).toMatchObject({state:"capacity",spans:[],omissions:[{code:"TRANSCRIPT_RESPONSE_SIZE_LIMIT"}]});expect(input.state().cancelled).toBe(true);
  });
  test("bounds SQL metadata before SDK json parsing",async()=>{
    const input=streamed(JSON.stringify({rows:[["synthetic","fireflies","synthetic","x".repeat(2*LIMIT)]]}));
    const reader=createReader(services(async()=>input.response));
    await expect(reader.getMetadata("synthetic")).rejects.toMatchObject({code:"transcript_unavailable"});expect(input.state().cancelled).toBe(true);
  });
  for(const status of [401,403])for(const body of ["permission denied","Space not found","x".repeat(2*LIMIT)])test(`preserves SDK access denial ${status} with ${body.length} bytes`,async()=>{
    const fixture=snapshotFixture();let calls=0;
    const reader=exactReader(fixture,async()=>{calls++;return streamed(body,{status}).response;});
    await expect(reader.readEvidence(fixture.args)).rejects.toMatchObject({code:"access_denied"});expect(calls).toBe(1);
  });
  test("never calls an oversized 404 response a missing body",async()=>{
    const fixture=snapshotFixture();const reader=exactReader(fixture,async()=>streamed("x".repeat(2*LIMIT),{status:404}).response);
    expect(await reader.readEvidence(fixture.args)).toMatchObject({state:"unavailable",omissions:[{code:"TRANSCRIPT_RESPONSE_SIZE_LIMIT"}]});
  });
  test("counts SDK fetch attempts without hidden transient recovery",async()=>{
    const fixture=snapshotFixture();let calls=0;const reader=exactReader(fixture,async()=>{calls++;return new Response("temporary",{status:503});});
    expect((await reader.readEvidence(fixture.args)).state).toBe("unavailable");expect(calls).toBe(1);
  });
  test("propagates deadline to pinned SDK and acknowledges local body cancellation",async()=>{
    const fixture=snapshotFixture();let cancelled=false,sdkSignal:AbortSignal|undefined;
    const reader=createReader(services(async(_url,init)=>{sdkSignal=init?.signal;if(init?.body)return new Response(JSON.stringify({rows:[fixture.row]}));
      return new Response(new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}}));}));
    await expect(reader.readEvidence(fixture.args,{deadlineAt:Date.now()+20})).rejects.toMatchObject({code:"retrieval_timeout"});expect(sdkSignal?.aborted).toBe(true);expect(cancelled).toBe(true);
  });
  test("three concurrent complete 1 MiB exact reads remain isolated",async()=>{
    const fixtures=Array.from({length:3},(_,i)=>snapshotFixture(String(i).repeat(1_048_576),`fixture-${i}`));
    const results=await Promise.all(fixtures.map(fixture=>exactReader(fixture).readEvidence(fixture.args)));
    results.forEach((result,index)=>{expect(result.state).toBe("complete");expect(result.spans[0].text).toBe(String(index).repeat(1_048_576));expect(result.original?.digest).toBe(sha256(String(index).repeat(1_048_576)));});
  });
  test("concurrent cancellation and overflow cannot damage another exact read",async()=>{
    const fixture=snapshotFixture();const abort=new AbortController();let started!:()=>void;const pulling=new Promise<void>(resolve=>{started=resolve;});
    const slow=exactReader(fixture,async()=>new Response(new ReadableStream<Uint8Array>({pull(){started();return new Promise(()=>{});}})));
    const pending=slow.readEvidence(fixture.args,{signal:abort.signal}).then(value=>({value}),error=>({error}));
    await pulling;abort.abort();
    const results=await Promise.all([pending,exactReader(fixture,async()=>streamed("x".repeat(2*LIMIT)).response).readEvidence(fixture.args),exactReader(fixture).readEvidence(fixture.args)]);
    expect(results[0]).toMatchObject({error:{code:"retrieval_cancelled"}});expect(results[1]).toMatchObject({state:"capacity"});expect(results[2]).toMatchObject({state:"complete"});
  });
});
