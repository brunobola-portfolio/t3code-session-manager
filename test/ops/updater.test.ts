import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock } from "../../src/core/lock.ts";
import type { CommandRunner, RunResult } from "../../src/core/run.ts";
import type { JournalEntry } from "../../src/core/types.ts";
import type { Clock, Heartbeat } from "../../src/ops/watch.ts";
import { LAUNCHD_LABEL, TASK_NAME } from "../../src/ops/schedule.ts";
import {
  HEALTH_MS, INSTALL_TIMEOUT_MS, QUERY_TIMEOUT_MS, classify, readPendingUpdate, recoverInterruptedUpdate, installRelease, latestRelease, readUpdateState, releaseSpecOf, runUpdate, watcherOps, writeUpdateState,
  type UpdateSource, type UpdaterDeps, type WatcherOps,
} from "../../src/ops/updater.ts";
import { EXIT_GRACE_MS, KILL_GRACE_MS, defaultKill, updateRunner, type SpawnFn } from "../../src/ops/update.ts";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SpawnLike } from "../../src/ops/successor.ts";
import { memScheduleFs, tempRoot } from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 15, 10, 0, 0);
const GH: UpdateSource = { kind: "github", repo: "demo-owner/demo-app" };

/** A clock whose sleeps cost no real time: a timer advances the clock by its delay and fires at once. */
function stepClock(): Clock & { t: number } {
  const c = {
    t: T0,
    now: () => c.t,
    setTimer(fn: () => void, ms: number) { c.t += ms; queueMicrotask(fn); return 1; },
    clearTimer() {},
  };
  return c;
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (code = 1, stderr = "fatal: unable to access"): RunResult => ({ code, stdout: "", stderr });

interface Call { cmd: string; args: string[]; cwd?: string; input?: string; timeoutMs?: number }
function runner(handler: (c: Call) => RunResult | Promise<RunResult>): CommandRunner & { calls: Call[] } {
  const calls: Call[] = [];
  const run = (async (cmd: string, args: string[], opts?: { input?: string; cwd?: string; timeoutMs?: number }) => {
    const c: Call = { cmd, args, ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}), ...(opts?.input !== undefined ? { input: opts.input } : {}), ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) };
    calls.push(c);
    return handler(c);
  }) as CommandRunner & { calls: Call[] };
  run.calls = calls;
  return run;
}

/**
 * The world runUpdate acts on: an installed version that npm changes, a watcher whose heartbeat the fake restart writes
 * (only for the versions `healthy` accepts), and a real state dir (lock, journal, update.json).
 */
function world(o: { installed: string; source?: UpdateSource; healthy?: (v: string) => boolean; npm?: (c: Call) => RunResult | null; watcherRunning?: boolean }) {
  const t = tempRoot();
  mkdirSync(t.state, { recursive: true });
  const clock = stepClock();
  const iso = (): string => new Date(clock.now()).toISOString();
  const st = {
    installed: o.installed,
    hb: (o.watcherRunning ?? true) ? { pid: 4242, startedAt: new Date(T0 - 3600_000).toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null, protocol: 1, version: o.installed } as Heartbeat : null,
    stops: 0,
    restarts: [] as { wasRunning: boolean; reinstallSchedule: boolean }[],
    branch: null as string | null,
  };
  const run = runner((c) => {
    if (c.cmd === "git" && c.args.includes("clone")) { st.branch = c.args[c.args.indexOf("--branch") + 1]!; return ok(); }
    if (c.cmd === "npm" && c.args[0] === "install") {
      const r = o.npm?.(c) ?? ok();
      if (r.code === 0) {
        const spec = c.args.at(-1)!;
        st.installed = spec === "." ? st.branch!.slice(1) : /#v(.+)$/.exec(spec)![1]!;
      }
      return r;
    }
    return fail(127, "not found");
  });
  const watcher: WatcherOps = {
    stop: async () => {
      st.stops++;
      const was = st.hb !== null && !st.hb.stoppedAt;
      if (st.hb) st.hb = { ...st.hb, stoppedAt: iso() };
      return { how: was ? "request" : "none", pid: was ? 4242 : null, running: false };
    },
    restart: async (r) => {
      st.restarts.push(r);
      if ((o.healthy ?? (() => true))(st.installed)) {
        st.hb = { pid: 5000 + st.restarts.length, startedAt: iso(), lastCycleAt: null, lastResult: null, nextCycleAt: null, protocol: 1, version: st.installed };
      }
      return true;
    },
  };
  const deps = (over: Partial<UpdaterDeps> = {}): UpdaterDeps => ({
    stateDir: t.state, platform: "win32", installed: st.installed, run, clock, journal: t.journal, watcher,
    readHeartbeat: async () => st.hb, pollMs: 1000,
    ...over,
  });
  const updates = async (): Promise<Extract<JournalEntry, { t: "update" }>[]> =>
    (await t.journal.readAll()).filter((e): e is Extract<JournalEntry, { t: "update" }> => e.t === "update");
  const npmInstalls = (): string[] => run.calls.filter((c) => c.cmd === "npm" && c.args[0] === "install").map((c) => c.args.at(-1)!);
  return { t, clock, st, run, watcher, deps, updates, npmInstalls, source: o.source ?? GH };
}

async function seed(w: ReturnType<typeof world>): Promise<void> {
  await writeUpdateState(w.t.state, { source: w.source, lastCheckAt: null, previous: null, available: null, skip: [] });
}

// ---------- classify, latestRelease ----------

test("never downgrade: local 0.3.0 vs GitHub 0.2.1 is none", async () => {
  const lsRemote = [
    "1111111111111111111111111111111111111111\trefs/tags/v0.1.0",
    "2222222222222222222222222222222222222222\trefs/tags/v0.2.1",
    "3333333333333333333333333333333333333333\trefs/tags/v0.2.0",
    "4444444444444444444444444444444444444444\trefs/tags/v0.2.2-rc1",
    "5555555555555555555555555555555555555555\trefs/tags/latest",
    "",
  ].join("\n");
  const run = runner((c) => (c.cmd === "git" ? ok(lsRemote) : fail()));
  const latest = await latestRelease(GH, run);
  assert.equal(latest, "0.2.1");
  // Every query has a 60 s limit: a stalled proxy or a credential prompt never holds the sync lock for long.
  assert.deepEqual(run.calls[0], { cmd: "git", args: ["ls-remote", "--tags", "--refs", "https://github.com/demo-owner/demo-app.git"], timeoutMs: QUERY_TIMEOUT_MS });
  assert.equal(QUERY_TIMEOUT_MS, 60_000);
  assert.equal(classify("0.3.0", latest!), "none");
  assert.equal(classify("0.3.0", "0.3.0"), "none");
  assert.equal(classify("0.3.0", "0.2.9"), "none");
  assert.equal(classify("0.3.0", "not-a-version"), "none");

  // runUpdate itself refuses anything not strictly newer: nothing installed, nothing journaled.
  const w = world({ installed: "0.3.0" });
  await seed(w);
  const r = await runUpdate("0.2.1", w.deps());
  assert.deepEqual(r, { outcome: "failed", from: "0.3.0", to: "0.2.1", error: "not-newer" });
  assert.equal(w.run.calls.length, 0);
  assert.deepEqual(await w.updates(), []);
  assert.equal(w.st.stops, 0);
});

test("major only announced", () => {
  assert.equal(classify("0.3.0", "1.0.0"), "major");
  assert.equal(classify("v0.3.0", "v2.0.0"), "major");
  // 0.x minors install by themselves (spec §5.3): a minor, not a major.
  assert.equal(classify("0.3.0", "0.4.0"), "minor");
  assert.equal(classify("0.3.0", "0.3.1"), "patch");
  assert.equal(classify("1.2.3", "1.3.0"), "minor");
});

test("offline (git and npm fail): null, no error", async () => {
  const run = runner(() => fail(128, "fatal: unable to access 'https://github.com/': Could not resolve host"));
  assert.equal(await latestRelease(GH, run), null);
  assert.deepEqual(run.calls.map((c) => [c.cmd, ...c.args]), [
    ["git", "ls-remote", "--tags", "--refs", "https://github.com/demo-owner/demo-app.git"],
    ["npm", "view", "github:demo-owner/demo-app", "version"],
  ]);
  // A runner that rejects (spawn blew up) is offline too.
  const boom = (async () => { throw new Error("spawn EPERM"); }) as CommandRunner;
  assert.equal(await latestRelease(GH, boom), null);
  // A folder whose git fails, and a folder that is not absolute (never run).
  const f = runner(() => fail(128, "fatal: not a git repository"));
  assert.equal(await latestRelease({ kind: "folder", path: "C:\\work\\demo" }, f, "win32"), null);
  const rel = runner(() => ok("v9.9.9\n"));
  assert.equal(await latestRelease({ kind: "folder", path: "work/demo" }, rel, "win32"), null);
  assert.equal(rel.calls.length, 0);
});

