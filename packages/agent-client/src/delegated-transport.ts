// DelegatedTransport — Transport implementation for delegation mode.
//
// Activates via TinyCloudNode.useDelegation (Phase 3 / Task 4 wires the real
// wallet-mode flow). SQL is routed through DelegatedAccess.sql.db(dbHandle)
// using the same adapter as NodeSdkTransport (sql-handle-adapter.ts).
//
// HARD CONTRACT:
//   - Never logs or includes delegation.delegationHeader.Authorization,
//     agentKey, or serializedDelegation in any error message.
//   - SQL methods return a typed NOT_ACTIVATED error if called before signIn().
//   - useDelegation() must live ONLY in this file (regression guard §2.3).
//
// HARD CONTRACT: zero host-framework (Eliza) imports — see ./index.ts.

import { readFileSync } from "node:fs";
import type { IDatabaseHandle, PortableDelegation, TinyCloudNodeConfig } from "@tinycloud/node-sdk";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { agentIdentityFromFile, agentIdentityFromKey, type AgentIdentity } from "./agent-identity";
import type { ResolvedDelegationConfig } from "./config";
import { AuthError, DelegationPolicyError } from "./errors";
import {
  defaultElizaMemoryPolicy,
  deserializeDelegationSafe,
  validateDelegationPolicy,
} from "./delegation-policy";
import { normalizeDelegationGrants, signedOwnerAddress } from "./delegation-normalize";
import { validateDelegationShape } from "./delegation-validate";
import { adapterBatch, adapterExecute, adapterQuery } from "./sql-handle-adapter";
import type {
  BatchData,
  ExecuteData,
  QueryData,
  SignInResult,
  SqlStatement,
  SqlValue,
  Transport,
  TransportError,
  TransportResult,
} from "./transport";

/**
 * Minimal duck-type of DelegatedAccess that DelegatedTransport needs.
 * Using a structural interface (not the SDK class directly) allows tests to
 * inject a plain object fake without constructing a real DelegatedAccess.
 */
export interface DelegatedSqlAccess {
  readonly sql: { db(name?: string): IDatabaseHandle };
  readonly spaceId: string;
}

/**
 * Activation function type. Takes the resolved config, the deserialized
 * PortableDelegation, and the agent identity already resolved by signIn() (whose
 * `.normalizedKey` the default activator reuses — no second disk read).
 *
 * Tests inject a fake that returns immediately (and may ignore the extra params).
 */
export type DelegatedActivateFn = (
  config: ResolvedDelegationConfig,
  delegation: PortableDelegation,
  identity: AgentIdentity,
) => Promise<DelegatedSqlAccess>;

/**
 * Injectable deps seam for DelegatedTransport.
 * All fields are optional; defaults are the real SDK implementations.
 */
export interface DelegatedTransportDeps {
  /** Override delegation deserializer (default: SDK `deserializeDelegation`). */
  deserialize?: (data: string) => PortableDelegation;
  /**
   * Override the wallet-mode activator.
   * Default throws "not activated" (Task 4 replaces the default with the real
   * TinyCloudNode + useDelegation flow). Tests inject a fake returning a
   * pre-built DelegatedSqlAccess.
   */
  activate?: DelegatedActivateFn;
  /** Override agent identity resolver (default: `agentIdentityFromKey`). */
  agentIdentity?: (rawKey: string) => Promise<AgentIdentity>;
}

const NOT_ACTIVATED_ERROR: TransportError = {
  code: "NOT_ACTIVATED",
  message: "DelegatedTransport: call signIn() before using SQL methods",
  service: "delegation",
};

/** Typed not-activated result — returned from SQL methods before signIn(). */
const NOT_ACTIVATED_RESULT: { ok: false; error: TransportError } = {
  ok: false,
  error: NOT_ACTIVATED_ERROR,
};

/**
 * Node config for the delegated-activation wallet session. The agent activating
 * a USER's delegation is not an account owner and must NOT run node-sdk 2.4.0's
 * first-account bootstrap (which tries a multi-permission SQL schema write the
 * delegated runtime cannot execute — "SQL operation requires multiple permissions").
 * `autoBootstrapAccount: false` is the SDK-supported skip (TinyCloudNodeConfig).
 */
export function delegatedNodeConfig(config: ResolvedDelegationConfig, normalizedKey: string): TinyCloudNodeConfig {
  return { privateKey: normalizedKey, host: config.host, autoBootstrapAccount: false };
}

/**
 * Default activator: wallet-mode TinyCloudNode construction + useDelegation.
 *
 * Builds a fresh TinyCloudNode from the stored agent key (inline or file) and
 * the configured host, then calls useDelegation(delegation) to produce a
 * DelegatedAccess handle. Each call builds a fresh node — do NOT reuse the
 * old node instance across activations (plan §SDK findings risk #3).
 *
 * SECURITY: agent key is never placed in error messages.
 */
