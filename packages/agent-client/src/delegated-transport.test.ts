// Unit tests for DelegatedTransport.
//
// All SDK interactions are replaced with fakes via the deps seam — no live node,
// no real key signing, no network. The tests mirror the private-key transport's
// behavior assertions so the two auth modes stay byte-identical at the seam.

import { expect, test } from "bun:test";
import { DelegatedTransport, type DelegatedSqlAccess } from "./delegated-transport.ts";
import type { IDatabaseHandle } from "@tinycloud/node-sdk";
import type { PortableDelegation } from "@tinycloud/node-sdk";
import type { BatchData, ExecuteData, QueryData, Transport } from "./transport.ts";
import { resolveDelegationConfig } from "./config.ts";
import { AuthError } from "./errors.ts";
import type { AgentIdentity } from "./agent-identity.ts";

// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

const AGENT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function makeResolvedConfig(overrides: Partial<ReturnType<typeof resolveDelegationConfig>> = {}) {
  return resolveDelegationConfig({
    mode: "delegation",
    serializedDelegation: "fake-serialized-delegation",
    agentKey: AGENT_KEY,
    ...overrides,
  });
}

/** Minimal fake PortableDelegation (only the fields DelegatedTransport reads). */
function fakeDelegation(ownerAddress = "0xowner1234567890abcdef1234567890abcdef12"): PortableDelegation {
  return {
    ownerAddress,
    // delegateDID must match fakeIdentity.did ("did:pkh:eip155:1:0xfakeagent")
    // so validateDelegationShape passes.
    delegateDID: "did:pkh:eip155:1:0xfakeagent",
    spaceId: "tinycloud:pkh:eip155:1:0xowner1234567890abcdef1234567890abcdef12:default",
    path: "xyz.tinycloud.eliza/memory",
    // Real delegations grant admin (Phase 5 runs ensureSchema DDL) — the wired
    // deep policy validator (defaultElizaMemoryPolicy) requires read+write+admin.
    actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
    expiry: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now (required by shape validator)
    cid: "fake-cid",
    delegationHeader: { Authorization: "Bearer SECRET-NEVER-LOGGED" },
    chainId: 1,
  } as unknown as PortableDelegation;
}

/** Fake IDatabaseHandle returning canned responses. */
function fakeDbHandle(
  opts: {
    queryResult?: object;
    executeResult?: object;
    batchResult?: object;
    error?: { code: string; message: string; service: string };
  } = {},
): IDatabaseHandle {
  const {
    queryResult = { columns: ["id"], rows: [[1]], rowCount: 1 },
    executeResult = { changes: 1, lastInsertRowId: 5 },
    batchResult = { results: [{ changes: 2, lastInsertRowId: 10 }] },
    error,
  } = opts;
  return {
    query: async () => (error ? { ok: false, error } : { ok: true, data: queryResult }),
    execute: async () => (error ? { ok: false, error } : { ok: true, data: executeResult }),
    batch: async () => (error ? { ok: false, error } : { ok: true, data: batchResult }),
  } as unknown as IDatabaseHandle;
}

/** Minimal fake DelegatedSqlAccess returned by the injected activate dep. */
function fakeSqlAccess(
  spaceId = "tinycloud:pkh:eip155:1:0xowner:default",
  handle = fakeDbHandle(),
): DelegatedSqlAccess {
  return {
    spaceId,
    sql: { db: () => handle },
  };
}

/** Fake agent identity (no real crypto). */
const fakeIdentity: AgentIdentity = {
  did: "did:pkh:eip155:1:0xfakeagent",
  normalizedKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
};

/** Build a DelegatedTransport pre-activated with injected fakes (bypasses real SDK). */
async function buildActivated(access = fakeSqlAccess()) {
  const transport = new DelegatedTransport(makeResolvedConfig(), {
    deserialize: () => fakeDelegation(),
    activate: async () => access,
    agentIdentity: async () => fakeIdentity,
  });
  await transport.signIn();
  return transport;
}

// ---------------------------------------------------------------------------
// 1. Implements Transport interface
// ---------------------------------------------------------------------------

test("DelegatedTransport implements the Transport interface (signIn/query/execute/batch are functions)", () => {
  const transport = new DelegatedTransport(makeResolvedConfig());
  // TypeScript already enforces the interface at compile time; this confirms
  // the runtime surface is present (all four methods exist as functions).
  const t: Transport = transport;
  expect(typeof t.signIn).toBe("function");
  expect(typeof t.query).toBe("function");
  expect(typeof t.execute).toBe("function");
  expect(typeof t.batch).toBe("function");
});

