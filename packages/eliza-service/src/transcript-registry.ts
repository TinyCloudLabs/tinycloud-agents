import {
  TinyCloudNode,
  defaultTinychatTranscriptPolicy,
  deserializeTranscriptDelegationForActivation,
  validateExactDelegationPolicy,
} from "@tinycloud/agent-client";
import { DelegationExpiredError, NoDelegationError } from "@tinycloud/eliza-plugin-memory";
import type { TranscriptMetadata, TranscriptReader, TranscriptRegistry } from "./actions/tinycloud-search-transcripts.js";

const SQL_PATH = "xyz.tinycloud.tinychat/connectors";
const MAX_ENTRIES = Number(process.env.ELIZA_TRANSCRIPT_REGISTRY_MAX_CLIENTS) || 256;
const TTL_MS = Number(process.env.ELIZA_TRANSCRIPT_REGISTRY_TTL_MS) || 4 * 60 * 60 * 1000;
/** Bounded discovery: one row over the policy ceiling is the overflow sentinel. */
const METADATA_ROW_LIMIT = 501;

type Access = {
  sql: { db(name: string): { query(sql: string): Promise<unknown> } };
  kv: { get(key: string, options?: { prefix?: string }): Promise<unknown> };
};

/** The delegated-node surface this registry uses; injectable for tests. */
export interface TranscriptNode {
  signIn(): Promise<unknown>;
  useDelegation(delegation: unknown): Promise<unknown>;
}

interface Entry {
  access: Access;
  expiry: Date;
  lastUsed: number;
  roomId?: string;
}

/** Per-entity activated transcript access. It retains only delegated handles, never bodies. */
export class TranscriptAccessRegistry implements TranscriptRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly roomToEntity = new Map<string, string>();
  /** Content-free follow-up state; transcript text is never retained here. */
  private readonly selectedMeetingByRoom = new Map<string, string>();

  constructor(
    private readonly args: {
      agentDid: string;
      agentKey: string;
      host: string;
      maxEntries?: number;
      ttlMs?: number;
      /** Overrides the delegated-node client. Production leaves this unset. */
      nodeFactory?: (args: { privateKey: string; host: string }) => TranscriptNode;
    },
  ) {}

  /**
   * Activate and retain one entity's transcript grant.
   *
   * A registration always activates the delegation it was handed: an in-flight
   * activation for the same entity is awaited (and ignored) first, because
   * returning it would silently substitute the PREVIOUS grant for a freshly
   * minted one. A failure is isolated to this entity — it drops that entity's
   * access and rethrows without touching any other entity's entry.
   */
  async register(entityId: string, serializedDelegation: string, roomId?: string): Promise<void> {
    const inFlight = this.pending.get(entityId);
    if (inFlight) await inFlight.catch(() => undefined);
    this.drop(entityId);
    const work = this.activate(entityId, serializedDelegation, roomId);
    this.pending.set(entityId, work);
    try {
      await work;
    } catch (error) {
      this.drop(entityId);
      throw error;
    } finally {
      if (this.pending.get(entityId) === work) this.pending.delete(entityId);
    }
  }

  /** Drop one entity's access (session stop, replacement, or explicit revocation). */
  revoke(entityId: string): void {
    this.drop(entityId);
  }

  readerFor(entityId: string, roomId?: string): TranscriptReader {
    // Room binding is an ISOLATION check, not an index: a room that another
    // entity owns must never resolve here. A room this registry has never seen
    // (tool dispatch synthesizes one when the caller omits it, and a user has
    // many threads per grant) is simply not a cross-entity collision.
    const roomOwner = roomId ? this.roomToEntity.get(roomId) : undefined;
    if (roomOwner !== undefined && roomOwner !== entityId) throw new NoDelegationError(entityId);
    const entry = this.entries.get(entityId);
    if (!entry) throw new NoDelegationError(entityId);
    if (Date.now() >= entry.expiry.getTime() || Date.now() - entry.lastUsed > (this.args.ttlMs ?? TTL_MS)) {
      this.drop(entityId);
      throw new DelegationExpiredError(entityId);
    }
    entry.lastUsed = Date.now();
    return createReader(entry.access);
  }

  selectedMeetingFor(entityId: string, roomId?: string): string | null {
    if (!roomId || this.roomToEntity.get(roomId) !== entityId) return null;
    return this.selectedMeetingByRoom.get(roomId) ?? null;
  }

  selectMeeting(entityId: string, roomId: string | undefined, meetingRef: string): void {
    if (!roomId) return;
    const roomOwner = this.roomToEntity.get(roomId);
    if (roomOwner !== undefined && roomOwner !== entityId) throw new NoDelegationError(entityId);
    if (!this.entries.has(entityId)) throw new NoDelegationError(entityId);
    this.roomToEntity.set(roomId, entityId);
    this.selectedMeetingByRoom.set(roomId, meetingRef);
  }

  /** True only while this entity has live, unexpired activated access. */
  has(entityId: string): boolean {
    const entry = this.entries.get(entityId);
    return entry !== undefined
      && Date.now() < entry.expiry.getTime()
      && Date.now() - entry.lastUsed <= (this.args.ttlMs ?? TTL_MS);
  }

  async stop(): Promise<void> {
    this.entries.clear();
    this.roomToEntity.clear();
    this.selectedMeetingByRoom.clear();
    this.pending.clear();
  }

  private async activate(entityId: string, serialized: string, roomId?: string): Promise<void> {
    const delegation = deserializeTranscriptDelegationForActivation(serialized);
    validateExactDelegationPolicy(delegation, { agentDID: this.args.agentDid, policy: defaultTinychatTranscriptPolicy() });
    const expiry = delegation.expiry instanceof Date ? delegation.expiry : new Date(delegation.expiry as unknown as string);
    const node = this.args.nodeFactory
      ? this.args.nodeFactory({ privateKey: this.args.agentKey, host: this.args.host })
      : new TinyCloudNode({ privateKey: this.args.agentKey, host: this.args.host }) as unknown as TranscriptNode;
    await node.signIn();
    const access = await node.useDelegation(delegation) as unknown as Access;
    if (this.entries.size >= (this.args.maxEntries ?? MAX_ENTRIES)) this.evictLru();
    this.entries.set(entityId, { access, expiry, lastUsed: Date.now(), roomId });
    if (roomId) this.roomToEntity.set(roomId, entityId);
  }

  private drop(entityId: string): void {
    this.entries.delete(entityId);
    for (const [room, owner] of this.roomToEntity) {
      if (owner !== entityId) continue;
      this.roomToEntity.delete(room);
      this.selectedMeetingByRoom.delete(room);
    }
  }

  private evictLru(): void {
    const lru = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]?.[0];
    if (lru) this.drop(lru);
  }
}

