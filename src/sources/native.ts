import { basename, join } from "node:path";
import type { DiscoveredSession, HarnessId, SessionFlag, SourceFile } from "../core/types.ts";
import { statSafe } from "../core/fsutil.ts";
import { createDiscoveryCache, readCachedMtimes } from "./cache.ts";
import { isNum, isStrOrNull, type ReadOptions } from "./jsonl.ts";
import { type Env, type FileTime, type SourceAdapter } from "./types.ts";
import { isActive } from "../core/activity.ts";

const MIB = 1024 * 1024;
const OVER_32MIB = 32 * MIB;
const OVER_4GIB = 4 * 1024 * MIB;
const CACHE_VERSION = 3;

/** What a scan of one Codex/Pi transcript yields; independent of `now`, so it is cacheable. */
export interface NativeScan {
  /** Codex compressed rollouts: the decompressed size passed the cap; the scan stopped there (flag `too-large`). */
  tooLarge?: boolean;
  /** Session id as T3 derives it (`providerSessionId`); null when the file carries none (stem fallback applies). */
  id: string | null;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  visibleUserCount: number;
  corruptLines: number;
  cwdOffsetBytes: number;
  /** A cwd was found within the T3 metadata window (1 MiB and 1000 records). */
  cwdReadable: boolean;
  /** Codex only: a session_meta marked as subagent stopped cwd discovery (T3 excludes the rollout). */
  subagent: boolean;
}

