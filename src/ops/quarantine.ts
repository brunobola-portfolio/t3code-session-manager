// Reversible quarantine of backup folders and mirror copies (spec §4.3 rule 4).
// Writing functions here REQUIRE the caller to hold the state-dir lock (acquireLock) and to have run
// recoverPendingMtimes first; they never take the lock themselves.
//
// Every move stays inside one account home (same volume) and never replaces anything (moveEntry): a FILE moves by
// hard link + unlink (EEXIST at the destination = nothing changed), a DIRECTORY by rename after checking the target is
// free (a non-empty target makes rename fail). File times, contents and ACLs travel with the entry. Cross-device
// (EXDEV) or a filesystem without hard links aborts that item; t3sm never copies and deletes. Each move is journaled
// (`quarantined`) right AFTER it succeeds; if the journal cannot be written the entry is moved back and the error
// aborts the command, so nothing ever sits in quarantine without a journal line that can undo it.

import { link, lstat, mkdir, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { AccountConfig, JournalEntry, Plan } from "../core/types.ts";
import type { Journal } from "../core/journal.ts";
import { expandHome, normalizeCwd, pathKey, sameCwd } from "../core/paths.ts";
import { ACTIVE_WINDOW_MS, isActive } from "../core/activity.ts";
import { MoveRefused, publishNoClobber } from "../core/fsutil.ts";
import { compareCopies } from "../plan/ownership.ts";

export const QUARANTINE_DIR = "session-manager-quarantine";

/** The filesystem calls a move uses; injected by tests (EXDEV, a file appearing at the destination). */
export interface MoveFs {
  rename(from: string, to: string): Promise<void>;
  link(existing: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface MoveOptions {
  fs?: MoveFs;
  now?: () => number;
  /** Run every check and report the targets, but move and journal nothing. */
  dryRun?: boolean;
  platform?: NodeJS.Platform;
  /** Expands `~` in account homes (dedupe). */
  home?: string;
}

export interface MoveReport {
  /** In order of the moves (a dedupe item's sidecar folder follows its file). */
  moved: { from: string; to: string }[];
  skipped: { path: string; reason: string }[];
}

/** The journal could not be written around a move. Aborts the command (exit 1). */
export class JournalWriteError extends Error {
  override name = "JournalWriteError";
}

/** A move refused before anything changed: destination exists, other drive, no hard links (shared with fsutil). */
export { MoveRefused };

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function retrying<T>(fn: () => Promise<T>, retryable: Set<string>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!retryable.has(code) || attempt >= 4) throw e;
      await sleep(25 * (attempt + 1));
    }
  }
}

/** node:fs with a few retries for the transient sharing errors Windows raises (antivirus, indexer). */
export const nodeMoveFs: MoveFs = {
  rename: (a, b) => retrying(() => rename(a, b), RETRYABLE),
  link: (a, b) => retrying(() => link(a, b), new Set(["EBUSY"])),
  unlink: (p) => retrying(() => unlink(p), RETRYABLE),
};

