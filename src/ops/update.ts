// t3sm update's building blocks: how this t3sm was installed (a checkout, a global npm install, npx's cache), its own
// GitHub repository (the default update source), and updateRunner, the runner the update engine (src/ops/updater.ts)
// uses for git and npm: no prompts, a time limit per call, no CLAUDE_CONFIG_DIR.

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptionsWithStdioTuple } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import type { CommandRunner } from "../core/run.ts";
import { driveSystemRoot } from "../core/sysroot.ts";
import type { UpdateSource } from "../core/types.ts";

export type InstallKind = "checkout" | "global" | "npx";

/** `root` is the package root (the folder holding bin/ and package.json). */
export function installKind(root: string): InstallKind {
  const parts = root.split(/[\\/]+/);
  if (!parts.includes("node_modules")) return "checkout";
  return parts.includes("_npx") ? "npx" : "global";
}

/** `owner/name` of a GitHub repository URL. Throws when it is not one. */
export function repoSlug(repositoryUrl: string): string {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repositoryUrl);
  if (!m) throw new Error(`package.json's repository is not a GitHub URL: ${repositoryUrl}`);
  return `${m[1]}/${m[2]}`;
}

/** The npm spec of the newest release, from package.json's repository URL. */
export function releaseSpec(repositoryUrl: string): string {
  return `github:${repoSlug(repositoryUrl)}#semver:*`;
}

/** This t3sm's own repository URL, from its package.json (src/ops and dist/ops both sit two folders below the root). */
export function ownRepositoryUrl(): string {
  try {
    const r = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { repository?: { url?: string } | string }).repository;
    return typeof r === "string" ? r : r?.url ?? "";
  } catch { return ""; }
}

/** The source t3sm updates from when nothing is remembered: the GitHub repository in package.json (null: not one). */
export function defaultUpdateSource(repositoryUrl: string = ownRepositoryUrl()): UpdateSource | null {
  try { return { kind: "github", repo: repoSlug(repositoryUrl) }; } catch { return null; }
}

/** The environment npm runs with: everything but CLAUDE_CONFIG_DIR (a child process never inherits it). */
export function npmEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k.toUpperCase() !== "CLAUDE_CONFIG_DIR") out[k] = v;
  return out;
}

/** Arguments safe to hand to cmd.exe unquoted (npm is npm.cmd on Windows, which needs a shell). */
const SAFE_ARG = /^[A-Za-z0-9:/._#*@-]+$/;

/** How updateRunner starts a process (tests inject a fake child). `args` empty: `cmd` is a whole shell command line. */
export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptionsWithStdioTuple<"pipe", "pipe", "pipe">) => ChildProcessWithoutNullStreams;