test("latestRelease github: npm fallback when git is missing; junk output is no release", async () => {
  const run = runner((c) => (c.cmd === "git" ? fail(127, "git: not found") : ok("0.3.1\n")));
  assert.equal(await latestRelease(GH, run), "0.3.1");
  const junk = runner((c) => (c.cmd === "git" ? fail(128) : ok("'0.3.1-rc1'\n")));
  assert.equal(await latestRelease(GH, junk), null);
  // git answered, with no release tag: no release, and npm is not asked (it would only read the default branch).
  const noTags = runner((c) => (c.cmd === "git" ? ok("1111111111111111111111111111111111111111\trefs/tags/v0.3.1-rc1\n") : ok("0.3.1\n")));
  assert.equal(await latestRelease(GH, noTags), null);
  assert.deepEqual(noTags.calls.map((c) => c.cmd), ["git"]);
  // A repo slug that is not owner/name is never put on a command line.
  const bad = runner(() => ok(""));
  assert.equal(await latestRelease({ kind: "github", repo: "x/y --upload-pack=evil" }, bad), null);
  assert.equal(bad.calls.length, 0);
});

test("latestRelease skips a version that was rolled back; a newer one still shows", async () => {
  const tags = (vs: string[]): string => vs.map((v, i) => `${String(i).repeat(40)}\trefs/tags/v${v}`).join("\n");
  const run = runner(() => ok(tags(["0.3.0", "0.3.1"])));
  assert.equal(await latestRelease(GH, run, "linux", ["0.3.1"]), "0.3.0");
  const newer = runner(() => ok(tags(["0.3.0", "0.3.1", "0.3.2"])));
  assert.equal(await latestRelease(GH, newer, "linux", ["v0.3.1"]), "0.3.2");
  const folder = runner(() => ok("v0.3.0\nv0.3.1\n"));
  assert.equal(await latestRelease({ kind: "folder", path: "/home/demo/code/app" }, folder, "linux", ["0.3.1"]), "0.3.0");
});

test("latestRelease folder: tags merged into main (master when there is no main), newest release wins", async () => {
  const run = runner((c) => {
    if (c.args.includes("main")) return fail(128, "fatal: malformed object name main");
    return ok("v0.2.1\nv0.3.0\nv0.3.1-rc1\nvnext\nv0.10.0\n");
  });
  assert.equal(await latestRelease({ kind: "folder", path: "/home/demo/code/app" }, run, "linux"), "0.10.0");
  assert.deepEqual(run.calls.map((c) => [c.cmd, ...c.args]), [
    ["git", "-C", "/home/demo/code/app", "tag", "--merged", "main", "--list", "v*"],
    ["git", "-C", "/home/demo/code/app", "tag", "--merged", "master", "--list", "v*"],
  ]);
});

// ---------- installRelease ----------

test("folder source installs from a clone of the tag", async () => {
  const t = tempRoot();
  const made: string[] = [];
  const tmp = {
    make: async () => { const d = mkdtempSync(join(t.root, "clone-")); made.push(d); return d; },
    remove: (p: string) => rm(p, { recursive: true, force: true }),
  };
  const run = runner(() => ok());
  await installRelease({ kind: "folder", path: "C:\\work\\demo" }, "0.3.1", { run, platform: "win32", tmp });
  assert.equal(made.length, 1);
  assert.deepEqual(run.calls, [
    { cmd: "git", args: ["-c", "advice.detachedHead=false", "clone", "--depth", "1", "--branch", "v0.3.1", "--", "file:///C:/work/demo", made[0]!], timeoutMs: INSTALL_TIMEOUT_MS },
    // The clone is installed from its own folder: no path on npm's command line (npm.cmd needs a shell on Windows).
    { cmd: "npm", args: ["install", "-g", "--install-links", "--no-audit", "--no-fund", "--no-update-notifier", "."], cwd: made[0]!, timeoutMs: INSTALL_TIMEOUT_MS },
  ]);
  assert.equal(existsSync(made[0]!), false, "the temporary clone is removed");

  // POSIX path; npm fails: the clone is still removed and the error says what failed.
  const run2 = runner((c) => (c.cmd === "npm" ? fail(1, "npm ERR! code EACCES\nnpm ERR! more") : ok()));
  await assert.rejects(installRelease({ kind: "folder", path: "/home/demo/code/app" }, "0.3.1", { run: run2, platform: "linux", tmp }), /npm install failed \(exit 1\): npm ERR! code EACCES/);
  assert.equal(run2.calls[0]!.args[8], "file:///home/demo/code/app");
  assert.equal(existsSync(made[1]!), false);

  // GitHub source: one npm call with the exact tag.
  const run3 = runner(() => ok());
  await installRelease(GH, "0.3.1", { run: run3, platform: "linux" });
  assert.deepEqual(run3.calls, [{ cmd: "npm", args: ["install", "-g", "--install-links", "--no-audit", "--no-fund", "--no-update-notifier", "github:demo-owner/demo-app#v0.3.1"], timeoutMs: INSTALL_TIMEOUT_MS }]);
  assert.equal(INSTALL_TIMEOUT_MS, 600_000);

  // A command that never answers (timed out, exit 124) is a failure that says so.
  const slow = runner(() => ({ code: 124, stdout: "", stderr: "timed out after 600 s" }));
  await assert.rejects(installRelease(GH, "0.3.1", { run: slow, platform: "linux" }), /npm install timed out after 600 s/);

  // Refused before anything runs: a version that is not a release, a relative folder, a bad slug.
  const none = runner(() => ok());
  await assert.rejects(installRelease(GH, "0.3.1 && calc", { run: none, platform: "win32" }), /not a release version/);
  await assert.rejects(installRelease({ kind: "folder", path: "work\\demo" }, "0.3.1", { run: none, platform: "win32", tmp }), /absolute/);
  await assert.rejects(installRelease({ kind: "folder", path: "-uevil" }, "0.3.1", { run: none, platform: "linux", tmp }), /absolute/);
  await assert.rejects(installRelease({ kind: "github", repo: "../x" }, "0.3.1", { run: none, platform: "linux" }), /owner\/name/);
  // Network folders are refused: only a local checkout is an update source.
  const remote: [NodeJS.Platform, string][] = [
    ["win32", "\\\\srv\\share\\repo"], ["win32", "\\\\?\\UNC\\srv\\share\\repo"], ["win32", "//srv/share/repo"],
    ["win32", "\\\\?\\C:\\work\\demo"], ["win32", "\\work\\demo"], ["linux", "//srv/share/repo"],
  ];
  for (const [platform, path] of remote) {
    await assert.rejects(installRelease({ kind: "folder", path }, "0.3.1", { run: none, platform, tmp }), /must be a local absolute path.*network folders are not accepted/, path);
    assert.equal(await latestRelease({ kind: "folder", path }, none, platform), null, path);
  }
  assert.equal(none.calls.length, 0);
  assert.equal(made.length, 2, "no clone folder made for a refused install");
});

test("releaseSpecOf: what rollback reinstalls", () => {
  assert.equal(releaseSpecOf(GH, "0.3.0"), "github:demo-owner/demo-app#v0.3.0");
  assert.equal(releaseSpecOf({ kind: "folder", path: "C:\\work\\demo" }, "v0.3.0"), "folder:C:\\work\\demo#v0.3.0");
});

// ---------- runUpdate ----------

test("healthy update: installed, watcher restarted into it, schedule reinstalled, journaled pending then installed", async () => {
  const w = world({ installed: "0.3.0" });
  await seed(w);
  const r = await runUpdate("0.3.1", w.deps());
  assert.deepEqual(r, { outcome: "installed", from: "0.3.0", to: "0.3.1" });
  assert.deepEqual(w.npmInstalls(), ["github:demo-owner/demo-app#v0.3.1"]);
  assert.equal(w.st.stops, 1);
  assert.deepEqual(w.st.restarts, [{ wasRunning: true, reinstallSchedule: true }]);
  const u = await w.updates();
  assert.deepEqual(u.map((e) => e.outcome), ["pending", "installed"]);
  assert.equal(u[0]!.runId, u[1]!.runId);
  assert.deepEqual({ from: u[1]!.from, to: u[1]!.to, source: u[1]!.source }, { from: "0.3.0", to: "0.3.1", source: GH });
  assert.equal(u[1]!.error, undefined);
  const s = await readUpdateState(w.t.state);
  assert.deepEqual(s, { source: GH, lastCheckAt: null, previous: { version: "0.3.0", spec: "github:demo-owner/demo-app#v0.3.0" }, available: null, skip: [] });
  // The lock is released afterwards.
  const l = await acquireLock(w.t.state);
  assert.ok(l);
  await l.release();
});

