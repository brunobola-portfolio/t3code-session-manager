import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendSyncLog, failedImports, filterForSync, logLine, runSyncCycle, summaryLines, zeroCounts, type CycleOutcome, type SyncCycleDeps,
} from "../../src/ops/sync.ts";
import { defaultConfig, saveConfig } from "../../src/core/config.ts";
import { createClaudeAdapter } from "../../src/sources/claude.ts";
import { RpcClosed } from "../../src/t3/errors.ts";
import { acquireLock } from "../../src/core/lock.ts";
import type { Plan, PlanItem } from "../../src/core/types.ts";
import type { T3Api, T3Project } from "../../src/t3/api.ts";
import type { SourceAdapter } from "../../src/sources/types.ts";
import { T3Incompatible } from "../../src/t3/errors.ts";
import { DAY, fakeT3, inst, tempHome, transcript, type FakeT3 } from "../apply/fake-t3.ts";
import { sess } from "../plan/helpers.ts";

const ROOT = "C:/work/demo";
const ROOT2 = "C:/work/other";
const VERSION = "0.1.9-nightly.20261110.4465";

function item(root: string, over: { nativeId?: string; instanceId?: string; path?: string; kind?: "import" | "skip" } = {}): PlanItem {
  const s = sess({ cwd: root, nativeId: over.nativeId, path: over.path });
  if (over.kind === "skip") return { session: s, action: { kind: "skip", reason: "mirror-copy" }, notes: [] };
  const instanceId = over.instanceId ?? "claudeAgent";
  return { session: s, action: { kind: "import", projectRoot: root, instanceId, expectedThreadId: `import:${instanceId}:${s.nativeId}` }, notes: [] };
}

function plan(items: PlanItem[], over: Partial<Plan> = {}): Plan {
  return {
    version: 1, runId: "20261111-120000-abcd", createdAt: new Date().toISOString(), t3Version: VERSION,
    instancesToCreate: [], projectsToCreate: [], projectAccounts: [], projectDefaults: [], mirrorCopies: [], items, warnings: [], ...over,
  };
}

const project = (id: string, root: string, instanceId: string | null): T3Project =>
  ({ id, title: id, workspaceRoot: root, defaultModelSelection: instanceId ? { instanceId, model: "m" } : null, archived: false, deleted: false }) as T3Project;

test("filterForSync: an in-window mirror copy holds back its session (it is parked while its project imports); the rest goes on", () => {
  const kept = item(ROOT, { nativeId: "00000000-0000-4000-8000-0000000000aa" });
  const mirror = item(ROOT, { nativeId: "00000000-0000-4000-8000-0000000000aa", kind: "skip", path: "C:/Users/demo/.claude-org/projects/C--work-demo/00000000-0000-4000-8000-0000000000aa.jsonl" });
  const sameRoot = item(ROOT);
  const other = item(ROOT2);
  const p = plan([kept, mirror, sameRoot, other], {
    mirrorCopies: [{ path: mirror.session.file.path, nativeId: mirror.session.nativeId, keptPath: kept.session.file.path, relation: "identical" }],
    projectsToCreate: [{ root: ROOT, title: "demo", defaultInstanceId: "claudeAgent" }, { root: ROOT2, title: "other", defaultInstanceId: "claudeAgent" }],
    projectDefaults: [{ root: ROOT, instanceId: "claudeAgent" }, { root: ROOT2, instanceId: "claudeAgent" }],
  });
  const r = filterForSync(p, { liveMirrorPaths: new Set([mirror.session.file.path]), projects: [], platform: "win32" });
  assert.equal(r.heldForDedupe, 1);
  assert.equal(r.heldForAccounts, 0);
  const imports = r.plan.items.filter((i) => i.action.kind !== "skip");
  assert.deepEqual(imports.map((i) => i.session.nativeId).sort(), [sameRoot.session.nativeId, other.session.nativeId].sort());
  assert.deepEqual(r.plan.mirrorCopies, [], "the held mirror copy is only warned about by apply");
  assert.deepEqual(r.plan.projectsToCreate.map((x) => x.root), [ROOT, ROOT2]);
  assert.equal(p.items.length, 4, "input untouched");
});

