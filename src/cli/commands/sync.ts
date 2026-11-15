import { homedir } from "node:os";
import { mkdir, readFile } from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import { join } from "node:path";
import type { Config } from "../../core/types.ts";
import { stateDir } from "../../core/paths.ts";
import { defaultConfig, loadConfig } from "../../core/config.ts";
import { resolveAccounts } from "../../ops/discoverAccounts.ts";
import type { SignalSource } from "../../apply/apply.ts";
import type { T3Api } from "../../t3/api.ts";
import { allAdapters } from "../../sources/registry.ts";
import type { SourceAdapter } from "../../sources/types.ts";
import { appendSyncLog, detailLines, logLine, overLimitLine, runSyncCycle, summaryLines, type CycleOutcome, type SyncCycleDeps } from "../../ops/sync.ts";
import { T3NotRunning } from "../../t3/errors.ts";
import { importProgress, resultPanel, waitingLines } from "../applyScreen.ts";
import { FAILURES_SHOWN, failureTable } from "../failures.ts";
import { fitLine, flowAtoms, richAtoms } from "../screen.ts";
import { cliUi, type CliUi, unknownOption, usageLine } from "../ui.ts";
import { UPDATE_INTERRUPTED_REASON, notifyOnce, systemNotifier, updateNotice, type Notifier } from "../../ops/notify.ts";
import { resolveLang, type Lang } from "../../assistant/i18n.ts";
import { defaultRunner } from "../../t3/auth.ts";
import { writeHeartbeatMerged } from "../../ops/syncStatus.ts";
import { UnsafeSocketDirError, acquireWatcherSingleton, createDirWatch, readHeartbeat, realClock, startWatch, withStopRequest, type Clock, type WatchFactory } from "../../ops/watch.ts";
import { LAUNCHD_LABEL, defaultBinPath, detectConhost } from "../../ops/schedule.ts";
import { spawnSuccessor, type SpawnLike } from "../../ops/successor.ts";
import { installReady, installRoot, installStamp, packageVersion, type InstallStamp } from "../../core/version.ts";
import { Journal } from "../../core/journal.ts";
import { acquireLock } from "../../core/lock.ts";
import { readPendingUpdate, recoverInterruptedUpdate } from "../../ops/updater.ts";
import { recordUpdateOutcome } from "../../ops/syncStatus.ts";
import { watcherUpdateCheck } from "../../ops/autoUpdate.ts";
import { describeError, oneLine, renderError } from "../errors.ts";
import { makeEnv } from "./scan.ts";
import { reportLockBusy } from "../locked.ts";
import { FLAG_SPECS } from "../flags.ts";
import type { Io } from "../main.ts";

