import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "../../src/cli/main.ts";
import { updateCommand, type UpdateDeps } from "../../src/cli/commands/update.ts";
import { changelogCommand } from "../../src/cli/commands/changelog.ts";
import { installKind, isRegistryInstall, npmEnv, releaseSpec } from "../../src/ops/update.ts";
import { readUpdateState, writeUpdateState, type UpdateSource, type WatcherOps } from "../../src/ops/updater.ts";
import { dailyUpdateCheck } from "../../src/ops/autoUpdate.ts";
import { readSyncStatus } from "../../src/ops/syncStatus.ts";
import { acquireLock } from "../../src/core/lock.ts";
import { defaultConfig, loadConfig, saveConfig } from "../../src/core/config.ts";
import { resolveAccounts } from "../../src/ops/discoverAccounts.ts";
import { watcherUpdateCheck } from "../../src/ops/autoUpdate.ts";
import type { SpawnLike } from "../../src/ops/successor.ts";
import type { CommandRunner, RunResult } from "../../src/core/run.ts";
import type { Clock } from "../../src/ops/watch.ts";

function fakeIo(o: { tty?: boolean; answer?: string; env?: NodeJS.ProcessEnv } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const io: Io = {
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
    isTTY: o.tty ?? false,
    prompt: async (q) => { asked.push(q); return o.answer ?? ""; },
    // English pinned: the OS locale must not leak into the tests.
    env: { LANG: "en_US.UTF-8", ...(o.env ?? {}) },
  };
  return { io, out: () => out.join(""), err: () => err.join(""), asked };
}

const SPEC = "github:brunobola-portfolio/t3code-session-manager#semver:*";
const REPO_URL = "https://github.com/demo-owner/demo-app.git";
const GH: UpdateSource = { kind: "github", repo: "demo-owner/demo-app" };
const FOLDER = "D:\\code\\t3sm";
const GLOBAL_ROOT = "C:/Users/demo/AppData/Roaming/npm/node_modules/t3code-session-manager";
const T0 = Date.UTC(2026, 10, 15, 10, 0, 0);

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (code = 128, stderr = "fatal: unable to access"): RunResult => ({ code, stdout: "", stderr });

/** A CHANGELOG with one section per version (newest first), as Keep a Changelog writes it. */
function changelog(versions: string[]): string {
  return ["# Changelog", "", "## [Unreleased]", "", "- Not released yet.", "",
    ...versions.flatMap((v) => [`## [${v}] - 2026-11-15`, "", `- Notes for ${v}.`, ""])].join("\n");
}

function stepClock(): Clock {
  const c = { t: T0, now: () => c.t, setTimer(fn: () => void, ms: number) { c.t += ms; queueMicrotask(fn); return 1; }, clearTimer() {} };
  return c;
}

/**
 * A global install whose version npm changes: GitHub answers `tags` (null: offline), the folder FOLDER has `tags` too and
 * shows `changelog(...)` for any tag; no watcher runs (restart returns false: no health wait).
 */
