// applyPlan: the only command path that changes T3 Code and file times for imports.
// Order: lock -> recoverPendingMtimes -> load plan + age -> connect -> version + response shapes + instance-home
// checks (+ mirror warning) -> confirm (all BEFORE the first write) -> instances -> conversions -> projects -> defaults
// -> waves -> run-end. A dry run (`dryRun`) stops before confirm, reports, and skips the recovery (read-only).
//
// Conversions (convert-import items: OpenCode, Codex compressed rollouts) are written by materializeConversions into their account's projects
// folder before the projects are created (a root whose only sessions fail to convert gets no empty project), then go
// through the same waves as native imports with the written transcript as their file.

import path from "node:path";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { AccountConfig, Config, DiscoveredSession, HarnessId, JournalEntry, Plan, PlanItem } from "../core/types.ts";
import { allAdapters, isConvertSession, otherForms, sessionIdsInT3 } from "../sources/registry.ts";
import { CWD_SCAN_MAX_BYTES, type SourceAdapter } from "../sources/types.ts";
import { ACTIVE_WINDOW_MS, inImportWindow } from "../core/activity.ts";
import { DEFAULT_BATCH } from "../core/config.ts";
import { materializeConversions, type ConvertFailReason } from "./materialize.ts";
import { Journal, near, newRunId, pendingMtimePaths, recoverPendingMtimes, type RecoverResult } from "../core/journal.ts";
import { acquireLock } from "../core/lock.ts";
import { statSafe } from "../core/fsutil.ts";
import { encodeClaudeProjectDir, normalizeCwd, pathKey, sameCwd } from "../core/paths.ts";
import { readClaudeNativeId } from "../sources/claude.ts";
import { connectT3, type ProviderInstanceInfo, type T3Api, type T3Project } from "../t3/api.ts";
import { T3HttpError, T3Incompatible } from "../t3/errors.ts";
import { DEFAULT_ID, applyProjectDefaults, assertDefaultInstanceHome, defaultClaudeHome, driftError, ensureInstances, entryHome } from "../ops/accounts.ts";
import { buildWaves, itemRoot, rootKey, waveItems } from "./waves.ts";
import {
  exposureIndex, restoreSync, runWaves, type BumpFile, type ExposedTranscript, type FailReason, type Progress, type WavesResult,
} from "./importer.ts";

export const PLAN_MAX_AGE_MS = 24 * 3_600_000;
const STALE = "Plan is stale; run `t3sm plan` again.";

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

const processSignals: SignalSource = {
  on: (sig, fn) => void process.on(sig as NodeJS.Signals, fn),
  off: (sig, fn) => void process.off(sig as NodeJS.Signals, fn),
};

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
   * applied, projects held this run removed) and the held project roots (a session of theirs is in use).
   * false: nothing is written (status "declined"). Omitted: proceed (--yes).
   */
  confirm?: (plan: Plan, held: { roots: string[]; sessions: number }) => Promise<boolean>;
  /** One line per wave. */
  onProgress?: (line: string) => void;
  onNotice?: (line: string) => void;
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
  /** Called once after every check (and confirm), right before the first write, with the plan as it will run (held projects removed). */
  beforeWrites?: (plan: Plan) => Promise<void>;
  /**
   * Extension point (Task 23 merge): runs while the lock is held and T3 is connected, after the waves and before
   * run-end; on a "noop" cycle it runs with runId null (it then journals its own run if it writes anything).
   */
  afterApply?: (ctx: AfterApplyContext) => Promise<void>;
}

export interface AfterApplyContext {
  api: T3Api;
  journal: Journal;
  plan: Plan;
  result: ApplyResult;
  runId: string | null;
}

/** What `apply --dry-run` found: the run as it would go, computed from the same checks, before any write. */
export interface DryRunReport {
  /** The plan as it would run (--only applied, held projects removed): what the confirmation summary shows. */
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
  failUpFront: { harness: string; nativeId: string; reason: FailReason }[];
  /** The home T3's default Claude instance would be pinned to (it is implicit now), or null. */
  pinDefault: string | null;
}

export interface ApplyResult {
  status: "ok" | "partial" | "aborted" | "locked" | "declined" | "noop" | "dry-run";
  dryRun?: DryRunReport;
  runId: string | null;
  imported: number;
  failed: number;
  failures: { harness: string; nativeId: string; reason: FailReason | ConvertFailReason }[];
  /** Converted transcripts written this run (convert-import items; files already in place are not counted). */
  converted: number;
  /** In use / changed / gone since planning (or, for conversions, the source busy / the session in use when read): left alone, the next run retries. */
  deferred: number;
  /** Of `deferred`: held because another transcript of their project is in use (T3 would import it now). */
  deferredInUse: number;
  /** The plan roots held this run (a transcript of the project in use). */
  heldRoots: string[];
  /** Sessions of the plan that T3 already had when this run started. */
  alreadyInT3: number;
  restoreErrors: { path: string; error: string }[];
  /** Attempted, but T3's thread list could not be read afterwards (see the journal's import-attempt). */
  unverified: number;
  /** Other transcripts parked (future file time) while their project imported, summed over the waves. */
  parked: number;
  recovered: RecoverResult | null;
}

const isObj = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u);

