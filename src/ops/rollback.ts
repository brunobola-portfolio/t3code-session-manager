// Undo one run from the journal (spec §4.3: quarantine is reversible; every default change is revertible).
// rollbackRun REQUIRES the caller to hold the state-dir lock (acquireLock) and to have run recoverPendingMtimes first
// (a dry run needs neither: it writes nothing).
//
// The journal is not trusted blindly: an entry is acted on only when its fields have the right types and its paths
// stay inside a configured account home (quarantine entries: `to` under <H>/session-manager-quarantine/(backups|mirror),
// `from` under <H>/projects, same H; converted files: <H>/projects/<dir>/<name>.jsonl; no `..` anywhere). Anything else
// is reported in `errors` and skipped; the rest of the run is still rolled back.
//
// File level (no T3 Code needed): converted files written by the run are deleted only while their sha256 still matches
// and they were not changed in the last 10 minutes (else kept and reported); quarantined entries move back without
// ever replacing anything (moveEntry; an original path that exists again is a conflict and the entry stays in
// quarantine), journaled `unquarantined`, and emptied quarantine folders are removed. T3 level (skipped with a report
// when T3 Code is not reachable): per-project default instance restored to `previous`; instance label/colour/home
// restored only with `instances`; imported threads listed (archived only with `archiveThreads`, never deleted).
// Merges (`merged` / `thread-archived`): a revision still exactly as t3sm wrote it is deleted (file level, above), its
// old thread unarchived and its revision thread archived; a revision continued since keeps both threads (reported).
// Idempotent: every step checks the current state (or a later journal entry) first, and a rollback that changes
// nothing writes nothing to the journal.

import { lstat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { JournalEntry } from "../core/types.ts";
import { effectiveWrites, newRunId, type Journal } from "../core/journal.ts";
import { sha256File, statSafe } from "../core/fsutil.ts";
import { pathKey, sameCwd } from "../core/paths.ts";
import { ConfigError } from "../core/config.ts";
import { isActive } from "../core/activity.ts";
import type { T3Api } from "../t3/api.ts";
import { T3NotRunning } from "../t3/errors.ts";
import {
  JournalWriteError, MoveRefused, QUARANTINE_DIR, hasDotDot, isInside, moveEntry, moveFailure, nodeMoveFs, pruneEmptyQuarantineDirs, subdirOf,
  type MoveFs,
} from "./quarantine.ts";

export interface RollbackDeps {
  journal: Journal;
  /** Expanded homes of the configured accounts: the only places a rollback touches files. */
  accountHomes: string[];
  /** Opens T3 Code (only when the run touched T3). Omitted or failing: the T3 part is reported as not done. */
  connect?: () => Promise<T3Api>;
  now?: () => number;
  /** Restore instance displayName / accentColor / homePath from the journaled deltas. */
  instances?: boolean;
  /** Archive (never delete) the threads the run imported that are still active. */
  archiveThreads?: boolean;
  /** Report what would be undone; write nothing (T3 is only read). */
  dryRun?: boolean;
  fs?: MoveFs;
  platform?: NodeJS.Platform;
}

type KeptReason = "revision continued" | "revision in use" | "revision rewritten" | "T3 Code unreachable";

export interface InstanceChange {
  instanceId: string;
  kind: "pinned" | "updated";
  previous: unknown;
  next: unknown;
  /** listed: shown only (no --instances); already: T3 already has the previous value. */
  status: "listed" | "restored" | "already" | "changed-since" | "not-restorable" | "failed";
  note?: string;
}

export interface RollbackReport {
  /** The rollback's own run id; null when nothing was written (dry run, or nothing left to undo). */
  runId: string | null;
  targetRunId: string;
  /** The target's run-start command, when it has one. */
  command: string | null;
  filesRemoved: string[];
  filesKeptModified: string[];
  /** Changed within the last 10 minutes (in use): kept; run rollback again later. */
  filesKeptActive: string[];
  /** Rewritten by a later run: left alone. */
  filesKeptRewritten: string[];
  unquarantined: string[];
  unquarantineConflicts: { from: string; to: string }[];
  /** Back at the original path already (an earlier rollback crashed before journaling, or moved by hand). */
  alreadyRestored: string[];
  /** Neither in quarantine nor at the original path (moved elsewhere by hand). */
  unquarantineMissing: string[];
  unquarantineFailed: { path: string; reason: string }[];
  defaultsRestored: string[];
  defaultsSkipped: { projectId: string; reason: string }[];
  instanceChanges: InstanceChange[];
  instancesCreated: string[];
  projectsCreated: { projectId: string; root: string }[];
  /** Threads this run imported (or attempted) that T3 Code still has. Never deleted by t3sm. */
  threadsToReview: string[];
  /** false: T3 could not be read, threadsToReview lists every journaled candidate. */
  threadsVerified: boolean;
  threadsArchived: string[];
  /**
   * Copies the run parked (future file time) during a wave, never meant to be imported, whose thread exists in T3 Code
   * (it may predate the run). Listed for review only: never archived, never counted as imported.
   */
  parkedThreads: string[];
  /** Threads the run archived (a merge's old thread) that are active again. */
  threadsUnarchived: string[];
  /** Merges left in place because their revision was continued (or is in use) since: both threads stay as they are. */
  mergesKept: { nativeId: string; revisionFile: string; reason: KeptReason }[];
  /**
   * Threads left active although the rollback would have archived them, because archiving would leave their session
   * (original thread + merge revision threads) without any active thread. Review them in T3 Code.
   */
  needsReview: { threadId: string; reason: string }[];
  /** Why the T3 part was not done (e.g. "T3 Code not running"); null when T3 was reachable or not needed. */
  t3Unavailable: string | null;
  /** Includes every malformed or out-of-bounds journal entry that was skipped. */
  errors: string[];
}

const isObj = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u);
const isStr = (u: unknown): u is string => typeof u === "string" && u !== "";
const strOrNull = (u: unknown): boolean => u === null || typeof u === "string";
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Newest run with a run-start that is not itself a rollback. */
export function latestRunId(entries: JournalEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.t === "run-start" && typeof e.command === "string" && !e.command.startsWith("rollback")) return e.runId;
  }
  return null;
}