test("filterForSync: a session that failed after its last change waits for `t3sm apply`; one changed since is retried", () => {
  const failed = item(ROOT);
  const changed = item(ROOT);
  const fresh = item(ROOT);
  const mt = failed.session.file.mtimeMs;
  const failedBefore = new Map([[`claude:${failed.session.nativeId}`, mt + 1000], [`claude:${changed.session.nativeId}`, changed.session.file.mtimeMs - 1000]]);
  const r = filterForSync(plan([failed, changed, fresh]), { liveMirrorPaths: new Set(), projects: [], platform: "win32", failedBefore });
  assert.equal(r.heldFailed, 1);
  assert.deepEqual(r.plan.items.map((i) => i.session.nativeId).sort(), [changed, fresh].map((i) => i.session.nativeId).sort());
});

test("filterForSync: a failed convert-mode session backs off on its own updatedAt, not the shared db's mtime", () => {
  const conv = (nativeId: string, updatedMs: number): PlanItem => {
    const s = { ...sess({ harness: "opencode", accountId: null, nativeId, cwd: ROOT }), updatedAt: new Date(updatedMs).toISOString() };
    s.file = { ...s.file, path: "C:/Users/demo/.local/share/opencode/opencode.db", mtimeMs: Date.now() }; // touched by another session just now
    return { session: s, action: { kind: "convert-import", projectRoot: ROOT, instanceId: "claudeAgent", expectedThreadId: `import:claudeAgent:${nativeId}`, uuid: nativeId, targetFile: "x" }, notes: [] };
  };
  const t0 = Date.now() - 5 * DAY;
  const stale = conv("ses_stale", t0);
  const moved = conv("ses_moved", t0 + 2 * DAY);
  const failedBefore = new Map([["opencode:ses_stale", t0 + DAY], ["opencode:ses_moved", t0 + DAY]]);
  const r = filterForSync(plan([stale, moved]), { liveMirrorPaths: new Set(), projects: [], platform: "win32", failedBefore });
  assert.equal(r.heldFailed, 1, "the db's fresh mtime does not release the back-off");
  assert.deepEqual(r.plan.items.map((i) => i.session.nativeId), ["ses_moved"]);
  // Per session, not per harness: a compressed Codex session (convert mode) backs off on its activity too (a file
  // rewritten by Codex with the same conversation does not retry the failed conversion).
  const cx = conv("0190aaaa-0000-7000-8000-00000000c0de", t0);
  const zst: PlanItem = { ...cx, session: { ...cx.session, harness: "codex", mode: "convert", flags: ["compressed"] } };
  const r2 = filterForSync(plan([zst]), { liveMirrorPaths: new Set(), projects: [], platform: "win32", failedBefore: new Map([[`codex:${zst.session.nativeId}`, t0 + DAY]]) });
  assert.equal(r2.heldFailed, 1);
});

test("failedImports: the newest import-failed entry per session, timed by its run id", () => {
  const m = failedImports([
    { t: "import-failed", runId: "20261110-080000-aaaa", harness: "claude", nativeId: "s1", reason: "not-imported" },
    { t: "import-failed", runId: "20261111-093015-bbbb", harness: "claude", nativeId: "s1", reason: "not-imported" },
    { t: "import-failed", runId: "garbage", harness: "codex", nativeId: "s2", reason: "not-imported" },
  ]);
  assert.equal(m.get("claude:s1"), Date.UTC(2026, 10, 11, 9, 30, 15));
  assert.equal(m.has("codex:s2"), false);
});

test("filterForSync: an out-of-window mirror copy holds nothing and stays for apply's own re-check", () => {
  const kept = item(ROOT);
  const mirror = item(ROOT, { nativeId: kept.session.nativeId, kind: "skip", path: "C:/x/mirror.jsonl" });
  const p = plan([kept, mirror], { mirrorCopies: [{ path: "C:/x/mirror.jsonl", nativeId: kept.session.nativeId, keptPath: kept.session.file.path, relation: "prefix" }] });
  const r = filterForSync(p, { liveMirrorPaths: new Set(), projects: [], platform: "win32" });
  assert.equal(r.heldForDedupe, 0);
  assert.equal(r.plan.items.filter((i) => i.action.kind === "import").length, 1);
  assert.equal(r.plan.mirrorCopies.length, 1);
});