test("new version never beats: rolled back to previous within 120 s", async () => {
  const w = world({ installed: "0.3.0", healthy: (v) => v !== "0.3.1" });
  await seed(w);
  const r = await runUpdate("0.3.1", w.deps());
  assert.equal(r.outcome, "rolled-back");
  assert.equal(r.from, "0.3.0");
  assert.equal(r.to, "0.3.1");
  assert.match(r.error ?? "", /no healthy heartbeat from 0\.3\.1 within 120 s/);
  assert.equal(HEALTH_MS, 120_000);
  assert.ok(w.clock.now() - T0 >= HEALTH_MS, "waited the full 120 s");
  assert.ok(w.clock.now() - T0 <= HEALTH_MS + 1000, "and not longer than one poll past it");
  assert.deepEqual(w.npmInstalls(), ["github:demo-owner/demo-app#v0.3.1", "github:demo-owner/demo-app#v0.3.0"]);
  assert.equal(w.st.installed, "0.3.0");
  assert.equal(w.st.stops, 2, "the new watcher is stopped before the old version starts");
  assert.deepEqual(w.st.restarts, [{ wasRunning: true, reinstallSchedule: true }, { wasRunning: true, reinstallSchedule: false }]);
  assert.equal(w.st.hb?.version, "0.3.0");
  const u = await w.updates();
  assert.deepEqual(u.map((e) => e.outcome), ["pending", "rolled-back"]);
  assert.match(u[1]!.error ?? "", /120 s/);
  const s = await readUpdateState(w.t.state);
  assert.equal(s?.previous, null, "no install went through: the guessed rollback spec stays out of update.json");
  assert.deepEqual(s?.skip, ["0.3.1"], "the rolled-back version is not offered again");
  assert.deepEqual(s?.source, GH);
  // A newer release that installs clears it.
  assert.equal((await runUpdate("0.3.2", w.deps({ installed: "0.3.0" }))).outcome, "installed");
  assert.deepEqual((await readUpdateState(w.t.state))?.skip, []);
});

test("the 120 s start when the restart has returned, not before", async () => {
  const w = world({ installed: "0.3.0", healthy: () => false });
  await seed(w);
  let upAt = Infinity;
  w.watcher.restart = async (r) => {
    w.st.restarts.push(r);
    w.clock.t += 100_000; // a slow scheduler call
    upAt = w.clock.now() + 50_000; // the new watcher beats 50 s after the restart returned
    return true;
  };
  const read = async (): Promise<Heartbeat | null> => w.clock.now() >= upAt
    ? { pid: 7000, startedAt: new Date(upAt).toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null, version: "0.3.1" }
    : w.st.hb;
  assert.equal((await runUpdate("0.3.1", w.deps({ readHeartbeat: read }))).outcome, "installed");
});

test("update.json that cannot be written: before the install, failed with nothing touched; after it, the outcome still holds", async () => {
  // Before the install: nothing installed, the watcher left alone, the failure journaled.
  const a = world({ installed: "0.3.0" });
  await seed(a);
  const r = await runUpdate("0.3.1", a.deps({ writeState: async () => { throw new Error("EACCES: permission denied, open 'update.json'"); } }));
  assert.equal(r.outcome, "failed");
  assert.match(r.error ?? "", /EACCES/);
  assert.deepEqual(a.npmInstalls(), []);
  assert.equal(a.st.stops, 0);
  assert.deepEqual((await a.updates()).map((e) => e.outcome), ["pending", "failed"]);

  // After a good install: still installed (the version runs), the write failure does not change that.
  const b = world({ installed: "0.3.0" });
  await seed(b);
  let n = 0;
  const flaky = async (): Promise<void> => { if (++n > 1) throw new Error("ENOSPC: no space left on device"); };
  assert.equal((await runUpdate("0.3.1", b.deps({ writeState: flaky }))).outcome, "installed");
  assert.deepEqual((await b.updates()).map((e) => e.outcome), ["pending", "installed"]);

  // A rollback whose state write fails still restarts the previous version and says rolled-back.
  const c = world({ installed: "0.3.0", healthy: (v) => v !== "0.3.1" });
  await seed(c);
  n = 0;
  assert.equal((await runUpdate("0.3.1", c.deps({ writeState: flaky }))).outcome, "rolled-back");
  assert.equal(c.st.restarts.length, 2);
  assert.equal(c.st.hb?.version, "0.3.0");
});

test("a watcher stop or restart that throws: the update still journals its outcome", async () => {
  const w = world({ installed: "0.3.0" });
  await seed(w);
  const restart = w.watcher.restart;
  w.watcher.stop = async () => { throw new Error("EPERM"); };
  const r = await runUpdate("0.3.1", w.deps());
  assert.equal(r.outcome, "installed", "the restart still ran and the new version beat");
  assert.deepEqual((await w.updates()).map((e) => e.outcome), ["pending", "installed"]);
  // A restart that throws: no watcher came up because the restart did not happen, which says nothing about 0.3.1. It is
  // not a rolled-back release: it stays installed, out of `skip`, and the outcome carries the reason.
  const v = world({ installed: "0.3.0" });
  await seed(v);
  let first = true;
  v.watcher.restart = async (o) => { if (first) { first = false; throw new Error("schtasks /Create failed: EPERM"); } return restart(o); };
  const r2 = await runUpdate("0.3.1", v.deps());
  assert.equal(r2.outcome, "installed");
  assert.match(r2.error ?? "", /could not be started again \(schtasks \/Create failed: EPERM\); 0\.3\.1 is installed/);
  assert.deepEqual(v.npmInstalls(), ["github:demo-owner/demo-app#v0.3.1"], "no reinstall of 0.3.0");
  assert.deepEqual((await v.updates()).map((e) => [e.outcome, e.error ?? null]), [["pending", null], ["installed", r2.error]]);
  assert.deepEqual((await readUpdateState(v.t.state))?.skip, [], "the good release is not skipped by the daily check");
});

test("a watcher that is still running after the stop (busy, or not verifiable) does not get the new release rolled back and skipped", async () => {
  const w = world({ installed: "0.3.0", healthy: () => false });
  await seed(w);
  w.watcher.stop = async () => { w.st.stops++; return { how: "none", pid: null, running: true }; };
  const r = await runUpdate("0.3.1", w.deps());
  assert.equal(r.outcome, "installed");
  assert.match(r.error ?? "", /the running watcher did not stop; 0\.3\.1 is installed/);
  assert.equal(w.st.restarts.length, 1, "the start still ran (the schedule is re-registered); no rollback restart");
  assert.deepEqual(w.npmInstalls(), ["github:demo-owner/demo-app#v0.3.1"]);
  assert.deepEqual((await readUpdateState(w.t.state))?.skip, []);
  // With the pid known, the reason names it.
  const p = world({ installed: "0.3.0", healthy: () => false });
  await seed(p);
  p.watcher.stop = async () => ({ how: "pid", pid: 4242, running: true });
  assert.match((await runUpdate("0.3.1", p.deps())).error ?? "", /the running watcher \(pid 4242\) did not stop/);
  // A real failure of the new version (the restart happened, nothing healthy came up) still rolls back and skips.
  const bad = world({ installed: "0.3.0", healthy: (v) => v !== "0.3.1" });
  await seed(bad);
  assert.equal((await runUpdate("0.3.1", bad.deps())).outcome, "rolled-back");
  assert.deepEqual((await readUpdateState(bad.t.state))?.skip, ["0.3.1"]);
});

test("a heartbeat of the new version that says it stopped, or predates the restart, is not healthy", async () => {
  const w = world({ installed: "0.3.0", healthy: () => false });
  await seed(w);
  // The new version wrote a heartbeat and stopped at once (it crashed out cleanly): still a rollback.
  w.watcher.restart = async (r) => {
    w.st.restarts.push(r);
    w.st.hb = { pid: 6000, startedAt: new Date(w.clock.now()).toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null, version: w.st.installed, stoppedAt: new Date(w.clock.now()).toISOString() };
    return true;
  };
  assert.equal((await runUpdate("0.3.1", w.deps())).outcome, "rolled-back");
  // A heartbeat of the new version that started before the restart (not the watcher this update started).
  const v = world({ installed: "0.3.0", healthy: () => false });
  await seed(v);
  v.watcher.restart = async (r) => {
    v.st.restarts.push(r);
    v.st.hb = { pid: 6001, startedAt: new Date(T0 - 60_000).toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null, version: v.st.installed };
    return true;
  };
  assert.equal((await runUpdate("0.3.1", v.deps())).outcome, "rolled-back");
});

test("rollback that cannot reinstall the previous version: failed, says both", async () => {
  let n = 0;
  const w = world({ installed: "0.3.0", healthy: (v) => v !== "0.3.1", npm: () => (++n === 2 ? fail(1, "npm ERR! notarget v0.3.0") : null) });
  await seed(w);
  const r = await runUpdate("0.3.1", w.deps());
  assert.equal(r.outcome, "failed");
  assert.match(r.error ?? "", /no healthy heartbeat from 0\.3\.1.*reinstalling 0\.3\.0 failed.*notarget/);
  assert.deepEqual((await w.updates()).map((e) => e.outcome), ["pending", "failed"]);
});

