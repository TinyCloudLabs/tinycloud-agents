import type { IAgentRuntime } from "@elizaos/core";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { agentIdentityFromFile, DelegatedTransport, resolveDelegationConfig, type DelegatedActivateFn } from "@tinycloud/agent-client";
import { MEMORY_DB_HANDLE, NoDelegationError } from "@tinycloud/eliza-plugin-memory";
import { TINYCHAT_AGENT_ID } from "./auth/app-registry.js";
import { webSearchPlugin } from "./actions/web-search.js";
import { setTranscriptRegistry, tinycloudSearchTranscriptsPlugin } from "./actions/tinycloud-search-transcripts.js";
import { TranscriptAccessRegistry } from "./transcript-registry.js";
import { createTranscriptNode } from "./transcript-transport.js";
import type { ElizaServiceHost } from "./server.js";
import { disableLocalAccountWrites } from "./local-validation-node.js";

export function localValidationFromEnv(env: Record<string, string | undefined>): boolean {
  if (env.ELIZA_LOCAL_VALIDATION !== "true") return false;
  if (env.NODE_ENV !== "development" || !["127.0.0.1", "localhost", "::1"].includes(env.HOST ?? "")) {
    throw new Error("Eliza local validation requires development mode and a loopback HOST");
  }
  return true;
}

/**
 * Local real-data validation: retain delegation validation/activation and the
 * existing direct tool handlers, without native memory schema or evaluators.
 * The caller's frontend supplies account context and keeps test outputs local.
 */
export async function createLocalValidationHost(config: {
  agentKeyFile: string;
  host: string;
  /** Controlled external activation boundary in local tests. */
  activateMemory?: DelegatedActivateFn;
}): Promise<ElizaServiceHost & { stop(): Promise<void> }> {
  const identity = await agentIdentityFromFile(config.agentKeyFile);
  const registry = new TranscriptAccessRegistry({
    agentDid: identity.did, agentKey: identity.normalizedKey, host: config.host,
    nodeFactory: args => createTranscriptNode({ ...args, localValidation: true }),
  });
  // handlePostTool consumes only actions; these are the real service actions.
  // Deliberately do not construct the native message/evaluator/memory pipeline.
  const runtime = { actions: [...(webSearchPlugin.actions ?? []), ...(tinycloudSearchTranscriptsPlugin.actions ?? [])] } as unknown as IAgentRuntime;
  setTranscriptRegistry(runtime, registry);
  const assertAgent = (agentId: string) => {
    if (agentId !== TINYCHAT_AGENT_ID) throw new Error("Local validation only supports TinyChat");
  };
  return {
    agentDid: identity.did,
    async runtimeFor(agentId) { assertAgent(agentId); return runtime; },
    async preflight(_agentId, entityId) { throw new NoDelegationError(entityId); },
    async storageFor(agentId) {
      assertAgent(agentId);
      return {
        async registerDelegation(_entityId, serializedDelegation) {
          // Reuse the normal signed-grant validation + SDK activation; never
          // call ensureSchema, query, execute or batch on the memory handle.
          const transport = new DelegatedTransport(resolveDelegationConfig({
            mode: "delegation", serializedDelegation, agentKey: identity.normalizedKey,
            host: config.host, dbHandle: MEMORY_DB_HANDLE,
          }), {
            activate: config.activateMemory ?? (async (resolved, delegation, agent) => {
              const node = new TinyCloudNode({ privateKey: agent.normalizedKey, host: resolved.host, autoCreateSpace: false });
              disableLocalAccountWrites(node);
              await node.signIn();
              return node.useDelegation(delegation);
            }),
          });
          await transport.signIn();
        },
      };
    },
    async registerTranscriptDelegation(agentId, entityId, serialized, roomId) {
      assertAgent(agentId);
      await registry.register(entityId, serialized, roomId);
    },
    async stop() { setTranscriptRegistry(runtime, null); await registry.stop(); },
  };
}
