import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { commands, main, type Io } from "../../src/cli/main.ts";
import { statusCommand } from "../../src/cli/commands/status.ts";
import { Journal } from "../../src/core/journal.ts";

const temps: string[] = [];
/** The screen's text on one line: wrapped lines joined, so a sentence can be matched whatever the width. */
const flat = (s: string): string => s.replace(/\s+/g, " ");
after(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

const NOW = Date.parse("2026-11-14T12:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function setup(o: { tty?: boolean; env?: NodeJS.ProcessEnv; noState?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "t3sm-status-"));
  temps.push(home);
  const state = join(home, "state");
  if (!o.noState) mkdirSync(state, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: o.tty ?? false, prompt: async () => "", env: { T3SM_HOME: state, LANG: "en_US.UTF-8", ...o.env } };
  const run = (args: string[] = [], deps: Parameters<typeof statusCommand>[2] = {}) =>
    statusCommand(args, io, { home, now: () => NOW, pidAlive: () => true, packageVersion: "0.3.0", installStamp: () => ({ ...INSTALL, changedAtMs: 0 }), ...deps });
  const status = (obj: object): void => writeFileSync(join(state, "sync-status.json"), JSON.stringify(obj));
  return { home, state, io, run, status, out: () => out.join(""), err: () => err.join("") };
}

/** What the install holds, and a fresh 0.3 watcher heartbeat running exactly that. */
const INSTALL = { version: "0.3.0", stamp: "2026-11-01T10:00:00.000Z" };
const LIVE = {
  pid: 7, startedAt: ago(HOUR), lastCycleAt: ago(3 * MIN), nextCycleAt: new Date(NOW + 7 * MIN).toISOString(),
  lastResult: { outcome: "noop", runId: null }, protocol: 1, version: INSTALL.version, stamp: INSTALL.stamp, installRoot: "C:/work/t3sm",
};

function writePlan(state: string, runId: string, o: { createdAt: string; items?: unknown[]; decisionsPending?: { key: string; sessions: number; folders: number }[] }): void {
  const dir = join(state, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify({
    version: 1, runId, createdAt: o.createdAt, t3Version: "1", instancesToCreate: [], projectsToCreate: [], projectDefaults: [], mirrorCopies: [], projectAccounts: [], warnings: [],
    items: o.items ?? [], ...(o.decisionsPending ? { decisionsPending: o.decisionsPending } : {}),
  }));
}

const skipItem = (nativeId: string, folder: string, reason: string) => ({ session: { harness: "claude", nativeId, cwd: `C:/work/${folder}` }, action: { kind: "skip", reason }, notes: [] });

const attention = (since: string) => ({ reason: "undecided", detail: "3 sessions in 2 categories wait for your decision", command: "t3sm start", since });

function snapshot(dir: string): string[] {
  const all: string[] = [];
  const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); all.push(p); if (e.isDirectory()) walk(p); } };
  walk(dir);
  return all.sort();
}

test("no state folder: says t3sm has not run yet and exits 0, creating nothing", async () => {
  const s = setup({ noState: true });
  assert.equal(await s.run(), 0);
  assert.equal(s.out(), "t3sm has not run yet. Run t3sm start.\n");
  assert.equal(existsSync(s.state), false);
  const j = setup({ noState: true });
  assert.equal(await j.run(["--json"]), 0);
  assert.deepEqual(JSON.parse(j.out()), { version: 2, ran: false });
});

test("needs you comes first: the count, each item in words with its command", async () => {
  const s = setup();
  s.status({ needsAttention: attention(ago(2 * HOUR)), undecided: { automated: 2, "t3-refused": 1 }, heldRehome: 0, failures: 0 });
  assert.equal(await s.run(), 10);
  const o = s.out();
  assert.match(o, /^! Needs you \(1\)/);
  assert.match(flat(o), /3 conversations wait for your decision \(automated sessions 2, folders T3 Code refuses 1\)/, "the screen names the questions in words");
  assert.match(o, /^  [›>] t3sm start$/m);
  assert.doesNotMatch(o, /All good/);
});

test("nothing needs attention: All good", async () => {
  const s = setup();
  s.status({ needsAttention: null, undecided: {}, heldRehome: 0, failures: 0 });
  assert.equal(await s.run(), 0);
  assert.match(s.out(), /^[✓v] All good [·-] t3sm does not need anything from you\n/);
  assert.doesNotMatch(s.out(), /Needs you/);
});

test("held projects with conversation title and since when; held rehome copies; strings are sanitized", async () => {
  const s = setup();
  s.status({
    ...LIVE,
    held: [{ project: "demo", root: "C:/work/demo", file: "C:/x/a.jsonl", title: "Fix\u001b[31m the build\u0007", modifiedAt: ago(4 * MIN), since: ago(25 * MIN) }],
    needsAttention: null, undecided: {}, heldRehome: 2, failures: 0,
  });
  assert.equal(await s.run(), 10, "the copies waiting for a folder need t3sm start");
  const o = s.out();
  assert.match(o, /demo is waiting: 'Fix\[31m the build' is in use \(first held 25 min ago\)/);
  assert.match(o, /2 copied conversations wait for their destination folder in T3 Code/);
  assert.doesNotMatch(o, /[\u001b\u0007]/);
  assert.doesNotMatch(o, /a\.jsonl/);
});

test("last sync and next sync come from the watcher heartbeat; a dead watcher shows no next sync", async () => {
  const live = setup();
  live.status({ pid: 7, startedAt: ago(HOUR), lastCycleAt: ago(3 * MIN), nextCycleAt: new Date(NOW + 7 * MIN).toISOString(), lastResult: { outcome: "ok", runId: "r1", imported: 4 } });
  await live.run();
  assert.match(live.out(), /Last sync +3 min ago, ok \(run r1\)/);
  assert.match(live.out(), /Next sync +in 7 min \(watcher\)/);
  const dead = setup();
  dead.status({ pid: 7, startedAt: ago(HOUR), lastCycleAt: ago(3 * MIN), nextCycleAt: new Date(NOW + 7 * MIN).toISOString(), lastResult: { outcome: "ok", runId: "r1" } });
  await dead.run([], { pidAlive: () => false });
  assert.doesNotMatch(dead.out(), /Next sync/);
  assert.match(dead.out(), /watcher is not running/i);
});

test("a stopped watcher's old lastResult.held is not shown; only the per-cycle held field is", async () => {
  const s = setup();
  s.status({
    pid: 7, startedAt: ago(5 * HOUR), stoppedAt: ago(HOUR), lastCycleAt: ago(2 * HOUR), nextCycleAt: null,
    lastResult: { outcome: "ok", runId: "r1", held: [{ project: "old", root: "C:/x", file: "C:/x/a.jsonl", title: "Old", modifiedAt: ago(3 * HOUR) }] },
    held: [], needsAttention: null, undecided: {}, heldRehome: 0, failures: 0,
  });
  await s.run();
  assert.doesNotMatch(s.out(), /Waiting|Old/);
  const j = setup();
  j.status({ pid: 7, startedAt: ago(HOUR), lastCycleAt: ago(MIN), lastResult: { outcome: "ok", held: [{ project: "old", title: "Old", modifiedAt: ago(HOUR) }] } });
  await j.run(["--json"]);
  assert.deepEqual(JSON.parse(j.out()).waiting, []);
});

