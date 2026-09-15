import { describe, expect, it } from "bun:test";
import { taskConfigFromEnv } from "./contract.js";
import { TaskUsage } from "./runner.js";

describe("task service configuration and usage", () => {
  it("keeps tasks disabled without both local provider and model configuration", () => {
    expect(taskConfigFromEnv({})).toBeUndefined();
    expect(taskConfigFromEnv({ REDPILL_API_KEY: "fake" })).toBeUndefined();
    expect(taskConfigFromEnv({ ELIZA_TASK_MODELS_JSON: '{"model":10000}' })).toBeUndefined();
    expect(taskConfigFromEnv({ REDPILL_API_KEY: "fake", ELIZA_TASK_MODELS_JSON: '{"model":10000}' })).toMatchObject({ baseUrl: "https://api.redpill.ai/v1", models: { model: 10000 } });
  });

  it("fails configured startup for invalid model limits or an unsafe provider endpoint", () => {
    for (const models of ["invalid", "[]", "{}", '{"model":0}', '{"model":-1}', '{"model":1.5}', '{"model":"10000"}']) {
      expect(() => taskConfigFromEnv({ REDPILL_API_KEY: "fake", ELIZA_TASK_MODELS_JSON: models })).toThrow("invalid_task_configuration");
    }
    expect(() => taskConfigFromEnv({ REDPILL_API_KEY: "fake", ELIZA_TASK_MODELS_JSON: '{"model":10000}', REDPILL_BASE_URL: "http://external.example/v1" })).toThrow("invalid_task_configuration");
  });

  it("accumulates distinct attempts while overwriting reports and reverting completeness at attempt start", () => {
    const snapshots: unknown[] = [];
    const usage = new TaskUsage(value => snapshots.push(value));
    const first = usage.start();
    usage.report(first, { prompt_tokens: 10, completion_tokens: 5 });
    usage.report(first, { prompt_tokens: 10, completion_tokens: 8 });
    usage.finish(first);
    expect(usage.snapshot()).toMatchObject({ promptTokens: 10, completionTokens: 8, startedAttempts: 1, finalizedAttempts: 1, usageCompleteness: "complete" });
    const second = usage.start();
    expect(usage.snapshot()).toMatchObject({ promptTokens: 10, completionTokens: 8, startedAttempts: 2, finalizedAttempts: 1, usageCompleteness: "partial" });
    usage.report(second, { prompt_tokens: 20, completion_tokens: 10 });
    expect(() => usage.report(second, { prompt_tokens: 19, completion_tokens: 10 })).toThrow("upstream_incomplete");
    expect(usage.snapshot()).toMatchObject({ promptTokens: 30, completionTokens: 18, reportedAttempts: 2, finalizedAttempts: 1, usageCompleteness: "partial" });
  });
});
