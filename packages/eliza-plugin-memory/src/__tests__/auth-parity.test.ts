// Cross-layer parity for the delegation-config XOR validation.
//
// Handoff known-finding: the "exactly one delegation source + exactly one agent
// key source" rule is DUPLICATED in two places —
//   • @tinycloud/agent-client   resolveDelegationConfig   (framework-agnostic)
//   • eliza-plugin-memory       resolveMemoryClientConfig (env surface)
// Phase 3 may centralize them. These tests pin that, TODAY, both validators make
// IDENTICAL accept/reject decisions across the full source matrix — so any future
// de-duplication that preserves behavior keeps this green, and any that drifts
// goes red. They also prove the eliza→agent-client handoff: a config eliza
// resolves is one agent-client accepts.

import { expect, test } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import {
  resolveDelegationConfig,
  type DelegationAgentClientConfig,
} from "@tinycloud/agent-client";
import { SETTING_KEYS, resolveMemoryClientConfig } from "../config";

function makeRuntime(settings: Record<string, string | undefined>): IAgentRuntime {
  return { getSetting: (key: string) => settings[key] ?? undefined } as never;
}

function elizaAccepts(settings: Record<string, string | undefined>): boolean {
  try {
    resolveMemoryClientConfig(makeRuntime({ ...settings, TINYCLOUD_AUTH_MODE: "delegation" }));
    return true;
  } catch {
    return false;
  }
}

function agentClientAccepts(config: Omit<DelegationAgentClientConfig, "mode">): boolean {
  try {
    resolveDelegationConfig({ mode: "delegation", ...config });
    return true;
  } catch {
    return false;
  }
}

// The source matrix: each axis is none / inline / file / both. A config is valid
// iff exactly ONE delegation source AND exactly ONE agent-key source are present.
const DELEGATION_SOURCES = {
  none: {} as Record<string, string>,
  inline: { TINYCLOUD_DELEGATION: "serialized" },
  file: { TINYCLOUD_DELEGATION_FILE: "/run/del.json" },
  both: { TINYCLOUD_DELEGATION: "serialized", TINYCLOUD_DELEGATION_FILE: "/run/del.json" },
} as const;
const KEY_SOURCES = {
  none: {} as Record<string, string>,
  inline: { TINYCLOUD_AGENT_KEY: "0xkey" },
  file: { TINYCLOUD_AGENT_KEY_FILE: "/run/agent.key" },
  both: { TINYCLOUD_AGENT_KEY: "0xkey", TINYCLOUD_AGENT_KEY_FILE: "/run/agent.key" },
} as const;

// Map env settings → the agent-client config shape (same logical sources).
function toAgentClientConfig(
  settings: Record<string, string>,
): Omit<DelegationAgentClientConfig, "mode"> {
  return {
    serializedDelegation: settings[SETTING_KEYS.delegation],
    delegationFile: settings[SETTING_KEYS.delegationFile],
    agentKey: settings[SETTING_KEYS.agentKey],
    agentKeyFile: settings[SETTING_KEYS.agentKeyFile],
  };
}

test("XOR validation: both layers agree across the full 4×4 source matrix", () => {
  const mismatches: string[] = [];
  for (const [delName, del] of Object.entries(DELEGATION_SOURCES)) {
    for (const [keyName, key] of Object.entries(KEY_SOURCES)) {
      const settings = { ...del, ...key };
      const expected = delName !== "none" && delName !== "both" && keyName !== "none" && keyName !== "both";

      const eliza = elizaAccepts(settings);
      const agent = agentClientAccepts(toAgentClientConfig(settings));

      if (eliza !== expected || agent !== expected) {
        mismatches.push(
          `del=${delName} key=${keyName}: expected=${expected} eliza=${eliza} agentClient=${agent}`,
        );
      }
    }
  }
  expect(mismatches).toEqual([]);
});

test("handoff: a config eliza resolves in delegation mode is one agent-client accepts", () => {
  const config = resolveMemoryClientConfig(
    makeRuntime({
      TINYCLOUD_AUTH_MODE: "delegation",
      TINYCLOUD_DELEGATION: "serialized-delegation",
      TINYCLOUD_AGENT_KEY: "0xagentkey",
    }),
  ) as DelegationAgentClientConfig;

  // eliza produced a delegation-shaped config...
  expect(config.mode).toBe("delegation");
  // ...and agent-client's resolver — the Phase-3 entry point — accepts it.
  const resolved = resolveDelegationConfig(config);
  expect(resolved.serializedDelegation).toBe("serialized-delegation");
  expect(resolved.agentKey).toBe("0xagentkey");
});

test("handoff: eliza file-source config also round-trips through agent-client", () => {
  const config = resolveMemoryClientConfig(
    makeRuntime({
      TINYCLOUD_AUTH_MODE: "delegation",
      TINYCLOUD_DELEGATION_FILE: "/run/del.json",
      TINYCLOUD_AGENT_KEY_FILE: "/run/agent.key",
    }),
  ) as DelegationAgentClientConfig;

  const resolved = resolveDelegationConfig(config);
  expect(resolved.delegationFile).toBe("/run/del.json");
  expect(resolved.agentKeyFile).toBe("/run/agent.key");
  expect(resolved.serializedDelegation).toBeUndefined();
  expect(resolved.agentKey).toBeUndefined();
});
