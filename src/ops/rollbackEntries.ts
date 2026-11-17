// The journal is not trusted blindly (see rollback.ts): the checks an entry of the target run passes before rollbackRun
// acts on it, and the small file helpers it uses.

import { lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { JournalEntry } from "../core/types.ts";
import { pathKey } from "../core/paths.ts";
import { QUARANTINE_DIR, hasDotDot, isInside, subdirOf } from "./quarantine.ts";

export const isObj = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u);
export const isStr = (u: unknown): u is string => typeof u === "string" && u !== "";
const strOrNull = (u: unknown): boolean => u === null || typeof u === "string";
export const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `path`, then each parent up to and including `created` (deepest first); null when `created` is not one of them. */
export function foldersUpTo(path: string, created: string): string[] | null {
  const out: string[] = [];
  for (let d = path; ; d = dirname(d)) {
    out.push(d);
    if (pathKey(d) === pathKey(created)) return out;
    if (dirname(d) === d) return null;
  }
}

export function selection(u: unknown): { instanceId: string | null; model: string | undefined } {
  if (!isObj(u)) return { instanceId: null, model: undefined };
  const id = typeof u.instanceId === "string" ? u.instanceId : typeof u.provider === "string" ? u.provider : null;
  return { instanceId: id, model: typeof u.model === "string" ? u.model : undefined };
}

/** Two paths name the same regular file (same device and inode: hard links). */
export async function sameFile(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([lstat(a, { bigint: true }), lstat(b, { bigint: true })]);
  return x.isFile() && y.isFile() && x.dev === y.dev && x.ino === y.ino && x.ino !== 0n;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** The account home a quarantined entry belongs to, or why it is not acted on. */
export function quarantineHome(e: { from?: unknown; to?: unknown }, homes: string[], platform: NodeJS.Platform): { home: string } | { error: string } {
  if (!isStr(e.from) || !isStr(e.to)) return { error: "from/to missing or not strings" };
  if (hasDotDot(e.from) || hasDotDot(e.to)) return { error: "path with `..`" };
  for (const h of homes) {
    const q = join(h, QUARANTINE_DIR);
    const toOk = isInside(e.to, join(q, "backups"), platform) || isInside(e.to, join(q, "mirror"), platform);
    if (toOk && isInside(e.from, join(h, "projects"), platform)) return { home: h };
  }
  return { error: `${e.from} -> ${e.to} is outside the configured account folders` };
}

/** A converted transcript path: <H>/projects/<dir>/<name>.jsonl for a configured home H. */
export function convertedFileOk(path: unknown, homes: string[], platform: NodeJS.Platform): boolean {
  if (!isStr(path) || hasDotDot(path) || !basename(path).endsWith(".jsonl")) return false;
  return homes.some((h) => {
    const rel = subdirOf(join(h, "projects"), dirname(path), platform);
    return rel !== null && rel !== "" && !rel.includes("/");
  });
}

/** Why an entry of the target run is malformed (null: well-formed). Path bounds are checked where they are used. */
export function malformed(e: JournalEntry): string | null {
  const o = e as unknown as Record<string, unknown>;
  switch (e.t) {
    case "file-written":
      if (o.revisionOf !== undefined && !(isObj(o.revisionOf) && isStr(o.revisionOf.nativeId))) return "revisionOf invalid";
      return isStr(o.path) && typeof o.sha256 === "string" && /^[0-9a-f]{64}$/.test(o.sha256) ? null : "path/sha256 missing or invalid";
    case "quarantined": return isStr(o.from) && isStr(o.to) ? null : "from/to missing or not strings";
    case "project-default-set": return isStr(o.projectId) ? null : "projectId missing";
    case "project-created": return isStr(o.projectId) && typeof o.root === "string" ? null : "projectId/root missing";
    case "instance-created": return isStr(o.instanceId) ? null : "instanceId missing";
    case "folder-created": {
      if (!isStr(o.path) || !isStr(o.created) || hasDotDot(o.path) || hasDotDot(o.created) || !isAbsolute(o.path)) return "path/created missing or not absolute";
      return foldersUpTo(o.path, o.created) === null ? "created is not the folder or one of its parents" : null;
    }
    case "organize-change": return isStr(o.kind) && isStr(o.target) ? null : "kind/target missing";
    case "imported": return isStr(o.threadId) ? null : "threadId missing";
    case "import-attempt": return Array.isArray(o.items) && (o.parked === undefined || Array.isArray(o.parked)) ? null : "items missing";
    case "thread-archived": return isStr(o.threadId) ? null : "threadId missing";
    case "thread-unarchived": return isStr(o.threadId) ? null : "threadId missing";
    case "merged": return isStr(o.nativeId) && isStr(o.revisionFile) && isStr(o.oldThreadId) && isStr(o.newThreadId) ? null : "nativeId/revisionFile/oldThreadId/newThreadId missing";
    case "followed": return isStr(o.original) && isStr(o.copy) && isStr(o.oldThread) && (o.mode === "refresh" || o.mode === "revision") ? null : "original/copy/oldThread/mode missing";
    case "instance-pinned":
      return isStr(o.instanceId) && isObj(o.previous) && strOrNull(o.previous.homePath) && isObj(o.next) && typeof o.next.homePath === "string" ? null : "instanceId/previous/next invalid";
    case "instance-updated": {
      const d = (u: unknown): boolean => isObj(u) && strOrNull(u.displayName) && strOrNull(u.accentColor) && strOrNull(u.homePath);
      return isStr(o.instanceId) && d(o.previous) && d(o.next) ? null : "instanceId/previous/next invalid";
    }
    default: return null;
  }
}
