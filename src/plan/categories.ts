// Where a session goes by its folder and session categories (spec §4.1–§4.4): imported as is, skipped (and why), or
// rehomed (a copy imported into another project, because T3 Code refuses its folder). Pure: the planner applies it.

import type { Config, DiscoveredSession, FolderCategory, OrganizeConfig, SkipReason } from "../core/types.ts";
import { isDecided, organizeSettings } from "../core/config.ts";
import { globToRegExp } from "../core/glob.ts";
import { expandHome, normalizeCwd, sameCwd } from "../core/paths.ts";
import { classifyFolder, isT3Refused, type FolderEnv } from "./folders.ts";

/** The questions (`organize.decided` keys) a plan can find unanswered, in report order. */
export type PendingKey = Exclude<FolderCategory, "project"> | "automated" | "orphaned";
export const PENDING_KEYS: readonly PendingKey[] = ["home", "t3-refused", "temp", "system", "automated", "orphaned"];

export type Route =
  /** Imported from its own folder (the planner's usual path). */
  | { kind: "native" }
  /**
   * Skipped for `reason`; `pending`: only because that question was never answered. `badTarget`: a `rehome:<folder>`
   * override naming a folder no T3 Code project can be in (refused, temp or system): the planner warns about it.
   */
  | { kind: "skip"; reason: SkipReason; pending?: PendingKey; badTarget?: string }
  /** A copy goes to another project: `target` (an override's folder), or null = inferred, else the General folder. */
  | { kind: "rehome"; target: string | null };

export interface CategoryRules {
  organize: OrganizeConfig;
  folderEnv: FolderEnv;
  /** The General folder, expanded and normalized. */
  generalFolder: string;
  decided(key: PendingKey): boolean;
  overrides: { re: RegExp; action: OrganizeConfig["overrides"][number]["action"] }[];
}

/** The default General folders (`organize.generalFolder` unset), one per language. */
export const DEFAULT_GENERAL_FOLDERS = { pt: "~/T3 Geral", en: "~/T3 General" } as const;

/**
 * The one General folder (ruling R10): `organize.generalFolder` when set; else a live T3 project already at a default
 * General folder (either language: `lang`'s first), reused as it is; else `lang`'s default. Expanded and normalized.
 */
export function resolveGeneralFolder(config: Config, lang: "en" | "pt", liveRoots: string[], o: { platform: NodeJS.Platform; home: string }): string {
  const norm = (p: string): string => normalizeCwd(expandHome(p, o.home), o.platform);
  if (config.organize?.generalFolder !== undefined) return norm(config.organize.generalFolder);
  const other = lang === "pt" ? "en" : "pt";
  for (const d of [DEFAULT_GENERAL_FOLDERS[lang], DEFAULT_GENERAL_FOLDERS[other]]) {
    const hit = liveRoots.find((r) => sameCwd(r, norm(d), o.platform));
    if (hit !== undefined) return normalizeCwd(hit, o.platform);
  }
  return norm(DEFAULT_GENERAL_FOLDERS[lang]);
}

/** `generalFolder`: the resolved General folder (resolveGeneralFolder); default: `organize.generalFolder` for `lang`. */
export function categoryRules(config: Config, lang: "en" | "pt", folderEnv: FolderEnv, generalFolder?: string): CategoryRules {
  const organize = organizeSettings(config, lang);
  const { platform, home } = folderEnv;
  return {
    organize, folderEnv,
    generalFolder: generalFolder ?? normalizeCwd(expandHome(organize.generalFolder, home), platform),
    decided: (k) => isDecided(config, k),
    overrides: organize.overrides.map((o) => ({ re: globToRegExp(expandHome(o.match, home), platform), action: o.action })),
  };
}

const SKIP_REASON: Record<Exclude<FolderCategory, "project">, SkipReason> = {
  home: "t3-refused", "t3-refused": "t3-refused", temp: "temp-folder", system: "system-folder",
};

/**
 * The route of a session whose (effective, normalized) folder is `cwd`. Rules, in order:
 * 1. `automated` sessions: skipped while `sessions.automated` is "skip" (or undecided).
 * 2. The first `overrides` rule matching the folder wins over its category ("skip" = excluded).
 * 3. `project` folders are imported as is; any other category waits for its question, then follows `folders`.
 * A folder T3 Code refuses (home, t3-refused) is never imported as is: "import" there means a rehomed copy, and a
 * session t3sm cannot copy (`canCopy` false: Pi) is skipped `t3-refused`.
 */
export function routeOf(s: Pick<DiscoveredSession, "origin">, cwd: string, r: CategoryRules, canCopy: boolean): Route {
  if (s.origin === "automated") {
    if (!r.decided("automated")) return { kind: "skip", reason: "undecided", pending: "automated" };
    if (r.organize.sessions.automated === "skip") return { kind: "skip", reason: "automated" };
  }
  const refused = isT3Refused(cwd, r.folderEnv);
  const rehome = (target: string | null): Route => {
    if (canCopy) return { kind: "rehome", target };
    return refused ? { kind: "skip", reason: "t3-refused" } : { kind: "native" };
  };
  const o = r.overrides.find((x) => x.re.test(cwd));
  if (o) {
    if (o.action === "skip") return { kind: "skip", reason: "excluded" };
    if (o.action === "import") return refused ? rehome(null) : { kind: "native" };
    const { platform, home } = r.folderEnv;
    const target = normalizeCwd(expandHome(o.action.slice("rehome:".length).trim(), home), platform);
    // Never a destination T3 Code would refuse, nor a temp or system folder (spec 4.3, 3.4).
    if (canCopy && classifyFolder(target, r.folderEnv) !== "project") return { kind: "skip", reason: "t3-refused", badTarget: o.action.slice("rehome:".length).trim() };
    return rehome(target);
  }
  const cat = classifyFolder(cwd, r.folderEnv);
  if (cat === "project") return { kind: "native" };
  if (refused && !canCopy) return { kind: "skip", reason: "t3-refused" }; // whatever the answer
  if (!r.decided(cat)) return { kind: "skip", reason: "undecided", pending: cat };
  const action = r.organize.folders[cat];
  if (action === "skip") return { kind: "skip", reason: SKIP_REASON[cat] };
  if (action === "import" && !refused) return { kind: "native" };
  return rehome(null);
}