test("install fails half-way: failed, previous untouched, journaled", async () => {
  const w = world({ installed: "0.3.0", npm: () => fail(1, "npm ERR! code ETIMEDOUT\nnpm ERR! network request failed") });
  await seed(w);
  const r = await runUpdate("0.3.1", w.deps());
  assert.equal(r.outcome, "failed");
  assert.match(r.error ?? "", /npm install failed \(exit 1\): npm ERR! code ETIMEDOUT/);
  assert.equal(w.st.installed, "0.3.0");
  assert.equal(w.st.stops, 0, "the running watcher is left alone");
  assert.deepEqual(w.st.restarts, []);
  assert.equal(w.st.hb?.version, "0.3.0");
  assert.equal(w.st.hb?.stoppedAt, undefined);
  const u = await w.updates();
  assert.deepEqual(u.map((e) => e.outcome), ["pending", "failed"]);
  assert.match(u[1]!.error ?? "", /ETIMEDOUT/);
  const s = await readUpdateState(w.t.state);
  assert.deepEqual(s, { source: GH, lastCheckAt: null, previous: null, available: null, skip: [] }, "untouched");
});

test("npm missing: failed with the install hint", async () => {
  const w = world({ installed: "0.3.0", npm: () => fail(127, "") });
  await seed(w);
  const r = await runUpdate("0.3.1", w.deps());
  assert.equal(r.outcome, "failed");
  assert.match(r.error ?? "", /npm was not found on PATH\. Install Node\.js \(it includes npm\)/);
  assert.equal(w.st.stops, 0);
  // git missing for a folder source: its own hint.
  const f = world({ installed: "0.3.0", source: { kind: "folder", path: "C:\\work\\demo" } });
  await seed(f);
  f.run.calls.length = 0;
  const gitless = runner(() => fail(127, ""));
  const r2 = await runUpdate("0.3.1", f.deps({ run: gitless, tmp: { make: async () => mkdtempSync(join(f.t.root, "c-")), remove: (p) => rm(p, { recursive: true, force: true }) } }));
  assert.match(r2.error ?? "", /git was not found on PATH\. Install Git/);
});

test("busy lock: retried later", async () => {
  const w = world({ installed: "0.3.0" });
  await seed(w);
  const held = await acquireLock(w.t.state);
  assert.ok(held);
  const r = await runUpdate("0.3.1", w.deps());
  assert.deepEqual(r, { outcome: "failed", from: "0.3.0", to: "0.3.1", error: "busy" });
  assert.equal(w.run.calls.length, 0);
  assert.deepEqual(await w.updates(), [], "nothing journaled without the lock");
  assert.equal(w.st.stops, 0);
  await held.release();
  // The next check finds the lock free.
  const again = await runUpdate("0.3.1", w.deps());
  assert.equal(again.outcome, "installed");
});

test("two updates in a row", async () => {
  const w = world({ installed: "0.3.0" });
  await seed(w);
  assert.equal((await runUpdate("0.3.1", w.deps())).outcome, "installed");
  const second = await runUpdate("0.3.2", w.deps());
  assert.deepEqual(second, { outcome: "installed", from: "0.3.1", to: "0.3.2" });
  assert.deepEqual(w.npmInstalls(), ["github:demo-owner/demo-app#v0.3.1", "github:demo-owner/demo-app#v0.3.2"]);
  const u = await w.updates();
  assert.deepEqual(u.map((e) => [e.from, e.to, e.outcome]), [["0.3.0", "0.3.1", "pending"], ["0.3.0", "0.3.1", "installed"], ["0.3.1", "0.3.2", "pending"], ["0.3.1", "0.3.2", "installed"]]);
  assert.notEqual(u[0]!.runId, u[2]!.runId);
  assert.deepEqual((await readUpdateState(w.t.state))?.previous, { version: "0.3.1", spec: "github:demo-owner/demo-app#v0.3.1" });
  assert.equal(w.st.hb?.version, "0.3.2");
});

test("folder source end to end: the tag is cloned and installed; source remembered; no watcher, no schedule: no health wait", async () => {
  const w = world({ installed: "0.3.0", source: { kind: "folder", path: "C:\\work\\demo" }, watcherRunning: false });
  // No update.json yet: the source comes from the caller (`t3sm update --from <folder>`) and is remembered.
  w.watcher.restart = async (r) => { w.st.restarts.push(r); return false; }; // nothing to restart
  const tmp = { make: async () => mkdtempSync(join(w.t.root, "c-")), remove: (p: string) => rm(p, { recursive: true, force: true }) };
  const r = await runUpdate("0.3.1", w.deps({ source: { kind: "folder", path: "C:\\work\\demo" }, tmp }));
  assert.equal(r.outcome, "installed");
  assert.equal(w.st.installed, "0.3.1");
  assert.equal(w.clock.now(), T0, "no heartbeat wait when no watcher is expected");
  assert.deepEqual(await readUpdateState(w.t.state), {
    source: { kind: "folder", path: "C:\\work\\demo" }, lastCheckAt: null, previous: { version: "0.3.0", spec: "folder:C:\\work\\demo#v0.3.0" }, available: null, skip: [],
  });
});

test("a new source is remembered only after the new version is in", async () => {
  const w = world({ installed: "0.3.0", npm: () => fail(1, "npm ERR! boom") });
  await seed(w);
  const folder: UpdateSource = { kind: "folder", path: "C:\\work\\demo" };
  const tmp = { make: async () => mkdtempSync(join(w.t.root, "c-")), remove: (p: string) => rm(p, { recursive: true, force: true }) };
  assert.equal((await runUpdate("0.3.1", w.deps({ source: folder, tmp }))).outcome, "failed");
  assert.deepEqual((await readUpdateState(w.t.state))?.source, GH);
});

test("no update.json and a failed --from: no source is remembered", async () => {
  const w = world({ installed: "0.3.0", npm: () => fail(1, "npm ERR! boom") });
  const folder: UpdateSource = { kind: "folder", path: "D:\\typo" };
  const tmp = { make: async () => mkdtempSync(join(w.t.root, "c-")), remove: (p: string) => rm(p, { recursive: true, force: true }) };
  assert.equal((await runUpdate("0.3.1", w.deps({ source: folder, tmp }))).outcome, "failed");
  assert.equal(await readUpdateState(w.t.state), null, "update.json is not created by a failed update");
  // A rollback without update.json remembers nothing either (no source was ever confirmed).
  const v = world({ installed: "0.3.0", healthy: (x) => x !== "0.3.1" });
  assert.equal((await runUpdate("0.3.1", v.deps({ source: folder, tmp }))).outcome, "rolled-back");
  assert.equal(await readUpdateState(v.t.state), null);
});

test("the attempt is on disk (update.pending.json) during the install, and gone after every outcome", async () => {
  for (const [name, o] of [
    ["installed", {}],
    ["failed", { npm: () => fail(1, "npm ERR! boom") }],
    ["rolled-back", { healthy: (v: string) => v !== "0.3.1" }],
  ] as const) {
    let seen: unknown = null;
    const w = world({ installed: "0.3.0", ...o, npm: (c) => { if (seen === null) seen = JSON.parse(readFileSync(join(w.t.state, "update.pending.json"), "utf8")); return "npm" in o ? o.npm() : null; } });
    await seed(w);
    const r = await runUpdate("0.3.1", w.deps());
    assert.equal(r.outcome, name);
    const runId = (await w.updates())[0]!.runId;
    assert.deepEqual({ ...(seen as Record<string, unknown>), startedAt: "-" }, {
      runId, previous: { version: "0.3.0", spec: "github:demo-owner/demo-app#v0.3.0" }, source: GH, target: "0.3.1", startedAt: "-",
    }, name);
    assert.equal(existsSync(join(w.t.state, "update.pending.json")), false, `${name}: removed`);
    assert.equal(await readPendingUpdate(w.t.state), null);
  }
});

test("an update interrupted mid-way (t3sm killed) is reported on the next run, its previous version kept until then", async () => {
  const w = world({ installed: "0.3.0" });
  await seed(w);
  const attempt = { runId: "20261115-090000-abcd", previous: { version: "0.3.0", spec: "github:demo-owner/demo-app#v0.3.0" }, source: GH, target: "0.3.1", startedAt: "2026-11-15T09:00:00.000Z" };
  writeFileSync(join(w.t.state, "update.pending.json"), JSON.stringify(attempt));
  await w.t.journal.append({ t: "update", runId: attempt.runId, from: "0.3.0", to: "0.3.1", source: GH, outcome: "pending" });
  // A status read sees it (read-only).
  assert.deepEqual(await readPendingUpdate(w.t.state), attempt);
  // Recovery (under the lock) journals it once and keeps the record for a rollback.
  const rec = await recoverInterruptedUpdate(w.t.state, w.t.journal);
  assert.deepEqual(rec, { ...attempt, interrupted: true });
  assert.deepEqual(await recoverInterruptedUpdate(w.t.state, w.t.journal), { ...attempt, interrupted: true }, "journaled once");
  const mine = (await w.updates()).filter((e) => e.runId === attempt.runId);
  assert.deepEqual(mine.map((e) => [e.outcome, e.error]), [["pending", undefined], ["failed", "interrupted"]]);
  // The next update replaces the record with its own attempt and removes it when done.
  assert.equal((await runUpdate("0.3.1", w.deps())).outcome, "installed");
  assert.equal(await readPendingUpdate(w.t.state), null);
  assert.equal((await w.updates()).filter((e) => e.runId === attempt.runId).length, 2);

  // An attempt whose outcome was journaled before t3sm died (between the outcome and the file removal): not interrupted.
  const v = world({ installed: "0.3.0" });
  await seed(v);
  writeFileSync(join(v.t.state, "update.pending.json"), JSON.stringify(attempt));
  await v.t.journal.append({ t: "update", runId: attempt.runId, from: "0.3.0", to: "0.3.1", source: GH, outcome: "pending" });
  await v.t.journal.append({ t: "update", runId: attempt.runId, from: "0.3.0", to: "0.3.1", source: GH, outcome: "installed" });
  assert.equal(await recoverInterruptedUpdate(v.t.state, v.t.journal), null);
  assert.equal(existsSync(join(v.t.state, "update.pending.json")), false);
  assert.equal((await v.updates()).length, 2);
  // runUpdate recovers by itself before its own attempt.
  const x = world({ installed: "0.3.0" });
  await seed(x);
  writeFileSync(join(x.t.state, "update.pending.json"), JSON.stringify(attempt));
  assert.equal((await runUpdate("0.3.1", x.deps())).outcome, "installed");
  assert.deepEqual((await x.updates()).filter((e) => e.runId === attempt.runId).map((e) => e.error), ["interrupted"]);
});

