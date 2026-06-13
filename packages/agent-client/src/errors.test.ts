import { describe, expect, test } from "bun:test";
import {
  AuthError,
  CircuitOpenError,
  DelegationPolicyError,
  QueueFullError,
  SqlError,
  TimeoutError,
  TinyCloudClientError,
} from "./index.ts";

describe("DelegationPolicyError", () => {
  test("is a TinyCloudClientError and an Error", () => {
    const e = new DelegationPolicyError("malformed delegation: could not deserialize", "MALFORMED");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(TinyCloudClientError);
    expect(e).toBeInstanceOf(DelegationPolicyError);
    expect(e.name).toBe("DelegationPolicyError");
  });

  test("carries the reason code", () => {
    const reasons = [
      "MALFORMED",
      "WRONG_DELEGATEE",
      "EXPIRED",
      "MISSING_SQL_RESOURCE",
      "WRONG_DB_HANDLE",
      "INSUFFICIENT_ACTIONS",
    ] as const;
    for (const reason of reasons) {
      const e = new DelegationPolicyError(`test ${reason}`, reason);
      expect(e.reason).toBe(reason);
    }
  });

  test("message never contains Authorization or authHeader", () => {
    const e = new DelegationPolicyError(
      "malformed delegation: missing delegateDID",
      "MALFORMED",
      { field: "delegateDID" },
    );
    expect(e.message.toLowerCase()).not.toContain("authorization");
    expect(e.message.toLowerCase()).not.toContain("authheader");
  });

  test("can carry non-secret context without leaking secret fields", () => {
    const e = new DelegationPolicyError(
      "wrong delegatee",
      "WRONG_DELEGATEE",
      { expectedDID: "did:pkh:eip155:1:0xABCD", actualDID: "did:pkh:eip155:1:0x1234" },
    );
    expect(e.context).toEqual({
      expectedDID: "did:pkh:eip155:1:0xABCD",
      actualDID: "did:pkh:eip155:1:0x1234",
    });
    // Context must not reference auth-bearing fields
    const serialized = JSON.stringify({ msg: e.message, ctx: e.context });
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized.toLowerCase()).not.toContain("authheader");
  });
});

test("every typed error is a TinyCloudClientError and an Error", () => {
  const errors = [
    new TimeoutError(10_000, "query"),
    new QueueFullError(50),
    new CircuitOpenError(),
    new AuthError("nope"),
    new SqlError("bad", { op: "query", code: "SQL_ERROR", sql: "SELECT" }),
  ];
  for (const e of errors) {
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(TinyCloudClientError);
    expect(e.name).toBe(e.constructor.name);
  }
});

test("instanceof discriminates subclasses (catchable by type)", () => {
  expect(new TimeoutError(5, "execute")).toBeInstanceOf(TimeoutError);
  expect(new QueueFullError(1)).not.toBeInstanceOf(TimeoutError);
});

test("SqlError carries op context but no auth header", () => {
  const e = new SqlError("not authorized", { op: "execute", code: "SQL_ERROR", sql: "CREATE" });
  expect(e.context.op).toBe("execute");
  expect(e.context.sql).toBe("CREATE");
  // The serialized error must not leak an Authorization header.
  expect(JSON.stringify({ msg: e.message, ctx: e.context }).toLowerCase()).not.toContain(
    "authorization",
  );
});
