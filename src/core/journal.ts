import { mkdir, open, readFile, stat, utimes } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { JournalEntry } from "./types.ts";
import { pathKey } from "./paths.ts";

/** Mtime bumps in the journal without a matching restore (path identity per platform). Read-only. */
export function pendingMtimePaths(entries: JournalEntry[], platform: NodeJS.Platform = process.platform): string[] {
  const key = (p: string): string => pathKey(p, platform);
  const pending = new Map<string, { path: string; runs: Set<string> }>();
  for (const e of entries) {
    if (e.t === "mtime-bump" && Array.isArray(e.files)) {
      for (const f of e.files) {
        if (!f || typeof f.path !== "string" || f.path === "") continue;
        const k = key(f.path);
        let s = pending.get(k);
        if (!s) pending.set(k, (s = { path: f.path, runs: new Set() }));
        s.runs.add(e.runId);
      }
    } else if (e.t === "mtime-restore" && Array.isArray(e.paths)) {
      for (const p of e.paths) if (typeof p === "string") pending.get(key(p))?.runs.delete(e.runId);
    }
  }
  return [...pending.values()].filter((s) => s.runs.size > 0).map((s) => s.path);
}

export interface RecoverResult {
  restored: string[];
  missing: string[];
  failed: { path: string; error: string }[];
  skippedModified: string[];
  malformed: number;
}

/**
 * Append-only JSONL journal. One JSON object per line, UTF-8, "\n".
 * `readAll()` sets `lastReadCorruptLines` to the number of unparseable/invalid
 * lines skipped by that call (a truncated final line without newline is skipped silently).
 */
// The file is created owner-only (0o600); win32 ignores the mode, so there it relies on the user profile ACLs.
export class Journal {
  readonly file: string;
  lastReadCorruptLines = 0;
  #chain: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  append(e: JournalEntry): Promise<void> {
    const line = JSON.stringify(e) + "\n";
    const run = this.#chain.then(() => this.#write(line));
    this.#chain = run.catch(() => {});
    return run;
  }

  async #write(line: string): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const fh = await open(this.file, "a+", 0o600);
    try {
      // Never glue a new entry onto a truncated tail left by a crash.
      const { size } = await fh.stat();
      let prefix = "";
      if (size > 0) {
        const b = Buffer.alloc(1);
        await fh.read(b, 0, 1, size - 1);
        if (b[0] !== 0x0a) prefix = "\n";
      }
      await fh.appendFile(prefix + line, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  async readAll(): Promise<JournalEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.lastReadCorruptLines = 0;
        return [];
      }
      throw e;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const endsWithNewline = text.endsWith("\n");
    const lines = text.split("\n");
    if (endsWithNewline) lines.pop();
    const out: JournalEntry[] = [];
    let corrupt = 0;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!.replace(/\r$/, "");
      if (raw.trim() === "") continue;
      const isTruncatedTail = i === lines.length - 1 && !endsWithNewline;
      let v: unknown;
      try {
        v = JSON.parse(raw);
      } catch {
        if (!isTruncatedTail) corrupt++;
        continue;
      }
      if (isEntry(v)) out.push(v);
      else corrupt++;
    }
    this.lastReadCorruptLines = corrupt;
    return out;
  }
}

function isEntry(v: unknown): v is JournalEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o["t"] === "string" && typeof o["runId"] === "string";
}

export function newRunId(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const d = `${p(now.getUTCFullYear(), 4)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const t = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${d}-${t}-${randomBytes(2).toString("hex")}`;
}

/**
 * The `file-written` entries that really happened, in journal order: each `file-write-aborted` cancels the latest
 * earlier `file-written` of the same run and path (`key` = path identity, e.g. case-folded on win32). "Last written
 * sha" logic must use this, or a write that lost its race would look like ours forever.
 */
export function effectiveWrites(entries: JournalEntry[], key: (p: string) => string = (p) => p): Extract<JournalEntry, { t: "file-written" }>[] {
  const out: (Extract<JournalEntry, { t: "file-written" }> | null)[] = [];
  for (const e of entries) {
    if (e.t === "file-written" && typeof e.path === "string") out.push(e);
    else if (e.t === "file-write-aborted" && typeof e.path === "string") {
      const k = key(e.path);
      for (let i = out.length - 1; i >= 0; i--) {
        const w = out[i];
        if (w && w.runId === e.runId && key(w.path) === k) { out[i] = null; break; }
      }
    }
  }
  return out.filter((w): w is Extract<JournalEntry, { t: "file-written" }> => w !== null);
}

export function importedIndex(entries: JournalEntry[]): Map<string, Extract<JournalEntry, { t: "imported" }>> {
  const m = new Map<string, Extract<JournalEntry, { t: "imported" }>>();
  for (const e of entries) {
    if (e.t === "imported") m.set(`${e.harness}:${e.nativeId}`, e);
  }
  return m;
}

/**
 * True when `observed` (a stat'd mtime) matches `expected` (a value we set or journaled):
 * within 2 ms, or equal after the truncation a coarse-timestamp filesystem applies
 * (1 s, e.g. HFS+; 2 s, FAT/exFAT).
 */
