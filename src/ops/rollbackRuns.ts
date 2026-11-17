// The runs in the journal: which one a bare `t3sm rollback` targets, which ones are never rolled back (a rollback, a
// journal compaction), and one summary per run (`t3sm runs`).

import type { JournalEntry } from "../core/types.ts";
import { effectiveWrites } from "../core/journal.ts";
import { COMPACT_COMMAND } from "../core/compact.ts";

/** Newest run with a run-start that is not itself a rollback or a journal compaction (neither is ever rolled back). */
export function latestRunId(entries: JournalEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.t === "run-start" && typeof e.command === "string" && !e.command.startsWith("rollback") && e.command !== COMPACT_COMMAND) return e.runId;
  }
  return null;
}

/** Entry kinds whose rollback changes T3 Code through something other than organize's commands. */
const OTHER_T3_KINDS: ReadonlySet<string> = new Set(["project-default-set", "instance-pinned", "instance-updated", "imported", "import-attempt", "merged", "followed", "thread-archived", "thread-unarchived"]);

/**
 * The rollback of `runId` touches T3 Code only through organize's commands (it has organize changes and nothing else
 * for T3). Such a rollback runs on any T3 Code version with organizeGate's one warning (ruling R18), so the caller
 * connects with allowUntested and lets organizeGate speak.
 */
export function organizeOnlyRun(entries: JournalEntry[], runId: string): boolean {
  const mine = entries.filter((e) => e.runId === runId);
  return mine.some((e) => e.t === "organize-change") && !mine.some((e) => OTHER_T3_KINDS.has(e.t));
}

/** The run-start command of `runId` marks it as a rollback run (those are never rolled back). */
export function isRollbackRun(entries: JournalEntry[], runId: string): boolean {
  return entries.some((e) => e.t === "run-start" && e.runId === runId && typeof e.command === "string" && e.command.startsWith("rollback"));
}

/** `runId` is a journal compaction (`t3sm journal compact`): it changed only journal.jsonl and is never rolled back. */
export function isCompactionRun(entries: JournalEntry[], runId: string): boolean {
  return entries.some((e) => e.t === "run-start" && e.runId === runId && e.command === COMPACT_COMMAND);
}

export interface RunSummary {
  runId: string;
  at: string | null;
  command: string | null;
  /** run-end status, "incomplete" (started, no run-end) or "-" (no run-start: an `accounts` change). */
  status: string;
  rolledBackBy: string | null;
  /** Projects the run left for later because a conversation of theirs was in use (its run-end; absent when none). */
  held?: number;
  /** organized: changes `t3sm organize` made (organize-change); organizeReverted: organize changes an undo put back. */
  counts: {
    imported: number; importFailed: number; filesWritten: number; quarantined: number; unquarantined: number; defaults: number; instances: number;
    projects: number; archived: number; merged: number; organized: number; organizeReverted: number;
  };
}

/** One summary per run id, in journal order (mtime-bump/restore bookkeeping alone does not make a run). */
export function listRuns(entries: JournalEntry[]): RunSummary[] {
  const byId = new Map<string, RunSummary>();
  const get = (id: string): RunSummary => {
    let s = byId.get(id);
    if (!s) {
      s = { runId: id, at: null, command: null, status: "-", rolledBackBy: null, counts: { imported: 0, importFailed: 0, filesWritten: 0, quarantined: 0, unquarantined: 0, defaults: 0, instances: 0, projects: 0, archived: 0, merged: 0, organized: 0, organizeReverted: 0 } };
      byId.set(id, s);
    }
    return s;
  };
  for (const e of entries) {
    if (e.t === "mtime-bump" || e.t === "mtime-restore" || e.t === "update") continue; // update: t3sm update, not a run to roll back
    const s = get(e.runId);
    switch (e.t) {
      case "run-start": s.at = e.at; s.command = e.command; if (s.status === "-") s.status = "incomplete"; break;
      case "run-end": s.status = e.status; if (typeof e.held === "number" && e.held > 0) s.held = e.held; break;
      case "imported": s.counts.imported++; break;
      case "import-failed": s.counts.importFailed++; break;
      case "file-written": break; // counted below from the writes that really happened (effectiveWrites)
      case "merged": s.counts.merged++; break;
      case "quarantined": s.counts.quarantined++; break;
      case "unquarantined": s.counts.unquarantined++; break;
      case "project-default-set": s.counts.defaults++; break;
      case "instance-created": case "instance-pinned": case "instance-updated": s.counts.instances++; break;
      case "project-created": s.counts.projects++; break;
      case "thread-archived": s.counts.archived++; break;
      case "organize-change": s.counts.organized++; break;
      case "organize-undone": s.counts.organizeReverted++; break;
      case "rolled-back": get(e.targetRunId).rolledBackBy = e.runId; break;
      default: break;
    }
  }
  for (const w of effectiveWrites(entries)) get(w.runId).counts.filesWritten++;
  return [...byId.values()];
}
