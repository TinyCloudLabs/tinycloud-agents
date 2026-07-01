import type { Manifest } from "@tinycloud/web-sdk";

// The canonical per-user space that holds all of an owner's agent memory.
export const AGENTS_SPACE = "agents";

// App manifest for the agents.tinycloud.xyz frontend, modeled on
// secret-manager's tinyCloudSecretsManifest (explicit-permissions route; no
// sdk-core change). It grants only what the APP ITSELF does in the "agents"
// space — the app is NOT the agent, so the grant is minimal and read-only for
// SQL (the app doesn't write agent memory; agents do that through their own
// direct per-agent delegation). Sam's hybrid: app manifest for the frontend's
// own read access, separate direct delegation for each agent.
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
        service: "tinycloud.sql",
        space: AGENTS_SPACE,
        path: "default",
        actions: ["read"],
        skipPrefix: true,
      },
      {
        service: "tinycloud.capabilities",
        space: AGENTS_SPACE,
        path: "",
        actions: ["read"],
        skipPrefix: true,
      },
    ],
  };
}
