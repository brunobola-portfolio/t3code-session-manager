// Merge revisions (spec §4.6, docs/spikes/S3-conversion.md §6, docs/spikes/S5-merge.md): bring work continued in a
// terminal (`claude --resume`) into T3 Code. T3 continues an imported thread from the last record IT wrote, so terminal
// turns end up on a side branch T3 never shows. A merge writes a linear "revision" transcript of the branch
// `claude --resume` would continue, imports it as a NEW thread, and only then archives the old thread.
//
// Rules:
//   - the original transcript is NEVER modified; the revision is a new file `<same dir>/<revisionUuid>.jsonl`
//     (revisionUuid = uuidV5("rev:<nativeId>:<size>")), never written over a file t3sm did not write, journaled
//     (`file-written` with `revisionOf`) before it is published, published without clobbering (link), given the
//     source's mtime. Its bytes depend only on the source (the provenance date is the source's mtime);
//   - the import goes through runWaves (bump / park / restore, exposure, held projects): a project with another
//     transcript in use defers the merge ("project-in-use");
//   - only after the new thread is confirmed in T3's thread list (unarchived first if a rolled-back merge left it
//     archived): archiveThread(old), journal `thread-archived`, then `merged`. A failed or deferred import deletes the
//     revision (while it is still exactly what t3sm wrote) and leaves the old thread alone; only the failure is
//     journaled (runWaves' import-failed);
//   - transcripts are streamed (two passes: an index of byte offsets, then the chain records read back by offset), so
//     a transcript over 32 MiB never sits in memory; verdicts are cached by (path, size, mtime, baseline).
//
// Branch and leaf (S3 §6, measured): nodes = records with a uuid, any type, not isSidechain. Leaf = the record named by
// the newest `last-prompt.leafUuid` that resolves, else the last node in file order. Chain = walk parentUuid from the
// leaf to the root. A revision is written only from a whole chain: a root whose parent is set but unknown, a cycle, or a
// corrupt line inside the chain's byte range -> skipped (`broken-chain` / `corrupt-lines`), never a truncated revision.
// A chain that crosses a compaction (`compact_boundary`, or a record with `logicalParentUuid`) -> `compacted`: merging
// compacted sessions is not supported yet. The revision holds a provenance record (isMeta user, parentUuid null) and
// then the chain root->leaf with `sessionId` rewritten and the chain root's `parentUuid` pointed at the provenance
// record; uuids and everything else are kept. Records without a uuid (last-prompt, summary, custom-title, ...) are not
// carried: none is needed to resume, and a copied last-prompt would redirect the revision's own resume.
//
// "Continued outside T3" needs POSITIVE evidence (controller ruling R1): after the baseline (the size t3sm imported, or
// the size of the last merge), a visible message record (user/assistant; not isMeta, isSidechain, isCompactSummary,
// isVisibleInTranscriptOnly) on the branch `claude --resume` continues, whose `entrypoint` is a string other than
// "t3-code". A record without an entrypoint is not evidence. If T3 evidently wrote since the baseline (the thread's
// latestUserMessageAt is newer than the baseline file's mtime) but no record after the baseline carries "t3-code",
// T3's marker may have changed: `no-t3-marker`, never merged. Sessions t3sm did not import have no baseline: never
// candidates.

import { createReadStream } from "node:fs";
import { link, mkdir, open, readFile, rm, unlink, utimes } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Config, HarnessId, JournalEntry, PlanItem } from "../core/types.ts";
import type { Journal } from "../core/journal.ts";
import { effectiveWrites, importedIndex, near } from "../core/journal.ts";
import { revisionUuid, uuidV5 } from "../core/uuid.ts";
import { MoveRefused, atomicWrite, publishNoClobber, sha256File, statSafe, sweepWriteTemps, writeTempPath, type LinkFs } from "../core/fsutil.ts";
import { pathKey } from "../core/paths.ts";
import { DEFAULT_BATCH } from "../core/config.ts";
import { isActive } from "../core/activity.ts";
import type { T3Api, T3Project, T3Thread } from "../t3/api.ts";
import { exposureOf, liveExposure } from "../apply/apply.ts";
import { runWaves, type BumpFile } from "../apply/importer.ts";
import { buildWaves, rootKey } from "../apply/waves.ts";
import { WRITTEN_MAX_AGE_MS, writtenMtime } from "../apply/materialize.ts";

export { revisionUuid };

/** sync merges at most this many sessions per cycle. */
export const MERGES_PER_CYCLE = 20;
const T3_ENTRYPOINT = "t3-code";

// unsettled: an unreadable line after the chain (a record being written, or a torn tail): skipped this run, like active.
export type BranchProblem = "broken-chain" | "corrupt-lines" | "compacted" | "unsettled";

