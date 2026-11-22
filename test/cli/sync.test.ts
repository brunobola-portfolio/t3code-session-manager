import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { main, type Io } from "../../src/cli/main.ts";
import { spawnSuccessor, syncCommand, type SyncCommandDeps } from "../../src/cli/commands/sync.ts";
import { scheduleCommand } from "../../src/cli/commands/schedule.ts";
import { acquireLock } from "../../src/core/lock.ts";
import type { PlanItem } from "../../src/core/types.ts";
import type { T3Api } from "../../src/t3/api.ts";
import type { CommandRunner } from "../../src/ops/schedule.ts";
import { T3Incompatible, T3NotRunning } from "../../src/t3/errors.ts";
import { UnsafeSocketDirError, acquireWatcherSingleton } from "../../src/ops/watch.ts";
import { defaultConfig, saveConfig } from "../../src/core/config.ts";
import { DAY, fakeT3, inst, tempHome, transcript, type FakeT3 } from "../apply/fake-t3.ts";
import { memScheduleFs } from "../ops/helpers.ts";
import { packageVersion } from "../../src/core/version.ts";

const ROOT = "C:/work/demo";

function setup(f: FakeT3) {
  const t = tempHome();
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: false, prompt: async () => "", env: { T3SM_HOME: t.state, LANG: "en_US.UTF-8" } };
  const api = { ...f.api, getConfig: async () => ({ settings: { providerInstances: { claudeAgent: { driver: "claudeAgent", config: { homePath: join(t.home, ".claude") } } } }, providers: [] }) } as T3Api;
  const deps = (items: PlanItem[], over: Partial<SyncCommandDeps> = {}): SyncCommandDeps => ({
    home: t.home, now: Date.now, isT3Running: async () => true, connect: async () => api, existsDir: async () => true,
    adapters: [{ id: "claude", mode: "native", isAvailable: async () => true, async *discover() { for (const i of items) yield i.session; } }],
    signals: { on() {}, off() {} },
    ...over,
  });
  return { ...t, io, deps, out: () => out.join(""), err: () => err.join("") };
}

const log = (state: string): string[] => {
  try { return readFileSync(join(state, "logs", "sync.log"), "utf8").trim().split("\n"); } catch { return []; }
};

test("sync --quiet with T3 down: exit 3, nothing on stdout or stderr", async () => {
  const s = setup(fakeT3());
  const code = await syncCommand(["--quiet"], s.io, s.deps([], { isT3Running: async () => false }));
  assert.equal(code, 3);
  assert.equal(s.out(), "");
  assert.equal(s.err(), "");
  assert.match(log(s.state)[0]!, /t3-down$/);
});

test("sync with T3 down without --quiet says so; a connect that finds T3 gone also exits 3", async () => {
  const s = setup(fakeT3());
  assert.equal(await syncCommand([], s.io, s.deps([], { isT3Running: async () => false })), 3);
  assert.match(s.err(), /T3 Code is not running/);
  const q = setup(fakeT3());
  assert.equal(await syncCommand(["--quiet"], q.io, q.deps([], { connect: async () => { throw new T3NotRunning(); } })), 3);
  assert.equal(q.err(), "");
});

test("sync --quiet with the lock held: exit 0, silent, T3 untouched", async () => {
  const f = fakeT3();
  const s = setup(f);
  const lock = await acquireLock(s.state);
  try {
    const code = await syncCommand(["--quiet"], s.io, s.deps([transcript(f, s.dir, ROOT, Date.now() - 3 * DAY)]));
    assert.equal(code, 0);
    assert.equal(s.out() + s.err(), "");
    assert.deepEqual(f.calls, []);
  } finally { await lock!.release(); }
});

test("sync --quiet with an untested T3 version: exit 4 and exactly one line on stderr", async () => {
  const s = setup(fakeT3());
  const code = await syncCommand(["--quiet"], s.io, s.deps([], { connect: async () => { throw new T3Incompatible("9.9.9", "T3Code 9.9.9 is newer than the versions t3sm was tested with.\nPass --allow-untested to continue."); } }));
  assert.equal(code, 4);
  assert.equal(s.out(), "");
  assert.equal(s.err().split("\n").filter(Boolean).length, 1);
  assert.match(s.err(), /9\.9\.9.*--allow-untested/);
  assert.match(log(s.state)[0]!, /error exit=4 T3Incompatible$/);
});

