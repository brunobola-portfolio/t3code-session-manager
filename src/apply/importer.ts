// The importer loop: bump -> scan -> import -> restore -> verify, one wave at a time (docs/spikes/S2-import.md §5).
//
// Crash safety: every mtime change (bump or park) is journaled with the file's original atime/mtime BEFORE the first
// utimes, and restored in `finally`. A restore that fails leaves the bump pending in the journal; the next writing
// command's recoverPendingMtimes puts it back. A file written while its wave ran is never moved backwards.
//
// A file that is in use (mtime within ACTIVE_WINDOW_MS), gone, or different from the plan (size or mtime) is never
// bumped this run. T3 imports EVERY in-window transcript of a project, from every instance (S2 §3), so per wave root:
// an exposed transcript in use holds the whole root for the rest of the run; every other exposed one is PARKED.
//
// Parking is always in the FUTURE (now + 7 days + i ms): T3 skips transcripts with a future mtime (S2 §3), and a
// transcript is never given a past mtime, because Claude Code deletes transcripts older than cleanupPeriodDays
// (default 30) by mtime: a file parked in the past and left there by a crash could be deleted. Bumped files sit at
// (now - 2 s) + i ms, i.e. at most a few seconds before now.
//
// Clock jumps: T3 judges eligibility with ITS clock at import time. A machine that sleeps between the bump and an
// import call wakes with parked files closer to "now" (a week covers any single call). The guard starts at the wave's
// FIRST clock reading (before the exposure scan): a bump time outside [start - 2 s, start + CLOCK_JUMP_MS] defers the
// whole wave `clock-jump` before any utimes (what the scan judged "in the future" may be inside the window by then).
// After the bump the clock is checked before the scan and before every import call: more than CLOCK_JUMP_MS past the
// start, or more than 2 s earlier than the last reading, stops the wave there (restore as usual); its projects not yet
// imported are deferred `clock-jump`, and the next wave (or run) starts afresh with a new start.
//
// The caller MUST hold the state-dir lock and have run recoverPendingMtimes.

import { statSync, utimesSync } from "node:fs";
import { stat, utimes } from "node:fs/promises";
import type { Config, HarnessId, PlanItem, SourceFile } from "../core/types.ts";
import type { Journal } from "../core/journal.ts";
import { near } from "../core/journal.ts";
import { statSafe } from "../core/fsutil.ts";
import { pathKey as pathKeyOf } from "../core/paths.ts";
import { ACTIVE_WINDOW_MS, CWD_SCAN_MAX_BYTES } from "../sources/types.ts";
import { inImportWindow, isActive } from "../core/activity.ts";
import { DEFAULT_BATCH } from "../core/config.ts";
import type { T3Api } from "../t3/api.ts";
import { RpcError } from "../t3/errors.ts";
import { WAVE_COST_CAP, buildWaves, bumpTargets, byOriginalMtime, itemRoot, rootKey, waveItems, type Wave } from "./waves.ts";

export { IMPORT_WINDOW_MS } from "../core/activity.ts";
/** Parked files sit this far in the future during their project's wave (T3 skips future mtimes). */
export const PARK_AHEAD_MS = 7 * 86_400_000;
/** A clock reading this far past a wave's bump time (a suspend, or the clock was set) stops that wave. */
export const CLOCK_JUMP_MS = 30 * 60_000;
/** A clock reading may be this much earlier than the previous one (time sync nudges) without stopping the wave. */
export const CLOCK_BACK_TOLERANCE_MS = 2_000;

/** A reading `t` is sane when it is not more than the tolerance before `last`, nor CLOCK_JUMP_MS past the wave's start. */
function clockWithin(t: number, last: number, start: number): boolean {
  return t >= last - CLOCK_BACK_TOLERANCE_MS && t <= start + CLOCK_JUMP_MS;
}
/** An item missing after its wave is tried once more in a later wave, then reported. */
const MAX_ATTEMPTS = 2;
const PROJECT_MISMATCH_TAGS = new Set(["AgentSessionImportProjectChangedError", "AgentSessionImportProjectNotFoundError"]);

export type FailReason = "cwd-unreadable-in-t3" | "instance-unavailable" | "project-mismatch" | "not-imported";
/**
 * project-in-use: another transcript of the project is being written, so T3 would import it now; the root waits.
 * clock-jump: the system clock jumped (suspend, time change) during the wave before its project was imported.
 * file-busy: a transcript of the project stayed locked (EBUSY / EPERM / EACCES) through the retries; the root waits.
 */
export type DeferReason = "active" | "changed" | "missing" | "project-in-use" | "clock-jump" | "file-busy";

