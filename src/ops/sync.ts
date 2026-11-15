// `t3sm sync`: one unattended cycle = fresh plan + apply without asking, with the extra caution a scheduler needs.
// Safety rules (on top of everything applyPlan already does, including holding a project whose session is in use and
// parking every other in-window transcript of a project while it imports):
//   - never creates T3 instances: sessions of an account without an instance wait for `t3sm accounts --apply`;
//   - never quarantines or dedupes. Sessions continued in a terminal since t3sm imported them (Task 23) are only
//     counted and reported ("run `t3sm merge`", once per change of the count) unless config.sync.autoMerge is true
//     (default false): then, after an "ok" or no-op cycle, at most MERGES_PER_CYCLE are merged in their own
//     `sync-merge` run, never retrying a revision whose import failed; a merge error never changes the cycle's result;
//   - a session with a mirror copy inside T3's 30-day window waits for `t3sm dedupe` (the mirror itself is parked
//     while its project imports, so the rest of the project goes on);
//   - a session whose import failed after its last change waits for `t3sm apply` (no retry storm every cycle);
//   - never overrides a per-project default the user chose in T3 (only new or default-less projects get one);
//   - more than config.sync.maxUnattendedImports pending imports: nothing is written ("run `t3sm apply` once"), so the
//     first big import always happens with someone watching;
//   - a cycle with nothing to write writes nothing (no journal entry, no run folder, no unchanged discovery cache);
//   - honours the organize decisions and never asks (spec 4.7, safety invariant 13): sessions of a category nobody has
//     answered yet are not imported (counted per question, `needsAttention: undecided`); a copy from a folder T3 Code
//     refuses is written only to a destination that already exists in T3 (the General folder is never created here,
//     nor an inferred project that is not in T3 yet: held as `rehome-target-missing`); a new project folder is still
//     created, with the clean name the planner gives it;
//   - after a successful import, archives and retitles ONLY the threads that import just made (archive automated ones,
//     clean titles), and applies the history rule (spec §5.2: the last `days` shown, at least `minPerProject` per
//     project, older ones settled) to every imported thread of the projects that got new ones; once a day
//     (HISTORY_INTERVAL_MS after sync-status.json's lastHistoryAt) it applies the rule to every project, also on a cycle
//     with nothing to import. At most HISTORY_PER_CYCLE history changes per cycle (the first pass after an upgrade may
//     have thousands): the rest continues on the next cycle. All of it inside the cycle's run and lock, so
//     `t3sm rollback <run>` undoes it with the import; a thread changed by hand is never moved (the planner's
//     user-touched rule). Never pins or unpins, never deletes a project, never changes a T3 setting. An organize failure
//     (T3 refused) never undoes the import, is counted, and is not retried until the next cycle imports something new
//     (or, for the history rule, the next daily pass);
//   - then lets rehome copies follow their original (src/ops/follow.ts, spec §5.1.4), whatever sync.autoMerge says, in
//     the same run and lock (at most FOLLOWS_PER_CYCLE; a copy continued itself is a conflict and is never written).
// One T3 session per cycle: the read-only connection that builds the plan is the one apply uses.

import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { resolveLang, type Lang } from "../assistant/i18n.ts";
import type { Config, JournalEntry, Plan, PlanItem } from "../core/types.ts";
import { defaultConfig, loadConfig } from "../core/config.ts";
import { expandHome } from "../core/paths.ts";
import { allAdapters, isConvertSession } from "../sources/registry.ts";
import { discoverAll } from "../cli/commands/scan.ts";
import { atomicWrite, statSafe } from "../core/fsutil.ts";
import { Journal, newRunId, recoverPendingMtimes } from "../core/journal.ts";
import { acquireLock } from "../core/lock.ts";
import { STOP_SIGNALS, applyPlan, type AfterApplyContext, type ApplyResult, type ImportFailure, type SignalSource } from "../apply/apply.ts";
import type { Progress } from "../apply/importer.ts";
import { cliT, type CliKey } from "../i18n/cli.ts";
import { inImportWindow } from "../core/activity.ts";
import { rootKey } from "../apply/waves.ts";
import { heldLine, renderPlanMarkdown } from "../plan/report.ts";
import { connectT3, type T3Api, type T3Project } from "../t3/api.ts";
import { RpcTimeout } from "../t3/errors.ts";
import { isT3Running } from "../t3/runtime.ts";
import type { SourceAdapter } from "../sources/types.ts";
import { defaultClaudeHome, planInstances } from "./accounts.ts";
import { freshPlan } from "../cli/commands/plan.ts";
import { buildOrganize } from "../cli/commands/organize.ts";
import type { Io } from "../cli/main.ts";
import { JournalWriteError } from "./quarantine.ts";
import { applyOrganize, failureText } from "../organize/apply.ts";
import { resolveGeneralFolder } from "../plan/categories.ts";
import { notifyAfterCycle, type ImportSummary, type Notifier } from "./notify.ts";
import { markHistoryPass, readLastHistoryAt, recordSyncStatus, type AttentionFacts, type FollowConflictEntry, type NeedsAttention, type Observed } from "./syncStatus.ts";
import type { OrganizePlan } from "../organize/types.ts";
import { describeError } from "./errorCodes.ts";
import { DEFERRED_REASONS, FAILED_REASONS, MERGES_PER_CYCLE, appendOrStop, executeMerges, findMergeCandidates, readMergePending, setMergePending, type MergeDeps } from "./merge.ts";
import { FOLLOWS_PER_CYCLE, followRehomed } from "./follow.ts";

export const DEFAULT_MAX_UNATTENDED_IMPORTS = 200;
/** The daily pass of the history rule: once per 24 h (sync-status.json lastHistoryAt). */
export const HISTORY_INTERVAL_MS = 86_400_000;
/**
 * History changes (settle / unsettle) per cycle, the daily pass and the one after an import together. One change is one
 * T3 command, and applyOrganize re-reads the thread list every THREAD_BATCH (50) of them: 200 is a few seconds of T3's
 * time per cycle, the same size as an unattended import (DEFAULT_MAX_UNATTENDED_IMPORTS). A first pass over thousands
 * of old conversations takes several cycles instead of one long burst.
 */
export const HISTORY_PER_CYCLE = 200;

/** `plan` with at most `budget` history actions (the first ones: every unsettle comes before any settle); the rest counted. */
function capHistory(plan: OrganizePlan, budget: number): { plan: OrganizePlan; deferred: number } {
  let used = 0;
  let deferred = 0;
  const actions = plan.actions.filter((a) => {
    if (a.kind !== "settle" && a.kind !== "unsettle") return true;
    if (used < budget) { used++; return true; }
    deferred++;
    return false;
  });
  if (deferred === 0) return { plan, deferred };
  const counts = { ...plan.counts };
  for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] = actions.filter((a) => a.kind === k).length;
  return { plan: { ...plan, actions, counts }, deferred };
}

