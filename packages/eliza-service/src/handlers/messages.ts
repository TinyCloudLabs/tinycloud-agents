// POST /messages handler — SSE streaming (plan §2, T5).
//
// T1 finding (emitevent-spike.test.ts):
//   - Correct entry point: runtime.messageService.handleMessage (NOT emitEvent).
//     emitEvent only fires plugin event handlers and does NOT trigger the LLM
//     response pipeline or invoke the HandlerCallback.
//   - NoDelegationError/DelegationExpiredError are caught silently inside composeState
//     and do NOT propagate from handleMessage to the caller.
//   - Decision settled by T1 (R1/R2): pre-flight check BEFORE opening the SSE stream.
//     On failure return HTTP 409 — never write SSE frames for delegation errors.
//
// SSE headers (set by the HTTP layer before calling this handler):
//   Content-Type: text/event-stream
//   Cache-Control: no-cache
//   Connection: keep-alive
//
// Error mapping (pre-stream 409, not terminal SSE):
//   NoDelegationError     -> 409 { error: "delegation_required" }
//   DelegationExpiredError -> 409 { error: "delegation_expired" }

import type { Content, HandlerCallback, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { withPrivateAccess } from "@tinycloud/eliza-plugin-memory";
import { withAbort } from "../tasks/provider.js";
import { mapDelegationError } from "../errors.js";

/**
 * Minimal host interface consumed by the messages handler.
 * RuntimeHost satisfies this interface; tests inject a fake.
 */
export interface MessageHandlerHost {
  runtimeFor(agentId: string): Promise<IAgentRuntime>;
  /**
   * Pre-flight delegation check — MUST be called before opening the SSE stream.
   *
   * T1 established: registry errors surface synchronously via clientFor but are
   * caught silently by composeState inside the message pipeline — they will NOT
   * reach the caller of handleMessage. This pre-flight exposes the error early so
   * C can return HTTP 409 before streaming begins.
   *
   * Throws NoDelegationError or DelegationExpiredError on failure.
   * Returns normally (void) when the entity has a valid delegation.
   */
  preflight(agentId: string, entityId: string): Promise<void>;
}

/** Minimal SSE write adapter — injected by the HTTP layer; faked in tests. */
export interface SseWriter {
  write(frame: string): void;
  close(): void;
}

export interface PostMessagesBody {
  agentId: string;
  entityId: string;
  roomId: string;
  text: string;
}

export interface ErrorResult {
  type: "error";
  status: number;
  body: { error: string };
}

export interface OkResult {
  type: "ok";
}

/**
 * Handle POST /messages.
 *
 * Pre-flight: calls host.preflight(agentId, entityId) BEFORE writing any SSE frame.
 * On NoDelegationError / DelegationExpiredError, returns an ErrorResult (HTTP 409)
 * without ever opening the SSE stream.
 *
 * On success: builds a Memory, calls messageService.handleMessage with a callback
 * that writes each response chunk as an SSE `data:` frame, then writes the
 * `data: [DONE]` sentinel and closes the writer.
 *
 * C never constructs an AgentClient or calls storage write methods directly —
 * memory writes happen inside the pipeline through B's already-laned storage seam.
 */
export async function handlePostMessages(
  body: PostMessagesBody,
  host: MessageHandlerHost,
  writer: SseWriter,
  transport: { signal?: AbortSignal; access?: { isCurrent(): boolean; isActive(): boolean } } = {},
): Promise<ErrorResult | OkResult> {
  const { agentId, entityId, roomId, text } = body;
  const allowed = () => !transport.signal?.aborted && (!transport.access || (transport.access.isCurrent() && transport.access.isActive()));
  const denied = (): ErrorResult => ({ type: "error", status: 409, body: { error: "delegation_required" } });
  if (!allowed()) return denied();

  // Pre-flight: check delegation BEFORE opening the SSE stream.
  // T1: registry errors are swallowed by composeState in the message pipeline, so
  // we check here and return 409 before streaming. No SSE frame is ever written on
  // an error path (pre-stream 409, not a terminal SSE error event).
  try {
    await host.preflight(agentId, entityId);
  } catch (err) {
    const code = mapDelegationError(err);
    if (code) return { type: "error", status: 409, body: { error: code } };
    throw err;
  }

  if (!allowed()) return denied();
  const runtime = await host.runtimeFor(agentId);
  if (!allowed()) return denied();
  if (!runtime.messageService) {
    throw new Error(
      `handlePostMessages: no messageService on runtime for agentId ${agentId}`,
    );
  }

  // Build the Memory object from request fields.
  // C treats (agentId, entityId, roomId) as opaque caller-supplied values (plan §0, §4).
  const message: Memory = {
    id: crypto.randomUUID() as UUID,
    agentId: agentId as UUID,
    entityId: entityId as UUID,
    roomId: roomId as UUID,
    content: { text },
    createdAt: Date.now(),
  };

  // Callback: each content chunk from the pipeline writes one SSE data frame.
  const callback: HandlerCallback = async (content: Content): Promise<Memory[]> => {
    if (allowed()) writer.write(`data: ${JSON.stringify(content)}\n\n`);
    return [];
  };

  // Eliza caches compose/action state by message ID. Never clear shared runtime
  // state, persisted history, or another account's message state.
  const stateCache = (runtime as IAgentRuntime & { stateCache?: Map<string, unknown> }).stateCache;
  const cleanup = () => {
    if (message.id) { stateCache?.delete(message.id); stateCache?.delete(`${message.id}_action_results`); }
  };
  transport.signal?.addEventListener("abort", cleanup, { once: true });
  try {
    if (!allowed()) return denied();
    const pipeline = withPrivateAccess(allowed, () => runtime.messageService!.handleMessage(runtime, message, callback, { abortSignal: transport.signal }));
    // An uncooperative pipeline can settle after the response is cancelled.
    // Retain this cleanup until its own completion so late cache writes vanish.
    const work = pipeline.finally(cleanup);
    if (transport.signal) await withAbort(work, transport.signal); else await work;
    if (allowed()) writer.write("data: [DONE]\n\n");
  } catch (error) {
    if (allowed()) throw error;
  } finally {
    cleanup();
    transport.signal?.removeEventListener("abort", cleanup);
    writer.close();
  }
  return { type: "ok" };
}