test("filterForSync: never creates instances; sessions for a missing instance wait for `accounts --apply`", () => {
  const a = item(ROOT, { instanceId: "claude-org" });
  const b = item(ROOT2);
  const p = plan([a, b], {
    instancesToCreate: [{ id: "claude-org", driver: "claudeAgent", displayName: "Org", accentColor: null, homePath: "C:/Users/demo/.claude-org", environment: [] }],
    projectsToCreate: [{ root: ROOT, title: "demo", defaultInstanceId: "claude-org" }, { root: ROOT2, title: "other", defaultInstanceId: "claudeAgent" }],
    projectDefaults: [{ root: ROOT, instanceId: "claude-org" }, { root: ROOT2, instanceId: "claudeAgent" }],
  });
  const r = filterForSync(p, { liveMirrorPaths: new Set(), projects: [], platform: "win32" });
  assert.equal(r.heldForAccounts, 1);
  assert.deepEqual(r.plan.instancesToCreate, []);
  assert.deepEqual(r.plan.items.map((i) => i.session.nativeId), [b.session.nativeId]);
  assert.deepEqual(r.plan.projectsToCreate.map((x) => x.root), [ROOT2]);
  assert.deepEqual(r.plan.projectDefaults, [{ root: ROOT2, instanceId: "claudeAgent" }]);
});

test("filterForSync: never overrides a default the user chose in T3; sets it only for new or default-less projects", () => {
  const p = plan([item(ROOT), item(ROOT2), item("C:/work/third")], {
    projectsToCreate: [{ root: "C:/work/third", title: "third", defaultInstanceId: "claudeAgent" }],
    projectDefaults: [{ root: ROOT, instanceId: "claudeAgent" }, { root: ROOT2, instanceId: "claudeAgent" }, { root: "C:/work/third", instanceId: "claudeAgent" }],
  });
  const projects = [project("p1", "c:\\work\\demo", "claude-org"), project("p2", "C:/work/other/", null)];
  const r = filterForSync(p, { liveMirrorPaths: new Set(), projects, platform: "win32" });
  assert.deepEqual(r.plan.projectDefaults.map((d) => d.root), [ROOT2, "C:/work/third"]);
});

// ---------- runSyncCycle against a fake T3 ----------

function adapterOf(items: PlanItem[]): SourceAdapter {
  return { id: "claude", mode: "native", isAvailable: async () => true, async *discover() { for (const i of items) yield i.session; } };
}

/** getConfig reporting claudeAgent's home, so the planner maps the temp account onto it. */
function withHome(f: FakeT3, home: string): T3Api {
  return { ...f.api, getConfig: async () => ({ settings: { providerInstances: { claudeAgent: { driver: "claudeAgent", config: { homePath: home } } } }, providers: [] }) } as T3Api;
}

function cycleEnv(f: FakeT3) {
  const t = tempHome();
  const connects = { n: 0 };
  const deps = (items: PlanItem[], over: Partial<SyncCycleDeps> = {}): SyncCycleDeps => ({
    home: t.home, stateDir: t.state, env: { T3SM_HOME: t.state }, now: Date.now,
    adapters: [adapterOf(items)], existsDir: async () => true, isT3Running: async () => true,
    connect: async () => { connects.n++; return withHome(f, join(t.home, ".claude")); },
    signals: { on() {}, off() {} },
    ...over,
  });
  return { ...t, deps, connects };
}

