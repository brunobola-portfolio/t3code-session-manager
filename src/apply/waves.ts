// Wave packing for the importer (docs/spikes/S2-import.md §5). Pure: no I/O.
//
// Every import item goes through a wave, oldest ORIGINAL mtime first across all projects. A wave is the next
// contiguous slice of that global order, so every item of a wave is at least as new as every item of earlier waves,
// and T3's thread updatedAt order (= bump time) ends up matching the original order.

import type { Config, PlanItem } from "../core/types.ts";
import { pathKey } from "../core/paths.ts";

/** 64 MiB per-source metadata budget in T3's scanner minus an 8 MiB margin (S2 §4/§5); the importer adds the wave's parked cost. */
export const WAVE_COST_CAP = 56 * 1024 * 1024;
/** Hard maximum of bumped files per project per wave (S2 §5). */
export const HARD_FILES_PER_PROJECT = 90;
/** Bump offsets are i ms below a base 2 s before now; more than 2000 files would reach "now" (future = ineligible). */
export const MAX_WAVE_FILES = 1000;
export const BUMP_LEAD_MS = 2000;

export interface Wave { projects: { projectRoot: string; items: PlanItem[] }[] }

export interface BuildOptions {
  platform?: NodeJS.Platform;
  maxCost?: number;
}

/** A project root's identity (core pathKey). */
export function rootKey(root: string, platform: NodeJS.Platform = process.platform): string {
  return pathKey(root, platform);
}

export function itemRoot(i: PlanItem): string {
  return i.action.kind === "skip" ? "" : i.action.projectRoot;
}

/** Ascending original mtime, then path: the global wave order. */
export function byOriginalMtime(a: PlanItem, b: PlanItem): number {
  const d = a.session.file.mtimeMs - b.session.file.mtimeMs;
  if (d !== 0) return d;
  const pa = a.session.file.path, pb = b.session.file.path;
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

/**
 * Files of one project per wave: min(filesPerProject, 90), at least 1.
 *
 * S2 §5 derives the capacity as min(filesPerProject, 90, 100 - R), R = the project's not-yet-imported in-window
 * transcripts outside the wave. T3 spends its 100-per-call cap in mtime-DESCENDING order, so only transcripts newer
 * than the wave's bump base (now - 2 s) can take a slot ahead of the bumped files. With parking (every other
 * not-imported, in-window transcript of the wave's projects is moved to now + 7 days for the wave, where T3 skips it;
 * a project with one in use is held instead), what
 * remains in the window is older than the bump base (active files are >= 2 s old in practice; skipped and
 * already-imported transcripts are older still), so R = 0 here. The hard max 90 keeps 10 slots of slack for files
 * written within the last 2 s.
 */
export function projectCapacity(filesPerProject: number): number {
  return Math.max(1, Math.min(filesPerProject, HARD_FILES_PER_PROJECT));
}

/** All items of a wave in ascending original mtime (the bump order). */
export function waveItems(w: Wave): PlanItem[] {
  return w.projects.flatMap((p) => p.items).sort(byOriginalMtime);
}

/**
 * Greedy packing of the global ascending order: a new wave starts when the next item would exceed projectsPerWave
 * projects, its project's capacity, MAX_WAVE_FILES, or the cost cap. An item that alone exceeds the cost cap gets a
 * wave of its own (T3 can still try it; it fails visibly instead of blocking the run). Deterministic.
 */
export function buildWaves(items: PlanItem[], batch: Config["batch"], cost: (item: PlanItem) => number, opts: BuildOptions = {}): Wave[] {
  const platform = opts.platform ?? process.platform;
  const maxCost = opts.maxCost ?? WAVE_COST_CAP;
  const sorted = [...items].sort(byOriginalMtime);
  const waves: Wave[] = [];
  let cur: { wave: Wave; byKey: Map<string, { projectRoot: string; items: PlanItem[] }>; cost: number; n: number } | null = null;
  for (const it of sorted) {
    const key = rootKey(itemRoot(it), platform);
    const c = Math.max(0, cost(it));
    const cap = projectCapacity(batch.filesPerProject);
    const fits = cur !== null && (() => {
      const p = cur.byKey.get(key);
      if (!p && cur.byKey.size >= batch.projectsPerWave) return false;
      if (p && p.items.length >= cap) return false;
      if (cur.n >= MAX_WAVE_FILES) return false;
      return cur.cost + c <= maxCost;
    })();
    if (!fits) {
      cur = { wave: { projects: [] }, byKey: new Map(), cost: 0, n: 0 };
      waves.push(cur.wave);
    }
    let p = cur!.byKey.get(key);
    if (!p) {
      p = { projectRoot: itemRoot(it), items: [] };
      cur!.byKey.set(key, p);
      cur!.wave.projects.push(p);
    }
    p.items.push(it);
    cur!.cost += c;
    cur!.n++;
  }
  return waves;
}

/** Bump targets for n files: the i-th (ascending original mtime) gets (now - 2 s) + i ms. Throws unless every target is strictly before now. */
export function bumpTargets(n: number, now: number): number[] {
  const base = Math.floor(now) - BUMP_LEAD_MS;
  const out = Array.from({ length: n }, (_, i) => base + i);
  if (n > 0 && out[n - 1]! >= now) throw new Error(`bump target not strictly before now, would be in the future (${n} files in one wave); waves hold at most ${MAX_WAVE_FILES}`);
  return out;
}
