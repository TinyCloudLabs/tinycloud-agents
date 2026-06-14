// Fan-out coalescer for the LTM read path (plan §5 row 2, invariant 5).
//
// Eliza's MemoryService resolves an entity's identity cluster and issues ONE
// getLongTermMemories call per related entity (memory-service.ts:446-456). Left
// alone, a cluster of N multiplies our ~2s/call latency by N. The microbatcher
// coalesces all calls that arrive within a short window (~10ms) and share a
// `group` (same agentId + category + limit) into ONE node round-trip — the
// storage layer issues a single `entity_id IN (…)` query with over-fetch and
// slices per entity client-side (a plain `IN … LIMIT` returns the wrong shape).
//
// Generic and timer-injectable so it is testable without a live node or real
// timers (plan T8 / task note). No host-framework (Eliza) imports. The default
// timer is the agent-client {@link realClock}, so this package needs no ambient
// node/DOM globals.

import { realClock } from "@tinycloud/agent-client";

/** A scheduled one-shot timer. Injected in tests; defaults to the clock's setTimeout. */
export type SetTimer = (fn: () => void, ms: number) => unknown;

/** Run one coalesced batch: given the members in the window, return each one's result. */
export type RunBatch<R> = (group: string, members: string[]) => Promise<Map<string, R>>;

/** Construction knobs for a {@link Microbatcher}. */
export interface MicrobatcherOptions<R> {
  /** Coalescing window (ms) — calls within this window to one group share a batch. */
  windowMs: number;
  /** Executes a batch for one group. Should return a result for every requested member. */
  runBatch: RunBatch<R>;
  /** Timer seam. Defaults to `setTimeout`. */
  setTimer?: SetTimer;
}

interface PendingGroup<R> {
  /** member → resolvers waiting on that member's slice (same entity may be requested twice). */
  members: Map<string, Array<(r: R) => void>>;
  /** every waiter's reject, fired together if the batch throws. */
  rejecters: Array<(e: unknown) => void>;
  /** whether a flush timer is armed for this group. */
  armed: boolean;
}

/**
 * Coalesces `request(group, member)` calls into batched `runBatch` invocations.
 * Each request resolves with its member's slice of the batch result.
 */
export class Microbatcher<R> {
  private readonly pending = new Map<string, PendingGroup<R>>();
  private readonly windowMs: number;
  private readonly runBatch: RunBatch<R>;
  private readonly setTimer: SetTimer;

  constructor(opts: MicrobatcherOptions<R>) {
    this.windowMs = opts.windowMs;
    this.runBatch = opts.runBatch;
    this.setTimer = opts.setTimer ?? ((fn, ms) => realClock.setTimeout(fn, ms));
  }

  /** Request `member`'s result within `group`; coalesces with concurrent siblings. */
  request(group: string, member: string): Promise<R> {
    let p = this.pending.get(group);
    if (!p) {
      p = { members: new Map(), rejecters: [], armed: false };
      this.pending.set(group, p);
    }
    const batch = p;
    const promise = new Promise<R>((resolve, reject) => {
      const resolvers = batch.members.get(member) ?? [];
      resolvers.push(resolve);
      batch.members.set(member, resolvers);
      batch.rejecters.push(reject);
    });
    if (!batch.armed) {
      batch.armed = true;
      this.setTimer(() => {
        void this.flushGroup(group);
      }, this.windowMs);
    }
    return promise;
  }

  /** Force-flush every pending group now (test seam / shutdown drain). */
  async flush(): Promise<void> {
    const groups = [...this.pending.keys()];
    await Promise.all(groups.map((g) => this.flushGroup(g)));
  }

  private async flushGroup(group: string): Promise<void> {
    const batch = this.pending.get(group);
    if (!batch) return;
    this.pending.delete(group);

    const members = [...batch.members.keys()];
    try {
      const result = await this.runBatch(group, members);
      for (const [member, resolvers] of batch.members) {
        const value = result.get(member) as R;
        for (const resolve of resolvers) resolve(value);
      }
    } catch (err) {
      for (const reject of batch.rejecters) reject(err);
    }
  }
}
