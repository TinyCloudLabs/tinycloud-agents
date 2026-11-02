// POST /messages handler tests (T5 TDD).
//
// All tests use fake host + fake runtime — no live TinyCloud node, no real AgentRuntime.
//
// Test coverage:
//   1. SSE frames well-formed: data: lines + [DONE] sentinel.
//   2. NoDelegationError from pre-flight -> 409 { error: "delegation_required" }.
//   3. DelegationExpiredError from pre-flight -> 409 { error: "delegation_expired" }.
//   4. Memory passed to handleMessage carries entityId/roomId/agentId from the request.
//   5. Writer.write is never called when pre-flight throws (no SSE opened on 409).
//
// T1 decision: delegation errors are caught as pre-stream HTTP 409, not terminal SSE
// events (emitevent-spike.test.ts). The host.preflight() interface encapsulates the
// synchronous delegation check so the handler stays decoupled from storage internals.

import { describe, expect, it } from "bun:test";
import type { Content, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  DelegationExpiredError,
  NoDelegationError,
} from "@tinycloud/eliza-plugin-memory";
import { handlePostMessages } from "./messages.js";
import type { MessageHandlerHost, PostMessagesBody, SseWriter } from "./messages.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENTITY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROOM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const DEFAULT_BODY: PostMessagesBody = {
  agentId: AGENT_ID,
  entityId: ENTITY_ID,
  roomId: ROOM_ID,
  text: "Hello agent",
};

// ── Fakes ─────────────────────────────────────────────────────────────────────

/** Captures frames written by the handler. */
class CapturingWriter implements SseWriter {
  readonly frames: string[] = [];
  closedCount = 0;

  write(frame: string): void {
    this.frames.push(frame);
  }

