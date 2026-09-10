import {
  defaultTinychatTranscriptPolicy,
  deserializeTranscriptDelegationForActivation,
  validateExactDelegationPolicy,
} from "@tinycloud/agent-client";
import type { PortableDelegation } from "@tinycloud/agent-client";
import { DelegationExpiredError, NoDelegationError } from "@tinycloud/eliza-plugin-memory";
import type { TranscriptMetadata, TranscriptReader, TranscriptRegistry } from "./actions/tinycloud-search-transcripts.js";
import { decodeBody, discoveryResult, MeetingRetrievalError, withinContext } from "./meeting-evidence.js";
import type { BodyResult, MeetingSelection, RetrievalContext } from "./meeting-evidence.js";
import { createTranscriptNode, TranscriptResponseLimitError } from "./transcript-transport.js";

const SQL_PATH = "xyz.tinycloud.tinychat/connectors";
const MAX_ENTRIES = Number(process.env.ELIZA_TRANSCRIPT_REGISTRY_MAX_CLIENTS) || 256;
const TTL_MS = Number(process.env.ELIZA_TRANSCRIPT_REGISTRY_TTL_MS) || 4 * 60 * 60 * 1000;
/** Bounded discovery: one row over the policy ceiling is the overflow sentinel. */
const METADATA_ROW_LIMIT = 501;

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
  private readonly selectedMeetingByRoom = new Map<string, MeetingSelection>();

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
    return createReader(entry.access, () => {
      // Recheck the current grant before and after every storage operation. Replaced
      // handles cannot finish an old request with evidence from their former grant.
      this.readerFor(entityId, roomId);
      if (this.entries.get(entityId) !== entry) throw new NoDelegationError(entityId);
    }, () => this.drop(entityId));
  }

  selectedMeetingFor(entityId: string, roomId?: string): string | null {
    this.readerFor(entityId, roomId);
    if (!roomId || this.roomToEntity.get(roomId) !== entityId) return null;
    const selection = this.selectedMeetingByRoom.get(roomId);
    return selection?.state === "single" ? selection.meetingRef : null;
  }

  selectMeeting(entityId: string, roomId: string | undefined, meetingRef: string): void {
    if (!roomId) return;
    const roomOwner = this.roomToEntity.get(roomId);
    if (roomOwner !== undefined && roomOwner !== entityId) throw new NoDelegationError(entityId);
    if (!this.entries.has(entityId)) throw new NoDelegationError(entityId);
    this.roomToEntity.set(roomId, entityId);
    this.readerFor(entityId, roomId);
    this.selectedMeetingByRoom.set(roomId, { state: "single", meetingRef });
  }

  setSelection(entityId: string, roomId: string | undefined, selection: MeetingSelection): void {
    if (!roomId) return;
    const owner = this.roomToEntity.get(roomId);
    if (owner !== undefined && owner !== entityId) throw new NoDelegationError(entityId);
    if (selection.state === "none") { this.selectedMeetingByRoom.delete(roomId); return; }
    this.readerFor(entityId, roomId);
    this.roomToEntity.set(roomId, entityId);
    this.selectedMeetingByRoom.set(roomId, selection);
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
      : createTranscriptNode({ privateKey: this.args.agentKey, host: this.args.host });
    await node.signIn();
    const access = await node.useDelegation(delegation) as unknown as Access;
    if (this.entries.size >= (this.args.maxEntries ?? MAX_ENTRIES)) this.evictLru();
    this.entries.set(entityId, { access, expiry, lastUsed: Date.now(), roomId });
    if (roomId) {
      this.selectedMeetingByRoom.delete(roomId);
      this.roomToEntity.set(roomId, entityId);
    }
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

const COLUMNS = "id, source, source_id, title, started_at, organizer_email, participants, summary_overview, summary_action_items, metadata";
function decodeMetadata(row: unknown): TranscriptMetadata | null {
  if (!Array.isArray(row)) return null;
  const [meetingRef, source, sourceId, title, startedAt, organizerEmail, participants, summaryOverview, summaryActionItems, metadata] = row;
  if (typeof meetingRef !== "string" || !safeMeetingRef(meetingRef) || !isSource(source) || typeof sourceId !== "string" || !safeSegment(sourceId)) return null;
  const parsed = parseParticipants(participants);
  let provenance: unknown = metadata;
  if (typeof provenance === "string") { try { provenance = JSON.parse(provenance); } catch { provenance = undefined; } }
  // Only keep existing artifact type markers, never opaque provider metadata.
  const known: Record<string, unknown> = {};
  if (provenance && typeof provenance === "object") for (const key of ["artifactType", "artifact_type", "type", "kind", "documentType", "document_type", "notes_kind", "notes_association"]) {
    const value = (provenance as Record<string, unknown>)[key]; if (typeof value === "string" && value.length < 100) known[key] = value;
  }
  const transcriptCount = provenance && typeof provenance === "object" ? (provenance as Record<string, unknown>).transcript_count : undefined;
  if (typeof transcriptCount === "number" && Number.isInteger(transcriptCount) && transcriptCount >= 0) known.transcript_count = transcriptCount;
  return { meetingRef, source, sourceId, title: typeof title === "string" ? title : null,
    startedAt: typeof startedAt === "string" && Number.isFinite(Date.parse(startedAt)) ? startedAt : null,
    participantNames: parsed.names, participantEmails: parsed.emails, metadataLimited: parsed.limited, organizerEmail: typeof organizerEmail === "string" ? organizerEmail : null,
    summaryOverview: typeof summaryOverview === "string" ? summaryOverview : null, summaryActionItems: typeof summaryActionItems === "string" ? summaryActionItems : null,
    ...(Object.keys(known).length ? { metadata: known } : {}),
  };
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
export function createReader(access: Access, assertAccess: () => void = () => {}, invalidateAccess: () => void = () => {}): TranscriptReader {
  const enforceAccess = (body: BodyResult) => {
    if (body.state !== "access_denied") return;
    const code = body.reasonCode === "DELEGATION_REVOKED" ? "delegation_revoked" : body.reasonCode === "DELEGATION_EXPIRED" || body.reasonCode === "AUTH_EXPIRED" ? "delegation_expired" : "access_denied";
    if (code !== "access_denied") invalidateAccess();
    throw new MeetingRetrievalError(code, 409);
  };
  const query = async (sql: string, params: Array<string | number | null> = [], context: RetrievalContext = {}): Promise<unknown[][]> => {
    assertAccess();
    const response = await withinContext(signal => access.sql.db(SQL_PATH).query(sql, params, { signal }), context) as { ok?: boolean; data?: { rows?: unknown[][] }; error?: unknown };
    assertAccess();
    if (response?.ok !== true || !Array.isArray(response.data?.rows)) {
      enforceAccess(classifyBodyFailure(response?.error));
      throw new MeetingRetrievalError("transcript_unavailable");
    }
    return response.data.rows;
  };
  const readBody = async (source: TranscriptMetadata["source"], sourceId: string, context: RetrievalContext = {}): Promise<BodyResult> => {
    if (!isSource(source) || !safeSegment(sourceId)) throw new MeetingRetrievalError("invalid_stored_metadata");
    assertAccess();
    // Transcript-only transport caps decoded bytes before SDK buffering. Retain
    // the decoded-value check for injected readers and UTF-8 replacement growth.
    const response = await withinContext(signal => access.kv.get(`${SQL_PATH}/${source}/transcript/${sourceId}`, { prefix: "", raw: true, signal }), context) as { ok?: boolean; error?: unknown; data?: { data?: unknown } };
    assertAccess();
    const body = response?.ok === true ? decodeBody(response.data?.data) : classifyBodyFailure(response?.error);
    enforceAccess(body); return body;
  };
  return {
    assertAccess,
    async listMetadata() {
      const rows = await query(`SELECT ${COLUMNS} FROM connector_meeting ORDER BY julianday(started_at) IS NULL ASC, julianday(started_at) DESC, id ASC LIMIT ${METADATA_ROW_LIMIT}`);
      return rows.flatMap(row => { const decoded = decodeMetadata(row); return decoded ? [decoded] : []; });
    },
    async getMetadata(reference, context = {}) {
      if (!safeMeetingRef(reference)) throw new MeetingRetrievalError("invalid_args", 400);
      const rows = await query(`SELECT ${COLUMNS} FROM connector_meeting WHERE id = ? LIMIT 1`, [reference], context);
      // Check identity even when a faulty upstream ignores its predicate.
      return rows.map(decodeMetadata).find(row => row?.meetingRef === reference) ?? null;
    },
    async discoverMetadata(args, context = {}) {
      const clauses: string[] = []; const params: Array<string | number | null> = [];
      if (args.source) { clauses.push("source = ?"); params.push(args.source); }
      // Conservative UTC superset for every IANA offset, followed by exact local-day checks.
      if (args.from) { clauses.push("julianday(started_at) >= julianday(?)"); params.push(new Date(Date.parse(args.from) - 86_400_000).toISOString()); }
      if (args.to) { clauses.push("julianday(started_at) < julianday(?)"); params.push(new Date(Date.parse(args.to) + 2 * 86_400_000).toISOString()); }
      const rows = await query(`SELECT ${COLUMNS} FROM connector_meeting${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY julianday(started_at) IS NULL ASC, julianday(started_at) ${args.sort === "oldest" ? "ASC" : "DESC"}, id ASC LIMIT ${METADATA_ROW_LIMIT}`, params, context);
      const decoded = rows.slice(0, 500).flatMap(row => { const value = decodeMetadata(row); return value ? [value] : []; });
      return discoveryResult(decoded, rows.length, args, context);
    },
    readBody,
    async getTranscript(source, sourceId) {
      const body = await readBody(source, sourceId);
      if (body.state === "missing" || body.state === "empty") return null;
      if (body.state !== "present") throw new MeetingRetrievalError(body.reasonCode ?? body.state);
      return body.value;
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

function parseParticipants(value: unknown): { names: string[]; emails: string[]; limited: boolean } {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown; } catch { return { names: [], emails: [], limited: true }; }
  }
  if (!Array.isArray(parsed)) return { names: [], emails: [], limited: true };
  const names: string[] = [];
  const emails: string[] = [];
  for (const entry of parsed.slice(0, 100)) {
    if (!entry || typeof entry !== "object") continue;
    const participant = entry as { name?: unknown; email?: unknown; displayName?: unknown };
    const name = typeof participant.name === "string" ? participant.name : participant.displayName;
    if (typeof name === "string" && name.length <= 160) names.push(name);
    if (typeof participant.email === "string" && participant.email.length <= 254) emails.push(participant.email);
  }
  return { names: [...new Set(names)], emails: [...new Set(emails)], limited: parsed.length > 100 };
}
