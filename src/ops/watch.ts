// `t3sm sync --watch`: a resident loop around runSyncCycle.
//
// Scheduling (one timer armed at the earliest deadline):
//   - a cycle at start, then a safety-net cycle every schedule.everyMinutes after each cycle;
//   - a transcript event (*.jsonl, or an event without a file name) sets a debounced cycle at event + debounce (each
//     new event pushes it back: bursts coalesce) and a follow-up at event + 10 min + debounce, because a session is
//     importable only once it has been idle for ACTIVE_WINDOW_MS;
//   - events during a cycle (our own file-time bumps, or a session being written) only schedule the follow-up;
//   - T3 down or the lock held: retry in 60 s, the loop keeps running;
//   - errors: back off 1, 2, 5, 10 min (cap); nothing runs earlier; a successful cycle resets it;
//   - a directory that can only be polled adds a cycle every 60 s.
// Exactly one cycle runs at a time; deadlines falling due during a cycle run once right after it.
// SIGINT/SIGTERM: stop after the current cycle (applyPlan itself stops after the running wave), close the watchers,
// write a final heartbeat with stoppedAt. A stop request over the endpoint does the same, and reaches the running cycle
// like SIGTERM (withStopRequest): it stops after its current step instead of running to its end. Debounce-only cycles run at most once per max(debounce, 2 min). The
// heartbeat is rewritten after every cycle and whenever an event moves the next cycle (serialized writes).
// Single instance: acquireWatcherSingleton (named pipe / unix socket, released by the OS when the process ends).
// Updates: after every cycle that does not stop the loop, `afterCycle` runs the daily update check (src/ops/autoUpdate.ts),
// which starts any install in a separate detached process (the install stops this watcher).
// Version: the heartbeat names the watcher's version, install stamp and install root (src/core/version.ts). After every
// cycle the install root's stamp is read again; a different version or stamp (a newer t3sm was installed) stops the
// loop like a stop request, with `reason: "restart"` in the final heartbeat, then calls `restart` (the command releases
// the singleton and spawns a successor from the new install). A stamp that cannot be read never restarts (reported once).
//
// Watching: fs.watch recursive (native on Windows and macOS; on Linux Node >= 20 emulates it with one inotify watch
// per directory). Where recursive watching is unavailable (ERR_FEATURE_UNAVAILABLE_ON_PLATFORM) each directory down to
// depth 3 is watched on its own (Claude: projects/<dir>/; Codex: sessions/YYYY/MM/DD/), new directories picked up as
// they appear. If watching fails (inotify limit ENOSPC, EMFILE, EPERM, a watcher error) the directory falls back to
// polling: a cycle every 60 s (discovery is cached, so a quiet cycle is cheap).

import { watch as fsWatchReal, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, type FSWatcher } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { renameRetrying, type AtomicWriteDeps } from "../core/fsutil.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ACTIVE_WINDOW_MS } from "../sources/types.ts";
import { STOP_SIGNALS, type SignalSource } from "../apply/apply.ts";
import { resultSummary, type CycleOutcome } from "./sync.ts";
import type { InstallStamp } from "../core/version.ts";

export const RETRY_MS = 60_000;
export const POLL_MS = 60_000;
export const BACKOFF_MS = [60_000, 120_000, 300_000, 600_000];
/** Debounce-only cycles run at most once per max(debounce, this). */
export const DEBOUNCE_MIN_GAP_MS = 120_000;
const TIMER_MAX = 2_147_483_647;

export interface Clock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, Math.min(Math.max(0, ms), TIMER_MAX)),
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface DirWatch {
  readonly mode: "recursive" | "per-dir" | "poll";
  close(): void;
}
export type WatchFactory = (dir: string, onEvent: (file: string | null) => void) => DirWatch;

export interface Heartbeat {
  pid: number;
  startedAt: string;
  lastCycleAt: string | null;
  lastResult: Record<string, unknown> | null;
  nextCycleAt: string | null;
  /** Set on a clean stop: the pid no longer belongs to a watcher. */
  stoppedAt?: string;
  /** Set by a watcher that answers stop requests over its endpoint (0.3+); absent on 0.2.1. */
  protocol?: number;
  /** The t3sm version, install stamp and install root this watcher runs (0.3+; absent on 0.2.1). */
  version?: string;
  stamp?: string;
  installRoot?: string;
  /** The endpoint this watcher actually bound (POSIX only; absent on 0.2.x): clients probe it besides the derived address. */
  socket?: string;
  /** With stoppedAt: why it stopped, when not by a stop request ("restart": into a newer install). */
  reason?: "restart";
}

