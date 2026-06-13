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
} from "./index.ts";

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
