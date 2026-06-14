// T1 Risk-Retirement Spike: runtime message pipeline via messageService.handleMessage
//
// FINDINGS (verified against @elizaos/core 2.0.0-beta.1 source):
//
// ── EMITEVENT vs MESSAGESERVICE.HANDLEANMESSAGE ────────────────────────────────────────────
// The plan (§1 correction 3) says "correct entry point is runtime.emitEvent(MESSAGE_RECEIVED,
// { message, callback })". However, inspecting the @elizaos/core bundle:
//
//   AgentRuntime.emitEvent(event, params) calls Promise.all(handlers) for the event name.
//   For MESSAGE_RECEIVED, registered handlers are plugin-level event handlers (trajectory
//   tracking, etc.). None of them call messageService.handleMessage or invoke the callback.
//   emitEvent does NOT trigger the LLM response pipeline.
//
//   The correct path is: runtime.messageService!.handleMessage(runtime, message, callback)
//   This is the same path used by the autonomous agent (line 252733 in the bundle) and is
//   the only call site that runs composeState → shouldRespond → response generation → callback.
//
// ── WHERE NODELEGATIONERROR / DELEGATIONEXPIREDERROR SURFACES ──────────────────────────────
// When the TinyCloud memory plugin is loaded (production path), the longTermMemoryProvider
// and contextSummaryProvider call storage.getLongTermMemories/getCurrentSessionSummary →
// registry.clientFor(entityId) → throws NoDelegationError if no delegation registered.
//
// CRITICAL: composeState (runtime bundle line ~319050) wraps each provider in try/catch:
//   } catch (error) {
//     logger.error(..., "Provider failed during state composition");
//     return { text: "", values: {}, data: {}, providerName: provider.name };
//   }
//
// => NoDelegationError from storage providers is CAUGHT SILENTLY inside composeState.
//    It appears as an error log but does NOT propagate to handleMessage's caller.
//    The pipeline continues with empty memory context and the agent still responds.
//
// CONSEQUENCE for POST /messages error mapping:
//   delegation_required / delegation_expired CANNOT be surfaced via handleMessage's callback
//   or as a thrown error from the pipeline. The correct approach is a PRE-FLIGHT CHECK:
//     await storageFor(agentId).clientFor(entityId)   <-- throws NoDelegationError/Expired
//   before calling handleMessage. Errors from this pre-flight map to pre-stream HTTP 409
//   (or a pre-stream SSE error event), NOT a terminal SSE event mid-stream.
//   This settles T1 R1/R2: use pre-stream 409, not a terminal SSE frame.
//
// ── CALLBACK INVOCATION ────────────────────────────────────────────────────────────────────
// With no text-generation model registered (hasTextGenerationHandler = false) and
// checkShouldRespond = false, DefaultMessageService.processMessage calls
// buildNoModelProviderReply which sets mode = "simple" and pendingSimpleEmit = responseContent.
// After post-turn evaluators, pendingSimpleEmit is passed to callback(pendingSimpleEmit).
// The callback IS invoked even without a real LLM.
//
// With a real LLM registered, the V5 message pipeline runs: stage-1 HANDLE_RESPONSE tool
// call → response generation → callback invoked with the generated text. The fake-model
// approach for the stub test uses the no-LLM path (buildNoModelProviderReply) which avoids
// any network calls while still proving the callback contract.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Content, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { type BootedRuntime, bootStubRuntime } from "../src/runtime-host.js";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const ENTITY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const ROOM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;
const MSG_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as UUID;

function buildMessage(text: string): Memory {
  return {
    id: MSG_ID,
    agentId: AGENT_ID,
    entityId: ENTITY_ID,
    roomId: ROOM_ID,
    content: { text },
    createdAt: Date.now(),
  };
}

describe("T1 emitevent spike — message pipeline", () => {
  let booted: BootedRuntime;
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    booted = await bootStubRuntime(AGENT_ID);
    runtime = booted.runtime;
  });

  afterEach(async () => {
    // Stop the runtime so tests don't leak timers / background tasks.
    await runtime.stop();
  });

  it("messageService.handleMessage invokes callback with content.text (no LLM)", async () => {
    // Proves the message pipeline contract: callback receives Content with a non-empty text.
    // No real LLM is needed — buildNoModelProviderReply provides the response text.
    const received: Content[] = [];
    const callback = async (content: Content): Promise<Memory[]> => {
      received.push(content);
      return [];
    };

    const message = buildMessage("Hello agent");

    // Use messageService.handleMessage — NOT emitEvent (see module-level comment).
    const svc = runtime.messageService;
    expect(svc).not.toBeNull();

    await svc!.handleMessage(runtime, message, callback);

    // The pipeline must have called callback at least once with a text response.
    expect(received.length).toBeGreaterThan(0);
    const firstResponse = received[0];
    expect(typeof firstResponse.text).toBe("string");
    expect(firstResponse.text!.length).toBeGreaterThan(0);
  });

  it("emitEvent MESSAGE_RECEIVED does NOT invoke the response callback", async () => {
    // Documents the negative: emitEvent only fires plugin event handlers (trajectory
    // tracking, etc.) — it does not call messageService.handleMessage or the callback.
    const { EventType } = await import("@elizaos/core");
    const received: Content[] = [];
    const callback = async (content: Content): Promise<Memory[]> => {
      received.push(content);
      return [];
    };

    const message = buildMessage("Hello via emitEvent");

    // emitEvent returns after all plugin event handlers complete; callback is NOT called.
    await runtime.emitEvent(EventType.MESSAGE_RECEIVED, { message, callback });

    // Callback was NOT invoked — emitEvent is not the response pipeline entry point.
    expect(received.length).toBe(0);
  });

  it("stub runtime boots without TinyCloud plugin and has null storageService", () => {
    // Confirms stub mode is free of TinyCloud / live-node dependencies.
    expect(booted.storageService).toBeNull();
    expect(runtime).not.toBeNull();
    expect(runtime.messageService).not.toBeNull();
  });
});
