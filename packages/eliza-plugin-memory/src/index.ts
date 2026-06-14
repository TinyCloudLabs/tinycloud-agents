// @tinycloud/eliza-plugin-memory — elizaOS 2.0 plugin owning the "memoryStorage"
// service slot (8-method MemoryStorageProvider). This is the ONLY package that
// may import @elizaos/* (plan §3); it builds atop @tinycloud/agent-client.
//
// T6 lands the schema + the TinyCloudMemoryStorageService and its two
// separately-testable units (SWR cache + fan-out microbatcher). T7 adds the
// Plugin object (default + named export), the config surface (./config), and the
// activation/registration-order docs (README).
//
// ACTIVATION (see README): list "@tinycloud/eliza-plugin-memory" BEFORE
// "@elizaos/plugin-sql" in character.plugins (first-registered wins the
// "memoryStorage" slot, plan §2.2) AND set character.advancedMemory: true
// (plan §2.1). If our service fails to start, advanced-memory storage is DISABLED
// entirely — fail-open, NOT fail-over to plugin-sql (plan §2.2).

import { type Plugin } from "@elizaos/core";

import { TinyCloudMemoryStorageService } from "./storage";

export const ELIZA_PLUGIN_MEMORY_VERSION = "0.1.0";

/** Plugin name — must precede "@elizaos/plugin-sql" in character.plugins (§2.2). */
export const PLUGIN_NAME = "@tinycloud/eliza-plugin-memory";

/**
 * The elizaOS plugin: registers {@link TinyCloudMemoryStorageService} (serviceType
 * "memoryStorage"). Exported as both the default and a named `tinycloudMemoryPlugin`.
 */
export const tinycloudMemoryPlugin: Plugin = {
  name: PLUGIN_NAME,
  description:
    "Owns the elizaOS advanced-memory \"memoryStorage\" slot: stores long-term " +
    "memories and session summaries in a TinyCloud space (portable, " +
    "durable system of record). Requires character.advancedMemory: true and must " +
    "be listed before @elizaos/plugin-sql in character.plugins.",
  services: [TinyCloudMemoryStorageService],
};

export default tinycloudMemoryPlugin;

export {
  MEMORY_DB_HANDLE,
  MEMORY_SCHEMA,
  LONG_TERM_MEMORIES_DDL,
  SESSION_SUMMARIES_DDL,
} from "./schema";

export { SwrCache } from "./caches";
export type { Now, SwrEntry, SwrOptions } from "./caches";

export { Microbatcher } from "./microbatcher";
export type { SetTimer, RunBatch, MicrobatcherOptions } from "./microbatcher";

export { TinyCloudMemoryStorageService } from "./storage";
export type { MemoryStorageTuning, MemoryStorageDeps } from "./storage";

export {
  EntityClientRegistry,
  NoDelegationError,
  DelegationExpiredError,
} from "./entity-registry";
export type { EntityClientRegistryDeps } from "./entity-registry";

export { WriteLane, WriteLaneOverflowError, writeLane, runWrite } from "./write-lane";
export type { WriteLaneOptions } from "./write-lane";

export {
  SETTING_KEYS,
  DEFAULT_MEMORY_DB_HANDLE,
  settingString,
  resolveMemoryClientConfig,
} from "./config";
