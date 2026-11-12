import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, renameSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  BACKOFF_MS, acquireWatcherSingleton, createDirWatch, singletonAddress, startWatch, type Clock, type DirWatch, type Heartbeat, type SingletonNet, type WatchDeps,
} from "../../src/ops/watch.ts";
import type { CycleOutcome } from "../../src/ops/sync.ts";
import { tempRoot } from "./helpers.ts";

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