export interface WatchDeps {
  clock: Clock;
  debounceMs: number;
  everyMinutes: number;
  pid: number;
  /** The endpoint the watcher bound, for the heartbeat's `socket` (POSIX only; omit on Windows). */
  socket?: string;
  /** Directories to watch (existing ones); re-read after every cycle. */
  dirs(): Promise<string[]>;
  watch: WatchFactory;
  cycle(): Promise<CycleOutcome>;
  writeHeartbeat(h: Heartbeat): Promise<void>;
  /** After every cycle (log line, terminal output). Errors are ignored. */
  onCycle?(o: CycleOutcome, at: number): void | Promise<void>;
  signals: SignalSource;
  /** What this watcher runs; `read` gives what the install root holds now (checked after every cycle). */
  install?: { root: string; stamp: InstallStamp; read(): InstallStamp | Promise<InstallStamp>; ready?(): boolean | Promise<boolean> };
  /** The version for the heartbeat when there is no install stamp (it could not be read at start). */
  version?: string;
  /** Called once after the final heartbeat of a restart, before `done` resolves (release the singleton, spawn the successor). */
  restart?(next: InstallStamp): Promise<void>;
  /** The install stamp could not be read (once per streak of failed reads). */
  onStampError?(e: unknown): void;
  /**
   * After every cycle that does not stop the watcher (the daily update check, src/ops/autoUpdate.ts), before the next
   * one is armed. Errors are ignored; events meanwhile only schedule the follow-up, as during a cycle. `stopped` says
   * whether a stop arrived meanwhile (then nothing new is started, such as the update child).
   */
  afterCycle?(stopped: () => boolean): Promise<void>;
}

const isTranscript = (f: string | null): boolean => f === null || /\.jsonl$/i.test(f);

