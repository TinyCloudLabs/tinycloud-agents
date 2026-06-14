// Tests for resolveMemoryClientConfig — auth mode resolution from runtime settings.
// Covers private-key mode (backward compat), delegation mode, and error paths.

import { expect, test } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import { SETTING_KEYS, resolveMemoryClientConfig, DEFAULT_MEMORY_DB_HANDLE } from "./config";

function makeRuntime(settings: Record<string, string | undefined>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key] ?? undefined,
  } as never;
}

// ---------------------------------------------------------------------------
// Private-key mode — backward compat
// ---------------------------------------------------------------------------

test("private-key: resolves TINYCLOUD_PRIVATE_KEY exactly as before", () => {
  const runtime = makeRuntime({ TINYCLOUD_PRIVATE_KEY: "0xabc" });
  const config = resolveMemoryClientConfig(runtime);
  expect(config).toMatchObject({ privateKey: "0xabc" });
  expect((config as { mode?: string }).mode).not.toBe("delegation");
});

test("private-key: throws when TINYCLOUD_PRIVATE_KEY is missing (no mode set)", () => {
  const runtime = makeRuntime({});
  expect(() => resolveMemoryClientConfig(runtime)).toThrow(/TINYCLOUD_PRIVATE_KEY/);
});

test("private-key: explicit TINYCLOUD_AUTH_MODE=private-key requires TINYCLOUD_PRIVATE_KEY", () => {
  const runtime = makeRuntime({ TINYCLOUD_AUTH_MODE: "private-key" });
  expect(() => resolveMemoryClientConfig(runtime)).toThrow(/TINYCLOUD_PRIVATE_KEY/);
});

test("private-key: explicit TINYCLOUD_AUTH_MODE=private-key resolves successfully", () => {
  const runtime = makeRuntime({
    TINYCLOUD_AUTH_MODE: "private-key",
    TINYCLOUD_PRIVATE_KEY: "0xdef",
  });
  const config = resolveMemoryClientConfig(runtime);
  expect(config).toMatchObject({ privateKey: "0xdef" });
});

test("private-key: resolves TINYCLOUD_HOST", () => {
  const runtime = makeRuntime({
    TINYCLOUD_PRIVATE_KEY: "0xabc",
    TINYCLOUD_HOST: "https://my.node.example",
  });
  const config = resolveMemoryClientConfig(runtime);
  expect((config as { host?: string }).host).toBe("https://my.node.example");
});

test("private-key: resolves TINYCLOUD_NODE_HOST legacy alias", () => {
  const runtime = makeRuntime({
    TINYCLOUD_PRIVATE_KEY: "0xabc",
    TINYCLOUD_NODE_HOST: "https://legacy.example",
  });
  const config = resolveMemoryClientConfig(runtime);
  expect((config as { host?: string }).host).toBe("https://legacy.example");
});

test("private-key: resolves TINYCLOUD_DB_HANDLE override", () => {
  const runtime = makeRuntime({
    TINYCLOUD_PRIVATE_KEY: "0xabc",
    TINYCLOUD_DB_HANDLE: "xyz.custom/db",
  });
  const config = resolveMemoryClientConfig(runtime);
  expect((config as { dbHandle?: string }).dbHandle).toBe("xyz.custom/db");
});

test("private-key: defaults dbHandle to MEMORY_DB_HANDLE", () => {
  const runtime = makeRuntime({ TINYCLOUD_PRIVATE_KEY: "0xabc" });
  const config = resolveMemoryClientConfig(runtime);
  expect((config as { dbHandle?: string }).dbHandle).toBe(DEFAULT_MEMORY_DB_HANDLE);
});

test("private-key: resolves TINYCLOUD_SPACE_PREFIX", () => {
  const runtime = makeRuntime({
    TINYCLOUD_PRIVATE_KEY: "0xabc",
    TINYCLOUD_SPACE_PREFIX: "pfx",
  });
  const config = resolveMemoryClientConfig(runtime);
  expect((config as { prefix?: string }).prefix).toBe("pfx");
});

// ---------------------------------------------------------------------------
// Unknown auth mode
// ---------------------------------------------------------------------------

