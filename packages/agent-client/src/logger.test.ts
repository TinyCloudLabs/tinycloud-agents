import { expect, test } from "bun:test";
import { consoleLogger, silentLogger } from "./index.ts";
import type { Logger } from "./index.ts";

test("silentLogger satisfies the Logger seam and never throws", () => {
  const log: Logger = silentLogger;
  expect(() => {
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
  }).not.toThrow();
});

test("consoleLogger redacts auth-looking strings (invariant 2 backstop)", () => {
  const captured: unknown[][] = [];
  const orig = console.info;
  console.info = (...args: unknown[]) => {
    captured.push(args);
  };
  try {
    consoleLogger.info("Authorization: Bearer secret-token-value");
    consoleLogger.info("plain message", "ucan eyJ-secret");
  } finally {
    console.info = orig;
  }
  const flat = JSON.stringify(captured).toLowerCase();
  expect(flat).not.toContain("secret-token-value");
  expect(flat).not.toContain("eyj-secret");
  expect(flat).toContain("[redacted]");
  expect(flat).toContain("plain message");
});
