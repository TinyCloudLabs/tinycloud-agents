// scripts/live-session-probe.ts — MANUAL live probe for 30-day agent sessions and
// repeat signIn() on node-sdk 2.11.0. Same discipline as live-smoke.ts: NOT part of
// `bun test`/CI; a human runs it by hand:
//
//     TINYCLOUD_LIVE=1 bun --bun run scripts/live-session-probe.ts
//
// Without TINYCLOUD_LIVE=1 it prints {"skipped":true,...} and exits 0.
//
// KEYS: ALWAYS fresh throwaway keys (randomBytes(32)) for both the "agent" and the
// "user"; nothing is read from the environment, nothing secret is printed. The
// spaces they mint are abandoned (the node has no delete API; none is needed).
//
// What it proves (each step sequential and deadline-bounded):
//   A. TinyCloudNode with sessionExpirationMs = AGENT_SESSION_EXPIRATION_MS (30d):
//      signIn → kv put/get → signIn AGAIN on the SAME node → kv put/get → signIn a
//      third time → kv get. node-sdk <=2.6.x threw "Key default does not exist." on
//      the second signIn. Reports the signed session expiry (~30d).
//   B. NodeSdkTransport (private-key mode, re-signs-in on the same node): signIn →
//      SQL → signIn → SQL.
//   C. Delegated path with a 30-day user→agent delegation: user node delegates the
//      Eliza memory SQL policy to the agent DID for 30 days; DelegatedTransport (the
//      production validators + useDelegation) activates, runs SQL, invalidates and
//      re-activates (a proactive refresh), and runs SQL again.
//   D. eliza-service transcript transport (createTranscriptNode): a 30-day KV grant
//      is activated and read through the hand-built delegated KV service.
//
// HOST: TINYCLOUD_HOST (default https://tee.node.tinycloud.xyz — eliza-service prod).
// PROBE_STEPS: subset of "ABCD" to run (default all).

import { randomBytes } from "node:crypto";

import {
  AGENT_SESSION_EXPIRATION_MS,
  DEFAULT_DB_HANDLE,
  DelegatedTransport,
  NodeSdkTransport,
  TinyCloudNode,
  agentIdentityFromKey,
  resolveConfig,
  resolveDelegationConfig,
  serializeDelegation,
} from "@tinycloud/agent-client";
import { createTranscriptNode } from "../packages/eliza-service/src/transcript-transport.js";

