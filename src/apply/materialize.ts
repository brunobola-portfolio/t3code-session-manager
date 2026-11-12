// materializeConversions: write the Claude transcript of every convert-import item (OpenCode sessions, Codex compressed
// rollouts) into its account's projects folder, so T3 Code imports it like any other Claude transcript.
//
// Safety rules (global constraints): the only files t3sm writes outside its state dir are these converted transcripts,
// at exactly `<account home>/projects/<encodeClaudeProjectDir(root)>/<uuid>.jsonl`, and nothing there is ever
// overwritten unless t3sm itself wrote it and it is untouched since:
// - a NEW file is written to a temp name in the same folder, given its mtime, then published with link + unlink
//   (publishNoClobber): if anything appeared at the target meanwhile, link fails with EEXIST and nothing is replaced
//   (`target-exists`). Never rename-over for a new file.
// - a file t3sm wrote earlier (journaled `file-written`, sha256 unchanged) whose source has moved on is refreshed by
//   rename-over, but only after re-hashing and re-stating it immediately before: changed since (resumed in T3 Code or
//   the CLI) or modified within ACTIVE_WINDOW_MS -> left exactly as it is.
// - a file whose first record is not t3sm's provenance for this session is never ours, whatever the journal says.
// Each write is journaled BEFORE it is published (rollback deletes it while its sha256 still matches), and cancelled
// with `file-write-aborted` if it is not published after all (the journal never ends with a write that did not happen).
//
// mtime (writtenMtime): the written file gets the source session's last activity (as read now), but never a time in
// the future and never older than now - 20 days. Not "now": that would make it look in use (ACTIVE_WINDOW_MS) and hold
// its project. Not older than 20 days: Claude Code deletes transcripts by mtime after cleanupPeriodDays (default 30),
// so a converted file must never start inside that zone. The chosen time is journaled. It then goes through the
// importer's waves (bump -> scan -> import -> restore) like any other transcript.
//
// Deferrals (next run, not failures): the source was busy (SourceBusyError) or the session is in use
// (SessionActiveError) when read.

import { link, mkdir, open, rename, rm, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AccountConfig, HarnessId, PlanItem } from "../core/types.ts";
import type { Journal } from "../core/journal.ts";
import { effectiveWrites, near } from "../core/journal.ts";
import { MoveRefused, publishNoClobber, sha256File, statSafe, sweepWriteTemps, writeTempPath, type LinkFs } from "../core/fsutil.ts";
import { encodeClaudeProjectDir, expandHome, normalizeCwd, pathKey } from "../core/paths.ts";
import { SessionActiveError, SourceBusyError, type SourceAdapter } from "../sources/types.ts";
import { isActive } from "../core/activity.ts";
import { toClaudeJsonl } from "./claudeWriter.ts";

/**
 * Why an item was not materialized:
 * - `no-reader`: no adapter with `read()` for its harness (the map holds every adapter that converts sessions).
 * - `target-outside-accounts`: the target is not `<account home>/projects/<encoded root>/<uuid>.jsonl`.
 * - `target-exists`: a file t3sm did not write already sits at the target (or appeared there while writing).
 * - `read-failed: <message>` / `write-failed: <message>`.
 */
export type ConvertFailReason = "no-reader" | "target-outside-accounts" | "target-exists" | `read-failed: ${string}` | `write-failed: ${string}`;
/** Not attempted this run, retried next run: the source kept changing, or the session is in use. */
export type ConvertDeferReason = "source-busy" | "active";

/** A file t3sm writes (converted transcript, merge revision) is never given a time older than this before now. */
export const WRITTEN_MAX_AGE_MS = 20 * 86_400_000;

/** The mtime of a file t3sm writes: its session's last activity, clamped to [now - 20 days, now]. */
export function writtenMtime(activityMs: number, now: number): number {
  const t = Number.isFinite(activityMs) ? Math.min(activityMs, now) : now;
  return Math.max(t, now - WRITTEN_MAX_AGE_MS);
}

