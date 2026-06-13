// Block 4(a) — CI SEAM CHECK, compile-time half (plan §8.2).
//
// A purely type-level assertion that our service instance type stays assignable
// to `MemoryStorageProvider` as imported from the resolved `@elizaos/core`. If the
// host seam drifts (a signature changes, a method is added/removed), instantiating
// the constrained alias below fails `tsc` — loudly, before runtime. This is a
// belt-and-suspenders companion to `storage.ts`'s `implements MemoryStorageProvider`.
//
// This file is deliberately NOT a *.test.ts: the package tsconfig excludes test
// files from `tsc`, and this assertion only bites when `tsc` evaluates it. It
// emits to an empty module (all types), so shipping it in dist is harmless.

import type { MemoryStorageProvider } from "@elizaos/core";

import type { TinyCloudMemoryStorageService } from "../storage";

/** Identity alias constrained to the host seam — instantiating it forces the check. */
type AssignableToSeam<T extends MemoryStorageProvider> = T;

/** Fails tsc if our instance type ever stops satisfying MemoryStorageProvider. */
export type SeamAssignabilityCheck = AssignableToSeam<TinyCloudMemoryStorageService>;
