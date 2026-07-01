import type { Manifest } from "@tinycloud/web-sdk";

// The canonical per-user space that holds all of an owner's agent memory.
export const AGENTS_SPACE = "agents";

// App manifest for the agents.tinycloud.xyz frontend, modeled on
// secret-manager's tinyCloudSecretsManifest. This grants the APP's own session
// access to the "agents" space (so the frontend can read/write agent memory and
// introspect capabilities). It is SEPARATE from the per-agent delegation, which
// is minted directly to each agent DID (Sam's hybrid: app manifest for the
// frontend's own access, direct delegation for the agent).
//
// `defaults: false` and `skipPrefix: true` keep the grant minimal and explicit.
export function tinyCloudAgentsManifest(): Manifest {
  return {
    manifest_version: 1,
    app_id: "xyz.tinycloud.agents",
    name: "TinyCloud Agents",
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
        actions: ["read", "write", "schema"],
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
