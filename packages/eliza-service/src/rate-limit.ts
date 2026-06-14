// Per-(app, entityId) fixed-window rate-limiter.
//
// SINGLE-INSTANCE LIMITATION: buckets are in-memory and are NOT shared across
// multiple service instances. In a multi-instance deployment each instance
// tracks its own counter; the effective per-user limit is N×instances.
// Acceptable for the current single-process MVP; replace with a shared store
// (Redis, Upstash, etc.) if horizontal scaling is needed (see handoff §8).

export interface RateLimitOptions {
  /** Maximum requests allowed per window. Default: 60. */
  maxRequests?: number;
  /** Window duration in milliseconds. Default: 60_000 (one minute). */
  windowMs?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export interface RateLimiter {
  check(appId: string, entityId: string): { allowed: boolean };
}

export function createRateLimiter(opts: RateLimitOptions = {}): RateLimiter {
  const maxRequests = opts.maxRequests ?? 60;
  const windowMs = opts.windowMs ?? 60_000;
  const clock = opts.now ?? (() => Date.now());

  const buckets = new Map<string, Bucket>();

  return {
    check(appId: string, entityId: string): { allowed: boolean } {
      const key = `${appId}\0${entityId}`;
      const now = clock();
      let bucket = buckets.get(key);

      if (!bucket || now - bucket.windowStart >= windowMs) {
        // Start a fresh window.
        bucket = { count: 0, windowStart: now };
        buckets.set(key, bucket);
      }

      if (bucket.count >= maxRequests) {
        return { allowed: false };
      }

      bucket.count++;
      return { allowed: true };
    },
  };
}

// Default singleton used by the server.  Tests use createRateLimiter() directly
// so they can inject a deterministic clock without affecting the singleton.
export const defaultRateLimiter: RateLimiter = createRateLimiter();
