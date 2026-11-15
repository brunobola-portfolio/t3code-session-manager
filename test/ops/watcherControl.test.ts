import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isT3smWatcher, requestWatcherStop, stopWatcher, type StopDeps } from "../../src/ops/watcherControl.ts";
import { type SuffixIo, SocketDirSuffixError, UnsafeSocketDirError, acquireWatcherSingleton, checkLegacySocket, checkSocketDir, fallbackSocketDir, legacySingletonAddress, realClock, realSingletonNet, singletonAddress, startWatch, type Clock, type Heartbeat, type SingletonNet } from "../../src/ops/watch.ts";
import type { ProcessInfo } from "../../src/core/pid.ts";
import type { CycleOutcome } from "../../src/ops/sync.ts";
import { tempRoot } from "./helpers.ts";

/** A clock whose sleeps cost no real time: a timer advances the clock by its delay and fires at once. */
function stepClock(): Clock {
  let t = 0;
  return {
    now: () => t,
    setTimer(fn, ms) { t += ms; queueMicrotask(fn); return 1; },
    clearTimer() {},
  };
}

type Req = "ok" | "no-watcher" | "closed" | "timed-out";
type Probe = "alive" | "refused" | "absent" | "other";

/** A fake net: `alive` is what the probe says (when not alive: `free`); `request` is scripted. */
function net(o: { request: Req; aliveAfterRequest?: boolean; alive: boolean; free?: Probe; lines?: string[] }) {
  const st = { alive: o.alive };
  const n: SingletonNet = {
    listen: async () => "in-use",
    probe: async () => (st.alive ? "alive" : (o.free ?? "absent")),
    request: async (_a, line) => { o.lines?.push(line); if (o.aliveAfterRequest !== undefined) st.alive = o.aliveAfterRequest; return o.request; },
    remove: async () => {},
  };
  return { n, st };
}

const WATCH_CMD = "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\t3code-session-manager\\bin\\t3sm.mjs\" sync --watch --quiet";
const HB_START = Date.UTC(2026, 10, 15, 10, 0, 0);
const GOOD: ProcessInfo = { argv: null, commandLine: WATCH_CMD, startedAt: HB_START - 1000 };

function deps(n: SingletonNet, over: Partial<StopDeps> = {}): StopDeps & { killed: number[]; killClock: number[] } {
  const killed: number[] = [];
  const killClock: number[] = [];
  const clock = stepClock();
  return {
    stateDir: "C:/s", platform: "win32", net: n, clock,
    readHeartbeat: async () => ({ pid: 4242, startedAt: new Date(HB_START).toISOString() } as Heartbeat),
    pidAlive: () => true,
    processInfo: async () => GOOD,
    kill: (p) => { killed.push(p); killClock.push(clock.now()); },
    writeHeartbeat: async () => {}, // the fake heartbeat is never written to a real file
    killed, killClock,
    ...over,
  };
}

const errno = (code: string): Error => Object.assign(new Error(code), { code });

test("isT3smWatcher: accepts real watcher command lines (quoted Windows paths, conhost wrapper, POSIX) and argv arrays", () => {
  assert.equal(isT3smWatcher(WATCH_CMD), true);
  assert.equal(isT3smWatcher("conhost.exe --headless \"C:\\Program Files\\nodejs\\node.exe\" \"C:\\u\\t3sm.mjs\" sync --watch"), true);
  assert.equal(isT3smWatcher("node /usr/lib/node_modules/t3code-session-manager/bin/t3sm.mjs sync --watch"), true);
  assert.equal(isT3smWatcher("/usr/bin/node --no-warnings /usr/local/bin/t3sm sync --quiet --watch"), true);
  assert.equal(isT3smWatcher(["/usr/bin/node", "/opt/my tools/t3sm.mjs", "sync", "--watch"]), true, "argv: a path with spaces is one token");
});

test("isT3smWatcher: rejects look-alikes (global flags before sync are rejected on purpose)", () => {
  for (const c of [
    "node something-else.js", "node /x/t3sm.mjs status", "node /x/t3sm.mjs sync", "node /x/t3sm.mjs sync --dry-run",
    "code.exe /x/t3sm.mjs sync --watch", "vim /x/t3sm.mjs sync --watch", "/x/t3sm sync --watch",
    "node other.js /x/t3sm.mjs sync --watch", "node /x/t3sm.mjs --watch sync", "node /x/t3sm.mjs --quiet sync --watch", "", "powershell node t3sm.mjs sync --watch",
  ]) assert.equal(isT3smWatcher(c), false, c);
  assert.equal(isT3smWatcher(["vim", "node", "t3sm.mjs", "sync", "--watch"]), false);
});

