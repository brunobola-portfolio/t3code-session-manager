// Exposure: what T3 Code could import into a project besides the run's own items (T3 imports EVERY in-window
// transcript of a root, from every instance; S2 §3; those of its linked git worktrees included). exposureOf / liveExposure list the transcripts, exposureIndex scans
// a root's at wave time (the importer parks them or holds the root), futureLeftovers finds transcripts left in the future.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DiscoveredSession, HarnessId, JournalEntry, PlanItem, SourceFile } from "../core/types.ts";
import { isConvertSession, otherForms, sessionIdsInT3 } from "../sources/registry.ts";
import { ACTIVE_WINDOW_MS } from "../sources/types.ts";
import { inImportWindow, isActive } from "../core/activity.ts";
import { pendingMtimePaths } from "../core/journal.ts";
import { statSafe } from "../core/fsutil.ts";
import { encodeClaudeProjectDir, normalizeCwd, pathKey, pathKey as pathKeyOf } from "../core/paths.ts";
import { linkedWorktreesOf, mainCheckoutOf } from "../core/worktree.ts";
import { readClaudeNativeId } from "../sources/claude.ts";
import type { ProviderInstanceInfo } from "../t3/api.ts";
import { rootKey } from "./waves.ts";
import { isBusy, retryBusy } from "./busy.ts";
import { itemSource, metadataCost, sourceOf, type MetadataSource } from "./budget.ts";
/** `file` lies inside directory `dir` (path identity per platform). */
export function inside(file: string, dir: string, platform: NodeJS.Platform): boolean {
  const f = rootKey(file, platform), d = rootKey(dir, platform);
  return f.startsWith(d.endsWith("/") ? d : `${d}/`);
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

export interface Identity { harness: HarnessId; nativeId: string; threadId: string }
interface Candidate { path: string; keys: Set<string>; cwds: Set<string>; threadIds: string[]; refs: string[]; id: Identity | null; cost: number | null; harness: HarnessId | null }
/** A transcript parked for a wave: fresh stat, identity, and what it costs T3's metadata pass of its source. */
export interface Parked { st: SourceFile; id: Identity | null; cost: number; source: MetadataSource }

/** The transcript that holds its project: being written (mtime within ACTIVE_WINDOW_MS of now). */
export interface ActiveFile { path: string; mtimeMs: number; harness: HarnessId | null }

export interface ExposureIndex {
  /**
   * The exposed transcripts of a root right now: inside the window, not already in T3, not in `exclude` (path keys
   * of the wave's own items). The clock is read right after each stat. inUse: one of them has an mtime within
   * ACTIVE_WINDOW_MS of that clock, either side (a session written during the scan gets an mtime slightly AHEAD of
   * an earlier clock reading; T3 would import it now): the caller holds the root. Only an mtime more than
   * ACTIVE_WINDOW_MS in the future counts as parked (a crash leftover at now + 7 days, which T3 skips) and is
   * ignored. park: the rest, with fresh stats. active (with inUse): the file that made the root in use, as stat'ed.
   */
  scan(k: string, root: string, clock: () => number, exclude: ReadonlySet<string>, wave: number): Promise<{ inUse: boolean; busy?: boolean; active?: ActiveFile; park: Parked[] }>;
  pathKey(p: string): string;
  /** The key of the main checkout `cwd` is a linked worktree of, or null (read once per folder). */
  mainKeyOf(cwd: string): Promise<string | null>;
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
  const mains = new Map<string, Promise<string | null>>();
  const mainKeyOf = (cwd: string): Promise<string | null> => {
    const k = key(cwd);
    const known = mains.get(k) ?? mainCheckoutOf(cwd).then((m) => (m === null ? null : key(m)));
    mains.set(k, known);
    return known;
  };
  /** T3 imports it with root `k`: its own folder, or a linked worktree of that root. */
  const belongsTo = async (c: Candidate, k: string): Promise<boolean> => {
    if (c.keys.has(k)) return true;
    for (const cwd of c.cwds) if ((await mainKeyOf(cwd)) === k) return true;
    return false;
  };
  const byPath = new Map<string, Candidate>();
  const add = (path: string, cwd: string, threadIds: string[], refs: string[], id: Identity | null, cost: number | null, harness: HarnessId | null): void => {
    const pk = pathKey(path);
    const c = byPath.get(pk) ?? { path, keys: new Set<string>(), cwds: new Set<string>(), threadIds: [], refs: [], id: null, cost: null, harness: null };
    c.keys.add(key(cwd));
    c.cwds.add(cwd);
    c.threadIds.push(...threadIds);
    c.refs.push(...refs);
    c.id ??= id;
    c.cost ??= cost;
    c.harness ??= harness;
    byPath.set(pk, c);
  };
  const idOf = (x: ExposedTranscript): Identity | null =>
    x.harness && x.nativeId && x.threadIds[0] ? { harness: x.harness, nativeId: x.nativeId, threadId: x.threadIds[0] } : null;
  for (const x of o.entries) add(x.path, x.cwd, x.threadIds, x.refs, idOf(x), x.cost ?? null, x.harness ?? null);
  for (const it of o.items) {
    if (it.action.kind === "skip") continue;
    const s = it.session;
    const id = { harness: s.harness, nativeId: s.nativeId, threadId: it.action.expectedThreadId };
    add(s.file.path, it.action.projectRoot, [it.action.expectedThreadId], [], id, s.cwdOffsetBytes, itemSource(it));
    if (s.cwd) add(s.file.path, s.cwd, [], [], id, s.cwdOffsetBytes, itemSource(it));
  }
  return {
    pathKey,
    mainKeyOf,
    async scan(k, root, clock, exclude, wave) {
      const cands: Candidate[] = [];
      for (const c of byPath.values()) if (await belongsTo(c, k)) cands.push(c);
      for (const x of (await o.live?.(root, wave).catch(() => [])) ?? []) {
        if (!byPath.has(pathKey(x.path))) cands.push({ path: x.path, keys: new Set([k]), cwds: new Set([x.cwd]), threadIds: x.threadIds, refs: x.refs, id: idOf(x), cost: x.cost ?? null, harness: x.harness ?? null });
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
        if (isActive(st.mtimeMs, t)) return { inUse: true, active: { path: c.path, mtimeMs: st.mtimeMs, harness: c.harness }, park: [] }; // recent, or up to 10 min ahead
        park.push({ st, id: c.id, cost: metadataCost(c.cost, st.size), source: sourceOf(c.harness) });
      }
      return { inUse: false, park };
    },
  };
}

/**
 * Transcripts more than ACTIVE_WINDOW_MS ahead of `now` that no pending journal bump explains (a parked file whose
 * journal entry was lost, or a clock that was wrong when the file was written). T3 Code skips them; t3sm cannot know
 * their real time, so they are only reported (apply / sync warn, doctor lists them).
 */
export function futureLeftovers(files: { path: string; mtimeMs: number }[], entries: JournalEntry[], now: number, platform: NodeJS.Platform = process.platform): string[] {
  const key = (p: string): string => pathKey(p, platform);
  const pending = new Set(pendingMtimePaths(entries, platform).map(key));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of files) {
    const k = key(f.path);
    if (f.mtimeMs <= now + ACTIVE_WINDOW_MS || pending.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(f.path);
  }
  return out;
}

/**
 * T3's thread ids, plus the expected thread id of every item whose session T3 already holds in its OTHER form (any
 * instance): a Codex session imported natively and since compressed, or converted and since seen as a plain rollout.
 * One session never gets a second thread, whatever the plan (an older plan.json) says.
 */
export function inT3ThreadIds(items: PlanItem[], threads: { id: string; nativeSessionId?: string | null }[]): Set<string> {
  const out = new Set(threads.map((t) => t.id));
  const sessionIds = sessionIdsInT3(threads);
  for (const i of items) {
    if (i.action.kind === "skip") continue;
    const own = i.action.kind === "convert-import" ? i.action.uuid : i.session.nativeId;
    if (!sessionIds.has(own) && otherForms(i.session, own).some((f) => sessionIds.has(f))) out.add(i.action.expectedThreadId);
  }
  return out;
}

/**
 * What T3 could import, as ExposedTranscript: every discovered native transcript with a cwd, with the thread ids T3
 * would give it. A Claude transcript belongs to the instances whose home holds it (unknown homes: every instance
 * without one); none = no instance reads it, so T3 cannot import it. Other harnesses: any non-Claude instance.
 */
export function exposureOf(items: PlanItem[], providers: ProviderInstanceInfo[], platform: NodeJS.Platform): ExposedTranscript[] {
  const out: ExposedTranscript[] = [];
  const claude = providers.filter((p) => p.driver === "claudeAgent");
  // A disabled or unavailable Codex/Pi instance does not import anything.
  const others = providers.filter((p) => p.driver !== "claudeAgent" && p.enabled && p.availability === "available");
  for (const it of items) {
    const s = it.session;
    // Convert-mode sessions and compressed rollouts are never read by T3 itself.
    if (s.cwd === null || isConvertSession(s) || s.flags?.includes("compressed")) continue;
    if (s.flags.includes("cwd-unreadable")) continue; // T3 cannot read its cwd, so it cannot match a project
    let insts: string[];
    if (s.harness === "claude") {
      const owners = claude.filter((p) => p.homePath !== null && inside(s.file.path, p.homePath, platform));
      insts = (owners.length > 0 ? owners : claude.filter((p) => p.homePath === null)).map((p) => p.instanceId);
    } else insts = others.map((p) => p.instanceId);
    if (insts.length === 0) continue;
    const threadIds = insts.map((i) => `import:${i}:${s.nativeId}`);
    if (it.action.kind !== "skip") threadIds.push(it.action.expectedThreadId);
    out.push({ path: s.file.path, cwd: s.cwd, threadIds, refs: insts.map((i) => `${i}:${s.nativeId}`), harness: s.harness, nativeId: s.nativeId, cost: s.cwdOffsetBytes });
  }
  return out;
}

/**
 * Wave-time listing of a root's transcripts (its linked worktrees' too), for files created after planning. Claude:
 * `<home>/projects/<encoded root>/*.jsonl` in every Claude instance home (the encoded folder matched case-insensitively on Windows and macOS, so
 * drive-letter case variants are included), each under the id T3 imports it as (claudeNativeId: `knownId` for files
 * discovery already read, else the file is streamed once). Codex / Pi: `rediscover` (the adapters' cached
 * discovery), at most once per wave, filtered to that cwd.
 */
export function liveExposure(
  getProviders: () => ProviderInstanceInfo[], platform: NodeJS.Platform, rediscover?: () => Promise<DiscoveredSession[]>,
  o: { accountHome?: (instanceId: string) => string | undefined; warn?: (line: string) => void; knownId?: (path: string) => string | undefined } = {},
): (root: string, wave: number) => Promise<ExposedTranscript[]> {
  const fold = platform === "win32" || platform === "darwin";
  let natWave = -1;
  let nat: Promise<DiscoveredSession[]> = Promise.resolve([]);
  const warned = new Set<string>();
  return async (root, wave) => {
    const out: ExposedTranscript[] = [];
    const roots = [root, ...await linkedWorktreesOf(root)];
    const want = new Map<string, string>(); // encoded folder -> the cwd it stands for
    for (const r of roots) {
      const enc = encodeClaudeProjectDir(normalizeCwd(r, platform));
      const w = fold ? enc.toLowerCase() : enc;
      if (!want.has(w)) want.set(w, r);
    }
    for (const p of getProviders()) {
      if (p.driver !== "claudeAgent") continue;
      // T3 reports no home for an implicit instance it has not resolved: the config account of that id names it.
      const home = p.homePath ?? o.accountHome?.(p.instanceId);
      if (!home) {
        if (!warned.has(p.instanceId)) { warned.add(p.instanceId); o.warn?.(`Warning: could not list ${p.instanceId}: home unknown (new transcripts there are not parked this run).`); }
        continue;
      }
      const projects = join(home, "projects");
      const dirs = await readdir(projects).catch(() => [] as string[]);
      for (const d of dirs) {
        const cwd = want.get(fold ? d.toLowerCase() : d);
        if (cwd === undefined) continue;
        for (const f of await readdir(join(projects, d)).catch(() => [] as string[])) {
          if (!f.endsWith(".jsonl")) continue;
          // T3's id rule, as discovery applies it (claudeNativeId): a file named after one session can carry another.
          const path = join(projects, d, f);
          const id = o.knownId?.(path) ?? await readClaudeNativeId(path);
          out.push({ path, cwd, threadIds: [`import:${p.instanceId}:${id}`], refs: [`${p.instanceId}:${id}`], harness: "claude", nativeId: id });
        }
      }
    }
    if (rediscover && getProviders().some((p) => p.driver !== "claudeAgent" && p.enabled && p.availability === "available")) {
      if (natWave !== wave) { natWave = wave; nat = rediscover().catch(() => []); }
      const ks = new Set(roots.map((r) => rootKey(r, platform)));
      const mine = (await nat).filter((s) => s.harness !== "claude" && s.cwd !== null && ks.has(rootKey(s.cwd, platform)));
      out.push(...exposureOf(mine.map((session) => ({ session, action: { kind: "skip", reason: "excluded" }, notes: [] })), getProviders(), platform));
    }
    return out;
  };
}

/** A convert-import item as the exposure checks see it: its file is the converted transcript (the source is shared). */
export function asTargetItem(i: PlanItem): PlanItem {
  if (i.action.kind !== "convert-import") return i;
  return { ...i, session: { ...i.session, file: { ...i.session.file, path: i.action.targetFile } } };
}
