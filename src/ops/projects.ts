// Which account a project folder uses: exact-folder routes in config.json (t3sm projects set / unset) and the
// read-only project table (t3sm projects, the guided assistant). Pure functions; the CLI does the I/O.

import path from "node:path";
import { homedir } from "node:os";
import type { AccountSource, Config, Plan } from "../core/types.ts";
import { expandHome, normalizeCwd, pathKey, sameCwd } from "../core/paths.ts";
import { globToRegExp } from "../core/glob.ts";
import { ConfigError, resolveRemap, routeAccount } from "../core/config.ts";
import type { T3Project } from "../t3/api.ts";

type Route = Config["routes"][number];

/** A route whose match has a wildcard. Every other route names one exact folder. */
export function isGlob(match: string): boolean {
  return /[*?]/.test(match);
}

/** A folder as the user typed it: `~` is `home`, then made absolute (against the current folder) and normalised. */
export function normalizeFolder(input: string, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const expanded = expandHome(input, home);
  const abs = platform === "win32" ? path.win32.resolve(expanded) : path.posix.resolve(expanded);
  return normalizeCwd(abs, platform);
}

/**
 * Sets the exact-folder route of `folder` to `account`; the folder always ends on that account and no other folder's
 * account changes. The folder's own route (in any spelling sameCwd accepts: trailing slash, `..`, backslashes, case
 * where the system folds it) is rewritten as the normalised folder in its place, duplicates dropped; a new one goes
 * right before the first wildcard route matching the folder, or at the end. If an earlier route still matches the
 * folder, that one route moves to just before it (it matches only this folder, so nothing else changes).
 * `previous`: the account of the folder's own route before (null: none); `before`: the account the folder had by routes
 * (null: none matched); `changed`: false when config.json would stay as it is. Input not mutated. A folder whose name
 * contains `*` or `?` (possible outside Windows) would become a wildcard route: ConfigError.
 */
export function setRoute(c: Config, folder: string, account: string, platform: NodeJS.Platform = process.platform): { config: Config; previous: string | null; before: string | null; changed: boolean } {
  const f = normalizeCwd(folder, platform);
  if (isGlob(f)) {
    throw new ConfigError(`The folder ${f} contains * or ?, which routes in config.json read as wildcards, so t3sm cannot write a route for it. Rename the folder, or write the route in config.json by hand.`);
  }
  const same = (r: Route): boolean => !isGlob(r.match) && sameCwd(r.match, f, platform);
  const previous = c.routes.find(same)?.account ?? null;
  const before = routeAccount(f, c, platform);
  const routes: Route[] = [];
  let placed = false;
  for (const r of c.routes) {
    if (!same(r)) { routes.push(r); continue; }
    if (!placed) { routes.push({ match: f, account }); placed = true; } // the normalised folder, so it matches
  }
  if (!placed) {
    const at = routes.findIndex((r) => isGlob(r.match) && globToRegExp(r.match, platform).test(f));
    routes.splice(at === -1 ? routes.length : at, 0, { match: f, account });
  }
  const mine = routes.findIndex((r) => r.match === f && r.account === account);
  const first = routes.findIndex((r) => globToRegExp(r.match, platform).test(f));
  if (first !== -1 && first < mine) routes.splice(first, 0, routes.splice(mine, 1)[0]!);
  const changed = JSON.stringify(routes) !== JSON.stringify(c.routes);
  return { config: { ...c, routes }, previous, before, changed };
}

/** The folders of `roots` other than `folder` whose account (by routes alone) differs between `before` and `after`. */
export function otherFoldersChanged(before: Config, after: Config, roots: string[], folder: string, platform: NodeJS.Platform = process.platform): string[] {
  return roots.filter((r) => !sameCwd(r, folder, platform) && routeAccount(r, before, platform) !== routeAccount(r, after, platform));
}

/** Removes the exact-folder route(s) of `folder` (never a glob). `removed`: the account it pointed at, or null. */
export function unsetRoute(c: Config, folder: string, platform: NodeJS.Platform = process.platform): { config: Config; removed: string | null } {
  const f = normalizeCwd(folder, platform);
  const hit = (r: Route): boolean => !isGlob(r.match) && sameCwd(r.match, f, platform);
  const removed = c.routes.find(hit)?.account ?? null;
  return { config: { ...c, routes: c.routes.filter((r) => !hit(r)) }, removed };
}

export interface ProjectRow {
  folder: string;
  account: string;
  accountName: string;
  reason: AccountSource;
  /** Sessions the plan would import (or convert) into this project. Without T3 Code: sessions found. */
  pending: number;
  /** null when T3 Code was not read. */
  inT3: "yes" | "archived" | "no" | null;
  /** A session of this project was written in the last 10 minutes (an import waits for it). */
  held: boolean;
}

/**
 * One row per project root of the plan (plan.projectAccounts, sorted by folder). `projects` null: T3 Code was not read
 * (offline table). `names`: account id -> display name.
 */
export function projectRows(plan: Plan, names: Record<string, string>, projects: T3Project[] | null, config: Config, platform: NodeJS.Platform = process.platform): ProjectRow[] {
  const key = (p: string): string => pathKey(p, platform);
  const pending = new Map<string, number>();
  for (const it of plan.items) {
    if (it.action.kind === "skip") continue;
    const k = key(it.action.projectRoot);
    pending.set(k, (pending.get(k) ?? 0) + 1);
  }
  const held = new Set<string>();
  for (const it of plan.items) {
    if (!it.session.flags.includes("active") || it.session.cwd === null) continue;
    held.add(key(resolveRemap(it.session.cwd, config, platform).cwd));
  }
  return plan.projectAccounts.map((p) => {
    const t = projects?.find((x) => !x.deleted && sameCwd(x.workspaceRoot, p.root, platform));
    return {
      folder: p.root, account: p.accountId, accountName: names[p.accountId] ?? p.accountId, reason: p.source,
      pending: pending.get(key(p.root)) ?? 0,
      inT3: projects === null ? null : t === undefined ? "no" : t.archived ? "archived" : "yes",
      held: held.has(key(p.root)),
    };
  });
}
