import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "../../core/paths.ts";
import { ConfigError, DEFAULT_SCHEDULE_MINUTES, loadConfig } from "../../core/config.ts";
import {
  ScheduleError, defaultBinPath, installSchedule, realRunner, removeSchedule, scheduleSpec, scheduleStatus, type CommandRunner, type ScheduleFs, type ScheduleSpec,
} from "../../ops/schedule.ts";
import { pidAlive, readHeartbeat } from "../../ops/watch.ts";
import type { Io } from "../main.ts";

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
}

const USAGE = "Usage: t3sm schedule install [--watch] | remove | status. Run `t3sm schedule --help`.\n";

function describe(spec: ScheduleSpec, every: number): string {
  const what = spec.watch ? "t3sm sync --watch --quiet" : "t3sm sync --quiet";
  if (spec.kind === "schtasks") return spec.watch ? `${what} at every logon (started now), hidden, as you, without elevation` : `${what} every ${every} min while you are logged on, hidden, without elevation`;
  if (spec.kind === "launchd") return spec.watch ? `${what} as a LaunchAgent (runs now and at every login)` : `${what} every ${every} min as a LaunchAgent`;
  return spec.watch ? `${what} at every reboot (crontab; start it now with \`t3sm sync --watch\`)` : `${what} every ${every} min (crontab)`;
}

export async function scheduleCommand(args: string[], io: Io, deps: ScheduleCommandDeps = {}): Promise<number> {
  const [sub, ...rest] = args;
  const okFlags = sub === "install" ? ["--watch"] : [];
  if ((sub !== "install" && sub !== "remove" && sub !== "status") || rest.some((a) => !okFlags.includes(a))) {
    io.stderr(USAGE);
    return 2;
  }
  const home = deps.home ?? homedir();
  const dir = stateDir(io.env, home);
  const run = deps.runner ?? realRunner;
  const every = (await loadConfig(dir, home))?.schedule.everyMinutes ?? DEFAULT_SCHEDULE_MINUTES;
  try {
    const spec = scheduleSpec(deps.platform ?? process.platform, deps.nodePath ?? process.execPath, deps.binPath ?? defaultBinPath(), every, {
      watch: rest.includes("--watch"), home, uid: deps.uid, conhost: deps.conhost, stateDir: dir,
      systemRoot: io.env["SystemRoot"] ?? io.env["windir"],
    });
    if (sub === "install") {
      await installSchedule(spec, run, deps.fs);
      io.stdout(`Installed (${spec.kind}): ${describe(spec, every)}.\nEach cycle logs one line to ${join(dir, "logs", "sync.log")}. Undo with \`t3sm schedule remove\`.\n`);
      return 0;
    }
    if (sub === "remove") {
      const r = await removeSchedule(spec, run, deps.fs);
      io.stdout(r.removed ? "Removed the scheduled sync. A running watcher stops at its next Ctrl+C or logoff.\n" : "Not installed; nothing to remove.\n");
      return 0;
    }
    const s = await scheduleStatus(spec, run);
    const lines = [s.installed
      ? `Scheduled sync: installed (${spec.kind})${s.nextRun ? `, next run ${s.nextRun}` : ""}${s.detail && spec.kind !== "cron" ? `, ${s.detail}` : ""}`
      : "Scheduled sync: not installed"];
    if (s.installed && spec.kind === "cron" && s.detail) lines.push(`  ${s.detail}`);
    if (s.installed) {
      lines.push(s.command ? `Installed command: ${s.command}` : "Installed command: could not be read");
      if (s.missing.length > 0) lines.push(`Warning: the scheduled command points at ${s.missing.join(" and ")}, which no longer exist${s.missing.length === 1 ? "s" : ""}. Run \`t3sm schedule install${spec.watch ? " --watch" : ""}\` again from the current install.`);
    }
    const hb = await readHeartbeat(dir);
    const alive = deps.isAlive ?? pidAlive;
    if (!hb) lines.push("Watcher: none");
    else {
      const res = typeof hb.lastResult?.["outcome"] === "string" ? ` (${hb.lastResult["outcome"] as string})` : "";
      const last = hb.lastCycleAt ? `last cycle ${hb.lastCycleAt}${res}` : "no cycle yet";
      if (!hb.stoppedAt && alive(hb.pid)) lines.push(`Watcher: running (pid ${hb.pid}), ${last}, next ${hb.nextCycleAt ?? "-"}`);
      else lines.push(`Watcher: not running (${last})`);
    }
    try {
      const tail = (await readFile(join(dir, "logs", "sync.log"), "utf8")).trimEnd().split("\n").at(-1);
      if (tail) lines.push(`Last logged cycle: ${tail}`);
    } catch { /* no log yet */ }
    io.stdout(lines.join("\n") + "\n");
    return 0;
  } catch (e) {
    if (e instanceof ScheduleError || e instanceof ConfigError) {
      io.stderr(`${e.message}\n`);
      return e instanceof ConfigError ? 2 : 1;
    }
    throw e;
  }
}