async function harness(t: { after: (fn: () => Promise<void>) => void }, o: { installed?: string; tags?: string[] | null; root?: string; npmCode?: number; registry?: string[] | null; fromRegistry?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), "t3sm-update-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const state = join(base, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(base, ".claude", "projects"), { recursive: true }); // one Claude account, for a config.json
  const st = { installed: o.installed ?? "0.3.0", branch: "" };
  const tags = o.tags === undefined ? ["v0.2.1", "v0.3.0", "v0.3.1"] : o.tags;
  const calls: { cmd: string; args: string[] }[] = [];
  const run: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "git" && args[0] === "ls-remote") return tags === null ? fail() : ok(tags.map((v, i) => `${String(i).repeat(40)}\trefs/tags/${v}`).join("\n"));
    if (cmd === "npm" && args[0] === "view") return o.registry ? ok(JSON.stringify(o.registry)) : fail(1, "npm error code E404");
    if (cmd === "git" && args[0] === "-C" && args[2] === "tag") return tags === null ? fail() : ok(tags.join("\n"));
    if (cmd === "git" && args[0] === "-C" && args[2] === "show") {
      const v = /^v(.+):CHANGELOG\.md$/.exec(args[3] ?? "")?.[1];
      return v ? ok(changelog((tags ?? []).map((x) => x.slice(1)).filter((x) => x <= v).reverse())) : fail();
    }
    if (cmd === "git" && args.includes("clone")) { st.branch = args[args.indexOf("--branch") + 1]!; return ok(); }
    if (cmd === "npm" && args[0] === "install") {
      if ((o.npmCode ?? 0) !== 0) return fail(o.npmCode, "npm ERR! boom");
      const spec = args.at(-1)!;
      st.installed = spec === "." ? st.branch.slice(1) : (/#v(.+)$/.exec(spec) ?? /@(\d[^@]*)$/.exec(spec))![1]!;
      return ok();
    }
    return fail(127, "not found");
  };
  const watcher: WatcherOps = { stop: async () => ({ how: "none", pid: null, running: false }), restart: async () => false };
  const deps: UpdateDeps = {
    root: o.root ?? GLOBAL_ROOT,
    home: base,
    platform: "win32",
    readVersion: () => st.installed,
    run,
    watcher,
    clock: stepClock(),
    repositoryUrl: REPO_URL,
    packageName: "demo-app",
    fromRegistry: o.fromRegistry ?? false,
    readChangelog: () => changelog(["0.3.1", "0.3.0", "0.2.1"].filter((v) => v <= st.installed)),
    tmp: { make: async () => mkdtempSync(join(base, "clone-")), remove: (p) => rm(p, { recursive: true, force: true }) },
  };
  const npmInstalls = (): string[] => calls.filter((c) => c.cmd === "npm" && c.args[0] === "install").map((c) => c.args.at(-1)!);
  const seedConfig = async (): Promise<void> => saveConfig(state, defaultConfig(await resolveAccounts(base, [], {})), base);
  return { deps, st, calls, npmInstalls, state, seedConfig, env: { T3SM_HOME: state } as NodeJS.ProcessEnv };
}

test("installKind: a checkout, a global npm install and the npx cache", () => {
  assert.equal(installKind("C:/work/t3code-session-manager"), "checkout");
  assert.equal(installKind("/home/demo/code/t3code-session-manager"), "checkout");
  assert.equal(installKind("C:\\Users\\demo\\AppData\\Roaming\\npm\\node_modules\\t3code-session-manager"), "global");
  assert.equal(installKind("/usr/local/lib/node_modules/t3code-session-manager"), "global");
  assert.equal(installKind("C:\\Users\\demo\\AppData\\Local\\npm-cache\\_npx\\1a2b3c\\node_modules\\t3code-session-manager"), "npx");
  assert.equal(installKind("/home/demo/.npm/_npx/1a2b3c/node_modules/t3code-session-manager"), "npx");
});

test("releaseSpec: the newest release tag of the repository in package.json", () => {
  assert.equal(releaseSpec("https://github.com/brunobola-portfolio/t3code-session-manager.git"), SPEC);
  assert.equal(releaseSpec("git+https://github.com/brunobola-portfolio/t3code-session-manager"), SPEC);
  assert.throws(() => releaseSpec("https://example.com/x.git"));
});