/** The T3 responses this run acts on, re-checked field by field before the first write (exit 4 on drift). */
export function validateSnapshot(version: string, projects: unknown, threads: unknown, providers: unknown): void {
  const bad = (what: string): never => {
    throw new T3Incompatible(version, `T3 Code ${version} returned an unexpected ${what} shape; nothing was changed. Update t3sm or report it.`);
  };
  if (!Array.isArray(projects)) bad("project list");
  for (const p of projects as unknown[]) {
    if (!isObj(p) || typeof p.id !== "string" || typeof p.workspaceRoot !== "string" || typeof p.title !== "string" || typeof p.archived !== "boolean") bad("project");
  }
  if (!Array.isArray(threads)) bad("thread list");
  for (const t of threads as unknown[]) if (!isObj(t) || typeof t.id !== "string" || typeof t.projectId !== "string") bad("thread");
  if (!Array.isArray(providers)) bad("provider list");
  for (const i of providers as unknown[]) {
    if (!isObj(i) || typeof i.instanceId !== "string" || typeof i.driver !== "string" || !(i.homePath === null || typeof i.homePath === "string")
      || (i.availability !== "available" && i.availability !== "unavailable")) bad("provider instance");
  }
}

function lastSegment(root: string): string {
  const parts = root.split("/").filter((x) => x !== "");
  return parts.length === 0 ? root : parts[parts.length - 1]!;
}

function nativeRoot(root: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.win32.normalize(root) : root;
}

/** `file` lies inside directory `dir` (path identity per platform). */
function inside(file: string, dir: string, platform: NodeJS.Platform): boolean {
  const f = rootKey(file, platform), d = rootKey(dir, platform);
  return f.startsWith(d.endsWith("/") ? d : `${d}/`);
}

function filterOnly(plan: Plan, only: string, platform: NodeJS.Platform): Plan {
  const keep = (r: string | null): boolean => r !== null && sameCwd(r, only, platform);
  const items = plan.items.filter((i) => keep(i.action.kind === "skip" ? i.session.cwd : i.action.projectRoot));
  const keptPaths = new Set(items.map((i) => i.session.file.path));
  const instancesUsed = new Set<string>([
    ...items.flatMap((i) => (i.action.kind === "skip" ? [] : [i.action.instanceId])),
    ...plan.projectDefaults.filter((d) => keep(d.root)).map((d) => d.instanceId),
  ]);
  return {
    ...plan,
    items,
    projectsToCreate: plan.projectsToCreate.filter((p) => keep(p.root)),
    projectDefaults: plan.projectDefaults.filter((d) => keep(d.root)),
    projectAccounts: plan.projectAccounts.filter((p) => keep(p.root)),
    instancesToCreate: plan.instancesToCreate.filter((s) => instancesUsed.has(s.id)),
    // A mirror whose kept copy is not in this root cannot be imported by this run's import calls.
    mirrorCopies: plan.mirrorCopies.filter((m) => keptPaths.has(m.keptPath) || !plan.items.some((i) => i.session.file.path === m.keptPath)),
  };
}

export function progressLine(p: Progress): string {
  return `Wave ${p.wave}/${p.totalWaves} · ${p.projects} ${p.projects === 1 ? "project" : "projects"} · ${p.sessions} sessions · imported ${p.imported} · retry ${p.retry}`
    + (p.failed ? ` · failed ${p.failed}` : "") + (p.deferred ? ` · deferred ${p.deferred}` : "");
}

/**
 * `planSource` is the plan, or a loader called only once the lock is held (the CLI reads plan.json there, so a held
 * lock always wins over a missing or stale plan).
 */
