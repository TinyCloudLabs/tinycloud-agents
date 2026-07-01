// User (owner) auth for the /api/agents surface (plan §2).
//
// OpenKey has no server-side SDK: it is a passkey-managed wallet that signs on the
// client. The server proves the caller owns an address by verifying a SIWE
// signature, then issues a short-lived bearer session. This module is intentionally
// thin (the agent-service will change soon) and owns the whole scheme:
//
//   1. GET  /api/auth/nonce  -> issueNonce(): single-use nonce, short TTL.
//   2. POST /api/auth/verify -> verifySiwe({ message, signature }): SIWE.verify()
//      binds domain + the issued nonce (consumed single-use), recovers the address,
//      mints an opaque session token.
//   3. /api/agents* -> authenticate(request): Bearer token -> owner address.
//
// SECURITY (engineering principle: nonce-based replay protection, never timestamps
// alone): replay protection is the SIWE nonce, generated server-side and consumed
// on first successful verify. Tokens and nonces are cryptographically random.

import { randomBytes } from "node:crypto";
import { SiweMessage, generateNonce } from "siwe";

const NONCE_TTL_MS = 5 * 60_000; // 5 minutes to sign after fetching a nonce
const SESSION_TTL_MS = 24 * 60 * 60_000; // 24h bearer session

export interface UserAuthConfig {
  /** Expected SIWE domain — bound at verify time. Defaults to agents.tinycloud.xyz. */
  domain?: string;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export interface AuthenticatedUser {
  /** Lowercased owner address recovered from the SIWE signature. */
  address: string;
}

/** Result of a verify attempt. */
export type VerifyResult =
  | { ok: true; token: string; address: string; expiresAt: number }
  | { ok: false; error: string };

interface SessionRecord {
  address: string;
  expiresAt: number;
}

export class UserAuth {
  private readonly _domain: string;
  private readonly _now: () => number;
  /** nonce -> expiry (single-use; deleted on consume). */
  private readonly _nonces = new Map<string, number>();
  /** token -> session. */
  private readonly _sessions = new Map<string, SessionRecord>();

  constructor(config: UserAuthConfig = {}) {
    this._domain = config.domain ?? "agents.tinycloud.xyz";
    this._now = config.now ?? (() => Date.now());
  }

  get domain(): string {
    return this._domain;
  }

  /** Issue a single-use nonce for the client to embed in its SIWE message. */
  issueNonce(): string {
    this._sweepNonces();
    const nonce = generateNonce();
    this._nonces.set(nonce, this._now() + NONCE_TTL_MS);
    return nonce;
  }

  /**
   * Verify a SIWE message + signature. On success, consume the nonce and mint a
   * bearer session token bound to the recovered address.
   *
   * Errors are returned (never thrown) so the route can map them to 401 without
   * leaking specifics. The nonce is consumed only on a fully successful verify, so
   * a failed attempt does not burn a valid client's nonce.
   */
  async verifySiwe(input: { message: string; signature: string }): Promise<VerifyResult> {
    let siwe: SiweMessage;
    try {
      siwe = new SiweMessage(input.message);
    } catch {
      return { ok: false, error: "invalid_message" };
    }

    const nonce = siwe.nonce;
    const nonceExpiry = this._nonces.get(nonce);
    if (nonceExpiry === undefined || nonceExpiry < this._now()) {
      return { ok: false, error: "invalid_nonce" };
    }

    let recovered: string;
    try {
      const result = await siwe.verify({
        signature: input.signature,
        domain: this._domain,
        nonce,
      });
      if (!result.success) return { ok: false, error: "invalid_signature" };
      recovered = result.data.address;
    } catch {
      return { ok: false, error: "invalid_signature" };
    }

    // Consume the nonce (single-use) only after a successful verify.
    this._nonces.delete(nonce);

    const address = recovered.toLowerCase();
    const token = randomBytes(32).toString("hex");
    const expiresAt = this._now() + SESSION_TTL_MS;
    this._sessions.set(token, { address, expiresAt });
    return { ok: true, token, address, expiresAt };
  }

  /**
   * Authenticate a request by its `Authorization: Bearer <token>` header.
   * Returns the owner on success, or null on a missing/invalid/expired token.
   */
  authenticate(request: Request): AuthenticatedUser | null {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return null;

    const token = match[1];
    const session = this._sessions.get(token);
    if (!session) return null;
    if (session.expiresAt < this._now()) {
      this._sessions.delete(token);
      return null;
    }
    return { address: session.address };
  }

  /** Drop expired nonces so the map does not grow unbounded. */
  private _sweepNonces(): void {
    const now = this._now();
    for (const [nonce, expiry] of this._nonces) {
      if (expiry < now) this._nonces.delete(nonce);
    }
  }
}
