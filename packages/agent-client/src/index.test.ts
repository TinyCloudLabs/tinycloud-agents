import { expect, test } from "bun:test";
import { AGENT_CLIENT_VERSION } from "./index.ts";

test("agent-client exposes a version", () => {
  expect(AGENT_CLIENT_VERSION).toBe("0.1.0");
});
