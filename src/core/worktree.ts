// Linked git worktrees, read from the files git keeps (never by running git). T3 Code imports the sessions of a linked
// worktree together with its main checkout (upstream 2026-11-13, AgentSessionScanner `belongsToRoot`), so the importer
// must know which folders belong to a root. Anything unreadable counts as "not a worktree".

import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const WORKTREE_GIT_DIR = /[\\/]worktrees[\\/][^\\/]+[\\/]?$/;

const read = async (file: string): Promise<string> => (await readFile(file, "utf8").catch(() => "")).trim();

/** The main checkout of the linked worktree at `dir`; null when `dir` is not the root of one, or its repository is bare. */
export async function mainCheckoutOf(dir: string): Promise<string | null> {
  const target = /^gitdir:\s*(.+)$/m.exec(await read(join(dir, ".git")))?.[1]?.trim();
  if (!target) return null;
  const gitDir = resolve(dir, target);
  if (!WORKTREE_GIT_DIR.test(gitDir)) return null;
  const common = await read(join(gitDir, "commondir"));
  if (common === "") return null;
  const commonDir = resolve(gitDir, common);
  // Only a common dir named .git sits inside its main checkout.
  return basename(commonDir) === ".git" ? dirname(commonDir) : null;
}

/** The folders of the linked worktrees of the main checkout at `root` (git's own list; some may be gone). */
export async function linkedWorktreesOf(root: string): Promise<string[]> {
  const base = join(root, ".git", "worktrees");
  const out: string[] = [];
  for (const name of await readdir(base).catch(() => [] as string[])) {
    const pointer = await read(join(base, name, "gitdir"));
    if (pointer !== "") out.push(dirname(resolve(base, name, pointer)));
  }
  return out;
}