export interface MaterializeResult {
  /** Target files written by this call. */
  written: string[];
  /** Target files already in place: identical to the conversion, or ours and resumed since (also in `resumed`). */
  unchanged: string[];
  /** Of `unchanged`: written by t3sm earlier and changed since (resumed); left exactly as they are. */
  resumed: string[];
  failed: { item: PlanItem; reason: ConvertFailReason }[];
  deferred: { item: PlanItem; reason: ConvertDeferReason }[];
  /**
   * The items whose target is in place, ready for the importer's waves: same action, `session.file` = the target
   * file as it is now, `cwdOffsetBytes` = the first record (which carries cwd). Plan order.
   */
  ready: PlanItem[];
}

/** Filesystem calls of the publish step; injected by tests to race it. */
export interface MaterializeFs extends LinkFs {
  rename(from: string, to: string): Promise<void>;
  /** Called right before a target is published or re-checked for a refresh (tests: a writer appears). */
  beforePublish?(target: string): Promise<void>;
}

export interface MaterializeOptions {
  platform?: NodeJS.Platform;
  /** For `~` in account homes (default: none expected; apply passes absolute homes). */
  home?: string;
  now?: () => number;
  fs?: MaterializeFs;
}

const nodeFs: MaterializeFs = { link, unlink, rename };
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The first line of a file (at most 64 KiB read), or null. */
async function firstLine(file: string): Promise<string | null> {
  try {
    const fh = await open(file, "r");
    try {
      const buf = Buffer.alloc(65_536);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const text = buf.subarray(0, bytesRead).toString("utf8");
      const nl = text.indexOf("\n");
      return nl < 0 ? null : text.slice(0, nl);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

export async function materializeConversions(
  items: PlanItem[],
  adapters: Map<HarnessId, SourceAdapter>,
  accounts: AccountConfig[],
  j: Journal,
  runId: string,
  opts: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const platform = opts.platform ?? process.platform;
  const fs = opts.fs ?? nodeFs;
  const now = opts.now ?? Date.now;
  const p = platform === "win32" ? path.win32 : path.posix;
  const key = (x: string): string => pathKey(x, platform);
  const projectsDirs = new Set(accounts.map((a) => key(p.join(opts.home ? expandHome(a.home, opts.home) : a.home, "projects"))));

  // The last file-written entry of every path: what t3sm itself put there.
  const ours = new Map<string, string>();
  // Aborted writes (never published) do not count: effectiveWrites drops them.
  for (const e of effectiveWrites(await j.readAll(), key)) ours.set(key(e.path), e.sha256);

  const swept = new Set<string>();
  const res: MaterializeResult = { written: [], unchanged: [], resumed: [], failed: [], deferred: [], ready: [] };
  for (const item of items) {
    const a = item.action;
    if (a.kind !== "convert-import") continue;
    const s = item.session;
    const fail = (reason: ConvertFailReason): void => void res.failed.push({ item, reason });
    const target = a.targetFile;
    const parent = p.dirname(target);
    const valid = !target.split(/[\\/]/).includes("..")
      && p.basename(target) === `${a.uuid}.jsonl`
      && p.basename(parent) === encodeClaudeProjectDir(normalizeCwd(a.projectRoot, platform))
      && projectsDirs.has(key(p.dirname(parent)));
    if (!valid) { fail("target-outside-accounts"); continue; }
    const adapter = adapters.get(s.harness);
    if (!adapter?.read) { fail("no-reader"); continue; }

    let text: string;
    let activity: { updatedAt: string; messageCount: number };
    try {
      const t = await adapter.read(s);
      activity = t.activity ?? { updatedAt: s.updatedAt, messageCount: s.messageCount };
      text = toClaudeJsonl(t, { uuid: a.uuid, cwd: platform === "win32" ? path.win32.normalize(a.projectRoot) : a.projectRoot }).text;
    } catch (e) {
      if (e instanceof SourceBusyError) res.deferred.push({ item, reason: "source-busy" });
      else if (e instanceof SessionActiveError) res.deferred.push({ item, reason: "active" });
      else fail(`read-failed: ${errText(e)}`);
      continue;
    }
    const sha = createHash("sha256").update(text, "utf8").digest("hex");
    const mtimeMs = writtenMtime(Date.parse(activity.updatedAt), now());
    const provenance = text.slice(0, text.indexOf("\n"));
    /** Ours = the journal says t3sm wrote it AND it still starts with this session's provenance record. */
    const isOurs = async (): Promise<boolean> => ours.has(key(target)) && (await firstLine(target)) === provenance;

    try {
      const existing = await statSafe(target);
      /** Refreshing our own earlier write: its sha256 at check time. */
      let refreshFrom: string | null = null;
      if (existing !== null) {
        const have = await sha256File(target);
        if (have === sha) {
          // Identical. Ours with a fresh mtime = a crash between publish and utimes: give it its time back. Ours and
          // aged past now - 20 days while waiting for its import: re-clamped, so it never drifts into Claude Code's
          // cleanup zone (utimes only: same bytes, still the file the journal's file-written names).
          const mine = ours.get(key(target)) === sha && !near(existing.mtimeMs, mtimeMs);
          if (mine && (existing.mtimeMs > mtimeMs || existing.mtimeMs < now() - WRITTEN_MAX_AGE_MS)) await utimes(target, mtimeMs / 1000, mtimeMs / 1000);
          res.unchanged.push(target);
          await ready(item, target, text, res);
          continue;
        }
        if (!(await isOurs())) { fail("target-exists"); continue; }
        if (ours.get(key(target)) !== have || isActive(existing.mtimeMs, now())) {
          // Written by t3sm, changed since (resumed) or being written now: it is the user's transcript now.
          res.unchanged.push(target);
          res.resumed.push(target);
          await ready(item, target, text, res);
          continue;
        }
        refreshFrom = have; // ours, untouched since, but the source has moved on
      }
      await mkdir(parent, { recursive: true });
      if (!swept.has(key(parent))) { swept.add(key(parent)); await sweepWriteTemps(parent); } // left by a dead run
      const tmp = writeTempPath(parent, a.uuid); // not *.jsonl: no scanner takes it
      const before = ours.get(key(target));
      let journaled = false;
      let published = false;
      try {
        await writeFile(tmp, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await utimes(tmp, mtimeMs / 1000, mtimeMs / 1000);
        await j.append({
          t: "file-written", runId, path: target, sha256: sha, mtimeMs,
          source: { harness: s.harness, nativeId: s.nativeId, updatedAt: activity.updatedAt, messageCount: activity.messageCount },
        });
        journaled = true;
        ours.set(key(target), sha);
        await fs.beforePublish?.(target);
        if (refreshFrom === null) {
          try {
            await publishNoClobber(tmp, target, fs);
            published = true;
          } catch (e) {
            if (e instanceof MoveRefused && e.code === "EEXIST") { fail("target-exists"); continue; } // appeared meanwhile
            throw e;
          }
        } else {
          // Re-check right before replacing: still exactly the file we checked (our earlier write), and not in use.
          const st = await statSafe(target);
          const still = st !== null && (await sha256File(target)) === refreshFrom;
          if (st === null || !still || isActive(st.mtimeMs, now())) {
            res.unchanged.push(target);
            res.resumed.push(target);
            await ready(item, target, text, res);
            continue;
          }
          await fs.rename(tmp, target);
          published = true;
        }
      } finally {
        if (journaled && !published) {
          // The journal must not end with a write that never happened: cancel it, and forget it here too.
          await j.append({ t: "file-write-aborted", runId, path: target });
          if (before === undefined) ours.delete(key(target)); else ours.set(key(target), before);
        }
        await rm(tmp, { force: true }).catch(() => {});
      }
      res.written.push(target);
      await ready(item, target, text, res);
    } catch (e) {
      fail(`write-failed: ${errText(e)}`);
    }
  }
  return res;
}

/** The item as the importer sees it: its file is the converted transcript. */
async function ready(item: PlanItem, target: string, text: string, res: MaterializeResult): Promise<void> {
  const st = await statSafe(target);
  if (st === null) throw new Error(`${target} vanished after it was written`);
  const nl = text.indexOf("\n");
  res.ready.push({ ...item, session: { ...item.session, file: st, cwdOffsetBytes: Buffer.byteLength(text.slice(0, nl + 1), "utf8") } });
}
