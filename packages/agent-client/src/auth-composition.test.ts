// Cross-layer composition tests for the OpenKey auth groundwork.
//
// The per-layer tests (config.test.ts, agent-identity.test.ts) already prove
// each unit in isolation. This file locks down the SEAMS BETWEEN those layers —
// the contracts Phase 3 (delegated transport) will build on per the handoff's
// suggested implementation order:
//
//   3. Load stable agent identity using the existing helper.
//   4. Validate delegate DID matches the stable agent DID.
//   6. Implement the Transport API and feed it through createAgentClient.
//
// If any of these seams shift silently, Phase 3 breaks. These tests are the
// tripwire. They also characterize the CURRENT security posture of the resolved
// delegation config (a known Phase-3 redaction TODO from the handoff) so the day
// that posture changes, the change is deliberate.

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  resolveConfig,
  resolveDelegationConfig,
  agentIdentityFromKey,
  agentIdentityFromFile,
  createAgentClient,
  silentLogger,
} from "./index.ts";
import type {
  Transport,
  SignInResult,
  QueryData,
  ExecuteData,
  BatchData,
} from "./index.ts";

// Deterministic hardhat test key — never a real production key.
const AGENT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// ---------------------------------------------------------------------------
// Seam 1: resolveDelegationConfig → agentIdentityFromKey
//
// Phase 3 step 3-4: take the agentKey the config carried, derive the stable
// agent DID, and check the delegation's delegatee matches it. This proves the
// key material survives config resolution in a form the identity helper can
// consume.
// ---------------------------------------------------------------------------

test("resolved delegation agentKey feeds agentIdentityFromKey and yields a stable DID", async () => {
  const resolved = resolveDelegationConfig({
    mode: "delegation",
    serializedDelegation: "serialized-portable-delegation",
    agentKey: AGENT_KEY,
  });

  // The config carries the key forward verbatim (no transformation).
  expect(resolved.agentKey).toBe(AGENT_KEY);

  // Phase 3 will hand exactly this string to the identity helper.
  const identity = await agentIdentityFromKey(resolved.agentKey!);
  expect(identity.did).toMatch(/^did:pkh:eip155:1:0x[0-9a-fA-F]{40}$/);

  // ...and it must be the SAME DID the helper derives directly from the key,
  // i.e. config resolution does not perturb the identity.
  const direct = await agentIdentityFromKey(AGENT_KEY);
  expect(identity.did).toBe(direct.did);
});

// ---------------------------------------------------------------------------
// Seam 2: config layer is filesystem-pure
//
// resolveDelegationConfig accepts *File paths but must NOT read them — file I/O
// lives in agentIdentityFromFile (and the future delegation loader). Pinning
// this keeps the boundary clear so Phase 3 reads each file exactly once, in one
// place. A nonexistent path resolving cleanly is the proof.
// ---------------------------------------------------------------------------

test("resolveDelegationConfig does not touch the filesystem (carries paths forward)", () => {
  const ghost = "/nonexistent/this-path-does-not-exist.key";
  const resolved = resolveDelegationConfig({
    mode: "delegation",
    delegationFile: "/nonexistent/delegation.json",
    agentKeyFile: ghost,
  });
  // No throw despite the paths not existing — the config never opened them.
  expect(resolved.agentKeyFile).toBe(ghost);
  expect(resolved.delegationFile).toBe("/nonexistent/delegation.json");
  expect(resolved.agentKey).toBeUndefined();
  expect(resolved.serializedDelegation).toBeUndefined();
});

test("agentIdentityFromFile is where file I/O actually happens (round-trips to the same DID)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-composition-"));
  const keyFile = join(dir, "agent.key");
  writeFileSync(keyFile, AGENT_KEY + "\n");

  // A resolved config pointing at the file does NOT yet have a DID — only the
  // identity helper, reading the file, produces one.
  const resolved = resolveDelegationConfig({
    mode: "delegation",
    serializedDelegation: "d",
    agentKeyFile: keyFile,
  });
  const identity = await agentIdentityFromFile(resolved.agentKeyFile!);
  const direct = await agentIdentityFromKey(AGENT_KEY);
  expect(identity.did).toBe(direct.did);
});

// ---------------------------------------------------------------------------
// Seam 3: SECURITY characterization of ResolvedDelegationConfig
//
// Handoff known-finding: ResolvedDelegationConfig stores raw serializedDelegation
// and agentKey; a redaction strategy / toJSON guard was deferred to Phase 3.
// These tests DOCUMENT the current posture so it is a tracked decision, not a
// silent leak — and so the day Phase 3 adds redaction, these flip deliberately.
// ---------------------------------------------------------------------------

test("resolved delegation config property access returns real values (transport consumption preserved)", () => {
  const resolved = resolveDelegationConfig({
    mode: "delegation",
    serializedDelegation: "SECRET_DELEGATION",
    agentKey: "0xSECRETKEY",
  });
  // Property access must return the real value so the transport can consume it
  // (e.g. resolved.agentKey is passed to agentIdentityFromKey). toJSON redacts
  // only the serialized form — see the next test.
  expect(resolved.agentKey).toBe("0xSECRETKEY");
  expect(resolved.serializedDelegation).toBe("SECRET_DELEGATION");
});

test("JSON.stringify of a resolved delegation config does NOT expose secrets (toJSON redaction)", () => {
  const resolved = resolveDelegationConfig({
    mode: "delegation",
    serializedDelegation: "SECRET_DELEGATION",
    agentKey: "0xSECRETKEY",
  });
  const dumped = JSON.stringify(resolved);
  // toJSON redaction: agentKey and serializedDelegation are replaced with
  // "[REDACTED]" so accidental log/JSON.stringify cannot leak key material.
  expect(dumped).not.toContain("0xSECRETKEY");
  expect(dumped).not.toContain("SECRET_DELEGATION");
  expect(dumped).toContain("[REDACTED]");
});