  close(): void {
    this.closedCount++;
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function installFakeTimers() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let nextId = 0;
  const delays: number[] = [];
  const scheduled = new Map<number, { at: number; callback: () => void }>();

  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    const id = ++nextId;
    delays.push(delay);
    scheduled.set(id, { at: now + delay, callback });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    scheduled.delete(Number(id));
  }) as unknown as typeof clearTimeout;

  return {
    advance(milliseconds: number) {
      const target = now + milliseconds;
      while (true) {
        const next = [...scheduled.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        scheduled.delete(next[0]);
        next[1].callback();
      }
      now = target;
    },
    get pendingCount() { return scheduled.size; },
    get scheduledDelays() { return delays; },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

function makeSlowHost(started: () => void, release: Promise<void>): MessageHandlerHost {
  const runtime = {
    agentId: AGENT_ID as UUID,
    messageService: {
      async handleMessage(
        _runtime: IAgentRuntime,
        _message: Memory,
        callback?: (content: Content) => Promise<Memory[]>,
      ) {
        started();
        await release;
        if (callback) await callback({ text: "final answer" });
        return { didRespond: true, responseMessages: [], mode: "simple" as const };
      },
    },
  } as unknown as IAgentRuntime;
  return {
    async runtimeFor() { return runtime; },
    async preflight() {},
  };
}

/**
 * Fake message service that calls the callback with scripted chunks.
 * Captures the Memory passed to handleMessage for assertion.
 */
function makeFakeMessageService(chunks: Content[]) {
  let capturedMessage: Memory | undefined;
  const service = {
    get capturedMessage() { return capturedMessage; },
    async handleMessage(
      _runtime: IAgentRuntime,
      message: Memory,
      callback?: (content: Content) => Promise<Memory[]>,
    ) {
      capturedMessage = message;
      for (const chunk of chunks) {
        if (callback) await callback(chunk);
      }
      return { didRespond: true, responseMessages: [], mode: "simple" as const };
    },
    shouldRespond() { return { shouldRespond: true, skipEvaluation: true, reason: "fake" }; },
    async deleteMessage() {},
    async clearChannel() {},
  };
  return service;
}

function makeFakeRuntime(
  agentId: string,
  chunks: Content[],
): { runtime: IAgentRuntime; messageService: ReturnType<typeof makeFakeMessageService> } {
  const messageService = makeFakeMessageService(chunks);
  const runtime = {
    agentId: agentId as UUID,
    messageService,
  } as unknown as IAgentRuntime;
  return { runtime, messageService };
}

function makeHost(opts: {
  agentId?: string;
  chunks?: Content[];
  preflightThrow?: unknown;
}): { host: MessageHandlerHost; messageService: ReturnType<typeof makeFakeMessageService> | null } {
  const chunks = opts.chunks ?? [{ text: "Hello from agent" }];
  const { runtime, messageService } = makeFakeRuntime(opts.agentId ?? AGENT_ID, chunks);
  const host: MessageHandlerHost = {
    async runtimeFor() { return runtime; },
    async preflight(_agentId: string, _entityId: string) {
      if (opts.preflightThrow !== undefined) throw opts.preflightThrow;
    },
  };
  return { host, messageService };
}

// ── SSE frame format ──────────────────────────────────────────────────────────

describe("handlePostMessages — SSE frames well-formed", () => {
  it("writes one data: frame per callback chunk plus a [DONE] sentinel", async () => {
    const chunks: Content[] = [{ text: "chunk1" }, { text: "chunk2" }];
    const { host } = makeHost({ chunks });
    const writer = new CapturingWriter();

    const result = await handlePostMessages(DEFAULT_BODY, host, writer);

    expect(result.type).toBe("ok");
    // Two content frames + [DONE]
    expect(writer.frames).toHaveLength(3);
    expect(writer.frames[0]).toBe(`data: ${JSON.stringify({ text: "chunk1" })}\n\n`);
    expect(writer.frames[1]).toBe(`data: ${JSON.stringify({ text: "chunk2" })}\n\n`);
    expect(writer.frames[2]).toBe("data: [DONE]\n\n");
  });

  it("writes [DONE] even when the pipeline calls callback zero times", async () => {
    const { host } = makeHost({ chunks: [] });
    const writer = new CapturingWriter();

    const result = await handlePostMessages(DEFAULT_BODY, host, writer);

    expect(result.type).toBe("ok");
    expect(writer.frames).toHaveLength(1);
    expect(writer.frames[0]).toBe("data: [DONE]\n\n");
  });

  it("calls writer.close() exactly once on success", async () => {
    const { host } = makeHost({ chunks: [{ text: "hi" }] });
    const writer = new CapturingWriter();

    await handlePostMessages(DEFAULT_BODY, host, writer);

    expect(writer.closedCount).toBe(1);
  });

  it("each data: frame contains valid JSON", async () => {
    const chunks: Content[] = [{ text: "hello" }, { text: "world" }];
    const { host } = makeHost({ chunks });
    const writer = new CapturingWriter();

    await handlePostMessages(DEFAULT_BODY, host, writer);

    const dataFrames = writer.frames.filter((f) => f !== "data: [DONE]\n\n");
    for (const frame of dataFrames) {
      expect(frame.startsWith("data: ")).toBe(true);
      // Strip "data: " prefix and "\n\n" suffix, then parse
      const json = frame.slice(6, -2);
      expect(() => JSON.parse(json)).not.toThrow();
    }
  });
});

describe("handlePostMessages — SSE keepalive", () => {
  it("pings every 30 seconds during a slow answer and preserves the final answer", async () => {
    const clock = installFakeTimers();
    const started = deferred();
    const release = deferred();
    const writer = new CapturingWriter();
    const handling = handlePostMessages(
      DEFAULT_BODY,
      makeSlowHost(started.resolve, release.promise),
      writer,
    );

    try {
      await started.promise;
      clock.advance(60_000);
      expect(writer.frames.filter((frame) => frame === ": ping\n\n")).toHaveLength(2);
    } finally {
      release.resolve();
      try {
        await handling;
      } finally {
        clock.restore();
      }
    }

    expect(writer.frames).toContain(`data: ${JSON.stringify({ text: "final answer" })}\n\n`);
    expect(writer.frames.at(-1)).toBe("data: [DONE]\n\n");
    expect(clock.pendingCount).toBe(0);
  });

  it("pings during runtime startup before the model begins", async () => {
    const clock = installFakeTimers();
    const bootStarted = deferred();
    const bootRelease = deferred();
    const { runtime } = makeFakeRuntime(AGENT_ID, [{ text: "answer after startup" }]);
    const host: MessageHandlerHost = {
      async preflight() {},
      async runtimeFor() {
        bootStarted.resolve();
        await bootRelease.promise;
        return runtime;
      },
    };
    const writer = new CapturingWriter();
    const handling = handlePostMessages(DEFAULT_BODY, host, writer);

    try {
      await bootStarted.promise;
      clock.advance(30_000);
      expect(writer.frames).toContain(": ping\n\n");
      bootRelease.resolve();
      await handling;
      expect(writer.frames).toContain(`data: ${JSON.stringify({ text: "answer after startup" })}\n\n`);
      expect(clock.pendingCount).toBe(0);
    } finally {
      bootRelease.resolve();
      try {
        await handling;
      } finally {
        clock.restore();
      }
    }
  });

  it("restarts the idle interval after each data event", async () => {
    const clock = installFakeTimers();
    const started = deferred();
    const sendProgress = deferred();
    const progressWritten = deferred();
    const release = deferred();
    const runtime = {
      agentId: AGENT_ID as UUID,
      messageService: {
        async handleMessage(
          _runtime: IAgentRuntime,
          _message: Memory,
          callback?: (content: Content) => Promise<Memory[]>,
        ) {
          started.resolve();
          await sendProgress.promise;
          if (callback) await callback({ text: "progress" });
          progressWritten.resolve();
          await release.promise;
          if (callback) await callback({ text: "final answer" });
          return { didRespond: true, responseMessages: [], mode: "simple" as const };
        },
      },
    } as unknown as IAgentRuntime;
    const host: MessageHandlerHost = {
      async preflight() {},
      async runtimeFor() { return runtime; },
    };
    const writer = new CapturingWriter();
    const handling = handlePostMessages(DEFAULT_BODY, host, writer);

    try {
      await started.promise;
      clock.advance(25_000);
      sendProgress.resolve();
      await progressWritten.promise;
      clock.advance(29_999);
      expect(writer.frames.filter((frame) => frame === ": ping\n\n")).toHaveLength(0);
      clock.advance(1);
      expect(writer.frames.filter((frame) => frame === ": ping\n\n")).toHaveLength(1);
    } finally {
      release.resolve();
      try {
        await handling;
      } finally {
        clock.restore();
      }
    }
  });

  it("stops keepalives when disconnected during runtime startup", async () => {
    const clock = installFakeTimers();
    const bootStarted = deferred();
    const bootRelease = deferred();
    const controller = new AbortController();
    const { runtime } = makeFakeRuntime(AGENT_ID, [{ text: "never sent" }]);
    const host: MessageHandlerHost = {
      async preflight() {},
      async runtimeFor() {
        bootStarted.resolve();
        await bootRelease.promise;
        return runtime;
      },
    };
    const writer = new CapturingWriter();
    const handling = handlePostMessages(DEFAULT_BODY, host, writer, { signal: controller.signal });

    try {
      await bootStarted.promise;
      expect(clock.pendingCount).toBe(1);
      controller.abort();
      expect(clock.pendingCount).toBe(0);
      clock.advance(60_000);
      expect(writer.frames).not.toContain(": ping\n\n");
      bootRelease.resolve();
      await handling;
    } finally {
      bootRelease.resolve();
      try {
        await handling;
      } finally {
        clock.restore();
      }
    }
  });

  it("does not restart the timer from a callback after the stream ends", async () => {
    const clock = installFakeTimers();
    let lateCallback: ((content: Content) => Promise<Memory[]>) | undefined;
    const runtime = {
      agentId: AGENT_ID as UUID,
      messageService: {
        async handleMessage(
          _runtime: IAgentRuntime,
          _message: Memory,
          callback?: (content: Content) => Promise<Memory[]>,
        ) {
          lateCallback = callback;
          return { didRespond: true, responseMessages: [], mode: "simple" as const };
        },
      },
    } as unknown as IAgentRuntime;
    const host: MessageHandlerHost = {
      async preflight() {},
      async runtimeFor() { return runtime; },
    };
    const writer = new CapturingWriter();

    try {
      await handlePostMessages(DEFAULT_BODY, host, writer);
      await lateCallback?.({ text: "late event" });
      clock.advance(60_000);
      expect(writer.frames).not.toContain(": ping\n\n");
      expect(writer.frames).not.toContain(`data: ${JSON.stringify({ text: "late event" })}\n\n`);
      expect(clock.pendingCount).toBe(0);
    } finally {
      clock.restore();
    }
  });

  it("clears the idle keepalive timer after a fast answer without sending a ping", async () => {
    const clock = installFakeTimers();
    const { host } = makeHost({ chunks: [{ text: "fast answer" }] });
    const writer = new CapturingWriter();

    try {
      await handlePostMessages(DEFAULT_BODY, host, writer);
      clock.advance(60_000);
      expect(writer.frames).not.toContain(": ping\n\n");
      expect(clock.scheduledDelays).toContain(30_000);
      expect(clock.pendingCount).toBe(0);
    } finally {
      clock.restore();
    }
  });

  it("clears the idle keepalive timer when the client disconnects", async () => {
    const clock = installFakeTimers();
    const started = deferred();
    const release = deferred();
    const controller = new AbortController();
    const writer = new CapturingWriter();
    const handling = handlePostMessages(
      DEFAULT_BODY,
      makeSlowHost(started.resolve, release.promise),
      writer,
      { signal: controller.signal },
    );

    try {
      await started.promise;
      expect(clock.pendingCount).toBe(1);
      controller.abort();
      expect(clock.pendingCount).toBe(0);
      clock.advance(60_000);
      expect(writer.frames).not.toContain(": ping\n\n");
    } finally {
      release.resolve();
      try {
        await handling;
      } finally {
        clock.restore();
      }
    }
  });
});

// ── NoDelegationError → 409 delegation_required ───────────────────────────────

describe("handlePostMessages — NoDelegationError pre-flight", () => {
  it("returns 409 { error: 'delegation_required' } when preflight throws NoDelegationError", async () => {
    const { host } = makeHost({ preflightThrow: new NoDelegationError(ENTITY_ID) });
    const writer = new CapturingWriter();

    const result = await handlePostMessages(DEFAULT_BODY, host, writer);

    expect(result.type).toBe("error");
    expect((result as { status: number }).status).toBe(409);
    expect((result as { body: { error: string } }).body.error).toBe("delegation_required");
  });

  it("does NOT write any SSE frame when pre-flight throws NoDelegationError", async () => {
    const { host } = makeHost({ preflightThrow: new NoDelegationError(ENTITY_ID) });
    const writer = new CapturingWriter();

    await handlePostMessages(DEFAULT_BODY, host, writer);

    expect(writer.frames).toHaveLength(0);
    expect(writer.closedCount).toBe(0);
  });
});

// ── DelegationExpiredError → 409 delegation_expired ──────────────────────────

describe("handlePostMessages — DelegationExpiredError pre-flight", () => {
  it("returns 409 { error: 'delegation_expired' } when preflight throws DelegationExpiredError", async () => {
    const { host } = makeHost({ preflightThrow: new DelegationExpiredError(ENTITY_ID) });
    const writer = new CapturingWriter();

    const result = await handlePostMessages(DEFAULT_BODY, host, writer);

    expect(result.type).toBe("error");
    expect((result as { status: number }).status).toBe(409);
    expect((result as { body: { error: string } }).body.error).toBe("delegation_expired");
  });

  it("does NOT write any SSE frame when pre-flight throws DelegationExpiredError", async () => {
    const { host } = makeHost({ preflightThrow: new DelegationExpiredError(ENTITY_ID) });
    const writer = new CapturingWriter();

    await handlePostMessages(DEFAULT_BODY, host, writer);

    expect(writer.frames).toHaveLength(0);
    expect(writer.closedCount).toBe(0);
  });
});

// ── Memory object passed to handleMessage ────────────────────────────────────

describe("handlePostMessages — Memory object construction", () => {
  it("passes entityId from request body to handleMessage", async () => {
    const { host, messageService } = makeHost({});
    const writer = new CapturingWriter();

    await handlePostMessages(DEFAULT_BODY, host, writer);

    expect(messageService!.capturedMessage!.entityId).toBe(ENTITY_ID);
  });

  it("passes roomId from request body to handleMessage", async () => {
    const { host, messageService } = makeHost({});
    const writer = new CapturingWriter();

    await handlePostMessages(DEFAULT_BODY, host, writer);

    expect(messageService!.capturedMessage!.roomId).toBe(ROOM_ID);
  });

  it("passes agentId from request body to handleMessage", async () => {
    const { host, messageService } = makeHost({});
    const writer = new CapturingWriter();

    await handlePostMessages(DEFAULT_BODY, host, writer);

    expect(messageService!.capturedMessage!.agentId).toBe(AGENT_ID);
  });

  it("includes the request text in memory content", async () => {
    const body = { ...DEFAULT_BODY, text: "What is the capital of France?" };
    const { host, messageService } = makeHost({});
    const writer = new CapturingWriter();

    await handlePostMessages(body, host, writer);

    expect(messageService!.capturedMessage!.content.text).toBe("What is the capital of France?");
  });

  it("assigns a non-empty UUID id to the Memory", async () => {
    const { host, messageService } = makeHost({});
    const writer = new CapturingWriter();

    await handlePostMessages(DEFAULT_BODY, host, writer);

    const id = messageService!.capturedMessage!.id;
    expect(typeof id).toBe("string");
    expect((id as string).length).toBeGreaterThan(0);
    // Basic UUID format check
    expect(/^[0-9a-f-]{36}$/.test(id as string)).toBe(true);
  });

  it("sets createdAt to a recent timestamp", async () => {
    const before = Date.now();
    const { host, messageService } = makeHost({});
    const writer = new CapturingWriter();

    await handlePostMessages(DEFAULT_BODY, host, writer);

    const after = Date.now();
    const ts = messageService!.capturedMessage!.createdAt!;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// ── Non-delegation errors rethrow ─────────────────────────────────────────────

describe("handlePostMessages — non-delegation errors", () => {
  it("rethrows unknown errors from preflight (not delegation errors)", async () => {
    const { host } = makeHost({ preflightThrow: new Error("unexpected network error") });
    const writer = new CapturingWriter();

    await expect(handlePostMessages(DEFAULT_BODY, host, writer)).rejects.toThrow(
      "unexpected network error",
    );
  });
});

it("disconnect fences legacy callbacks and clears only the affected message state again after late completion", async () => {
  const controller = new AbortController(); let current = true;
  let release!: () => void, messageId = "";
  const pending = new Promise<void>(resolve => { release = resolve; });
  const stateCache = new Map<string, unknown>([["other-account", { text: "preserved" }]]);
  const runtime = { stateCache, messageService: { async handleMessage(_runtime: unknown, message: Memory, callback: (content: Content) => Promise<Memory[]>) {
    messageId = message.id!;
    stateCache.set(messageId, { text: "private cached" });
    stateCache.set(`${messageId}_action_results`, { text: "private action" });
    await pending;
    stateCache.set(messageId, { text: "late private cache" });
    await callback({ text: "late private answer" });
  } } } as unknown as IAgentRuntime;
  const writer = new CapturingWriter();
  const work = handlePostMessages(DEFAULT_BODY, { preflight: async () => {}, runtimeFor: async () => runtime }, writer, { signal: controller.signal, access: { isCurrent: () => current, isActive: () => current } } as any);
  await new Promise(resolve => setTimeout(resolve, 0)); current = false; controller.abort();
  expect(stateCache.has(messageId)).toBe(false);
  expect(stateCache.has(`${messageId}_action_results`)).toBe(false);
  release(); await work;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(writer.frames.join("")).not.toContain("late private answer");
  expect(stateCache.has(messageId)).toBe(false);
  expect(stateCache.get("other-account")).toEqual({ text: "preserved" });
});
