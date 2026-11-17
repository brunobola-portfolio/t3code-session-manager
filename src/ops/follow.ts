// Rehome copies follow their original (spec §5.1.4). A conversation run from a folder T3 Code refuses (the home folder)
// is in T3 as a faithful copy inside a project folder (copyTranscript.faithfulCopy: only cwd / sessionId swapped,
// journaled `file-written` with `rehomeOf`). When the user keeps working on the ORIGINAL (VS Code, from the home
// folder), sync brings the new messages into T3: `followRehomed` runs after every apply, inside the cycle's run and
// lock, whatever `sync.autoMerge` says, and only for rehome copies (orphan copies of T3-native sessions included).
//
// The copy that follows an original is its newest write that still stands: the first copy, or a revision a standing
// `merged` entry uses (a rolled-back run counts for nothing; a revision never swapped in is "unfinished"). Rules:
//   - a candidate is a copy whose original grew past the journaled `rehomeOf.size`. The original deleted, not grown,
//     the copy gone, or the copy's thread archived by the user (or never imported): nothing, no error;
//   - the copy itself changed since t3sm wrote it (its sha256 is not the journaled one: continued in T3 Code, or in a
//     terminal): a CONFLICT. Nothing is written or sent; it is listed with both titles;
//   - either file written in the last 10 minutes (ACTIVE_WINDOW_MS): deferred, so a conversation in use is never
//     copied half-way, and one growth gives one revision (its id is the original's size: revisionUuid);
//   - an original whose branch crosses a compaction is refused (`compacted`, as merge refuses it);
//   - the state a rollback undid (same original, same size) is not followed again; a later growth is;
//   - T3 Code unreachable: deferred, retried next cycle. At most FOLLOWS_PER_CYCLE per cycle (the rest: deferred).
//
// Modes (FOLLOW_MODE in src/t3/compat.ts, decided by the live spike S7):
//   - "revision" (spike S5: T3 only continues a thread from records it wrote): the faithful copy of the grown original
//     is written as a NEW file `<copy folder>/<revisionUuid(first copy id, original size)>.jsonl` with merge's revision
//     write (journaled before it is published, never over a file t3sm did not write), imported through merge's import
//     step (runWaves), then merge's archive step: the new thread gets the old thread's title and settled state
//     (journaled as `organize-change`, so later organize runs and the history rule treat them as t3sm's), and only then
//     is the old thread archived. Journaled like a merge (`thread-archived`, `merged`) plus `followed`, so one
//     `t3sm rollback <run>` removes the revision, brings the old thread back and archives the new one. T3 has no thread
//     pin call: only the title and the settled state are carried.
//   - "refresh" (if S7 shows T3 growing the same thread): the copy is rewritten in place (same id) by materialize's
//     refresh path (rename-over only after re-checking it is still t3sm's untouched write) and imported again into the
//     same thread. Journaled `file-written`, `imported`, `followed` (newThread null). A rollback keeps the refreshed
//     copy: T3's thread already holds its records.
// The original is only ever read.

import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AccountConfig, Config, DiscoveredSession, JournalEntry, PlanItem, SourceFile } from "../core/types.ts";
import type { Journal } from "../core/journal.ts";
import { effectiveWrites } from "../core/journal.ts";
import { revisionUuid } from "../core/uuid.ts";
import { atomicWrite, sha256File, statSafe, sweepWriteTemps, writeTempPath, type LinkFs } from "../core/fsutil.ts";
import { pathKey } from "../core/paths.ts";
import { isActive } from "../core/activity.ts";
import { FOLLOW_MODE } from "../t3/compat.ts";
import type { T3Api, T3Project, T3Thread } from "../t3/api.ts";
import { RpcClosed, RpcTimeout, T3HttpError, T3NotRunning } from "../t3/errors.ts";
import { readFaithfulCopy } from "../apply/copyTranscript.ts";
import { WRITTEN_MAX_AGE_MS, materializeConversions, writtenMtime } from "../apply/materialize.ts";
import type { BumpFile } from "../apply/importer.ts";
import { scanJsonl } from "../sources/jsonl.ts";
import { proposeTitle } from "../organize/titles.ts";
import { failureText } from "../organize/apply.ts";
import { JournalWriteError } from "./quarantine.ts";
import { IMPORT_THREAD, standingMerges } from "./merge.ts";
import { readBranch } from "./mergeBranch.ts";
import { appendOrStop, importRevision, publishRevision, removeIfOurs, swapThreads, type RevisionImportOutcome } from "./revision.ts";