test("requestWatcherStop maps the net answer and sends `stop <token>` read from the state dir", async () => {
  const t = tempRoot();
  mkdirSync(t.state, { recursive: true });
  writeFileSync(join(t.state, "watcher.token"), "abc123\n");
  const lines: string[] = [];
  assert.equal(await requestWatcherStop(t.state, "win32", net({ request: "ok", alive: true, lines }).n), "stopped");
  assert.deepEqual(lines, ["stop abc123\n"]);
  assert.equal(await requestWatcherStop("C:/s", "win32", net({ request: "no-watcher", alive: false }).n), "no-watcher");
  const noTok: string[] = [];
  assert.equal(await requestWatcherStop("C:/nope", "win32", net({ request: "closed", alive: true, lines: noTok }).n), "closed-without-reply");
  assert.deepEqual(noTok, ["stop \n"], "no token file: an empty token is sent (a 0.2.1 watcher just drops the socket)");
  assert.equal(await requestWatcherStop("C:/s", "win32", net({ request: "timed-out", alive: true }).n), "timed-out");
});

test("no watcher: nothing runs, nothing killed", async () => {
  const d = deps(net({ request: "no-watcher", alive: false }).n);
  assert.deepEqual(await stopWatcher(d), { how: "none", pid: null, running: false });
  assert.deepEqual(d.killed, []);
});

test("a stop request that frees the pipe never kills", async () => {
  const d = deps(net({ request: "ok", alive: true, aliveAfterRequest: false }).n);
  assert.deepEqual(await stopWatcher(d), { how: "request", pid: 4242, running: false });
  assert.deepEqual(d.killed, []);
});

test("old watcher without IPC (0.2.1): the socket is closed without a reply, so the verified pid is killed at once (no 30 s wait)", async () => {
  const f = net({ request: "closed", alive: true });
  const d = deps(f.n, { kill: (p) => { d.killed.push(p); d.killClock.push(-1); f.st.alive = false; } });
  assert.deepEqual(await stopWatcher(d), { how: "pid", pid: 4242, running: false });
  assert.deepEqual(d.killed, [4242]);
});

test("a slow watcher (request timed out) gets the full default 30 s before the pid step", async () => {
  const f = net({ request: "timed-out", alive: true });
  const d = deps(f.n, { kill: (p) => { d.killed.push(p); d.killClock.push(clockOf(d).now()); f.st.alive = false; } });
  assert.deepEqual(await stopWatcher(d), { how: "pid", pid: 4242, running: false });
  assert.ok(clockOf(d).now() >= 30_000, `waited ${clockOf(d).now()} ms`);
  assert.deepEqual(d.killed, [4242]);
});
const clockOf = (d: StopDeps): Clock => d.clock;

test("a request answered but never let go falls back to the verified pid after the wait", async () => {
  const f = net({ request: "ok", alive: true });
  const d = deps(f.n, { waitMs: 1000, kill: (p) => { d.killed.push(p); f.st.alive = false; } });
  assert.deepEqual(await stopWatcher(d), { how: "pid", pid: 4242, running: false });
});

test("stopped but the pipe stays busy and the pid is not a verified watcher: not killed, running true", async () => {
  const d = deps(net({ request: "ok", alive: true }).n, { waitMs: 1000, processInfo: async () => ({ argv: null, commandLine: "node something-else.js", startedAt: HB_START - 1000 }) });
  assert.deepEqual(await stopWatcher(d), { how: "none", pid: null, running: true });
  assert.deepEqual(d.killed, []);
});

test("kill races: ESRCH means gone (re-probed); another kill error means still running", async () => {
  const f = net({ request: "closed", alive: true });
  const gone = deps(f.n, { kill: () => { f.st.alive = false; throw errno("ESRCH"); } });
  assert.deepEqual(await stopWatcher(gone), { how: "pid", pid: 4242, running: false });
  const g = net({ request: "closed", alive: true });
  const denied = deps(g.n, { waitMs: 1000, kill: () => { throw errno("EPERM"); } });
  assert.deepEqual(await stopWatcher(denied), { how: "pid", pid: 4242, running: true });
});

test("killed but the pipe is still busy: running true", async () => {
  const d = deps(net({ request: "closed", alive: true }).n, { waitMs: 1000 });
  assert.deepEqual(await stopWatcher(d), { how: "pid", pid: 4242, running: true });
});

test("a probe error that is not 'absent'/'refused' does not count as a free endpoint", async () => {
  const d = deps(net({ request: "ok", alive: false, free: "other" }).n, { waitMs: 1000 });
  const r = await stopWatcher(d);
  assert.equal(r.running, true);
});

