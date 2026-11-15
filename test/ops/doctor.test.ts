import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { runDoctor, pendingMtimePaths, maskEmail, defaultDoctorDeps, type DoctorDeps, type Check } from "../../src/ops/doctor.ts";
import { doctorCommand } from "../../src/cli/commands/doctor.ts";
import { defaultConfig } from "../../src/core/config.ts";
import type { Io } from "../../src/cli/main.ts";
import type { Config, JournalEntry } from "../../src/core/types.ts";
import type { ProviderInstanceInfo, T3Api } from "../../src/t3/api.ts";
import { OPENCODE_1_19_DDL, buildOpenCodeDb } from "../fixtures/opencode/build.ts";
import { TESTED_VERSIONS } from "../../src/t3/compat.ts";

const HOME = "C:/Users/demo";
const CFG: Config = defaultConfig([
  { id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null },
  { id: "claude-org", home: "~/.claude-org", displayName: "Org", accentColor: null },
]);

function inst(id: string, home: string | null, extra: Partial<ProviderInstanceInfo> = {}): ProviderInstanceInfo {
  return { instanceId: id, driver: "claudeAgent", homePath: home, displayName: id, accentColor: null, email: null, authStatus: "authenticated", enabled: true, availability: "available", ...extra };
}

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const DAY_MS = 86_400_000;

function fakeDeps(over: Partial<DoctorDeps> & { instances?: ProviderInstanceInfo[]; explicit?: Record<string, unknown> } = {}) {
  const calls: string[] = [];
  const instances = over.instances ?? [
    inst("claudeAgent", "C:\\Users\\demo\\.claude", { email: "alice@example.com" }),
    inst("claude-org", "C:/Users/demo/.claude-org", { email: "bob@corp.example" }),
    { ...inst("codex", null), driver: "codex" },
  ];
  const api = {
    version: "0.1.9-nightly.20261110.4465",
    providerInstances: async () => { calls.push("providerInstances"); return instances.map((i) => ({ ...i })); },
    getConfig: async () => ({ settings: { providerInstances: over.explicit ?? { claudeAgent: { driver: "claudeAgent", config: { homePath: "C:\Users\demo\.claude" } } } }, providers: [] }),
    close: async () => { calls.push("close"); },
  } as unknown as T3Api;
  const deps: DoctorDeps = {
    home: HOME, platform: "win32", env: {}, stateDir: `${HOME}/.t3code-session-manager`, nodeVersion: "22.18.0", now: () => NOW, repair: false, hostname: "h",
    loadConfig: async () => CFG,
    detectAccounts: async () => CFG.accounts,
    stateWritable: async () => null,
    lockInfo: async () => null,
    pidAlive: () => true,
    uptime: () => 30 * 86400,
    readJournal: async () => [],
    repairMtimes: async () => { calls.push("repair"); return { restored: [], missing: [], failed: [], skippedModified: [], malformed: 0 }; },
    readRuntime: async () => ({ origin: "http://127.0.0.1:3773", port: 3773, serverVersion: "0.1.9-nightly.20261110.4465", pid: 42 }),
    probe: async () => true,
    resolveCli: () => `${HOME}/.t3/bin/t3.cmd`,
    connect: async () => { calls.push("connect"); return api; },
    discover: async () => [
      { home: `${HOME}/.claude`, sources: ["default"], alias: null },
      { home: `${HOME}/.claude-org`, sources: ["folder", "shell-profile"], alias: "claude-org" },
    ],
    findBackupDirs: async () => [],
    findOrphanedQuarantine: async () => [],
    harnesses: async () => [{ id: "claude", available: true }, { id: "codex", available: true }, { id: "pi", available: false }],
    findBin: (n) => (n === "claude" ? "C:/bin/claude.exe" : null),
    binVersion: async () => "2.1.0 (Claude Code)",
    scheduleStatus: async () => ({ kind: "schtasks", installed: true, nextRun: "11/11/2026 12:15:00", detail: "Ready" }),
    readHeartbeat: async () => null,
    packageVersion: "0.3.0",
    pluginState: async () => ({ state: "installed", version: "0.3.0" }),
    ...over,
  };
  return { deps, calls, api };
}

const by = (checks: Check[], id: string) => checks.find((c) => c.id === id);

const IDS = ["node-version", "state-dir", "config", "lock", "pending-mtimes", "future-mtimes", "claude-env", "t3-runtime", "t3-reachable", "t3-version", "t3-cli", "t3-token",
  "instances", "instance-home-drift", "instance-unpinned", "instance-accounts", "accounts-undiscovered", "backups-present", "quarantine-orphans",
  "harness:claude", "harness:codex", "harness:pi", "t3sm-plugin", "schedule", "sync-watcher", "merge-pending"];

test("all-fake healthy deps: every check ok, one T3 session, closed at the end", async () => {
  const { deps, calls } = fakeDeps();
  const { checks } = await runDoctor(deps);
  assert.deepEqual(checks.map((c) => c.id), IDS);
  const bad = checks.filter((c) => c.status !== "ok");
  assert.deepEqual(bad, []);
  assert.equal(calls.filter((c) => c === "connect").length, 1);
  assert.equal(calls.at(-1), "close");
  assert.match(by(checks, "harness:claude")!.message, /2\.1\.0/);
  assert.match(by(checks, "instance-accounts")!.message, /a\*\*\*@example\.com/);
  assert.ok(!JSON.stringify(checks).includes("alice@"), "emails masked");
  assert.ok(!JSON.stringify(checks).includes("C:/Users/demo"), "paths ~-relative");
});

test("T3 down: t3-reachable fails with the Start-menu fix, dependent checks skip, no session, doctor completes", async () => {
  const { deps, calls } = fakeDeps({ probe: async () => false });
  const { checks } = await runDoctor(deps);
  assert.deepEqual(checks.map((c) => c.id), IDS);
  assert.equal(by(checks, "t3-reachable")!.status, "fail");
  assert.equal(by(checks, "t3-reachable")!.fix, "Open T3 Code from the Start menu");
  for (const id of ["t3-token", "instances", "instance-home-drift", "instance-accounts"]) assert.equal(by(checks, id)!.status, "skip", id);
  assert.ok(!calls.includes("connect"));
  assert.equal(by(checks, "config")!.status, "ok");
});

test("no server-runtime.json: t3-runtime fails, reachable skips", async () => {
  const { deps } = fakeDeps({ readRuntime: async () => null });
  const { checks } = await runDoctor(deps);
  assert.equal(by(checks, "t3-runtime")!.status, "fail");
  assert.equal(by(checks, "t3-runtime")!.fix, "Open T3 Code from the Start menu");
  assert.equal(by(checks, "t3-reachable")!.status, "skip");
});

test("two instances on one home -> instances: fail; account without instance -> warn", async () => {
  const { deps } = fakeDeps({ instances: [inst("claudeAgent", `${HOME}/.claude`), inst("a", `${HOME}/.claude-org`), inst("b", `${HOME}/.claude-org/`)] });
  const { checks } = await runDoctor(deps);
  assert.equal(by(checks, "instances")!.status, "fail");
  assert.match(by(checks, "instances")!.message, /a and b both read ~\/\.claude-org/);
  const { deps: d2 } = fakeDeps({ instances: [inst("claudeAgent", `${HOME}/.claude`)] });
  const c2 = (await runDoctor(d2)).checks;
  assert.equal(by(c2, "instances")!.status, "warn");
  assert.match(by(c2, "instances")!.fix!, /t3sm accounts --apply/);
});

test("claudeAgent reading another home -> instance-home-drift: fail with restart fix (implicit) or the settings fix (explicit entry)", async () => {
  const instances = [inst("claudeAgent", `${HOME}/.claude-org`), inst("claude-org", `${HOME}/.claude-org`)];
  const c = by((await runDoctor(fakeDeps({ instances, explicit: {} }).deps)).checks, "instance-home-drift")!;
  assert.equal(c.status, "fail");
  assert.match(c.message, /~\/\.claude-org/);
  assert.match(c.fix!, /Start menu/);
  const e = by((await runDoctor(fakeDeps({ instances, explicit: { claudeAgent: { driver: "claudeAgent", config: { homePath: `${HOME}/.claude-org` } } } }).deps)).checks, "instance-home-drift")!;
  assert.equal(e.status, "fail");
  assert.match(e.message, /configured to read ~\/\.claude-org/);
  assert.equal(e.fix, "Change it in T3 Code settings (Providers), or run t3sm accounts --apply");
});

