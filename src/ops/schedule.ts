// Scheduler integration for `t3sm sync`: Windows Task Scheduler (schtasks /XML), macOS LaunchAgent (launchctl), cron.
// Every command is an argument array run without a shell. The only command strings built here are the task XML's
// <Arguments> and the crontab line, each quoted for its own parser; node/bin paths holding %, CR or LF are refused
// (cron and the Windows command line would expand or split them).
//
// Windows: a task XML is written to <state>/schedule/t3sm-task.xml (UTF-16LE with BOM, as schtasks requires) and
// registered with %SystemRoot%\System32\schtasks.exe /Create /XML <file> /TN <name> /F. The principal is the current
// user with LogonType InteractiveToken (runs only while that user is logged on, in their session) and RunLevel
// LeastPrivilege (no elevation). Interval: TimeTrigger with an indefinite Repetition; --watch: LogonTrigger for that
// user only, started at once with /Run. Settings: IgnoreNew (never two at once), runs on battery, StartWhenAvailable
// (a missed run starts at logon/wake), ExecutionTimeLimit PT2H for the interval job (generous on purpose: a hard
// terminate in the middle of a wave is exactly what the journal has to repair) / PT0S (unlimited) for the watcher.
// No <Hidden>: that flag hides the task from the Task Scheduler library, not its window; the window is hidden by
// running the action through `conhost.exe --headless "<node>" "<bin>" sync ...` (Windows
// 10 1809+; verified on build 26300). conhost does not forward the child's exit code (Task Scheduler's "Last Run
// Result" is always 0); the outcome lives in <state>/logs/sync.log. Without conhost: `cmd.exe /c start "" /min ...`.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir, release, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "../core/fsutil.ts";
import { ConfigError } from "../core/config.ts";

export const TASK_NAME = "t3code-session-manager sync";
export const LAUNCHD_LABEL = "dev.t3sm.sync";
export const CRON_TAG = "# t3sm";
/** Fixed StartBoundary: the repetition grid only; StartWhenAvailable covers the first run. */
const START_BOUNDARY = "2026-01-01T00:00:00";

export interface ScheduleFile { path: string; content: string; encoding?: "utf8" | "utf16le-bom" }

export interface ScheduleSpec {
  kind: "schtasks" | "launchd" | "cron";
  /** Commands run in order by installSchedule (argument arrays, no shell). */
  install: string[][];
  remove: string[][];
  /** Status probe. */
  query: string[];
  /** Files written before `install` and deleted by `remove` (task XML, LaunchAgent plist). */
  files?: ScheduleFile[];
  /** cron: the tagged line installSchedule merges into the user's crontab (other lines are kept). */
  cronLine?: string;
  watch: boolean;
}

export interface SpecOptions {
  /** Register the resident watcher (`sync --watch --quiet`) at logon/load/reboot instead of the interval job. */
  watch?: boolean;
  /** darwin: home holding Library/LaunchAgents (default os.homedir()). */
  home?: string;
  /** darwin: uid for the gui/<uid> domain (default os.userInfo().uid). */
  uid?: number;
  /** win32: absolute conhost.exe supporting --headless, or null for the `start /min` fallback (default: detected). */
  conhost?: string | null;
  /** win32: %SystemRoot% (default from the environment, else C:\Windows). */
  systemRoot?: string;
  /** win32: the t3sm state dir; the task XML is written to <stateDir>/schedule/t3sm-task.xml. */
  stateDir?: string;
  /** win32: DOMAIN\user of the principal and logon trigger (default USERDOMAIN\USERNAME). */
  userId?: string;
}

function checkEvery(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > 1440) throw new ConfigError(`schedule.everyMinutes must be an integer 1..1440 (got ${n}).`);
}

function checkPath(p: string, what: string): void {
  if (/[%\r\n]/.test(p)) throw new ConfigError(`The ${what} path cannot contain %, CR or LF (the scheduler would expand or split it): ${JSON.stringify(p)}. Install t3sm in another folder.`);
}

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Double-quoted for /bin/sh inside a crontab: \ " $ ` escaped for the shell (% is refused by checkPath). */
function cronQuote(p: string): string {
  return `"${p.replace(/([\\"$`])/g, "\\$1")}"`;
}

function cronWhen(n: number): string {
  if (n < 60) return `*/${n} * * * *`;
  if (n === 1440) return "0 0 * * *";
  if (n % 60 === 0) return `0 */${n / 60} * * *`;
  throw new ConfigError(`schedule.everyMinutes = ${n} cannot be expressed in cron: use a value below 60 or a multiple of 60.`);
}