test("sync --quiet with claudeAgent reading another home: exit 2 with the fix in one line, nothing written", async () => {
  const f = fakeT3();
  const s = setup(f);
  const other = join(s.home, ".claude-other");
  f.opts.instances = [inst("claudeAgent", other)];
  const api = { ...f.api, getConfig: async () => ({ settings: { providerInstances: { claudeAgent: { driver: "claudeAgent", config: { homePath: other } } } }, providers: [] }) } as T3Api;
  const code = await syncCommand(["--quiet"], s.io, s.deps([transcript(f, s.dir, ROOT, Date.now() - 3 * DAY)], { connect: async () => api }));
  assert.equal(code, 2);
  assert.equal(s.err().split("\n").filter(Boolean).length, 1);
  assert.match(s.err(), /configured to read .*T3 Code settings \(Providers\) or run `t3sm accounts --apply`/); // explicit entry: the settings advice
  assert.ok(!existsSync(join(s.state, "journal.jsonl")));
});

test("sync --quiet imports silently and logs one line; a second run does nothing and writes no run", async () => {
  const f = fakeT3();
  const s = setup(f);
  const items = [transcript(f, s.dir, ROOT, Date.now() - 3 * DAY)];
  assert.equal(await syncCommand(["--quiet"], s.io, s.deps(items)), 0);
  assert.equal(s.out() + s.err(), "");
  assert.match(log(s.state)[0]!, / ok run=\S+ imported=1 failed=0/);
  assert.equal(await syncCommand([], s.io, s.deps(items)), 0);
  assert.match(s.out(), /^[✓v] Nothing to import\.\n$/);
  assert.match(log(s.state)[1]!, / noop$/);
});

test("sync --dry-run prints what a cycle would import and writes nothing", async () => {
  const f = fakeT3();
  const s = setup(f);
  const items = [transcript(f, s.dir, ROOT, Date.now() - 3 * DAY)];
  assert.equal(await syncCommand(["--dry-run"], s.io, s.deps(items)), 0);
  assert.match(s.out().replace(/\s+/g, " "), /Dry run: a sync cycle would import 1 session \(claude 1\) into 1 project \(1 new\)\. Nothing was written\./);
  assert.ok(!existsSync(join(s.state, "journal.jsonl")));
  assert.ok(!existsSync(join(s.state, "runs")));
  assert.ok(!existsSync(join(s.state, "logs")));
});

test("sync rejects unknown options and --watch with --dry-run", async () => {
  const s = setup(fakeT3());
  assert.equal(await syncCommand(["--nope"], s.io, s.deps([])), 2);
  assert.equal(await syncCommand(["--watch", "--dry-run"], s.io, s.deps([])), 2);
});

test("sync --watch exits 0 when another watcher holds the OS endpoint (the heartbeat only names its pid)", async () => {
  const s = setup(fakeT3());
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, "sync-status.json"), JSON.stringify({ pid: 777, startedAt: new Date().toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null }));
  const held = await acquireWatcherSingleton(s.state);
  try {
    const code = await syncCommand(["--watch"], s.io, s.deps([]));
    assert.equal(code, 0);
    assert.equal(s.out(), "A t3sm watcher is already running (pid 777).\n");
  } finally { await held!.release(); }
});

test("sync --watch: a startup failure is logged as startup-error", async () => {
  const s = setup(fakeT3());
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, "config.json"), "{not json");
  assert.equal(await main(["sync", "--watch", "--quiet"], { ...s.io }), 2);
  assert.match(log(s.state).at(-1)!, / startup-error exit=2 ConfigError$/);
  // The keep-alive retries every 15 minutes: one line per streak, not one per try.
  assert.equal(await main(["sync", "--watch", "--quiet"], { ...s.io }), 2);
  assert.equal(log(s.state).filter((l) => l.includes("startup-error")).length, 1);
});

