// applyPlan: the only command path that changes T3 Code and file times for imports.
// Order: lock -> recoverPendingMtimes -> load plan + age -> connect -> version + response shapes + instance-home
// checks (+ mirror warning) -> confirm (all BEFORE the first write) -> instances -> conversions -> projects -> defaults
// -> waves -> run-end. A dry run (`dryRun`) stops before confirm, reports, and skips the recovery (read-only).
//
// Rehome destination folders (interactive runs only, `rehomeFolders`; sync never passes it, safety invariant 13): a
// copy's destination folder that T3 Code does not have yet and that is missing on disk (the General folder, a
// `rehome:<folder>` override) is created and journaled (`folder-created`) before the copies are written. One T3 Code
// refuses, a temp or system folder, or one that cannot be created fails its own items ("cannot create <folder>:
// <reason>"); the rest of the run goes on.
//
// Conversions (convert-import items: OpenCode, Codex compressed rollouts) are written by materializeConversions into their account's projects
// folder before the projects are created (a root whose only sessions fail to convert gets no empty project), then go
// through the same waves as native imports with the written transcript as their file.
//
// Next to it: applyTypes.ts (deps, result, dry-run report), checks.ts (the read-only checks), exposure.ts (what T3
// could import), rehomeFolders.ts, projects.ts, steps.ts (write-phase helpers) and importer.ts (the waves).

import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { Plan, PlanItem } from "../core/types.ts";
import { allAdapters } from "../sources/registry.ts";
import { DEFAULT_BATCH } from "../core/config.ts";
import { materializeConversions, type ConvertFailReason } from "./materialize.ts";
import { Journal, newRunId, pendingMtimePaths, recoverPendingMtimes } from "../core/journal.ts";
import { acquireLock } from "../core/lock.ts";
import { normalizeCwd, pathKey, sameCwd } from "../core/paths.ts";
import { cliT, type CliKey } from "../i18n/cli.ts";
import { connectT3, type ProviderInstanceInfo } from "../t3/api.ts";
import { DEFAULT_ID, applyProjectDefaults, assertDefaultInstanceHome, defaultClaudeHome, driftError, ensureInstances, entryHome } from "../ops/accounts.ts";
import { buildWaves, itemRoot, rootKey } from "./waves.ts";
import { runWaves, type Progress, type WavesResult } from "./importer.ts";
import { restoreSync, type BumpFile } from "./restore.ts";
import {
  ApplyRefusal, PLAN_MAX_AGE_MS, STALE, STOP_SIGNALS, failureOf, nameFailures, type ApplyDeps, type ApplyResult, type DryRunReport, type SignalSource,
} from "./applyTypes.ts";
import { checkInstanceHomes, dryRunReport, filterOnly, nothingToWrite, validateSnapshot, warnMirrors } from "./checks.ts";
import { asTargetItem, exposureIndex, exposureOf, futureLeftovers, inT3ThreadIds, liveExposure } from "./exposure.ts";
import { checkRehomeFolders, prepareRehomeFolders } from "./rehomeFolders.ts";
import { ensureProjects, lastSegment } from "./projects.ts";
import { adapterMap, backfillImported, conversionAccounts, heldEntry, isOrphanCopy, recheckOrphans } from "./steps.ts";

export {
  ApplyRefusal, PLAN_MAX_AGE_MS, STOP_SIGNALS, failureOf, nameFailures,
  type AfterApplyContext, type ApplyDeps, type ApplyResult, type DryRunReport, type ImportFailure, type RehomeFolders, type SignalSource,
} from "./applyTypes.ts";
export { validateSnapshot } from "./checks.ts";
export { exposureOf, futureLeftovers, inT3ThreadIds, liveExposure } from "./exposure.ts";

