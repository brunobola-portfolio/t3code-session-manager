// Starting the next background watcher (`sync --watch --quiet`) detached and hidden: used by a watcher that restarts
// into a newer install (src/cli/commands/sync.ts), by `t3sm schedule` where the scheduler cannot start one (cron), and
// by the update engine (src/ops/updater.ts). The watcher's daily update check starts `update --auto-run --yes` the same
// way (src/ops/autoUpdate.ts): the update stops the watcher, so it never runs inside the watcher's own process.

import { system32 } from "../core/sysroot.ts";

/** The slice of child_process.spawn spawnSuccessor uses. */
export type SpawnLike = (cmd: string, args: string[], opts: {
  detached: boolean; stdio: "ignore"; windowsHide: boolean; env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean;
}) => { unref(): void; on?(ev: "error", fn: (e: Error) => void): unknown };

export interface SuccessorOptions {
  platform: NodeJS.Platform;
  nodePath: string;
  binPath: string;
  /** win32: conhost.exe supporting --headless, or null for the `cmd.exe /c start "" /min` fallback (as the scheduled task). */
  conhost: string | null;
  spawn: SpawnLike;
  /** The environment the successor starts from (default process.env); CLAUDE_CONFIG_DIR (any case) is dropped. */
  env?: NodeJS.ProcessEnv;
  /** win32: %SystemRoot% for cmd.exe (default from the environment, else C:\Windows; not a drive path: C:\Windows). */
  systemRoot?: string;
  /** What the child runs (default the watcher: `sync --watch --quiet`; the daily update check: `update --auto-run --yes`). */
  argv?: string[];
}

/**
 * Starts the next watcher (`sync --watch --quiet` from the new install) detached, hidden, with stdio ignored and
 * without CLAUDE_CONFIG_DIR, and lets it go (unref). Called after the singleton is released, so the successor finds the
 * pipe free; if it still loses a race, or fails to start, the keep-alive trigger (every 15 min) or the next logon
 * starts one.
 */
export function spawnSuccessor(o: SuccessorOptions): void {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(o.env ?? process.env)) if (v !== undefined && k.toUpperCase() !== "CLAUDE_CONFIG_DIR") env[k] = v;
  const opts = { detached: true, stdio: "ignore" as const, windowsHide: true, env };
  const argv = o.argv ?? ["sync", "--watch", "--quiet"];
  let child: ReturnType<SpawnLike>;
  if (o.platform === "win32" && o.conhost) {
    child = o.spawn(o.conhost, ["--headless", o.nodePath, o.binPath, ...argv], opts);
  } else if (o.platform === "win32" && !/[%"\r\n]/.test(o.nodePath + o.binPath)) {
    // cmd.exe parses its own command line: built verbatim, quoted as the scheduled task's (src/ops/schedule.ts).
    const cmd = system32(o.systemRoot !== undefined ? { SystemRoot: o.systemRoot } : env, "cmd.exe");
    child = o.spawn(cmd, ["/c", "start", '""', "/min", `"${o.nodePath}"`, `"${o.binPath}"`, ...argv], { ...opts, windowsVerbatimArguments: true });
  } else {
    child = o.spawn(o.nodePath, [o.binPath, ...argv], opts);
  }
  child.on?.("error", () => { /* the keep-alive trigger starts one */ });
  child.unref();
}