test("instance-accounts: shared email and signed-out instance warn; emails masked", async () => {
  const { deps } = fakeDeps({ instances: [
    inst("claudeAgent", `${HOME}/.claude`, { email: "demo@example.com" }),
    inst("claude-org", `${HOME}/.claude-org`, { email: "Demo@Example.com" }),
    inst("x", `${HOME}/.claude-x`, { authStatus: "unauthenticated" }),
  ] });
  const c = by((await runDoctor(deps)).checks, "instance-accounts")!;
  assert.equal(c.status, "warn");
  assert.match(c.message, /share d\*\*\*@example\.com/i);
  assert.match(c.message, /x is signed out/);
  assert.ok(!c.message.toLowerCase().includes("demo@"));
});

test("pending mtime bump -> pending-mtimes: warn with fix; without --repair nothing is restored", async () => {
  const entries: JournalEntry[] = [
    { t: "mtime-bump", runId: "r1", files: [{ path: "C:/x/a.jsonl", atimeMs: 1, mtimeMs: 2, targetMtimeMs: 3 }, { path: "C:/x/b.jsonl", atimeMs: 1, mtimeMs: 2, targetMtimeMs: 3 }] },
    { t: "mtime-restore", runId: "r1", paths: ["c:\\x\\b.jsonl"] },
  ];
  assert.deepEqual(pendingMtimePaths(entries, "win32"), ["C:/x/a.jsonl"]);
  const { deps, calls } = fakeDeps({ readJournal: async () => entries });
  const c = by((await runDoctor(deps)).checks, "pending-mtimes")!;
  assert.equal(c.status, "warn");
  assert.equal(c.fix, "Run any t3sm command that writes, or t3sm doctor --repair");
  assert.ok(!calls.includes("repair"));
});

test("--repair runs recoverPendingMtimes (via repairMtimes) and reports it; lock held -> warn", async () => {
  const entries: JournalEntry[] = [{ t: "mtime-bump", runId: "r1", files: [{ path: "C:/x/a.jsonl", atimeMs: 1, mtimeMs: 2, targetMtimeMs: 3 }] }];
  const { deps, calls } = fakeDeps({ repair: true, readJournal: async () => entries,
    repairMtimes: async () => { calls.push("repair"); return { restored: ["C:/x/a.jsonl"], missing: [], failed: [], skippedModified: [], malformed: 0 }; } });
  const c = by((await runDoctor(deps)).checks, "pending-mtimes")!;
  assert.ok(calls.includes("repair"));
  assert.equal(c.status, "ok");
  assert.match(c.message, /restored 1/);
  const { deps: d2 } = fakeDeps({ repair: true, readJournal: async () => entries, repairMtimes: async () => null });
  assert.equal(by((await runDoctor(d2)).checks, "pending-mtimes")!.status, "warn");
});

test("a throwing or hanging non-critical check is a warn (never a false FAIL); the others continue", async () => {
  const { deps } = fakeDeps({ lockInfo: async () => { throw new Error("boom"); }, findBackupDirs: () => new Promise(() => {}), timeoutMs: 50 });
  const { checks } = await runDoctor(deps);
  assert.deepEqual(checks.map((c) => c.id), IDS);
  assert.deepEqual([by(checks, "lock")!.status, by(checks, "lock")!.message], ["warn", "boom"]);
  assert.equal(by(checks, "backups-present")!.status, "warn");
  assert.match(by(checks, "backups-present")!.message, /did not finish within 0\.05 s/);
  assert.equal(by(checks, "quarantine-orphans")!.status, "ok");
  assert.ok(!checks.some((c) => c.status === "fail"));
});

test("every non-critical check that hangs on a large home times out into a warn; critical ones still FAIL", async () => {
  const hang = () => new Promise<never>(() => {});
  const { deps } = fakeDeps({
    timeoutMs: 40,
    checkTimeoutsMs: { "future-mtimes": 40, harnesses: 40 },
    findBackupDirs: hang, findOrphanedQuarantine: hang, discover: hang, mergePending: hang, scheduleStatus: hang,
    readHeartbeat: hang, readJournal: hang, futureMtimes: hang,
  });
  deps.harnesses = async () => [{ id: "claude", available: true }];
  deps.binVersion = hang;
  const { checks } = await runDoctor(deps);
  for (const id of ["backups-present", "quarantine-orphans", "accounts-undiscovered", "merge-pending", "schedule", "sync-watcher", "pending-mtimes", "future-mtimes", "harness:claude"]) {
    assert.equal(by(checks, id)?.status, "warn", id);
  }
  assert.ok(!checks.some((c) => c.status === "fail"), JSON.stringify(checks.filter((c) => c.status === "fail")));
  const h = fakeDeps({ timeoutMs: 40, checkTimeoutsMs: { harnesses: 40 }, harnesses: hang });
  const hc = (await runDoctor(h.deps)).checks;
  assert.equal(by(hc, "harnesses")?.status, "warn");
  const crit = fakeDeps({ timeoutMs: 40, stateWritable: hang, probe: hang });
  const cc = (await runDoctor(crit.deps)).checks;
  assert.equal(by(cc, "state-dir")!.status, "fail");
  assert.equal(by(cc, "t3-reachable")!.status, "fail");
});

test("future-mtimes: its own budget (default 45 s); a slow walker degrades to a warn with the count so far and is stopped", async () => {
  const { CHECK_TIMEOUTS_MS } = await import("../../src/ops/doctor.ts");
  assert.equal(CHECK_TIMEOUTS_MS["future-mtimes"], 45_000);
  let stopped = false;
  // The first 4 files arrive through microtasks only and the walk then waits on a gate, so how many files were checked
  // when the 60 ms budget fires does not depend on timer resolution or machine load (it used to count on three
  // setTimeout(0) hops fitting in 60 ms).
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  async function* slow() {
    try {
      for (let i = 0; ; i++) {
        yield { path: `C:/Users/demo/.claude/projects/p/${i}.jsonl`, mtimeMs: NOW - DAY_MS };
        if (i < 3) await Promise.resolve();
        else await gate;
      }
    } finally { stopped = true; }
  }
  const { deps } = fakeDeps({ checkTimeoutsMs: { "future-mtimes": 60 }, futureMtimes: () => slow() });
  const c = by((await runDoctor(deps)).checks, "future-mtimes")!;
  assert.equal(c.status, "warn");
  assert.equal(c.message, "could not finish checking file times in 0.06 s (4 files checked, none in the future so far)");
  assert.equal(stopped, false, "still waiting on the gate");
  release(); // the walk resumes, hands the consumer one more file, which sees the stop flag and ends it
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, true, "the walk is stopped, not left running");
});

test("future-mtimes: a walker slower than the default per-check budget still finishes inside its own; one found before the budget is named", async () => {
  async function* walk(n: number, delay: number, future: number) {
    for (let i = 0; i < n; i++) {
      await new Promise((r) => setTimeout(r, delay));
      yield { path: `C:/Users/demo/.claude/projects/p/${i}.jsonl`, mtimeMs: i === future ? NOW + DAY_MS : NOW - DAY_MS };
    }
  }
  const ok = by((await runDoctor(fakeDeps({ timeoutMs: 30, checkTimeoutsMs: { "future-mtimes": 5000 }, futureMtimes: () => walk(5, 20, -1) }).deps)).checks, "future-mtimes")!;
  assert.deepEqual([ok.status, ok.message], ["ok", "no transcript has a file time in the future (5 files checked)"]);
  // Two files through microtasks only (no timer racing the 50 ms budget), then a walk that never ends.
  async function* thenHang() {
    for (let i = 0; i < 2; i++) {
      await Promise.resolve();
      yield { path: `C:/Users/demo/.claude/projects/p/${i}.jsonl`, mtimeMs: i === 1 ? NOW + DAY_MS : NOW - DAY_MS };
    }
    await new Promise(() => {});
  }
  const part = by((await runDoctor(fakeDeps({ checkTimeoutsMs: { "future-mtimes": 50 }, futureMtimes: () => thenHang() }).deps)).checks, "future-mtimes")!;
  assert.equal(part.status, "warn");
  assert.match(part.message, /^could not finish checking file times in 0\.05 s \(2 files checked; 1 transcript in the future so far: ~\/\.claude\/projects\/p\/1\.jsonl\)/);
});

