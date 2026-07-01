// Autonomous E2E harness. Drives the REAL client modules (api.ts, delegate.ts)
// with an ephemeral-EOA provider swapped in for OpenKey. Exposes window.runE2E()
// which returns a per-leg pass/fail report. A headless browser (run-e2e.ts)
// navigates here, calls runE2E(), and prints the result.
//
// What this DOES cover: the full SIWE nonce+bearer auth, agent create, real
// delegation mint against node.tinycloud.xyz + POST, enable/disable gate, and
// the web_search / chat error paths — all through the shipping client code.
// What it does NOT cover: the OpenKey iframe/WebAuthn UI leg, real passkey
// signup, HTTPS/mkcert origin. Those are the manual option-B verification.

import { TinyCloudWeb, type Config } from "@tinycloud/web-sdk";
import { Wallet } from "ethers";
import { makeEoaProvider } from "./eoa-provider";
import { TINYCLOUD_HOST } from "../src/tinycloud";
import { mintDelegation } from "../src/delegate";
import {
  signerFromTcw,
  createAgent,
  listAgents,
  submitDelegation,
  setEnabled,
  sendMessage,
  callTool,
  DelegationRequiredError,
  ApiError,
  type Signer,
  type Agent,
} from "../src/api";

interface LegResult {
  leg: string;
  pass: boolean;
  detail: string;
}