test("recordSyncStatus replaces held every cycle and an empty list clears it", async () => {
  const { recordSyncStatus, readSyncStatus } = await import("../../src/ops/syncStatus.ts");
  const s = setup();
  const h = [{ project: "demo", title: "Fix", modifiedAt: ago(MIN) }];
  const seen = h.map((x) => ({ ...x, since: ago(0) }));
  assert.deepEqual((await recordSyncStatus(s.state, { cycle: "ok", held: h }, new Date(NOW))).held, seen);
  assert.deepEqual((await recordSyncStatus(s.state, { cycle: "unchanged" }, new Date(NOW))).held, seen, "an aborted cycle keeps what the file says");
  assert.deepEqual((await recordSyncStatus(s.state, { cycle: "ok", held: [] }, new Date(NOW))).held, []);
  assert.deepEqual((await readSyncStatus(s.state)).held, []);
});

test("last sync falls back to the last line of logs/sync.log", async () => {
  const s = setup();
  mkdirSync(join(s.state, "logs"));
  writeFileSync(join(s.state, "logs", "sync.log"), `${ago(3 * HOUR)} noop\n${ago(25 * MIN)} ok run=20261114-a imported=2 failed=0\n`);
  await s.run();
  assert.match(s.out(), /Last sync +25 min ago, ok \(run 20261114-a\)/);
});

test("pending imports: from an over-limit result, else from the latest plan", async () => {
  const a = setup();
  a.status({ lastCycleAt: ago(MIN), pid: 1, startedAt: ago(HOUR), lastResult: { outcome: "over-limit", pending: 250, limit: 200 } });
  await a.run();
  assert.match(a.out(), /Pending imports +250 sessions/);
  const b = setup();
  const runDir = join(b.state, "runs", "20261113-000000");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "plan.json"), JSON.stringify({
    version: 1, runId: "20261113-000000", createdAt: ago(20 * HOUR), t3Version: "1", instancesToCreate: [], projectsToCreate: [], projectDefaults: [], mirrorCopies: [], projectAccounts: [], warnings: [],
    items: [{ action: { kind: "import" } }, { action: { kind: "convert-import" } }, { action: { kind: "skip" } }],
  }));
  await b.run();
  assert.match(b.out(), /Pending imports +2 sessions \(plan from 20 hours ago\)/);
});

test("last organize run from the journal, with counts", async () => {
  const s = setup();
  const j = new Journal(join(s.state, "journal.jsonl"));
  await j.append({ t: "run-start", runId: "org-1", at: ago(3 * 24 * HOUR), command: "organize" });
  await j.append({ t: "organize-change", runId: "org-1", kind: "thread-archive", target: "t1", previous: null, next: null } as never);
  await j.append({ t: "organize-change", runId: "org-1", kind: "thread-archive", target: "t2", previous: null, next: null } as never);
  await j.append({ t: "run-end", runId: "org-1", status: "ok" } as never);
  await j.append({ t: "run-start", runId: "imp-1", at: ago(HOUR), command: "sync" });
  await s.run();
  assert.match(s.out(), /Last organize +run org-1, 3 days ago: 2 changes/);
});

test("T3 Code: not running only when the runtime file says so; no network", async () => {
  const s = setup();
  await s.run([], { readRuntime: async () => null });
  assert.match(s.out(), /T3 Code +not running/);
  const r = setup();
  await r.run([], { readRuntime: async () => ({ origin: "http://127.0.0.1:1", port: 1, serverVersion: "9.9.9", pid: 5 }) });
  assert.match(r.out(), /T3 Code +running \(9\.9\.9\)/);
  const d = setup();
  await d.run([], { readRuntime: async () => ({ origin: "http://127.0.0.1:1", port: 1, serverVersion: "9.9.9", pid: 5 }), pidAlive: (p) => p !== 5 });
  assert.match(d.out(), /T3 Code +not running/);
});

test("--json: stable keys, no ANSI, the same data", async () => {
  const s = setup({ tty: true });
  s.status({
    pid: 7, startedAt: ago(HOUR), lastCycleAt: ago(3 * MIN), nextCycleAt: new Date(NOW + 7 * MIN).toISOString(),
    lastResult: { outcome: "ok", runId: "r1" },
    held: [{ project: "demo", root: "C:/work/demo", file: "C:/x/a.jsonl", title: "Fix", modifiedAt: ago(4 * MIN) }],
    needsAttention: attention(ago(2 * HOUR)), undecided: { automated: 2 }, heldRehome: 1, failures: 0,
  });
  assert.equal(await s.run(["--json"], { readRuntime: async () => null }), 10);
  assert.doesNotMatch(s.out(), /\u001b/);
  const j = JSON.parse(s.out());
  assert.deepEqual(Object.keys(j), ["version", "ran", "level", "items", "needsAttention", "waiting", "heldRehome", "decisionsPending", "pendingImports", "lastSync", "nextSync", "watcher", "update", "runInProgress", "lastOrganize", "plugin", "t3Code"]);
  assert.equal(j.version, 2);
  assert.equal(j.ran, true);
  assert.deepEqual(j.needsAttention, { reason: "undecided", detail: "3 sessions in 2 categories wait for your decision", command: "t3sm start", since: ago(2 * HOUR) });
  assert.deepEqual(j.waiting, [{ project: "demo", title: "Fix", modifiedAt: ago(4 * MIN), since: ago(4 * MIN) }]);
  assert.deepEqual(j.decisionsPending, { automated: 2 });
  assert.equal(j.heldRehome, 1);
  assert.deepEqual(j.lastSync, { at: ago(3 * MIN), outcome: "ok", runId: "r1" });
  assert.deepEqual(j.nextSync, { at: new Date(NOW + 7 * MIN).toISOString(), source: "watcher" });
  assert.deepEqual(j.watcher, { running: true, pid: 7, version: null, stale: true });
  assert.equal(j.lastOrganize, null);
  assert.deepEqual(j.plugin, [{ account: "default", state: "missing", version: null }]);
  assert.deepEqual(j.t3Code, { running: false, version: null });
});

