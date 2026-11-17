// The steps a merge (src/ops/merge.ts) and a follow (src/ops/follow.ts) share: write a revision transcript, publish it
// without clobbering (journaled first), import it through the waves, swap the threads, and journal what T3 Code holds.

import { link, open, rm, unlink, utimes } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Config, JournalEntry, PlanItem } from "../core/types.ts";
import type { Journal } from "../core/journal.ts";
import { uuidV5 } from "../core/uuid.ts";
import { MoveRefused, publishNoClobber, sha256File, sweepWriteTemps, writeTempPath, type LinkFs } from "../core/fsutil.ts";
import { DEFAULT_BATCH } from "../core/config.ts";
import type { T3Api, T3Thread } from "../t3/api.ts";
import { exposureOf, liveExposure } from "../apply/exposure.ts";
import { runWaves } from "../apply/importer.ts";
import type { BumpFile } from "../apply/restore.ts";
import { buildWaves, rootKey } from "../apply/waves.ts";
import { JournalWriteError } from "./quarantine.ts";
import { parseLine, type TranscriptBranch } from "./mergeBranch.ts";

type WrittenEntry = Extract<JournalEntry, { t: "file-written" }>;

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

/** Removes a file while it is still exactly what t3sm wrote. */
export async function removeIfOurs(file: string, sha: string): Promise<boolean> {
  try {
    if ((await sha256File(file)) !== sha) return false;
    await rm(file, { force: true });
    return true;
  } catch {
    return false; // gone, or unreadable: left as it is
  }
}

type WrittenExtra = Pick<WrittenEntry, "revisionOf" | "source" | "rehomeOf">;

/**
 * The revision write (merge, and follow: src/ops/follow.ts). `tmp` (next to `target`, not a .jsonl) is journaled as
 * `file-written` BEFORE it is published, then published without clobbering (link + unlink only: never replaces a file at
 * the target, never falls back to rename) and given `mtimeMs`. Not published: the temp is removed and the write is
 * cancelled with `file-write-aborted`, so the journal never claims a file t3sm did not write.
 */
export async function publishRevision(o: {
  tmp: string; target: string; sha256: string; mtimeMs: number; journal: Journal; runId: string; entry: WrittenExtra; linkFs?: LinkFs;
}): Promise<"published" | "target-exists" | "copy-failed"> {
  await o.journal.append({ t: "file-written", runId: o.runId, path: o.target, sha256: o.sha256, mtimeMs: o.mtimeMs, ...o.entry });
  try {
    await publishNoClobber(o.tmp, o.target, o.linkFs ?? { link, unlink });
  } catch (e) {
    await rm(o.tmp, { force: true }).catch(() => {});
    await o.journal.append({ t: "file-write-aborted", runId: o.runId, path: o.target });
    return e instanceof MoveRefused && e.code === "EEXIST" ? "target-exists" : "copy-failed";
  }
  await utimes(o.target, o.mtimeMs / 1000, o.mtimeMs / 1000);
  return "published";
}

export interface RevisionImportCtx {
  api: T3Api; journal: Journal; runId: string; now: () => number; platform: NodeJS.Platform;
  projectId: string; projectRoot: string;
  /** T3's provider instances (read once per run by the caller). */
  providers: Awaited<ReturnType<T3Api["providerInstances"]>>;
  /** Every discovered session T3 could import while the revision imports (exposure). */
  exposureItems: PlanItem[];
  accountHomes?: Record<string, string>;
  batch?: Config["batch"];
  aborted?: () => boolean;
  onPendingFiles?: (files: BumpFile[] | null) => void;
  /** The api runWaves talks to (default `api`); follow's refresh mode passes a view of it. */
  wavesApi?: T3Api;
}

/** What importRevision did: imported (in T3's thread list), unverified (T3 may have it), or why it was not imported. */
export type RevisionImportOutcome = "imported" | "import-unverified" | "project-in-use" | "clock-jump" | "file-busy" | "copy-failed" | "active" | "import-failed" | "aborted";

/**
 * The import step (merge and follow): one item through runWaves (bump / park / restore, exposure, held projects), alone
 * in its project's wave. The file is never removed here: the caller removes it (removeIfOurs) when it was not imported.
 */
