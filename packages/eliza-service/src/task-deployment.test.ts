import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { taskConfigFromEnv } from "./tasks/contract.js";

const compose = readFileSync(new URL("../../../docker-compose.phala.yml", import.meta.url), "utf8");

// Resolve the service's compose environment with synthetic deploy values. This
// catches a setting that exists in the runtime but never reaches the container.
function containerEnv(deploy: Record<string, string>): Record<string, string> {
  const service = compose.split("  dstack-ingress:")[0];
  const result: Record<string, string> = {};
  for (const match of service.matchAll(/^      ([A-Z_]+): \$\{([A-Z_]+)(?::-([^}]*))?\}$/gm)) {
    result[match[1]] = deploy[match[2]] || match[3] || "";
  }
  return result;
}

test("Phala forwards the approved task provider and exact model map", () => {
  const models = { "moonshotai/kimi-k3": 1048576, "z-ai/glm-5.3": 1048576 };
  const config = taskConfigFromEnv(containerEnv({
    REDPILL_API_KEY: "synthetic-deployment-key",
    REDPILL_BASE_URL: "https://provider.example/v1",
    ELIZA_TASK_MODELS_JSON: JSON.stringify(models),
  }));
  expect(config).toEqual({ apiKey: "synthetic-deployment-key", baseUrl: "https://provider.example/v1", models });
});

test("Phala defaults keep tasks disabled until both key and model map arrive", () => {
  expect(taskConfigFromEnv(containerEnv({}))).toBeUndefined();
  expect(taskConfigFromEnv(containerEnv({ REDPILL_API_KEY: "synthetic-deployment-key" }))).toBeUndefined();
  const config = taskConfigFromEnv(containerEnv({
    REDPILL_API_KEY: "synthetic-deployment-key",
    ELIZA_TASK_MODELS_JSON: '{"z-ai/glm-5.3":1048576}',
  }));
  expect(config?.baseUrl).toBe("https://api.redpill.ai/v1");
});

test("production deployment does not forward local validation switches", () => {
  expect(compose).not.toMatch(/(?:ELIZA|TINYCHAT|VITE)_LOCAL_VALIDATION/);
  expect(compose).toContain('HOST: "0.0.0.0"');
  expect(compose).toContain('PORT: "3000"');
});
