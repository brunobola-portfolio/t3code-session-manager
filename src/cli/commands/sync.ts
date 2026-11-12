import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../../core/types.ts";
import { stateDir } from "../../core/paths.ts";
import { defaultConfig, loadConfig } from "../../core/config.ts";
import { resolveAccounts } from "../../ops/discoverAccounts.ts";
import { atomicWrite } from "../../core/fsutil.ts";
import type { SignalSource } from "../../apply/apply.ts";
import type { T3Api } from "../../t3/api.ts";
import { allAdapters } from "../../sources/registry.ts";
import type { SourceAdapter } from "../../sources/types.ts";
import { appendSyncLog, logLine, overLimitLine, runSyncCycle, summaryLines, type CycleOutcome, type SyncCycleDeps } from "../../ops/sync.ts";
import { acquireWatcherSingleton, createDirWatch, readHeartbeat, realClock, startWatch, type Clock, type WatchFactory } from "../../ops/watch.ts";
import { describeError, oneLine } from "../errors.ts";
import { makeEnv } from "./scan.ts";
import { reportLockBusy } from "../locked.ts";
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
}

const FLAGS = new Set(["--quiet", "--allow-untested", "--watch", "--dry-run"]);

const processSignals: SignalSource = {
  on: (sig, fn) => void process.on(sig as NodeJS.Signals, fn),
  off: (sig, fn) => void process.off(sig as NodeJS.Signals, fn),
};

export async function syncCommand(args: string[], io: Io, deps: SyncCommandDeps = {}): Promise<number> {
  const bad = args.find((a) => !FLAGS.has(a));
  if (bad !== undefined) { io.stderr(`Unknown option: ${bad}. Run \`t3sm sync --help\`.\n`); return 2; }
  const quiet = args.includes("--quiet");
  const watch = args.includes("--watch");
  const dryRun = args.includes("--dry-run");
  if (watch && dryRun) { io.stderr("--watch and --dry-run cannot be combined. Run `t3sm sync --help`.\n"); return 2; }

  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const dir = stateDir(io.env, home);
  const signals = deps.signals ?? processSignals;
  const cycleDeps: SyncCycleDeps = {
    home, stateDir: dir, env: io.env, now, adapters: deps.adapters, connect: deps.connect, isT3Running: deps.isT3Running,
    existsDir: deps.existsDir, allowUntested: args.includes("--allow-untested"), signals, afterApply: deps.afterApply,
    onNotice: (l) => { if (!quiet) io.stderr(`${l}\n`); },
    onProgress: (l) => { if (!quiet && !watch) io.stdout(`${l}\n`); },
  };
  const log = async (o: CycleOutcome, at: number): Promise<void> => {
    try { await appendSyncLog(dir, logLine(o, at)); } catch { /* a log failure never fails the cycle */ }
  };

  if (!watch) {
    const o = await runSyncCycle({ ...cycleDeps, dryRun });
    if (!dryRun) await log(o, now());
    return report(o, io, quiet);
  }

  // ---------- --watch ----------
  // Single instance: an OS endpoint (named pipe / unix socket) released when the process ends, crash included. The
  // heartbeat only names the running watcher's pid for the message (and for `doctor`).
  await mkdir(dir, { recursive: true });
  const single = await acquireWatcherSingleton(dir);
  if (!single) {
    io.stdout(`A t3sm watcher is already running (pid ${(await readHeartbeat(dir))?.pid ?? "?"}).\n`);
    return 0;
  }
  try {
    let config: Config;
    let adapters: SourceAdapter[];
    try {
      config = (await loadConfig(dir, home)) ?? defaultConfig(await resolveAccounts(home, [], io.env));
      adapters = deps.adapters ?? allAdapters();
    } catch (e) {
      // Started by the scheduler with nobody watching: the log is where this shows up.
      try { await appendSyncLog(dir, `${new Date(now()).toISOString()} startup-error exit=${describeError(e).code} ${(e as Error)?.name ?? "Error"}`); } catch { /* ignore */ }
      throw e;
    }
    const env = makeEnv(io, home, config, now);
    let lastKey: string | null = null;
    const w = startWatch({
      clock: deps.clock ?? realClock,
      debounceMs: config.sync.watchDebounceMs,
      everyMinutes: config.schedule.everyMinutes,
      pid: process.pid,
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
      writeHeartbeat: (h) => atomicWrite(join(dir, "sync-status.json"), JSON.stringify(h, null, 2) + "\n"),
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
    if (!quiet) io.stdout("Watching for new sessions. Press Ctrl+C to stop.\n");
    await w.done;
  } finally {
    await single.release();
  }
  return 0;
}

function report(o: CycleOutcome, io: Io, quiet: boolean): number {
  if (o.kind === "t3-down") {
    if (!quiet) io.stderr("T3 Code is not running. Open it from the Start menu and try again.\n");
    return 3;
  }
  if (o.kind === "locked") {
    reportLockBusy(io, quiet);
    return 0;
  }
  if (o.kind === "over-limit") {
    io.stdout(`${overLimitLine(o.pending)}\n`); // even under --quiet: the scheduler log shows it
    return 0;
  }
  if (o.kind === "error") {
    const { message } = describeError(o.error);
    io.stderr(`${quiet ? oneLine(message) : message}\n`);
    return o.exitCode;
  }
  if (!quiet) for (const l of summaryLines(o)) io.stdout(`${l}\n`);
  if (o.kind === "aborted") {
    io.stderr("Interrupted: file times restored. The next sync continues.\n");
    return 130;
  }
  if (o.kind === "partial") {
    const c = o.counts;
    io.stderr(`sync: ${c.failed} failed, ${c.unverified} unverified in run ${o.runId ?? "-"}; see \`t3sm runs\`.\n`);
    return 5;
  }
  return 0;
}
