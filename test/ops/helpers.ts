// Temp homes and tree snapshots for the quarantine / dedupe / rollback tests. Never touches a real home.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { after } from "node:test";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { Journal } from "../../src/core/journal.ts";
import type { JournalEntry } from "../../src/core/types.ts";
import { scheduleFileBytes, type ScheduleFs } from "../../src/ops/schedule.ts";

export const DAY = 86_400_000;
export const OLD = Date.now() - 40 * DAY;

const temps: string[] = [];
after(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A temp root holding an account home (`<root>/.claude/projects`) and a state dir. */
export function tempRoot(): { root: string; home: string; projects: string; state: string; journal: Journal } {
  const root = mkdtempSync(join(tmpdir(), "t3sm-ops-"));
  temps.push(root);
  const home = join(root, ".claude");
  const projects = join(home, "projects");
  mkdirSync(projects, { recursive: true });
  const state = join(root, "state");
  return { root, home, projects, state, journal: new Journal(join(state, "journal.jsonl")) };
}

/** Writes `content` at `path` (parents created) with atime/mtime = `mtimeMs` (atime 1 s earlier, to tell them apart). */
export function put(path: string, content: string, mtimeMs = OLD): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, (mtimeMs - 1000) / 1000, mtimeMs / 1000);
  return path;
}

/**
 * Every file under `dir`: relative path -> sha256, mtimeMs. No atime: hashing reads the file, and reads move atime
 * (NTFS with last-access updates on, relatime). atime is asserted by the stat-only tests (`times`).
 */
export function snapshot(dir: string): Record<string, { sha: string; mtimeMs: number }> {
  const out: Record<string, { sha: string; mtimeMs: number }> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const st = statSync(p);
      out[relative(dir, p).replace(/\\/g, "/")] = { sha: createHash("sha256").update(readFileSync(p)).digest("hex"), mtimeMs: st.mtimeMs };
    }
  };
  walk(dir);
  return out;
}

/** Every file under `dir`: relative path -> mtimeMs, atimeMs (stat only, never reads content). */
export function times(dir: string): Record<string, { mtimeMs: number; atimeMs: number }> {
  const out: Record<string, { mtimeMs: number; atimeMs: number }> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const st = statSync(p);
      out[relative(dir, p).replace(/\\/g, "/")] = { mtimeMs: st.mtimeMs, atimeMs: st.atimeMs };
    }
  };
  walk(dir);
  return out;
}

/** A transcript line set for compareCopies: `n` user records with cwd. */
export function lines(n: number, tag = "x"): string {
  let s = "";
  for (let i = 0; i < n; i++) s += JSON.stringify({ type: "user", cwd: "C:/work/demo", uuid: `${tag}-${i}`, message: { role: "user", content: `m${i}` } }) + "\n";
  return s;
}

export async function entries(j: Journal): Promise<JournalEntry[]> {
  return j.readAll();
}

/** A Journal whose append always fails (disk full, ACL change) after `okCount` successful appends. */
export class FailingJournal extends Journal {
  okCount: number;
  constructor(file: string, okCount = 0) { super(file); this.okCount = okCount; }
  override append(e: JournalEntry): Promise<void> {
    if (this.okCount-- > 0) return super.append(e);
    return Promise.reject(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
  }
}

/**
 * In-memory ScheduleFs. A win32 spec names its task XML with a Windows path on every host; on Linux or macOS the real
 * file system would take that whole path as one file name in the current directory.
 */
export function memScheduleFs(): ScheduleFs & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    write: async (f) => void files.set(f.path, scheduleFileBytes(f)),
    remove: async (p) => void files.delete(p),
    exists: (p) => files.has(p),
  };
}