export const defaultActivate: DelegatedActivateFn = async (
  config: ResolvedDelegationConfig,
  delegation: PortableDelegation,
  identity: AgentIdentity,
): Promise<DelegatedSqlAccess> => {
  // Reuse the agent key signIn() already resolved + normalized (AgentIdentity) — no
  // second readFileSync of agentKeyFile and the raw key sits in memory for less time
  // (review #8). signIn() guarantees identity.normalizedKey is present here.
  const normalizedKey = identity.normalizedKey;
  // Wallet mode: construct node with the agent's privateKey and sign in as the
  // agent's own PKH identity (did:pkh:eip155:1:{address}). useDelegation
  // requires an established wallet session (auth.tinyCloudSession); without a
  // prior signIn() it throws "Not signed in. Call signIn() first." signIn()
  // establishes that session; useDelegation then builds the delegated
  // sub-session (user → agent) scoped to the delegation's SQL abilities.
  const node = new TinyCloudNode(delegatedNodeConfig(config, normalizedKey));
  await node.signIn();
  const access = await node.useDelegation(delegation);
  return access as unknown as DelegatedSqlAccess;
};

/**
 * Transport that routes SQL through a user-granted portable delegation.
 *
 * Auth-mode flow (Task 4 will implement the full wallet-mode path):
 *   signIn() → deserialize delegation → resolve agent identity → activate via
 *   useDelegation → cache DelegatedAccess → SQL calls use the cached handle.
 *
 * Until signIn() is called, all SQL methods return a typed NOT_ACTIVATED error.
 */
export class DelegatedTransport implements Transport {
  private readonly config: ResolvedDelegationConfig;
  private readonly deps: Required<DelegatedTransportDeps>;
  /** Set after a successful signIn(); null before that. */
  private _access: DelegatedSqlAccess | null = null;
  /** Cached SignInResult — set alongside _access; returned on subsequent signIn() calls. */
  private _cachedSignInResult: SignInResult | null = null;

  constructor(config: ResolvedDelegationConfig, deps: DelegatedTransportDeps = {}) {
    this.config = config;
    this.deps = {
      // The deserialize seam controls ONLY how serialized bytes parse into a
      // PortableDelegation — NOT whether grants are signed-derived. signIn() runs
      // normalizeDelegationGrants UNCONDITIONALLY on the result (review #5), so no
      // construction path (a refactor, a copied fixture) can bypass the signed-att
      // chokepoint and re-open the F1 forgery hole. Default is the raw SDK deserializer.
      deserialize: deps.deserialize ?? deserializeDelegationSafe,
      activate: deps.activate ?? defaultActivate,
      agentIdentity: deps.agentIdentity ?? agentIdentityFromKey,
    };
  }

  /**
   * Clear the cached DelegatedAccess and SignInResult so the next signIn() call
   * performs a fresh activation (rebuilds TinyCloudNode + re-calls useDelegation).
   *
   * Called by Session.reSignIn() before the auth-retry path so that:
   *   1. A fresh TinyCloudNode is built from the stored agent key (new wallet session).
   *   2. useDelegation is re-called to produce a fresh DelegatedAccess with a new
   *      sub-delegation SIWE (1h expiry from activation time).
   *
   * Without a prior invalidate(), signIn() returns the cached result — callers
   * outside the retry path (concurrent first-callers deduped by Session) must
   * not call invalidate() directly.
   */
  invalidate(): void {
    this._access = null;
    this._cachedSignInResult = null;
  }

