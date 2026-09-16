import { AsyncLocalStorage } from "node:async_hooks";

const privateAccess = new AsyncLocalStorage<() => boolean>();

/** Pin all nested private work, including legacy runtime callbacks, to its admission lease. */
export function withPrivateAccess<T>(isCurrent: () => boolean, operation: () => T): T {
  const parent = privateAccess.getStore();
  return privateAccess.run(() => (!parent || parent()) && isCurrent(), operation);
}

export function currentPrivateAccess(): (() => boolean) | undefined {
  return privateAccess.getStore();
}