export interface SyncCounts {
  imported: number;
  failed: number;
  deferred: number;
  unverified: number;
  alreadyInT3: number;
  /** Import items held back because their session has a mirror copy inside T3's window. */
  heldForDedupe: number;
  /** Import items held back because their account has no T3 instance yet. */
  heldForAccounts: number;
  /** Deferred because another transcript of their project was in use at wave time (T3 would import it now). */
  heldInUse: number;
  /** Import items whose last import failed after their last change: `t3sm apply` retries them. */
  heldFailed: number;
  /** --dry-run: import items a cycle would run. */
  wouldImport: number;
  /** Copies from a refused folder held because their destination project is not in T3 yet (`rehome-target-missing`). */
  heldRehome?: number;
  /** Sessions waiting for an organize question nobody answered, per question key (`t3sm start` asks). */
  undecided?: Record<string, number>;
  /** Organize changes made this cycle (the new threads, and the history rule) / that T3 refused. */
  organized?: number;
  organizeFailed?: number;
  /** History changes left for the next cycle (over historyPerCycle). */
  historyDeferred?: number;
  /** Other transcripts parked while their project imported (summed over the waves). */
  parked?: number;
  /** autoMerge: sessions merged this cycle, deferred (project in use, over the per-cycle cap, interrupted), failed. */
  merged?: number;
  mergeDeferred?: number;
  mergeFailed?: number;
  /** autoMerge off: sessions waiting for `t3sm merge`, set only when the count changed since it was last reported. */
  mergePending?: number;
  /** Sessions whose terminal work sits on a side branch T3 Code cannot show (never merged); set only when it changed. */
  mergeOrphaned?: number;
  /**
   * Rehome copies that followed their original this cycle (src/ops/follow.ts); conflicts (the copy and the original
   * both continued: nothing done); deferred (in use, T3 unreachable, over FOLLOWS_PER_CYCLE); failed (compacted, ...).
   */
  followed?: number;
  followConflicts?: number;
  /** The conflicts themselves (titles and session ids, never a path): summary lines and sync-status.json. */
  followConflictList?: FollowConflictEntry[];
  followDeferred?: number;
  followFailed?: number;
}

export type CycleOutcome = (
  | { kind: "t3-down"; runId?: string }
  | { kind: "locked" }
  | { kind: "over-limit"; pending: number; limit: number }
  | { kind: "ok" | "partial" | "aborted" | "noop"; runId: string | null; counts: SyncCounts; held?: HeldProject[];
      /** The conversations that could not be imported this cycle (project, title, reason): the screen's table. Never logged. */
      failures?: ImportFailure[] }
  | { kind: "dry-run"; runId: null; counts: SyncCounts; byHarness: Record<string, number>; projects: number; newProjects: number; overLimit: number | null }
  | { kind: "error"; exitCode: number; error: unknown }
) & {
  /** File times this cycle put back from an interrupted run (set only when something was recovered or failed). */
  recovered?: { restored: number; failed: number };
};

/** A project held this cycle (named as T3 shows it) and the conversation holding it (spec 4.6; `t3sm status` shows it). Never logged. */
export type HeldProject = ApplyResult["held"][number];

export const zeroCounts = (): SyncCounts => ({
  imported: 0, failed: 0, deferred: 0, unverified: 0, alreadyInT3: 0,
  heldForDedupe: 0, heldForAccounts: 0, heldInUse: 0, heldFailed: 0, heldRehome: 0, wouldImport: 0, merged: 0, mergeDeferred: 0, mergeFailed: 0,
});

// ---------- the sync filter (pure) ----------

export interface SyncFilterOptions {
  /** Paths of plan.mirrorCopies whose file is inside T3's 30-day import window right now. */
  liveMirrorPaths: Set<string>;
  /** T3's projects as read for this plan (to leave user-chosen defaults alone). */
  projects: T3Project[];
  platform?: NodeJS.Platform;
  /** "harness:nativeId" -> time of its newest import-failed entry (failedImports). */
  failedBefore?: Map<string, number>;
  /** The resolved General folder (resolveGeneralFolder): sync never creates it. */
  generalFolder?: string;
}

export interface SyncFilterResult {
  plan: Plan; heldForDedupe: number; heldForAccounts: number; heldFailed: number;
  /** Rehome copies (and imports into the same folder) held: their destination project is not in T3. */
  heldRehome: number;
  /** plan.decisionsPending as {question key: sessions}. */
  undecided: Record<string, number>;
}

export function filterForSync(plan: Plan, o: SyncFilterOptions): SyncFilterResult {
  const platform = o.platform ?? process.platform;
  const key = (p: string): string => rootKey(p, platform);
  const newInstances = new Set(plan.instancesToCreate.map((s) => s.id));
  const heldIds = new Set(plan.mirrorCopies.filter((m) => o.liveMirrorPaths.has(m.path)).map((m) => m.nativeId));

  let heldForDedupe = 0;
  let heldForAccounts = 0;
  let heldFailed = 0;
  let heldRehome = 0;
  const existing = (root: string): T3Project | undefined => o.projects.find((p) => !p.deleted && key(p.workspaceRoot) === key(root));
  // Where a copy from a refused folder (spec 4.3) would go: the General folder or a project inferred from its paths.
  const rehomeRoots = new Set(plan.items.flatMap((i) => (i.action.kind === "convert-import" && (i.action.rehomeFrom !== undefined || i.action.copy === "faithful") ? [key(i.action.projectRoot)] : [])));
  const items: PlanItem[] = [];
  for (const it of plan.items) {
    const a = it.action;
    if (a.kind === "skip") { items.push(it); continue; }
    if (newInstances.has(a.instanceId)) { heldForAccounts++; continue; }
    // Never creates a folder or project for a rehome copy: only where T3 already has the destination.
    if (a.kind === "convert-import" && (a.rehomeFrom !== undefined || a.copy === "faithful" || rehomeRoots.has(key(a.projectRoot))) && !existing(a.projectRoot)) { heldRehome++; continue; }
    if (heldIds.has(it.session.nativeId)) { heldForDedupe++; continue; }
    const failedAt = o.failedBefore?.get(`${it.session.harness}:${it.session.nativeId}`);
    // Changed since the failure? A convert-mode session is judged by its own activity (updatedAt): its source may be
    // shared (OpenCode's db: any session's change moves its mtime) or rewritten unchanged (a Codex compressed rollout).
    const changedAt = isConvertSession(it.session) ? Date.parse(it.session.updatedAt) : it.session.file.mtimeMs;
    if (failedAt !== undefined && failedAt > changedAt) { heldFailed++; continue; }
    items.push(it);
  }
  const importRoots = new Set(items.flatMap((i) => (i.action.kind === "skip" ? [] : [key(i.action.projectRoot)])));
  const generalKey = o.generalFolder === undefined ? null : key(o.generalFolder);
  return {
    heldForDedupe,
    heldForAccounts,
    heldFailed,
    heldRehome,
    undecided: Object.fromEntries((plan.decisionsPending ?? []).map((d) => [d.key, d.sessions])),
    plan: {
      ...plan,
      items,
      instancesToCreate: [],
      projectsToCreate: plan.projectsToCreate.filter((p) => importRoots.has(key(p.root)) && !(generalKey !== null && key(p.root) === generalKey && !existing(p.root))),
      projectDefaults: plan.projectDefaults.filter((d) => {
        if (newInstances.has(d.instanceId)) return false;
        const p = existing(d.root);
        return p ? p.defaultModelSelection == null : importRoots.has(key(d.root));
      }),
      // The live ones are parked by the waves; apply would only warn about them again.
      mirrorCopies: plan.mirrorCopies.filter((m) => !o.liveMirrorPaths.has(m.path)),
    },
  };
}

