import type { FolderCategory } from "../core/types.ts";
import { pathKey } from "../core/paths.ts";

export interface FolderEnv {
  platform: NodeJS.Platform;
  home: string;
  tmpdir: string;
  env: NodeJS.ProcessEnv;
  /** T3 Code base dir (default `~/.t3`; the caller fills it). */
  t3BaseDir: string;
  /** T3 Code worktrees dir (default `~/.t3/worktrees`). */
  t3WorktreesDir: string;
}

function key(p: string, e: FolderEnv): string {
  return pathKey(p, e.platform);
}

function isInside(k: string, rootKey: string): boolean {
  if (rootKey === "") return false;
  return k.startsWith(rootKey.endsWith("/") ? rootKey : rootKey + "/");
}

function isUnderOrEqual(k: string, rootKey: string): boolean {
  return k === rootKey || isInside(k, rootKey);
}

function envVar(e: FolderEnv, name: string): string | undefined {
  const direct = e.env[name];
  if (direct) return direct;
  if (e.platform !== "win32") return undefined;
  const hit = Object.keys(e.env).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit ? e.env[hit] : undefined;
}

function homeSub(e: FolderEnv, sub: string): string {
  return key(e.home.replace(/[\\/]+$/, "") + "/" + sub, e);
}

function isHome(k: string, e: FolderEnv): boolean {
  return k === key(e.home, e);
}

/** The T3 rules except `home`: exact tmpdir, `/tmp`, `/private/tmp`; prefix Downloads, Documents/Codex, T3 base, T3 worktrees. */
function isRefusedNotHome(k: string, e: FolderEnv): boolean {
  if ([key(e.tmpdir, e), key("/tmp", e), key("/private/tmp", e)].includes(k)) return true;
  const ancestors = [homeSub(e, "Downloads"), homeSub(e, "Documents/Codex"), key(e.t3BaseDir, e), key(e.t3WorktreesDir, e)];
  return ancestors.some((a) => isUnderOrEqual(k, a));
}

/** Mirror of T3 Code 0.1.10 `AgentSessionScanner.isExcludedProjectPath`: folders T3 never imports (home included). */
export function isT3Refused(cwd: string, e: FolderEnv): boolean {
  const k = key(cwd, e);
  return isHome(k, e) || isRefusedNotHome(k, e);
}

function isTemp(k: string, e: FolderEnv): boolean {
  if (isInside(k, key(e.tmpdir, e)) || isInside(k, key("/tmp", e)) || isInside(k, key("/private/tmp", e))) return true;
  if (/^[a-z]:\/(tmp|temp)(\/|$)/i.test(k)) return true;
  return k.split("/").some((s) => s.toLowerCase() === "scratchpad");
}

function isSystem(k: string, e: FolderEnv): boolean {
  if (e.platform === "win32") {
    const roots = [envVar(e, "WINDIR"), envVar(e, "ProgramFiles"), envVar(e, "ProgramFiles(x86)"), envVar(e, "ProgramData")]
      .filter((r): r is string => !!r)
      .map((r) => key(r, e));
    roots.push(homeSub(e, "AppData"));
    return roots.some((r) => isUnderOrEqual(k, r));
  }
  return ["/usr", "/etc", "/System", "/Library", "/opt"].some((r) => isUnderOrEqual(k, key(r, e)));
}

/** First match wins: home, t3-refused, temp, system, project. */
export function classifyFolder(cwd: string, e: FolderEnv): FolderCategory {
  const k = key(cwd, e);
  if (isHome(k, e)) return "home";
  if (isRefusedNotHome(k, e)) return "t3-refused";
  if (isTemp(k, e)) return "temp";
  if (isSystem(k, e)) return "system";
  return "project";
}