test("sync --quiet over the unattended limit: one line even under --quiet, exit 0, nothing written, logged", async () => {
  const f = fakeT3();
  const s = setup(f);
  const c = defaultConfig([{ id: "claudeAgent", home: join(s.home, ".claude"), displayName: "Claude", accentColor: null }]);
  c.sync.maxUnattendedImports = 1;
  await saveConfig(s.state, c);
  const items = [transcript(f, s.dir, ROOT, Date.now() - 3 * DAY), transcript(f, s.dir, ROOT, Date.now() - 4 * DAY)];
  assert.equal(await syncCommand(["--quiet"], s.io, s.deps(items)), 0);
  assert.equal(s.out(), "2 sessions pending; run `t3sm apply` once to import them.\n");
  assert.equal(s.err(), "");
  assert.ok(!existsSync(join(s.state, "journal.jsonl")));
  assert.match(log(s.state).at(-1)!, / over-limit pending=2 limit=1$/);
  assert.equal(await syncCommand(["--dry-run"], s.io, s.deps(items)), 0);
  assert.match(s.out(), /over the unattended limit of 1/);
});

test("help for sync and schedule", async () => {
  const s = setup(fakeT3());
  assert.equal(await main(["sync", "--help"], s.io), 0);
  assert.match(s.out(), /^Usage: t3sm sync \[--quiet\] \[--verbose\] \[--allow-untested\]/);
  assert.match(s.out(), /--verbose +Also print one line per import wave/);
  assert.match(s.out(), /--watch/);
  assert.match(s.out(), /--dry-run/);
  const h = setup(fakeT3());
  assert.equal(await main(["schedule", "--help"], h.io), 0);
  assert.match(h.out(), /^Usage: t3sm schedule install \[--watch\] \[--yes \| --dry-run\]\n +t3sm schedule remove \[--yes \| --dry-run\]\n +t3sm schedule restart \[--yes \| --dry-run\]\n +t3sm schedule status$/m);
  const u = setup(fakeT3());
  assert.equal(await main(["--help"], u.io), 0);
  assert.match(u.out(), /\n  t3sm sync /);
  assert.match(u.out(), /\n  t3sm schedule .*install/);
});

function fakeRunner() {
  const calls: string[][] = [];
  let task: string[] | null = null;
  const run: CommandRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "/Create") { task = args; return { code: 0, stdout: "SUCCESS", stderr: "" }; }
    if (args[0] === "/Query") return task ? { code: 0, stdout: `"\\t3code-session-manager sync","N/A","Running"\r\n`, stderr: "" } : { code: 1, stdout: "", stderr: "ERROR: not found" };
    if (args[0] === "/Delete") { const had = task; task = null; return { code: had ? 0 : 1, stdout: "", stderr: "" }; }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

test("schedule install --watch / status / remove through a fake runner (never a real task)", async () => {
  const s = setup(fakeT3());
  const r = fakeRunner();
  // A win32 schedule names its task XML with a Windows path on every host: kept in memory, never on the real disk.
  const fs = memScheduleFs();
  const deps = { runner: r.run, stopWatcher: async () => ({ how: "none" as const, pid: null, running: false }), platform: "win32" as const, home: s.home, nodePath: "C:\\Program Files\\nodejs\\node.exe", binPath: "C:\\t3sm\\bin\\t3sm.mjs", conhost: "C:\\Windows\\System32\\conhost.exe", fs };
  assert.equal(await scheduleCommand(["status"], s.io, deps), 0);
  assert.match(s.out(), /Scheduled sync +not installed/);
  assert.equal(await scheduleCommand(["install", "--watch", "--yes"], s.io, deps), 0);
  assert.match(s.out(), /Installed/);
  const create = r.calls.find((c) => c[1] === "/Create")!;
  assert.equal(create[2], "/XML");
  assert.match(fs.files.get(create[3]!)!.subarray(2).toString("utf16le"), /<LogonTrigger>/);
  assert.equal(create[3], win32.join(s.state, "schedule", "t3sm-task.xml"), "task XML lives in the state dir");
  assert.equal(await scheduleCommand(["install", "--watch", "--yes"], s.io, deps), 0, "idempotent");
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, "sync-status.json"), JSON.stringify({ pid: 777, startedAt: "2026-11-11T10:00:00.000Z", lastCycleAt: "2026-11-11T11:00:00.000Z", lastResult: { outcome: "ok", imported: 2 }, nextCycleAt: "2026-11-11T11:15:00.000Z" }));
  assert.equal(await scheduleCommand(["status"], s.io, { ...deps, isAlive: () => true }), 0);
  assert.match(s.out(), /Scheduled sync +installed \(schtasks\)\n/, "no N/A, no normal scheduler state");
  assert.match(s.out(), /Watcher +running \(pid 777\), last cycle Nov 11, \d\d:00 \(done\), next Nov 11,\s+\d\d:15/);
  assert.equal(await scheduleCommand(["remove", "--yes"], s.io, deps), 0);
  assert.equal(fs.files.size, 0, "task XML removed");
  assert.equal(await scheduleCommand(["remove", "--yes"], s.io, deps), 0);
  assert.match(s.out(), /Not installed; nothing to remove\./);
  assert.equal(await scheduleCommand(["bogus"], s.io, deps), 2);
});