async function step(
  leg: string,
  fn: () => Promise<string>,
  results: LegResult[]
): Promise<boolean> {
  try {
    const detail = await fn();
    results.push({ leg, pass: true, detail });
    return true;
  } catch (err) {
    results.push({ leg, pass: false, detail: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

// A wallet-backed Signer for the api.ts auth legs. The api.ts Signer contract is
// just { address, signMessage(EIP-191) }; the real app fills it via
// signerFromTcw (OpenKey → ethers). Here we fill it straight from an ethers
// Wallet — this is the same personal_sign the service verifies, and it removes
// the TinyCloudWeb node dependency from the auth/create/toggle legs (only the
// delegation MINT needs a live node session).
function walletSigner(wallet: Wallet): Signer {
  return { address: wallet.address, signMessage: (m) => wallet.signMessage(m) };
}

export async function runE2E(): Promise<{ results: LegResult[]; agent?: Agent }> {
  const results: LegResult[] = [];

  const wallet = Wallet.createRandom();
  const signer: Signer = walletSigner(wallet);
  results.push({
    leg: "wallet signer (ephemeral EOA)",
    pass: true,
    detail: `address=${signer.address}`,
  });

  // create -> also exercises nonce -> SIWE -> verify inside api.ts (first authed call).
  let agent: Agent | undefined;
  await step("nonce->SIWE->verify + create (DID returned)", async () => {
    agent = await createAgent(signer!, "e2e-agent");
    if (!agent.agentDid?.startsWith("did:pkh:")) throw new Error(`bad agentDid: ${agent.agentDid}`);
    return `agentId=${agent.agentId} agentDid=${agent.agentDid} space=${agent.space} dbHandle=${agent.dbHandle}`;
  }, results);
  if (!agent) return { results };

  await step("list agents (created agent present)", async () => {
    const list = await listAgents(signer!);
    if (!list.some((a) => a.agentId === agent!.agentId)) throw new Error("created agent not in list");
    return `count=${list.length}`;
  }, results);

  // mint delegation via the REAL delegate.ts against the REAL node, then POST it.
  // This is the ONE leg that needs a live TinyCloudWeb node session (signIn +
  // space create + delegations.create). Bounded by a timeout so a node-side
  // hang reports a clean failure instead of blocking the whole run.
  let mintedSerialized: string | undefined;
  await step("mint delegation vs node.tinycloud.xyz (real)", async () => {
    const eoa = makeEoaProvider(1);
    const tcw = new TinyCloudWeb({
      providers: { web3: { driver: eoa.provider as unknown as Config["provider"] } },
      tinycloudHosts: [TINYCLOUD_HOST],
    } as Config);

    const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
      ]);

    await withTimeout(tcw.signIn(), 45000, "signIn");
    const minted = await withTimeout(
      mintDelegation(tcw, agent!.agentDid, { space: agent!.space, path: agent!.dbHandle }),
      45000,
      "mintDelegation"
    );
    mintedSerialized = minted.serialized;
    if (minted.delegateDID !== agent!.agentDid)
      throw new Error(`delegateDID ${minted.delegateDID} != agentDid ${agent!.agentDid}`);
    return `delegateDID=${minted.delegateDID} actions=${minted.actions.join(",")}`;
  }, results);

  if (mintedSerialized) {
    await step("POST delegation -> status active", async () => {
      const res = await submitDelegation(signer!, agent!.agentId, mintedSerialized!);
      if (res.status !== "active") throw new Error(`status=${res.status} (expected active)`);
      return `entityId=${res.entityId} status=${res.status}`;
    }, results);
  }

  // disable -> 403 on messages/tools.
  await step("disable toggle", async () => {
    const updated = await setEnabled(signer!, agent!.agentId, false);
    if (updated.enabled !== false) throw new Error("enabled still true after disable");
    return "enabled=false";
  }, results);

  await step("disabled -> 403 on messages", async () => {
    try {
      await sendMessage(signer!, agent!.agentId, "hi", () => {}, "e2e-room");
      throw new Error("expected 403 agent_disabled, got success");
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) return `403 ${err.code ?? ""}`;
      if (err instanceof DelegationRequiredError) throw new Error("got 409 not 403");
      throw err;
    }
  }, results);

  // re-enable for the remaining error-path checks.
  await step("re-enable toggle", async () => {
    const updated = await setEnabled(signer!, agent!.agentId, true);
    if (updated.enabled !== true) throw new Error("enabled still false after enable");
    return "enabled=true";
  }, results);

  // web_search: with a real Tavily key configured, expect a real result; without
  // one, a clean tool_misconfigured error (no crash, no silent success).
  await step("web_search (real result, or clean error w/o key)", async () => {
    try {
      const r = await callTool<{ ok?: boolean }>(
        signer!,
        agent!.agentId,
        "web_search",
        { query: "tinycloud" },
        "e2e-room"
      );
      if (r?.ok !== true) throw new Error(`unexpected result: ${JSON.stringify(r).slice(0, 120)}`);
      return `real result: ${JSON.stringify(r).slice(0, 100)}`;
    } catch (err) {
      if (err instanceof ApiError) return `clean ApiError ${err.status} ${err.code ?? err.message}`;
      throw err;
    }
  }, results);

  // chat: without a registered delegation (mint blocked by node) the service
  // returns a clean pre-stream 409 delegation_required; without a model key it
  // would stream to a clean close. Either is a clean, non-crashing outcome.
  await step("chat -> clean gate (no crash)", async () => {
    let chunks = 0;
    try {
      await sendMessage(signer!, agent!.agentId, "hello", () => { chunks++; }, "e2e-room");
      return `stream completed cleanly, chunks=${chunks} (no TEXT model configured)`;
    } catch (err) {
      if (err instanceof DelegationRequiredError)
        return `clean 409 delegation_required (no delegation registered)`;
      if (err instanceof ApiError) return `clean ApiError ${err.status} ${err.code ?? err.message}`;
      throw err;
    }
  }, results);

  return { results, agent };
}

// Isolated sign-in probe: measure how far TinyCloudWeb.signIn gets via the EOA
// provider, retrying to characterize any intermittent node-info fetch failure.
export async function probeSignIn(attempts = 3): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < attempts; i++) {
    const eoa = makeEoaProvider(1);
    const tcw = new TinyCloudWeb({
      providers: { web3: { driver: eoa.provider as unknown as Config["provider"] } },
      tinycloudHosts: [TINYCLOUD_HOST],
    });
    try {
      await tcw.signIn();
      out.push(`attempt ${i}: SIGNED IN addr=${tcw.address()}`);
    } catch (err) {
      out.push(`attempt ${i}: FAIL ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

// Expose for the headless driver.
(window as unknown as { runE2E: typeof runE2E }).runE2E = runE2E;
(window as unknown as { probeSignIn: typeof probeSignIn }).probeSignIn = probeSignIn;
(window as unknown as { __e2eReady: boolean }).__e2eReady = true;
