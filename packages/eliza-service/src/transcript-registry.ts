import {
  defaultTinychatTranscriptPolicy,
  deserializeTranscriptDelegationForActivation,
  validateExactDelegationPolicy,
} from "@tinycloud/agent-client";
import type { PortableDelegation } from "@tinycloud/agent-client";
import { currentPrivateAccess, DelegationExpiredError, NoDelegationError } from "@tinycloud/eliza-plugin-memory";
import { TRANSCRIPT_SOURCES } from "./actions/tinycloud-search-transcripts.js";
import type { TranscriptMetadata, TranscriptReader, TranscriptRegistry } from "./actions/tinycloud-search-transcripts.js";
import { checkContext, decodeBody, discoveryResult, MeetingRetrievalError, withinContext } from "./meeting-evidence.js";
import type { BodyResult, MeetingSelection, RetrievalContext } from "./meeting-evidence.js";
import { createTranscriptNode, TranscriptResponseLimitError } from "./transcript-transport.js";
import { COMBINED_SOURCE, combinedMemberKeys, isCombinedMember, readCombinedMembers } from "./combined-meetings.js";

const SQL_PATH = "xyz.tinycloud.tinychat/connectors";
const MAX_ENTRIES = Number(process.env.ELIZA_TRANSCRIPT_REGISTRY_MAX_CLIENTS) || 256;
// node-sdk (2.6.0 and 2.11.0) activates a child session lasting at most one hour, even when
// its portable parent is valid for days. Renew on the next read before expiry.
const SESSION_REFRESH_MS = 50 * 60 * 1000;
/** Bounded discovery: one row over the policy ceiling is the overflow sentinel. */
const METADATA_ROW_LIMIT = 501;
/** Voice notes: the commit index names the one readable revision (see readBody). */
const VOICE_NOTE_SOURCE = "exo-voice-note";
const VOICE_NOTE_INDEX = "voice_note_transcript";
const VOICE_NOTE_REV_PREFIX = `${SQL_PATH}/${VOICE_NOTE_SOURCE}/transcript-rev/`;
// Revision hash shape written by transcriptHash: first 32 hex characters of a SHA-256 digest.
const VOICE_NOTE_REV_HASH = /^[0-9a-f]{32}$/;
// Metadata mirror for listing and lookup. Prefilters to a transcribed outcome; with the commit index present, commitReadable then requires the commit row too.
const VOICE_NOTE_MIRROR_READABLE = "(CASE WHEN json_valid(metadata) THEN (json_extract(metadata, '$.transcription_outcome') = 'transcribed') ELSE 0 END)";

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
  isCurrent: () => boolean;
  canUse: () => boolean;
}

