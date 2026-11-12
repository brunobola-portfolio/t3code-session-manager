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
// write a final heartbeat with stoppedAt. Debounce-only cycles run at most once per max(debounce, 2 min). The
// heartbeat is rewritten after every cycle and whenever an event moves the next cycle (serialized writes).
// Single instance: acquireWatcherSingleton (named pipe / unix socket, released by the OS when the process ends).
//
// Watching: fs.watch recursive (native on Windows and macOS; on Linux Node >= 20 emulates it with one inotify watch
// per directory). Where recursive watching is unavailable (ERR_FEATURE_UNAVAILABLE_ON_PLATFORM) each directory down to
// depth 3 is watched on its own (Claude: projects/<dir>/; Codex: sessions/YYYY/MM/DD/), new directories picked up as
// they appear. If watching fails (inotify limit ENOSPC, EMFILE, EPERM, a watcher error) the directory falls back to
// polling: a cycle every 60 s (discovery is cached, so a quiet cycle is cheap).

import { watch as fsWatchReal, readdirSync, type FSWatcher } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ACTIVE_WINDOW_MS } from "../sources/types.ts";
import { STOP_SIGNALS, type SignalSource } from "../apply/apply.ts";
import { resultSummary, type CycleOutcome } from "./sync.ts";

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
}

export interface WatchDeps {
  clock: Clock;
  debounceMs: number;
  everyMinutes: number;
  pid: number;
  /** Directories to watch (existing ones); re-read after every cycle. */
  dirs(): Promise<string[]>;
  watch: WatchFactory;
  cycle(): Promise<CycleOutcome>;
  writeHeartbeat(h: Heartbeat): Promise<void>;
  /** After every cycle (log line, terminal output). Errors are ignored. */
  onCycle?(o: CycleOutcome, at: number): void | Promise<void>;
  signals: SignalSource;
}

const isTranscript = (f: string | null): boolean => f === null || /\.jsonl$/i.test(f);

export function startWatch(deps: WatchDeps): { done: Promise<void>; stop(): void } {
  const { clock } = deps;
  const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());
  const watchers = new Map<string, DirWatch>();
  const hb: Heartbeat = { pid: deps.pid, startedAt: new Date(clock.now()).toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null };
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
    nextAt = null;
    await beat();
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

// ---------- single instance ----------

/**
 * The watcher's single-instance endpoint, derived from the state dir: a named pipe on Windows, a unix socket in the
 * state dir elsewhere (in the temp dir when that path would pass the ~100-byte socket path limit).
 */
export function singletonAddress(stateDir: string, platform: NodeJS.Platform = process.platform): string {
  const h = createHash("sha1").update(resolve(stateDir)).digest("hex").slice(0, 12);
  if (platform === "win32") return `\\\\.\\pipe\\t3sm-watcher-${h}`;
  const inState = join(stateDir, "watcher.sock");
  return Buffer.byteLength(inState) <= 100 ? inState : join(tmpdir(), `t3sm-watcher-${h}.sock`);
}

/** The socket operations acquireWatcherSingleton needs (tests inject a fake). */
export interface SingletonNet {
  /** Bind and listen; "in-use" on EADDRINUSE. The handle is unref'd and closed by release(). */
  listen(addr: string): Promise<{ release(): Promise<void> } | "in-use">;
  /** One connect attempt: "alive" (accepted), "refused" (ECONNREFUSED: a socket file nobody listens on), or "other". */
  probe(addr: string): Promise<"alive" | "refused" | "other">;
  remove(addr: string): Promise<void>;
}

export const realSingletonNet: SingletonNet = {
  listen: (addr) => new Promise((ok, fail) => {
    const srv: Server = createServer((sock) => sock.destroy());
    srv.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" ? ok("in-use") : fail(e)));
    srv.listen(addr, () => {
      srv.unref(); // never keeps the process alive on its own
      ok({ release: () => new Promise<void>((done) => srv.close(() => done())) });
    });
  }),
  probe: (addr) => new Promise((ok) => {
    const c = connect(addr);
    c.once("connect", () => { c.destroy(); ok("alive"); });
    c.once("error", (e: NodeJS.ErrnoException) => ok(e.code === "ECONNREFUSED" ? "refused" : "other"));
  }),
  remove: (addr) => rm(addr, { force: true }),
};

/**
 * Listen on singletonAddress. The OS releases it when the process dies (pipe handle closed / socket closed), so a
 * crashed watcher never blocks the next one; the heartbeat is only for `doctor`. EADDRINUSE = already running.
 * POSIX only: a socket FILE survives a crash. It is removed only when a connect attempt right before fails with
 * ECONNREFUSED (nobody listens: stale); a live or unclear one is never deleted. After removing it the bind is tried
 * once more; if that fails with EADDRINUSE, another watcher bound in between: probe once more (for the record) and
 * report "already running". Never two binds after a removal, never a removal without a fresh ECONNREFUSED.
 */
export async function acquireWatcherSingleton(
  stateDir: string, platform: NodeJS.Platform = process.platform, net: SingletonNet = realSingletonNet,
): Promise<{ release(): Promise<void> } | null> {
  const addr = singletonAddress(stateDir, platform);
  const first = await net.listen(addr);
  if (first !== "in-use") return first;
  if (platform === "win32") return null; // a named pipe in use is a live watcher; nothing to clean up
  if ((await net.probe(addr)) !== "refused") return null; // alive, or not provably stale: leave it alone
  await net.remove(addr);
  const second = await net.listen(addr);
  if (second !== "in-use") return second;
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