// ---------------------------------------------------------------------------
// 2. SQL before signIn returns typed NOT_ACTIVATED error
// ---------------------------------------------------------------------------

test("query before signIn returns NOT_ACTIVATED error (not null, not throw)", async () => {
  const transport = new DelegatedTransport(makeResolvedConfig());
  const result = await transport.query("SELECT 1");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("NOT_ACTIVATED");
    expect(result.error.service).toBe("delegation");
    expect(typeof result.error.message).toBe("string");
    expect(result.error.message.length).toBeGreaterThan(0);
  }
});

test("execute before signIn returns NOT_ACTIVATED error", async () => {
  const transport = new DelegatedTransport(makeResolvedConfig());
  const result = await transport.execute("INSERT INTO t VALUES (1)");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("NOT_ACTIVATED");
  }
});

test("batch before signIn returns NOT_ACTIVATED error", async () => {
  const transport = new DelegatedTransport(makeResolvedConfig());
  const result = await transport.batch([{ sql: "INSERT INTO t VALUES (1)" }]);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("NOT_ACTIVATED");
  }
});

test("NOT_ACTIVATED error never includes delegation secret material", async () => {
  const transport = new DelegatedTransport(makeResolvedConfig());
  const result = await transport.query("SELECT 1");
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("Authorization");
  expect(serialized).not.toContain("SECRET");
  expect(serialized).not.toContain(AGENT_KEY);
});

// ---------------------------------------------------------------------------
// 3. signIn() caches — second call reuses without re-activating
// ---------------------------------------------------------------------------

test("signIn() caches: second call reuses DelegatedAccess (activator called once)", async () => {
  let activateCalls = 0;
  const transport = new DelegatedTransport(makeResolvedConfig(), {
    deserialize: () => fakeDelegation(),
    activate: async () => { activateCalls++; return fakeSqlAccess(); },
    agentIdentity: async () => fakeIdentity,
  });

  const result1 = await transport.signIn();
  expect(activateCalls).toBe(1);

  const result2 = await transport.signIn();
  expect(activateCalls).toBe(1); // activator NOT called again
  expect(result2.spaceId).toBe(result1.spaceId);
  expect(result2.address).toBe(result1.address);
  expect(result2.did).toBe(result1.did);
});

// ---------------------------------------------------------------------------
// 4. query/execute/batch delegate to the injected fake handle and map
//    responses identically to the private-key transport
// ---------------------------------------------------------------------------

test("query delegates to injected DelegatedSqlAccess and maps QueryResponse → QueryData", async () => {
  const handle = fakeDbHandle({
    queryResult: { columns: ["id", "name"], rows: [[1, "alice"], [2, "bob"]], rowCount: 2 },
  });
  const transport = await buildActivated(fakeSqlAccess("space-1", handle));

  const result = await transport.query("SELECT id, name FROM users");
  expect(result.ok).toBe(true);
  if (result.ok) {
    const data: QueryData = result.data;
    expect(data.columns).toEqual(["id", "name"]);
    expect(data.rows).toEqual([[1, "alice"], [2, "bob"]]);
    expect(data.rowCount).toBe(2);
  }
});

test("execute delegates to injected handle and maps ExecuteResponse → ExecuteData", async () => {
  const handle = fakeDbHandle({
    executeResult: { changes: 3, lastInsertRowId: 42 },
  });
  const transport = await buildActivated(fakeSqlAccess("space-1", handle));

  const result = await transport.execute("INSERT INTO t VALUES (?, ?)", ["a", "b"]);
  expect(result.ok).toBe(true);
  if (result.ok) {
    const data: ExecuteData = result.data;
    expect(data.changes).toBe(3);
    expect(data.lastInsertRowId).toBe(42);
  }
});

test("batch delegates to injected handle and maps BatchResponse → BatchData", async () => {
  const handle = fakeDbHandle({
    batchResult: { results: [{ changes: 1, lastInsertRowId: 7 }, { changes: 2, lastInsertRowId: 8 }] },
  });
  const transport = await buildActivated(fakeSqlAccess("space-1", handle));

  const result = await transport.batch([
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "INSERT INTO t VALUES (2)" },
  ]);
  expect(result.ok).toBe(true);
  if (result.ok) {
    const data: BatchData = result.data;
    expect(data.results).toHaveLength(2);
    expect(data.results[0].changes).toBe(1);
    expect(data.results[0].lastInsertRowId).toBe(7);
    expect(data.results[1].changes).toBe(2);
    expect(data.results[1].lastInsertRowId).toBe(8);
  }
});