test("never kills a pid whose identity is not proven (command line, start time, dead, 0, 1, our own, stopped)", async () => {
  const cases: Partial<StopDeps>[] = [
    { processInfo: async () => ({ ...GOOD, commandLine: "node something-else.js" }) },
    { processInfo: async () => ({ ...GOOD, commandLine: "code.exe /x/t3sm.mjs sync --watch" }) },
    { processInfo: async () => ({ ...GOOD, argv: ["vim", "t3sm.mjs", "sync", "--watch"] }) },
    { processInfo: async () => null },
    { processInfo: async () => ({ ...GOOD, startedAt: HB_START + 60_000 }) },      // started after the heartbeat: pid reuse
    { processInfo: async () => ({ ...GOOD, startedAt: HB_START - 121_000 }) },     // more than 2 min before it: pid reuse
    { processInfo: async () => ({ ...GOOD, startedAt: Number.NaN }) },
    { readHeartbeat: async () => ({ pid: 4242, startedAt: "garbage" } as Heartbeat) },
    { pidAlive: () => false },
    { readHeartbeat: async () => ({ pid: 0, startedAt: new Date(HB_START).toISOString() } as Heartbeat) },
    { readHeartbeat: async () => ({ pid: 1, startedAt: new Date(HB_START).toISOString() } as Heartbeat) },
    { readHeartbeat: async () => ({ pid: process.pid, startedAt: new Date(HB_START).toISOString() } as Heartbeat) },
    { readHeartbeat: async () => ({ pid: 4242, startedAt: new Date(HB_START).toISOString(), stoppedAt: "2026-01-01T00:00:00Z" } as Heartbeat) },
    { readHeartbeat: async () => null },
  ];
  for (const c of cases) {
    const d = deps(net({ request: "closed", alive: true }).n, { waitMs: 1000, ...c });
    assert.deepEqual(await stopWatcher(d), { how: "none", pid: null, running: true }, JSON.stringify(Object.keys(c)));
    assert.deepEqual(d.killed, []);
  }
  // The boundaries that are accepted: at the heartbeat, and exactly 2 minutes before it.
  for (const startedAt of [HB_START, HB_START - 120_000]) {
    const f = net({ request: "closed", alive: true });
    const d = deps(f.n, { processInfo: async () => ({ ...GOOD, startedAt }), kill: (p) => { d.killed.push(p); f.st.alive = false; } });
    assert.equal((await stopWatcher(d)).how, "pid");
  }
});

test("real endpoint: wrong token is dropped; the right one -> ok -> the loop stops after its cycle -> the pipe and the token are freed", async () => {
  const t = tempRoot();
  mkdirSync(t.state, { recursive: true });
  let loop: { done: Promise<void>; stop(): void } | null = null;
  let asked = false;
  const single = await acquireWatcherSingleton(t.state, process.platform, undefined, () => { asked = true; loop?.stop(); });
  assert.ok(single);
  const tokenFile = join(t.state, "watcher.token");
  try {
    assert.match(readFileSync(tokenFile, "utf8").trim(), /^[0-9a-f]{32}$/);
    if (process.platform !== "win32") {
      assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
      assert.equal(statSync(singletonAddress(t.state)).mode & 0o777, 0o600, "socket 0600");
    }
    loop = startWatch({
      clock: realClock, debounceMs: 30_000, everyMinutes: 15, pid: 4242,
      signals: { on() {}, off() {} },
      dirs: async () => [], watch: () => ({ mode: "poll", close() {} }),
      cycle: async () => ({ kind: "noop", runId: null, counts: { imported: 0, failed: 0, deferred: 0, unverified: 0, alreadyInT3: 0, heldForDedupe: 0, heldForAccounts: 0, heldInUse: 0, heldFailed: 0, wouldImport: 0 } } as CycleOutcome),
      writeHeartbeat: async () => {},
    });
    const addr = singletonAddress(t.state);
    assert.equal(await realSingletonNet.probe(addr), "alive");
    for (const bad of ["hello\n", "stop\n", "stop wrong\n", "stop \n"]) assert.equal(await realSingletonNet.request(addr, bad), "closed", bad);
    assert.equal(asked, false);
    assert.equal(await requestWatcherStop(t.state), "stopped");
    await loop.done;
    assert.equal(asked, true);
  } finally {
    loop?.stop();
    await single.release();
  }
  assert.ok(["absent", "refused"].includes(await realSingletonNet.probe(singletonAddress(t.state))), "pipe freed");
  assert.equal(existsSync(tokenFile), false, "token removed on release");
  assert.equal(await requestWatcherStop(t.state), "no-watcher");
});

// ---------- fix round 2 ----------

/** A state path too long for a socket, inside a throwaway temp root (the real suffix file is written there, never in a real state dir). */
const LONG = join(tempRoot().root, "a".repeat(120));

test("legacySingletonAddress: only where a POSIX state path forces the temp-dir fallback (0.2.1 used <tmp>/t3sm-watcher-<h>.sock)", () => {
  const legacy = legacySingletonAddress(LONG, "linux");
  assert.ok(legacy !== null && /t3sm-watcher-[0-9a-f]{12}\.sock$/.test(legacy));
  assert.notEqual(legacy, singletonAddress(LONG, "linux"));
  assert.equal(legacySingletonAddress("/short", "linux"), null);
  assert.equal(legacySingletonAddress(LONG, "win32"), null);
});

