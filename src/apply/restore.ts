// Putting bumped and parked transcripts back (safety invariant 2): restoreAll after every wave (in runWaves' finally),
// restoreSync on a forced exit (the third Ctrl+C). A file is moved back only while it is still at t3sm's target time.

import { statSync, utimesSync } from "node:fs";
import { near } from "../core/journal.ts";
import { retryBusy } from "./busy.ts";

export interface BumpFile { path: string; atimeMs: number; mtimeMs: number; targetMtimeMs: number }

/**
 * Synchronous restore for a forced exit: puts back every file still at its bump target (same guard as the async
 * restore: a file anywhere else was never bumped or was written meanwhile, and is left alone). Never throws. The
 * journal stays the safety net: no mtime-restore is written here; the next run's recoverPendingMtimes finds these
 * files at their originals and marks them restored.
 */
export function restoreSync(files: BumpFile[]): number {
  let n = 0;
  for (const f of files) {
    try {
      if (!near(statSync(f.path).mtimeMs, f.targetMtimeMs)) continue;
      utimesSync(f.path, f.atimeMs / 1000, f.mtimeMs / 1000);
      n++;
    } catch { /* left pending for recoverPendingMtimes */ }
  }
  return n;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Put every file back where the journal says it was. Never throws for a single file; returns the paths that are
 * resolved (restored, gone, never moved, or modified by someone else meanwhile) and the errors (left pending for
 * recoverPendingMtimes).
 */
export async function restoreAll(
  files: BumpFile[], setTimes: (path: string, atime: number, mtime: number) => Promise<void>, statFn: (path: string) => Promise<{ mtimeMs: number }>,
  skipped: ReadonlySet<string>, busyRetryMs?: readonly number[],
): Promise<{ resolved: string[]; errors: { path: string; error: string }[] }> {
  const resolved: string[] = [];
  const errors: { path: string; error: string }[] = [];
  for (const f of files) {
    // Never bumped (written to or gone before its utimes) and already journaled restored: never touched, even if a
    // coarse-timestamp filesystem makes its fresh mtime look like the target.
    if (skipped.has(f.path)) continue;
    try {
      let cur: { mtimeMs: number } | null;
      try {
        cur = await retryBusy(() => statFn(f.path), busyRetryMs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        cur = null;
      }
      // Still at our target: put it back. Anywhere else: either our utimes never ran (it is at its original) or
      // someone wrote to it during the wave (it is newer); never move it backwards.
      if (cur !== null && near(cur.mtimeMs, f.targetMtimeMs)) await retryBusy(() => setTimes(f.path, f.atimeMs / 1000, f.mtimeMs / 1000), busyRetryMs);
      resolved.push(f.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") resolved.push(f.path);
      else errors.push({ path: f.path, error: errText(e) });
    }
  }
  return { resolved, errors };
}
