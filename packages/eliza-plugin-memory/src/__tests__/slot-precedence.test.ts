// Block 2 — SLOT-PRECEDENCE (plan §2.2). Adapted from the WORKING spike
// `eliza-bun-spike/slot-probe.ts`: a real AgentRuntime (settings
// ALLOW_NO_DATABASE:"true" + InMemoryDatabaseAdapter), two services claiming
// serviceType "memoryStorage". We register OUR service FIRST and a stub SECOND,
// then assert getService("memoryStorage") resolves OURS (first-registered wins)
// while getServicesByType returns BOTH.
//
// OUR service is registered via a thin subclass whose static start() injects a
// fake (offline) agent-client — the resolved instance is a genuine
// `TinyCloudMemoryStorageService` (asserted by instanceof); only the network
// bring-up is stubbed so the test stays deterministic and node-free.

import { expect, test } from "bun:test";
import { AgentRuntime, InMemoryDatabaseAdapter, Service } from "@elizaos/core";

import { TinyCloudMemoryStorageService } from "../storage";
import { makeFakeClient } from "./fake-client.test";

const TYPE = "memoryStorage";

/** OUR service, started offline with an injected in-memory client. */
class TestTinyCloudService extends TinyCloudMemoryStorageService {
  static override serviceType = TYPE as never;
  static override async start(runtime: never): Promise<Service> {
    const client = makeFakeClient();
    const svc = new TinyCloudMemoryStorageService(runtime, { client });
    // Mirror the real start() session/schema bring-up against the fake client.
    await client.signIn();
    await client.ensureSchema([]);
    return svc as never;
  }
}

/** A second service claiming the same slot — duck-typed (store* fns present). */
class StubMemoryService extends (Service as never as typeof Service) {
  static override serviceType = TYPE as never;
  tag = "STUB";
  capabilityDescription = "stub memoryStorage";
  async storeLongTermMemory(m: unknown) {
    return m;
  }
  async storeSessionSummary(s: unknown) {
    return s;
  }
  async stop() {}
  static override async start(runtime: never): Promise<Service> {
    return new (this as never as new (r: never) => Service)(runtime);
  }
}

test("first-registered service wins the memoryStorage slot; both are registered", async () => {
  const runtime = new AgentRuntime({
    adapter: new InMemoryDatabaseAdapter(),
    settings: { ALLOW_NO_DATABASE: "true" },
    logLevel: "error",
  } as never);

  if (typeof (runtime as { initialize?: () => Promise<void> }).initialize === "function") {
    await (runtime as { initialize: () => Promise<void> }).initialize();
  }

  // OURS first, stub second.
  await runtime.registerService(TestTinyCloudService as never);
  await runtime.registerService(StubMemoryService as never);

  let resolved = runtime.getService(TYPE) as unknown;
  if (!resolved && typeof (runtime as { getServiceLoadPromise?: (t: string) => Promise<unknown> }).getServiceLoadPromise === "function") {
    resolved = await (runtime as { getServiceLoadPromise: (t: string) => Promise<unknown> }).getServiceLoadPromise(TYPE);
  }

  // First-registered wins → the resolved instance is OURS.
  expect(resolved).toBeInstanceOf(TinyCloudMemoryStorageService);

  // But both classes are registered under the slot.
  const all = (runtime.getServicesByType(TYPE) ?? []) as unknown[];
  expect(all).toHaveLength(2);
  const names = all.map((s) => (s as { constructor: { name: string } }).constructor.name);
  expect(names).toContain("TinyCloudMemoryStorageService");
  expect(names).toContain("StubMemoryService");
});
