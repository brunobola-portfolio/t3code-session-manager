// Merge revisions (spec §4.6, docs/spikes/S3-conversion.md §6, docs/spikes/S5-merge.md): bring work continued in a
// terminal (`claude --resume`) into T3 Code. T3 continues an imported thread from the last record IT wrote, so terminal
// turns end up on a side branch T3 never shows. A merge writes a linear "revision" transcript of the branch
// `claude --resume` would continue, imports it as a NEW thread, and only then archives the old thread.
//
// Rules:
//   - the original transcript is NEVER modified; the revision is a new file `<same dir>/<revisionUuid>.jsonl`
//     (revisionUuid = uuidV5("rev:<nativeId>:<size>")), never written over a file t3sm did not write, journaled
//     (`file-written` with `revisionOf`) before it is published, published without clobbering (link), given the
//     source's mtime. Its bytes depend only on the source (the provenance date is the source's mtime);
//   - the import goes through runWaves (bump / park / restore, exposure, held projects): a project with another
//     transcript in use defers the merge ("project-in-use");
//   - only after the new thread is confirmed in T3's thread list (unarchived first if a rolled-back merge left it
//     archived): archiveThread(old), journal `thread-archived`, then `merged`. A failed or deferred import deletes the
//     revision (while it is still exactly what t3sm wrote) and leaves the old thread alone; only the failure is
//     journaled (runWaves' import-failed);
//   - transcripts are streamed (two passes: an index of byte offsets, then the chain records read back by offset), so
//     a transcript over 32 MiB never sits in memory; verdicts are cached by (path, size, mtime, baseline).
//
// Branch and leaf (S3 §6, measured): nodes = records with a uuid, any type, not isSidechain. Leaf = the record named by
// the newest `last-prompt.leafUuid` that resolves, else the last node in file order. Chain = walk parentUuid from the
// leaf to the root. A revision is written only from a whole chain: a root whose parent is set but unknown, a cycle, or a
// corrupt line inside the chain's byte range -> skipped (`broken-chain` / `corrupt-lines`), never a truncated revision.
// A chain that crosses a compaction (`compact_boundary`, or a record with `logicalParentUuid`) -> `compacted`: merging
// compacted sessions is not supported yet. The revision holds a provenance record (isMeta user, parentUuid null) and
// then the chain root->leaf with `sessionId` rewritten and the chain root's `parentUuid` pointed at the provenance
// record; uuids and everything else are kept. Records without a uuid (last-prompt, summary, custom-title, ...) are not
// carried: none is needed to resume, and a copied last-prompt would redirect the revision's own resume.
//
// "Continued outside T3" needs POSITIVE evidence (controller ruling R1): after the baseline (the size t3sm imported, or
// the size of the last merge), a visible message record (user/assistant; not isMeta, isSidechain, isCompactSummary,
// isVisibleInTranscriptOnly) on the branch `claude --resume` continues, whose `entrypoint` is a string other than
// "t3-code". A record without an entrypoint is not evidence. If T3 evidently wrote since the baseline (the thread's
// latestUserMessageAt is newer than the baseline file's mtime) but no record after the baseline carries "t3-code",
// T3's marker may have changed: `no-t3-marker`, never merged. Sessions t3sm did not import have no baseline: never
// candidates.
//
// Next to it: mergeBranch.ts (reading the branch), mergeCache.ts (verdicts and pending counts) and revision.ts (the
// write, import and swap steps merge shares with follow).

import { rm, utimes } from "node:fs/promises";
import path from "node:path";
import type { Config, HarnessId, JournalEntry, PlanItem } from "../core/types.ts";
import type { Journal } from "../core/journal.ts";
import { effectiveWrites, importedIndex, near } from "../core/journal.ts";
import { revisionUuid } from "../core/uuid.ts";
import { sha256File, statSafe, type LinkFs } from "../core/fsutil.ts";
import { pathKey } from "../core/paths.ts";
import { isActive } from "../core/activity.ts";
import type { T3Api, T3Project, T3Thread } from "../t3/api.ts";
import type { BumpFile } from "../apply/restore.ts";
import { WRITTEN_MAX_AGE_MS, writtenMtime } from "../apply/materialize.ts";
import { firstLineLength, readBranch, type BranchProblem, type TranscriptBranch } from "./mergeBranch.ts";
import { readCache, writeCache, type Verdict } from "./mergeCache.ts";
import { appendOrStop, importRevision, prepareRevision, publishRevision, removeIfOurs, swapThreads, sweepStaleTemps, type PreparedRevision } from "./revision.ts";

