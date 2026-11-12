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
//   - a cycle with nothing to write writes nothing (no journal entry, no run folder, no unchanged discovery cache).
// One T3 session per cycle: the read-only connection that builds the plan is the one apply uses.

import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config, JournalEntry, Plan, PlanItem } from "../core/types.ts";
import { defaultConfig, loadConfig } from "../core/config.ts";
import { expandHome } from "../core/paths.ts";
import { allAdapters, isConvertSession } from "../sources/registry.ts";
import { discoverAll } from "../cli/commands/scan.ts";
import { atomicWrite, statSafe } from "../core/fsutil.ts";
import { Journal, newRunId, recoverPendingMtimes } from "../core/journal.ts";
import { acquireLock } from "../core/lock.ts";
import { STOP_SIGNALS, applyPlan, type AfterApplyContext, type SignalSource } from "../apply/apply.ts";
import { inImportWindow } from "../core/activity.ts";
import { rootKey } from "../apply/waves.ts";
import { renderPlanMarkdown } from "../plan/report.ts";
import { connectT3, type T3Api, type T3Project } from "../t3/api.ts";
import { RpcTimeout } from "../t3/errors.ts";
import { isT3Running } from "../t3/runtime.ts";
import type { SourceAdapter } from "../sources/types.ts";
import { defaultClaudeHome, planInstances } from "./accounts.ts";
import { freshPlan } from "../cli/commands/plan.ts";
import { describeError } from "../cli/errors.ts";
import { DEFERRED_REASONS, FAILED_REASONS, MERGES_PER_CYCLE, executeMerges, findMergeCandidates, readMergePending, setMergePending, type MergeDeps } from "./merge.ts";

export const DEFAULT_MAX_UNATTENDED_IMPORTS = 200;

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
}

export type CycleOutcome = (
  | { kind: "t3-down"; runId?: string }
  | { kind: "locked" }
  | { kind: "over-limit"; pending: number; limit: number }
  | { kind: "ok" | "partial" | "aborted" | "noop"; runId: string | null; counts: SyncCounts }
  | { kind: "dry-run"; runId: null; counts: SyncCounts; byHarness: Record<string, number>; projects: number; newProjects: number; overLimit: number | null }
  | { kind: "error"; exitCode: number; error: unknown }
) & {
  /** File times this cycle put back from an interrupted run (set only when something was recovered or failed). */
  recovered?: { restored: number; failed: number };
};

