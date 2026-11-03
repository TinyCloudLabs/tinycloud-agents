import { jest } from "bun:test";

// Deadline tests run on virtual time: with jest.useFakeTimers() timers and Date.now() move only when advanced,
// so they exercise the real deadline code without waiting on the wall clock.
const STEP_MS = 5;

/** Resolves after `ms` of virtual time. */
export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Lets already-queued promise work run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** Advances virtual time in small steps, running pending promise work between steps, until the promise settles. */
export async function settle<T>(promise: Promise<T>, maxMs = 20_000): Promise<T> {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let elapsed = 0; !done && elapsed <= maxMs; elapsed += STEP_MS) {
    await flush();
    jest.advanceTimersByTime(STEP_MS);
  }
  await flush();
  return promise;
}