/** The slice of `process` updateRunner uses to stop a POSIX child's group when t3sm exits or is interrupted. */
export interface ProcessLike {
  readonly pid: number;
  on(ev: "exit" | NodeJS.Signals, fn: (sig: NodeJS.Signals) => void): unknown;
  off(ev: "exit" | NodeJS.Signals, fn: (sig: NodeJS.Signals) => void): unknown;
  listenerCount(ev: NodeJS.Signals): number;
  kill(pid: number, sig: NodeJS.Signals): unknown;
}
const GUARD_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The timer updateRunner arms per call (tests inject one that fires on demand). */
export interface RunTimer { setTimer(fn: () => void, ms: number): unknown; clearTimer(h: unknown): void }
const realTimer: RunTimer = {
  // unref: a pending time limit never keeps the process alive by itself.
  setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** How long a killed command gets to report its exit before the call returns the timeout result anyway. */
export const KILL_GRACE_MS = 5000;
/** How long an exited command may keep its pipes open (a helper that inherited them) before the call ends anyway. */
export const EXIT_GRACE_MS = 5000;

/** The slice of a ChildProcess the kill needs. */
export interface KillableChild {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | string | null;
  kill(signal?: NodeJS.Signals): boolean;
}

/** What defaultKill starts or signals (tests inject a fake, so no real pid or group is ever signalled by a test). */
export interface KillSys {
  /** Starts `taskkill.exe` (win32) with `env`. */
  spawn(cmd: string, args: string[], env: Record<string, string>): void;
  /** SIGKILL to a POSIX process group (`process.kill(-pgid, "SIGKILL")`). */
  killGroup(pgid: number): void;
}
const realKillSys: KillSys = {
  spawn: (cmd, args, env) => { spawn(cmd, args, { stdio: "ignore", windowsHide: true, env }).on("error", () => {}); },
  killGroup: (pgid) => { process.kill(-pgid, "SIGKILL"); },
};

/**
 * Kills a command updateRunner started, by its own pid, never by name, and only while that child is known to be alive
 * (no exit code, no signal yet: a pid that already exited may belong to another process by now). win32:
 * `taskkill /PID <pid> /T /F` (the tree: the shell npm runs in, npm, git, a `prepare` script), started without
 * CLAUDE_CONFIG_DIR, and only under a SystemRoot that is a drive path such as `C:\Windows` (a relative, drive-less,
 * network or device SystemRoot never runs a taskkill.exe found somewhere else). POSIX: the child leads its own process group (updateRunner starts it detached), so the whole
 * group gets SIGKILL (npm's git clone and `prepare` too, so nothing keeps writing the install after a timeout), then
 * the child itself through its handle.
 */
export function defaultKill(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, sys: KillSys = realKillSys): (child: KillableChild) => void {
  return (c) => {
    const pid = c.pid;
    if (pid === undefined || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
    if (c.exitCode !== null || c.signalCode !== null) return; // already gone: never signal a pid that may be reused
    if (platform === "win32") {
      // A drive path only (`C:\Windows`): a drive-less rooted folder (`\Windows`, the current drive), a relative one, a
      // network share or a device path never resolves the taskkill.exe that is started.
      const root = driveSystemRoot(env);
      if (root === null) return;
      const taskkill = win32.join(root, "System32", "taskkill.exe");
      if (!win32.isAbsolute(taskkill)) return;
      try { sys.spawn(taskkill, ["/PID", String(pid), "/T", "/F"], npmEnv(env)); } catch { /* gone */ }
      return;
    }
    try { sys.killGroup(pid); } catch { /* the group is gone */ }
    try { c.kill("SIGKILL"); } catch { /* gone */ }
  };
}

/**
 * The environment of every command the update engine runs: npmEnv (no CLAUDE_CONFIG_DIR), and git never asks for
 * anything: GIT_TERMINAL_PROMPT=0 (no username/password prompt) and GCM_INTERACTIVE=never (Git Credential Manager on
 * Windows would otherwise open a sign-in window from a hidden background process and wait for it forever).
 */
export function updateEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return { ...npmEnv(env), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
}

/**
 * The runner the update engine (src/ops/updater.ts) uses for git and npm: output captured, env from updateEnv, and a
 * time limit per call (`timeoutMs`): past it the command is killed by its own pid (defaultKill) and the result is exit
 * 124 with "timed out after N s" (at the latest KILL_GRACE_MS after the kill, whether or not the child reports its
 * exit), so a stalled proxy or a hidden prompt never holds the sync lock. On POSIX each child leads its own process
 * group (detached), so the kill reaches what npm started itself (git clone, a `prepare` script) as well; and because a
 * detached group misses the terminal's Ctrl+C, the call registers exit, SIGINT, SIGTERM and SIGHUP handlers for its
 * duration that kill the live child's group (a signal is raised again afterwards when nobody else handles it, so
 * Ctrl+C still ends t3sm). A child that exited but whose pipes stay open (a background helper inherited them) ends the
 * call EXIT_GRACE_MS later with its own exit code. No shell, except npm
 * on Windows (npm.cmd only starts through cmd.exe): its arguments must pass SAFE_ARG (no spaces, quotes or cmd.exe
 * metacharacters), the command line is joined here, never by Node, and anything else is refused with exit 126 before a
 * process starts. NoDefaultCurrentDirectoryInExePath=1 stops cmd.exe from resolving `npm` from the working folder (a
 * folder install runs npm inside the clone; that checkout's own `prepare` script runs anyway, so this is tidiness, not
 * a trust boundary). A call without `cwd` runs in the temp folder (`o.cwd`, default os.tmpdir()), never in the folder
 * t3sm was started from: Windows resolves a bare `git` in the working folder before PATH, so `t3sm update --check` run
 * in a folder holding a planted git.exe would start it. Spawn errors are exit 127, and so is cmd.exe's 9009 (command not found).
 */
export function updateRunner(
  platform: NodeJS.Platform, env: NodeJS.ProcessEnv,
  o: { timer?: RunTimer; kill?: (child: KillableChild) => void; onSpawn?: (child: ChildProcess) => void; spawn?: SpawnFn; proc?: ProcessLike; cwd?: string } = {},
): CommandRunner {
  const proc = o.proc ?? (process as unknown as ProcessLike);
  const sp: SpawnFn = o.spawn ?? ((c, a, opts) => (a.length > 0 ? spawn(c, a, opts) : spawn(c, opts)));
  const timer = o.timer ?? realTimer;
  const kill = o.kill ?? defaultKill(platform, env);
  return (cmd, args, opts) => new Promise((resolve) => {
    const viaShell = platform === "win32" && cmd === "npm";
    if (viaShell) {
      const bad = args.find((a) => !SAFE_ARG.test(a));
      if (bad !== undefined) { resolve({ code: 126, stdout: "", stderr: `refusing to pass ${JSON.stringify(bad)} to npm` }); return; }
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let done = false;
    let timedOut = false;
    let handle: unknown = null;
    let grace: unknown = null;
    let exitGrace: unknown = null;
    let exited = false; // the 'exit' event: 'close' also waits for every process holding the pipes (grandchildren)
    let unguard = (): void => {};
    const finish = (code: number, fallbackErr = ""): void => {
      if (done) return; // late child events after a timeout result are ignored
      done = true;
      unguard();
      if (handle !== null) timer.clearTimer(handle);
      if (grace !== null) timer.clearTimer(grace);
      if (exitGrace !== null) timer.clearTimer(exitGrace);
      const stderr = Buffer.concat(err).toString("utf8") || fallbackErr;
      if (timedOut) resolve({ code: 124, stdout: Buffer.concat(out).toString("utf8"), stderr: `timed out after ${Math.round((opts?.timeoutMs ?? 0) / 1000)} s${stderr ? `\n${stderr}` : ""}` });
      else resolve({ code: code === 9009 ? 127 : code, stdout: Buffer.concat(out).toString("utf8"), stderr });
    };
    let child;
    try {
      const childEnv = viaShell ? { ...updateEnv(env), NoDefaultCurrentDirectoryInExePath: "1" } : updateEnv(env);
      // POSIX: its own process group, so a kill reaches everything it started (see defaultKill).
      // Never the launch folder: without a shell, Windows looks for a bare `git` there before PATH (a planted git.exe).
      const o2 = { shell: viaShell, windowsHide: true, detached: platform !== "win32", cwd: opts?.cwd ?? o.cwd ?? tmpdir(), env: childEnv, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
      child = viaShell ? sp(["npm", ...args].join(" "), [], o2) : sp(cmd, args, o2);
    } catch (e) {
      finish(127, (e as Error).message);
      return;
    }
    const c = child;
    const letGo = (): void => { for (const st of [c.stdin, c.stdout, c.stderr]) { try { st.destroy(); } catch { /* already closed */ } } };
    o.onSpawn?.(c);
    const alive = (): boolean => !exited && c.exitCode === null && c.signalCode === null;
    if (platform !== "win32") {
      // The detached group does not get the terminal's Ctrl+C: t3sm passes it on while this call runs.
      const onExit = (): void => { if (alive()) kill(c); };
      const onSignal = (sig: NodeJS.Signals): void => {
        if (alive()) kill(c);
        unguard();
        if (proc.listenerCount(sig) === 0) proc.kill(proc.pid, sig); // nobody else handles it: the default action
      };
      proc.on("exit", onExit);
      for (const sig of GUARD_SIGNALS) proc.on(sig, onSignal);
      unguard = () => {
        unguard = () => {};
        proc.off("exit", onExit);
        for (const sig of GUARD_SIGNALS) proc.off(sig, onSignal);
      };
    }
    c.on("exit", (code) => {
      exited = true;
      // 'close' also waits for every process holding the pipes (a background helper that inherited stdout): the child
      // is done, so after a short grace the call ends with its own exit code (a signal exit counts as 1).
      if (!done) exitGrace = timer.setTimer(() => { letGo(); finish(code ?? 1); }, EXIT_GRACE_MS);
    });
    c.stdout.on("data", (d: Buffer) => void out.push(d));
    c.stderr.on("data", (d: Buffer) => void err.push(d));
    c.on("error", (e) => finish(127, e.message));
    c.on("close", (code) => finish(code ?? 1));
    c.stdin.on("error", () => {});
    c.stdin.end(opts?.input ?? "");
    if (opts?.timeoutMs !== undefined && opts.timeoutMs > 0) {
      handle = timer.setTimer(() => {
        if (done) return;
        timedOut = true;
        if (alive()) kill(c);
        // A grandchild holding the pipes must not keep the call alive: let go of them.
        letGo();
        // The child is gone: the timeout result now. Otherwise never wait on its events forever: the grace period.
        if (exited) finish(124);
        else grace = timer.setTimer(() => finish(124), KILL_GRACE_MS);
      }, opts.timeoutMs);
    }
  });
}