test("runSyncCycle imports a new session, writes the run's plan.md (no plan.json) and journals under the same run id", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const items = [transcript(f, e.dir, ROOT, Date.now() - 3 * DAY)];
  const o = await runSyncCycle(e.deps(items));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  if (o.kind !== "ok") return;
  assert.equal(o.counts.imported, 1);
  assert.ok(o.runId);
  const runDir = join(e.state, "runs", o.runId!);
  assert.match(readFileSync(join(runDir, "plan.md"), "utf8"), /^# t3sm plan /);
  assert.ok(!existsSync(join(runDir, "plan.json")), "a sync plan never becomes `apply`'s latest plan");
  const journal = readFileSync(join(e.state, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(journal[0].t, "run-start");
  assert.equal(journal[0].runId, o.runId);
  assert.match(journal[0].command, /^sync /);
  assert.equal(journal.at(-1).t, "run-end");
  assert.equal(e.connects.n, 1, "one T3 session per cycle: the plan's connection is reused for apply");
  assert.equal(f.calls.filter((c) => c === "close").length, 1);
});

test("runSyncCycle: a Codex session already in T3 as a Codex thread is never converted into a second (Claude) thread once compressed", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const id = "0190eeee-0000-7000-8000-000000000001";
  const s = { ...sess({ harness: "codex", nativeId: id, accountId: null, cwd: ROOT, path: join(e.dir, `rollout-2026-01-01T00-00-00-${id}.jsonl.zst`), flags: ["compressed"] }), mode: "convert" as const, cwdOffsetBytes: 0 };
  f.threads.set(`import:codex:${id}`, { id: `import:codex:${id}`, projectId: "p0", instanceId: "codex", archived: false, title: "t", updatedAt: Date.now() });
  const item: PlanItem = { session: s, action: { kind: "skip", reason: "excluded" }, notes: [] };
  const d = await runSyncCycle(e.deps([item], { dryRun: true }));
  assert.equal(d.kind, "dry-run");
  if (d.kind === "dry-run") assert.equal(d.counts.wouldImport, 0);
  const o = await runSyncCycle(e.deps([item]));
  assert.equal(o.kind, "noop", JSON.stringify(o));
  assert.ok(!f.calls.some((c) => c.startsWith("create:") || c.startsWith("import:") || c === "scan"));
  assert.ok(!existsSync(join(e.state, "journal.jsonl")), "nothing converted, nothing journaled");
});

function writeConfig(home: string, state: string, over: { maxUnattendedImports?: number; org?: boolean } = {}): void {
  const accounts = [{ id: "claudeAgent", home: join(home, ".claude"), displayName: "Claude", accentColor: null }];
  if (over.org) accounts.push({ id: "claude-org", home: join(home, ".claude-org"), displayName: "Org", accentColor: null });
  const c = defaultConfig(accounts);
  if (over.maxUnattendedImports !== undefined) c.sync.maxUnattendedImports = over.maxUnattendedImports;
  return void saveConfig(state, c);
}

test("runSyncCycle: more pending imports than sync.maxUnattendedImports -> over-limit, nothing written", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  await writeConfig(e.home, e.state, { maxUnattendedImports: 1 });
  const items = [transcript(f, e.dir, ROOT, Date.now() - 3 * DAY), transcript(f, e.dir, ROOT, Date.now() - 4 * DAY)];
  const o = await runSyncCycle(e.deps(items));
  assert.deepEqual(o, { kind: "over-limit", pending: 2, limit: 1 });
  assert.ok(!existsSync(join(e.state, "journal.jsonl")));
  assert.ok(!existsSync(join(e.state, "runs")));
  assert.ok(!f.calls.some((c) => c.startsWith("create:") || c === "scan"));
  const d = await runSyncCycle(e.deps(items, { dryRun: true }));
  assert.equal(d.kind, "dry-run");
  if (d.kind === "dry-run") assert.equal(d.overLimit, 1);
});

