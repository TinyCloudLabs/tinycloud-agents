import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(import.meta.dir, "../src");

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

function readSources(): Array<{ rel: string; source: string }> {
  return listSourceFiles(SRC_DIR).map((file) => ({
    rel: relative(SRC_DIR, file),
    source: readFileSync(file, "utf8"),
  }));
}

describe("Milestone C structural guards", () => {
  it("does not construct an AgentClient inside eliza-service", () => {
    const allSource = readSources().map((file) => file.source).join("\n");

    expect(allSource).not.toMatch(/\bcreateAgentClient\s*\(/);
  });

  it("does not call TinyCloud memory write methods directly", () => {
    const allSource = readSources().map((file) => file.source).join("\n");

    expect(allSource).not.toMatch(/\.(storeLongTermMemory|storeSessionSummary|ensureSchema)\s*\(/);
  });

  it("keeps session liveness local instead of importing B's entity registry", () => {
    const sessionSources = readSources().filter((file) =>
      file.rel === "session-store.ts" || file.rel === "handlers/sessions.ts"
    );

    expect(sessionSources.length).toBe(2);
    for (const file of sessionSources) {
      expect(file.source).not.toMatch(/from\s+["'][^"']*entity-registry/);
      expect(file.source).not.toMatch(/import\s*\([^)]*entity-registry/);
    }
  });
});