/** A net keyed by address: which addresses are alive; request only answers on the primary. */
function addrNet(alive: Set<string>, requestResult: Req, extra: Partial<SingletonNet> = {}) {
  const listens: string[] = [];
  const n: SingletonNet = {
    listen: async (a) => { listens.push(a); return "in-use"; },
    probe: async (a) => (alive.has(a) ? "alive" : "absent"),
    request: async () => requestResult,
    remove: async () => {},
    ...extra,
  };
  return { n, listens };
}

test("a 0.2.1 watcher at the legacy address blocks a new watcher (no second bind)", async () => {
  const legacy = legacySingletonAddress(LONG, "linux")!;
  const f = addrNet(new Set([legacy]), "no-watcher");
  assert.equal(await acquireWatcherSingleton(LONG, "linux", f.n), null);
  assert.deepEqual(f.listens, []);
});

test("stopWatcher: a live legacy address is a 0.2.1 watcher (verified-pid path); running probes both addresses", async () => {
  const legacy = legacySingletonAddress(LONG, "linux")!;
  const alive = new Set([legacy]);
  const f = addrNet(alive, "no-watcher");
  const d = deps(f.n, { stateDir: LONG, platform: "linux", waitMs: 1000, kill: (p) => { d.killed.push(p); alive.clear(); } });
  assert.deepEqual(await stopWatcher(d), { how: "pid", pid: 4242, running: false });
  assert.deepEqual(d.killed, [4242]);
  const stuck = addrNet(new Set([legacy]), "no-watcher");
  const d2 = deps(stuck.n, { stateDir: LONG, platform: "linux", waitMs: 1000 });
  assert.deepEqual(await stopWatcher(d2), { how: "pid", pid: 4242, running: true }, "killed but the legacy address is still alive");
  const none = addrNet(new Set(), "no-watcher");
  assert.deepEqual(await stopWatcher(deps(none.n, { stateDir: LONG, platform: "linux" })), { how: "none", pid: null, running: false });
});

test("checkSocketDir: creates 0700, refuses a symlink, a foreign owner, or group/other access", async () => {
  const st = (o: Partial<{ link: boolean; uid: number; mode: number }> = {}) => ({ isSymbolicLink: () => o.link ?? false, isDirectory: () => true, uid: o.uid ?? 1000, mode: 0o40000 | (o.mode ?? 0o700) });
  const mk = (s: ReturnType<typeof st> | "ENOENT") => {
    const calls: string[] = [];
    let made = false;
    return { calls, fs: {
      mkdir: async (p: string, o: { mode: number }) => { calls.push(`mkdir ${p} ${o.mode.toString(8)}`); made = true; },
      lstat: async () => { if (s === "ENOENT" && !made) throw errno("ENOENT"); return s === "ENOENT" ? st() : s; },
    } };
  };
  assert.equal(await checkSocketDir("/tmp/t3sm-1000", mk(st()).fs, 1000), true);
  const created = mk("ENOENT");
  assert.equal(await checkSocketDir("/tmp/t3sm-1000", created.fs, 1000), true);
  assert.deepEqual(created.calls, ["mkdir /tmp/t3sm-1000 700"]);
  assert.equal(await checkSocketDir("/tmp/t3sm-1000", mk(st({ link: true })).fs, 1000), false);
  assert.equal(await checkSocketDir("/tmp/t3sm-1000", mk(st({ uid: 0 })).fs, 1000), false);
  assert.equal(await checkSocketDir("/tmp/t3sm-1000", mk(st({ mode: 0o755 })).fs, 1000), false);
  assert.equal(await checkSocketDir("/tmp/t3sm-1000", mk(st({ mode: 0o770 })).fs, 1000), false);
  assert.equal(await checkSocketDir("/tmp/t3sm-1000", { mkdir: async () => { throw errno("EACCES"); }, lstat: async () => { throw errno("ENOENT"); } }, 1000), false);
});

test("an unsafe fallback directory: the watcher refuses to start with a typed error and binds nothing", async () => {
  const f = addrNet(new Set(), "no-watcher", { secureDir: async () => false });
  const bad = await acquireWatcherSingleton(LONG, "linux", f.n, () => {}).then(() => null, (e: unknown) => e);
  assert.ok(bad instanceof UnsafeSocketDirError);
  assert.equal(bad.dir, dirname(singletonAddress(LONG, "linux")));
  assert.match(bad.message, /not safe.*0700/);
  assert.deepEqual(f.listens, []);
});