export interface SyncCommandDeps {
  home?: string;
  now?: () => number;
  connect?: (home: string, opts: { allowUntested: boolean; manageProviders: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;
  isT3Running?: (home: string) => Promise<boolean>;
  adapters?: SourceAdapter[];
  existsDir?: (p: string) => Promise<boolean>;
  signals?: SignalSource;
  clock?: Clock;
  watchFactory?: WatchFactory;
  afterApply?: SyncCycleDeps["afterApply"];
  /** Tests inject one; otherwise the real OS notifier is used only when `home` is the real one (a test home never notifies). */
  notifier?: Notifier;
  /** --watch: what this install root holds now (default installStamp(installRoot())); read at start and after every cycle. */
  installStamp?: () => InstallStamp;
  /** --watch: the single-instance endpoint (default acquireWatcherSingleton). */
  singleton?: typeof acquireWatcherSingleton;
  /** --watch: starts the successor after a restart (default child_process.spawn). */
  spawn?: SpawnLike;
  /** --watch on win32: conhost.exe with --headless, or null (default detected). */
  conhost?: string | null;
  /** --watch: whether the new install is complete and settled (default installReady(installRoot(), now())). */
  installReady?: () => boolean;
  /** --watch: the platform deciding how to restart (default process.platform; the singleton always uses the real one). */
  platform?: NodeJS.Platform;
  /**
   * --watch: the daily update check, run after every cycle that does not restart the watcher (default: the real one,
   * src/ops/autoUpdate.ts, only when `home` is the real one: a test home never looks anything up).
   */
  updateCheck?: (stopped?: () => boolean) => Promise<unknown>;
}

/** Exit code of a watcher that restarted on macOS: non-zero so launchd's KeepAlive relaunches the new install (EX_TEMPFAIL). */
export const RESTART_EXIT_LAUNCHD = 75;

export { spawnSuccessor, type SpawnLike, type SuccessorOptions } from "../../ops/successor.ts";

const FLAGS = new Set<string>(FLAG_SPECS.sync.bool);

const processSignals: SignalSource = {
  on: (sig, fn) => void process.on(sig as NodeJS.Signals, fn),
  off: (sig, fn) => void process.off(sig as NodeJS.Signals, fn),
};

export async function syncCommand(args: string[], io: Io, deps: SyncCommandDeps = {}): Promise<number> {
  const bad = args.find((a) => !FLAGS.has(a));
  if (bad !== undefined) { unknownOption(io, bad, "sync"); return 2; }
  const quiet = args.includes("--quiet");
  const watch = args.includes("--watch");
  const dryRun = args.includes("--dry-run");
  if (watch && dryRun) { usageLine(io, "usage.watchDryRun"); return 2; }

  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const dir = stateDir(io.env, home);
  // --watch: a stop request over the endpoint reaches the running cycle like SIGTERM (withStopRequest).
  const stopper = watch ? withStopRequest(deps.signals ?? processSignals) : null;
  const signals = stopper ?? deps.signals ?? processSignals;
  const ui = cliUi(io, { now });
  // One progress bar for a cycle's import; nothing at all with --quiet or --watch (the watcher prints its log lines).
  const bar = importProgress(io, ui, now, { silent: quiet || watch, verbose: args.includes("--verbose") });
  const cycleDeps: SyncCycleDeps = {
    home, stateDir: dir, env: io.env, lang: io.langFlag, now, adapters: deps.adapters, connect: deps.connect, isT3Running: deps.isT3Running,
    existsDir: deps.existsDir, allowUntested: args.includes("--allow-untested"), signals, afterApply: deps.afterApply,
    notifier: deps.notifier ?? (deps.home === undefined ? systemNotifier(process.platform, defaultRunner) : undefined),
    onNotice: (l) => { if (!quiet && !bar.note(l)) io.stderr(`${l}\n`); },
    onProgress: (l) => bar.onProgress(l),
    onImportStart: (n) => bar.onImportStart(n),
    onWave: (p) => bar.onWave(p),
    // Titles are read only for the failures the screen shows: never in a quiet or watcher cycle.
    failureTitles: quiet || watch ? 0 : FAILURES_SHOWN,
  };
  const log = async (o: CycleOutcome, at: number): Promise<void> => {
    try { await appendSyncLog(dir, logLine(o, at)); } catch { /* a log failure never fails the cycle */ }
  };

  if (!watch) {
    let o: CycleOutcome;
    try {
      o = await runSyncCycle({ ...cycleDeps, dryRun });
      bar.end();
    } finally {
      bar.dispose();
    }
    if (!dryRun) await log(o, now());
    return report(o, io, quiet, ui, now());
  }

  // ---------- --watch ----------
  // Single instance: an OS endpoint (named pipe / unix socket) released when the process ends, crash included. The
  // heartbeat only names the running watcher's pid for the message (and for `doctor`).
  await mkdir(dir, { recursive: true });
  // A stop request over the endpoint stops the running cycle after its current step (as Ctrl+C does) and then the loop
  // (it may arrive before startWatch returns).
  let stopLoop: (() => void) | null = null;
  let stopAsked = false;
  let single: Awaited<ReturnType<typeof acquireWatcherSingleton>>;
  try {
    single = await (deps.singleton ?? acquireWatcherSingleton)(dir, process.platform, undefined, () => { stopAsked = true; stopper?.fire(); stopLoop?.(); });
  } catch (e) {
    if (!(e instanceof UnsafeSocketDirError)) throw e;
    // Exit 0 on purpose: a non-zero exit would make launchd's KeepAlive restart the watcher every minute, forever.
    // The reason is logged once (not on every keep-alive run) and shown to anyone watching.
    await logOnce(dir, `socket-dir-unsafe ${e.dir}`, now);
    if (!quiet) io.stderr(`t3sm: ${e.message}\n`);
    return 0;
  }
  if (!single) {
    // --quiet: the keep-alive run (cron every 15 min, Task Scheduler) must stay silent (no cron mail).
    if (!quiet) io.stdout(`A t3sm watcher is already running (pid ${(await readHeartbeat(dir))?.pid ?? "?"}).\n`);
    return 0;
  }
  let released = false;
  let exitCode = 0;
  const platform = deps.platform ?? process.platform;
  const release = async (): Promise<void> => { if (released) return; released = true; await single.release(); };
  try {
    let config: Config;
    let adapters: SourceAdapter[];
    try {
      config = (await loadConfig(dir, home)) ?? defaultConfig(await resolveAccounts(home, [], io.env));
      adapters = deps.adapters ?? allAdapters();
    } catch (e) {
      // Started by the scheduler with nobody watching: the log is where this shows up (once per streak: the keep-alive
      // retries every 15 minutes; `t3sm status` reads the line as "the background watcher cannot start").
      await logOnce(dir, `startup-error exit=${describeError(e).code} ${(e as Error)?.name ?? "Error"}`, now);
      throw e;
    }
    const env = makeEnv(io, home, config, now);
    let lastKey: string | null = null;
    // The install this watcher runs: compared after every cycle, a newer one restarts the watcher into it.
    const root = installRoot();
    const readStamp = deps.installStamp ?? (() => installStamp(root));
    let own: InstallStamp | null = null;
    try { own = readStamp(); } catch (e) {
      try { await appendSyncLog(dir, `${new Date(now()).toISOString()} version-unknown ${(e as Error)?.name ?? "Error"}`); } catch { /* ignore */ }
    }
    // An update interrupted earlier (t3sm killed mid-install, power loss) is journaled now, even when no newer release
    // ever comes; under the lock, so an update that is running right now (it holds the lock) is never mistaken for one.
    await recoverUpdateAtStart(dir, home, now, cycleDeps.notifier, io.env, io.langFlag);
    const updateCheck = deps.updateCheck ?? (deps.home === undefined
      ? watcherUpdateCheck({ stateDir: dir, home, env: io.env, platform, now, notifier: cycleDeps.notifier }) : undefined);
    const w = startWatch({
      clock: deps.clock ?? realClock,
      debounceMs: config.sync.watchDebounceMs,
      everyMinutes: config.schedule.everyMinutes,
      pid: process.pid,
      ...(process.platform !== "win32" && single.addr !== undefined ? { socket: single.addr } : {}),
      signals,
      dirs: async () => {
        const out: string[] = [];
        for (const a of adapters) {
          if (a.watchRoots && (await a.isAvailable(env).catch(() => false))) out.push(...(await a.watchRoots(env).catch(() => [])));
        }
        return [...new Set(out)];
      },
      watch: deps.watchFactory ?? ((d, cb) => createDirWatch(d, cb)),
      cycle: () => runSyncCycle(cycleDeps),
      writeHeartbeat: (h) => writeHeartbeatMerged(dir, h), // keeps what the cycles recorded (needsAttention, undecided, ...)
      install: own ? { root, stamp: own, read: readStamp, ready: deps.installReady ?? (() => installReady(root, now())) } : undefined,
      version: packageVersion(),
      onStampError: (e) => void appendSyncLog(dir, `${new Date(now()).toISOString()} version-unknown ${(e as Error)?.name ?? "Error"}`).catch(() => {}),
      ...(updateCheck ? { afterCycle: async (stopped) => { await updateCheck(stopped); } } : {}),
      restart: async (next) => {
        try { await appendSyncLog(dir, `${new Date(now()).toISOString()} restart from=${own?.version ?? "?"} to=${next.version}`); } catch { /* ignore */ }
        if (!quiet) io.stdout(`t3sm ${next.version} is installed: restarting the watcher into it.\n`);
        await release(); // first: the successor must find the pipe free
        // macOS under launchd (KeepAlive after a failed exit): a detached successor would run outside its job and nobody
        // would bring back one that dies; a non-zero exit makes launchd start the newly installed bin itself.
        // Only under launchd: a watcher started by hand on macOS has no KeepAlive behind it, so it spawns its successor.
        if (platform === "darwin" && io.env["XPC_SERVICE_NAME"] === LAUNCHD_LABEL) { exitCode = RESTART_EXIT_LAUNCHD; return; }
        spawnSuccessor({
          platform, nodePath: process.execPath, binPath: defaultBinPath(), spawn: deps.spawn ?? (nodeSpawn as unknown as SpawnLike),
          conhost: deps.conhost !== undefined ? deps.conhost : platform === "win32" ? detectConhost() : null,
        });
      },
      onCycle: async (o, at) => {
        // T3 closed for hours = one line, not one per minute; the over-limit line again only when the count changes.
        const key = o.kind === "t3-down" || o.kind === "locked" ? o.kind : o.kind === "over-limit" ? `over-limit:${o.pending}` : null;
        const repeat = key !== null && key === lastKey;
        lastKey = key;
        if (repeat) return;
        await log(o, at);
        if (o.kind === "over-limit") io.stdout(`${overLimitLine(o.pending)}\n`);
        else if (!quiet) io.stdout(`${logLine(o, at)}\n`);
      },
    });
    stopLoop = w.stop;
    if (stopAsked) w.stop();
    if (!quiet) io.stdout(`${ui.t("sync.watching")}\n`);
    await w.done;
  } finally {
    await release();
  }
  return exitCode; // 0, or RESTART_EXIT_LAUNCHD after a restart on macOS
}

/**
 * Appends `what` to sync.log with the time, unless the log's last line already says exactly that: a watcher that
 * stops at start-up is retried by the keep-alive every 15 minutes, and one line per streak is enough. Never throws.
 */
async function logOnce(dir: string, what: string, now: () => number): Promise<void> {
  try {
    const last = (await readFile(join(dir, "logs", "sync.log"), "utf8").catch(() => "")).trimEnd().split(/\r?\n/).pop() ?? "";
    if (!last.endsWith(` ${what}`)) await appendSyncLog(dir, `${new Date(now()).toISOString()} ${what}`);
  } catch { /* ignore */ }
}

/**
 * recoverInterruptedUpdate under the lock (busy: an update or a cycle runs; the next start looks again). A newly found
 * interruption needs attention (update-failed) and is notified once per version. Never throws.
 */
async function recoverUpdateAtStart(dir: string, home: string, now: () => number, notifier: Notifier | undefined, env: NodeJS.ProcessEnv, lang: Lang | undefined): Promise<void> {
  try {
    const lock = await acquireLock(dir);
    if (!lock) return;
    let found: { from: string; to: string } | null = null;
    try {
      const seen = (await readPendingUpdate(dir))?.interrupted === true; // reported at an earlier start already
      const p = await recoverInterruptedUpdate(dir, new Journal(join(dir, "journal.jsonl")));
      if (p !== null && !seen) {
        found = { from: p.previous.version, to: p.target };
        await recordUpdateOutcome(dir, { outcome: "interrupted", ...found }, new Date(now()));
      }
    } finally {
      await lock.release();
    }
    if (found !== null && notifier) {
      const config = await loadConfig(dir, home).catch(() => null);
      const n = updateNotice("interrupted", found, lang ?? resolveLang(null, env, config?.language ?? null));
      await notifyOnce({
        stateDir: dir, mode: config?.notify ?? "attention", notifier, now: now(), key: `${UPDATE_INTERRUPTED_REASON}:${found.to}`, title: n.title, body: n.body,
      });
    }
  } catch { /* the journal or status file cannot be written: reported by doctor; never stops the watcher */ }
}

/**
 * A cycle's result on screen, in the user's language: "nothing to import" as one line, a dry run as its lines, an
 * import as the result panel; then why held projects wait (each once), the other things the cycle did, and the
 * failures as a table. Commands are shown whole and without backticks.
 */
export function renderSyncResult(ui: CliUi, o: CycleOutcome, now: number, width: number = ui.width): string[] {
  const { s } = ui;
  const w = Math.max(1, width);
  const opts = { lang: ui.lang, dash: s.caps.unicode ? "—" : "-" };
  const line = (lead: string, text: string): string[] => flowAtoms([...(lead ? [lead] : []), ...richAtoms(s, text.trim())], w, 2);
  if (o.kind === "t3-down" || o.kind === "locked" || o.kind === "error") return [];
  if (o.kind === "over-limit") return line("", overLimitLine(o.pending, ui.lang));
  if (o.kind === "dry-run") return summaryLines(o, now, opts).flatMap((l, i) => line(i === 0 ? "" : s("warn", s.sym.warn), l));
  const held = o.held ?? [];
  // The held projects are said once: named under the panel (or counted in it), never again as a detail line.
  const shownHeld = o.kind !== "noop" || held.length > 0;
  const details = detailLines({ ...o, held: [], counts: shownHeld ? { ...o.counts, heldInUse: 0 } : o.counts }, now, opts);
  const out: string[] = [];
  if (o.kind === "noop") out.push(...fitLine(`${s("ok", s.sym.ok)} ${ui.t("sync.nothing")}`, w, 2));
  else {
    const c = o.counts;
    out.push(...resultPanel(ui, {
      status: o.kind === "aborted" ? "aborted" : o.kind === "partial" ? "partial" : "ok",
      imported: c.imported, failed: c.failed, converted: 0, unverified: c.unverified, alreadyInT3: 0,
      deferred: c.deferred - c.heldInUse, held: c.heldInUse, heldNamed: held.length > 0, runId: o.runId,
    }, w));
  }
  const waiting = waitingLines(ui, held, w);
  if (waiting.length > 0 || details.length > 0) out.push("", ...waiting, ...details.flatMap((d) => line(s("accent", s.sym.sep), d)));
  if (o.failures && o.failures.length > 0) out.push("", ...failureTable(ui, o.failures, w));
  return out;
}

function report(o: CycleOutcome, io: Io, quiet: boolean, ui: CliUi, now: number): number {
  if (o.kind === "t3-down") {
    if (!quiet) io.stderr(renderError(new T3NotRunning(), ui).join("\n") + "\n");
    return 3;
  }
  if (o.kind === "locked") {
    reportLockBusy(io, quiet);
    return 0;
  }
  if (o.kind === "over-limit") {
    io.stdout(`${overLimitLine(o.pending, ui.lang)}\n`); // even under --quiet: the scheduler log shows it
    return 0;
  }
  if (o.kind === "error") {
    io.stderr(quiet ? `${oneLine(describeError(o.error).message)}\n` : renderError(o.error, ui).join("\n") + "\n");
    return o.exitCode;
  }
  if (!quiet) io.stdout(renderSyncResult(ui, o, now).join("\n") + "\n");
  if (o.kind === "aborted") {
    io.stderr(`${ui.t("sync.interrupted")}\n`);
    return 130;
  }
  if (o.kind === "partial") {
    const c = o.counts;
    io.stderr(`${ui.t("sync.partial", { failed: c.failed, unverified: c.unverified, runId: o.runId ?? "-" })}\n`);
    return 5;
  }
  return 0;
}
