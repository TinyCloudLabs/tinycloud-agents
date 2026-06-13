// Config surface for @tinycloud/eliza-plugin-memory.
//
// Resolves an {@link AgentClientAuthConfig} from the Eliza runtime's settings/env
// so the service can sign in to a TinyCloud space. Two auth modes are supported:
//
//   private-key (default):
//     • TINYCLOUD_PRIVATE_KEY  (REQUIRED)  hex key for the agent's OWN memory space.
//         DEDICATED low-value key — NEVER the operator's main wallet.
//
//   delegation:
//     • TINYCLOUD_AUTH_MODE=delegation
//     • TINYCLOUD_DELEGATION or TINYCLOUD_DELEGATION_FILE  (exactly one)
//     • TINYCLOUD_AGENT_KEY or TINYCLOUD_AGENT_KEY_FILE    (exactly one)
//
//   Common to both modes:
//     • TINYCLOUD_HOST         (optional)  node endpoint; defaults to the public node.
//     • TINYCLOUD_DB_HANDLE    (optional)  full-path db handle; defaults to MEMORY_DB_HANDLE.
//     • TINYCLOUD_SPACE_PREFIX (optional)  node-sdk space prefix (private-key mode only).
//
// SECURITY: never log the resolved key or delegation material.

import { type IAgentRuntime } from "@elizaos/core";
import {
  type AgentClientAuthConfig,
  type AgentClientConfig,
  type DelegationAgentClientConfig,
} from "@tinycloud/agent-client";

import { MEMORY_DB_HANDLE } from "./schema";

/** Runtime setting / env keys this plugin reads (the documented config surface). */
export const SETTING_KEYS = {
  /** Auth mode: "private-key" (default) or "delegation". */
  authMode: "TINYCLOUD_AUTH_MODE",
  /** REQUIRED in private-key mode: hex private key for the agent's dedicated memory-space wallet. */
  privateKey: "TINYCLOUD_PRIVATE_KEY",
  /** Node endpoint override. `TINYCLOUD_NODE_HOST` is accepted as a legacy alias. */
  host: "TINYCLOUD_HOST",
  hostAlias: "TINYCLOUD_NODE_HOST",
  /** Full-path db handle override (default {@link MEMORY_DB_HANDLE}). */
  dbHandle: "TINYCLOUD_DB_HANDLE",
  /** node-sdk space prefix (private-key mode). */
  prefix: "TINYCLOUD_SPACE_PREFIX",
  /** Delegation mode: inline serialized portable delegation. */
  delegation: "TINYCLOUD_DELEGATION",
  /** Delegation mode: file path containing serialized portable delegation. */
  delegationFile: "TINYCLOUD_DELEGATION_FILE",
  /** Delegation mode: inline stable agent identity key material. */
  agentKey: "TINYCLOUD_AGENT_KEY",
  /** Delegation mode: file path containing stable agent identity key material. */
  agentKeyFile: "TINYCLOUD_AGENT_KEY_FILE",
} as const;

/** Default db handle when {@link SETTING_KEYS.dbHandle} is unset. */
export const DEFAULT_MEMORY_DB_HANDLE = MEMORY_DB_HANDLE;

/** Read a runtime setting, normalizing empty/absent values to undefined. */
export function settingString(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  if (value === null || value === undefined || value === "") return undefined;
  return String(value);
}

function resolveHost(runtime: IAgentRuntime): string | undefined {
  return settingString(runtime, SETTING_KEYS.host) ?? settingString(runtime, SETTING_KEYS.hostAlias);
}

function resolvePrivateKeyConfig(runtime: IAgentRuntime): AgentClientConfig {
  const privateKey = settingString(runtime, SETTING_KEYS.privateKey);
  if (!privateKey) {
    throw new Error(
      `${SETTING_KEYS.privateKey} is required in private-key mode: ` +
        "set a DEDICATED low-value key for the agent's memory space — never the " +
        "operator's main wallet.",
    );
  }
  return {
    privateKey,
    host: resolveHost(runtime),
    prefix: settingString(runtime, SETTING_KEYS.prefix),
    dbHandle: settingString(runtime, SETTING_KEYS.dbHandle) ?? DEFAULT_MEMORY_DB_HANDLE,
  };
}

function resolveDelegationModeConfig(runtime: IAgentRuntime): DelegationAgentClientConfig {
  const serializedDelegation = settingString(runtime, SETTING_KEYS.delegation);
  const delegationFile = settingString(runtime, SETTING_KEYS.delegationFile);
  const agentKey = settingString(runtime, SETTING_KEYS.agentKey);
  const agentKeyFile = settingString(runtime, SETTING_KEYS.agentKeyFile);

  if (!serializedDelegation && !delegationFile) {
    throw new Error(
      `Delegation mode requires a delegation source: set ${SETTING_KEYS.delegation} ` +
        `or ${SETTING_KEYS.delegationFile}`,
    );
  }
  if (serializedDelegation && delegationFile) {
    throw new Error(
      `Delegation mode conflict: set ${SETTING_KEYS.delegation} ` +
        `or ${SETTING_KEYS.delegationFile}, not both`,
    );
  }
  if (!agentKey && !agentKeyFile) {
    throw new Error(
      `Delegation mode requires a stable agent key source: set ${SETTING_KEYS.agentKey} ` +
        `or ${SETTING_KEYS.agentKeyFile}`,
    );
  }
  if (agentKey && agentKeyFile) {
    throw new Error(
      `Delegation mode conflict: set ${SETTING_KEYS.agentKey} ` +
        `or ${SETTING_KEYS.agentKeyFile}, not both`,
    );
  }

  return {
    mode: "delegation",
    serializedDelegation,
    delegationFile,
    agentKey,
    agentKeyFile,
    host: resolveHost(runtime),
    dbHandle: settingString(runtime, SETTING_KEYS.dbHandle) ?? DEFAULT_MEMORY_DB_HANDLE,
  };
}

/**
 * Resolve the {@link AgentClientAuthConfig} for the storage service from runtime
 * settings/env.
 *
 * - No `TINYCLOUD_AUTH_MODE` (or `TINYCLOUD_AUTH_MODE=private-key`): requires
 *   `TINYCLOUD_PRIVATE_KEY`.
 * - `TINYCLOUD_AUTH_MODE=delegation`: requires delegation source and agent key
 *   source; missing or conflicting inputs throw clear errors.
 */
export function resolveMemoryClientConfig(runtime: IAgentRuntime): AgentClientAuthConfig {
  const authMode = settingString(runtime, SETTING_KEYS.authMode);

  if (authMode === "delegation") {
    return resolveDelegationModeConfig(runtime);
  }

  if (authMode !== undefined && authMode !== "private-key") {
    throw new Error(
      `Unknown ${SETTING_KEYS.authMode} value "${authMode}": ` +
        `expected "private-key" or "delegation"`,
    );
  }

  return resolvePrivateKeyConfig(runtime);
}
