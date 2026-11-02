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

  it("accepts configured timeouts that leave room for the 30-second keepalive", () => {
    expect(serverIdleTimeoutFromEnv("60")).toBe(60);
    expect(serverIdleTimeoutFromEnv("255")).toBe(255);
  });

  it("rejects invalid values and values that could expire before the keepalive", () => {
    for (const value of ["", "0", "1", "29", "30", "59", "256", "1.5", "NaN"]) {
      expect(() => serverIdleTimeoutFromEnv(value)).toThrow(
        "invalid ELIZA_SERVICE_IDLE_TIMEOUT",
      );
    }
  });
});