export async function applyPlan(planSource: Plan | (() => Promise<Plan>), deps: ApplyDeps): Promise<ApplyResult> {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const notice = deps.onNotice ?? (() => {});
  const result: ApplyResult = {
    status: "ok", runId: null, imported: 0, failed: 0, failures: [], converted: 0, deferred: 0, deferredInUse: 0, heldRoots: [], alreadyInT3: 0, restoreErrors: [], unverified: 0, parked: 0, recovered: null,
  };

  // A dry run takes the lock too (it reads a consistent state), but never creates the state folder for it.
  const noStateDir = deps.dryRun === true && (await stat(deps.stateDir).then(() => false, () => true));
  const lock = noStateDir ? { release: async () => {} } : await acquireLock(deps.stateDir);
  if (!lock) return { ...result, status: "locked" };
  const signals = deps.signals ?? processSignals;
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  let abort = false;
  let signalCount = 0;
  let pendingFiles: BumpFile[] | null = null;
  // 1st: stop after the current wave's restore. 2nd: if a wave is in progress, say so (once); otherwise nothing.
  // 3rd: restore the wave's files synchronously and exit 130 now; whatever could not be restored stays pending in the
  // journal for the next run's recovery. The lock file is left behind with this (dead) pid; the next run treats it as
  // stale.
  const onSignal = (): void => {
    abort = true;
    signalCount++;
    if (signalCount === 2) {
      if (pendingFiles) notice("Still restoring file times… (press Ctrl+C again to force; the journal restores the rest next run)");
    } else if (signalCount >= 3) {
      if (pendingFiles) restoreSync(pendingFiles);
      notice("Forced exit after restoring file times.");
      exit(130);
    }
  };
  // SIGHUP (the terminal or console window closed) stops the run like SIGTERM.
  for (const sig of STOP_SIGNALS) signals.on(sig, onSignal);
  try {
    const journal = new Journal(join(deps.stateDir, "journal.jsonl"));
    const entriesBefore = await journal.readAll(); // before the recovery: which future file times are t3sm's own
    const pendingRecovery = deps.dryRun ? pendingMtimePaths(entriesBefore, platform) : [];
    if (!deps.dryRun) result.recovered = await recoverPendingMtimes(journal);

    const inputPlan = typeof planSource === "function" ? await planSource() : planSource;
    const created = Date.parse(inputPlan.createdAt);
    if (inputPlan.version !== 1 || !Number.isFinite(created) || now() - created > PLAN_MAX_AGE_MS || created - now() > 3_600_000) throw new ApplyRefusal(STALE);
    const plan = deps.only ? filterOnly(inputPlan, deps.only, platform) : inputPlan;
    if (deps.only && plan.items.length === 0 && plan.projectsToCreate.length === 0 && plan.projectDefaults.length === 0) {
      throw new ApplyRefusal(`No sessions or projects under ${deps.only} in this plan.`);
    }

    const connect = deps.connect ?? connectT3;
    const pinWanted = deps.pinDefaultInstance !== false && plan.pinDefault != null ? plan.pinDefault : null;
    const manageProviders = !deps.dryRun && (plan.instancesToCreate.length > 0 || pinWanted !== null);
    const api = await connect(deps.home, { allowUntested: deps.allowUntested ?? false, manageProviders, onNotice: notice });
    try {
      if (plan.t3Version !== api.version) throw new ApplyRefusal(`T3 Code changed from ${plan.t3Version} to ${api.version} since the plan. ${STALE}`);

      // ---------- checks: nothing has been written yet ----------
      const [projects, threads, providers] = await Promise.all([api.listProjects(), api.listThreads(), api.providerInstances()]);
      validateSnapshot(api.version, projects, threads, providers);
      // T3's default Claude instance must read the config account whose home is ~/.claude (matched by home, any id).
      let settingsP: Promise<Record<string, unknown>> | null = null;
      const settings = (): Promise<Record<string, unknown>> => (settingsP ??= api.getConfig().then((c) => c.settings.providerInstances));
      if (deps.accountHomes) {
        const homes = Object.values(deps.accountHomes());
        const def = providers.find((p) => p.instanceId === DEFAULT_ID && p.driver === "claudeAgent");
        // T3's settings are read only when the default instance's home is in question (they say which advice applies).
        assertDefaultInstanceHome(providers, homes, deps.home, platform, def?.homePath != null && !sameCwd(def.homePath, defaultClaudeHome(deps.home), platform) ? await settings() : undefined);
      }
      await warnMirrors(plan, now(), notice);
      checkInstanceHomes(plan, providers, platform);
      // The pin is made only while the instance is still implicit (no settings entry) and reads that home (or none).
      let pin: { instanceId: string; homePath: string } | null = null;
      if (pinWanted !== null) {
        const def = providers.find((p) => p.instanceId === pinWanted.instanceId);
        if (def && def.homePath !== null && !sameCwd(def.homePath, pinWanted.homePath, platform)) throw driftError(await settings(), def.homePath);
        if (def && sameCwd(pinWanted.homePath, defaultClaudeHome(deps.home), platform)
          && !Object.hasOwn(await settings(), pinWanted.instanceId)) pin = pinWanted;
      }
      if (abort) return { ...result, status: "aborted" };

      // Exposure (what T3 could import besides the plan's items): every discovered session, plus the homes of the
      // instances this run will create (a mirror there is exposed as soon as the instance exists), plus a wave-time
      // listing of new files. Projects with a transcript in use right now are held for the whole run: computed here,
      // before the nothing-to-write check, so a cycle where everything pending is held writes nothing at all.
      const exposedItems = deps.exposure?.() ?? inputPlan.items;
      const ahead = futureLeftovers(exposedItems.map((i) => i.session.file), entriesBefore, now(), platform);
      if (ahead.length > 0) {
        notice(`Warning: ${ahead.length} transcript${ahead.length === 1 ? " has" : "s have"} a file time more than 10 minutes in the future that no interrupted t3sm run explains; T3 Code skips ${ahead.length === 1 ? "it" : "them"} until then. Run \`t3sm doctor\` to list ${ahead.length === 1 ? "it" : "them"}.`);
      }
      let liveProviders: ProviderInstanceInfo[] = [...providers, ...plan.instancesToCreate
        .filter((s) => !providers.some((p) => p.instanceId === s.id))
        .map((s): ProviderInstanceInfo => ({ instanceId: s.id, driver: "claudeAgent", homePath: s.homePath, displayName: s.displayName, accentColor: s.accentColor, email: null, authStatus: null, enabled: true, availability: "available" }))];
      const homes = deps.accountHomes?.() ?? {};
      // Claude transcripts discovery already read keep its id (no re-read at wave time); only new files are streamed.
      const knownIds = new Map(exposedItems.filter((i) => i.session.harness === "claude").map((i) => [pathKey(i.session.file.path, platform), i.session.nativeId]));
      const live = liveExposure(() => liveProviders, platform, deps.rediscover, {
        accountHome: (id) => (Object.hasOwn(homes, id) ? homes[id] : undefined), warn: notice,
        knownId: (p) => knownIds.get(pathKey(p, platform)),
      });
      // An item whose session T3 already holds in its other form (Codex: native vs converted thread) counts as in T3.
      const threadIds0 = inT3ThreadIds(plan.items, threads);
      const refs0 = new Set(threads.flatMap((t) => (t.nativeSessionId ? [`${t.instanceId}:${t.nativeSessionId}`] : [])));
      // A convert-import item is exposed through its converted transcript (written by an earlier run, or not yet).
      const pendingImports = plan.items.filter((i) => i.action.kind !== "skip" && !threadIds0.has(i.action.expectedThreadId)).map(asTargetItem);
      const pre = exposureIndex({
        entries: exposureOf(exposedItems, liveProviders, platform), items: pendingImports, platform, live,
        inT3: (ids, rs) => ids.some((id) => threadIds0.has(id)) || rs.some((r) => refs0.has(r)),
      });
      const heldAtStart = new Set<string>();
      const rootsOf = new Map<string, string>();
      for (const i of pendingImports) rootsOf.set(rootKey(itemRoot(i), platform), itemRoot(i));
      for (const [k, root] of rootsOf) if ((await pre.scan(k, root, now, new Set(), 0)).inUse) heldAtStart.add(k);
      const isHeld = (r: string): boolean => heldAtStart.has(rootKey(r, platform));
      const heldItems = pendingImports.filter((i) => isHeld(itemRoot(i)));
      const runnable: Plan = heldAtStart.size === 0 ? { ...plan, pinDefault: pin } : {
        ...plan,
        pinDefault: pin,
        items: plan.items.filter((i) => !(i.action.kind !== "skip" && isHeld(i.action.projectRoot))),
        projectsToCreate: plan.projectsToCreate.filter((p) => !isHeld(p.root)),
        projectDefaults: plan.projectDefaults.filter((d) => !isHeld(d.root)),
      };
      const noteHeld = (): void => {
        result.deferred += heldItems.length;
        result.deferredInUse += heldItems.length;
        for (const r of rootsOf.values()) if (isHeld(r) && !result.heldRoots.includes(r)) result.heldRoots.push(r);
      };

      if (deps.noopWithoutWrites && pin === null && nothingToWrite(runnable, projects, threadIds0, platform)) {
        const ids = threadIds0;
        const liveIds = runnable.items.flatMap((i) => (i.action.kind === "skip" ? [] : [i.action.expectedThreadId]));
        result.alreadyInT3 = liveIds.filter((id) => ids.has(id)).length;
        noteHeld();
        result.status = "noop";
        if (deps.afterApply) await deps.afterApply({ api, journal, plan, result, runId: null });
        return result;
      }
      const heldRootNames = [...rootsOf.values()].filter((r) => isHeld(r));
      if (deps.dryRun) {
        const report = dryRunReport(runnable, projects, providers, threadIds0, deps.batch ?? DEFAULT_BATCH, platform);
        return { ...result, status: "dry-run", dryRun: { ...report, pendingRecovery, held: { roots: heldRootNames, sessions: heldItems.length }, pinDefault: pin?.homePath ?? null } };
      }
      if (deps.confirm && !(await deps.confirm(runnable, { roots: heldRootNames, sessions: heldItems.length }))) return { ...result, status: "declined" };
      if (abort) return { ...result, status: "aborted" };
      if (deps.beforeWrites) await deps.beforeWrites(runnable); // what this run does (held projects removed)

      // ---------- writes ----------
      const runId = deps.runId ?? newRunId(new Date(now()));
      result.runId = runId;
      await journal.append({ t: "run-start", runId, at: new Date(now()).toISOString(), command: deps.command ?? `apply ${inputPlan.runId}${deps.only ? " --only" : ""}` });
      await backfillImported(journal, new Set(threads.map((t) => t.id)));
      let waves: WavesResult | null = null;
      try {
        if (pin !== null) {
          const r = await api.pinInstanceHome(pin.instanceId, pin.homePath);
          if (r.changed) await journal.append({ t: "instance-pinned", runId, instanceId: pin.instanceId, previous: { homePath: entryHome(r.previous) }, next: { homePath: pin.homePath } });
        }
        if (plan.instancesToCreate.length > 0) {
          await ensureInstances(api, plan.instancesToCreate, journal, runId, defaultClaudeHome(deps.home));
          liveProviders = await api.providerInstances(); // the instances as T3 now has them (created ones included)
        }
        noteHeld();

        const threadIds = threadIds0;
        const liveItems = runnable.items.filter((i) => i.action.kind !== "skip");
        const pending = liveItems.filter((i) => !threadIds.has((i.action as { expectedThreadId: string }).expectedThreadId));
        result.alreadyInT3 = liveItems.length - pending.length;
        const toImport = pending.filter((i) => i.action.kind === "import");
        const toConvert = pending.filter((i) => i.action.kind === "convert-import");
        if (toConvert.length > 0 && !abort) { // interrupted first: not attempted (like a wave never started)
          const m = await materializeConversions(toConvert, adapterMap(deps.adapters ?? allAdapters()), conversionAccounts(liveProviders, deps.accountHomes?.() ?? {}), journal, runId, { platform });
          result.converted = m.written.length;
          result.deferred += m.deferred.length; // source busy / session in use: next run, not a failure
          for (const { item, reason } of m.failed) {
            result.failed++;
            result.failures.push({ harness: item.session.harness, nativeId: item.session.nativeId, reason });
            await journal.append({ t: "import-failed", runId, harness: item.session.harness, nativeId: item.session.nativeId, reason: `convert: ${reason}` });
          }
          toImport.push(...m.ready); // the converted transcript is now the item's file
        }

        const projectOf = await ensureProjects(api, runnable, projects, toImport, journal, runId, platform);
        const defaults: { projectId: string; instanceId: string }[] = [];
        for (const d of runnable.projectDefaults) {
          const p = projectOf.get(rootKey(d.root, platform));
          if (p) defaults.push({ projectId: p.id, instanceId: d.instanceId });
        }
        if (defaults.length > 0) await applyProjectDefaults(api, defaults, journal, runId);

        if (toImport.length > 0 && !abort) {
          const batch = deps.batch ?? DEFAULT_BATCH;
          const cost = (i: PlanItem): number => i.session.cwdOffsetBytes;
          const projectIds = new Map<string, string>();
          const importRoots = new Map<string, string>();
          for (const [k, p] of projectOf) { projectIds.set(k, p.id); importRoots.set(k, p.workspaceRoot); }
          // From the list read after ensureInstances: a just-created instance has its real availability here.
          const providerAvail = new Map(liveProviders.map((p) => [p.instanceId, p.availability] as const));
          waves = await runWaves({
            api, journal, runId, projectIds, importRoots, now, batch, cost, platform,
            instanceAvailability: providerAvail,
            exposure: exposureOf(exposedItems, liveProviders, platform), liveExposure: live,
            aborted: () => abort,
            onPendingFiles: (f) => { pendingFiles = f; },
            onProgress: (p) => deps.onProgress?.(progressLine(p)),
            onNotice: notice,
          }, buildWaves(toImport, batch, cost, { platform }));
          result.imported = waves.imported.length;
          result.unverified = waves.unverified.length;
          result.failed += waves.failed.length;
          result.failures.push(...waves.failed.map((f) => ({ harness: f.item.session.harness, nativeId: f.item.session.nativeId, reason: f.reason })));
          result.deferred += waves.deferred.length;
          result.deferredInUse += waves.deferred.filter((d) => d.reason === "project-in-use").length;
          for (const r of waves.heldRoots) if (!result.heldRoots.some((x) => rootKey(x, platform) === rootKey(r, platform))) result.heldRoots.push(r);
          result.restoreErrors = waves.restoreErrors;
          result.parked = waves.parked;
          const jumped = waves.deferred.filter((d) => d.reason === "clock-jump").length;
          if (jumped > 0) notice(`The system clock jumped during an import (sleep or a time change): ${jumped} ${jumped === 1 ? "session waits" : "sessions wait"} for the next run. Keep the machine awake while t3sm imports.`);
        }
        result.status = abort || waves?.aborted ? "aborted" : result.failed > 0 || result.unverified > 0 || result.restoreErrors.length > 0 ? "partial" : "ok";
        if (deps.afterApply && !abort) await deps.afterApply({ api, journal, plan, result, runId });
      } catch (e) {
        await journal.append({ t: "run-end", runId, at: new Date(now()).toISOString(), status: "aborted" }).catch(() => {});
        throw e;
      }
      await journal.append({ t: "run-end", runId, at: new Date(now()).toISOString(), status: result.status as "ok" | "partial" | "aborted" });
      return result;
    } finally {
      await api.close();
    }
  } finally {
    for (const sig of STOP_SIGNALS) signals.off(sig, onSignal);
    await lock.release();
  }
}

