// T3's metadata budget (S2 §4): per source, the bytes its scanner reads to find each transcript's cwd. A wave takes
// roots while every source's bumped + parked cost stays within WAVE_COST_CAP.

import type { HarnessId, PlanItem } from "../core/types.ts";
import { CWD_SCAN_MAX_BYTES } from "../sources/types.ts";
import { WAVE_COST_CAP, itemRoot } from "./waves.ts";

/** T3 budgets metadata per source (S2 §4): converted OpenCode sessions are Claude transcripts. */
export type MetadataSource = "claude" | "codex" | "pi";
export function sourceOf(h: HarnessId | null | undefined): MetadataSource {
  return h === "codex" || h === "pi" ? h : "claude";
}

/** The metadata source of an item's file: a convert-import's file is a Claude transcript, whatever its harness. */
export function itemSource(it: PlanItem): HarnessId {
  return it.action.kind === "convert-import" ? "claude" : it.session.harness;
}

/** What T3 reads of a file to find its cwd: never more than the file, never more than 1 MiB (S2 §4). */
export function metadataCost(cost: number | null, size: number): number {
  return Math.max(0, Math.min(cost ?? size, size, CWD_SCAN_MAX_BYTES));
}

/**
 * The roots of `ready` (in order, oldest item first) that fit one wave: each root's ready items and the copies parked
 * while it imports, added while every source's cost stays within WAVE_COST_CAP. The first root always goes, alone and
 * with a warning (`onNotice`) when it alone is over; the others wait for a later wave.
 */
export function rootsWithinBudget(
  ready: { item: PlanItem; st: { path: string; size: number } }[],
  parkedOf: ReadonlyMap<string, { st: { path: string }; cost: number; source: MetadataSource }[]>,
  o: { key: (root: string) => string; cost: (item: PlanItem) => number; pathKey: (p: string) => string; onNotice?: (line: string) => void },
): Set<string> {
  const { key, cost, pathKey } = o;
  const spent = new Map<MetadataSource, number>();
  const parkedSeen = new Set<string>();
  const keep = new Set<string>();
  for (const k of [...new Set(ready.map((r) => key(itemRoot(r.item))))]) {
    const add = new Map<MetadataSource, number>();
    const plus = (src: MetadataSource, n: number): void => void add.set(src, (add.get(src) ?? 0) + n);
    for (const r of ready) if (key(itemRoot(r.item)) === k) plus(sourceOf(itemSource(r.item)), metadataCost(cost(r.item), r.st.size));
    for (const p of parkedOf.get(k) ?? []) if (!parkedSeen.has(pathKey(p.st.path))) plus(p.source, p.cost);
    const over = [...add].some(([src, n]) => (spent.get(src) ?? 0) + n > WAVE_COST_CAP);
    if (over && keep.size > 0) break;
    keep.add(k);
    for (const [src, n] of add) spent.set(src, (spent.get(src) ?? 0) + n);
    for (const p of parkedOf.get(k) ?? []) parkedSeen.add(pathKey(p.st.path));
    if (over) {
      const mib = (n: number): string => (n / 1024 / 1024).toFixed(1);
      const worst = Math.max(...spent.values());
      o.onNotice?.(`Warning: ${itemRoot(ready.find((r) => key(itemRoot(r.item)) === k)!.item)}: its sessions and the copies parked while it imports cost ${mib(worst)} MiB of T3 Code's 64 MiB read budget; some may not be imported this run (they are retried once, then reported).`);
      break;
    }
  }
  return keep;
}