test("colour only on a TTY without NO_COLOR", async () => {
  const body = { needsAttention: attention(ago(HOUR)), undecided: { automated: 1 } };
  const tty = setup({ tty: true });
  tty.status(body);
  await tty.run();
  assert.match(tty.out(), /\u001b\[/);
  const nc = setup({ tty: true, env: { NO_COLOR: "1" } });
  nc.status(body);
  await nc.run();
  assert.doesNotMatch(nc.out(), /\u001b/);
  const pipe = setup();
  pipe.status(body);
  await pipe.run();
  assert.doesNotMatch(pipe.out(), /\u001b/);
});

test("strictly read-only: the state folder is unchanged after a run", async () => {
  const s = setup();
  s.status({ needsAttention: attention(ago(HOUR)), undecided: { automated: 1 }, pid: 1, startedAt: ago(HOUR), lastCycleAt: ago(MIN) });
  await new Journal(join(s.state, "journal.jsonl")).append({ t: "run-start", runId: "x", at: ago(HOUR), command: "sync" });
  const before = snapshot(s.state);
  await s.run();
  await s.run(["--json"]);
  assert.deepEqual(snapshot(s.state), before);
  assert.equal(existsSync(join(s.state, "lock")), false);
});

test("unknown option or argument is a usage error (2); --help documents the JSON keys", async () => {
  const s = setup();
  assert.equal(await s.run(["--nope"]), 2);
  assert.match(s.err(), /Unknown option: --nope/);
  const out: string[] = [];
  const io: Io = { stdout: (x) => void out.push(x), stderr: () => {}, isTTY: false, prompt: async () => "", env: {} };
  assert.equal(await main(["status", "--help"], io), 0);
  const h = out.join("");
  for (const k of ["level", "items", "update", "runInProgress", "needsAttention", "waiting", "heldRehome", "decisionsPending", "pendingImports", "lastSync", "nextSync", "watcher", "lastOrganize", "t3Code"]) assert.match(h, new RegExp(k));
  out.length = 0;
  assert.equal(await main([], io), 0);
  assert.match(out.join(""), /t3sm status/);
});

test("a corrupt sync-status.json does not fail status", async () => {
  const s = setup();
  writeFileSync(join(s.state, "sync-status.json"), "{not json");
  assert.equal(await s.run(), 0);
  assert.match(s.out(), /All good/);
});

test("t3sm plugin line: one entry per configured account (installed, outdated, missing), read-only", async () => {
  const s = setup();
  const seen: string[] = [];
  const states: Record<string, { state: "installed" | "outdated"; version: string } | { state: "missing" }> = {
    "C:/h/.claude": { state: "installed", version: "0.3.0" }, "C:/h/.claude-org": { state: "outdated", version: "0.2.1" }, "C:/h/.claude-x": { state: "missing" },
  };
  await s.run([], {
    accounts: async () => [{ id: "personal", home: "C:/h/.claude" }, { id: "org", home: "C:/h/.claude-org" }, { id: "x", home: "C:/h/.claude-x" }],
    packageVersion: "0.3.0", pluginState: async (h) => { seen.push(h); return states[h]!; },
  });
  assert.deepEqual(seen, ["C:/h/.claude", "C:/h/.claude-org", "C:/h/.claude-x"]);
  assert.match(flat(s.out()), /t3sm plugin personal: installed \(0\.3\.0\); org: outdated: 0\.2\.1 installed, this t3sm is 0\.3\.0.*; x: not installed/);
  const j = setup();
  await j.run(["--json"], { accounts: async () => [{ id: "personal", home: "C:/h/.claude" }, { id: "x", home: "C:/h/.claude-x" }], packageVersion: "0.3.0", pluginState: async (h) => states[h]! });
  assert.deepEqual(JSON.parse(j.out()).plugin, [{ account: "personal", state: "installed", version: "0.3.0" }, { account: "x", state: "missing", version: null }]);
});

test("t3sm plugin line: an account named after its email shows it masked, on screen and in --json", async () => {
  const accounts = async () => [{ id: "personal", home: "C:/h/.claude", name: "demouser@example.com" }];
  const s = setup();
  await s.run([], { accounts, packageVersion: "0.3.0", pluginState: async () => ({ state: "installed", version: "0.3.0" }) });
  assert.match(flat(s.out()), /d\*\*\*@example\.com: installed/);
  const j = setup();
  await j.run(["--json"], { accounts, packageVersion: "0.3.0", pluginState: async () => ({ state: "installed", version: "0.3.0" }) });
  assert.doesNotMatch(s.out() + j.out(), /demouser/);
});

test("t3sm plugin line: reads installed_plugins.json of each account's home by default; a failing accounts reader is not fatal", async () => {
  const s = setup();
  const acct = join(s.home, ".claude-demo");
  mkdirSync(join(acct, "plugins"), { recursive: true });
  writeFileSync(join(acct, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "t3sm@t3code-session-manager": [{ version: "9.9.9" }] } }));
  await s.run([], { accounts: async () => [{ id: "demo", home: acct }], packageVersion: "0.3.0" });
  assert.match(s.out(), /t3sm plugin +demo: installed \(9\.9\.9\)/);
  const b = setup();
  assert.equal(await b.run([], { accounts: async () => { throw new Error("config"); } }), 0);
  assert.doesNotMatch(b.out(), /t3sm plugin/);
});

// ---------- Task 15: truthful status ----------

type Item = { level: string; key: string; text: string; command: string | null };
async function report(s: ReturnType<typeof setup>, deps: Parameters<typeof statusCommand>[2] = {}): Promise<{ code: number; j: { level: string; items: Item[]; [k: string]: unknown } }> {
  const before = s.out().length;
  const code = await s.run(["--json"], deps);
  return { code, j: JSON.parse(s.out().slice(before)) };
}

test("F3 replay: old watcher running old code shows needs-you, not all good", async () => {
  // A 0.2.1 watcher: its heartbeat has no version, its pid is alive, nothing else is wrong.
  const s = setup();
  s.status({ pid: 77, startedAt: ago(5 * HOUR), lastCycleAt: ago(3 * MIN), nextCycleAt: new Date(NOW + 7 * MIN).toISOString(), lastResult: { outcome: "noop" }, needsAttention: null, undecided: {}, heldRehome: 0, failures: 0 });
  assert.equal(await s.run(), 10);
  assert.match(s.out(), /^! Needs you \(1\)/);
  assert.doesNotMatch(s.out(), /All good/);
  assert.match(s.out(), /older t3sm/);
  assert.match(s.out(), /^  [›>] t3sm schedule restart$/m);
  const { j } = await report(setup(), {});
  assert.equal(j.level, "ok", "control: no heartbeat at all is not a stale watcher");
  // A 0.3.0 watcher while 0.3.1 was installed well before its last cycle: stale version.
  const v = setup();
  v.status(LIVE);
  const r = await report(v, { installStamp: () => ({ version: "0.3.1", stamp: "2026-11-14T10:00:00.000Z", changedAtMs: NOW - 2 * HOUR }) });
  assert.equal(r.code, 10);
  assert.equal(r.j.level, "needs-you");
  const it = r.j.items.find((i) => i.key === "watcher-stale-version")!;
  assert.equal(it.level, "needs-you");
  assert.match(it.text, /0\.3\.0.*0\.3\.1 is installed/);
  assert.equal(it.command, "t3sm schedule restart");
  assert.deepEqual(r.j["watcher"], { running: true, pid: 7, version: "0.3.0", stale: true });
  // Installed a moment before its last cycle ended: it switches after the next one (info only).
  const w = setup();
  w.status(LIVE);
  const p = await report(w, { installStamp: () => ({ version: "0.3.1", stamp: "x", changedAtMs: Date.parse(LIVE.lastCycleAt) - 5_000 }) });
  assert.equal(p.j.level, "ok");
  assert.equal(p.j.items.find((i) => i.key === "watcher-switching")?.level, "info");
});