export type MergeSkipReason =
  | BranchProblem
  | "active" // written in the last 10 minutes (or while the merge ran): next time
  | "not-continued" // no positive evidence of terminal work on the branch `claude --resume` continues
  | "no-t3-marker" // T3 wrote since the import, but no record carries entrypoint "t3-code": T3's marker may have changed
  | "already-merged" // this exact revision (same session, same size) was merged before
  | "thread-archived" // its T3 thread is archived (merged earlier, or archived by the user)
  | "target-exists" // a file t3sm did not write sits at the revision path
  | "revision-in-use" // the revision t3sm wrote earlier was continued since (resumed before an interrupted run ended)
  | "copy-failed" // reading the source or writing the revision failed
  | "import-failed" // T3 did not import the revision (journaled by the importer)
  | "import-unverified" // T3's thread list could not be read after the import; the revision is kept for the next run
  | "project-in-use" // another transcript of the project is being written: T3 would import it now
  | "archive-failed" // the new thread exists, but the old one could not be archived; the next run retries
  | "over-cap" // more candidates than this run's limit: next run
  | "clock-jump" // the system clock jumped (sleep, time change) during the import: next run
  | "file-busy" // a transcript of its project stayed locked by another program: next run
  | "aborted"; // interrupted (Ctrl+C) before this session was merged

/** Waiting on something else (counted as merge-deferred by sync); "active" is the user's own session, not counted. */
export const DEFERRED_REASONS: ReadonlySet<MergeSkipReason> = new Set(["project-in-use", "over-cap", "clock-jump", "file-busy", "aborted"]);
/** Failures worth an exit code 5. */
export const FAILED_REASONS: ReadonlySet<MergeSkipReason> = new Set(["copy-failed", "import-failed", "import-unverified", "archive-failed"]);

// ---------------- reading the branch ----------------

export interface BranchNode {
  uuid: string; parent: string | null; type: string;
  /** A message the user sees: user/assistant, not isMeta / isCompactSummary / isVisibleInTranscriptOnly. */
  visible: boolean;
  /** A compaction boundary (`compact_boundary`, or `logicalParentUuid` set). */
  compact: boolean;
  entrypoint: string | null;
  /** Byte offset and length (newline included) of the record's line in the source. */
  offset: number; length: number;
  timestamp: string | null; cwd: string | null;
}

export interface TranscriptBranch {
  /** The record `claude --resume` continues from (null: no record with a uuid). */
  leaf: string | null;
  leafSource: "last-prompt" | "file-order" | null;
  /** Root -> leaf. */
  chain: BranchNode[];
  /** Why no revision may be written from this chain (null: it is whole). */
  problem: BranchProblem | null;
  /** Visible messages on the chain after the baseline whose entrypoint is a string other than "t3-code" (R1). */
  addedMessages: number;
  /** A record after the baseline carries entrypoint "t3-code". */
  t3MarkerAfter: boolean;
  /** Other leaves whose branch holds visible messages that are not on the chain (orphaned for T3 and the CLI alike). */
  divergedLeaves: number;
  /** Of those, the ones holding terminal work after the baseline (a visible message from an entrypoint other than T3). */
  orphanedTerminal: number;
  /** Newest timestamp on the chain. */
  lastActivity: string | null;
  corruptLines: number;
}

interface Line { offset: number; buf: Buffer }

/** Every line of a file with its byte offset, streamed (a line is held only while it is yielded). */
async function* fileLines(file: string): AsyncGenerator<Line> {
  const s = createReadStream(file, { highWaterMark: 1 << 20 });
  let pending: Buffer[] = [];
  let pendingLen = 0;
  let start = 0;
  for await (const chunk of s as AsyncIterable<Buffer>) {
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, from);
      if (nl === -1) {
        if (from < chunk.length) { pending.push(chunk.subarray(from)); pendingLen += chunk.length - from; }
        break;
      }
      const part = chunk.subarray(from, nl + 1);
      const buf = pendingLen > 0 ? Buffer.concat([...pending, part]) : part;
      yield { offset: start, buf };
      start += buf.length;
      pending = [];
      pendingLen = 0;
      from = nl + 1;
    }
  }
  if (pendingLen > 0) yield { offset: start, buf: Buffer.concat(pending) };
}