/**
 * Transcripts more than ACTIVE_WINDOW_MS ahead of `now` that no pending journal bump explains (a parked file whose
 * journal entry was lost, or a clock that was wrong when the file was written). T3 Code skips them; t3sm cannot know
 * their real time, so they are only reported (apply / sync warn, doctor lists them).
 */
export function futureLeftovers(files: { path: string; mtimeMs: number }[], entries: JournalEntry[], now: number, platform: NodeJS.Platform = process.platform): string[] {
  const key = (p: string): string => pathKey(p, platform);
  const pending = new Set(pendingMtimePaths(entries, platform).map(key));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of files) {
    const k = key(f.path);
    if (f.mtimeMs <= now + ACTIVE_WINDOW_MS || pending.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(f.path);
  }
  return out;
}

/**
 * A wave that died before it could verify (crash, T3's thread list unreachable) left `import-attempt` items without an
 * `imported` entry. For each whose thread exists now and whose file is still exactly as attempted (size + mtime), the
 * missing `imported` is journaled under the attempt's run (merge reads it as the session's import baseline; `runs`
 * counts it). A file changed since is left without one: what T3 holds of it is unknown. Idempotent.
 */
async function backfillImported(journal: Journal, threadIds: Set<string>): Promise<number> {
  const es = await journal.readAll();
  const have = new Set(es.flatMap((e) => (e.t === "imported" ? [`${e.harness}:${e.nativeId}`] : [])));
  let n = 0;
  for (const e of es) {
    if (e.t !== "import-attempt" || !Array.isArray(e.items)) continue;
    for (const x of e.items as unknown[]) {
      if (!isObj(x) || typeof x.threadId !== "string" || typeof x.nativeId !== "string" || typeof x.harness !== "string" || !isObj(x.source)) continue;
      const src = x.source;
      if (typeof src.path !== "string" || typeof src.size !== "number" || typeof src.mtimeMs !== "number") continue;
      const k = `${x.harness}:${x.nativeId}`;
      if (have.has(k) || !threadIds.has(x.threadId)) continue;
      const st = await statSafe(src.path).catch(() => null);
      if (!st || st.size !== src.size || !near(st.mtimeMs, src.mtimeMs)) continue;
      const item = x as unknown as Extract<JournalEntry, { t: "import-attempt" }>["items"][number];
      await journal.append({ t: "imported", runId: e.runId, harness: item.harness, nativeId: item.nativeId, threadId: item.threadId, source: { path: src.path, size: src.size, mtimeMs: src.mtimeMs } });
      have.add(k);
      n++;
    }
  }
  return n;
}

