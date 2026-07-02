import type { Manifest } from "@tinycloud/web-sdk";
import { KV_ACTIONS, SQL_ACTIONS, CAPABILITIES_ACTIONS } from "./config";

// The canonical per-user space that holds all of an owner's agent memory.
export const AGENTS_SPACE = "agents";

// The owner's first (index-0) agent has a KNOWN, deterministic memory scope at
// sign-in — `"default/"` prefix, `"default/memory.db"` SQL handle (matches the
// service's AgentView for the default agent). These are baked into the manifest
// so the default agent's caps are first-class (see below); additional agents
// have dynamically-slugged prefixes not known statically.
export const DEFAULT_AGENT_PREFIX = "default/";
export const DEFAULT_AGENT_DB_HANDLE = "default/memory.db";

// App manifest for the agents.tinycloud.xyz frontend, modeled on
// secret-manager's tinyCloudSecretsManifest (explicit-permissions route; no
// sdk-core change). It DECLARES this app in the user's account
// (discoverability/auditability — TinyCloud's model, and the base the `agents:`
// shorthand of TC-66 builds on) AND makes the AGENT's caps first-class (Sam):
// the default agent's memory scope is declared as explicit permission entries —
// tinycloud.kv PREFIX on "default/" (full kv) + tinycloud.sql EXACT on
// "default/memory.db" + capabilities read, all in the "agents" space.
//
// Baking the default agent's caps into the recap makes its delegateTo mint a
// SUBSET of the session's manifest recap, so that mint can take the derivable
// session-key path (no wallet prompt). Additional, dynamically-named agents are
// not in this static manifest and keep the wallet-signed path (see delegate.ts).
//
// `defaults: false` + `skipPrefix: true` keep the grant explicit and minimal.
// (The `agents: true` manifest shorthand is a future sdk-core feature — not used.)
export function tinyCloudAgentsManifest(): Manifest {
  return {
    manifest_version: 1,
    app_id: "xyz.tinycloud.agents",
    name: "Agents",
    description: "Create agents and delegate access to your TinyCloud memory space.",
    space: AGENTS_SPACE,
    prefix: "",
    defaults: false,
    includePublicSpace: false,
    permissions: [
      {
        service: "tinycloud.kv",
        space: AGENTS_SPACE,
        path: DEFAULT_AGENT_PREFIX,
        actions: KV_ACTIONS,
        skipPrefix: true,
      },
      {
        service: "tinycloud.sql",
        space: AGENTS_SPACE,
        path: DEFAULT_AGENT_DB_HANDLE,
        actions: SQL_ACTIONS,
        skipPrefix: true,
      },
      {
        service: "tinycloud.capabilities",
        space: AGENTS_SPACE,
        path: "",
        actions: CAPABILITIES_ACTIONS,
        skipPrefix: true,
      },
    ],
  };
}
