import type { CanonicalTranscript, Config, DiscoveredSession, HarnessId } from "../core/types.ts";

export interface Env {
  home: string;
  platform: NodeJS.Platform;
  now(): number;
  config: Config;
  /** t3sm state directory; adapters keep their discovery caches under `<stateDir>/cache/`. */
  stateDir: string;
  /** Process environment for adapters honouring CODEX_HOME / PI_CODING_AGENT_* (defaults to process.env; tests inject). */
  env?: NodeJS.ProcessEnv;
  /** Discover without writing anything (no discovery-cache save): `sync --dry-run`, `doctor`. */
  readOnly?: boolean;
}

/**
 * Whether a harness can be read on this machine: `absent` (not installed / no sessions), `ok`, `drift` (its storage
 * no longer has what the adapter reads; doctor warns) or `unreadable` (present but could not be read; doctor warns).
 */
export type Availability = "absent" | "ok" | { drift: string } | { unreadable: string };

export interface SourceAdapter {
  id: HarnessId;
  /** `native`: T3 Code imports the sessions itself. `convert`: t3sm reads them (`read`) and writes Claude transcripts. */
  mode: "native" | "convert";
  isAvailable(env: Env): Promise<boolean>;
  /** Finer than isAvailable, for doctor (optional; never throws). Read-only envs leave no persistent state. */
  availability?(env: Env): Promise<Availability>;
  discover(env: Env): AsyncIterable<DiscoveredSession>;
  /**
   * Convert-mode adapters only: the session as a CanonicalTranscript. Contract (every converter must keep it):
   * - messages in conversation order, roles `user` | `assistant` only, timestamps ISO-8601 (UTC);
   * - tool calls flattened into the text as `[tool <name>] <input> → <output>`, the part after the name at most 500
   *   characters (`…` appended when clipped); attachments as `[attachment: <name>]`; reasoning dropped;
   * - `activity` = the session's updatedAt / messageCount as seen by this read (same measure as discovery);
   * - never writes the source (read a private copy if the source cannot be opened without side effects);
   * - throws HarnessSchemaError when the storage no longer has what it reads, SourceBusyError when the source kept
   *   changing while it was read, SessionActiveError when the session itself is in use: its last activity AS OF THE
   *   STATE THIS RUN READS (a pinned snapshot / copy, not the live source) is within ACTIVE_WINDOW_MS of now. The
   *   caller defers the last two (next run), and fails the first.
   */
  read?(s: DiscoveredSession): Promise<CanonicalTranscript>;
  /** Existing directories whose changes can add or change sessions (`sync --watch` watches them). */
  watchRoots?(env: Env): Promise<string[]>;
  /**
   * Native adapters: the transcript files discovery lists, with their current times, from a stat-only walk (no file
   * is opened, nothing written; a file that cannot be stat'ed is skipped). Streams, so a caller can stop it early.
   */
  fileTimes?(env: Env): AsyncIterable<FileTime>;
  /** Native adapters: the file times the discovery cache recorded at its last full pass (empty when cold). Read-only. */
  cachedFileTimes?(env: Env): Promise<FileTime[]>;
}

export interface FileTime { path: string; mtimeMs: number }

/** A harness's storage no longer has what the adapter reads (a newer or older version of the agent). */
export class HarnessSchemaError extends Error {
  override name = "HarnessSchemaError";
  readonly harness: HarnessId;
  constructor(harness: HarnessId, message: string) {
    super(message);
    this.harness = harness;
  }
}

/** The source kept changing while it was being read: try again next run (deferred, not failed). */
export class SourceBusyError extends Error {
  override name = "SourceBusyError";
}

/** As of the state read (the run's pinned snapshot), the session was updated within ACTIVE_WINDOW_MS: in use; next run. */
export class SessionActiveError extends Error {
  override name = "SessionActiveError";
}

/** A transcript modified more recently than this is considered in use and is never touched. */
export { ACTIVE_WINDOW_MS } from "../core/activity.ts";
/** T3 Code reads `cwd` only from the first 1 MiB / 1000 records of a transcript (spike S2). */
export const CWD_SCAN_MAX_BYTES = 1_048_576;
export const CWD_SCAN_MAX_RECORDS = 1000;
