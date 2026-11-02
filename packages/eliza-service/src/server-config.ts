export const DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS = 255;

export function serverIdleTimeoutFromEnv(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS;

  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS) {
    throw new Error("@tinycloud/eliza-service: invalid ELIZA_SERVICE_IDLE_TIMEOUT");
  }
  return seconds;
}