test("status and doctor classify the watcher with the same function", async () => {
  const { watcherHealth } = await import("../../src/ops/watcherHealth.ts");
  const o = { now: NOW, pidAlive: () => true, install: () => ({ ...INSTALL, changedAtMs: 0 }), everyMinutes: 15 };
  assert.equal(watcherHealth(null, o).state, "none");
  assert.equal(watcherHealth({ ...LIVE } as never, o).state, "running");
  assert.equal(watcherHealth({ ...LIVE, version: undefined } as never, o).state, "no-version");
  assert.equal(watcherHealth({ ...LIVE } as never, { ...o, pidAlive: () => false }).state, "gone");
  assert.equal(watcherHealth({ ...LIVE, stoppedAt: ago(30 * MIN), reason: "restart" } as never, o).state, "restart-lost");
  assert.equal(watcherHealth({ ...LIVE, stoppedAt: ago(2 * MIN), reason: "restart" } as never, o).state, "stopped");
});

test("watcher gone, restart without successor, late cycles, failing streak: needs you with the command", async () => {
  const gone = setup();
  gone.status(LIVE);
  const g = await report(gone, { pidAlive: (p) => p !== 7 });
  assert.equal(g.j.level, "needs-you");
  assert.equal(g.j.items[0]!.key, "watcher-not-running");
  assert.equal(g.j.items[0]!.command, "t3sm schedule restart");
  const lost = setup();
  lost.status({ ...LIVE, stoppedAt: ago(40 * MIN), reason: "restart" });
  assert.equal((await report(lost)).j.items[0]!.key, "watcher-not-running");
  // Late: nextCycleAt long past while T3 Code runs. With T3 Code closed it waits for T3 Code (not late).
  const late = setup();
  late.status({ ...LIVE, lastCycleAt: ago(3 * HOUR), nextCycleAt: ago(2 * HOUR) });
  const rt = async () => ({ origin: "http://127.0.0.1:1", port: 1, serverVersion: "9.9.9", pid: 5 });
  assert.equal((await report(late, { readRuntime: rt })).j.items[0]!.key, "watcher-late");
  const closed = setup();
  closed.status({ ...LIVE, lastCycleAt: ago(3 * HOUR), nextCycleAt: ago(2 * HOUR) });
  assert.equal((await report(closed, { readRuntime: async () => null })).j.level, "ok");
  const failing = setup();
  failing.status({ ...LIVE, failures: 4, needsAttention: { reason: "repeated-failures", detail: "The last 4 sync cycles failed", command: "t3sm doctor", since: ago(HOUR) } });
  const f = await report(failing);
  const fi = f.j.items.find((i) => i.key === "sync-failing")!;
  assert.equal(fi.level, "needs-you");
  assert.match(fi.text, /last 4 sync cycles failed/);
  assert.equal(fi.command, "t3sm doctor");
  assert.equal(f.j.items.filter((i) => /fail/.test(i.key)).length, 1, "the attention reason is not listed twice");
  // The streak was reset (failures 0) but sync still records the reason: no invented count.
  const reset = setup();
  reset.status({ ...LIVE, failures: 0, needsAttention: { reason: "repeated-failures", detail: "The last 3 sync cycles failed", command: "t3sm doctor", since: ago(HOUR) } });
  const rs = (await report(reset)).j.items.find((i) => i.key === "sync-failing")!;
  assert.equal(rs.text, "The background sync keeps failing repeatedly");
  // A cleanly stopped watcher is worth knowing, not a need.
  const stopped = setup();
  stopped.status({ ...LIVE, stoppedAt: ago(HOUR) });
  const st = await report(stopped);
  assert.equal(st.j.level, "ok");
  assert.equal(st.j.items.find((i) => i.key === "watcher-stopped")?.level, "info");
});

test("41 undecided gives needs-you with t3sm start", async () => {
  // The newest plan holds the questions; no cycle recorded them (an old watcher never did).
  const s = setup();
  s.status({ ...LIVE, undecided: {}, lastCycleAt: ago(3 * HOUR) });
  writePlan(s.state, "20261114-110000-aaaa", { createdAt: ago(HOUR), decisionsPending: [{ key: "automated", sessions: 30, folders: 3 }, { key: "t3-refused", sessions: 11, folders: 2 }] });
  const { code, j } = await report(s);
  assert.equal(code, 10);
  assert.equal(j.level, "needs-you");
  const u = j.items.find((i) => i.key === "undecided")!;
  assert.equal(u.level, "needs-you");
  assert.match(u.text, /^41 conversations wait for your decision \(automated 30, t3-refused 11\)/);
  assert.equal(u.command, "t3sm start");
  assert.deepEqual(j["decisionsPending"], { automated: 30, "t3-refused": 11 });
  // A cycle newer than the plan wins: it found the questions answered.
  const n = setup();
  n.status({ ...LIVE, undecided: {}, lastCycleAt: ago(10 * MIN) });
  writePlan(n.state, "20261114-110000-aaaa", { createdAt: ago(HOUR), decisionsPending: [{ key: "automated", sessions: 41, folders: 3 }] });
  assert.equal((await report(n)).j.level, "ok");
});

test("run in progress gives working", async () => {
  const s = setup();
  s.status(LIVE);
  writeFileSync(join(s.state, "lock"), JSON.stringify({ pid: 4321, startedAt: ago(2 * MIN), hostname: "demo-host" }));
  const { code, j } = await report(s);
  assert.equal(code, 0, "working is not a need");
  assert.equal(j.level, "working");
  assert.deepEqual(j["runInProgress"], { pid: 4321, startedAt: ago(2 * MIN) });
  const before = s.out().length;
  assert.equal(await s.run(), 0);
  assert.match(s.out().slice(before), /^[●*] Working [·-] a t3sm run is in progress \(pid 4321, started 2 min ago\)/);
  // A lock left by a dead process is not a run in progress.
  const dead = setup();
  writeFileSync(join(dead.state, "lock"), JSON.stringify({ pid: 4321, startedAt: ago(2 * MIN), hostname: "demo-host" }));
  assert.equal((await report(dead, { pidAlive: (p) => p !== 4321 })).j.level, "ok");
  // Something that needs you wins over working.
  const both = setup();
  both.status({ ...LIVE, undecided: { automated: 2 } });
  writeFileSync(join(both.state, "lock"), JSON.stringify({ pid: 4321, startedAt: ago(2 * MIN), hostname: "demo-host" }));
  assert.equal((await report(both)).j.level, "needs-you");
});

test("exit 10 when needs-you", async () => {
  const s = setup();
  s.status({ ...LIVE, heldRehome: 1 });
  assert.equal(await s.run(), 10);
  assert.equal(await s.run(["--json"]), 10);
  const ok = setup();
  ok.status(LIVE);
  assert.equal(await ok.run(), 0);
  assert.match(ok.out(), /^[✓v] All good/);
});

test("json v2 shape", async () => {
  const s = setup();
  s.status({ ...LIVE, undecided: { automated: 2 } });
  const { j } = await report(s);
  assert.equal(j["version"], 2);
  assert.equal(j["ran"], true);
  assert.ok(["ok", "needs-you", "working"].includes(j.level));
  for (const i of j.items) {
    assert.deepEqual(Object.keys(i), ["level", "key", "text", "command"]);
    assert.ok(i.level === "needs-you" || i.level === "info");
    assert.ok(i.command === null || typeof i.command === "string");
  }
  assert.deepEqual(j["watcher"], { running: true, pid: 7, version: "0.3.0", stale: false });
  assert.deepEqual(j["update"], { installed: "0.3.0", available: null, failure: null, lastInstalled: null });
  assert.equal(j["runInProgress"], null);
  // Items are ordered: every needs-you item before every info item.
  const levels = j.items.map((i) => i.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => (a === b ? 0 : a === "needs-you" ? -1 : 1)));
});

