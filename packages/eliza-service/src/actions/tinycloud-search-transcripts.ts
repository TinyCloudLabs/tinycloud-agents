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
