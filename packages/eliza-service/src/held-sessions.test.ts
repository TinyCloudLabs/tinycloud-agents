import { describe, expect, test } from "bun:test";
import { isRevocation } from "./held-sessions.js";

describe("revocation classification", () => {
  test("recognises the node's revoked-grant rejections", () => {
    expect(isRevocation(new Error("Failed to activate session: 401 - delegation-parent-revoked: bafy"))).toBe(true);
    expect(isRevocation(new Error("delegation-ancestor-revoked: ancestor=a parent=b"))).toBe(true);
    expect(isRevocation(Object.assign(new Error("denied"), { code: "DELEGATION_REVOKED" }))).toBe(true);
    expect(isRevocation(new Error("wrapped", { cause: { code: "DELEGATION_REVOKED" } }))).toBe(true);
  });

  test("does not treat outages or other rejections as revocation", () => {
    expect(isRevocation(new Error("fetch failed"))).toBe(false);
    expect(isRevocation(Object.assign(new Error("Unauthorized"), { status: 401 }))).toBe(false);
    expect(isRevocation(new Error("delegation expired"))).toBe(false);
    expect(isRevocation(undefined)).toBe(false);
  });
});