/**
 * The writes a run of `plan` (already --only-filtered, held projects removed) would make, mirroring the write phase:
 * instances (ensureInstances), conversions (materializeConversions), projects (ensureProjects), defaults
 * (applyProjectDefaults: unchanged ones are skipped), up-front failures and waves (runWaves / buildWaves).
 */
function dryRunReport(
  plan: Plan, projects: T3Project[], providers: ProviderInstanceInfo[], threadIds: Set<string>, batch: Config["batch"], platform: NodeJS.Platform,
): Omit<DryRunReport, "pendingRecovery" | "held" | "pinDefault"> {
  const live = plan.items.filter((i) => i.action.kind !== "skip");
  const pending = live.filter((i) => !threadIds.has((i.action as { expectedThreadId: string }).expectedThreadId));
  const existing = (root: string): T3Project | undefined => projects.find((p) => !p.deleted && rootKey(p.workspaceRoot, platform) === rootKey(root, platform));
  const projectsToCreate: string[] = [];
  for (const i of pending) {
    const r = itemRoot(i);
    if (!existing(r) && !projectsToCreate.some((x) => rootKey(x, platform) === rootKey(r, platform))) projectsToCreate.push(r);
  }
  const defaultsToSet = plan.projectDefaults.filter((d) => {
    const p = existing(d.root);
    if (p) return p.defaultModelSelection?.instanceId !== d.instanceId;
    return projectsToCreate.some((x) => rootKey(x, platform) === rootKey(d.root, platform));
  }).map((d) => ({ root: d.root, instanceId: d.instanceId }));
  const availability = new Map(providers.map((p) => [p.instanceId, p.availability] as const));
  const failUpFront: DryRunReport["failUpFront"] = [];
  const waveable: PlanItem[] = [];
  for (const i of pending) {
    const id = (i.action as { instanceId: string }).instanceId;
    const reason: FailReason | null = i.action.kind === "import" && i.session.cwdOffsetBytes > CWD_SCAN_MAX_BYTES ? "cwd-unreadable-in-t3"
      : availability.get(id) === "unavailable" ? "instance-unavailable" : null;
    if (reason) failUpFront.push({ harness: i.session.harness, nativeId: i.session.nativeId, reason });
    else waveable.push(asTargetItem(i));
  }
  const waves = buildWaves(waveable, batch, (i) => i.session.cwdOffsetBytes, { platform });
  return {
    plan,
    instancesToCreate: plan.instancesToCreate.filter((s) => !providers.some((p) => p.instanceId === s.id)).map((s) => s.id),
    projectsToCreate, defaultsToSet,
    conversions: pending.filter((i) => i.action.kind === "convert-import").length,
    waves: waves.length,
    waveSessions: waves.reduce((n, w) => n + waveItems(w).length, 0),
    alreadyInT3: live.length - pending.length,
    failUpFront,
  };
}

