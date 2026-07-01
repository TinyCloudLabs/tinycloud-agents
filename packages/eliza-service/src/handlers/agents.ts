// /api/agents handlers (plan §2, M2).
//
// The user-facing surface: an OpenKey-authenticated owner creates, lists, toggles,
// delegates to, and talks to their own agents. Every handler here receives the
// already-authenticated owner address (from UserAuth) — ownership is enforced by
// re-deriving/matching against that address, never trusting a caller-supplied one.
//
// Delegation reuses handlePostSessions with agentDidFor(agentId); the entityId is
// computed server-side from (ownerAddress, agentId) so a caller cannot register a
// delegation under someone else's identity.

import { addressToEntityId } from "../entity-id.js";
import { dbHandleForRecord, type AgentStore, type AgentRecord } from "../agents/agent-store.js";
import type { SessionStore } from "../session-store.js";
import {
  handlePostSessions,
  type SessionHandlerHost,
} from "./sessions.js";

/** Host surface the agents handlers need: identity derivation + delegation storage. */
export interface AgentsHandlerHost extends SessionHandlerHost {
  agentDidFor(agentId: string): Promise<string>;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

/** Public shape of an agent returned to the owner. */
export interface AgentView {
  agentId: string;
  agentDid: string;
  name: string;
  enabled: boolean;
  /** TinyCloud space the client mints the delegation in: tcw.space(space). */
  space: string;
  /** Per-agent path prefix within the space (e.g. "default/"). */
  pathPrefix: string;
  /** Delegation `path` to grant: `${pathPrefix}memory`. delegateDID must be agentDid. */
  dbHandle: string;
  createdAt: string;
}

async function toView(record: AgentRecord, host: AgentsHandlerHost): Promise<AgentView> {
  return {
    agentId: record.agentId,
    agentDid: await host.agentDidFor(record.agentId),
    name: record.name,
    enabled: record.enabled,
    space: record.space,
    pathPrefix: record.pathPrefix,
    dbHandle: dbHandleForRecord(record),
    createdAt: record.createdAt,
  };
}

/** POST /api/agents — idempotent create of the owner's next agent. */
export async function handleCreateAgent(
  ownerAddress: string,
  body: { name?: unknown },
  store: AgentStore,
  host: AgentsHandlerHost,
): Promise<HandlerResult> {
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "agent";
  const record = store.create(ownerAddress, name);
  return { status: 201, body: await toView(record, host) };
}

/** GET /api/agents — list the owner's agents. */
export async function handleListAgents(
  ownerAddress: string,
  store: AgentStore,
  host: AgentsHandlerHost,
): Promise<HandlerResult> {
  const records = store.listByOwner(ownerAddress);
  const agents = await Promise.all(records.map((r) => toView(r, host)));
  return { status: 200, body: { agents } };
}

/** GET /api/agents/:agentId — a single owned agent (404 if not owned). */
export async function handleGetAgent(
  ownerAddress: string,
  agentId: string,
  store: AgentStore,
  host: AgentsHandlerHost,
): Promise<HandlerResult> {
  const record = requireOwned(agentId, ownerAddress, store);
  if (!record) return notFound();
  return { status: 200, body: await toView(record, host) };
}

/** PATCH /api/agents/:agentId { enabled } — toggle (404 if not owned). */
export async function handlePatchAgent(
  ownerAddress: string,
  agentId: string,
  body: { enabled?: unknown },
  store: AgentStore,
  host: AgentsHandlerHost,
): Promise<HandlerResult> {
  if (typeof body.enabled !== "boolean") {
    return { status: 400, body: { error: "invalid_body", message: "enabled must be a boolean" } };
  }
  const record = store.setEnabled(agentId, ownerAddress, body.enabled);
  if (!record) return notFound();
  return { status: 200, body: await toView(record, host) };
}

/**
 * POST /api/agents/:agentId/delegation { serializedDelegation, roomId? }
 *
 * The entityId is derived server-side from (ownerAddress, agentId); the caller
 * cannot supply it. Reuses the sessions validation chain against the agent's DID.
 */
export async function handleAgentDelegation(
  ownerAddress: string,
  agentId: string,
  body: { serializedDelegation?: unknown; roomId?: unknown },
  store: AgentStore,
  sessions: SessionStore,
  host: AgentsHandlerHost,
): Promise<HandlerResult> {
  const record = requireOwned(agentId, ownerAddress, store);
  if (!record) return notFound();
  if (typeof body.serializedDelegation !== "string") {
    return { status: 400, body: { error: "invalid_body", message: "serializedDelegation required" } };
  }
  const roomId = typeof body.roomId === "string" ? body.roomId : undefined;

  const entityId = addressToEntityId(ownerAddress, agentId);
  // Option D multi-resource validation for THIS agent (fail-closed on the /api route):
  //  - SQL EXACT on dbHandle "<pathPrefix>memory" (node authorizes exact db names only)
  //  - KV PREFIX on pathPrefix "default/" (KV is hierarchical → "operate broadly")
  //  - space == record.space ("agents") on all matched resources
  // Absent KV resource → missing_kv_resource; wrong space → wrong_space; all 400.
  const dbHandle = dbHandleForRecord(record);
  return handlePostSessions(
    {
      agentId,
      entityId,
      serializedDelegation: body.serializedDelegation,
      roomId,
      dbHandle,
      expectedSpace: record.space,
      kvPrefix: record.pathPrefix,
    },
    host,
    sessions,
  );
}

/**
 * Resolve the entityId for an owner talking to their agent (messages/tools).
 * Returns null when the agent is not owned by ownerAddress.
 */
export function ownerEntityId(
  ownerAddress: string,
  agentId: string,
  store: AgentStore,
): string | null {
  const record = requireOwned(agentId, ownerAddress, store);
  if (!record) return null;
  return addressToEntityId(ownerAddress, agentId);
}

/** Lookup + ownership check; returns the record only when owned. */
export function requireOwned(
  agentId: string,
  ownerAddress: string,
  store: AgentStore,
): AgentRecord | undefined {
  const record = store.get(agentId);
  if (!record || record.ownerAddress !== ownerAddress.toLowerCase()) return undefined;
  return record;
}

function notFound(): HandlerResult {
  // Unknown and not-owned both map to 404 so ownership is not leaked.
  return { status: 404, body: { error: "not_found" } };
}
