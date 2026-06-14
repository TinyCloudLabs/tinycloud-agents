// Block 4 — CI SEAM CHECK (plan §8.2), runtime halves:
//   (a) the 8-method surface is present on our service (companion to the
//       compile-time `seam-assignability.ts` assertion);
//   (b) checksum the RESOLVED @elizaos/core dist seam .d.ts files against the
//       committed fixtures and fail LOUDLY on drift.
//
// Anchored on the published-beta seam verified identical to the pin (plan §2.6/§8.1).
// Deterministic, no network.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

import { TinyCloudMemoryStorageService } from "../storage";
import fixture from "./fixtures/seam-checksums.json";

// ── (a) the 8 MemoryStorageProvider methods exist on our service ──────────────

const SEAM_METHODS = [
  "storeLongTermMemory",
  "getLongTermMemories",
  "updateLongTermMemory",
  "deleteLongTermMemory",
  "storeSessionSummary",
  "getCurrentSessionSummary",
  "updateSessionSummary",
  "getSessionSummaries",
] as const;

test("the service implements all 8 MemoryStorageProvider methods", () => {
  const proto = TinyCloudMemoryStorageService.prototype as unknown as Record<string, unknown>;
  for (const name of SEAM_METHODS) {
    expect(typeof proto[name]).toBe("function");
  }
  expect(SEAM_METHODS).toHaveLength(8);
  expect(TinyCloudMemoryStorageService.serviceType).toBe("memoryStorage");
});

// ── (b) checksum the resolved seam .d.ts against the committed fixtures ────────

/** The on-disk root of the resolved @elizaos/core (find the ACTUAL path, plan §2.6). */
function resolveCoreRoot(): string {
  // import.meta.resolve → file URL of core's main entry (…/dist/node/index.node.js).
  const mainUrl = import.meta.resolve("@elizaos/core");
  return fileURLToPath(mainUrl).split("/dist/")[0];
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("resolved @elizaos/core seam files match the committed checksums", () => {
  const coreRoot = resolveCoreRoot();
  const seams = fixture.seams as Record<string, string>;
  const drifted: string[] = [];

  for (const [rel, expected] of Object.entries(seams)) {
    const actual = sha256(`${coreRoot}/${rel}`);
    if (actual !== expected) {
      drifted.push(`  ${rel}\n    expected ${expected}\n    actual   ${actual}`);
    }
  }

  if (drifted.length > 0) {
    throw new Error(
      `@elizaos/core seam drifted — re-verify against the plan (§2.6/§8.2) before ` +
        `re-pinning. Pinned ${fixture.pinnedVersion} (verified ${fixture.verifiedOn}). ` +
        `Resolved at ${coreRoot}.\n${drifted.join("\n")}`,
    );
  }

  // Sanity: we actually checked the two documented seam files.
  expect(Object.keys(seams).sort()).toEqual([
    "dist/features/advanced-memory/types.d.ts",
    "dist/types/memory-storage.d.ts",
  ]);
});