test("query result is identical shape to private-key transport (auth-composition.test.ts baseline)", async () => {
  // Mirrors the exact QueryData shape asserted in auth-composition.test.ts.
  const handle = fakeDbHandle({
    queryResult: { columns: ["id"], rows: [[1]], rowCount: 1 },
  });
  const transport = await buildActivated(fakeSqlAccess("space-1", handle));
  const result = await transport.query("SELECT 1");
  expect(result).toEqual({ ok: true, data: { columns: ["id"], rows: [[1]], rowCount: 1 } });
});

test("execute result is identical shape to private-key transport baseline", async () => {
  const handle = fakeDbHandle({ executeResult: { changes: 1 } });
  const transport = await buildActivated(fakeSqlAccess("space-1", handle));
  const result = await transport.execute("INSERT INTO t VALUES (1)");
  expect(result).toEqual({ ok: true, data: { changes: 1, lastInsertRowId: undefined } });
});

test("batch result is identical shape to private-key transport baseline", async () => {
  const handle = fakeDbHandle({ batchResult: { results: [{ changes: 1 }] } });
  const transport = await buildActivated(fakeSqlAccess("space-1", handle));
  const result = await transport.batch([{ sql: "INSERT INTO t VALUES (1)" }]);
  expect(result).toEqual({ ok: true, data: { results: [{ changes: 1, lastInsertRowId: undefined }] } });
});

// ---------------------------------------------------------------------------
// 5. SDK Result error maps to a redacted TransportError: only {code,message,service}
//    — cause/meta/Authorization never appear in the output
// ---------------------------------------------------------------------------

test("SDK query error maps to redacted TransportError (code+message+service, no cause/meta)", async () => {
  const sdkError = {
    code: "SQL_PERMISSION_DENIED",
    message: "Permission denied on table 't'",
    service: "sql",
    cause: new Error("inner cause — must be dropped"),
    meta: { Authorization: "Bearer SECRET — must be dropped" },
  };
  const handle = fakeDbHandle({ error: sdkError });
  const transport = await buildActivated(fakeSqlAccess("space-1", handle));

  const result = await transport.query("SELECT * FROM t");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("SQL_PERMISSION_DENIED");
    expect(result.error.message).toBe("Permission denied on table 't'");
    expect(result.error.service).toBe("sql");
    // Redaction: cause and meta must NOT leak through.
    const serialized = JSON.stringify(result.error);
    expect(serialized).not.toContain("cause");
    expect(serialized).not.toContain("inner cause");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("meta");
    // The TransportError has exactly these three keys.
    const errorKeys = Object.keys(result.error);
    expect(errorKeys).not.toContain("cause");
    expect(errorKeys).not.toContain("meta");
  }
});

test("SDK execute error maps to redacted TransportError", async () => {
  const sdkError = { code: "AUTH_EXPIRED", message: "Session expired", service: "auth" };
  const handle = fakeDbHandle({ error: sdkError });
  const transport = await buildActivated(fakeSqlAccess("space-1", handle));

  const result = await transport.execute("INSERT INTO t VALUES (1)");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("AUTH_EXPIRED");
    expect(result.error.service).toBe("auth");
  }
});

test("SDK batch error maps to redacted TransportError", async () => {
  const sdkError = { code: "SQL_READONLY_VIOLATION", message: "Read-only violation", service: "sql" };
  const handle = fakeDbHandle({ error: sdkError });
  const transport = await buildActivated(fakeSqlAccess("space-1", handle));

  const result = await transport.batch([{ sql: "DROP TABLE t" }]);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("SQL_READONLY_VIOLATION");
  }
});

// ---------------------------------------------------------------------------
// 6. signIn() with injected fakes returns correct SignInResult
// ---------------------------------------------------------------------------

test("signIn() with injected fakes returns SignInResult from access.spaceId and delegation.ownerAddress", async () => {
  const owner = "0xowner0000000000000000000000000000000001";
  const access = fakeSqlAccess("tinycloud:pkh:eip155:1:" + owner + ":default");
  const delegation = fakeDelegation(owner);
  const transport = new DelegatedTransport(makeResolvedConfig(), {
    deserialize: () => delegation,
    activate: async () => access,
    agentIdentity: async () => fakeIdentity,
  });

  const result = await transport.signIn();
  expect(result.spaceId).toBe(access.spaceId);
  expect(result.address).toBe(owner);
  expect(result.did).toBe(fakeIdentity.did);
});

