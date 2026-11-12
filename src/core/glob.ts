/**
 * Compile a path glob to a RegExp. Match it against `normalizeCwd` output.
 * `**` crosses `/`, `*` and `?` stay within one segment. Case-insensitive on win32.
 */
export function globToRegExp(glob: string, platform: NodeJS.Platform = process.platform): RegExp {
  const g = platform === "win32" ? glob.replace(/\\/g, "/") : glob;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        const before = i === 0 || g[i - 1] === "/";
        const after = g[i + 2];
        if (before && after === "/") {
          re += "(?:.*/)?"; // "**/": zero or more directories
          i += 2;
        } else if (before && after === undefined && i > 0) {
          re = re.replace(/\/$/, "") + "(?:/.*)?"; // trailing "/**"
          i += 1;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$", platform === "win32" ? "i" : "");
}
