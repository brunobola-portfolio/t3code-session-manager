import { readFileSync } from "node:fs";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { hostname, uptime } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pidAlive } from "./pid.ts";

const UNPARSEABLE_STALE_MS = 3600_000;
const STEAL_MUTEX_STALE_MS = 30_000;
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EXDEV", "ENOSYS", "EOPNOTSUPP"]);

/**
 * The lock owner cannot have survived a reboot: the machine's uptime now is below the uptime recorded in the lock
 * (uptime only grows within one boot, whatever the wall clock does). Its pid may since belong to an unrelated live
 * process, so this check wins over the pid check. A lock without a recorded uptime (older t3sm): false (pid check only).
 */
export function rebootedSince(lockUptimeSec: number | null | undefined, currentUptimeSec: number): boolean {
  return typeof lockUptimeSec === "number" && Number.isFinite(lockUptimeSec) && currentUptimeSec < lockUptimeSec;
}

/** Linux only: this boot's id (diagnostic hint in the lock body; staleness is judged by uptime). */
function bootIdHint(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined; } catch { return undefined; }
}

export interface Lock {
  release(): Promise<void>;
}

export interface LockOptions {
  /** Test hook replacing `process.kill`; same contract (throws ESRCH/EPERM). */
  kill?: (pid: number, signal: 0) => void;
  /** Test hooks for deterministic interleavings. */
  stealHooks?: StealHooks;
  /** Test hook replacing os.uptime (seconds since this machine booted). */
  uptime?: () => number;
}

export interface LockInfo {
  pid: number;
  startedAt: string;
  hostname: string;
  ageMs: number;
  /** The machine's uptime (s) when the lock was taken; null for a lock written by an older t3sm. */
  uptimeSec: number | null;
}

interface LockBody {
  pid: number;
  startedAt: string;
  hostname: string;
  /** os.uptime() when taken: a lower uptime later means the machine rebooted since. */
  uptimeSec?: number;
  /** Linux boot id (diagnostic only). */
  bootId?: string;
}

function parseBody(raw: string): LockBody | null {
  try {
    const v = JSON.parse(raw) as Partial<LockBody> | null;
    if (v && typeof v.pid === "number" && Number.isInteger(v.pid) && v.pid > 0 && typeof v.startedAt === "string" && typeof v.hostname === "string") {
      const b: LockBody = { pid: v.pid, startedAt: v.startedAt, hostname: v.hostname };
      if (typeof v.uptimeSec === "number" && Number.isFinite(v.uptimeSec)) b.uptimeSec = v.uptimeSec;
      if (typeof v.bootId === "string") b.bootId = v.bootId;
      return b;
    }
  } catch { /* fall through */ }
  return null;
}


/**
 * Create `file` atomically WITH its content: write a temp file, fsync, hard-link it to
 * `file` (EEXIST => held), unlink the temp. No reader can ever see an empty lock.
 * If the filesystem cannot hard-link (EPERM/ENOTSUP/EXDEV/...), fall back to an
 * exclusive `wx` create followed by a write; that fallback has a brief window in which
 * the lock file is empty (readers treat an empty/unparseable lock younger than 1 h as held).
 */
async function tryCreate(file: string, body: LockBody): Promise<boolean> {
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  const fh = await open(tmp, "wx");
  try {
    try {
      await fh.writeFile(JSON.stringify(body), "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await link(tmp, file);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (code === "EEXIST") return false;
      if (!LINK_UNSUPPORTED.has(code)) throw e;
    }
    let lf;
    try {
      lf = await open(file, "wx");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (code === "EEXIST" || TRANSIENT.has(code)) return false; // held, or being deleted right now
      throw e;
    }
    try {
      await lf.writeFile(JSON.stringify(body), "utf8");
      await lf.sync();
    } finally {
      await lf.close();
    }
    return true;
  } finally {
    await rmForce(tmp);
  }
}

const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Read a file; null if absent. On Windows a file being deleted by another process reports
 *  EPERM/EBUSY for a moment, so those are retried briefly and then rethrown. */
async function readIfExists(file: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readFile(file, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT") return null;
      if (!TRANSIENT.has(code) || attempt >= 8) throw e;
      await new Promise((r) => setTimeout(r, 5 * (attempt + 1)));
    }
  }
}

const rmForce = (p: string) => rm(p, { force: true, maxRetries: 8, retryDelay: 10 });

async function isStale(file: string, raw: string, kill: NonNullable<LockOptions["kill"]>, upNow: () => number): Promise<boolean> {
  const b = parseBody(raw);
  if (b) {
    if (b.hostname !== hostname()) return false; // shared state dir: never steal
    if (rebootedSince(b.uptimeSec, upNow())) return true; // its owner died with the last shutdown
    return !pidAlive(b.pid, kill);
  }
  try {
    const s = await stat(file);
    return Date.now() - s.mtimeMs > UNPARSEABLE_STALE_MS;
  } catch {
    return false;
  }
}

/** Test hooks (deterministic interleavings). */
export interface StealHooks {
  /** Runs between the staleness `stat` and the break `rename` of the steal mutex. */
  afterStatBeforeBreak?: () => Promise<void>;
}

/**
 * Take the steal mutex (`lock.steal`, wx) holding a random token; returns the token or null.
 *
 * Guarantee: exclusivity comes from the exclusive `wx` create, never from rename (on Windows
 * concurrent renames of the same file can all report success). A mutex older than 30 s is
 * stale: we move it aside to `lock.steal.broken-<rand>`, delete that, and `wx`-create a new
 * one; only one creator can succeed. If the moved-aside file turns out to be fresh (its
 * owner replaced the stale one between our stat and rename) it is a live holder's mutex:
 * it is put back with `link` (EEXIST means someone recreated it, which is fine; never
 * `rename` back, that overwrites on POSIX), then the aside name is unlinked, and we return null.
 */