export function startWatch(deps: WatchDeps): { done: Promise<void>; stop(): void } {
  const { clock } = deps;
  const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());
  const watchers = new Map<string, DirWatch>();
  const hb: Heartbeat = { pid: deps.pid, startedAt: new Date(clock.now()).toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null, protocol: 1, ...(deps.socket !== undefined ? { socket: deps.socket } : {}) };
  if (deps.install) { hb.version = deps.install.stamp.version; hb.stamp = deps.install.stamp.stamp; hb.installRoot = deps.install.root; }
  else if (deps.version !== undefined) hb.version = deps.version;
  /** Set when the install changed: the loop stops after this cycle and restarts into it. */
  let restartInto: InstallStamp | null = null;
  let stampFailing = false;
  const installChanged = async (): Promise<InstallStamp | null> => {
    const inst = deps.install;
    if (!inst) return null;
    let cur: InstallStamp;
    try { cur = await inst.read(); } catch (e) {
      if (!stampFailing) { stampFailing = true; try { deps.onStampError?.(e); } catch { /* ignore */ } }
      return null;
    }
    stampFailing = false;
    if (cur.version === inst.stamp.version && cur.stamp === inst.stamp.stamp) return null;
    // A new install still being written (or just written) waits for the next cycle.
    try { if (inst.ready && !(await inst.ready())) return null; } catch { return null; }
    return cur;
  };
  let timer: unknown = null;
  let nextAt: number | null = null;
  let running = false;
  let eventsDuringCycle = false;
  let stopping = false;
  let errors = 0;
  let blockedUntil = 0;
  const due = { safety: clock.now() as number | null, debounce: null as number | null, followUp: null as number | null, cycleFollowUp: null as number | null, retry: null as number | null, poll: null as number | null };
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });

  const beat = async (): Promise<void> => {
    hb.nextCycleAt = stopping ? null : iso(nextAt);
    const snapshot = { ...hb };
    // Serialized: a re-arm beat and a cycle-end beat never write concurrently (the last one wins, in order).
    beats = beats.then(async () => { try { await deps.writeHeartbeat(snapshot); } catch { /* best effort */ } });
    await beats;
  };
  let beats: Promise<void> = Promise.resolve();
  let lastBeatNext: number | null = null;
  /** A re-arm moved the next cycle: tell the heartbeat (only when it changed; never while a cycle runs). */
  const beatIfMoved = (): void => {
    if (running || stopping || nextAt === lastBeatNext) return;
    lastBeatNext = nextAt;
    void beat();
  };
  /** Start of the last cycle a debounce deadline triggered (rate limit for debounce-only cycles). */
  let lastDebounceCycle = -Infinity;
  const debounceGap = Math.max(deps.debounceMs, DEBOUNCE_MIN_GAP_MS);

  const arm = (): void => {
    if (timer !== null) { clock.clearTimer(timer); timer = null; }
    nextAt = null;
    if (stopping) return;
    const times = Object.values(due).filter((t): t is number => t !== null);
    if (times.length === 0) return;
    nextAt = Math.max(Math.min(...times), blockedUntil);
    timer = clock.setTimer(fire, nextAt - clock.now());
  };

  const fire = (): void => {
    timer = null;
    if (stopping) return;
    const t = clock.now();
    if (running) return; // never armed while a cycle runs; runCycle re-arms when it ends
    if (due.debounce !== null && due.debounce <= t) lastDebounceCycle = t;
    for (const k of Object.keys(due) as (keyof typeof due)[]) if (due[k] !== null && due[k]! <= t) due[k] = null;
    void runCycle();
  };

  const onEvent = (file: string | null): void => {
    if (stopping || !isTranscript(file)) return;
    if (running) { eventsDuringCycle = true; return; }
    const t = clock.now();
    // Trailing debounce, but at most one debounce-triggered cycle per max(debounce, 2 min): a session written every
    // few seconds for hours must not turn into a cycle every 30 s.
    due.debounce = Math.max(t + deps.debounceMs, lastDebounceCycle + debounceGap);
    due.followUp = t + ACTIVE_WINDOW_MS + deps.debounceMs;
    arm();
    beatIfMoved();
  };

  const syncWatchers = async (): Promise<void> => {
    let dirs: string[];
    try { dirs = await deps.dirs(); } catch { return; }
    const want = new Set(dirs);
    for (const [d, w] of watchers) {
      if (!want.has(d) || w.mode === "poll") { w.close(); watchers.delete(d); }
    }
    for (const d of dirs) {
      if (stopping || watchers.has(d)) continue;
      try { watchers.set(d, deps.watch(d, onEvent)); } catch { watchers.set(d, { mode: "poll", close() {} }); }
    }
  };

  const runCycle = async (): Promise<void> => {
    running = true;
    eventsDuringCycle = false;
    let o: CycleOutcome;
    try { o = await deps.cycle(); } catch (e) { o = { kind: "error", exitCode: 1, error: e }; }
    const t = clock.now();
    hb.lastCycleAt = new Date(t).toISOString();
    hb.lastResult = resultSummary(o);
    due.safety = t + deps.everyMinutes * 60_000;
    due.retry = null;
    if (o.kind === "error") {
      errors++;
      blockedUntil = t + BACKOFF_MS[Math.min(errors, BACKOFF_MS.length) - 1]!;
      due.retry = blockedUntil;
    } else {
      errors = 0;
      blockedUntil = 0;
      if (o.kind === "t3-down" || o.kind === "locked") due.retry = t + RETRY_MS;
    }
    // A follow-up that fell due during the cycle stays due (the session was still active when the cycle started).
    if (eventsDuringCycle) due.cycleFollowUp = t + ACTIVE_WINDOW_MS + deps.debounceMs;
    try { await deps.onCycle?.(o, t); } catch { /* logging never stops the loop */ }
    if (!stopping) {
      restartInto = await installChanged();
      if (restartInto) stopping = true; // a newer install: stop like a stop request, then restart into it
    }
    if (!stopping && deps.afterCycle) { try { await deps.afterCycle(() => stopping); } catch { /* never stops the loop */ } }
    if (!stopping) await syncWatchers();
    due.poll = [...watchers.values()].some((w) => w.mode === "poll") ? t + POLL_MS : null;
    running = false;
    if (stopping) { await finish(); return; }
    arm();
    lastBeatNext = nextAt;
    await beat();
  };

  let finished = false;
  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    if (timer !== null) { clock.clearTimer(timer); timer = null; }
    for (const w of watchers.values()) { try { w.close(); } catch { /* ignore */ } }
    watchers.clear();
    for (const s of STOP_SIGNALS) deps.signals.off(s, stop);
    hb.stoppedAt = new Date(clock.now()).toISOString();
    if (restartInto) hb.reason = "restart";
    nextAt = null;
    await beat();
    if (restartInto && deps.restart) { try { await deps.restart(restartInto); } catch { /* the keep-alive trigger or the next logon starts one */ } }
    resolveDone();
  };

  function stop(): void {
    if (stopping) return;
    stopping = true;
    if (timer !== null) { clock.clearTimer(timer); timer = null; }
    if (!running) void finish();
  }

  for (const s of STOP_SIGNALS) deps.signals.on(s, stop); // SIGHUP: the console window closed
  void (async () => {
    await syncWatchers();
    if (stopping) { await finish(); return; }
    due.poll = [...watchers.values()].some((w) => w.mode === "poll") ? clock.now() + POLL_MS : null;
    arm();
    lastBeatNext = nextAt;
    await beat();
  })();
  return { done, stop };
}

