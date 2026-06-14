import { describe, expect, it } from "bun:test";
import { createRateLimiter } from "./rate-limit.js";

describe("createRateLimiter — per-(appId, entityId) fixed-window", () => {
  it("allows N requests then blocks the (N+1)th", () => {
    const limiter = createRateLimiter({ maxRequests: 3, windowMs: 60_000, now: () => 0 });

    expect(limiter.check("app", "entity").allowed).toBe(true); // 1
    expect(limiter.check("app", "entity").allowed).toBe(true); // 2
    expect(limiter.check("app", "entity").allowed).toBe(true); // 3 — last allowed
    expect(limiter.check("app", "entity").allowed).toBe(false); // 4 → 429
  });

  it("advancing the clock past the window resets the bucket", () => {
    let t = 0;
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 1_000, now: () => t });

    expect(limiter.check("app", "entity").allowed).toBe(true);
    expect(limiter.check("app", "entity").allowed).toBe(true);
    expect(limiter.check("app", "entity").allowed).toBe(false); // exhausted

    t = 1_001; // advance past the 1-second window
    expect(limiter.check("app", "entity").allowed).toBe(true); // new window — allowed
    expect(limiter.check("app", "entity").allowed).toBe(true);
    expect(limiter.check("app", "entity").allowed).toBe(false); // exhausted again
  });

  it("distinct (appId, entityId) pairs have independent buckets", () => {
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 0 });

    // Exhaust the app1+entity1 bucket.
    expect(limiter.check("app1", "entity1").allowed).toBe(true);
    expect(limiter.check("app1", "entity1").allowed).toBe(false);

    // A different appId shares no state with app1+entity1.
    expect(limiter.check("app2", "entity1").allowed).toBe(true);

    // A different entityId within the same app also has its own bucket.
    expect(limiter.check("app1", "entity2").allowed).toBe(true);
  });
});
