import {
  TinyCloudNode,
  defaultTinychatTranscriptPolicy,
  deserializeAndNormalize,
  validateExactDelegationPolicy,
} from "@tinycloud/agent-client";
import { DelegationExpiredError, NoDelegationError } from "@tinycloud/eliza-plugin-memory";
import type { TranscriptMetadata, TranscriptReader } from "./actions/tinycloud-search-transcripts.js";

const SQL_PATH = "xyz.tinycloud.tinychat/connectors";
const KV_PREFIX = `${SQL_PATH}/`;
const MAX_ENTRIES = Number(process.env.ELIZA_TRANSCRIPT_REGISTRY_MAX_CLIENTS) || 256;
const TTL_MS = Number(process.env.ELIZA_TRANSCRIPT_REGISTRY_TTL_MS) || 4 * 60 * 60 * 1000;

type Access = {
  sql: { db(name: string): { query(sql: string): Promise<unknown> } };
  kv: { get(key: string): Promise<unknown> };
};

interface Entry {
  access: Access;
  expiry: Date;
  lastUsed: number;
  roomId?: string;
}

/** Per-entity activated transcript access. It retains only delegated handles, never bodies. */
export class TranscriptAccessRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly roomToEntity = new Map<string, string>();

  constructor(
    private readonly args: { agentDid: string; agentKey: string; host: string; maxEntries?: number; ttlMs?: number },
  ) {}

  async register(entityId: string, serializedDelegation: string, roomId?: string): Promise<void> {
    const current = this.entries.get(entityId);
    if (current) await this.drop(entityId);
    const inFlight = this.pending.get(entityId);
    if (inFlight) return inFlight;
    const work = this.activate(entityId, serializedDelegation, roomId);
    this.pending.set(entityId, work);
    try { await work; } finally { this.pending.delete(entityId); }
  }

  readerFor(entityId: string, roomId?: string): TranscriptReader {
    const resolved = roomId ? this.roomToEntity.get(roomId) : entityId;
    if (!resolved || resolved !== entityId) throw new NoDelegationError(entityId);
    const entry = this.entries.get(entityId);
    if (!entry) throw new NoDelegationError(entityId);
    if (Date.now() >= entry.expiry.getTime() || Date.now() - entry.lastUsed > (this.args.ttlMs ?? TTL_MS)) {
      void this.drop(entityId);
      throw new DelegationExpiredError(entityId);
    }
    entry.lastUsed = Date.now();
    return createReader(entry.access);
  }

  async stop(): Promise<void> {
    this.entries.clear();
    this.roomToEntity.clear();
    this.pending.clear();
  }

  private async activate(entityId: string, serialized: string, roomId?: string): Promise<void> {
    const delegation = deserializeAndNormalize(serialized);
    validateExactDelegationPolicy(delegation, { agentDID: this.args.agentDid, policy: defaultTinychatTranscriptPolicy() });
    const expiry = delegation.expiry instanceof Date ? delegation.expiry : new Date(delegation.expiry as unknown as string);
    const node = new TinyCloudNode({ privateKey: this.args.agentKey, host: this.args.host });
    await node.signIn();
    const access = await node.useDelegation(delegation) as unknown as Access;
    if (this.entries.size >= (this.args.maxEntries ?? MAX_ENTRIES)) await this.evictLru();
    this.entries.set(entityId, { access, expiry, lastUsed: Date.now(), roomId });
    if (roomId) this.roomToEntity.set(roomId, entityId);
  }

  private async drop(entityId: string): Promise<void> {
    this.entries.delete(entityId);
    for (const [room, owner] of this.roomToEntity) if (owner === entityId) this.roomToEntity.delete(room);
  }

  private async evictLru(): Promise<void> {
    const lru = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]?.[0];
    if (lru) await this.drop(lru);
  }
}

function createReader(access: Access): TranscriptReader {
  return {
    async listMetadata(): Promise<TranscriptMetadata[]> {
      const response = await access.sql.db(SQL_PATH).query(
        "SELECT source, source_id, title, started_at FROM connector_meeting ORDER BY started_at DESC LIMIT 501",
      ) as { ok?: boolean; data?: { rows?: unknown[][] } };
      if (response?.ok !== true || !Array.isArray(response.data?.rows)) throw new Error("metadata unavailable");
      return response.data.rows.flatMap((row): TranscriptMetadata[] => {
        const [source, sourceId, title, startedAt] = row;
        if (!isSource(source) || typeof sourceId !== "string") return [];
        return [{ source, sourceId, title: typeof title === "string" ? title : null, startedAt: typeof startedAt === "string" ? startedAt : null }];
      });
    },
    async getTranscript(source, sourceId): Promise<unknown | null> {
      if (!isSource(source) || !safeSegment(sourceId)) throw new Error("invalid stored metadata");
      const key = `${KV_PREFIX}${source}/transcript/${sourceId}`;
      const response = await access.kv.get(key) as { ok?: boolean; error?: { code?: string }; data?: { data?: unknown } };
      if (response?.ok !== true) {
        if (response?.error?.code === "KV_NOT_FOUND") return null;
        throw new Error("transcript unavailable");
      }
      const value = response.data?.data;
      if (typeof value !== "string") return value ?? null;
      try { return JSON.parse(value) as unknown; } catch { return null; }
    },
  };
}

function isSource(value: unknown): value is TranscriptMetadata["source"] {
  return value === "fireflies" || value === "google-meet" || value === "tinycloud-transcriber";
}

function safeSegment(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.includes("/") && !value.includes("\\") && !value.includes("..");
}
