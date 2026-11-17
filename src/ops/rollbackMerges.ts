// Which merges a rollback undoes, as thread swaps (src/ops/rollback.ts applies them in T3 Code).

import { basename } from "node:path";
import type { JournalEntry } from "../core/types.ts";
import { exists, isStr } from "./rollbackEntries.ts";
import type { KeptReason, RollbackReport } from "./rollbackTypes.ts";

/** One undo: bring `old` back (when the run archived it), then archive `rev`; either may be null. */
export interface Swap { old: string | null; rev: string | null }

/**
 * The swaps that undo the run's merges, and the revisions it wrote. An undone merge (revision removed, or already gone)
 * swaps; a merge whose revision is kept (`kept`) is reported whole in `mergesKept`. Also undone: a thread the run
 * archived without a `merged` entry (crash between thread-archived and merged), and a revision thread the run
 * UNarchived (re-merge after a rollback) whose revision is removed.
 */
export async function planMergeUndo(
  mine: { e: JournalEntry }[], kept: ReadonlyMap<string, KeptReason>, r: Pick<RollbackReport, "filesRemoved" | "mergesKept" | "errors">, keyOf: (p: string) => string,
): Promise<{ swaps: Swap[]; revisionsOfRun: { path: string; nativeId: string; rev: string }[] }> {
  const removed = new Set(r.filesRemoved.map(keyOf));
  const gone = async (file: string): Promise<boolean> => removed.has(keyOf(file)) || !(await exists(file).catch(() => true));
  const swaps: { old: string | null; rev: string | null }[] = [];
  const addSwap = (old: string | null, rev: string | null): void => {
    if (swaps.some((x) => x.old === old && x.rev === rev)) return;
    swaps.push({ old, rev });
  };
  const keptOld = new Set<string>();
  for (const { e } of mine) {
    if (e.t !== "merged") continue;
    const why = kept.get(keyOf(e.revisionFile));
    if (why) { r.mergesKept.push({ nativeId: e.nativeId, revisionFile: e.revisionFile, reason: why }); keptOld.add(e.oldThreadId); continue; }
    if (!(await gone(e.revisionFile))) {
      r.errors.push(`merge of ${e.nativeId} not undone: its revision ${e.revisionFile} is still there`);
      keptOld.add(e.oldThreadId);
      continue;
    }
    addSwap(e.oldThreadId, e.newThreadId);
  }
  const revisionsOfRun = mine.flatMap(({ e }) => (e.t === "file-written" && e.revisionOf && isStr(e.path) ? [{ path: e.path, nativeId: e.revisionOf.nativeId, rev: basename(e.path, ".jsonl") }] : []));
  const mergedOld = new Set(mine.flatMap(({ e }) => (e.t === "merged" ? [e.oldThreadId] : [])));
  for (const { e } of mine) {
    if (e.t !== "thread-archived" || keptOld.has(e.threadId) || mergedOld.has(e.threadId)) continue;
    // The run's own revision thread, archived back by a follow that stopped before its swap (the copy changed during
    // the import): it stays archived; there is no old thread to bring back.
    if (revisionsOfRun.some((w) => e.threadId.endsWith(`:${w.rev}`))) continue;
    let keep = false;
    let any = false;
    for (const w of revisionsOfRun) {
      if (!e.threadId.endsWith(`:${w.nativeId}`)) continue;
      if (kept.has(keyOf(w.path))) { keep = true; continue; }
      any = true;
      addSwap(e.threadId, `${e.threadId.slice(0, -w.nativeId.length)}${w.rev}`);
    }
    if (!keep && !any) addSwap(e.threadId, null);
  }
  for (const { e } of mine) {
    if (e.t !== "thread-unarchived") continue;
    const w = revisionsOfRun.find((x) => e.threadId.endsWith(`:${x.rev}`));
    if (!w || kept.has(keyOf(w.path)) || !(await gone(w.path))) continue;
    if (!swaps.some((x) => x.rev === e.threadId)) addSwap(null, e.threadId);
  }
  return { swaps, revisionsOfRun };
}