test("an unsafe fallback directory: stopWatcher never asks the socket, but the verified-pid path still stops the watcher; running comes from the pid", async () => {
  let alive = true;
  const asked: string[] = [];
  const f = addrNet(new Set(), "ok", { secureDir: async () => false, request: async (a) => { asked.push(a); return "ok"; } });
  const d = deps(f.n, { stateDir: LONG, platform: "linux", waitMs: 1000, pidAlive: () => alive, kill: (p) => { d.killed.push(p); alive = false; } });
  assert.deepEqual(await stopWatcher(d), { how: "pid", pid: 4242, running: false });
  assert.deepEqual(d.killed, [4242]);
  assert.deepEqual(asked, [], "no token is ever sent into an unsafe directory");
  // Not a t3sm watcher (pid reuse): nothing is killed and nothing is reported running.
  const other = deps(f.n, { stateDir: LONG, platform: "linux", processInfo: async () => ({ ...GOOD, commandLine: "node server.js", argv: null }) });
  assert.deepEqual(await stopWatcher(other), { how: "none", pid: null, running: false });
  assert.deepEqual(other.killed, []);
  // A verified watcher that survives the kill is still running.
  const stuck = deps(f.n, { stateDir: LONG, platform: "linux", waitMs: 1000 });
  assert.deepEqual(await stopWatcher(stuck), { how: "pid", pid: 4242, running: true });
  // And with nothing known at all the answer is "not running", not a fail-closed true.
  const none = deps(f.n, { stateDir: LONG, platform: "linux", readHeartbeat: async () => null });
  assert.deepEqual(await stopWatcher(none), { how: "none", pid: null, running: false });
});

/** An in-memory suffix store: files by path; `fail` makes every read/create throw (an unreadable state dir). */
function mem(fail = false, files = new Map<string, string>()): SuffixIo & { files: Map<string, string>; created: string[] } {
  const created: string[] = [];
  return {
    files, created,
    read: (f) => { if (fail) throw errno("EACCES"); const v = files.get(f); if (v === undefined) throw errno("ENOENT"); return v; },
    create: (f, c) => { if (fail) throw errno("EACCES"); created.push(f); if (!files.has(f)) files.set(f, c); },
  };
}
const norm = (p: string): string => p.replaceAll("\\", "/");

test("the fallback socket address never depends on the environment: identical with and without XDG_RUNTIME_DIR (cron, shell and launchd must agree)", () => {
  const was = process.env["XDG_RUNTIME_DIR"];
  const io = mem();
  const o = { tmp: "/tmp", uid: 1000, suffixIo: io };
  try {
    delete process.env["XDG_RUNTIME_DIR"];
    const without = singletonAddress(LONG, "linux", o);
    process.env["XDG_RUNTIME_DIR"] = "/run/user/1000";
    assert.equal(singletonAddress(LONG, "linux", o), without);
    assert.equal(fallbackSocketDir(LONG, o), fallbackSocketDir(LONG, o));
  } finally { if (was === undefined) delete process.env["XDG_RUNTIME_DIR"]; else process.env["XDG_RUNTIME_DIR"] = was; }
  assert.match(norm(singletonAddress(LONG, "linux", o)), /^\/tmp\/t3sm-1000-[0-9a-f]{16}\/watcher-[0-9a-f]{12}\.sock$/);
});

test("fallback socket dir suffix: 16 random hex chars created once in <state>/socket-dir-suffix and read back on every call", () => {
  const io = mem();
  const a = fallbackSocketDir(LONG, { tmp: "/tmp", uid: 1000, suffixIo: io });
  assert.match(norm(a), /^\/tmp\/t3sm-1000-[0-9a-f]{16}$/);
  assert.equal(io.created.length, 1);
  assert.equal(norm(io.created[0]!), norm(join(LONG, "socket-dir-suffix")));
  assert.equal(fallbackSocketDir(LONG, { tmp: "/tmp", uid: 1000, suffixIo: io }), a, "same on every call");
  assert.equal(io.created.length, 1, "not rewritten");
  assert.equal(legacySingletonAddress(LONG, "linux", { tmp: "/tmp", uid: 1000, suffixIo: io })!.includes("t3sm-watcher-"), true, "legacy address unchanged");
});

test("fallback socket dir suffix: different state dirs get different suffixes", () => {
  const io = mem();
  const o = { tmp: "/tmp", uid: 1000, suffixIo: io };
  assert.notEqual(fallbackSocketDir(LONG, o), fallbackSocketDir(`${LONG}b`, o));
});

test("fallback socket dir suffix: an unreadable, unwritable or malformed suffix file is a typed error, never another name; and no bind happens", async () => {
  const bad = mem(false, new Map([[join(LONG, "socket-dir-suffix"), "not-hex"]]));
  for (const io of [mem(true), bad]) {
    const o = { tmp: "/tmp", uid: 1000, suffixIo: io };
    assert.throws(() => fallbackSocketDir(LONG, o), SocketDirSuffixError);
    assert.throws(() => singletonAddress(LONG, "linux", o), UnsafeSocketDirError, "also an UnsafeSocketDirError: the watcher command exits 0 like an unsafe dir");
    const f = addrNet(new Set(), "no-watcher");
    const e = await acquireWatcherSingleton(LONG, "linux", f.n, () => {}, o).then(() => null, (x: unknown) => x);
    assert.ok(e instanceof SocketDirSuffixError);
    assert.match(e.message, /socket-dir-suffix.*cannot be used/);
    assert.deepEqual(f.listens, [], "nothing bound");
  }
  assert.equal(bad.created.length, 0, "a corrupt file is never overwritten");
});

