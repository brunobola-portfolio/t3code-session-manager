// What rollbackRun (src/ops/rollback.ts) takes and reports.

import type { Journal } from "../core/journal.ts";
import type { T3Api } from "../t3/api.ts";
import type { OrganizeUndoItem } from "../organize/apply.ts";
import type { MoveFs } from "./quarantine.ts";

export interface RollbackDeps {
  journal: Journal;
  /** Expanded homes of the configured accounts: the only places a rollback touches files. */
  accountHomes: string[];
  /** Opens T3 Code (only when the run touched T3). Omitted or failing: the T3 part is reported as not done. */
  connect?: () => Promise<T3Api>;
  now?: () => number;
  /** Restore instance displayName / accentColor / homePath from the journaled deltas. */
  instances?: boolean;
  /** Archive (never delete) the threads the run imported that are still active. */
  archiveThreads?: boolean;
  /** Report what would be undone; write nothing (T3 is only read). */
  dryRun?: boolean;
  fs?: MoveFs;
  platform?: NodeJS.Platform;
  /** Organize changes on an unverified T3 Code version: no warning (`--allow-untested`). */
  allowUntested?: boolean;
  onNotice?: (line: string) => void;
}

export type KeptReason = "revision continued" | "revision in use" | "revision rewritten" | "T3 Code unreachable" | `followed again by run ${string}; roll back ${string} first`;

export interface InstanceChange {
  instanceId: string;
  kind: "pinned" | "updated";
  previous: unknown;
  next: unknown;
  /** listed: shown only (no --instances); already: T3 already has the previous value. */
  status: "listed" | "restored" | "already" | "changed-since" | "not-restorable" | "failed";
  note?: string;
}

export interface RollbackReport {
  /** The rollback's own run id; null when nothing was written (dry run, or nothing left to undo). */
  runId: string | null;
  targetRunId: string;
  /** The target's run-start command, when it has one. */
  command: string | null;
  filesRemoved: string[];
  filesKeptModified: string[];
  /** Changed within the last 10 minutes (in use): kept; run rollback again later. */
  filesKeptActive: string[];
  /** Destination folders the run created for rehome copies, removed (would be, in a dry run) because they were empty. */
  foldersRemoved: string[];
  /** Such folders kept because something is in them now. */
  foldersKept: string[];
  /** Rewritten by a later run: left alone. */
  filesKeptRewritten: string[];
  /** Rehome copies a follow rewrote in place (refresh mode): kept, since their T3 thread already holds those records. */
  filesKeptRefreshed: string[];
  unquarantined: string[];
  unquarantineConflicts: { from: string; to: string }[];
  /** Back at the original path already (an earlier rollback crashed before journaling, or moved by hand). */
  alreadyRestored: string[];
  /** Neither in quarantine nor at the original path (moved elsewhere by hand). */
  unquarantineMissing: string[];
  unquarantineFailed: { path: string; reason: string }[];
  defaultsRestored: string[];
  defaultsSkipped: { projectId: string; reason: string }[];
  instanceChanges: InstanceChange[];
  instancesCreated: string[];
  projectsCreated: { projectId: string; root: string }[];
  /** Threads this run imported (or attempted) that T3 Code still has. Never deleted by t3sm. */
  threadsToReview: string[];
  /** false: T3 could not be read, threadsToReview lists every journaled candidate. */
  threadsVerified: boolean;
  threadsArchived: string[];
  /**
   * Copies the run parked (future file time) during a wave, never meant to be imported, whose thread exists in T3 Code
   * (it may predate the run). Listed for review only: never archived, never counted as imported.
   */
  parkedThreads: string[];
  /** Threads the run archived (a merge's old thread) that are active again. */
  threadsUnarchived: string[];
  /** Merges left in place because their revision was continued (or is in use) since: both threads stay as they are. */
  mergesKept: { nativeId: string; revisionFile: string; reason: KeptReason }[];
  /**
   * Threads left active although the rollback would have archived them, because archiving would leave their session
   * (original thread + merge revision threads) without any active thread. Review them in T3 Code.
   */
  needsReview: { threadId: string; reason: string }[];
  /** Organize changes of the run, newest first: reverted (would be, in a dry run), user-changed (left alone), already, failed. */
  organize: OrganizeUndoItem[];
  /** Why the T3 part was not done (e.g. "T3 Code not running"); null when T3 was reachable or not needed. */
  t3Unavailable: string | null;
  /** Includes every malformed or out-of-bounds journal entry that was skipped. */
  errors: string[];
}
