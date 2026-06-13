import { expect, test } from "bun:test";
import {
  AuthError,
  CircuitOpenError,
  QueueFullError,
  SqlError,
  TimeoutError,
  TinyCloudClientError,
} from "./index.ts";

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