test("fallback socket dir suffix: computed once per process; a later read failure cannot change the address", () => {
  const io = mem();
  const o = { tmp: "/tmp", uid: 1000, suffixIo: io };
  const first = fallbackSocketDir(LONG, o);
  const flaky: SuffixIo = { ...io, read: () => { throw errno("EIO"); } };
  // Same io object keeps its cache; a different io (a fresh process in the model) has none and fails.
  assert.equal(fallbackSocketDir(LONG, o), first);
  assert.throws(() => fallbackSocketDir(LONG, { ...o, suffixIo: flaky }), SocketDirSuffixError);
  io.read = () => { throw errno("EIO"); };
  assert.equal(fallbackSocketDir(LONG, o), first, "cached: no read at all");
});

test("stopWatcher: a client whose derived address differs finds the watcher through the heartbeat's socket (request and free-check)", async () => {
  const bound = "/tmp/t3sm-1000-0123456789abcdef/watcher-aaaaaaaaaaaa.sock";
  const alive = new Set([bound]);
  const asked: string[] = [];
  const f = addrNet(alive, "ok", { request: async (a) => { asked.push(a); if (a === bound) { alive.clear(); return "ok"; } return "no-watcher"; } });
  const hb = async () => ({ pid: 4242, startedAt: new Date(0).toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null, protocol: 1, socket: bound });
  const d = deps(f.n, { stateDir: LONG, platform: "linux", waitMs: 1000, readHeartbeat: hb, addr: { tmp: "/tmp", uid: 1000, suffixIo: mem() } });
  assert.notEqual(singletonAddress(LONG, "linux", d.addr), bound, "the client derives another address");
  assert.deepEqual(await stopWatcher(d), { how: "request", pid: 4242, running: false });
  assert.deepEqual(asked, [bound]);
  // The heartbeat's socket must be ours: a foreign one is ignored.
  const g = addrNet(new Set([bound]), "no-watcher", { legacySafe: async () => false, secureDir: async () => true });
  const d2 = deps(g.n, { stateDir: LONG, platform: "linux", readHeartbeat: hb, addr: { tmp: "/tmp", uid: 1000, suffixIo: mem() } });
  assert.deepEqual(await stopWatcher(d2), { how: "none", pid: null, running: false });
  // Without a usable suffix the derived address is gone, but the heartbeat's still works.
  const alive3 = new Set([bound]);
  const k = addrNet(alive3, "ok", { request: async () => { alive3.clear(); return "ok"; } });
  const d3 = deps(k.n, { stateDir: LONG, platform: "linux", waitMs: 1000, readHeartbeat: hb, addr: { tmp: "/tmp", uid: 1000, suffixIo: mem(true) } });
  assert.deepEqual(await stopWatcher(d3), { how: "request", pid: 4242, running: false });
});

test("acquireWatcherSingleton reports the address it bound", async () => {
  const io = mem();
  const addr = { tmp: "/tmp", uid: 1000, suffixIo: io };
  const f = addrNet(new Set(), "no-watcher", { listen: async () => ({ release: async () => {} }), secureDir: async () => true });
  const single = await acquireWatcherSingleton(LONG, "linux", f.n, () => {}, addr);
  assert.equal(single?.addr, singletonAddress(LONG, "linux", addr));
  await single?.release();
});

test("fallback socket dir suffix: bind and stop compute the same address (state dir passed through)", async () => {
  const io = mem();
  const addr = { tmp: "/tmp", uid: 1000, suffixIo: io };
  const f = addrNet(new Set(), "no-watcher");
  await acquireWatcherSingleton(LONG, "linux", f.n, undefined, addr);
  const bound = f.listens[0]!;
  assert.equal(bound, singletonAddress(LONG, "linux", addr));
  const asked: string[] = [];
  await requestWatcherStop(LONG, "linux", addrNet(new Set(), "ok", { request: async (a) => { asked.push(a); return "ok"; } }).n, addr);
  assert.deepEqual(asked, [bound]);
});

test("checkLegacySocket: a live legacy socket counts only when it is a real socket owned by us (not a link, not a file, not someone else's)", async () => {
  const st = (o: Partial<{ link: boolean; sock: boolean; uid: number }> = {}) => ({ lstat: async () => ({ isSymbolicLink: () => o.link ?? false, isSocket: () => o.sock ?? true, uid: o.uid ?? 1000 }) });
  assert.equal(await checkLegacySocket("/tmp/x.sock", st(), 1000), true);
  assert.equal(await checkLegacySocket("/tmp/x.sock", st({ link: true }), 1000), false);
  assert.equal(await checkLegacySocket("/tmp/x.sock", st({ sock: false }), 1000), false);
  assert.equal(await checkLegacySocket("/tmp/x.sock", st({ uid: 0 }), 1000), false);
  assert.equal(await checkLegacySocket("/tmp/x.sock", { lstat: async () => { throw errno("ENOENT"); } }, 1000), false);
});