export function isValidScan(r: unknown): r is NativeScan {
  if (r === null || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return isStrOrNull(o.id) && isStrOrNull(o.cwd) && isStrOrNull(o.startedAt) && isStrOrNull(o.updatedAt) &&
    isNum(o.messageCount) && isNum(o.visibleUserCount) && isNum(o.corruptLines) &&
    isNum(o.cwdOffsetBytes) && typeof o.cwdReadable === "boolean" && typeof o.subagent === "boolean" &&
    (o.tooLarge === undefined || typeof o.tooLarge === "boolean");
}

export interface NativeAdapter extends SourceAdapter {
  /** Files that could not be read during the last `discover` run (never thrown). */
  lastErrors: { path: string; error: string }[];
}

export interface NativeAdapterOptions {
  /** Test hook: called each time a transcript is actually opened and scanned (cache miss). */
  onScan?: (path: string) => void;
  /** Test hook: read options for the transcript stream. */
  readOptions?: ReadOptions;
}

export interface NativeSpec {
  id: HarnessId;
  /** File name under `<stateDir>/cache/`. */
  cacheFile: string;
  /** Discovery cache format (default 3); bumped when what a scan records changes. */
  cacheVersion?: number;
  /** Root directory whose existence makes the harness available. */
  root(env: Env): string;
  /** Transcript files in T3 discovery order; never throws. */
  files(env: Env, onError: (path: string, error: string) => void): AsyncIterable<string>;
  /** Pi falls back to the file stem when the file carries no id; Codex does not (T3 never imports it). */
  stemFallback: boolean;
  scan(path: string, readOpts: ReadOptions): Promise<NativeScan>;
  /**
   * Codex only: compressed transcripts (`rollout-*.jsonl.zst`), which T3 Code cannot read. `id`: the display id of a
   * compressed path, else null. `convert(env)` true: the file is scanned (`scan` decompresses it while streaming) and
   * yielded in convert mode, flagged `compressed`; one file per session id is planned (a plain copy wins, see
   * discover) and every other copy is yielded flagged `duplicate-file` too. False: yielded unopened, flagged
   * `compressed` only (skipped).
   */
  compressed?: { id(path: string): string | null; convert(env: Env): boolean };
}

export function createNativeAdapter(spec: NativeSpec, opts: NativeAdapterOptions = {}): NativeAdapter {
  const adapter: NativeAdapter = {
    id: spec.id,
    mode: "native",
    lastErrors: [],
    async isAvailable(env: Env): Promise<boolean> {
      return (await statSafe(spec.root(env))) !== null;
    },
    async watchRoots(env: Env): Promise<string[]> {
      const root = spec.root(env);
      return (await statSafe(root)) !== null ? [root] : [];
    },
    async *fileTimes(env: Env): AsyncGenerator<FileTime> {
      const seen = new Set<string>();
      for await (const path of spec.files(env, () => {})) {
        if (seen.has(path)) continue;
        seen.add(path);
        const file = await statSafe(path).catch(() => null);
        if (file) yield { path, mtimeMs: file.mtimeMs };
      }
    },
    cachedFileTimes: (env: Env) => readCachedMtimes(join(env.stateDir, "cache", spec.cacheFile)),
    async *discover(env: Env): AsyncGenerator<DiscoveredSession> {
      adapter.lastErrors = [];
      const cachePath = join(env.stateDir, "cache", spec.cacheFile);
      const cache = createDiscoveryCache<NativeScan>(cachePath, spec.cacheVersion ?? CACHE_VERSION, isValidScan);
      await cache.load();
      const seen = new Set<string>();
      /** The cached or fresh scan of a file; null (error recorded) when it cannot be read. */
      const scanned = async (path: string, file: SourceFile): Promise<NativeScan | null> => {
        let result = cache.get(path, file.size, file.mtimeMs);
        if (!result) {
          try {
            opts.onScan?.(path);
            result = await spec.scan(path, opts.readOptions ?? {});
          } catch (e) {
            adapter.lastErrors.push({ path, error: (e as NodeJS.ErrnoException).code ?? String(e) });
            return null;
          }
        }
        cache.set(path, file.size, file.mtimeMs, result);
        return result;
      };
      // Compressed transcripts to convert: scanned after the plain ones, so a plain copy of the same session wins.
      const compressed: { path: string; file: SourceFile }[] = [];
      const plainIds = new Set<string>();
      for await (const path of spec.files(env, (p, error) => adapter.lastErrors.push({ path: p, error }))) {
        if (seen.has(path)) continue;
        seen.add(path);
        let file;
        try {
          file = await statSafe(path);
        } catch (e) {
          adapter.lastErrors.push({ path, error: (e as NodeJS.ErrnoException).code ?? String(e) });
          continue;
        }
        if (!file) {
          adapter.lastErrors.push({ path, error: "stat failed" });
          continue;
        }
        const compressedId = spec.compressed?.id(path) ?? null;
        if (compressedId !== null) {
          if (spec.compressed!.convert(env)) {
            compressed.push({ path, file });
            continue;
          }
          const mtimeIso = new Date(file.mtimeMs).toISOString();
          yield {
            harness: spec.id, accountId: null, nativeId: compressedId, cwd: null, startedAt: null, updatedAt: mtimeIso,
            messageCount: 0, corruptLines: 0, file, flags: ["compressed"], cwdOffsetBytes: 0,
          };
          continue;
        }
        const result = await scanned(path, file);
        if (!result) continue;
        if (result.id !== null) plainIds.add(result.id);
        const flags: SessionFlag[] = [];
        if (result.corruptLines > 0) flags.push("corrupt-lines");
        if (result.subagent) flags.push("subagent");
        else {
          if (result.cwd === null) flags.push("no-cwd");
          if (!result.cwdReadable) flags.push("cwd-unreadable");
        }
        if (result.id === null && !spec.stemFallback) flags.push("no-session-id");
        if (result.visibleUserCount === 0) flags.push("only-hidden");
        if (file.size > OVER_32MIB) flags.push("over-32mib");
        if (file.size > OVER_4GIB) flags.push("over-4gib");
        if (isActive(file.mtimeMs, env.now())) flags.push("active");
        const mtimeIso = new Date(file.mtimeMs).toISOString();
        yield {
          harness: spec.id,
          accountId: null,
          nativeId: result.id ?? basename(path, ".jsonl"),
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
      // Compressed transcripts, converted (convert mode): T3 never reads them, so its cwd window and 32 MiB read do not
      // apply (the converted transcript carries cwd on its first record and is sized by the writer).
      const scans: { path: string; file: SourceFile; result: NativeScan }[] = [];
      for (const { path, file } of compressed) {
        const result = await scanned(path, file);
        if (result) scans.push({ path, file, result });
      }
      // One planned file per session id; every other copy is listed, flagged `duplicate-file`. A plain copy wins. Among
      // compressed copies (Codex writes `<id>_<child>` rollouts carrying the parent's id): a usable one (not a
      // sub-agent, not too large, with a cwd and a visible user message) first, then the parent rollout (its file name carries the id inside),
      // then the path. Stable: activity never decides, so the choice does not flip between runs.
      const rank = (x: (typeof scans)[number]): [number, number, string] => [
        !x.result.subagent && !x.result.tooLarge && x.result.cwd !== null && x.result.visibleUserCount > 0 ? 0 : 1,
        spec.compressed!.id(x.path) === x.result.id ? 0 : 1,
        x.path,
      ];
      const before = (a: (typeof scans)[number], b: (typeof scans)[number]): boolean => {
        const [ra, rb] = [rank(a), rank(b)];
        return ra[0] !== rb[0] ? ra[0] < rb[0] : ra[1] !== rb[1] ? ra[1] < rb[1] : ra[2] < rb[2];
      };
      const best = new Map<string, (typeof scans)[number]>();
      for (const x of scans) {
        const id = x.result.id;
        if (id === null) continue;
        const cur = best.get(id);
        if (!cur || before(x, cur)) best.set(id, x);
      }
      for (const x of scans) {
        const { path, file, result } = x;
        const flags: SessionFlag[] = ["compressed"];
        if (result.id !== null && (plainIds.has(result.id) || best.get(result.id) !== x)) flags.push("duplicate-file");
        if (result.corruptLines > 0) flags.push("corrupt-lines");
        if (result.subagent) flags.push("subagent");
        else if (result.cwd === null) flags.push("no-cwd");
        if (result.id === null && !spec.stemFallback) flags.push("no-session-id");
        if (!result.subagent && result.visibleUserCount === 0) flags.push("only-hidden"); // a subagent scan stops at its meta
        if (result.tooLarge) flags.push("too-large");
        if (isActive(file.mtimeMs, env.now())) flags.push("active");
        const mtimeIso = new Date(file.mtimeMs).toISOString();
        yield {
          harness: spec.id, accountId: null, nativeId: result.id ?? basename(basename(path, ".zst"), ".jsonl"),
          cwd: result.cwd, startedAt: result.startedAt ?? mtimeIso, updatedAt: result.updatedAt ?? mtimeIso,
          messageCount: result.messageCount, corruptLines: result.corruptLines, file, flags, cwdOffsetBytes: 0, mode: "convert",
        };
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
