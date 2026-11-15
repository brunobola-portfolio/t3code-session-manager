import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "../../core/paths.ts";
import { ConfigError, DEFAULT_SCHEDULE_MINUTES, loadConfig } from "../../core/config.ts";
import {
  ScheduleError, defaultBinPath, installSchedule, realRunner, removeSchedule, scheduleSpec, scheduleStatus, type CommandRunner, type ScheduleFs, type ScheduleSpec,
} from "../../ops/schedule.ts";
import { pidAlive, readHeartbeat, realClock } from "../../ops/watch.ts";
import { markGoneWatcher, stopWatcher as realStopWatcher, type StopResult } from "../../ops/watcherControl.ts";
import { acquireLock, type Lock } from "../../core/lock.ts";
import { reportLockBusy } from "../locked.ts";
import { spawn as nodeSpawn } from "node:child_process";
import { detectConhost } from "../../ops/schedule.ts";
import { cliUi, confirm, isCliKey, type CliKey, type CliUi } from "../ui.ts";
import { FLAG_SPECS } from "../flags.ts";
import { callout, kv } from "../../ui/components.ts";
import { noteLines, textLines } from "../screen.ts";
import { shownText } from "../../plan/names.ts";
import { spawnSuccessor, type SpawnLike } from "../../ops/successor.ts";
import { realIsElevated, warnIfElevated } from "../../ops/elevated.ts";
import type { Io } from "../main.ts";
import { systemRoot } from "../../core/sysroot.ts";

export interface ScheduleCommandDeps {
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  nodePath?: string;
  binPath?: string;
  /** win32: conhost.exe for a hidden window (undefined = detect). */
  conhost?: string | null;
  isAlive?: (pid: number) => boolean;
  /** Where install and remove write the task XML or plist (default: the real file system). */
  fs?: ScheduleFs;
  /** Stops the background watcher (default: ops/watcherControl stopWatcher against the real endpoint); `restart`: a new one follows. */
  stopWatcher?: (o?: { restart?: boolean }) => Promise<StopResult>;
  /** The state lock install --watch, remove and restart hold around the stop (default acquireLock). */
  lock?: (dir: string) => Promise<Lock | null>;
  /** The detached spawn that starts a watcher where the scheduler cannot (cron); default child_process.spawn. */
  spawn?: SpawnLike;
  /** Whether this shell runs as Administrator (default: `net session` on Windows, only for the real home). */
  elevated?: () => Promise<boolean>;
}

/** What the scheduler entry runs, in words ("t3sm sync --quiet every 15 min while you are logged on, ..."). */
function describe(ui: CliUi, spec: ScheduleSpec, every: number): string {
  const what = spec.watch ? "t3sm sync --watch --quiet" : "t3sm sync --quiet";
  const key: CliKey = spec.kind === "schtasks" ? (spec.watch ? "schedule.desc.schtasksWatch" : "schedule.desc.schtasks")
    : spec.kind === "launchd" ? (spec.watch ? "schedule.desc.launchdWatch" : "schedule.desc.launchd")
    : spec.watch ? "schedule.desc.cronWatch" : "schedule.desc.cron";
  return ui.t(key, { what, every });
}

/** What `t3sm schedule status` found, as aligned rows (and a warning when the entry points at paths that are gone). */
export interface ScheduleStatusView {
  kind: string; installed: boolean; nextRun: string | null; detail: string | null; command: string | null | undefined; missing: string[]; watch: boolean;
  watcher: { running: boolean; pid: number; lastCycleAt: string | null; outcome: string | null; nextCycleAt: string | null } | null;
  lastLogged: string | null;
}

/** The scheduler's own state for a healthy entry (schtasks "Ready"/"Running", launchd "running"): not worth a word. */
const NORMAL_STATE = /^(ready|running|waiting)$/i;
/** A scheduler field that says nothing (schtasks "N/A"). */
const EMPTY_FIELD = /^(n\/a|-|)$/i;