test("connect timing out still closes the late session", async () => {
  const { deps, calls, api } = fakeDeps({ timeoutMs: 30 });
  deps.connect = () => new Promise((r) => setTimeout(() => { calls.push("connect"); r(api); }, 80));
  const { checks } = await runDoctor(deps);
  assert.equal(by(checks, "t3-token")!.status, "fail");
  assert.ok(!calls.includes("close"), "doctor does not wait for the late connect");
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(calls.includes("close"), "late session revoked when it arrives");
});

/** Resolves with "done" when p settles within ms, else "hung". */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => "done"), new Promise((r) => setTimeout(() => r("hung"), ms))]);

test("I1: a connect that never settles does not hang doctor (bounded by the per-check timeout)", async () => {
  const { deps } = fakeDeps({ timeoutMs: 50, connect: () => new Promise(() => {}) });
  const p = runDoctor(deps);
  assert.equal(await within(p, 2000), "done");
  const { checks } = await p;
  assert.equal(by(checks, "t3-token")!.status, "fail");
  assert.match(by(checks, "t3-token")!.message, /did not finish within 0\.05 s/);
  assert.equal(by(checks, "instances")!.status, "skip");
});

test("I1: closing an open session is bounded (closeTimeoutMs) when close() never settles", async () => {
  const { deps, api } = fakeDeps({ closeTimeoutMs: 50 });
  (api as unknown as { close: () => Promise<void> }).close = () => new Promise(() => {});
  assert.equal(await within(runDoctor(deps), 2000), "done");
});

test("I2: Ctrl+C while the T3 session is open closes it (bounded) and exits 130; listeners removed afterwards", async () => {
  const { EventEmitter } = await import("node:events");
  const signals = new EventEmitter();
  const exits: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { deps, calls, api } = fakeDeps({ signals, exit: (code: number) => { exits.push(code); } });
  (api as unknown as { providerInstances: () => Promise<ProviderInstanceInfo[]> }).providerInstances = async () => {
    assert.equal(signals.listenerCount("SIGINT"), 1, "handler installed while the session is open");
    assert.equal(signals.listenerCount("SIGTERM"), 1);
    signals.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 20));
    release();
    return [inst("claudeAgent", `${HOME}/.claude`)];
  };
  const p = runDoctor(deps);
  await gate;
  await p;
  assert.deepEqual(exits, [130]);
  assert.equal(calls.filter((c) => c === "close").length, 1, "closed once");
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("I2: no signal listener when T3 is down (no session)", async () => {
  const { EventEmitter } = await import("node:events");
  const signals = new EventEmitter();
  let max = 0;
  const { deps } = fakeDeps({ signals, probe: async () => { max = Math.max(max, signals.listenerCount("SIGINT")); return false; } });
  await runDoctor(deps);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(max, 0);
});

test("M3: lock message names no host for this machine, 'another machine' otherwise", async () => {
  const lock = (hostname: string) => async () => ({ pid: 4242, startedAt: "2026-11-11T11:00:00.000Z", hostname, ageMs: 60_000, uptimeSec: null });
  const same = by((await runDoctor(fakeDeps({ hostname: "here", lockInfo: lock("here") }).deps)).checks, "lock")!;
  assert.ok(!same.message.includes("here"), same.message);
  assert.match(same.message, /pid 4242/);
  const other = by((await runDoctor(fakeDeps({ hostname: "here", lockInfo: lock("there") }).deps)).checks, "lock")!;
  assert.match(other.message, /another machine/);
  assert.ok(!other.message.includes("there"));
});

test("M4: t3-cli fail; config invalid -> fail, missing -> ok; backups-present warn; rejected connect -> t3-token fail", async () => {
  const { ConfigError } = await import("../../src/core/config.ts");
  const c1 = (await runDoctor(fakeDeps({ resolveCli: () => null }).deps)).checks;
  assert.equal(by(c1, "t3-cli")!.status, "fail");
  assert.match(by(c1, "t3-cli")!.fix!, /~\/\.t3\/bin/);
  assert.equal(by(c1, "t3-token")!.status, "skip");
  const c2 = (await runDoctor(fakeDeps({ loadConfig: async () => { throw new ConfigError("C:/Users/demo/.t3code-session-manager/config.json: invalid JSON (Unexpected token)."); } }).deps)).checks;
  assert.equal(by(c2, "config")!.status, "fail");
  assert.match(by(c2, "config")!.message, /invalid JSON/);
  assert.match(by(c2, "config")!.fix!, /accounts --init/);
  const c3 = (await runDoctor(fakeDeps({ loadConfig: async () => null }).deps)).checks;
  assert.equal(by(c3, "config")!.status, "ok");
  assert.match(by(c3, "config")!.message, /no config\.json yet/);
  const c4 = (await runDoctor(fakeDeps({ findBackupDirs: async (h: string) => (h.endsWith(".claude") ? [`${h}/projects/.bak-1`, `${h}/projects/x.bak`] : []) }).deps)).checks;
  assert.equal(by(c4, "backups-present")!.status, "warn");
  assert.match(by(c4, "backups-present")!.message, /2 backup folders .*~\/\.claude: 2/);
  assert.equal(by(c4, "backups-present")!.fix, "Run t3sm quarantine (reversible)");
  const { T3AuthError } = await import("../../src/t3/errors.ts");
  const c5 = (await runDoctor(fakeDeps({ connect: async () => { throw new T3AuthError("websocket ticket refused (HTTP 403)"); } }).deps)).checks;
  assert.equal(by(c5, "t3-token")!.status, "fail");
  assert.match(by(c5, "t3-token")!.message, /websocket ticket refused/);
  assert.equal(by(c5, "instances")!.status, "skip");
});

test("M4: instance-accounts warns on an unavailable instance and when T3 has no Claude instance", async () => {
  const c1 = by((await runDoctor(fakeDeps({ instances: [inst("claudeAgent", `${HOME}/.claude`, { email: "a@x.com" }), inst("claude-org", `${HOME}/.claude-org`, { availability: "unavailable" })] }).deps)).checks, "instance-accounts")!;
  assert.equal(c1.status, "warn");
  assert.match(c1.message, /^Org is unavailable/, "the account by its display name");
  assert.doesNotMatch(c1.message, /claude-org|claudeAgent/, "never the raw account id when the account has a name");
  const c2 = by((await runDoctor(fakeDeps({ instances: [{ ...inst("codex", null), driver: "codex" }] }).deps)).checks, "instance-accounts")!;
  assert.equal(c2.status, "warn");
  assert.equal(c2.message, "T3 Code has no Claude instance");
});

test("doctor masks an account whose display name is an email (Claude accounts and t3sm plugin checks)", async () => {
  const cfg = defaultConfig([{ id: "claudeAgent", home: "~/.claude", displayName: "demouser@example.com", accentColor: null }]);
  const r = await runDoctor(fakeDeps({ loadConfig: async () => cfg, instances: [inst("claudeAgent", `${HOME}/.claude`, { availability: "unavailable" })], pluginState: async () => ({ state: "missing" }) }).deps);
  for (const id of ["instance-accounts", "t3sm-plugin"]) {
    const c = by(r.checks, id)!;
    assert.match(c.message, /d\*\*\*@example\.com/, id);
    assert.doesNotMatch(JSON.stringify(c), /demouser/, `${id}: never the unmasked email, --json included`);
  }
});

test("doctor's last scrub drops invisible characters before it masks, so a hidden one cannot shield an email", async () => {
  const { ConfigError } = await import("../../src/core/config.ts");
  const r = await runDoctor(fakeDeps({ loadConfig: async () => { throw new ConfigError("config.json: owner demo\u200Buser@example.com is not valid"); } }).deps);
  const c = by(r.checks, "config")!;
  assert.match(c.message, /d\*\*\*@example\.com/);
  assert.doesNotMatch(JSON.stringify(c), /user@|\u200b/i);
});

test("doctor tells apart two Claude accounts with the same display name by their id", async () => {
  const cfg = defaultConfig([
    { id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null },
    { id: "claude-org", home: "~/.claude-org", displayName: "Claude", accentColor: null },
  ]);
  const c = by((await runDoctor(fakeDeps({ loadConfig: async () => cfg, instances: [inst("claudeAgent", `${HOME}/.claude`, { email: "a@x.com" }), inst("claude-org", `${HOME}/.claude-org`, { availability: "unavailable" })] }).deps)).checks, "instance-accounts")!;
  assert.match(c.message, /^Claude \(claude-org\) is unavailable/);
  assert.match(c.message, /Claude \(claudeAgent\) a\*\*\*@x\.com/);
});