test("signIn() calls activate exactly once and caches the handle (SQL works after)", async () => {
  let activateCalls = 0;
  const handle = fakeDbHandle({ queryResult: { columns: ["n"], rows: [[42]], rowCount: 1 } });
  const access = fakeSqlAccess("space-1", handle);
  const transport = new DelegatedTransport(makeResolvedConfig(), {
    deserialize: () => fakeDelegation(),
    activate: async () => { activateCalls++; return access; },
    agentIdentity: async () => fakeIdentity,
  });

  await transport.signIn();
  expect(activateCalls).toBe(1);

  const result = await transport.query("SELECT 42");
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.data.rows).toEqual([[42]]);
  }
});

test("db() passes dbHandle to sql.db() (not bare name, not empty)", async () => {
  const dbCalls: (string | undefined)[] = [];
  const access: DelegatedSqlAccess = {
    spaceId: "space-1",
    sql: {
      db: (name?: string) => {
        dbCalls.push(name);
        return fakeDbHandle();
      },
    },
  };
  const config = makeResolvedConfig({ dbHandle: "xyz.tinycloud.eliza/memory" });
  const transport = new DelegatedTransport(config, {
    deserialize: () => fakeDelegation(),
    activate: async () => access,
    agentIdentity: async () => fakeIdentity,
  });
  await transport.signIn();
  await transport.query("SELECT 1");
  expect(dbCalls).toContain("xyz.tinycloud.eliza/memory");
});

// ---------------------------------------------------------------------------
// 7. DelegatedTransport never leaks secrets in errors (activation failure + SQL)
// ---------------------------------------------------------------------------

test("forced activation failure: error thrown by signIn() never includes agentKey or serializedDelegation from config", async () => {
  const secretKey = "0xSECRETKEY_ACTIVATION_FAILURE_TEST_abc123";
  const secretDelegation = "SECRET_DELEGATION_ACTIVATION_FAILURE_TOKEN_xyz";

  const config = resolveDelegationConfig({
    mode: "delegation",
    serializedDelegation: secretDelegation,
    agentKey: secretKey,
  });

  const transport = new DelegatedTransport(config, {
    deserialize: () => fakeDelegation(),
    activate: async () => {
      throw new Error("activation failed: SDK error (no secrets here)");
    },
    agentIdentity: async () => fakeIdentity,
  });

  let caught: unknown = null;
  try {
    await transport.signIn();
  } catch (e) {
    caught = e;
  }

  expect(caught).not.toBeNull();
  const msg = caught instanceof Error ? caught.message : String(caught);
  // DelegatedTransport must not inject config secret values into thrown errors.
  expect(msg).not.toContain(secretKey);
  expect(msg).not.toContain(secretDelegation);
});

test("activation (network/SDK) failure surfaces as a typed AuthError with no secret leak", async () => {
  const secretKey = "0xSECRETKEY_AUTHERROR_TEST_def456";
  const secretAuth = "Bearer SECRET_AUTH_AUTHERROR_TEST";
  const config = resolveDelegationConfig({
    mode: "delegation",
    serializedDelegation: "SECRET_DELEGATION_AUTHERROR",
    agentKey: secretKey,
  });
  const transport = new DelegatedTransport(config, {
    deserialize: () => ({ ...fakeDelegation(), delegationHeader: { Authorization: secretAuth } } as unknown as PortableDelegation),
    // Simulate a node.signIn()/useDelegation network fault that (worst case)
    // echoes the auth header in its own message.
    activate: async () => {
      throw new Error(`network down while signing in with ${secretAuth}`);
    },
    agentIdentity: async () => fakeIdentity,
  });

  let caught: unknown = null;
  try {
    await transport.signIn();
  } catch (e) {
    caught = e;
  }
  // Typed: callers can classify it as an auth/activation failure.
  expect(caught).toBeInstanceOf(AuthError);
  // The fixed message never leaks secrets (the raw SDK error rides on `cause`).
  const msg = (caught as Error).message;
  expect(msg).not.toContain(secretKey);
  expect(msg).not.toContain(secretAuth);
});

