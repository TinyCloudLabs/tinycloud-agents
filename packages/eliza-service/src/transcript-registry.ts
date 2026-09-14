import {
  defaultTinychatTranscriptPolicy,
  deserializeTranscriptDelegationForActivation,
  validateExactDelegationPolicy,
} from "@tinycloud/agent-client";
import type { PortableDelegation } from "@tinycloud/agent-client";
import { DelegationExpiredError, NoDelegationError } from "@tinycloud/eliza-plugin-memory";
import type { TranscriptReader, TranscriptRegistry } from "./actions/tinycloud-search-transcripts.js";
import { checkContext, decodeSnapshotEvidence, emptyEvidence, safeMeetingRef, sha256, MeetingRetrievalError, withinContext } from "./meeting-evidence.js";
import type { BodyResult, RetrievalContext } from "./meeting-evidence.js";
import type { CatalogMeeting, EvidenceOmission, PublishedMeetingSnapshot } from "./meeting-contract.js";
import { isSource, parseFindMeetingsArgs, parseReadMeetingArgs, safeSourceId } from "./actions/tinycloud-search-transcripts.js";
import { createTranscriptNode, TranscriptResponseLimitError } from "./transcript-transport.js";

const SQL_PATH = "xyz.tinycloud.tinychat/connectors";
const MAX_ENTRIES = Number(process.env.ELIZA_TRANSCRIPT_REGISTRY_MAX_CLIENTS) || 256;
const TTL_MS = Number(process.env.ELIZA_TRANSCRIPT_REGISTRY_TTL_MS) || 4 * 60 * 60 * 1000;
// node-sdk 2.6.0 activates a child session lasting at most one hour, even when
// its portable parent is valid for days. Renew on the next read before expiry.
const SESSION_REFRESH_MS = 50 * 60 * 1000;


type Access = {
  sql: { db(name: string): { query(sql: string, params?: Array<string | number | null>, options?: { signal?: AbortSignal }): Promise<unknown> } };
  kv: { get(key: string, options?: { prefix?: string; raw?: boolean; signal?: AbortSignal }): Promise<unknown> };
};

/** The delegated-node surface this registry uses; injectable for tests. */
export interface TranscriptNode {
  signIn(): Promise<unknown>;
  useDelegation(delegation: PortableDelegation): Promise<unknown>;
}

interface Entry {
  access: Access;
  delegation: PortableDelegation;
  refreshAt: number;
  refresh?: Promise<void>;
  expiry: Date;
  lastUsed: number;
  roomId?: string;
}

/** Per-entity transcript grants and renewable delegated access; never retains bodies. */
export class TranscriptAccessRegistry implements TranscriptRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly roomToEntity = new Map<string, string>();

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
    const assertAccess = () => {
      // Recheck the current grant before and after every storage operation. Replaced
      // handles cannot finish an old request with evidence from their former grant.
      this.readerFor(entityId, roomId);
      if (this.entries.get(entityId) !== entry) throw new NoDelegationError(entityId);
    };
    return createReader(async () => {
      assertAccess();
      if (Date.now() >= entry.refreshAt) {
        if (!entry.refresh) {
          const startedAt = Date.now();
          entry.refresh = this.activateAccess(entry.delegation).then(access => {
            // Renewal preserves the entry. A late activation
            // must never restore a revoked, replaced, evicted, or stopped entry.
            assertAccess();
            entry.access = access;
            entry.refreshAt = startedAt + SESSION_REFRESH_MS;
          }, () => {
            assertAccess();
            throw new MeetingRetrievalError("transcript_unavailable");
          }).finally(() => { entry.refresh = undefined; });
        }
        await entry.refresh;
      }
      assertAccess();
      return entry.access;
    }, assertAccess, () => this.drop(entityId));
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
    this.pending.clear();
  }

  private async activate(entityId: string, serialized: string, roomId?: string): Promise<void> {
    const delegation = deserializeTranscriptDelegationForActivation(serialized);
    validateExactDelegationPolicy(delegation, { agentDID: this.args.agentDid, policy: defaultTinychatTranscriptPolicy() });
    const expiry = delegation.expiry instanceof Date ? delegation.expiry : new Date(delegation.expiry as unknown as string);
    const startedAt = Date.now();
    const access = await this.activateAccess(delegation);
    if (this.entries.size >= (this.args.maxEntries ?? MAX_ENTRIES)) this.evictLru();
    this.entries.set(entityId, { access, delegation, refreshAt: startedAt + SESSION_REFRESH_MS, expiry, lastUsed: Date.now(), roomId });
    if (roomId) {
      this.roomToEntity.set(roomId, entityId);
    }
  }

  private async activateAccess(delegation: PortableDelegation): Promise<Access> {
    // Build a fresh wallet session, then reactivate the same exact parent grant.
    const node = this.args.nodeFactory
      ? this.args.nodeFactory({ privateKey: this.args.agentKey, host: this.args.host })
      : createTranscriptNode({ privateKey: this.args.agentKey, host: this.args.host });
    await node.signIn();
    return await node.useDelegation(delegation) as unknown as Access;
  }

  private drop(entityId: string): void {
    this.entries.delete(entityId);
    for (const [room, owner] of this.roomToEntity) {
      if (owner !== entityId) continue;
      this.roomToEntity.delete(room);
    }
  }

  private evictLru(): void {
    const lru = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]?.[0];
    if (lru) this.drop(lru);
  }
}