test("M4: schedule warns when the installed command points at paths that no longer exist", async () => {
  const c = by((await runDoctor(fakeDeps({ scheduleStatus: async () => ({ kind: "schtasks", installed: true, nextRun: null, detail: "Ready", missing: [`${HOME}/old/bin/t3sm.mjs`] }) }).deps)).checks, "schedule")!;
  assert.equal(c.status, "warn");
  assert.match(c.message, /~\/old\/bin\/t3sm\.mjs, which no longer exists/);
  assert.equal(c.fix, "Run t3sm schedule install again from the current t3sm");
});

test("M2 (Task 21): a table of checks (symbol, check, result), each problem in full with what to do, the verdict as a panel (snapshot)", async () => {
  const { renderDoctor } = await import("../../src/cli/commands/doctor.ts");
  const { makeCliUi } = await import("../../src/cli/ui.ts");
  const { assertSnapshot } = await import("../ui/snapshot.ts");
  const checks: Check[] = [
    { id: "node-version", status: "ok", message: "Node 24.11.1" },
    { id: "t3-reachable", status: "fail", message: "T3 Code is not answering at http://127.0.0.1:3773 and every check that needs it was skipped for that reason", fix: "Open T3 Code from the Start menu, wait until its window shows your projects, then run t3sm doctor again" },
    { id: "t3-token", status: "skip", message: "needs a running T3 Code" },
  ];
  for (const unicode of [false, true]) {
    const out = renderDoctor(checks, makeCliUi({ color: 0, unicode, isTTY: false, columns: 80 }, "en"));
    for (const l of out.split("\n")) assert.ok(l.length <= 80, l);
    assertSnapshot(`doctor/m2-80-${unicode ? "u" : "a"}`, out);
  }
  const ascii = renderDoctor(checks, makeCliUi({ color: 0, unicode: false, isTTY: false, columns: 80 }, "en"));
  assert.match(ascii, /^x  T3 Code running  see below$/m, "the check's name, never its id; the message once, below");
  assert.equal(ascii.split("T3 Code is not answering").length, 2, "never twice");
  assert.match(ascii, /^  What to do: Open T3 Code from the Start menu, wait until its window shows your$/m, "the fix in full");
  assert.match(ascii, /^\+- x 1 problem to fix -+\+$/m, "the verdict is a panel");
});

test("lock: taken before the last restart (uptime now below the lock's) -> ok (taken over next run) even with a live pid; held long -> fix names the lock file, never ending a process", async () => {
  const before = fakeDeps({
    lockInfo: async () => ({ pid: 4242, startedAt: "2026-11-08T12:00:00.000Z", hostname: "h", ageMs: 3 * 86400_000, uptimeSec: 500_000 }),
    pidAlive: () => true, uptime: () => 3600,
  });
  const c1 = by((await runDoctor(before.deps)).checks, "lock")!;
  assert.equal(c1.status, "ok");
  assert.match(c1.message, /before the last restart/);
  // Same boot: an old-looking startedAt (wall clock stepped) is judged by its pid, not by the boot.
  const stepped = fakeDeps({
    lockInfo: async () => ({ pid: 4242, startedAt: "2016-11-08T12:00:00.000Z", hostname: "h", ageMs: 60_000, uptimeSec: 3000 }),
    pidAlive: () => true, uptime: () => 3600,
  });
  assert.match(by((await runDoctor(stepped.deps)).checks, "lock")!.message, /held by pid 4242/);
  const held = fakeDeps({
    lockInfo: async () => ({ pid: 4242, startedAt: "2026-11-11T04:00:00.000Z", hostname: "h", ageMs: 8 * 3600_000, uptimeSec: null }),
    pidAlive: () => true, uptime: () => 1,
  });
  const c2 = by((await runDoctor(held.deps)).checks, "lock")!;
  assert.equal(c2.status, "warn");
  assert.match(c2.fix!, /^If no t3sm command is running, delete .*lock$/);
  assert.doesNotMatch(c2.fix!, /end it|kill/i);
});

test("lock held > 6 h -> warn naming the pid; versions; claude-env; node; state-dir; watcher; harness without instance", async () => {
  const { deps } = fakeDeps({
    lockInfo: async () => ({ pid: 4242, startedAt: "2026-11-11T04:00:00.000Z", hostname: "h", ageMs: 8 * 3600_000, uptimeSec: null }),
    env: { CLAUDE_CONFIG_DIR: "C:\\Users\\demo\\.claude-org" },
    nodeVersion: "22.17.1",
    stateWritable: async () => "EACCES",
    readRuntime: async () => ({ origin: "http://127.0.0.1:3773", port: 3773, serverVersion: "0.2.0", pid: 1 }),
    readHeartbeat: async () => ({ pid: 77, startedAt: "2026-11-11T08:00:00.000Z", lastCycleAt: "2026-11-11T09:00:00.000Z", lastResult: null, nextCycleAt: "2026-11-11T09:15:00.000Z" }),
    instances: [inst("claudeAgent", `${HOME}/.claude`), inst("claude-org", `${HOME}/.claude-org`)],
    harnesses: async () => [{ id: "claude", available: true }, { id: "codex", available: true }, { id: "pi", available: true }],
  });
  const { checks } = await runDoctor(deps);
  assert.equal(by(checks, "lock")!.status, "warn");
  assert.match(by(checks, "lock")!.message, /4242/);
  assert.equal(by(checks, "t3-version")!.status, "warn");
  assert.match(by(checks, "t3-version")!.message, /has not been tested with t3sm.*proceeds/);
  assert.equal(by(checks, "claude-env")!.status, "warn");
  assert.equal(by(checks, "claude-env")!.message, "T3 Code started from this shell would read ~/.claude-org as its default account");
  assert.equal(by(checks, "node-version")!.status, "fail");
  assert.equal(by(checks, "state-dir")!.status, "fail");
  assert.equal(by(checks, "sync-watcher")!.status, "warn");
  assert.equal(by(checks, "harness:codex")!.status, "warn");
  assert.equal(by(checks, "harness:codex")!.message, "sessions found but T3 Code has no codex instance; they will be skipped");
  assert.equal(by(checks, "harness:pi")!.status, "warn");
});

test("same-minor T3 version warns with the same wording as any untested version; accounts-undiscovered and quarantine-orphans warn", async () => {
  const { deps } = fakeDeps({
    readRuntime: async () => ({ origin: "http://127.0.0.1:3773", port: 3773, serverVersion: "0.1.9-nightly.20261111.4515", pid: 1 }),
    discover: async () => [{ home: `${HOME}/.claude`, sources: ["default"], alias: null }, { home: "D:/accts/work", sources: ["shell-profile"], alias: "cw" }],
    findOrphanedQuarantine: async () => [{ accountHome: `${HOME}/.claude`, path: `${HOME}/.claude/session-manager-quarantine/backups/x`, kind: "backup" }],
  });
  const { checks } = await runDoctor(deps);
  assert.equal(by(checks, "t3-version")!.status, "warn");
  assert.equal(by(checks, "t3-version")!.message, `0.1.9-nightly.20261111.4515 has not been tested with t3sm (tested: ${TESTED_VERSIONS.join(", ")}); t3sm proceeds with a warning`);
  assert.equal(by(checks, "t3-version")!.fix, "Nothing is required; every change is journaled and can be undone with t3sm rollback. Pass --allow-untested to hide the warning");
  const u = by(checks, "accounts-undiscovered")!;
  assert.equal(u.status, "warn");
  assert.match(u.message, /D:\/accts\/work \(shell-profile \(cw\)\)/);
  assert.equal(by(checks, "quarantine-orphans")!.status, "warn");
});

test("maskEmail", () => {
  assert.equal(maskEmail("demo@example.com"), "d***@example.com");
  assert.equal(maskEmail("x"), "***");
});

