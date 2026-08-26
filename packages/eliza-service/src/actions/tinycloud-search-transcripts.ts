import type { Action, Content, IAgentRuntime, Memory, Plugin } from "@elizaos/core";
import { ToolError } from "../handlers/tools.js";

/**
 * Fixed-name action contract.  The implementation deliberately accepts no SQL,
 * TinyCloud path, space, or caller-controlled result limit.
 */
export const TINYCLOUD_SEARCH_TRANSCRIPTS = "tinycloud_search_transcripts";

export interface TranscriptSearchArgs {
  query: string;
  title?: string;
  from?: string;
  to?: string;
  source?: "fireflies" | "google-meet" | "tinycloud-transcriber";
  recent?: boolean;
}

export function parseTranscriptSearchArgs(args: Record<string, unknown>): TranscriptSearchArgs | null {
  const allowed = new Set(["query", "title", "from", "to", "source", "recent"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return null;
  if (typeof args.query !== "string" || args.query.length === 0 || args.query.length > 500) return null;
  if (args.title !== undefined && (typeof args.title !== "string" || args.title.length > 160)) return null;
  if (args.from !== undefined && typeof args.from !== "string") return null;
  if (args.to !== undefined && typeof args.to !== "string") return null;
  if (args.recent !== undefined && typeof args.recent !== "boolean") return null;
  if (args.source !== undefined && !["fireflies", "google-meet", "tinycloud-transcriber"].includes(args.source as string)) return null;
  // The preceding runtime checks establish every property of this narrow tool
  // contract.  `Record<string, unknown>` cannot express that refinement to TS.
  return {
    query: args.query,
    ...(typeof args.title === "string" ? { title: args.title } : {}),
    ...(typeof args.from === "string" ? { from: args.from } : {}),
    ...(typeof args.to === "string" ? { to: args.to } : {}),
    ...(args.source !== undefined ? { source: args.source as TranscriptSearchArgs["source"] } : {}),
    ...(typeof args.recent === "boolean" ? { recent: args.recent } : {}),
  };
}

/** Fixed TinyChat connector paths. They are never model-controlled. */
export const TINYCLOUD_CONNECTORS_SQL_PATH = "xyz.tinycloud.tinychat/connectors";
export const TINYCLOUD_CONNECTORS_KV_PREFIX = `${TINYCLOUD_CONNECTORS_SQL_PATH}/`;
const MAX_METADATA_ROWS = 500;
const MAX_BODIES = 12;
const MAX_MATCHES = 4;
const MAX_EXCERPTS_PER_MATCH = 4;
const MAX_EXCERPT_CHARS = 1_400;
const MAX_TITLE_CHARS = 300;
const MAX_SERIALIZED_RESULT_CHARS = 16_000;

export interface TranscriptMetadata {
  source: "fireflies" | "google-meet" | "tinycloud-transcriber";
  sourceId: string;
  title: string | null;
  startedAt: string | null;
}

/** The only I/O seam used by the action; both calls are fixed-path reads. */
export interface TranscriptReader {
  listMetadata(): Promise<TranscriptMetadata[]>;
  getTranscript(source: TranscriptMetadata["source"], sourceId: string): Promise<unknown | null>;
}

/**
 * Per-entity resolution of an ALREADY-ACTIVATED transcript delegation.
 *
 * There is deliberately no way to install a reader for an entity from outside
 * the activation path: the only implementation is TranscriptAccessRegistry,
 * which is bound to a runtime by RuntimeHost after it has validated and
 * activated that entity's separately scoped transcript grant.  A tool
 * invocation therefore cannot select a path, SQL statement, space, or entity.
 */
export interface TranscriptRegistry {
  readerFor(entityId: string, roomId?: string): TranscriptReader;
}

// Keyed by runtime so a second booted agent cannot observe or overwrite another
// agent's activated access (a module-level singleton would let the last boot win).
const registries = new WeakMap<object, TranscriptRegistry>();

/** Installed by RuntimeHost during production boot; no plaintext is retained here. */
export function setTranscriptRegistry(runtime: object, registry: TranscriptRegistry | null): void {
  if (registry) registries.set(runtime, registry);
  else registries.delete(runtime);
}

export function transcriptRegistryFor(runtime: object | null | undefined): TranscriptRegistry | null {
  return runtime ? registries.get(runtime) ?? null : null;
}

interface TranscriptExcerpt {
  citation: string;
  text: string;
  speaker?: string;
  startSecs?: number;
}

interface TranscriptMatch {
  citation: string;
  source: TranscriptMetadata["source"];
  sourceId: string;
  title: string | null;
  startedAt: string | null;
  excerpts: TranscriptExcerpt[];
}

export interface TranscriptSearchResult {
  text: string;
  data: {
    corpus: { candidateCount: number; examinedCount: number; matchedCount: number; truncated: boolean; partial: boolean };
    matches: TranscriptMatch[];
  };
}

function escapeEvidence(text: string): string {
  // Transcript content is evidence, never instructions. Delimiters make that
  // boundary explicit to the synthesis model without changing the source text.
  return text.replace(/<\/?(?:system|tool|assistant|user|instructions?)\b/gi, (token) => token.replace("<", "&lt;"));
}

/** Render a known offset; never invent one when the source omitted it. */
function formatOffset(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const parts = [Math.floor(total / 3_600), Math.floor((total % 3_600) / 60), total % 60];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

function excerptCitation(matchIndex: number, excerptIndex: number, excerpt: Omit<TranscriptExcerpt, "citation">): string {
  const attribution = [
    excerpt.speaker,
    excerpt.startSecs !== undefined ? formatOffset(excerpt.startSecs) : undefined,
  ].filter((part): part is string => part !== undefined && part !== "");
  const identity = `T${matchIndex}:E${excerptIndex}`;
  return attribution.length > 0 ? `[${identity}, ${attribution.join(", ")}]` : `[${identity}]`;
}

interface Sentence { text: string; speaker?: string; startSecs?: number }

/**
 * Accept the stored Fireflies sentence shape (`{ text, speaker_name, start_time }`,
 * plus the camelCase variants TinyChat also writes) and the legacy plain-string body.
 * Anything else yields no sentences, which the caller reports as an unmatched meeting.
 */
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
    return [{
      text: value.text,
      ...(speaker !== undefined ? { speaker } : {}),
      ...(startSecs !== undefined ? { startSecs } : {}),
    }];
  });
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1))];
}