/** plan.mirrorCopies whose file is inside T3's 30-day import window now. */
export async function liveMirrorPaths(plan: Plan, now: number): Promise<Set<string>> {
  const out = new Set<string>();
  for (const m of plan.mirrorCopies) {
    const st = await statSafe(m.path).catch(() => null);
    if (st && inImportWindow(st.mtimeMs, now)) out.add(m.path);
  }
  return out;
}

const RUN_ID_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/;

/** "harness:nativeId" -> time of its newest import-failed entry (from the run id, UTC). Unparseable run ids are ignored. */
export function failedImports(entries: JournalEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (e.t !== "import-failed") continue;
    const m = RUN_ID_RE.exec(e.runId);
    if (!m) continue;
    const at = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    const k = `${e.harness}:${e.nativeId}`;
    if (at > (out.get(k) ?? -Infinity)) out.set(k, at);
  }
  return out;
}

class OverLimit extends Error {
  override name = "OverLimit";
  readonly pending: number;
  readonly limit: number;
  constructor(pending: number, limit: number) {
    super(`${pending} pending > ${limit}`);
    this.pending = pending;
    this.limit = limit;
  }
}

const UNREACHABLE = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

/** T3 went away or does not answer: retry like T3 down (60 s), not like an error. */
function unreachable(e: unknown): boolean {
  if (e instanceof RpcTimeout) return true;
  for (let c: unknown = e, i = 0; c && i < 4; c = (c as { cause?: unknown }).cause, i++) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === "string" && UNREACHABLE.has(code)) return true;
  }
  return e instanceof TypeError && /fetch failed/i.test(e.message);
}

// ---------- one cycle ----------