// ---------------------------------------------------------------------------
// Seam 4: createAgentClient composition root over an injected Transport
//
// Phase 3 wires delegation mode into the composition root. These tests prove
// both private-key and delegation modes compose a working client from an
// injected transport (signIn / sql / stop all wire through the seam), and that
// delegation mode rejects a structurally invalid config before constructing
// anything.
// ---------------------------------------------------------------------------

/** A fake transport recording calls, returning canned ok results. */
function fakeTransport() {
  const calls: string[] = [];
  const signInResult: SignInResult = {
    spaceId: "space-1",
    address: "0xagent",
    did: "did:pkh:eip155:1:0xagent",
  };
  const transport: Transport = {
    signIn: async () => {
      calls.push("signIn");
      return signInResult;
    },
    query: async () => {
      calls.push("query");
      const data: QueryData = { columns: ["id"], rows: [[1]], rowCount: 1 };
      return { ok: true, data };
    },
    execute: async () => {
      calls.push("execute");
      const data: ExecuteData = { changes: 1 };
      return { ok: true, data };
    },
    batch: async () => {
      calls.push("batch");
      const data: BatchData = { results: [{ changes: 1 }] };
      return { ok: true, data };
    },
  };
  return { transport, calls, signInResult };
}

test("createAgentClient (private-key) composes a working client over an injected transport", async () => {
  const fake = fakeTransport();
  const client = createAgentClient(
    { privateKey: "0xabc" },
    { transport: fake.transport, logger: silentLogger },
  );

  // Public surface is fully shaped.
  expect(typeof client.signIn).toBe("function");
  expect(typeof client.sql.query).toBe("function");
  expect(typeof client.ensureSchema).toBe("function");
  expect(typeof client.stop).toBe("function");

  // signIn wires through to the transport seam.
  const session = await client.signIn();
  expect(session).toEqual(fake.signInResult);

  // A read unwraps the transport Result into data (no `ok` branching for callers).
  const data = await client.sql.query("SELECT 1");
  expect(data).toEqual({ columns: ["id"], rows: [[1]], rowCount: 1 });
  expect(fake.calls).toContain("query");

  // withRowObjects maps positional rows → keyed objects.
  expect(client.sql.withRowObjects(data)).toEqual([{ id: 1 }]);

  await client.stop();
});

test("createAgentClient (delegation) composes a working client over an injected delegated transport (signIn/sql/stop wire through)", async () => {
  const fake = fakeTransport();
  // The injected-deps.transport path works for BOTH modes; no real delegation
  // activation occurs here — the fake transport handles signIn directly.
  const client = createAgentClient(
    { mode: "delegation", serializedDelegation: "d", agentKey: AGENT_KEY },
    { transport: fake.transport, logger: silentLogger },
  );

  // Public surface is fully shaped.
  expect(typeof client.signIn).toBe("function");
  expect(typeof client.sql.query).toBe("function");
  expect(typeof client.ensureSchema).toBe("function");
  expect(typeof client.stop).toBe("function");

  // signIn wires through to the injected transport seam.
  const session = await client.signIn();
  expect(session).toEqual(fake.signInResult);
  expect(fake.calls).toContain("signIn");

  // SQL routes through the injected transport.
  const data = await client.sql.query("SELECT 1");
  expect(data).toEqual({ columns: ["id"], rows: [[1]], rowCount: 1 });
  expect(fake.calls).toContain("query");

  // withRowObjects maps positional rows → keyed objects.
  expect(client.sql.withRowObjects(data)).toEqual([{ id: 1 }]);

  await client.stop();
});

test("createAgentClient (delegation) still rejects a structurally invalid config with an actionable, secret-free error", () => {
  // Missing both delegation source — resolveDelegationConfig throws before
  // constructing the client.
  let threw = false;
  try {
    createAgentClient(
      // @ts-expect-error intentionally invalid: no delegation source
      { mode: "delegation", agentKey: AGENT_KEY },
      { logger: silentLogger },
    );
  } catch (e) {
    threw = true;
    const msg = (e as Error).message;
    // Error is actionable (names the missing fields) and secret-free.
    expect(msg).toMatch(/delegation source/i);
    expect(msg).not.toContain(AGENT_KEY);
  }
  expect(threw).toBe(true);
});

// ---------------------------------------------------------------------------
// Seam 5: the two resolvers stay structurally compatible
//
// Private-key and delegation both flow into createAgentClient via the union.
// They must agree on the shared resilience knobs so a single transport/worker
// construction path serves both (Phase 3 reuses the worker for delegated mode).
// ---------------------------------------------------------------------------

test("private-key and delegation resolvers agree on shared resilience-knob defaults", () => {
  const pk = resolveConfig({ privateKey: "0xabc" });
  const del = resolveDelegationConfig({
    mode: "delegation",
    serializedDelegation: "d",
    agentKey: AGENT_KEY,
  });
  expect(del.host).toBe(pk.host);
  expect(del.dbHandle).toBe(pk.dbHandle);
  expect(del.requestTimeoutMs).toBe(pk.requestTimeoutMs);
  expect(del.writeQueueLimit).toBe(pk.writeQueueLimit);
  expect(del.breakerThreshold).toBe(pk.breakerThreshold);
  expect(del.breakerOpenMs).toBe(pk.breakerOpenMs);
  expect(del.reSignInMs).toBe(pk.reSignInMs);
});