/** sync follows at most this many rehome copies per cycle (each one is a wave of its own). */
export const FOLLOWS_PER_CYCLE = 10;

export interface FollowCtx {
  api: T3Api;
  journal: Journal;
  /** Journal run id, or a function called once right before the first write (it journals the run-start). */
  runId: string | (() => Promise<string>);
  now?: () => number;
  platform?: NodeJS.Platform;
  /** Default FOLLOW_MODE (src/t3/compat.ts); tests inject the other one. */
  mode?: "refresh" | "revision";
  /** At most this many follows (default FOLLOWS_PER_CYCLE; the rest are deferred). */
  limit?: number;
  /** Config account id -> absolute home: refresh mode writes only inside one of them; the waves list instance homes. */
  accountHomes?: Record<string, string>;
  /** Every discovered session T3 could import while a revision imports (exposure); default none. */
  exposureItems?: PlanItem[];
  batch?: Config["batch"];
  aborted?: () => boolean;
  onPendingFiles?: (files: BumpFile[] | null) => void;
  /** Test hook for publishing a revision (link + unlink). */
  linkFs?: LinkFs;
  /**
   * State dir: refusals that last until the original changes (`compacted`) are remembered in
   * <stateDir>/cache/follow.json, reported once per state of the original and not read again. Absent: no cache.
   */
  stateDir?: string;
}

/** Refusals per original state (`<path key>|<size>|<mtimeMs>` -> reason): reported once, never re-read. */
interface FollowCache { version: 1; refused: Record<string, string> }
const cachePath = (stateDir: string): string => path.join(stateDir, "cache", "follow.json");

async function readFollowCache(stateDir: string | undefined): Promise<FollowCache> {
  if (!stateDir) return { version: 1, refused: {} };
  try {
    const u = JSON.parse(await readFile(cachePath(stateDir), "utf8")) as FollowCache;
    if (u && u.version === 1 && typeof u.refused === "object" && u.refused !== null) return u;
  } catch { /* missing or unreadable: start over */ }
  return { version: 1, refused: {} };
}

async function writeFollowCache(stateDir: string | undefined, c: FollowCache): Promise<void> {
  if (!stateDir) return;
  try {
    await mkdir(path.dirname(cachePath(stateDir)), { recursive: true });
    await atomicWrite(cachePath(stateDir), JSON.stringify(c) + "\n");
  } catch { /* a cache is never worth failing a follow */ }
}

export interface FollowOutcome {
  /** Copies brought up to date with their original (a carry failure is in `failed` as well). */
  followed: number;
  /** Copy continued since t3sm wrote it AND original grown: nothing done. Titles: the original's, the copy's thread's. */
  conflicts: { original: string; copy: string; originalTitle: string; copyTitle: string }[];
  /** In use, T3 Code unreachable, over the per-cycle limit, ...: retried next cycle. */
  deferred: number;
  /** `copy`: the copy (or the revision) concerned. reason: compacted, import-failed, archive-failed, carry-failed: <kind>, ... */
  failed: { copy: string; reason: string }[];
}

type Written = Extract<JournalEntry, { t: "file-written" }>;
type Copied = NonNullable<Written["rehomeOf"]>;

/** The copies of one original, from the journal. */
interface Lineage {
  /** The first copy (its id names every revision), or null when it was rolled back. */
  root: Written | null;
  /** The copy that follows the original now (the newest standing write), or null. */
  current: Written | null;
  /** Revisions written but never swapped in (import unverified, interrupted): reused or removed. */
  unfinished: Written[];
  /** Sizes of the original a rolled-back run copied: those states are not followed again. */
  rolledBackSizes: Set<number>;
}

const isStr = (u: unknown): u is string => typeof u === "string" && u !== "";
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const validCopied = (r: unknown): r is Copied => {
  const o = r as Partial<Copied> | null;
  return !!o && isStr(o.path) && isStr(o.nativeId) && typeof o.cwd === "string" && typeof o.size === "number" && typeof o.mtimeMs === "number";
};