// ---------- self-restart into a new install ----------

type SpawnCall = { cmd: string; args: string[]; opts: Record<string, unknown>; unref: number };
function fakeSpawn() {
  const calls: SpawnCall[] = [];
  const spawn = (cmd: string, args: string[], opts: object) => {
    const c: SpawnCall = { cmd, args, opts: opts as Record<string, unknown>, unref: 0 };
    calls.push(c);
    return { unref: () => { c.unref++; }, on: () => undefined };
  };
  return { spawn, calls };
}

test("spawnSuccessor: node directly on every platform (paths with spaces or cmd.exe metacharacters too), detached, hidden, stdio ignored, no CLAUDE_CONFIG_DIR, unref'd", () => {
  for (const [platform, nodePath, binPath] of [
    ["win32", "C:\Program Files\nodejs\node.exe", "C:\a%PATH%\t3sm.mjs"],
    ["linux", "/usr/bin/node", "/opt/my tools/t3sm/bin/t3sm.mjs"],
  ] as const) {
    const f = fakeSpawn();
    spawnSuccessor({ nodePath, binPath, spawn: f.spawn, env: { PATH: "/bin", claude_config_dir: "/x", CLAUDE_CONFIG_DIR: "/y", T3SM_HOME: "/work/state" } });
    assert.equal(f.calls.length, 1, platform);
    const c = f.calls[0]!;
    assert.equal(c.cmd, nodePath);
    assert.deepEqual(c.args, [binPath, "sync", "--watch", "--quiet"]);
    assert.equal(c.opts["detached"], true);
    assert.equal(c.opts["stdio"], "ignore");
    assert.equal(c.opts["windowsHide"], true);
    assert.deepEqual(c.opts["env"], { PATH: "/bin", T3SM_HOME: "/work/state" });
    assert.equal(c.unref, 1);
  }
});

test("spawnSuccessor: the child really runs (Windows: conhost.exe --headless with ignored stdio exits 0 and runs nothing)", async () => {
  const t = tempHome();
  const bin = join(t.home, "child one.mjs");
  const out = join(t.home, "ran.txt");
  writeFileSync(bin, `import { renameSync, writeFileSync } from "node:fs";
writeFileSync(process.argv[3] + ".tmp", process.argv.slice(2, 3).join(" "));
renameSync(process.argv[3] + ".tmp", process.argv[3]);
`);
  const exited = new Promise<void>((resolve) => {
    spawnSuccessor({
      nodePath: process.execPath, binPath: bin, argv: ["update", out],
      // Not unref'd here: the test waits for it.
      spawn: (cmd, args, opts) => { const c = nodeSpawn(cmd, args, opts); c.on("exit", () => resolve()); return { unref: () => {}, on: (ev, fn) => c.on(ev, fn) }; },
    });
  });
  await exited;
  assert.equal(readFileSync(out, "utf8"), "update");
});