/** A cycle's outcome (the heartbeat's, a sync.log line's) in words; an unknown one as it is. */
function outcomeWord(ui: CliUi, kind: string): string {
  const k = `schedule.st.outcome.${kind.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())}`;
  return isCliKey(k) ? ui.t(k) : shownText(kind, 40);
}

/**
 * A sync.log line that is not a cycle (the watcher's restart, an update, the daily check, a start-up stop) in words,
 * or null for a cycle line. The versions and the error's name come from t3sm's own log, shown sanitized.
 */
function eventWords(ui: CliUi, kind: string, rest: string): string | null {
  const field = (name: string): string => shownText(new RegExp(`\\b${name}=(\\S+)`).exec(rest)?.[1] ?? "?", 40);
  const sub = /^\s*(\S+)/.exec(rest)?.[1] ?? "";
  if (kind === "restart") return ui.t("schedule.st.event.restart", { to: field("to") });
  if (kind === "update") {
    const k = ({ installed: "schedule.st.event.updateInstalled", "rolled-back": "schedule.st.event.updateRolledBack", failed: "schedule.st.event.updateFailed", busy: "schedule.st.event.updateBusy" } as const)[sub];
    return k ? ui.t(k, { to: field("to"), from: field("from") }) : null;
  }
  if (kind === "update-check") {
    const k = ({ unavailable: "schedule.st.event.checkUnavailable", available: "schedule.st.event.checkAvailable", start: "schedule.st.event.checkStart" } as const)[sub];
    return k ? ui.t(k, { to: field("to") }) : null;
  }
  if (kind === "version-unknown") return ui.t("schedule.st.event.versionUnknown");
  if (kind === "startup-error") {
    const name = /^\s*exit=\S+\s+(\S+)/.exec(rest)?.[1];
    return ui.t("schedule.st.event.startupError", { name: name ? ` (${shownText(name, 40)})` : "" });
  }
  if (kind === "socket-dir-unsafe") return ui.t("schedule.st.event.socketDirUnsafe");
  return null;
}

/** The last sync.log line in words: when, how it ended, how many it imported and its run; an unknown line as it is. */
export function loggedLine(ui: CliUi, line: string): string {
  const m = /^(\S+)\s+(\S+)(.*)$/.exec(line.trim());
  if (!m || Number.isNaN(Date.parse(m[1]!))) return shownText(line, 400);
  const at = m[1]!;
  const event = eventWords(ui, m[2]!, m[3]!);
  if (event !== null) return ui.t("schedule.st.loggedLine", { at: ui.f.date(at), ago: ui.f.ago(at), outcome: event });
  const imported = /\bimported=(\d+)/.exec(m[3]!)?.[1];
  const run = /\brun=(\S+)/.exec(m[3]!)?.[1];
  const parts = [ui.t("schedule.st.loggedLine", { at: ui.f.date(at), ago: ui.f.ago(at), outcome: outcomeWord(ui, m[2]!) })];
  if (imported !== undefined && Number(imported) > 0) parts.push(ui.t("schedule.st.loggedImported", { n: Number(imported) }));
  if (run !== undefined && run !== "-") parts.push(ui.t("schedule.st.loggedRun", { runId: shownText(run, 60) }));
  return parts.join(", ");
}

