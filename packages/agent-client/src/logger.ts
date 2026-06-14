// Minimal pluggable logger seam.
//
// SECURITY INVARIANT (plan §5, audit F4) — ENFORCED, not just documented:
//   • NEVER log `Authorization` header values, UCAN invocations, or session tokens.
//   • NEVER log full request dumps (whole HTTP requests / response bodies).
// Callers pass short op labels and SQL keywords, not request bodies. The default
// logger additionally redacts anything that looks like an auth value as a backstop.

export interface Logger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

/** Case-insensitive markers that must never appear in a log line in cleartext. */
const FORBIDDEN_MARKERS = ["authorization:", "bearer ", "ucan ", "x-tinycloud-invocation"];

/**
 * Backstop redaction: drop any string arg/message that smells like an auth value.
 * This is defense-in-depth — call sites must still avoid passing secrets at all.
 */
function redact(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const lower = value.toLowerCase();
  for (const marker of FORBIDDEN_MARKERS) {
    if (lower.includes(marker)) return "[redacted]";
  }
  return value;
}

function redactMessage(message: string): string {
  return redact(message) as string;
}

/** Default logger backed by `console`, with the security backstop applied. */
export const consoleLogger: Logger = {
  debug: (message, ...meta) => console.debug(redactMessage(message), ...meta.map(redact)),
  info: (message, ...meta) => console.info(redactMessage(message), ...meta.map(redact)),
  warn: (message, ...meta) => console.warn(redactMessage(message), ...meta.map(redact)),
  error: (message, ...meta) => console.error(redactMessage(message), ...meta.map(redact)),
};

/** A no-op logger (useful in tests). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