test("sync --watch: a new install stamp after a cycle releases the pipe, then spawns exactly one successor, and exits 0", async () => {
  const s = setup(fakeT3());
  const order: string[] = [];
  const f = fakeSpawn();
  const stamps = [{ version: "0.3.0", stamp: "2026-11-15T10:00:00.000Z" }, { version: "0.3.1", stamp: "2026-11-16T10:00:00.000Z" }];
  let reads = 0;
  const code = await syncCommand(["--watch", "--quiet"], s.io, s.deps([], {
    platform: "win32",
    installReady: () => true,
    installStamp: () => stamps[Math.min(reads++, 1)]!,
    singleton: async (dir, platform, net, onStop) => {
      const h = await acquireWatcherSingleton(dir, platform, net, onStop);
      return h && { release: async () => { order.push("release"); await h.release(); } };
    },
    spawn: (cmd, args, opts) => {
      order.push("spawn");
      return f.spawn(cmd, args, opts);
    },
  }));
  assert.equal(code, 0);
  assert.deepEqual(order, ["release", "spawn"], "the successor finds the pipe free");
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0]!.args.join(" ").includes("sync --watch --quiet"));
  const hb = JSON.parse(readFileSync(join(s.state, "sync-status.json"), "utf8")) as Record<string, unknown>;
  assert.equal(hb["reason"], "restart");
  assert.equal(hb["version"], "0.3.0");
  assert.equal(typeof hb["stoppedAt"], "string");
  assert.match(log(s.state).at(-1)!, / restart from=0\.3\.0 to=0\.3\.1$/);
  // The pipe is free for the successor.
  const next = await acquireWatcherSingleton(s.state);
  assert.ok(next);
  await next.release();
});

test("sync --watch --quiet with the pipe taken (a keep-alive run) writes nothing and exits 0", async () => {
  const s = setup(fakeT3());
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, "sync-status.json"), JSON.stringify({ pid: 777, startedAt: new Date().toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null }));
  const held = await acquireWatcherSingleton(s.state);
  try {
    assert.equal(await syncCommand(["--watch", "--quiet"], s.io, s.deps([])), 0);
    assert.equal(s.out() + s.err(), "");
  } finally { await held!.release(); }
});

for (const platform of ["darwin", "linux", "win32"] as const) {
  test(`sync --watch restart on ${platform}: ${platform === "darwin" ? "under launchd: no successor, exit 75 so KeepAlive relaunches the new bin" : "one successor, exit 0"}`, async () => {
    const s = setup(fakeT3());
    if (platform === "darwin") s.io.env["XPC_SERVICE_NAME"] = "dev.t3sm.sync";
    const order: string[] = [];
    const f = fakeSpawn();
    const stamps = [{ version: "0.3.0", stamp: "2026-11-15T10:00:00.000Z" }, { version: "0.3.1", stamp: "2026-11-16T10:00:00.000Z" }];
    let reads = 0;
    const code = await syncCommand(["--watch", "--quiet"], s.io, s.deps([], {
      platform,
      installStamp: () => stamps[Math.min(reads++, 1)]!,
      installReady: () => true,
      singleton: async (dir, p, net, onStop) => {
        const h = await acquireWatcherSingleton(dir, p, net, onStop);
        return h && { release: async () => { order.push("release"); await h.release(); } };
      },
      spawn: (cmd, args, opts) => { order.push("spawn"); return f.spawn(cmd, args, opts); },
      }));
    const hb = JSON.parse(readFileSync(join(s.state, "sync-status.json"), "utf8")) as Record<string, unknown>;
    assert.equal(hb["reason"], "restart");
    if (platform === "darwin") {
      assert.equal(code, 75);
      assert.deepEqual(order, ["release"]);
      assert.equal(f.calls.length, 0);
    } else {
      assert.equal(code, 0);
      assert.deepEqual(order, ["release", "spawn"]);
      assert.equal(f.calls.length, 1);
    }
  });
}

