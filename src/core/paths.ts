import path from "node:path";

/**
 * Canonical form of a working directory: forward slashes, no trailing slash,
 * upper-case drive letter, `\\?\` prefix stripped, `.`/`..` resolved.
 * Pure string function: never touches the filesystem. Case is preserved
 * (compare with `sameCwd`).
 */
export function normalizeCwd(p: string, platform: NodeJS.Platform = process.platform): string {
  if (p === "") return p;
  let out: string;
  if (platform === "win32") {
    let s = p;
    if (/^\\\\\?\\UNC\\/i.test(s)) s = "\\\\" + s.slice(8);
    else if (s.startsWith("\\\\?\\")) s = s.slice(4);
    out = path.win32.normalize(s).replace(/\\/g, "/");
    out = out.replace(/^([A-Za-z]):\.$/, "$1:/"); // bare drive "D:" normalizes to "D:."
    out = out.replace(/^([a-z]):/, (_m, d: string) => d.toUpperCase() + ":");
  } else {
    out = path.posix.normalize(p);
  }
  if (out.length > 1 && out.endsWith("/") && !/^[A-Za-z]:\/$/.test(out)) out = out.replace(/\/+$/, "");
  return out;
}

/** Path identity for maps and sets: normalizeCwd, case-folded on Windows and macOS. One definition for every caller. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const n = normalizeCwd(p, platform);
  return platform === "win32" || platform === "darwin" ? n.toLowerCase() : n;
}

export function sameCwd(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const na = normalizeCwd(a, platform);
  const nb = normalizeCwd(b, platform);
  if (platform === "win32" || platform === "darwin") return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}

/** Claude Code's own project-directory rule: every char outside [A-Za-z0-9] becomes "-". */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function trimTrailingSeps(s: string): string {
  return s.replace(/[\\/]+$/, "");
}

export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return trimTrailingSeps(home) + "/" + p.slice(2);
  return p;
}

/** `p` relative to the user home as `~/...` (forward slashes) when it lies inside it; else its normalized form. */
export function tildePath(p: string, home: string, platform: NodeJS.Platform = process.platform): string {
  const n = normalizeCwd(p, platform), h = normalizeCwd(home, platform);
  const fold = platform === "win32" || platform === "darwin";
  const k = (s: string) => (fold ? s.toLowerCase() : s);
  if (k(n) === k(h)) return "~";
  const pre = h.endsWith("/") ? h : h + "/";
  return k(n).startsWith(k(pre)) ? "~/" + n.slice(pre.length) : n;
}

export function stateDir(env: NodeJS.ProcessEnv, home: string): string {
  const override = env["T3SM_HOME"];
  if (override) return override;
  return trimTrailingSeps(home) + "/.t3code-session-manager";
}
