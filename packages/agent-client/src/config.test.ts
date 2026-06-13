import { expect, test } from "bun:test";
import {
  DEFAULT_BREAKER_OPEN_MS,
  DEFAULT_BREAKER_THRESHOLD,
  DEFAULT_DB_HANDLE,
  DEFAULT_HOST,
  DEFAULT_RE_SIGN_IN_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_WRITE_QUEUE_LIMIT,
  resolveConfig,
  resolveDelegationConfig,
  createAgentClient,
} from "./index.ts";
import type { AgentClientAuthConfig } from "./index.ts";

// ---------------------------------------------------------------------------
// Private-key mode (backward compat)
// ---------------------------------------------------------------------------

test("resolveConfig fills plan-§5 defaults", () => {
  const c = resolveConfig({ privateKey: "0xabc" });
  expect(c.host).toBe(DEFAULT_HOST);
  expect(c.host).toBe("https://node.tinycloud.xyz");
  expect(c.dbHandle).toBe(DEFAULT_DB_HANDLE);
  expect(c.dbHandle).toBe("xyz.tinycloud.eliza/memory");
  expect(c.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  expect(c.requestTimeoutMs).toBe(10_000);
  expect(c.writeQueueLimit).toBe(DEFAULT_WRITE_QUEUE_LIMIT);
  expect(c.writeQueueLimit).toBe(50);
  expect(c.breakerThreshold).toBe(DEFAULT_BREAKER_THRESHOLD);
  expect(c.breakerThreshold).toBe(5);
  expect(c.breakerOpenMs).toBe(DEFAULT_BREAKER_OPEN_MS);
  expect(c.breakerOpenMs).toBe(120_000);
  expect(c.reSignInMs).toBe(DEFAULT_RE_SIGN_IN_MS);
  expect(c.reSignInMs).toBe(50 * 60_000);
  expect(c.prefix).toBeUndefined();
});

test("resolveConfig honors overrides", () => {
  const c = resolveConfig({
    privateKey: "0xabc",
    host: "https://other.example",
    prefix: "p",
    dbHandle: "x/y",
    requestTimeoutMs: 1,
    writeQueueLimit: 2,
    breakerThreshold: 3,
    breakerOpenMs: 4,
    reSignInMs: 5,
  });
  expect(c).toEqual({
    privateKey: "0xabc",
    host: "https://other.example",
    prefix: "p",
    dbHandle: "x/y",
    requestTimeoutMs: 1,
    writeQueueLimit: 2,
    breakerThreshold: 3,
    breakerOpenMs: 4,
    reSignInMs: 5,
  });
});

test("resolveConfig throws without a private key", () => {
  expect(() => resolveConfig({ privateKey: "" })).toThrow(/privateKey is required/);
});

test("resolveConfig accepts explicit mode: private-key", () => {
  const c = resolveConfig({ mode: "private-key", privateKey: "0xabc" });
  expect(c.privateKey).toBe("0xabc");
  expect(c.host).toBe(DEFAULT_HOST);
});

// ---------------------------------------------------------------------------
// Delegation mode — typed union acceptance
// ---------------------------------------------------------------------------

test("AgentClientAuthConfig union accepts private-key shape", () => {
  const config: AgentClientAuthConfig = { privateKey: "0xabc" };
  expect(config).toBeDefined();
});

test("AgentClientAuthConfig union accepts delegation shape", () => {
  const config: AgentClientAuthConfig = {
    mode: "delegation",
    serializedDelegation: "abc",
    agentKey: "0xkey",
  };
  expect(config).toBeDefined();
});

// ---------------------------------------------------------------------------
// resolveDelegationConfig — defaults
// ---------------------------------------------------------------------------

test("resolveDelegationConfig fills plan-§5 defaults", () => {
  const c = resolveDelegationConfig({
    mode: "delegation",
    serializedDelegation: "abc",
    agentKey: "0xkey",
  });
  expect(c.mode).toBe("delegation");
  expect(c.serializedDelegation).toBe("abc");
  expect(c.agentKey).toBe("0xkey");
  expect(c.delegationFile).toBeUndefined();
  expect(c.agentKeyFile).toBeUndefined();
  expect(c.host).toBe(DEFAULT_HOST);
  expect(c.dbHandle).toBe(DEFAULT_DB_HANDLE);
  expect(c.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  expect(c.writeQueueLimit).toBe(DEFAULT_WRITE_QUEUE_LIMIT);
  expect(c.breakerThreshold).toBe(DEFAULT_BREAKER_THRESHOLD);
  expect(c.breakerOpenMs).toBe(DEFAULT_BREAKER_OPEN_MS);
  expect(c.reSignInMs).toBe(DEFAULT_RE_SIGN_IN_MS);
});

test("resolveDelegationConfig honors knob overrides", () => {
  const c = resolveDelegationConfig({
    mode: "delegation",
    serializedDelegation: "abc",
    agentKey: "0xkey",
    host: "https://other.example",
    dbHandle: "x/y",
    requestTimeoutMs: 1,
    writeQueueLimit: 2,
    breakerThreshold: 3,
    breakerOpenMs: 4,
    reSignInMs: 5,
  });
  expect(c.host).toBe("https://other.example");
  expect(c.dbHandle).toBe("x/y");
  expect(c.requestTimeoutMs).toBe(1);
  expect(c.writeQueueLimit).toBe(2);
  expect(c.breakerThreshold).toBe(3);
  expect(c.breakerOpenMs).toBe(4);
  expect(c.reSignInMs).toBe(5);
});

// ---------------------------------------------------------------------------
// resolveDelegationConfig — delegation source (serializedDelegation vs file)
// ---------------------------------------------------------------------------

test("resolveDelegationConfig accepts delegationFile as delegation source", () => {
  const c = resolveDelegationConfig({
    mode: "delegation",
    delegationFile: "/path/to/delegation.json",
    agentKey: "0xkey",
  });
  expect(c.delegationFile).toBe("/path/to/delegation.json");
  expect(c.serializedDelegation).toBeUndefined();
});

test("resolveDelegationConfig throws when no delegation source provided", () => {
  expect(() =>
    resolveDelegationConfig({
      mode: "delegation",
      agentKey: "0xkey",
    }),
  ).toThrow(/delegation source/);
});

test("resolveDelegationConfig throws when both delegation sources provided", () => {
  expect(() =>
    resolveDelegationConfig({
      mode: "delegation",
      serializedDelegation: "abc",
      delegationFile: "/path/to/delegation.json",
      agentKey: "0xkey",
    }),
  ).toThrow(/not both/);
});

// ---------------------------------------------------------------------------
// resolveDelegationConfig — agent key source (agentKey vs agentKeyFile)
// ---------------------------------------------------------------------------

test("resolveDelegationConfig accepts agentKeyFile as agent key source", () => {
  const c = resolveDelegationConfig({
    mode: "delegation",
    serializedDelegation: "abc",
    agentKeyFile: "/path/to/agent.key",
  });
  expect(c.agentKeyFile).toBe("/path/to/agent.key");
  expect(c.agentKey).toBeUndefined();
});

test("resolveDelegationConfig throws when no agent key source provided", () => {
  expect(() =>
    resolveDelegationConfig({
      mode: "delegation",
      serializedDelegation: "abc",
    }),
  ).toThrow(/agent key source/);
});

test("resolveDelegationConfig throws when both agent key sources provided", () => {
  expect(() =>
    resolveDelegationConfig({
      mode: "delegation",
      serializedDelegation: "abc",
      agentKey: "0xkey",
      agentKeyFile: "/path/to/agent.key",
    }),
  ).toThrow(/not both/);
});

// ---------------------------------------------------------------------------
// resolveDelegationConfig — security: errors must not leak secret material
// ---------------------------------------------------------------------------

test("resolveDelegationConfig conflict error does not include key material", () => {
  let errorMessage = "";
  try {
    resolveDelegationConfig({
      mode: "delegation",
      serializedDelegation: "my-secret-delegation-value",
      agentKey: "my-secret-agent-key-value",
      agentKeyFile: "/path/to/agent.key",
    });
  } catch (e) {
    errorMessage = (e as Error).message;
  }
  expect(errorMessage).not.toContain("my-secret-agent-key-value");
  expect(errorMessage).not.toContain("my-secret-delegation-value");
  expect(errorMessage.length).toBeGreaterThan(0);
});

test("resolveDelegationConfig delegation-source conflict error does not include delegation material", () => {
  let errorMessage = "";
  try {
    resolveDelegationConfig({
      mode: "delegation",
      serializedDelegation: "secret-delegation-value",
      delegationFile: "/path/to/delegation.json",
      agentKey: "0xvalidagentkey",
    });
  } catch (e) {
    errorMessage = (e as Error).message;
  }
  expect(errorMessage).not.toContain("secret-delegation-value");
  expect(errorMessage.length).toBeGreaterThan(0);
});

test("resolveConfig error does not include private key material", () => {
  let errorMessage = "";
  try {
    resolveConfig({ privateKey: "" });
  } catch (e) {
    errorMessage = (e as Error).message;
  }
  // Error is about missing key, not its value — value is empty so trivially safe,
  // but the pattern must hold for any future validation.
  expect(errorMessage).toMatch(/privateKey is required/);
});

// ---------------------------------------------------------------------------
// createAgentClient — delegation guard
// ---------------------------------------------------------------------------

test("createAgentClient returns a client for a valid delegation config (Phase 3: delegation mode is implemented)", () => {
  // Phase 3 removed the "not yet implemented" throw. A valid delegation config
  // (with both serializedDelegation and agentKey) now constructs the client.
  // signIn() is lazy — no network or key validation at construction time.
  const client = createAgentClient({
    mode: "delegation",
    serializedDelegation: "abc",
    // Deterministic hardhat test key — never a real production key.
    agentKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  });
  expect(typeof client.signIn).toBe("function");
  expect(typeof client.sql.query).toBe("function");
  expect(typeof client.stop).toBe("function");
});