/** Error codes of a file another program holds open (antivirus, sync client, an editor) on Windows. */
const BUSY_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
export const isBusy = (e: unknown): boolean => BUSY_CODES.has((e as NodeJS.ErrnoException)?.code ?? "");
/** Waits between tries of a busy file: tried once, then again after 100, 300 and 1000 ms. */
export const BUSY_RETRY_MS = [100, 300, 1000];

/** `fn`, retried while it fails with a busy-file error; the last error is thrown. */
export async function retryBusy<T>(fn: () => Promise<T>, delays: readonly number[] = BUSY_RETRY_MS): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isBusy(e) || i >= delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

/**
 * A discovered transcript T3 could import into the project of its cwd (agentSessions.import takes EVERY in-window
 * transcript of a root, from every instance; S2 §3): plan items of any action, mirror and backup copies, excluded ones.
 * `threadIds` / `refs` (`<instanceId>:<nativeId>`) say how T3 would represent it; one present = already in T3.
 */
export interface ExposedTranscript {
  path: string; cwd: string; threadIds: string[]; refs: string[];
  /** Identity for a follow-up import-attempt when the file changed under us and could not be parked. */
  harness?: HarnessId; nativeId?: string;
  /** Bytes T3's metadata pass reads to find its cwd (discovery's cwdOffsetBytes); unknown: min(size, 1 MiB). */
  cost?: number;
}

interface Identity { harness: HarnessId; nativeId: string; threadId: string }
interface Candidate { path: string; keys: Set<string>; threadIds: string[]; refs: string[]; id: Identity | null; cost: number | null; harness: HarnessId | null }
/** A transcript parked for a wave: fresh stat, identity, and what it costs T3's metadata pass of its source. */
export interface Parked { st: SourceFile; id: Identity | null; cost: number; source: MetadataSource }
/** T3 budgets metadata per source (S2 §4): converted OpenCode sessions are Claude transcripts. */
export type MetadataSource = "claude" | "codex" | "pi";
export function sourceOf(h: HarnessId | null | undefined): MetadataSource {
  return h === "codex" || h === "pi" ? h : "claude";
}
/** The metadata source of an item's file: a convert-import's file is a Claude transcript, whatever its harness. */
function itemSource(it: PlanItem): HarnessId {
  return it.action.kind === "convert-import" ? "claude" : it.session.harness;
}
/** What T3 reads of a file to find its cwd: never more than the file, never more than 1 MiB (S2 §4). */
function metadataCost(cost: number | null, size: number): number {
  return Math.max(0, Math.min(cost ?? size, size, CWD_SCAN_MAX_BYTES));
}

export interface ExposureIndex {
  /**
   * The exposed transcripts of a root right now: inside the window, not already in T3, not in `exclude` (path keys
   * of the wave's own items). The clock is read right after each stat. inUse: one of them has an mtime within
   * ACTIVE_WINDOW_MS of that clock, either side (a session written during the scan gets an mtime slightly AHEAD of
   * an earlier clock reading; T3 would import it now): the caller holds the root. Only an mtime more than
   * ACTIVE_WINDOW_MS in the future counts as parked (a crash leftover at now + 7 days, which T3 skips) and is
   * ignored. park: the rest, with fresh stats.
   */
  scan(k: string, root: string, clock: () => number, exclude: ReadonlySet<string>, wave: number): Promise<{ inUse: boolean; busy?: boolean; park: Parked[] }>;
  pathKey(p: string): string;
}