/** conhost.exe with --headless (Windows 10 1809 = build 17763 or later), else null. */
export function detectConhost(env: NodeJS.ProcessEnv = process.env, osRelease: string = release(), exists: (p: string) => boolean = existsSync): string | null {
  const build = Number(osRelease.split(".")[2] ?? 0);
  if (!(build >= 17763)) return null;
  const p = path.win32.join(env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows", "System32", "conhost.exe");
  return exists(p) ? p : null;
}

/** Absolute path of bin/t3sm.mjs in this checkout or install. */
export function defaultBinPath(): string {
  return fileURLToPath(new URL("../../bin/t3sm.mjs", import.meta.url));
}

export interface TaskXmlInput {
  nodePath: string; binPath: string; args: string[]; everyMinutes: number; watch: boolean;
  userId: string; conhost: string | null; systemRoot: string;
}

/** The Task Scheduler 1.2 definition (see the header). Every value is XML-escaped. */
export function taskXml(i: TaskXmlInput): string {
  const cmd = `"${i.nodePath}" "${i.binPath}" ${i.args.join(" ")}`;
  const command = i.conhost ?? path.win32.join(i.systemRoot, "System32", "cmd.exe");
  const args = i.conhost ? `--headless ${cmd}` : `/c start "" /min ${cmd}`;
  const trigger = i.watch
    ? `    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(i.userId)}</UserId>
    </LogonTrigger>`
    : `    <TimeTrigger>
      <Repetition>
        <Interval>PT${i.everyMinutes}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${START_BOUNDARY}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>t3code-session-manager: import new agent sessions into T3 Code (t3sm sync).</Description>
  </RegistrationInfo>
  <Triggers>
${trigger}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(i.userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>${i.watch ? "PT0S" : "PT2H"}</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(command)}</Command>
      <Arguments>${xml(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function scheduleSpec(platform: NodeJS.Platform, nodePath: string, binPath: string, everyMinutes: number, opts: SpecOptions = {}): ScheduleSpec {
  checkEvery(everyMinutes);
  checkPath(nodePath, "node");
  checkPath(binPath, "t3sm");
  const watch = opts.watch ?? false;
  const args = watch ? ["sync", "--watch", "--quiet"] : ["sync", "--quiet"];
  if (platform === "win32") {
    const systemRoot = opts.systemRoot ?? process.env["SystemRoot"] ?? process.env["windir"] ?? "C:\\Windows";
    const schtasks = path.win32.join(systemRoot, "System32", "schtasks.exe");
    const conhost = opts.conhost === undefined ? detectConhost() : opts.conhost;
    const userId = opts.userId ?? (process.env["USERDOMAIN"] ? `${process.env["USERDOMAIN"]}\\${process.env["USERNAME"] ?? userInfo().username}` : userInfo().username);
    if (!opts.stateDir) throw new ConfigError("scheduleSpec(win32) needs the state dir for the task XML.");
    const xmlPath = path.win32.join(opts.stateDir, "schedule", "t3sm-task.xml");
    const create = [schtasks, "/Create", "/XML", xmlPath, "/TN", TASK_NAME, "/F"];
    return {
      kind: "schtasks", watch,
      install: watch ? [create, [schtasks, "/Run", "/TN", TASK_NAME]] : [create],
      remove: [[schtasks, "/Delete", "/F", "/TN", TASK_NAME]],
      query: [schtasks, "/Query", "/TN", TASK_NAME, "/FO", "CSV", "/NH"],
      files: [{ path: xmlPath, content: taskXml({ nodePath, binPath, args, everyMinutes, watch, userId, conhost, systemRoot }), encoding: "utf16le-bom" }],
    };
  }
  if (platform === "darwin") {
    const home = opts.home ?? homedir();
    const uid = opts.uid ?? userInfo().uid;
    const plist = path.posix.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    const prog = [nodePath, binPath, ...args].map((a) => `    <string>${xml(a)}</string>`).join("\n");
    // KeepAlive only after a failed exit (a second watcher exits 0 and stays down), at most one restart a minute.
    const when = watch
      ? "  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n  <key>ThrottleInterval</key>\n  <integer>60</integer>"
      : `  <key>StartInterval</key>\n  <integer>${everyMinutes * 60}</integer>`;
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${prog}
  </array>
${when}
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
    return {
      kind: "launchd", watch,
      install: [["launchctl", "bootstrap", `gui/${uid}`, plist]],
      remove: [["launchctl", "bootout", `gui/${uid}/${LAUNCHD_LABEL}`]],
      query: ["launchctl", "print", `gui/${uid}/${LAUNCHD_LABEL}`],
      files: [{ path: plist, content }],
    };
  }
  const line = `${watch ? "@reboot" : cronWhen(everyMinutes)} ${cronQuote(nodePath)} ${cronQuote(binPath)} ${args.join(" ")} ${CRON_TAG}`;
  return { kind: "cron", watch, install: [["crontab", "-"]], remove: [["crontab", "-"]], query: ["crontab", "-l"], cronLine: line };
}

// ---------- running the spec ----------

export interface RunResult { code: number; stdout: string; stderr: string }
export type CommandRunner = (cmd: string, args: string[], opts?: { input?: string }) => Promise<RunResult>;

/** schtasks /XML prints UTF-16 when redirected on some builds: decode by BOM / NUL pattern, else UTF-8. */
function decodeOutput(b: Buffer): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString("utf16le");
  if (b.length >= 4 && b[1] === 0 && b[3] === 0) return b.toString("utf16le");
  return b.toString("utf8");
}

/** spawn without a shell; ENOENT and other spawn errors come back as code 127. */
export const realRunner: CommandRunner = (cmd, args, opts) => new Promise((resolve) => {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let done = false;
  const finish = (code: number, fallbackErr = ""): void => {
    if (done) return;
    done = true;
    resolve({ code, stdout: decodeOutput(Buffer.concat(out)), stderr: decodeOutput(Buffer.concat(err)) || fallbackErr });
  };
  let child;
  try {
    child = spawn(cmd, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    finish(127, (e as Error).message);
    return;
  }
  child.stdout.on("data", (d: Buffer) => void out.push(d));
  child.stderr.on("data", (d: Buffer) => void err.push(d));
  child.on("error", (e) => finish(127, e.message));
  child.on("close", (code) => finish(code ?? 1));
  child.stdin.on("error", () => {});
  child.stdin.end(opts?.input ?? "");
});

export class ScheduleError extends Error {
  override name = "ScheduleError";
}

async function must(run: CommandRunner, argv: string[], input?: string): Promise<RunResult> {
  const r = await run(argv[0]!, argv.slice(1), input === undefined ? undefined : { input });
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim().split(/\r?\n/)[0] || `exit ${r.code}`;
    throw new ScheduleError(`${path.basename(argv[0]!)} ${argv[1] ?? ""} failed: ${why}`);
  }
  return r;
}

/** The current crontab, "" when the user has none. Any other failure throws: never overwrite a crontab we could not read. */
async function readCrontab(run: CommandRunner): Promise<string> {
  const r = await run("crontab", ["-l"]);
  if (r.code === 0) return r.stdout;
  if (/no crontab/i.test(r.stderr)) return "";
  throw new ScheduleError(`crontab -l failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
}

function withoutTagged(crontab: string): string[] {
  return crontab.split(/\r?\n/).filter((l) => l !== "" && !l.trimEnd().endsWith(CRON_TAG));
}

/** The bytes of a schedule file: UTF-16LE with a BOM for the task XML (schtasks /XML requires it), else UTF-8. */
export function scheduleFileBytes(f: ScheduleFile): Buffer {
  return f.encoding === "utf16le-bom" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(f.content, "utf16le")]) : Buffer.from(f.content, "utf8");
}