test("info items never raise the level", async () => {
  const s = setup();
  s.status({ ...LIVE, held: [{ project: "demo", title: "Fix", modifiedAt: ago(4 * MIN), since: ago(30 * MIN) }] });
  const j = new Journal(join(s.state, "journal.jsonl"));
  await j.append({ t: "update", runId: "20261113-120000-abcd", from: "0.2.9", to: "0.3.0", source: { kind: "github", repo: "demo-owner/demo-app" }, outcome: "installed" } as never);
  writePlan(s.state, "20261114-110000-aaaa", { createdAt: ago(10 * MIN), items: [skipItem("s-1", "old-app", "orphaned-in-t3"), skipItem("s-2", "lost-app", "t3-native-unknown")] });
  const r = await report(s);
  assert.equal(r.code, 0);
  assert.equal(r.j.level, "ok");
  assert.ok(r.j.items.length >= 4);
  assert.ok(r.j.items.every((i) => i.level === "info"));
  const upd = r.j.items.find((i) => i.key === "update-installed")!;
  assert.equal(upd.text, "Updated to 0.3.0 yesterday - what's new: t3sm changelog");
  assert.equal(upd.command, "t3sm changelog");
  assert.match(r.j.items.find((i) => i.key === "held:demo")!.text, /demo is waiting: 'Fix' is in use \(first held 30 min ago\)/);
  assert.match(r.j.items.find((i) => i.key === "orphaned-in-t3")!.text, /1 conversation .*deleted.*old-app \(claude s-1\)/);
  assert.match(r.j.items.find((i) => i.key === "t3-native-unknown")!.text, /lost-app \(claude s-2\).*claude --resume/);
  assert.deepEqual(r.j["update"], { installed: "0.3.0", available: null, failure: null, lastInstalled: { from: "0.2.9", to: "0.3.0", at: "2026-11-13T12:00:00.000Z" } });
  await s.run();
  assert.match(s.out(), /All good/);
  // An install older than 7 days is not mentioned.
  const old = setup();
  old.status(LIVE);
  await new Journal(join(old.state, "journal.jsonl")).append({ t: "update", runId: "20261101-120000-abcd", from: "0.2.9", to: "0.3.0", source: { kind: "github", repo: "demo-owner/demo-app" }, outcome: "installed" } as never);
  assert.equal((await report(old)).j.items.some((i) => i.key === "update-installed"), false);
});

test("an update that failed or was interrupted needs you; a rolled-back one (t3sm recovered) and a major available are only worth knowing", async () => {
  const f = setup();
  f.status({ ...LIVE, updateFailure: { from: "0.3.0", to: "0.3.1", outcome: "failed", at: ago(HOUR) } });
  const r = await report(f);
  const it = r.j.items.find((i) => i.key === "update-failed")!;
  assert.equal(it.level, "needs-you");
  assert.match(it.text, /Updating t3sm from 0\.3\.0 to 0\.3\.1 failed/);
  assert.equal(it.command, "t3sm update --check");
  assert.equal(r.code, 10);
  // Rolled back: the previous version runs and is healthy, so t3sm recovered by itself. Worth knowing, not a need.
  const rb = setup();
  rb.status({ ...LIVE, updateFailure: { from: "0.3.0", to: "0.3.1", outcome: "rolled-back", at: ago(HOUR) } });
  const rr = await report(rb);
  assert.equal(rr.j.items.some((i) => i.key === "update-failed"), false);
  const rbi = rr.j.items.find((i) => i.key === "update-rolled-back")!;
  assert.equal(rbi.level, "info");
  assert.match(rbi.text, /t3sm 0\.3\.1 was rolled back; 0\.3\.0 is running/);
  assert.equal(rbi.command, "t3sm update --check");
  assert.equal(rr.j.level, "ok", "a rolled-back update does not need you");
  assert.equal(rr.code, 0);
  assert.deepEqual((rr.j["update"] as { failure: unknown }).failure, { from: "0.3.0", to: "0.3.1", outcome: "rolled-back", at: ago(HOUR) });
  // Already at (or past) the failed version: nothing to look at any more.
  const past = setup();
  past.status({ ...LIVE, updateFailure: { from: "0.2.9", to: "0.3.0", outcome: "failed", at: ago(HOUR) } });
  assert.equal((await report(past)).j.level, "ok");
  // An attempt on disk with no outcome and no run holding the lock: interrupted.
  const i = setup();
  i.status(LIVE);
  writeFileSync(join(i.state, "update.pending.json"), JSON.stringify({ runId: "20261114-100000-abcd", previous: { version: "0.3.0", spec: "github:demo-owner/demo-app#v0.3.0" }, source: { kind: "github", repo: "demo-owner/demo-app" }, target: "0.3.1", startedAt: ago(2 * HOUR) }));
  const ii = (await report(i)).j.items.find((x) => x.key === "update-interrupted")!;
  assert.equal(ii.level, "needs-you");
  assert.equal(ii.command, "t3sm update --check");
  // A run holding the lock hides it only while that run may be the update itself (its lock is older than the attempt);
  // a lock taken after the attempt started is another run: the attempt is still reported.
  const lockAt = (iso: string): void => writeFileSync(join(i.state, "lock"), JSON.stringify({ pid: 9, startedAt: iso, hostname: hostname() }));
  lockAt(ago(2 * HOUR + MIN));
  assert.equal((await report(i)).j.items.some((x) => x.key === "update-interrupted"), false, "maybe the update itself: hidden");
  lockAt(ago(10 * MIN));
  assert.equal((await report(i)).j.items.some((x) => x.key === "update-interrupted"), true, "a later run: still interrupted");
  // A major release found by the daily check: announced, never installed by itself.
  const m = setup();
  m.status(LIVE);
  writeFileSync(join(m.state, "update.json"), JSON.stringify({ source: { kind: "github", repo: "demo-owner/demo-app" }, lastCheckAt: ago(HOUR), previous: null, available: "1.0.0", skip: [] }));
  const mm = await report(m);
  const major = mm.j.items.find((x) => x.key === "update-major")!;
  assert.equal(major.level, "info");
  assert.equal(mm.j.level, "ok", "a major release is announced, it does not need you");
  assert.equal(mm.code, 0);
  assert.match(major.text, /t3sm 1\.0\.0 is available/);
  assert.equal(major.command, "t3sm update");
  assert.equal((mm.j["update"] as { available: unknown }).available, "1.0.0");
});