test("runSyncCycle with real files: an in-window mirror copy holds its session, is parked while the project imports, never imported", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const claudeHome = join(e.home, ".claude");
  const orgHome = join(e.home, ".claude-org");
  await writeConfig(e.home, e.state, { org: true });
  f.opts.instances = [inst("claudeAgent", claudeHome), inst("claude-org", orgHome)];
  const api = { ...f.api, getConfig: async () => ({ settings: { providerInstances: {
    claudeAgent: { driver: "claudeAgent", config: { homePath: claudeHome } }, "claude-org": { driver: "claudeAgent", config: { homePath: orgHome } },
  } }, providers: [] }) } as T3Api;
  const now = Date.now();
  const kept = transcript(f, e.dir, ROOT, now - 3 * DAY);
  const other = transcript(f, e.dir, ROOT, now - 5 * DAY);
  const orgDir = join(orgHome, "projects", "C--work-demo");
  mkdirSync(orgDir, { recursive: true });
  const mirrorPath = join(orgDir, `${kept.session.nativeId}.jsonl`);
  copyFileSync(kept.session.file.path, mirrorPath);
  const mt = (now - 2 * DAY) / 1000;
  utimesSync(mirrorPath, mt, mt);
  const mirror: PlanItem = { ...kept, session: { ...kept.session, accountId: "claude-org", file: { ...kept.session.file, path: mirrorPath, mtimeMs: now - 2 * DAY, atimeMs: now - 2 * DAY } } };
  const mirrorTid = `import:claude-org:${kept.session.nativeId}`;
  f.files.push({ path: mirrorPath, root: ROOT, threadId: mirrorTid });
  const o = await runSyncCycle(e.deps([kept, other, mirror], { connect: async () => api }));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  if (o.kind !== "ok") return;
  assert.equal(o.counts.heldForDedupe, 1);
  assert.equal(o.counts.imported, 1);
  assert.ok(f.threads.has(`import:claudeAgent:${other.session.nativeId}`));
  assert.ok(!f.threads.has(mirrorTid), "mirror never imported under the org account");
  assert.ok(!f.threads.has(`import:claudeAgent:${kept.session.nativeId}`), "its session waits for dedupe");
  assert.ok(Math.abs(statSync(mirrorPath).mtimeMs - (now - 2 * DAY)) <= 2, "mirror parked and restored");
  const bump = readFileSync(join(e.state, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((x) => x.t === "mtime-bump");
  assert.ok(bump.files.some((x: { path: string; targetMtimeMs: number }) => x.path === mirrorPath && x.targetMtimeMs > now), "the mirror was parked in the future during the wave");
});

test("runSyncCycle: a cycle whose only work is held (a session of the project in use) is a no-op: nothing written, held-in-use logged", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const a = transcript(f, e.dir, ROOT, Date.now() - 3 * DAY);
  const live = transcript(f, e.dir, ROOT, Date.now() - 4 * DAY);
  utimesSync(live.session.file.path, new Date(), new Date());
  live.session.file.mtimeMs = Date.now() - 4 * DAY; // the plan still sees it idle: the pre-check catches it
  const o = await runSyncCycle(e.deps([a, live]));
  assert.equal(o.kind, "noop", JSON.stringify(o));
  if (o.kind !== "noop") return;
  assert.equal(o.counts.imported, 0);
  assert.equal(o.counts.heldInUse, 2);
  assert.match(logLine(o, Date.now()), / noop held-in-use=2 /);
  assert.ok(!existsSync(join(e.state, "journal.jsonl")), "no run-start");
  assert.ok(!existsSync(join(e.state, "runs")), "no run folder");
  assert.ok(!f.calls.some((c) => c.startsWith("create:")), "no project created");
});

test("runSyncCycle: a crash's pending file times are restored even while T3 stays closed (lock + recovery before the probe)", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const t = transcript(null, e.dir, ROOT, Date.now() - 3 * DAY);
  const orig = t.session.file;
  const target = Date.now() + 24 * 3_600_000; // parked in the future when the crash happened
  utimesSync(orig.path, target / 1000, target / 1000);
  mkdirSync(e.state, { recursive: true });
  writeFileSync(join(e.state, "journal.jsonl"), JSON.stringify({ t: "mtime-bump", runId: "20261111-120000-dead", files: [{ path: orig.path, atimeMs: orig.atimeMs, mtimeMs: orig.mtimeMs, targetMtimeMs: target }] }) + "\n");
  const o = await runSyncCycle(e.deps([], { isT3Running: async () => false }));
  assert.equal(o.kind, "t3-down");
  assert.ok(Math.abs(statSync(orig.path).mtimeMs - orig.mtimeMs) <= 2, "file time restored");
  assert.deepEqual(o.recovered, { restored: 1, failed: 0 });
  assert.match(logLine(o, Date.now()), / t3-down recovered=1 failed=0$/);
  assert.equal((await runSyncCycle(e.deps([], { isT3Running: async () => false }))).recovered, undefined, "nothing recovered: no field, no log noise");
  assert.match(readFileSync(join(e.state, "journal.jsonl"), "utf8"), /"t":"mtime-restore"/);
  assert.ok(!existsSync(join(e.state, "lock")), "lock released");
});