/**
 * The file operations install and remove need. A spec's file paths are written for the spec's platform (a win32 spec
 * holds Windows paths), so they are real files only on that platform: tests of another platform's spec inject a fake.
 */
export interface ScheduleFs {
  /** Create the parent directory and write the file, replacing an older one. */
  write(f: ScheduleFile): Promise<void>;
  /** Delete the file; a missing one is fine. */
  remove(path: string): Promise<void>;
  exists(path: string): boolean;
}

export const realScheduleFs: ScheduleFs = {
  write: async (f) => {
    if (f.encoding !== "utf16le-bom") return atomicWrite(f.path, f.content);
    // atomicWrite is UTF-8 text: temp file + rename, same directory.
    await mkdir(path.dirname(f.path), { recursive: true });
    const tmp = `${f.path}.${process.pid}.tmp`;
    await writeFile(tmp, scheduleFileBytes(f));
    try { await rename(tmp, f.path); } catch (e) { await rm(tmp, { force: true }); throw e; }
  },
  remove: (p) => rm(p, { force: true }),
  exists: existsSync,
};

/**
 * Idempotent: schtasks /F replaces; launchd is booted out (failure ignored) and bootstrapped, with one more
 * bootout + bootstrap if the first bootstrap fails (a stale registration); cron replaces the tagged line.
 */
export async function installSchedule(spec: ScheduleSpec, run: CommandRunner, fs: ScheduleFs = realScheduleFs): Promise<void> {
  if (spec.kind === "cron") {
    const lines = withoutTagged(await readCrontab(run));
    await must(run, spec.install[0]!, [...lines, spec.cronLine!].join("\n") + "\n");
    return;
  }
  for (const f of spec.files ?? []) await fs.write(f);
  if (spec.kind === "launchd") {
    const bootout = async (): Promise<void> => { for (const c of spec.remove) await run(c[0]!, c.slice(1)); };
    await bootout(); // not loaded yet: fine
    const c = spec.install[0]!;
    const first = await run(c[0]!, c.slice(1));
    if (first.code !== 0) {
      await bootout();
      await must(run, c);
    }
    return;
  }
  for (const c of spec.install) await must(run, c);
}