test("a rollback without update.json records the skip under the default source, never under the unconfirmed --from", async () => {
  const w = world({ installed: "0.3.0", healthy: (x) => x !== "0.3.1" });
  const folder: UpdateSource = { kind: "folder", path: "D:\\code\\t3sm" };
  const tmp = { make: async () => mkdtempSync(join(w.t.root, "c-")), remove: (p: string) => rm(p, { recursive: true, force: true }) };
  assert.equal((await runUpdate("0.3.1", w.deps({ source: folder, tmp, defaultSource: GH }))).outcome, "rolled-back");
  // `previous` would name the unconfirmed --from folder under the default source: it is left out (null).
  assert.deepEqual(await readUpdateState(w.t.state), { source: GH, lastCheckAt: null, previous: null, available: null, skip: ["0.3.1"] });
});

test("the attempt is on disk before the pending entry is journaled (no crash window between them)", async () => {
  const w = world({ installed: "0.3.0" });
  await seed(w);
  const pendingFile = join(w.t.state, "update.pending.json");
  const seen: boolean[] = [];
  const journal = {
    readAll: () => w.t.journal.readAll(),
    append: async (e: JournalEntry) => { if (e.t === "update" && e.outcome === "pending") seen.push(existsSync(pendingFile)); return w.t.journal.append(e); },
  } as unknown as typeof w.t.journal;
  assert.equal((await runUpdate("0.3.1", w.deps({ journal }))).outcome, "installed");
  assert.deepEqual(seen, [true]);
});

test("an update.json that never recorded an install does not decide how the installed version is reinstalled", async () => {
  // The daily check creates update.json under the default source (GitHub) before any update ran, while the installed
  // version may have come from a folder. A --from update that rolls back reinstalls from that folder, as without update.json.
  const w = world({ installed: "0.3.0", healthy: (x) => x !== "0.3.1" });
  await seed(w); // source GH, previous null
  const folder: UpdateSource = { kind: "folder", path: "D:\\code\\t3sm" };
  const clones: string[] = [];
  const tmp = { make: async () => mkdtempSync(join(w.t.root, "c-")), remove: (p: string) => rm(p, { recursive: true, force: true }) };
  const run = runner((c) => { if (c.args.includes("clone")) clones.push(c.args[c.args.indexOf("--branch") + 1]!); return w.run(c.cmd, c.args, c); });
  assert.equal((await runUpdate("0.3.1", w.deps({ source: folder, tmp, run }))).outcome, "rolled-back");
  assert.deepEqual(clones, ["v0.3.1", "v0.3.0"], "the previous version came back from the folder");
  assert.equal(w.st.installed, "0.3.0");
  const s = await readUpdateState(w.t.state);
  assert.equal(s?.previous, null, "a guessed rollback spec lives only in update.pending.json");
  assert.deepEqual(s?.source, GH, "the remembered source stays the default: nothing was confirmed");
  // A later attempt from the same folder guesses the same way.
  clones.length = 0;
  assert.equal((await runUpdate("0.3.1", w.deps({ source: folder, tmp, run }))).outcome, "rolled-back");
  assert.deepEqual(clones, ["v0.3.1", "v0.3.0"]);
});

test("a failed --from attempt never becomes the rollback target of a later GitHub update", async () => {
  // The daily check's update.json (GitHub, nothing installed through it yet); the folder install fails.
  const w = world({ installed: "0.3.0", healthy: (x) => x !== "0.3.1", npm: (c) => (c.args.at(-1) === "." ? fail(1, "npm ERR! boom") : null) });
  await seed(w);
  const folder: UpdateSource = { kind: "folder", path: "D:\\code\\t3sm" };
  const tmp = { make: async () => mkdtempSync(join(w.t.root, "c-")), remove: (p: string) => rm(p, { recursive: true, force: true }) };
  assert.equal((await runUpdate("0.3.1", w.deps({ source: folder, tmp }))).outcome, "failed");
  assert.equal((await readUpdateState(w.t.state))?.previous, null, "nothing unconfirmed reached update.json");
  const clonesBefore = w.run.calls.filter((c) => c.args.includes("clone")).length;
  // The automatic GitHub update rolls back: it reinstalls 0.3.0 from GitHub, never from the folder.
  assert.equal((await runUpdate("0.3.1", w.deps({ tmp }))).outcome, "rolled-back");
  assert.equal(w.run.calls.filter((c) => c.args.includes("clone")).length, clonesBefore, "the folder is never cloned");
  assert.deepEqual(w.npmInstalls().slice(-2), ["github:demo-owner/demo-app#v0.3.1", "github:demo-owner/demo-app#v0.3.0"]);
  // An older update.json whose previous names the installed version from a source that is neither the remembered one
  // nor this update's is not reused either.
  const v = world({ installed: "0.3.0", healthy: (x) => x !== "0.3.1" });
  await writeUpdateState(v.t.state, { source: GH, lastCheckAt: null, previous: { version: "0.3.0", spec: "folder:D:\\code\\t3sm#v0.3.0" }, available: null, skip: [] });
  assert.equal((await runUpdate("0.3.1", v.deps({ tmp }))).outcome, "rolled-back");
  assert.equal(v.run.calls.filter((c) => c.args.includes("clone")).length, 0);
});

test("the installed version is read again under the lock: an update already in place is not repeated", async () => {
  const w = world({ installed: "0.3.0" });
  await seed(w);
  const r = await runUpdate("0.3.1", w.deps({ readInstalled: () => "0.3.1" }));
  assert.deepEqual(r, { outcome: "failed", from: "0.3.1", to: "0.3.1", error: "not-newer" });
  assert.deepEqual(w.npmInstalls(), []);
  assert.deepEqual(await w.updates(), []);
});

test("readInstalled that throws under the lock: failed invalid-version, the lock released, nothing installed", async () => {
  const w = world({ installed: "0.3.0" });
  await seed(w);
  const r = await runUpdate("0.3.1", w.deps({ readInstalled: () => { throw new Error("package.json unreadable"); } }));
  assert.deepEqual(r, { outcome: "failed", from: "0.3.0", to: "0.3.1", error: "invalid-version" });
  assert.deepEqual(w.npmInstalls(), []);
  assert.deepEqual(await w.updates(), []);
  const again = await acquireLock(w.t.state);
  assert.ok(again, "the lock was released");
  await again.release();
});

test("progress: each step is reported as it starts", async () => {
  const w = world({ installed: "0.3.0" });
  await seed(w);
  const steps: string[] = [];
  assert.equal((await runUpdate("0.3.1", w.deps({ onStep: (s) => void steps.push(s) }))).outcome, "installed");
  assert.deepEqual(steps, ["installing", "restarting", "checking"]);
  const v = world({ installed: "0.3.0", healthy: (x) => x !== "0.3.1" });
  await seed(v);
  const vs: string[] = [];
  assert.equal((await runUpdate("0.3.1", v.deps({ onStep: (s) => void vs.push(s) }))).outcome, "rolled-back");
  assert.deepEqual(vs, ["installing", "restarting", "checking", "rolling-back"]);
});

test("no source known: failed, nothing run", async () => {
  const w = world({ installed: "0.3.0" });
  const r = await runUpdate("0.3.1", w.deps());
  assert.deepEqual(r, { outcome: "failed", from: "0.3.0", to: "0.3.1", error: "no-source" });
  assert.equal(w.run.calls.length, 0);
});