export function near(observed: number, expected: number): boolean {
  if (Math.abs(observed - expected) <= 2) return true;
  if (expected % 1000 !== 0 && observed % 1000 === 0 && Math.floor(observed / 1000) === Math.floor(expected / 1000)) return true;
  if (observed % 2000 === 0 && Math.abs(observed - expected) < 2000) return true;
  return false;
}

/**
 * Restore every bumped mtime that has no later restore in the same run.
 *
 * MUST be called only while holding the state-dir lock (`acquireLock`): it rewrites
 * file times and appends to the journal, and a concurrent run's bumps would be undone.
 *
 * Matching is per (runId, path) but restoration is per path (identity normalized with
 * `normalizeCwd`, case-insensitive on win32/darwin): one `utimes` per path, using the
 * original of the EARLIEST still-pending bump (a later run may have journaled an
 * already-bumped value as its "original"), except that a later bump whose original differs
 * from the previous bump's `targetMtimeMs` by more than 2 ms (a user edit in between)
 * replaces it. If the file already sits at that original (+-2 ms; crash between utimes and
 * the restore entry) it counts as `restored` without touching it. Afterwards one `mtime-restore` per affected
 * run lists its paths.
 * - ENOENT: reported in `missing`, marked restored (no endless retry).
 * - Current mtime differs from the latest pending bump's `targetMtimeMs` (+-2 ms): the
 *   file was modified by someone else; never moved backwards. Reported in
 *   `skippedModified`, marked restored. Entries without `targetMtimeMs` restore as before.
 * - Other errors: `failed`, left pending.
 * - Structurally invalid bump/restore entries are skipped and counted in `malformed`.
 */
export async function recoverPendingMtimes(
  j: Journal,
  opts: { stat?: (p: string) => Promise<{ mtimeMs: number }> } = {},
): Promise<RecoverResult> {
  const statFn = opts.stat ?? stat;
  const entries = await j.readAll();
  type Bump = { runId: string; original: { atimeMs: number; mtimeMs: number }; target: number | null };
  const byKey = new Map<string, { path: string; bumps: Bump[] }>();
  const keyOf = (p: string): string => pathKey(p, process.platform);
  let malformed = 0;
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  for (const e of entries) {
    if (e.t === "mtime-bump") {
      const files: unknown = (e as { files?: unknown }).files;
      if (!Array.isArray(files)) { malformed++; continue; }
      let bad = false;
      for (const f of files as Record<string, unknown>[]) {
        if (typeof f !== "object" || f === null || typeof f["path"] !== "string" || f["path"] === "" || !num(f["atimeMs"]) || !num(f["mtimeMs"])) { bad = true; continue; }
        const key = keyOf(f["path"]);
        let slot = byKey.get(key);
        if (!slot) byKey.set(key, (slot = { path: f["path"], bumps: [] }));
        slot.bumps.push({
          runId: e.runId,
          original: { atimeMs: f["atimeMs"], mtimeMs: f["mtimeMs"] },
          target: num(f["targetMtimeMs"]) ? f["targetMtimeMs"] : null,
        });
      }
      if (bad) malformed++;
    } else if (e.t === "mtime-restore") {
      const paths: unknown = (e as { paths?: unknown }).paths;
      if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) { malformed++; continue; }
      for (const p of paths as string[]) {
        const slot = byKey.get(keyOf(p));
        if (slot) slot.bumps = slot.bumps.filter((b) => b.runId !== e.runId);
      }
    }
  }
  const result: RecoverResult = { restored: [], missing: [], failed: [], skippedModified: [], malformed };
  const doneByRun = new Map<string, string[]>();
  for (const slot of byKey.values()) {
    if (slot.bumps.length === 0) continue;
    // Effective original: the earliest pending bump's, unless a later bump started from a
    // value that is not where the previous bump left the file (a real edit happened between).
    let original = slot.bumps[0]!.original;
    for (let k = 1; k < slot.bumps.length; k++) {
      const prev = slot.bumps[k - 1]!;
      const cur = slot.bumps[k]!;
      // Continuation if it starts where the previous bump left the file OR where the previous
      // bump itself started (that earlier run restored the file but crashed before journaling it).
      if (prev.target !== null && !near(cur.original.mtimeMs, prev.target) && !near(cur.original.mtimeMs, prev.original.mtimeMs)) original = cur.original;
    }
    const target = slot.bumps[slot.bumps.length - 1]!.target;
    let outcome: "restored" | "missing" | "skipped";
    try {
      const cur = await statFn(slot.path).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (cur === null) outcome = "missing";
      else if (near(cur.mtimeMs, original.mtimeMs)) outcome = "restored"; // crashed after utimes, before the restore entry
      else if (target !== null && !near(cur.mtimeMs, target)) outcome = "skipped";
      else {
        await utimes(slot.path, original.atimeMs / 1000, original.mtimeMs / 1000);
        outcome = "restored";
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") outcome = "missing";
      else {
        result.failed.push({ path: slot.path, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
    }
    if (outcome === "restored") result.restored.push(slot.path);
    else if (outcome === "missing") result.missing.push(slot.path);
    else result.skippedModified.push(slot.path);
    for (const b of slot.bumps) {
      let l = doneByRun.get(b.runId);
      if (!l) doneByRun.set(b.runId, (l = []));
      if (!l.includes(slot.path)) l.push(slot.path);
    }
  }
  for (const [runId, paths] of doneByRun) await j.append({ t: "mtime-restore", runId, paths });
  return result;
}
