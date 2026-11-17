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
// old thread unarchived and its revision thread archived; a revision continued since keeps both threads (reported), and
// so does a merge a later run (not rolled back) built on: a follow of its revision thread, or a revision of its
// revision ("followed again by run X; roll back X first"). A revision a later run journaled again (reused it and
// swapped it in) is that run's: kept here ("rewritten"), with its thread.
// Destination folders an apply created for rehome copies (`folder-created`): removed deepest first, up to the topmost
// one it created, each only while it is empty; one holding anything is kept (reported).
// Organize changes (`organize-change`): reverted exactly as `t3sm organize --undo` does (undoOrganizeEntries), newest
// first, only where T3 still shows the value t3sm set; T3 Code is reached first, before any file is touched.
// Idempotent: every step checks the current state (or a later journal entry) first, and a rollback that changes
// nothing writes nothing to the journal.
//
// Next to it: rollbackTypes.ts (deps and report), rollbackEntries.ts (the entry checks), rollbackMerges.ts (which
// merges are undone), rollbackInstances.ts (instance restores) and rollbackRuns.ts (runs and their summaries).

import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { JournalEntry } from "../core/types.ts";
import { effectiveWrites, newRunId } from "../core/journal.ts";
import { sha256File, statSafe } from "../core/fsutil.ts";
import { pathKey } from "../core/paths.ts";
import { ConfigError } from "../core/config.ts";
import { isActive } from "../core/activity.ts";
import type { T3Api } from "../t3/api.ts";
import { T3NotRunning } from "../t3/errors.ts";
import { organizeGate } from "../t3/compat.ts";
import { OrganizeReadError, undoOrganizeEntries } from "../organize/apply.ts";
import { JournalWriteError, MoveRefused, moveEntry, moveFailure, nodeMoveFs, pruneEmptyQuarantineDirs } from "./quarantine.ts";
import type { InstanceChange, KeptReason, RollbackDeps, RollbackReport } from "./rollbackTypes.ts";
import { convertedFileOk, exists, foldersUpTo, isObj, isStr, malformed, msg, quarantineHome, sameFile, selection } from "./rollbackEntries.ts";
import { planMergeUndo } from "./rollbackMerges.ts";
import { restoreInstance } from "./rollbackInstances.ts";
import { isCompactionRun, isRollbackRun } from "./rollbackRuns.ts";