test("throws a clear error for an unknown TINYCLOUD_AUTH_MODE value", () => {
  const runtime = makeRuntime({ TINYCLOUD_AUTH_MODE: "oauth" });
  expect(() => resolveMemoryClientConfig(runtime)).toThrow(/TINYCLOUD_AUTH_MODE/);
  expect(() => resolveMemoryClientConfig(runtime)).toThrow(/"oauth"/);
});

// ---------------------------------------------------------------------------
// Delegation mode — happy paths
// ---------------------------------------------------------------------------

test("delegation: resolves with inline delegation + inline agent key", () => {
  const runtime = makeRuntime({
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_DELEGATION: "serial-del",
    TINYCLOUD_AGENT_KEY: "0xagentkey",
  });
  const config = resolveMemoryClientConfig(runtime);
  expect(config.mode).toBe("delegation");
  expect((config as { serializedDelegation?: string }).serializedDelegation).toBe("serial-del");
  expect((config as { agentKey?: string }).agentKey).toBe("0xagentkey");
});

test("delegation: resolves with delegation file + agent key file", () => {
  const runtime = makeRuntime({
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_DELEGATION_FILE: "/run/delegation.json",
    TINYCLOUD_AGENT_KEY_FILE: "/run/agent.key",
  });
  const config = resolveMemoryClientConfig(runtime);
  expect(config.mode).toBe("delegation");
  expect((config as { delegationFile?: string }).delegationFile).toBe("/run/delegation.json");
  expect((config as { agentKeyFile?: string }).agentKeyFile).toBe("/run/agent.key");
});

test("delegation: resolves TINYCLOUD_HOST in delegation mode", () => {
  const runtime = makeRuntime({
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_DELEGATION: "d",
    TINYCLOUD_AGENT_KEY: "k",
    TINYCLOUD_HOST: "https://local.node",
  });
  const config = resolveMemoryClientConfig(runtime);
  expect((config as { host?: string }).host).toBe("https://local.node");
});

test("delegation: resolves TINYCLOUD_NODE_HOST legacy alias", () => {
  const runtime = makeRuntime({
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_DELEGATION: "d",
    TINYCLOUD_AGENT_KEY: "k",
    TINYCLOUD_NODE_HOST: "https://legacy.example",
  });
  const config = resolveMemoryClientConfig(runtime);
  expect((config as { host?: string }).host).toBe("https://legacy.example");
});

test("delegation: resolves TINYCLOUD_DB_HANDLE in delegation mode", () => {
  const runtime = makeRuntime({
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_DELEGATION: "d",
    TINYCLOUD_AGENT_KEY: "k",
    TINYCLOUD_DB_HANDLE: "xyz.custom/mem",
  });
  const config = resolveMemoryClientConfig(runtime);
  expect((config as { dbHandle?: string }).dbHandle).toBe("xyz.custom/mem");
});

test("delegation: defaults dbHandle to MEMORY_DB_HANDLE", () => {
  const runtime = makeRuntime({
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_DELEGATION: "d",
    TINYCLOUD_AGENT_KEY: "k",
  });
  const config = resolveMemoryClientConfig(runtime);
  expect((config as { dbHandle?: string }).dbHandle).toBe(DEFAULT_MEMORY_DB_HANDLE);
});

// ---------------------------------------------------------------------------
// Delegation mode — missing/conflicting delegation source
// ---------------------------------------------------------------------------

test("delegation: throws when no delegation source is provided", () => {
  const runtime = makeRuntime({
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_AGENT_KEY: "0xkey",
  });
  expect(() => resolveMemoryClientConfig(runtime)).toThrow(/delegation source/);
  expect(() => resolveMemoryClientConfig(runtime)).toThrow(/TINYCLOUD_DELEGATION/);
});

test("delegation: throws when both TINYCLOUD_DELEGATION and TINYCLOUD_DELEGATION_FILE are set", () => {
  const runtime = makeRuntime({
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_DELEGATION: "inline",
    TINYCLOUD_DELEGATION_FILE: "/path/del.json",
    TINYCLOUD_AGENT_KEY: "0xkey",
  });
  expect(() => resolveMemoryClientConfig(runtime)).toThrow(/not both/);
});