/**
 * T3's thread ids, plus the expected thread id of every item whose session T3 already holds in its OTHER form (any
 * instance): a Codex session imported natively and since compressed, or converted and since seen as a plain rollout.
 * One session never gets a second thread, whatever the plan (an older plan.json) says.
 */
export function inT3ThreadIds(items: PlanItem[], threads: { id: string; nativeSessionId?: string | null }[]): Set<string> {
  const out = new Set(threads.map((t) => t.id));
  const sessionIds = sessionIdsInT3(threads);
  for (const i of items) {
    if (i.action.kind === "skip") continue;
    const own = i.action.kind === "convert-import" ? i.action.uuid : i.session.nativeId;
    if (!sessionIds.has(own) && otherForms(i.session, own).some((f) => sessionIds.has(f))) out.add(i.action.expectedThreadId);
  }
  return out;
}

/** No instance to create, no import pending in T3, no project default that would change: a run would write nothing. */
function nothingToWrite(plan: Plan, projects: T3Project[], threadIds: ReadonlySet<string>, platform: NodeJS.Platform): boolean {
  if (plan.instancesToCreate.length > 0) return false;
  if (plan.items.some((i) => i.action.kind !== "skip" && !threadIds.has(i.action.expectedThreadId))) return false;
  for (const d of plan.projectDefaults) {
    const k = rootKey(d.root, platform);
    const p = projects.find((x) => !x.deleted && rootKey(x.workspaceRoot, platform) === k);
    // A project that does not exist is only created for imports (none pending here), so its default is not set either.
    if (p && p.defaultModelSelection?.instanceId !== d.instanceId) return false;
  }
  return true;
}

