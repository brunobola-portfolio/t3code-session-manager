import { createHash } from "node:crypto";

export const T3SM_NAMESPACE = "b7e1c3a2-5f4d-4e8b-9a6c-2d1f0e3b4a59";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** RFC 4122 version-5 (SHA-1, name-based) UUID. */
export function uuidV5(name: string, namespace: string = T3SM_NAMESPACE): string {
  if (!isUuid(namespace)) throw new Error(`invalid namespace UUID: ${namespace}`);
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const b = h.subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * Merge revision id of a Claude session at a given transcript size (spec §4.6): deterministic, so a re-run on the same
 * unchanged session finds the same revision; any growth of the transcript is a new revision.
 */
export function revisionUuid(nativeId: string, size: number): string {
  return uuidV5(`rev:${nativeId}:${size}`);
}