export async function takeStealMutex(path: string, hooks: StealHooks = {}): Promise<string | null> {
  const token = randomBytes(8).toString("hex");
  const create = async (): Promise<boolean> => {
    let fh;
    try {
      fh = await open(path, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
    try { await fh.writeFile(token, "utf8"); } finally { await fh.close(); }
    return true;
  };
  if (await create()) return token;
  let age: number;
  try {
    age = Date.now() - (await stat(path)).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return (await create()) ? token : null;
    throw e;
  }
  if (age <= STEAL_MUTEX_STALE_MS) return null;
  if (hooks.afterStatBeforeBreak) await hooks.afterStatBeforeBreak();
  const broken = `${path}.broken-${randomBytes(4).toString("hex")}`;
  try {
    await rename(path, broken);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOENT" || TRANSIENT.has(code)) return null; // lost the break race
    throw e;
  }
  let fresh = false;
  try {
    fresh = Date.now() - (await stat(broken)).mtimeMs <= STEAL_MUTEX_STALE_MS;
  } catch { /* gone: treat as stale */ }
  if (fresh) {
    try {
      await link(broken, path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (code !== "EEXIST") {
        // No hard links here: recreate the mutex with the same content (best effort).
        try {
          const content = await readFile(broken, "utf8");
          const fh = await open(path, "wx");
          try { await fh.writeFile(content, "utf8"); } finally { await fh.close(); }
        } catch { /* someone recreated it, or unrecoverable: the holder's finally tolerates a missing mutex */ }
      }
    }
    await rmForce(broken);
    return null;
  }
  await rmForce(broken);
  return (await create()) ? token : null;
}

/**
 * Take the state-dir lock at `<dir>/lock`. Returns null when held by a live owner on this machine (started after the
 * last boot, pid alive) or by an owner on another host. Callers MUST hold this lock around any journal-mutating work
 * (including `recoverPendingMtimes`) and `release()` it afterwards.
 *
 * Stealing a stale lock is serialized by a `lock.steal` mutex: inside it the lock is re-read and removed only if it
 * still equals the content judged stale, then the exclusive create is retried once and verified by a re-read. Nothing
 * is ever put back. A stale (>30 s) mutex is moved aside by rename and replaced by an exclusive `wx` create, so only
 * one stealer can win (see takeStealMutex). Residual risk: a mutex holder stalled for more than 30 s combined with an
 * exact interleaving of a second stealer could still yield two owners; accepted as practically unreachable.
 */
export async function acquireLock(dir: string, opts: LockOptions = {}): Promise<Lock | null> {
  const kill = opts.kill ?? ((pid: number, sig: 0) => { process.kill(pid, sig); });
  await mkdir(dir, { recursive: true });
  const file = join(dir, "lock");
  const upNow = opts.uptime ?? uptime;
  const body: LockBody = { pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname(), uptimeSec: upNow() };
  const bootId = bootIdHint();
  if (bootId !== undefined) body.bootId = bootId;

  if (await tryCreate(file, body)) return makeLock(file, body);

  let raw: string | null;
  try {
    raw = await readIfExists(file);
  } catch (e) {
    if (TRANSIENT.has((e as NodeJS.ErrnoException).code ?? "")) return null; // contended: report held
    throw e;
  }
  if (raw === null) return (await tryCreate(file, body)) ? makeLock(file, body) : null; // vanished
  if (!(await isStale(file, raw, kill, upNow))) return null;

  const mutex = `${file}.steal`;
  const token = await takeStealMutex(mutex, opts.stealHooks);
  if (token === null) return null;
  try {
    const cur = await readIfExists(file);
    if (cur !== null) {
      if (cur !== raw) return null; // someone else already replaced it
      await rmForce(file);
    }
    if (!(await tryCreate(file, body))) return null;
    // Verify we still own it; if not, remove nothing and yield.
    const after = await readIfExists(file).catch(() => null);
    const mine = after !== null ? parseBody(after) : null;
    if (!mine || mine.pid !== body.pid || mine.startedAt !== body.startedAt) return null;
    return makeLock(file, body);
  } finally {
    // Delete the mutex only if it is still ours.
    let seen: string | null | undefined;
    for (let attempt = 0; attempt < 6 && seen === undefined; attempt++) {
      try {
        seen = await readIfExists(mutex);
      } catch {
        await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
      }
    }
    if (seen === token) await rmForce(mutex);
  }
}

/** Parse the current lock for diagnostics (`doctor`): null if absent or unparseable. Never steals. */
export async function lockInfo(dir: string): Promise<LockInfo | null> {
  const file = join(dir, "lock");
  const raw = await readIfExists(file);
  if (raw === null) return null;
  const b = parseBody(raw);
  if (!b) return null;
  const started = Date.parse(b.startedAt);
  let ageMs: number;
  if (Number.isFinite(started)) ageMs = Date.now() - started;
  else {
    try { ageMs = Date.now() - (await stat(file)).mtimeMs; } catch { return null; }
  }
  return { pid: b.pid, startedAt: b.startedAt, hostname: b.hostname, ageMs, uptimeSec: b.uptimeSec ?? null };
}

function makeLock(file: string, body: LockBody): Lock {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      const raw = await readIfExists(file);
      const cur = raw === null ? null : parseBody(raw);
      if (cur && cur.pid === body.pid && cur.startedAt === body.startedAt) await rmForce(file);
    },
  };
}
