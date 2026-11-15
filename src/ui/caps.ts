// What the terminal can do: colour depth, Unicode, TTY, width. Pure: the environment, platform and stream facts are
// passed in so every screen can be tested under any combination.

export interface Caps {
  color: 0 | 1 | 2 | 3; unicode: boolean; isTTY: boolean; columns: number;
  /** Cursor control (hide/show, "" redraw, clear to end of line): a TTY that is not TERM=dumb. Absent means "as isTTY". */
  cursor?: boolean;
}

/**
 * Whether the terminal draws Unicode symbols. Windows: Windows Terminal, the VS Code terminal and ConEmu do; plain
 * conhost often does not. Elsewhere: a UTF-8 locale (an unset one counts as UTF-8: every current terminal is).
 * TERM=dumb never does.
 */
export function detectUnicode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (env["TERM"] === "dumb") return false;
  if (platform === "win32") return Boolean(env["WT_SESSION"]) || env["TERM_PROGRAM"] === "vscode" || env["ConEmuANSI"] === "ON";
  const loc = env["LC_ALL"] || env["LC_CTYPE"] || env["LANG"];
  if (loc === undefined || loc === "") return true;
  return /utf-?8/i.test(loc);
}

/**
 * Precedence: NO_COLOR and TERM=dumb (0) > FORCE_COLOR (0, 1/true, 2, 3; works without a TTY) > no TTY (0) > the depth
 * the stream reports (`hasColors`) or COLORTERM / TERM / Windows Terminal hints, at least 1.
 */
export function detectCaps(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  s: { isTTY: boolean; columns?: number; hasColors?(n: number): boolean },
): Caps {
  const off = env["TERM"] === "dumb" || Boolean(env["NO_COLOR"]);
  return { color: off ? 0 : colorLevel(env, platform, s), unicode: detectUnicode(env, platform), isTTY: s.isTTY, columns: s.columns || 80, cursor: s.isTTY && env["TERM"] !== "dumb" };
}

function colorLevel(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, s: { isTTY: boolean; hasColors?(n: number): boolean }): 0 | 1 | 2 | 3 {
  const force = env["FORCE_COLOR"];
  if (force !== undefined && force !== "") {
    if (force === "0" || force === "false") return 0;
    if (force === "2") return 2;
    if (force === "3") return 3;
    return 1;
  }
  if (!s.isTTY) return 0;
  if (typeof s.hasColors === "function") {
    try {
      if (s.hasColors(2 ** 24)) return 3;
      if (s.hasColors(256)) return 2;
      if (s.hasColors(16)) return 1;
    } catch { /* fall through to the hints */ }
  }
  const ct = env["COLORTERM"];
  if (ct === "truecolor" || ct === "24bit" || (platform === "win32" && env["WT_SESSION"])) return 3;
  if (/256color/i.test(env["TERM"] ?? "")) return 2;
  return 1;
}
