import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, renameSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  BACKOFF_MS, acquireWatcherSingleton, createDirWatch, realSuffixIo, singletonAddress, startWatch, watcherTokenPath, writeToken, type Clock, type DirWatch, type Heartbeat, type SingletonNet, type WatchDeps,
} from "../../src/ops/watch.ts";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { writeScheduleFile } from "../../src/ops/schedule.ts";
import type { CycleOutcome } from "../../src/ops/sync.ts";
import { tempRoot } from "./helpers.ts";
import { dailyUpdateCheck } from "../../src/ops/autoUpdate.ts";
import type { UpdateState } from "../../src/ops/updater.ts";
import type { InstallKind } from "../../src/ops/update.ts";
import type { CommandRunner } from "../../src/core/run.ts";
import type { Config } from "../../src/core/types.ts";

const MIN = 60_000;
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

class FakeClock implements Clock {
  t = 0;
  seq = 0;
  timers: { at: number; fn: () => void; id: number }[] = [];
  now() { return this.t; }
  setTimer(fn: () => void, ms: number) { const id = ++this.seq; this.timers.push({ at: this.t + Math.max(0, ms), fn, id }); return id; }
  clearTimer(h: unknown) { this.timers = this.timers.filter((x) => x.id !== h); }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await flush();
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
    await flush();
  }
}

class FakeSignals {
  handlers = new Map<string, Set<() => void>>();
  on(sig: string, fn: () => void) { (this.handlers.get(sig) ?? this.handlers.set(sig, new Set()).get(sig)!).add(fn); }
  off(sig: string, fn: () => void) { this.handlers.get(sig)?.delete(fn); }
  emit(sig: string) { for (const fn of [...(this.handlers.get(sig) ?? [])]) fn(); }
  count() { return [...this.handlers.values()].reduce((a, s) => a + s.size, 0); }
}

const OK: CycleOutcome = { kind: "noop", runId: null, counts: { imported: 0, failed: 0, deferred: 0, unverified: 0, alreadyInT3: 0, heldForDedupe: 0, heldForAccounts: 0, heldInUse: 0, heldFailed: 0, wouldImport: 0 } };

function harness(outcomes: (CycleOutcome | (() => Promise<CycleOutcome>))[] = [], over: Partial<WatchDeps> = {}) {
  const clock = new FakeClock();
  const signals = new FakeSignals();
  const cycles: number[] = [];
  const beats: Heartbeat[] = [];
  const emitters = new Map<string, (f: string | null) => void>();
  const closed: string[] = [];
  let running = 0;
  let maxRunning = 0;
  let k = 0;
  const deps: WatchDeps = {
    clock, signals, pid: 4242, debounceMs: 30_000, everyMinutes: 15,
    dirs: async () => ["/acc/.claude/projects", "/home/.codex/sessions"],
    watch: (dir, onEvent): DirWatch => { emitters.set(dir, onEvent); return { mode: "recursive", close: () => void closed.push(dir) }; },
    cycle: async () => {
      cycles.push(clock.now());
      running++; maxRunning = Math.max(maxRunning, running);
      try {
        const o = outcomes[Math.min(k++, Math.max(0, outcomes.length - 1))] ?? OK;
        return typeof o === "function" ? await o() : o;
      } finally { running--; }
    },
    writeHeartbeat: async (h) => void beats.push(structuredClone(h)),
    ...over,
  };
  const w = startWatch(deps);
  const emit = (file: string | null = "C--work-demo/a.jsonl", dir = "/acc/.claude/projects") => emitters.get(dir)!(file);
  return { clock, signals, cycles, beats, emit, closed, w, deps, maxRunning: () => maxRunning };
}

test("watch: the heartbeat names the socket the watcher bound (POSIX only; absent otherwise)", async () => {
  const h = harness([], { socket: "/tmp/t3sm-1000-0123456789abcdef/watcher-aaaaaaaaaaaa.sock" });
  await h.clock.advance(0);
  assert.equal(h.beats.at(-1)?.socket, "/tmp/t3sm-1000-0123456789abcdef/watcher-aaaaaaaaaaaa.sock");
  h.signals.emit("SIGINT");
  await h.w.done;
  const plain = harness();
  await plain.clock.advance(0);
  assert.equal("socket" in plain.beats.at(-1)!, false);
  plain.signals.emit("SIGINT");
  await plain.w.done;
});