/**
 * A mirror copy inside the 30-day window is parked during every wave of its project (runWaves' exposure), so this run
 * never imports it under the wrong account. T3's own Welcome import could still take it: warn, recommend dedupe.
 */
async function warnMirrors(plan: Plan, now: number, notice: (l: string) => void): Promise<void> {
  let live = 0;
  for (const m of plan.mirrorCopies) {
    const st = await statSafe(m.path).catch(() => null);
    if (st && inImportWindow(st.mtimeMs, now)) live++;
  }
  if (live > 0) {
    notice(`Warning: ${live} mirror ${live === 1 ? "copy is" : "copies are"} inside T3 Code's 30-day window. t3sm parks them while it imports, but T3 Code's own Welcome import could still take them under the wrong account: run \`t3sm dedupe\` (and \`t3sm quarantine\` for backup folders).`);
  }
}

/**
 * What T3 could import, as ExposedTranscript: every discovered native transcript with a cwd, with the thread ids T3
 * would give it. A Claude transcript belongs to the instances whose home holds it (unknown homes: every instance
 * without one); none = no instance reads it, so T3 cannot import it. Other harnesses: any non-Claude instance.
 */
export function exposureOf(items: PlanItem[], providers: ProviderInstanceInfo[], platform: NodeJS.Platform): ExposedTranscript[] {
  const out: ExposedTranscript[] = [];
  const claude = providers.filter((p) => p.driver === "claudeAgent");
  // A disabled or unavailable Codex/Pi instance does not import anything.
  const others = providers.filter((p) => p.driver !== "claudeAgent" && p.enabled && p.availability === "available");
  for (const it of items) {
    const s = it.session;
    // Convert-mode sessions and compressed rollouts are never read by T3 itself.
    if (s.cwd === null || isConvertSession(s) || s.flags?.includes("compressed")) continue;
    if (s.flags.includes("cwd-unreadable")) continue; // T3 cannot read its cwd, so it cannot match a project
    let insts: string[];
    if (s.harness === "claude") {
      const owners = claude.filter((p) => p.homePath !== null && inside(s.file.path, p.homePath, platform));
      insts = (owners.length > 0 ? owners : claude.filter((p) => p.homePath === null)).map((p) => p.instanceId);
    } else insts = others.map((p) => p.instanceId);
    if (insts.length === 0) continue;
    const threadIds = insts.map((i) => `import:${i}:${s.nativeId}`);
    if (it.action.kind !== "skip") threadIds.push(it.action.expectedThreadId);
    out.push({ path: s.file.path, cwd: s.cwd, threadIds, refs: insts.map((i) => `${i}:${s.nativeId}`), harness: s.harness, nativeId: s.nativeId, cost: s.cwdOffsetBytes });
  }
  return out;
}

/**
 * Wave-time listing of a root's transcripts, for files created after planning. Claude: `<home>/projects/<encoded
 * root>/*.jsonl` in every Claude instance home (the encoded folder matched case-insensitively on Windows and macOS, so
 * drive-letter case variants are included), each under the id T3 imports it as (claudeNativeId: `knownId` for files
 * discovery already read, else the file is streamed once). Codex / Pi: `rediscover` (the adapters' cached
 * discovery), at most once per wave, filtered to that cwd.
 */
export function liveExposure(
  getProviders: () => ProviderInstanceInfo[], platform: NodeJS.Platform, rediscover?: () => Promise<DiscoveredSession[]>,
  o: { accountHome?: (instanceId: string) => string | undefined; warn?: (line: string) => void; knownId?: (path: string) => string | undefined } = {},
): (root: string, wave: number) => Promise<ExposedTranscript[]> {
  const fold = platform === "win32" || platform === "darwin";
  let natWave = -1;
  let nat: Promise<DiscoveredSession[]> = Promise.resolve([]);
  const warned = new Set<string>();
  return async (root, wave) => {
    const out: ExposedTranscript[] = [];
    const enc = encodeClaudeProjectDir(normalizeCwd(root, platform));
    const want = fold ? enc.toLowerCase() : enc;
    for (const p of getProviders()) {
      if (p.driver !== "claudeAgent") continue;
      // T3 reports no home for an implicit instance it has not resolved: the config account of that id names it.
      const home = p.homePath ?? o.accountHome?.(p.instanceId);
      if (!home) {
        if (!warned.has(p.instanceId)) { warned.add(p.instanceId); o.warn?.(`Warning: could not list ${p.instanceId}: home unknown (new transcripts there are not parked this run).`); }
        continue;
      }
      const projects = join(home, "projects");
      const dirs = await readdir(projects).catch(() => [] as string[]);
      for (const d of dirs) {
        if ((fold ? d.toLowerCase() : d) !== want) continue;
        for (const f of await readdir(join(projects, d)).catch(() => [] as string[])) {
          if (!f.endsWith(".jsonl")) continue;
          // T3's id rule, as discovery applies it (claudeNativeId): a file named after one session can carry another.
          const path = join(projects, d, f);
          const id = o.knownId?.(path) ?? await readClaudeNativeId(path);
          out.push({ path, cwd: root, threadIds: [`import:${p.instanceId}:${id}`], refs: [`${p.instanceId}:${id}`], harness: "claude", nativeId: id });
        }
      }
    }
    if (rediscover && getProviders().some((p) => p.driver !== "claudeAgent" && p.enabled && p.availability === "available")) {
      if (natWave !== wave) { natWave = wave; nat = rediscover().catch(() => []); }
      const k = rootKey(root, platform);
      const mine = (await nat).filter((s) => s.harness !== "claude" && s.cwd !== null && rootKey(s.cwd, platform) === k);
      out.push(...exposureOf(mine.map((session) => ({ session, action: { kind: "skip", reason: "excluded" }, notes: [] })), getProviders(), platform));
    }
    return out;
  };
}