export const zeroCounts = (): SyncCounts => ({
  imported: 0, failed: 0, deferred: 0, unverified: 0, alreadyInT3: 0,
  heldForDedupe: 0, heldForAccounts: 0, heldInUse: 0, heldFailed: 0, wouldImport: 0, merged: 0, mergeDeferred: 0, mergeFailed: 0,
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
}

export interface SyncFilterResult { plan: Plan; heldForDedupe: number; heldForAccounts: number; heldFailed: number }

export function filterForSync(plan: Plan, o: SyncFilterOptions): SyncFilterResult {
  const platform = o.platform ?? process.platform;
  const key = (p: string): string => rootKey(p, platform);
  const newInstances = new Set(plan.instancesToCreate.map((s) => s.id));
  const heldIds = new Set(plan.mirrorCopies.filter((m) => o.liveMirrorPaths.has(m.path)).map((m) => m.nativeId));

  let heldForDedupe = 0;
  let heldForAccounts = 0;
  let heldFailed = 0;
  const items: PlanItem[] = [];
  for (const it of plan.items) {
    const a = it.action;
    if (a.kind === "skip") { items.push(it); continue; }
    if (newInstances.has(a.instanceId)) { heldForAccounts++; continue; }
    if (heldIds.has(it.session.nativeId)) { heldForDedupe++; continue; }
    const failedAt = o.failedBefore?.get(`${it.session.harness}:${it.session.nativeId}`);
    // Changed since the failure? A convert-mode session is judged by its own activity (updatedAt): its source may be
    // shared (OpenCode's db: any session's change moves its mtime) or rewritten unchanged (a Codex compressed rollout).
    const changedAt = isConvertSession(it.session) ? Date.parse(it.session.updatedAt) : it.session.file.mtimeMs;
    if (failedAt !== undefined && failedAt > changedAt) { heldFailed++; continue; }
    items.push(it);
  }
  const importRoots = new Set(items.flatMap((i) => (i.action.kind === "skip" ? [] : [key(i.action.projectRoot)])));
  const existing = (root: string): T3Project | undefined => o.projects.find((p) => !p.deleted && key(p.workspaceRoot) === key(root));
  return {
    heldForDedupe,
    heldForAccounts,
    heldFailed,
    plan: {
      ...plan,
      items,
      instancesToCreate: [],
      projectsToCreate: plan.projectsToCreate.filter((p) => importRoots.has(key(p.root))),
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
}

export async function runSyncCycle(deps: SyncCycleDeps): Promise<CycleOutcome> {
  const recovered = { restored: 0, failed: 0 };
  const o = await cycle(deps, recovered);
  return recovered.restored > 0 || recovered.failed > 0 ? { ...o, recovered } : o;
}

async function cycle(deps: SyncCycleDeps, recovered: { restored: number; failed: number }): Promise<CycleOutcome> {
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
        missingConfig: "memory", readOnly: deps.dryRun ?? false,
      });
      // sync never creates instances, but a drifted claudeAgent must still stop it (exit 2) before any write.
      if (fp.plan.instancesToCreate.length > 0) await planInstances(api, fp.plan.instancesToCreate, defaultClaudeHome(deps.home));
      const journal = await new Journal(join(deps.stateDir, "journal.jsonl")).readAll();
      const f = filterForSync(fp.plan, {
        liveMirrorPaths: await liveMirrorPaths(fp.plan, now()), projects: fp.projects, platform, failedBefore: failedImports(journal),
      });
      counts.heldForDedupe = f.heldForDedupe;
      counts.heldForAccounts = f.heldForAccounts;
      counts.heldFailed = f.heldFailed;
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

    // Merges (Task 23): under the lock, T3 connected, after the waves; always in their own `sync-merge` run (journaled
    // only once a merge is about to write), so a merge never changes the cycle's own run or result.
    let mergeRun: string | null = null;
    const autoMerge = async (ctx: AfterApplyContext): Promise<void> => {
      if (ctx.result.status !== "ok" && ctx.result.status !== "noop") return;
      const cfg = planConfig ?? config;
      const items = ctx.plan.items.filter((i) => i.notes.includes("continued-outside-t3"));
      const mdeps: MergeDeps = {
        api: ctx.api, journal: ctx.journal, now, platform, stateDir: deps.stateDir, retryFailed: false, limit: MERGES_PER_CYCLE,
        exposureItems: fullItems, batch: cfg?.batch,
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
        const r = await executeMerges(found.candidates, { ...mdeps, aborted: () => stop });
        const skipped = [...found.skipped, ...r.skipped];
        counts.merged = r.merged.length;
        counts.mergeDeferred = skipped.filter((x) => DEFERRED_REASONS.has(x.reason)).length;
        counts.mergeFailed = skipped.filter((x) => FAILED_REASONS.has(x.reason)).length;
        if (r.merged.length > 0) await setMergePending(deps.stateDir, Math.max(0, found.candidates.length - r.merged.length), new Date(now()));
        status = stop ? "aborted" : (counts.mergeFailed ?? 0) > 0 ? "partial" : "ok";
      } catch (e) {
        counts.mergeFailed = (counts.mergeFailed ?? 0) + 1;
        status = "partial";
        notice(`Merge stopped: ${describeError(e).message.split("\n")[0]}`);
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
        await autoMerge(ctx);
        await deps.afterApply?.(ctx);
      },
      onNotice: notice, onProgress: deps.onProgress,
    });
    if (r.status === "locked") return { kind: "locked" };
    recovered.restored += r.recovered?.restored.length ?? 0;
    recovered.failed += r.recovered?.failed.length ?? 0;
    Object.assign(counts, {
      imported: r.imported, failed: r.failed, deferred: r.deferred, unverified: r.unverified, alreadyInT3: r.alreadyInT3,
      heldInUse: r.deferredInUse, parked: r.parked,
    });
    if ((r.status === "noop" || r.status === "declined") && mergeRun === null) return { kind: "noop", runId: null, counts };
    if (r.status === "noop") return { kind: "ok", runId: mergeRun, counts };
    const kind = r.status === "ok" && r.restoreErrors.length === 0 ? "ok" : r.status === "aborted" ? "aborted" : "partial";
    return { kind, runId: r.runId, counts };
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

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function overLimitLine(pending: number): string {
  return `${plural(pending, "session", "sessions")} pending; run \`t3sm apply\` once to import them.`;
}

/** Human summary (non-quiet). */
export function summaryLines(o: CycleOutcome): string[] {
  if (o.kind === "t3-down" || o.kind === "locked" || o.kind === "error") return [];
  if (o.kind === "over-limit") return [overLimitLine(o.pending)];
  const c = o.counts;
  const out: string[] = [];
  if (o.kind === "noop") out.push("Nothing to import.");
  else if (o.kind === "dry-run") {
    const h = Object.entries(o.byHarness).sort().map(([k, n]) => `${k} ${n}`).join(", ");
    out.push(`Dry run: a sync cycle would import ${plural(c.wouldImport, "session", "sessions")}${h ? ` (${h})` : ""} into ${plural(o.projects, "project", "projects")} (${o.newProjects} new). Nothing was written.`);
    if (o.overLimit !== null) out.push(`That is over the unattended limit of ${o.overLimit} (sync.maxUnattendedImports): a real cycle would import nothing; run \`t3sm apply\` once.`);
  } else {
    const parts = [`Imported ${c.imported}`, `failed ${c.failed}`];
    if (c.unverified) parts.push(`unverified ${c.unverified}`);
    const deferred = c.deferred - c.heldInUse;
    if (deferred) parts.push(`deferred ${deferred} (in use, changed or locked; next cycle)`);
    out.push(`${parts.join(", ")}.${o.runId ? ` Run ${o.runId}.` : ""}`);
  }
  if (c.merged) out.push(`Merged ${plural(c.merged, "session", "sessions")} continued outside T3 Code into new threads (the old threads are archived; \`t3sm runs\` lists the run).`);
  if (c.mergeDeferred) out.push(`${plural(c.mergeDeferred, "merge waits", "merges wait")} (in use, or over ${MERGES_PER_CYCLE} per cycle; next cycle).`);
  if (c.mergeFailed) out.push(`${plural(c.mergeFailed, "merge", "merges")} failed; \`t3sm merge\` shows why and retries.`);
  if (c.mergeOrphaned) out.push(`${plural(c.mergeOrphaned, "session has", "sessions have")} terminal work on a side branch that T3 Code cannot show; \`t3sm merge\` lists them with the \`claude --resume <id>\` hint to recover it.`);
  if (c.mergePending) out.push(`${plural(c.mergePending, "session was", "sessions were")} continued in a terminal; run \`t3sm merge\` to bring them into T3 Code.`);
  if (c.heldInUse) out.push(`${plural(c.heldInUse, "session waits", "sessions wait")}: a session of their project is in use (next cycle).`);
  if (c.heldForDedupe) out.push(`${plural(c.heldForDedupe, "session waits", "sessions wait")} for \`t3sm dedupe\`.`);
  if (c.heldForAccounts) out.push(`${plural(c.heldForAccounts, "session waits", "sessions wait")} for \`t3sm accounts --apply\`.`);
  if (c.heldFailed) out.push(`${plural(c.heldFailed, "session", "sessions")} failed before; \`t3sm apply\` retries them.`);
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
  const held = `held-in-use=${c.heldInUse} held-dedupe=${c.heldForDedupe} held-accounts=${c.heldForAccounts} held-failed=${c.heldFailed}`;
  const anyHeld = c.heldInUse || c.heldForDedupe || c.heldForAccounts || c.heldFailed;
  const merges = (c.merged || c.mergeDeferred || c.mergeFailed ? ` merged=${c.merged ?? 0} merge-deferred=${c.mergeDeferred ?? 0}${c.mergeFailed ? ` merge-failed=${c.mergeFailed}` : ""}` : "")
    + (c.mergePending !== undefined ? ` merge-pending=${c.mergePending}` : "")
    + (c.mergeOrphaned !== undefined ? ` merge-orphaned=${c.mergeOrphaned}` : "");
  if (o.kind === "noop") return `${ts} noop${anyHeld ? ` ${held}` : ""}${merges}`;
  if (o.kind === "dry-run") return `${ts} dry-run would-import=${c.wouldImport} ${held}`;
  return `${ts} ${o.kind} run=${o.runId ?? "-"} imported=${c.imported} failed=${c.failed} deferred=${c.deferred} parked=${c.parked ?? 0} ${held}${merges}`;
}

/** Compact result for the heartbeat file. */
export function resultSummary(o: CycleOutcome): Record<string, unknown> {
  if (o.kind === "t3-down" || o.kind === "locked") return { outcome: o.kind };
  if (o.kind === "over-limit") return { outcome: o.kind, pending: o.pending, limit: o.limit };
  if (o.kind === "error") return { outcome: "error", exitCode: o.exitCode };
  const c = o.counts;
  return {
    outcome: o.kind, runId: o.runId, imported: c.imported, failed: c.failed, deferred: c.deferred,
    heldInUse: c.heldInUse, heldForDedupe: c.heldForDedupe, heldForAccounts: c.heldForAccounts, heldFailed: c.heldFailed,
    ...(c.merged || c.mergeDeferred || c.mergeFailed ? { merged: c.merged ?? 0, mergeDeferred: c.mergeDeferred ?? 0, mergeFailed: c.mergeFailed ?? 0 } : {}),
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
