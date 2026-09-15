import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeDelegation } from "@tinycloud/agent-client";
import { MEMORY_DB_HANDLE } from "@tinycloud/eliza-plugin-memory";
import { createLocalValidationHost, localValidationFromEnv } from "./local-validation-host.js";
import { TINYCHAT_AGENT_ID } from "./auth/app-registry.js";

describe("local validation host", () => {
  test("requires explicit development and loopback bind", () => {
    expect(localValidationFromEnv({})).toBe(false);
    expect(localValidationFromEnv({ ELIZA_LOCAL_VALIDATION: "true", NODE_ENV: "development", HOST: "127.0.0.1" })).toBe(true);
    for (const env of [{ NODE_ENV: "production", HOST: "127.0.0.1" }, { NODE_ENV: "development", HOST: "0.0.0.0" }]) {
      expect(() => localValidationFromEnv({ ELIZA_LOCAL_VALIDATION: "true", ...env })).toThrow();
    }
  });

  test("activates the normal memory grant without schema access, and exposes direct read actions only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eliza-local-host-"));
    const keyFile = join(dir, "agent.key");
    writeFileSync(keyFile, `0x${"03".repeat(32)}`, { mode: 0o600 });
    let activated = 0;
    try {
      const host = await createLocalValidationHost({ agentKeyFile: keyFile, host: "https://node.example",
        activateMemory: async () => { activated++; return { spaceId: "local-test", sql: { db() { throw new Error("Memory SQL access is forbidden"); } } }; },
      });
      const owner = "0x1111111111111111111111111111111111111111";
      const space = `tinycloud:pkh:eip155:1:${owner}:default`;
      const payload = Buffer.from(JSON.stringify({ aud: host.agentDid, exp: Math.floor((Date.now() + 60_000) / 1000), att: {
        [`${space}/sql/${MEMORY_DB_HANDLE}`]: { "tinycloud.sql/read": [{}], "tinycloud.sql/write": [{}], "tinycloud.sql/admin": [{}] },
      } })).toString("base64url");
      const grant = serializeDelegation({
        cid: "test-memory", delegateDID: host.agentDid, spaceId: space, path: MEMORY_DB_HANDLE,
        actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
        expiry: new Date(Date.now() + 60_000), ownerAddress: owner, chainId: 1,
        delegationHeader: { Authorization: `Bearer eyJhbGciOiJFZERTQSJ9.${payload}.test-signature` },
      });
      const storage = await host.storageFor(TINYCHAT_AGENT_ID);
      await storage.registerDelegation("entity-local", grant, "room-local");
      expect(activated).toBe(1);
      const runtime = await host.runtimeFor(TINYCHAT_AGENT_ID);
      expect(runtime.actions).toHaveLength(5);
      expect(runtime.actions.map((action: { name: string }) => action.name.toLowerCase())).not.toContain("run_artifact_skill");
      expect(runtime.messageService).toBeUndefined();
      await expect(host.preflight(TINYCHAT_AGENT_ID, "entity-local")).rejects.toThrow();
      await expect(host.runtimeFor("foreign-agent")).rejects.toThrow();
      const invalid = JSON.parse(grant); invalid.delegateDID = "did:key:wrong";
      await expect(storage.registerDelegation("entity-local", JSON.stringify(invalid))).rejects.toThrow();
      expect(activated).toBe(1);
      await host.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