/** T3 Code could not be reached (closed, connection lost, no answer): the follow waits for the next cycle. */
function unreachable(e: unknown): boolean {
  return e instanceof T3NotRunning || e instanceof RpcClosed || e instanceof RpcTimeout || (e instanceof T3HttpError && e.status === null);
}

/** The first record of a transcript that carries cwd: its cwd and the bytes read up to and including it; null: none. */
async function firstCwd(file: string): Promise<{ cwd: string; offset: number } | null> {
  let found: { cwd: string; offset: number } | null = null;
  await scanJsonl(file, {}, (o, info) => {
    if (typeof o.cwd === "string" && o.cwd !== "") { found = { cwd: o.cwd, offset: info.offset }; return "stop"; }
  });
  return found;
}

const DEFERRED: ReadonlySet<RevisionImportOutcome> = new Set(["import-unverified", "project-in-use", "clock-jump", "file-busy", "active", "aborted"]);

export async function followRehomed(ctx: FollowCtx): Promise<FollowOutcome> {
  const now = ctx.now ?? Date.now;
  const platform = ctx.platform ?? process.platform;
  const mode = ctx.mode ?? FOLLOW_MODE;
  const limit = ctx.limit ?? FOLLOWS_PER_CYCLE;
  const key = (p: string): string => pathKey(p, platform);
  const out: FollowOutcome = { followed: 0, conflicts: [], deferred: 0, failed: [] };
  const api = ctx.api;
  const j = ctx.journal;
  let started: Promise<string> | null = null;
  const runId = (): Promise<string> => (started ??= typeof ctx.runId === "string" ? Promise.resolve(ctx.runId) : ctx.runId());

  // ---------- the copies of every original, from the journal ----------
  const entries = await j.readAll();
  const rolledBack = new Set(entries.flatMap((e) => (e.t === "rolled-back" ? [e.targetRunId] : [])));
  const mergedFiles = new Set(standingMerges(entries).map((m) => key(m.revisionFile)));
  const anyMergedFiles = new Set(entries.flatMap((e) => (e.t === "merged" && isStr(e.revisionFile) ? [key(e.revisionFile)] : [])));
  const failedRevs = new Set(entries.flatMap((e) => (e.t === "import-failed" ? [e.nativeId] : [])));
  const ours = new Map<string, string>();
  const lineages = new Map<string, Lineage>();
  for (const w of effectiveWrites(entries, key)) {
    ours.set(key(w.path), w.sha256);
    if (!validCopied(w.rehomeOf)) continue;
    const k = `${key(w.rehomeOf.path)}|${w.rehomeOf.nativeId}`;
    const l = lineages.get(k) ?? lineages.set(k, { root: null, current: null, unfinished: [], rolledBackSizes: new Set() }).get(k)!;
    // A rolled-back write counts for nothing, unless the rollback kept it (in use, T3 Code unreachable, a refreshed
    // copy): still on disk exactly as written, it is still the copy whose thread T3 shows.
    const kept = rolledBack.has(w.runId) && (await sha256File(w.path).catch(() => null)) === w.sha256;
    if (rolledBack.has(w.runId) && !kept) { l.rolledBackSizes.add(w.rehomeOf.size); continue; }
    if (w.revisionOf && !(kept ? anyMergedFiles : mergedFiles).has(key(w.path))) { l.unfinished.push(w); continue; }
    if (!w.revisionOf && l.root === null) l.root = w;
    l.current = w;
  }

  // T3, read once and only when needed.
  let threads: T3Thread[] | null = null;
  let projects: T3Project[] | null = null;
  let providers: Awaited<ReturnType<T3Api["providerInstances"]>> | null = null;
  const getThreads = async (): Promise<T3Thread[]> => (threads ??= await api.listThreads());
  const getProjects = async (): Promise<T3Project[]> => (projects ??= await api.listProjects());
  const threadOf = (list: T3Thread[], nativeId: string): T3Thread | undefined => {
    const own = list.filter((t) => IMPORT_THREAD.exec(t.id)?.[2] === nativeId);
    return own.find((t) => !t.archived) ?? own[0];
  };

  // ---------- candidates (files only: no T3 needed) ----------
  interface Candidate { l: Lineage; c: Written; r: Copied; orig: SourceFile }
  const candidates: Candidate[] = [];
  for (const l of lineages.values()) {
    const c = l.current;
    if (c === null) continue;
    const r = c.rehomeOf!;
    const orig = await statSafe(r.path).catch(() => null);
    if (orig === null || orig.size <= r.size) continue; // deleted, or not grown
    if (l.rolledBackSizes.has(orig.size)) continue; // the user rolled this very state back
    const copySt = await statSafe(c.path).catch(() => null);
    if (copySt === null) continue; // the copy is gone: nothing to follow
    const have = await sha256File(c.path).catch(() => null);
    if (have !== c.sha256) {
      // The copy's thread archived by the user, or gone from T3 Code: they decided (archiving it is what the conflict
      // advice offers), exactly as for a copy that did not change. T3 Code unreadable: still listed.
      let copyTitle: string | null = null;
      try {
        const t = threadOf(await getThreads(), path.basename(c.path, ".jsonl"));
        if (t === undefined || t.archived) continue;
        copyTitle = t.title;
      } catch { /* T3 closed: the file's title */ }
      out.conflicts.push({
        original: r.path, copy: c.path,
        originalTitle: (await proposeTitle(r.path, { maxLength: 120 })) ?? "",
        copyTitle: copyTitle ?? (await proposeTitle(c.path, { maxLength: 120 })) ?? "",
      });
      continue;
    }
    if (isActive(orig.mtimeMs, now()) || isActive(copySt.mtimeMs, now())) { out.deferred++; continue; }
    candidates.push({ l, c, r, orig });
  }
  candidates.sort((a, b) => a.orig.mtimeMs - b.orig.mtimeMs || (a.r.path < b.r.path ? -1 : a.r.path > b.r.path ? 1 : 0));

  /** Journals a change T3 already holds; a failure stops everything (the journal must hear of every T3 change). */
  const record = (e: JournalEntry, what: string): Promise<void> => appendOrStop(j, e, what);
  /** The copy is still exactly t3sm's write and idle (checked again right before the import). */
  const copyStill = async (c: Written): Promise<"ok" | "changed" | "active"> => {
    const st = await statSafe(c.path).catch(() => null);
    if (st === null || (await sha256File(c.path).catch(() => null)) !== c.sha256) return "changed";
    return isActive(st.mtimeMs, now()) ? "active" : "ok";
  };
  const swept = new Set<string>();

  // ---------- revision mode ----------
  const followRevision = async (k: Candidate, old: T3Thread): Promise<void> => {
    const { l, c, r, orig } = k;
    const fail = (reason: string, copy = c.path): void => void out.failed.push({ copy, reason });
    const project = (await getProjects()).find((p) => p.id === old.projectId);
    if (!project) { fail("project-missing"); return; }
    const instanceId = IMPORT_THREAD.exec(old.id)![1]!;
    const oldNativeId = path.basename(c.path, ".jsonl");
    let rev = revisionUuid(path.basename((l.root ?? c).path, ".jsonl"), orig.size);
    const dir = path.dirname(c.path);
    let revFile = path.join(dir, `${rev}.jsonl`);
    let newThreadId = `import:${instanceId}:${rev}`;
    /** The state of the original the revision holds (the one this follow swaps in). */
    let target = { size: orig.size, mtimeMs: orig.mtimeMs };
    const first = await firstCwd(c.path).catch(() => null);
    if (first === null) { fail("copy-unreadable"); return; }

    // Earlier revisions of this original never swapped in (newest write of each path). T3 holds no thread for one: it is
    // removed while still exactly what t3sm wrote and idle. Its thread archived (the swap was cancelled and the thread
    // archived back): left as it is, an archived thread keeps its transcript, and the follow goes on to the new size.
    // Its thread active (the archive failed, or the import was not verified then): that swap is finished first, here,
    // and the next cycle follows the revision in turn; an older one, or two of them, block the follow (a person decides).
    const inT3 = new Map<string, T3Thread>();
    for (const t of await getThreads()) {
      for (const id of [IMPORT_THREAD.exec(t.id)?.[2], t.nativeSessionId]) {
        if (!id) continue;
        const had = inT3.get(id);
        if (had === undefined || (had.archived && !t.archived)) inT3.set(id, t);
      }
    }
    const unfinished = new Map<string, Written>();
    for (const u of l.unfinished) unfinished.set(key(u.path), u);
    let pending: { u: Written; thread: T3Thread } | null = null;
    for (const u of unfinished.values()) {
      if (key(u.path) === key(revFile)) continue;
      const ust = await statSafe(u.path).catch(() => null);
      if (ust === null) continue;
      const t = inT3.get(path.basename(u.path, ".jsonl"));
      if (t === undefined) {
        if (!isActive(ust.mtimeMs, now())) await removeIfOurs(u.path, u.sha256);
        continue;
      }
      if (t.archived) continue;
      const newer = validCopied(u.rehomeOf) && u.rehomeOf.size > r.size && IMPORT_THREAD.test(t.id);
      if (!newer || pending !== null) { fail("revision-pending", (pending?.u ?? u).path); return; }
      pending = { u, thread: t };
    }
    if (pending !== null) {
      revFile = pending.u.path;
      rev = path.basename(revFile, ".jsonl");
      newThreadId = pending.thread.id;
      target = { size: pending.u.rehomeOf!.size, mtimeMs: pending.u.rehomeOf!.mtimeMs };
    }
    if (failedRevs.has(rev)) { fail("import-failed"); return; } // never retried every cycle; the next growth is

    let sha: string;
    let cwdOffsetBytes: number;
    let activity: { updatedAt: string; messageCount: number };
    /** Reused: the revision an earlier cycle wrote, journaled again in this run right before its import. */
    let reused: Written | null = null;
    const existing = await statSafe(revFile).catch(() => null);
    if (existing !== null) {
      // Written by an earlier cycle that stopped before the swap: reused while it is still exactly t3sm's write.
      const mine = ours.get(key(revFile));
      if (mine === undefined) { fail("target-exists", revFile); return; }
      if ((await sha256File(revFile).catch(() => null)) !== mine) { fail("revision-in-use", revFile); return; }
      sha = mine;
      const w = unfinished.get(key(revFile));
      activity = w?.source ? { updatedAt: w.source.updatedAt, messageCount: w.source.messageCount } : { updatedAt: new Date(existing.mtimeMs).toISOString(), messageCount: 0 };
      const fc = await firstCwd(revFile).catch(() => null);
      if (fc === null) { fail("copy-unreadable", revFile); return; }
      cwdOffsetBytes = fc.offset;
      reused = {
        t: "file-written", runId: "", path: revFile, sha256: sha, mtimeMs: existing.mtimeMs,
        revisionOf: w?.revisionOf ?? { harness: "claude", nativeId: oldNativeId },
        source: w?.source ?? { harness: "claude", nativeId: r.nativeId, updatedAt: activity.updatedAt, messageCount: activity.messageCount },
        rehomeOf: w?.rehomeOf ?? { path: r.path, nativeId: r.nativeId, cwd: r.cwd, size: target.size, mtimeMs: target.mtimeMs },
      };
    } else {
      const copy = await readFaithfulCopy({ path: r.path, nativeId: r.nativeId }, { cwd: first.cwd, sessionId: rev, fromCwd: r.cwd }, now());
      // In use, or grown again since the stat (the revision id is the size): next cycle, never two revisions.
      if ("defer" in copy || copy.rehomeOf.size !== orig.size) { out.deferred++; return; }
      if (!swept.has(key(dir))) { swept.add(key(dir)); await sweepWriteTemps(dir); }
      const tmp = writeTempPath(dir, rev); // not *.jsonl: no scanner takes it
      sha = createHash("sha256").update(copy.text, "utf8").digest("hex");
      try {
        await writeFile(tmp, copy.text, { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => {});
        fail(`write-failed: ${failureText(msg(e))}`);
        return;
      }
      const pub = await publishRevision({
        tmp, target: revFile, sha256: sha, mtimeMs: writtenMtime(Date.parse(copy.activity.updatedAt), now()), journal: j, runId: await runId(),
        entry: {
          revisionOf: { harness: "claude", nativeId: oldNativeId },
          source: { harness: "claude", nativeId: r.nativeId, updatedAt: copy.activity.updatedAt, messageCount: copy.activity.messageCount },
          rehomeOf: copy.rehomeOf,
        },
        linkFs: ctx.linkFs,
      });
      if (pub !== "published") { fail(pub, revFile); return; }
      ours.set(key(revFile), sha);
      activity = copy.activity;
      cwdOffsetBytes = copy.cwdOffsetBytes;
    }

    // The copy, again, right before anything reaches T3: continued meanwhile -> conflict; in use -> next cycle.
    const still = await copyStill(c);
    if (still !== "ok") {
      if (!inT3.has(rev)) await removeIfOurs(revFile, sha); // a revision T3 holds a thread of keeps its transcript
      if (still === "active") out.deferred++;
      else out.conflicts.push({ original: r.path, copy: c.path, originalTitle: (await proposeTitle(r.path, { maxLength: 120 })) ?? "", copyTitle: old.title });
      return;
    }

    const rid = await runId();
    if (reused !== null) {
      // Journaled again in this run, before the import, as publishRevision does: the run that swaps the revision in owns
      // it, so a rollback of the earlier run keeps it ("rewritten") and a rollback of this one undoes the swap. Ours and
      // aged past now - 20 days while it waited: re-clamped (utimes only), never into Claude Code's cleanup zone.
      let mtimeMs = reused.mtimeMs ?? now();
      if (mtimeMs < now() - WRITTEN_MAX_AGE_MS) {
        mtimeMs = writtenMtime(Date.parse(activity.updatedAt), now());
        await utimes(revFile, mtimeMs / 1000, mtimeMs / 1000);
      }
      await j.append({ ...reused, runId: rid, mtimeMs });
    }
    const st = await statSafe(revFile);
    if (st === null) { fail("copy-failed", revFile); return; }
    const session: DiscoveredSession = {
      harness: "claude", accountId: null, nativeId: rev, cwd: first.cwd, startedAt: null, updatedAt: activity.updatedAt,
      messageCount: activity.messageCount, corruptLines: 0, file: st, flags: [], cwdOffsetBytes,
    };
    const item: PlanItem = { session, action: { kind: "import", projectRoot: project.workspaceRoot, instanceId, expectedThreadId: newThreadId }, notes: [] };
    providers ??= await api.providerInstances();
    const outcome = await importRevision(item, {
      api, journal: j, runId: rid, now, platform, projectId: project.id, projectRoot: project.workspaceRoot, providers,
      exposureItems: ctx.exposureItems ?? [], accountHomes: ctx.accountHomes, batch: ctx.batch, aborted: ctx.aborted, onPendingFiles: ctx.onPendingFiles,
    });
    threads = null; // the list moved on
    if (outcome !== "imported") {
      // Unverified: T3 may have it, kept for the next cycle; so is a revision T3 already holds a thread of.
      if (outcome !== "import-unverified" && !inT3.has(rev)) await removeIfOurs(revFile, sha);
      if (DEFERRED.has(outcome)) out.deferred++;
      else fail(outcome, revFile);
      return;
    }

    // Carry the old thread's title and settled state to the new one, then archive the old one (merge's archive step).
    // The copy is checked once more first: typed into in T3 Code during the waves, archiving its thread would fork the
    // conversation, so the old thread stays and the new one is archived back.
    let meanwhile: "changed" | "active" | null = null;
    const beforeArchive = async (fresh: T3Thread): Promise<boolean> => {
      const now2 = await copyStill(c);
      if (now2 !== "ok") { meanwhile = now2; return false; }
      await carry(fresh);
      return true;
    };
    const carry = async (fresh: T3Thread): Promise<void> => {
      const changes: { kind: "title" | "unsettle" | "settle"; previous: unknown; next: unknown; write: () => Promise<void> }[] = [];
      if (old.title.trim() !== "" && fresh.title !== old.title) {
        changes.push({ kind: "title", previous: fresh.title, next: old.title, write: () => api.setThreadTitle(fresh.id, old.title) });
      }
      const want = old.settledOverride ?? null;
      const have = fresh.settledOverride ?? null;
      if ((want === "settled" || want === "active") && have !== "unknown" && have !== want) {
        // Journaled as the change it is (settle: -> "settled", unsettle: -> "active"), so undo and the planner read it.
        changes.push(want === "settled"
          ? { kind: "settle", previous: have, next: want, write: () => api.settleThread(fresh.id) }
          : { kind: "unsettle", previous: have, next: want, write: () => api.unsettleThread(fresh.id) });
      }
      for (const ch of changes) {
        try {
          await ch.write();
        } catch (e) {
          const error = failureText(msg(e));
          await record({ t: "organize-failed", runId: rid, kind: ch.kind, target: fresh.id, projectId: project.id, error }, `nothing (${ch.kind} failed)`);
          fail(`carry-failed: ${ch.kind}`, revFile);
          continue;
        }
        await record({ t: "organize-change", runId: rid, kind: ch.kind, target: fresh.id, previous: ch.previous, next: ch.next }, `${ch.kind} ${fresh.id}`);
      }
    };
    const swapped = await swapThreads({ api, journal: j, runId: rid, oldThreadId: old.id, newThreadId, beforeArchive });
    if (swapped === "cancelled") {
      // The old thread is left alone; the revision's thread goes back to the archive (its file is kept: an archived
      // thread keeps its transcript). Changed: a conflict. Only in use: the next cycle unarchives and retries.
      try {
        await api.archiveThread(newThreadId);
      } catch {
        fail("archive-failed: the copy changed during the import and the new thread could not be archived; two threads are active", revFile);
        return;
      }
      await record({ t: "thread-archived", runId: rid, threadId: newThreadId }, `the archive of ${newThreadId}`);
      if (meanwhile === "active") out.deferred++;
      else out.conflicts.push({ original: r.path, copy: c.path, originalTitle: (await proposeTitle(r.path, { maxLength: 120 })) ?? "", copyTitle: old.title });
      return;
    }
    if (swapped === "import-unverified") { out.deferred++; return; } // the new thread is not listed (yet): kept for reuse
    if (swapped === "archive-failed") { fail("archive-failed", revFile); return; } // next cycle reuses the revision and retries
    await record({
      t: "merged", runId: rid, harness: "claude", nativeId: oldNativeId, revisionUuid: rev, revisionFile: revFile,
      oldThreadId: old.id, newThreadId, sourceSize: target.size, sourceMtimeMs: target.mtimeMs,
    }, `the archive of ${old.id}`);
    await record({ t: "followed", runId: rid, original: r.path, copy: revFile, oldThread: old.id, newThread: newThreadId, mode: "revision" }, `the archive of ${old.id}`);
    out.followed++;
  };

  // ---------- refresh mode ----------
  const followRefresh = async (k: Candidate, old: T3Thread): Promise<void> => {
    const { c, r, orig } = k;
    const fail = (reason: string): void => void out.failed.push({ copy: c.path, reason });
    const project = (await getProjects()).find((p) => p.id === old.projectId);
    if (!project) { fail("project-missing"); return; }
    const first = await firstCwd(c.path).catch(() => null);
    if (first === null) { fail("copy-unreadable"); return; }
    const instanceId = IMPORT_THREAD.exec(old.id)![1]!;
    const accounts: AccountConfig[] = Object.entries(ctx.accountHomes ?? {}).map(([id, home]) => ({ id, home, displayName: id, accentColor: null }));
    const session: DiscoveredSession = {
      harness: "claude", accountId: null, nativeId: r.nativeId, cwd: r.cwd, startedAt: null, updatedAt: new Date(orig.mtimeMs).toISOString(),
      messageCount: 0, corruptLines: 0, file: orig, flags: [], cwdOffsetBytes: 0,
    };
    const item: PlanItem = {
      session,
      action: { kind: "convert-import", projectRoot: first.cwd, instanceId, expectedThreadId: old.id, uuid: path.basename(c.path, ".jsonl"), targetFile: c.path, copy: "faithful", rehomeFrom: r.cwd },
      notes: [],
    };
    // Nothing to write (in use, or the copy already holds this text): the run is not started for nothing.
    const pre = await readFaithfulCopy({ path: r.path, nativeId: r.nativeId }, { cwd: first.cwd, sessionId: path.basename(c.path, ".jsonl"), fromCwd: r.cwd }, now());
    if ("defer" in pre) { out.deferred++; return; }
    if (createHash("sha256").update(pre.text, "utf8").digest("hex") === c.sha256) return;
    const rid = await runId();
    // materialize's refresh path: rewritten in place only while the copy is still t3sm's untouched write and idle.
    const m = await materializeConversions([item], new Map(), accounts, j, rid, { platform, now });
    if (m.deferred.length > 0) { out.deferred++; return; }
    if (m.failed.length > 0) { fail(m.failed[0]!.reason); return; }
    if (m.resumed.length > 0) {
      out.conflicts.push({ original: r.path, copy: c.path, originalTitle: (await proposeTitle(r.path, { maxLength: 120 })) ?? "", copyTitle: old.title });
      return;
    }
    const ready = m.ready[0];
    if (m.written.length === 0 || ready === undefined) return; // identical already: nothing to bring
    // Imported again into the same thread. runWaves would take a thread that already exists as imported without
    // calling T3, so it is shown T3 without that thread until the import call has been made.
    let called = false;
    const wavesApi: T3Api = {
      ...api,
      listThreads: async () => (await api.listThreads()).filter((t) => called || t.id !== old.id),
      importSessions: async (projectId: string, root: string) => { called = true; return api.importSessions(projectId, root); },
    };
    providers ??= await api.providerInstances();
    let outcome: RevisionImportOutcome;
    try {
      outcome = await importRevision(ready, {
        api, wavesApi, journal: j, runId: rid, now, platform, projectId: project.id, projectRoot: project.workspaceRoot, providers,
        exposureItems: ctx.exposureItems ?? [], accountHomes: ctx.accountHomes, batch: ctx.batch, aborted: ctx.aborted, onPendingFiles: ctx.onPendingFiles,
      });
    } catch (e) {
      if (e instanceof JournalWriteError) throw e;
      // The copy is already rewritten: not a candidate any more, so this is a failure, not a retry.
      fail(`import-failed: ${failureText(msg(e))}`);
      return;
    }
    threads = null;
    if (outcome !== "imported") { fail(outcome); return; }
    await record({ t: "followed", runId: rid, original: r.path, copy: c.path, oldThread: old.id, newThread: null, mode: "refresh" }, `the import of ${old.id}`);
    out.followed++;
  };

  // ---------- follow, one at a time ----------
  // The limit counts real attempts only: a refused or skipped candidate never takes a slot (a compacted original stays
  // a candidate forever and must not starve the others). A refusal that lasts until the original changes is reported
  // once per state of the original (cache), and that state is not read again.
  const cache = await readFollowCache(ctx.stateDir);
  const refused: Record<string, string> = {};
  let attempts = 0;
  for (const k of candidates) {
    if (ctx.aborted?.()) { out.deferred++; continue; }
    const state = `${key(k.r.path)}|${k.orig.size}|${k.orig.mtimeMs}`;
    const known = cache.refused[state];
    if (known !== undefined) { refused[state] = known; continue; }
    try {
      const old = threadOf(await getThreads(), path.basename(k.c.path, ".jsonl"));
      if (!old || old.archived) continue; // never imported, or archived by the user: left alone
      let branch;
      try { branch = await readBranch(k.r.path); } catch { out.deferred++; continue; } // gone or busy while read
      if (branch.problem === "compacted" || branch.chain.some((n) => n.compact)) {
        refused[state] = "compacted";
        out.failed.push({ copy: k.c.path, reason: "compacted" });
        continue;
      }
      if (branch.problem === "unsettled") { out.deferred++; continue; } // a torn last line: being written
      // A revision of this very state whose import failed: never retried (the next growth is), and it never takes a
      // slot; reported once per state of the original, like a compacted one.
      if (mode === "revision" && failedRevs.has(revisionUuid(path.basename((k.l.root ?? k.c).path, ".jsonl"), k.orig.size))) {
        refused[state] = "import-failed";
        out.failed.push({ copy: k.c.path, reason: "import-failed" });
        continue;
      }
      if (attempts >= limit) { out.deferred++; continue; }
      attempts++;
      await (mode === "refresh" ? followRefresh(k, old) : followRevision(k, old));
    } catch (e) {
      if (e instanceof JournalWriteError) throw e;
      threads = null;
      if (unreachable(e)) out.deferred++;
      else out.failed.push({ copy: k.c.path, reason: `failed: ${failureText(msg(e))}` });
    }
  }
  // Only the states still current are kept (an original that changed is judged again).
  if (JSON.stringify(refused) !== JSON.stringify(cache.refused)) await writeFollowCache(ctx.stateDir, { version: 1, refused });
  return out;
}