// ---- CLI ----
const temps: string[] = [];
after(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

function cliIo(env: NodeJS.ProcessEnv, tty = false) {
  const out: string[] = [], err: string[] = [];
  const io: Io = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: tty, prompt: async () => "", env };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

test("doctor CLI: the table, what to do under each problem, the verdict panel, exit 1 on fail; --json prints the checks", async () => {
  const { deps } = fakeDeps({ probe: async () => false });
  const c = cliIo({ TERM: "dumb", LANG: "en_US.UTF-8" }); // ASCII symbols, no colour
  assert.equal(await doctorCommand([], c.io, { deps }), 1);
  const o = c.out();
  assert.match(o, /^x\s+T3 Code running\s+/m);
  assert.match(o, /^v\s+Node\s+Node /m);
  assert.match(o, /\n  What to do: Open T3 Code from the Start menu\n/);
  assert.match(o, /^\| Fix the items marked x, then run t3sm doctor again\. +\|$/m);
  assert.match(o, /^\+- x 1 problem to fix -+\+$/m);
  assert.ok(!o.includes("✓") && !o.includes("\x1b["), "ASCII and no colour on a dumb terminal");
  const j = cliIo({});
  assert.equal(await doctorCommand(["--json"], j.io, { deps }), 1);
  const parsed = JSON.parse(j.out());
  assert.ok(Array.isArray(parsed) && parsed.some((x: Check) => x.id === "t3-reachable" && x.status === "fail"));
  const ok = cliIo({ WT_SESSION: "1", LANG: "en_US.UTF-8" }, true);
  assert.equal(await doctorCommand([], ok.io, { deps: fakeDeps().deps }), 0);
  assert.match(ok.out(), /✓/);
  assert.match(ok.out(), /Ready/);
  assert.match(ok.out(), /Next: t3sm plan/);
  const w = cliIo({ LANG: "en_US.UTF-8" });
  assert.equal(await doctorCommand([], w.io, { deps: fakeDeps({ env: { CLAUDE_CONFIG_DIR: "C:/x" } }).deps }), 0);
  assert.match(w.out(), /Ready, with 1 warning/);
  const nc = cliIo({ NO_COLOR: "1" }, true);
  await doctorCommand([], nc.io, { deps: fakeDeps().deps });
  assert.ok(!nc.out().includes("\x1b["));
  const bad = cliIo({});
  assert.equal(await doctorCommand(["--bogus"], bad.io, { deps }), 2);
});

test("doctor with default deps on a temp home: writes nothing; --repair restores a pending mtime under the lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "t3sm-doc-"));
  temps.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  const state = join(root, "state");
  const file = join(home, ".claude", "projects", "a.jsonl");
  writeFileSync(file, "{}\n");
  const orig = Date.parse("2026-01-01T00:00:00Z");
  const bumped = Date.parse("2026-11-01T00:00:00Z");
  utimesSync(file, orig / 1000, bumped / 1000);
  const offline = { readRuntime: async () => null, harnesses: async () => [], findBin: () => null, scheduleStatus: async () => ({ kind: "schtasks", installed: false, nextRun: null, detail: null }) };
  const env = { T3SM_HOME: state };
  const c = cliIo(env);
  await doctorCommand([], c.io, { home, overrides: offline });
  assert.equal(existsSync(state), false, "doctor writes nothing");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "journal.jsonl"), JSON.stringify({ t: "mtime-bump", runId: "r1", files: [{ path: file, atimeMs: orig, mtimeMs: orig, targetMtimeMs: bumped }] }) + "\n");
  const c2 = cliIo(env);
  await doctorCommand(["--json"], c2.io, { home, overrides: offline });
  assert.equal(JSON.parse(c2.out()).find((x: Check) => x.id === "pending-mtimes").status, "warn");
  assert.equal(statSync(file).mtimeMs, bumped, "no repair without --repair");
  const c3 = cliIo(env);
  await doctorCommand(["--repair", "--json"], c3.io, { home, overrides: offline });
  assert.equal(JSON.parse(c3.out()).find((x: Check) => x.id === "pending-mtimes").status, "ok");
  assert.equal(Math.round(statSync(file).mtimeMs), orig);
  assert.equal(existsSync(join(state, "lock")), false, "lock released");
  void defaultDoctorDeps;
});

test("harness:opencode warns on a changed storage format or an unreadable db (adapter availability); absent stays ok", async () => {
  const { deps } = fakeDeps({
    harnesses: async () => [
      { id: "claude", available: true },
      { id: "opencode", available: false, problem: "storage format changed: opencode: table part is missing" },
    ],
    findBin: (n) => (n === "opencode" ? "C:/bin/opencode.exe" : null),
    binVersion: async () => "1.20.0",
  });
  const { checks } = await runDoctor(deps);
  const oc = by(checks, "harness:opencode")!;
  assert.equal(oc.status, "warn");
  assert.match(oc.message, /^storage format changed: opencode: table part is missing; opencode 1\.20\.0; its sessions are not converted$/);
  const { deps: d2 } = fakeDeps({ harnesses: async () => [{ id: "opencode", available: false }] });
  assert.equal(by((await runDoctor(d2)).checks, "harness:opencode")!.status, "ok");
});

test("harness:codex: importable natively, convertible (compressed) and skipped counts; no Codex instance matters only for native ones", async () => {
  const codexDeps = (importable: number, convertible: number, skipped: number) => fakeDeps({
    harnesses: async () => [{ id: "codex", available: true, importable, convertible, skipped }],
    findBin: (n) => (n === "codex" ? "C:/bin/codex.exe" : null),
    binVersion: async () => "codex-cli 0.167.0",
  }).deps;
  const all = by((await runDoctor(codexDeps(2, 3, 1))).checks, "harness:codex")!;
  assert.equal(all.status, "ok");
  assert.equal(all.message, "codex-cli 0.167.0 · 2 importable natively, 3 convertible (compressed), 1 skipped");
  const zstOnly = by((await runDoctor(codexDeps(0, 108, 0))).checks, "harness:codex")!;
  assert.equal(zstOnly.status, "ok", "compressed sessions alone are converted: nothing to warn about");
  assert.equal(zstOnly.message, "codex-cli 0.167.0 · 0 importable natively, 108 convertible (compressed), 0 skipped");
});

test("harness:codex: read errors are reported apart from skipped sessions (warn); with T3 reachable, how many are already in T3 (either form)", async () => {
  const { uuidV5 } = await import("../../src/core/uuid.ts");
  const { deps, api } = fakeDeps({
    harnesses: async () => [{ id: "codex", available: true, importable: 1, convertible: 2, skipped: 0, readErrors: 1, sessionIds: ["a", "b", "c"] }],
    findBin: (n) => (n === "codex" ? "C:/bin/codex.exe" : null),
    binVersion: async () => "codex-cli 0.167.0",
  });
  (api as unknown as { listThreads: () => Promise<unknown[]> }).listThreads = async () => [
    { id: "import:codex:a", projectId: "p", instanceId: "codex", archived: false, title: "t" },
    { id: `import:claudeAgent:${uuidV5("codex:b")}`, projectId: "p", instanceId: "claudeAgent", archived: false, title: "t" },
  ];
  const c = by((await runDoctor(deps)).checks, "harness:codex")!;
  assert.equal(c.status, "warn");
  assert.equal(c.message, "codex-cli 0.167.0 · 1 importable natively, 2 convertible (compressed), 0 skipped, 1 read error; 2 already in T3 Code");
  assert.match(c.fix ?? "", /t3sm scan/);
});

test("harness:codex: read errors and a missing Codex instance are both reported (one warn, messages and fixes combined)", async () => {
  const { deps } = fakeDeps({
    instances: [inst("claudeAgent", "C:\\Users\\demo\\.claude", { email: "alice@example.com" }), inst("claude-org", "C:/Users/demo/.claude-org", { email: "bob@corp.example" })],
    harnesses: async () => [{ id: "codex", available: true, importable: 2, convertible: 3, skipped: 0, readErrors: 1 }],
    findBin: (n) => (n === "codex" ? "C:/bin/codex.exe" : null),
    binVersion: async () => "codex-cli 0.167.0",
  });
  const c = by((await runDoctor(deps)).checks, "harness:codex")!;
  assert.equal(c.status, "warn");
  assert.equal(c.message, "codex-cli 0.167.0 · 2 importable natively, 3 convertible (compressed), 0 skipped, 1 read error; T3 Code has no codex instance, so the 2 native sessions will be skipped");
  assert.match(c.fix ?? "", /Enable Codex in T3 Code settings/);
  assert.match(c.fix ?? "", /t3sm scan/);
  // Without read errors: the missing instance alone still warns, with the counts.
  const { deps: d2 } = fakeDeps({
    instances: [inst("claudeAgent", "C:\\Users\\demo\\.claude")],
    harnesses: async () => [{ id: "codex", available: true, importable: 2, convertible: 3, skipped: 0, readErrors: 0 }],
    findBin: (n) => (n === "codex" ? "C:/bin/codex.exe" : null),
    binVersion: async () => "codex-cli 0.167.0",
  });
  const c2 = by((await runDoctor(d2)).checks, "harness:codex")!;
  assert.equal(c2.status, "warn");
  assert.match(c2.message, /; T3 Code has no codex instance, so the 2 native sessions will be skipped$/);
  assert.doesNotMatch(c2.fix ?? "", /t3sm scan/);
});