/**
 * Deterministic lexical selection over the SOURCE sentences.
 *
 * Each returned excerpt keeps the speaker and offset of the sentence it was cut
 * from, so an attribution is never transplanted from an unrelated sentence.
 */
function excerptsFor(query: string, transcript: unknown): Array<Omit<TranscriptExcerpt, "citation">> {
  const sentences = sentencesOf(transcript);
  if (sentences.length === 0) return [];
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const scored = sentences
    .map((sentence, index) => {
      const haystack = sentence.text.toLowerCase();
      return { sentence, index, score: terms.filter((term) => haystack.includes(term)).length };
    })
    .filter((entry) => entry.score > 0)
    // Highest term coverage first; source order breaks every tie so the same
    // corpus always produces the same citations.
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_EXCERPTS_PER_MATCH)
    .sort((a, b) => a.index - b.index);

  return scored.map(({ sentence }) => ({
    text: escapeEvidence(sentence.text.slice(0, MAX_EXCERPT_CHARS)),
    ...(sentence.speaker !== undefined ? { speaker: escapeEvidence(sentence.speaker).slice(0, 120) } : {}),
    ...(sentence.startSecs !== undefined ? { startSecs: sentence.startSecs } : {}),
  }));
}

/**
 * Bounded, deterministic retrieval over a caller's already-activated connector
 * access. It deliberately has no path, SQL, limit, or persistence parameter.
 */