const DEFAULT_HOST = "https://tee.node.tinycloud.xyz";
// signIn on a FRESH account can take ~60s on node-sdk 2.11 (account-bootstrap repair
// on the second signIn); later signIns are ~4-8s.
const STEP_BUDGET_MS = 150_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function withDeadline<T>(p: Promise<T>, label: string, ms = STEP_BUDGET_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms budget`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

const host = process.env.TINYCLOUD_HOST || DEFAULT_HOST;
if (process.env.TINYCLOUD_LIVE !== "1") {
  console.log(JSON.stringify({ skipped: true, reason: "set TINYCLOUD_LIVE=1 to run the live session probe", host }));
  process.exit(0);
}

const throwawayKey = () => `0x${randomBytes(32).toString("hex")}`;
const results: Array<Record<string, unknown>> = [];
function record(step: string, extra: Record<string, unknown> = {}): void {
  const entry = { step, ok: true, ...extra };
  results.push(entry);
  console.log(JSON.stringify(entry));
}

function sessionExpiryDays(node: TinyCloudNode): number | null {
  const siwe = (node as unknown as { session?: { siwe?: string } }).session?.siwe;
  const match = siwe ? /Expiration Time: (\S+)/.exec(siwe) : null;
  return match ? Math.round(((Date.parse(match[1]) - Date.now()) / DAY_MS) * 100) / 100 : null;
}

function unwrap<T>(label: string, result: { ok: boolean; data?: T; error?: { code?: string; message?: string } }): T {
  if (!result.ok) throw new Error(`${label} failed: ${result.error?.code ?? ""} ${result.error?.message ?? ""}`);
  return result.data as T;
}

async function kvRoundTrip(node: TinyCloudNode, label: string): Promise<void> {
  const key = `probe/${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${randomBytes(4).toString("hex")}`;
  const value = `v-${randomBytes(6).toString("hex")}`;
  unwrap(`${label} kv.put`, await withDeadline(node.kv.put(key, value), `${label} kv.put`));
  const got = unwrap<{ data?: unknown }>(`${label} kv.get`, await withDeadline(node.kv.get(key), `${label} kv.get`));
  const readBack = typeof got === "object" && got !== null && "data" in got ? got.data : got;
  if (readBack !== value) throw new Error(`${label} kv.get mismatch`);
  record(`${label}: kv put/get`, { key });
}

async function stepA(): Promise<void> {
  const node = new TinyCloudNode({
    privateKey: throwawayKey(),
    host,
    autoCreateSpace: true,
    sessionExpirationMs: AGENT_SESSION_EXPIRATION_MS,
  });
  let t = performance.now();
  await withDeadline(node.signIn(), "A signIn#1");
  record("A: signIn #1", { ms: Math.round(performance.now() - t), sessionExpiresInDays: sessionExpiryDays(node) });
  await kvRoundTrip(node, "A after signIn #1");

  t = performance.now();
  await withDeadline(node.signIn(), "A signIn#2");
  record("A: signIn #2 (same node)", { ms: Math.round(performance.now() - t), sessionExpiresInDays: sessionExpiryDays(node) });
  await kvRoundTrip(node, "A after signIn #2");

  t = performance.now();
  await withDeadline(node.signIn(), "A signIn#3");
  record("A: signIn #3 (same node)", { ms: Math.round(performance.now() - t) });
  await kvRoundTrip(node, "A after signIn #3");
}

async function stepB(): Promise<void> {
  const transport = new NodeSdkTransport(resolveConfig({ privateKey: throwawayKey(), host, dbHandle: DEFAULT_DB_HANDLE }));
  await withDeadline(transport.signIn(), "B signIn#1");
  unwrap("B create", await withDeadline(transport.execute("CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY, v TEXT)"), "B create"));
  unwrap("B insert1", await withDeadline(transport.execute("INSERT INTO probe (id, v) VALUES (?, ?)", ["one", "1"]), "B insert1"));
  record("B: NodeSdkTransport signIn #1 + SQL");
  await withDeadline(transport.signIn(), "B signIn#2");
  unwrap("B insert2", await withDeadline(transport.execute("INSERT INTO probe (id, v) VALUES (?, ?)", ["two", "2"]), "B insert2"));
  const rows = unwrap<{ rowCount: number }>("B select", await withDeadline(transport.query("SELECT id FROM probe"), "B select"));
  record("B: NodeSdkTransport signIn #2 (same node) + SQL", { rowCount: rows.rowCount });
}

async function stepC(): Promise<void> {
  const agentKey = throwawayKey();
  const agent = await agentIdentityFromKey(agentKey);
  const user = new TinyCloudNode({
    privateKey: throwawayKey(),
    host,
    autoCreateSpace: true,
    sessionExpirationMs: AGENT_SESSION_EXPIRATION_MS,
  });
  await withDeadline(user.signIn(), "C user signIn");
  // Wallet-signed SQL-only grant, the same shape tinychat/delegate-ui mint.
  const delegation = await withDeadline(user.createDelegation({
    path: DEFAULT_DB_HANDLE,
    actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
    delegateDID: agent.did,
    expiryMs: 30 * DAY_MS,
    includePublicSpace: false,
  }), "C createDelegation");
  const delegationDays = Math.round(((new Date(delegation.expiry).getTime() - Date.now()) / DAY_MS) * 100) / 100;
  record("C: user delegated memory SQL to agent", { delegationExpiresInDays: delegationDays });

  const transport = new DelegatedTransport(resolveDelegationConfig({
    mode: "delegation", serializedDelegation: serializeDelegation(delegation), agentKey, host, dbHandle: DEFAULT_DB_HANDLE,
  }));
  let t = performance.now();
  await withDeadline(transport.signIn(), "C activate#1");
  const activate1Ms = Math.round(performance.now() - t);
  unwrap("C create", await withDeadline(transport.execute("CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY, v TEXT)"), "C create"));
  unwrap("C insert1", await withDeadline(transport.execute("INSERT INTO probe (id, v) VALUES (?, ?)", ["one", "1"]), "C insert1"));
  record("C: DelegatedTransport activation #1 + SQL", { activateMs: activate1Ms });
  transport.invalidate();
  t = performance.now();
  await withDeadline(transport.signIn(), "C activate#2");
  const activate2Ms = Math.round(performance.now() - t);
  unwrap("C insert2", await withDeadline(transport.execute("INSERT INTO probe (id, v) VALUES (?, ?)", ["two", "2"]), "C insert2"));
  const rows = unwrap<{ rowCount: number }>("C select", await withDeadline(transport.query("SELECT id FROM probe"), "C select"));
  record("C: DelegatedTransport re-activation #2 + SQL", { activateMs: activate2Ms, rowCount: rows.rowCount });
}

async function stepD(): Promise<void> {
  // eliza-service transcript transport: hand-built SDK services over the
  // DelegatedAccess internals — verify they still work on node-sdk 2.11.
  const agentKey = throwawayKey();
  const agent = await agentIdentityFromKey(agentKey);
  const user = new TinyCloudNode({ privateKey: throwawayKey(), host, autoCreateSpace: true });
  await withDeadline(user.signIn(), "D user signIn");
  const key = `xyz.tinycloud.tinychat/connectors/probe/transcript/${randomBytes(4).toString("hex")}`;
  const body = `transcript-${randomBytes(6).toString("hex")}`;
  unwrap("D user kv.put", await withDeadline(user.kv.put(key, body, { prefix: "" } as never), "D user kv.put"));
  const delegation = await withDeadline(user.createDelegation({
    path: "xyz.tinycloud.tinychat/connectors/",
    actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
    delegateDID: agent.did,
    expiryMs: 30 * DAY_MS,
    includePublicSpace: false,
  }), "D createDelegation");
  const node = createTranscriptNode({ privateKey: agent.normalizedKey, host });
  const t = performance.now();
  await withDeadline(node.signIn(), "D agent signIn");
  const services = await withDeadline(node.useDelegation(delegation), "D useDelegation");
  const activateMs = Math.round(performance.now() - t);
  const got = await withDeadline(services.kv.get(key, { prefix: "", raw: true }), "D kv.get") as { ok: boolean; data?: { data?: unknown } };
  if (!got.ok) throw new Error(`D kv.get failed: ${JSON.stringify((got as { error?: unknown }).error).slice(0, 200)}`);
  if (got.data?.data !== body) throw new Error("D kv.get mismatch");
  record("D: transcript transport activation + delegated kv.get", { activateMs });
}

async function main(): Promise<void> {
  console.log(JSON.stringify({ probe: "live-session-probe", host, sessionExpirationMs: AGENT_SESSION_EXPIRATION_MS }));
  let failed = false;
  const only = (process.env.PROBE_STEPS ?? "ABCD").toUpperCase();
  for (const [name, step] of [["A", stepA], ["B", stepB], ["C", stepC], ["D", stepD]] as const) {
    if (!only.includes(name)) continue;
    try {
      await step();
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      console.log(JSON.stringify({ step: name, ok: false, error: message.slice(0, 300) }));
    }
  }
  console.log(JSON.stringify({ done: true, ok: !failed, steps: results.length }));
  process.exit(failed ? 1 : 0);
}

void main();