test("update.json: atomic, strict decode (bad content reads as null)", async () => {
  const t = tempRoot();
  mkdirSync(t.state, { recursive: true });
  assert.equal(await readUpdateState(t.state), null);
  await writeUpdateState(t.state, { source: GH, lastCheckAt: "2026-11-15T10:00:00.000Z", previous: null, available: "0.3.1", skip: ["0.3.0"] });
  assert.deepEqual(await readUpdateState(t.state), { source: GH, lastCheckAt: "2026-11-15T10:00:00.000Z", previous: null, available: "0.3.1", skip: ["0.3.0"] });
  // Written before skip existed: reads as no skipped versions.
  writeFileSync(join(t.state, "update.json"), JSON.stringify({ source: GH, lastCheckAt: null, previous: null, available: null }));
  assert.deepEqual((await readUpdateState(t.state))?.skip, []);
  for (const bad of ["{", "null", JSON.stringify({ source: { kind: "ftp", url: "x" }, lastCheckAt: null, previous: null, available: null }),
    JSON.stringify({ source: GH, lastCheckAt: 5, previous: null, available: null }),
    JSON.stringify({ source: GH, lastCheckAt: null, previous: { version: "x" }, available: null }),
    JSON.stringify({ source: GH, lastCheckAt: null, previous: null, available: null, skip: ["0.3.1-rc1"] })]) {
    writeFileSync(join(t.state, "update.json"), bad);
    assert.equal(await readUpdateState(t.state), null, bad);
  }
});

// ---------- watcherOps: how the watcher is restarted on each platform ----------

const WIN_XML = `<Task><Actions><Exec><Command>C:\\Windows\\System32\\conhost.exe</Command><Arguments>--headless "C:\\nodejs\\node.exe" "C:\\npm\\t3sm.mjs" sync --watch --quiet</Arguments></Exec></Actions></Task>`;

function winRunner(o: { installed: boolean; runFails?: boolean }) {
  return runner((c) => {
    if (!c.cmd.endsWith("schtasks.exe")) return fail(127);
    if (c.args[0] === "/Query" && c.args.includes("/XML")) return o.installed ? ok(WIN_XML) : fail(1, "ERROR");
    if (c.args[0] === "/Query") return o.installed ? ok(`"\\${TASK_NAME}","N/A","Running"\r\n`) : fail(1, "ERROR: The system cannot find the file specified.");
    if (c.args[0] === "/Create") return ok("SUCCESS");
    if (c.args[0] === "/Run") return o.runFails ? fail(1, "ERROR") : ok("SUCCESS");
    return fail();
  });
}

function spawnRec() {
  const spawned: { cmd: string; args: string[] }[] = [];
  const spawn: SpawnLike = (cmd, args) => { spawned.push({ cmd, args }); return { unref() {} }; };
  return { spawned, spawn };
}

const STOPPED = async () => ({ how: "request" as const, pid: 4242, running: false });

test("watcherOps win32: update reinstalls the task (keep-alive trigger) then runs it; rollback only runs it; /Run failing spawns", async () => {
  const fs = memScheduleFs();
  const run = winRunner({ installed: true });
  const s = spawnRec();
  const ops = watcherOps({ platform: "win32", run, stateDir: "C:\\Users\\demo\\.t3code-session-manager", nodePath: "C:\\nodejs\\node.exe", binPath: "C:\\npm\\t3sm.mjs", everyMinutes: 15, conhost: "C:\\Windows\\System32\\conhost.exe", systemRoot: "C:\\Windows", userId: "DEMO\\demo", spawn: s.spawn, fs, stop: STOPPED });
  assert.equal(await ops.restart({ wasRunning: true, reinstallSchedule: true }), true);
  const verbs = run.calls.map((c) => c.args[0]);
  assert.deepEqual(verbs.filter((v) => v === "/Create" || v === "/Run"), ["/Create", "/Run"], "one /Create, one /Run");
  const xml = [...fs.files.values()][0]!.subarray(2).toString("utf16le");
  assert.match(xml, /<Interval>PT15M<\/Interval>/, "the keep-alive trigger is in the reinstalled task");
  assert.equal(s.spawned.length, 1, "win32: the successor is spawned after /Run too (Task Scheduler may drop /Run while the old instance exits)");
  assert.ok(run.calls.every((c) => c.timeoutMs !== undefined && c.timeoutMs > 0), "every scheduler call has a time limit (the update holds the state lock)");

  run.calls.length = 0;
  assert.equal(await ops.restart({ wasRunning: true, reinstallSchedule: false }), true);
  assert.deepEqual(run.calls.filter((c) => c.args[0] !== "/Query").map((c) => c.args), [["/Run", "/TN", TASK_NAME]]);

  const failing = winRunner({ installed: true, runFails: true });
  const s2 = spawnRec();
  const ops2 = watcherOps({ platform: "win32", run: failing, stateDir: "C:\\s", nodePath: "C:\\nodejs\\node.exe", binPath: "C:\\npm\\t3sm.mjs", everyMinutes: 15, conhost: "C:\\Windows\\System32\\conhost.exe", systemRoot: "C:\\Windows", userId: "DEMO\\demo", spawn: s2.spawn, fs, stop: STOPPED });
  assert.equal(await ops2.restart({ wasRunning: true, reinstallSchedule: false }), true);
  assert.deepEqual(s2.spawned, [{ cmd: "C:\\Windows\\System32\\conhost.exe", args: ["--headless", "C:\\nodejs\\node.exe", "C:\\npm\\t3sm.mjs", "sync", "--watch", "--quiet"] }]);
});

test("watcherOps without a scheduled watcher: spawn one only when one was running", async () => {
  const s = spawnRec();
  const ops = watcherOps({ platform: "win32", run: winRunner({ installed: false }), stateDir: "C:\\s", nodePath: "C:\\nodejs\\node.exe", binPath: "C:\\npm\\t3sm.mjs", everyMinutes: 15, conhost: "C:\\Windows\\System32\\conhost.exe", systemRoot: "C:\\Windows", userId: "DEMO\\demo", spawn: s.spawn, fs: memScheduleFs(), stop: STOPPED });
  assert.equal(await ops.restart({ wasRunning: false, reinstallSchedule: true }), false);
  assert.equal(s.spawned.length, 0);
  assert.equal(await ops.restart({ wasRunning: true, reinstallSchedule: true }), true);
  assert.equal(s.spawned.length, 1);
});

test("watcherOps darwin: update reinstalls the LaunchAgent (RunAtLoad starts it); rollback kickstarts, bootstrap when not loaded", async () => {
  const t = tempRoot();
  const state = { loaded: true, kickFails: false };
  const run = runner((c) => {
    if (c.cmd !== "launchctl") return fail(127);
    if (c.args[0] === "print") return state.loaded ? ok("state = running\n") : fail(113, "Could not find service");
    if (c.args[0] === "bootout") { state.loaded = false; return ok(); }
    if (c.args[0] === "bootstrap") { state.loaded = true; return ok(); }
    if (c.args[0] === "kickstart") return state.kickFails ? fail(113, "Could not find service") : ok();
    return fail();
  });
  const fs = memScheduleFs();
  const s = spawnRec();
  const ops = watcherOps({ platform: "darwin", run, stateDir: join(t.root, "state"), nodePath: "/usr/local/bin/node", binPath: "/usr/local/lib/node_modules/t3sm/bin/t3sm.mjs", everyMinutes: 15, home: "/Users/demo", uid: 501, spawn: s.spawn, fs, stop: STOPPED });
  assert.equal(await ops.restart({ wasRunning: true, reinstallSchedule: true }), true);
  assert.deepEqual(run.calls.filter((c) => c.args[0] !== "print").map((c) => c.args), [["bootout", `gui/501/${LAUNCHD_LABEL}`], ["bootstrap", "gui/501", `/Users/demo/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`]]);
  assert.match([...fs.files.values()][0]!.toString("utf8"), /<string>--watch<\/string>/);

  run.calls.length = 0;
  assert.equal(await ops.restart({ wasRunning: true, reinstallSchedule: false }), true);
  assert.deepEqual(run.calls.filter((c) => c.args[0] !== "print").map((c) => c.args), [["kickstart", "-k", `gui/501/${LAUNCHD_LABEL}`]]);

  run.calls.length = 0;
  state.kickFails = true;
  assert.equal(await ops.restart({ wasRunning: true, reinstallSchedule: false }), true);
  assert.deepEqual(run.calls.filter((c) => c.args[0] !== "print").map((c) => c.args[0]), ["kickstart", "bootout", "bootstrap"]);
  assert.equal(s.spawned.length, 0, "launchd starts it, never a detached spawn");
});

