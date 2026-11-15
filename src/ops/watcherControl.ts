/**
 * Stopping the background watcher (`t3sm sync --watch`) safely. First a stop request over its single-instance
 * endpoint (`stop <token>` -> `ok`; the watcher finishes the current cycle and exits). Only when that does not work
 * the heartbeat pid is killed, and ONLY after its identity is proven: the command line is a t3sm watcher AND the
 * process started when the heartbeat says (pid reuse guard). Never by image name; never pid 0/1/our own.
 */
import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pidAlive, processInfo as realProcessInfo, type ProcessInfo } from "../core/pid.ts";
import { realRunner } from "./schedule.ts";
import { SocketDirSuffixError, readHeartbeat, legacySingletonAddress, realSingletonNet, singletonAddress, watcherTokenPath, type AddrOpts, type Clock, type Heartbeat, type SingletonNet } from "./watch.ts";
import { writeHeartbeatMerged } from "./syncStatus.ts";

const baseName = (t: string): string => t.replace(/^["']+|["']+$/g, "").split(/[\\/]/).pop() ?? "";

function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/**
 * Rule (tokens; quote and Windows/POSIX path aware): the command line must be `[wrapper] node [node flags] <script>
 * sync ... --watch ...` where: `node` is a token whose basename is node/node.exe; `<script>` has basename t3sm or
 * t3sm.mjs and comes after node with only `-flags` between; the NEXT token is `sync` (a global flag before `sync`,
 * such as `t3sm --quiet sync --watch`, is rejected on purpose: t3sm has none, so such a line is not ours); `--watch`
 * is a later token. The only thing allowed before node is a `conhost(.exe)` wrapper with `-`/`--` flags. An editor or
 * anything else that merely mentions the script, or `t3sm status` / `t3sm sync` without --watch: no.
 * Takes the argv array when the OS gives one (Linux), else the flat command line, tokenized here.
 */
export function isT3smWatcher(cmd: string | readonly string[]): boolean {
  const t = typeof cmd === "string" ? tokenize(cmd) : cmd;
  const n = t.findIndex((x) => /^node(\.exe)?$/i.test(baseName(x)));
  if (n < 0) return false;
  if (n > 0) {
    if (!/^conhost(\.exe)?$/i.test(baseName(t[0]!))) return false;
    if (!t.slice(1, n).every((x) => x.startsWith("-"))) return false;
  }
  let s = n + 1;
  while (s < t.length && t[s]!.startsWith("-")) s++;
  if (s >= t.length || !/^t3sm(\.mjs)?$/i.test(baseName(t[s]!))) return false;
  if (t[s + 1] !== "sync") return false;
  return t.slice(s + 2).includes("--watch");
}

/** "closed-without-reply": the 0.2.1 signature (or a refused token); "timed-out": connected, no reply (slow watcher). */
export async function requestWatcherStop(
  stateDir: string, platform: NodeJS.Platform = process.platform, net: SingletonNet = realSingletonNet, addrOpts: AddrOpts = {},
  /** Where to send it instead of the derived address (the heartbeat's `socket`). */
  target?: string,
): Promise<"stopped" | "no-watcher" | "closed-without-reply" | "timed-out"> {
  const token = await readFile(watcherTokenPath(stateDir), "utf8").then((s) => s.trim(), () => "");
  const addr = target ?? tryAddress(stateDir, platform, addrOpts);
  if (addr === null) return "no-watcher"; // no address can be derived (see SocketDirSuffixError): nothing to ask
  const r = await net.request(addr, `stop ${token}\n`);
  return r === "ok" ? "stopped" : r === "closed" ? "closed-without-reply" : r;
}

/** The derived endpoint, or null when the persisted directory suffix cannot be used (SocketDirSuffixError). */
function tryAddress(stateDir: string, platform: NodeJS.Platform, o: AddrOpts = {}): string | null {
  try { return singletonAddress(stateDir, platform, o); } catch (e) { if (e instanceof SocketDirSuffixError) return null; throw e; }
}

export interface StopDeps {
  stateDir: string;
  platform: NodeJS.Platform;
  net?: SingletonNet;
  /** Where the POSIX fallback socket directory comes from (env, tmp dir, uid, lstat); default: the real process. */
  addr?: AddrOpts;
  readHeartbeat?: typeof readHeartbeat;
  pidAlive?: (pid: number) => boolean;
  processInfo?: (pid: number) => Promise<ProcessInfo | null>;
  kill(pid: number): void;
  clock: Clock;
  waitMs?: number;
  /**
   * "restart": the caller starts a new watcher right after (an update, `schedule restart`, `install --watch`). The
   * stopped watcher's heartbeat then says `reason: "restart"`, so a successor that never comes is `restart-lost`
   * (needs you) instead of a clean, final stop (watcherHealth).
   */
  intent?: "restart";
  /** Writes the heartbeat over its own fields (default writeHeartbeatMerged; what the cycles recorded stays). */
  writeHeartbeat?: (stateDir: string, hb: Heartbeat) => Promise<void>;
  /** win32: how long to wait for the stopped watcher's process to exit (default EXIT_WAIT_MS). */
  exitWaitMs?: number;
}

/**
 * win32: the watcher frees its pipe before its process (and the conhost that is the scheduled task's action) has exited.
 * A `schtasks /Run` sent in that gap finds the task still running and is dropped (IgnoreNew, exit 0), so a stop waits
 * up to this long for the pid to go before it returns.
 */
export const EXIT_WAIT_MS = 10_000;

/**
 * The heartbeat of a watcher that is gone (its pid is not alive) without a clean stop: marked stopped now (`stoppedAt`,
 * merged), so `status` and `doctor` stop reporting a crashed watcher once something looked (a stop, `schedule remove`,
 * `schedule install`). A heartbeat that already stopped, or whose pid lives, is left alone. Returns whether it wrote.
 */
export async function markGoneWatcher(stateDir: string, o: {
  pidAlive?: (pid: number) => boolean; now: number; readHeartbeat?: typeof readHeartbeat; writeHeartbeat?: (stateDir: string, hb: Heartbeat) => Promise<void>;
}): Promise<boolean> {
  const hb = await (o.readHeartbeat ?? readHeartbeat)(stateDir);
  if (hb === null || hb.stoppedAt || (o.pidAlive ?? ((p) => pidAlive(p)))(hb.pid)) return false;
  await (o.writeHeartbeat ?? writeHeartbeatMerged)(stateDir, { ...hb, stoppedAt: new Date(o.now).toISOString(), nextCycleAt: null });
  return true;
}

const POLL_MS = 200;
const START_SLACK_MS = 2000; // /proc start times are whole seconds
const START_WINDOW_MS = 120_000;
const FREE = new Set(["refused", "absent"]);
const sleep = (c: Clock, ms: number): Promise<void> => new Promise((ok) => { c.setTimer(ok, ms); });

/**
 * running: from a final probe of the endpoint (the truth, whatever we did). how: "request" the watcher let go after
 * the request; "pid" we killed (or tried to kill) a verified pid; "none" nothing was done to any process.
 */
export type StopResult = { how: "request" | "pid" | "none"; pid: number | null; running: boolean };

export async function stopWatcher(d: StopDeps): Promise<StopResult> {
  const read = d.readHeartbeat ?? readHeartbeat;
  const before = d.intent === "restart" ? await read(d.stateDir).catch(() => null) : null;
  const r = await stopOnly(d);
  if (r.running) return r;
  const hb = await read(d.stateDir);
  const alive = (pid: number): boolean => Number.isInteger(pid) && pid > 1 && pid !== process.pid && (d.pidAlive ?? ((p) => pidAlive(p)))(pid);
  if (d.platform === "win32" && r.pid !== null) {
    const end = d.clock.now() + (d.exitWaitMs ?? EXIT_WAIT_MS);
    while (alive(r.pid) && d.clock.now() < end) await sleep(d.clock, POLL_MS);
  }
  // What the heartbeat says now: a watcher that is gone without a clean stop is marked stopped; a stop before a restart
  // says so, but only when this call stopped it (or it never stopped cleanly): an old clean stop that this call found
  // as it was is left alone (a restart reason there would read restart-lost forever). Only the heartbeat of the
  // watcher that was there (never a successor's: read again right before the write, same pid and start), best effort.
  const restart = d.intent === "restart" && (r.how !== "none" || (before !== null && !before.stoppedAt));
  try {
    const cur = hb === null ? null : await read(d.stateDir);
    if (hb !== null && cur !== null && cur.pid === hb.pid && cur.startedAt === hb.startedAt
      && (!cur.stoppedAt || (restart && cur.reason !== "restart")) && (cur.stoppedAt || !alive(cur.pid))) {
      const next: Heartbeat = { ...cur, stoppedAt: cur.stoppedAt ?? new Date(d.clock.now()).toISOString(), nextCycleAt: null, ...(restart ? { reason: "restart" as const } : {}) };
      await (d.writeHeartbeat ?? writeHeartbeatMerged)(d.stateDir, next);
    }
  } catch { /* the heartbeat is only a report */ }
  return r;
}

async function stopOnly(d: StopDeps): Promise<StopResult> {
  const net = d.net ?? realSingletonNet;
  const derived = tryAddress(d.stateDir, d.platform, d.addr);
  const hb = await (d.readHeartbeat ?? readHeartbeat)(d.stateDir);
  const hbPid = hb && !hb.stoppedAt ? hb.pid : null;
  const hbStart = hb ? Date.parse(hb.startedAt) : Number.NaN;
  const waitMs = d.waitMs ?? 30_000;
  // Where a 0.2.1 watcher may still be listening; a socket there that is not ours (a link, not a socket, another
  // user's) is ignored entirely: it is neither a watcher to stop nor a reason to report "running".
  const legacyAddr = legacySingletonAddress(d.stateDir, d.platform, d.addr);
  const legacy = legacyAddr !== null && (!net.legacySafe || (await net.legacySafe(legacyAddr))) ? legacyAddr : null;
  // The endpoint the running watcher says it bound: a client whose derived address differs still finds it. Only a
  // socket that is ours (a real socket, not a link, our uid) counts, like the legacy address.
  const hbAddr = hb && !hb.stoppedAt && d.platform !== "win32" && typeof hb.socket === "string" && hb.socket !== derived
    && (!net.legacySafe || (await net.legacySafe(hb.socket))) ? hb.socket : null;
  // An unsafe fallback directory: nothing may be asked of, or believed from, a socket in it. The stop request is
  // skipped; the verified-pid path (command line + start time) still works, and "running" comes from that pid.
  const unsafe = derived === null || (legacyAddr !== null && net.secureDir !== undefined && !(await net.secureDir(dirname(derived))));
  const pidOk = (pid: number): boolean => Number.isInteger(pid) && pid > 1 && pid !== process.pid && (d.pidAlive ?? ((p) => pidAlive(p)))(pid);
  /** The heartbeat pid, when it is alive AND provably a t3sm watcher that started when the heartbeat says (else null). */
  const verifiedPid = async (): Promise<number | null> => {
    const pid = hbPid;
    if (pid === null || !pidOk(pid)) return null;
    const info = await (d.processInfo ?? ((p) => realProcessInfo(p, d.platform, realRunner)))(pid);
    if (info === null || !isT3smWatcher(info.argv ?? info.commandLine)) return null;
    // Pid-reuse guard: the process must have started at (or just before) the heartbeat's startedAt.
    if (!Number.isFinite(info.startedAt) || !Number.isFinite(hbStart) || info.startedAt > hbStart + START_SLACK_MS || hbStart - info.startedAt > START_WINDOW_MS) return null;
    return pid;
  };
  const freeAt = async (a: string | null): Promise<boolean> => a === null || FREE.has(await net.probe(a));
  const isFree = async (): Promise<boolean> => unsafe
    ? (await freeAt(legacy)) && (await freeAt(hbAddr)) && (await verifiedPid()) === null
    : (await freeAt(derived)) && (await freeAt(hbAddr)) && (await freeAt(legacy));
  const waitFree = async (): Promise<boolean> => {
    const end = d.clock.now() + waitMs;
    for (;;) {
      if (await isFree()) return true;
      if (d.clock.now() >= end) return false;
      await sleep(d.clock, POLL_MS);
    }
  };

  // Requests go to the heartbeat's address when there is one, else to the derived one (never into an unsafe directory).
  let r: Awaited<ReturnType<typeof requestWatcherStop>> = hbAddr !== null ? await requestWatcherStop(d.stateDir, d.platform, net, d.addr, hbAddr)
    : unsafe ? "no-watcher" : await requestWatcherStop(d.stateDir, d.platform, net, d.addr, derived ?? undefined);
  // A live legacy address is a 0.2.1 watcher: it never answers, so it takes the verified-pid path.
  if (r === "no-watcher" && legacy !== null && (await net.probe(legacy)) === "alive") r = "closed-without-reply";
  if (r === "no-watcher" && !unsafe) return { how: "none", pid: null, running: !(await isFree()) };
  // A new-protocol watcher whose token write failed refuses every request: that is not the 0.2.1 signature, so it gets the full wait too.
  if (r === "closed-without-reply" && (hb?.protocol ?? 0) >= 1 && !(await access(watcherTokenPath(d.stateDir)).then(() => true, () => false))) r = "timed-out";
  // A slow watcher (answered, or connected without a reply) gets the full wait; a closed socket (0.2.1) skips it.
  if ((r === "stopped" || r === "timed-out") && (await waitFree())) return { how: "request", pid: hbPid, running: false };

  const none = async (): Promise<{ how: "none"; pid: null; running: boolean }> => ({ how: "none", pid: null, running: !(await isFree()) });
  const pid = await verifiedPid();
  if (pid === null) return none();
  try {
    d.kill(pid);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") return { how: "pid", pid, running: true }; // EPERM etc.: it is still there
  }
  await waitFree();
  return { how: "pid", pid, running: !(await isFree()) };
}