export function renderScheduleStatus(ui: CliUi, v: ScheduleStatusView, width: number = ui.width): string[] {
  const { s, t } = ui;
  const next = v.nextRun !== null && !EMPTY_FIELD.test(v.nextRun.trim()) ? v.nextRun : null;
  const state = v.detail !== null && v.kind !== "cron" && !NORMAL_STATE.test(v.detail.trim()) && !EMPTY_FIELD.test(v.detail.trim()) ? v.detail : null;
  const entry = !v.installed ? t("schedule.st.notInstalled")
    : [t("schedule.st.installed", { kind: v.kind }), ...(next ? [t("schedule.st.next", { next: shownText(next, 60) })] : []), ...(state ? [t("schedule.st.state", { state: shownText(state, 60) })] : [])].join(", ");
  const rows: [string, string][] = [[t("schedule.st.entry"), entry]];
  if (v.installed && v.kind === "cron" && v.detail) rows.push(["", v.detail]);
  if (v.installed) rows.push([t("schedule.st.command"), v.command ? shownText(v.command, 400) : t("schedule.st.unreadable")]);
  const w = v.watcher;
  const last = w === null ? "" : w.lastCycleAt ? t("schedule.st.lastCycle", { at: ui.f.date(w.lastCycleAt), outcome: w.outcome ? ` (${outcomeWord(ui, w.outcome)})` : "" }) : t("schedule.st.noCycle");
  rows.push([t("schedule.st.watcher"), w === null ? t("schedule.st.noWatcher")
    : w.running ? t("schedule.st.running", { pid: w.pid, last, next: w.nextCycleAt ? ui.f.date(w.nextCycleAt) : "-" }) : t("schedule.st.notRunning", { last })]);
  if (v.lastLogged) rows.push([t("schedule.st.logged"), loggedLine(ui, v.lastLogged)]);
  const out = kv(s, rows, width);
  if (v.installed && v.missing.length > 0) {
    out.push("", ...callout(s, { kind: "warn", title: t("schedule.st.missingTitle"), body: textLines(s, t("schedule.st.missing", { paths: v.missing.map((m) => shownText(m, 300)).join(", "), n: v.missing.length }), Math.max(1, width - 2)), command: `t3sm schedule install${v.watch ? " --watch" : ""}` }, width));
  }
  return out;
}