test("runSyncCycle: an unreachable T3 (fetch failed) is t3-down; a connection lost mid-run keeps the run id", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }) });
  assert.deepEqual(await runSyncCycle(e.deps([], { connect: async () => { throw refused; } })), { kind: "t3-down" });
  const g = fakeT3({ importError: () => new RpcClosed() });
  const e2 = cycleEnv(g);
  const o = await runSyncCycle(e2.deps([transcript(g, e2.dir, ROOT, Date.now() - 3 * DAY)]));
  assert.equal(o.kind, "t3-down");
  assert.match((o as { runId?: string }).runId ?? "", /^\d{8}-\d{6}-/);
});

test("runSyncCycle --dry-run writes no discovery cache; an idle real cycle does not rewrite it", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const adapter = createClaudeAdapter();
  const items = [transcript(f, e.dir, ROOT, Date.now() - 3 * DAY)];
  const cache = join(e.state, "cache", "claude-discovery.json");
  await writeConfig(e.home, e.state);
  const d = await runSyncCycle(e.deps(items, { dryRun: true, adapters: [adapter] }));
  assert.equal(d.kind, "dry-run", JSON.stringify(d));
  assert.ok(!existsSync(cache), "dry-run wrote no cache");
  assert.equal((await runSyncCycle(e.deps(items, { adapters: [adapter] }))).kind, "ok");
  const before = statSync(cache).mtimeMs;
  const raw = readFileSync(cache, "utf8");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await runSyncCycle(e.deps(items, { adapters: [adapter] }))).kind, "noop");
  assert.equal(readFileSync(cache, "utf8"), raw);
  assert.equal(statSync(cache).mtimeMs, before, "unchanged cache not rewritten");
});

test("runSyncCycle: a cycle with nothing to import writes nothing (no journal entry, no run directory)", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const items = [transcript(f, e.dir, ROOT, Date.now() - 3 * DAY)];
  assert.equal((await runSyncCycle(e.deps(items))).kind, "ok");
  const journal = readFileSync(join(e.state, "journal.jsonl"), "utf8");
  const runs = readdirSync(join(e.state, "runs"));
  const o = await runSyncCycle(e.deps(items));
  assert.equal(o.kind, "noop", JSON.stringify(o));
  assert.equal(readFileSync(join(e.state, "journal.jsonl"), "utf8"), journal, "journal unchanged");
  assert.deepEqual(readdirSync(join(e.state, "runs")), runs, "no new run directory");
  assert.ok(!existsSync(join(e.state, "lock")));

  const g = fakeT3();
  const fresh = cycleEnv(g);
  assert.equal((await runSyncCycle(fresh.deps([]))).kind, "noop");
  assert.ok(!existsSync(join(fresh.state, "journal.jsonl")));
  assert.ok(!existsSync(join(fresh.state, "runs")));
});

test("runSyncCycle: T3 not running -> t3-down without any connection; nothing written (the lock is only taken and released)", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const o = await runSyncCycle(e.deps([], { isT3Running: async () => false }));
  assert.deepEqual(o, { kind: "t3-down" });
  assert.equal(e.connects.n, 0);
  assert.ok(!existsSync(join(e.state, "journal.jsonl")));
  assert.ok(!existsSync(join(e.state, "runs")));
  assert.ok(!existsSync(join(e.state, "lock")));
});