const COLUMNS = "id, source, source_id, title, started_at, organizer_email, participants, metadata, head_revision, head_snapshot_key, publication_state";
function decodeMetadata(row: unknown): CatalogMeeting | null {
  if (!Array.isArray(row)) return null;
  const [meetingRef,source,sourceId,title,startedAt,organizerEmail,rawParticipants,rawMetadata,revision,_key,state] = row;
  if (!safeMeetingRef(meetingRef) || !isSource(source) || !safeSourceId(sourceId) || state === "deleted") return null;
  let participants: unknown = rawParticipants, metadata: unknown = rawMetadata;
  try { if (typeof participants === "string") participants = JSON.parse(participants); if (typeof metadata === "string") metadata=JSON.parse(metadata); } catch { return null; }
  if (!Array.isArray(participants)) return null;
  const validRevision = typeof revision === "string" && /^[a-f0-9]{64}$/.test(revision);
  return {meetingRef,source,sourceId,revision:validRevision?revision:null,
    readiness:validRevision && ["published","reserved"].includes(state) ? "published" : state === "unavailable" ? "unavailable" : "unverified",
    title:typeof title === "string"?title:null,startedAt:typeof startedAt === "string"?startedAt:null,
    organizerEmail:typeof organizerEmail === "string"?organizerEmail:null,
    participants:participants.flatMap(item => item && typeof item === "object" ? [{...(typeof item.name === "string"?{name:item.name}:typeof item.displayName === "string"?{name:item.displayName}:{}),...(typeof item.email === "string"?{email:item.email}:{})}] : []),
    basis:metadata && typeof metadata === "object" && ((metadata as Record<string,unknown>).artifactType === "notes" || (metadata as Record<string,unknown>).basis === "notes") ? "notes" : "transcript"};
}
/** Pinned SDK 2.6.0 preserves HTTP error details, but KV_NOT_FOUND alone is ambiguous. */
export function classifyBodyFailure(error: unknown): BodyResult {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  // Pinned SDK wrapError preserves thrown adapter errors in `cause`.
  const transport = value.cause instanceof TranscriptResponseLimitError ? value.cause : error instanceof TranscriptResponseLimitError ? error : undefined;
  if (transport) {
    if (transport.status === 401 || transport.status === 403) return { state: "access_denied", reasonCode: "ACCESS_DENIED" };
    return { state: transport.status >= 200 && transport.status < 300 ? "size_limit" : "unavailable", reasonCode: transport.code };
  }
  const code = typeof value.code === "string" && /^[A-Z0-9_]{1,80}$/.test(value.code) ? value.code : "UNKNOWN";
  // Explicit denial outranks diagnostic prose (even "Space not found").
  const status = value.status ?? (value.meta as { status?: unknown } | undefined)?.status;
  if (status === 401 || status === 403 || /(?:UNAUTHORIZED|FORBIDDEN|ACCESS_DENIED|PERMISSION_DENIED|AUTH_REQUIRED|AUTH_EXPIRED|DELEGATION_EXPIRED|DELEGATION_REVOKED)/.test(code)) return { state: "access_denied", reasonCode: code };
  if (code === "TIMEOUT") return { state: "timeout", reasonCode: code };
  if (code === "ABORTED") return { state: "cancelled", reasonCode: code };
  const text = [value.message, value.statusText, value.details && typeof value.details === "object" ? JSON.stringify(value.details) : value.details].filter(value => typeof value === "string").join(" ");
  if (/space.{0,30}(?:not found|not hosted|unavailable)|(?:not found|not hosted).{0,30}space/i.test(text)) return { state: "unavailable", reasonCode: "space_unavailable" };
  if (code === "KV_NOT_FOUND") return /(?:key|entry) not found/i.test(text) ? { state: "missing", reasonCode: code } : { state: "unavailable", reasonCode: "ambiguous_not_found" };
  return { state: "unavailable", reasonCode: code };
}
export function createReader(access: Access | (() => Promise<Access>), assertAccess: () => void = () => {}, invalidateAccess: () => void = () => {}): TranscriptReader {
  const withAccess = async <T>(signal: AbortSignal | undefined, operation: (active: Access) => Promise<T>) => {
    const active = typeof access === "function" ? await access() : access;
    // A caller can stop waiting while a shared renewal continues for others.
    // Check again before storage so cancelled callers never start a late read.
    checkContext({ signal });
    assertAccess();
    return operation(active);
  };
  const enforceAccess = (body: BodyResult) => {
    if (body.state !== "access_denied") return;
    const code = body.reasonCode === "DELEGATION_REVOKED" ? "delegation_revoked" : body.reasonCode === "DELEGATION_EXPIRED" || body.reasonCode === "AUTH_EXPIRED" ? "delegation_expired" : "access_denied";
    if (code !== "access_denied") invalidateAccess();
    throw new MeetingRetrievalError(code, 409);
  };
  const query = async (sql: string, params: Array<string | number | null> = [], context: RetrievalContext = {}): Promise<unknown[][]> => {
    assertAccess();
    const response = await withinContext(signal => withAccess(signal, active => active.sql.db(SQL_PATH).query(sql, params, { signal })), context) as { ok?: boolean; data?: { rows?: unknown[][] }; error?: unknown };
    assertAccess();
    if (response?.ok !== true || !Array.isArray(response.data?.rows)) {
      enforceAccess(classifyBodyFailure(response?.error));
      throw new MeetingRetrievalError("transcript_unavailable");
    }
    return response.data.rows;
  };
  return {
    assertAccess,
    async getMetadata(reference, context = {}) {
      if (!safeMeetingRef(reference)) throw new MeetingRetrievalError("invalid_args",400);
      const rows = await query(`SELECT ${COLUMNS} FROM connector_meeting WHERE id = ? LIMIT 1`, [reference], context);
      return rows.map(decodeMetadata).find(row=>row?.meetingRef===reference)??null;
    },
    async pageMetadata(args, context = {}) {
      if (!parseFindMeetingsArgs(args as unknown as Record<string,unknown>)) throw new MeetingRetrievalError("invalid_args",400);
      const clauses = ["(publication_state IS NULL OR publication_state != 'deleted')"], params:Array<string|number|null>=[];
      if(args.after){clauses.push("id > ?");params.push(args.after);}
      if(args.filters?.source){clauses.push("source = ?");params.push(args.filters.source);}
      const raw = await query(`SELECT ${COLUMNS} FROM connector_meeting WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT 101`,params,context);
      const examined=raw.slice(0,100), omissions:EvidenceOmission[]=[];
      const rows=examined.flatMap((row,index)=>{const decoded=decodeMetadata(row);if(decoded)return[decoded];omissions.push({code:"invalid_catalog_record",recordIndex:index});return[];});
      const cursor=examined.at(-1)?.[0];
      if(examined.length && !safeMeetingRef(cursor))throw new MeetingRetrievalError("invalid_catalog_cursor");
      return {contractVersion:3,kind:"page",rows,nextCursor:raw.length>100?cursor as string:null,exhausted:raw.length<=100,
        examinedRows:examined.length,observedAt:new Date().toISOString(),scope:"observed",omissions};
    },
    async readEvidence(args, context = {}) {
      if(!parseReadMeetingArgs(args as unknown as Record<string,unknown>))throw new MeetingRetrievalError("invalid_args",400);
      const {reference,basis}=args;
      const metadata=await this.getMetadata(reference.meetingRef,context);
      if(!metadata || metadata.source!==reference.source || metadata.sourceId!==reference.sourceId || metadata.readiness!=="published")return emptyEvidence(reference,basis,"unavailable","meeting_unavailable");
      const key=`${SQL_PATH}/${reference.source}/snapshot/${encodeURIComponent(reference.sourceId)}/${reference.revision}`;
      const response=await withinContext(signal=>withAccess(signal,active=>active.kv.get(key,{prefix:"",raw:true,signal})),context) as {ok?:boolean;error?:unknown;data?:{data?:unknown}};
      assertAccess();
      if(response?.ok!==true){const failure=classifyBodyFailure(response?.error);enforceAccess(failure);return emptyEvidence(reference,basis,failure.state==="size_limit"?"capacity":"unavailable",failure.state==="missing"?"revision_unavailable":failure.reasonCode??failure.state);}
      const raw=response.data?.data;
      if(typeof raw!=="string")return emptyEvidence(reference,basis,"unavailable","invalid_snapshot_encoding");
      if(sha256(raw)!==reference.revision)return emptyEvidence(reference,basis,"unavailable","snapshot_digest_mismatch");
      let snapshot:PublishedMeetingSnapshot;
      try{snapshot=JSON.parse(raw);}catch{return emptyEvidence(reference,basis,"unavailable","invalid_snapshot_json");}
      const result=decodeSnapshotEvidence(snapshot,reference,basis);
      // A delete/identity replacement during KV I/O cannot release its former content.
      const current=await this.getMetadata(reference.meetingRef,context);
      if(!current || current.source!==reference.source || current.sourceId!==reference.sourceId || current.readiness!=="published")return emptyEvidence(reference,basis,"unavailable","meeting_unavailable");
      assertAccess();return result;
    },
  };
}
