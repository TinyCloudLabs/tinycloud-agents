import { createHash } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bytesToUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    hex.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

// Byte-identical to @elizaos/core stringToUuid.
// If target is already a valid UUID it is returned as-is.
// Otherwise: sha1(encodeURIComponent(target)), first 16 bytes,
// variant byte bytes[8] = bytes[8] & 63 | 128,
// version nibble bytes[6] = bytes[6] & 15 | 0  ← forced to 0, NOT standard uuidv5
export function stringToUuid(target: string | number): string {
  if (typeof target === "number") {
    target = target.toString();
  }
  if (typeof target !== "string") {
    throw new TypeError("Value must be string");
  }
  if (UUID_RE.test(target)) {
    return target;
  }
  const escaped = encodeURIComponent(target);
  const buf = createHash("sha1").update(escaped).digest();
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, 16);
  bytes[8] = (bytes[8] & 63) | 128;
  bytes[6] = (bytes[6] & 15) | 0;
  return bytesToUuid(bytes);
}

// Derives the elizaOS entityId for a wallet address paired with an agentId.
// Lowercases the address before seeding so EIP-55 checksummed and lowercase
// forms always map to the same UUID (sha1 is case-sensitive).
export function addressToEntityId(address: string, agentId: string): string {
  return stringToUuid(`${address.toLowerCase()}:${agentId}`);
}
