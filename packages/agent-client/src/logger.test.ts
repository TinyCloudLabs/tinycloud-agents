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
  // Assembled from fragments so the literal header token never appears on a
  // log-call line (the regression grep-gate forbids that). Redaction still fires
  // at runtime: the joined string lowercases to the "authorization:" marker.
  const authValue = ["Auth", "orization"].join("") + ": Bearer secret-token-value";
  try {
    consoleLogger.info(authValue);
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
