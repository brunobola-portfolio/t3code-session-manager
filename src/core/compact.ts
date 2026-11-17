// Journal compaction (`t3sm journal compact`): journal.jsonl only grows, and most of its bytes are the file lists of
// finished runs' `mtime-bump` / `mtime-restore` entries. Once a run is finished, old and has nothing pending, those
// entries answer nothing any reader asks any more: recovery skips a bump its run restored, `pendingMtimePaths` too,
// and `listRuns` ignores both kinds. Compaction drops exactly those lines and keeps every other line byte for byte, so
// the result is a journal in the format every t3sm version already reads (nothing new to understand but one
// `journal-compacted` entry, which readers that do not know it skip).
//
// Crash safety: the run's `run-start` is appended first (the attempt is in the history even if the process dies), the
// full journal as it is then is written to a new backup file next to it (exclusive create + fsync; t3sm never deletes
// it), the compacted journal to a temp file (fsync), and only then does a rename put it in place. Until that rename the
// old journal is untouched; the rename itself is atomic. Before the rename the result is checked against the original
// (every entry but the dropped ones identical and in order, the same pending bumps, the same corrupt-line count), and
// the journal's size against the one read (no append slipped in): any difference aborts with nothing replaced.
//
// MUST be called while holding the state-dir lock, after recoverPendingMtimes (like every writing command).

import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { JournalEntry } from "./types.ts";
import { Journal, newRunId, parseJournal, pendingBumps, pendingMtimePaths } from "./journal.ts";
import { pathKey } from "./paths.ts";
import { renameRetrying } from "./fsutil.ts";

/** The run-start `command` of a compaction run. */
export const COMPACT_COMMAND = "journal compact";
/** Runs that ended less than this many days ago are never folded unless `--older-than` says otherwise. */
export const DEFAULT_OLDER_THAN_DAYS = 90;
/** Accepted range of `--older-than` (days). */
export const OLDER_THAN_MIN = 1;
export const OLDER_THAN_MAX = 3650;
const DAY_MS = 86_400_000;

const MTIME_KINDS: ReadonlySet<string> = new Set(["mtime-bump", "mtime-restore"]);

/** What a compaction would fold, and why the other runs with file-time entries stay as they are. */
export interface CompactionPlan {
  /** Run ids whose mtime-bump / mtime-restore entries are dropped, in journal order. */
  runs: string[];
  /** Indexes (into parseJournal's `lines`) of the lines dropped. */
  drop: number[];
  /** Entries dropped. */
  entries: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Runs with file-time entries that are kept: still pending (a bump not restored, an import attempt without outcome, malformed entries), too recent, or unfinished (no run-end, or the newest run). */
  kept: { pending: number; recent: number; unfinished: number };
}

/** The text after dropping `drop` (line indexes of parseJournal(text).lines); always newline-terminated. */
export function dropLines(text: string, drop: Iterable<number>): string {
  const p = parseJournal(text);
  const gone = new Set(drop);
  const kept = p.lines.filter((_, i) => !gone.has(i));
  return (p.bom ? "﻿" : "") + (kept.length > 0 ? kept.join("\n") + "\n" : "");
}

const validBump = (e: JournalEntry): boolean => {
  const files: unknown = (e as { files?: unknown }).files;
  if (!Array.isArray(files)) return false;
  const num = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
  return files.every((f: unknown) => {
    if (typeof f !== "object" || f === null) return false;
    const o = f as Record<string, unknown>;
    return typeof o["path"] === "string" && o["path"] !== "" && num(o["atimeMs"]) && num(o["mtimeMs"]);
  });
};
const validRestore = (e: JournalEntry): boolean => {
  const paths: unknown = (e as { paths?: unknown }).paths;
  return Array.isArray(paths) && paths.every((p) => typeof p === "string");
};

/**
 * Which runs a compaction folds. A run is folded only when ALL hold:
 * - it has a `run-start` and a `run-end`, and is not the newest run other than a compaction (no unfinished or current
 *   run is ever touched);
 * - its run-end is at least `olderThanDays` days before `now`;
 * - none of its file-time entries is malformed, none of its bumps is pending, and no path it bumped is pending in any
 *   other run (recovery would read that path's first spelling from it);
 * - every item of its `import-attempt` entries (parked copies aside) has an `imported` or `import-failed` in the run.
 * Pure (reads only `text`).
 */
