// What applyPlan takes and returns (src/apply/apply.ts): its dependencies, its result, the dry-run report, and the
// failure entries a screen names. No orchestration here.

import type { Config, DiscoveredSession, Plan, PlanItem } from "../core/types.ts";
import type { SourceAdapter } from "../sources/types.ts";
import type { ConvertFailReason } from "./materialize.ts";
import type { Journal, RecoverResult } from "../core/journal.ts";
import type { FolderEnv } from "../plan/folders.ts";
import type { CliKey } from "../i18n/cli.ts";
import type { Lang } from "../i18n/lang.ts";
import { conversationTitle } from "../plan/ownership.ts";
import type { T3Api } from "../t3/api.ts";
import { itemRoot } from "./waves.ts";
import type { FailReason, Progress } from "./importer.ts";
import type { BumpFile } from "./restore.ts";
export const PLAN_MAX_AGE_MS = 24 * 3_600_000;
export const STALE = "Plan is stale; run `t3sm plan` again.";

/** apply refuses to run (stale plan, instance home moved). Exit 2, nothing written. */
export class ApplyRefusal extends Error {
  override name = "ApplyRefusal";
  readonly exitCode = 2;
}

/** The signals that stop a writing run: Ctrl+C, a kill, and the terminal or console window closing. */
export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface SignalSource {
  on(sig: string, fn: () => void): void;
  off(sig: string, fn: () => void): void;
}

