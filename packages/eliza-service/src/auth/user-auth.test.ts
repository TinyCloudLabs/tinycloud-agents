// UserAuth tests (M2): SIWE nonce + verify + bearer session.
//
// Signatures are produced with a viem test account (hardhat key) so the whole
// nonce -> sign -> verify -> authenticate loop runs without a live wallet.

import { describe, expect, it } from "bun:test";
import { SiweMessage } from "siwe";
import { privateKeyToAccount } from "viem/accounts";
import { UserAuth } from "./user-auth.js";

const DOMAIN = "agents.tinycloud.xyz";
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(PK);

async function signedMessage(
  nonce: string,
  opts: { domain?: string; address?: string; expirationTime?: string } = {},
) {
  const siwe = new SiweMessage({
    domain: opts.domain ?? DOMAIN,
    address: opts.address ?? account.address,
    uri: `https://${DOMAIN}`,
    version: "1",
    chainId: 1,
    nonce,
    ...(opts.expirationTime ? { expirationTime: opts.expirationTime } : {}),
  });
  const message = siwe.prepareMessage();
  const signature = await account.signMessage({ message });
  return { message, signature };
}

describe("UserAuth — happy path", () => {
  it("nonce -> sign -> verify mints a token bound to the recovered address", async () => {
    const auth = new UserAuth({ domain: DOMAIN });
    const nonce = auth.issueNonce();
    const { message, signature } = await signedMessage(nonce);

    const result = await auth.verifySiwe({ message, signature });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.address).toBe(account.address.toLowerCase());
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("authenticate resolves a Bearer token to the owner", async () => {
    const auth = new UserAuth({ domain: DOMAIN });
    const nonce = auth.issueNonce();
    const { message, signature } = await signedMessage(nonce);
    const result = await auth.verifySiwe({ message, signature });
    if (!result.ok) throw new Error("verify failed");

    const req = new Request("https://x/api/agents", {
      headers: { authorization: `Bearer ${result.token}` },
    });
    expect(auth.authenticate(req)?.address).toBe(account.address.toLowerCase());
  });
});

describe("UserAuth — nonce replay protection", () => {
  it("rejects a message whose nonce was never issued", async () => {
    const auth = new UserAuth({ domain: DOMAIN });
    const { message, signature } = await signedMessage("neverissuednonce0");
    const result = await auth.verifySiwe({ message, signature });
    expect(result).toEqual({ ok: false, error: "invalid_nonce" });
  });

  it("consumes the nonce single-use — a replay of the same message fails", async () => {
    const auth = new UserAuth({ domain: DOMAIN });
    const nonce = auth.issueNonce();
    const { message, signature } = await signedMessage(nonce);

    const first = await auth.verifySiwe({ message, signature });
    expect(first.ok).toBe(true);
    const replay = await auth.verifySiwe({ message, signature });
    expect(replay).toEqual({ ok: false, error: "invalid_nonce" });
  });

  it("rejects an expired nonce", async () => {
    let t = 1_000_000;
    const auth = new UserAuth({ domain: DOMAIN, now: () => t });
    const nonce = auth.issueNonce();
    const { message, signature } = await signedMessage(nonce);
    t += 6 * 60_000; // past the 5-minute nonce TTL
    const result = await auth.verifySiwe({ message, signature });
    expect(result).toEqual({ ok: false, error: "invalid_nonce" });
  });

  it("does NOT consume the nonce on a failed verify (bad signature)", async () => {
    const auth = new UserAuth({ domain: DOMAIN });
    const nonce = auth.issueNonce();
    const { message } = await signedMessage(nonce);

    // Tamper: a different account signs the same message.
    const other = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const badSig = await other.signMessage({ message });
    const bad = await auth.verifySiwe({ message, signature: badSig });
    expect(bad.ok).toBe(false);

    // The genuine owner can still use the same nonce afterward.
    const goodSig = await account.signMessage({ message });
    const good = await auth.verifySiwe({ message, signature: goodSig });
    expect(good.ok).toBe(true);
  });
});

describe("UserAuth — domain binding", () => {
  it("rejects a signature over a different domain", async () => {
    const auth = new UserAuth({ domain: DOMAIN });
    const nonce = auth.issueNonce();
    const { message, signature } = await signedMessage(nonce, { domain: "evil.example.com" });
    const result = await auth.verifySiwe({ message, signature });
    expect(result.ok).toBe(false);
  });
});

describe("UserAuth — expirationTime enforcement", () => {
  it("rejects a message whose expirationTime has already passed", async () => {
    const auth = new UserAuth({ domain: DOMAIN });
    const nonce = auth.issueNonce();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const { message, signature } = await signedMessage(nonce, { expirationTime: expired });
    const result = await auth.verifySiwe({ message, signature });
    expect(result).toEqual({ ok: false, error: "invalid_signature" });
  });

  it("accepts a message with a future expirationTime", async () => {
    const auth = new UserAuth({ domain: DOMAIN });
    const nonce = auth.issueNonce();
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const { message, signature } = await signedMessage(nonce, { expirationTime: future });
    const result = await auth.verifySiwe({ message, signature });
    expect(result.ok).toBe(true);
  });
});

describe("UserAuth — authenticate edge cases", () => {
  it("returns null for a missing/malformed Authorization header", () => {
    const auth = new UserAuth({ domain: DOMAIN });
    expect(auth.authenticate(new Request("https://x"))).toBeNull();
    expect(
      auth.authenticate(new Request("https://x", { headers: { authorization: "Basic abc" } })),
    ).toBeNull();
  });

  it("returns null for an unknown token", () => {
    const auth = new UserAuth({ domain: DOMAIN });
    const req = new Request("https://x", { headers: { authorization: "Bearer deadbeef" } });
    expect(auth.authenticate(req)).toBeNull();
  });

  it("returns null for an expired session", async () => {
    let t = 1_000_000;
    const auth = new UserAuth({ domain: DOMAIN, now: () => t });
    const nonce = auth.issueNonce();
    const { message, signature } = await signedMessage(nonce);
    const result = await auth.verifySiwe({ message, signature });
    if (!result.ok) throw new Error("verify failed");

    t += 25 * 60 * 60_000; // past the 24h session TTL
    const req = new Request("https://x", { headers: { authorization: `Bearer ${result.token}` } });
    expect(auth.authenticate(req)).toBeNull();
  });
});
