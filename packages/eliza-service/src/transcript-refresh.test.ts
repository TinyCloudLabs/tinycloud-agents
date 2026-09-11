import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { serializeDelegation } from "@tinycloud/agent-client";
import type { PortableDelegation } from "@tinycloud/agent-client";
import { TranscriptAccessRegistry } from "./transcript-registry.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PATH = "xyz.tinycloud.tinychat/connectors";
const AGENT = "did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c";
const SPACE = "tinycloud:pkh:eip155:1:0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2:applications";
const HOST = "https://node.tinycloud.xyz";

beforeEach(() => setSystemTime(new Date("2030-01-01T00:00:00Z")));
afterEach(() => setSystemTime());

function advance(ms: number) { setSystemTime(new Date(Date.now() + ms)); }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(parentMs = 7 * 24 * HOUR) {
  const grant = (cid = "synthetic-parent") => serializeDelegation({
    cid, delegationHeader: { Authorization: `Bearer ${cid}` },
    delegateDID: AGENT, spaceId: SPACE, path: PATH,
    actions: ["tinycloud.sql/read"], expiry: new Date(Date.now() + parentMs),
    ownerAddress: SPACE.split(":")[4], chainId: 1, host: HOST,
    resources: [
      { service: "sql", space: SPACE, path: PATH, actions: ["tinycloud.sql/read"] },
      { service: "kv", space: SPACE, path: `${PATH}/`, actions: ["tinycloud.kv/get", "tinycloud.kv/list"] },
    ],
  } satisfies PortableDelegation);
  const activations: PortableDelegation[] = [];
  const reads: string[] = [];
  const signIns: number[] = [];
  const refreshing = deferred();
  const release = deferred();
  let holdRefresh = false;
  let failActivation = false;
  let nodes = 0;
  const registry = new TranscriptAccessRegistry({
    agentDid: AGENT, agentKey: "synthetic-agent-key", host: HOST,
    nodeFactory(args) {
      expect(args).toEqual({ privateKey: "synthetic-agent-key", host: HOST });
      const node = ++nodes;
      return {
        async signIn() { signIns.push(node); },
        async useDelegation(delegation) {
          expect(signIns).toContain(node);
          activations.push(delegation);
          if (activations.length === 2 && holdRefresh) {
            refreshing.resolve();
            await release.promise;
          }
          if (failActivation) { failActivation = false; throw new Error("synthetic private activation diagnostic"); }
          // node-sdk 2.6.0 useDelegation caps each activated child at one hour,
          // independently of the portable parent's longer expiry.
          const expiresAt = Math.min(Date.now() + HOUR, delegation.expiry.getTime());
          const result = (operation: string, data: unknown) => {
            reads.push(`${node}:${operation}`);
            return Date.now() >= expiresAt
              ? { ok: false, error: { code: "AUTH_UNAUTHORIZED", meta: { status: 401 } } }
              : { ok: true, data };
          };
          return {
            sql: { db(name: string) {
              expect(name).toBe(PATH);
              return { query: async () => result("sql", { rows: [["meeting", "fireflies", "source", delegation.cid, "2030-01-01T00:00:00Z", null, "[]", null, null]] }) };
            } },
            kv: { get: async (key: string, options?: { prefix?: string }) => {
              expect(key).toBe(`${PATH}/fireflies/transcript/source`);
              expect(options?.prefix).toBe("");
              return result("kv", { data: '"Synthetic transcript"' });
            } },
          };
        },
      };
    },
  });
  return { registry, grant, activations, reads, signIns, refreshing, release, hold: () => { holdRefresh = true; }, fail: () => { failActivation = true; } };
}