export interface SyncCycleDeps {
  home: string;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  platform?: NodeJS.Platform;
  adapters?: SourceAdapter[];
  connect?: (home: string, opts: { allowUntested: boolean; manageProviders: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;
  isT3Running?: (home: string) => Promise<boolean>;
  existsDir?: (p: string) => Promise<boolean>;
  allowUntested?: boolean;
  /** Plan only: no lock, no journal, no run folder, no discovery-cache write. */
  dryRun?: boolean;
  signals?: SignalSource;
  /** Task 23 hook (autoMerge): runs under the lock with T3 connected, after the waves (runId null on a no-op cycle). */
  afterApply?: (ctx: AfterApplyContext) => Promise<void>;
  onNotice?: (line: string) => void;
  onProgress?: (line: string) => void;
  /** The progress bar's hooks (ApplyDeps.onImportStart / onWave). */
  onImportStart?: (n: { sessions: number; projects: number }) => void;
  onWave?: (p: Progress) => void;
  /** How many failures get their conversation's title read (the rows the screen shows); default 0, none. */
  failureTitles?: number;
  /** Task 18: raises the optional system notifications (config.notify, default "attention"); absent: none. Never in --dry-run. */
  notifier?: Notifier;
  /** History changes per cycle (default HISTORY_PER_CYCLE). */
  historyPerCycle?: number;
  /**
   * --lang, when given: the language of the General folder's default name. Otherwise each cycle resolves it from `env`
   * and config.json "language" as it is then (resolveLang), the same way for the plan and for the filter.
   */
  lang?: Lang;
}

/** What a cycle saw besides its outcome, for sync-status.json (set by build). */
interface CycleInfo {
  undecided: Record<string, number>; heldRehome: number; signedOut: number; planned: { projects: number; newProjects: string[] };
  /** Set when the follow step ran: the conflicts it found (an empty list clears them in sync-status.json). */
  followConflicts?: FollowConflictEntry[];
}

export async function runSyncCycle(deps: SyncCycleDeps): Promise<CycleOutcome> {
  const recovered = { restored: 0, failed: 0 };
  const info: CycleInfo = { undecided: {}, heldRehome: 0, signedOut: 0, planned: { projects: 0, newProjects: [] } };
  const o = await cycle(deps, recovered, info);
  if (!deps.dryRun) {
    const obs = observe(o, info);
    // A status file that cannot be written never fails the cycle.
    const status = obs === null ? null : await recordSyncStatus(deps.stateDir, obs, new Date((deps.now ?? Date.now)())).catch(() => null);
    if (status !== null && deps.notifier) {
      const imported = o.kind === "ok" || o.kind === "partial" ? o.counts.imported : 0;
      const summary: ImportSummary | null = imported > 0 ? { imported, projects: Math.min(info.planned.projects, imported), newProjects: info.planned.newProjects } : null;
      const config = await loadConfig(deps.stateDir, deps.home).catch(() => null);
      // The watcher has no Io: the notification's language is resolved like the plan's (--lang, env, config.json).
      const lang = deps.lang ?? resolveLang(null, deps.env ?? process.env, config?.language ?? null);
      await notifyAfterCycle({ stateDir: deps.stateDir, mode: config?.notify ?? "attention", notifier: deps.notifier, now: (deps.now ?? Date.now)(), attention: status.needsAttention, summary, lang }).catch(() => []);
    }
  }
  return recovered.restored > 0 || recovered.failed > 0 ? { ...o, recovered } : o;
}


/**
 * The attention a cycle raised, by priority; null: nothing needs a person. Each carries its facts (the numbers it is
 * about) next to the English detail, worded from the same catalogue entry, so any language can be told from them.
 */
export function attentionOf(o: CycleOutcome, info: Pick<CycleInfo, "undecided" | "signedOut">): Omit<NeedsAttention, "since"> | null {
  const said = (reason: NeedsAttention["reason"], key: CliKey, facts: AttentionFacts, command: string): Omit<NeedsAttention, "since"> =>
    ({ reason, detail: cliT("en", key, facts as Record<string, number>), command, facts });
  if (info.signedOut > 0) return said("signed-out", "notify.signedOut", { n: info.signedOut }, "t3sm accounts");
  if (o.kind === "over-limit") return said("over-limit", "notify.overLimit", { n: o.pending, limit: o.limit }, "t3sm start");
  const sessions = Object.values(info.undecided).reduce((a, n) => a + n, 0);
  const questions = Object.keys(info.undecided).length;
  if (questions > 0) return said("undecided", "notify.undecided", { n: sessions, q: questions }, "t3sm start");
  return null;
}

/** A T3 Code version t3sm cannot talk to: needs a person (t3-incompatible). */
export function incompatibleAttention(version: string): Omit<NeedsAttention, "since"> {
  return { reason: "t3-incompatible", detail: cliT("en", "notify.incompatible", { version }), command: "t3sm doctor", facts: { version } };
}

/** What sync-status.json should record for this outcome; null: the cycle did not look at anything (T3 closed, lock busy). */
function observe(o: CycleOutcome, info: CycleInfo): Observed | null {
  if (o.kind === "t3-down" || o.kind === "locked" || o.kind === "dry-run") return null;
  if (o.kind === "error") {
    const e = o.error as { name?: string; version?: unknown };
    if (e?.name === "T3Incompatible") {
      return { cycle: "failed", attention: incompatibleAttention(typeof e.version === "string" ? e.version : "?") };
    }
    return { cycle: "failed" };
  }
  const cycleKind = o.kind === "partial" ? "failed" : o.kind === "aborted" ? "unchanged" : "ok";
  if (o.kind === "aborted") return { cycle: cycleKind };
  return {
    cycle: cycleKind, attention: attentionOf(o, info), undecided: info.undecided, heldRehome: info.heldRehome,
    held: "held" in o ? (o.held ?? []).map((h) => ({ project: h.project, title: h.title, modifiedAt: h.modifiedAt })) : [],
    ...(info.followConflicts !== undefined ? { followConflicts: info.followConflicts } : {}),
  };
}

async function cycle(deps: SyncCycleDeps, recovered: { restored: number; failed: number }, info: CycleInfo): Promise<CycleOutcome> {
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const notice = deps.onNotice ?? (() => {});
  const connect = deps.connect ?? connectT3;
  const counts = zeroCounts();
  let api: T3Api | null = null;
  let runStarted = false;
  const runId = newRunId(new Date(now()));
  try {
    // Recovery first, under the lock and BEFORE probing T3: after a crash mid-wave, file times parked or bumped by it
    // are put back on the next scheduled cycle even if T3 Code stays closed. (Writes only when something is pending.)
    if (!deps.dryRun) {
      const lock = await acquireLock(deps.stateDir);
      if (!lock) return { kind: "locked" };
      try {
        const rec = await recoverPendingMtimes(new Journal(join(deps.stateDir, "journal.jsonl")));
        recovered.restored += rec.restored.length;
        recovered.failed += rec.failed.length;
      } finally { await lock.release(); }
    }
    // Then the cheap probe: with T3 closed, no connection, nothing else written.
    if (!(await (deps.isT3Running ?? isT3Running)(deps.home))) return { kind: "t3-down" };
    const config = await loadConfig(deps.stateDir, deps.home);
    // The notices' language (stderr only: logs/sync.log stays English).
    const noticeLang = deps.lang ?? resolveLang(null, { ...env, T3SM_HOME: deps.stateDir }, config?.language ?? null);
    let names: Record<string, string> = {};
    let fullItems: PlanItem[] = [];
    let planConfig: Config | null = null;
    let overLimit: number | null = null;

    // Runs under the lock (applyPlan's loader) except for --dry-run. Read-only against T3; the connection stays open
    // for applyPlan (one T3 session per cycle) and is closed in this function's finally.
    const build = async (): Promise<Plan> => {
      api = await connect(deps.home, { allowUntested: deps.allowUntested ?? false, manageProviders: false, onNotice: notice });
      const fp = await freshPlan(api, {
        home: deps.home, env: { ...env, T3SM_HOME: deps.stateDir }, now, runId, adapters: deps.adapters, existsDir: deps.existsDir,
        missingConfig: "memory", readOnly: deps.dryRun ?? false, lang: deps.lang,
      });
      // sync never creates instances, but a drifted claudeAgent must still stop it (exit 2) before any write.
      if (fp.plan.instancesToCreate.length > 0) await planInstances(api, fp.plan.instancesToCreate, defaultClaudeHome(deps.home));
      const journal = await new Journal(join(deps.stateDir, "journal.jsonl")).readAll();
      const f = filterForSync(fp.plan, {
        liveMirrorPaths: await liveMirrorPaths(fp.plan, now()), projects: fp.projects, platform, failedBefore: failedImports(journal),
        generalFolder: resolveGeneralFolder(fp.config, deps.lang ?? resolveLang(null, { ...env, T3SM_HOME: deps.stateDir }, fp.config.language), fp.projects.filter((p) => !p.deleted).map((p) => p.workspaceRoot), { platform, home: deps.home }),
      });
      counts.heldForDedupe = f.heldForDedupe;
      counts.heldForAccounts = f.heldForAccounts;
      counts.heldFailed = f.heldFailed;
      counts.heldRehome = f.heldRehome;
      if (Object.keys(f.undecided).length > 0) counts.undecided = f.undecided;
      info.undecided = f.undecided;
      info.heldRehome = f.heldRehome;
      // An account signed out in T3 Code cannot import: its sessions wait, and a person has to sign it in.
      const signedOut = new Set((await api.providerInstances()).filter((i) => i.authStatus === "unauthenticated").map((i) => i.instanceId));
      info.signedOut = new Set(f.plan.items.flatMap((i) => (i.action.kind !== "skip" && signedOut.has(i.action.instanceId) ? [i.action.instanceId] : []))).size;
      const importRoots = new Set(f.plan.items.flatMap((i) => (i.action.kind !== "skip" ? [rootKey(i.action.projectRoot, platform)] : [])));
      info.planned = { projects: importRoots.size, newProjects: f.plan.projectsToCreate.filter((x) => importRoots.has(rootKey(x.root, platform))).map((x) => x.title) };
      names = fp.names;
      fullItems = fp.plan.items;
      planConfig = fp.config;
      const pending = f.plan.items.filter((i) => i.action.kind !== "skip").length;
      const limit = fp.config.sync.maxUnattendedImports ?? DEFAULT_MAX_UNATTENDED_IMPORTS;
      if (pending > limit) {
        if (!deps.dryRun) throw new OverLimit(pending, limit);
        overLimit = limit;
      }
      return f.plan;
    };

    // On a cycle with nothing to import, the history pass and the follow step journal their own run, with the cycle's run
    // id, only once one of them is about to write (one run-start for both; run-end once both are done, in afterApply).
    let ownRun: string | null = null;
    let ownStatus: "ok" | "partial" | "aborted" = "ok";
    const RANK = { ok: 0, partial: 1, aborted: 2 } as const;
    const ownEnds = (s: "ok" | "partial" | "aborted"): void => { if (RANK[s] > RANK[ownStatus]) ownStatus = s; };
    const runOf = async (ctx: AfterApplyContext): Promise<string> => {
      if (ctx.runId !== null) return ctx.runId;
      if (ownRun === null) {
        ownRun = runId;
        runStarted = true;
        await ctx.journal.append({ t: "run-start", runId, at: new Date(now()).toISOString(), command: `sync ${runId}` });
      }
      return ownRun;
    };

    // Organize (spec 4.7, §5.2): under the lock, T3 connected, inside the sync run (command null: applyPlan or runOf owns
    // run-start / run-end), so one `t3sm rollback <run>` undoes the import and the organize changes together. Archive and
    // title only for the threads of this run's `imported` entries; the history rule for every imported thread of their
    // projects, or of all projects when the daily pass is due. No pins, no deletes, no auto-settle: invariant 13.
    const organizeCycle = async (ctx: AfterApplyContext): Promise<void> => {
      const imported = ctx.runId !== null && (ctx.result.status === "ok" || ctx.result.status === "partial");
      if (!imported && ctx.result.status !== "noop") return;
      const ids = imported
        ? new Set((await ctx.journal.readAll()).flatMap((e) => (e.t === "imported" && e.runId === ctx.runId ? [e.threadId] : [])))
        : new Set<string>();
      const last = await readLastHistoryAt(deps.stateDir).catch(() => null);
      // A date in the future (the clock went back) counts as due.
      const daily = last === null || last > now() || now() - last >= HISTORY_INTERVAL_MS;
      if (ids.size === 0 && !daily) return;
      let stop = false;
      const onSignal = (): void => { stop = true; };
      const sig = deps.signals ?? { on: (s: string, f: () => void) => void process.on(s as NodeJS.Signals, f), off: (s: string, f: () => void) => void process.off(s as NodeJS.Signals, f) };
      for (const s of STOP_SIGNALS) sig.on(s, onSignal);
      let status: "ok" | "partial" | "aborted" = "ok";
      try {
        const silent: Io = { stdout: () => {}, stderr: () => {}, isTTY: false, prompt: async () => "", env: { ...env, T3SM_HOME: deps.stateDir } };
        // dryRun here only means "read-only discovery": the cache was just written by the planning above.
        const b = await buildOrganize(ctx.api, ctx.journal, planConfig ?? config ?? defaultConfig([]),
          { only: null, onlyThreads: ids, historyScope: daily ? "all" : "projects", dryRun: true }, silent, { adapters: deps.adapters, platform }, deps.home, now);
        const { plan, deferred } = capHistory(b.plan, deps.historyPerCycle ?? HISTORY_PER_CYCLE);
        if (deferred > 0) counts.historyDeferred = deferred;
        if (plan.actions.length > 0) {
          const r = await applyOrganize(plan, {
            api: ctx.api, journal: ctx.journal, runId: await runOf(ctx), command: null, now, allowUntested: deps.allowUntested ?? false, onNotice: notice,
            aborted: () => stop || ctx.aborted?.() === true,
          });
          counts.organized = r.done;
          if (r.failed.length > 0) counts.organizeFailed = r.failed.length;
          status = r.status === "aborted" ? "aborted" : r.failed.length > 0 ? "partial" : "ok";
        }
        // Done for today only when nothing is left; changes left over make the next cycle a daily pass.
        if (status === "aborted") return;
        if (deferred > 0) await markHistoryPass(deps.stateDir, null).catch(() => {});
        else if (daily) await markHistoryPass(deps.stateDir, new Date(now())).catch(() => {});
      } catch (e) {
        // T3 changed but the journal did not hear of it: nothing could roll that back, so the cycle ends as an error.
        if (e instanceof JournalWriteError) { status = "aborted"; throw e; }
        counts.organizeFailed = (counts.organizeFailed ?? 0) + 1;
        status = "partial";
        const why = describeError(e).message.split("\n")[0] ?? "";
        notice(cliT(noticeLang, "sync.notice.organizeStopped", { error: why }));
        // Every failure carries its reason in the journal (spec §5.1.5): here the whole step, not one change.
        await appendOrStop(ctx.journal, {
          t: "organize-failed", runId: await runOf(ctx), kind: "organize", target: daily ? "history" : "*", projectId: null, error: failureText(why),
        }, "nothing (organizing failed)");
      } finally {
        for (const s of STOP_SIGNALS) sig.off(s, onSignal);
        if (ctx.runId === null && ownRun !== null) ownEnds(status);
      }
    };

    // Rehome copies follow their original (spec §5.1.4, src/ops/follow.ts): under the lock, T3 connected, after the
    // waves and the organize step (which must never retitle a revision thread), inside the cycle's own run, so one
    // `t3sm rollback <run>` undoes it with the rest. On a cycle with nothing to import the run is journaled by runOf,
    // with the cycle's run id, only once a follow is about to write. Runs whatever sync.autoMerge says; a follow error
    // never changes the import's result.
    const follow = async (ctx: AfterApplyContext): Promise<void> => {
      if (ctx.result.status !== "ok" && ctx.result.status !== "partial" && ctx.result.status !== "noop") return;
      if (ctx.aborted?.()) return; // asked to stop (during organize, say): nothing more is started
      const cfg = planConfig ?? config;
      let stop = false;
      const onSignal = (): void => { stop = true; };
      const sig = deps.signals ?? { on: (s: string, f: () => void) => void process.on(s as NodeJS.Signals, f), off: (s: string, f: () => void) => void process.off(s as NodeJS.Signals, f) };
      for (const s of STOP_SIGNALS) sig.on(s, onSignal);
      let status: "ok" | "partial" | "aborted" = "ok";
      try {
        const r = await followRehomed({
          api: ctx.api, journal: ctx.journal, now, platform, limit: FOLLOWS_PER_CYCLE, exposureItems: fullItems, batch: cfg?.batch, stateDir: deps.stateDir,
          accountHomes: Object.fromEntries(cfg?.accounts.map((a) => [a.id, expandHome(a.home, deps.home)]) ?? []),
          aborted: () => stop || ctx.aborted?.() === true, onPendingFiles: ctx.onPendingFiles,
          runId: ctx.runId ?? (() => runOf(ctx)),
        });
        if (r.followed) counts.followed = r.followed;
        const id = (p: string): string => basename(p, ".jsonl");
        const conflicts = r.conflicts.map((x) => ({ originalId: id(x.original), copyId: id(x.copy), originalTitle: x.originalTitle, copyTitle: x.copyTitle }));
        info.followConflicts = conflicts;
        if (conflicts.length) { counts.followConflicts = conflicts.length; counts.followConflictList = conflicts; }
        if (r.deferred) counts.followDeferred = r.deferred;
        if (r.failed.length) counts.followFailed = r.failed.length;
        status = stop || ctx.aborted?.() ? "aborted" : r.failed.length > 0 ? "partial" : "ok";
      } catch (e) {
        // T3 changed but the journal did not hear of it: nothing could roll that back, so the cycle ends as an error.
        if (e instanceof JournalWriteError) { status = "aborted"; throw e; }
        counts.followFailed = (counts.followFailed ?? 0) + 1;
        status = "partial";
        notice(cliT(noticeLang, "sync.notice.followStopped", { error: describeError(e).message.split("\n")[0] ?? "" }));
      } finally {
        for (const s of STOP_SIGNALS) sig.off(s, onSignal);
        if (ctx.runId === null && ownRun !== null) ownEnds(status);
      }
    };

    // Merges (Task 23): under the lock, T3 connected, after the waves; always in their own `sync-merge` run (journaled
    // only once a merge is about to write), so a merge never changes the cycle's own run or result.
    let mergeRun: string | null = null;
    const autoMerge = async (ctx: AfterApplyContext): Promise<void> => {
      if (ctx.result.status !== "ok" && ctx.result.status !== "noop") return;
      if (ctx.aborted?.()) return; // asked to stop: no merge is started
      const cfg = planConfig ?? config;
      const items = ctx.plan.items.filter((i) => i.notes.includes("continued-outside-t3"));
      const mdeps: MergeDeps = {
        api: ctx.api, journal: ctx.journal, now, platform, stateDir: deps.stateDir, retryFailed: false, limit: MERGES_PER_CYCLE,
        exposureItems: fullItems, batch: cfg?.batch, onPendingFiles: ctx.onPendingFiles,
        accountHomes: Object.fromEntries(cfg?.accounts.map((a) => [a.id, expandHome(a.home, deps.home)]) ?? []),
        runId: async () => {
          mergeRun = newRunId(new Date(now()));
          await ctx.journal.append({ t: "run-start", runId: mergeRun, at: new Date(now()).toISOString(), command: `sync-merge ${mergeRun}` });
          return mergeRun;
        },
      };
      // Counts reported once per change: sessions waiting for `t3sm merge`, and sessions whose terminal work sits on a
      // side branch (never merged; `t3sm merge` lists them with the `claude --resume <id>` hint).
      const before = await readMergePending(deps.stateDir).catch(() => null);
      const report = (n: number, orphaned: number): void => {
        if (n !== (before?.count ?? 0)) counts.mergePending = n;
        if (orphaned !== (before?.orphaned ?? 0)) counts.mergeOrphaned = orphaned;
      };
      if (items.length === 0) {
        await setMergePending(deps.stateDir, 0, new Date(now()), 0).catch(() => null);
        if (cfg?.sync.autoMerge !== true) report(0, 0);
        else if ((before?.orphaned ?? 0) !== 0) counts.mergeOrphaned = 0;
        return;
      }
      if (cfg?.sync.autoMerge !== true) {
        try {
          const f = await findMergeCandidates(items, mdeps);
          report(f.candidates.length, f.orphaned.length);
        } catch { /* reporting only */ }
        return;
      }
      let stop = false;
      const onSignal = (): void => { stop = true; };
      const sig = deps.signals ?? { on: (s: string, f: () => void) => void process.on(s as NodeJS.Signals, f), off: (s: string, f: () => void) => void process.off(s as NodeJS.Signals, f) };
      for (const s of STOP_SIGNALS) sig.on(s, onSignal);
      let status: "ok" | "partial" | "aborted" = "aborted";
      try {
        const found = await findMergeCandidates(items, mdeps);
        if (found.orphaned.length !== (before?.orphaned ?? 0)) counts.mergeOrphaned = found.orphaned.length;
        const r = await executeMerges(found.candidates, { ...mdeps, aborted: () => stop || ctx.aborted?.() === true });
        const skipped = [...found.skipped, ...r.skipped];
        counts.merged = r.merged.length;
        counts.mergeDeferred = skipped.filter((x) => DEFERRED_REASONS.has(x.reason)).length;
        counts.mergeFailed = skipped.filter((x) => FAILED_REASONS.has(x.reason)).length;
        if (r.merged.length > 0) await setMergePending(deps.stateDir, Math.max(0, found.candidates.length - r.merged.length), new Date(now()));
        status = stop || ctx.aborted?.() ? "aborted" : (counts.mergeFailed ?? 0) > 0 ? "partial" : "ok";
      } catch (e) {
        // T3 changed but the journal did not hear of it: nothing could roll that back, so the cycle ends as an error.
        if (e instanceof JournalWriteError) { status = "aborted"; throw e; }
        counts.mergeFailed = (counts.mergeFailed ?? 0) + 1;
        status = "partial";
        notice(cliT(noticeLang, "sync.notice.mergeStopped", { error: describeError(e).message.split("\n")[0] ?? "" }));
      } finally {
        for (const s of STOP_SIGNALS) sig.off(s, onSignal);
        if (mergeRun !== null) await ctx.journal.append({ t: "run-end", runId: mergeRun, at: new Date(now()).toISOString(), status }).catch(() => {});
      }
    };

    if (deps.dryRun) {
      const p = await build();
      const byHarness: Record<string, number> = {};
      const roots = new Set<string>();
      for (const i of p.items) {
        if (i.action.kind !== "skip") { // convert-import items are converted, then imported, in the same cycle
          counts.wouldImport++;
          byHarness[i.session.harness] = (byHarness[i.session.harness] ?? 0) + 1;
          roots.add(rootKey(i.action.projectRoot, platform));
        }
      }
      return {
        kind: "dry-run", runId: null, counts, byHarness, projects: roots.size, overLimit,
        newProjects: p.projectsToCreate.filter((x) => roots.has(rootKey(x.root, platform))).length,
      };
    }

    const r = await applyPlan(build, {
      stateDir: deps.stateDir, home: deps.home, now, platform, signals: deps.signals,
      // The plan's connection, lent to applyPlan without its close: this function's finally closes it exactly once.
      connect: async () => new Proxy(api!, { get: (t, k) => (k === "close" ? async () => {} : Reflect.get(t, k)) }),
      allowUntested: deps.allowUntested ?? false, batch: config?.batch,
      runId, command: `sync ${runId}`, noopWithoutWrites: true,
      pinDefaultInstance: false, // unattended: never changes T3's provider settings (a drifted default instance stops it in freshPlan)
      exposure: () => fullItems, // held items are still on disk and still exposed to T3's importer
      accountHomes: () => Object.fromEntries((planConfig ?? config)?.accounts.map((a) => [a.id, expandHome(a.home, deps.home)]) ?? []),
      // Codex / Pi transcripts created after planning (cached discovery; Claude's are listed from the instance homes).
      rediscover: async () => (await discoverAll((deps.adapters ?? allAdapters()).filter((a) => a.id !== "claude"), {
        home: deps.home, platform, now, config: planConfig ?? config ?? defaultConfig([]), stateDir: deps.stateDir, env,
      })).sessions,
      beforeWrites: async (plan) => {
        runStarted = true;
        await atomicWrite(join(deps.stateDir, "runs", runId, "plan.md"), renderPlanMarkdown(plan, { names }));
      },
      afterApply: async (ctx) => {
        try {
          await organizeCycle(ctx);
          await follow(ctx);
        } finally {
          if (ownRun !== null) await ctx.journal.append({ t: "run-end", runId: ownRun, at: new Date(now()).toISOString(), status: ownStatus }).catch(() => {});
        }
        await autoMerge(ctx);
        await deps.afterApply?.(ctx);
      },
      onNotice: notice, lang: noticeLang, onProgress: deps.onProgress, onImportStart: deps.onImportStart, onWave: deps.onWave, failureTitles: deps.failureTitles,
    });
    if (r.status === "locked") return { kind: "locked" };
    recovered.restored += r.recovered?.restored.length ?? 0;
    recovered.failed += r.recovered?.failed.length ?? 0;
    Object.assign(counts, {
      imported: r.imported, failed: r.failed, deferred: r.deferred, unverified: r.unverified, alreadyInT3: r.alreadyInT3,
      heldInUse: r.deferredInUse, parked: r.parked,
    });
    const extra = { ...(r.held.length > 0 ? { held: r.held } : {}), ...(r.failures.length > 0 ? { failures: r.failures } : {}) };
    if ((r.status === "noop" || r.status === "declined") && mergeRun === null && ownRun === null) return { kind: "noop", runId: null, counts, ...extra };
    if (r.status === "noop") return { kind: "ok", runId: ownRun ?? mergeRun, counts, ...extra };
    const kind = r.status === "ok" && r.restoreErrors.length === 0 ? "ok" : r.status === "aborted" ? "aborted" : "partial";
    return { kind, runId: r.runId, counts, ...extra };
  } catch (e) {
    if (e instanceof OverLimit) return { kind: "over-limit", pending: e.pending, limit: e.limit };
    const { code } = describeError(e);
    // Lost T3 mid-run: keep the run id so the log points at the (partial) run in the journal.
    if (code === 3 || unreachable(e)) return runStarted ? { kind: "t3-down", runId } : { kind: "t3-down" };
    return { kind: "error", exitCode: code, error: e };
  } finally {
    await (api as T3Api | null)?.close();
  }
}

// ---------- reporting ----------

export function overLimitLine(pending: number, lang: Lang = "en"): string {
  return cliT(lang, "sync.overLimit", { n: pending });
}

/** How the summary is told: the language (English by default) and the dash of a held line (ASCII consoles: "-"). */
export interface SummaryOptions { lang?: Lang; dash?: string }

/** Human summary (non-quiet), in `o.lang` (English by default). `now` dates the held conversations ("written 3 min ago"). */
export function summaryLines(o: CycleOutcome, now: number = Date.now(), opts: SummaryOptions = {}): string[] {
  const lang = opts.lang ?? "en";
  const t = (k: Parameters<typeof cliT>[1], v: Record<string, string | number> = {}): string => cliT(lang, k, v);
  if (o.kind === "t3-down" || o.kind === "locked" || o.kind === "error") return [];
  if (o.kind === "over-limit") return [overLimitLine(o.pending, lang)];
  const c = o.counts;
  const out: string[] = [];
  if (o.kind === "noop") out.push(t("sync.nothing"));
  else if (o.kind === "dry-run") {
    const h = Object.entries(o.byHarness).sort().map(([k, n]) => `${k} ${n}`).join(", ");
    out.push(t("sync.dryRun", { n: c.wouldImport, harness: h ? ` (${h})` : "", p: o.projects, newP: o.newProjects }));
    if (o.overLimit !== null) out.push(t("sync.dryRunOverLimit", { limit: o.overLimit }));
  } else {
    const parts = [t("sync.imported", { n: c.imported }), t("sync.failed", { n: c.failed })];
    if (c.unverified) parts.push(t("sync.unverified", { n: c.unverified }));
    const deferred = c.deferred - c.heldInUse;
    if (deferred) parts.push(t("sync.deferred", { n: deferred }));
    out.push(`${parts.join(", ")}.${o.runId ? t("sync.runId", { runId: o.runId }) : ""}`);
  }
  out.push(...detailLines(o, now, opts));
  return out;
}

/** Everything summaryLines says after its first line (the result): what followed, merged, waits, organized. */
export function detailLines(o: CycleOutcome, now: number = Date.now(), opts: SummaryOptions = {}): string[] {
  const lang = opts.lang ?? "en";
  const t = (k: Parameters<typeof cliT>[1], v: Record<string, string | number> = {}): string => cliT(lang, k, v);
  if (o.kind === "t3-down" || o.kind === "locked" || o.kind === "error" || o.kind === "over-limit") return [];
  const c = o.counts;
  const out: string[] = [];
  if (c.followed) out.push(t("sync.followed", { n: c.followed }));
  if (c.followConflicts) {
    out.push(t("sync.followConflicts", { n: c.followConflicts }));
    const list = c.followConflictList ?? [];
    for (const x of list.slice(0, 5)) out.push(t("sync.followConflict", { original: x.originalTitle || x.originalId, originalId: x.originalId, copy: x.copyTitle || x.copyId, copyId: x.copyId }));
    if (list.length > 5) out.push(t("sync.andMore", { n: list.length - 5 }));
  }
  if (c.followDeferred) out.push(t("sync.followDeferred", { n: c.followDeferred, max: FOLLOWS_PER_CYCLE }));
  if (c.followFailed) out.push(t("sync.followFailed", { n: c.followFailed }));
  if (c.merged) out.push(t("sync.merged", { n: c.merged }));
  if (c.mergeDeferred) out.push(t("sync.mergeDeferred", { n: c.mergeDeferred, max: MERGES_PER_CYCLE }));
  if (c.mergeFailed) out.push(t("sync.mergeFailed", { n: c.mergeFailed }));
  if (c.mergeOrphaned) out.push(t("sync.mergeOrphaned", { n: c.mergeOrphaned }));
  if (c.mergePending) out.push(t("sync.mergePending", { n: c.mergePending }));
  if (c.heldInUse) out.push(t("sync.heldInUse", { n: c.heldInUse }));
  if ("held" in o) for (const h of o.held ?? []) out.push(heldLine(h, h.project, now, opts));
  if (c.heldForDedupe) out.push(t("sync.heldDedupe", { n: c.heldForDedupe }));
  if (c.heldForAccounts) out.push(t("sync.heldAccounts", { n: c.heldForAccounts }));
  if (c.heldFailed) out.push(t("sync.heldFailed", { n: c.heldFailed }));
  if (c.heldRehome) out.push(t("sync.heldRehome", { n: c.heldRehome }));
  const undecided = Object.values(c.undecided ?? {}).reduce((a, n) => a + n, 0);
  if (undecided) out.push(t("sync.undecided", { n: undecided }));
  if (c.organized) out.push(t("sync.organized", { n: c.organized }));
  if (c.historyDeferred) out.push(t("sync.historyDeferred", { n: c.historyDeferred, max: HISTORY_PER_CYCLE }));
  if (c.organizeFailed) out.push(t("sync.organizeFailed", { n: c.organizeFailed }));
  return out;
}

/** One log line: timestamp, outcome, counts and run id. Never paths, titles or error messages (personal content). */
export function logLine(o: CycleOutcome, at: number): string {
  const r = o.recovered;
  const line = baseLogLine(o, at);
  return r && (r.restored > 0 || r.failed > 0) ? `${line} recovered=${r.restored} failed=${r.failed}` : line;
}

function baseLogLine(o: CycleOutcome, at: number): string {
  const ts = new Date(at).toISOString();
  if (o.kind === "t3-down") return `${ts} t3-down${o.runId ? ` run=${o.runId}` : ""}`;
  if (o.kind === "locked") return `${ts} locked`;
  if (o.kind === "over-limit") return `${ts} over-limit pending=${o.pending} limit=${o.limit}`;
  if (o.kind === "error") return `${ts} error exit=${o.exitCode} ${(o.error as Error)?.name ?? "Error"}`;
  const c = o.counts;
  // Held projects: a count only (their names and conversation titles stay out of the log).
  const heldProjects = "held" in o ? o.held?.length ?? 0 : 0;
  const held = `held-in-use=${c.heldInUse} held-dedupe=${c.heldForDedupe} held-accounts=${c.heldForAccounts} held-failed=${c.heldFailed}${c.heldRehome ? ` held-rehome=${c.heldRehome}` : ""}${heldProjects ? ` held-projects=${heldProjects}` : ""}`;
  const anyHeld = c.heldInUse || c.heldForDedupe || c.heldForAccounts || c.heldFailed || c.heldRehome;
  const undecided = Object.values(c.undecided ?? {}).reduce((a, n) => a + n, 0);
  const merges = (c.merged || c.mergeDeferred || c.mergeFailed ? ` merged=${c.merged ?? 0} merge-deferred=${c.mergeDeferred ?? 0}${c.mergeFailed ? ` merge-failed=${c.mergeFailed}` : ""}` : "")
    + (c.mergePending !== undefined ? ` merge-pending=${c.mergePending}` : "")
    + (c.mergeOrphaned !== undefined ? ` merge-orphaned=${c.mergeOrphaned}` : "")
    + (undecided ? ` undecided=${undecided}` : "")
    + (c.organized ? ` organized=${c.organized}` : "")
    + (c.organizeFailed ? ` organize-failed=${c.organizeFailed}` : "")
    + (c.historyDeferred ? ` history-deferred=${c.historyDeferred}` : "")
    + (c.followed ? ` followed=${c.followed}` : "")
    + (c.followConflicts ? ` follow-conflicts=${c.followConflicts}` : "")
    + (c.followDeferred ? ` follow-deferred=${c.followDeferred}` : "")
    + (c.followFailed ? ` follow-failed=${c.followFailed}` : "");
  if (o.kind === "noop") return `${ts} noop${anyHeld ? ` ${held}` : ""}${merges}`;
  if (o.kind === "dry-run") return `${ts} dry-run would-import=${c.wouldImport} ${held}`;
  return `${ts} ${o.kind} run=${o.runId ?? "-"} imported=${c.imported} failed=${c.failed} deferred=${c.deferred} parked=${c.parked ?? 0} ${held}${merges}`;
}

/** Compact result for the heartbeat file (sync-status.json `lastResult`): counts, the run id and held names; never a path. */
export function resultSummary(o: CycleOutcome): Record<string, unknown> {
  if (o.kind === "t3-down" || o.kind === "locked") return { outcome: o.kind };
  if (o.kind === "over-limit") return { outcome: o.kind, pending: o.pending, limit: o.limit };
  if (o.kind === "error") return { outcome: "error", exitCode: o.exitCode };
  const c = o.counts;
  return {
    outcome: o.kind, runId: o.runId, imported: c.imported, failed: c.failed, deferred: c.deferred,
    heldInUse: c.heldInUse, heldForDedupe: c.heldForDedupe, heldForAccounts: c.heldForAccounts, heldFailed: c.heldFailed,
    ...(c.heldRehome ? { heldRehome: c.heldRehome } : {}),
    ...(c.undecided ? { undecided: c.undecided } : {}),
    ...(c.organized || c.organizeFailed ? { organized: c.organized ?? 0, organizeFailed: c.organizeFailed ?? 0 } : {}),
    ...(c.historyDeferred ? { historyDeferred: c.historyDeferred } : {}),
    ...(c.merged || c.mergeDeferred || c.mergeFailed ? { merged: c.merged ?? 0, mergeDeferred: c.mergeDeferred ?? 0, mergeFailed: c.mergeFailed ?? 0 } : {}),
    ...(c.followed || c.followConflicts || c.followDeferred || c.followFailed
      ? { followed: c.followed ?? 0, followConflicts: c.followConflicts ?? 0, followDeferred: c.followDeferred ?? 0, followFailed: c.followFailed ?? 0 } : {}),
    // Titles and session ids only: never the transcripts' paths (SECURITY.md).
    ...(c.followConflictList?.length ? { followConflictList: c.followConflictList } : {}),
    // Names and time only: the held project's folder and transcript path never reach the heartbeat (SECURITY.md).
    ...("held" in o && o.held?.length ? { held: o.held.map((h) => ({ project: h.project, title: h.title, modifiedAt: h.modifiedAt })) } : {}),
  };
}

export const SYNC_LOG_MAX_BYTES = 1_048_576;

/**
 * Appends one line to <stateDir>/logs/sync.log; rotates to sync.log.1..keep when the next line would pass maxBytes.
 * Race: two t3sm processes (a scheduled cycle and a watcher) may rotate at the same moment. Every rename tolerates a
 * missing source, so the worst case is one rotation too many (a short sync.log.1) or a line landing in the file just
 * renamed to sync.log.1; no line is lost and nothing throws. The lines are diagnostics, not state.
 */
export async function appendSyncLog(stateDir: string, line: string, o: { maxBytes?: number; keep?: number } = {}): Promise<void> {
  const max = o.maxBytes ?? SYNC_LOG_MAX_BYTES;
  const keep = o.keep ?? 3;
  const dir = join(stateDir, "logs");
  const file = join(dir, "sync.log");
  const text = `${line}\n`;
  await mkdir(dir, { recursive: true });
  let size = 0;
  try { size = (await stat(file)).size; } catch { /* new log */ }
  if (size > 0 && size + Buffer.byteLength(text) > max) {
    await rm(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) await rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => {});
    await rename(file, `${file}.1`).catch(() => {});
  }
  await appendFile(file, text, "utf8");
}