test("npmEnv: npm never inherits CLAUDE_CONFIG_DIR", () => {
  const env = npmEnv({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/home/demo/.claude-work", claude_config_dir: "x" });
  assert.deepEqual(env, { PATH: "/bin" });
});

// ---------- --check ----------

test("update --check prints installed, latest and kind", async (t) => {
  const h = await harness(t);
  // Read-only: it works while another run holds the lock, and installs nothing.
  const lock = await acquireLock(h.state);
  assert.ok(lock);
  t.after(() => lock.release());
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--check"], f.io, h.deps), 0);
  assert.match(f.out(), /Installed\s+0\.3\.0/);
  assert.match(f.out(), /Latest\s+0\.3\.1 \(patch\)/);
  assert.match(f.out(), /Source\s+GitHub demo-owner\/demo-app/);
  assert.match(f.out(), /Automatic updates\s+on/);
  assert.match(f.out(), /Last check\s+never/);
  assert.deepEqual(h.npmInstalls(), []);
  assert.equal(await readUpdateState(h.state), null, "nothing written");

  // A major, the remembered source and the last check, from update.json.
  const g = await harness(t, { tags: ["v0.3.0", "v1.0.0"] });
  await writeUpdateState(g.state, { source: { kind: "folder", path: FOLDER }, lastCheckAt: new Date(T0 - 3600_000).toISOString(), previous: null, available: "1.0.0", skip: [] });
  const m = fakeIo({ env: g.env });
  assert.equal(await updateCommand(["--check"], m.io, g.deps), 0);
  assert.match(m.out(), /Latest\s+1\.0\.0 \(major/);
  assert.match(m.out(), /Source\s+the folder D:\\code\\t3sm/);
  assert.match(m.out(), /Last check\s+Nov 15, \d\d:\d\d \(/);
  assert.doesNotMatch(m.out(), /UTC|2026-11-15/, "a local date, never raw ISO");

  // Up to date: kind none.
  const n = await harness(t, { installed: "0.3.1" });
  const u = fakeIo({ env: n.env });
  assert.equal(await updateCommand(["--check"], u.io, n.deps), 0);
  assert.match(u.out(), /Latest\s+0\.3\.1 \(none/);
});

test("update --check offline says so and exits 0", async (t) => {
  const h = await harness(t, { tags: null });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--check"], f.io, h.deps), 0);
  assert.match(f.out(), /Latest\s+could not be checked/);
});

test("update --check shows an interrupted update and how to go back", async (t) => {
  const h = await harness(t);
  writeFileSync(join(h.state, "update.pending.json"), JSON.stringify({
    runId: "20261115-090000-abcd", previous: { version: "0.3.0", spec: "github:demo-owner/demo-app#v0.3.0" }, source: GH, target: "0.3.1",
    startedAt: "2026-11-15T09:00:00.000Z", interrupted: true,
  }));
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--check"], f.io, h.deps), 0);
  assert.match(f.out(), /update to 0\.3\.1 .*interrupted/i);
  assert.match(f.out(), /npm install -g --install-links github:demo-owner\/demo-app#v0\.3\.0/);
});

// ---------- updating ----------

test("update shows what is new and asks", async (t) => {
  const h = await harness(t);
  await writeUpdateState(h.state, { source: { kind: "folder", path: FOLDER }, lastCheckAt: null, previous: null, available: null, skip: [] });
  const f = fakeIo({ tty: true, answer: "", env: h.env });
  assert.equal(await updateCommand([], f.io, h.deps), 0);
  assert.match(f.out(), /0\.3\.0 -> 0\.3\.1 \(patch\)/);
  assert.match(f.out().replace(/\x1b\[[0-9;]*m/g, ""), /^\[0\.3\.1\] - 2026-11-15$/m);
  assert.match(f.out(), /Notes for 0\.3\.1\./);
  assert.doesNotMatch(f.out(), /Notes for 0\.3\.0\./, "only what is newer than the installed version");
  assert.equal(f.asked.length, 1);
  assert.match(f.out(), /Nothing changed/);
  assert.deepEqual(h.npmInstalls(), []);
  const show = h.calls.find((c) => c.args[2] === "show");
  assert.deepEqual(show?.args, ["-C", FOLDER, "show", "v0.3.1:CHANGELOG.md"]);
});

test("update off a terminal without --yes refuses (exit 2) and installs nothing", async (t) => {
  const h = await harness(t);
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand([], f.io, h.deps), 2);
  assert.deepEqual(h.calls, [], "refused before any release lookup");
  assert.match(f.err(), /--yes/);
});

test("update --dry-run shows what would be installed and installs nothing", async (t) => {
  const h = await harness(t);
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--dry-run"], f.io, h.deps), 0);
  assert.match(f.out(), /Would install t3sm 0\.3\.1 from GitHub demo-owner\/demo-app/);
  assert.deepEqual(h.npmInstalls(), []);
  assert.equal(await readUpdateState(h.state), null);
});

test("update --yes from GitHub: installs, then shows what is new from the installed CHANGELOG", async (t) => {
  const h = await harness(t);
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--yes"], f.io, h.deps), 0);
  // No update.json yet: the default source is package.json's GitHub repository (defaultSource).
  assert.deepEqual(h.npmInstalls(), ["github:demo-owner/demo-app#v0.3.1"]);
  assert.match(f.out(), /shown after the update/);
  assert.match(f.out(), /Updated t3sm 0\.3\.0 -> 0\.3\.1/);
  assert.match(f.out(), /Notes for 0\.3\.1\./);
  assert.doesNotMatch(f.out(), /Notes for 0\.3\.0\./);
  assert.deepEqual((await readUpdateState(h.state))?.source, GH);
});

test("update when already on the newest release says so and installs nothing", async (t) => {
  const h = await harness(t, { installed: "0.3.1" });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--yes"], f.io, h.deps), 0);
  assert.match(f.out(), /newest release/);
  assert.deepEqual(h.npmInstalls(), []);
});

test("--from remembers the folder source", async (t) => {
  const h = await harness(t);
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--from", FOLDER, "--yes"], f.io, h.deps), 0);
  assert.equal(h.st.installed, "0.3.1");
  assert.deepEqual(h.npmInstalls(), ["."]);
  assert.deepEqual((await readUpdateState(h.state))?.source, { kind: "folder", path: FOLDER });
  assert.match(f.out(), /Notes for 0\.3\.1\./, "the folder's CHANGELOG is shown before installing");

  // Not a local absolute folder: refused before anything runs.
  const g = await harness(t);
  for (const bad of ["code\\t3sm", "\\\\server\\share\\t3sm"]) {
    const e = fakeIo({ env: g.env });
    assert.equal(await updateCommand(["--from", bad, "--yes"], e.io, g.deps), 2);
    assert.match(e.err(), /local absolute path/);
  }
  assert.deepEqual(g.calls, []);
});

test("--source github switches", async (t) => {
  const h = await harness(t);
  await writeUpdateState(h.state, { source: { kind: "folder", path: FOLDER }, lastCheckAt: null, previous: null, available: null, skip: [] });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--source", "github", "--yes"], f.io, h.deps), 0);
  assert.deepEqual(h.npmInstalls(), ["github:demo-owner/demo-app#v0.3.1"]);
  assert.deepEqual((await readUpdateState(h.state))?.source, GH);
  const g = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--source", "gitlab"], g.io, h.deps), 2);
  assert.equal(await updateCommand(["--source", "github", "--from", FOLDER], g.io, h.deps), 2);
});

test("a manual update installs a major release only when confirmed", async (t) => {
  const h = await harness(t, { tags: ["v0.3.0", "v1.0.0"] });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--yes"], f.io, h.deps), 0);
  assert.match(f.out(), /major/);
  assert.deepEqual(h.npmInstalls(), ["github:demo-owner/demo-app#v1.0.0"]);
});

test("a failed install exits 1, says the old version stays and is reported in status", async (t) => {
  const h = await harness(t, { npmCode: 1 });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--yes"], f.io, h.deps), 1);
  assert.match(f.err(), /still 0\.3\.0/);
  assert.equal((await readSyncStatus(h.state)).needsAttention?.reason, "update-failed");
});

test("update waits for a running t3sm: lock taken -> nothing installed, exit 0", async (t) => {
  const h = await harness(t);
  const lock = await acquireLock(h.state);
  assert.ok(lock);
  t.after(() => lock.release());
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--yes"], f.io, h.deps), 0);
  assert.deepEqual(h.npmInstalls(), []);
  assert.match(f.out(), /Another t3sm run is in progress/);
});

test("update in a checkout explains git and installs nothing", async (t) => {
  const h = await harness(t, { root: "C:/work/t3code-session-manager" });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--yes"], f.io, h.deps), 0);
  assert.deepEqual(h.calls, []);
  assert.match(f.out(), /git checkout/);
  assert.match(f.out(), /git -C "C:\/work\/t3code-session-manager" pull/);
});

test("update from the npx cache explains how to install once and installs nothing", async (t) => {
  const h = await harness(t, { root: "/home/demo/.npm/_npx/1a2b3c/node_modules/t3code-session-manager" });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand([], f.io, h.deps), 0);
  assert.deepEqual(h.calls, []);
  assert.match(f.out(), /npm install -g demo-app/);
});

test("update rejects unknown options and --yes with --dry-run", async (t) => {
  const h = await harness(t);
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--force"], f.io, h.deps), 2);
  assert.equal(await updateCommand(["--yes", "--dry-run"], f.io, h.deps), 2);
  assert.equal(await updateCommand(["--check", "--yes"], f.io, h.deps), 2);
  assert.equal(await updateCommand(["--auto", "maybe"], f.io, h.deps), 2);
  assert.deepEqual(h.npmInstalls(), []);
});

// ---------- --auto, --auto-run, the daily check ----------

test("--auto off stops the daily check", async (t) => {
  const h = await harness(t);
  await h.seedConfig();
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--auto", "off"], f.io, h.deps), 0);
  assert.match(f.out(), /Automatic updates are now off/);
  const config = await loadConfig(h.state, h.deps.home!);
  assert.equal(config?.update?.auto, false);
  let spawned = 0;
  const check = dailyUpdateCheck({
    stateDir: h.state, installed: () => "0.3.0", kind: "global", config: () => loadConfig(h.state, h.deps.home!), defaultSource: GH,
    run: h.deps.run!, platform: "win32", now: () => T0, spawnUpdate: () => void spawned++, log: () => {},
  });
  assert.deepEqual(await check.check(), { kind: "skipped", why: "auto-off" });
  assert.deepEqual(h.calls, [], "no network call");
  assert.equal(spawned, 0);
  // --auto on turns it back on; --dry-run writes nothing.
  const d = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--auto", "on", "--dry-run"], d.io, h.deps), 0);
  assert.equal((await loadConfig(h.state, h.deps.home!))?.update?.auto, false);
  assert.equal(await updateCommand(["--auto", "on", "--yes"], d.io, h.deps), 0, "--yes is accepted (and not needed)");
  assert.equal((await loadConfig(h.state, h.deps.home!))?.update?.auto, true);
  assert.deepEqual(await check.check(), { kind: "checked", latest: "0.3.1", install: "0.3.1", major: null });
  assert.equal(spawned, 1);
});

test("--auto: no config.json yet is refused (nothing created); the lock taken changes nothing", async (t) => {
  const h = await harness(t);
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--auto", "off"], f.io, h.deps), 1);
  assert.match(f.err(), /t3sm start/);
  assert.equal(await loadConfig(h.state, h.deps.home!), null, "no config.json was created");
  await h.seedConfig();
  const lock = await acquireLock(h.state);
  assert.ok(lock);
  t.after(() => lock.release());
  const g = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--auto", "off"], g.io, h.deps), 0);
  assert.match(g.out(), /Another t3sm run is in progress/);
  assert.equal((await loadConfig(h.state, h.deps.home!))?.update?.auto, undefined, "unchanged");
});

test("--auto-run never installs a version that was rolled back; a busy lock asks the watcher to retry within the hour", async (t) => {
  const h = await harness(t);
  await writeUpdateState(h.state, { source: GH, lastCheckAt: new Date(T0).toISOString(), previous: null, available: null, skip: ["0.3.1"] });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--auto-run", "--yes"], f.io, h.deps), 0);
  assert.deepEqual(h.npmInstalls(), []);

  const g = await harness(t);
  await writeUpdateState(g.state, { source: GH, lastCheckAt: new Date(T0).toISOString(), previous: null, available: null, skip: [] });
  const lock = await acquireLock(g.state);
  assert.ok(lock);
  const e = fakeIo({ env: g.env });
  assert.equal(await updateCommand(["--auto-run", "--yes"], e.io, g.deps), 0);
  await lock.release();
  assert.deepEqual(g.npmInstalls(), []);
  assert.match(readFileSync(join(g.state, "logs", "sync.log"), "utf8"), / update busy to=0\.3\.1$/m);
  // The daily check (lastCheckAt just now) runs again an hour later instead of a day later.
  let spawned = 0;
  let now = T0 + 30 * 60_000;
  const check = dailyUpdateCheck({
    stateDir: g.state, installed: () => "0.3.0", kind: "global", config: async () => null, defaultSource: GH,
    run: g.deps.run!, platform: "win32", now: () => now, spawnUpdate: () => void spawned++, log: () => {},
  });
  assert.deepEqual(await check.check(), { kind: "skipped", why: "not-due" });
  now = T0 + 60 * 60_000;
  assert.equal((await check.check()).kind, "checked");
  assert.equal(spawned, 1);
});

test("watcherUpdateCheck starts `update --auto-run --yes` from the installed bin, without CLAUDE_CONFIG_DIR", async (t) => {
  const h = await harness(t);
  const spawned: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawn: SpawnLike = (cmd, args, opts) => { spawned.push({ cmd, args, env: opts.env }); return { unref() {} }; };
  const check = watcherUpdateCheck({
    stateDir: h.state, home: h.deps.home!, env: { PATH: "C:/bin", CLAUDE_CONFIG_DIR: "C:/work/.claude-other", claude_config_dir: "x" }, platform: "win32", now: () => T0,
    run: h.deps.run!, kind: "global", installed: () => "0.3.0", defaultSource: GH, spawn, conhost: null,
  });
  assert.equal((await check()).kind, "checked");
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0]!.args.slice(-3), ["update", "--auto-run", "--yes"]);
  assert.equal(Object.keys(spawned[0]!.env).some((k) => k.toUpperCase() === "CLAUDE_CONFIG_DIR"), false);
  assert.equal(spawned[0]!.env["PATH"], "C:/bin");
});

test("--auto-run installs a patch or minor by itself, never a major", async (t) => {
  const h = await harness(t);
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--auto-run"], f.io, h.deps), 2, "needs --yes");
  assert.equal(await updateCommand(["--auto-run", "--yes"], f.io, h.deps), 0);
  assert.deepEqual(h.npmInstalls(), ["github:demo-owner/demo-app#v0.3.1"]);
  assert.match(readFileSync(join(h.state, "logs", "sync.log"), "utf8"), / update installed from=0\.3\.0 to=0\.3\.1/);

  const g = await harness(t, { tags: ["v0.3.0", "v1.0.0"] });
  const e = fakeIo({ env: g.env });
  assert.equal(await updateCommand(["--auto-run", "--yes"], e.io, g.deps), 0);
  assert.deepEqual(g.npmInstalls(), [], "a major is never installed by itself");
});

test("checkout install never auto-updates", async (t) => {
  const h = await harness(t, { root: "C:/work/t3code-session-manager" });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--auto-run", "--yes"], f.io, h.deps), 0);
  assert.deepEqual(h.calls, []);
  let spawned = 0;
  const check = dailyUpdateCheck({
    stateDir: h.state, installed: () => "0.3.0", kind: "checkout", config: async () => null, defaultSource: GH,
    run: h.deps.run!, platform: "win32", now: () => T0, spawnUpdate: () => void spawned++, log: () => {},
  });
  assert.deepEqual(await check.check(), { kind: "skipped", why: "not-installed" });
  assert.deepEqual(h.calls, []);
  assert.equal(spawned, 0);
});

// ---------- changelog ----------

test("changelog --since 0.2.1 prints 0.3.0 notes", async () => {
  const text = changelog(["0.3.0", "0.2.1", "0.2.0"]);
  const deps = { readVersion: () => "0.3.0", readChangelog: () => text };
  const f = fakeIo();
  assert.equal(await changelogCommand(["--since", "0.2.1"], f.io, deps), 0);
  assert.match(f.out(), /^\[0\.3\.0\] - 2026-11-15$/m);
  assert.match(f.out(), /Notes for 0\.3\.0\./);
  assert.doesNotMatch(f.out(), /0\.2\.1|Unreleased/);
  // Default: the installed version's own section.
  const g = fakeIo();
  assert.equal(await changelogCommand([], g.io, deps), 0);
  assert.match(g.out(), /Notes for 0\.3\.0\./);
  assert.doesNotMatch(g.out(), /0\.2\.1/);
  // Several versions, newest first; a bad version is refused.
  const s = fakeIo();
  assert.equal(await changelogCommand(["--since", "0.2.0"], s.io, deps), 0);
  assert.ok(s.out().indexOf("0.3.0") < s.out().indexOf("0.2.1"));
  assert.equal(await changelogCommand(["--since", "latest"], fakeIo().io, deps), 2);
  // Nothing newer.
  const n = fakeIo();
  assert.equal(await changelogCommand(["--since", "0.3.0"], n.io, deps), 0);
  assert.match(n.out(), /No release notes newer than 0\.3\.0/);
});

test("changelog in Portuguese says first that the notes are in English; in English it does not", async () => {
  const deps = { readVersion: () => "0.3.0", readChangelog: () => changelog(["0.3.0"]) };
  const p = fakeIo();
  assert.equal(await changelogCommand([], { ...p.io, lang: "pt" }, deps), 0);
  assert.match(p.out(), /^As notas das versões estão em inglês\.\n/);
  const e = fakeIo();
  assert.equal(await changelogCommand([], e.io, deps), 0);
  assert.doesNotMatch(e.out(), /written in English/);
});

test("t3sm update --help, changelog --help and the main usage list the commands", async () => {
  const f = fakeIo();
  assert.equal(await main(["update", "--help"], f.io), 0);
  assert.match(f.out(), /Usage: t3sm update/);
  assert.match(f.out(), /--check/);
  assert.match(f.out(), /--from <folder>/);
  assert.match(f.out(), /--auto on\|off/);
  const c = fakeIo();
  assert.equal(await main(["changelog", "--help"], c.io), 0);
  assert.match(c.out(), /Usage: t3sm changelog \[--since <version>\]/);
  const g = fakeIo();
  assert.equal(await main(["--help"], g.io), 0);
  assert.match(g.out(), /t3sm update/);
  assert.match(g.out(), /t3sm changelog/);
  // The real command reads this package's own CHANGELOG.md.
  // main reads config.json "language" of the state folder: point it at a folder that does not exist (never the real one).
  const r = fakeIo({ env: { T3SM_HOME: join(tmpdir(), "t3sm-update-no-state-x9"), LANG: "en_US.UTF-8" } });
  assert.equal(await main(["changelog", "--since", "0.2.0"], r.io), 0);
  assert.match(r.out(), /^\[0\.2\.1\]/m);
});

test("update --check in Portuguese: the last update's outcome in words, labels and values agree (Task 22)", async () => {
  const { renderUpdateCheck } = await import("../../src/cli/commands/update.ts");
  const { makeCliUi } = await import("../../src/cli/ui.ts");
  const view = {
    installed: "0.3.0", kind: "global" as const, root: "C:/npm/t3sm", latest: "0.3.0", skipped: false, auto: null,
    source: { kind: "github" as const, repo: "demo-owner/demo-app" }, automatic: true, lastCheckAt: null,
    lastUpdate: { from: "0.2.1", to: "0.3.0", outcome: "rolled-back" }, pending: null,
  };
  const pt = renderUpdateCheck(makeCliUi({ color: 0, unicode: true, isTTY: false, columns: 100 }, "pt"), view).join("\n");
  assert.match(pt, /^Versão instalada +0\.3\.0 \(instalada com o npm\)$/m);
  assert.match(pt, /0\.2\.1 -> 0\.3\.0, voltou atrás$/m);
  assert.doesNotMatch(pt, /rolled-back|installed with/);
  const en = renderUpdateCheck(makeCliUi({ color: 0, unicode: true, isTTY: false, columns: 100 }, "en"), view).join("\n");
  assert.match(en, /0\.2\.1 -> 0\.3\.0, rolled back$/m);
});

test("update --yes whose watcher could not be restarted: installed (exit 0), and says how to restart it, in English and Portuguese", async (t) => {
  for (const [lang, words] of [["en", ["did not restart into it (the running watcher (pid 4242) did not stop; 0.3.1 is installed", "t3sm schedule restart"]], ["pt", ["não reiniciou com esta versão", "t3sm schedule restart"]]] as const) {
    const h = await harness(t);
    h.deps.watcher = { stop: async () => ({ how: "pid", pid: 4242, running: true }), restart: async () => true };
    h.deps.readHeartbeat = async () => null;
    const f = fakeIo({ env: h.env });
    if (lang === "pt") f.io.lang = "pt";
    assert.equal(await updateCommand(["--yes"], f.io, h.deps), 0, lang);
    assert.deepEqual(h.npmInstalls(), ["github:demo-owner/demo-app#v0.3.1"], "never rolled back");
    const out = f.out().replace(/\s+/g, " ");
    for (const w of words) assert.ok(out.includes(w), `${lang}: ${w}`);
  }
});

// ---------- the npm registry ----------

const NPM_SRC: UpdateSource = { kind: "npm", name: "demo-app" };

test("isRegistryInstall: the package the Release workflow published to npm says so in dist/build.json", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "t3sm-origin-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "node_modules", "demo-app");
  mkdirSync(join(root, "dist"), { recursive: true });
  const stamp = (o: object | string): void => writeFileSync(join(root, "dist", "build.json"), typeof o === "string" ? o : JSON.stringify(o));
  assert.equal(isRegistryInstall(root), false, "no build.json: not known to come from the registry");
  stamp({ version: "0.4.0", builtAt: "2026-11-20T10:00:00.000Z", channel: "npm" });
  assert.equal(isRegistryInstall(root), true);
  stamp({ version: "0.4.0", builtAt: "2026-11-20T10:00:00.000Z" });
  assert.equal(isRegistryInstall(root), false, "built by npm from a GitHub tag: no channel");
  stamp("{ not json");
  assert.equal(isRegistryInstall(root), false);
});

test("update --yes from the npm registry: the default source of a registry install, its versions, then what is new", async (t) => {
  const h = await harness(t, { fromRegistry: true, registry: ["0.2.1", "0.3.0", "0.3.1", "0.4.0-rc.1"] });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--yes"], f.io, h.deps), 0);
  assert.deepEqual(h.calls.filter((c) => c.cmd === "npm" && c.args[0] === "view").map((c) => c.args), [["view", "demo-app", "versions", "--json"]]);
  assert.deepEqual(h.npmInstalls(), ["demo-app@0.3.1"]);
  assert.match(f.out(), /npm demo-app/);
  assert.match(f.out(), /Notes for 0\.3\.1\./);
  assert.deepEqual((await readUpdateState(h.state))?.source, NPM_SRC);
});

test("--source npm moves a GitHub install to the npm registry; --check names the source", async (t) => {
  const h = await harness(t, { registry: ["0.3.0", "0.3.1"] });
  await writeUpdateState(h.state, { source: GH, lastCheckAt: null, previous: null, available: null, skip: [] });
  const f = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--source", "npm", "--yes"], f.io, h.deps), 0);
  assert.deepEqual(h.npmInstalls(), ["demo-app@0.3.1"]);
  assert.deepEqual((await readUpdateState(h.state))?.source, NPM_SRC);
  const c = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--check"], c.io, h.deps), 0);
  assert.match(c.out(), /npm demo-app/);
  const bad = fakeIo({ env: h.env });
  assert.equal(await updateCommand(["--source", "npmjs"], bad.io, h.deps), 2);
  assert.match(bad.err(), /--source takes npm or github/);
});
