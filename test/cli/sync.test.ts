import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { main, type Io } from "../../src/cli/main.ts";
import { syncCommand, type SyncCommandDeps } from "../../src/cli/commands/sync.ts";
import { scheduleCommand } from "../../src/cli/commands/schedule.ts";
import { acquireLock } from "../../src/core/lock.ts";
import type { PlanItem } from "../../src/core/types.ts";
import type { T3Api } from "../../src/t3/api.ts";
import type { CommandRunner } from "../../src/ops/schedule.ts";
import { T3Incompatible, T3NotRunning } from "../../src/t3/errors.ts";
import { acquireWatcherSingleton } from "../../src/ops/watch.ts";
import { defaultConfig, saveConfig } from "../../src/core/config.ts";
import { DAY, fakeT3, inst, tempHome, transcript, type FakeT3 } from "../apply/fake-t3.ts";
import { memScheduleFs } from "../ops/helpers.ts";

const ROOT = "C:/work/demo";

function setup(f: FakeT3) {
  const t = tempHome();
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: false, prompt: async () => "", env: { T3SM_HOME: t.state } };
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
  assert.match(s.out(), /^Nothing to import\.\n$/);
  assert.match(log(s.state)[1]!, / noop$/);
});

test("sync --dry-run prints what a cycle would import and writes nothing", async () => {
  const f = fakeT3();
  const s = setup(f);
  const items = [transcript(f, s.dir, ROOT, Date.now() - 3 * DAY)];
  assert.equal(await syncCommand(["--dry-run"], s.io, s.deps(items)), 0);
  assert.match(s.out(), /Dry run: a sync cycle would import 1 session \(claude 1\) into 1 project \(1 new\)\. Nothing was written\./);
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
  assert.match(s.out(), /^Usage: t3sm sync \[--quiet\] \[--allow-untested\]/);
  assert.match(s.out(), /--watch/);
  assert.match(s.out(), /--dry-run/);
  const h = setup(fakeT3());
  assert.equal(await main(["schedule", "--help"], h.io), 0);
  assert.match(h.out(), /^Usage: t3sm schedule install \[--watch\] \| remove \| status/);
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
  const deps = { runner: r.run, platform: "win32" as const, home: s.home, nodePath: "C:\\Program Files\\nodejs\\node.exe", binPath: "C:\\t3sm\\bin\\t3sm.mjs", conhost: "C:\\Windows\\System32\\conhost.exe", fs };
  assert.equal(await scheduleCommand(["status"], s.io, deps), 0);
  assert.match(s.out(), /Scheduled sync: not installed/);
  assert.equal(await scheduleCommand(["install", "--watch"], s.io, deps), 0);
  assert.match(s.out(), /Installed/);
  const create = r.calls.find((c) => c[1] === "/Create")!;
  assert.equal(create[2], "/XML");
  assert.match(fs.files.get(create[3]!)!.subarray(2).toString("utf16le"), /<LogonTrigger>/);
  assert.equal(create[3], win32.join(s.state, "schedule", "t3sm-task.xml"), "task XML lives in the state dir");
  assert.equal(await scheduleCommand(["install", "--watch"], s.io, deps), 0, "idempotent");
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, "sync-status.json"), JSON.stringify({ pid: 777, startedAt: "2026-11-11T10:00:00.000Z", lastCycleAt: "2026-11-11T11:00:00.000Z", lastResult: { outcome: "ok", imported: 2 }, nextCycleAt: "2026-11-11T11:15:00.000Z" }));
  assert.equal(await scheduleCommand(["status"], s.io, { ...deps, isAlive: () => true }), 0);
  assert.match(s.out(), /Scheduled sync: installed \(schtasks\), next run N\/A/);
  assert.match(s.out(), /Watcher: running \(pid 777\), last cycle 2026-11-11T11:00:00\.000Z \(ok\), next 2026-11-11T11:15:00\.000Z/);
  assert.equal(await scheduleCommand(["remove"], s.io, deps), 0);
  assert.equal(fs.files.size, 0, "task XML removed");
  assert.equal(await scheduleCommand(["remove"], s.io, deps), 0);
  assert.match(s.out(), /Not installed; nothing to remove\./);
  assert.equal(await scheduleCommand(["bogus"], s.io, deps), 2);
});
