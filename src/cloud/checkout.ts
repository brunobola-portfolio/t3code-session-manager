// Where a cloud session's code goes on this PC (spec 2026-11-26 §3.5): an existing checkout whose `origin` is the
// session's repository is reused; otherwise it is cloned into `<base>/<owner>/<repo>`. The session's branch is checked
// out in a linked worktree `<base>/.worktrees/<owner>/<repo>/<branch>` (or wherever that branch is already checked out),
// never in the user's own working tree. A session without a repository gets `<base>/cloud-sessions/<short id>`.
//
// Owner, repository and branch come from the cloud: untrusted. Path segments keep [A-Za-z0-9._-] only; every final
// path is checked to be inside the base folder or the reused checkout. git runs with no prompt (GIT_TERMINAL_PROMPT=0),
// a time limit and without CLAUDE_CONFIG_DIR; arguments are passed as an array, never through a shell.

import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeCwd, sameCwd } from "../core/paths.ts";
import { mainCheckoutOf } from "../core/worktree.ts";
import type { CloudRepo, CloudSession } from "./decode.ts";

export const GIT_TIMEOUT_MS = 10 * 60_000;

/** A path segment from an untrusted name, or null when nothing usable is left. */
export function safeSegment(s: string): string | null {
  const t = s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").replace(/-+$/, "").slice(0, 80);
  return t === "" || t === "." || t === ".." ? null : t;
}

/** A branch name git accepts and t3sm is willing to pass on: no leading dash, no control characters, no `..`. */
export function plausibleBranch(b: string): boolean {
  return b !== "" && b.length <= 200 && !b.startsWith("-") && !/[\x00-\x20~^:?*[\\\x7f]/.test(b) && !b.includes("..") && !b.endsWith(".lock") && !b.endsWith("/") && !b.startsWith("/");
}

/** owner/name of a GitHub remote URL (https, ssh or scp form), lowercased for comparison; null for anything else. */
export function githubRepoOf(url: string): CloudRepo | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1]!.toLowerCase(), name: m[2]!.toLowerCase() } : null;
}

const sameRepo = (a: CloudRepo, b: CloudRepo): boolean => a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

/** The `origin` URL in `<root>/.git/config` (read, never by running git); null when it is not a main checkout. */
export async function originOf(root: string): Promise<string | null> {
  let text: string;
  try { text = await readFile(path.join(root, ".git", "config"), "utf8"); } catch { return null; }
  let inOrigin = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { inOrigin = /^remote\s+"origin"$/.test(sec[1]!.trim()); continue; }
    const kv = inOrigin ? /^url\s*=\s*(.+)$/.exec(line) : null;
    if (kv) return kv[1]!.trim();
  }
  return null;
}

/** The first of `roots` that is a main checkout of `repo` (by its origin), or null. */
export async function findCheckout(repo: CloudRepo, roots: readonly string[]): Promise<string | null> {
  for (const r of roots) {
    const url = await originOf(r);
    const got = url === null ? null : githubRepoOf(url);
    if (got && sameRepo(got, repo)) return r;
  }
  return null;
}

export type CheckoutPlan =
  | { kind: "folder"; cwd: string }
  | { kind: "repo"; repo: CloudRepo; main: string; clone: boolean; url: string; branch: string | null; worktree: string | null };

export class CheckoutRefused extends Error {
  override name = "CheckoutRefused";
  readonly reason: "bad-name" | "bad-branch" | "not-a-checkout" | "outside";
  constructor(reason: CheckoutRefused["reason"], message: string) { super(message); this.reason = reason; }
}

const inside = (child: string, parent: string, platform: NodeJS.Platform): boolean => {
  const P = platform === "win32" ? path.win32 : path.posix;
  const rel = P.relative(normalizeCwd(parent, platform), normalizeCwd(child, platform));
  return rel === "" || (!rel.startsWith("..") && !P.isAbsolute(rel));
};

/** The short id shown and used for folders: the part after `session_`, first 12 characters. */
export function shortCloudId(id: string): string {
  return (id.startsWith("session_") ? id.slice(8) : id).slice(0, 12);
}

/**
 * Where the session goes, before anything is created. `existing`: an existing main checkout of its repository (found
 * by findCheckout), or null to use `<base>/<owner>/<repo>`.
 */