test("sync --watch restart on macOS started by hand (no launchd job): spawns a successor like Linux and exits 0", async () => {
  for (const xpc of [undefined, "application.com.apple.Terminal", "dev.t3sm.other"]) {
    const s = setup(fakeT3());
    if (xpc !== undefined) s.io.env["XPC_SERVICE_NAME"] = xpc;
    const f = fakeSpawn();
    const stamps = [{ version: "0.3.0", stamp: "2026-11-15T10:00:00.000Z" }, { version: "0.3.1", stamp: "2026-11-16T10:00:00.000Z" }];
    let reads = 0;
    const code = await syncCommand(["--watch", "--quiet"], s.io, s.deps([], {
      platform: "darwin", installStamp: () => stamps[Math.min(reads++, 1)]!, installReady: () => true, spawn: f.spawn,
    }));
    assert.equal(code, 0, String(xpc));
    assert.equal(f.calls.length, 1, String(xpc));
  }
});

test("sync --watch with an unsafe socket directory: exit 0 (no launchd restart loop), the reason logged once, shown unless --quiet", async () => {
  const s = setup(fakeT3());
  const bad = async (): Promise<never> => { throw new UnsafeSocketDirError("/tmp/t3sm-1000"); };
  assert.equal(await syncCommand(["--watch", "--quiet"], s.io, s.deps([], { singleton: bad })), 0);
  assert.equal(s.err(), "", "--quiet: nothing on stderr");
  assert.equal(await syncCommand(["--watch", "--quiet"], s.io, s.deps([], { singleton: bad })), 0);
  const lines = log(s.state).filter((l) => l.includes("socket-dir-unsafe"));
  assert.equal(lines.length, 1, "the same problem is not logged again on every keep-alive run");
  assert.match(lines[0]!, /^\S+ socket-dir-unsafe \/tmp\/t3sm-1000$/);
  assert.equal(await syncCommand(["--watch"], s.io, s.deps([], { singleton: bad })), 0);
  assert.match(s.err(), /\/tmp\/t3sm-1000 is not safe.*0700/);
  // Any other startup error is not swallowed.
  await assert.rejects(() => syncCommand(["--watch", "--quiet"], s.io, s.deps([], { singleton: async () => { throw new Error("boom"); } })), /boom/);
});

test("sync --watch: an unknown install stamp still puts this t3sm's version in the heartbeat", async () => {
  const s = setup(fakeT3());
  let stopped = false;
  const code = syncCommand(["--watch", "--quiet"], s.io, s.deps([], {
    installStamp: () => { throw new Error("no build.json"); },
    signals: { on: (sig, fn) => { if (sig === "SIGINT" && !stopped) { stopped = true; setTimeout(fn, 50); } }, off() {} },
  }));
  assert.equal(await code, 0);
  const hb = JSON.parse(readFileSync(join(s.state, "sync-status.json"), "utf8")) as Record<string, unknown>;
  assert.equal(hb["version"], packageVersion());
  assert.equal(hb["stamp"], undefined);
  assert.match(log(s.state).join("\n"), / version-unknown Error/);
});