export function createReader(access: Access): TranscriptReader {
  return {
    async listMetadata(): Promise<TranscriptMetadata[]> {
      const response = await access.sql.db(SQL_PATH).query(
        `SELECT id, source, source_id, title, started_at, organizer_email, participants, summary_overview, summary_action_items FROM connector_meeting ORDER BY started_at DESC LIMIT ${METADATA_ROW_LIMIT}`,
      ) as { ok?: boolean; data?: { rows?: unknown[][] }; error?: { code?: unknown } };
      if (response?.ok !== true || !Array.isArray(response.data?.rows)) {
        // Keep upstream details out of the tool response, but retain the stable
        // service code in process logs so operators can distinguish an auth
        // contract mismatch from a storage outage without logging user data.
        const code = typeof response?.error?.code === "string" ? response.error.code : "unknown";
        console.warn(`[transcript-registry] metadata query failed (${code})`);
        throw new Error("metadata unavailable");
      }
      return response.data.rows.flatMap((row): TranscriptMetadata[] => {
        const [meetingRef, source, sourceId, title, startedAt, organizerEmail, participants, summaryOverview, summaryActionItems] = row;
        if (typeof meetingRef !== "string" || !safeMeetingRef(meetingRef) || !isSource(source) || typeof sourceId !== "string") return [];
        const parsedParticipants = parseParticipants(participants);
        return [{
          meetingRef,
          source,
          sourceId,
          title: typeof title === "string" ? title : null,
          startedAt: typeof startedAt === "string" && Number.isFinite(Date.parse(startedAt)) ? startedAt : null,
          participantNames: parsedParticipants.names,
          participantEmails: parsedParticipants.emails,
          organizerEmail: typeof organizerEmail === "string" ? organizerEmail : null,
          summaryOverview: typeof summaryOverview === "string" ? summaryOverview : null,
          summaryActionItems: typeof summaryActionItems === "string" ? summaryActionItems : null,
        }];
      });
    },
    async getTranscript(source, sourceId): Promise<unknown | null> {
      if (!isSource(source) || !safeSegment(sourceId)) throw new Error("invalid stored metadata");
      // DelegatedAccess configures an automatic KV prefix from the portable
      // delegation's compatibility path. Use the fixed full connector key and
      // explicitly disable that automatic prefix, or the SDK doubles the path
      // and turns an existing transcript into KV_NOT_FOUND.
      const key = `${SQL_PATH}/${source}/transcript/${sourceId}`;
      const response = await access.kv.get(key, { prefix: "" }) as { ok?: boolean; error?: { code?: string }; data?: { data?: unknown } };
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

function safeMeetingRef(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value) && !value.includes("..");
}

function parseParticipants(value: unknown): { names: string[]; emails: string[] } {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown; } catch { return { names: [], emails: [] }; }
  }
  if (!Array.isArray(parsed)) return { names: [], emails: [] };
  const names: string[] = [];
  const emails: string[] = [];
  for (const entry of parsed.slice(0, 100)) {
    if (!entry || typeof entry !== "object") continue;
    const participant = entry as { name?: unknown; email?: unknown; displayName?: unknown };
    const name = typeof participant.name === "string" ? participant.name : participant.displayName;
    if (typeof name === "string" && name.length <= 160) names.push(name);
    if (typeof participant.email === "string" && participant.email.length <= 254) emails.push(participant.email);
  }
  return { names: [...new Set(names)], emails: [...new Set(emails)] };
}
