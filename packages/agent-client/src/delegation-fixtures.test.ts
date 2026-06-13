// Shared signed-att wire-format fixtures for delegation tests (review #8).
//
// The UCAN `att` JWT shape was hand-encoded in THREE test files (delegation-normalize,
// delegated-transport-policy-reject, delegated-transport). This is now the SINGLE source
// for the wire format + the canonical owner/space/db-handle constants, so a format change
// lands in one place. Named `*.test.ts` so it is excluded from the published build (see
// tsconfig `exclude`); it intentionally contains no `test()` cases.

/** A real, mainnet-checksummed EVM address — must be valid 0x+40-hex so parseSpaceUri accepts it. */
export const OWNER = "0x7d0333579C19E8fa149C2dbf8405cb6f66c373f2";
export const AGENT_DID = "did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c";
export const OTHER_DID = "did:pkh:eip155:1:0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
export const AGENT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const DB_HANDLE = "xyz.tinycloud.eliza/memory";
export const SPACE = `tinycloud:pkh:eip155:1:${OWNER}:default`;
export const SQL_URI = `${SPACE}/sql/${DB_HANDLE}`;
export const CAP_URI = `${SPACE}/capabilities/${DB_HANDLE}`;

export const FULL_SQL_ACTIONS = [
  "tinycloud.sql/read",
  "tinycloud.sql/write",
  "tinycloud.sql/admin",
] as const;

export function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Build an (unsigned, for-test) UCAN-shaped JWT carrying the given `att`. */
export function makeJwt(att: Record<string, unknown>, opts: { aud?: string; exp?: number } = {}): string {
  const header = b64url({ alg: "EdDSA", typ: "JWT" });
  const payload = b64url({ att, aud: opts.aud ?? AGENT_DID, exp: opts.exp ?? 9999999999 });
  return `${header}.${payload}.sig`; // signature is never verified by the normalizer
}

/** Build a UCAN `att` granting the given SQL actions (at sqlPath) + optional capabilities. */
export function makeAtt(opts: {
  sqlActions?: readonly string[];
  sqlPath?: string;
  caps?: boolean;
  space?: string;
} = {}): Record<string, unknown> {
  const { sqlActions, sqlPath = DB_HANDLE, caps = true, space = SPACE } = opts;
  const att: Record<string, unknown> = {};
  if (caps) att[`${space}/capabilities/${DB_HANDLE}`] = { "tinycloud.capabilities/read": [{}] };
  if (sqlActions && sqlActions.length) {
    const inner: Record<string, unknown> = {};
    for (const a of sqlActions) inner[a] = [{}];
    att[`${space}/sql/${sqlPath}`] = inner;
  }
  return att;
}

/** The common "full SQL grant" att (capabilities/read + sql read/write/admin). */
export const FULL_GRANT_ATT = makeAtt({ sqlActions: FULL_SQL_ACTIONS });
