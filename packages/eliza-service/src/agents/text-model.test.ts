// text-model config resolution tests (M2).

import { describe, expect, it } from "bun:test";
import { resolveTextModelConfig } from "./text-model.js";

describe("resolveTextModelConfig", () => {
  it("returns null when neither var is set", () => {
    expect(resolveTextModelConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("resolves config, trims, strips trailing slash, defaults model name", () => {
    const cfg = resolveTextModelConfig({
      MODEL_API_URL: "  https://api.openai.com/v1/  ",
      MODEL_API_KEY: "  sk-test  ",
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({
      apiUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      modelName: "gpt-4o-mini",
    });
  });

  it("honors MODEL_NAME override", () => {
    const cfg = resolveTextModelConfig({
      MODEL_API_URL: "https://x/v1",
      MODEL_API_KEY: "k",
      MODEL_NAME: "llama-3",
    } as NodeJS.ProcessEnv);
    expect(cfg?.modelName).toBe("llama-3");
  });

  it("throws on partial config (URL without KEY)", () => {
    expect(() =>
      resolveTextModelConfig({ MODEL_API_URL: "https://x/v1" } as NodeJS.ProcessEnv),
    ).toThrow(/set BOTH/);
  });

  it("throws on partial config (KEY without URL)", () => {
    expect(() =>
      resolveTextModelConfig({ MODEL_API_KEY: "k" } as NodeJS.ProcessEnv),
    ).toThrow(/set BOTH/);
  });
});
