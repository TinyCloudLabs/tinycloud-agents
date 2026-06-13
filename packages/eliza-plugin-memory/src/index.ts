// @tinycloud/eliza-plugin-memory — elizaOS 2.0 plugin owning the "memoryStorage"
// service slot (8-method MemoryStorageProvider). This is the ONLY package that
// may import @elizaos/* (plan §3); it builds atop @tinycloud/agent-client.
//
// T6 lands the schema + the TinyCloudMemoryStorageService and its two
// separately-testable units (SWR cache + fan-out microbatcher). The Plugin object
// + config docs (the package `elizaos.plugin` block, registration-order notes)
// land in T7.

export const ELIZA_PLUGIN_MEMORY_VERSION = "0.1.0";

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