/** The run-start command of `runId` marks it as a rollback run (those are never rolled back). */
export function isRollbackRun(entries: JournalEntry[], runId: string): boolean {
  return entries.some((e) => e.t === "run-start" && e.runId === runId && typeof e.command === "string" && e.command.startsWith("rollback"));
}

function selection(u: unknown): { instanceId: string | null; model: string | undefined } {
  if (!isObj(u)) return { instanceId: null, model: undefined };
  const id = typeof u.instanceId === "string" ? u.instanceId : typeof u.provider === "string" ? u.provider : null;
  return { instanceId: id, model: typeof u.model === "string" ? u.model : undefined };
}

/** Two paths name the same regular file (same device and inode: hard links). */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([lstat(a, { bigint: true }), lstat(b, { bigint: true })]);
  return x.isFile() && y.isFile() && x.dev === y.dev && x.ino === y.ino && x.ino !== 0n;
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** The account home a quarantined entry belongs to, or why it is not acted on. */
function quarantineHome(e: { from?: unknown; to?: unknown }, homes: string[], platform: NodeJS.Platform): { home: string } | { error: string } {
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
function convertedFileOk(path: unknown, homes: string[], platform: NodeJS.Platform): boolean {
  if (!isStr(path) || hasDotDot(path) || !basename(path).endsWith(".jsonl")) return false;
  return homes.some((h) => {
    const rel = subdirOf(join(h, "projects"), dirname(path), platform);
    return rel !== null && rel !== "" && !rel.includes("/");
  });
}

/** Why an entry of the target run is malformed (null: well-formed). Path bounds are checked where they are used. */
function malformed(e: JournalEntry): string | null {
  const o = e as unknown as Record<string, unknown>;
  switch (e.t) {
    case "file-written":
      if (o.revisionOf !== undefined && !(isObj(o.revisionOf) && isStr(o.revisionOf.nativeId))) return "revisionOf invalid";
      return isStr(o.path) && typeof o.sha256 === "string" && /^[0-9a-f]{64}$/.test(o.sha256) ? null : "path/sha256 missing or invalid";
    case "quarantined": return isStr(o.from) && isStr(o.to) ? null : "from/to missing or not strings";
    case "project-default-set": return isStr(o.projectId) ? null : "projectId missing";
    case "project-created": return isStr(o.projectId) && typeof o.root === "string" ? null : "projectId/root missing";
    case "instance-created": return isStr(o.instanceId) ? null : "instanceId missing";
    case "imported": return isStr(o.threadId) ? null : "threadId missing";
    case "import-attempt": return Array.isArray(o.items) && (o.parked === undefined || Array.isArray(o.parked)) ? null : "items missing";
    case "thread-archived": return isStr(o.threadId) ? null : "threadId missing";
    case "thread-unarchived": return isStr(o.threadId) ? null : "threadId missing";
    case "merged": return isStr(o.nativeId) && isStr(o.revisionFile) && isStr(o.oldThreadId) && isStr(o.newThreadId) ? null : "nativeId/revisionFile/oldThreadId/newThreadId missing";
    case "instance-pinned":
      return isStr(o.instanceId) && isObj(o.previous) && strOrNull(o.previous.homePath) && isObj(o.next) && typeof o.next.homePath === "string" ? null : "instanceId/previous/next invalid";
    case "instance-updated": {
      const d = (u: unknown): boolean => isObj(u) && strOrNull(u.displayName) && strOrNull(u.accentColor) && strOrNull(u.homePath);
      return isStr(o.instanceId) && d(o.previous) && d(o.next) ? null : "instanceId/previous/next invalid";
    }
    default: return null;
  }
}

export async function rollbackRun(targetRunId: string, deps: RollbackDeps): Promise<RollbackReport> {
  const j = deps.journal;
  const now = deps.now ?? Date.now;
  const fs = deps.fs ?? nodeMoveFs;
  const platform = deps.platform ?? process.platform;
  const dry = deps.dryRun ?? false;
  const homes = deps.accountHomes;
  const keyOf = (p: string): string => pathKey(p, platform);

  const all = await j.readAll();
  if (isRollbackRun(all, targetRunId)) throw new ConfigError("Cannot roll back a rollback run.");
  const r: RollbackReport = {
    runId: null, targetRunId, command: null,
    filesRemoved: [], filesKeptModified: [], filesKeptActive: [], filesKeptRewritten: [], unquarantined: [], unquarantineConflicts: [], alreadyRestored: [],
    unquarantineMissing: [], unquarantineFailed: [], defaultsRestored: [], defaultsSkipped: [], instanceChanges: [], instancesCreated: [], projectsCreated: [],
    threadsToReview: [], threadsVerified: false, threadsArchived: [], parkedThreads: [], threadsUnarchived: [], mergesKept: [], needsReview: [], t3Unavailable: null, errors: [],
  };
  const mine: { e: JournalEntry; i: number }[] = [];
  let any = false;
  all.forEach((e, i) => {
    if (e.runId !== targetRunId) return;
    any = true;
    const bad = malformed(e);
    if (bad) r.errors.push(`skipped a malformed ${e.t} journal entry (${bad})`);
    else mine.push({ e, i });
  });
  if (!any) throw new ConfigError(`No run ${targetRunId} in the journal. Run \`t3sm runs\` to list them.`);
  const start = mine.find((x) => x.e.t === "run-start")?.e as Extract<JournalEntry, { t: "run-start" }> | undefined;
  r.command = typeof start?.command === "string" ? start.command : null;

  let rb: string | null = null;
  const begin = async (): Promise<string> => {
    if (rb === null) {
      const id = newRunId(new Date(now()));
      await j.append({ t: "run-start", runId: id, at: new Date(now()).toISOString(), command: `rollback ${targetRunId}` });
      rb = id;
    }
    return rb;
  };
  const laterUnquarantine = (i: number, from: string, to: string): boolean =>
    all.some((x, xi) => xi > i && x.t === "unquarantined" && isStr(x.from) && isStr(x.to) && keyOf(x.from) === keyOf(to) && keyOf(x.to) === keyOf(from));

  // Merge revisions (Task 23): their threads are fixed in T3 Code together with the file, so T3 Code is reached FIRST;
  // when it cannot be, the revision files are left untouched (reported) and a later rollback finishes the job.
  const revisionPaths = new Set<string>();
  for (const { e } of mine) {
    if (e.t === "merged" && isStr(e.revisionFile)) revisionPaths.add(keyOf(e.revisionFile));
    if (e.t === "file-written" && e.revisionOf && isStr(e.path)) revisionPaths.add(keyOf(e.path));
  }
  let api = null as T3Api | null; // assigned in connectT3Once (the cast keeps TS from narrowing it to null)
  let connectTried = false;
  const connectT3Once = async (): Promise<void> => {
    if (connectTried) return;
    connectTried = true;
    if (!deps.connect) { r.t3Unavailable = "T3 Code not connected"; return; }
    try {
      api = await deps.connect();
    } catch (e) {
      r.t3Unavailable = e instanceof T3NotRunning ? "T3 Code not running" : `T3 Code not reachable (${msg(e)})`;
    }
  };
  // The thread list is read before any revision file is touched: unreadable = the threads cannot be fixed, so the
  // revision files stay (reported), exactly as when T3 Code is not reachable at all.
  let live: Map<string, boolean> | null = null;
  let revisionsBlocked: string | null = null;
  if (revisionPaths.size > 0) {
    await connectT3Once();
    if (api === null) revisionsBlocked = r.t3Unavailable ?? "T3 Code not connected";
    else {
      try { live = new Map((await api.listThreads()).map((t) => [t.id, t.archived] as const)); } catch (e) {
        revisionsBlocked = `could not read T3 threads (${msg(e)})`;
        r.errors.push(`could not read T3 threads: ${msg(e)}`);
      }
    }
  }
  const kept = new Map<string, KeptReason>();

  // ---------- files (newest first) ----------
  const seenFiles = new Set<string>();
  try {
  for (const { e, i } of [...mine].reverse()) {
    if (e.t === "file-written") {
      if (!convertedFileOk(e.path, homes, platform)) { r.errors.push(`skipped file-written ${e.path}: not a transcript inside a configured account's projects folder`); continue; }
      // Never published (file-write-aborted later in the same run): whatever sits there is not ours.
      if (all.some((x, xi) => xi > i && x.t === "file-write-aborted" && x.runId === e.runId && isStr(x.path) && keyOf(x.path) === keyOf(e.path))) continue;
      const k = keyOf(e.path);
      if (seenFiles.has(k)) continue; // only this run's last write of a path counts
      seenFiles.add(k);
      if (revisionPaths.has(k) && revisionsBlocked !== null && (await exists(e.path).catch(() => true))) {
        kept.set(k, "T3 Code unreachable");
        r.errors.push(`kept the merge revision ${e.path}: ${revisionsBlocked}; run the rollback again with T3 Code running`);
        continue;
      }
      if (all.some((x, xi) => xi > i && x.t === "file-written" && x.runId !== targetRunId && isStr(x.path) && keyOf(x.path) === k)) { r.filesKeptRewritten.push(e.path); continue; }
      let sha: string;
      let st;
      try {
        sha = await sha256File(e.path);
        st = await statSafe(e.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") r.errors.push(`could not read ${e.path}: ${msg(err)}`);
        continue; // already gone: nothing to undo
      }
      if (sha !== e.sha256) { r.filesKeptModified.push(e.path); continue; }
      if (!st || isActive(st.mtimeMs, now())) { r.filesKeptActive.push(e.path); continue; }
      if (!dry) {
        await begin();
        try {
          await rm(e.path);
        } catch (err) {
          r.errors.push(`could not remove ${e.path}: ${msg(err)}`);
          continue;
        }
      }
      r.filesRemoved.push(e.path);
    } else if (e.t === "quarantined") {
      const where = quarantineHome(e, homes, platform);
      if ("error" in where) { r.errors.push(`skipped quarantined entry: ${where.error}`); continue; }
      if (laterUnquarantine(i, e.from, e.to)) continue;
      try {
        const inQuarantine = await exists(e.to);
        const atOrigin = await exists(e.from);
        if (!inQuarantine) { (atOrigin ? r.alreadyRestored : r.unquarantineMissing).push(atOrigin ? e.from : e.to); continue; }
        if (atOrigin) {
          // Both names are ONE file (an earlier rollback crashed between its link and its unlink): finish that move.
          if (await sameFile(e.to, e.from)) {
            if (!dry) {
              const id = await begin();
              await fs.unlink(e.to);
              await j.append({ t: "unquarantined", runId: id, from: e.to, to: e.from });
              await pruneEmptyQuarantineDirs(dirname(e.to), where.home, platform);
            }
            r.unquarantined.push(e.from);
            continue;
          }
          r.unquarantineConflicts.push({ from: e.to, to: e.from });
          continue;
        }
      } catch (err) {
        r.unquarantineFailed.push({ path: e.to, reason: msg(err) });
        continue;
      }
      if (!dry) {
        const id = await begin();
        try {
          await mkdir(dirname(e.from), { recursive: true }); // the encoded project folder may be gone
          await moveEntry(e.to, e.from, fs);
        } catch (err) {
          if (err instanceof MoveRefused && err.code === "EEXIST") r.unquarantineConflicts.push({ from: e.to, to: e.from });
          else r.unquarantineFailed.push({ path: e.to, reason: `could not move back (${moveFailure(err)})` });
          continue;
        }
        try {
          await j.append({ t: "unquarantined", runId: id, from: e.to, to: e.from });
        } catch (err) {
          try { await moveEntry(e.from, e.to, fs); } catch (back) {
            throw new JournalWriteError(`Could not write the journal (${msg(err)}) after moving ${e.to} back to ${e.from}, and could not undo that move (${moveFailure(back)}). Nothing is lost; a later rollback reports it as already restored.`);
          }
          throw new JournalWriteError(`Could not write the journal (${msg(err)}); ${e.to} stays in quarantine.`);
        }
        await pruneEmptyQuarantineDirs(dirname(e.to), where.home, platform);
      }
      r.unquarantined.push(e.from);
    } else if (e.t === "instance-created") {
      r.instancesCreated.unshift(e.instanceId);
    } else if (e.t === "project-created") {
      r.projectsCreated.unshift({ projectId: e.projectId, root: e.root });
    }
  }
  } catch (e) {
    await (api as T3Api | null)?.close();
    throw e;
  }

  // ---------- T3 ----------
  const defaults = new Map<string, { previous: unknown; next: unknown }>();
  for (const { e } of mine) {
    if (e.t !== "project-default-set") continue;
    const d = defaults.get(e.projectId);
    if (d) d.next = e.next; // the run's first `previous` is the original; its last `next` is what it left
    else defaults.set(e.projectId, { previous: e.previous, next: e.next });
  }
  const instEntries = mine.map((x) => x.e).filter((e): e is Extract<JournalEntry, { t: "instance-pinned" | "instance-updated" }> => e.t === "instance-pinned" || e.t === "instance-updated");
  const threadIds: string[] = [];
  for (const { e } of mine) {
    const ids: unknown[] = e.t === "imported" ? [e.threadId] : e.t === "import-attempt" ? e.items.map((x) => (isObj(x) ? x.threadId : undefined)) : [];
    for (const id of ids) {
      if (!isStr(id)) { r.errors.push(`skipped a malformed ${e.t} item (threadId missing)`); continue; }
      if (!threadIds.includes(id)) threadIds.push(id);
    }
  }
  const parkedIds: string[] = [];
  for (const { e } of mine) {
    if (e.t !== "import-attempt" || !Array.isArray(e.parked)) continue;
    for (const x of e.parked) {
      const id = isObj(x) ? x.threadId : undefined;
      if (isStr(id) && !threadIds.includes(id) && !parkedIds.includes(id)) parkedIds.push(id);
    }
  }
  // Merges (Task 23). Each undo is a swap: bring the old thread back (if the run archived it), then archive the
  // revision thread. An undone merge (revision removed, or already gone) swaps; a merge whose revision was continued
  // since is kept whole and reported. Also undone: a thread the run archived without a `merged` entry (crash between
  // thread-archived and merged), and a revision thread the run UNarchived (re-merge after a rollback) whose revision is
  // removed. The revision thread is archived only once its old thread is active, so no session ends with no thread.
  for (const f of r.filesKeptModified) kept.set(keyOf(f), "revision continued");
  for (const f of r.filesKeptActive) kept.set(keyOf(f), "revision in use");
  for (const f of r.filesKeptRewritten) kept.set(keyOf(f), "revision rewritten");
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

  // Session lineages (Task 23): an original thread and the revision threads merged from it. THE invariant of every
  // archive below (one guard, `mayArchive`): never archive a thread if that leaves its lineage without an active thread,
  // judged on the freshly read thread list plus what this rollback already changed.
  const lineage = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    const la = lineage.get(a) ?? new Set([a]);
    const lb = lineage.get(b) ?? new Set([b]);
    const all = new Set([...la, ...lb]);
    for (const id of all) lineage.set(id, all);
  };
  for (const { e } of mine) if (e.t === "merged") link(e.oldThreadId, e.newThreadId);
  for (const sw of swaps) if (sw.old !== null && sw.rev !== null) link(sw.old, sw.rev);
  for (const { e } of mine) {
    if (e.t !== "imported") continue;
    const w = revisionsOfRun.find((x) => x.rev === e.nativeId);
    if (w && e.threadId.endsWith(`:${w.rev}`)) link(`${e.threadId.slice(0, -w.rev.length)}${w.nativeId}`, e.threadId);
  }
  /** Revision threads of merges kept whole (continued since): never archived by this rollback. */
  const keptNew = new Set(mine.flatMap(({ e }) => (e.t === "merged" && kept.has(keyOf(e.revisionFile)) ? [e.newThreadId] : [])));
  const needsReview = (threadId: string, reason: string): void => {
    if (!r.needsReview.some((x) => x.threadId === threadId)) r.needsReview.push({ threadId, reason });
  };
  const mayArchive = (id: string, lv: Map<string, boolean>): boolean => {
    const group = lineage.get(id);
    if (!group) return true;
    if ([...group].some((t) => t !== id && lv.get(t) === false)) return true;
    const missing = [...group].filter((t) => t !== id && !lv.has(t));
    needsReview(id, missing.length > 0
      ? `left active: the session's other thread (${missing.join(", ")}) no longer exists in T3 Code, so this is its only thread`
      : "left active: it is the session's only active thread (its original thread is archived and could not be brought back)");
    return false;
  };

  const needT3 = defaults.size > 0 || threadIds.length > 0 || swaps.length > 0 || (deps.instances === true && instEntries.length > 0);

  if (needT3) await connectT3Once();
  try {
    // defaults
    if (defaults.size > 0) {
      let projects: Awaited<ReturnType<T3Api["listProjects"]>> | null = null;
      if (api) {
        try { projects = await api.listProjects(); } catch (e) { r.t3Unavailable ??= `could not read T3 projects (${msg(e)})`; }
      }
      for (const [projectId, d] of defaults) {
        if (!api || !projects) { r.defaultsSkipped.push({ projectId, reason: r.t3Unavailable ?? "T3 Code not connected" }); continue; }
        const p = projects.find((x) => x.id === projectId);
        if (!p) { r.defaultsSkipped.push({ projectId, reason: "project no longer exists in T3 Code" }); continue; }
        const cur = selection(p.defaultModelSelection).instanceId;
        const prev = selection(d.previous);
        const next = selection(d.next).instanceId;
        if (cur === prev.instanceId) continue; // already restored
        if (cur !== next) { r.defaultsSkipped.push({ projectId, reason: `changed since (now ${cur ?? "none"})` }); continue; }
        if (!dry) {
          const id = await begin();
          let previous: unknown;
          try {
            ({ previous } = await api.setProjectDefault(projectId, prev.instanceId, prev.model));
          } catch (e) {
            r.defaultsSkipped.push({ projectId, reason: `failed: ${msg(e)}` });
            continue;
          }
          await j.append({ t: "project-default-set", runId: id, projectId, previous, next: d.previous });
        }
        r.defaultsRestored.push(projectId);
      }
    }

    // instances (newest first, so a run that changed one twice ends at its first `previous`)
    for (const e of [...instEntries].reverse()) {
      const c: InstanceChange = { instanceId: e.instanceId, kind: e.t === "instance-pinned" ? "pinned" : "updated", previous: e.previous, next: e.next, status: "listed" };
      r.instanceChanges.unshift(c);
      if (!deps.instances) continue;
      if (!api) { c.status = "failed"; c.note = r.t3Unavailable ?? "T3 Code not connected"; continue; }
      try {
        await restoreInstance(api, e, c, { dry, platform, begin, j });
      } catch (err) {
        c.status = "failed";
        c.note = msg(err);
      }
    }

    // threads
    if (live === null && (threadIds.length > 0 || swaps.length > 0) && api) {
      try { live = new Map((await api.listThreads()).map((t) => [t.id, t.archived] as const)); } catch (e) { r.errors.push(`could not read T3 threads: ${msg(e)}`); }
    }
    if (swaps.length > 0) {
      const lv = live;
      if (!api || !lv) r.errors.push(`merge threads not restored: ${r.t3Unavailable ?? "T3 threads unreadable"}`);
      else {
        // `lv` is updated in a dry run too: it is the projected state the guard judges.
        for (const sw of swaps) {
          if (sw.old !== null && lv.get(sw.old) === true) {
            if (!dry) {
              const rid = await begin();
              try { await api.unarchiveThread(sw.old); } catch (e) {
                r.errors.push(`could not unarchive thread ${sw.old}: ${msg(e)}`);
                if (sw.rev !== null && lv.get(sw.rev) === false) needsReview(sw.rev, `left active: its original thread ${sw.old} could not be unarchived`);
                continue;
              }
              await j.append({ t: "thread-unarchived", runId: rid, threadId: sw.old });
            }
            lv.set(sw.old, false);
            if (!r.threadsUnarchived.includes(sw.old)) r.threadsUnarchived.push(sw.old);
          }
          if (sw.rev === null || lv.get(sw.rev) !== false) continue; // archived already, or gone
          if (!mayArchive(sw.rev, lv)) continue;
          if (!dry) {
            const rid = await begin();
            try { await api.archiveThread(sw.rev); } catch (e) { r.errors.push(`could not archive thread ${sw.rev}: ${msg(e)}`); continue; }
            await j.append({ t: "thread-archived", runId: rid, threadId: sw.rev });
          }
          lv.set(sw.rev, true);
          if (!r.threadsArchived.includes(sw.rev)) r.threadsArchived.push(sw.rev);
        }
      }
    }
    if (threadIds.length > 0) {
      const lv = live;
      if (lv) {
        r.threadsVerified = true;
        r.threadsToReview = threadIds.filter((id) => lv.has(id));
        if (deps.archiveThreads && api) {
          for (const id of r.threadsToReview) {
            if (lv.get(id) || r.threadsArchived.includes(id)) continue; // already archived
            if (keptNew.has(id)) continue; // a kept merge's revision thread: the session continues there
            if (!mayArchive(id, lv)) continue;
            if (!dry) {
              const rid = await begin();
              try {
                await api.archiveThread(id);
              } catch (e) {
                r.errors.push(`could not archive thread ${id}: ${msg(e)}`);
                continue;
              }
              await j.append({ t: "thread-archived", runId: rid, threadId: id });
            }
            lv.set(id, true);
            r.threadsArchived.push(id);
          }
        }
      } else {
        r.threadsToReview = [...threadIds];
      }
    }
    // Parked copies: listed only when T3's thread list was read and their thread exists.
    if (live !== null) r.parkedThreads = parkedIds.filter((id) => (live as Map<string, boolean>).has(id));
  } finally {
    await api?.close();
  }

  if (rb !== null) {
    r.runId = rb;
    const at = new Date(now()).toISOString();
    const partial = r.errors.length > 0 || r.unquarantineConflicts.length > 0 || r.unquarantineFailed.length > 0 || r.defaultsSkipped.length > 0
      || r.instanceChanges.some((c) => c.status === "failed");
    await j.append({ t: "rolled-back", runId: rb, targetRunId, at });
    await j.append({ t: "run-end", runId: rb, at, status: partial ? "partial" : "ok" });
  }
  return r;
}

const DEFAULT_INSTANCE = "claudeAgent";

async function restoreInstance(
  api: T3Api,
  e: Extract<JournalEntry, { t: "instance-pinned" | "instance-updated" }>,
  c: InstanceChange,
  x: { dry: boolean; platform: NodeJS.Platform; begin: () => Promise<string>; j: Journal },
): Promise<void> {
  const cur = (await api.providerInstances()).find((i) => i.instanceId === e.instanceId);
  if (!cur) { c.status = "not-restorable"; c.note = "the instance no longer exists"; return; }
  const same = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : sameCwd(a, b, x.platform));

  if (e.t === "instance-pinned") {
    const prev = e.previous.homePath;
    if (e.instanceId === DEFAULT_INSTANCE) { c.status = "not-restorable"; c.note = "claudeAgent stays pinned to ~/.claude"; return; }
    if (prev === null) { c.status = "not-restorable"; c.note = "it had no explicit home before; T3 Code has no way to unpin"; return; }
    if (same(cur.homePath, prev)) { c.status = "already"; return; }
    if (!same(cur.homePath, e.next.homePath)) { c.status = "changed-since"; c.note = `home is now ${cur.homePath ?? "unset"}`; return; }
    if (!x.dry) {
      const id = await x.begin();
      await api.pinInstanceHome(e.instanceId, prev);
      await x.j.append({ t: "instance-pinned", runId: id, instanceId: e.instanceId, previous: { homePath: cur.homePath }, next: { homePath: prev } });
    }
    c.status = "restored";
    return;
  }

  const prev = e.previous, next = e.next;
  // A null previous (no explicit label/colour before) cannot be written back: T3 Code has no "clear" for it.
  const cannotClear = prev.accentColor === null && cur.accentColor !== null;
  const note = cannotClear ? "the accent colour cannot be cleared through T3 Code; change it in T3 Code's settings" : undefined;
  const homeBack = prev.homePath !== null && next.homePath !== null && !same(prev.homePath, next.homePath) && e.instanceId !== DEFAULT_INSTANCE;
  const ap: { displayName?: string; accentColor?: string } = {};
  if (prev.displayName !== null && prev.displayName !== cur.displayName) ap.displayName = prev.displayName;
  if (prev.accentColor !== null && prev.accentColor !== cur.accentColor) ap.accentColor = prev.accentColor;
  const homeNeeded = homeBack && !same(cur.homePath, prev.homePath);
  if (ap.displayName === undefined && ap.accentColor === undefined && !homeNeeded) {
    c.status = cannotClear && cur.accentColor === next.accentColor && cur.displayName === (next.displayName ?? cur.displayName) ? "not-restorable" : "already";
    c.note = note;
    return;
  }
  if ((next.displayName !== null && cur.displayName !== next.displayName) || cur.accentColor !== next.accentColor) {
    c.status = "changed-since";
    c.note = `now ${JSON.stringify(cur.displayName)} ${cur.accentColor ?? "no colour"}`;
    return;
  }
  const notes: string[] = note ? [note] : [];
  if (!x.dry) {
    const id = await x.begin();
    if (ap.displayName !== undefined || ap.accentColor !== undefined) await api.updateInstanceAppearance(e.instanceId, ap);
    if (homeBack) await api.pinInstanceHome(e.instanceId, prev.homePath!);
    await x.j.append({
      t: "instance-updated", runId: id, instanceId: e.instanceId,
      previous: { displayName: cur.displayName, accentColor: cur.accentColor, homePath: cur.homePath },
      next: { displayName: ap.displayName ?? cur.displayName, accentColor: ap.accentColor ?? cur.accentColor, homePath: homeBack ? prev.homePath : cur.homePath },
    });
  }
  c.status = "restored";
  if (notes.length) c.note = notes.join("; ");
}