test("repeated import failures by reason, with names; follow conflicts name both conversations", async () => {
  const s = setup();
  s.status({ ...LIVE, followConflicts: [{ originalId: "o-1", copyId: "c-1", originalTitle: "Plan the API", copyTitle: "Plan the API (copy)" }] });
  writePlan(s.state, "20261114-110000-aaaa", { createdAt: ago(10 * MIN), items: [
    { session: { harness: "claude", nativeId: "s-1", cwd: "C:/work/demo" }, action: { kind: "import" }, notes: [] },
    { session: { harness: "codex", nativeId: "s-2", cwd: null }, action: { kind: "import" }, notes: [] },
  ] });
  const j = new Journal(join(s.state, "journal.jsonl"));
  for (const run of ["r1", "r2"]) {
    await j.append({ t: "import-failed", runId: run, harness: "claude", nativeId: "s-1", reason: "thread did not appear" } as never);
    await j.append({ t: "import-failed", runId: run, harness: "codex", nativeId: "s-2", reason: "thread did not appear" } as never);
  }
  // Failed twice but gone from the newest plan (deleted, or skipped now): not listed.
  await j.append({ t: "import-failed", runId: "r1", harness: "claude", nativeId: "s-9", reason: "thread did not appear" } as never);
  await j.append({ t: "import-failed", runId: "r2", harness: "claude", nativeId: "s-9", reason: "thread did not appear" } as never);
  // Failed twice, then imported: not failing any more.
  await j.append({ t: "import-failed", runId: "r1", harness: "claude", nativeId: "s-3", reason: "timeout" } as never);
  await j.append({ t: "import-failed", runId: "r2", harness: "claude", nativeId: "s-3", reason: "timeout" } as never);
  await j.append({ t: "imported", runId: "r3", harness: "claude", nativeId: "s-3", threadId: "t-3" } as never);
  const r = await report(s);
  const fails = r.j.items.filter((i) => i.key.startsWith("import-failing"));
  assert.equal(fails.length, 1);
  assert.equal(fails[0]!.level, "needs-you");
  assert.match(fails[0]!.text, /^2 conversations keep failing to import \(thread did not appear\): demo \(claude s-1\), codex s-2$/);
  assert.equal(fails[0]!.command, "t3sm doctor");
  const fc = r.j.items.find((i) => i.key === "follow-conflict:c-1")!;
  assert.equal(fc.level, "needs-you");
  assert.equal(fc.command, null);
  assert.match(fc.text, /'Plan the API'.*'Plan the API \(copy\)'/);
  assert.match(fc.text, /archive the copy's thread in T3 Code to stop following, or keep continuing it there; the work done outside T3 Code stays in 'Plan the API'$/);
});

test("organize failures of the last run need you; an earlier run's do not", async () => {
  const s = setup();
  s.status(LIVE);
  const j = new Journal(join(s.state, "journal.jsonl"));
  await j.append({ t: "run-start", runId: "org-1", at: ago(2 * HOUR), command: "organize" });
  await j.append({ t: "organize-failed", runId: "org-1", kind: "title", target: "t-1", projectId: "p-1", error: "rejected" } as never);
  await j.append({ t: "organize-failed", runId: "org-1", kind: "archive", target: "t-2", projectId: "p-1", error: "rejected" } as never);
  await j.append({ t: "run-end", runId: "org-1", at: ago(2 * HOUR), status: "partial" } as never);
  const r = await report(s);
  const it = r.j.items.find((i) => i.key === "organize-failed")!;
  assert.equal(it.level, "needs-you");
  assert.match(it.text, /2 organize changes could not be made in the last run \(org-1\)/);
  assert.equal(it.command, "t3sm organize");
  // A later sync run that organized nothing does not hide them.
  await j.append({ t: "run-start", runId: "sync-1", at: ago(90 * MIN), command: "sync" });
  await j.append({ t: "run-end", runId: "sync-1", at: ago(90 * MIN), status: "ok" } as never);
  assert.match((await report(s)).j.items.find((i) => i.key === "organize-failed")!.text, /\(org-1\)/);
  // A later organize run with nothing to change (no change, no failure) clears them.
  await j.append({ t: "run-start", runId: "org-2", at: ago(HOUR), command: "organize" });
  await j.append({ t: "run-end", runId: "org-2", at: ago(HOUR), status: "ok" } as never);
  assert.equal((await report(s)).j.items.some((i) => i.key === "organize-failed"), false);
  // A sync run (journaled as `sync <runId>`, as src/ops/sync.ts does) that journaled organize failures is the last organize run.
  await j.append({ t: "run-start", runId: "sync-2", at: ago(30 * MIN), command: "sync sync-2" });
  await j.append({ t: "organize-failed", runId: "sync-2", kind: "archive", target: "t-3", projectId: "p-1", error: "rejected" } as never);
  await j.append({ t: "run-end", runId: "sync-2", at: ago(30 * MIN), status: "partial" } as never);
  assert.match((await report(s)).j.items.find((i) => i.key === "organize-failed")!.text, /^1 organize change could not be made in the last run \(sync-2\)/);
  // So is a `projects rename` run (organize entries of kind project-title), and a clean one clears it.
  await j.append({ t: "run-start", runId: "ren-1", at: ago(20 * MIN), command: "projects rename" });
  await j.append({ t: "organize-failed", runId: "ren-1", kind: "project-title", target: "p-1", projectId: "p-1", error: "rejected" } as never);
  await j.append({ t: "run-end", runId: "ren-1", at: ago(20 * MIN), status: "partial" } as never);
  assert.match((await report(s)).j.items.find((i) => i.key === "organize-failed")!.text, /\(ren-1\): 1 project-title/);
  await j.append({ t: "run-start", runId: "ren-2", at: ago(10 * MIN), command: "projects rename" });
  await j.append({ t: "organize-change", runId: "ren-2", kind: "project-title", target: "p-1", previous: "a", next: "b" } as never);
  await j.append({ t: "run-end", runId: "ren-2", at: ago(10 * MIN), status: "ok" } as never);
  assert.equal((await report(s)).j.items.some((i) => i.key === "organize-failed"), false);
});

test("other reasons recorded by sync (signed out, over the limit) are needs-you items with their command", async () => {
  const s = setup();
  s.status({ ...LIVE, needsAttention: { reason: "signed-out", detail: "1 account is signed out in T3 Code; its sessions wait", command: "t3sm accounts", since: ago(HOUR) } });
  const r = await report(s);
  assert.deepEqual(r.j.items[0], { level: "needs-you", key: "attention:signed-out", text: "1 account is signed out in T3 Code; its sessions wait", command: "t3sm accounts" });
  // In Portuguese the item is worded from the facts sync recorded (never the English detail read back).
  const { attentionOf } = await import("../../src/ops/sync.ts");
  const { zeroCounts } = await import("../../src/ops/sync.ts");
  const a = attentionOf({ kind: "noop", runId: null, counts: zeroCounts() }, { undecided: {}, signedOut: 2 })!;
  const p = setup();
  p.status({ ...LIVE, needsAttention: { ...a, since: ago(HOUR) } });
  p.io.lang = "pt";
  const before = p.out().length;
  await p.run([], {});
  const screen = p.out().slice(before);
  assert.match(screen, /2 contas têm a sessão terminada no T3 Code/);
  assert.doesNotMatch(screen, /signed out/);
});

test("recordSyncStatus keeps when a project was first held", async () => {
  const { recordSyncStatus } = await import("../../src/ops/syncStatus.ts");
  const s = setup();
  const first = await recordSyncStatus(s.state, { cycle: "ok", held: [{ project: "demo", title: "Fix", modifiedAt: ago(5 * MIN) }] }, new Date(NOW - 20 * MIN));
  assert.equal(first.held[0]!.since, ago(20 * MIN));
  const later = await recordSyncStatus(s.state, { cycle: "ok", held: [{ project: "demo", title: "Fix", modifiedAt: ago(MIN) }, { project: "app", title: null, modifiedAt: ago(MIN) }] }, new Date(NOW));
  assert.equal(later.held[0]!.since, ago(20 * MIN), "the same project keeps its first time");
  assert.equal(later.held[1]!.since, ago(0));
});

test("F3 combined: a 0.2.1 watcher cycling now and a plan with 41 decisions: stale watcher AND 41 undecided", async () => {
  const s = setup();
  // The 0.2.1 heartbeat: no version, cycled a minute ago (newer than the plan), never writes `undecided`.
  s.status({ pid: 77, startedAt: ago(5 * HOUR), lastCycleAt: ago(MIN), nextCycleAt: new Date(NOW + 14 * MIN).toISOString(), lastResult: { outcome: "noop" }, needsAttention: null, heldRehome: 0, failures: 0 });
  writePlan(s.state, "20261114-110000-aaaa", { createdAt: ago(HOUR), decisionsPending: [{ key: "automated", sessions: 30, folders: 3 }, { key: "t3-refused", sessions: 11, folders: 2 }] });
  const { code, j } = await report(s);
  assert.equal(code, 10);
  assert.equal(j.items.find((i) => i.key === "watcher-stale-version")?.level, "needs-you");
  const u = j.items.find((i) => i.key === "undecided")!;
  assert.match(u.text, /^41 conversations wait for your decision/);
  assert.equal(u.command, "t3sm start");
  // Even with an `undecided` key left in the file by an earlier 0.3 run: a 0.2.1 watcher's cycles never update it.
  const k = setup();
  k.status({ pid: 77, startedAt: ago(5 * HOUR), lastCycleAt: ago(MIN), nextCycleAt: new Date(NOW + 14 * MIN).toISOString(), lastResult: { outcome: "noop" }, undecided: {} });
  writePlan(k.state, "20261114-110000-aaaa", { createdAt: ago(HOUR), decisionsPending: [{ key: "automated", sessions: 41, folders: 3 }] });
  assert.match((await report(k)).j.items.find((i) => i.key === "undecided")!.text, /^41 /);
  // A one-shot 0.3 sync file without an `undecided` key (no cycle recorded it): the plan counts.
  const n = setup();
  n.status({ needsAttention: null, heldRehome: 0, failures: 0 });
  mkdirSync(join(n.state, "logs"));
  writeFileSync(join(n.state, "logs", "sync.log"), `${ago(MIN)} noop\n`);
  writePlan(n.state, "20261114-110000-aaaa", { createdAt: ago(HOUR), decisionsPending: [{ key: "automated", sessions: 41, folders: 3 }] });
  assert.ok((await report(n)).j.items.some((i) => i.key === "undecided"));
});

test("security: control characters in heartbeat and update records never reach the terminal; non-semver versions are unknown", async () => {
  const ESC = "\u001b";
  const s = setup();
  s.status({ ...LIVE, version: `0.3.0${ESC}[31m`, updateFailure: { from: "0.3.0", to: `0.3.1${ESC}]0;pwned\u0007`, outcome: "failed", at: ago(HOUR) } });
  const before = s.out().length;
  assert.equal(await s.run(), 10);
  const text = s.out().slice(before);
  assert.doesNotMatch(text, /[\u001b\u0007]/);
  const { j } = await report(s);
  assert.doesNotMatch(JSON.stringify(j), /\\u001b|\\u0007/);
  const w = j.items.find((i) => i.key === "watcher-stale-version")!;
  assert.match(w.text, /older t3sm/, "a non-semver heartbeat version is treated as unknown");
  assert.equal((j["watcher"] as { version: unknown }).version, null);
  const u = j.items.find((i) => i.key === "update-failed")!;
  assert.match(u.text, /from 0\.3\.0 to unknown failed/);
  // A pending record with a bad target is not an update record at all.
  const p = setup();
  p.status(LIVE);
  writeFileSync(join(p.state, "update.pending.json"), JSON.stringify({ runId: "20261114-100000-abcd", previous: { version: "0.3.0", spec: "x" }, source: { kind: "github", repo: "demo-owner/demo-app" }, target: `0.3.1${ESC}[2J`, startedAt: ago(HOUR) }));
  assert.equal((await report(p)).j.items.some((i) => i.key === "update-interrupted"), false);
  // A journal `update` entry with a bad version is not mentioned.
  const q = setup();
  q.status(LIVE);
  await new Journal(join(q.state, "journal.jsonl")).append({ t: "update", runId: "20261114-100000-abcd", from: "0.2.9", to: `0.3.0${ESC}[2J`, source: { kind: "github", repo: "demo-owner/demo-app" }, outcome: "installed" } as never);
  const qj = (await report(q)).j;
  assert.equal(qj.items.some((i) => i.key === "update-installed"), false);
  assert.equal((qj["update"] as { lastInstalled: unknown }).lastInstalled, null);
});

test("recordSyncStatus: a 0.3 cycle that looked always writes `undecided`, even {} (status trusts the key)", async () => {
  const { recordSyncStatus, recordsUndecided } = await import("../../src/ops/syncStatus.ts");
  const s = setup();
  // Every field a cycle writes, except `undecided` (a file a 0.2.1 watcher left), in the order a cycle writes them.
  s.status({ needsAttention: null, heldRehome: 0, held: [], failures: 0 });
  assert.equal(await recordsUndecided(s.state), false);
  await recordSyncStatus(s.state, { cycle: "ok", attention: null, undecided: {}, heldRehome: 0, held: [] }, new Date(NOW));
  assert.deepEqual(JSON.parse(readFileSync(join(s.state, "sync-status.json"), "utf8")).undecided, {});
  assert.equal(await recordsUndecided(s.state), true);
  // A cycle that could not look (an error) does not claim to have recorded it.
  const e = setup();
  e.status({ needsAttention: null, heldRehome: 0, held: [], failures: 0 });
  await recordSyncStatus(e.state, { cycle: "unchanged" }, new Date(NOW));
  assert.equal(await recordsUndecided(e.state), false);
});

// ---------- Task 19: localized output ----------

/** `t3sm <argv>` through main (the global flags are parsed there), with status's world injected. */
async function viaMain(s: ReturnType<typeof setup>, argv: string[]): Promise<number> {
  const saved = commands["status"]!;
  commands["status"] = (a, io) => statusCommand(a, io, { home: s.home, now: () => NOW, pidAlive: () => true, packageVersion: "0.3.0", installStamp: () => ({ ...INSTALL, changedAtMs: 0 }), readRuntime: async () => null, accounts: async () => [], pluginState: async () => ({ state: "missing" }) });
  try { return await main(argv, s.io); } finally { commands["status"] = saved; }
}

const BODY = { ...LIVE, held: [{ project: "demo", title: "Fix", modifiedAt: ago(4 * MIN), since: ago(25 * MIN) }], needsAttention: null, undecided: { automated: 2 }, heldRehome: 0, failures: 0 };

test("--lang pt works on t3sm status: the lead line, the items and the labels in Portuguese", async () => {
  const s = setup({ env: { LANG: "en_US.UTF-8" } });
  s.status(BODY);
  assert.equal(await viaMain(s, ["status", "--lang", "pt"]), 10);
  const o = s.out();
  assert.match(o, /^! Precisa de ti \(1\)/);
  assert.match(o, /2 conversas esperam pela tua decisão \(sessões automáticas 2\)/);
  assert.match(o, /^  [›>] t3sm start$/m);
  assert.match(o, /Bom saber/);
  assert.match(flat(o), /demo está à espera: 'Fix' está em uso \(retido há 25 min\)/);
  assert.match(o, /Última sincronização +há 3 min, noop/);
  assert.match(o, /Próxima sincronização +daqui a 7 min \(vigilante\)/);
  assert.match(o, /T3 Code +não está a correr/);
  assert.doesNotMatch(o, /Needs you|Worth knowing|Last sync|not running/);
  // The flag goes before the command too; T3SM_LANG and config.json "language" choose it without a flag.
  const b = setup({ env: { LANG: "en_US.UTF-8" } });
  b.status(BODY);
  await viaMain(b, ["--lang=pt", "status"]);
  assert.match(b.out(), /^! Precisa de ti/);
  const e = setup({ env: { LANG: "en_US.UTF-8", T3SM_LANG: "pt" } });
  e.status(BODY);
  await viaMain(e, ["status"]);
  assert.match(e.out(), /^! Precisa de ti/);
  const c = setup({ env: { LANG: "pt_PT.UTF-8" } });
  writeFileSync(join(c.state, "config.json"), JSON.stringify({ version: 1, accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "C", accentColor: null }], defaultAccount: "claudeAgent", language: "en" }));
  c.status(BODY);
  await viaMain(c, ["status"]);
  assert.match(c.out(), /^! Needs you \(1\)/, "config.json language beats the system locale");
  // English stays exactly as it was.
  const en = setup({ env: { LANG: "en_US.UTF-8" } });
  en.status(BODY);
  await viaMain(en, ["status", "--lang", "en"]);
  assert.match(en.out(), /^! Needs you \(1\)\n\n[✗x] 2 conversations wait for your decision \(automated sessions 2\)\n  [›>] t3sm start\n/);
  assert.match(flat(en.out()), /demo is waiting: 'Fix' is in use \(first held 25 min ago\)/);
});

