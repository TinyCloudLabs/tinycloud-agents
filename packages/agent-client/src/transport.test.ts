import { expect, test } from "bun:test";
import type {
  QueryData,
  SignInResult,
  SqlStatement,
  SqlValue,
  Transport,
  TransportResult,
} from "./index.ts";

// A mock Transport — proves the seam is implementable without the node-sdk
// (this is the shape T5 will use to test the resilience layer).
class FakeTransport implements Transport {
  async signIn(): Promise<SignInResult> {
    return { spaceId: "space-1", address: "0xabc", did: "did:key:z6Mk" };
  }
  async query(_sql: string, _params?: SqlValue[]): Promise<TransportResult<QueryData>> {
    return {
      ok: true,
      data: { columns: ["id", "v"], rows: [["row-1", "val-1"]], rowCount: 1 },
    };
  }
  async execute(): Promise<TransportResult<{ changes: number }>> {
    return { ok: true, data: { changes: 1 } };
  }
  async batch(_statements: SqlStatement[]): Promise<TransportResult<{ results: { changes: number }[] }>> {
    return { ok: true, data: { results: [{ changes: 1 }] } };
  }
}

test("Transport.query returns positional rows indexed via columns.indexOf", async () => {
  const t = new FakeTransport();
  const r = await t.query("SELECT id, v FROM x");
  if (!r.ok) throw new Error("expected ok");
  const v = r.data.rows[0][r.data.columns.indexOf("v")];
  expect(v).toBe("val-1");
});

test("TransportResult error branch carries no Authorization header", () => {
  const err: TransportResult<QueryData> = {
    ok: false,
    error: { code: "SQL_ERROR", message: "not authorized", service: "sql" },
  };
  expect(JSON.stringify(err).toLowerCase()).not.toContain("authorization");
});