/** Static exposure (plan items of any action + `entries`) plus the optional wave-time listing `live` (new files). */
export function exposureIndex(o: {
  entries: ExposedTranscript[]; items: PlanItem[]; platform: NodeJS.Platform;
  inT3: (threadIds: string[], refs: string[]) => boolean;
  live?: (root: string, wave: number) => Promise<ExposedTranscript[]>;
  /** Waits between tries of a busy file (default BUSY_RETRY_MS). */
  busyRetryMs?: readonly number[];
}): ExposureIndex {
  const key = (r: string): string => rootKey(r, o.platform);
  const pathKey = (p: string): string => pathKeyOf(p, o.platform);
  const byPath = new Map<string, Candidate>();
  const add = (path: string, k: string, threadIds: string[], refs: string[], id: Identity | null, cost: number | null, harness: HarnessId | null): void => {
    const pk = pathKey(path);
    const c = byPath.get(pk) ?? { path, keys: new Set<string>(), threadIds: [], refs: [], id: null, cost: null, harness: null };
    c.keys.add(k);
    c.threadIds.push(...threadIds);
    c.refs.push(...refs);
    c.id ??= id;
    c.cost ??= cost;
    c.harness ??= harness;
    byPath.set(pk, c);
  };
  const idOf = (x: ExposedTranscript): Identity | null =>
    x.harness && x.nativeId && x.threadIds[0] ? { harness: x.harness, nativeId: x.nativeId, threadId: x.threadIds[0] } : null;
  for (const x of o.entries) add(x.path, key(x.cwd), x.threadIds, x.refs, idOf(x), x.cost ?? null, x.harness ?? null);
  for (const it of o.items) {
    if (it.action.kind === "skip") continue;
    const s = it.session;
    const id = { harness: s.harness, nativeId: s.nativeId, threadId: it.action.expectedThreadId };
    add(s.file.path, key(it.action.projectRoot), [it.action.expectedThreadId], [], id, s.cwdOffsetBytes, itemSource(it));
    if (s.cwd) add(s.file.path, key(s.cwd), [], [], id, s.cwdOffsetBytes, itemSource(it));
  }
  return {
    pathKey,
    async scan(k, root, clock, exclude, wave) {
      const cands = [...byPath.values()].filter((c) => c.keys.has(k));
      for (const x of (await o.live?.(root, wave).catch(() => [])) ?? []) {
        if (!byPath.has(pathKey(x.path))) cands.push({ path: x.path, keys: new Set([k]), threadIds: x.threadIds, refs: x.refs, id: idOf(x), cost: x.cost ?? null, harness: x.harness ?? null });
      }
      const park: Parked[] = [];
      const seen = new Set<string>();
      for (const c of cands) {
        const pk = pathKey(c.path);
        if (seen.has(pk) || exclude.has(pk) || o.inT3(c.threadIds, c.refs)) continue;
        seen.add(pk);
        let st: SourceFile | null;
        try {
          st = await retryBusy(() => statSafe(c.path), o.busyRetryMs);
        } catch (e) {
          if (isBusy(e)) return { inUse: false, busy: true, park: [] }; // cannot tell where it is: hold the root
          continue;
        }
        if (st === null) continue;
        const t = clock(); // at stat time, never before the awaits
        if (st.mtimeMs > t + ACTIVE_WINDOW_MS) continue; // parked (a leftover at +7 days): T3 skips it
        if (!inImportWindow(st.mtimeMs, t)) continue; // outside the window: T3 cannot take it
        if (isActive(st.mtimeMs, t)) return { inUse: true, park: [] }; // recent, or up to 10 min ahead
        park.push({ st, id: c.id, cost: metadataCost(c.cost, st.size), source: sourceOf(c.harness) });
      }
      return { inUse: false, park };
    },
  };
}

export interface Progress {
  wave: number; totalWaves: number; projects: number; sessions: number;
  imported: number; retry: number; failed: number; deferred: number;
}

export interface WaveCtx {
  api: T3Api;
  journal: Journal;
  runId: string;
  /** Project root (any spelling of it) -> T3 project id. */
  projectIds: Map<string, string>;
  now(): number;
  onProgress(p: Progress): void;
  /** Warning lines for the run output (a root over T3's metadata budget on its own). */
  onNotice?(line: string): void;
  /** Packing limits for waves (re)built here; default: the largest dimensions found in `waves`. */
  batch?: Config["batch"];
  /** Metadata cost of an item (bytes up to its first cwd); default `session.cwdOffsetBytes`. */
  cost?(item: PlanItem): number;
  /** Polled before each wave, before scan and before each import call (SIGINT / SIGTERM). */
  aborted?(): boolean;
  /** waves.rootKey -> the root sent as expectedWorkspaceRoot (T3's own spelling); default the plan root. */
  importRoots?: Map<string, string>;
  /** instanceId -> availability, for the failure reason. */
  instanceAvailability?: Map<string, "available" | "unavailable">;
  platform?: NodeJS.Platform;
  /** Test hook (fault injection) replacing fs.promises.utimes for bumps and restores. */
  utimes?: (path: string, atime: number, mtime: number) => Promise<void>;
  /** Test hook replacing fs.promises.stat for the pre-utimes check and the restore (e.g. a coarse-timestamp fs). */
  stat?: (path: string) => Promise<{ size: number; mtimeMs: number }>;
  /**
   * The current wave's journaled bump list, set right after the mtime-bump entry is written and cleared (null) once
   * the wave's restore finished. Lets a forced exit (third Ctrl+C) restore synchronously with `restoreSync`.
   */
  onPendingFiles?(files: BumpFile[] | null): void;
  /**
   * Every discovered transcript T3 could import (default: the waves' own items). Per wave root, an exposed one in use
   * holds the whole root; the others are parked for the wave.
   */
  exposure?: ExposedTranscript[];
  /** Wave-time listing of a root's transcripts (files created after planning); see apply.ts liveExposure. */
  liveExposure?(root: string, wave: number): Promise<ExposedTranscript[]>;
  /** rootKeys already held when the run starts (applyPlan's pre-check): their items are deferred at once. */
  heldRoots?: ReadonlySet<string>;
  /** Waits between tries of a busy file (default BUSY_RETRY_MS: 100, 300, 1000 ms); tests pass short ones. */
  busyRetryMs?: readonly number[];
}

