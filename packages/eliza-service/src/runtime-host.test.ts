// T3 RuntimeHost tests — lazy boot, caching, agentDid, graceful stop()
//
// All tests use a _bootFactory so no live TinyCloud node is required.
// The FakeStorageService duck-types TinyCloudMemoryStorageService's stop() contract.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { agentIdentityFromKey } from "@tinycloud/agent-client";
import type { TinyCloudMemoryStorageService } from "@tinycloud/eliza-plugin-memory";
import { RuntimeHost, type BootedRuntime, type BootFactory } from "./runtime-host.js";

// Deterministic hardhat test key — same key used in agent-client tests; never a real key.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const AGENT_ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const AGENT_ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;

// ── Minimal fakes ─────────────────────────────────────────────────────────────

class FakeStorageService {
  stopCount = 0;
  async stop() {
    this.stopCount++;
  }
}

function makeFakeRuntime(agentId: UUID): IAgentRuntime {
  return {
    agentId,
    stop: async () => {},
  } as unknown as IAgentRuntime;
}

function makeFactory(
  getStorage: (agentId: UUID) => FakeStorageService,
): { factory: BootFactory; bootCount: number } {
  const state = { bootCount: 0 };
  const factory: BootFactory = async (agentId) => {
    state.bootCount++;
    return {
      agentId,
      runtime: makeFakeRuntime(agentId),
      storageService: getStorage(agentId) as unknown as TinyCloudMemoryStorageService,
    };
  };
  // Return a proxy object so callers can read bootCount after calls
  return new Proxy(state, {
    get(t, p) {
      if (p === "factory") return factory;
      return Reflect.get(t, p);
    },
  }) as { factory: BootFactory; bootCount: number };
}

// ── Lazy boot and caching ─────────────────────────────────────────────────────

describe("RuntimeHost T3 — lazy boot and caching", () => {
  it("runtimeFor boots lazily on first call (not at construction)", async () => {
    const storage = new FakeStorageService();
    const state = makeFactory(() => storage);
    const host = new RuntimeHost({ _bootFactory: state.factory });

    expect(state.bootCount).toBe(0); // not booted yet

    const runtime = await host.runtimeFor(AGENT_ID_A);
    expect(runtime).not.toBeNull();
    expect(state.bootCount).toBe(1);
  });

  it("runtimeFor returns the same instance on second call (boots exactly once)", async () => {
    const storage = new FakeStorageService();
    const state = makeFactory(() => storage);
    const host = new RuntimeHost({ _bootFactory: state.factory });

    const r1 = await host.runtimeFor(AGENT_ID_A);
    const r2 = await host.runtimeFor(AGENT_ID_A);

    expect(r1).toBe(r2); // same reference
    expect(state.bootCount).toBe(1);
  });

  it("storageFor returns the same instance on second call (boots exactly once)", async () => {
    const storage = new FakeStorageService();
    const state = makeFactory(() => storage);
    const host = new RuntimeHost({ _bootFactory: state.factory });

    const s1 = await host.storageFor(AGENT_ID_A);
    const s2 = await host.storageFor(AGENT_ID_A);

    expect(s1).toBe(s2); // same reference
    expect(state.bootCount).toBe(1);
  });

  it("runtimeFor and storageFor share a single boot (first-use trigger from either)", async () => {
    const storage = new FakeStorageService();
    const state = makeFactory(() => storage);
    const host = new RuntimeHost({ _bootFactory: state.factory });

    const runtime = await host.runtimeFor(AGENT_ID_A);
    const st = await host.storageFor(AGENT_ID_A);

    expect(runtime).not.toBeNull();
    expect(st).not.toBeNull();
    expect(state.bootCount).toBe(1); // only one boot, not two
  });
});

// ── Multi-agentId isolation ───────────────────────────────────────────────────

describe("RuntimeHost T3 — multi-agentId isolation", () => {
  it("two distinct agentIds get distinct runtime instances", async () => {
    const sharedStorage = new FakeStorageService();
    const state = makeFactory(() => sharedStorage);
    const host = new RuntimeHost({ _bootFactory: state.factory });

    const rA = await host.runtimeFor(AGENT_ID_A);
    const rB = await host.runtimeFor(AGENT_ID_B);

    expect(rA).not.toBe(rB); // distinct runtime instances
    expect((rA as any).agentId).toBe(AGENT_ID_A);
    expect((rB as any).agentId).toBe(AGENT_ID_B);
    expect(state.bootCount).toBe(2);
  });

  it("two distinct agentIds share the same storage service instance", async () => {
    const sharedStorage = new FakeStorageService();
    // Factory always returns the same storage object — simulates one shared service
    const state = makeFactory(() => sharedStorage);
    const host = new RuntimeHost({ _bootFactory: state.factory });

    const sA = await host.storageFor(AGENT_ID_A);
    const sB = await host.storageFor(AGENT_ID_B);

    expect(sA).toBe(sB); // same reference — shared storage service
  });
});

// ── agentDid ──────────────────────────────────────────────────────────────────

