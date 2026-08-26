import type { Action, Content, Memory, Plugin } from "@elizaos/core";
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
  return args as TranscriptSearchArgs;
}

/** Fixed TinyChat connector paths. They are never model-controlled. */
export const TINYCLOUD_CONNECTORS_SQL_PATH = "xyz.tinycloud.tinychat/connectors";
export const TINYCLOUD_CONNECTORS_KV_PREFIX = `${TINYCLOUD_CONNECTORS_SQL_PATH}/`;
const MAX_METADATA_ROWS = 500;
const MAX_BODIES = 12;
const MAX_MATCHES = 4;
const MAX_EXCERPTS_PER_MATCH = 4;
const MAX_EXCERPT_CHARS = 1_400;
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
  getTranscript(source: TranscriptMetadata["source"], sourceId: string): Promise<string | null>;
}

/*
 * This registry is intentionally capability-only: it stores a reader factory, never
 * a transcript body or a prior result.  The session/activation layer installs a
 * per-entity factory after it has activated that entity's separate transcript
 * delegation.  Keeping this seam here makes the action directly testable while
 * preventing a tool invocation from selecting a path, SQL statement, or entity.
 */
const readers = new Map<string, () => Promise<TranscriptReader>>();

export function registerTranscriptReader(entityId: string, reader: () => Promise<TranscriptReader>): void {
  readers.set(entityId, reader);
}

export function clearTranscriptReader(entityId: string): void {
  readers.delete(entityId);
}

interface TranscriptExcerpt {
  citation: string;
  text: string;
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

function excerptFor(query: string, transcript: string): string | null {
  const haystack = transcript.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1);
  const index = terms.map((term) => haystack.indexOf(term)).find((found) => found >= 0);
  if (index === undefined) return null;
  const start = Math.max(0, index - 280);
  const end = Math.min(transcript.length, start + MAX_EXCERPT_CHARS);
  return escapeEvidence(transcript.slice(start, end));
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
    throw new Error("transcript_metadata_unavailable");
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
    let transcript: string | null;
    try {
      transcript = await reader.getTranscript(row.source, row.sourceId);
    } catch {
      partial = true;
      continue;
    }
    if (!transcript) continue;
    const excerpt = excerptFor(args.query, transcript);
    if (!excerpt) continue;
    if (matches.length >= MAX_MATCHES) {
      truncated = true;
      continue;
    }
    const index = matches.length + 1;
    matches.push({
      citation: `[T${index}]`, source: row.source, sourceId: row.sourceId,
      title: row.title, startedAt: row.startedAt,
      excerpts: [{ citation: `[T${index}:E1]`, text: excerpt }].slice(0, MAX_EXCERPTS_PER_MATCH),
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
  handler: async (_runtime, message: Memory, _state, options, callback) => {
    const raw = (options as { args?: Record<string, unknown> } | undefined)?.args
      ?? { query: message.content?.text };
    const args = parseTranscriptSearchArgs(raw);
    if (!args) throw new ToolError("invalid transcript tool arguments", 400, "invalid_args");
    const factory = readers.get(message.entityId);
    if (!factory) throw new ToolError("transcript delegation required", 409, "delegation_required");
    let reader: TranscriptReader;
    try {
      reader = await factory();
    } catch {
      throw new ToolError("transcript delegation unavailable", 409, "delegation_expired");
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