export async function searchTranscripts(
  reader: TranscriptReader,
  args: TranscriptSearchArgs,
): Promise<TranscriptSearchResult> {
  let partial = false;
  let rows: TranscriptMetadata[];
  try {
    rows = await reader.listMetadata();
  } catch {
    // A metadata outage is not an empty corpus, and it is not a delegation
    // problem either: answer with the contract's stable unavailable code.
    throw new ToolError("transcript metadata unavailable", 503, "transcript_unavailable");
  }
  let truncated = rows.length > MAX_METADATA_ROWS;
  rows = rows.slice(0, MAX_METADATA_ROWS);
  const title = args.title?.trim().toLowerCase();
  const filtered = rows.filter((row) =>
    (!args.source || row.source === args.source)
    && (!title || row.title?.toLowerCase().includes(title))
    && (!args.from || (row.startedAt !== null && row.startedAt.slice(0, 10) >= args.from))
    && (!args.to || (row.startedAt !== null && row.startedAt.slice(0, 10) <= args.to)),
  );
  const candidates = [...filtered].sort((a, b) => {
    const relevance = Number((b.title ?? "").toLowerCase().includes(args.query.toLowerCase()))
      - Number((a.title ?? "").toLowerCase().includes(args.query.toLowerCase()));
    if (relevance) return relevance;
    return args.recent ? (b.startedAt ?? "").localeCompare(a.startedAt ?? "") : (a.startedAt ?? "").localeCompare(b.startedAt ?? "");
  });
  const candidateCount = candidates.length;
  if (candidateCount > MAX_BODIES) truncated = true;
  const matches: TranscriptMatch[] = [];
  let examinedCount = 0;
  for (const row of candidates.slice(0, MAX_BODIES)) {
    examinedCount += 1;
    let transcript: unknown | null;
    try {
      transcript = await reader.getTranscript(row.source, row.sourceId);
    } catch {
      partial = true;
      continue;
    }
    if (!transcript) continue;
    const excerpts = excerptsFor(args.query, transcript);
    if (excerpts.length === 0) continue;
    if (matches.length >= MAX_MATCHES) {
      truncated = true;
      continue;
    }
    const index = matches.length + 1;
    matches.push({
      citation: `[T${index}]`, source: row.source, sourceId: row.sourceId,
      // A meeting title is user/provider-controlled text on the same untrusted
      // footing as the body, so it is fenced identically before synthesis.
      title: row.title === null ? null : escapeEvidence(row.title).slice(0, MAX_TITLE_CHARS),
      startedAt: row.startedAt,
      excerpts: excerpts.map((excerpt, excerptIndex) => ({
        citation: excerptCitation(index, excerptIndex + 1, excerpt),
        ...excerpt,
      })),
    });
  }
  const data = { corpus: { candidateCount, examinedCount, matchedCount: matches.length, truncated, partial }, matches };
  // Result-size capping is deterministic: retain meetings in ranked order.
  while (matches.length > 0 && JSON.stringify(data).length > MAX_SERIALIZED_RESULT_CHARS) {
    matches.pop();
    data.corpus.matchedCount = matches.length;
    data.corpus.truncated = true;
  }
  return {
    text: `Found cited evidence in ${matches.length} of ${examinedCount} examined transcripts.${(data.corpus.truncated || partial) ? " Results are bounded; answer only from retained evidence." : ""}`,
    data,
  };
}

function isNamedError(error: unknown, name: string): boolean {
  return (error as { name?: unknown } | null)?.name === name;
}

/** Registered Eliza action backing POST /tools/tinycloud_search_transcripts. */
export const tinycloudSearchTranscriptsAction: Action = {
  name: "TINYCLOUD_SEARCH_TRANSCRIPTS",
  description: "Search the caller's delegated TinyCloud meeting transcripts.",
  similes: [TINYCLOUD_SEARCH_TRANSCRIPTS],
  examples: [],
  validate: async (_runtime, message, _state, options) => {
    const args = (options as { args?: Record<string, unknown> } | undefined)?.args
      ?? { query: message.content?.text };
    return parseTranscriptSearchArgs(args) !== null;
  },
  handler: async (runtime: IAgentRuntime, message: Memory, _state, options, callback) => {
    const raw = (options as { args?: Record<string, unknown> } | undefined)?.args
      ?? { query: message.content?.text };
    const args = parseTranscriptSearchArgs(raw);
    if (!args) throw new ToolError("invalid transcript tool arguments", 400, "invalid_args");
    const registry = transcriptRegistryFor(runtime as unknown as object);
    // No registry at all means this runtime never activated transcript access;
    // it must fail closed exactly like a missing per-entity grant rather than
    // letting the turn silently proceed without the user's transcripts.
    if (!registry) throw new ToolError("transcript delegation required", 409, "delegation_required");
    let reader: TranscriptReader;
    try {
      reader = registry.readerFor(message.entityId, message.roomId);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (isNamedError(error, "DelegationExpiredError")) {
        throw new ToolError("transcript delegation expired", 409, "delegation_expired");
      }
      throw new ToolError("transcript delegation required", 409, "delegation_required");
    }
    const result = await searchTranscripts(reader, args);
    // Only the bounded final result is handed to the calling model.  The registry
    // retains no plaintext and callback frames deliberately carry no evidence.
    const content: Content = { text: result.text };
    if (callback) await callback(content);
    return { success: true, text: result.text, data: result.data };
  },
};

export const tinycloudSearchTranscriptsPlugin: Plugin = {
  name: "tinycloud-search-transcripts",
  description: "Bounded read-only delegated TinyCloud transcript retrieval.",
  actions: [tinycloudSearchTranscriptsAction],
};