export type { InstanceChange, RollbackDeps, RollbackReport } from "./rollbackTypes.ts";
export { isCompactionRun, isRollbackRun, latestRunId, listRuns, organizeOnlyRun, type RunSummary } from "./rollbackRuns.ts";

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
  if (isCompactionRun(all, targetRunId)) {
    // It changed only journal.jsonl; the journal as it was is the backup its journal-compacted entry names.
    throw new ConfigError("Cannot roll back a journal compaction: it changed only journal.jsonl. The journal as it was is the backup next to it (journal.<run>.bak.jsonl).");
  }
  const r: RollbackReport = {
    runId: null, targetRunId, command: null,
    filesRemoved: [], filesKeptModified: [], filesKeptActive: [], filesKeptRewritten: [], filesKeptRefreshed: [], foldersRemoved: [], foldersKept: [], unquarantined: [], unquarantineConflicts: [], alreadyRestored: [],
    unquarantineMissing: [], unquarantineFailed: [], defaultsRestored: [], defaultsSkipped: [], instanceChanges: [], instancesCreated: [], projectsCreated: [],
    threadsToReview: [], threadsVerified: false, threadsArchived: [], parkedThreads: [], threadsUnarchived: [], mergesKept: [], needsReview: [], organize: [], t3Unavailable: null, errors: [],
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

  // Merges a later run built on (follow makes such chains routine: cycle A follows the copy into R1, cycle B follows R1
  // into R2): a later run swapped this merge's revision thread out again (`merged` / `followed` with it as the old
  // thread), or wrote a revision of this revision that is still there. Undoing it would delete the transcript the later
  // chain continues from and bring back a second active thread, so it is kept whole (its revision file too) until that
  // run is rolled back first. A later swap counts until a rollback undid it (rolled back, and its revision gone): a
  // rollback that kept it (the revision continued since) leaves it standing.
  const rolledBackRuns = new Set(all.flatMap((e) => (e.t === "rolled-back" ? [e.targetRunId] : [])));
  const liveWrites = new Set<JournalEntry>(effectiveWrites(all, keyOf));
  const there = async (file: string): Promise<boolean> => exists(file).catch(() => true);
  for (const { e, i } of mine) {
    if (e.t !== "merged") continue;
    const rev = basename(e.revisionFile, ".jsonl");
    let later: string | null = null;
    for (let xi = i + 1; xi < all.length && later === null; xi++) {
      const x = all[xi]!;
      if (x.runId === targetRunId) continue;
      const swap = x.t === "merged" && x.oldThreadId === e.newThreadId && isStr(x.revisionFile) ? x.revisionFile
        : x.t === "followed" && x.oldThread === e.newThreadId && isStr(x.copy) ? x.copy : null;
      if (swap !== null && (!rolledBackRuns.has(x.runId) || (await there(swap)))) later = x.runId;
      else if (x.t === "file-written" && x.revisionOf?.nativeId === rev && liveWrites.has(x) && isStr(x.path) && (await there(x.path))) later = x.runId;
    }
    if (later !== null) kept.set(keyOf(e.revisionFile), `followed again by run ${later}; roll back ${later} first`);
  }

  // Organize changes: T3 is opened before anything else, and an unverified version warns once (never refuses).
  const organizeEntries = mine.filter((x) => x.e.t === "organize-change").map((x) => x.e);
  if (organizeEntries.length > 0) {
    await connectT3Once();
    if (api !== null) organizeGate((api as T3Api).version, { allowUntested: deps.allowUntested ?? false, onNotice: deps.onNotice });
  }

  // ---------- files (newest first) ----------
  const seenFiles = new Set<string>();
  // Rehome copies a follow rewrote in place (refresh mode): T3 grew their thread from the new records, and the copy
  // before the refresh is gone; removing the file would leave that thread without its transcript. Kept, reported.
  const refreshed = new Set(mine.flatMap(({ e }) => (e.t === "followed" && e.mode === "refresh" && isStr(e.copy) ? [keyOf(e.copy)] : [])));
  try {
  for (const { e, i } of [...mine].reverse()) {
    if (e.t === "file-written") {
      if (!convertedFileOk(e.path, homes, platform)) { r.errors.push(`skipped file-written ${e.path}: not a transcript inside a configured account's projects folder`); continue; }
      // Never published (file-write-aborted later in the same run): whatever sits there is not ours.
      if (all.some((x, xi) => xi > i && x.t === "file-write-aborted" && x.runId === e.runId && isStr(x.path) && keyOf(x.path) === keyOf(e.path))) continue;
      const k = keyOf(e.path);
      if (seenFiles.has(k)) continue; // only this run's last write of a path counts
      seenFiles.add(k);
      if (refreshed.has(k)) { r.filesKeptRefreshed.push(e.path); continue; }
      if (kept.has(k)) continue; // a later run built on this revision (above): reported with its merge
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
    // Destination folders the run created (newest first): each only while it is empty, deepest first.
    for (const { e } of [...mine].reverse()) {
      if (e.t !== "folder-created") continue;
      let removedChild: string | null = null;
      for (const dir of foldersUpTo(e.path, e.created) ?? []) {
        let entries: string[];
        try { entries = await readdir(dir); } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") { removedChild = dir; continue; } // gone already
          r.errors.push(`could not read ${dir}: ${msg(err)}`);
          break;
        }
        if (entries.some((x) => removedChild === null || x !== basename(removedChild))) { r.foldersKept.push(dir); break; }
        if (!dry) {
          await begin();
          try { await rmdir(dir); } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOTEMPTY") r.foldersKept.push(dir);
            else r.errors.push(`could not remove ${dir}: ${msg(err)}`);
            break;
          }
        }
        r.foldersRemoved.push(dir);
        removedChild = dir;
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
  const { swaps, revisionsOfRun } = await planMergeUndo(mine, kept, r, keyOf);

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
  /**
   * Threads of revisions this rollback keeps (a merge kept whole, or a revision a later run journaled again and swapped
   * in): the session continues there, so they are never archived here, nor have their carried title or state reverted.
   */
  const keptNew = new Set(mine.flatMap(({ e }) => {
    if (e.t === "merged") return kept.has(keyOf(e.revisionFile)) ? [e.newThreadId] : [];
    if (e.t !== "imported") return [];
    const w = revisionsOfRun.find((x) => x.rev === e.nativeId);
    return w && e.threadId.endsWith(`:${w.rev}`) && kept.has(keyOf(w.path)) ? [e.threadId] : [];
  }));
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

  const needT3 = organizeEntries.length > 0 || defaults.size > 0 || threadIds.length > 0 || swaps.length > 0 || (deps.instances === true && instEntries.length > 0);

  if (needT3) await connectT3Once();
  try {
    // organize (first: the newest changes of a run that imported and then organized)
    if (organizeEntries.length > 0) {
      if (!api) r.errors.push(`organize changes not undone: ${r.t3Unavailable ?? "T3 Code not connected"}`);
      else {
        // Only the first read of T3 is caught (nothing changed yet); a journal failure (JournalWriteError, naming what
        // was already reverted) stops the rollback like every other journal failure here. r.organize fills as it goes.
        // A follow's title and settled state carried to its revision thread (src/ops/follow.ts) stay with that thread:
        // the swap below archives it and brings the old thread back with its own. (T3 cannot clear a settled override,
        // so a carry onto a thread that had none could not be put back anyway.)
        const swappedOut = new Set(swaps.flatMap((sw) => (sw.old !== null && sw.rev !== null ? [sw.rev] : [])));
        // A kept follow's revision thread (keptNew) keeps them too: it is the thread the user continues.
        const carried = new Set(mine.flatMap(({ e }) => (e.t === "followed" && isStr(e.newThread) && (swappedOut.has(e.newThread) || keptNew.has(e.newThread)) ? [e.newThread] : [])));
        const toUndo = organizeEntries.filter((e) => !(e.t === "organize-change" && carried.has(e.target) && (e.kind === "title" || e.kind === "unsettle" || e.kind === "settle")));
        try {
          await undoOrganizeEntries(toUndo, targetRunId, { api, journal: j, begin, dryRun: dry, platform, history: all }, r.organize);
        } catch (e) {
          if (!(e instanceof OrganizeReadError)) throw e;
          r.errors.push(`organize changes not undone: ${e.message}`);
        }
        // An archive put back changes which threads are archived: read them again below when needed.
        if (r.organize.some((x) => x.kind === "archive" && x.status === "reverted")) live = null;
      }
    }

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
      || r.instanceChanges.some((c) => c.status === "failed") || r.organize.some((x) => x.status === "failed");
    await j.append({ t: "rolled-back", runId: rb, targetRunId, at });
    await j.append({ t: "run-end", runId: rb, at, status: partial ? "partial" : "ok" });
  }
  return r;
}
