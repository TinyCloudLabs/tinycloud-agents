// Config surface for @tinycloud/eliza-plugin-memory (plan §3 — agent-holds-key).
//
// Resolves an {@link AgentClientConfig} from the Eliza runtime's settings/env so
// the service can sign in to a user-owned TinyCloud space. This is the documented
// knob set referenced by the package README:
//
//   • TINYCLOUD_PRIVATE_KEY  (REQUIRED)  hex key for the agent's OWN memory space.
//       D3: a DEDICATED low-value key — NEVER the operator's main wallet. Key
//       compromise == memory-space compromise only (plan §5 security posture).
//   • TINYCLOUD_HOST         (optional)  node endpoint; defaults to the public
//       node. Self-host this for sensitive deployments (plaintext-at-rest, §10.1).
//   • TINYCLOUD_DB_HANDLE    (optional)  full-path db handle; the "db-handle prefix"
//       defaults to MEMORY_DB_HANDLE ("xyz.tinycloud.eliza/memory", plan §4).
//   • TINYCLOUD_SPACE_PREFIX (optional)  node-sdk space `prefix`.
//
// SECURITY: never log the resolved key or host as part of a request/credential
// dump (plan §5 — no Authorization/full-request logging at any level).

import { type IAgentRuntime } from "@elizaos/core";
import { type AgentClientConfig } from "@tinycloud/agent-client";

import { MEMORY_DB_HANDLE } from "./schema";

/** Runtime setting / env keys this plugin reads (the documented config surface). */
export const SETTING_KEYS = {
  /** REQUIRED hex private key for the agent's dedicated memory-space wallet (D3). */
  privateKey: "TINYCLOUD_PRIVATE_KEY",
  /** Node endpoint override. `TINYCLOUD_NODE_HOST` is accepted as a legacy alias. */
  host: "TINYCLOUD_HOST",
  hostAlias: "TINYCLOUD_NODE_HOST",
  /** Full-path db handle override (default {@link MEMORY_DB_HANDLE}). */
  dbHandle: "TINYCLOUD_DB_HANDLE",
  /** node-sdk space prefix. */
  prefix: "TINYCLOUD_SPACE_PREFIX",
} as const;

/** Default db handle when {@link SETTING_KEYS.dbHandle} is unset (plan §4). */
export const DEFAULT_MEMORY_DB_HANDLE = MEMORY_DB_HANDLE;

/** Read a runtime setting, normalizing empty/absent values to undefined. */
export function settingString(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  if (value === null || value === undefined || value === "") return undefined;
  return String(value);
}

/**
 * Resolve the {@link AgentClientConfig} for the storage service from runtime
 * settings/env. Throws when {@link SETTING_KEYS.privateKey} is absent — the
 * agent-holds-key model has no other auth path (plan §3).
 */
export function resolveMemoryClientConfig(runtime: IAgentRuntime): AgentClientConfig {
  const privateKey = settingString(runtime, SETTING_KEYS.privateKey);
  if (!privateKey) {
    throw new Error(
      `${SETTING_KEYS.privateKey} is required (agent-holds-key model, plan §3): ` +
        "set a DEDICATED low-value key for the agent's memory space — never the " +
        "operator's main wallet (D3).",
    );
  }
  return {
    privateKey,
    host:
      settingString(runtime, SETTING_KEYS.host) ??
      settingString(runtime, SETTING_KEYS.hostAlias),
    prefix: settingString(runtime, SETTING_KEYS.prefix),
    dbHandle: settingString(runtime, SETTING_KEYS.dbHandle) ?? DEFAULT_MEMORY_DB_HANDLE,
  };
}