export interface WavesResult {
  imported: PlanItem[];
  failed: { item: PlanItem; reason: FailReason }[];
  /** Not touched this run (in use, changed or gone since planning); the next run picks them up. Nothing journaled. */
  deferred: { item: PlanItem; reason: DeferReason }[];
  /** Restores that failed: the bump stays pending in the journal and the next run restores it. */
  restoreErrors: { path: string; error: string }[];
  /**
   * Attempted in a wave whose result could not be read (listThreads failed twice). Their threads may exist; the
   * journal's import-attempt entry names them, and the next run's plan sees them as already in T3 if they do.
   */
  unverified: PlanItem[];
  /** A wave ended unverified, so no further wave was started (the remaining items were not attempted). */
  stoppedUnverified: boolean;
  aborted: boolean;
  waves: number;
  /** Plan roots held this run because a transcript of the project was in use (each once). */
  heldRoots: string[];
  /** Waves stopped early because the system clock jumped (their remaining items are deferred `clock-jump`). */
  clockJumps: number;
  /** Transcripts parked (future file time) across all waves of the run, counted once per wave they were parked in. */
  parked: number;
}

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

function threadIdOf(i: PlanItem): string | null {
  return i.action.kind === "skip" ? null : i.action.expectedThreadId;
}

function instanceOf(i: PlanItem): string | null {
  return i.action.kind === "skip" ? null : i.action.instanceId;
}

/** The file is still exactly what the plan saw (size and mtime). */
function matchesPlan(st: SourceFile, it: PlanItem): boolean {
  return st.size === it.session.file.size && near(st.mtimeMs, it.session.file.mtimeMs);
}

