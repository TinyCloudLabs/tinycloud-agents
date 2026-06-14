// Phase 6: Consent and Delivery Harness — I/O contract implementation.
//
// Offline — never calls useDelegation, never touches the network.
// Derives the agent DID via the Phase-2 agentIdentityFromKey/agentIdentityFromFile
// helper so the advertised DID equals the runtime-activated DID.
// Imports defaultElizaMemoryPolicy + computePolicyHash from @tinycloud/agent-client
// (Phase 4 delegation-policy.ts — §2.1 shared policy module, cohesion plan).
//
// SECURITY: never print the agent key or key-file contents — only the derived DID.
// Error messages name fields, never values.

import { resolve } from "node:path";
import {
  agentIdentityFromKey,
  agentIdentityFromFile,
  defaultElizaMemoryPolicy, // Phase 4
  computePolicyHash,        // Phase 4
} from "@tinycloud/agent-client";
import type { AgentIdentity, DelegationPolicy } from "@tinycloud/agent-client";

const DEFAULT_HARNESS_HOST = "https://node.tinycloud.xyz";
const DEFAULT_HARNESS_DB_HANDLE = "xyz.tinycloud.eliza/memory";
const DEFAULT_HARNESS_DELEGATION_FILE = "./.tinycloud/agent-delegation.json";
const DEFAULT_OPENKEY_DELEGATE_URL = "https://openkey.so/delegate";
const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Environment input for the consent harness.
 * Mirrors the env keys documented in the Phase-6 I/O contract.
 */
export interface ConsentEnv {
  /** Stable agent identity key material (hex). Exactly one of AGENT_KEY or AGENT_KEY_FILE. */
  TINYCLOUD_AGENT_KEY?: string;
  /** File path containing stable agent identity key material. XOR with AGENT_KEY. */
  TINYCLOUD_AGENT_KEY_FILE?: string;
  /** TinyCloud node endpoint (default: https://node.tinycloud.xyz). */
  TINYCLOUD_HOST?: string;
  /** Full-path SQL db handle (default: xyz.tinycloud.eliza/memory). */
  TINYCLOUD_DB_HANDLE?: string;
  /** Delegation file path the runtime reads on boot (default: ./.tinycloud/agent-delegation.json). */
  TINYCLOUD_DELEGATION_FILE?: string;
  /** Base URL for the OpenKey delegate page (default: https://openkey.so/delegate). */
  OPENKEY_DELEGATE_URL?: string;
  /** ISO 8601 delegation expiry override — used by tests to produce deterministic URLs. */
  CONSENT_EXPIRY_ISO?: string;
}

/**
 * The structured consent report emitted by the harness.
 * Every field is required — the regression guard asserts non-empty presence of all.
 */
export interface ConsentReport {
  /** Stable did:pkh:eip155:1:{address} derived from the agent key (never the key itself). */
  agentDid: string;
  /** TinyCloud node endpoint. */
  host: string;
  /** Full-path SQL db handle. */
  dbHandle: string;
  /** Phase-4 canonical permission set — exactly defaultElizaMemoryPolicy(dbHandle). */
  permissions: DelegationPolicy;
  /** Stable hash over permissions + agentDid — computed by computePolicyHash. */
  policyHash: string;
  /** Absolute path to the delegation file the runtime reads on boot. */
  delegationFilePath: string;
  /** OpenKey delegate URL with query params: did/host/permissions/expiry. */
  openKeyDelegateUrl: string;
  /** Human-readable ordered steps for the live manual flow. */
  instructions: string[];
}

/** Normalize an env string: trim whitespace; treat blank as absent. */
function envStr(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v === "" ? undefined : v;
}

/**
 * Pure async function: builds the consent report from environment variables.
 *
 * Refusal cases (throws, non-zero exit, no JSON, no secret):
 *  - TINYCLOUD_AGENT_KEY and TINYCLOUD_AGENT_KEY_FILE both absent
 *  - TINYCLOUD_AGENT_KEY and TINYCLOUD_AGENT_KEY_FILE both provided
 *  - Key is empty or otherwise invalid
 *  - Key file is unreadable
 *
 * Never calls useDelegation or the network. Never exposes key or file contents
 * in thrown error messages — only field names.
 */