test("watch: an initial cycle at start, then three events within the debounce window trigger exactly one cycle", async () => {
  const h = harness();
  await h.clock.advance(0);
  assert.deepEqual(h.cycles, [0]);
  await h.clock.advance(1000); h.emit();
  await h.clock.advance(1000); h.emit();
  await h.clock.advance(1000); h.emit("C--work-demo/b.jsonl");
  await h.clock.advance(29_999);
  assert.deepEqual(h.cycles, [0], "not before the debounce after the LAST event");
  await h.clock.advance(1);
  assert.deepEqual(h.cycles, [0, 33_000]);
  await h.clock.advance(60_000);
  assert.deepEqual(h.cycles, [0, 33_000], "coalesced into one");
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("watch: a follow-up cycle at last event + 10 min + debounce (sessions import only once inactive)", async () => {
  const h = harness();
  await h.clock.advance(3000); h.emit();
  await h.clock.advance(600_000 + 30_000 - 1);
  assert.deepEqual(h.cycles, [0, 33_000]);
  await h.clock.advance(1);
  assert.deepEqual(h.cycles, [0, 33_000, 633_000]);
  h.signals.emit("SIGTERM");
  await h.w.done;
});

test("watch: debounce-only cycles are rate-limited to one per max(debounce, 2 min)", async () => {
  const h = harness();
  await h.clock.advance(3000); h.emit();
  await h.clock.advance(30_000);
  assert.deepEqual(h.cycles, [0, 33_000]);
  await h.clock.advance(7000); h.emit(); // 40 s: a debounce at 70 s would be the second in 37 s
  await h.clock.advance(80_000);
  assert.deepEqual(h.cycles, [0, 33_000], "held back");
  await h.clock.advance(33_000);
  assert.deepEqual(h.cycles, [0, 33_000, 153_000], "33 s + 120 s");
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("watch: the heartbeat follows a re-arm (an event moves nextCycleAt)", async () => {
  const h = harness();
  await h.clock.advance(0);
  assert.equal(h.beats.at(-1)!.nextCycleAt, new Date(15 * MIN).toISOString());
  await h.clock.advance(1000); h.emit();
  await h.clock.advance(0);
  assert.equal(h.beats.at(-1)!.nextCycleAt, new Date(31_000).toISOString());
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("watch: non-transcript events are ignored", async () => {
  const h = harness();
  await h.clock.advance(1000);
  h.emit("C--work-demo/abc/tool-results/x.txt");
  h.emit("C--work-demo/notes.json");
  await h.clock.advance(120_000);
  assert.deepEqual(h.cycles, [0]);
  h.emit(null); // platform gave no file name: counts
  await h.clock.advance(30_000);
  assert.deepEqual(h.cycles, [0, 151_000]);
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("watch: a safety-net cycle every schedule.everyMinutes without any event", async () => {
  const h = harness();
  await h.clock.advance(15 * MIN);
  assert.deepEqual(h.cycles, [0, 15 * MIN]);
  await h.clock.advance(15 * MIN);
  assert.deepEqual(h.cycles, [0, 15 * MIN, 30 * MIN]);
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("watch: exactly one cycle at a time; events during a cycle schedule only the follow-up", async () => {
  let release!: () => void;
  const slow = () => new Promise<CycleOutcome>((r) => { release = () => r(OK); });
  const h = harness([OK, slow, OK]);
  await h.clock.advance(1000); h.emit();
  await h.clock.advance(30_000); // second cycle starts at 31_000 and hangs
  assert.deepEqual(h.cycles, [0, 31_000]);
  h.emit(); // during the cycle (our own bumps or a live session)
  await h.clock.advance(20 * MIN); // safety net and debounce would be due: still one cycle running
  assert.deepEqual(h.cycles, [0, 31_000]);
  assert.equal(h.maxRunning(), 1);
  release();
  await h.clock.advance(0);
  // ended at 31_000 + 20 min: the follow-up for the event at 1 s (due at 631 s, during the cycle) runs once right away
  const end = 31_000 + 20 * MIN;
  assert.deepEqual(h.cycles, [0, 31_000, end]);
  assert.equal(h.maxRunning(), 1);
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("watch: T3 down (or lock held) keeps the loop alive and retries every 60 s", async () => {
  const h = harness([{ kind: "t3-down" }, { kind: "t3-down" }, { kind: "locked" }, OK]);
  await h.clock.advance(0);
  await h.clock.advance(MIN);
  await h.clock.advance(MIN);
  await h.clock.advance(MIN);
  assert.deepEqual(h.cycles, [0, MIN, 2 * MIN, 3 * MIN]);
  await h.clock.advance(MIN);
  assert.deepEqual(h.cycles, [0, MIN, 2 * MIN, 3 * MIN], "after a successful cycle back to the safety net");
  assert.equal(h.beats.at(-1)!.lastResult!.outcome, "noop");
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("watch: backoff after errors 1, 2, 5, 10 min (cap); events cannot bypass it; success resets", async () => {
  const err: CycleOutcome = { kind: "error", exitCode: 1, error: new Error("boom") };
  assert.deepEqual(BACKOFF_MS, [MIN, 2 * MIN, 5 * MIN, 10 * MIN]);
  const h = harness([err, err, err, err, err, OK, err]);
  await h.clock.advance(0);
  h.emit(); // debounce would fire at 30 s; backoff holds it until 60 s
  await h.clock.advance(59_999);
  assert.deepEqual(h.cycles, [0]);
  await h.clock.advance(1);
  assert.deepEqual(h.cycles, [0, MIN]);
  await h.clock.advance(2 * MIN);
  await h.clock.advance(5 * MIN);
  await h.clock.advance(10 * MIN);
  await h.clock.advance(10 * MIN);
  assert.deepEqual(h.cycles, [0, 1, 3, 8, 18, 28].map((m) => m * MIN));
  await h.clock.advance(15 * MIN); // OK at 28 min was the 6th; next: safety at 43 -> err -> 1 min
  await h.clock.advance(MIN);
  assert.deepEqual(h.cycles.slice(6), [43 * MIN, 44 * MIN]);
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("watch: heartbeat carries pid, startedAt, lastCycleAt, lastResult and nextCycleAt; stop marks it stopped", async () => {
  const h = harness([{ kind: "ok", runId: "20261111-120000-abcd", counts: { ...OK.counts, imported: 3 } }]);
  await h.clock.advance(0);
  const b = h.beats.at(-1)!;
  assert.equal(b.pid, 4242);
  assert.equal(b.startedAt, new Date(0).toISOString());
  assert.equal(b.lastCycleAt, new Date(0).toISOString());
  assert.deepEqual(b.lastResult, { outcome: "ok", runId: "20261111-120000-abcd", imported: 3, failed: 0, deferred: 0, heldInUse: 0, heldForDedupe: 0, heldForAccounts: 0, heldFailed: 0 });
  assert.equal(b.nextCycleAt, new Date(15 * MIN).toISOString());
  assert.equal(b.stoppedAt, undefined);
  h.signals.emit("SIGINT");
  await h.w.done;
  const last = h.beats.at(-1)!;
  assert.equal(typeof last.stoppedAt, "string");
  assert.equal(last.nextCycleAt, null);
});

test("watch: a held project reaches the heartbeat as its name, title and time only, never its folder or transcript path", async () => {
  const held = [{ project: "demo", root: "C:/work/demo", file: "C:/Users/demo/.claude/projects/C--work-demo/a.jsonl", title: "Synthetic work", modifiedAt: new Date(0).toISOString() }];
  const h = harness([{ kind: "ok", runId: "20261111-120000-abcd", counts: OK.counts, held }]);
  await h.clock.advance(0);
  const b = h.beats.at(-1)!;
  assert.deepEqual(b.lastResult!["held"], [{ project: "demo", title: "Synthetic work", modifiedAt: new Date(0).toISOString() }]);
  assert.doesNotMatch(JSON.stringify(b), /C:\/|\.jsonl/);
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("watch: SIGINT during a cycle stops cleanly after it, closes watchers and removes its signal handlers", async () => {
  let release!: () => void;
  const slow = () => new Promise<CycleOutcome>((r) => { release = () => r(OK); });
  const h = harness([slow, OK]);
  await h.clock.advance(0);
  assert.equal(h.signals.count(), 3, "SIGINT, SIGTERM and SIGHUP");
  h.signals.emit("SIGINT");
  let finished = false;
  void h.w.done.then(() => { finished = true; });
  await h.clock.advance(MIN);
  assert.equal(finished, false, "waits for the running cycle");
  release();
  await h.clock.advance(0);
  await h.w.done;
  assert.deepEqual(h.cycles, [0]);
  assert.deepEqual(h.closed.sort(), ["/acc/.claude/projects", "/home/.codex/sessions"]);
  assert.equal(h.signals.count(), 0);
  assert.equal(h.clock.timers.length, 0, "no timer left behind");
});

test("watch: a watcher in poll mode adds a cycle every 60 s", async () => {
  const h = harness([], { watch: () => ({ mode: "poll", close: () => {} }) });
  await h.clock.advance(3 * MIN);
  assert.deepEqual(h.cycles, [0, MIN, 2 * MIN, 3 * MIN]);
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("createDirWatch: recursive where supported, per-directory fallback, polling when watching fails", () => {
  const t = tempRoot();
  mkdirSync(join(t.projects, "C--work-a"), { recursive: true });
  mkdirSync(join(t.projects, "C--work-b"), { recursive: true });
  const watched: { dir: string; recursive: boolean }[] = [];
  const fake = (mode: "ok" | "no-recursive" | "enospc") => ((dir: string, opts: { recursive?: boolean }) => {
    if (opts.recursive && mode !== "ok") throw Object.assign(new Error("x"), { code: mode === "no-recursive" ? "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" : "ENOSPC" });
    if (mode === "enospc") throw Object.assign(new Error("x"), { code: "ENOSPC" });
    watched.push({ dir, recursive: !!opts.recursive });
    return { close() {}, on() { return this; } };
  }) as never;
  const a = createDirWatch(t.projects, () => {}, { fsWatch: fake("ok") });
  assert.equal(a.mode, "recursive");
  assert.deepEqual(watched, [{ dir: t.projects, recursive: true }]);
  watched.length = 0;
  const b = createDirWatch(t.projects, () => {}, { fsWatch: fake("no-recursive") });
  assert.equal(b.mode, "per-dir");
  assert.deepEqual(watched.map((w) => w.dir).sort(), [t.projects, join(t.projects, "C--work-a"), join(t.projects, "C--work-b")].sort());
  assert.ok(watched.every((w) => !w.recursive));
  const c = createDirWatch(t.projects, () => {}, { fsWatch: fake("enospc") });
  assert.equal(c.mode, "poll");
  a.close(); b.close(); c.close();
});

test("acquireWatcherSingleton: an OS-released endpoint (named pipe / unix socket); the second holder is refused until release", async () => {
  const t = tempRoot();
  mkdirSync(t.state, { recursive: true });
  const addr = singletonAddress(t.state);
  if (process.platform === "win32") assert.ok(addr.startsWith("\\\\.\\pipe\\t3sm-watcher-") && /-[0-9a-f]{12}$/.test(addr), addr);
  else assert.ok(addr.endsWith(".sock"));
  assert.equal(singletonAddress(t.state), addr, "stable per state dir");
  assert.notEqual(singletonAddress(join(t.state, "x")), addr);
  const a = await acquireWatcherSingleton(t.state);
  assert.ok(a, "first acquires");
  assert.equal(await acquireWatcherSingleton(t.state), null, "second refused");
  await a!.release();
  const b = await acquireWatcherSingleton(t.state);
  assert.ok(b, "free again after release");
  await b!.release();
});

test("acquireWatcherSingleton (POSIX): a stale socket file left by a crash is removed", { skip: process.platform === "win32" }, async () => {
  const t = tempRoot();
  mkdirSync(t.state, { recursive: true });
  const addr = singletonAddress(t.state);
  // A real socket file nobody listens on, as a crashed watcher leaves it. (An empty regular file would not do: a
  // connect to one is refused on Linux but fails with ENOTSOCK on macOS, where the file is rightly left alone.)
  // close() unlinks the path the server bound, so the socket is moved aside while it closes.
  const crashed = createServer();
  await new Promise<void>((ok, fail) => { crashed.once("error", fail); crashed.listen(addr, ok); });
  renameSync(addr, `${addr}.aside`);
  await new Promise<void>((ok) => crashed.close(() => ok()));
  renameSync(`${addr}.aside`, addr);
  assert.ok(statSync(addr).isSocket(), "a socket file is left behind");
  const a = await acquireWatcherSingleton(t.state);
  assert.ok(a, "the stale socket was removed and the address bound");
  assert.equal(await acquireWatcherSingleton(t.state), null, "now held: a second watcher is refused");
  await a!.release();
});

test("createDirWatch per-directory fallback: smoke test with 100 project folders, new folders picked up", () => {
  const t = tempRoot();
  for (let i = 0; i < 100; i++) mkdirSync(join(t.projects, `C--work-p${i}`), { recursive: true });
  const watched = new Map<string, (ev: string, f: string | null) => void>();
  const events: (string | null)[] = [];
  const fake = ((dir: string, opts: { recursive?: boolean }, cb: (ev: string, f: string | null) => void) => {
    if (opts.recursive) throw Object.assign(new Error("x"), { code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" });
    watched.set(dir, cb);
    return { close() { watched.delete(dir); }, on() { return this; } };
  }) as never;
  const w = createDirWatch(t.projects, (f) => void events.push(f), { fsWatch: fake });
  assert.equal(w.mode, "per-dir");
  assert.equal(watched.size, 101);
  mkdirSync(join(t.projects, "C--work-new"));
  watched.get(t.projects)!("rename", "C--work-new");
  assert.equal(watched.size, 102, "new project folder watched");
  watched.get(join(t.projects, "C--work-p7"))!("change", "abc.jsonl");
  assert.ok(events.some((e) => e !== null && e.endsWith("abc.jsonl")));
  w.close();
  assert.equal(watched.size, 0);
});

function fakeNet(script: { listen: ("ok" | "in-use")[]; probe: ("alive" | "refused" | "other")[] }) {
  const log: string[] = [];
  const net: SingletonNet = {
    listen: async (a) => { log.push(`listen`); const r = script.listen.shift() ?? "in-use"; return r === "ok" ? { release: async () => void log.push("release") } : "in-use"; },
    probe: async () => { log.push("probe"); return script.probe.shift() ?? "other"; },
    request: async () => "no-watcher",
    remove: async () => void log.push("remove"),
  };
  return { net, log };
}

test("acquireWatcherSingleton (injected net): a stale socket (ECONNREFUSED right before) is removed and the bind retried once", async () => {
  const f = fakeNet({ listen: ["in-use", "ok"], probe: ["refused"] });
  assert.ok(await acquireWatcherSingleton("/s", "linux", f.net));
  assert.deepEqual(f.log, ["listen", "probe", "remove", "listen"]);
});

test("acquireWatcherSingleton (injected net): another watcher binding right after the removal wins; we re-check and stand down", async () => {
  const f = fakeNet({ listen: ["in-use", "in-use"], probe: ["refused", "alive"] });
  assert.equal(await acquireWatcherSingleton("/s", "linux", f.net), null);
  assert.deepEqual(f.log, ["listen", "probe", "remove", "listen", "probe"], "one removal, never a second one");
});

test("acquireWatcherSingleton (injected net): a live or unclear socket is never removed; a busy pipe on Windows is never probed", async () => {
  for (const p of ["alive", "other"] as const) {
    const f = fakeNet({ listen: ["in-use"], probe: [p] });
    assert.equal(await acquireWatcherSingleton("/s", "linux", f.net), null);
    assert.deepEqual(f.log, ["listen", "probe"]);
  }
  const w = fakeNet({ listen: ["in-use"], probe: ["refused"] });
  assert.equal(await acquireWatcherSingleton("C:/s", "win32", w.net), null);
  assert.deepEqual(w.log, ["listen"]);
});

test("singletonAddress (POSIX): a state dir path too long for a socket falls back to a per-user directory under the temp dir", () => {
  const long = join(tempRoot().root, "a".repeat(120));
  const addr = singletonAddress(long, "linux");
  assert.match(addr, /[\\/]t3sm-[^\\/]+[\\/]watcher-[0-9a-f]{12}\.sock$/);
  assert.equal(singletonAddress("/short", "linux").endsWith("watcher.sock"), true);
});

// ---------- version awareness (self-restart) ----------

const A = { version: "0.3.0", stamp: "2026-11-15T10:00:00.000Z" };
const B = { version: "0.3.1", stamp: "2026-11-16T10:00:00.000Z" };

test("watch: new stamp: one successor spawned after the cycle, pipe released first (heartbeat stoppedAt + reason restart, then restart, then done)", async () => {
  const order: string[] = [];
  let release!: () => void;
  let reads = 0;
  const stamps = [A, B];
  const h = harness([async () => { order.push("cycle"); await new Promise<void>((r) => { release = r; }); return OK; }], {
    install: { root: "C:/work/t3sm", stamp: A, read: () => { order.push("read"); return stamps[Math.min(reads++, stamps.length - 1)]!; } },
    restart: async (next) => { order.push(`restart:${next.version}`); },
  });
  await h.clock.advance(0);
  assert.equal(h.beats.at(-1)!.version, "0.3.0");
  assert.equal(h.beats.at(-1)!.stamp, A.stamp);
  assert.equal(h.beats.at(-1)!.installRoot, "C:/work/t3sm");
  release();
  await h.clock.advance(0); // first cycle ends: stamp A, same as at start
  assert.deepEqual(order, ["cycle", "read"]);
  await h.clock.advance(15 * MIN); // second cycle: the install now says B
  release();
  await h.w.done;
  assert.deepEqual(order, ["cycle", "read", "cycle", "read", "restart:0.3.1"]);
  const last = h.beats.at(-1)!;
  assert.equal(typeof last.stoppedAt, "string");
  assert.equal(last.reason, "restart");
  assert.equal(last.version, "0.3.0", "the heartbeat names the version that stopped");
  assert.equal(last.nextCycleAt, null);
  assert.equal(h.signals.count(), 0, "signal handlers removed");
  assert.deepEqual(h.closed.sort(), ["/acc/.claude/projects", "/home/.codex/sessions"]);
  await h.clock.advance(60 * MIN);
  assert.equal(h.cycles.length, 2, "no cycle after the restart");
});

test("watch: same stamp: no restart; a different version with the same stamp restarts too", async () => {
  let restarts = 0;
  const h = harness([], { install: { root: "/opt/t3sm", stamp: A, read: () => ({ ...A }) }, restart: async () => { restarts++; } });
  await h.clock.advance(60 * MIN);
  assert.ok(h.cycles.length >= 4);
  assert.equal(restarts, 0);
  assert.equal(h.beats.at(-1)!.reason, undefined);
  h.signals.emit("SIGINT");
  await h.w.done;
  assert.equal(h.beats.at(-1)!.reason, undefined, "a plain stop has no restart reason");
  assert.equal(restarts, 0);

  const v = harness([], { install: { root: "/opt/t3sm", stamp: A, read: () => ({ ...A, version: "0.3.1" }) }, restart: async () => { restarts++; } });
  await v.clock.advance(0);
  await v.w.done;
  assert.equal(restarts, 1);
  assert.equal(v.cycles.length, 1);
});

test("watch: an unreadable install stamp never restarts and is reported once", async () => {
  let restarts = 0;
  const errors: unknown[] = [];
  const h = harness([], {
    install: { root: "/opt/t3sm", stamp: A, read: () => { throw new Error("ENOENT dist/build.json"); } },
    restart: async () => { restarts++; },
    onStampError: (e) => void errors.push(e),
  });
  await h.clock.advance(60 * MIN);
  assert.ok(h.cycles.length >= 4);
  assert.equal(restarts, 0);
  assert.equal(errors.length, 1);
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("watch: a new install that is not complete and settled yet waits for the next cycle", async () => {
  let restarts = 0;
  let ready = false;
  const h = harness([], { install: { root: "/opt/t3sm", stamp: A, read: () => B, ready: () => ready }, restart: async () => { restarts++; } });
  await h.clock.advance(0);
  await h.clock.advance(15 * MIN);
  assert.equal(h.cycles.length, 2);
  assert.equal(restarts, 0, "not while the install is still being written");
  ready = true;
  await h.clock.advance(15 * MIN);
  await h.w.done;
  assert.equal(restarts, 1);
  assert.equal(h.cycles.length, 3);
});

test("watch: without an install stamp the heartbeat still names the version", async () => {
  const h = harness([], { version: "0.3.0" });
  await h.clock.advance(0);
  assert.equal(h.beats.at(-1)!.version, "0.3.0");
  assert.equal(h.beats.at(-1)!.stamp, undefined);
  h.signals.emit("SIGINT");
  await h.w.done;
});

// ---------- the daily update check (Task 14) ----------

/** The daily check over an in-memory update.json and lock: everything settles within the fake clock's flushes. */
function checker(o: { tags: string[] | null; kind?: InstallKind; auto?: boolean; state?: UpdateState; retryAt?: number }) {
  let state: UpdateState | null = o.state ?? null;
  let retry: number | null = o.retryAt ?? null;
  const queries: string[][] = [];
  const logs: string[] = [];
  let spawned = 0;
  const announced: string[] = [];
  let clock: Clock | null = null;
  const run: CommandRunner = async (cmd, args) => {
    queries.push([cmd, ...args]);
    if (o.tags === null) return { code: 128, stdout: "", stderr: "fatal: unable to access" };
    return { code: 0, stdout: o.tags.map((v) => `${"a".repeat(40)}\trefs/tags/${v}`).join("\n"), stderr: "" };
  };
  const check = dailyUpdateCheck({
    stateDir: "/unused", installed: () => "0.3.0", kind: o.kind ?? "global",
    config: async () => (o.auto === false ? { update: { auto: false } } as Config : null),
    defaultSource: { kind: "github", repo: "demo-owner/demo-app" }, run, platform: "win32",
    now: () => clock!.now(), spawnUpdate: () => void spawned++, log: (l) => void logs.push(l),
    announce: async (v) => void announced.push(v),
    store: { read: async () => state, write: async (s) => { state = structuredClone(s); }, retryAt: async () => retry, clearRetry: async () => { retry = null; } },
    lock: async () => ({ release: async () => {} }),
  });
  return {
    check, queries, logs, announced, spawned: () => spawned, state: () => state, retry: () => retry,
    use(c: Clock) { clock = c; },
  };
}

test("watcher checks once per day and starts one update child", async () => {
  const c = checker({ tags: ["v0.2.1", "v0.3.0", "v0.3.1"] });
  const h = harness([], { afterCycle: async () => { await c.check.check(); } });
  c.use(h.clock);
  await h.clock.advance(23 * 60 * MIN); // a cycle every 15 min: about 92 of them
  assert.ok(h.cycles.length > 80);
  assert.equal(c.queries.length, 1, "one lookup in the first day");
  assert.equal(c.spawned(), 1, "one update child");
  assert.equal(c.state()?.lastCheckAt, new Date(0).toISOString());
  assert.equal(c.state()?.available, null, "a patch is installed by the child, not announced");
  await h.clock.advance(2 * 60 * MIN);
  assert.equal(c.queries.length, 2, "the next day: one more");
  assert.equal(c.spawned(), 2);
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("major: announced once, not installed", async () => {
  const c = checker({ tags: ["v0.3.0", "v1.0.0"] });
  const h = harness([], { afterCycle: async () => { await c.check.check(); } });
  c.use(h.clock);
  await h.clock.advance(3 * 24 * 60 * MIN - MIN); // checks at 0, 24 h and 48 h
  assert.equal(c.queries.length, 3, "checked each day");
  assert.equal(c.spawned(), 0, "a major is never installed by itself");
  assert.deepEqual(c.announced, ["1.0.0"], "announced once");
  assert.equal(c.state()?.available, "1.0.0");
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("daily check offline: silent, logged once, retried after an hour", async () => {
  const c = checker({ tags: null });
  const h = harness([], { afterCycle: async () => { await c.check.check(); } });
  c.use(h.clock);
  await h.clock.advance(150 * MIN);
  assert.equal(c.queries.length, 3 * 2, "git, then npm, at 0, 60 and 120 min");
  assert.deepEqual(c.logs, ["update-check unavailable"], "logged once per streak");
  assert.equal(c.state(), null, "nothing recorded: the next try comes soon");
  assert.equal(c.spawned(), 0);
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("daily check: auto off or a checkout never looks anything up", async () => {
  for (const o of [{ auto: false }, { kind: "checkout" as const }, { kind: "npx" as const }]) {
    const c = checker({ tags: ["v0.3.1"], ...o });
    const h = harness([], { afterCycle: async () => { await c.check.check(); } });
    c.use(h.clock);
    await h.clock.advance(30 * MIN);
    assert.deepEqual(c.queries, [], JSON.stringify(o));
    assert.equal(c.spawned(), 0);
    h.signals.emit("SIGINT");
    await h.w.done;
  }
});

test("watch: afterCycle runs after each cycle; its errors never stop the loop; not when stopping", async () => {
  let n = 0;
  const h = harness([], { afterCycle: async () => { n++; throw new Error("boom"); } });
  await h.clock.advance(31 * MIN);
  assert.equal(h.cycles.length, 3);
  assert.equal(n, 3);
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("daily check: an answer without any release still counts as a check (only offline retries hourly)", async () => {
  const c = checker({ tags: [] });
  const h = harness([], { afterCycle: async () => { await c.check.check(); } });
  c.use(h.clock);
  await h.clock.advance(5 * 60 * MIN);
  assert.equal(c.queries.length, 1, "one lookup: the next is a day later");
  assert.equal(c.state()?.lastCheckAt, new Date(0).toISOString());
  assert.deepEqual(c.logs, []);
  h.signals.emit("SIGINT");
  await h.w.done;
});

test("daily check: a version that was rolled back is never started again", async () => {
  const c = checker({ tags: ["v0.3.0", "v0.3.1"], state: { source: { kind: "github", repo: "demo-owner/demo-app" }, lastCheckAt: null, previous: null, available: null, skip: ["0.3.1"] } });
  c.use({ now: () => 0, setTimer: () => 0, clearTimer: () => {} });
  assert.deepEqual(await c.check.check(), { kind: "checked", latest: "0.3.0", install: null, major: null });
  assert.equal(c.spawned(), 0);
});

test("daily check: an update child that found the lock busy asks for a retry within the hour", async () => {
  // The check ran at 0 (lastCheckAt) and started a child, which found the lock taken and asked for a retry at +60 min.
  const c = checker({ tags: ["v0.3.0", "v0.3.1"], state: { source: { kind: "github", repo: "demo-owner/demo-app" }, lastCheckAt: new Date(0).toISOString(), previous: null, available: null, skip: [] }, retryAt: 60 * MIN });
  let t = 30 * MIN;
  c.use({ now: () => t, setTimer: () => 0, clearTimer: () => {} });
  assert.deepEqual(await c.check.check(), { kind: "skipped", why: "not-due" });
  t = 60 * MIN;
  assert.equal((await c.check.check()).kind, "checked");
  assert.equal(c.spawned(), 1);
  assert.equal(c.retry(), null, "the request is used up");
});

const refusedRename = (): NodeJS.ErrnoException => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });

test("writeToken: a rename Windows refuses for a moment (an antivirus scan) is retried; one that stays refused throws and leaves no temp file", async () => {
  const t = tempRoot();
  mkdirSync(t.state, { recursive: true });
  writeFileSync(watcherTokenPath(t.state), "old-token");
  let calls = 0;
  const slept: number[] = [];
  const moved: string[] = [];
  await writeToken(t.state, "new-token", {
    rename: async (a) => { if (++calls <= 2) throw refusedRename(); moved.push(readFileSync(a, "utf8")); renameSync(a, watcherTokenPath(t.state)); },
    sleep: async (ms) => void slept.push(ms),
  });
  assert.equal(calls, 3);
  assert.deepEqual(slept, [10, 20]);
  assert.deepEqual(moved, ["new-token"]);
  assert.equal(readFileSync(watcherTokenPath(t.state), "utf8"), "new-token");
  await assert.rejects(writeToken(t.state, "x", { rename: async () => { throw refusedRename(); }, sleep: async () => {} }), { code: "EPERM" });
  assert.deepEqual(readdirSync(t.state), ["watcher.token"], "no temp file left");
});

test("acquireWatcherSingleton: a token a crashed watcher left is removed before the new one is written (a failed write leaves none)", async () => {
  const t = tempRoot();
  mkdirSync(t.state, { recursive: true });
  writeFileSync(watcherTokenPath(t.state), "stale-token-of-a-crashed-watcher");
  const net: SingletonNet = { listen: async () => ({ release: async () => {} }), probe: async () => "absent", request: async () => "no-watcher", remove: async () => {} };
  const h = await acquireWatcherSingleton(t.state, "win32", net, () => {}, {}, async () => { throw refusedRename(); });
  assert.ok(h);
  assert.equal(existsSync(watcherTokenPath(t.state)), false, "a client never sends the stale token (it would read the refusal as a 0.2.1 watcher and kill at once)");
  await h.release();
});

test("writeScheduleFile: the task XML's rename over the old one is retried while Windows refuses it", async () => {
  const t = tempRoot();
  const path = join(t.state, "schedule", "t3sm-task.xml");
  let calls = 0;
  await writeScheduleFile({ path, content: "<Task>a</Task>", encoding: "utf16le-bom" });
  await writeScheduleFile({ path, content: "<Task>b</Task>", encoding: "utf16le-bom" }, {
    rename: async (a, b) => { if (++calls <= 3) throw refusedRename(); renameSync(a, b); },
    sleep: async () => {},
  });
  assert.equal(calls, 4);
  assert.equal(readFileSync(path).subarray(2).toString("utf16le"), "<Task>b</Task>");
  assert.deepEqual(readdirSync(join(t.state, "schedule")), ["t3sm-task.xml"]);
});

test("socket dir suffix: a temp file a crashed process left under its (reused) pid never blocks creating the suffix", () => {
  const t = tempRoot();
  mkdirSync(t.state, { recursive: true });
  const file = join(t.state, "socket-dir-suffix");
  writeFileSync(`${file}.${process.pid}.tmp`, "leftover");
  realSuffixIo.create(file, "0123456789abcdef");
  assert.equal(readFileSync(file, "utf8"), "0123456789abcdef");
});

test("withStopRequest: fire reaches each SIGTERM listener once (as one SIGTERM), later listeners at once; process signals still pass through", async () => {
  const { withStopRequest } = await import("../../src/ops/watch.ts");
  const base: { sig: string; fn: () => void }[] = [];
  const src = withStopRequest({ on: (sig, fn) => void base.push({ sig, fn }), off: (sig, fn) => { const i = base.findIndex((b) => b.sig === sig && b.fn === fn); if (i >= 0) base.splice(i, 1); } });
  let a = 0, b = 0, late = 0;
  const fa = (): void => { a++; };
  const fb = (): void => { b++; };
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) src.on(s, fa); // as applyPlan registers: one function, three signals
  src.on("SIGTERM", fb);
  src.off("SIGTERM", fb);
  assert.equal(base.length, 3, "registered on the process signals too");
  src.fire();
  src.fire();
  assert.equal(a, 1, "one call: applyPlan counts it as the first Ctrl+C, never the forced third");
  assert.equal(b, 0, "removed listeners are not called");
  src.on("SIGTERM", () => { late++; });
  assert.equal(late, 1, "a step that starts after the request stops at once");
  base.find((x) => x.sig === "SIGINT")!.fn();
  assert.equal(a, 2, "a real Ctrl+C still arrives");
});

test("a stop that arrives during the daily check: no update child is started (the watcher was asked to stop)", async () => {
  const c = checker({ tags: ["v0.2.1", "v0.3.0", "v0.3.1"] });
  c.use({ now: () => 0, setTimer: () => 0, clearTimer: () => {} });
  const r = await c.check.check(() => true);
  assert.deepEqual(r, { kind: "skipped", why: "stopping" });
  assert.equal(c.spawned(), 0);
  // The watcher passes its stop flag: a stop during afterCycle is seen by the check.
  const d = checker({ tags: ["v0.2.1", "v0.3.0", "v0.3.1"] });
  const flags: boolean[] = [];
  const h = harness([], { afterCycle: async (stopped) => { h.w.stop(); flags.push(stopped()); await d.check.check(stopped); } });
  d.use(h.clock);
  await h.clock.advance(MIN);
  await h.w.done;
  assert.deepEqual(flags, [true]);
  assert.equal(d.spawned(), 0);
});