  /**
   * Activate the delegation and cache the DelegatedAccess handle.
   *
   * On first call (or after invalidate()): deserializes the delegation, resolves
   * agent identity, validates shape, calls deps.activate (wallet-mode
   * TinyCloudNode + useDelegation), caches DelegatedAccess + SignInResult.
   *
   * On subsequent calls WITHOUT a prior invalidate(): returns the cached
   * SignInResult without re-activating.
   *
   * Session.reSignIn() calls transport.invalidate() before calling signIn()
   * again, so the retry path always performs a fresh activation. A re-activation
   * of an expired delegation will fail inside deps.activate or on the SQL retry,
   * and Session surfaces AuthError as the correct terminal state.
   *
   * SECURITY: no key or delegation material is included in thrown messages.
   */
  async signIn(): Promise<SignInResult> {
    // Return cached result if already activated (activator called exactly once).
    if (this._access && this._cachedSignInResult) {
      return this._cachedSignInResult;
    }

    // Resolve the serialized delegation (inline or file).
    const serialized =
      this.config.serializedDelegation ??
      (this.config.delegationFile
        ? readFileSync(this.config.delegationFile, "utf-8").trim()
        : undefined);
    if (!serialized) {
      throw new Error(
        "DelegatedTransport.signIn: no delegation source configured (serializedDelegation or delegationFile)",
      );
    }

    // Resolve agent identity (inline key or file).
    const identity = this.config.agentKey
      ? await this.deps.agentIdentity(this.config.agentKey)
      : this.config.agentKeyFile
        ? await agentIdentityFromFile(this.config.agentKeyFile)
        : (() => {
            throw new Error(
              "DelegatedTransport.signIn: no agent key source configured (agentKey or agentKeyFile)",
            );
          })();

    // Deserialize, then normalize STRUCTURALLY. deps.deserialize only parses bytes;
    // normalizeDelegationGrants rewrites resources/actions from the SIGNED `att` here
    // — unconditionally — so the validators below gate on signed-derived data rather
    // than the forgeable top-level summary, regardless of which deserializer ran
    // (review #5 / handoff F1).
    const delegation = normalizeDelegationGrants(this.deps.deserialize(serialized));

    // Shallow shape validation — cheap pre-check: field presence, delegatee, expiry,
    // a SQL grant exists. The authoritative gate is the deep policy check below.
    validateDelegationShape(delegation, {
      agentDid: identity.did,
      dbHandle: this.config.dbHandle,
    });

    // Deep policy validation — the authoritative pre-activation gate. Rejects
    // WRONG_DELEGATEE / EXPIRED / WRONG_DB_HANDLE / INSUFFICIENT_ACTIONS BEFORE a
    // single useDelegation network call. Because `delegation` was normalized from
    // the signed att, a forged top-level `actions` claim cannot pass here — the
    // SQL grant must be present in the signed capability (handoff F1 Consequence B).
    validateDelegationPolicy(delegation, {
      agentDID: identity.did,
      policy: defaultElizaMemoryPolicy(this.config.dbHandle),
    });

    // Owner identity is taken from the SIGNED side: the owner address embedded in the
    // signed space URI (tinycloud:pkh:eip155:{chain}:0x{owner}:default). The top-level
    // `ownerAddress` is unsigned/forgeable, so cross-check it against the signed owner
    // and reject a mismatch BEFORE activation — the surfaced identity must not be
    // attacker-set while grants are signed-correct (review #6).
    const signedAddress = signedOwnerAddress(delegation);
    if (
      signedAddress &&
      delegation.ownerAddress &&
      signedAddress.toLowerCase() !== delegation.ownerAddress.toLowerCase()
    ) {
      throw new DelegationPolicyError(
        "delegation ownerAddress does not match the signed space owner",
        "MALFORMED",
        { field: "ownerAddress" },
      );
    }

    // Activate via deps.activate — builds a fresh wallet-mode TinyCloudNode
    // and calls useDelegation(delegation) to obtain DelegatedAccess.
    // Re-activation rebuilds from stored config (not the old node instance) — the
    // fresh-node-per-activation invariant (plan §SDK findings risk #3); we
    // deliberately do NOT cache the node across activations.
    //
    // A failure HERE is a network/SDK fault (node.signIn() or useDelegation()),
    // distinct from the validation rejects above. Wrap it in a typed AuthError so
    // callers (and Session's auth-retry path) get a clean, classified error. The
    // message is fixed — never the agent key, delegation, or auth header; the raw
    // SDK error rides on `cause` for debugging only.
    let access: DelegatedSqlAccess;
    try {
      access = await this.deps.activate(this.config, delegation, identity);
    } catch (cause) {
      throw new AuthError(
        "DelegatedTransport: delegation activation failed (signIn/useDelegation)",
        { cause },
      );
    }
    this._access = access;

    const result: SignInResult = {
      spaceId: access.spaceId,
      // Signed-derived owner (cross-checked above); fall back to ownerAddress only
      // when no resource carried a parseable space (review #6).
      address: signedAddress ?? delegation.ownerAddress,
      did: identity.did,
    };
    this._cachedSignInResult = result;
    return result;
  }

  private activeHandle(): IDatabaseHandle | null {
    if (!this._access) return null;
    return this._access.sql.db(this.config.dbHandle);
  }

  async query(sql: string, params?: SqlValue[]): Promise<TransportResult<QueryData>> {
    const handle = this.activeHandle();
    if (!handle) return NOT_ACTIVATED_RESULT;
    return adapterQuery(handle, sql, params);
  }

  async execute(sql: string, params?: SqlValue[]): Promise<TransportResult<ExecuteData>> {
    const handle = this.activeHandle();
    if (!handle) return NOT_ACTIVATED_RESULT;
    return adapterExecute(handle, sql, params);
  }

  async batch(statements: SqlStatement[]): Promise<TransportResult<BatchData>> {
    const handle = this.activeHandle();
    if (!handle) return NOT_ACTIVATED_RESULT;
    return adapterBatch(handle, statements);
  }
}