test("sync --watch: an update interrupted before the watcher started is journaled at start; the update check runs after a cycle", async () => {
  const s = setup(fakeT3());
  mkdirSync(s.state, { recursive: true });
  const attempt = {
    runId: "20261115-090000-abcd", previous: { version: "0.3.0", spec: "github:demo-owner/demo-app#v0.3.0" },
    source: { kind: "github", repo: "demo-owner/demo-app" }, target: "0.3.1", startedAt: "2026-11-15T09:00:00.000Z",
  };
  writeFileSync(join(s.state, "update.pending.json"), JSON.stringify(attempt));
  // A clock whose timers fire at once (time jumps ahead): the loop runs two cycles, then the third stamp restarts it.
  let now = Date.UTC(2026, 10, 15, 10);
  const cancelled = new Set<unknown>();
  let seq = 0;
  const clock = {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; setImmediate(() => { if (!cancelled.has(id)) { now += Math.max(0, ms); fn(); } }); return id; },
    clearTimer: (h: unknown) => void cancelled.add(h),
  };
  const stamps = [{ version: "0.3.0", stamp: "a" }, { version: "0.3.0", stamp: "a" }, { version: "0.3.1", stamp: "b" }];
  let reads = 0;
  let checks = 0;
  const f = fakeSpawn();
  const sent: string[] = [];
  const notifier = { notify: async (title: string, body: string) => { sent.push(`${title}: ${body}`); return true; } };
  const code = await syncCommand(["--watch", "--quiet"], s.io, s.deps([], {
    platform: "win32", clock, installReady: () => true, installStamp: () => stamps[Math.min(reads++, 2)]!, spawn: f.spawn,
    updateCheck: async () => { checks++; }, notifier,
  }));
  assert.equal(code, 0);
  assert.equal(checks, 1, "after the cycle that did not restart");
  const entries = readFileSync(join(s.state, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const mine = entries.filter((e) => e["t"] === "update" && e["runId"] === attempt.runId);
  assert.deepEqual(mine.map((e) => [e["outcome"], e["error"]]), [["failed", "interrupted"]]);
  const status = JSON.parse(readFileSync(join(s.state, "sync-status.json"), "utf8")) as { needsAttention?: { reason?: string } };
  assert.equal(status.needsAttention?.reason, "update-failed", "status says an update needs a look");
  assert.equal(sent.length, 1, "notified once");
  assert.match(sent[0]!, /0\.3\.1.*interrupted/);
  const notified = Object.keys((JSON.parse(readFileSync(join(s.state, "sync-status.json"), "utf8")) as { lastNotified?: Record<string, string> }).lastNotified ?? {});
  assert.ok(notified.includes("update-interrupted:0.3.1"), "an interrupted update has its own notification key");
  assert.ok(!notified.includes("update-failed:0.3.1"), "distinct from a failed update of the same version");
  // The next start finds the same record: journaled and notified already.
  reads = 0;
  assert.equal(await syncCommand(["--watch", "--quiet"], s.io, s.deps([], {
    platform: "win32", clock, installReady: () => true, installStamp: () => stamps[Math.min(reads++, 2)]!, spawn: f.spawn,
    updateCheck: async () => {}, notifier,
  })), 0);
  assert.equal(sent.length, 1);
  const again = readFileSync(join(s.state, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(again.filter((e) => e["t"] === "update" && e["runId"] === attempt.runId).length, 1);
});

test("sync --watch: with the lock taken at start (an update is running), the update record is left alone", async () => {
  const s = setup(fakeT3());
  mkdirSync(s.state, { recursive: true });
  const attempt = {
    runId: "20261115-090000-abcd", previous: { version: "0.3.0", spec: "github:demo-owner/demo-app#v0.3.0" },
    source: { kind: "github", repo: "demo-owner/demo-app" }, target: "0.3.1", startedAt: "2026-11-15T09:00:00.000Z",
  };
  writeFileSync(join(s.state, "update.pending.json"), JSON.stringify(attempt));
  const lock = await acquireLock(s.state);
  assert.ok(lock);
  try {
    const stamps = [{ version: "0.3.0", stamp: "a" }, { version: "0.3.1", stamp: "b" }];
    let reads = 0;
    const f = fakeSpawn();
    assert.equal(await syncCommand(["--watch", "--quiet"], s.io, s.deps([], {
      platform: "win32", installReady: () => true, installStamp: () => stamps[Math.min(reads++, 1)]!, spawn: f.spawn, updateCheck: async () => {},
    })), 0);
  } finally { await lock.release(); }
  assert.equal(existsSync(join(s.state, "journal.jsonl")) ? readFileSync(join(s.state, "journal.jsonl"), "utf8").includes(attempt.runId) : false, false, "nothing journaled");
  assert.deepEqual(JSON.parse(readFileSync(join(s.state, "update.pending.json"), "utf8")), attempt, "not marked interrupted");
});

// ---------- Task 21: the import screen of sync ----------

/** One watcher cycle with `items` to import; the install changes after it, so the watcher restarts and the loop ends. */
async function oneWatchCycle(args: string[], items: (s: ReturnType<typeof setup>, f: FakeT3) => PlanItem[]) {
  const f = fakeT3();
  const s = setup(f);
  const stamps = [{ version: "0.3.0", stamp: "2026-11-15T10:00:00.000Z" }, { version: "0.3.1", stamp: "2026-11-16T10:00:00.000Z" }];
  let reads = 0;
  const code = await syncCommand(args, s.io, s.deps(items(s, f), {
    platform: "win32", installReady: () => true, installStamp: () => stamps[Math.min(reads++, 1)]!, spawn: fakeSpawn().spawn,
  }));
  return { s, code };
}

test("sync --quiet and --watch print nothing: no progress bar and no wave lines (the watcher prints only its log lines)", async () => {
  // --quiet: an import cycle is silent.
  const f = fakeT3();
  const q = setup(f);
  assert.equal(await syncCommand(["--quiet", "--verbose"], q.io, q.deps([transcript(f, q.dir, ROOT, Date.now() - 3 * DAY), transcript(f, q.dir, ROOT, Date.now() - 4 * DAY)])), 0);
  assert.equal(q.out() + q.err(), "");
  assert.match(log(q.state)[0]!, / ok run=\S+ imported=2 failed=0/);
  // --watch: the cycle imports, and stdout has the log line, never the bar or a wave.
  const w = await oneWatchCycle(["--watch", "--verbose"], (s, g) => [transcript(g, s.dir, ROOT, Date.now() - 3 * DAY)]);
  assert.equal(w.code, 0);
  assert.match(w.s.out(), / ok run=\S+ imported=1 failed=0/);
  assert.doesNotMatch(w.s.out(), /Importing|Wave |%/);
  // --watch --quiet: nothing at all.
  const wq = await oneWatchCycle(["--watch", "--quiet"], (s, g) => [transcript(g, s.dir, ROOT, Date.now() - 3 * DAY)]);
  assert.equal(wq.code, 0);
  assert.equal(wq.s.out(), "");
  assert.match(log(wq.s.state).find((l) => / ok run=/.test(l))!, /imported=1 failed=0/);
});

test("sync: one progress bar for the import, the result panel, wave lines only with --verbose", async () => {
  const f = fakeT3();
  const s = setup(f);
  s.io.env = { ...s.io.env, LANG: "en_US.UTF-8" };
  assert.equal(await syncCommand([], s.io, s.deps([transcript(f, s.dir, ROOT, Date.now() - 3 * DAY)])), 0);
  assert.match(s.out(), /^Importing 1 conversation [·-] 1 project/m);
  assert.doesNotMatch(s.out(), /Wave /);
  assert.match(s.out(), /Imported 1 conversation/);
  assert.match(s.out(), /Undo +t3sm rollback /);
  const g = fakeT3();
  const v = setup(g);
  assert.equal(await syncCommand(["--verbose"], v.io, v.deps([transcript(g, v.dir, ROOT, Date.now() - 3 * DAY)])), 0);
  assert.match(v.out(), /^Wave 1\/1 · 1 project · 1 sessions · imported 1/m);
});

test("sync --watch: a stop request reaches the running cycle like SIGTERM (its steps stop after the current one), then the loop ends", async () => {
  const s = setup(fakeT3());
  let stop: (() => void) | undefined;
  const seen: boolean[] = [];
  const code = await syncCommand(["--watch", "--quiet"], s.io, s.deps([], {
    installStamp: () => ({ version: "0.3.0", stamp: "2026-11-15T10:00:00.000Z" }), installReady: () => true,
    singleton: async (dir, p, net, onStop) => { stop = onStop; return acquireWatcherSingleton(dir, p, net, onStop); },
    // The request arrives while the cycle is in its after-import steps (organize, follow, merge read ctx.aborted).
    afterApply: async (ctx) => { seen.push(ctx.aborted?.() === true); stop?.(); seen.push(ctx.aborted?.() === true); },
  }));
  assert.equal(code, 0);
  assert.deepEqual(seen, [false, true], "the cycle saw the stop at once, not only the loop after the cycle");
  const hb = JSON.parse(readFileSync(join(s.state, "sync-status.json"), "utf8")) as Record<string, unknown>;
  assert.equal(typeof hb["stoppedAt"], "string");
});