test("validation rejects are NOT masked as AuthError (insufficient-actions stays a policy error)", async () => {
  // Inject a delegation that passes shape but fails the deep policy (no admin),
  // and an activate spy that must NEVER run.
  let activateCalls = 0;
  const transport = new DelegatedTransport(makeResolvedConfig(), {
    deserialize: () =>
      ({ ...fakeDelegation(), actions: ["tinycloud.sql/read", "tinycloud.sql/write"] } as unknown as PortableDelegation),
    activate: async () => {
      activateCalls++;
      return fakeSqlAccess();
    },
    agentIdentity: async () => fakeIdentity,
  });

  let caught: unknown = null;
  try {
    await transport.signIn();
  } catch (e) {
    caught = e;
  }
  expect(caught).not.toBeNull();
  // It is a policy rejection, NOT an AuthError — and activate never ran.
  expect(caught).not.toBeInstanceOf(AuthError);
  expect(activateCalls).toBe(0);
});

test("forced SQL error: TransportError never includes agentKey, serializedDelegation, or delegationHeader Authorization", async () => {
  const secretKey = "0xSECRETKEY_SQL_ERROR_TEST_xyz789";
  const secretDelegation = "SECRET_DELEGATION_SQL_ERROR_TOKEN_abc";
  const secretAuth = "Bearer SECRET_AUTHORIZATION_SQL_ERROR_VALUE";

  const config = resolveDelegationConfig({
    mode: "delegation",
    serializedDelegation: secretDelegation,
    agentKey: secretKey,
  });

  // SQL handle returning an error that (in the worst case) carries Authorization
  // in cause/meta — toTransportError must strip cause/meta before surfacing.
  const leakyHandle = {
    query: async () => ({
      ok: false as const,
      error: {
        code: "AUTH_UNAUTHORIZED",
        message: "Unauthorized",
        service: "sql",
        cause: new Error("inner SDK cause"),
        meta: { Authorization: secretAuth, key: secretKey },
      },
    }),
    execute: async () => ({ ok: true as const, data: { changes: 0 } }),
    batch: async () => ({ ok: true as const, data: { results: [] } }),
  } as unknown as IDatabaseHandle;

  const access = fakeSqlAccess("space-1", leakyHandle);
  const transport = new DelegatedTransport(config, {
    deserialize: () => ({
      ...fakeDelegation(),
      delegationHeader: { Authorization: secretAuth },
    } as unknown as PortableDelegation),
    activate: async () => access,
    agentIdentity: async () => fakeIdentity,
  });

  await transport.signIn();
  const result = await transport.query("SELECT 1");

  expect(result.ok).toBe(false);
  if (!result.ok) {
    const serialized = JSON.stringify(result.error);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain(secretDelegation);
    expect(serialized).not.toContain(secretAuth);
    expect(serialized).not.toContain("Authorization");
    // Only the redacted {code, message, service} fields survive.
    expect(result.error.code).toBe("AUTH_UNAUTHORIZED");
    expect(result.error.message).toBe("Unauthorized");
    expect(result.error.service).toBe("sql");
  }
});

// ---------------------------------------------------------------------------
// 8. invalidate() clears cache — next signIn() re-activates (re-activation contract)
// ---------------------------------------------------------------------------

test("invalidate() clears cached access: subsequent signIn() re-activates (activator called twice)", async () => {
  let activateCalls = 0;
  const transport = new DelegatedTransport(makeResolvedConfig(), {
    deserialize: () => fakeDelegation(),
    activate: async () => { activateCalls++; return fakeSqlAccess(); },
    agentIdentity: async () => fakeIdentity,
  });

  await transport.signIn();
  expect(activateCalls).toBe(1);

  // Without invalidate(), a second signIn() would return the cached result.
  // After invalidate(), it must rebuild.
  transport.invalidate();
  await transport.signIn();
  expect(activateCalls).toBe(2); // activator called again after invalidation
});

test("signIn() without preceding invalidate() reuses cached handle (activator called once)", async () => {
  let activateCalls = 0;
  const transport = new DelegatedTransport(makeResolvedConfig(), {
    deserialize: () => fakeDelegation(),
    activate: async () => { activateCalls++; return fakeSqlAccess(); },
    agentIdentity: async () => fakeIdentity,
  });

  await transport.signIn();
  await transport.signIn(); // no invalidate — must use cache
  expect(activateCalls).toBe(1);
});

test("after invalidate(), SQL methods return NOT_ACTIVATED until next signIn()", async () => {
  const transport = await buildActivated();

  // SQL works before invalidate.
  const before = await transport.query("SELECT 1");
  expect(before.ok).toBe(true);

  transport.invalidate();

  // SQL returns NOT_ACTIVATED immediately after invalidate (no re-signIn yet).
  const after = await transport.query("SELECT 1");
  expect(after.ok).toBe(false);
  if (!after.ok) {
    expect(after.error.code).toBe("NOT_ACTIVATED");
  }
});
