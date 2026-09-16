import { expect, test } from "bun:test";
import { SwrCache } from "./caches";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("invalidating a cold load prevents publication and reseeding", async () => {
  const cache = new SwrCache<string>({ ttlMs: 100 });
  const old = deferred<string>();
  const read = cache.read("entity:room", () => old.promise, 1000, "empty");
  cache.invalidatePrefix("entity:");
  old.resolve("private");
  expect(await read).toBe("empty");
  expect(cache.peek("entity:room")).toBeUndefined();
});

test("old background refresh cannot clear or overwrite a newer pending load", async () => {
  const cache = new SwrCache<string>({ ttlMs: 0 });
  cache.set("key", "stale");
  const old = deferred<string>();
  expect(await cache.read("key", () => old.promise, 1000, "empty")).toBe("stale");
  cache.invalidate("key");
  const fresh = deferred<string>();
  let loads = 0;
  const read = cache.read("key", () => { loads++; return fresh.promise; }, 1000, "empty");
  old.resolve("old-private");
  await Promise.resolve(); await Promise.resolve();
  const duplicate = cache.read("key", () => { loads++; return fresh.promise; }, 1000, "empty");
  fresh.resolve("fresh");
  expect(await read).toBe("fresh");
  expect(await duplicate).toBe("fresh");
  expect(loads).toBe(1);
  expect(cache.peek("key")?.value).toBe("fresh");
});
