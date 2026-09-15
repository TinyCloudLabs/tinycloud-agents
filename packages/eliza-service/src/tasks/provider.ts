import { TASK_FRAME_BYTES, TaskError, object, type TaskConfig, type TaskMessage } from "./contract.js";

/** Abort races settle locally even when upstream ignores AbortSignal. Late failures stay observed. */
export async function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); throw new TaskError("task_cancelled"); }
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => { cancel = () => reject(new TaskError("task_cancelled")); });
  signal.addEventListener("abort", cancel, { once: true });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener("abort", cancel); }
}

export interface ProviderOptions { tools?: readonly unknown[]; tool_choice?: "auto" | "none"; reasoning_effort?: "low" }
export async function* providerEvents(config: TaskConfig, model: string, messages: TaskMessage[], signal: AbortSignal, options: ProviderOptions = {}): AsyncGenerator<Record<string, unknown>> {
  if (signal.aborted) throw new TaskError("task_cancelled");
  let received: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelBody = () => { void (reader ? reader.cancel() : received?.body?.cancel())?.catch(() => {}); };
  signal.addEventListener("abort", cancelBody, { once: true });
  try {
    const pending = (config.fetchImpl ?? fetch)(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model, messages, ...options, stream: true, stream_options: { include_usage: true } }),
      signal,
    });
    void pending.then(response => { received = response; if (signal.aborted) cancelBody(); }, () => {});
    const response = await withAbort(pending, signal);
    if (!response.ok || !response.body) throw new TaskError("upstream_failed");
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    // Find ASCII SSE frame boundaries before UTF-8 decoding. A malformed later
    // frame in the same native chunk must not erase already complete usage.
    // Four extra bytes allow the longest CRLF separator at the frame limit.
    const buffer = new Uint8Array(TASK_FRAME_BYTES + 4);
    let size = 0;
    for (;;) {
      const next = await withAbort(reader.read(), signal);
      if (signal.aborted) throw new TaskError("task_cancelled");
      if (next.done) throw new TaskError("upstream_incomplete");
      for (const byte of next.value) {
        if (size === buffer.length) throw new TaskError("result_size_limit");
        buffer[size++] = byte;
        let separator = 0;
        if (byte === 10) {
          if (size >= 2 && buffer[size - 2] === 10) separator = size >= 3 && buffer[size - 3] === 13 ? 3 : 2;
          else if (size >= 3 && buffer[size - 2] === 13 && buffer[size - 3] === 10) separator = size >= 4 && buffer[size - 4] === 13 ? 4 : 3;
        }
        if (separator) {
          const frameSize = size - separator;
          if (frameSize > TASK_FRAME_BYTES) throw new TaskError("result_size_limit");
          let frame: string;
          try { frame = decoder.decode(buffer.subarray(0, frameSize)); }
          catch { throw new TaskError("upstream_incomplete"); }
          size = 0;
          const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
          if (!data) continue;
          if (data === "[DONE]") return;
          let value: unknown;
          try { value = JSON.parse(data); } catch { throw new TaskError("upstream_incomplete"); }
          if (!object(value)) throw new TaskError("upstream_incomplete");
          // Usage is consumed by the runner before errors or choices in this same frame.
          yield value;
        }
      }
    }
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskError(signal.aborted ? "task_cancelled" : "upstream_failed");
  } finally {
    signal.removeEventListener("abort", cancelBody);
    cancelBody();
    try { reader?.releaseLock(); } catch { /* Noncompliant source cleanup cannot hold accounting. */ }
  }
}
