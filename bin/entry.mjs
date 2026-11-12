// Which entry point bin/t3sm.mjs runs. A checkout (src/ next to bin/, not inside node_modules) runs the TypeScript
// sources directly (Node type stripping), so a stale gitignored dist/ can never shadow them; an installed package
// runs its compiled dist/. Neither present: the caller tells the user to build.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @param {URL} binUrl URL of bin/t3sm.mjs
 * @param {(u: URL) => boolean} [exists]
 * @returns {{ kind: "src" | "dist"; url: string } | { kind: "none" }}
 */
export function resolveEntry(binUrl, exists = (u) => existsSync(u)) {
  const src = new URL("../src/cli/main.ts", binUrl);
  const dist = new URL("../dist/cli/main.js", binUrl);
  const installed = fileURLToPath(new URL("..", binUrl)).split(/[\\/]+/).includes("node_modules");
  if (!installed && exists(src)) return { kind: "src", url: src.href };
  if (exists(dist)) return { kind: "dist", url: dist.href };
  return { kind: "none" };
}