export { readBranch, type BranchNode, type BranchProblem, type TranscriptBranch } from "./mergeBranch.ts";
export { readMergePending, setMergePending, type MergePending } from "./mergeCache.ts";
export {
  appendOrStop, importRevision, prepareRevision, provenanceText, publishRevision, removeIfOurs, swapThreads, sweepStaleTemps,
  type PreparedRevision, type RevisionImportCtx, type RevisionImportOutcome,
} from "./revision.ts";
export { revisionUuid };

/** sync merges at most this many sessions per cycle. */
export const MERGES_PER_CYCLE = 20;

export type MergeSkipReason =
  | BranchProblem
  | "active" // written in the last 10 minutes (or while the merge ran): next time
  | "not-continued" // no positive evidence of terminal work on the branch `claude --resume` continues
  | "rehomed-copy" // a conversation copied from a folder T3 Code refuses (plan note continued-after-rehome): merge cannot apply (R11)
  | "no-t3-marker" // T3 wrote since the import, but no record carries entrypoint "t3-code": T3's marker may have changed
  | "already-merged" // this exact revision (same session, same size) was merged before
  | "thread-archived" // its T3 thread is archived (merged earlier, or archived by the user)
  | "target-exists" // a file t3sm did not write sits at the revision path
  | "revision-in-use" // the revision t3sm wrote earlier was continued since (resumed before an interrupted run ended)
  | "copy-failed" // reading the source or writing the revision failed
  | "import-failed" // T3 did not import the revision (journaled by the importer)
  | "import-unverified" // T3's thread list could not be read after the import; the revision is kept for the next run
  | "project-in-use" // another transcript of the project is being written: T3 would import it now
  | "archive-failed" // the new thread exists, but the old one could not be archived; the next run retries
  | "over-cap" // more candidates than this run's limit: next run
  | "clock-jump" // the system clock jumped (sleep, time change) during the import: next run
  | "file-busy" // a transcript of its project stayed locked by another program: next run
  | "aborted"; // interrupted (Ctrl+C) before this session was merged

/** Waiting on something else (counted as merge-deferred by sync); "active" is the user's own session, not counted. */
export const DEFERRED_REASONS: ReadonlySet<MergeSkipReason> = new Set(["project-in-use", "over-cap", "clock-jump", "file-busy", "aborted"]);
/** Failures worth an exit code 5. */
export const FAILED_REASONS: ReadonlySet<MergeSkipReason> = new Set(["copy-failed", "import-failed", "import-unverified", "archive-failed"]);

// ---------------- candidates ----------------

export interface MergeCandidate {
  item: PlanItem;
  nativeId: string;
  sourcePath: string;
  source: { size: number; mtimeMs: number; atimeMs: number };
  projectId: string;
  /** The T3 project's workspace root (T3's spelling). */
  projectRoot: string;
  instanceId: string;
  oldThreadId: string;
  oldTitle: string;
  revisionUuid: string;
  revisionFile: string;
  newThreadId: string;
  addedMessages: number;
  divergedLeaves: number;
  lastActivity: string | null;
  /** The revision file is already there, written by t3sm and unchanged (an earlier run stopped before the archive). */
  reuse: { sha256: string } | null;
  branch: TranscriptBranch;
}

export interface MergeSkip { nativeId: string; reason: MergeSkipReason }

export interface MergedSession {
  nativeId: string; revisionUuid: string; revisionFile: string; newThreadId: string; oldThreadId: string; oldTitle: string;
  addedMessages: number; divergedLeaves: number; projectRoot: string;
}

export interface MergeResult { merged: MergedSession[]; skipped: MergeSkip[] }

/** A session that is not merged, but holds terminal work on a side branch neither T3 nor `claude --resume` shows. */
export interface OrphanedWork { nativeId: string; projectRoot: string; branches: number }

