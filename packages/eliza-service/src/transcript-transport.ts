import { KVService, NodeWasmBindings, SQLService, ServiceContext, TinyCloudNode } from "@tinycloud/node-sdk";
import type { DelegatedAccess, FetchFunction, IWasmBindings, PortableDelegation } from "@tinycloud/node-sdk";

export const TRANSCRIPT_RESPONSE_BYTE_LIMIT = 1_048_576;
export type TranscriptFetch = (url: string, init?: Parameters<FetchFunction>[1]) => Promise<Response>;

/** Keep activation unchanged and replace only the delegated storage services. */
export function createTranscriptNode(args: { privateKey: string; host: string }) {
  const bindings = new NodeWasmBindings();
  const node = new TinyCloudNode({ ...args, wasmBindings: bindings });
  return {
    signIn: () => node.signIn(),
    async useDelegation(delegation: PortableDelegation) {
      const access = await node.useDelegation(delegation);
      return createTranscriptServices(access, args.host, bindings, globalThis.fetch.bind(globalThis));
    },
  };
}

/**
 * Reuse the public activated-session export and the same WASM bindings used by
 * TinyCloudNode. These are precisely the inputs DelegatedAccess gives its SDK
 * services in 2.6.0. Never substitute the portable parent or node's own session.
 */
export function createTranscriptServices(
  access: Pick<DelegatedAccess, "restorable" | "path" | "delegation">,
  host: string,
  bindings: Pick<IWasmBindings, "invoke" | "invokeAny">,
  fetchImpl: TranscriptFetch,
) {
  const context = new ServiceContext({
    invoke: bindings.invoke, invokeAny: bindings.invokeAny,
    hosts: [access.delegation.host ?? host], fetch: createTranscriptFetch(fetchImpl),
  });
  const kv = new KVService({ prefix: access.path.replace(/\/$/, "") });
  const sql = new SQLService({});
  kv.initialize(context); context.registerService("kv", kv);
  sql.initialize(context); context.registerService("sql", sql);
  context.setSession(access.restorable);
  return { kv, sql };
}

export class TranscriptResponseLimitError extends Error {
  readonly code = "TRANSCRIPT_RESPONSE_SIZE_LIMIT";
  constructor(readonly status: number) {
    super("Transcript response exceeds the decoded byte limit");
    this.name = "TranscriptResponseLimitError";
  }
}

/**
 * Count native fetch's decoded bytes before handing a body to SDK text/json.
 * The retained input buffer is at most 1 MiB. The crossing chunk has already
 * been allocated by fetch, and native queues/decompression are outside this
 * bound. Response construction and SDK decoding/parsing add bounded copies;
 * this is not a process-memory or network-allocation ceiling.
 */
export function createTranscriptFetch(fetchImpl: TranscriptFetch): FetchFunction {
  return async (url, init) => {
    const signal = init?.signal;
    const abortError = () => new DOMException("Transcript request cancelled", "AbortError");
    if (signal?.aborted) throw abortError();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let received: Response | undefined;
    let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const cancel = () => {
      const cancellation = reader ? reader.cancel() : received?.body?.cancel();
      void cancellation?.catch(() => {});
    };
    const onAbort = () => { cancel(); rejectAbort(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const pending = fetchImpl(url, init);
      // A noncompliant fetch may resolve after its caller has already aborted.
      void pending.then(response => {
        received = response;
        if (signal?.aborted) cancel();
      }, () => {});
      const response = await Promise.race([pending, aborted]);
      if (signal?.aborted) throw abortError();
      if (!response.body) return response;
      reader = response.body.getReader();
      const bytes = new Uint8Array(TRANSCRIPT_RESPONSE_BYTE_LIMIT);
      let size = 0;
      while (true) {
        // cancel() resolves a pending read even if source cleanup hangs. Avoid
        // retaining an abort-promise reaction for every small incoming chunk.
        const chunk = await reader.read();
        if (signal?.aborted) throw abortError();
        if (chunk.done) break;
        if (chunk.value.byteLength > bytes.byteLength - size) {
          cancel();
          throw new TranscriptResponseLimitError(response.status);
        }
        bytes.set(chunk.value, size);
        size += chunk.value.byteLength;
      }
      return new Response(bytes.subarray(0, size), {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    } finally {
      signal?.removeEventListener("abort", onAbort);
      reader?.releaseLock();
    }
  };
}