// ---------------- runs ----------------

export interface RunSummary {
  runId: string;
  at: string | null;
  command: string | null;
  /** run-end status, "incomplete" (started, no run-end) or "-" (no run-start: an `accounts` change). */
  status: string;
  rolledBackBy: string | null;
  counts: { imported: number; importFailed: number; filesWritten: number; quarantined: number; unquarantined: number; defaults: number; instances: number; projects: number; archived: number; merged: number };
}

/** One summary per run id, in journal order (mtime-bump/restore bookkeeping alone does not make a run). */
export function listRuns(entries: JournalEntry[]): RunSummary[] {
  const byId = new Map<string, RunSummary>();
  const get = (id: string): RunSummary => {
    let s = byId.get(id);
    if (!s) {
      s = { runId: id, at: null, command: null, status: "-", rolledBackBy: null, counts: { imported: 0, importFailed: 0, filesWritten: 0, quarantined: 0, unquarantined: 0, defaults: 0, instances: 0, projects: 0, archived: 0, merged: 0 } };
      byId.set(id, s);
    }
    return s;
  };
  for (const e of entries) {
    if (e.t === "mtime-bump" || e.t === "mtime-restore") continue;
    const s = get(e.runId);
    switch (e.t) {
      case "run-start": s.at = e.at; s.command = e.command; if (s.status === "-") s.status = "incomplete"; break;
      case "run-end": s.status = e.status; break;
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
      case "rolled-back": get(e.targetRunId).rolledBackBy = e.runId; break;
      default: break;
    }
  }
  for (const w of effectiveWrites(entries)) get(w.runId).counts.filesWritten++;
  return [...byId.values()];
}
