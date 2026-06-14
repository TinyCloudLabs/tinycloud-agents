import { expect, test } from "bun:test";
import { ELIZA_PLUGIN_MEMORY_VERSION } from "./index.ts";

test("eliza-plugin-memory exposes a version", () => {
  expect(ELIZA_PLUGIN_MEMORY_VERSION).toBe("0.1.0");
});