function parseLine(buf: Buffer, offset: number): Record<string, unknown> | null {
  let text = buf.toString("utf8");
  if (offset === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r?\n$/, "");
  if (text.trim() === "") return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The branch `claude --resume` would continue (S3 §6), whether it can be copied whole, and the positive evidence of
 * terminal work on it after `importedSize` (the baseline: the transcript's size when t3sm imported or last merged it).
 */
export async function readBranch(file: string, opts: { importedSize?: number | null } = {}): Promise<TranscriptBranch> {
  const nodes = new Map<string, BranchNode>();
  const lastPrompts: string[] = [];
  const corruptAt: number[] = [];
  let lastNode: string | null = null;
  let t3MarkerAfter = false;
  const baseline = opts.importedSize ?? 0;
  for await (const { offset, buf } of fileLines(file)) {
    const o = parseLine(buf, offset);
    if (o === null) {
      if (buf.toString("utf8").trim() !== "") corruptAt.push(offset);
      continue;
    }
    if (offset >= baseline && o.entrypoint === T3_ENTRYPOINT) t3MarkerAfter = true;
    if (o.type === "last-prompt") {
      if (typeof o.leafUuid === "string" && o.leafUuid !== "") lastPrompts.push(o.leafUuid);
      continue; // never a node
    }
    if (typeof o.uuid !== "string" || o.uuid === "" || o.isSidechain === true) continue;
    if (!nodes.has(o.uuid)) {
      const type = typeof o.type === "string" ? o.type : "";
      nodes.set(o.uuid, {
        uuid: o.uuid, parent: typeof o.parentUuid === "string" && o.parentUuid !== "" ? o.parentUuid : null, type,
        visible: (type === "user" || type === "assistant") && o.isMeta !== true && o.isCompactSummary !== true && o.isVisibleInTranscriptOnly !== true,
        compact: o.subtype === "compact_boundary" || (typeof o.logicalParentUuid === "string" && o.logicalParentUuid !== ""),
        entrypoint: typeof o.entrypoint === "string" ? o.entrypoint : null,
        offset, length: buf.length,
        timestamp: typeof o.timestamp === "string" ? o.timestamp : null, cwd: typeof o.cwd === "string" ? o.cwd : null,
      });
    }
    lastNode = o.uuid;
  }

  const res: TranscriptBranch = {
    leaf: null, leafSource: null, chain: [], problem: null, addedMessages: 0, t3MarkerAfter, divergedLeaves: 0, orphanedTerminal: 0, lastActivity: null,
    corruptLines: corruptAt.length,
  };
  // The newest last-prompt whose leafUuid resolves wins; an unresolvable newer one does not hide an older valid one.
  let fromPrompt: string | null = null;
  for (let i = lastPrompts.length - 1; i >= 0 && fromPrompt === null; i--) if (nodes.has(lastPrompts[i]!)) fromPrompt = lastPrompts[i]!;
  const leaf = fromPrompt ?? lastNode;
  if (leaf === null) return res;
  res.leaf = leaf;
  res.leafSource = fromPrompt !== null ? "last-prompt" : "file-order";

  const chain: BranchNode[] = [];
  const seen = new Set<string>();
  let id: string | null = leaf;
  while (id !== null) {
    if (seen.has(id)) { res.problem = "broken-chain"; break; } // cycle
    const n = nodes.get(id);
    if (!n) { res.problem = "broken-chain"; break; } // a parent that is not in the file
    seen.add(id);
    chain.push(n);
    id = n.parent;
  }
  res.chain = chain.reverse();
  if (res.problem === null && res.chain.some((n) => n.compact)) res.problem = "compacted";
  if (res.problem === null && corruptAt.length > 0) {
    const lo = Math.min(...res.chain.map((n) => n.offset));
    const hi = Math.max(...res.chain.map((n) => n.offset + n.length));
    if (corruptAt.some((o) => o >= lo && o < hi)) res.problem = "corrupt-lines";
    else if (corruptAt.some((o) => o >= hi)) res.problem = "unsettled";
  }
  const onChain = new Set(res.chain.map((n) => n.uuid));
  res.addedMessages = res.chain.filter((n) => n.visible && n.offset >= baseline && n.entrypoint !== null && n.entrypoint !== T3_ENTRYPOINT).length;
  for (let i = res.chain.length - 1; i >= 0 && res.lastActivity === null; i--) res.lastActivity = res.chain[i]!.timestamp;

  // Other leaves: report the ones whose own segment (up to the chain or an already walked node) holds messages.
  const parents = new Set<string>();
  for (const n of nodes.values()) if (n.parent !== null) parents.add(n.parent);
  const walked = new Set<string>(onChain);
  for (const n of nodes.values()) {
    if (parents.has(n.uuid) || n.uuid === leaf) continue;
    let msg = false;
    let terminal = false;
    for (let x: BranchNode | undefined = n; x && !walked.has(x.uuid); x = x.parent !== null ? nodes.get(x.parent) : undefined) {
      walked.add(x.uuid);
      if (x.visible) msg = true;
      if (x.visible && x.offset >= baseline && x.entrypoint !== null && x.entrypoint !== T3_ENTRYPOINT) terminal = true;
    }
    if (msg) res.divergedLeaves++;
    if (terminal) res.orphanedTerminal++;
  }
  return res;
}

// ---------------- verdict cache ----------------

type Verdict = Pick<TranscriptBranch, "problem" | "addedMessages" | "t3MarkerAfter" | "divergedLeaves" | "orphanedTerminal" | "lastActivity"> & { empty: boolean };
/** count: mergeable now; orphaned: sessions whose only terminal work sits on a side branch (never merged). */
export interface MergePending { count: number; orphaned: number; at: string }
interface CacheFile { version: 2; verdicts: Record<string, Verdict>; pending?: MergePending }

const cachePath = (stateDir: string): string => path.join(stateDir, "cache", "merge.json");

async function readCache(stateDir: string | undefined): Promise<CacheFile> {
  if (!stateDir) return { version: 2, verdicts: {} };
  try {
    const u = JSON.parse(await readFile(cachePath(stateDir), "utf8")) as CacheFile;
    if (u && u.version === 2 && typeof u.verdicts === "object" && u.verdicts !== null) return u;
  } catch { /* missing or unreadable: start over */ }
  return { version: 2, verdicts: {} };
}

async function writeCache(stateDir: string | undefined, c: CacheFile): Promise<void> {
  if (!stateDir) return;
  try {
    await mkdir(path.dirname(cachePath(stateDir)), { recursive: true });
    await atomicWrite(cachePath(stateDir), JSON.stringify(c) + "\n");
  } catch { /* a cache is never worth failing a merge */ }
}

/** Sessions continued in a terminal and mergeable, as last counted by sync or `t3sm merge` (null: never counted). */
export async function readMergePending(stateDir: string): Promise<MergePending | null> {
  const c = await readCache(stateDir);
  return c.pending && typeof c.pending.count === "number" ? { ...c.pending, orphaned: c.pending.orphaned ?? 0 } : null;
}

/** Records the pending counts (orphaned kept when omitted). */
export async function setMergePending(stateDir: string | undefined, count: number, at: Date, orphaned?: number): Promise<void> {
  if (!stateDir) return;
  const c = await readCache(stateDir);
  const next = { count, orphaned: orphaned ?? c.pending?.orphaned ?? 0 };
  if (c.pending?.count !== next.count || c.pending?.orphaned !== next.orphaned) { c.pending = { ...next, at: at.toISOString() }; await writeCache(stateDir, c); }
}

// ---------------- writing the revision ----------------

export interface PreparedRevision { tmp: string; sha256: string; size: number; firstLineBytes: number }

export function provenanceText(nativeId: string, at: Date): string {
  return `Merged revision of session ${nativeId} on ${at.toISOString()} by t3code-session-manager.`;
}

/**
 * Writes the revision to a temp file next to the source (`.<revisionUuid>.<pid>.<rand>.tmp`, not a `.jsonl`, so no
 * scanner takes it): the provenance record, then the chain root->leaf read back by offset. Same input, same bytes.
 * `at` is the date in the provenance text (executeMerges passes the source's mtime).
 */
export async function prepareRevision(
  source: string, branch: TranscriptBranch, o: { nativeId: string; revisionUuid: string; at: Date; cwd?: string | null },
): Promise<PreparedRevision> {
  if (branch.chain.length === 0) throw new Error("the transcript has no record with a uuid");
  if (branch.problem !== null) throw new Error(`refusing to write a revision from a ${branch.problem} transcript`);
  const rev = o.revisionUuid;
  const provUuid = uuidV5(`rev-provenance:${rev}`);
  const cwd = o.cwd ?? branch.chain.find((n) => n.cwd !== null)?.cwd ?? null;
  const ts = branch.chain.find((n) => n.timestamp !== null)?.timestamp ?? o.at.toISOString();
  const prov: Record<string, unknown> = {
    parentUuid: null, type: "user", isMeta: true, message: { role: "user", content: provenanceText(o.nativeId, o.at) },
    uuid: provUuid, timestamp: ts,
  };
  if (cwd !== null) prov.cwd = cwd;
  prov.sessionId = rev;
  const first = JSON.stringify(prov) + "\n";

  const tmp = writeTempPath(path.dirname(source), rev);
  const hash = createHash("sha256");
  let size = 0;
  const src = await open(source, "r");
  try {
    const out = await open(tmp, "wx");
    try {
      const put = async (s: string): Promise<void> => {
        const b = Buffer.from(s, "utf8");
        hash.update(b);
        size += b.length;
        await out.write(b);
      };
      await put(first);
      for (const [i, n] of branch.chain.entries()) {
        const buf = Buffer.alloc(n.length);
        const { bytesRead } = await src.read(buf, 0, n.length, n.offset);
        const rec = parseLine(buf.subarray(0, bytesRead), n.offset);
        if (rec === null || rec.uuid !== n.uuid) throw new Error(`${source} changed while the revision was written`);
        rec.sessionId = rev;
        if (i === 0) rec.parentUuid = provUuid;
        await put(JSON.stringify(rec) + "\n");
      }
      await out.sync();
    } finally {
      await out.close();
    }
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  } finally {
    await src.close();
  }
  return { tmp, sha256: hash.digest("hex"), size, firstLineBytes: Buffer.byteLength(first) };
}

/** Removes revision temp files (`.<rev>.<pid>.<rand>.tmp`) left in `dir` by a t3sm process that is gone. */
export const sweepStaleTemps = sweepWriteTemps;

// ---------------- candidates ----------------

export interface MergeCandidate {
  item: PlanItem;
  nativeId: string;
  sourcePath: string;
  source: { size: number; mtimeMs: number; atimeMs: number };
  projectId: string;
  /** The T3 project's workspace root (T3's spelling). */
  projectRoot: string;
  instanceId: string;
  oldThreadId: string;
  oldTitle: string;
  revisionUuid: string;
  revisionFile: string;
  newThreadId: string;
  addedMessages: number;
  divergedLeaves: number;
  lastActivity: string | null;
  /** The revision file is already there, written by t3sm and unchanged (an earlier run stopped before the archive). */
  reuse: { sha256: string } | null;
  branch: TranscriptBranch;
}

export interface MergeSkip { nativeId: string; reason: MergeSkipReason }

export interface MergedSession {
  nativeId: string; revisionUuid: string; revisionFile: string; newThreadId: string; oldThreadId: string; oldTitle: string;
  addedMessages: number; divergedLeaves: number; projectRoot: string;
}

export interface MergeResult { merged: MergedSession[]; skipped: MergeSkip[] }

/** A session that is not merged, but holds terminal work on a side branch neither T3 nor `claude --resume` shows. */
export interface OrphanedWork { nativeId: string; projectRoot: string; branches: number }

export interface MergeDeps {
  api: T3Api;
  journal: Journal;
  /** Journal run id, or a function called once right before the first write (it journals the run-start). */
  runId: string | (() => Promise<string>);
  now?: () => number;
  platform?: NodeJS.Platform;
  /** State dir: the verdict cache and the pending count live in <stateDir>/cache/merge.json. */
  stateDir?: string;
  /** A listing (`merge --dry-run`, `merge` without --all/--session): the cache is read, never written. */
  readOnly?: boolean;
  /** Retry a revision whose import failed before (default true; sync passes false: no retry storm every cycle). */
  retryFailed?: boolean;
  /** At most this many merges (the rest: "over-cap"). */
  limit?: number;
  /** Every discovered session T3 could import (exposure while the revision imports); default: the items. */
  exposureItems?: PlanItem[];
  /** Config account id -> absolute home (wave-time listing for instances T3 reports without a home). */
  accountHomes?: Record<string, string>;
  batch?: Config["batch"];
  aborted?: () => boolean;
  onProgress?: (line: string) => void;
  onPendingFiles?: (files: BumpFile[] | null) => void;
  /** Test hook for publishing the revision (link + unlink), e.g. a filesystem without hard links. */
  linkFs?: LinkFs;
}

const IMPORT_THREAD = /^import:([^:]+):(.+)$/s;

type MergedEntry = Extract<JournalEntry, { t: "merged" }>;
type WrittenEntry = Extract<JournalEntry, { t: "file-written" }>;

/** Merges still standing: not rolled back. */
function standingMerges(entries: JournalEntry[]): MergedEntry[] {
  const rolledBack = new Set(entries.flatMap((e) => (e.t === "rolled-back" ? [e.targetRunId] : [])));
  return entries.filter((e): e is MergedEntry => e.t === "merged" && !rolledBack.has(e.runId));
}

/** Revision files t3sm wrote that no standing merge uses (path identity per platform: case-folded on win32/darwin). */
export function unmergedRevisionFiles(entries: JournalEntry[], platform: NodeJS.Platform = process.platform): WrittenEntry[] {
  const key = (p: string): string => pathKey(p, platform);
  const used = new Set(standingMerges(entries).map((e) => key(e.revisionFile)));
  const last = new Map<string, WrittenEntry>();
  for (const e of effectiveWrites(entries, key)) if (e.revisionOf) last.set(key(e.path), e);
  return [...last].filter(([k]) => !used.has(k)).map(([, e]) => e);
}

/** Read-only (apart from the verdict cache): which of `items` would be merged, and why the others are not. */
export async function findMergeCandidates(items: PlanItem[], deps: MergeDeps): Promise<{ candidates: MergeCandidate[]; skipped: MergeSkip[]; orphaned: OrphanedWork[] }> {
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const key = (p: string): string => pathKey(p, platform);
  const entries = await deps.journal.readAll();
  const imported = importedIndex(entries);
  const ours = new Map<string, string>();
  for (const e of effectiveWrites(entries, key)) ours.set(key(e.path), e.sha256);
  const merges = standingMerges(entries);
  const mergedRevs = new Set(merges.map((e) => e.revisionUuid));
  const failedRevs = new Set(entries.filter((e) => e.t === "import-failed").map((e) => (e as { nativeId: string }).nativeId));
  const [threads, projects] = await Promise.all([deps.api.listThreads(), deps.api.listProjects()]);
  const byNative = new Map<string, T3Thread[]>();
  for (const t of threads) {
    const m = IMPORT_THREAD.exec(t.id);
    if (m) (byNative.get(m[2]!) ?? byNative.set(m[2]!, []).get(m[2]!)!).push(t);
  }
  const projectById = new Map<string, T3Project>(projects.map((p) => [p.id, p]));
  const cache = await readCache(deps.stateDir);
  const fresh: Record<string, Verdict> = {};
  let cacheChanged = false;

  const candidates: MergeCandidate[] = [];
  const skipped: MergeSkip[] = [];
  const orphaned: OrphanedWork[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const s = item.session;
    if (s.harness !== "claude" || item.action.kind !== "skip" || item.action.reason !== "already-in-t3") continue;
    if (seen.has(s.nativeId)) continue;
    seen.add(s.nativeId);
    const skip = (reason: MergeSkipReason): void => void skipped.push({ nativeId: s.nativeId, reason });
    const st = await statSafe(s.file.path).catch(() => null);
    if (st === null) continue;
    const rev = revisionUuid(s.nativeId, st.size);
    const revisionFile = path.join(path.dirname(s.file.path), `${rev}.jsonl`);
    const revSt = await statSafe(revisionFile).catch(() => null);
    if (mergedRevs.has(rev) && revSt !== null) { skip("already-merged"); continue; }
    const own = byNative.get(s.nativeId) ?? [];
    const thread = own.find((t) => !t.archived);
    if (!thread) { if (own.length > 0) skip("thread-archived"); continue; }
    const project = projectById.get(thread.projectId);
    if (!project) continue;

    // Baseline: what t3sm imported, or what it merged last (R1).
    const j = imported.get(`claude:${s.nativeId}`);
    if (!j) { skip("not-continued"); continue; } // not imported by t3sm: no baseline, never a candidate
    let base = { size: j.source.size, mtimeMs: j.source.mtimeMs };
    for (const m of merges) {
      if (m.nativeId === s.nativeId && typeof m.sourceSize === "number" && m.sourceSize > base.size && m.sourceSize <= st.size) {
        base = { size: m.sourceSize, mtimeMs: typeof m.sourceMtimeMs === "number" ? m.sourceMtimeMs : base.mtimeMs };
      }
    }
    if (base.size === st.size && near(st.mtimeMs, base.mtimeMs)) { skip("not-continued"); continue; }
    if (isActive(st.mtimeMs, now())) { skip("active"); continue; }
    if (deps.retryFailed === false && failedRevs.has(rev)) { skip("import-failed"); continue; }

    const ck = `${key(s.file.path)}|${st.size}|${st.mtimeMs}|${base.size}`;
    let branch: TranscriptBranch | null = null;
    let v = cache.verdicts[ck];
    if (!v) {
      try {
        branch = await readBranch(s.file.path, { importedSize: base.size });
      } catch {
        skip("copy-failed");
        continue;
      }
      v = {
        problem: branch.problem, addedMessages: branch.addedMessages, t3MarkerAfter: branch.t3MarkerAfter, divergedLeaves: branch.divergedLeaves,
        orphanedTerminal: branch.orphanedTerminal, lastActivity: branch.lastActivity, empty: branch.chain.length === 0,
      };
      cacheChanged = true;
    }
    fresh[ck] = v;
    if (v.problem !== null) { skip(v.problem); continue; }
    const orphan = (): void => { if (v.orphanedTerminal > 0) orphaned.push({ nativeId: s.nativeId, projectRoot: project.workspaceRoot, branches: v.orphanedTerminal }); };
    if (v.empty || v.addedMessages === 0) { skip("not-continued"); orphan(); continue; }
    const t3Wrote = typeof thread.latestUserMessageAt === "string" && Date.parse(thread.latestUserMessageAt) > base.mtimeMs;
    if (t3Wrote && !v.t3MarkerAfter) { skip("no-t3-marker"); orphan(); continue; }

    let reuse: MergeCandidate["reuse"] = null;
    if (revSt !== null) {
      const mine = ours.get(key(revisionFile));
      if (mine === undefined) { skip("target-exists"); continue; }
      const have = await sha256File(revisionFile).catch(() => null);
      if (have !== mine) { skip("revision-in-use"); continue; }
      reuse = { sha256: mine };
    }
    if (branch === null) {
      try {
        branch = await readBranch(s.file.path, { importedSize: base.size });
      } catch {
        skip("copy-failed");
        continue;
      }
      if (branch.problem !== null || branch.addedMessages === 0) { skip(branch.problem ?? "not-continued"); continue; }
    }
    const instanceId = IMPORT_THREAD.exec(thread.id)![1]!;
    candidates.push({
      item, nativeId: s.nativeId, sourcePath: s.file.path, source: { size: st.size, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs },
      projectId: project.id, projectRoot: project.workspaceRoot, instanceId, oldThreadId: thread.id, oldTitle: thread.title,
      revisionUuid: rev, revisionFile, newThreadId: `import:${instanceId}:${rev}`,
      addedMessages: branch.addedMessages, divergedLeaves: branch.divergedLeaves, lastActivity: branch.lastActivity, reuse, branch,
    });
  }
  candidates.sort((a, b) => a.source.mtimeMs - b.source.mtimeMs || (a.nativeId < b.nativeId ? -1 : a.nativeId > b.nativeId ? 1 : 0));
  // The pending counts (doctor's merge-pending check) and the verdicts of the sessions seen this run.
  const pendingChanged = cache.pending?.count !== candidates.length || (cache.pending?.orphaned ?? 0) !== orphaned.length || cache.pending === undefined;
  if (cacheChanged || pendingChanged || Object.keys(fresh).length !== Object.keys(cache.verdicts).length) {
    const pending = pendingChanged ? { count: candidates.length, orphaned: orphaned.length, at: new Date(now()).toISOString() } : cache.pending;
    if (!deps.readOnly) await writeCache(deps.stateDir, { ...cache, version: 2, verdicts: fresh, pending });
  }
  return { candidates, skipped, orphaned };
}

// ---------------- merging ----------------

/** Removes a file while it is still exactly what t3sm wrote. */
async function removeIfOurs(file: string, sha: string): Promise<boolean> {
  try {
    if ((await sha256File(file)) !== sha) return false;
    await rm(file, { force: true });
    return true;
  } catch {
    return false; // gone, or unreadable: left as it is
  }
}

/** Writes, imports and swaps the threads of each candidate, one at a time (see the header for the order). */
export async function executeMerges(candidates: MergeCandidate[], deps: MergeDeps): Promise<MergeResult> {
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const res: MergeResult = { merged: [], skipped: [] };
  const limit = deps.limit ?? Infinity;
  let started: Promise<string> | null = null;
  const runId = (): Promise<string> => (started ??= typeof deps.runId === "string" ? Promise.resolve(deps.runId) : deps.runId());
  let providers: Awaited<ReturnType<T3Api["providerInstances"]>> | null = null;
  const swept = new Set<string>();
  let journalNow: JournalEntry[] | null = null;
  let threadIdsNow: Set<string> | null = null;

  for (const [i, c] of candidates.entries()) {
    const skip = (reason: MergeSkipReason): void => void res.skipped.push({ nativeId: c.nativeId, reason });
    if (i >= limit) { skip("over-cap"); continue; }
    if (deps.aborted?.()) { skip("aborted"); continue; }
    const dir = path.dirname(c.revisionFile);
    if (!swept.has(dir)) { swept.add(dir); await sweepStaleTemps(dir); }

    // Earlier revisions of this session that were never merged (import failed, unverified, crash) and are still ours:
    // removed, unless T3 holds a thread for them.
    journalNow ??= await deps.journal.readAll();
    threadIdsNow = null;
    for (const e of unmergedRevisionFiles(journalNow, platform)) {
      if (e.revisionOf?.nativeId !== c.nativeId || e.path === c.revisionFile) continue;
      // Any instance's thread for that revision (an import under another account) keeps it.
      threadIdsNow ??= new Set((await deps.api.listThreads()).flatMap((t) => [IMPORT_THREAD.exec(t.id)?.[2] ?? "", t.nativeSessionId ?? ""]).filter((x) => x !== ""));
      if (threadIdsNow.has(path.basename(e.path, ".jsonl"))) continue;
      if (await removeIfOurs(e.path, e.sha256)) deps.onProgress?.(`Removed an unmerged earlier revision ${e.path}`);
    }

    // ---------- the revision file ----------
    let sha: string;
    let firstLineBytes: number;
    if (c.reuse) {
      sha = c.reuse.sha256;
      firstLineBytes = await firstLineLength(c.revisionFile);
      // The source must still be idle and unchanged right before the import (it was checked at planning time only).
      const again = await statSafe(c.sourcePath).catch(() => null);
      if (again === null || again.size !== c.source.size || !near(again.mtimeMs, c.source.mtimeMs) || isActive(again.mtimeMs, now())) {
        skip("active");
        continue;
      }
      // Ours (sha checked when it became a candidate) and aged past now - 20 days while unmerged: re-clamped (utimes
      // only), so it never drifts into Claude Code's cleanup zone while it waits.
      const revSt = await statSafe(c.revisionFile).catch(() => null);
      if (revSt !== null && revSt.mtimeMs < now() - WRITTEN_MAX_AGE_MS) {
        const t = writtenMtime(c.source.mtimeMs, now());
        await utimes(c.revisionFile, t / 1000, t / 1000);
      }
    } else {
      let prep: PreparedRevision;
      try {
        prep = await prepareRevision(c.sourcePath, c.branch, {
          nativeId: c.nativeId, revisionUuid: c.revisionUuid, at: new Date(c.source.mtimeMs),
          cwd: c.branch.chain.find((n) => n.cwd !== null)?.cwd ?? c.item.session.cwd,
        });
      } catch {
        skip("copy-failed");
        continue;
      }
      // Written to while we read it: the session is in use again; nothing was journaled yet.
      const again = await statSafe(c.sourcePath).catch(() => null);
      if (again === null || again.size !== c.source.size || !near(again.mtimeMs, c.source.mtimeMs)) {
        await rm(prep.tmp, { force: true });
        skip("active");
        continue;
      }
      const rid = await runId();
      const harness: HarnessId = "claude";
      const revMtime = writtenMtime(c.source.mtimeMs, now()); // never inside Claude Code's cleanup zone (materialize.ts)
      await deps.journal.append({ t: "file-written", runId: rid, path: c.revisionFile, sha256: prep.sha256, mtimeMs: revMtime, revisionOf: { harness, nativeId: c.nativeId } });
      try {
        // link + unlink only: never replaces a file at the target, never falls back to rename (fsutil.publishNoClobber).
        await publishNoClobber(prep.tmp, c.revisionFile, deps.linkFs ?? { link, unlink });
      } catch (e) {
        await rm(prep.tmp, { force: true }).catch(() => {});
        // Not published: the journal must not claim the file at that path is ours.
        await deps.journal.append({ t: "file-write-aborted", runId: rid, path: c.revisionFile });
        skip(e instanceof MoveRefused && e.code === "EEXIST" ? "target-exists" : "copy-failed");
        continue;
      }
      await utimes(c.revisionFile, revMtime / 1000, revMtime / 1000);
      sha = prep.sha256;
      firstLineBytes = prep.firstLineBytes;
    }

    // ---------- import through the waves ----------
    const rid = await runId();
    const st = await statSafe(c.revisionFile);
    if (st === null) { skip("copy-failed"); continue; }
    const item: PlanItem = {
      session: {
        ...c.item.session, nativeId: c.revisionUuid, file: st, flags: [], cwdOffsetBytes: firstLineBytes,
        updatedAt: c.lastActivity ?? new Date(c.source.mtimeMs).toISOString(),
      },
      action: { kind: "import", projectRoot: c.projectRoot, instanceId: c.instanceId, expectedThreadId: c.newThreadId },
      notes: [],
    };
    providers ??= await deps.api.providerInstances();
    const provs = providers;
    const batch = deps.batch ?? DEFAULT_BATCH;
    const cost = (x: PlanItem): number => x.session.cwdOffsetBytes;
    const homes = deps.accountHomes ?? {};
    const waves = await runWaves({
      api: deps.api, journal: deps.journal, runId: rid, now, platform, batch, cost,
      projectIds: new Map([[c.projectRoot, c.projectId]]),
      importRoots: new Map([[rootKey(c.projectRoot, platform), c.projectRoot]]),
      instanceAvailability: new Map(provs.map((p) => [p.instanceId, p.availability] as const)),
      exposure: exposureOf(deps.exposureItems ?? candidates.map((x) => x.item), provs, platform),
      liveExposure: liveExposure(() => provs, platform, undefined, { accountHome: (id) => (Object.hasOwn(homes, id) ? homes[id] : undefined) }),
      aborted: deps.aborted,
      onPendingFiles: deps.onPendingFiles,
      onProgress: () => {},
    }, buildWaves([item], batch, cost, { platform }));
    threadIdsNow = null;

    if (waves.imported.includes(item)) {
      // Confirmed in the thread list by the importer; read once more right before touching the old thread.
      const listed = await deps.api.listThreads().catch(() => null);
      const fresh = listed?.find((t) => t.id === c.newThreadId);
      if (!fresh) { skip("import-unverified"); continue; }
      try {
        // A rolled-back merge of the same revision left its thread archived: bring it back first (one active thread).
        if (fresh.archived) {
          await deps.api.unarchiveThread(c.newThreadId);
          await deps.journal.append({ t: "thread-unarchived", runId: rid, threadId: c.newThreadId });
        }
        await deps.api.archiveThread(c.oldThreadId);
      } catch {
        skip("archive-failed");
        continue;
      }
      await deps.journal.append({ t: "thread-archived", runId: rid, threadId: c.oldThreadId });
      await deps.journal.append({
        t: "merged", runId: rid, harness: "claude", nativeId: c.nativeId, revisionUuid: c.revisionUuid, revisionFile: c.revisionFile,
        oldThreadId: c.oldThreadId, newThreadId: c.newThreadId, sourceSize: c.source.size, sourceMtimeMs: c.source.mtimeMs,
      });
      journalNow = null;
      res.merged.push({
        nativeId: c.nativeId, revisionUuid: c.revisionUuid, revisionFile: c.revisionFile, newThreadId: c.newThreadId, oldThreadId: c.oldThreadId,
        oldTitle: c.oldTitle, addedMessages: c.addedMessages, divergedLeaves: c.divergedLeaves, projectRoot: c.projectRoot,
      });
      deps.onProgress?.(`Merged ${c.nativeId} -> ${c.newThreadId}`);
      continue;
    }
    if (waves.unverified.includes(item)) { skip("import-unverified"); continue; } // T3 may have it: keep the file
    await removeIfOurs(c.revisionFile, sha);
    const deferred = waves.deferred.find((d) => d.item === item);
    if (deferred) {
      skip(deferred.reason === "project-in-use" || deferred.reason === "clock-jump" || deferred.reason === "file-busy" ? deferred.reason : deferred.reason === "missing" ? "copy-failed" : "active");
    }
    else if (waves.failed.some((f) => f.item === item)) skip("import-failed");
    else skip("aborted");
  }
  return res;
}

async function firstLineLength(file: string): Promise<number> {
  for await (const { buf } of fileLines(file)) return buf.length;
  return 0;
}
