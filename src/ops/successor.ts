// Starting the next background watcher (`sync --watch --quiet`) detached and hidden: used by a watcher that restarts
// into a newer install (src/cli/commands/sync.ts), by `t3sm schedule` where the scheduler cannot start one (cron), and
// by the update engine (src/ops/updater.ts). The watcher's daily update check starts `update --auto-run --yes` the same
// way (src/ops/autoUpdate.ts): the update stops the watcher, so it never runs inside the watcher's own process.

/** The slice of child_process.spawn spawnSuccessor uses. */
export type SpawnLike = (cmd: string, args: string[], opts: {
  detached: boolean; stdio: "ignore"; windowsHide: boolean; env: NodeJS.ProcessEnv;
}) => { unref(): void; on?(ev: "error", fn: (e: Error) => void): unknown };

export interface SuccessorOptions {
  nodePath: string;
  binPath: string;
  spawn: SpawnLike;
  /** The environment the successor starts from (default process.env); CLAUDE_CONFIG_DIR (any case) is dropped. */
  env?: NodeJS.ProcessEnv;
  /** What the child runs (default the watcher: `sync --watch --quiet`; the daily update check: `update --auto-run --yes`). */
  argv?: string[];
}

/**
 * Starts the next watcher (`sync --watch --quiet` from the new install) detached, hidden, with stdio ignored and
 * without CLAUDE_CONFIG_DIR, and lets it go (unref). Called after the singleton is released, so the successor finds the
 * pipe free; if it still loses a race, or fails to start, the keep-alive trigger (every 15 min) or the next logon
 * starts one.
 *
 * Always node itself. On Windows a detached child has no console at all, so no window shows. Never through conhost.exe
 * --headless, as the scheduled task does: with stdio ignored it exits 0 at once and runs nothing (0.3.0 to 0.4.1 did
 * that, so their automatic update never ran).
 */
export function spawnSuccessor(o: SuccessorOptions): void {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(o.env ?? process.env)) if (v !== undefined && k.toUpperCase() !== "CLAUDE_CONFIG_DIR") env[k] = v;
  const argv = o.argv ?? ["sync", "--watch", "--quiet"];
  const child = o.spawn(o.nodePath, [o.binPath, ...argv], { detached: true, stdio: "ignore", windowsHide: true, env });
  child.on?.("error", () => { /* the keep-alive trigger starts one */ });
  child.unref();
}