test("runSyncCycle: lock held -> locked, T3 untouched", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const lock = await acquireLock(e.state);
  try {
    const o = await runSyncCycle(e.deps([transcript(f, e.dir, ROOT, Date.now() - 3 * DAY)]));
    assert.deepEqual(o, { kind: "locked" });
    assert.equal(e.connects.n, 0);
    assert.deepEqual(f.calls, []);
  } finally { await lock!.release(); }
});

test("runSyncCycle: untested T3 version -> error exit 4, nothing written", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const o = await runSyncCycle(e.deps([], { connect: async () => { throw new T3Incompatible("9.9.9", "T3Code 9.9.9 is not a tested version."); } }));
  assert.equal(o.kind, "error");
  if (o.kind === "error") assert.equal(o.exitCode, 4);
  assert.ok(!existsSync(join(e.state, "journal.jsonl")));
  assert.ok(!existsSync(join(e.state, "runs")));
});

test("runSyncCycle: claudeAgent reading another home (InstanceHomeDrift) -> error exit 2, nothing written", async () => {
  const f = fakeT3({ instances: [] });
  const e = cycleEnv(f);
  const other = join(e.home, ".claude-other");
  f.opts.instances = [inst("claudeAgent", other)];
  const api = { ...f.api, getConfig: async () => ({ settings: { providerInstances: { claudeAgent: { driver: "claudeAgent", config: { homePath: other } } } }, providers: [] }) } as T3Api;
  const items = [transcript(f, e.dir, ROOT, Date.now() - 3 * DAY)];
  const o = await runSyncCycle(e.deps(items, { connect: async () => api }));
  assert.equal(o.kind, "error", JSON.stringify(o));
  if (o.kind === "error") {
    assert.equal(o.exitCode, 2);
    assert.equal((o.error as Error).name, "InstanceHomeConfigured"); // an explicit settings entry: the distinct drift error
  }
  assert.ok(!f.calls.some((c) => c.startsWith("add:") || c.startsWith("create:") || c === "scan"));
  assert.ok(!existsSync(join(e.state, "journal.jsonl")));
});

test("runSyncCycle --dry-run: counts what a cycle would import and writes nothing (no lock, journal or run)", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const items = [transcript(f, e.dir, ROOT, Date.now() - 3 * DAY), transcript(f, e.dir, ROOT, Date.now() - 4 * DAY)];
  const o = await runSyncCycle(e.deps(items, { dryRun: true }));
  assert.equal(o.kind, "dry-run");
  if (o.kind === "dry-run") {
    assert.equal(o.counts.wouldImport, 2);
    assert.deepEqual(o.byHarness, { claude: 2 });
    assert.equal(o.newProjects, 1);
  }
  assert.ok(!f.calls.some((c) => c !== "close"), "read-only");
  assert.ok(!existsSync(join(e.state, "journal.jsonl")));
  assert.ok(!existsSync(join(e.state, "runs")));
});

test("runSyncCycle exposes afterApply (Task 23 merge hook) under the lock: with the run id, and on a no-op cycle", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const items = [transcript(f, e.dir, ROOT, Date.now() - 3 * DAY)];
  const seen: (string | null)[] = [];
  const afterApply: SyncCycleDeps["afterApply"] = async (ctx) => {
    assert.ok(existsSync(join(e.state, "lock")), "lock held");
    assert.equal(typeof ctx.api.listThreads, "function");
    seen.push(ctx.runId);
  };
  const a = await runSyncCycle(e.deps(items, { afterApply }));
  await runSyncCycle(e.deps(items, { afterApply }));
  assert.deepEqual(seen, [a.kind === "ok" ? a.runId : "x", null]);
});

test("appendSyncLog rotates at the size limit and keeps three old logs", async () => {
  const t = tempHome();
  const line = "x".repeat(99);
  for (let i = 0; i < 25; i++) await appendSyncLog(t.state, `${line}${i % 10}`, { maxBytes: 500 });
  const logs = readdirSync(join(t.state, "logs")).sort();
  assert.deepEqual(logs, ["sync.log", "sync.log.1", "sync.log.2", "sync.log.3"]);
  for (const l of logs) assert.ok(readFileSync(join(t.state, "logs", l)).length <= 500, l);
  assert.match(readFileSync(join(t.state, "logs", "sync.log"), "utf8"), /x4\n$/);
});