export async function scheduleCommand(args: string[], io: Io, deps: ScheduleCommandDeps = {}): Promise<number> {
  const [sub, ...rest] = args;
  const ui = cliUi(io);
  const say = (l: string[]): void => io.stdout(l.join("\n") + "\n");
  const note = (tone: "ok" | "warn" | "err" | "info", text: string): string[] => noteLines(ui.s, tone, text, ui.width);
  const okFlags: string[] = sub === "install" ? [...FLAG_SPECS.schedule.bool] : sub === "remove" || sub === "restart" ? ["--dry-run", "--yes"] : [];
  if ((sub !== "install" && sub !== "remove" && sub !== "restart" && sub !== "status") || rest.some((a) => !okFlags.includes(a))) {
    io.stderr(`${ui.t("schedule.usage")}\n`);
    return 2;
  }
  const dryRun = rest.includes("--dry-run");
  if (dryRun && rest.includes("--yes")) { io.stderr(`${ui.t("common.eitherDryRunOrYes")}\n`); return 2; }
  // Before any question: what this installs belongs to the user running it.
  await warnIfElevated(io, deps.elevated ?? (deps.home === undefined ? realIsElevated : async () => false), "schedule");
  if (sub !== "status" && !dryRun && !rest.includes("--yes")) {
    if (!io.isTTY) { io.stderr(`${ui.t("schedule.needsYes")}\n`); return 2; }
    const what = sub === "install" ? (rest.includes("--watch") ? "schedule.confirmInstallWatch" : "schedule.confirmInstall") : sub === "remove" ? "schedule.confirmRemove" : "schedule.confirmRestart";
    if (!(await confirm(io, ui.t(what)))) { io.stdout(`${ui.t("common.nothingChanged")}\n`); return 0; }
  }
  const home = deps.home ?? homedir();
  const dir = stateDir(io.env, home);
  const run = deps.runner ?? realRunner;
  const platform = deps.platform ?? process.platform;
  const every = (await loadConfig(dir, home))?.schedule.everyMinutes ?? DEFAULT_SCHEDULE_MINUTES;
  const stop = deps.stopWatcher ?? ((o?: { restart?: boolean }) => realStopWatcher({
    stateDir: dir, platform, kill: (pid) => process.kill(pid), clock: realClock, ...(o?.restart ? { intent: "restart" as const } : {}),
  }));
  const alive = deps.isAlive ?? pidAlive;
  /**
   * Runs `fn` under the state lock, as `t3sm update` does: while a run holds it (the watcher's cycle in the middle of an
   * import, say), nothing is stopped and nothing changes (the busy line, exit 0 like every writing command), so a stop
   * never ends in a hard kill of a watcher that is writing.
   */
  const locked = async (fn: () => Promise<number>): Promise<number> => {
    const lock = await (deps.lock ?? acquireLock)(dir);
    if (!lock) { reportLockBusy(io); return 0; }
    try { return await fn(); } finally { await lock.release(); }
  };
  const nodePath = deps.nodePath ?? process.execPath;
  const binPath = deps.binPath ?? defaultBinPath();
  const stillRunning = (r: StopResult): string => ui.t(r.pid !== null ? "schedule.stillRunningPid" : "schedule.stillRunning", { pid: r.pid ?? 0 });
  const started = (r: StopResult): string => (r.how === "none" ? ui.t("schedule.startedNew") : ui.t(r.pid !== null ? "schedule.restartedPid" : "schedule.restarted", { pid: r.pid ?? 0 }));
  /** The detached watcher (`sync --watch --quiet`), started outside the scheduler. */
  const successor = (): void => spawnSuccessor({
    platform, nodePath, binPath, spawn: deps.spawn ?? (nodeSpawn as unknown as SpawnLike),
    conhost: deps.conhost !== undefined ? deps.conhost : platform === "win32" ? detectConhost() : null,
  });
  /**
   * Starts the scheduled watcher now: schtasks /Run, launchd bootstrap (after a bootout) or, for cron, the detached spawn.
   * win32: the detached spawn follows /Run as well. Task Scheduler may still count the stopped watcher's task instance as
   * running and drop /Run (IgnoreNew, still exit 0); whichever of the two starts second finds the pipe taken and exits 0.
   */
  const startWatcher = async (spec: ScheduleSpec): Promise<void> => {
    if (spec.kind === "cron") { successor(); return; }
    if (spec.kind === "launchd") for (const c of spec.remove) await run(c[0]!, c.slice(1));
    const c = spec.kind === "launchd" ? spec.install[0]! : spec.install[1]!;
    const r = await run(c[0]!, c.slice(1));
    if (spec.kind === "schtasks") { successor(); return; }
    if (r.code !== 0) throw new ScheduleError(`Could not start the watcher: ${c.join(" ")} failed${r.stderr.trim() ? ` (${r.stderr.trim()})` : ""}.`);
  };
  try {
    const spec = scheduleSpec(platform, nodePath, binPath, every, {
      watch: rest.includes("--watch") || sub === "restart", home, uid: deps.uid, conhost: deps.conhost, stateDir: dir,
      systemRoot: systemRoot(io.env),
    });
    if (sub === "install") {
      if (dryRun) {
        say([...note("info", ui.t(spec.watch ? "schedule.wouldInstallWatch" : "schedule.wouldInstall", { kind: spec.kind, desc: describe(ui, spec, every) })), ...note("ok", ui.t("common.nothingChanged"))]);
        return 0;
      }
      const done = (r: StopResult | null, extra: string[]): number => {
        const out = note("ok", ui.t("schedule.installed", { kind: spec.kind, desc: describe(ui, spec, every) }));
        if (r !== null) out.push(...note("ok", started(r)));
        out.push(...textLines(ui.s, ui.t("schedule.logs", { log: join(dir, "logs", "sync.log") }), ui.width, 2), ...extra);
        say(out);
        return 0;
      };
      if (!spec.watch) {
        await installSchedule(spec, run, deps.fs);
        const hb = await readHeartbeat(dir);
        if (hb && !hb.stoppedAt && alive(hb.pid)) return done(null, note("warn", ui.t("schedule.watcherStillRuns", { pid: hb.pid })));
        // A watcher that crashed (pid gone, no clean stop) is not coming back with an interval job: its heartbeat says so.
        await markGoneWatcher(dir, { pidAlive: alive, now: Date.now() }).catch(() => false);
        return done(null, []);
      }
      return locked(async () => {
        const r = await stop({ restart: true });
        if (r.running) { io.stderr(`${stillRunning(r)} ${ui.t("common.nothingChanged")}\n`); return 1; }
        await installSchedule(spec, run, deps.fs); // win32: /Create, then /Run
        if (spec.kind === "cron") await startWatcher(spec); // cron @reboot would wait for a reboot
        else if (spec.kind === "schtasks") successor(); // /Run may have been dropped (see startWatcher)
        return done(r, []);
      });
    }
    if (sub === "remove") {
      if (dryRun) {
        say([...note("info", ui.t("schedule.wouldRemove")), ...note("ok", ui.t("common.nothingChanged"))]);
        return 0;
      }
      return locked(async () => {
        // The entry goes first: a keep-alive trigger firing between the stop and the removal would start a watcher
        // that outlives the removal.
        const gone = await removeSchedule(spec, run, deps.fs);
        const r = await stop();
        if (r.running) {
          io.stderr(`${ui.t(gone.removed ? "schedule.removed" : "schedule.notInstalledRemove")} ${stillRunning(r)}\n`);
          return 1;
        }
        say([
          ...(r.how === "none" ? [] : note("ok", ui.t(r.pid !== null ? "schedule.stoppedPid" : "schedule.stopped", { pid: r.pid ?? 0 }))),
          ...note("ok", ui.t(gone.removed ? "schedule.removed" : "schedule.notInstalledRemove")),
        ]);
        return 0;
      });
    }
    if (sub === "restart") {
      const st = await scheduleStatus(spec, run);
      if (!st.installed || (st.command !== null && st.command !== undefined && !st.command.includes("--watch"))) {
        // Nothing to restart. A watcher started by hand that crashed is not coming back either: its heartbeat says so,
        // so `t3sm status` stops pointing here.
        if (!dryRun) await markGoneWatcher(dir, { pidAlive: alive, now: Date.now() }).catch(() => false);
        io.stderr(`${ui.t("schedule.noWatcherInstalled")}\n`);
        return 2;
      }
      if (dryRun) {
        say([...note("info", ui.t("schedule.wouldRestart")), ...note("ok", ui.t("common.nothingChanged"))]);
        return 0;
      }
      return locked(async () => {
        const r = await stop({ restart: true });
        if (r.running) { io.stderr(`${stillRunning(r)} ${ui.t("schedule.nothingStarted")}\n`); return 1; }
        await startWatcher(spec);
        say(note("ok", started(r)));
        return 0;
      });
    }
    const st = await scheduleStatus(spec, run);
    const hb = await readHeartbeat(dir);
    let lastLogged: string | null = null;
    try { lastLogged = (await readFile(join(dir, "logs", "sync.log"), "utf8")).trimEnd().split("\n").at(-1) || null; } catch { /* no log yet */ }
    say(renderScheduleStatus(ui, {
      kind: spec.kind, installed: st.installed, nextRun: st.nextRun, detail: st.detail, command: st.command, missing: st.missing, watch: spec.watch,
      watcher: hb ? { running: !hb.stoppedAt && alive(hb.pid), pid: hb.pid, lastCycleAt: hb.lastCycleAt ?? null, outcome: typeof hb.lastResult?.["outcome"] === "string" ? hb.lastResult["outcome"] as string : null, nextCycleAt: hb.nextCycleAt ?? null } : null,
      lastLogged,
    }));
    return 0;
  } catch (e) {
    if (e instanceof ScheduleError || e instanceof ConfigError) {
      io.stderr(`${e.message}\n`);
      return e instanceof ConfigError ? 2 : 1;
    }
    throw e;
  }
}
