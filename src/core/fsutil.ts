import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { SourceFile } from "./types.ts";
import { pidAlive } from "./pid.ts";

/** Rename retries after the first attempt; the delays (10, 20, 40, ... ms, at most 250 each) add up to about 5 s. */
export const RENAME_RETRIES = 24;
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Delay before rename retry `attempt` (0-based): doubles from 10 ms, capped at 250 ms. */
export function renameRetryDelay(attempt: number): number {
  return Math.min(10 * 2 ** attempt, 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** What atomicWrite does to the world that tests replace: the final rename and the wait between its retries. */
export interface AtomicWriteDeps {
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Write `data` to `path` atomically: temp file in the same directory, fsync, rename.
 * Creates parent directories. Windows refuses to rename over a file another process has open (a second t3sm
 * reading config.json or a plan, an antivirus scan, a sync client): EPERM / EBUSY / EACCES. The rename alone is
 * retried with a growing delay for about 5 s (RENAME_RETRIES, renameRetryDelay), then the error is thrown. The temp
 * file never outlives a failure.
 */
export async function atomicWrite(path: string, data: string, deps: AtomicWriteDeps = {}): Promise<void> {
  const doRename = deps.rename ?? rename;
  const wait = deps.sleep ?? sleep;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(data, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await doRename(tmp, path);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "";
        if (!RETRYABLE.has(code) || attempt >= RENAME_RETRIES) throw e;
        await wait(renameRetryDelay(attempt));
      }
    }
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(path);
    s.on("error", reject);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

export async function statSafe(path: string): Promise<SourceFile | null> {
  try {
    const s = await stat(path);
    return { path, size: s.size, mtimeMs: s.mtimeMs, atimeMs: s.atimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** A no-clobber move/publish refused before anything changed: destination exists, other drive, no hard links. */
export class MoveRefused extends Error {
  override name = "MoveRefused";
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/** The calls publishNoClobber makes; injected by tests (a file appearing at the destination, EXDEV). */
export interface LinkFs {
  link(existing: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "ENOSYS", "EOPNOTSUPP", "EMLINK"]);
const codeOf = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e));

/**
 * Gives FILE `from` the name `to` without ever replacing an existing entry (node's rename replaces a target file):
 * link(from, to) then unlink(from). EEXIST at `to` -> MoveRefused("EEXIST"), nothing changed; EXDEV or a filesystem
 * without hard links -> MoveRefused, nothing changed (never copy-and-delete). If `from` cannot be removed afterwards,
 * the new name is dropped again (the exact previous state) and the error is thrown. The parent of `to` must exist.
 */
export async function publishNoClobber(from: string, to: string, fs: LinkFs): Promise<void> {
  try {
    await fs.link(from, to);
  } catch (e) {
    const code = codeOf(e);
    if (code === "EEXIST") throw new MoveRefused(`${to} already exists; nothing was changed`, "EEXIST");
    if (code === "EXDEV") throw new MoveRefused(`${to} is on another drive (EXDEV); not moved (t3sm never copies and deletes)`, "EXDEV");
    if (LINK_UNSUPPORTED.has(code)) throw new MoveRefused(`this filesystem cannot hard-link (${code}); not moved (t3sm never copies and deletes)`, code);
    throw e;
  }
  try {
    await fs.unlink(from);
  } catch (e) {
    // Both names point at the same file: dropping the new name restores the exact previous state.
    try {
      await fs.unlink(to);
    } catch (e2) {
      throw new Error(`could not remove ${from} after linking it to ${to} (${codeOf(e)}), nor undo the link (${codeOf(e2)}); the file now has both names, nothing is lost`);
    }
    throw e;
  }
}

/** Temp files of files t3sm writes into account folders: `.<uuid>.<pid>.<12 hex>.tmp` (not *.jsonl: no scanner reads it). */
export const WRITE_TEMP_RE = /^\.[0-9a-f-]{36}\.(\d+)\.[0-9a-f]{12}\.tmp$/;

/** A temp name next to a converted transcript or merge revision `<uuid>.jsonl` in `dir` (sweepWriteTemps finds it). */
export function writeTempPath(dir: string, uuid: string): string {
  return join(dir, `.${uuid}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
}


/** Removes the write temps (WRITE_TEMP_RE) left in `dir` by t3sm processes that are gone; returns their paths. */
export async function sweepWriteTemps(dir: string, alive: (pid: number) => boolean = pidAlive): Promise<string[]> {
  const out: string[] = [];
  for (const n of await readdir(dir).catch(() => [] as string[])) {
    const m = WRITE_TEMP_RE.exec(n);
    if (!m || alive(Number(m[1]))) continue;
    await rm(join(dir, n), { force: true }).catch(() => {});
    out.push(join(dir, n));
  }
  return out;
}