test("watcherOps cron: update rewrites the crontab (keep-alive line) and spawns the watcher", async () => {
  let crontab = `@reboot "/usr/bin/node" "/opt/t3sm/bin/t3sm.mjs" sync --watch --quiet # t3sm\n`;
  const run = runner((c) => {
    if (c.cmd !== "crontab") return fail(127);
    if (c.args[0] === "-l") return ok(crontab);
    crontab = c.input ?? "";
    return ok();
  });
  const s = spawnRec();
  const ops = watcherOps({ platform: "linux", run, stateDir: "/home/demo/.t3code-session-manager", nodePath: "/usr/bin/node", binPath: "/opt/t3sm/bin/t3sm.mjs", everyMinutes: 15, spawn: s.spawn, stop: STOPPED });
  assert.equal(await ops.restart({ wasRunning: false, reinstallSchedule: true }), true);
  assert.match(crontab, /^\*\/15 \* \* \* \* .*sync --watch --quiet # t3sm$/m);
  assert.deepEqual(s.spawned, [{ cmd: "/usr/bin/node", args: ["/opt/t3sm/bin/t3sm.mjs", "sync", "--watch", "--quiet"] }]);
});

// ---------- the real runner ----------

test("updateRunner: git never prompts (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never)", async () => {
  const run = updateRunner(process.platform, { ...process.env, GIT_TERMINAL_PROMPT: "1", GCM_INTERACTIVE: "always" });
  const r = await run(process.execPath, ["-e", "process.stdout.write(process.env.GIT_TERMINAL_PROMPT + ',' + process.env.GCM_INTERACTIVE)"]);
  assert.equal(r.stdout, "0,never");
});

test("updateRunner: a call without cwd never runs in the folder t3sm was started from (a planted git.exe there would run first)", async () => {
  const seen: (string | undefined)[] = [];
  const fakeSpawn = ((_c: string, _a: string[], opts: { cwd?: string }) => {
    seen.push(opts.cwd);
    throw new Error("not started");
  }) as unknown as SpawnFn;
  for (const platform of ["win32", "linux"] as const) {
    const run = updateRunner(platform, {}, { spawn: fakeSpawn });
    await run("git", ["ls-remote", "--tags", "--refs", "https://github.com/demo/t3sm.git"]);
    await run("npm", ["view", "github:demo/t3sm", "version"]);
    await run("git", ["-C", "C:/work/demo", "tag"], { cwd: "C:/work/clone" });
  }
  const tmp = (await import("node:os")).tmpdir();
  assert.deepEqual(seen, [tmp, tmp, "C:/work/clone", tmp, tmp, "C:/work/clone"], "every call has a cwd: the temp folder unless the caller names one");
  // The real thing: the child's working folder is the temp folder.
  const r = await updateRunner(process.platform, process.env)(process.execPath, ["-e", "process.stdout.write(process.cwd())"]);
  assert.equal(r.stdout.toLowerCase(), tmp.toLowerCase());
});

/** Timers that fire only when the test says so. */
function manualTimer() {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    timers,
    setTimer: (fn: () => void, ms: number): unknown => { const h = { fn, ms, cleared: false }; timers.push(h); return h; },
    clearTimer: (h: unknown): void => { (h as { cleared: boolean }).cleared = true; },
  };
}

const started = (c: ChildProcess): Promise<void> => new Promise((ok) => { if (c.pid !== undefined) ok(); else c.once("spawn", () => ok()); });
const exited = (c: ChildProcess): Promise<void> => new Promise((ok) => { if (c.exitCode !== null || c.signalCode !== null) ok(); else c.once("exit", () => ok()); });

test("updateRunner: a command past its time limit is killed by its own pid and reported as exit 124", async () => {
  const t = manualTimer();
  const killed: (number | undefined)[] = [];
  let child: ChildProcess | null = null;
  const real = defaultKill(process.platform, process.env);
  const run = updateRunner(process.platform, process.env, { timer: t, kill: (c) => { killed.push(c.pid); real(c); }, onSpawn: (c) => { child = c; } });
  const p = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 5000 });
  assert.equal(t.timers[0]!.ms, 5000);
  await started(child!);
  t.timers[0]!.fn();
  const r = await p;
  assert.equal(r.code, 124);
  assert.match(r.stderr, /timed out after 5 s/);
  assert.deepEqual(killed, [child!.pid]);
  await exited(child!); // really gone
});

test("updateRunner: a killed command that never reports its exit still resolves, after the grace period", async () => {
  const t = manualTimer();
  let child: ChildProcess | null = null;
  const run = updateRunner(process.platform, process.env, { timer: t, kill: () => { /* the kill is lost: no exit event follows */ }, onSpawn: (c) => { child = c; } });
  const p = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 5000 });
  await started(child!);
  try {
    t.timers[0]!.fn();
    assert.equal(t.timers[1]!.ms, KILL_GRACE_MS);
    assert.equal(KILL_GRACE_MS, 5000);
    t.timers[1]!.fn();
    const r = await p;
    assert.equal(r.code, 124);
  } finally {
    child!.kill("SIGKILL"); // our own child, by its handle
    await exited(child!);
  }
});

test("updateRunner: the child already exited but a grandchild holds its pipes: 124 at the limit, nothing is killed", async () => {
  const t = manualTimer();
  const kills: string[] = [];
  // A child whose 'exit' came but whose 'close' never comes (a grandchild still holds the pipes).
  const c = Object.assign(new EventEmitter(), {
    pid: 4242, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { kills.push("child"); return true; },
  });
  const sys = { spawn: (cmd: string) => void kills.push(cmd), killGroup: (g: number) => void kills.push(`group ${g}`) };
  const run = updateRunner(process.platform, process.env, {
    timer: t, kill: defaultKill(process.platform, process.env, sys),
    spawn: () => c as unknown as ChildProcessWithoutNullStreams,
  });
  const p = run("git", ["clone"], { timeoutMs: 5000 });
  c.exitCode = 0;
  c.emit("exit", 0, null);
  t.timers[0]!.fn();
  const r = await p; // resolves without the grace timer: the child is already gone
  assert.equal(r.code, 124);
  assert.deepEqual(kills, [], "an exited child is never killed");
  assert.equal(c.stdout.destroyed && c.stderr.destroyed && c.stdin.destroyed, true, "the pipes are let go");
  assert.equal(t.timers.length, 2, "the time limit and the exit grace; no kill grace");
  assert.equal(t.timers[1]!.ms, EXIT_GRACE_MS);
  assert.equal(t.timers[1]!.cleared, true, "the exit grace is cleared once the call ended");
});