export async function importRevision(item: PlanItem, o: RevisionImportCtx): Promise<RevisionImportOutcome> {
  const batch = o.batch ?? DEFAULT_BATCH;
  const cost = (x: PlanItem): number => x.session.cwdOffsetBytes;
  const homes = o.accountHomes ?? {};
  const provs = o.providers;
  const waves = await runWaves({
    api: o.wavesApi ?? o.api, journal: o.journal, runId: o.runId, now: o.now, platform: o.platform, batch, cost,
    projectIds: new Map([[o.projectRoot, o.projectId]]),
    importRoots: new Map([[rootKey(o.projectRoot, o.platform), o.projectRoot]]),
    instanceAvailability: new Map(provs.map((p) => [p.instanceId, p.availability] as const)),
    exposure: exposureOf(o.exposureItems, provs, o.platform),
    liveExposure: liveExposure(() => provs, o.platform, undefined, { accountHome: (id) => (Object.hasOwn(homes, id) ? homes[id] : undefined) }),
    aborted: o.aborted,
    onPendingFiles: o.onPendingFiles,
    onProgress: () => {},
  }, buildWaves([item], batch, cost, { platform: o.platform }));
  if (waves.imported.includes(item)) return "imported";
  if (waves.unverified.includes(item)) return "import-unverified"; // T3 may have it: the caller keeps the file
  const deferred = waves.deferred.find((d) => d.item === item);
  if (deferred) {
    return deferred.reason === "project-in-use" || deferred.reason === "clock-jump" || deferred.reason === "file-busy" ? deferred.reason : deferred.reason === "missing" ? "copy-failed" : "active";
  }
  if (waves.failed.some((f) => f.item === item)) return "import-failed";
  return "aborted";
}

/**
 * The archive step (merge and follow): only once the new thread is confirmed in T3's thread list (read once more right
 * before the old thread is touched). A rolled-back earlier swap left the new thread archived: unarchived first
 * (journaled), so the session always keeps one active thread. `beforeArchive` (follow: carry the old thread's title and
 * settled state) runs on the fresh new thread; its errors propagate. Then the old thread is archived and journaled
 * `thread-archived`. The caller journals what the swap was for (`merged`).
 */
export async function swapThreads(o: {
  api: T3Api; journal: Journal; runId: string; oldThreadId: string; newThreadId: string;
  /** false: do not archive the old thread (follow: the copy changed meanwhile); the new thread is left as it is. */
  beforeArchive?: (fresh: T3Thread) => Promise<boolean | void>;
}): Promise<"swapped" | "import-unverified" | "archive-failed" | "cancelled"> {
  const listed = await o.api.listThreads().catch(() => null);
  const fresh = listed?.find((t) => t.id === o.newThreadId);
  if (!fresh) return "import-unverified";
  if (fresh.archived) {
    try {
      await o.api.unarchiveThread(o.newThreadId);
    } catch {
      return "archive-failed";
    }
    await appendOrStop(o.journal, { t: "thread-unarchived", runId: o.runId, threadId: o.newThreadId }, `the unarchive of ${o.newThreadId}`);
  }
  if (o.beforeArchive && (await o.beforeArchive({ ...fresh, archived: false })) === false) return "cancelled";
  try {
    await o.api.archiveThread(o.oldThreadId);
  } catch {
    return "archive-failed";
  }
  await appendOrStop(o.journal, { t: "thread-archived", runId: o.runId, threadId: o.oldThreadId }, `the archive of ${o.oldThreadId}`);
  return "swapped";
}

/**
 * Journals a change T3 Code already holds. A failure is a JournalWriteError: the run stops (merge, follow and sync
 * never go on with T3 holding a change the journal did not hear of, which no rollback could undo).
 */
export async function appendOrStop(j: Journal, e: JournalEntry, what: string): Promise<void> {
  try {
    await j.append(e);
  } catch (err) {
    throw new JournalWriteError(`Could not write the journal (${err instanceof Error ? err.message : String(err)}) after T3 Code accepted ${what}; stopped.`);
  }
}
