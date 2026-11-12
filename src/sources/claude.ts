import { type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DiscoveredSession, SessionFlag } from "../core/types.ts";
import { statSafe } from "../core/fsutil.ts";
import { expandHome } from "../core/paths.ts";
import { isActive } from "../core/activity.ts";
import { createDiscoveryCache, readCachedMtimes } from "./cache.ts";
import { isNum, isoOrNull, isStrOrNull, scanJsonl, type ReadOptions } from "./jsonl.ts";
import { isUuid } from "../core/uuid.ts";
import {
  CWD_SCAN_MAX_BYTES,
  CWD_SCAN_MAX_RECORDS,
  type Env,
  type FileTime,
  type SourceAdapter,
} from "./types.ts";

const MIB = 1024 * 1024;
const OVER_32MIB = 32 * MIB;
const OVER_4GIB = 4 * 1024 * MIB;
const BACKUP_DIR = /\.bak(-\d{8}-\d{6})?$/;
const CACHE_VERSION = 3;
const CACHE_FILE = "claude-discovery.json";

/** Result of scanning one transcript; everything that does not depend on `now`. */
export interface ScanResult {
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  visibleUserCount: number;
  corruptLines: number;
  cwdOffsetBytes: number;
  /** A cwd was found within the T3 metadata window (1 MiB and 1000 records). */
  cwdReadable: boolean;
  /**
   * The session id T3 Code imports this transcript under (S2 §2.6; T3's foldClaudeFields): the trimmed `sessionId` of
   * the last record that is not sidechain, meta or compact summary; null when none carries one (T3 then uses the stem).
   */
  sessionId: string | null;
}

/** A user record whose content is only tool_result blocks is tool plumbing, not a user message. */
function isToolResultOnly(content: unknown): boolean {
  return Array.isArray(content) && content.length > 0 &&
    content.every((b) => b !== null && typeof b === "object" && (b as { type?: unknown }).type === "tool_result");
}

/**
 * Stream a transcript once (shared byte-exact scanner). The file is never loaded whole.
 */
export async function scanTranscript(path: string, readOpts: ReadOptions = {}): Promise<ScanResult> {
  const r: ScanResult = {
    cwd: null, startedAt: null, updatedAt: null, messageCount: 0, visibleUserCount: 0,
    corruptLines: 0, cwdOffsetBytes: 0, cwdReadable: false, sessionId: null,
  };
  const totals = await scanJsonl(path, readOpts, (o, info) => {
    if (r.cwd === null && typeof o.cwd === "string" && o.cwd !== "") {
      r.cwd = o.cwd;
      r.cwdOffsetBytes = info.offset;
      // T3 (S2 section 4) reads in 8 KiB chunks until the first record with cwd, at most 1 MiB per
      // file, and a record only parses once complete. So a cwd record is readable iff it ends
      // (newline included) at byte <= 1 MiB, and it is among the first 1000 lines (blank lines count).
      r.cwdReadable = info.offset <= CWD_SCAN_MAX_BYTES && info.recordIndex <= CWD_SCAN_MAX_RECORDS;
    }
    const hidden = o.isSidechain === true || o.isMeta === true || o.isCompactSummary === true;
    if (!hidden && typeof o.sessionId === "string" && o.sessionId.trim() !== "") r.sessionId = o.sessionId.trim();
    const ts = isoOrNull(o.timestamp);
    if (ts !== null) {
      r.startedAt ??= ts;
      r.updatedAt = ts;
    }
    if ((o.type === "user" || o.type === "assistant") && o.isSidechain !== true && o.isMeta !== true &&
      o.isCompactSummary !== true) {
      if (o.type === "user") {
        if (isToolResultOnly((o.message as { content?: unknown } | undefined)?.content)) return;
        r.visibleUserCount++;
      }
      r.messageCount++;
    }
  });
  r.corruptLines = totals.corruptLines;
  if (r.cwd === null) r.cwdOffsetBytes = totals.totalBytes;
  return r;
}

/**
 * The id T3 Code imports a Claude transcript under (its thread is import:<instance>:<id>; S2 §2.6, T3's
 * foldClaudeFields): the last non-hidden record's sessionId, else the file stem.
 */
export function claudeNativeId(path: string, scan: Pick<ScanResult, "sessionId">): string {
  return scan.sessionId ?? basename(path, ".jsonl");
}

/** claudeNativeId of a transcript on disk (streams it once); the stem when it cannot be read. */
export async function readClaudeNativeId(path: string): Promise<string> {
  return claudeNativeId(path, await scanTranscript(path).catch(() => ({ sessionId: null })));
}

