// The real Transport over @tinycloud/node-sdk.
//
// This is the ONLY file in agent-client that imports the node-sdk. It performs
// no queueing/retry/timeout — it just adapts node-sdk calls to the Transport seam
// (./transport.ts). The resilience layer (T3/T4) wraps this.
//
// HARD CONTRACT: zero host-framework (Eliza) imports — see ./index.ts.

import { TinyCloudNode } from "@tinycloud/node-sdk";
import type { IDatabaseHandle } from "@tinycloud/node-sdk";
import type { ResolvedAgentClientConfig } from "./config";
import { AuthError } from "./errors";
import type {
  BatchData,
  ExecuteData,
  QueryData,
  SignInResult,
  SqlStatement,
  SqlValue,
  Transport,
  TransportError,
  TransportResult,
} from "./transport";

/**
 * The node-sdk Result discriminant, structurally. We don't import the node-sdk's
 * `Result`/`ServiceError` (not re-exported from its entrypoint), so we describe
 * the success/error shapes we read locally.
 */
type SdkResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; service?: string } };

/** Map a node-sdk ServiceError shape to a redacted {@link TransportError} (drops `cause`). */
function toTransportError(error: {
  code: string;
  message: string;
  service?: string;
}): TransportError {
  return { code: error.code, message: error.message, service: error.service };
}

/** Adapt a node-sdk Result to a Transport Result, mapping data on success. */
function mapResult<T, U>(result: SdkResult<T>, mapData: (data: T) => U): TransportResult<U> {
  if (result.ok) return { ok: true, data: mapData(result.data) };
  return { ok: false, error: toTransportError(result.error) };
}

/** Real Transport: a thin adapter over a signed-in {@link TinyCloudNode}. */
export class NodeSdkTransport implements Transport {
  private readonly node: TinyCloudNode;
  private readonly dbHandle: string;

  constructor(config: ResolvedAgentClientConfig) {
    this.dbHandle = config.dbHandle;
    this.node = new TinyCloudNode({
      privateKey: config.privateKey,
      // `host` is SINGULAR (plan §2.5).
      host: config.host,
      prefix: config.prefix,
      // MANDATORY: defaults false → every invoke 404s (plan §2.5).
      autoCreateSpace: true,
    });
    // No Cloudflare UA workaround: Bun's default fetch UA passes prod
    // (spike-verified; plan §5 invariant 6).
  }

  async signIn(): Promise<SignInResult> {
    await this.node.signIn();
    const spaceId = this.node.spaceId;
    const address = this.node.address;
    const did = this.node.did;
    if (!spaceId) {
      throw new AuthError("signIn completed but no spaceId was established");
    }
    if (!address) {
      throw new AuthError("signIn completed but no address was established");
    }
    return { spaceId, address, did };
  }

  private db(): IDatabaseHandle {
    return this.node.sql.db(this.dbHandle);
  }

  async query(sql: string, params?: SqlValue[]): Promise<TransportResult<QueryData>> {
    const result = await this.db().query(sql, params);
    return mapResult(result, (data) => ({
      columns: data.columns,
      rows: data.rows,
      rowCount: data.rowCount,
    }));
  }

  async execute(sql: string, params?: SqlValue[]): Promise<TransportResult<ExecuteData>> {
    const result = await this.db().execute(sql, params);
    return mapResult(result, (data) => ({
      changes: data.changes,
      lastInsertRowId: data.lastInsertRowId,
    }));
  }

  async batch(statements: SqlStatement[]): Promise<TransportResult<BatchData>> {
    const result = await this.db().batch(statements);
    return mapResult(result, (data) => ({
      results: data.results.map((r) => ({
        changes: r.changes,
        lastInsertRowId: r.lastInsertRowId,
      })),
    }));
  }
}