export interface MergeDeps {
  api: T3Api;
  journal: Journal;
  /** Journal run id, or a function called once right before the first write (it journals the run-start). */
  runId: string | (() => Promise<string>);
  now?: () => number;
  platform?: NodeJS.Platform;
  /** State dir: the verdict cache and the pending count live in <stateDir>/cache/merge.json. */
  stateDir?: string;
  /** A listing (`merge --dry-run`, `merge` without --all/--session): the cache is read, never written. */
  readOnly?: boolean;
  /** Retry a revision whose import failed before (default true; sync passes false: no retry storm every cycle). */
  retryFailed?: boolean;
  /** At most this many merges (the rest: "over-cap"). */
  limit?: number;
  /** Every discovered session T3 could import (exposure while the revision imports); default: the items. */
  exposureItems?: PlanItem[];
  /** Config account id -> absolute home (wave-time listing for instances T3 reports without a home). */
  accountHomes?: Record<string, string>;
  batch?: Config["batch"];
  aborted?: () => boolean;
  onProgress?: (line: string) => void;
  onPendingFiles?: (files: BumpFile[] | null) => void;
  /** Test hook for publishing the revision (link + unlink), e.g. a filesystem without hard links. */
  linkFs?: LinkFs;
}

/** A thread T3 imported from a transcript: `import:<instance>:<native id>`. */
export const IMPORT_THREAD = /^import:([^:]+):(.+)$/s;

type MergedEntry = Extract<JournalEntry, { t: "merged" }>;
type WrittenEntry = Extract<JournalEntry, { t: "file-written" }>;

/** Merges still standing: not rolled back. */
export function standingMerges(entries: JournalEntry[]): MergedEntry[] {
  const rolledBack = new Set(entries.flatMap((e) => (e.t === "rolled-back" ? [e.targetRunId] : [])));
  return entries.filter((e): e is MergedEntry => e.t === "merged" && !rolledBack.has(e.runId));
}

/** Revision files t3sm wrote that no standing merge uses (path identity per platform: case-folded on win32/darwin). */
export function unmergedRevisionFiles(entries: JournalEntry[], platform: NodeJS.Platform = process.platform): WrittenEntry[] {
  const key = (p: string): string => pathKey(p, platform);
  const used = new Set(standingMerges(entries).map((e) => key(e.revisionFile)));
  const last = new Map<string, WrittenEntry>();
  for (const e of effectiveWrites(entries, key)) if (e.revisionOf) last.set(key(e.path), e);
  return [...last].filter(([k]) => !used.has(k)).map(([, e]) => e);
}