export function planCompaction(text: string, opts: { now: number; olderThanDays: number; platform?: NodeJS.Platform }): CompactionPlan {
  const platform = opts.platform ?? process.platform;
  const p = parseJournal(text);
  const cutoff = opts.now - opts.olderThanDays * DAY_MS;
  interface RunInfo { start: boolean; endAt: number | null; mtimeIdx: number[]; bad: boolean; attempts: Set<string>; outcomes: Set<string>; keys: Set<string> }
  const runs = new Map<string, RunInfo>();
  const info = (id: string): RunInfo => {
    let r = runs.get(id);
    if (!r) runs.set(id, (r = { start: false, endAt: null, mtimeIdx: [], bad: false, attempts: new Set(), outcomes: new Set(), keys: new Set() }));
    return r;
  };
  let lastStart: string | null = null;
  p.entries.forEach((e, k) => {
    const r = info(e.runId);
    switch (e.t) {
      // The newest run other than a compaction is never folded (a compaction run has no file-time entries).
      case "run-start": r.start = true; if (e.command !== COMPACT_COMMAND) lastStart = e.runId; break;
      case "run-end": { const at = Date.parse(String(e.at)); r.endAt = Number.isFinite(at) ? at : null; if (r.endAt === null) r.bad = true; break; }
      case "mtime-bump":
        r.mtimeIdx.push(p.lineOf[k]!);
        if (!validBump(e)) r.bad = true;
        else for (const f of e.files) r.keys.add(pathKey(f.path, platform));
        break;
      case "mtime-restore":
        r.mtimeIdx.push(p.lineOf[k]!);
        if (!validRestore(e)) r.bad = true;
        break;
      case "import-attempt":
        if (!Array.isArray(e.items)) { r.bad = true; break; }
        for (const x of e.items as unknown[]) {
          const o = x as Record<string, unknown> | null;
          if (typeof o !== "object" || o === null) { r.bad = true; continue; }
          r.attempts.add(`${String(o["harness"])}:${String(o["nativeId"])}`);
        }
        break;
      case "imported": case "import-failed":
        r.outcomes.add(`${String(e.harness)}:${String(e.nativeId)}`);
        break;
      default: break;
    }
  });
  const pending = pendingBumps(p.entries, platform);
  const pendingRuns = new Set<string>();
  const pendingKeys = new Set<string>();
  for (const s of pending.slots) {
    pendingKeys.add(pathKey(s.path, platform));
    for (const b of s.bumps) pendingRuns.add(b.runId);
  }

  const out: CompactionPlan = { runs: [], drop: [], entries: 0, bytesBefore: Buffer.byteLength(text, "utf8"), bytesAfter: 0, kept: { pending: 0, recent: 0, unfinished: 0 } };
  for (const [id, r] of runs) {
    if (r.mtimeIdx.length === 0) continue;
    if (!r.start || r.endAt === null || id === lastStart) { out.kept.unfinished++; continue; }
    const unresolved = [...r.attempts].some((a) => !r.outcomes.has(a));
    if (r.bad || unresolved || pendingRuns.has(id) || [...r.keys].some((k) => pendingKeys.has(k))) { out.kept.pending++; continue; }
    if (r.endAt > cutoff) { out.kept.recent++; continue; }
    out.runs.push(id);
    out.drop.push(...r.mtimeIdx);
    out.entries += r.mtimeIdx.length;
  }
  out.drop.sort((a, b) => a - b);
  out.bytesAfter = Buffer.byteLength(dropLines(text, out.drop), "utf8");
  return out;
}

/** What compaction does to the file system; tests replace it to fail at each step. */
export interface CompactFs {
  readFile(path: string): Promise<Buffer>;
  /** Creates `path` (refusing an existing one), writes `data`, fsyncs and closes it. */
  writeNew(path: string, data: Buffer): Promise<void>;
  size(path: string): Promise<number>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
}

