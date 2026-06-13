// @tinycloud/eliza-plugin-memory — elizaOS 2.0 plugin owning the "memoryStorage"
// service slot (8-method MemoryStorageProvider). This is the ONLY package that
// may import @elizaos/* (plan §3); it builds atop @tinycloud/agent-client.
//
// Placeholder export — real plugin wiring lands in T3/T4.
export const ELIZA_PLUGIN_MEMORY_VERSION = "0.1.0";