/**
 * The watcher's stop sources in one: the process signals of `base`, plus a stop request over the endpoint (`fire`).
 * `fire` reaches every SIGTERM listener as if the process had been sent SIGTERM once, so a running cycle (applyPlan's
 * waves, organize, follow, merge) stops after its current step exactly as on Ctrl+C, instead of running to its end
 * while the client waits and finally kills it. After `fire`, a listener registered later (a step that starts after the
 * request) is called at once: it never starts work the request already stopped.
 */
export function withStopRequest(base: SignalSource): SignalSource & { fire(): void } {
  const term = new Set<() => void>();
  let fired = false;
  return {
    on(sig, fn) {
      base.on(sig, fn);
      if (sig !== "SIGTERM") return;
      term.add(fn);
      if (fired) fn();
    },
    off(sig, fn) {
      base.off(sig, fn);
      if (sig === "SIGTERM") term.delete(fn);
    },
    fire() {
      if (fired) return;
      fired = true;
      for (const fn of [...term]) { try { fn(); } catch { /* a listener never stops the others */ } }
    },
  };
}

// ---------- single instance ----------

/** The two file operations behind the persisted directory suffix; tests inject an in-memory one. Both may throw. */
export interface SuffixIo {
  read(file: string): string;
  /** Create the file (and its folder) with mode 0600, atomically, never replacing an existing file. */
  create(file: string, content: string): void;
}

export const realSuffixIo: SuffixIo = {
  read: (file) => readFileSync(file, "utf8"),
  create(file, content) {
    mkdirSync(dirname(file), { recursive: true });
    // A random temp name: a leftover from a crashed process whose pid is reused would otherwise fail `wx` forever.
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    try { linkSync(tmp, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } finally { try { unlinkSync(tmp); } catch { /* ignore */ } }
  },
};

/** Where the POSIX fallback socket directory comes from; tests inject it (this host may not be POSIX). */
export interface AddrOpts {
  tmp?: string;
  /** Default process.getuid?.(); `undefined` (no uid on this platform) is a valid injected value. */
  uid?: number | undefined;
  /** Where the directory suffix is read and created; default: the real file system. */
  suffixIo?: SuffixIo;
}

const SUFFIX_FILE = "socket-dir-suffix";
const SUFFIX_RE = /^[0-9a-f]{16}$/;

/** Per process and per SuffixIo: state dir -> suffix. Computed once, so a later transient failure cannot change the address. */
const suffixCache = new WeakMap<SuffixIo, Map<string, string>>();

/**
 * The persisted unguessable part of the fallback directory name: 16 random hex chars, created once in
 * <state>/socket-dir-suffix (0600, atomic, no clobber), read back, and cached for the life of the process. A missing
 * file is created; ANY other failure (unreadable, not creatable, malformed content) throws SocketDirSuffixError:
 * silently using another name would give two processes two different addresses (two watchers, or a stop that
 * misses). A corrupt file is never overwritten.
 */
function socketDirSuffix(stateDir: string, io: SuffixIo): string {
  const file = join(stateDir, SUFFIX_FILE);
  let cache = suffixCache.get(io);
  if (!cache) suffixCache.set(io, (cache = new Map()));
  const hit = cache.get(file);
  if (hit !== undefined) return hit;
  const read = (): string => {
    const v = io.read(file).trim();
    if (!SUFFIX_RE.test(v)) throw new SocketDirSuffixError(file, "its content is not a 16-character hex suffix");
    return v;
  };
  const fail = (e: unknown): never => {
    if (e instanceof SocketDirSuffixError) throw e;
    throw new SocketDirSuffixError(file, (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e)));
  };
  let v: string;
  try {
    try { v = read(); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      io.create(file, `${randomBytes(8).toString("hex")}
`);
      v = read(); // a concurrent creator may have won: always use what is on disk
    }
  } catch (e) { return fail(e); }
  cache.set(file, v);
  return v;
}

