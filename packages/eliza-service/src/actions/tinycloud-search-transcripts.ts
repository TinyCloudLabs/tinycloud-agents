import type { Action, Content, IAgentRuntime, Memory, Plugin, ProviderDataRecord } from "@elizaos/core";
import { ToolError } from "../handlers/tools.js";

export const TINYCLOUD_FIND_MEETINGS = "tinycloud_find_meetings";
export const TINYCLOUD_READ_MEETING = "tinycloud_read_meeting";
export const TINYCLOUD_SEARCH_TRANSCRIPTS = "tinycloud_search_transcripts";
export const TINYCLOUD_LIST_MEETING_ACTIONS = "tinycloud_list_meeting_actions";

type TranscriptSource = "fireflies" | "google-meet" | "tinycloud-transcriber";
type SortOrder = "newest" | "oldest";

interface MeetingFilters {
  title?: string;
  participant?: string;
  from?: string;
  to?: string;
  source?: TranscriptSource;
}

export interface FindMeetingsArgs extends MeetingFilters { sort?: SortOrder; selectFirst?: boolean }
export interface ReadMeetingArgs {
  meetingRef?: string;
  focus: "summary" | "actions" | "decisions" | "speaker" | "transcript";
  query?: string;
  speaker?: string;
}
export interface TranscriptSearchArgs extends MeetingFilters { query: string; speaker?: string; meetingRef?: string }
export interface ListMeetingActionsArgs extends MeetingFilters { assignee?: string }