export async function planCheckout(s: CloudSession, base: string, existing: string | null, platform: NodeJS.Platform): Promise<CheckoutPlan> {
  const P = platform === "win32" ? path.win32 : path.posix;
  if (s.repo === null) {
    const id = safeSegment(shortCloudId(s.id));
    if (id === null) throw new CheckoutRefused("bad-name", `unusable session id ${s.id}`);
    return { kind: "folder", cwd: P.join(base, "cloud-sessions", id) };
  }
  const owner = safeSegment(s.repo.owner), name = safeSegment(s.repo.name);
  if (owner === null || name === null) throw new CheckoutRefused("bad-name", `unusable repository name ${s.repo.owner}/${s.repo.name}`);
  const url = `https://github.com/${owner}/${name}.git`;
  let main = existing;
  let clone = false;
  if (main === null) {
    main = P.join(base, owner, name);
    const st = await stat(main).catch(() => null);
    if (st !== null) {
      const got = await originOf(main).then((u) => (u === null ? null : githubRepoOf(u)));
      if (!got || !sameRepo(got, s.repo)) throw new CheckoutRefused("not-a-checkout", `${main} exists and is not a checkout of ${owner}/${name}`);
    } else clone = true;
  }
  const branch = s.branch;
  if (branch === null) return { kind: "repo", repo: s.repo, main, clone, url, branch: null, worktree: null };
  if (!plausibleBranch(branch)) throw new CheckoutRefused("bad-branch", `unusable branch name ${JSON.stringify(branch.slice(0, 80))}`);
  const slug = safeSegment(branch.replaceAll("/", "-"));
  if (slug === null) throw new CheckoutRefused("bad-branch", `unusable branch name ${JSON.stringify(branch.slice(0, 80))}`);
  const worktree = P.join(base, ".worktrees", owner, name, slug);
  if (!inside(worktree, base, platform) || (existing === null && !inside(main, base, platform))) throw new CheckoutRefused("outside", "a folder would fall outside the base folder");
  return { kind: "repo", repo: s.repo, main, clone, url, branch, worktree };
}

export interface GitResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
/** Runs `git <args>` (tests pass a fake). */
export type Git = (args: string[]) => Promise<GitResult>;

export class CheckoutFailed extends Error {
  override name = "CheckoutFailed";
  readonly step: "clone" | "fetch" | "worktree" | "folder";
  readonly output: string;
  constructor(step: CheckoutFailed["step"], output: string) {
    super(`git ${step} failed${output ? `: ${output}` : ""}`);
    this.step = step;
    this.output = output;
  }
}

export interface PreparedCheckout {
  /** The session's working folder (its transcript's cwd). */
  cwd: string;
  /** What was created, for the journal (`cloud-checkout`). */
  cloned: string | null;
  worktreeAdded: string | null;
  /** The branch is gone from the remote: the session uses the main checkout. */
  branchGone: boolean;
}

const out = (r: GitResult): string => `${r.stderr}${r.stdout}`.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\r?\n/).filter(Boolean).slice(-4).join(" ").slice(0, 400);
const ok = (r: GitResult): boolean => r.code === 0 && !r.timedOut;

/** Creates what the plan needs: the folder, the clone, the branch and its worktree. Throws CheckoutFailed. */
export async function prepareCheckout(p: CheckoutPlan, git: Git, platform: NodeJS.Platform): Promise<PreparedCheckout> {
  const P = platform === "win32" ? path.win32 : path.posix;
  if (p.kind === "folder") {
    try { await mkdir(p.cwd, { recursive: true }); } catch (e) { throw new CheckoutFailed("folder", (e as Error).message); }
    return { cwd: p.cwd, cloned: null, worktreeAdded: null, branchGone: false };
  }
  let cloned: string | null = null;
  if (p.clone) {
    await mkdir(P.dirname(p.main), { recursive: true });
    const r = await git(["clone", "--", p.url, p.main]);
    if (!ok(r)) throw new CheckoutFailed("clone", out(r));
    cloned = p.main;
  }
  if (p.branch === null || p.worktree === null) return { cwd: p.main, cloned, worktreeAdded: null, branchGone: false };
  const b = p.branch;
  const C = ["-C", p.main];
  const f = await git([...C, "fetch", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`]);
  if (!ok(f)) {
    if (/couldn't find remote ref|not our ref|no such ref/i.test(`${f.stderr}${f.stdout}`)) return { cwd: p.main, cloned, worktreeAdded: null, branchGone: true };
    throw new CheckoutFailed("fetch", out(f));
  }
  // Already checked out somewhere (the main checkout, or an earlier pull's worktree): use that folder.
  const list = await git([...C, "worktree", "list", "--porcelain"]);
  if (ok(list)) {
    let at: string | null = null;
    for (const line of list.stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) at = line.slice(9).trim();
      else if (line.trim() === `branch refs/heads/${b}` && at !== null) {
        const cwd = platform === "win32" ? P.normalize(at) : at;
        return { cwd, cloned, worktreeAdded: null, branchGone: false };
      }
    }
  }
  const there = await stat(p.worktree).catch(() => null);
  if (there !== null) {
    const owner = await mainCheckoutOf(p.worktree);
    // Only a worktree of this checkout that holds this very branch (two branches can share a folder name: a/b, a-b).
    const head = await git(["-C", p.worktree, "symbolic-ref", "--quiet", "HEAD"]);
    if (owner !== null && sameCwd(owner, p.main, platform) && ok(head) && head.stdout.trim() === `refs/heads/${b}`) return { cwd: p.worktree, cloned, worktreeAdded: null, branchGone: false };
    throw new CheckoutFailed("worktree", `${p.worktree} exists and is not a worktree of ${p.main}`);
  }
  await mkdir(P.dirname(p.worktree), { recursive: true });
  const local = await git([...C, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`]);
  const add = ok(local)
    ? await git([...C, "worktree", "add", p.worktree, b])
    : await git([...C, "worktree", "add", "--track", "-b", b, p.worktree, `origin/${b}`]);
  if (!ok(add)) throw new CheckoutFailed("worktree", out(add));
  return { cwd: p.worktree, cloned, worktreeAdded: p.worktree, branchGone: false };
}