/** Per-entity transcript grants and renewable delegated access; never retains bodies. */
export class TranscriptAccessRegistry implements TranscriptRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, { serialized: string; roomId?: string; isCurrent?: () => boolean; canUse?: () => boolean; work: Promise<void> }>();
  private readonly generations = new Map<string, object>();
  private readonly roomToEntity = new Map<string, string>();
  /** Content-free follow-up state; transcript text is never retained here. */
  private readonly selectedMeetingByRoom = new Map<string, MeetingSelection>();

  constructor(
    private readonly args: {
      agentDid: string;
      agentKey: string;
      host: string;
      maxEntries?: number;
      /** Overrides the delegated-node client. Production leaves this unset. */
      nodeFactory?: (args: { privateKey: string; host: string }) => TranscriptNode;
    },
  ) {}

  /**
   * Activate and retain one entity's transcript grant.
   *
   * Only identical pending registrations coalesce. Every replacement fences
   * the old activation immediately; late work cannot install or drop its client.
   */
  async register(entityId: string, serializedDelegation: string, roomId?: string, isCurrent?: () => boolean, canUse?: () => boolean): Promise<void> {
    const inFlight = this.pending.get(entityId);
    if (inFlight?.serialized === serializedDelegation && inFlight.roomId === roomId && inFlight.isCurrent === isCurrent && inFlight.canUse === canUse) return inFlight.work;
    this.drop(entityId);
    const generation = {};
    this.generations.set(entityId, generation);
    const owns = () => this.generations.get(entityId) === generation && (isCurrent?.() ?? true);
    const work = this.activate(entityId, serializedDelegation, roomId, owns, canUse ?? (() => true));
    const pending = { serialized: serializedDelegation, roomId, isCurrent, canUse, work };
    this.pending.set(entityId, pending);
    try {
      await work;
    } catch (error) {
      if (owns()) this.drop(entityId);
      throw error;
    } finally {
      if (this.pending.get(entityId) === pending) this.pending.delete(entityId);
    }
  }

  /** Drop one entity's access (session stop, replacement, or explicit revocation). */
  revoke(entityId: string): void {
    this.drop(entityId);
  }

  readerFor(entityId: string, roomId?: string): TranscriptReader {
    const inheritedAccess = currentPrivateAccess();
    if (inheritedAccess && !inheritedAccess()) throw new NoDelegationError(entityId);
    // Room binding is an ISOLATION check, not an index: a room that another
    // entity owns must never resolve here. A room this registry has never seen
    // (tool dispatch synthesizes one when the caller omits it, and a user has
    // many threads per grant) is simply not a cross-entity collision.
    const roomOwner = roomId ? this.roomToEntity.get(roomId) : undefined;
    if (roomOwner !== undefined && roomOwner !== entityId) throw new NoDelegationError(entityId);
    const entry = this.entries.get(entityId);
    if (!entry || !entry.isCurrent() || !entry.canUse()) throw new NoDelegationError(entityId);
    if (Date.now() >= entry.expiry.getTime()) {
      this.drop(entityId);
      throw new DelegationExpiredError(entityId);
    }
    entry.lastUsed = Date.now();
    const assertAccess = () => {
      if (inheritedAccess && !inheritedAccess()) throw new NoDelegationError(entityId);
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
          entry.refresh = this.activateAccess(entry.delegation, assertAccess).then(access => {
            // Renewal preserves the entry and its selection. A late activation
            // must never restore a revoked, replaced, evicted, or stopped entry.
            assertAccess();
            entry.access = access;
            entry.refreshAt = startedAt + SESSION_REFRESH_MS;
          }, (error) => {
            if (error instanceof DelegationExpiredError) throw error;
            assertAccess();
            throw new MeetingRetrievalError("transcript_unavailable");
          }).finally(() => { entry.refresh = undefined; });
        }
        await entry.refresh;
      }
      assertAccess();
      return entry.access;
    }, assertAccess, () => { if (this.entries.get(entityId) === entry) this.drop(entityId); });
  }

  selectedMeetingFor(entityId: string, roomId?: string): string | null {
    this.readerFor(entityId, roomId);
    if (!roomId || this.roomToEntity.get(roomId) !== entityId) return null;
    const selection = this.selectedMeetingByRoom.get(roomId);
    return selection?.state === "single" ? selection.meetingRef : null;
  }

  selectMeeting(entityId: string, roomId: string | undefined, meetingRef: string): void {
    if (!roomId) return;
    this.readerFor(entityId, roomId);
    const roomOwner = this.roomToEntity.get(roomId);
    if (roomOwner !== undefined && roomOwner !== entityId) throw new NoDelegationError(entityId);
    if (!this.entries.has(entityId)) throw new NoDelegationError(entityId);
    this.roomToEntity.set(roomId, entityId);
    this.readerFor(entityId, roomId);
    this.selectedMeetingByRoom.set(roomId, { state: "single", meetingRef });
  }

  setSelection(entityId: string, roomId: string | undefined, selection: MeetingSelection): void {
    if (!roomId) return;
    this.readerFor(entityId, roomId);
    const owner = this.roomToEntity.get(roomId);
    if (owner !== undefined && owner !== entityId) throw new NoDelegationError(entityId);
    if (selection.state === "none") { this.selectedMeetingByRoom.delete(roomId); return; }
    this.readerFor(entityId, roomId);
    this.roomToEntity.set(roomId, entityId);
    this.selectedMeetingByRoom.set(roomId, selection);
  }

  /** True while this entity has a registered, unexpired parent grant. */
  has(entityId: string): boolean {
    const entry = this.entries.get(entityId);
    return entry !== undefined
      && entry.isCurrent()
      && Date.now() < entry.expiry.getTime();
  }

  async stop(): Promise<void> {
    this.entries.clear();
    this.roomToEntity.clear();
    this.selectedMeetingByRoom.clear();
    this.pending.clear();
    this.generations.clear();
  }

  private async activate(entityId: string, serialized: string, roomId: string | undefined, isCurrent: () => boolean, canUse: () => boolean): Promise<void> {
    const assertCurrent = () => { if (!isCurrent()) throw new NoDelegationError(entityId); };
    assertCurrent();
    const delegation = deserializeTranscriptDelegationForActivation(serialized);
    validateExactDelegationPolicy(delegation, { agentDID: this.args.agentDid, policy: defaultTinychatTranscriptPolicy() });
    const expiry = delegation.expiry instanceof Date ? delegation.expiry : new Date(delegation.expiry as unknown as string);
    const startedAt = Date.now();
    const access = await this.activateAccess(delegation, assertCurrent);
    assertCurrent();
    if (this.entries.size >= (this.args.maxEntries ?? MAX_ENTRIES)) this.evictLru();
    this.entries.set(entityId, { access, delegation, refreshAt: startedAt + SESSION_REFRESH_MS, expiry, lastUsed: Date.now(), roomId, isCurrent, canUse });
    if (roomId) {
      this.selectedMeetingByRoom.delete(roomId);
      this.roomToEntity.set(roomId, entityId);
    }
  }

  private async activateAccess(delegation: PortableDelegation, assertCurrent: () => void): Promise<Access> {
    // Build a fresh wallet session, then reactivate the same exact parent grant.
    const node = this.args.nodeFactory
      ? this.args.nodeFactory({ privateKey: this.args.agentKey, host: this.args.host })
      : createTranscriptNode({ privateKey: this.args.agentKey, host: this.args.host });
    await node.signIn();
    assertCurrent();
    const access = await node.useDelegation(delegation) as unknown as Access;
    assertCurrent();
    return access;
  }

  private drop(entityId: string): void {
    this.generations.delete(entityId);
    this.pending.delete(entityId);
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

const MARKER_KEYS = ["artifactType", "artifact_type", "type", "kind", "documentType", "document_type", "notes_kind", "notes_association"] as const;
/** Keep whole transcripts stored in `metadata` out of meeting-list responses. */
const METADATA_PROJECTION = `CASE WHEN json_valid(metadata) THEN json_object(${[
  ...MARKER_KEYS.map(key => `'${key}', CASE WHEN json_type(metadata, '$.${key}') = 'text' AND length(json_extract(metadata, '$.${key}')) < 100 THEN json_extract(metadata, '$.${key}') END`),
  "'transcript_count', CASE WHEN json_type(metadata, '$.transcript_count') IN ('integer', 'real') THEN json_extract(metadata, '$.transcript_count') END",
  "'merge', json_object('members', CASE json_type(metadata, '$.merge.members') WHEN 'array' THEN json(json_extract(metadata, '$.merge.members')) END)",
].join(", ")}) END`;
const COLUMNS = `id, source, source_id, title, started_at, organizer_email, participants, summary_overview, summary_action_items, ${METADATA_PROJECTION}`;
function decodeMetadata(row: unknown): TranscriptMetadata | null {
  if (!Array.isArray(row)) return null;
  const [meetingRef, source, sourceId, title, startedAt, organizerEmail, participants, summaryOverview, summaryActionItems, metadata] = row;
  if (typeof meetingRef !== "string" || !safeMeetingRef(meetingRef) || !isSource(source) || typeof sourceId !== "string" || !safeSegment(sourceId)) return null;
  const parsed = parseParticipants(participants);
  let provenance: unknown = metadata;
  if (typeof provenance === "string") { try { provenance = JSON.parse(provenance); } catch { provenance = undefined; } }
  // Only keep existing artifact type markers, never opaque provider metadata.
  const known: Record<string, unknown> = {};
  if (provenance && typeof provenance === "object") for (const key of MARKER_KEYS) {
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
/** Pinned SDK (2.11.0; wrapError unchanged since 2.6.0) preserves HTTP error details, but KV_NOT_FOUND alone is ambiguous. */
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
  const readKey = async (key: string, context: RetrievalContext): Promise<BodyResult> => {
    // Transcript-only transport caps decoded bytes before SDK buffering. Retain
    // the decoded-value check for injected readers and UTF-8 replacement growth.
    const response = await withinContext(signal => withAccess(signal, active => active.kv.get(key, { prefix: "", raw: true, signal })), context) as { ok?: boolean; error?: unknown; data?: { data?: unknown } };
    assertAccess();
    const body = response?.ok === true ? decodeBody(response.data?.data) : classifyBodyFailure(response?.error);
    enforceAccess(body); return body;
  };
  const readBody = async (source: TranscriptMetadata["source"], sourceId: string, context: RetrievalContext = {}): Promise<BodyResult> => {
    if (!isSource(source) || !safeSegment(sourceId)) throw new MeetingRetrievalError("invalid_stored_metadata");
    assertAccess();
    if (source === VOICE_NOTE_SOURCE && await hasVoiceNoteIndex(context)) {
      const [commit] = await query(`SELECT outcome, hash, body_key FROM ${VOICE_NOTE_INDEX} WHERE source_id = ? LIMIT 1`, [sourceId], context);
      // The index names the one committed revision. No commit row, or any outcome other than transcribed, has no readable body.
      if (!commit) return { state: "missing" };
      const [outcome, hash, bodyKey] = commit;
      // The body key must be exactly the writer's key for this source id and hash, so the index cannot reach any other KV key.
      if (outcome !== "transcribed" || typeof hash !== "string" || !VOICE_NOTE_REV_HASH.test(hash)
        || bodyKey !== `${VOICE_NOTE_REV_PREFIX}${sourceId}/${hash}`) return { state: "missing" };
      return readKey(bodyKey, context);
    }
    return readKey(`${SQL_PATH}/${source}/transcript/${sourceId}`, context);
  };
  // Member keys come from every combined row, never from the page being listed: a source filter or
  // date window could otherwise return members whose combined row is outside the result.
  // If this read fails the list proceeds without exclusion: a duplicate is recoverable, a hidden meeting is not.
  // Access and cancellation errors still propagate.
  // Projections for combined-meetings.ts: combined-key rows are (source, source_id, metadata); listed rows follow COLUMNS.
  const combinedColumns = (row: unknown[]) => ({ source: row[0], sourceId: row[1], metadata: row[2] });
  const listedColumns = (row: unknown[]) => ({ source: row[1], sourceId: row[2], metadata: row[9] });
  const combinedKeys = async (context: RetrievalContext = {}): Promise<Set<string>> => {
    try {
      return combinedMemberKeys(await query("SELECT source, source_id, metadata FROM connector_meeting WHERE source = ?", [COMBINED_SOURCE], context), combinedColumns);
    } catch (error) {
      // Only the generic unavailable failure fails open; access, timeout and cancellation errors propagate.
      if (error instanceof MeetingRetrievalError && error.code === "transcript_unavailable") return new Set();
      throw error;
    }
  };
  // Drops unreadable combined rows and every capture named by a readable combined row.
  const visibleRows = (rows: unknown[][], hidden: ReadonlySet<string>): unknown[][] => rows.filter(row =>
    !(row[1] === COMBINED_SOURCE && readCombinedMembers(row[9]) === null) && !isCombinedMember(row, hidden, listedColumns));
  // The commit index is absent in spaces that never saved a voice note; recheck until found.
  let voiceNoteIndexFound = false;
  const hasVoiceNoteIndex = async (context: RetrievalContext = {}): Promise<boolean> => {
    if (!voiceNoteIndexFound) voiceNoteIndexFound = (await query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", [VOICE_NOTE_INDEX], context)).length > 0;
    return voiceNoteIndexFound;
  };
  // SQL prefilter: the metadata mirror, which is also the whole readable test when the commit index table is absent. Other sources are unaffected.
  const readableClause = (): string => `(source != '${VOICE_NOTE_SOURCE}' OR source IS NULL OR ${VOICE_NOTE_MIRROR_READABLE})`;
  // With the commit index present, a listed voice note must be one readBody can read: same predicate (transcribed outcome,
  // writer-shaped hash, writer's exact body key), so a mirror/commit disagreement never lists an unreadable note.
  // The index is queried only when the page holds a voice note, so other sources cost no extra round trip.
  const commitReadable = async (rows: unknown[][], context: RetrievalContext = {}): Promise<unknown[][]> => {
    const ids = rows.flatMap(row => row[1] === VOICE_NOTE_SOURCE && typeof row[2] === "string" ? [row[2]] : []);
    if (ids.length === 0 || !await hasVoiceNoteIndex(context)) return rows;
    // The node SQL parser has no GLOB/REGEXP, so the lowercase-hex shape of the hash is checked here, not in SQL.
    const committed = await query(
      `SELECT source_id, hash FROM ${VOICE_NOTE_INDEX} WHERE outcome = 'transcribed' AND length(hash) = 32 AND body_key = '${VOICE_NOTE_REV_PREFIX}' || source_id || '/' || hash AND source_id IN (${ids.map(() => "?").join(", ")})`,
      ids, context);
    const readable = new Set(committed.filter(row => typeof row[1] === "string" && /^[0-9a-f]{32}$/.test(row[1])).map(row => row[0]));
    return rows.filter(row => row[1] !== VOICE_NOTE_SOURCE || readable.has(row[2]));
  };
  return {
    assertAccess,
    async listMetadata() {
      const readable = readableClause();
      const rows = await query(`SELECT ${COLUMNS} FROM connector_meeting WHERE ${readable} ORDER BY julianday(started_at) IS NULL ASC, julianday(started_at) DESC, id ASC LIMIT ${METADATA_ROW_LIMIT}`);
      const hidden = await combinedKeys();
      return visibleRows(await commitReadable(rows), hidden).flatMap(row => { const decoded = decodeMetadata(row); return decoded ? [decoded] : []; });
    },
    async getMetadata(reference, context = {}) {
      if (!safeMeetingRef(reference)) throw new MeetingRetrievalError("invalid_args", 400);
      const readable = readableClause();
      const rows = await query(`SELECT ${COLUMNS} FROM connector_meeting WHERE id = ? AND ${readable} LIMIT 1`, [reference], context);
      const hidden = await combinedKeys(context);
      // Check identity even when a faulty upstream ignores its predicate.
      return visibleRows(await commitReadable(rows, context), hidden).map(decodeMetadata).find(row => row?.meetingRef === reference) ?? null;
    },
    async discoverMetadata(args, context = {}) {
      const clauses: string[] = []; const params: Array<string | number | null> = [];
      if (args.source) { clauses.push("source = ?"); params.push(args.source); }
      // Conservative UTC superset for every IANA offset, followed by exact local-day checks.
      if (args.from) { clauses.push("julianday(started_at) >= julianday(?)"); params.push(new Date(Date.parse(args.from) - 86_400_000).toISOString()); }
      if (args.to) { clauses.push("julianday(started_at) < julianday(?)"); params.push(new Date(Date.parse(args.to) + 2 * 86_400_000).toISOString()); }
      clauses.push(readableClause());
      const rows = await query(`SELECT ${COLUMNS} FROM connector_meeting${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY julianday(started_at) IS NULL ASC, julianday(started_at) ${args.sort === "oldest" ? "ASC" : "DESC"}, id ASC LIMIT ${METADATA_ROW_LIMIT}`, params, context);
      const hidden = await combinedKeys(context);
      // The raw row count (before exclusion) decides scanLimited, so rows past the read window stay counted as unseen.
      const decoded = visibleRows(await commitReadable(rows.slice(0, 500), context), hidden).flatMap(row => { const value = decodeMetadata(row); return value ? [value] : []; });
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
  return (TRANSCRIPT_SOURCES as readonly unknown[]).includes(value);
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
