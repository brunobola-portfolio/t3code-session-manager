// The merge verdict cache and the pending counts (<stateDir>/cache/merge.json): a verdict per (path, size, mtime,
// baseline), so an unchanged transcript is not read again; the counts doctor's merge-pending check shows.

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../core/fsutil.ts";
import type { TranscriptBranch } from "./mergeBranch.ts";

export type Verdict = Pick<TranscriptBranch, "problem" | "addedMessages" | "t3MarkerAfter" | "divergedLeaves" | "orphanedTerminal" | "lastActivity"> & { empty: boolean };
/** count: mergeable now; orphaned: sessions whose only terminal work sits on a side branch (never merged). */
export interface MergePending { count: number; orphaned: number; at: string }
interface CacheFile { version: 2; verdicts: Record<string, Verdict>; pending?: MergePending }

const cachePath = (stateDir: string): string => path.join(stateDir, "cache", "merge.json");

export async function readCache(stateDir: string | undefined): Promise<CacheFile> {
  if (!stateDir) return { version: 2, verdicts: {} };
  try {
    const u = JSON.parse(await readFile(cachePath(stateDir), "utf8")) as CacheFile;
    if (u && u.version === 2 && typeof u.verdicts === "object" && u.verdicts !== null) return u;
  } catch { /* missing or unreadable: start over */ }
  return { version: 2, verdicts: {} };
}

export async function writeCache(stateDir: string | undefined, c: CacheFile): Promise<void> {
  if (!stateDir) return;
  try {
    await mkdir(path.dirname(cachePath(stateDir)), { recursive: true });
    await atomicWrite(cachePath(stateDir), JSON.stringify(c) + "\n");
  } catch { /* a cache is never worth failing a merge */ }
}

/** Sessions continued in a terminal and mergeable, as last counted by sync or `t3sm merge` (null: never counted). */
export async function readMergePending(stateDir: string): Promise<MergePending | null> {
  const c = await readCache(stateDir);
  return c.pending && typeof c.pending.count === "number" ? { ...c.pending, orphaned: c.pending.orphaned ?? 0 } : null;
}

/** Records the pending counts (orphaned kept when omitted). */
export async function setMergePending(stateDir: string | undefined, count: number, at: Date, orphaned?: number): Promise<void> {
  if (!stateDir) return;
  const c = await readCache(stateDir);
  const next = { count, orphaned: orphaned ?? c.pending?.orphaned ?? 0 };
  if (c.pending?.count !== next.count || c.pending?.orphaned !== next.orphaned) { c.pending = { ...next, at: at.toISOString() }; await writeCache(stateDir, c); }
}
