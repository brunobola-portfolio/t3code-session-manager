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
