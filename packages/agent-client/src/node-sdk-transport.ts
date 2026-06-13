// The real Transport over @tinycloud/node-sdk (private-key mode).
//
// This file adapts node-sdk calls to the Transport seam (./transport.ts).
// It performs no queueing/retry/timeout — the resilience layer (T3/T4) wraps it.
//
// SQL result mapping is shared with DelegatedTransport via sql-handle-adapter.ts.
//
// HARD CONTRACT: zero host-framework (Eliza) imports — see ./index.ts.

import { TinyCloudNode } from "@tinycloud/node-sdk";
import type { IDatabaseHandle } from "@tinycloud/node-sdk";
import type { ResolvedAgentClientConfig } from "./config";
import { AuthError } from "./errors";
import { adapterBatch, adapterExecute, adapterQuery } from "./sql-handle-adapter";
import type {
  BatchData,
  ExecuteData,
  QueryData,
  SignInResult,
  SqlStatement,
  SqlValue,
  Transport,
  TransportResult,
} from "./transport";

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
    return adapterQuery(this.db(), sql, params);
  }

  async execute(sql: string, params?: SqlValue[]): Promise<TransportResult<ExecuteData>> {
    return adapterExecute(this.db(), sql, params);
  }

  async batch(statements: SqlStatement[]): Promise<TransportResult<BatchData>> {
    return adapterBatch(this.db(), statements);
  }
}