describe("RuntimeHost T3 — agentDid", () => {
  it("agentDid is derived from the key file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-host-test-"));
    const keyFile = join(dir, "agent.key");
    writeFileSync(keyFile, TEST_KEY + "\n");

    const storage = new FakeStorageService();
    const state = makeFactory(() => storage);
    const host = new RuntimeHost({ agentKeyFile: keyFile, _bootFactory: state.factory });

    await host.init();

    const expected = (await agentIdentityFromKey(TEST_KEY)).did;
    expect(host.agentDid).toBe(expected);
    expect(host.agentDid).toMatch(/^did:pkh:eip155:1:0x[0-9a-fA-F]{40}$/);
  });

  it("init() is idempotent — calling it twice gives the same agentDid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-host-test-"));
    const keyFile = join(dir, "agent.key");
    writeFileSync(keyFile, TEST_KEY + "\n");

    const host = new RuntimeHost({
      agentKeyFile: keyFile,
      _bootFactory: async (agentId) => ({
        agentId,
        runtime: makeFakeRuntime(agentId),
        storageService: null,
      }),
    });

    await host.init();
    const did1 = host.agentDid;
    await host.init();
    const did2 = host.agentDid;

    expect(did1).toBe(did2);
  });

  it("agentDid falls back to TINYCLOUD_AGENT_KEY_FILE env var when agentKeyFile not in config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-host-test-"));
    const keyFile = join(dir, "agent.key");
    writeFileSync(keyFile, TEST_KEY + "\n");

    const saved = process.env.TINYCLOUD_AGENT_KEY_FILE;
    process.env.TINYCLOUD_AGENT_KEY_FILE = keyFile;
    try {
      const host = new RuntimeHost({
        _bootFactory: async (agentId) => ({
          agentId,
          runtime: makeFakeRuntime(agentId),
          storageService: null,
        }),
      });
      await host.init();
      expect(host.agentDid).toMatch(/^did:pkh:eip155:1:0x[0-9a-fA-F]{40}$/);
    } finally {
      if (saved === undefined) delete process.env.TINYCLOUD_AGENT_KEY_FILE;
      else process.env.TINYCLOUD_AGENT_KEY_FILE = saved;
    }
  });

  it("init() throws when no key file is configured and env var is absent", async () => {
    const saved = process.env.TINYCLOUD_AGENT_KEY_FILE;
    delete process.env.TINYCLOUD_AGENT_KEY_FILE;
    try {
      const host = new RuntimeHost({ _bootFactory: async (agentId) => ({
        agentId,
        runtime: makeFakeRuntime(agentId),
        storageService: null,
      })});
      await expect(host.init()).rejects.toThrow(/key file not configured/);
    } finally {
      if (saved !== undefined) process.env.TINYCLOUD_AGENT_KEY_FILE = saved;
    }
  });
});

// ── Graceful stop() ───────────────────────────────────────────────────────────

describe("RuntimeHost T3 — stop()", () => {
  it("stop() calls storageService.stop() exactly once when one runtime is booted", async () => {
    const storage = new FakeStorageService();
    const state = makeFactory(() => storage);
    const host = new RuntimeHost({ _bootFactory: state.factory });

    await host.runtimeFor(AGENT_ID_A);
    await host.stop();

    expect(storage.stopCount).toBe(1);
  });

  it("stop() calls storageService.stop() once per booted runtime (two runtimes)", async () => {
    const sharedStorage = new FakeStorageService();
    const state = makeFactory(() => sharedStorage);
    const host = new RuntimeHost({ _bootFactory: state.factory });

    await host.runtimeFor(AGENT_ID_A);
    await host.runtimeFor(AGENT_ID_B);
    await host.stop();

    // One call per booted runtime — two runtimes, two stop() calls (even on shared service)
    expect(sharedStorage.stopCount).toBe(2);
  });

  it("stop() does not call storageService.stop() when no runtimes are booted", async () => {
    const storage = new FakeStorageService();
    const host = new RuntimeHost({
      _bootFactory: async (agentId) => ({
        agentId,
        runtime: makeFakeRuntime(agentId),
        storageService: storage as unknown as TinyCloudMemoryStorageService,
      }),
    });

    await host.stop(); // nothing booted

    expect(storage.stopCount).toBe(0);
  });

  it("stop() skips storageService.stop() for runtimes with null storage (stub mode)", async () => {
    const host = new RuntimeHost({
      _bootFactory: async (agentId) => ({
        agentId,
        runtime: makeFakeRuntime(agentId),
        storageService: null, // stub: no storage
      }),
    });

    await host.runtimeFor(AGENT_ID_A);
    // Should not throw even with null storageService
    await expect(host.stop()).resolves.toBeUndefined();
  });
});

describe("RuntimeHost — delegation preflight", () => {
  it("preflight checks the storage registry client for the entity", async () => {
    const seen: string[] = [];
    const storage = {
      requireRegistry() {
        return {
          clientFor(entityId: string) {
            seen.push(entityId);
            return {};
          },
        };
      },
      async stop() {},
    };
    const host = new RuntimeHost({
      _bootFactory: async (agentId) => ({
        agentId,
        runtime: makeFakeRuntime(agentId),
        storageService: storage as unknown as TinyCloudMemoryStorageService,
      }),
    });

    await host.preflight(AGENT_ID_A, "entity-a");

    expect(seen).toEqual(["entity-a"]);
  });
});