test("--lang pt leaves status --json byte-identical; --lang fr is a usage error (2) in English; --no-color works for status", async () => {
  const a = setup({ env: { LANG: "en_US.UTF-8" } });
  a.status(BODY);
  await viaMain(a, ["status", "--json"]);
  const b = setup({ env: { LANG: "en_US.UTF-8" } });
  b.status(BODY);
  await viaMain(b, ["status", "--json", "--lang", "pt"]);
  assert.equal(b.out(), a.out());
  const bad = setup();
  assert.equal(await viaMain(bad, ["status", "--lang", "fr"]), 2);
  assert.match(bad.err(), /^--lang must be en or pt\. Run `t3sm --help`\.\n$/);
  assert.equal(bad.out(), "");
  const tty = setup({ tty: true, env: { LANG: "en_US.UTF-8" } });
  tty.status(BODY);
  await viaMain(tty, ["status"]);
  assert.match(tty.out(), /\u001b\[/);
  const nc = setup({ tty: true, env: { LANG: "en_US.UTF-8" } });
  nc.status(BODY);
  await viaMain(nc, ["status", "--no-color"]);
  assert.doesNotMatch(nc.out(), /\u001b/);
});

test("status before t3sm ever ran, in Portuguese", async () => {
  const s = setup({ noState: true, env: { LANG: "en_US.UTF-8" } });
  assert.equal(await viaMain(s, ["status", "--lang", "pt"]), 0);
  assert.equal(s.out(), "O t3sm ainda não correu. Corre t3sm start.\n");
});

test("a watcher that stops at start-up (startup-error, socket-dir-unsafe in sync.log, newer than the heartbeat) needs you, not All good", async () => {
  const logLine = (s: ReturnType<typeof setup>, line: string): void => {
    mkdirSync(join(s.state, "logs"), { recursive: true });
    writeFileSync(join(s.state, "logs", "sync.log"), `${ago(2 * HOUR)} noop run=- imported=0\n${line}\n`);
  };
  // A clean stop (an update, schedule restart), then every start of the next watcher fails.
  const s = setup();
  s.status({ ...LIVE, lastCycleAt: ago(3 * HOUR), stoppedAt: ago(3 * HOUR) });
  logLine(s, `${ago(40 * MIN)} startup-error exit=1 Error`);
  const r = await report(s);
  assert.equal(r.code, 10);
  const it = r.j.items.find((i) => i.key === "watcher-cannot-start")!;
  assert.equal(it.level, "needs-you");
  assert.match(it.text, /cannot start: its last try \(40 min ago\) stopped at start-up \(Error\)/);
  assert.equal(it.command, "t3sm doctor");
  // No heartbeat at all (the first watcher never started), and an unsafe socket directory.
  const u = setup();
  logLine(u, `${ago(5 * MIN)} socket-dir-unsafe /tmp/t3sm-1000-0123456789abcdef`);
  assert.match((await report(u)).j.items.find((i) => i.key === "watcher-cannot-start")!.text, /socket directory is not safe/);
  // Older than what the heartbeat records (a watcher started fine since): nothing.
  const ok = setup();
  ok.status(LIVE);
  logLine(ok, `${ago(2 * HOUR)} startup-error exit=1 Error`);
  const o = await report(ok);
  assert.equal(o.j.level, "ok");
  assert.equal(o.j.items.some((i) => i.key === "watcher-cannot-start"), false);
});

test("a config.json that cannot be used is a need of its own, named, with t3sm doctor (not swallowed)", async () => {
  const s = setup();
  writeFileSync(join(s.state, "config.json"), "{not json");
  s.status({ ...LIVE, stoppedAt: ago(HOUR) });
  mkdirSync(join(s.state, "logs"), { recursive: true });
  writeFileSync(join(s.state, "logs", "sync.log"), `${ago(10 * MIN)} startup-error exit=2 ConfigError\n`);
  const r = await report(s);
  assert.equal(r.code, 10);
  const it = r.j.items.find((i) => i.key === "config-error")!;
  assert.equal(it.level, "needs-you");
  assert.match(it.text, /config\.json cannot be used, so sync and the background watcher stop at start-up: /);
  assert.equal(it.command, "t3sm doctor");
  assert.equal(r.j.items.some((i) => i.key === "watcher-cannot-start"), false, "one need for one cause");
  assert.doesNotMatch(JSON.stringify(r.j), new RegExp(s.home.replace(/[\^$.*+?()[\]{}|]/g, "\$&").replace(/\\/g, "[\\/]+"), "i"), "the home folder is shown as ~");
});

test("a gone watcher's item says how a hand-started one comes back", async () => {
  const s = setup();
  s.status(LIVE);
  const it = (await report(s, { pidAlive: (p) => p !== 7 })).j.items.find((i) => i.key === "watcher-not-running")!;
  assert.match(it.text, /one you started by hand comes back with t3sm sync --watch/);
  assert.equal(it.command, "t3sm schedule restart");
});