const errCode = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function lstatOrNull(p: string) {
  try {
    return await lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Moves `from` to `to` without ever replacing an existing entry (node's rename replaces a target FILE).
 * File: link(from, to) then unlink(from); EEXIST -> MoveRefused, nothing changed; no hard-link support -> MoveRefused.
 * Directory: refused when `to` exists, else rename (a non-empty target makes rename fail anyway).
 * The parent of `to` must exist.
 */
export async function moveEntry(from: string, to: string, fs: MoveFs = nodeMoveFs): Promise<void> {
  const st = await lstat(from);
  if (st.isDirectory()) {
    if ((await lstatOrNull(to)) !== null) throw new MoveRefused(`${to} already exists; nothing was changed`, "EEXIST");
    try {
      await fs.rename(from, to);
    } catch (e) {
      const code = errCode(e);
      if (code === "EEXIST" || code === "ENOTEMPTY") throw new MoveRefused(`${to} already exists; nothing was changed`, "EEXIST");
      throw e;
    }
    return;
  }
  await publishNoClobber(from, to, fs);
}

/** Human reason for a failed move. */
export function moveFailure(e: unknown): string {
  if (e instanceof MoveRefused) return e.message;
  const code = errCode(e);
  if (code === "EXDEV") return "on another drive than its account home (EXDEV); not moved (t3sm never copies and deletes)";
  return `could not move (${code})`;
}

const BACKUP_RE = /\.bak(-\d{8}-\d{6})?$/;

export function isBackupDirName(name: string): boolean {
  return name.startsWith(".bak-") || BACKUP_RE.test(name);
}

/** Direct children of `<accountHome>/projects` that are backup folders (`.bak-*` or `*.bak[-YYYYMMDD-HHMMSS]`). */
export async function findBackupDirs(accountHome: string): Promise<string[]> {
  const projects = join(accountHome, "projects");
  let ents;
  try {
    ents = await readdir(projects, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
  return ents.filter((e) => e.isDirectory() && isBackupDirName(e.name)).map((e) => join(projects, e.name)).sort();
}

/** First file under `dir` (symlinks not followed) modified after `cutoff`, relative to `dir`; null if none. */
async function findActive(dir: string, cutoff: number): Promise<string | null> {
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      const st = await lstatOrNull(p);
      if (st && st.mtimeMs > cutoff) return p.slice(dir.length + 1);
    }
  }
  return null;
}

const foldsCase = (platform: NodeJS.Platform): boolean => platform === "win32" || platform === "darwin";

function key(p: string, platform: NodeJS.Platform): string {
  return pathKey(p, platform);
}

/** `child` lies strictly inside directory `parent` (path identity per platform). */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const c = key(child, platform), p = key(parent, platform);
  return c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

/** A raw path string with a `..` segment (journal entries carrying one are never acted on). */
export function hasDotDot(p: string): boolean {
  return p.split(/[\\/]+/).includes("..");
}

/**
 * `dir` relative to `parent` ("/"-separated, original case of `dir`), compared case-insensitively on win32/darwin.
 * "" when they are the same folder; null when `dir` is not inside `parent` or the result would be absolute or climb
 * (`..`). Never path.relative: posix relative is case-sensitive, so a darwin case variant would climb out.
 */
export function subdirOf(parent: string, dir: string, platform: NodeJS.Platform = process.platform): string | null {
  const fold = foldsCase(platform);
  const p = normalizeCwd(parent, platform), d = normalizeCwd(dir, platform);
  const pk = fold ? p.toLowerCase() : p;
  if ((fold ? d.toLowerCase() : d) === pk) return "";
  const prefix = pk.endsWith("/") ? pk : `${pk}/`;
  const head = d.slice(0, prefix.length);
  if ((fold ? head.toLowerCase() : head) !== prefix) return null; // also catches case folding that changes length
  const rel = d.slice(prefix.length);
  if (rel === "" || rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || rel.split("/").some((s) => s === ".." || s === "." || s === "")) return null;
  return rel;
}

interface Ctx { fs: MoveFs; j: Journal; runId: string; reserved: Set<string>; platform: NodeJS.Platform }

/**
 * The first suffix ("", "-2", "-3", ...) for which every name built by `names(sfx)` is free in `dir` (on disk and
 * not reserved earlier in this run, which matters for dry runs).
 */
async function pickFree(dir: string, names: (sfx: string) => string[], ctx: Ctx): Promise<string[]> {
  for (let n = 1; n < 100_000; n++) {
    const sfx = n === 1 ? "" : `-${n}`;
    const paths = names(sfx).map((x) => join(dir, x));
    let free = true;
    for (const p of paths) {
      if (ctx.reserved.has(key(p, ctx.platform)) || (await lstatOrNull(p)) !== null) { free = false; break; }
    }
    if (free) {
      for (const p of paths) ctx.reserved.add(key(p, ctx.platform));
      return paths;
    }
  }
  throw new Error(`no free name in ${dir}`);
}

/** Move, then journal; a failed journal write moves the entry back (no-clobber) and throws JournalWriteError. */
async function moveAndJournal(from: string, to: string, reason: "backup-dir" | "mirror-copy", ctx: Ctx): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await moveEntry(from, to, ctx.fs);
  try {
    await ctx.j.append({ t: "quarantined", runId: ctx.runId, from, to, reason } satisfies JournalEntry);
  } catch (e) {
    try {
      await moveEntry(to, from, ctx.fs);
    } catch (back) {
      throw new JournalWriteError(`Could not write the journal (${msg(e)}) and could not move ${to} back to ${from} (${moveFailure(back)}). Move it back by hand.`);
    }
    throw new JournalWriteError(`Could not write the journal (${msg(e)}); ${from} was left in place.`);
  }
}

function ctxOf(j: Journal, runId: string, opts: MoveOptions): Ctx {
  return { fs: opts.fs ?? nodeMoveFs, j, runId, reserved: new Set(), platform: opts.platform ?? process.platform };
}

/**
 * Moves backup folders of one account to `<accountHome>/session-manager-quarantine/backups/<name>` (collisions get
 * `-2`, `-3`). Skips (and reports) a folder that is not a backup child of `<accountHome>/projects`, is missing, or
 * holds a file changed within ACTIVE_WINDOW_MS. Throws only JournalWriteError (after moving the folder back).
 */
export async function quarantine(dirs: string[], accountHome: string, j: Journal, runId: string, opts: MoveOptions = {}): Promise<MoveReport> {
  const ctx = ctxOf(j, runId, opts);
  const now = opts.now ?? Date.now;
  const report: MoveReport = { moved: [], skipped: [] };
  const projects = join(accountHome, "projects");
  const dest = join(accountHome, QUARANTINE_DIR, "backups");
  for (const dir of dirs) {
    const skip = (reason: string): void => void report.skipped.push({ path: dir, reason });
    try {
      if (!sameCwd(dirname(dir), projects, ctx.platform) || !isBackupDirName(basename(dir))) { skip(`not a backup folder of ${accountHome}`); continue; }
      const st = await lstatOrNull(dir);
      if (st === null) { skip("missing"); continue; }
      if (!st.isDirectory()) { skip("not a folder"); continue; }
      const live = await findActive(dir, now() - ACTIVE_WINDOW_MS);
      if (live !== null) { skip(`active (${live} changed in the last 10 minutes)`); continue; }
      const [to] = await pickFree(dest, (sfx) => [basename(dir) + sfx], ctx);
      if (!opts.dryRun) await moveAndJournal(dir, to!, "backup-dir", ctx);
      report.moved.push({ from: dir, to: to! });
    } catch (e) {
      if (e instanceof JournalWriteError) throw e;
      skip(moveFailure(e));
    }
  }
  return report;
}

/**
 * Moves each plan mirror copy to `<its account home>/session-manager-quarantine/mirror/<encoded project dir>/<file>`,
 * together with its sidecar folder (`<stem>/`, subagents and tool results) when one exists. Right before moving it
 * re-checks: the copy still exists and is not active, the kept copy still exists, and the copy is still identical to
 * or a prefix of the kept one (compareCopies). Forks are never moved. Throws only JournalWriteError.
 */
export async function dedupe(copies: Plan["mirrorCopies"], accounts: AccountConfig[], j: Journal, runId: string, opts: MoveOptions = {}): Promise<MoveReport> {
  const ctx = ctxOf(j, runId, opts);
  const now = opts.now ?? Date.now;
  const home = opts.home ?? homedir();
  const report: MoveReport = { moved: [], skipped: [] };
  for (const c of copies) {
    const skip = (reason: string): void => void report.skipped.push({ path: c.path, reason });
    if (typeof c.path !== "string" || typeof c.keptPath !== "string" || hasDotDot(c.path) || hasDotDot(c.keptPath)) { skip("invalid plan entry"); continue; }
    const acct = accounts.map((a) => expandHome(a.home, home)).find((h) => isInside(c.path, join(h, "projects"), ctx.platform));
    if (acct === undefined) { skip("not inside a configured account's projects folder"); continue; }
    const rel = subdirOf(join(acct, "projects"), dirname(c.path), ctx.platform);
    if (rel === null) { skip("not inside a configured account's projects folder"); continue; }
    try {
      const st = await lstatOrNull(c.path);
      if (st === null) { skip("missing"); continue; }
      if (!st.isFile()) { skip("not a file"); continue; }
      if (isActive(st.mtimeMs, now())) { skip("active"); continue; }
      if (sameCwd(c.path, c.keptPath, ctx.platform)) { skip("kept copy is the same file"); continue; }
      if ((await lstatOrNull(c.keptPath)) === null) { skip("kept copy missing"); continue; }
      let relation;
      try {
        relation = await compareCopies(c.path, c.keptPath, ctx.platform);
      } catch (e) {
        skip(`compare failed (${errCode(e)})`);
        continue;
      }
      if (relation !== "identical" && relation !== "b-extends-a") { skip("no longer a mirror"); continue; }

      const ext = extname(c.path);
      const stem = basename(c.path, ext);
      const sidecarPath = join(dirname(c.path), stem);
      const side = await lstatOrNull(sidecarPath);
      const sidecar = side !== null && side.isDirectory() ? sidecarPath : null;
      if (sidecar !== null) {
        const live = await findActive(sidecar, now() - ACTIVE_WINDOW_MS);
        if (live !== null) { skip(`active (${live} changed in the last 10 minutes)`); continue; }
      }
      const destDir = join(acct, QUARANTINE_DIR, "mirror", ...(rel === "" ? [] : rel.split("/")));
      const [to, sideTo] = await pickFree(destDir, (sfx) => (sidecar ? [stem + sfx + ext, stem + sfx] : [stem + sfx + ext]), ctx);
      // Changed while it was being compared (the session resumed): leave it for the next run.
      const again = await lstatOrNull(c.path);
      if (again === null || again.mtimeMs !== st.mtimeMs || again.size !== st.size) { skip("changed while checking"); continue; }
      if (opts.dryRun) {
        report.moved.push({ from: c.path, to: to! });
        if (sidecar) report.moved.push({ from: sidecar, to: sideTo! });
        continue;
      }
      await moveAndJournal(c.path, to!, "mirror-copy", ctx);
      if (sidecar) {
        try {
          await moveAndJournal(sidecar, sideTo!, "mirror-copy", ctx);
        } catch (e) {
          if (e instanceof JournalWriteError) throw e;
          const why = moveFailure(e);
          // Keep the pair together: put the transcript back too.
          try {
            await moveEntry(to!, c.path, ctx.fs);
          } catch (back) {
            report.moved.push({ from: c.path, to: to! });
            skip(`sidecar folder ${sidecar} could not be moved (${why}), and the transcript could not be moved back (${moveFailure(back)}); it stays in quarantine at ${to} (journaled, \`t3sm rollback\` restores it)`);
            continue;
          }
          try {
            await ctx.j.append({ t: "unquarantined", runId, from: to!, to: c.path } satisfies JournalEntry);
          } catch (je) {
            throw new JournalWriteError(`Moved ${to} back to ${c.path} because its sidecar folder could not be moved, but could not journal that (${msg(je)}). Nothing is lost; \`t3sm rollback\` reports it as already restored.`);
          }
          skip(`sidecar folder ${sidecar} could not be moved (${why}); the transcript was left in place`);
          continue;
        }
      }
      report.moved.push({ from: c.path, to: to! });
      if (sidecar) report.moved.push({ from: sidecar, to: sideTo! });
    } catch (e) {
      if (e instanceof JournalWriteError) throw e;
      skip(moveFailure(e));
    }
  }
  return report;
}

/**
 * Removes now-empty folders from `dir` up to and including `<accountHome>/session-manager-quarantine` (rmdir only:
 * a folder with anything in it stays). Best effort; never throws.
 */
export async function pruneEmptyQuarantineDirs(dir: string, accountHome: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const root = join(accountHome, QUARANTINE_DIR);
  let d = dir;
  while (isInside(d, root, platform) || sameCwd(d, root, platform)) {
    try {
      await rmdir(d);
    } catch {
      return; // ENOTEMPTY, ENOENT, EBUSY...: stop
    }
    if (sameCwd(d, root, platform)) return;
    d = dirname(d);
  }
}

export interface OrphanedItem { accountHome: string; path: string; kind: "backup" | "mirror" }

/**
 * Entries in each account's quarantine that no `quarantined` journal entry refers to (moved there by hand, or a
 * journal lost). backups/: every child. mirror/: every file, and every folder named like a sibling transcript's stem
 * (a sidecar), found under the encoded project folders. Read-only. Accounts' homes must be expanded.
 */
export async function findOrphanedQuarantine(accounts: Pick<AccountConfig, "home">[], journalEntries: JournalEntry[], platform: NodeJS.Platform = process.platform): Promise<OrphanedItem[]> {
  const known = new Set<string>();
  for (const e of journalEntries) {
    if (e.t === "quarantined" && typeof e.to === "string") known.add(key(e.to, platform));
  }
  const out: OrphanedItem[] = [];
  const list = async (d: string) => {
    try {
      return await readdir(d, { withFileTypes: true });
    } catch (e) {
      const code = errCode(e);
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw e;
    }
  };
  for (const a of accounts) {
    const root = join(a.home, QUARANTINE_DIR);
    for (const e of await list(join(root, "backups"))) {
      const p = join(root, "backups", e.name);
      if (!known.has(key(p, platform))) out.push({ accountHome: a.home, path: p, kind: "backup" });
    }
    const walk = async (d: string): Promise<void> => {
      const ents = await list(d);
      const stems = new Set(ents.filter((e) => !e.isDirectory() && e.name.endsWith(".jsonl")).map((e) => e.name.slice(0, -".jsonl".length)));
      for (const e of ents) {
        const p = join(d, e.name);
        if (known.has(key(p, platform))) continue;
        if (!e.isDirectory()) { out.push({ accountHome: a.home, path: p, kind: "mirror" }); continue; }
        if (stems.has(e.name)) { out.push({ accountHome: a.home, path: p, kind: "mirror" }); continue; }
        await walk(p);
      }
    };
    await walk(join(root, "mirror"));
  }
  return out;
}
