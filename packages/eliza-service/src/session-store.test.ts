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

describe("restored access generations", () => {
  test("a reload keeps the persisted revision, and a new process never reuses it", () => {
    const store = new SessionStore();
    const lease = store.beginRestore(scope, "alice", "previous-process:7")!;
    expect(store.snapshot(scope, "alice")).toEqual({ revision: "previous-process:7", state: "restoring" });
    expect(lease.isActive()).toBe(false);
    expect(store.restore(scope, "alice", lease, record)).toBe(true);
    expect(store.snapshot(scope, "alice")).toMatchObject({ revision: "previous-process:7", state: "active" });
    expect(lease.isActive()).toBe(true);
    // The next ceremony starts from the persisted revision and gets a new one.
    const next = store.reserve(scope, "alice", "previous-process:7")!;
    expect(next.revision).not.toBe("previous-process:7");
  });

  test("a reload never overrides local state", () => {
    const store = new SessionStore();
    store.disconnect(scope, "alice");
    expect(store.beginRestore(scope, "alice", "persisted")).toBeNull();
    expect(store.snapshot(scope, "alice").state).toBe("disconnected");
  });

  test("a Disconnect or a reconnect during a reload fences the reload", () => {
    const store = new SessionStore();
    const reload = store.beginRestore(scope, "alice", "persisted")!;
    const reconnect = store.reserve(scope, "alice", "persisted")!;
    expect(reload.isCurrent()).toBe(false);
    expect(store.restore(scope, "alice", reload, record)).toBe(false);
    expect(store.tombstone(scope, "alice", reload, { revokedAt: 1 })).toBe(false);
    store.abandonRestore(scope, "alice", reload);
    expect(reconnect.isCurrent()).toBe(true);

    const other = store.beginRestore(scope, "bob", "persisted")!;
    store.disconnect(scope, "bob");
    expect(store.restore(scope, "bob", other, record)).toBe(false);
    expect(store.snapshot(scope, "bob").state).toBe("disconnected");
  });

  test("a revoked reload becomes a tombstone under the persisted revision", () => {
    const store = new SessionStore();
    const lease = store.beginRestore(scope, "alice", "persisted")!;
    expect(store.tombstone(scope, "alice", lease, { exp: 10, revokedAt: 5 })).toBe(true);
    expect(store.snapshot(scope, "alice")).toEqual({ revision: "persisted", state: "revoked", exp: 10, revokedAt: 5 });
    expect(lease.isActive()).toBe(false);
  });

  test("a staged record belongs only to its activating revision", () => {
    const store = new SessionStore();
    const lease = store.reserve(scope, "alice")!;
    expect(store.stage(scope, "alice", lease, record)).toBe(true);
    expect(store.staged(scope, "alice")).toEqual({ revision: lease.revision, record });
    store.disconnect(scope, "alice");
    expect(store.staged(scope, "alice")).toBeUndefined();
    expect(store.stage(scope, "alice", lease, record)).toBe(false);
  });
});