const processSignals: SignalSource = {
  on: (sig, fn) => void process.on(sig as NodeJS.Signals, fn),
  off: (sig, fn) => void process.off(sig as NodeJS.Signals, fn),
};

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
  const tr = (k: CliKey, v: Record<string, string | number> = {}): string => cliT(deps.lang ?? "en", k, v);
  const result: ApplyResult = {
    status: "ok", runId: null, imported: 0, failed: 0, failures: [], converted: 0, deferred: 0, deferredInUse: 0, heldRoots: [], held: [], alreadyInT3: 0, restoreErrors: [], unverified: 0, parked: 0, recovered: null,
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
      if (pendingFiles) notice(tr("apply.notice.stillRestoring"));
    } else if (signalCount >= 3) {
      if (pendingFiles) restoreSync(pendingFiles);
      notice(tr("apply.notice.forcedExit"));
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
      await warnMirrors(plan, now(), notice, tr);
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
        notice(tr("apply.notice.futureTimes", { n: ahead.length }));
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
      // A held project's name as T3 shows it: its existing title (renamed, General, de-duplicated), else the plan's, else the folder.
      const projectName = (root: string): string => {
        const k = rootKey(root, platform);
        return projects.find((p) => !p.deleted && rootKey(p.workspaceRoot, platform) === k)?.title
          ?? plan.projectsToCreate.find((p) => rootKey(p.root, platform) === k)?.title ?? lastSegment(normalizeCwd(root, platform));
      };
      for (const [k, root] of rootsOf) {
        const s = await pre.scan(k, root, now, new Set(), 0);
        if (!s.inUse) continue;
        heldAtStart.add(k);
        if (s.active) result.held.push(await heldEntry(projectName(root), root, s.active));
      }
      const isHeld = (r: string): boolean => heldAtStart.has(rootKey(r, platform));
      const heldItems = pendingImports.filter((i) => isHeld(itemRoot(i)));
      // A held project keeps its project and default (S6: creating one imports nothing); only its imports wait.
      const runnable: Plan = heldAtStart.size === 0 ? { ...plan, pinDefault: pin } : {
        ...plan,
        pinDefault: pin,
        items: plan.items.filter((i) => !(i.action.kind !== "skip" && isHeld(i.action.projectRoot))),
      };
      const noteHeld = (): void => {
        result.deferred += heldItems.length;
        result.deferredInUse += heldItems.length;
        for (const r of rootsOf.values()) if (isHeld(r) && !result.heldRoots.includes(r)) result.heldRoots.push(r);
      };

      const heldToCreate = heldItems.some((i) => !projects.some((p) => !p.deleted && rootKey(p.workspaceRoot, platform) === rootKey(itemRoot(i), platform)));
      if (deps.noopWithoutWrites && pin === null && !heldToCreate && nothingToWrite(runnable, projects, threadIds0, platform)) {
        const ids = threadIds0;
        const liveIds = runnable.items.flatMap((i) => (i.action.kind === "skip" ? [] : [i.action.expectedThreadId]));
        result.alreadyInT3 = liveIds.filter((id) => ids.has(id)).length;
        noteHeld();
        result.status = "noop";
        if (deps.afterApply) await deps.afterApply({ api, journal, plan, result, runId: null, aborted: () => abort, onPendingFiles: (f) => { pendingFiles = f; } });
        return result;
      }
      const heldRootNames = [...rootsOf.values()].filter((r) => isHeld(r));
      // The folders a run would create for rehome copies: shown by the dry run and the confirmation.
      const foldersToCreate = deps.rehomeFolders
        ? (await checkRehomeFolders(pendingImports, projects, deps.rehomeFolders, platform)).flatMap((c) => (c.state === "create" ? [c.root] : []))
        : [];
      if (deps.dryRun) {
        const report = dryRunReport(runnable, heldItems, projects, providers, threadIds0, deps.batch ?? DEFAULT_BATCH, platform);
        const failUpFront = report.failUpFront.map(({ item, reason }) => failureOf(item, reason) as DryRunReport["failUpFront"][number]);
        await nameFailures(failUpFront, deps.failureTitles ?? 0);
        return { ...result, status: "dry-run", dryRun: { ...report, failUpFront, pendingRecovery, held: { roots: heldRootNames, sessions: heldItems.length }, pinDefault: pin?.homePath ?? null, foldersToCreate } };
      }
      if (deps.confirm && !(await deps.confirm(runnable, { roots: heldRootNames, sessions: heldItems.length }, { foldersToCreate }))) return { ...result, status: "declined" };
      if (abort) return { ...result, status: "aborted" };
      if (deps.beforeWrites) await deps.beforeWrites(runnable); // what this run does (held projects' sessions removed)

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
        let toConvert = pending.filter((i) => i.action.kind === "convert-import");
        // Orphan copies: T3's thread lists are read once more before anything is written for them (steps.ts).
        let orphanHeld = new Set<PlanItem>();
        if ([...toConvert, ...heldItems].some(isOrphanCopy) && !abort) ({ toConvert, orphanHeld } = await recheckOrphans(api, toConvert, heldItems, result, notice, tr));
        // Rehome destination folders, before any copy is written; a folder that cannot be used fails its items only.
        let heldProjects = heldItems.filter((i) => !orphanHeld.has(i)); // held items whose project is still created (empty)
        if (deps.rehomeFolders && !abort) {
          const blocked = await prepareRehomeFolders([...toConvert, ...heldProjects], projects, deps.rehomeFolders, journal, runId, platform, notice, tr);
          if (blocked.size > 0) {
            const why = (i: PlanItem): string | undefined => blocked.get(rootKey(itemRoot(i), platform));
            for (const i of toConvert) {
              const w = why(i);
              if (w === undefined) continue;
              const reason: ConvertFailReason = `target-folder: ${w}`;
              result.failed++;
              result.failures.push(failureOf(i, reason));
              await journal.append({ t: "import-failed", runId, harness: i.session.harness, nativeId: i.session.nativeId, reason });
            }
            toConvert = toConvert.filter((i) => why(i) === undefined);
            heldProjects = heldProjects.filter((i) => why(i) === undefined);
          }
        }
        if (toConvert.length > 0 && !abort) { // interrupted first: not attempted (like a wave never started)
          const m = await materializeConversions(toConvert, adapterMap(deps.adapters ?? allAdapters()), conversionAccounts(liveProviders, deps.accountHomes?.() ?? {}), journal, runId, { platform });
          result.converted = m.written.length;
          result.deferred += m.deferred.length; // source busy / session in use: next run, not a failure
          for (const { item, reason } of m.failed) {
            result.failed++;
            result.failures.push(failureOf(item, reason));
            await journal.append({ t: "import-failed", runId, harness: item.session.harness, nativeId: item.session.nativeId, reason: `convert: ${reason}` });
          }
          toImport.push(...m.ready); // the converted transcript is now the item's file
        }

        const projectOf = await ensureProjects(api, runnable, projects, [...toImport, ...heldProjects], journal, runId, platform);
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
          const planned = buildWaves(toImport, batch, cost, { platform });
          deps.onImportStart?.({ sessions: toImport.length, projects: new Set(toImport.map((i) => rootKey(itemRoot(i), platform))).size });
          waves = await runWaves({
            api, journal, runId, projectIds, importRoots, now, batch, cost, platform,
            instanceAvailability: providerAvail,
            exposure: exposureOf(exposedItems, liveProviders, platform), liveExposure: live,
            aborted: () => abort,
            onPendingFiles: (f) => { pendingFiles = f; },
            onProgress: (p) => { deps.onWave?.(p); deps.onProgress?.(progressLine(p)); },
            onNotice: notice,
          }, planned);
          result.imported = waves.imported.length;
          result.unverified = waves.unverified.length;
          result.failed += waves.failed.length;
          for (const f of waves.failed) result.failures.push(failureOf(f.item, f.reason));
          result.deferred += waves.deferred.length;
          result.deferredInUse += waves.deferred.filter((d) => d.reason === "project-in-use").length;
          for (const r of waves.heldRoots) if (!result.heldRoots.some((x) => rootKey(x, platform) === rootKey(r, platform))) result.heldRoots.push(r);
          for (const h of waves.heldActive) if (!result.held.some((x) => rootKey(x.root, platform) === rootKey(h.root, platform))) result.held.push(await heldEntry(projectName(h.root), h.root, h.file));
          result.restoreErrors = waves.restoreErrors;
          result.parked = waves.parked;
          const jumped = waves.deferred.filter((d) => d.reason === "clock-jump").length;
          if (jumped > 0) notice(tr("apply.notice.clockJump", { n: jumped }));
        }
        result.status = abort || waves?.aborted ? "aborted" : result.failed > 0 || result.unverified > 0 || result.restoreErrors.length > 0 ? "partial" : "ok";
        if (deps.afterApply && !abort) await deps.afterApply({ api, journal, plan, result, runId, aborted: () => abort, onPendingFiles: (f) => { pendingFiles = f; } });
      } catch (e) {
        await journal.append({ t: "run-end", runId, at: new Date(now()).toISOString(), status: "aborted" }).catch(() => {});
        throw e;
      }
      // How many projects waited (in use): read back after the fact, e.g. by the guided assistant (never from the plan).
      await journal.append({
        t: "run-end", runId, at: new Date(now()).toISOString(), status: result.status as "ok" | "partial" | "aborted",
        ...(result.heldRoots.length > 0 ? { held: result.heldRoots.length } : {}),
      });
      await nameFailures(result.failures, deps.failureTitles ?? 0);
      return result;
    } finally {
      await api.close();
    }
  } finally {
    for (const sig of STOP_SIGNALS) signals.off(sig, onSignal);
    await lock.release();
  }
}
