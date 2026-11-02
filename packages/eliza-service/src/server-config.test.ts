import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS,
  serverIdleTimeoutFromEnv,
} from "./server-config.js";

describe("serverIdleTimeoutFromEnv", () => {
  it("uses Bun's maximum idle timeout when unset", () => {
    expect(serverIdleTimeoutFromEnv(undefined)).toBe(255);
    expect(DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS).toBe(255);
  });

  it("accepts a configured timeout in seconds", () => {
    expect(serverIdleTimeoutFromEnv("40")).toBe(40);
    expect(serverIdleTimeoutFromEnv("255")).toBe(255);
  });

  it("rejects invalid values and values outside Bun's supported range", () => {
    for (const value of ["", "0", "256", "1.5", "NaN"]) {
      expect(() => serverIdleTimeoutFromEnv(value)).toThrow(
        "invalid ELIZA_SERVICE_IDLE_TIMEOUT",
      );
    }
  });
});