test("logLine: counts and run ids only, never paths or messages", () => {
  const at = Date.UTC(2026, 10, 11, 12, 0, 0);
  const counts = { ...zeroCounts(), imported: 2, failed: 1, heldForDedupe: 3, heldInUse: 4, heldFailed: 5 };
  assert.equal(logLine({ kind: "partial", runId: "20261111-120000-abcd", counts }, at),
    "2026-11-11T12:00:00.000Z partial run=20261111-120000-abcd imported=2 failed=1 deferred=0 parked=0 held-in-use=4 held-dedupe=3 held-accounts=0 held-failed=5");
  assert.equal(logLine({ kind: "t3-down" }, at), "2026-11-11T12:00:00.000Z t3-down");
  assert.equal(logLine({ kind: "t3-down", runId: "20261111-120000-abcd" }, at), "2026-11-11T12:00:00.000Z t3-down run=20261111-120000-abcd");
  assert.equal(logLine({ kind: "over-limit", pending: 3806, limit: 200 }, at), "2026-11-11T12:00:00.000Z over-limit pending=3806 limit=200");
  const err: CycleOutcome = { kind: "error", exitCode: 2, error: Object.assign(new Error("C:/Users/demo/.claude/projects/secret.jsonl is bad"), { name: "ApplyRefusal" }) };
  assert.equal(logLine(err, at), "2026-11-11T12:00:00.000Z error exit=2 ApplyRefusal");
});

test("summaryLines: held sessions are reported, not aborted; over-limit explains the one-time apply", () => {
  const counts = { ...zeroCounts(), imported: 4, deferred: 3, heldForDedupe: 2, heldForAccounts: 1, heldInUse: 3, heldFailed: 2 };
  const lines = summaryLines({ kind: "ok", runId: "r1", counts });
  assert.deepEqual(lines, [
    "Imported 4, failed 0. Run r1.",
    "3 sessions wait: a session of their project is in use (next cycle).",
    "2 sessions wait for `t3sm dedupe`.",
    "1 session waits for `t3sm accounts --apply`.",
    "2 sessions failed before; `t3sm apply` retries them.",
  ]);
  assert.deepEqual(summaryLines({ kind: "noop", runId: null, counts: zeroCounts() }), ["Nothing to import."]);
  assert.deepEqual(summaryLines({ kind: "over-limit", pending: 3806, limit: 200 }), ["3806 sessions pending; run `t3sm apply` once to import them."]);
});

test("runSyncCycle never pins T3's default instance (unattended); an implicit and drifted one stops the cycle with exit 2", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  await writeConfig(e.home, e.state, {});
  const pins: string[] = [];
  (f.api as { pinInstanceHome: unknown }).pinInstanceHome = async (id: string) => { pins.push(id); return { previous: null, changed: true }; };
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude"))];
  const a = transcript(f, e.dir, ROOT, Date.now() - 40 * DAY);
  const o = await runSyncCycle(e.deps([a]));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  assert.deepEqual(pins, [], "sync leaves the implicit instance as it is");
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude-org"))];
  const d = await runSyncCycle(e.deps([transcript(f, e.dir, ROOT, Date.now() - 41 * DAY)]));
  assert.equal(d.kind, "error");
  if (d.kind === "error") assert.equal(d.exitCode, 2);
  assert.deepEqual(pins, []);
});

test("B15: the sync log line carries parked=N", async () => {
  const { logLine } = await import("../../src/ops/sync.ts");
  const line = logLine({ kind: "ok", runId: "r1", counts: { ...(await import("../../src/ops/sync.ts")).zeroCounts(), imported: 1, parked: 3 } }, Date.parse("2026-11-11T12:00:00Z"));
  assert.match(line, / parked=3\b/);
});
