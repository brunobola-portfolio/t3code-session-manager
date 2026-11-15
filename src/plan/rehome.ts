import { normalizeCwd, pathKey } from "../core/paths.ts";
import { scanJsonl } from "../sources/jsonl.ts";

export interface RehomeGuess { root: string; hits: number; total: number; share: number }

const PATH_FIELDS = ["file_path", "path", "notebook_path", "cwd"] as const;
// `cd <path>` at the start of a command or after ; & | ( or a newline; `cd /d` (cmd.exe) allowed; quoted or bare.
const CD_RE = /(?:^|[;&|(\n]\s*)cd\s+(?:\/[dD]\s+)?(?:"([^"]*)"|'([^']*)'|([^\s;&|"')]+))/g;
// PowerShell (tool `PowerShell`): `Set-Location [-Path | -LiteralPath] <path>` or `cd <path>`, any case.
const PS_CD_RE = /(?:^|[;&|({\n]\s*)(?:set-location|cd)\s+(?:-(?:literal)?path\s+)?(?:"([^"]*)"|'([^']*)'|([^\s;&|"')}]+))/gi;
// Git Bash on Windows spells a drive `/d/...`: the drive letter alone, then a slash or the end.
const GIT_BASH_DRIVE_RE = /^\/([A-Za-z])(\/.*)?$/;

/** A `cd` target as Windows reads it: Git Bash's `/d/work` is `D:/work`, `/c` is `C:/` (win32 only; elsewhere unchanged). */
function cdTarget(p: string | undefined, platform: NodeJS.Platform): string | undefined {
  if (p === undefined || platform !== "win32") return p;
  const m = GIT_BASH_DRIVE_RE.exec(p);
  return m ? `${m[1]!.toUpperCase()}:${m[2] ?? "/"}` : p;
}

function isAbs(p: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("//");
  return p.startsWith("/");
}

const asObj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Guess which known project a transcript really worked on (used for sessions whose recorded folder is the home
 * folder, which T3 refuses).
 *
 * What is counted: every absolute path found in the transcript, once per occurrence: record `cwd`, tool_use inputs
 * (`file_path`, `path`, `notebook_path`, `cwd`), `cd <path>` in Bash commands (on Windows, Git Bash's `/d/...` is
 * `D:/...`) and `Set-Location` / `cd <path>` in PowerShell commands. Relative paths are ignored.
 * `total` = all those paths EXCEPT ones equal to the home folder exactly (the home cwd repeats on every record and
 * would drown the share); paths merely inside home still count towards `total`. `hits` for a root = paths equal to
 * or inside it, attributed to the deepest matching known root. The top root is returned when
 * `hits >= minHits` (default 5) and `hits / total >= minShare` (default 0.6); a tie for the top gives null.
 */
export async function inferProjectRoot(
  file: string,
  knownRoots: string[],
  o: { platform: NodeJS.Platform; home: string; minShare?: number; minHits?: number },
): Promise<RehomeGuess | null> {
  const { platform } = o;
  const minShare = o.minShare ?? 0.6;
  const minHits = o.minHits ?? 5;
  const homeKey = pathKey(o.home, platform);
  const roots = new Map<string, string>(); // key -> normalized root as given
  for (const r of knownRoots) {
    if (r !== "" && isAbs(r, platform)) roots.set(pathKey(r, platform), normalizeCwd(r, platform));
  }
  const keys = [...roots.keys()].sort((a, b) => b.length - a.length); // deepest first
  const counts = new Map<string, number>();
  let total = 0;

  const add = (p: unknown): void => {
    if (typeof p !== "string" || p === "" || !isAbs(p, platform)) return;
    const k = pathKey(p, platform);
    if (k === homeKey) return;
    total++;
    for (const r of keys) {
      const prefix = r.endsWith("/") ? r : r + "/";
      if (k === r || k.startsWith(prefix)) {
        counts.set(r, (counts.get(r) ?? 0) + 1);
        return;
      }
    }
  };

  await scanJsonl(file, {}, (rec) => {
    add(rec["cwd"]);
    const content = asObj(rec["message"])?.["content"];
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const b = asObj(block);
      if (!b || b["type"] !== "tool_use") continue;
      const input = asObj(b["input"]);
      if (!input) continue;
      for (const f of PATH_FIELDS) add(input[f]);
      if (typeof input["command"] !== "string") continue;
      if (b["name"] === "Bash") {
        for (const m of input["command"].matchAll(CD_RE)) add(cdTarget(m[1] ?? m[2] ?? m[3], platform));
      } else if (b["name"] === "PowerShell") {
        for (const m of input["command"].matchAll(PS_CD_RE)) add(m[1] ?? m[2] ?? m[3]);
      }
    }
  });

  let best: string | null = null;
  let bestN = 0;
  let tie = false;
  for (const [r, n] of counts) {
    if (n > bestN) { best = r; bestN = n; tie = false; } else if (n === bestN) tie = true;
  }
  if (best === null || tie || total === 0) return null;
  const share = bestN / total;
  if (bestN < minHits || share < minShare) return null;
  return { root: roots.get(best)!, hits: bestN, total, share };
}
