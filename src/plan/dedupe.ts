// Picks one copy per session (spec §4.3 rule 2): copies of one `harness:nativeId` are resolved by backup status,
// then by size/mtime inside one account (drive-case variant dirs), then by content across accounts.

import type { AccountSource, Config, DiscoveredSession } from "../core/types.ts";
import { resolveRemap } from "../core/config.ts";
import type { CopyRelation } from "./ownership.ts";

export type { CopyRelation } from "./ownership.ts";

export type LoserRelation = "identical" | "prefix" | "case-variant" | "backup";
export interface Loser { session: DiscoveredSession; winner: DiscoveredSession; relation: LoserRelation }
export interface WinnersResult { winners: DiscoveredSession[]; losers: Loser[]; forks: DiscoveredSession[][] }

export interface PickDeps {
  compareCopies(a: string, b: string): Promise<CopyRelation>;
  /** Account of the project at `root` (spec §4.3 rule 3); decides which identical copy stays. */
  projectAccount(root: string): Promise<{ accountId: string; source?: AccountSource }>;
  platform?: NodeJS.Platform;
}

const isBackup = (s: DiscoveredSession): boolean => s.flags.includes("backup-copy");

/** Larger file, then newer mtime, then path (deterministic). */
function biggerNewer(a: DiscoveredSession, b: DiscoveredSession): number {
  if (a.file.size !== b.file.size) return b.file.size - a.file.size;
  if (a.file.mtimeMs !== b.file.mtimeMs) return b.file.mtimeMs - a.file.mtimeMs;
  return a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0;
}

export async function pickWinners(sessions: DiscoveredSession[], config: Config, deps: PickDeps): Promise<WinnersResult> {
  const platform = deps.platform ?? process.platform;
  const groups = new Map<string, DiscoveredSession[]>();
  for (const s of sessions) {
    const k = `${s.harness}:${s.nativeId}`;
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  const acctOrder = (id: string | null): number => {
    const i = config.accounts.findIndex((a) => a.id === id);
    return i === -1 ? config.accounts.length : i;
  };

  const winners: DiscoveredSession[] = [];
  const losers: Loser[] = [];
  const forks: DiscoveredSession[][] = [];

  for (const group of groups.values()) {
    if (group.length === 1) {
      winners.push(group[0]!);
      continue;
    }
    const live = group.filter((s) => !isBackup(s));
    const pool = live.length > 0 ? live : group;
    const backupLosers = live.length > 0 ? group.filter(isBackup) : [];

    // Inside one account (drive-case variant dirs like `d--X` / `D--X`). On win32/darwin the copies are picked by size,
    // then mtime, without a content compare: a case-insensitive filesystem (NTFS, APFS default) cannot hold two such
    // dirs at once, so both copies only coexist through a rename and the bigger/newer one is where work last happened.
    // On case-sensitive platforms (linux) the two dirs really are distinct, so same-account copies go through the
    // content compare below like cross-account copies (identical/prefix -> `case-variant` loser; diverged -> fork).
    const foldsCase = platform === "win32" || platform === "darwin";
    const byAccount = new Map<string, DiscoveredSession[]>();
    for (const s of pool) {
      const k = s.accountId ?? "";
      const g = byAccount.get(k);
      if (g) g.push(s);
      else byAccount.set(k, [s]);
    }
    const pending: { session: DiscoveredSession; winner: DiscoveredSession; relation: LoserRelation }[] = [];
    const candidates: DiscoveredSession[] = [];
    for (const g of byAccount.values()) {
      if (!foldsCase) {
        candidates.push(...g);
        continue;
      }
      const sorted = [...g].sort(biggerNewer);
      candidates.push(sorted[0]!);
      for (const s of sorted.slice(1)) pending.push({ session: s, winner: sorted[0]!, relation: "case-variant" });
    }
    candidates.sort((a, b) => acctOrder(a.accountId) - acctOrder(b.accountId) || (a.file.path < b.file.path ? -1 : 1));

    // Across accounts: by content.
    const replacedBy = new Map<DiscoveredSession, DiscoveredSession>();
    let heads: DiscoveredSession[] = [];
    for (const c of candidates) {
      let placed = false;
      for (let i = 0; i < heads.length; i++) {
        const h = heads[i]!;
        const rel = await deps.compareCopies(c.file.path, h.file.path);
        if (rel === "diverged") continue;
        placed = true;
        let keep: DiscoveredSession;
        let drop: DiscoveredSession;
        let relation: LoserRelation;
        const sameAccount = c.accountId === h.accountId;
        if (rel === "identical" && sameAccount) {
          relation = "case-variant";
          [keep, drop] = biggerNewer(c, h) < 0 ? [c, h] : [h, c];
        } else if (rel === "identical") {
          relation = "identical";
          const cwd = c.cwd ?? h.cwd;
          const owner = cwd === null ? config.defaultAccount : (await deps.projectAccount(resolveRemap(cwd, config, platform).cwd)).accountId;
          if (c.accountId === owner && h.accountId !== owner) [keep, drop] = [c, h];
          else [keep, drop] = [h, c];
        } else {
          relation = sameAccount ? "case-variant" : "prefix";
          [keep, drop] = rel === "a-extends-b" ? [c, h] : [h, c];
        }
        pending.push({ session: drop, winner: keep, relation });
        if (keep === c) {
          replacedBy.set(h, c);
          heads[i] = c;
        }
        break;
      }
      if (!placed) heads.push(c);
    }
    heads = heads.filter((h) => !replacedBy.has(h));
    const final = (s: DiscoveredSession): DiscoveredSession => {
      let cur = s;
      for (let r = replacedBy.get(cur); r !== undefined; r = replacedBy.get(cur)) cur = r;
      if (heads.includes(cur)) return cur;
      // A winner that later lost (e.g. a case-variant's account winner lost across accounts): follow its own loss.
      const lost = pending.find((p) => p.session === cur);
      return lost ? final(lost.winner) : cur;
    };
    for (const p of pending) losers.push({ session: p.session, winner: final(p.winner), relation: p.relation });
    for (const b of backupLosers) {
      const sameAcct = heads.find((h) => h.accountId === b.accountId) ?? heads[0]!;
      losers.push({ session: b, winner: sameAcct, relation: "backup" });
    }
    winners.push(...heads);
    if (heads.length > 1) forks.push([...heads]);
  }
  return { winners, losers, forks };
}