const SOURCES = ["fireflies", "google-meet", "tinycloud-transcriber"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseBoundedString(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function parseFilters(args: Record<string, unknown>): MeetingFilters | null {
  const title = parseBoundedString(args.title, 160);
  const participant = parseBoundedString(args.participant, 160);
  if (title === null || participant === null) return null;
  if (args.from !== undefined && (typeof args.from !== "string" || !DATE_RE.test(args.from))) return null;
  if (args.to !== undefined && (typeof args.to !== "string" || !DATE_RE.test(args.to))) return null;
  if (args.source !== undefined && !SOURCES.includes(args.source as TranscriptSource)) return null;
  return {
    ...(title ? { title } : {}),
    ...(participant ? { participant } : {}),
    ...(typeof args.from === "string" ? { from: args.from } : {}),
    ...(typeof args.to === "string" ? { to: args.to } : {}),
    ...(args.source !== undefined ? { source: args.source as TranscriptSource } : {}),
  };
}

export function parseFindMeetingsArgs(args: Record<string, unknown>): FindMeetingsArgs | null {
  const allowed = new Set(["title", "participant", "from", "to", "source", "sort", "selectFirst"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return null;
  const filters = parseFilters(args);
  if (!filters) return null;
  if (args.sort !== undefined && args.sort !== "newest" && args.sort !== "oldest") return null;
  if (args.selectFirst !== undefined && typeof args.selectFirst !== "boolean") return null;
  return {
    ...filters,
    ...(args.sort ? { sort: args.sort as SortOrder } : {}),
    ...(typeof args.selectFirst === "boolean" ? { selectFirst: args.selectFirst } : {}),
  };
}

export function parseReadMeetingArgs(args: Record<string, unknown>): ReadMeetingArgs | null {
  const allowed = new Set(["meetingRef", "focus", "query", "speaker"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return null;
  const meetingRef = parseBoundedString(args.meetingRef, 128);
  const query = parseBoundedString(args.query, 500);
  const speaker = parseBoundedString(args.speaker, 160);
  if (meetingRef === null || query === null || speaker === null) return null;
  if (!["summary", "actions", "decisions", "speaker", "transcript"].includes(args.focus as string)) return null;
  if (args.focus === "speaker" && !speaker) return null;
  return {
    focus: args.focus as ReadMeetingArgs["focus"],
    ...(meetingRef ? { meetingRef } : {}),
    ...(query ? { query } : {}),
    ...(speaker ? { speaker } : {}),
  };
}

export function parseTranscriptSearchArgs(args: Record<string, unknown>): TranscriptSearchArgs | null {
  const allowed = new Set(["query", "title", "participant", "speaker", "meetingRef", "from", "to", "source"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return null;
  const filters = parseFilters(args);
  const query = parseBoundedString(args.query, 500);
  const speaker = parseBoundedString(args.speaker, 160);
  const meetingRef = parseBoundedString(args.meetingRef, 128);
  if (!filters || !query || speaker === null || meetingRef === null) return null;
  return { query, ...filters, ...(speaker ? { speaker } : {}), ...(meetingRef ? { meetingRef } : {}) };
}

export function parseListMeetingActionsArgs(args: Record<string, unknown>): ListMeetingActionsArgs | null {
  const allowed = new Set(["title", "participant", "from", "to", "source", "assignee"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return null;
  const filters = parseFilters(args);
  const assignee = parseBoundedString(args.assignee, 160);
  if (!filters || assignee === null) return null;
  return { ...filters, ...(assignee ? { assignee } : {}) };
}

export const TINYCLOUD_CONNECTORS_SQL_PATH = "xyz.tinycloud.tinychat/connectors";
export const TINYCLOUD_CONNECTORS_KV_PREFIX = `${TINYCLOUD_CONNECTORS_SQL_PATH}/`;
const MAX_METADATA_ROWS = 500;
const MAX_BODIES = 12;
const MAX_FIND_RESULTS = 5;
const MAX_MATCHES = 4;
const MAX_ACTION_MEETINGS = 8;
const MAX_ACTIONS_PER_MEETING = 8;
const MAX_EXCERPTS_PER_MATCH = 4;
const MAX_EXCERPT_CHARS = 1_400;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_TITLE_CHARS = 300;
const MAX_SERIALIZED_RESULT_CHARS = 16_000;

export interface TranscriptMetadata {
  meetingRef: string;
  source: TranscriptSource;
  sourceId: string;
  title: string | null;
  startedAt: string | null;
  participantNames: string[];
  participantEmails: string[];
  organizerEmail: string | null;
  summaryOverview: string | null;
  summaryActionItems: string | null;
}

export interface TranscriptReader {
  listMetadata(): Promise<TranscriptMetadata[]>;
  getTranscript(source: TranscriptSource, sourceId: string): Promise<unknown | null>;
}

export interface TranscriptRegistry {
  readerFor(entityId: string, roomId?: string): TranscriptReader;
  selectedMeetingFor(entityId: string, roomId?: string): string | null;
  selectMeeting(entityId: string, roomId: string | undefined, meetingRef: string): void;
}

const registries = new WeakMap<object, TranscriptRegistry>();
export function setTranscriptRegistry(runtime: object, registry: TranscriptRegistry | null): void {
  if (registry) registries.set(runtime, registry); else registries.delete(runtime);
}
export function transcriptRegistryFor(runtime: object | null | undefined): TranscriptRegistry | null {
  return runtime ? registries.get(runtime) ?? null : null;
}

interface TranscriptExcerpt { citation: string; text: string; speaker?: string; startSecs?: number }
interface TranscriptMatch {
  citation: string;
  meetingRef: string;
  source: TranscriptSource;
  title: string | null;
  startedAt: string | null;
  excerpts: TranscriptExcerpt[];
}
interface Sentence { text: string; speaker?: string; startSecs?: number }

function escapeEvidence(text: string): string {
  return text.replace(/<\/?(?:system|tool|assistant|user|instructions?)\b/gi, (token) => token.replace("<", "&lt;"));
}
function safeEvidence(text: string, max: number): string { return escapeEvidence(text).slice(0, max) }
function formatOffset(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const parts = [Math.floor(total / 3_600), Math.floor((total % 3_600) / 60), total % 60];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}
function excerptCitation(meetingIndex: number, excerptIndex: number, excerpt: Omit<TranscriptExcerpt, "citation">): string {
  const attribution = [excerpt.speaker, excerpt.startSecs !== undefined ? formatOffset(excerpt.startSecs) : undefined]
    .filter((part): part is string => part !== undefined && part !== "");
  const identity = `M${meetingIndex}:E${excerptIndex}`;
  return attribution.length > 0 ? `[${identity}, ${attribution.join(", ")}]` : `[${identity}]`;
}

function sentencesOf(transcript: unknown): Sentence[] {
  if (typeof transcript === "string") return transcript ? [{ text: transcript }] : [];
  if (!Array.isArray(transcript)) return [];
  return transcript.flatMap((entry): Sentence[] => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.text !== "string" || value.text.trim() === "") return [];
    const speaker = [value.speaker_name, value.speaker, value.speakerName]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "");
    const startSecs = [value.start_time, value.startTime]
      .find((candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0);
    return [{ text: value.text, ...(speaker ? { speaker } : {}), ...(startSecs !== undefined ? { startSecs } : {}) }];
  });
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1))];
}

function excerptsFor(query: string | undefined, transcript: unknown, options: { speaker?: string; actionOnly?: boolean } = {}): Array<Omit<TranscriptExcerpt, "citation">> {
  const speakerNeedle = options.speaker?.toLowerCase();
  const terms = queryTerms(query ?? "");
  const actionRe = /\b(?:action item|to-?do|follow up|i(?:'ll| will| need to| have to)|we(?:'ll| will| need to| have to)|send|schedule|prepare|share|confirm|review|deliver)\b/i;
  const scored = sentencesOf(transcript)
    .map((sentence, index) => {
      if (speakerNeedle && !sentence.speaker?.toLowerCase().includes(speakerNeedle)) return null;
      if (options.actionOnly && !actionRe.test(sentence.text)) return null;
      const haystack = `${sentence.speaker ?? ""} ${sentence.text}`.toLowerCase();
      const score = terms.length === 0 ? 1 : terms.filter((term) => haystack.includes(term)).length;
      return score === 0 ? null : { sentence, index, score };
    })
    .filter((entry): entry is { sentence: Sentence; index: number; score: number } => entry !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_EXCERPTS_PER_MATCH)
    .sort((a, b) => a.index - b.index);
  return scored.map(({ sentence }) => ({
    text: safeEvidence(sentence.text, MAX_EXCERPT_CHARS),
    ...(sentence.speaker ? { speaker: safeEvidence(sentence.speaker, 120) } : {}),
    ...(sentence.startSecs !== undefined ? { startSecs: sentence.startSecs } : {}),
  }));
}

function normalized(value: string): string { return value.trim().toLowerCase() }
function participantHaystack(row: TranscriptMetadata): string {
  return [...row.participantNames, ...row.participantEmails, row.organizerEmail ?? ""].join(" ").toLowerCase();
}
function calendarDay(iso: string, timeZone?: string): string {
  if (!timeZone) return iso.slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(iso));
    const value = (type: "year" | "month" | "day") => parts.find((part) => part.type === type)?.value ?? "";
    return `${value("year")}-${value("month")}-${value("day")}`;
  } catch {
    return iso.slice(0, 10);
  }
}

function filterMeetings(rows: TranscriptMetadata[], filters: MeetingFilters, timeZone?: string): TranscriptMetadata[] {
  const title = filters.title ? normalized(filters.title) : null;
  const participant = filters.participant ? normalized(filters.participant) : null;
  return rows.filter((row) =>
    (!filters.source || row.source === filters.source)
    && (!title || row.title?.toLowerCase().includes(title))
    && (!participant || participantHaystack(row).includes(participant))
    && (!filters.from || (row.startedAt !== null && calendarDay(row.startedAt, timeZone) >= filters.from))
    && (!filters.to || (row.startedAt !== null && calendarDay(row.startedAt, timeZone) <= filters.to)),
  );
}
function sortMeetings(rows: TranscriptMetadata[], order: SortOrder = "newest"): TranscriptMetadata[] {
  const direction = order === "newest" ? -1 : 1;
  return [...rows].sort((a, b) => ((a.startedAt ?? "").localeCompare(b.startedAt ?? "") * direction) || a.meetingRef.localeCompare(b.meetingRef));
}
async function metadata(reader: TranscriptReader): Promise<{ rows: TranscriptMetadata[]; truncated: boolean }> {
  let rows: TranscriptMetadata[];
  try { rows = await reader.listMetadata(); } catch { throw new ToolError("meeting metadata unavailable", 503, "transcript_unavailable"); }
  return { rows: rows.slice(0, MAX_METADATA_ROWS), truncated: rows.length > MAX_METADATA_ROWS };
}
function publicMeeting(row: TranscriptMetadata, index: number) {
  return {
    citation: `[M${index}]`, meetingRef: row.meetingRef, source: row.source,
    title: row.title === null ? null : safeEvidence(row.title, MAX_TITLE_CHARS), startedAt: row.startedAt,
    participants: row.participantNames.slice(0, 20).map((name) => safeEvidence(name, 120)),
    organizerEmail: row.organizerEmail === null ? null : safeEvidence(row.organizerEmail, 254),
  };
}

export async function findMeetings(reader: TranscriptReader, args: FindMeetingsArgs, timeZone?: string) {
  const discovered = await metadata(reader);
  const candidates = sortMeetings(filterMeetings(discovered.rows, args, timeZone), args.sort ?? "newest");
  const meetings = candidates.slice(0, MAX_FIND_RESULTS).map((row, index) => publicMeeting(row, index + 1));
  const truncated = discovered.truncated || candidates.length > meetings.length;
  return {
    text: `Found ${candidates.length} matching meetings; returned ${meetings.length} bounded metadata result${meetings.length === 1 ? "" : "s"}. Copy each exact citation field after any meeting fact in the answer.`,
    data: { corpus: { candidateCount: candidates.length, returnedCount: meetings.length, truncated, partial: false }, meetings },
  };
}

export async function searchTranscripts(reader: TranscriptReader, args: TranscriptSearchArgs, timeZone?: string) {
  const discovered = await metadata(reader);
  let filtered = filterMeetings(discovered.rows, args, timeZone);
  if (args.meetingRef) filtered = filtered.filter((row) => row.meetingRef === args.meetingRef);
  const candidates = sortMeetings(filtered, "newest").sort((a, b) => {
    const needle = args.query.toLowerCase();
    const relevance = Number(`${b.title ?? ""} ${participantHaystack(b)}`.toLowerCase().includes(needle))
      - Number(`${a.title ?? ""} ${participantHaystack(a)}`.toLowerCase().includes(needle));
    return relevance || (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
  });
  let truncated = discovered.truncated || candidates.length > MAX_BODIES;
  let partial = false;
  const matches: TranscriptMatch[] = [];
  let examinedCount = 0;
  for (const row of candidates.slice(0, MAX_BODIES)) {
    examinedCount += 1;
    let transcript: unknown | null;
    try { transcript = await reader.getTranscript(row.source, row.sourceId); } catch { partial = true; continue; }
    if (!transcript) continue;
    const excerpts = excerptsFor(args.query, transcript, { speaker: args.speaker });
    if (excerpts.length === 0) continue;
    if (matches.length >= MAX_MATCHES) { truncated = true; continue; }
    const index = matches.length + 1;
    matches.push({
      citation: `[M${index}]`, meetingRef: row.meetingRef, source: row.source,
      title: row.title === null ? null : safeEvidence(row.title, MAX_TITLE_CHARS), startedAt: row.startedAt,
      excerpts: excerpts.map((excerpt, excerptIndex) => ({ citation: excerptCitation(index, excerptIndex + 1, excerpt), ...excerpt })),
    });
  }
  const data = { corpus: { candidateCount: candidates.length, examinedCount, matchedCount: matches.length, truncated, partial }, matches };
  while (matches.length > 0 && JSON.stringify(data).length > MAX_SERIALIZED_RESULT_CHARS) {
    matches.pop(); data.corpus.matchedCount = matches.length; data.corpus.truncated = true;
  }
  return { text: `Found cited evidence in ${matches.length} of ${examinedCount} examined transcripts. Copy each exact citation field after the claim it supports.${(data.corpus.truncated || partial) ? " Results are bounded; answer only from retained evidence." : ""}`, data };
}

function actionItemsOf(value: string | null): string[] {
  if (!value) return [];
  const items: string[] = [];
  let assigneeHeading: string | null = null;
  for (const rawLine of value.split(/\r?\n|(?<=\.)\s+(?=[A-Z])/)) {
    const raw = rawLine.trim();
    if (!raw) continue;
    const heading = raw.match(/^(?:#{1,6}\s*)?\*{1,2}([^*]+)\*{1,2}:?$/);
    if (heading) {
      assigneeHeading = heading[1]!.trim();
      continue;
    }
    const bullet = raw.match(/^\s*(?:[-*•]|\d+[.)])\s*(?:\[[ xX]\]\s*)?(.*)$/);
    const text = (bullet?.[1] ?? raw).replace(/\*\*([^*]+)\*\*/g, "$1").trim();
    if (text.length < 4 || !/[A-Za-z0-9]/.test(text)) continue;
    items.push(safeEvidence(bullet && assigneeHeading ? `${assigneeHeading}: ${text}` : text, 800));
    if (items.length >= MAX_ACTIONS_PER_MEETING) break;
  }
  return items;
}

export async function readMeeting(reader: TranscriptReader, args: ReadMeetingArgs & { meetingRef: string }) {
  const discovered = await metadata(reader);
  const row = discovered.rows.find((candidate) => candidate.meetingRef === args.meetingRef);
  if (!row) throw new ToolError("meeting not found", 404, "meeting_not_found");
  const overview = row.summaryOverview ? safeEvidence(row.summaryOverview, MAX_SUMMARY_CHARS) : null;
  const actionItems = actionItemsOf(row.summaryActionItems);
  let partial = discovered.truncated;
  let transcriptRead = false;
  let excerpts: Array<Omit<TranscriptExcerpt, "citation">> = [];
  const needsTranscript = args.focus === "speaker" || args.focus === "transcript" || args.focus === "decisions"
    || (args.focus === "actions" && actionItems.length === 0)
    || (args.focus === "summary" && overview === null && actionItems.length === 0);
  if (needsTranscript) {
    transcriptRead = true;
    try {
      const transcript = await reader.getTranscript(row.source, row.sourceId);
      const query = args.focus === "decisions" ? (args.query ?? "decided decision agreed chose final") : args.query;
      excerpts = excerptsFor(query, transcript, { ...(args.speaker ? { speaker: args.speaker } : {}), actionOnly: args.focus === "actions" });
    } catch { partial = true; }
  }
  const data = {
    meeting: publicMeeting(row, 1), focus: args.focus,
    summary: overview === null ? null : { citation: "[M1:S]", text: overview },
    actionItems: actionItems.map((text, index) => ({ citation: `[M1:A${index + 1}]`, text })),
    excerpts: excerpts.map((excerpt, index) => ({ citation: excerptCitation(1, index + 1, excerpt), ...excerpt })),
    corpus: { transcriptRead, truncated: discovered.truncated, partial },
  };
  return { text: `Read ${args.focus} evidence for the selected meeting. Copy each exact citation field after the claim it supports.${partial ? " Some evidence was unavailable; do not overstate completeness." : ""}`, data };
}

export async function listMeetingActions(reader: TranscriptReader, args: ListMeetingActionsArgs, timeZone?: string) {
  const discovered = await metadata(reader);
  const candidates = sortMeetings(filterMeetings(discovered.rows, args, timeZone), "newest");
  let truncated = discovered.truncated || candidates.length > MAX_BODIES;
  let partial = false;
  let examinedCount = 0;
  let transcriptFallbackCount = 0;
  const matches: Array<{
    citation: string; meetingRef: string; source: TranscriptSource; title: string | null; startedAt: string | null;
    actionItems: Array<{ citation: string; text: string }>; transcriptCandidates: TranscriptExcerpt[];
  }> = [];
  for (const row of candidates.slice(0, MAX_BODIES)) {
    examinedCount += 1;
    let items = actionItemsOf(row.summaryActionItems);
    if (args.assignee) items = items.filter((item) => item.toLowerCase().includes(args.assignee!.toLowerCase()));
    let fallback: Array<Omit<TranscriptExcerpt, "citation">> = [];
    if (items.length === 0 && !args.assignee) {
      transcriptFallbackCount += 1;
      try { fallback = excerptsFor(undefined, await reader.getTranscript(row.source, row.sourceId), { actionOnly: true }); }
      catch { partial = true; }
    }
    if (items.length === 0 && fallback.length === 0) continue;
    if (matches.length >= MAX_ACTION_MEETINGS) { truncated = true; continue; }
    const index = matches.length + 1;
    matches.push({
      citation: `[M${index}]`, meetingRef: row.meetingRef, source: row.source,
      title: row.title === null ? null : safeEvidence(row.title, MAX_TITLE_CHARS), startedAt: row.startedAt,
      actionItems: items.map((text, actionIndex) => ({ citation: `[M${index}:A${actionIndex + 1}]`, text })),
      transcriptCandidates: fallback.map((excerpt, excerptIndex) => ({ citation: excerptCitation(index, excerptIndex + 1, excerpt), ...excerpt })),
    });
  }
  const data = {
    corpus: { candidateCount: candidates.length, examinedCount, matchedCount: matches.length, transcriptFallbackCount, truncated, partial, assigneeFilterApplied: Boolean(args.assignee) },
    matches,
  };
  while (matches.length > 0 && JSON.stringify(data).length > MAX_SERIALIZED_RESULT_CHARS) {
    matches.pop(); data.corpus.matchedCount = matches.length; data.corpus.truncated = true;
  }
  return { text: `Found explicit or candidate action evidence in ${matches.length} of ${examinedCount} examined meetings. Copy each exact citation field after the claim it supports.${(truncated || partial) ? " Coverage is bounded; report that limitation." : ""}`, data };
}

function isNamedError(error: unknown, name: string): boolean { return (error as { name?: unknown } | null)?.name === name }
function toolContext(runtime: IAgentRuntime, message: Memory): { registry: TranscriptRegistry; reader: TranscriptReader } {
  const registry = transcriptRegistryFor(runtime as unknown as object);
  if (!registry) throw new ToolError("transcript delegation required", 409, "delegation_required");
  try { return { registry, reader: registry.readerFor(message.entityId, message.roomId) }; }
  catch (error) {
    if (error instanceof ToolError) throw error;
    if (isNamedError(error, "DelegationExpiredError")) throw new ToolError("transcript delegation expired", 409, "delegation_expired");
    throw new ToolError("transcript delegation required", 409, "delegation_required");
  }
}
async function finish(callback: ((content: Content) => Promise<unknown>) | undefined, result: { text: string; data: Record<string, unknown> }) {
  if (callback) await callback({ text: result.text });
  return { success: true, text: result.text, data: result.data as ProviderDataRecord };
}
function rawArgs(message: Memory, options: unknown): Record<string, unknown> {
  return (options as { args?: Record<string, unknown> } | undefined)?.args ?? { query: message.content?.text };
}
function toolTimeZone(options: unknown): string | undefined {
  const value = (options as { context?: { timeZone?: unknown } } | undefined)?.context?.timeZone;
  return typeof value === "string" ? value : undefined;
}

export const tinycloudFindMeetingsAction: Action = {
  name: "TINYCLOUD_FIND_MEETINGS", description: "Find private meetings by metadata without reading transcript bodies.", similes: [TINYCLOUD_FIND_MEETINGS], examples: [],
  validate: async (_runtime, message, _state, options) => parseFindMeetingsArgs(rawArgs(message, options)) !== null,
  handler: async (runtime, message, _state, options, callback) => {
    const args = parseFindMeetingsArgs(rawArgs(message, options));
    if (!args) throw new ToolError("invalid meeting finder arguments", 400, "invalid_args");
    const { registry, reader } = toolContext(runtime, message);
    const result = await findMeetings(reader, args, toolTimeZone(options));
    const first = result.data.meetings[0];
    if (first && (result.data.corpus.candidateCount === 1 || args.selectFirst === true)) {
      registry.selectMeeting(message.entityId, message.roomId, first.meetingRef);
    }
    return finish(callback, result);
  },
};

export const tinycloudReadMeetingAction: Action = {
  name: "TINYCLOUD_READ_MEETING", description: "Read cited evidence from one selected private meeting.", similes: [TINYCLOUD_READ_MEETING], examples: [],
  validate: async (_runtime, message, _state, options) => parseReadMeetingArgs(rawArgs(message, options)) !== null,
  handler: async (runtime, message, _state, options, callback) => {
    const args = parseReadMeetingArgs(rawArgs(message, options));
    if (!args) throw new ToolError("invalid meeting reader arguments", 400, "invalid_args");
    const { registry, reader } = toolContext(runtime, message);
    const selectedMeetingRef = registry.selectedMeetingFor(message.entityId, message.roomId);
    // Display citations are intentionally not durable identifiers. Models can
    // still echo one into meetingRef on an anaphoric follow-up, so resolve only
    // citation-shaped aliases against this room's content-free selection.
    const requestedMeetingRef = args.meetingRef;
    const meetingRef = requestedMeetingRef && /^\[?M\d+\]?$/i.test(requestedMeetingRef)
      ? selectedMeetingRef
      : requestedMeetingRef ?? selectedMeetingRef;
    if (!meetingRef) throw new ToolError("select a meeting first", 409, "meeting_selection_required");
    const result = await readMeeting(reader, { ...args, meetingRef });
    registry.selectMeeting(message.entityId, message.roomId, meetingRef);
    return finish(callback, result);
  },
};

export const tinycloudSearchTranscriptsAction: Action = {
  name: "TINYCLOUD_SEARCH_TRANSCRIPTS", description: "Search private meeting content for a topic or phrase.", similes: [TINYCLOUD_SEARCH_TRANSCRIPTS], examples: [],
  validate: async (_runtime, message, _state, options) => parseTranscriptSearchArgs(rawArgs(message, options)) !== null,
  handler: async (runtime, message, _state, options, callback) => {
    const args = parseTranscriptSearchArgs(rawArgs(message, options));
    if (!args) throw new ToolError("invalid transcript search arguments", 400, "invalid_args");
    const { registry, reader } = toolContext(runtime, message);
    const result = await searchTranscripts(reader, args, toolTimeZone(options));
    if (result.data.matches.length === 1) registry.selectMeeting(message.entityId, message.roomId, result.data.matches[0]!.meetingRef);
    return finish(callback, result);
  },
};

export const tinycloudListMeetingActionsAction: Action = {
  name: "TINYCLOUD_LIST_MEETING_ACTIONS", description: "Aggregate explicit action evidence across a bounded meeting date range.", similes: [TINYCLOUD_LIST_MEETING_ACTIONS], examples: [],
  validate: async (_runtime, message, _state, options) => parseListMeetingActionsArgs(rawArgs(message, options)) !== null,
  handler: async (runtime, message, _state, options, callback) => {
    const args = parseListMeetingActionsArgs(rawArgs(message, options));
    if (!args) throw new ToolError("invalid meeting actions arguments", 400, "invalid_args");
    const { reader } = toolContext(runtime, message);
    return finish(callback, await listMeetingActions(reader, args, toolTimeZone(options)));
  },
};

export const tinycloudSearchTranscriptsPlugin: Plugin = {
  name: "tinycloud-meeting-tools",
  description: "Bounded read-only delegated TinyCloud meeting discovery and evidence tools.",
  actions: [tinycloudFindMeetingsAction, tinycloudReadMeetingAction, tinycloudSearchTranscriptsAction, tinycloudListMeetingActionsAction],
};
