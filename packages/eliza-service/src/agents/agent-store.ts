// In-memory agent registry (plan §2, M2 phase 1).
//
// Maps a deterministic per-owner agentId to its record. agentIds are derived, not
// random:
//
//   agentId = stringToUuid(ownerAddress.toLowerCase() + ":agent:" + index)
//
// so create is idempotent per (owner, index) and recoverable after a restart even
// though name/enabled state is lost (only the mutable fields live here; identity
// and DID are re-derivable via runtime-host.identityFor()).
//
// Phase 2 (plan §2) persists this via a service-owned TinyCloud space. Until then
// this is a process-local Map — records are lost on CVM redeploy.

import { stringToUuid } from "../entity-id.js";

export interface AgentRecord {
  agentId: string;
  /** Lowercased owner address (EIP-55 input is normalized before storage). */
  ownerAddress: string;
  name: string;
  enabled: boolean;
  /** Zero-based index of this agent within the owner's set. */
  index: number;
  createdAt: string;
}

/** Compute the deterministic agentId for an owner's Nth agent. */
export function agentIdFor(ownerAddress: string, index: number): string {
  return stringToUuid(`${ownerAddress.toLowerCase()}:agent:${index}`);
}

export class AgentStore {
  private readonly _byAgentId = new Map<string, AgentRecord>();

  /** All agentIds owned by ownerAddress, in creation (index) order. */
  private _indicesFor(ownerAddress: string): AgentRecord[] {
    const owner = ownerAddress.toLowerCase();
    return [...this._byAgentId.values()]
      .filter((r) => r.ownerAddress === owner)
      .sort((a, b) => a.index - b.index);
  }

  /**
   * Idempotently create the owner's next agent.
   *
   * Deterministic: the Nth create for an owner always yields the same agentId. If
   * a record for that agentId already exists (e.g. a retried request), it is
   * returned unchanged rather than duplicated — the caller sees the same
   * {agentId, ...} either way.
   */
  create(ownerAddress: string, name: string, now: () => number = Date.now): AgentRecord {
    const owner = ownerAddress.toLowerCase();
    const index = this._indicesFor(owner).length;
    const agentId = agentIdFor(owner, index);

    const existing = this._byAgentId.get(agentId);
    if (existing) return existing;

    const record: AgentRecord = {
      agentId,
      ownerAddress: owner,
      name,
      enabled: true,
      index,
      createdAt: new Date(now()).toISOString(),
    };
    this._byAgentId.set(agentId, record);
    return record;
  }

  get(agentId: string): AgentRecord | undefined {
    return this._byAgentId.get(agentId);
  }

  /** All records owned by ownerAddress, in creation order. */
  listByOwner(ownerAddress: string): AgentRecord[] {
    return this._indicesFor(ownerAddress);
  }

  /**
   * Toggle enabled on an owned agent. Returns the updated record, or undefined if
   * the agentId is unknown OR not owned by ownerAddress (callers map both to 404
   * so ownership is not leaked).
   */
  setEnabled(agentId: string, ownerAddress: string, enabled: boolean): AgentRecord | undefined {
    const record = this._byAgentId.get(agentId);
    if (!record || record.ownerAddress !== ownerAddress.toLowerCase()) return undefined;
    record.enabled = enabled;
    return record;
  }
}