/**
 * The directory of the POSIX fallback socket (the state path is too long for a socket): `<tmp>/t3sm-<uid>-<suffix>`
 * with a random suffix persisted in the state dir, so another local user cannot guess (and pre-create) it. Verified
 * (and created 0700) by checkSocketDir before the socket is bound. If the suffix cannot be read or created it throws
 * SocketDirSuffixError (there is no second name: see socketDirSuffix). It deliberately does NOT depend on the
 * environment (no XDG_RUNTIME_DIR): the keep-alive cron job, a login shell and launchd run with different
 * environments and must all compute the same address, or two watchers could run and `stop` would probe the wrong one.
 * Every caller passes the same state dir.
 */
export function fallbackSocketDir(stateDir: string, o: AddrOpts = {}): string {
  const uid = "uid" in o ? o.uid : process.getuid?.();
  return join(o.tmp ?? tmpdir(), `t3sm-${uid ?? "user"}-${socketDirSuffix(stateDir, o.suffixIo ?? realSuffixIo)}`);
}

/**
 * The watcher's single-instance endpoint, derived from the state dir: a named pipe on Windows, a unix socket in the
 * state dir elsewhere (in a per-user 0700 directory under the temp dir, see fallbackSocketDir, when that path would
 * pass the ~100-byte socket path limit). The same for every caller, whatever its environment.
 */
export function singletonAddress(stateDir: string, platform: NodeJS.Platform = process.platform, o: AddrOpts = {}): string {
  const h = createHash("sha1").update(resolve(stateDir)).digest("hex").slice(0, 12);
  if (platform === "win32") return `\\\\.\\pipe\\t3sm-watcher-${h}`;
  const inState = join(stateDir, "watcher.sock");
  return Buffer.byteLength(inState) <= 100 ? inState : join(fallbackSocketDir(stateDir, o), `watcher-${h}.sock`);
}

/**
 * 0.2.1 put the fallback socket directly in the temp dir (<tmp>/t3sm-watcher-<h>.sock). A 0.2.1 watcher may still be
 * running there after an upgrade, so that address is probed too. null when the state path does not need the fallback
 * (and on Windows, where the pipe name never changed).
 */
export function legacySingletonAddress(stateDir: string, platform: NodeJS.Platform = process.platform, o: AddrOpts = {}): string | null {
  if (platform === "win32") return null;
  if (Buffer.byteLength(join(stateDir, "watcher.sock")) <= 100) return null; // the socket lives in the state dir
  return join(o.tmp ?? tmpdir(), `t3sm-watcher-${createHash("sha1").update(resolve(stateDir)).digest("hex").slice(0, 12)}.sock`);
}

/** The fallback socket directory failed checkSocketDir: starting the watcher there is refused (typed, so callers can word it). */
export class UnsafeSocketDirError extends Error {
  readonly dir: string;
  constructor(dir: string, message?: string) {
    super(message ?? `the socket directory ${dir} is not safe (it must be a real directory owned by you with mode 0700, no group or other access). `
      + `Remove or fix it (for example chmod 700 ${dir}), or use a state directory whose path is under 100 bytes. The watcher was not started.`);
    this.name = "UnsafeSocketDirError";
    this.dir = dir;
  }
}

/** The persisted directory suffix could not be read or created: there is no safe address, so nothing is bound (dir = the suffix file). */
export class SocketDirSuffixError extends UnsafeSocketDirError {
  constructor(file: string, why: string) {
    super(file, `the socket directory suffix file ${file} cannot be used (${why}). The watcher needs it to compute its address, `
      + `so it was not started. Fix or remove that file (it is recreated when missing), or use a state directory whose path is under 100 bytes.`);
    this.name = "SocketDirSuffixError";
  }
}