export const nodeCompactFs: CompactFs = {
  readFile: (p) => readFile(p),
  writeNew: async (p, data) => {
    const fh = await open(p, "wx", 0o600);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
  size: async (p) => (await stat(p)).size,
  rename: (a, b) => rename(a, b),
  rm: (p) => rm(p, { force: true }),
};

/** The compaction found something that would change what a reader computes; nothing was replaced. */
export class CompactionMismatch extends Error {
  override name = "CompactionMismatch";
}
/** journal.jsonl changed while it was being compacted (something appended without the lock); nothing was replaced. */
export class JournalChanged extends Error {
  override name = "JournalChanged";
}

export interface CompactResult {
  /** The compaction's run id; null when there was nothing to fold (nothing was written). */
  runId: string | null;
  plan: CompactionPlan;
  /** Full path of the backup; null when nothing was written. */
  backup: string | null;
}

/** The backup's name for run `runId`: next to journal.jsonl, never reused (the run id is unique). */
export function backupName(runId: string): string {
  return `journal.${runId}.bak.jsonl`;
}

const nonMtime = (es: JournalEntry[]): JournalEntry[] => es.filter((e) => !MTIME_KINDS.has(e.t));

/** Throws CompactionMismatch unless every reader computes the same from `after` as from `before`. */
export function assertEquivalent(before: string, after: string, platform: NodeJS.Platform = process.platform): void {
  const a = parseJournal(before);
  const b = parseJournal(after);
  if (a.corrupt !== b.corrupt) throw new CompactionMismatch(`corrupt lines ${a.corrupt} -> ${b.corrupt}`);
  if (!isDeepStrictEqual(nonMtime(a.entries), nonMtime(b.entries))) throw new CompactionMismatch("an entry other than a file-time entry changed");
  if (!isDeepStrictEqual(pendingBumps(a.entries, platform), pendingBumps(b.entries, platform))) throw new CompactionMismatch("the pending file times changed");
  if (!isDeepStrictEqual(pendingMtimePaths(a.entries, platform), pendingMtimePaths(b.entries, platform))) throw new CompactionMismatch("the pending paths changed");
}

/**
 * Folds the finished runs older than `olderThanDays` (planCompaction) and replaces journal.jsonl with the result,
 * keeping the journal as it was in a backup next to it. Writes nothing when there is nothing to fold. Caller holds the
 * lock and has run recoverPendingMtimes.
 */
export async function compactJournal(
  j: Journal,
  opts: { now: () => number; olderThanDays: number; platform?: NodeJS.Platform; fs?: CompactFs },
): Promise<CompactResult> {
  const fs = opts.fs ?? nodeCompactFs;
  const platform = opts.platform ?? process.platform;
  const read = async (): Promise<Buffer | null> => fs.readFile(j.file).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  const first = await read();
  const preview = planCompaction(first?.toString("utf8") ?? "", { now: opts.now(), olderThanDays: opts.olderThanDays, platform });
  if (first === null || preview.runs.length === 0) return { runId: null, plan: preview, backup: null };

  const runId = newRunId(new Date(opts.now()));
  await j.append({ t: "run-start", runId, at: new Date(opts.now()).toISOString(), command: COMPACT_COMMAND });
  const backup = join(dirname(j.file), backupName(runId));
  const tmp = `${j.file}.${runId}.tmp`;
  try {
    const buf = await fs.readFile(j.file);
    const text = buf.toString("utf8");
    const plan = planCompaction(text, { now: opts.now(), olderThanDays: opts.olderThanDays, platform });
    await fs.writeNew(backup, buf);
    const at = new Date(opts.now()).toISOString();
    // bytesAfter: the compacted journal with these two closing entries (their own size included).
    const tail = (bytesAfter: number): string =>
      JSON.stringify({ t: "journal-compacted", runId, at, olderThanDays: opts.olderThanDays, runs: plan.runs.length, entries: plan.entries, bytesBefore: buf.length, bytesAfter, backup: basename(backup) } satisfies JournalEntry) + "\n"
      + JSON.stringify({ t: "run-end", runId, at, status: "ok" } satisfies JournalEntry) + "\n";
    const body = dropLines(text, plan.drop);
    let size = 0;
    let after = body + tail(size);
    while (Buffer.byteLength(after, "utf8") !== size) {
      size = Buffer.byteLength(after, "utf8");
      after = body + tail(size);
    }
    assertEquivalent(text + tail(size), after, platform);
    await fs.writeNew(tmp, Buffer.from(after, "utf8"));
    if ((await fs.size(j.file)) !== buf.length) throw new JournalChanged("journal.jsonl changed while it was being compacted; nothing was replaced");
    await renameRetrying(tmp, j.file, { rename: fs.rename });
    return { runId, plan: { ...plan, bytesAfter: Buffer.byteLength(after, "utf8") }, backup };
  } catch (e) {
    await fs.rm(tmp).catch(() => {});
    await j.append({ t: "run-end", runId, at: new Date(opts.now()).toISOString(), status: "aborted" }).catch(() => {});
    throw e;
  }
}