export interface ApplyDeps {
  stateDir: string;
  home: string;
  now?: () => number;
  connect?: (home: string, opts: { allowUntested: boolean; manageProviders: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;
  allowUntested?: boolean;
  /**
   * Pin T3's default Claude instance to the plan's `pinDefault` home when it is still implicit (default true). `sync`
   * passes false: an unattended run never changes T3's provider settings.
   */
  pinDefaultInstance?: boolean;
  /**
   * Every discovered session T3 could import (default: the loaded plan's items, before --only). Sync passes its full
   * plan here because its filtered plan drops held items, which are still on disk and still exposed.
   */
  exposure?: () => PlanItem[];
  /**
   * Fresh discovery of the native non-Claude harnesses (Codex, Pi), cached by the adapters: finds transcripts created
   * after planning. Called at most once per wave. Claude's new files are listed directly from the instance homes.
   */
  rediscover?: () => Promise<DiscoveredSession[]>;
  /** Config account id -> absolute home, for Claude instances T3 reports without a home (wave-time listing, conversions). */
  accountHomes?: () => Record<string, string>;
  /** Source adapters whose `read()` converts convert-import items (default allAdapters()). */
  adapters?: SourceAdapter[];
  /** Restrict the run to one project root (any spelling). */
  only?: string | null;
  batch?: Config["batch"];
  signals?: SignalSource;
  /**
   * Asked once, after every read-only check and before the first write, with the plan as it will run (--only
   * applied, sessions of projects held this run removed; their projects are still created) and the held project roots (a session of theirs is in use).
   * false: nothing is written (status "declined"). Omitted: proceed (--yes).
   */
  confirm?: (plan: Plan, held: { roots: string[]; sessions: number }, extra: { foldersToCreate: string[] }) => Promise<boolean>;
  /** One line per wave (progressLine: English, for logs and `--verbose`). */
  onProgress?: (line: string) => void;
  /** Once, right before the first wave: how many conversations the waves will import, into how many projects. */
  onImportStart?: (n: { sessions: number; projects: number }) => void;
  /** After every wave, its counts (the progress bar counts imported + failed + deferred as done). */
  onWave?: (p: Progress) => void;
  /** How many failures get their conversation's title read (the rows the screen shows); default 0, none. */
  failureTitles?: number;
  onNotice?: (line: string) => void;
  /** The language of the notices (default English). */
  lang?: Lang;
  platform?: NodeJS.Platform;
  /** Forced exit on the third SIGINT/SIGTERM (default process.exit); tests inject. */
  exit?: (code: number) => never;
  /** Journal run id (default: a new one). `sync` passes its plan's run id so runs/<id>/plan.md and the journal agree. */
  runId?: string;
  /** Journal run-start `command` (default `apply <planRunId>[ --only]`). */
  command?: string;
  /**
   * `sync`: when the checked plan has nothing to write (no instance, no pending import, no default to change), return
   * status "noop" without a single write (no run-start/run-end entries).
   */
  noopWithoutWrites?: boolean;
  /**
   * `apply --dry-run`: every read-only step (lock, plan load and checks, a read-only T3 connection, snapshot, mirror
   * and instance-home checks, held projects), then status "dry-run" with `dryRun` describing what a run would do.
   * Nothing is written: no recovery (pending file times are reported instead), no journal, no T3 write call.
   */
  dryRun?: boolean;
  /** Called once after every check (and confirm), right before the first write, with the plan as it will run (held projects' sessions removed). */
  beforeWrites?: (plan: Plan) => Promise<void>;
  /**
   * Extension point (Task 23 merge): runs while the lock is held and T3 is connected, after the waves and before
   * run-end; on a "noop" cycle it runs with runId null (it then journals its own run if it writes anything).
   */
  afterApply?: (ctx: AfterApplyContext) => Promise<void>;
  /**
   * Interactive runs only (`t3sm apply`, the assistant through it): create a missing destination folder of rehome copies
   * (spec 4.3) once it is checked against `env` (never a folder T3 Code refuses, nor a temp or system one). Omitted
   * (`sync`): no folder is ever created.
   */
  rehomeFolders?: RehomeFolders;
}

export interface RehomeFolders {
  env: FolderEnv;
  /** Creates the folder and its missing parents; returns the topmost one it created (undefined: it existed). Tests inject. */
  mkdir?: (path: string) => Promise<string | undefined>;
}

export interface AfterApplyContext {
  api: T3Api;
  journal: Journal;
  plan: Plan;
  result: ApplyResult;
  runId: string | null;
  /** The run was asked to stop (a signal, even one that arrived during afterApply): steps after it must not start. */
  aborted?: () => boolean;
  /** The files a step's waves have bumped or parked right now, for the forced exit's restore (the 3rd Ctrl+C). */
  onPendingFiles?: (files: BumpFile[] | null) => void;
}

/** What `apply --dry-run` found: the run as it would go, computed from the same checks, before any write. */
export interface DryRunReport {
  /** The plan as it would run (--only applied, held projects' sessions removed): what the confirmation summary shows. */
  plan: Plan;
  /** Transcript file times an interrupted run left bumped; a real run restores them first. */
  pendingRecovery: string[];
  instancesToCreate: string[];
  projectsToCreate: string[];
  defaultsToSet: { root: string; instanceId: string }[];
  /** convert-import items not in T3 yet (their transcripts would be written first). */
  conversions: number;
  waves: number;
  waveSessions: number;
  alreadyInT3: number;
  held: { roots: string[]; sessions: number };
  /** Pending items that cannot be imported whatever happens (cwd beyond T3's window, instance unavailable). */
  failUpFront: (ImportFailure & { reason: FailReason })[];
  /** The home T3's default Claude instance would be pinned to (it is implicit now), or null. */
  pinDefault: string | null;
  /** Destination folders of rehome copies a real run would create (`rehomeFolders` given; else none). */
  foldersToCreate: string[];
}

/**
 * One conversation that could not be imported, as a screen names it: its project root (where it was going) and its
 * title (Claude transcripts: `custom-title`, else `ai-title`; null for none or another harness), with the reason code.
 */
export interface ImportFailure {
  harness: string; nativeId: string; reason: FailReason | ConvertFailReason;
  projectRoot: string;
  title: string | null;
}

/** Each failure's transcript, beside it (never in the result itself): its title is read only for the rows shown. */
const FILE_OF = new WeakMap<ImportFailure, string>();

/** The failure entry for a plan item. Its title is filled by nameFailures, for the failures a screen shows. */
export function failureOf(i: PlanItem, reason: FailReason | ConvertFailReason): ImportFailure {
  const f: ImportFailure = { harness: i.session.harness, nativeId: i.session.nativeId, reason, projectRoot: itemRoot(i), title: null };
  FILE_OF.set(f, i.session.file.path);
  return f;
}

/**
 * Reads the title (`custom-title`, else `ai-title`; never message content) of the first `limit` failures that are
 * Claude transcripts: the rows a screen shows. 0 (an unattended or quiet run) reads no transcript at all.
 */
export async function nameFailures(failures: ImportFailure[], limit: number): Promise<void> {
  for (const f of failures.slice(0, Math.max(0, limit))) {
    const file = FILE_OF.get(f);
    if (f.title === null && f.harness === "claude" && file !== undefined) f.title = await conversationTitle(file);
  }
}

export interface ApplyResult {
  status: "ok" | "partial" | "aborted" | "locked" | "declined" | "noop" | "dry-run";
  dryRun?: DryRunReport;
  runId: string | null;
  imported: number;
  failed: number;
  failures: ImportFailure[];
  /** Converted transcripts written this run (convert-import items; files already in place are not counted). */
  converted: number;
  /** In use / changed / gone since planning (or, for conversions, the source busy / the session in use when read): left alone, the next run retries. */
  deferred: number;
  /** Of `deferred`: held because another transcript of their project is in use (T3 would import it now). */
  deferredInUse: number;
  /** The plan roots held this run (a transcript of the project in use). */
  heldRoots: string[];
  /**
   * Why each in-use root waits: the project's name as T3 shows it (its existing title, else the plan's, else the
   * folder), the transcript being written, its title (`custom-title`, else `ai-title`; null for none or another
   * harness) and its file time. Held projects are still created, empty (S6: project.create imports nothing).
   */
  held: { project: string; root: string; file: string; title: string | null; modifiedAt: string }[];
  /** Sessions of the plan that T3 already had when this run started. */
  alreadyInT3: number;
  restoreErrors: { path: string; error: string }[];
  /** Attempted, but T3's thread list could not be read afterwards (see the journal's import-attempt). */
  unverified: number;
  /** Other transcripts parked (future file time) while their project imported, summed over the waves. */
  parked: number;
  recovered: RecoverResult | null;
}

/** A notice in the run's language. */
export type Tr = (k: CliKey, v?: Record<string, string | number>) => string;