/** What a legacy (0.2.1) socket must be before a live one counts as "a 0.2.1 watcher": ours, a real socket, not a link. */
export interface SocketFs { lstat(p: string): Promise<{ isSymbolicLink(): boolean; isSocket(): boolean; uid: number }> }
export async function checkLegacySocket(addr: string, fs: SocketFs, uid: number | undefined): Promise<boolean> {
  try {
    const st = await fs.lstat(addr);
    return !st.isSymbolicLink() && st.isSocket() && (uid === undefined || st.uid === uid);
  } catch { return false; }
}

/** The fallback directory must be ours alone: a pre-planted or symlinked directory in /tmp must never carry the socket. */
export interface DirFs {
  mkdir(p: string, o: { mode: number }): Promise<unknown>;
  lstat(p: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; uid: number; mode: number }>;
}
/*
 * Accepted TOCTOU: the directory could in theory be swapped between this check and the bind. Nobody but us can do it:
 * it must be owned by this user and 0700, so no other user can create, rename or replace entries in it (replacing the
 * directory itself needs write access to its parent: the same user, or root). A bind onto anything unexpected fails
 * (EADDRINUSE / EACCES) and the watcher does not start: fail safe.
 */
export async function checkSocketDir(dir: string, fs: DirFs, uid: number | undefined): Promise<boolean> {
  try {
    try { await fs.lstat(dir); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
      await fs.mkdir(dir, { mode: 0o700 });
    }
    const st = await fs.lstat(dir);
    return !st.isSymbolicLink() && st.isDirectory() && (uid === undefined || st.uid === uid) && (st.mode & 0o077) === 0;
  } catch { return false; }
}

/** The shared secret a stop request must carry; written by the running watcher, read by the client (same user). */
export const watcherTokenPath = (stateDir: string): string => join(stateDir, "watcher.token");

/** What the endpoint does with a request: `stop <token>` with the right token answers ok and calls onStop. */
export interface WatcherControl { token(): string | null; onStop(): void }

/** The socket operations acquireWatcherSingleton needs (tests inject a fake). */
export interface SingletonNet {
  /** Bind and listen; "in-use" on EADDRINUSE. The handle is unref'd and closed by release(). */
  listen(addr: string, ctl?: WatcherControl): Promise<{ release(): Promise<void> } | "in-use">;
  /**
   * Send one request line. "ok": the watcher answered ok. "no-watcher": nothing listens. "closed": the peer closed the
   * connection without a reply (a watcher from before the protocol, or a refused token). "timed-out": connected but
   * no reply in time (a slow watcher).
   */
  request(addr: string, line: string): Promise<"ok" | "no-watcher" | "closed" | "timed-out">;
  /** One connect attempt: "alive" (accepted), "refused" (ECONNREFUSED), "absent" (ENOENT: no socket file / pipe), or "other". */
  probe(addr: string): Promise<"alive" | "refused" | "absent" | "other">;
  remove(addr: string): Promise<void>;
  /** POSIX fallback directory check (see checkSocketDir); absent on fakes that do not care. */
  secureDir?(dir: string): Promise<boolean>;
  /** Whether a live socket at the legacy address is trustworthy (see checkLegacySocket); absent on fakes = yes. */
  legacySafe?(addr: string): Promise<boolean>;
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const realSingletonNet: SingletonNet = {
  listen: (addr, ctl) => new Promise((ok, fail) => {
    // Protocol: one line `stop <token>` -> "ok", then onStop(). Anything else (or silence) -> the socket is destroyed.
    const srv: Server = createServer((sock) => {
      let buf = "";
      sock.setTimeout(2000, () => sock.destroy());
      sock.on("error", () => sock.destroy());
      sock.on("data", (c) => {
        buf += c.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) { if (buf.length > 128) sock.destroy(); return; }
        const tok = ctl?.token() ?? null;
        if (ctl && tok !== null && safeEqual(buf.slice(0, nl), `stop ${tok}`)) {
          sock.end("ok\n", () => { try { ctl.onStop(); } catch { /* ignore */ } });
        } else sock.destroy();
      });
    });
    const posix = !addr.startsWith("\\\\.\\pipe\\");
    srv.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" ? ok("in-use") : fail(e)));
    srv.listen(addr, () => {
      srv.unref(); // never keeps the process alive on its own
      const done = (): void => ok({ release: () => new Promise<void>((r) => srv.close(() => r())) });
      if (posix) chmod(addr, 0o600).then(done, done); else done(); // owner-only socket, best effort
    });
  }),
  probe: (addr) => new Promise((ok) => {
    const c = connect(addr);
    c.once("connect", () => { c.destroy(); ok("alive"); });
    c.once("error", (e: NodeJS.ErrnoException) => ok(e.code === "ECONNREFUSED" ? "refused" : e.code === "ENOENT" ? "absent" : "other"));
  }),
  request: (addr, line) => new Promise((ok) => {
    let answer = "";
    let settled = false;
    const c = connect(addr);
    const end = (r: "ok" | "no-watcher" | "closed" | "timed-out"): void => { if (settled) return; settled = true; c.destroy(); ok(r); };
    c.setTimeout(3000, () => end("timed-out"));
    c.once("connect", () => c.write(line));
    c.on("data", (d) => { answer += d.toString("utf8"); if (answer.includes("\n")) end(answer.startsWith("ok\n") ? "ok" : "closed"); });
    c.once("close", () => end("closed"));
    c.once("error", (e: NodeJS.ErrnoException) => end(e.code === "ECONNREFUSED" || e.code === "ENOENT" ? "no-watcher" : "closed"));
  }),
  remove: (addr) => rm(addr, { force: true }),
  secureDir: (dir) => checkSocketDir(dir, { mkdir: (p, o) => mkdir(p, o), lstat: (p) => lstat(p) }, process.getuid?.()),
  legacySafe: (addr) => checkLegacySocket(addr, { lstat: (p) => lstat(p) }, process.getuid?.()),
};