test("countCodexSessions reads a warm discovery cache read-only: no file is decompressed again, the cache is not rewritten", async () => {
  const { createCodexAdapter, countCodexSessions } = await import("../../src/sources/codex.ts");
  const home = mkdtempSync(join(tmpdir(), "t3sm-doctor-warm-"));
  try {
    const day = join(home, ".codex", "sessions", "2026", "01", "02");
    mkdirSync(day, { recursive: true });
    const id = "0190aaaa-0000-7000-8000-000000000009";
    const recs = [
      { timestamp: "2026-01-02T00:00:00.000Z", type: "session_meta", payload: { id, cwd: "C:/work/demo" } },
      { timestamp: "2026-01-02T00:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(join(day, `rollout-2026-01-02T00-00-00-${id}.jsonl.zst`), zstdCompressSync(Buffer.from(recs)));
    const env = { home, platform: process.platform, now: Date.now, config: defaultConfig([]), stateDir: join(home, "state"), env: {} };
    for await (const _ of createCodexAdapter().discover(env)) { /* warm the cache (a plan or scan does this) */ }
    const cache = join(home, "state", "cache", "codex-discovery.json");
    const before = statSync(cache).mtimeMs;
    const scans: string[] = [];
    const n = await countCodexSessions(env, createCodexAdapter({ onScan: (p) => scans.push(p) }));
    assert.equal(n.convertible, 1);
    assert.deepEqual(scans, [], "nothing decompressed");
    assert.equal(statSync(cache).mtimeMs, before, "cache not rewritten");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("defaultDoctorDeps().harnesses: Codex sessions classified read-only (native, convertible, skipped incl. unreadable .zst); nothing written", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3sm-doctor-cx-"));
  try {
    const day = join(home, ".codex", "sessions", "2026", "01", "02");
    mkdirSync(day, { recursive: true });
    const rec = (id: string) => [
      { timestamp: "2026-01-02T00:00:00.000Z", type: "session_meta", payload: { id, cwd: "C:/work/demo" } },
      { timestamp: "2026-01-02T00:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
      { timestamp: "2026-01-02T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n";
    const id = (n: number) => `0190aaaa-0000-7000-8000-00000000000${n}`;
    writeFileSync(join(day, `rollout-2026-01-02T00-00-00-${id(1)}.jsonl.zst`), "not zstd");
    writeFileSync(join(day, `rollout-2026-01-02T00-00-01-${id(2)}.jsonl.zst`), zstdCompressSync(Buffer.from(rec(id(2)))));
    writeFileSync(join(day, `rollout-2026-01-02T00-00-02-${id(3)}.jsonl`), rec(id(3)));
    writeFileSync(join(day, `rollout-2026-01-02T00-00-03-${id(4)}.jsonl`), "{}\n");
    const state = join(home, "state");
    const deps = defaultDoctorDeps({ home, env: { T3SM_HOME: state }, platform: process.platform } as never);
    const cx = (await deps.harnesses(defaultConfig([]))).find((h) => h.id === "codex")!;
    assert.equal(cx.available, true);
    // The unreadable .zst is a read error, not a skipped session; the plain one without an id is skipped.
    assert.deepEqual([cx.importable, cx.convertible, cx.skipped, cx.readErrors], [1, 1, 1, 1]);
    assert.deepEqual(cx.sessionIds?.toSorted(), [id(2), id(3)]);
    assert.ok(!existsSync(state), "doctor writes nothing");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("defaultDoctorDeps().harnesses: an unreadable OpenCode db -> problem; read-only (no snapshot left in the state dir)", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3sm-doctor-oc-"));
  try {
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
    writeFileSync(join(home, ".local", "share", "opencode", "opencode.db"), "not a database ".repeat(100));
    const state = join(home, "state");
    const deps = defaultDoctorDeps({ home, env: { T3SM_HOME: state }, platform: process.platform } as never);
    const list = await deps.harnesses(defaultConfig([]));
    const oc = list.find((h) => h.id === "opencode")!;
    assert.equal(oc.available, false);
    assert.match(oc.problem ?? "", /^present but unreadable: /);
    assert.ok(!existsSync(join(state, "cache", "opencode")), "doctor leaves no persistent snapshot");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("merge-pending: warns with the cached count of sessions continued in a terminal; ok when none or not counted", async () => {
  const warn = by((await runDoctor(fakeDeps({ mergePending: async () => ({ count: 2, orphaned: 0, at: "2026-11-11T10:00:00.000Z" }) }).deps)).checks, "merge-pending")!;
  assert.equal(warn.status, "warn");
  assert.match(warn.message, /2 sessions continued in a terminal/);
  assert.match(warn.fix!, /t3sm merge/);
  assert.equal(by((await runDoctor(fakeDeps({ mergePending: async () => ({ count: 0, orphaned: 0, at: "x" }) }).deps)).checks, "merge-pending")!.status, "ok");
  assert.equal(by((await runDoctor(fakeDeps({ mergePending: async () => null }).deps)).checks, "merge-pending")!.status, "ok");
});

test("defaultDoctorDeps().harnesses: OpenCode schema drift (a required table missing) -> storage format changed; nothing left in the state dir", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3sm-doctor-oc-"));
  try {
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
    buildOpenCodeDb(join(home, ".local", "share", "opencode", "opencode.db"), { ddl: OPENCODE_1_19_DDL.filter((s) => !/TABLE `part`/.test(s) && !/ON `part`/.test(s)) });
    const state = join(home, "state");
    const deps = defaultDoctorDeps({ home, env: { T3SM_HOME: state }, platform: process.platform } as never);
    const oc = (await deps.harnesses(defaultConfig([]))).find((h) => h.id === "opencode")!;
    assert.equal(oc.available, false);
    assert.match(oc.problem ?? "", /^storage format changed: opencode: table part is missing/);
    assert.ok(!existsSync(join(state, "cache", "opencode")));
    const { deps: d } = fakeDeps({ harnesses: async () => [{ id: "opencode", available: false, problem: oc.problem }] });
    assert.equal(by((await runDoctor(d)).checks, "harness:opencode")!.status, "warn");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("merge-pending: sessions with terminal work on a side branch are a warning even with nothing to merge", async () => {
  const c = by((await runDoctor(fakeDeps({ mergePending: async () => ({ count: 0, orphaned: 1, at: "x" }) }).deps)).checks, "merge-pending")!;
  assert.equal(c.status, "warn");
  assert.match(c.message, /1 session has terminal work on a side branch that T3 Code cannot show/);
  assert.match(c.fix!, /claude --resume/);
});

test("instance-unpinned: T3's default Claude instance without an explicit home -> warn, fix `t3sm accounts --apply`", async () => {
  const { deps } = fakeDeps({ explicit: {} });
  const c = by((await runDoctor(deps)).checks, "instance-unpinned")!;
  assert.equal(c.status, "warn");
  assert.match(c.message, /claudeAgent/);
  assert.equal(c.fix, "Run t3sm accounts --apply");
});

test("B13: future-mtimes lists transcripts more than 10 minutes ahead that are not in a pending journal entry", async () => {
  const pending = "C:/Users/demo/.claude/projects/C--w/p.jsonl";
  const { deps } = fakeDeps({
    futureMtimes: async () => [
      { path: pending, mtimeMs: NOW + DAY_MS }, { path: "C:/Users/demo/.claude/projects/C--w/x.jsonl", mtimeMs: NOW + 2 * DAY_MS },
      { path: "C:/Users/demo/.claude/projects/C--w/soon.jsonl", mtimeMs: NOW + 60_000 },
    ],
    readJournal: async () => [{ t: "mtime-bump", runId: "r", files: [{ path: pending, atimeMs: 1, mtimeMs: 1, targetMtimeMs: NOW + DAY_MS }] }],
  });
  const c = by((await runDoctor(deps)).checks, "future-mtimes")!;
  assert.equal(c.status, "warn");
  assert.match(c.message, /^1 transcript has a file time more than 10 minutes in the future/);
  assert.match(c.message, /x\.jsonl/);
  const ok = by((await runDoctor(fakeDeps().deps)).checks, "future-mtimes")!;
  assert.equal(ok.status, "ok");
});

test("defaultDoctorDeps().futureMtimes: stat-only walk (no transcript opened), warm-cache suspects first, nothing written", async () => {
  const root = mkdtempSync(join(tmpdir(), "t3sm-doc-fm-"));
  temps.push(root);
  const home = join(root, "home");
  const proj = join(home, ".claude", "projects", "C--w");
  mkdirSync(proj, { recursive: true });
  const a = join(proj, "a.jsonl"), b = join(proj, "b.jsonl");
  writeFileSync(a, "{}\n");
  writeFileSync(b, "{}\n");
  const future = Date.now() + 5 * DAY_MS;
  utimesSync(b, future / 1000, future / 1000);
  const state = join(root, "state");
  const cfg = defaultConfig([{ id: "claudeAgent", home: join(home, ".claude"), displayName: "Claude", accentColor: null }]);
  const collect = async () => {
    const d = defaultDoctorDeps({ home, env: { T3SM_HOME: state }, repair: false, platform: process.platform });
    const out: { path: string; mtimeMs: number }[] = [];
    for await (const f of await d.futureMtimes!(cfg)) out.push(f);
    return out;
  };
  const cold = await collect();
  assert.deepEqual(cold.map((f) => f.path).sort(), [a, b].sort());
  assert.equal(Math.round(cold.find((f) => f.path === b)!.mtimeMs / 1000), Math.round(future / 1000));
  assert.equal(existsSync(state), false, "nothing written");
  // Warm: the discovery cache already recorded b in the future -> it is checked first (re-stat), and not twice.
  mkdirSync(join(state, "cache"), { recursive: true });
  writeFileSync(join(state, "cache", "claude-discovery.json"), JSON.stringify({ version: 3, entries: { [a]: { size: 3, mtimeMs: 1, result: {} }, [b]: { size: 3, mtimeMs: future, result: {} } } }));
  const warm = await collect();
  assert.equal(warm[0]!.path, b);
  assert.equal(warm.length, 2);
});

test("t3sm-plugin: one line per configured account (installed / outdated / missing); read-only, never a fail", async () => {
  const seen: string[] = [];
  const states: Record<string, { state: "installed"; version: string } | { state: "outdated"; version: string } | { state: "missing" }> = {
    [`${HOME}/.claude`]: { state: "installed", version: "0.3.0" },
    [`${HOME}/.claude-org`]: { state: "missing" },
  };
  const c = by((await runDoctor(fakeDeps({ pluginState: async (h) => { seen.push(h); return states[h]!; } }).deps)).checks, "t3sm-plugin")!;
  assert.equal(c.status, "ok", "an optional plugin that is missing is not a warning");
  assert.match(c.message, /^Claude: installed \(0\.3\.0\)/, "each account by its display name");
  assert.match(c.message, /Org: not installed/);
  assert.doesNotMatch(c.message, /claude-org|claudeAgent/, "never the raw account id when the account has a name");
  assert.deepEqual(seen.sort(), [`${HOME}/.claude`, `${HOME}/.claude-org`].sort());

  states[`${HOME}/.claude-org`] = { state: "outdated", version: "0.2.1" };
  const w = by((await runDoctor(fakeDeps({ pluginState: async (h) => states[h]! }).deps)).checks, "t3sm-plugin")!;
  assert.equal(w.status, "warn");
  assert.match(w.message, /Org: outdated: 0\.2\.1 installed, this t3sm is 0\.3\.0/);
  assert.match(w.fix ?? "", /claude plugin update t3sm@t3code-session-manager/);
});

test("t3sm-plugin: without the reader the check is skipped, and a throwing reader is a warn, not a crash", async () => {
  const none = by((await runDoctor(fakeDeps({ pluginState: undefined }).deps)).checks, "t3sm-plugin")!;
  assert.equal(none.status, "skip");
  const bad = by((await runDoctor(fakeDeps({ pluginState: async () => { throw new Error("disk"); } }).deps)).checks, "t3sm-plugin")!;
  assert.equal(bad.status, "warn");
});

// ---------- sync-watcher: stale version ----------

const HB = { pid: 77, startedAt: "2026-11-11T08:00:00.000Z", lastCycleAt: "2026-11-11T11:55:00.000Z", lastResult: null, nextCycleAt: "2026-11-11T12:10:00.000Z", protocol: 1 };
const RUNNING = { ...HB, version: "0.3.0", stamp: "2026-11-01T10:00:00.000Z", installRoot: "C:/work/t3sm" };
const INSTALLED = { version: "0.3.1", stamp: "2026-11-11T11:00:00.000Z" };

test("doctor flags a watcher on another version after one cycle (the install changed before its last cycle ended)", async () => {
  const roots: (string | null)[] = [];
  const { deps } = fakeDeps({
    readHeartbeat: async () => RUNNING,
    installStamp: (root) => { roots.push(root); return { ...INSTALLED, changedAtMs: Date.parse("2026-11-11T11:50:00.000Z") }; },
  });
  const c = by((await runDoctor(deps)).checks, "sync-watcher")!;
  assert.equal(c.status, "warn");
  assert.match(c.message, /pid 77.*0\.3\.0.*0\.3\.1 is installed/);
  assert.match(c.fix!, /t3sm schedule restart/);
  assert.deepEqual(roots, ["C:/work/t3sm"], "compared with the watcher's own install root");
  // Same version, rebuilt (another stamp): stale as well.
  const rebuilt = fakeDeps({ readHeartbeat: async () => RUNNING, installStamp: () => ({ version: "0.3.0", stamp: "2026-11-11T11:00:00.000Z", changedAtMs: Date.parse("2026-11-11T11:50:00.000Z") }) });
  assert.equal(by((await runDoctor(rebuilt.deps)).checks, "sync-watcher")!.status, "warn");
});

test("doctor: a new install the watcher has not had a cycle to notice yet is fine (it restarts after its next cycle)", async () => {
  const { deps } = fakeDeps({ readHeartbeat: async () => RUNNING, installStamp: () => ({ ...INSTALLED, changedAtMs: Date.parse("2026-11-11T11:58:00.000Z") }) });
  const c = by((await runDoctor(deps)).checks, "sync-watcher")!;
  assert.equal(c.status, "ok");
  assert.match(c.message, /running \(pid 77\).*0\.3\.1 is installed; the watcher switches to it after its next cycle/);
  const same = fakeDeps({ readHeartbeat: async () => RUNNING, installStamp: () => ({ version: "0.3.0", stamp: RUNNING.stamp, changedAtMs: 0 }) });
  const s = by((await runDoctor(same.deps)).checks, "sync-watcher")!;
  assert.equal(s.status, "ok");
  assert.match(s.message, /^running \(pid 77\), last cycle 5 min ago$/);
  // An unreadable install (null) says nothing about the version.
  const unknown = fakeDeps({ readHeartbeat: async () => RUNNING, installStamp: () => null });
  assert.equal(by((await runDoctor(unknown.deps)).checks, "sync-watcher")!.status, "ok");
});

test("doctor: an install that changed inside the watcher's settle window before its last cycle is not flagged (the watcher skips that restart on purpose)", async () => {
  const at = (ms: number) => fakeDeps({ readHeartbeat: async () => RUNNING, installStamp: () => ({ ...INSTALLED, changedAtMs: Date.parse(RUNNING.lastCycleAt) - ms }) });
  const inside = by((await runDoctor(at(15_000).deps)).checks, "sync-watcher")!;
  assert.equal(inside.status, "ok", "15 s before the cycle ended: still settling, the next cycle restarts it");
  assert.match(inside.message, /0.3.1 is installed; the watcher switches to it after its next cycle/);
  assert.equal(by((await runDoctor(at(29_999).deps)).checks, "sync-watcher")!.status, "ok");
  assert.equal(by((await runDoctor(at(30_000).deps)).checks, "sync-watcher")!.status, "warn", "exactly settled and still not restarted");
});

test("heartbeat from 0.2.1 (no version) counts as stale-version", async () => {
  for (const installStamp of [() => ({ ...INSTALLED, changedAtMs: 0 }), () => null, undefined]) {
    const { deps } = fakeDeps({ readHeartbeat: async () => ({ ...HB, protocol: undefined }), installStamp });
    const c = by((await runDoctor(deps)).checks, "sync-watcher")!;
    assert.equal(c.status, "warn");
    assert.match(c.message, /^running \(pid 77\) on an older t3sm, or one that could not read its install, that does not restart itself after an upgrade$/);
    assert.match(c.fix!, /t3sm schedule restart/);
  }
  // A stopped or dead 0.2.1 watcher is not "running on another version".
  const stopped = fakeDeps({ readHeartbeat: async () => ({ ...HB, stoppedAt: "2026-11-11T11:56:00.000Z" }) });
  assert.equal(by((await runDoctor(stopped.deps)).checks, "sync-watcher")!.status, "ok");
  const dead = fakeDeps({ readHeartbeat: async () => HB, pidAlive: () => false });
  assert.match(by((await runDoctor(dead.deps)).checks, "sync-watcher")!.message, /is gone without a clean stop/);
});

test("doctor: a watcher that stopped to restart and has no successor after 20 min warns (as status does)", async () => {
  const lost = fakeDeps({ readHeartbeat: async () => ({ ...RUNNING, stoppedAt: "2026-11-11T11:30:00.000Z", reason: "restart" as const }) });
  const c = by((await runDoctor(lost.deps)).checks, "sync-watcher")!;
  assert.equal(c.status, "warn");
  assert.match(c.message, /to restart into a newer t3sm, and no new watcher started/);
  assert.match(c.fix!, /t3sm schedule restart/);
  const fresh = fakeDeps({ readHeartbeat: async () => ({ ...RUNNING, stoppedAt: "2026-11-11T11:55:00.000Z", reason: "restart" as const }) });
  assert.equal(by((await runDoctor(fresh.deps)).checks, "sync-watcher")!.status, "ok", "a successor may still be starting");
});

test("doctor: a 0.3 watcher that could not read its install stamp (version, no stamp) is flagged as not restarting itself", async () => {
  const { deps } = fakeDeps({ readHeartbeat: async () => ({ ...HB, version: "0.3.0" }), installStamp: () => ({ ...INSTALLED, changedAtMs: 0 }) });
  const c = by((await runDoctor(deps)).checks, "sync-watcher")!;
  assert.equal(c.status, "warn");
  assert.match(c.message, /on t3sm 0\.3\.0, but it could not read its install/);
  assert.match(c.fix!, /t3sm schedule restart/);
});

test("the checks a screen interprets carry structured data (merge-pending, harness:<agent>); message and fix unchanged", async () => {
  const at = "2026-11-11T10:00:00.000Z";
  const m = by((await runDoctor(fakeDeps({ mergePending: async () => ({ count: 2, orphaned: 1, at }) }).deps)).checks, "merge-pending")!;
  assert.deepEqual(m.data, { continued: 2, sideBranch: 1, at });
  assert.match(m.message, /2 sessions continued in a terminal.*1 session has terminal work on a side branch/);
  const ok = by((await runDoctor(fakeDeps({ mergePending: async () => ({ count: 0, orphaned: 0, at }) }).deps)).checks, "merge-pending")!;
  assert.deepEqual(ok.data, { continued: 0, sideBranch: 0, at });
  const { deps } = fakeDeps({
    instances: [inst("claudeAgent", "C:\Users\demo\.claude")],
    harnesses: async () => [{ id: "codex", available: true, importable: 2, convertible: 3, skipped: 0, readErrors: 1 }, { id: "pi", available: true }, { id: "opencode", available: false }],
    findBin: () => null,
  });
  const checks = (await runDoctor(deps)).checks;
  assert.deepEqual(by(checks, "harness:codex")!.data, { harness: "codex", sessions: 5, readErrors: 1, noInstance: true });
  assert.deepEqual(by(checks, "harness:pi")!.data, { harness: "pi", sessions: null, readErrors: 0, noInstance: true });
  assert.deepEqual(by(checks, "harness:opencode")!.data, { harness: "opencode", sessions: 0, readErrors: 0, noInstance: false });
  assert.match(by(checks, "harness:codex")!.fix ?? "", /Enable Codex.*t3sm scan/s, "the fix is unchanged");
});

test("doctor in Portuguese: every check's result and fix are worded from the catalogue (no English sentence on screen); --json keeps the English message and fix", async () => {
  const { renderDoctor } = await import("../../src/cli/commands/doctor.ts");
  const { makeCliUi } = await import("../../src/cli/ui.ts");
  const runs = [
    fakeDeps().deps,
    fakeDeps({ probe: async () => false }).deps,
    fakeDeps({ env: { CLAUDE_CONFIG_DIR: "C:/x" }, readRuntime: async () => null }).deps,
    fakeDeps({ scheduleStatus: async () => ({ kind: "schtasks", installed: true, nextRun: null, detail: "Ready", missing: [`${HOME}/old/bin/t3sm.mjs`] }) }).deps,
  ];
  for (const deps of runs) {
    const { checks } = await runDoctor(deps);
    for (const c of checks) assert.ok(c.say !== undefined && c.say.length > 0 && c.say.every((p) => /^doctor\.say\./.test(p.key)), `${c.id} ${c.status}: worded by catalogue keys`);
    const pt = renderDoctor(checks, makeCliUi({ color: 0, unicode: true, isTTY: false, columns: 200 }, "pt"));
    const sentence = (x: string): boolean => x.split(" ").filter((w) => /^[a-z]{3,}$/i.test(w)).length >= 2;
    for (const c of checks) {
      // The accounts' list is names and masked emails, the same in every language.
      const namesOnly = c.id === "instance-accounts" && c.status === "ok";
      if (sentence(c.message) && !namesOnly) assert.ok(!pt.includes(c.message), `${c.id}: the English message is on the Portuguese screen: ${c.message}`);
      if (c.fix && c.status !== "ok" && c.status !== "skip") assert.ok(!pt.includes(c.fix), `${c.id}: the English fix on the Portuguese screen: ${c.fix}`);
    }
    // English: the catalogue says exactly what the check's own message says.
    const en = renderDoctor(checks, makeCliUi({ color: 0, unicode: true, isTTY: false, columns: 400 }, "en"));
    for (const c of checks.filter((x) => x.status === "warn" || x.status === "fail")) assert.ok(en.includes(c.message), `${c.id}: ${c.message}`);
  }
  const j = cliIo({});
  await doctorCommand(["--json"], j.io, { deps: fakeDeps({ probe: async () => false }).deps });
  for (const c of JSON.parse(j.out()) as Record<string, unknown>[]) {
    assert.ok(!("say" in c), "--json is unchanged: no wording keys");
    assert.equal(typeof c["message"], "string");
  }
});

test("doctor --json keeps its English messages and fixes verbatim (the screen words them from the catalogue; --json never changes)", async () => {
  const j = cliIo({});
  await doctorCommand(["--json"], j.io, { deps: fakeDeps({ probe: async () => false, env: { CLAUDE_CONFIG_DIR: "C:/x" } }).deps });
  const by = new Map((JSON.parse(j.out()) as Check[]).map((c) => [c.id, c]));
  assert.deepEqual(by.get("node-version"), { id: "node-version", status: "ok", message: "Node 22.18.0" });
  assert.deepEqual(by.get("lock"), { id: "lock", status: "ok", message: "free" });
  assert.deepEqual(by.get("claude-env"), {
    id: "claude-env", status: "warn", message: "T3 Code started from this shell would read C:/x as its default account",
    fix: "Start T3 Code from the Start menu, not from this shell",
  });
  assert.equal(by.get("t3-reachable")!.message, "T3 Code is not answering at http://127.0.0.1:3773");
  assert.equal(by.get("t3-reachable")!.fix, "Open T3 Code from the Start menu");
  assert.deepEqual(by.get("t3-token"), { id: "t3-token", status: "skip", message: "needs a running T3 Code" });
  assert.equal(by.get("pending-mtimes")!.message, "no transcript file time is left bumped");
});