function inferBatch(waves: Wave[]): Config["batch"] {
  let projectsPerWave = 0, filesPerProject = 0;
  for (const w of waves) {
    projectsPerWave = Math.max(projectsPerWave, w.projects.length);
    for (const p of w.projects) filesPerProject = Math.max(filesPerProject, p.items.length);
  }
  return { filesPerProject: filesPerProject || DEFAULT_BATCH.filesPerProject, projectsPerWave: projectsPerWave || DEFAULT_BATCH.projectsPerWave };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Put every file back where the journal says it was. Never throws for a single file; returns the paths that are
 * resolved (restored, gone, never moved, or modified by someone else meanwhile) and the errors (left pending for
 * recoverPendingMtimes).
 */
async function restoreAll(
  files: BumpFile[], setTimes: NonNullable<WaveCtx["utimes"]>, statFn: NonNullable<WaveCtx["stat"]>, skipped: ReadonlySet<string>,
  busyRetryMs?: readonly number[],
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

/**
 * Runs the waves. Every item is bumped only in its own wave; the next wave is always rebuilt from what is still
 * pending (retries included), in ascending ORIGINAL mtime, so T3's thread order (updatedAt = bump time) follows the
 * original order. Termination: each item is attempted at most MAX_ATTEMPTS times, so the loop ends when every
 * expected thread id is present or a pass brings no progress for the rest.
 */
export async function runWaves(ctx: WaveCtx, waves: Wave[]): Promise<WavesResult> {
  const platform = ctx.platform ?? process.platform;
  const key = (r: string): string => rootKey(r, platform);
  const cost = ctx.cost ?? ((i: PlanItem) => i.session.cwdOffsetBytes);
  const batch = ctx.batch ?? inferBatch(waves);
  const aborted = (): boolean => ctx.aborted?.() ?? false;
  const setTimes = ctx.utimes ?? utimes;
  const projectId = new Map<string, string>();
  for (const [r, id] of ctx.projectIds) projectId.set(key(r), id);

  const all = waves.flatMap(waveItems).filter((i) => threadIdOf(i) !== null).sort(byOriginalMtime);
  const res: WavesResult = { imported: [], failed: [], deferred: [], restoreErrors: [], unverified: [], stoppedUnverified: false, aborted: false, waves: 0, heldRoots: [], clockJumps: 0, parked: 0 };
  const statFn = ctx.stat ?? stat;
  /** Imported or failed: T3 will not take these in a later wave. */
  const settled = new Set<PlanItem>();
  /** Settled this run: imported, failed or deferred. Never bumped or parked again. */
  const done = new Set<PlanItem>();
  const attempts = new Map<PlanItem, number>();
  const mismatch = new Set<string>();

  const markImported = async (it: PlanItem, src: { path: string; size: number; mtimeMs: number }): Promise<void> => {
    done.add(it);
    settled.add(it);
    res.imported.push(it);
    await ctx.journal.append({
      t: "imported", runId: ctx.runId, harness: it.session.harness, nativeId: it.session.nativeId, threadId: threadIdOf(it)!,
      source: { path: src.path, size: src.size, mtimeMs: src.mtimeMs },
    });
  };
  const reasonFor = (it: PlanItem): FailReason => {
    if (it.session.cwdOffsetBytes > CWD_SCAN_MAX_BYTES) return "cwd-unreadable-in-t3";
    const inst = instanceOf(it);
    if (inst !== null && ctx.instanceAvailability?.get(inst) === "unavailable") return "instance-unavailable";
    if (mismatch.has(key(itemRoot(it)))) return "project-mismatch";
    return "not-imported";
  };
  const markFailed = async (it: PlanItem, reason: FailReason): Promise<void> => {
    done.add(it);
    settled.add(it);
    res.failed.push({ item: it, reason });
    await ctx.journal.append({ t: "import-failed", runId: ctx.runId, harness: it.session.harness, nativeId: it.session.nativeId, reason });
  };

  let refs = new Set<string>();
  const readThreads = (list: { id: string; instanceId: string; nativeSessionId?: string | null }[]): Set<string> => {
    refs = new Set(list.flatMap((t) => (t.nativeSessionId ? [`${t.instanceId}:${t.nativeSessionId}`] : [])));
    return new Set(list.map((t) => t.id));
  };
  let threads = readThreads(await ctx.api.listThreads());
  const exposure = exposureIndex({
    entries: ctx.exposure ?? [], items: all, platform, live: ctx.liveExposure?.bind(ctx), busyRetryMs: ctx.busyRetryMs,
    inT3: (ids, rs) => ids.some((id) => threads.has(id)) || rs.some((r) => refs.has(r)),
  });
  /** Held once = held for the rest of the run (a project in use now is still in use a wave later). */
  const heldForRun = new Set<string>(ctx.heldRoots ?? []);
  /** Why a root is held when it is not "project-in-use" (a busy file). */
  const heldWhy = new Map<string, DeferReason>();
  const holdBusy = (k: string): void => { heldForRun.add(k); heldWhy.set(k, "file-busy"); };
  const holdRoot = (it: PlanItem): void => {
    const r = itemRoot(it);
    if (!res.heldRoots.some((x) => key(x) === key(r))) res.heldRoots.push(r);
  };
  const deferHeld = (it: PlanItem): void => {
    const why = heldWhy.get(key(itemRoot(it))) ?? "project-in-use";
    done.add(it);
    res.deferred.push({ item: it, reason: why });
    if (why === "project-in-use") holdRoot(it);
  };
  // T3 reads a cwd only within the first 1 MiB of a transcript (S2 §4): such a session can never be imported, so it
  // fails up front instead of spending two waves. (The planner already skips them; this is the defensive path.)
  for (const it of all) {
    if (threads.has(threadIdOf(it)!) || it.session.cwdOffsetBytes <= CWD_SCAN_MAX_BYTES) continue;
    await markFailed(it, "cwd-unreadable-in-t3");
  }
  let pool = all.filter((i) => !done.has(i));

  while (pool.length > 0) {
    if (aborted()) { res.aborted = true; break; }
    // Imported meanwhile (e.g. a natural in-window side effect of an earlier wave): never bump again (S2 §5).
    for (const it of pool) {
      if (!threads.has(threadIdOf(it)!)) continue;
      const st = await retryBusy(() => statSafe(it.session.file.path), ctx.busyRetryMs).catch(() => null);
      await markImported(it, st ?? it.session.file);
    }
    for (const it of pool) if (!done.has(it) && !projectId.has(key(itemRoot(it)))) await markFailed(it, "project-mismatch");
    pool = pool.filter((i) => !done.has(i));
    if (pool.length === 0) break;

    const candidates = waveItems(buildWaves(pool, batch, cost, { platform })[0]!);
    const inWave = new Set(candidates);
    pool = pool.filter((i) => !inWave.has(i));

    // Re-stat at bump time: anything in use, changed or gone since planning is left alone this run.
    // This first reading starts the wave's clock guard: the exposure scan and the bump are judged against it.
    const now = ctx.now();
    const waveStart = now;
    const ready: { item: PlanItem; st: SourceFile }[] = [];
    let deferredNow = 0;
    for (const it of candidates) {
      if (heldForRun.has(key(itemRoot(it)))) { deferHeld(it); deferredNow++; continue; }
      let st: SourceFile | null;
      try {
        st = await retryBusy(() => statSafe(it.session.file.path), ctx.busyRetryMs);
      } catch (e) {
        if (!isBusy(e)) throw e;
        holdBusy(key(itemRoot(it))); deferHeld(it); deferredNow++; continue;
      }
      const reason: DeferReason | null = st === null ? "missing"
        : isActive(st.mtimeMs, now) ? "active"
        : !matchesPlan(st, it) ? "changed" : null;
      if (reason !== null) { done.add(it); res.deferred.push({ item: it, reason }); deferredNow++; continue; }
      ready.push({ item: it, st: st! });
    }
    if (ready.length === 0) continue;

    // T3 imports every in-window transcript of a project, from every instance (S2 §3). Per wave root, the EXPOSED set
    // is every transcript of that root (discovered, or listed now: created after planning) inside the window, not in
    // the future and not already in T3. One of them in use: T3 would import it now (live mtime, maybe half-written),
    // so the root is held for the rest of the run. Otherwise every exposed one that is not imported in this wave
    // (mirror and backup copies, excluded ones, duplicates, later waves, new files) is parked in the future.
    const readyKeys = new Set(ready.map((r) => exposure.pathKey(r.st.path)));
    const waveRoots = new Map<string, string>();
    for (const r of ready) waveRoots.set(key(itemRoot(r.item)), itemRoot(r.item));
    const parkedOf = new Map<string, Parked[]>();
    for (const [k, root] of waveRoots) {
      const s = await exposure.scan(k, root, () => ctx.now(), readyKeys, res.waves + 1);
      if (s.busy) holdBusy(k);
      else if (s.inUse) heldForRun.add(k);
      else parkedOf.set(k, s.park);
    }
    if (ready.some((r) => heldForRun.has(key(itemRoot(r.item))))) {
      for (const r of ready) {
        if (!heldForRun.has(key(itemRoot(r.item)))) continue;
        deferHeld(r.item);
        deferredNow++;
      }
      ready.splice(0, ready.length, ...ready.filter((r) => !heldForRun.has(key(itemRoot(r.item)))));
      // a parked file of a held root (two roots can share a file only through remap) stays parked: harmless
    }
    if (ready.length === 0) continue;

    // Metadata budget (S2 §4): T3 reads metadata newest first, so parked files (future mtime) are read BEFORE the
    // bumped ones and spend the same per-source 64 MiB. Roots join the wave in order (oldest item first) while every
    // source's bumped + parked cost stays within WAVE_COST_CAP; the next root waits for a later wave (its items go
    // back to the pool, untouched). The first root always goes, alone and with a warning when it alone is over.
    const spent = new Map<MetadataSource, number>();
    const parkedSeen = new Set<string>();
    const keep = new Set<string>();
    for (const k of [...new Set(ready.map((r) => key(itemRoot(r.item))))]) {
      const add = new Map<MetadataSource, number>();
      const plus = (src: MetadataSource, n: number): void => void add.set(src, (add.get(src) ?? 0) + n);
      for (const r of ready) if (key(itemRoot(r.item)) === k) plus(sourceOf(itemSource(r.item)), metadataCost(cost(r.item), r.st.size));
      for (const p of parkedOf.get(k) ?? []) if (!parkedSeen.has(exposure.pathKey(p.st.path))) plus(p.source, p.cost);
      const over = [...add].some(([src, n]) => (spent.get(src) ?? 0) + n > WAVE_COST_CAP);
      if (over && keep.size > 0) break;
      keep.add(k);
      for (const [src, n] of add) spent.set(src, (spent.get(src) ?? 0) + n);
      for (const p of parkedOf.get(k) ?? []) parkedSeen.add(exposure.pathKey(p.st.path));
      if (over) {
        const mib = (n: number): string => (n / 1024 / 1024).toFixed(1);
        const worst = Math.max(...spent.values());
        ctx.onNotice?.(`Warning: ${itemRoot(ready.find((r) => key(itemRoot(r.item)) === k)!.item)}: its sessions and the copies parked while it imports cost ${mib(worst)} MiB of T3 Code's 64 MiB read budget; some may not be imported this run (they are retried once, then reported).`);
        break;
      }
    }
    if (keep.size < new Set(ready.map((r) => key(itemRoot(r.item)))).size) {
      for (const r of ready) if (!keep.has(key(itemRoot(r.item)))) pool.push(r.item); // a later wave, re-stat'ed then
      pool.sort(byOriginalMtime);
      ready.splice(0, ready.length, ...ready.filter((r) => keep.has(key(itemRoot(r.item)))));
    }
    const parkedByPath = new Map<string, Parked>();
    for (const k of keep) for (const p of parkedOf.get(k) ?? []) parkedByPath.set(exposure.pathKey(p.st.path), p);
    const parked = [...parkedByPath.values()];

    // `now` is re-read immediately before bumping. Bumped: (now - 2 s) + i ms, asserted in the past (bumpTargets).
    // Parked: now + 7 days + i ms, asserted in the future (never a past mtime: Claude Code's cleanup deletes by mtime).
    const bumpNow = ctx.now();
    if (!clockWithin(bumpNow, waveStart, waveStart)) {
      // The clock jumped since the wave's first reading: what the exposure scan saw in the future (or outside the
      // window) may be inside it now. Nothing is touched; the wave's items wait for the next run.
      res.clockJumps++;
      for (const r of ready) { done.add(r.item); res.deferred.push({ item: r.item, reason: "clock-jump" }); }
      continue;
    }
    const targets = bumpTargets(ready.length, bumpNow);
    const parkTargets = parked.map((_, i) => Math.floor(bumpNow) + PARK_AHEAD_MS + i);
    if (parkTargets.some((t) => !(t > bumpNow))) throw new Error("internal: a park target must lie in the future");
    const files: BumpFile[] = [
      ...ready.map((r, i) => ({ path: r.st.path, atimeMs: r.st.atimeMs, mtimeMs: r.st.mtimeMs, targetMtimeMs: targets[i]! })),
      ...parked.map((o, i) => ({ path: o.st.path, atimeMs: o.st.atimeMs, mtimeMs: o.st.mtimeMs, targetMtimeMs: parkTargets[i]! })),
    ];
    const identityOf = new Map<string, Identity>();
    for (const r of ready) identityOf.set(r.st.path, { harness: r.item.session.harness, nativeId: r.item.session.nativeId, threadId: threadIdOf(r.item)! });
    for (const p of parked) if (p.id) identityOf.set(p.st.path, p.id);
    const projects: { k: string; root: string; id: string }[] = [];
    for (const r of ready) {
      const k = key(itemRoot(r.item));
      if (!projects.some((p) => p.k === k)) projects.push({ k, root: ctx.importRoots?.get(k) ?? itemRoot(r.item), id: projectId.get(k)! });
    }
    res.waves++;
    res.parked += parked.length;

    const sizeOf = new Map<string, number>([...ready, ...parked].map((x) => [x.st.path, x.st.size]));
    /** The wave roots each file belongs to (a busy file holds all of them). */
    const rootsOfPath = new Map<string, Set<string>>();
    const addRoot = (path: string, k: string): void => {
      const set = rootsOfPath.get(path) ?? new Set<string>();
      set.add(k);
      rootsOfPath.set(path, set);
    };
    for (const r of ready) addRoot(r.st.path, key(itemRoot(r.item)));
    for (const k of keep) for (const p of parkedOf.get(k) ?? []) addRoot(p.st.path, k);
    /** Roots of this wave not imported because one of their files stayed busy. */
    const busyNow = new Set<string>();
    /** Written to (or gone) between the re-stat and its own utimes: never bumped, left as the writer left it. */
    const skipped = new Map<string, DeferReason>();
    let skippedJournaled = false;
    // The skipped paths were never changed by us: journal them restored at once, so neither this wave's restore nor a
    // crash recovery can ever "restore" them (a coarse-timestamp fs could show their fresh mtime as the target).
    const journalSkipped = async (): Promise<void> => {
      if (skippedJournaled) return;
      skippedJournaled = true;
      if (skipped.size > 0) {
        await ctx.journal.append({ t: "mtime-restore", runId: ctx.runId, paths: [...skipped.keys()] });
        // A file written under us could not be parked: it sits in the window with its live mtime, so T3 may import it
        // in this wave. Name it in a follow-up import-attempt (rollback finds its thread). Bumped ready items that
        // were skipped are already in the first entry.
        const extra = [...skipped].filter(([p, why]) => why !== "file-busy" && !ready.some((r) => r.st.path === p)).map(([p]) => identityOf.get(p)).filter((x): x is Identity => !!x);
        if (extra.length > 0) await ctx.journal.append({ t: "import-attempt", runId: ctx.runId, items: extra });
      }
      ctx.onPendingFiles?.(files.filter((f) => !skipped.has(f.path)));
    };

    await ctx.journal.append({ t: "mtime-bump", runId: ctx.runId, files }); // before any utimes
    // Before the import calls: every thread this wave may create (nothing else of its projects is importable now: the
    // rest is parked or the root is held), so a rollback finds them even if verification never happens.
    // `parked`: the copies parked for this wave (never meant to be imported; a rollback lists them for review only).
    await ctx.journal.append({
      t: "import-attempt", runId: ctx.runId,
      items: ready.map(({ item: it, st }) => ({
        harness: it.session.harness, nativeId: it.session.nativeId, threadId: threadIdOf(it)!, source: { path: st.path, size: st.size, mtimeMs: st.mtimeMs },
      })),
      parked: parked.flatMap((p) => (p.id ? [p.id] : [])),
    });
    ctx.onPendingFiles?.(files);
    // Every clock reading of this wave must stay within [the last reading - CLOCK_BACK_TOLERANCE_MS, waveStart + CLOCK_JUMP_MS].
    let lastClock = bumpNow;
    let clockJump = false;
    const clockOk = (): boolean => {
      const t = ctx.now();
      if (!clockWithin(t, lastClock, waveStart)) { clockJump = true; return false; }
      lastClock = Math.max(lastClock, t);
      return true;
    };
    /** Roots whose import call was made in this wave. */
    const called = new Set<string>();
    try {
      // A file that stays busy is left as it is and holds every root it belongs to (none is imported this run: a copy
      // that could not be parked would be imported under its own account).
      const busy = (path: string): void => {
        skipped.set(path, "file-busy");
        for (const k of rootsOfPath.get(path) ?? []) { busyNow.add(k); holdBusy(k); }
      };
      for (const f of files) {
        // Close the stat->utimes race: a file written since the re-stat keeps its fresh mtime.
        let cur: { size: number; mtimeMs: number };
        try { cur = await retryBusy(() => statFn(f.path), ctx.busyRetryMs); } catch (e) {
          if (isBusy(e)) busy(f.path);
          else skipped.set(f.path, (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "changed");
          continue;
        }
        if (cur.size !== sizeOf.get(f.path) || cur.mtimeMs !== f.mtimeMs) { skipped.set(f.path, "changed"); continue; }
        try {
          await retryBusy(() => setTimes(f.path, f.atimeMs / 1000, f.targetMtimeMs / 1000), ctx.busyRetryMs);
        } catch (e) {
          if (!isBusy(e)) throw e;
          busy(f.path);
        }
      }
      await journalSkipped();
      if (!aborted() && clockOk()) {
        await ctx.api.scanSessions(); // mandatory: import only sees mtimes from the last scan (S2 §2.1)
        for (const p of projects) {
          if (busyNow.has(p.k)) continue; // a file of it stayed busy: nothing of it is imported this run
          if (aborted() || !clockOk()) break;
          called.add(p.k);
          try {
            await ctx.api.importSessions(p.id, p.root);
          } catch (e) {
            if (e instanceof RpcError && e.errorTag !== null && PROJECT_MISMATCH_TAGS.has(e.errorTag)) mismatch.add(p.k);
            else throw e;
          }
        }
      }
    } finally {
      await journalSkipped(); // the bump loop threw: still record the skipped ones before restoring the rest
      const r = await restoreAll(files, setTimes, statFn, new Set(skipped.keys()), ctx.busyRetryMs);
      res.restoreErrors.push(...r.errors);
      if (r.resolved.length > 0) await ctx.journal.append({ t: "mtime-restore", runId: ctx.runId, paths: r.resolved });
      ctx.onPendingFiles?.(null);
    }

    // Verify against the shell: the only success signal (importedCount is not "new threads", S2 §2.2). One retry;
    // if the shell stays unreachable the wave's items end unverified (reported; the import-attempt entry names them).
    let shell: Set<string> | null = null;
    for (let k = 0; k < 2 && shell === null; k++) {
      try { shell = readThreads(await ctx.api.listThreads()); } catch { /* retried once */ }
    }
    let importedNow = 0, retry = 0, failedNow = 0;
    const stopped = aborted();
    if (clockJump) res.clockJumps++;
    if (shell === null) {
      // T3's thread list is unreachable: stop here. Starting more waves could not be verified either.
      for (const { item } of ready) { done.add(item); res.unverified.push(item); }
      res.stoppedUnverified = true;
    } else threads = shell;
    for (const { item, st } of shell === null ? [] : ready) {
      if (threads.has(threadIdOf(item)!)) {
        await markImported(item, skipped.has(st.path) ? (await statSafe(st.path)) ?? st : st);
        importedNow++;
        continue;
      }
      const why = skipped.get(st.path);
      if (why !== undefined) { done.add(item); res.deferred.push({ item, reason: why }); deferredNow++; continue; } // never bumped
      if (busyNow.has(key(itemRoot(item)))) { done.add(item); res.deferred.push({ item, reason: "file-busy" }); deferredNow++; continue; }
      if (clockJump && !called.has(key(itemRoot(item)))) { done.add(item); res.deferred.push({ item, reason: "clock-jump" }); deferredNow++; continue; }
      if (stopped) continue; // not attempted to the end: neither a failure nor a retry
      const n = (attempts.get(item) ?? 0) + 1;
      attempts.set(item, n);
      if (n < MAX_ATTEMPTS) { pool.push(item); retry++; }
      else { await markFailed(item, reasonFor(item)); failedNow++; }
    }
    pool.sort(byOriginalMtime);
    const remaining = pool.length > 0 ? buildWaves(pool, batch, cost, { platform }).length : 0;
    ctx.onProgress({
      wave: res.waves, totalWaves: res.waves + remaining, projects: projects.length, sessions: ready.length,
      imported: importedNow, retry, failed: failedNow, deferred: deferredNow,
    });
    if (stopped) { res.aborted = true; break; }
    if (res.stoppedUnverified) break;
  }
  return res;
}