/**
 * Write the token owner-only (0600; on Windows the per-user state dir is the protection), atomically. The rename is
 * retried while Windows refuses it (renameRetrying: an antivirus scan holding the old token); the temp file never
 * outlives a failure.
 */
export async function writeToken(stateDir: string, token: string, deps: AtomicWriteDeps = {}): Promise<void> {
  const file = watcherTokenPath(stateDir);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fh = await open(tmp, "w", 0o600);
    try { await fh.writeFile(token, "utf8"); } finally { await fh.close(); }
    await chmod(tmp, 0o600).catch(() => {});
    await renameRetrying(tmp, file, deps);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Listen on singletonAddress. The OS releases it when the process dies (pipe handle closed / socket closed), so a
 * crashed watcher never blocks the next one; the heartbeat is only for `doctor`. EADDRINUSE = already running.
 * POSIX only: a socket FILE survives a crash. It is removed only when a connect attempt right before fails with
 * ECONNREFUSED (nobody listens: stale); a live or unclear one is never deleted. After removing it the bind is tried
 * once more; if that fails with EADDRINUSE, another watcher bound in between: probe once more (for the record) and
 * report "already running". Never two binds after a removal, never a removal without a fresh ECONNREFUSED.
 * With `onStop`, a random token is written to <state>/watcher.token (only after the bind succeeded, so a second
 * instance never overwrites the running watcher's token) and a stop request must carry it; release() removes it.
 */
export async function acquireWatcherSingleton(
  stateDir: string, platform: NodeJS.Platform = process.platform, net: SingletonNet = realSingletonNet,
  onStop?: () => void, addrOpts: AddrOpts = {},
  /** How the token is written (tests inject a refused rename). */
  tokenWriter: (stateDir: string, token: string) => Promise<void> = writeToken,
): Promise<{ release(): Promise<void>; addr?: string } | null> {
  const addr = singletonAddress(stateDir, platform, addrOpts);
  const legacy = legacySingletonAddress(stateDir, platform, addrOpts);
  if (legacy !== null) {
    // A 0.2.1 watcher bound the legacy address: it is running, whatever the new address says. Only a socket that is
    // ours (a real socket, not a link) counts: anyone can create one in the temp dir to keep us from starting.
    if ((await net.probe(legacy)) === "alive" && (!net.legacySafe || (await net.legacySafe(legacy)))) return null;
    if (net.secureDir && !(await net.secureDir(dirname(addr)))) throw new UnsafeSocketDirError(dirname(addr));
  }
  let token: string | null = null;
  const ctl: WatcherControl | undefined = onStop ? { token: () => token, onStop } : undefined;
  const won = async (h: { release(): Promise<void> }): Promise<{ release(): Promise<void>; addr: string }> => {
    if (!ctl) return { release: () => h.release(), addr };
    const t = randomBytes(16).toString("hex");
    // A token a crashed predecessor left behind goes first: were the new one not written, a client sending the old one
    // would read the refusal as the 0.2.1 signature and kill at once instead of waiting (watcherControl).
    await rm(watcherTokenPath(stateDir), { force: true }).catch(() => {});
    try { await tokenWriter(stateDir, t); token = t; } catch { /* no token: stop requests are refused; the verified-pid fallback remains */ }
    return { addr, release: async () => { token = null; await rm(watcherTokenPath(stateDir), { force: true }).catch(() => {}); await h.release(); } };
  };
  const first = await net.listen(addr, ctl);
  if (first !== "in-use") return won(first);
  if (platform === "win32") return null; // a named pipe in use is a live watcher; nothing to clean up
  if ((await net.probe(addr)) !== "refused") return null; // alive, or not provably stale: leave it alone
  await net.remove(addr);
  const second = await net.listen(addr, ctl);
  if (second !== "in-use") return won(second);
  await net.probe(addr); // re-check after the failed bind: someone else won the race; either way we stand down
  return null;
}

export { pidAlive } from "../core/pid.ts";

export async function readHeartbeat(stateDir: string): Promise<Heartbeat | null> {
  try {
    const h = JSON.parse(await readFile(join(stateDir, "sync-status.json"), "utf8")) as Heartbeat;
    return h && typeof h.pid === "number" ? h : null;
  } catch { return null; }
}

type FsWatch = (dir: string, opts: { recursive?: boolean; persistent?: boolean }, listener: (ev: string, file: string | Buffer | null) => void) => FSWatcher;

const PER_DIR_DEPTH = 3;
const PER_DIR_MAX = 2000;

/** One watched directory: recursive, else per directory, else poll (see the header). */
export function createDirWatch(dir: string, onEvent: (file: string | null) => void, o: { fsWatch?: FsWatch } = {}): DirWatch {
  const fsWatch: FsWatch = o.fsWatch ?? (fsWatchReal as unknown as FsWatch);
  const name = (f: string | Buffer | null): string | null => (f === null || f === undefined ? null : String(f));
  let mode: DirWatch["mode"] = "recursive";
  const handles = new Map<string, FSWatcher>();
  const closeAll = (): void => { for (const h of handles.values()) { try { h.close(); } catch { /* ignore */ } } handles.clear(); };
  const toPoll = (): void => { closeAll(); mode = "poll"; };
  const guard = (h: FSWatcher): FSWatcher => { h.on?.("error", () => toPoll()); return h; };

  try {
    handles.set(dir, guard(fsWatch(dir, { recursive: true, persistent: true }, (_e, f) => onEvent(name(f)))));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") {
      toPoll();
    } else {
      mode = "per-dir";
      const add = (d: string, depth: number): void => {
        if (mode !== "per-dir" || handles.has(d)) return;
        if (handles.size >= PER_DIR_MAX) { toPoll(); return; }
        try {
          handles.set(d, guard(fsWatch(d, { persistent: true }, (_e, f) => {
            const n = name(f);
            onEvent(n === null ? null : join(d, n));
            if (n !== null && depth < PER_DIR_DEPTH) add2(join(d, n), depth + 1); // a new subdirectory
          })));
        } catch { toPoll(); return; }
        if (depth >= PER_DIR_DEPTH) return;
        let subs: string[] = [];
        try { subs = readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => join(d, x.name)); } catch { /* gone */ }
        for (const s of subs) add(s, depth + 1);
      };
      const add2 = (p: string, depth: number): void => {
        try { if (readdirSync(p) && !handles.has(p)) add(p, depth); } catch { /* a file, or gone */ }
      };
      add(dir, 0);
    }
  }
  return {
    get mode() { return mode; },
    close: closeAll,
  };
}