/** Read-only (apart from the verdict cache): which of `items` would be merged, and why the others are not. */
export async function findMergeCandidates(items: PlanItem[], deps: MergeDeps): Promise<{ candidates: MergeCandidate[]; skipped: MergeSkip[]; orphaned: OrphanedWork[] }> {
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const key = (p: string): string => pathKey(p, platform);
  const entries = await deps.journal.readAll();
  const imported = importedIndex(entries);
  const ours = new Map<string, string>();
  for (const e of effectiveWrites(entries, key)) ours.set(key(e.path), e.sha256);
  const merges = standingMerges(entries);
  const mergedRevs = new Set(merges.map((e) => e.revisionUuid));
  const failedRevs = new Set(entries.filter((e) => e.t === "import-failed").map((e) => (e as { nativeId: string }).nativeId));
  const [threads, projects] = await Promise.all([deps.api.listThreads(), deps.api.listProjects()]);
  const byNative = new Map<string, T3Thread[]>();
  for (const t of threads) {
    const m = IMPORT_THREAD.exec(t.id);
    if (m) (byNative.get(m[2]!) ?? byNative.set(m[2]!, []).get(m[2]!)!).push(t);
  }
  const projectById = new Map<string, T3Project>(projects.map((p) => [p.id, p]));
  const cache = await readCache(deps.stateDir);
  const fresh: Record<string, Verdict> = {};
  let cacheChanged = false;

  const candidates: MergeCandidate[] = [];
  const skipped: MergeSkip[] = [];
  const orphaned: OrphanedWork[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const s = item.session;
    if (s.harness !== "claude" || item.action.kind !== "skip" || item.action.reason !== "already-in-t3") continue;
    if (seen.has(s.nativeId)) continue;
    seen.add(s.nativeId);
    const skip = (reason: MergeSkipReason): void => void skipped.push({ nativeId: s.nativeId, reason });
    // Its T3 thread is a faithful copy under another id (spec §4.3): a revision of this file could not reach it (R11).
    if (item.notes.includes("continued-after-rehome")) { skip("rehomed-copy"); continue; }
    const st = await statSafe(s.file.path).catch(() => null);
    if (st === null) continue;
    const rev = revisionUuid(s.nativeId, st.size);
    const revisionFile = path.join(path.dirname(s.file.path), `${rev}.jsonl`);
    const revSt = await statSafe(revisionFile).catch(() => null);
    if (mergedRevs.has(rev) && revSt !== null) { skip("already-merged"); continue; }
    const own = byNative.get(s.nativeId) ?? [];
    const thread = own.find((t) => !t.archived);
    if (!thread) { if (own.length > 0) skip("thread-archived"); continue; }
    const project = projectById.get(thread.projectId);
    if (!project) continue;

    // Baseline: what t3sm imported, or what it merged last (R1).
    const j = imported.get(`claude:${s.nativeId}`);
    if (!j) { skip("not-continued"); continue; } // not imported by t3sm: no baseline, never a candidate
    let base = { size: j.source.size, mtimeMs: j.source.mtimeMs };
    for (const m of merges) {
      if (m.nativeId === s.nativeId && typeof m.sourceSize === "number" && m.sourceSize > base.size && m.sourceSize <= st.size) {
        base = { size: m.sourceSize, mtimeMs: typeof m.sourceMtimeMs === "number" ? m.sourceMtimeMs : base.mtimeMs };
      }
    }
    if (base.size === st.size && near(st.mtimeMs, base.mtimeMs)) { skip("not-continued"); continue; }
    if (isActive(st.mtimeMs, now())) { skip("active"); continue; }
    if (deps.retryFailed === false && failedRevs.has(rev)) { skip("import-failed"); continue; }

    const ck = `${key(s.file.path)}|${st.size}|${st.mtimeMs}|${base.size}`;
    let branch: TranscriptBranch | null = null;
    let v = cache.verdicts[ck];
    if (!v) {
      try {
        branch = await readBranch(s.file.path, { importedSize: base.size });
      } catch {
        skip("copy-failed");
        continue;
      }
      v = {
        problem: branch.problem, addedMessages: branch.addedMessages, t3MarkerAfter: branch.t3MarkerAfter, divergedLeaves: branch.divergedLeaves,
        orphanedTerminal: branch.orphanedTerminal, lastActivity: branch.lastActivity, empty: branch.chain.length === 0,
      };
      cacheChanged = true;
    }
    fresh[ck] = v;
    if (v.problem !== null) { skip(v.problem); continue; }
    const orphan = (): void => { if (v.orphanedTerminal > 0) orphaned.push({ nativeId: s.nativeId, projectRoot: project.workspaceRoot, branches: v.orphanedTerminal }); };
    if (v.empty || v.addedMessages === 0) { skip("not-continued"); orphan(); continue; }
    const t3Wrote = typeof thread.latestUserMessageAt === "string" && Date.parse(thread.latestUserMessageAt) > base.mtimeMs;
    if (t3Wrote && !v.t3MarkerAfter) { skip("no-t3-marker"); orphan(); continue; }

    let reuse: MergeCandidate["reuse"] = null;
    if (revSt !== null) {
      const mine = ours.get(key(revisionFile));
      if (mine === undefined) { skip("target-exists"); continue; }
      const have = await sha256File(revisionFile).catch(() => null);
      if (have !== mine) { skip("revision-in-use"); continue; }
      reuse = { sha256: mine };
    }
    if (branch === null) {
      try {
        branch = await readBranch(s.file.path, { importedSize: base.size });
      } catch {
        skip("copy-failed");
        continue;
      }
      if (branch.problem !== null || branch.addedMessages === 0) { skip(branch.problem ?? "not-continued"); continue; }
    }
    const instanceId = IMPORT_THREAD.exec(thread.id)![1]!;
    candidates.push({
      item, nativeId: s.nativeId, sourcePath: s.file.path, source: { size: st.size, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs },
      projectId: project.id, projectRoot: project.workspaceRoot, instanceId, oldThreadId: thread.id, oldTitle: thread.title,
      revisionUuid: rev, revisionFile, newThreadId: `import:${instanceId}:${rev}`,
      addedMessages: branch.addedMessages, divergedLeaves: branch.divergedLeaves, lastActivity: branch.lastActivity, reuse, branch,
    });
  }
  candidates.sort((a, b) => a.source.mtimeMs - b.source.mtimeMs || (a.nativeId < b.nativeId ? -1 : a.nativeId > b.nativeId ? 1 : 0));
  // The pending counts (doctor's merge-pending check) and the verdicts of the sessions seen this run.
  const pendingChanged = cache.pending?.count !== candidates.length || (cache.pending?.orphaned ?? 0) !== orphaned.length || cache.pending === undefined;
  if (cacheChanged || pendingChanged || Object.keys(fresh).length !== Object.keys(cache.verdicts).length) {
    const pending = pendingChanged ? { count: candidates.length, orphaned: orphaned.length, at: new Date(now()).toISOString() } : cache.pending;
    if (!deps.readOnly) await writeCache(deps.stateDir, { ...cache, version: 2, verdicts: fresh, pending });
  }
  return { candidates, skipped, orphaned };
}