test("an untrusted legacy socket is ignored: the new watcher still starts, and stopWatcher neither kills for it nor reports it running", async () => {
  const legacy = legacySingletonAddress(LONG, "linux")!;
  const f = addrNet(new Set([legacy]), "no-watcher", { legacySafe: async () => false, listen: async (a) => { f.listens.push(a); return { release: async () => {} }; } });
  assert.ok(await acquireWatcherSingleton(LONG, "linux", f.n), "did not stand down for a socket that is not ours");
  assert.equal(f.listens.length, 1);
  const g = addrNet(new Set([legacy]), "no-watcher", { legacySafe: async () => false });
  const d = deps(g.n, { stateDir: LONG, platform: "linux" });
  assert.deepEqual(await stopWatcher(d), { how: "none", pid: null, running: false });
  assert.deepEqual(d.killed, []);
  // A trusted one still blocks.
  const h = addrNet(new Set([legacy]), "no-watcher", { legacySafe: async () => true });
  assert.equal(await acquireWatcherSingleton(LONG, "linux", h.n), null);
});

test("a new-protocol watcher (heartbeat protocol 1) with no token file gets the full 30 s before the pid step; with a token, or an old heartbeat, no wait", async () => {
  const t = tempRoot();
  mkdirSync(t.state, { recursive: true });
  const proto = async () => ({ pid: 4242, startedAt: new Date(HB_START).toISOString(), protocol: 1 } as Heartbeat);
  const run = async (stateDir: string, readHeartbeat: StopDeps["readHeartbeat"]) => {
    const f = net({ request: "closed", alive: true });
    const d = deps(f.n, { stateDir, readHeartbeat, kill: (p) => { d.killed.push(p); d.killClock.push(clockOf(d).now()); f.st.alive = false; } });
    await stopWatcher(d);
    return d.killClock[0]!;
  };
  assert.ok((await run(t.state, proto)) >= 30_000, "no token + protocol heartbeat: waited");
  writeFileSync(join(t.state, "watcher.token"), "tok");
  assert.equal(await run(t.state, proto), 0, "token present: a refused request is a real 'closed'");
  assert.equal(await run(join(t.state, "none"), async () => ({ pid: 4242, startedAt: new Date(HB_START).toISOString() } as Heartbeat)), 0, "old heartbeat: immediate");
});

test("stopWatcher: a watcher that is gone without a clean stop gets stoppedAt in its heartbeat (status no longer reports a crash forever)", async () => {
  const written: Heartbeat[] = [];
  const crashed = { pid: 4242, startedAt: new Date(HB_START).toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: new Date(HB_START + 60_000).toISOString() } as Heartbeat;
  const d = deps(net({ request: "no-watcher", alive: false }).n, { readHeartbeat: async () => crashed, pidAlive: () => false, writeHeartbeat: async (_s, h) => void written.push(h) });
  assert.deepEqual(await stopWatcher(d), { how: "none", pid: null, running: false });
  assert.equal(written.length, 1);
  assert.equal(written[0]!.pid, 4242);
  assert.equal(typeof written[0]!.stoppedAt, "string");
  assert.equal(written[0]!.nextCycleAt, null);
  assert.equal(written[0]!.reason, undefined, "no restart intent: a plain stop");
  // A live pid (another process, or the watcher itself) is never marked; nor is a heartbeat that already stopped.
  for (const over of [{ pidAlive: () => true }, { readHeartbeat: async () => ({ ...crashed, stoppedAt: "2026-11-15T09:00:00.000Z" }) }]) {
    const w: Heartbeat[] = [];
    await stopWatcher(deps(net({ request: "no-watcher", alive: false }).n, { readHeartbeat: async () => crashed, pidAlive: () => false, ...over, writeHeartbeat: async (_s, h) => void w.push(h) }));
    assert.deepEqual(w, [], JSON.stringify(Object.keys(over)));
  }
});

test("stopWatcher with intent restart: the stopped heartbeat says reason restart, so a successor that never comes is restart-lost", async () => {
  const written: Heartbeat[] = [];
  let hb: Heartbeat = { pid: 4242, startedAt: new Date(HB_START).toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null, protocol: 1 };
  let alive = true;
  const f = net({ request: "ok", alive: true });
  // The watcher answers ok, writes its final heartbeat (stoppedAt, no reason) and frees the pipe, then its process exits.
  f.n.request = async () => { hb = { ...hb, stoppedAt: new Date(HB_START + 5000).toISOString() }; f.st.alive = false; return "ok"; };
  const d = deps(f.n, { intent: "restart", readHeartbeat: async () => hb, pidAlive: () => alive, writeHeartbeat: async (_s, h) => void written.push(h) });
  const clock = d.clock;
  const realSet = clock.setTimer.bind(clock);
  clock.setTimer = (fn, ms) => { if (clock.now() >= 3000) alive = false; return realSet(fn, ms); };
  assert.deepEqual(await stopWatcher(d), { how: "request", pid: 4242, running: false });
  assert.equal(written.length, 1);
  assert.equal(written[0]!.reason, "restart");
  assert.equal(written[0]!.stoppedAt, new Date(HB_START + 5000).toISOString(), "the watcher's own stop time is kept");
  assert.ok(clock.now() >= 3000 && clock.now() < 10_000, `win32: waited for the pid to exit before returning (${clock.now()} ms)`);
});

