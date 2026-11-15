import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { CommandRunner } from "./run.ts";
import { system32 } from "./sysroot.ts";

const MAX_PID = 2 ** 31 - 1;

/**
 * Is process `pid` alive? Signal 0 only probes; nothing is ever sent. ESRCH = gone; any other error (EPERM: another
 * user's process) counts as alive, so a lock or a watcher is never taken over on a doubtful answer. `kill`: test hook.
 * A pid outside 1..2^31-1 (or not an integer) names no process: not alive, never probed (`kill(0)` would signal our
 * own process group, and an out-of-range pid throws a non-ESRCH error that would read as alive forever).
 */
export function pidAlive(pid: number, kill: (pid: number, signal: 0) => void = (p, s) => { process.kill(p, s); }): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_PID) return false;
  if (pid === process.pid) return true;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** What identifies a process before it is killed: its command line (and argv where the OS keeps it) and start time. */
export interface ProcessInfo {
  /** The argv array, where the OS gives it (Linux /proc cmdline); null elsewhere (only the flat string exists). */
  argv: string[] | null;
  commandLine: string;
  /** Epoch ms. */
  startedAt: number;
}

export interface InfoOpts {
  /** Linux: how /proc files are read (injectable). */
  readProc?: (path: string) => Promise<string>;
  env?: Record<string, string | undefined>;
  /** The reader's working directory (default: the temp dir, never the launch directory). */
  cwd?: string;
  timeoutMs?: number;
}

const CLK_TCK = 100; // USER_HZ: 100 on every mainstream Linux build

/**
 * How long reading a process's command line and start time may take. A cold powershell.exe with a CIM query at sign-in
 * can take several seconds on a loaded machine, and a timeout means "cannot verify" (the watcher is then not stopped).
 */
export const PROCESS_INFO_TIMEOUT_MS = 15_000;

/**
 * Command line and start time of process `pid`, or null when it is gone, unreadable or the answer is unusable (the
 * caller then does not kill). The pid is validated (integer, 1..2^31-1) before any command is built: nothing else is
 * ever interpolated. Tools are resolved to absolute paths (never PATH / CWD): win32 powershell.exe under SystemRoot
 * (one CIM call -> JSON), POSIX /bin/ps; Linux reads /proc/<pid>/{cmdline,stat} and /proc/stat btime without a
 * command. The whole read is bounded by `timeoutMs` (default PROCESS_INFO_TIMEOUT_MS), and so is each command, which
 * the runner then kills: a timed-out reader is never left running.
 */
export async function processInfo(pid: number, platform: NodeJS.Platform, run: CommandRunner, o: InfoOpts = {}): Promise<ProcessInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_PID) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((ok) => { timer = setTimeout(() => ok(null), o.timeoutMs ?? PROCESS_INFO_TIMEOUT_MS); timer.unref?.(); });
  try {
    return await Promise.race([read(pid, platform, run, o), timeout]);
  } catch { return null; } finally { clearTimeout(timer); }
}

async function read(pid: number, platform: NodeJS.Platform, run: CommandRunner, o: InfoOpts): Promise<ProcessInfo | null> {
  const cwd = o.cwd ?? tmpdir();
  if (platform === "linux") {
    const rd = o.readProc ?? ((p: string) => readFile(p, "utf8"));
    const argv = (await rd(`/proc/${pid}/cmdline`)).split("\0");
    while (argv.length > 0 && argv[argv.length - 1] === "") argv.pop();
    if (argv.length === 0) return null;
    const stat = await rd(`/proc/${pid}/stat`);
    const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/); // rest[0] is field 3
    const ticks = Number(rest[19]); // field 22: starttime
    const btime = Number(/^btime\s+(\d+)/m.exec(await rd("/proc/stat"))?.[1]);
    if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
    return { argv, commandLine: argv.join(" "), startedAt: (btime + ticks / CLK_TCK) * 1000 };
  }
  if (platform === "win32") {
    const env = o.env ?? process.env;
    const ps = system32(env, "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object CommandLine, @{n='S';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`;
    const r = await run(ps, ["-NoProfile", "-NonInteractive", "-Command", script], { cwd, timeoutMs: o.timeoutMs ?? PROCESS_INFO_TIMEOUT_MS });
    if (r.code !== 0 || r.stdout.trim() === "") return null;
    const j = JSON.parse(r.stdout.trim()) as { CommandLine?: unknown; S?: unknown };
    const startedAt = typeof j.S === "string" ? Date.parse(j.S) : Number.NaN;
    if (typeof j.CommandLine !== "string" || j.CommandLine.trim() === "" || !Number.isFinite(startedAt)) return null;
    return { argv: null, commandLine: j.CommandLine.trim(), startedAt };
  }
  const ps = async (field: string): Promise<string | null> => {
    const r = await run("/bin/ps", ["-o", field, "-p", String(pid)], { cwd, timeoutMs: o.timeoutMs ?? PROCESS_INFO_TIMEOUT_MS });
    return r.code === 0 && r.stdout.trim() !== "" ? r.stdout.trim() : null;
  };
  const lstart = await ps("lstart=");
  const commandLine = lstart === null ? null : await ps("command=");
  const startedAt = lstart === null ? Number.NaN : Date.parse(lstart);
  return commandLine === null || !Number.isFinite(startedAt) ? null : { argv: null, commandLine, startedAt };
}