// ---------------------------------------------------------------------------
// Delegation mode — missing/conflicting agent key source
// ---------------------------------------------------------------------------

test("delegation: throws when no agent key source is provided", () => {
  const runtime = makeRuntime({
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_DELEGATION: "inline",
  });
  expect(() => resolveMemoryClientConfig(runtime)).toThrow(/agent key source/);
  expect(() => resolveMemoryClientConfig(runtime)).toThrow(/TINYCLOUD_AGENT_KEY/);
});

test("delegation: throws when both TINYCLOUD_AGENT_KEY and TINYCLOUD_AGENT_KEY_FILE are set", () => {
  const runtime = makeRuntime({
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_DELEGATION: "inline",
    TINYCLOUD_AGENT_KEY: "0xkey",
    TINYCLOUD_AGENT_KEY_FILE: "/path/agent.key",
  });
  expect(() => resolveMemoryClientConfig(runtime)).toThrow(/not both/);
});

// ---------------------------------------------------------------------------
// Delegation mode — multi-tenant: boot delegation source is optional
// ---------------------------------------------------------------------------

test("delegation+multi-tenant: resolves with agent key file and NO delegation source (no throw)", () => {
  const runtime = makeRuntime({
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_MULTI_TENANT: "1",
    TINYCLOUD_AGENT_KEY_FILE: "/run/agent.key",
  });
  const config = resolveMemoryClientConfig(runtime);
  expect(config.mode).toBe("delegation");
  expect((config as { agentKeyFile?: string }).agentKeyFile).toBe("/run/agent.key");
  expect((config as { serializedDelegation?: string }).serializedDelegation).toBeUndefined();
  expect((config as { delegationFile?: string }).delegationFile).toBeUndefined();
});

test("delegation+multi-tenant: resolves with inline agent key and NO delegation source", () => {
  const runtime = makeRuntime({
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_MULTI_TENANT: "true",
    TINYCLOUD_AGENT_KEY: "0xagentkey",
  });
  const config = resolveMemoryClientConfig(runtime);
  expect(config.mode).toBe("delegation");
  expect((config as { agentKey?: string }).agentKey).toBe("0xagentkey");
  expect((config as { serializedDelegation?: string }).serializedDelegation).toBeUndefined();
});

test("delegation+multi-tenant: still requires an agent key source", () => {
  const runtime = makeRuntime({
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_MULTI_TENANT: "1",
  });
  expect(() => resolveMemoryClientConfig(runtime)).toThrow(/agent key source/);
});

test("delegation (single-tenant, no multi-tenant flag): missing delegation source still throws", () => {
  const runtime = makeRuntime({
    TINYCLOUD_AUTH_MODE: "delegation",
    TINYCLOUD_AGENT_KEY: "0xkey",
  });
  expect(() => resolveMemoryClientConfig(runtime)).toThrow(/delegation source/);
});

// ---------------------------------------------------------------------------
// Security: errors must not leak secret material
// ---------------------------------------------------------------------------

test("delegation: error messages do not include agent key value", () => {
  let msg = "";
  try {
    resolveMemoryClientConfig(
      makeRuntime({
        TINYCLOUD_AUTH_MODE: "delegation",
        TINYCLOUD_DELEGATION: "secret-delegation-value",
        TINYCLOUD_AGENT_KEY: "secret-agent-key-value",
        TINYCLOUD_AGENT_KEY_FILE: "/path/agent.key",
      }),
    );
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).not.toContain("secret-agent-key-value");
  expect(msg).not.toContain("secret-delegation-value");
  expect(msg.length).toBeGreaterThan(0);
});

test("private-key: error message does not include private key value", () => {
  let msg = "";
  try {
    resolveMemoryClientConfig(makeRuntime({ TINYCLOUD_PRIVATE_KEY: "" }));
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toMatch(/TINYCLOUD_PRIVATE_KEY/);
  expect(msg).not.toContain("0xsecret");
});