// ---------------- merging ----------------

/** Writes, imports and swaps the threads of each candidate, one at a time (see the header for the order). */
export async function executeMerges(candidates: MergeCandidate[], deps: MergeDeps): Promise<MergeResult> {
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const res: MergeResult = { merged: [], skipped: [] };
  const limit = deps.limit ?? Infinity;
  let started: Promise<string> | null = null;
  const runId = (): Promise<string> => (started ??= typeof deps.runId === "string" ? Promise.resolve(deps.runId) : deps.runId());
  let providers: Awaited<ReturnType<T3Api["providerInstances"]>> | null = null;
  const swept = new Set<string>();
  let journalNow: JournalEntry[] | null = null;
  let threadIdsNow: Set<string> | null = null;

  for (const [i, c] of candidates.entries()) {
    const skip = (reason: MergeSkipReason): void => void res.skipped.push({ nativeId: c.nativeId, reason });
    if (i >= limit) { skip("over-cap"); continue; }
    if (deps.aborted?.()) { skip("aborted"); continue; }
    const dir = path.dirname(c.revisionFile);
    if (!swept.has(dir)) { swept.add(dir); await sweepStaleTemps(dir); }

    // Earlier revisions of this session that were never merged (import failed, unverified, crash) and are still ours:
    // removed, unless T3 holds a thread for them.
    journalNow ??= await deps.journal.readAll();
    threadIdsNow = null;
    for (const e of unmergedRevisionFiles(journalNow, platform)) {
      if (e.revisionOf?.nativeId !== c.nativeId || e.path === c.revisionFile) continue;
      // Any instance's thread for that revision (an import under another account) keeps it.
      threadIdsNow ??= new Set((await deps.api.listThreads()).flatMap((t) => [IMPORT_THREAD.exec(t.id)?.[2] ?? "", t.nativeSessionId ?? ""]).filter((x) => x !== ""));
      if (threadIdsNow.has(path.basename(e.path, ".jsonl"))) continue;
      if (await removeIfOurs(e.path, e.sha256)) deps.onProgress?.(`Removed an unmerged earlier revision ${e.path}`);
    }

    // ---------- the revision file ----------
    let sha: string;
    let firstLineBytes: number;
    if (c.reuse) {
      sha = c.reuse.sha256;
      firstLineBytes = await firstLineLength(c.revisionFile);
      // The source must still be idle and unchanged right before the import (it was checked at planning time only).
      const again = await statSafe(c.sourcePath).catch(() => null);
      if (again === null || again.size !== c.source.size || !near(again.mtimeMs, c.source.mtimeMs) || isActive(again.mtimeMs, now())) {
        skip("active");
        continue;
      }
      // Ours (sha checked when it became a candidate) and aged past now - 20 days while unmerged: re-clamped (utimes
      // only), so it never drifts into Claude Code's cleanup zone while it waits.
      const revSt = await statSafe(c.revisionFile).catch(() => null);
      let revMtime = revSt?.mtimeMs ?? now();
      if (revSt !== null && revSt.mtimeMs < now() - WRITTEN_MAX_AGE_MS) {
        revMtime = writtenMtime(c.source.mtimeMs, now());
        await utimes(c.revisionFile, revMtime / 1000, revMtime / 1000);
      }
      // Journaled again in this run, before the import (as publishRevision does): the run that swaps the revision in
      // owns it, so a rollback of the earlier run keeps it ("rewritten") and a rollback of this one undoes the merge.
      await deps.journal.append({ t: "file-written", runId: await runId(), path: c.revisionFile, sha256: sha, mtimeMs: revMtime, revisionOf: { harness: "claude", nativeId: c.nativeId } });
      journalNow = null;
    } else {
      let prep: PreparedRevision;
      try {
        prep = await prepareRevision(c.sourcePath, c.branch, {
          nativeId: c.nativeId, revisionUuid: c.revisionUuid, at: new Date(c.source.mtimeMs),
          cwd: c.branch.chain.find((n) => n.cwd !== null)?.cwd ?? c.item.session.cwd,
        });
      } catch {
        skip("copy-failed");
        continue;
      }
      // Written to while we read it: the session is in use again; nothing was journaled yet.
      const again = await statSafe(c.sourcePath).catch(() => null);
      if (again === null || again.size !== c.source.size || !near(again.mtimeMs, c.source.mtimeMs)) {
        await rm(prep.tmp, { force: true });
        skip("active");
        continue;
      }
      const rid = await runId();
      const harness: HarnessId = "claude";
      const revMtime = writtenMtime(c.source.mtimeMs, now()); // never inside Claude Code's cleanup zone (materialize.ts)
      const pub = await publishRevision({
        tmp: prep.tmp, target: c.revisionFile, sha256: prep.sha256, mtimeMs: revMtime, journal: deps.journal, runId: rid,
        entry: { revisionOf: { harness, nativeId: c.nativeId } }, linkFs: deps.linkFs,
      });
      if (pub !== "published") { skip(pub); continue; }
      sha = prep.sha256;
      firstLineBytes = prep.firstLineBytes;
    }

    // ---------- import through the waves ----------
    const rid = await runId();
    const st = await statSafe(c.revisionFile);
    if (st === null) { skip("copy-failed"); continue; }
    const item: PlanItem = {
      session: {
        ...c.item.session, nativeId: c.revisionUuid, file: st, flags: [], cwdOffsetBytes: firstLineBytes,
        updatedAt: c.lastActivity ?? new Date(c.source.mtimeMs).toISOString(),
      },
      action: { kind: "import", projectRoot: c.projectRoot, instanceId: c.instanceId, expectedThreadId: c.newThreadId },
      notes: [],
    };
    providers ??= await deps.api.providerInstances();
    const outcome = await importRevision(item, {
      api: deps.api, journal: deps.journal, runId: rid, now, platform, projectId: c.projectId, projectRoot: c.projectRoot, providers,
      exposureItems: deps.exposureItems ?? candidates.map((x) => x.item), accountHomes: deps.accountHomes, batch: deps.batch,
      aborted: deps.aborted, onPendingFiles: deps.onPendingFiles,
    });
    threadIdsNow = null;

    if (outcome === "imported") {
      // Confirmed in the thread list by the importer; swapThreads reads it once more before touching the old thread.
      const swapped = await swapThreads({ api: deps.api, journal: deps.journal, runId: rid, oldThreadId: c.oldThreadId, newThreadId: c.newThreadId });
      if (swapped !== "swapped") { skip(swapped === "cancelled" ? "archive-failed" : swapped); continue; }
      await appendOrStop(deps.journal, {
        t: "merged", runId: rid, harness: "claude", nativeId: c.nativeId, revisionUuid: c.revisionUuid, revisionFile: c.revisionFile,
        oldThreadId: c.oldThreadId, newThreadId: c.newThreadId, sourceSize: c.source.size, sourceMtimeMs: c.source.mtimeMs,
      }, `the archive of ${c.oldThreadId}`);
      journalNow = null;
      res.merged.push({
        nativeId: c.nativeId, revisionUuid: c.revisionUuid, revisionFile: c.revisionFile, newThreadId: c.newThreadId, oldThreadId: c.oldThreadId,
        oldTitle: c.oldTitle, addedMessages: c.addedMessages, divergedLeaves: c.divergedLeaves, projectRoot: c.projectRoot,
      });
      deps.onProgress?.(`Merged ${c.nativeId} -> ${c.newThreadId}`);
      continue;
    }
    if (outcome === "import-unverified") { skip("import-unverified"); continue; } // T3 may have it: keep the file
    await removeIfOurs(c.revisionFile, sha);
    skip(outcome);
  }
  return res;
}
