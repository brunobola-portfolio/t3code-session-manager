// What t3sm build this is, and what build an install root holds now. The background watcher records its own stamp at
// start and compares it with the install root's after every cycle: a different one means a newer t3sm was installed
// (or the checkout was updated), and the watcher restarts into it (src/ops/watch.ts, src/cli/commands/sync.ts).
//
// The stamp: an installed package (it runs dist/) has dist/build.json `{version, builtAt}` written by scripts/build.js,
// and its stamp is builtAt; a checkout (it runs src/; same rule as bin/entry.mjs) is stamped `checkout:<package.json
// mtimeMs>`. The version always comes from package.json.

import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface InstallStamp { version: string; stamp: string }

/** This install's root: the folder holding package.json, bin/ and src/ or dist/ (two levels above src/core, dist/core). */
export function installRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

/** This install's version, read fresh from package.json. */
export function packageVersion(): string {
  try { return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0"; } catch { return "0.0.0"; }
}

/** A checkout runs src/ (src/ next to bin/, not inside node_modules); everything else runs dist/ (bin/entry.mjs). */
function isCheckout(root: string): boolean {
  return !root.split(/[\\/]+/).includes("node_modules") && existsSync(join(root, "src", "cli", "main.ts"));
}

/** The file whose content (dist) or time (checkout) makes the stamp. */
function stampFile(root: string): string {
  return isCheckout(root) ? join(root, "package.json") : join(root, "dist", "build.json");
}

/** What `root` holds now. Throws when package.json or (for an installed package) dist/build.json cannot be read. */
export function installStamp(root: string): InstallStamp {
  const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = pkg && typeof pkg === "object" ? (pkg as { version?: unknown }).version : undefined;
  if (typeof version !== "string" || version === "") throw new Error(`${join(root, "package.json")} has no version`);
  if (isCheckout(root)) return { version, stamp: `checkout:${statSync(join(root, "package.json")).mtimeMs}` };
  const b: unknown = JSON.parse(readFileSync(join(root, "dist", "build.json"), "utf8"));
  const builtAt = b && typeof b === "object" ? (b as { builtAt?: unknown }).builtAt : undefined;
  if (typeof builtAt !== "string" || builtAt === "") throw new Error(`${join(root, "dist", "build.json")} has no builtAt`);
  return { version, stamp: builtAt };
}

/**
 * When the stamp file last changed on this disk (the later of its mtime and ctime: npm packs files with a fixed 1985
 * mtime, but extracting them moves the ctime), or null when it cannot be read. `doctor` uses it to tell a watcher that
 * has not had a cycle to notice a new install yet from one that does not restart.
 */
export function installChangedAt(root: string): number | null {
  try {
    const st = statSync(stampFile(root));
    return Math.max(st.mtimeMs, st.ctimeMs);
  } catch { return null; }
}

/** How long a new install's stamp file must be left alone before the watcher restarts into it. */
export const INSTALL_SETTLE_MS = 30_000;

/**
 * Whether `root` looks complete and settled enough to restart into: bin/t3sm.mjs and, for an installed package,
 * dist/cli/main.js exist, and the stamp file last changed at least INSTALL_SETTLE_MS before `now` (npm may still be
 * writing the rest). Not ready: the watcher keeps running and looks again after its next cycle.
 */
export function installReady(root: string, now: number): boolean {
  if (!existsSync(join(root, "bin", "t3sm.mjs"))) return false;
  if (!isCheckout(root) && !existsSync(join(root, "dist", "cli", "main.js"))) return false;
  const at = installChangedAt(root);
  return at !== null && now - at >= INSTALL_SETTLE_MS;
}