export async function removeSchedule(spec: ScheduleSpec, run: CommandRunner, fs: ScheduleFs = realScheduleFs): Promise<{ removed: boolean }> {
  if (spec.kind === "cron") {
    const cur = await readCrontab(run);
    const kept = withoutTagged(cur);
    if (kept.length === cur.split(/\r?\n/).filter((l) => l !== "").length) return { removed: false };
    await must(run, spec.remove[0]!, kept.length ? kept.join("\n") + "\n" : "");
    return { removed: true };
  }
  const status = await scheduleStatus(spec, run);
  const hasFiles = (spec.files ?? []).some((f) => fs.exists(f.path));
  if (!status.installed && !hasFiles) return { removed: false };
  if (spec.kind === "launchd") {
    for (const c of spec.remove) await run(c[0]!, c.slice(1));
  } else if (status.installed) {
    for (const c of spec.remove) await must(run, c);
  }
  for (const f of spec.files ?? []) await fs.remove(f.path);
  return { removed: status.installed || hasFiles };
}

/** First CSV row of `schtasks /Query /FO CSV /NH`: TaskName, Next Run Time, Status (values localized, columns fixed). */
function csvRow(s: string): string[] {
  const line = s.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
}

const unxml = (s: string): string => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const quoted = (s: string): string[] => [...s.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1")).filter((p) => p !== "");

/** The installed command line and the node/bin paths it runs, read back from the scheduler (or the plist). */
async function installedCommand(spec: ScheduleSpec, run: CommandRunner, cronLine: string | null): Promise<{ command: string | null; paths: string[] }> {
  try {
    if (spec.kind === "cron") {
      if (!cronLine) return { command: null, paths: [] };
      const body = cronLine.replace(/^(@\w+|\S+ \S+ \S+ \S+ \S+)\s+/, "").replace(/\s*# t3sm\s*$/, "");
      return { command: body, paths: quoted(body).slice(0, 2) };
    }
    if (spec.kind === "launchd") {
      const plist = await readFile(spec.files![0]!.path, "utf8");
      const strings = [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? "").matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1]!));
      return strings.length ? { command: strings.join(" "), paths: strings.slice(0, 2) } : { command: null, paths: [] };
    }
    const r = await run(spec.query[0]!, ["/Query", "/TN", TASK_NAME, "/XML"]);
    if (r.code !== 0) return { command: null, paths: [] };
    const cmd = /<Command>([\s\S]*?)<\/Command>/.exec(r.stdout)?.[1];
    const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(r.stdout)?.[1];
    if (cmd === undefined || args === undefined) return { command: null, paths: [] };
    const a = unxml(args);
    // Windows command line: backslashes are path separators, not escapes; the "" title of `start` is skipped.
    const ps = [...a.matchAll(/"([^"]*)"/g)].map((m) => m[1]!).filter((p) => /[\\/]/.test(p));
    return { command: `${unxml(cmd)} ${a}`, paths: ps.slice(0, 2) };
  } catch {
    return { command: null, paths: [] };
  }
}

export interface ScheduleStatus {
  installed: boolean;
  nextRun: string | null;
  detail: string | null;
  /** The command line the scheduler runs, as installed (null if it could not be read). */
  command: string | null;
  /** node / bin paths of that command that no longer exist (moved checkout, cleaned npx cache, upgraded node). */
  missing: string[];
}

export async function scheduleStatus(spec: ScheduleSpec, run: CommandRunner, o: { exists?: (p: string) => boolean } = {}): Promise<ScheduleStatus> {
  const exists = o.exists ?? existsSync;
  const none: ScheduleStatus = { installed: false, nextRun: null, detail: null, command: null, missing: [] };
  let base: Omit<ScheduleStatus, "command" | "missing">;
  let cronLine: string | null = null;
  if (spec.kind === "cron") {
    cronLine = (await readCrontab(run)).split(/\r?\n/).find((l) => l.trimEnd().endsWith(CRON_TAG)) ?? null;
    if (cronLine === null) return none;
    base = { installed: true, nextRun: null, detail: cronLine };
  } else {
    const r = await run(spec.query[0]!, spec.query.slice(1));
    if (r.code !== 0) return none;
    if (spec.kind === "schtasks") {
      const row = csvRow(r.stdout);
      base = { installed: true, nextRun: row[1] ?? null, detail: row[2] ?? null };
    } else {
      base = { installed: true, nextRun: null, detail: /^\s*state = (.+)$/m.exec(r.stdout)?.[1] ?? null };
    }
  }
  const ic = await installedCommand(spec, run, cronLine);
  return { ...base, command: ic.command, missing: ic.paths.filter((p) => !exists(p)) };
}
