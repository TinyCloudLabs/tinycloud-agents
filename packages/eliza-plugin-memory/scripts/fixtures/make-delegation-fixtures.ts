// Pure fixture mutator for Phase 7 delegation baseline and negative-fixture variants.
//
// Lives under scripts/fixtures/ — NOT in package src/. The regression guard
// (phase7-negative-fixtures-present) asserts this file exists here.
//
// HARD CONTRACT: NO network. NO useDelegation call. NO secret material.
// Each exported function returns a *serialized* delegation string built by
// mutating EXACTLY ONE field of the baseline.
//
// Use node-sdk serializeDelegation/deserializeDelegation so shapes stay real
// and round-trip through the SDK's own codec (no manual JSON construction).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deserializeDelegation, serializeDelegation } from "@tinycloud/agent-client";
import type { PortableDelegation } from "@tinycloud/agent-client";

const SAMPLE_PATH = join(import.meta.dir, "delegation.sample.json");

/**
 * Load the committed scrubbed baseline from delegation.sample.json and
 * deserialize it into a PortableDelegation. The expiry is far-future (2099)
 * so it is never stale at test time.
 */
function loadBaseline(): PortableDelegation {
  const raw = readFileSync(SAMPLE_PATH, "utf-8");
  return deserializeDelegation(raw);
}

/**
 * Serialize the baseline as-is. Round-trips through deserialize → serialize
 * to confirm the sample JSON survives the SDK codec.
 */
export function baseline(): string {
  return serializeDelegation(loadBaseline());
}

/**
 * Mutate ONLY delegateDID — replace it with otherDid.
 * All other fields are identical to the baseline.
 * Intended use: prove wrong-delegatee rejection.
 */
export function withWrongDelegatee(otherDid: string): string {
  const d = loadBaseline();
  return serializeDelegation({ ...d, delegateDID: otherDid });
}

/**
 * Mutate ONLY expiry — replace it with pastDate.
 * All other fields are identical to the baseline.
 * Intended use: prove expired-grant rejection.
 */
export function withExpired(pastDate: Date): string {
  const d = loadBaseline();
  return serializeDelegation({ ...d, expiry: pastDate });
}

/**
 * Mutate ONLY actions — strip tinycloud.sql/write and tinycloud.sql/admin,
 * leaving only tinycloud.sql/read.
 * All other fields (including path / spaceId / delegateDID / expiry) are
 * identical to the baseline. The flat-shape baseline has no resources[] array,
 * so this single field change is the only mutation.
 * Intended use: prove insufficient-policy rejection (missing write+admin).
 */
export function withInsufficientPolicy(): string {
  const d = loadBaseline();
  const actions = d.actions.filter(
    (a) => !a.endsWith("/write") && !a.endsWith("/admin"),
  );
  return serializeDelegation({ ...d, actions });
}
