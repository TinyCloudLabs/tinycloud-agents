import { describe, expect, test } from "bun:test";
import { SessionStore } from "./session-store.js";

const scope = { appId: "tinychat", agentId: "agent" };
const record = { agentId: "agent", serializedDelegation: "synthetic-memory", serializedTranscriptDelegation: "synthetic-transcripts" };

describe("account access generations", () => {
  test("reserves a revision once, commits it, and synchronously invalidates old leases", () => {
    const store = new SessionStore();
    const initial = store.snapshot(scope, "alice");
    const lease = store.reserve(scope, "alice", initial.revision)!;
    expect(lease.isCurrent()).toBe(true);
    expect(lease.isActive()).toBe(false);
    expect(store.reserve(scope, "alice", initial.revision)).toBeNull();
    expect(store.commit(scope, "alice", lease, record)).toBe(true);
    expect(lease.isActive()).toBe(true);
    let invalidated = false;
    store.onInvalidate((changed, entity) => { invalidated = changed.appId === scope.appId && entity === "alice" && !lease.isCurrent(); });
    const disconnected = store.disconnect(scope, "alice");
    expect(invalidated).toBe(true);
    expect(disconnected.state).toBe("disconnected");
    expect(disconnected.record).toBeUndefined();
    expect(lease.isActive()).toBe(false);
    expect(store.commit(scope, "alice", lease, record)).toBe(false);
  });

  test("restart and a different application cannot reuse an account revision", () => {
    const first = new SessionStore();
    const revision = first.snapshot(scope, "alice").revision;
    expect(new SessionStore().reserve(scope, "alice", revision)).toBeNull();
    expect(first.reserve({ ...scope, appId: "other" }, "alice", revision)).toBeNull();
    const other = first.lease(scope, "bob");
    first.disconnect(scope, "alice");
    expect(other.isCurrent()).toBe(true);
  });

  test("late failure cannot erase a replacement and never restores the old grant", () => {
    const store = new SessionStore();
    const old = store.reserve(scope, "alice")!;
    store.commit(scope, "alice", old, record);
    const replacement = store.reserve(scope, "alice", old.revision)!;
    expect(store.snapshot(scope, "alice").record).toBeUndefined();
    store.fail(scope, "alice", old);
    expect(replacement.isCurrent()).toBe(true);
    store.fail(scope, "alice", replacement);
    expect(store.snapshot(scope, "alice").state).toBe("none");
  });
});
