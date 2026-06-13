// createAgentClient — the public composition root (plan §3 client shape).
//
// Composes transport + worker + session + sql + schema into the public client:
//   {
//     sql: { query, execute, batch, withRowObjects },
//     ensureSchema,
//     signIn,
//     stop,
//   }
//
// The eliza-plugin-memory service (and a future OpenClaw plugin) consume THIS
// surface — they never touch the worker, session, or transport directly.
//
// Testability: pass `deps` to inject a fake Transport / Worker / Clock / Logger so
// T5 can drive the resilience + session machinery without a live node.
//
// HARD CONTRACT: zero host-framework (Eliza) imports — see ./index.ts.

import {
  resolveConfig,
  resolveDelegationConfig,
  type AgentClientAuthConfig,
  type AgentClientConfig,
} from "./config";
import { DelegatedTransport } from "./delegated-transport";
import { consoleLogger, type Logger } from "./logger";
import { NodeSdkTransport } from "./node-sdk-transport";
import { createEnsureSchema, type EnsureSchema } from "./schema";
import { Session } from "./session";
import { createSql, type SqlApi } from "./sql";
import type { SignInResult, Transport } from "./transport";
import { realClock, Worker, type Clock } from "./worker";

/** Injectable dependencies (tests / alternate transports). All optional. */
export interface AgentClientDeps {
  /** Override the node I/O seam (default: {@link NodeSdkTransport}). */
  transport?: Transport;
  /** Override the serialized worker (default: a {@link Worker} built from config). */
  worker?: Worker;
  /** Timing seam (default: {@link realClock}). */
  clock?: Clock;
  /** Logger (default: consoleLogger). */
  logger?: Logger;
}

/** The public client surface (plan §3). */
export interface AgentClient {
  /** SQL helpers — unwrapped data or typed SqlError. */
  sql: SqlApi;
  /** Memoized CREATE TABLE bootstrap (CREATE TABLE only — plan §2.5/§4). */
  ensureSchema: EnsureSchema;
  /** Establish (lazily) the session — idempotent; returns the established session. */
  signIn(): Promise<SignInResult>;
  /** Flush in-flight writes (bounded ~5s), clear timers, reject queued work. */
  stop(): Promise<void>;
}

/**
 * Build a client from an {@link AgentClientAuthConfig}. Supports both
 * private-key mode and delegation mode.
 */
export function createAgentClient(
  config: AgentClientAuthConfig,
  deps: AgentClientDeps = {},
): AgentClient {
  const clock = deps.clock ?? realClock;
  const logger = deps.logger ?? consoleLogger;

  if (config.mode === "delegation") {
    const resolved = resolveDelegationConfig(config);
    const transport = deps.transport ?? new DelegatedTransport(resolved);
    const worker =
      deps.worker ??
      new Worker({
        requestTimeoutMs: resolved.requestTimeoutMs,
        writeQueueLimit: resolved.writeQueueLimit,
        breakerThreshold: resolved.breakerThreshold,
        breakerOpenMs: resolved.breakerOpenMs,
        clock,
        logger,
      });

    const session = new Session({
      transport,
      worker,
      reSignInMs: resolved.reSignInMs,
      proactiveRefresh: false,
      clock,
      logger,
    });

    const sql = createSql(session, transport);
    const ensureSchema = createEnsureSchema(sql, logger);

    return {
      sql,
      ensureSchema,
      signIn: () => session.ensureSignedIn(),
      stop: async () => {
        await session.stop();
      },
    };
  }

  const resolved = resolveConfig(config);

  const transport = deps.transport ?? new NodeSdkTransport(resolved);
  const worker =
    deps.worker ??
    new Worker({
      requestTimeoutMs: resolved.requestTimeoutMs,
      writeQueueLimit: resolved.writeQueueLimit,
      breakerThreshold: resolved.breakerThreshold,
      breakerOpenMs: resolved.breakerOpenMs,
      clock,
      logger,
    });

  const session = new Session({
    transport,
    worker,
    reSignInMs: resolved.reSignInMs,
    clock,
    logger,
  });

  const sql = createSql(session, transport);
  const ensureSchema = createEnsureSchema(sql, logger);

  return {
    sql,
    ensureSchema,
    signIn: () => session.ensureSignedIn(),
    stop: async () => {
      await session.stop();
    },
  };
}