test("updateRunner: a child that exited 0 while a helper keeps its pipes open ends with its own exit code after the grace", async () => {
  const t = manualTimer();
  const c = Object.assign(new EventEmitter(), {
    pid: 4243, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { throw new Error("never killed"); },
  });
  const run = updateRunner(process.platform, process.env, { timer: t, spawn: () => c as unknown as ChildProcessWithoutNullStreams });
  const p = run("git", ["ls-remote"], { timeoutMs: 60_000 });
  c.stdout.write("1111\trefs/tags/v0.3.1\n");
  await new Promise((ok) => setImmediate(ok));
  c.exitCode = 0;
  c.emit("exit", 0, null); // and never 'close'
  const grace = t.timers.find((x) => x.ms === EXIT_GRACE_MS)!;
  assert.equal(EXIT_GRACE_MS, 5000);
  grace.fn();
  const r = await p;
  assert.equal(r.code, 0, "the real exit code, not a timeout");
  assert.equal(r.stdout, "1111\trefs/tags/v0.3.1\n");
  assert.equal(t.timers[0]!.cleared, true, "the time limit is cleared");
  assert.equal(c.stdout.destroyed, true, "the pipes are let go");
  // A signal exit (code null) is a failure, not success.
  const t2 = manualTimer();
  const c2 = Object.assign(new EventEmitter(), { pid: 4244, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  const p2 = updateRunner(process.platform, process.env, { timer: t2, spawn: () => c2 as unknown as ChildProcessWithoutNullStreams })("git", []);
  c2.emit("exit", null, "SIGTERM");
  t2.timers[0]!.fn();
  assert.equal((await p2).code, 1);
});

test("defaultKill: only a live child, by its own pid; taskkill gets no CLAUDE_CONFIG_DIR", () => {
  const calls: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
  const groups: number[] = [];
  const sys = { spawn: (cmd: string, args: string[], env: Record<string, string>) => void calls.push({ cmd, args, env }), killGroup: (g: number) => void groups.push(g) };
  const childKills: (string | undefined)[] = [];
  const child = (o: { exitCode?: number | null; signalCode?: string | null }) => ({
    pid: 4242, exitCode: o.exitCode ?? null, signalCode: o.signalCode ?? null, kill: (sig?: NodeJS.Signals) => { childKills.push(sig); return true; },
  });
  const env = { SystemRoot: "C:\\Windows", CLAUDE_CONFIG_DIR: "C:/elsewhere", PATH: "C:\\bin" };
  for (const platform of ["win32", "linux"] as const) {
    defaultKill(platform, env, sys)(child({ exitCode: 0 }));
    defaultKill(platform, env, sys)(child({ signalCode: "SIGTERM" }));
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(childKills, []);
  assert.deepEqual(groups, [], "an exited child's group is never signalled");
  defaultKill("win32", env, sys)(child({}));
  assert.deepEqual(calls.map((c) => [c.cmd, ...c.args]), [["C:\\Windows\\System32\\taskkill.exe", "/PID", "4242", "/T", "/F"]]);
  assert.equal(Object.keys(calls[0]!.env).some((k) => k.toUpperCase() === "CLAUDE_CONFIG_DIR"), false);
  assert.equal(calls[0]!.env["PATH"], "C:\\bin");
  defaultKill("linux", env, sys)(child({}));
  assert.deepEqual(groups, [4242], "POSIX: the child's own process group (everything npm started)");
  assert.deepEqual(childKills, ["SIGKILL"], "then the child through its handle");
  assert.equal(calls.length, 1);
  // Neither SystemRoot nor windir: the default Windows folder, a full path (never the drive-relative "C:Windows").
  defaultKill("win32", { PATH: "C:\\bin" }, sys)(child({}));
  assert.equal(calls[1]!.cmd, "C:\\Windows\\System32\\taskkill.exe");
  // A relative SystemRoot would resolve taskkill.exe against the working folder: nothing is started.
  defaultKill("win32", { SystemRoot: "Windows" }, sys)(child({}));
  defaultKill("win32", { windir: "..\\x" }, sys)(child({}));
  assert.equal(calls.length, 2);
  // Only a drive path: a drive-less rooted folder (the current drive) or a network or device path never runs anything.
  defaultKill("win32", { SystemRoot: "\\Windows" }, sys)(child({}));
  defaultKill("win32", { SystemRoot: "\\\\srv\\share\\Windows" }, sys)(child({}));
  defaultKill("win32", { windir: "//srv/share/Windows" }, sys)(child({}));
  defaultKill("win32", { SystemRoot: "\\\\?\\C:\\Windows" }, sys)(child({}));
  assert.equal(calls.length, 2);
  defaultKill("win32", { windir: "D:\\Win" }, sys)(child({}));
  assert.equal(calls[2]!.cmd, "D:\\Win\\System32\\taskkill.exe");
});

/** A fake `process` for the POSIX group guard: listeners by event, and what kill was asked. */
function fakeProc() {
  const listeners = new Map<string, ((sig: NodeJS.Signals) => void)[]>();
  const kills: [number, string][] = [];
  return {
    listeners, kills, pid: 999,
    on(ev: string, fn: (sig: NodeJS.Signals) => void) { listeners.set(ev, [...(listeners.get(ev) ?? []), fn]); return this; },
    off(ev: string, fn: (sig: NodeJS.Signals) => void) { listeners.set(ev, (listeners.get(ev) ?? []).filter((f) => f !== fn)); return this; },
    listenerCount(ev: string) { return (listeners.get(ev) ?? []).length; },
    kill(pid: number, sig: string) { kills.push([pid, sig]); return true; },
    emit(ev: string, sig: NodeJS.Signals) { for (const f of [...(listeners.get(ev) ?? [])]) f(sig); },
    count() { return [...listeners.values()].reduce((n, l) => n + l.length, 0); },
  };
}

function fakeChild(pid: number) {
  return Object.assign(new EventEmitter(), {
    pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => true,
  });
}

test("updateRunner POSIX: the child leads its own group; Ctrl+C, SIGTERM, SIGHUP or t3sm's exit during the call kill that group", async () => {
  for (const ev of ["SIGINT", "SIGTERM", "SIGHUP", "exit"] as const) {
    const proc = fakeProc();
    const c = fakeChild(5100);
    const killed: (number | undefined)[] = [];
    let spawnOpts: { detached?: boolean } | null = null;
    const run = updateRunner("linux", {}, {
      timer: manualTimer(), proc, kill: (k) => void killed.push(k.pid),
      spawn: (_cmd, _args, opts) => { spawnOpts = opts; return c as unknown as ChildProcessWithoutNullStreams; },
    });
    const p = run("npm", ["install"]);
    assert.equal(spawnOpts!.detached, true, "detached: its own process group");
    assert.equal(proc.count(), 4, "exit, SIGINT, SIGTERM and SIGHUP are guarded while the call runs");
    proc.emit(ev, ev === "exit" ? ("SIGTERM" as NodeJS.Signals) : ev);
    assert.deepEqual(killed, [5100], ev);
    if (ev !== "exit") {
      assert.deepEqual(proc.kills, [[999, ev]], "nobody else handles the signal: it is raised again (Ctrl+C still ends t3sm)");
      assert.equal(proc.count(), 0, "the guard is gone after the signal");
    }
    c.exitCode = 137;
    c.emit("exit", null, "SIGKILL");
    c.emit("close", null, "SIGKILL");
    await p;
    assert.equal(proc.count(), 0, "no handler is left behind");
  }
  // Another handler of the signal (the watcher's own Ctrl+C): the group is killed, the signal is not raised again.
  const proc = fakeProc();
  proc.on("SIGINT", () => {});
  const c = fakeChild(5200);
  const killed: (number | undefined)[] = [];
  const p = updateRunner("darwin", {}, { timer: manualTimer(), proc, kill: (k) => void killed.push(k.pid), spawn: () => c as unknown as ChildProcessWithoutNullStreams })("git", []);
  proc.emit("SIGINT", "SIGINT");
  assert.deepEqual(killed, [5200]);
  assert.deepEqual(proc.kills, []);
  c.emit("exit", 0, null);
  c.emit("close", 0, null);
  await p;
  // A call that ended normally leaves no handlers; a child that already exited is never killed by a later signal.
  const proc2 = fakeProc();
  const c2 = fakeChild(5300);
  const killed2: number[] = [];
  const p2 = updateRunner("linux", {}, { timer: manualTimer(), proc: proc2, kill: () => void killed2.push(1), spawn: () => c2 as unknown as ChildProcessWithoutNullStreams })("git", []);
  c2.exitCode = 0;
  c2.emit("exit", 0, null);
  proc2.emit("SIGTERM", "SIGTERM");
  assert.deepEqual(killed2, []);
  c2.emit("close", 0, null);
  assert.equal((await p2).code, 0);
  assert.equal(proc2.count(), 0);
});

test("updateRunner win32: no group, no signal handlers", async () => {
  const proc = fakeProc();
  const c = fakeChild(5400);
  let spawnOpts: { detached?: boolean } | null = null;
  const p = updateRunner("win32", {}, { timer: manualTimer(), proc, spawn: (_a, _b, opts) => { spawnOpts = opts; return c as unknown as ChildProcessWithoutNullStreams; } })("git", []);
  assert.equal(spawnOpts!.detached, false);
  assert.equal(proc.count(), 0);
  c.emit("exit", 0, null);
  c.emit("close", 0, null);
  await p;
});

test("updateRunner: children never get CLAUDE_CONFIG_DIR; npm on Windows refuses unsafe arguments without starting", async () => {
  const run = updateRunner(process.platform, { ...process.env, CLAUDE_CONFIG_DIR: "C:/elsewhere", claude_config_dir: "x" });
  const r = await run(process.execPath, ["-e", "process.stdout.write(Object.keys(process.env).filter((k) => k.toUpperCase() === 'CLAUDE_CONFIG_DIR').join(',') || 'none')"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "none");
  const win = updateRunner("win32", {});
  const refused = await win("npm", ["install", "-g", "C:\\Users\\a b\\x & calc"]);
  assert.equal(refused.code, 126);
  assert.match(refused.stderr, /refusing to pass/);
  const missing = await run(join(tempRoot().root, "no-such-binary"), []);
  assert.equal(missing.code, 127);
});

test("watcherOps win32 from the automatic update: /Run may be ignored inside the task, so a successor is spawned too; the health check takes its heartbeat", async () => {
  const fs = memScheduleFs();
  const run = winRunner({ installed: true });
  let hb: Heartbeat | null = null;
  const w = world({ installed: "0.3.0" });
  await seed(w);
  const spawned: string[][] = [];
  const spawn: SpawnLike = (cmd, args) => {
    spawned.push([cmd, ...args]);
    hb = { pid: 6000, startedAt: new Date(w.clock.now()).toISOString(), lastCycleAt: null, lastResult: null, nextCycleAt: null, protocol: 1, version: w.st.installed };
    return { unref() {} };
  };
  const ops = watcherOps({
    platform: "win32", run, stateDir: w.t.state, nodePath: "C:\\nodejs\\node.exe", binPath: "C:\\npm\\t3sm.mjs", everyMinutes: 15,
    conhost: "C:\\Windows\\System32\\conhost.exe", systemRoot: "C:\\Windows", userId: "DEMO\\demo", spawn, fs, stop: STOPPED,
  });
  const r = await runUpdate("0.3.1", w.deps({ watcher: ops, readHeartbeat: async () => hb }));
  assert.equal(r.outcome, "installed");
  assert.ok(run.calls.some((c) => c.args[0] === "/Run"), "the task is run");
  assert.equal(spawned.length, 1, "and a successor is spawned (a duplicate finds the pipe taken and exits)");
  assert.deepEqual(spawned[0]!.slice(-3), ["sync", "--watch", "--quiet"]);
  // A manual update from a terminal spawns too: the stopped watcher's task instance may still be exiting.
  const s = spawnRec();
  const plain = watcherOps({ platform: "win32", run: winRunner({ installed: true }), stateDir: "C:\\s", nodePath: "C:\\nodejs\\node.exe", binPath: "C:\\npm\\t3sm.mjs", everyMinutes: 15, conhost: null, systemRoot: "C:\\Windows", userId: "DEMO\\demo", spawn: s.spawn, fs, stop: STOPPED });
  await plain.restart({ wasRunning: true, reinstallSchedule: false });
  assert.equal(s.spawned.length, 1);
});
