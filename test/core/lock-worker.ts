// Child process for the multi-process lock stress test (not a test file itself).
// argv: <dir> <goAtEpochMs> <deadPid>. kill() reports ESRCH for exactly <deadPid> (immune to pid reuse). Prints WIN or LOSE (or ERR ...), then waits for stdin to close
// so a winner keeps holding the lock until every contender has finished.
import { acquireLock } from "../../src/core/lock.ts";

const [dir, goAt, dead] = [process.argv[2]!, Number(process.argv[3]), Number(process.argv[4])];
const kill = (pid: number, sig: 0): void => {
  if (pid === dead) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  process.kill(pid, sig);
};
const wait = goAt - Date.now();
if (wait > 0) await new Promise((r) => setTimeout(r, wait));
try {
  const lock = await acquireLock(dir, { kill });
  process.stdout.write(lock ? "WIN\n" : "LOSE\n");
  process.stdin.resume();
  await new Promise((r) => process.stdin.on("end", r));
  if (lock) await lock.release();
} catch (e) {
  process.stdout.write(`ERR ${(e as Error).message}\n`);
}