export async function buildConsentReport(env: ConsentEnv): Promise<ConsentReport> {
  const agentKey = envStr(env.TINYCLOUD_AGENT_KEY);
  const agentKeyFile = envStr(env.TINYCLOUD_AGENT_KEY_FILE);

  // XOR validation — mirrors resolveDelegationModeConfig rules
  if (!agentKey && !agentKeyFile) {
    throw new Error(
      "Missing agent key source: set TINYCLOUD_AGENT_KEY or TINYCLOUD_AGENT_KEY_FILE (exactly one).",
    );
  }
  if (agentKey && agentKeyFile) {
    throw new Error(
      "Conflicting agent key sources: set TINYCLOUD_AGENT_KEY or TINYCLOUD_AGENT_KEY_FILE, not both.",
    );
  }

  // Derive agent DID via Phase-2 helper — the same path the runtime activates with,
  // so the advertised DID equals the runtime-activated DID.
  // Wrapped in try/catch so key or file-content values never reach error messages.
  let identity: AgentIdentity;
  try {
    identity = agentKey
      ? await agentIdentityFromKey(agentKey)
      : await agentIdentityFromFile(agentKeyFile!);
  } catch {
    const field = agentKey ? "TINYCLOUD_AGENT_KEY" : "TINYCLOUD_AGENT_KEY_FILE";
    throw new Error(
      `Failed to derive agent DID from ${field}: verify the value is valid 32-byte hex key material.`,
    );
  }

  const host = envStr(env.TINYCLOUD_HOST) ?? DEFAULT_HARNESS_HOST;
  const dbHandle = envStr(env.TINYCLOUD_DB_HANDLE) ?? DEFAULT_HARNESS_DB_HANDLE;
  const delegationFilePath = resolve(
    envStr(env.TINYCLOUD_DELEGATION_FILE) ?? DEFAULT_HARNESS_DELEGATION_FILE,
  );
  const baseUrl = envStr(env.OPENKEY_DELEGATE_URL) ?? DEFAULT_OPENKEY_DELEGATE_URL;

  // Phase 4: single source of truth for the permission set — do NOT hand-roll these.
  const permissions = defaultElizaMemoryPolicy(dbHandle);
  const policyHash = computePolicyHash(permissions, identity.did);

  // Expiry for the OpenKey delegate URL query param (informational; human reviews before signing).
  // CONSENT_EXPIRY_ISO is an escape hatch for tests to produce deterministic URLs.
  const expiryIso =
    envStr(env.CONSENT_EXPIRY_ISO) ??
    new Date(Date.now() + DEFAULT_EXPIRY_MS).toISOString();

  // OpenKey delegate-page contract (openkey apps/web/src/routes/delegate/+page.svelte):
  // the page decodes the `permissions` query param as base64url JSON of shape
  //   { permissions: [{ service, space, path, actions }] }
  // where `service` is SHORT form ("sql"), `actions` are FULL-URN
  // ("tinycloud.sql/read"), and `space` is filled in from the user's key selection
  // on the page (left empty in the request). This mirrors js-sdk's `tc auth request`
  // and the API /api/delegate/prepare PermissionEntry shape. We translate our
  // canonical DelegationPolicy (resources[]) into that request shape here.
  const openKeyPermissions = {
    permissions: permissions.resources.map((r) => ({
      service: r.serviceShort,
      space: "",
      path: r.path,
      actions: r.requiredActions,
    })),
  };
  const permissionsB64 = Buffer.from(JSON.stringify(openKeyPermissions)).toString("base64url");

  const url = new URL(baseUrl);
  url.searchParams.set("did", identity.did);
  url.searchParams.set("host", host);
  url.searchParams.set("permissions", permissionsB64);
  url.searchParams.set("expiry", expiryIso);
  const openKeyDelegateUrl = url.toString();

  return {
    agentDid: identity.did,
    host,
    dbHandle,
    permissions,
    policyHash,
    delegationFilePath,
    openKeyDelegateUrl,
    instructions: [
      "1. Open the OpenKey delegate URL above and sign in with your passkey.",
      "2. Review the requested permissions; they must match the permissions field.",
      "3. Approve to create a delegation to the agentDid.",
      "4. Copy the serialized delegation and write it to delegationFilePath",
      "   (or export it as TINYCLOUD_DELEGATION).",
      "5. Boot Eliza with TINYCLOUD_AUTH_MODE=delegation and TINYCLOUD_DELEGATION_FILE set.",
    ],
  };
}

// ---------------------------------------------------------------------------
// CLI entry point — thin wrapper over buildConsentReport
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonOnly = args.includes("--json");

  const env: ConsentEnv = {
    TINYCLOUD_AGENT_KEY: process.env.TINYCLOUD_AGENT_KEY,
    TINYCLOUD_AGENT_KEY_FILE: process.env.TINYCLOUD_AGENT_KEY_FILE,
    TINYCLOUD_HOST: process.env.TINYCLOUD_HOST,
    TINYCLOUD_DB_HANDLE: process.env.TINYCLOUD_DB_HANDLE,
    TINYCLOUD_DELEGATION_FILE: process.env.TINYCLOUD_DELEGATION_FILE,
    OPENKEY_DELEGATE_URL: process.env.OPENKEY_DELEGATE_URL,
    // CONSENT_EXPIRY_ISO not wired from env in the CLI; tests pass it directly.
  };

  let report: ConsentReport;
  try {
    report = await buildConsentReport(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`consent-harness: ${message}\n`);
    process.exit(1);
  }

  const json = JSON.stringify(report, null, 2);

  if (jsonOnly) {
    process.stdout.write(json + "\n");
    return;
  }

  // Human-readable block, then the JSON
  process.stdout.write(
    [
      "",
      "=== TinyCloud Eliza Agent Consent Harness ===",
      "",
      `Agent DID:             ${report.agentDid}`,
      `Host:                  ${report.host}`,
      `DB Handle:             ${report.dbHandle}`,
      `Policy Hash:           ${report.policyHash}`,
      `Delegation File Path:  ${report.delegationFilePath}`,
      "",
      "OpenKey Delegate URL:",
      `  ${report.openKeyDelegateUrl}`,
      "",
      "Instructions:",
      ...report.instructions.map((s) => `  ${s}`),
      "",
      "=== JSON ===",
      json,
      "",
    ].join("\n"),
  );
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(
      `consent-harness fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