/** Every ScanResult field must be present with the right type; otherwise the entry is rescanned. */
function isValidResult(r: unknown): r is ScanResult {
  if (r === null || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return isStrOrNull(o.cwd) && isStrOrNull(o.startedAt) && isStrOrNull(o.updatedAt) &&
    isNum(o.messageCount) && isNum(o.visibleUserCount) && isNum(o.corruptLines) &&
    isNum(o.cwdOffsetBytes) && typeof o.cwdReadable === "boolean" && isStrOrNull(o.sessionId);
}

export type { ReadOptions };

export interface ClaudeAdapter extends SourceAdapter {
  /** Files that could not be read during the last `discover` run (never thrown). */
  lastErrors: { path: string; error: string }[];
}

export interface ClaudeAdapterOptions {
  /** Test hook: called each time a transcript is actually opened and scanned (cache miss). */
  onScan?: (path: string) => void;
  /** Test hook: read options for the transcript stream. */
  readOptions?: ReadOptions;
}

interface Candidate { path: string; accountId: string; backup: boolean }

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function* candidates(accountId: string, projects: string): AsyncGenerator<Candidate> {
  for (const d of await listDir(projects)) {
    if (!d.isDirectory()) continue;
    const dir = join(projects, d.name);
    if (d.name.startsWith(".bak-")) {
      for (const sub of await listDir(dir)) {
        if (!sub.isDirectory()) continue;
        for (const f of await listDir(join(dir, sub.name))) {
          if (f.isFile() && f.name.endsWith(".jsonl")) {
            yield { path: join(dir, sub.name, f.name), accountId, backup: true };
          }
        }
      }
      continue;
    }
    const backup = BACKUP_DIR.test(d.name);
    for (const f of await listDir(dir)) {
      if (f.isFile() && f.name.endsWith(".jsonl")) yield { path: join(dir, f.name), accountId, backup };
    }
  }
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions = {}): ClaudeAdapter {
  const adapter: ClaudeAdapter = {
    id: "claude",
    mode: "native",
    lastErrors: [],
    async isAvailable(env: Env): Promise<boolean> {
      for (const a of env.config.accounts) {
        if (await statSafe(join(a.home, "projects"))) return true;
      }
      return false;
    },
    async watchRoots(env: Env): Promise<string[]> {
      const out: string[] = [];
      for (const a of env.config.accounts) {
        const p = join(expandHome(a.home, env.home), "projects");
        if (await statSafe(p)) out.push(p);
      }
      return out;
    },
    async *fileTimes(env: Env): AsyncGenerator<FileTime> {
      const seen = new Set<string>();
      for (const account of env.config.accounts) {
        for await (const c of candidates(account.id, join(account.home, "projects"))) {
          if (seen.has(c.path)) continue;
          seen.add(c.path);
          const file = await statSafe(c.path).catch(() => null);
          if (file) yield { path: c.path, mtimeMs: file.mtimeMs };
        }
      }
    },
    cachedFileTimes: (env: Env) => readCachedMtimes(join(env.stateDir, "cache", CACHE_FILE)),
    async *discover(env: Env): AsyncGenerator<DiscoveredSession> {
      adapter.lastErrors = [];
      const cachePath = join(env.stateDir, "cache", CACHE_FILE);
      const cache = createDiscoveryCache<ScanResult>(cachePath, CACHE_VERSION, isValidResult);
      await cache.load();
      const seen = new Set<string>();
      for (const account of env.config.accounts) {
        const projects = join(account.home, "projects");
        if (!(await statSafe(projects))) continue;
        for await (const c of candidates(account.id, projects)) {
          if (seen.has(c.path)) continue;
          seen.add(c.path);
          const file = await statSafe(c.path);
          if (!file) {
            adapter.lastErrors.push({ path: c.path, error: "stat failed" });
            continue;
          }
          let result: ScanResult;
          const hit = cache.get(c.path, file.size, file.mtimeMs);
          if (hit) {
            result = hit;
          } else {
            try {
              opts.onScan?.(c.path);
              result = await scanTranscript(c.path, opts.readOptions);
            } catch (e) {
              adapter.lastErrors.push({ path: c.path, error: (e as NodeJS.ErrnoException).code ?? String(e) });
              continue;
            }
          }
          cache.set(c.path, file.size, file.mtimeMs, result);
          // nativeId is the id T3 Code imports the transcript under (its thread is import:<instance>:<id>): the last
          // non-hidden record's sessionId, else the file stem (S2 §2.6). Normally both are the same session UUID.
          const stem = basename(c.path, ".jsonl");
          const nativeId = claudeNativeId(c.path, result);
          const flags: SessionFlag[] = [];
          if (nativeId !== stem) flags.push("id-mismatch");
          if (result.corruptLines > 0) flags.push("corrupt-lines");
          if (result.cwd === null) flags.push("no-cwd");
          if (!result.cwdReadable) flags.push("cwd-unreadable");
          if (!isUuid(nativeId)) flags.push("non-uuid-id");
          if (result.visibleUserCount === 0) flags.push("only-hidden");
          if (file.size > OVER_32MIB) flags.push("over-32mib");
          if (file.size > OVER_4GIB) flags.push("over-4gib");
          if (c.backup) flags.push("backup-copy");
          if (isActive(file.mtimeMs, env.now())) flags.push("active");
          const mtimeIso = new Date(file.mtimeMs).toISOString();
          yield {
            harness: "claude",
            accountId: c.accountId,
            nativeId,
            cwd: result.cwd,
            startedAt: result.startedAt ?? mtimeIso,
            updatedAt: result.updatedAt ?? mtimeIso,
            messageCount: result.messageCount,
            corruptLines: result.corruptLines,
            file,
            flags,
            cwdOffsetBytes: result.cwdOffsetBytes,
          };
        }
      }
      try {
        if (!env.readOnly) await cache.save();
      } catch (e) {
        adapter.lastErrors.push({ path: cachePath, error: `cache write failed: ${(e as Error).message}` });
      }
    },
  };
  return adapter;
}

export const claudeAdapter: ClaudeAdapter = createClaudeAdapter();