describe("transcript activated-session renewal", () => {
  test("reads SQL and KV after child expiry using the same live parent and a fresh node", async () => {
    const f = fixture();
    await f.registry.register("entity", f.grant(), "room");
    f.registry.selectMeeting("entity", "room", "meeting");
    const reader = f.registry.readerFor("entity", "room");
    expect((await reader.getMetadata!("meeting"))?.meetingRef).toBe("meeting");
    advance(61 * MINUTE);
    expect((await reader.getMetadata!("meeting"))?.meetingRef).toBe("meeting");
    expect(await reader.readBody!("fireflies", "source")).toMatchObject({ state: "present" });
    expect(f.activations).toHaveLength(2);
    expect(f.activations[1]).toEqual(f.activations[0]);
    expect(f.signIns).toEqual([1, 2]);
    expect(f.reads).toEqual(["1:sql", "2:sql", "2:kv"]);
    expect(f.registry.selectedMeetingFor("entity", "room")).toBe("meeting");
    advance(49 * MINUTE);
    await reader.getMetadata!("meeting");
    expect(f.activations).toHaveLength(2);
  });

  test("refreshes on demand at fifty minutes without waiting for a denial", async () => {
    const f = fixture();
    await f.registry.register("entity", f.grant());
    advance(49 * MINUTE);
    await f.registry.readerFor("entity").getMetadata!("meeting");
    expect(f.activations).toHaveLength(1);
    advance(MINUTE);
    await f.registry.readerFor("entity").getMetadata!("meeting");
    expect(f.activations).toHaveLength(2);
    expect(f.reads).toEqual(["1:sql", "2:sql"]);
  });

  test("concurrent SQL and KV calls share one refresh", async () => {
    const f = fixture();
    await f.registry.register("entity", f.grant());
    advance(61 * MINUTE); f.hold();
    const reader = f.registry.readerFor("entity");
    const results = Promise.allSettled([reader.getMetadata!("meeting"), reader.readBody!("fireflies", "source")]);
    await Promise.race([f.refreshing.promise, results]);
    try { expect(f.activations).toHaveLength(2); expect(f.reads).toEqual([]); }
    finally { f.release.resolve(); }
    expect(await results).toMatchObject([{ status: "fulfilled" }, { status: "fulfilled", value: { state: "present" } }]);
    expect(f.signIns).toEqual([1, 2]);
    expect(f.reads.sort()).toEqual(["2:kv", "2:sql"]);
  });

  for (const mutation of ["revoke", "replace", "stop"] as const) test(`${mutation} during refresh cannot revive the old grant or read its content`, async () => {
    const f = fixture();
    await f.registry.register("entity", f.grant());
    advance(61 * MINUTE); f.hold();
    const outcome = f.registry.readerFor("entity").getMetadata!("meeting").then(value => ({ value }), error => ({ error }));
    await Promise.race([f.refreshing.promise, outcome]);
    try {
      expect(f.activations).toHaveLength(2);
      if (mutation === "revoke") f.registry.revoke("entity");
      if (mutation === "stop") await f.registry.stop();
      if (mutation === "replace") await f.registry.register("entity", f.grant("replacement-parent"));
    } finally { f.release.resolve(); }
    expect(await outcome).toMatchObject({ error: { name: "NoDelegationError" } });
    expect(f.reads).toEqual([]);
    if (mutation === "replace") {
      expect((await f.registry.readerFor("entity").getMetadata!("meeting"))?.title).toBe("replacement-parent");
      expect(f.reads).toEqual(["3:sql"]);
    } else expect(f.registry.has("entity")).toBe(false);
  });

  test("an expired parent is dropped without reactivation", async () => {
    const f = fixture(HOUR);
    await f.registry.register("entity", f.grant());
    const reader = f.registry.readerFor("entity");
    advance(61 * MINUTE);
    await expect(reader.getMetadata!("meeting")).rejects.toMatchObject({ name: "DelegationExpiredError" });
    expect(f.activations).toHaveLength(1);
    expect(f.reads).toEqual([]);
    expect(f.registry.has("entity")).toBe(false);
  });

  test("parent expiry during refresh discards the refreshed handle", async () => {
    const f = fixture(HOUR);
    await f.registry.register("entity", f.grant());
    advance(50 * MINUTE); f.hold();
    const outcome = f.registry.readerFor("entity").getMetadata!("meeting").then(value => ({ value }), error => ({ error }));
    await Promise.race([f.refreshing.promise, outcome]);
    try { expect(f.activations).toHaveLength(2); advance(11 * MINUTE); }
    finally { f.release.resolve(); }
    expect(await outcome).toMatchObject({ error: { name: "DelegationExpiredError" } });
    expect(f.reads).toEqual([]);
    expect(f.registry.has("entity")).toBe(false);
  });

  for (const cancellation of ["abort", "deadline"] as const) test(`${cancellation} stops one refresh waiter without blocking another caller`, async () => {
    const f = fixture();
    await f.registry.register("entity", f.grant());
    advance(61 * MINUTE); f.hold();
    const abort = new AbortController();
    const reader = f.registry.readerFor("entity");
    const context = cancellation === "abort" ? { signal: abort.signal } : { deadlineAt: Date.now() + 20 };
    const cancelled = reader.getMetadata!("meeting", context).then(value => ({ value }), error => ({ error }));
    const other = reader.readBody!("fireflies", "source").then(value => ({ value }), error => ({ error }));
    await Promise.race([f.refreshing.promise, cancelled]);
    try {
      expect(f.activations).toHaveLength(2);
      if (cancellation === "abort") abort.abort();
      expect(await cancelled).toMatchObject({ error: { code: cancellation === "abort" ? "retrieval_cancelled" : "retrieval_timeout" } });
    } finally { f.release.resolve(); }
    expect(await other).toMatchObject({ value: { state: "present" } });
    expect(f.reads).toEqual(["2:kv"]);
  });

  test("a failed refresh is content-free and can be retried by the next read", async () => {
    const f = fixture();
    await f.registry.register("entity", f.grant());
    advance(50 * MINUTE); f.fail();
    const reader = f.registry.readerFor("entity");
    await expect(reader.getMetadata!("meeting")).rejects.toMatchObject({ code: "transcript_unavailable", message: "transcript_unavailable" });
    expect(f.reads).toEqual([]);
    expect((await reader.getMetadata!("meeting"))?.meetingRef).toBe("meeting");
    expect(f.signIns).toEqual([1, 2, 3]);
    expect(f.activations[2]).toEqual(f.activations[0]);
    expect(f.reads).toEqual(["3:sql"]);
  });
});