test("stopWatcher win32: the wait for the stopped watcher's process is bounded (EXIT_WAIT_MS); other platforms do not wait", async () => {
  const { EXIT_WAIT_MS } = await import("../../src/ops/watcherControl.ts");
  const f = net({ request: "ok", alive: true, aliveAfterRequest: false });
  const d = deps(f.n, { pidAlive: () => true });
  assert.deepEqual(await stopWatcher(d), { how: "request", pid: 4242, running: false });
  assert.ok(d.clock.now() >= EXIT_WAIT_MS && d.clock.now() < EXIT_WAIT_MS + 1000, String(d.clock.now()));
  const g = net({ request: "ok", alive: true, aliveAfterRequest: false });
  const p = deps(g.n, { platform: "linux", stateDir: "/s", pidAlive: () => true });
  await stopWatcher(p);
  assert.ok(p.clock.now() < 1000, String(p.clock.now()));
});

test("markGoneWatcher: only a heartbeat whose pid is gone and that never stopped", async () => {
  const { markGoneWatcher } = await import("../../src/ops/watcherControl.ts");
  const hb = { pid: 4242, startedAt: new Date(HB_START).toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null } as Heartbeat;
  const w: Heartbeat[] = [];
  const o = (over: object) => ({ now: HB_START + 1000, readHeartbeat: async () => hb, pidAlive: () => false, writeHeartbeat: async (_s: string, h: Heartbeat) => void w.push(h), ...over });
  assert.equal(await markGoneWatcher("/s", o({})), true);
  assert.equal(w[0]!.stoppedAt, new Date(HB_START + 1000).toISOString());
  assert.equal(await markGoneWatcher("/s", o({ pidAlive: () => true })), false);
  assert.equal(await markGoneWatcher("/s", o({ readHeartbeat: async () => ({ ...hb, stoppedAt: "x" }) })), false);
  assert.equal(await markGoneWatcher("/s", o({ readHeartbeat: async () => null })), false);
  assert.equal(w.length, 1);
});

test("update with no watcher running and an old clean stop leaves the heartbeat stopped, not restart-lost", async () => {
  const { watcherHealth } = await import("../../src/ops/watcherHealth.ts");
  const written: Heartbeat[] = [];
  const old = { pid: 4242, startedAt: new Date(HB_START).toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null, stoppedAt: new Date(HB_START + 5000).toISOString() } as Heartbeat;
  // `t3sm update` always passes the restart intent; nothing runs (an interval schedule, or none), so nothing is stopped.
  const d = deps(net({ request: "no-watcher", alive: false }).n, { intent: "restart", readHeartbeat: async () => old, pidAlive: () => false, writeHeartbeat: async (_s, h) => void written.push(h) });
  assert.deepEqual(await stopWatcher(d), { how: "none", pid: null, running: false });
  assert.deepEqual(written, [], "an old clean stop is left as it was");
  const health = watcherHealth(written[0] ?? old, { now: HB_START + 86_400_000, pidAlive: () => false, install: () => null, everyMinutes: 15 });
  assert.equal(health.state, "stopped");
});

test("stopWatcher with intent restart and a crashed watcher (no stoppedAt before the call): marked stopped with reason restart", async () => {
  const written: Heartbeat[] = [];
  const crashed = { pid: 4242, startedAt: new Date(HB_START).toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null } as Heartbeat;
  const d = deps(net({ request: "no-watcher", alive: false }).n, { intent: "restart", readHeartbeat: async () => crashed, pidAlive: () => false, writeHeartbeat: async (_s, h) => void written.push(h) });
  await stopWatcher(d);
  assert.equal(written.length, 1);
  assert.equal(written[0]!.reason, "restart");
});

test("stopWatcher: the heartbeat is read again right before the write; a successor's heartbeat (another pid or start) is never overwritten", async () => {
  const written: Heartbeat[] = [];
  const crashed = { pid: 4242, startedAt: new Date(HB_START).toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null } as Heartbeat;
  const successor = { pid: 5151, startedAt: new Date(HB_START + 9000).toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null } as Heartbeat;
  let reads = 0;
  // The stop and the read after it see the crashed watcher; then a successor wrote its own.
  const d = deps(net({ request: "no-watcher", alive: false }).n, { readHeartbeat: async () => (++reads <= 2 ? crashed : successor), pidAlive: () => false, writeHeartbeat: async (_s, h) => void written.push(h) });
  await stopWatcher(d);
  assert.ok(reads >= 3, `read again before the write (${reads})`);
  assert.deepEqual(written, []);
});