/** A convert-import item as the exposure checks see it: its file is the converted transcript (the source is shared). */
function asTargetItem(i: PlanItem): PlanItem {
  if (i.action.kind !== "convert-import") return i;
  return { ...i, session: { ...i.session, file: { ...i.session.file, path: i.action.targetFile } } };
}

/** The adapters that convert sessions (`read`), by harness: convert-mode ones, and Codex for compressed rollouts. */
function adapterMap(adapters: SourceAdapter[]): Map<HarnessId, SourceAdapter> {
  return new Map(adapters.filter((a) => typeof a.read === "function").map((a) => [a.id, a]));
}

/** The homes conversions may write into: every Claude instance home T3 reports, plus the config accounts' homes. */
function conversionAccounts(providers: ProviderInstanceInfo[], homes: Record<string, string>): AccountConfig[] {
  const out: AccountConfig[] = [];
  for (const p of providers) if (p.driver === "claudeAgent" && p.homePath !== null) out.push({ id: p.instanceId, home: p.homePath, displayName: p.displayName, accentColor: null });
  for (const [id, home] of Object.entries(homes)) out.push({ id, home, displayName: id, accentColor: null });
  return out;
}

/** Every Claude item must still live in the home its instance reads (S4: an inherited CLAUDE_CONFIG_DIR moves homes). */
function checkInstanceHomes(plan: Plan, providers: ProviderInstanceInfo[], platform: NodeJS.Platform): void {
  const toCreate = new Set(plan.instancesToCreate.map((s) => s.id));
  for (const it of plan.items) {
    if (it.action.kind === "skip") continue;
    const id = it.action.instanceId;
    const live = providers.find((p) => p.instanceId === id);
    if (!live) {
      if (toCreate.has(id)) continue;
      throw new ApplyRefusal(`T3 instance ${id} no longer exists. ${STALE}`);
    }
    if (it.action.kind === "convert-import") {
      if (live.homePath !== null && !inside(it.action.targetFile, live.homePath, platform)) {
        throw new ApplyRefusal(`T3 instance ${id} now reads ${live.homePath}, not the home session ${it.session.nativeId} would be converted into; converting would file it under the wrong account. Check \`t3sm accounts\`, then run \`t3sm plan\` again.`);
      }
      continue;
    }
    if (it.session.harness !== "claude" || it.action.kind !== "import" || live.homePath === null) continue;
    if (!inside(it.session.file.path, live.homePath, platform)) {
      throw new ApplyRefusal(`T3 instance ${id} now reads ${live.homePath}, which does not hold session ${it.session.nativeId}; importing would file it under the wrong account. Check \`t3sm accounts\`, then run \`t3sm plan\` again.`);
    }
  }
}

/** root key -> T3 project for every root with an import item: existing projects first (sameCwd), else created and journaled. */
async function ensureProjects(
  api: T3Api, plan: Plan, liveProjects: T3Project[], toImport: PlanItem[], journal: Journal, runId: string, platform: NodeJS.Platform,
): Promise<Map<string, T3Project>> {
  const out = new Map<string, T3Project>();
  const find = (ps: T3Project[], k: string): T3Project | undefined => ps.find((p) => !p.deleted && rootKey(p.workspaceRoot, platform) === k);
  const needed = new Map<string, string>();
  for (const i of toImport) needed.set(rootKey(itemRoot(i), platform), itemRoot(i));
  for (const d of plan.projectDefaults) {
    const k = rootKey(d.root, platform);
    const p = find(liveProjects, k);
    if (p) out.set(k, p);
  }
  for (const [k, root] of needed) {
    const existing = find(liveProjects, k);
    if (existing) { out.set(k, existing); continue; }
    const spec = plan.projectsToCreate.find((p) => rootKey(p.root, platform) === k);
    const title = spec?.title ?? lastSegment(normalizeCwd(root, platform));
    let p: T3Project;
    try {
      p = await api.createProject(nativeRoot(root, platform), title);
    } catch (e) {
      // 400 invalid_command = a project already owns this root (S2 §7): re-read and use it.
      const again = e instanceof T3HttpError && e.status === 400 ? find(await api.listProjects(), k) : undefined;
      if (!again) throw e;
      out.set(k, again);
      continue;
    }
    await journal.append({ t: "project-created", runId, projectId: p.id, root: p.workspaceRoot });
    out.set(k, p);
  }
  return out;
}
