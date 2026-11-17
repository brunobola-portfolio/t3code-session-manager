import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendSyncLog, failedImports, filterForSync, logLine, resultSummary, runSyncCycle, summaryLines, zeroCounts, type CycleOutcome, type SyncCycleDeps,
} from "../../src/ops/sync.ts";
import { defaultConfig, saveConfig } from "../../src/core/config.ts";
import { createClaudeAdapter } from "../../src/sources/claude.ts";
import { RpcClosed } from "../../src/t3/errors.ts";
import { acquireLock } from "../../src/core/lock.ts";
import type { Config, Plan, PlanItem } from "../../src/core/types.ts";
import type { T3Api, T3Project } from "../../src/t3/api.ts";
import type { SourceAdapter } from "../../src/sources/types.ts";
import { T3Incompatible } from "../../src/t3/errors.ts";
import { statusCommand } from "../../src/cli/commands/status.ts";
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
  ({ id, title: id, workspaceRoot: root, defaultModelSelection: instanceId ? { instanceId, model: "m" } : null, archived: false, deleted: false, pinned: false, createdAt: null }) as T3Project;

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
    home: t.home, stateDir: t.state, env: { T3SM_HOME: t.state, LANG: "en_US.UTF-8" }, now: Date.now,
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

/**
 * Awaited by every caller: a cycle started before config.json is on disk plans with the defaults (no limit of 1, no
 * organize decisions). It used to return `void saveConfig(...)`, so `await writeConfig(...)` did not wait for the write.
 */
async function writeConfig(home: string, state: string, over: { maxUnattendedImports?: number; org?: boolean; organize?: Config["organize"] } = {}): Promise<void> {
  const accounts = [{ id: "claudeAgent", home: join(home, ".claude"), displayName: "Claude", accentColor: null }];
  if (over.org) accounts.push({ id: "claude-org", home: join(home, ".claude-org"), displayName: "Org", accentColor: null });
  const c = defaultConfig(accounts);
  if (over.maxUnattendedImports !== undefined) c.sync.maxUnattendedImports = over.maxUnattendedImports;
  if (over.organize !== undefined) c.organize = over.organize;
  await saveConfig(state, c);
}

test("runSyncCycle: more pending imports than sync.maxUnattendedImports -> over-limit, nothing written", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  await writeConfig(e.home, e.state, { maxUnattendedImports: 1 });
  const base = Date.now(); // one reading: the session ages and the cycle's clock come from it, never from two separate Date.now() calls
  const items = [transcript(f, e.dir, ROOT, base - 3 * DAY), transcript(f, e.dir, ROOT, base - 4 * DAY)];
  const o = await runSyncCycle(e.deps(items, { now: () => base }));
  assert.deepEqual(o, { kind: "over-limit", pending: 2, limit: 1 });
  assert.ok(!existsSync(join(e.state, "journal.jsonl")));
  assert.ok(!existsSync(join(e.state, "runs")));
  assert.ok(!f.calls.some((c) => c.startsWith("create:") || c === "scan"));
  const d = await runSyncCycle(e.deps(items, { dryRun: true, now: () => base }));
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

test("runSyncCycle: a cycle whose only work is held creates the (empty) project, carries `held` into the outcome and sync-status, logs only a count; the next cycle writes nothing", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const a = transcript(f, e.dir, ROOT, Date.now() - 3 * DAY);
  const live = transcript(f, e.dir, ROOT, Date.now() - 4 * DAY);
  appendFileSync(live.session.file.path, `{"type":"custom-title","customTitle":"Synthetic work","sessionId":"${live.session.nativeId}"}\n`);
  utimesSync(live.session.file.path, new Date(), new Date());
  live.session.file.mtimeMs = Date.now() - 4 * DAY; // the plan still sees it idle: the pre-check catches it
  const o = await runSyncCycle(e.deps([a, live]));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  if (o.kind !== "ok") return;
  assert.equal(o.counts.imported, 0);
  assert.equal(o.counts.heldInUse, 2);
  assert.equal(f.calls.filter((c) => c.startsWith("create:")).length, 1, "the held project is created");
  assert.ok(!f.calls.some((c) => c === "scan" || c.startsWith("import:")), "nothing imported");
  assert.deepEqual(o.held?.map((h) => [h.project, h.root, h.file, h.title]), [["demo", ROOT, live.session.file.path, "Synthetic work"]]);
  assert.equal(typeof o.held?.[0]?.modifiedAt, "string");
  assert.ok(summaryLines(o).includes("waiting: demo — 'Synthetic work' written just now; retried after 10 min idle"), summaryLines(o).join("\n"));
  const s = resultSummary(o);
  // The watcher's heartbeat (lastResult in sync-status.json): names and time only, never a path (SECURITY.md).
  assert.deepEqual(s["held"], [{ project: "demo", title: "Synthetic work", modifiedAt: o.held![0]!.modifiedAt }]);
  const text = JSON.stringify(s);
  for (const p of [ROOT, live.session.file.path, e.home]) {
    assert.ok(!text.includes(JSON.stringify(p).slice(1, -1)) && !text.includes(p), `no path in the heartbeat: ${text}`);
  }
  const line = logLine(o, Date.now());
  assert.match(line, / held-projects=1( |$)/);
  assert.ok(!/Synthetic|demo|work/.test(line.replace(/held-\w+=/g, "")), `no names or titles in the log: ${line}`);

  const n = readFileSync(join(e.state, "journal.jsonl"), "utf8").trim().split("\n").length;
  f.projects[0]!.title = "General"; // the project as T3 shows it now (a General folder, or renamed by the user)
  const o2 = await runSyncCycle(e.deps([a, live]));
  assert.equal(o2.kind, "noop", JSON.stringify(o2));
  assert.equal(readFileSync(join(e.state, "journal.jsonl"), "utf8").trim().split("\n").length, n, "the second cycle writes nothing");
  assert.equal(f.calls.filter((c) => c.startsWith("create:")).length, 1);
  if (o2.kind !== "noop") return;
  assert.match(logLine(o2, Date.now()), / noop held-in-use=2 .*held-projects=1/);
  assert.deepEqual(o2.held?.map((h) => h.project), ["General"], "named as T3 shows it, not by its folder");
  assert.ok(summaryLines(o2).includes("waiting: General — 'Synthetic work' written just now; retried after 10 min idle"), summaryLines(o2).join("\n"));

  // A one-shot cycle (no watcher, no heartbeat) leaves the held list in sync-status.json: names and time only, no paths.
  const raw = JSON.parse(readFileSync(join(e.state, "sync-status.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys((raw["held"] as object[])[0]!).sort(), ["modifiedAt", "project", "since", "title"]);
  assert.ok(!("lastResult" in raw), "no heartbeat in a one-shot cycle");
  const show = async (): Promise<string> => {
    const out: string[] = [];
    await statusCommand([], { stdout: (x) => void out.push(x), stderr: () => {}, isTTY: false, prompt: async () => "", env: { T3SM_HOME: e.state } }, { home: e.home, readRuntime: async () => null });
    return out.join("");
  };
  assert.match(await show(), /General is waiting: 'Synthetic work' is in use \(first held (just now|\d+ min ago)\)/);
  // The next cycle that finds nothing held clears it.
  const old = new Date(Date.now() - 4 * DAY);
  utimesSync(live.session.file.path, old, old);
  const o3 = await runSyncCycle(e.deps([a, live]));
  assert.ok(o3.kind === "ok" || o3.kind === "noop", JSON.stringify(o3));
  assert.deepEqual((JSON.parse(readFileSync(join(e.state, "sync-status.json"), "utf8")) as { held: unknown[] }).held, []);
  assert.doesNotMatch(await show(), /is waiting:/);
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
  // A whole-second file time. The import cycle moves the file's time and puts it back through utimes, which takes
  // seconds as a double and keeps microseconds: a time with a fraction can come back 1 microsecond lower on Linux and
  // macOS (inside the +-2 ms the restore promises). The cache keys on the exact time, so such a file would be read
  // again and the cache rewritten once: nothing this test is about. Whole seconds survive the round trip exactly.
  const items = [transcript(f, e.dir, ROOT, Math.floor((Date.now() - 3 * DAY) / 1000) * 1000)];
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

// ---------- Task 17: sync honours decisions and organizes what it imported ----------

const GENERAL = "C:/T3 General";
const rehomeItem = (root: string, over: { copy?: "faithful"; inferred?: boolean } = {}): PlanItem => {
  const s = sess({ cwd: "C:/Users/demo" });
  return {
    session: s, notes: [],
    action: {
      kind: "convert-import", projectRoot: root, instanceId: "claudeAgent", expectedThreadId: `import:claudeAgent:${s.nativeId}`, uuid: s.nativeId, targetFile: "x",
      rehomeFrom: "C:/Users/demo", ...(over.copy === "faithful" ? { copy: "faithful" as const } : {}), ...(over.inferred ? { rehomeShare: { hits: 9, total: 10 } } : {}),
    },
  };
};
type Status = { needsAttention: { reason: string; detail: string; command: string; since: string } | null; undecided: Record<string, number>; heldRehome: number };
const statusOf = (state: string): Status => JSON.parse(readFileSync(join(state, "sync-status.json"), "utf8")) as Status;
const automatedItem = (it: PlanItem): PlanItem => { it.session.origin = "automated"; return it; };
const AUTOMATED_IMPORT: Config["organize"] = { decided: ["automated"], sessions: { automated: "import" } };

test("filterForSync: the General folder project is never created by sync; a rehome copy to a missing target is held (rehome-target-missing)", () => {
  const copy = rehomeItem(GENERAL, { copy: "faithful" });
  const inferred = rehomeItem("C:/work/inferred", { copy: "faithful", inferred: true });
  const plain = item(ROOT);
  const p = plan([copy, inferred, plain], {
    projectsToCreate: [{ root: GENERAL, title: "General", defaultInstanceId: "claudeAgent" }, { root: "C:/work/inferred", title: "inferred", defaultInstanceId: "claudeAgent" }, { root: ROOT, title: "demo", defaultInstanceId: "claudeAgent" }],
    projectDefaults: [{ root: GENERAL, instanceId: "claudeAgent" }, { root: ROOT, instanceId: "claudeAgent" }],
    decisionsPending: [{ key: "automated", sessions: 3, folders: 1 }],
  });
  const r = filterForSync(p, { liveMirrorPaths: new Set(), projects: [], platform: "win32", generalFolder: GENERAL });
  assert.equal(r.heldRehome, 2);
  assert.deepEqual(r.plan.items.map((i) => i.session.nativeId), [plain.session.nativeId]);
  assert.deepEqual(r.plan.projectsToCreate.map((x) => x.root), [ROOT], "General and the inferred folder are not created; a normal new project still is");
  assert.deepEqual(r.undecided, { automated: 3 });
});

test("filterForSync: General already in T3 takes its rehome copies; a deleted project is not a destination", () => {
  const copy = rehomeItem(GENERAL, { copy: "faithful" });
  const p = plan([copy], { projectsToCreate: [{ root: GENERAL, title: "General", defaultInstanceId: "claudeAgent" }] });
  const r = filterForSync(p, { liveMirrorPaths: new Set(), projects: [project("pg", "c:\\t3 general", "claudeAgent")], platform: "win32", generalFolder: GENERAL });
  assert.equal(r.heldRehome, 0);
  assert.equal(r.plan.items.length, 1);
  const gone = filterForSync(p, { liveMirrorPaths: new Set(), projects: [{ ...project("pg", GENERAL, "claudeAgent"), deleted: true }], platform: "win32", generalFolder: GENERAL });
  assert.equal(gone.heldRehome, 1);
});

test("filterForSync: a convert-import into a missing rehome target is held too (it would create that folder)", () => {
  const copy = rehomeItem("C:/work/inferred", { copy: "faithful", inferred: true });
  const conv = item("C:/work/inferred");
  conv.action = { kind: "convert-import", projectRoot: "C:/work/inferred", instanceId: "claudeAgent", expectedThreadId: "import:claudeAgent:x", uuid: "x", targetFile: "x" };
  const r = filterForSync(plan([copy, conv]), { liveMirrorPaths: new Set(), projects: [], platform: "win32", generalFolder: GENERAL });
  assert.equal(r.heldRehome, 2);
  assert.deepEqual(r.plan.items, []);
});

test("runSyncCycle: undecided sessions are not imported and set needsAttention undecided (since is kept across cycles)", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const base = Date.now();
  const a = automatedItem(transcript(f, e.dir, ROOT, base - 3 * DAY));
  const o = await runSyncCycle(e.deps([a], { now: () => base }));
  assert.equal(o.kind, "noop", JSON.stringify(o));
  if (o.kind !== "noop") return;
  assert.deepEqual(o.counts.undecided, { automated: 1 });
  assert.ok(!f.calls.some((c) => c.startsWith("create:") || c.startsWith("import:") || c === "scan"), "nothing written to T3");
  const s = statusOf(e.state);
  assert.deepEqual(s.needsAttention, { reason: "undecided", detail: "1 session in 1 category waits for your decision", command: "t3sm start", facts: { n: 1, q: 1 }, since: new Date(base).toISOString() });
  assert.deepEqual(s.undecided, { automated: 1 });
  await runSyncCycle(e.deps([a], { now: () => base + 3_600_000 }));
  assert.equal(statusOf(e.state).needsAttention?.since, new Date(base).toISOString(), "the first time this reason was seen");
  assert.ok(!/automated|C:|demo/.test(logLine(o, base)), "the log line stays counts-only");
});

test("runSyncCycle: once the question is answered the attention clears and the session imports", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const a = automatedItem(transcript(f, e.dir, ROOT, Date.now() - 3 * DAY));
  await runSyncCycle(e.deps([a]));
  assert.equal(statusOf(e.state).needsAttention?.reason, "undecided");
  await writeConfig(e.home, e.state, { organize: AUTOMATED_IMPORT });
  const o = await runSyncCycle(e.deps([a]));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  assert.equal(statusOf(e.state).needsAttention, null);
  assert.deepEqual(statusOf(e.state).undecided, {});
});

test("runSyncCycle: sync organizes only the threads it imported, in the same run (same run id; see the rollbackRun test below)", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  await writeConfig(e.home, e.state, { organize: AUTOMATED_IMPORT });
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude"))];
  f.projects.push(project("p0", ROOT, "claudeAgent"));
  const now = Date.now();
  const old = automatedItem(transcript(f, e.dir, ROOT, now - 5 * DAY));
  const oldId = `import:claudeAgent:${old.session.nativeId}`;
  f.threads.set(oldId, { id: oldId, projectId: "p0", instanceId: "claudeAgent", archived: false, title: "t", updatedAt: now - 5 * DAY });
  const fresh = automatedItem(transcript(f, e.dir, ROOT, now - 3 * DAY));
  const human = transcript(f, e.dir, ROOT, now - 4 * DAY);
  const o = await runSyncCycle(e.deps([old, fresh, human]));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  if (o.kind !== "ok") return;
  assert.equal(o.counts.imported, 2);
  assert.equal(o.counts.organized, 1);
  assert.ok(f.calls.includes(`archive:import:claudeAgent:${fresh.session.nativeId}`), f.calls.join("\n"));
  assert.ok(!f.calls.includes(`archive:${oldId}`), "a thread imported earlier is left to `t3sm organize`");
  assert.ok(!f.calls.includes(`archive:import:claudeAgent:${human.session.nativeId}`));
  const journal = readFileSync(join(e.state, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const changes = journal.filter((x) => x.t === "organize-change");
  assert.deepEqual(changes.map((x) => [x.kind, x.target, x.runId]), [["archive", `import:claudeAgent:${fresh.session.nativeId}`, o.runId]]);
  assert.equal(journal.filter((x) => x.t === "run-start").length, 1, "organize joins the sync run instead of opening another");
  assert.equal(journal.at(-1).t, "run-end");
  assert.match(logLine(o, now), / organized=1( |$)/);
});

test("runSyncCycle: sync never pins, deletes projects or changes settings", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  await writeConfig(e.home, e.state, { organize: AUTOMATED_IMPORT });
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude"))];
  f.projects.push(project("p9", "C:/work/empty", "claudeAgent")); // a project t3sm made earlier, now empty: a full organize would delete it
  mkdirSync(e.state, { recursive: true });
  writeFileSync(join(e.state, "journal.jsonl"), JSON.stringify({ t: "project-created", runId: "20261101-000000-aaaa", projectId: "p9", root: "C:/work/empty" }) + "\n");
  const now = Date.now();
  const items = [transcript(f, e.dir, ROOT, now - 3 * DAY), automatedItem(transcript(f, e.dir, ROOT2, now - 4 * DAY)), transcript(f, e.dir, "C:/work/third", now - 5 * DAY)];
  let pins = 0;
  (f.api as { pinInstanceHome: unknown }).pinInstanceHome = async () => { pins++; return { previous: null, changed: true }; };
  const o = await runSyncCycle(e.deps(items));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  assert.ok(f.calls.some((c) => c.startsWith("archive:")), "organize did run");
  const written = f.calls.filter((c) => /^(pin|delete-project|auto-settle|project-title|settle):/.test(c));
  assert.deepEqual(written, [], "no pin, unpin, delete, auto-settle, project rename or settle");
  assert.ok(!f.calls.some((c) => c.startsWith("add:")), "no instance created");
  assert.equal(pins, 0);
  assert.equal(f.autoSettleDays, 7);
  assert.equal(f.projects.find((p) => p.id === "p9")?.deleted, false);
  assert.ok(f.projects.every((p) => !p.pinned));
});

test("runSyncCycle: sync never asks T3 Code to write titles (spends tokens), even with organize.aiTitles.enabled (invariant 13)", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  // Titles off: a technical title is exactly what `organize --ai-titles` would hand to T3 Code.
  await writeConfig(e.home, e.state, { organize: { ...AUTOMATED_IMPORT, titles: false, aiTitles: { enabled: true, maxPerRun: 50 } } });
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude"))];
  const importSessions = f.api.importSessions;
  f.api.importSessions = async (projectId, root) => {
    const r = await importSessions(projectId, root);
    for (const t of f.threads.values()) t.title = "<command-name>/clear</command-name>"; // T3 titled them from a command
    return r;
  };
  const now = Date.now();
  const o = await runSyncCycle(e.deps([transcript(f, e.dir, ROOT, now - 3 * DAY), transcript(f, e.dir, ROOT, now - 4 * DAY)]));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  if (o.kind !== "ok") return;
  assert.equal(o.counts.imported, 2);
  assert.ok(!f.calls.some((c) => c.startsWith("ai-title:")), f.calls.join("\n"));
  const journal = readFileSync(join(e.state, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(!journal.some((x) => x.t === "organize-change" && x.kind === "ai-title"));
});

test("runSyncCycle: a rehome copy to a missing target is held, not created", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  await writeConfig(e.home, e.state, { organize: { decided: ["home"] } });
  const base = Date.now();
  const inHome = transcript(f, e.dir, e.home, base - 3 * DAY); // a conversation in the user's home folder, which T3 Code refuses
  const o = await runSyncCycle(e.deps([inHome], { now: () => base }));
  assert.equal(o.kind, "noop", JSON.stringify(o));
  if (o.kind !== "noop") return;
  assert.equal(o.counts.heldRehome, 1);
  assert.ok(!f.calls.some((c) => c.startsWith("create:") || c.startsWith("import:") || c === "scan"), "no General folder, nothing imported");
  assert.equal(f.projects.length, 0);
  assert.ok(!existsSync(join(e.state, "journal.jsonl")), "no copy written");
  assert.equal(statusOf(e.state).heldRehome, 1);
  assert.ok(summaryLines(o).some((l) => /destination folder/.test(l)), summaryLines(o).join("\n"));
  assert.match(logLine(o, base), / noop .*held-rehome=1/);
});

test("runSyncCycle: over-limit sets needsAttention with `t3sm start`; since is kept, and a later import clears it", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  await writeConfig(e.home, e.state, { maxUnattendedImports: 1 });
  const base = Date.now();
  const items = [transcript(f, e.dir, ROOT, base - 3 * DAY), transcript(f, e.dir, ROOT, base - 4 * DAY)];
  const o = await runSyncCycle(e.deps(items, { now: () => base }));
  assert.deepEqual(o, { kind: "over-limit", pending: 2, limit: 1 });
  const s = statusOf(e.state);
  assert.deepEqual(s.needsAttention, { reason: "over-limit", detail: "2 sessions pending; the unattended limit is 1", command: "t3sm start", facts: { n: 2, limit: 1 }, since: new Date(base).toISOString() });
  await runSyncCycle(e.deps(items, { now: () => base + 7_200_000 }));
  assert.equal(statusOf(e.state).needsAttention?.since, new Date(base).toISOString());
  await writeConfig(e.home, e.state, { maxUnattendedImports: 10 });
  const done = await runSyncCycle(e.deps(items)); // a real import: the clock must be the real one (the importer's clock-jump guard compares it with the files it bumps)
  assert.equal(done.kind, "ok", JSON.stringify(done));
  assert.equal(statusOf(e.state).needsAttention, null);
});

test("runSyncCycle: an incompatible T3 raises t3-incompatible; three failing cycles in a row raise repeated-failures", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const base = Date.now();
  await runSyncCycle(e.deps([], { now: () => base, connect: async () => { throw new T3Incompatible("9.9.9", "T3Code 9.9.9 is not a tested version."); } }));
  assert.deepEqual(statusOf(e.state).needsAttention, { reason: "t3-incompatible", detail: "T3 Code 9.9.9 is not compatible with t3sm", command: "t3sm doctor", facts: { version: "9.9.9" }, since: new Date(base).toISOString() });

  const e2 = cycleEnv(fakeT3());
  for (let i = 0; i < 3; i++) {
    assert.equal(existsSync(join(e2.state, "sync-status.json")) ? statusOf(e2.state).needsAttention : null, null, `not yet after ${i} failures`);
    const o = await runSyncCycle(e2.deps([], { now: () => base + i * 3_600_000, connect: async () => { throw new Error("boom"); } }));
    assert.equal(o.kind, "error");
  }
  assert.equal(statusOf(e2.state).needsAttention?.reason, "repeated-failures");
  assert.equal(statusOf(e2.state).needsAttention?.command, "t3sm doctor");
});

test("runSyncCycle: a new project folder is created with a clean name and organized", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  await writeConfig(e.home, e.state, { organize: AUTOMATED_IMPORT });
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude"))];
  const now = Date.now();
  const root = "C:/work/billing/frontend";
  const human = transcript(f, e.dir, root, now - 3 * DAY);
  const auto = automatedItem(transcript(f, e.dir, root, now - 4 * DAY));
  const o = await runSyncCycle(e.deps([human, auto]));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  assert.equal(f.projects.length, 1);
  assert.equal(f.projects[0]!.title, "billing/frontend", "the clean name from the planner (a generic folder name gets its parent), not the bare folder name");
  assert.deepEqual(f.calls.filter((c) => c.startsWith("archive:")), [`archive:import:claudeAgent:${auto.session.nativeId}`]);
  assert.equal(f.threads.get(`import:claudeAgent:${human.session.nativeId}`)?.archived, false);
});

test("runSyncCycle: sync counts organize failures and they survive a restart (read from the journal); the import stays and nothing is retried", async () => {
  const f = fakeT3({ writeError: (c) => (c.startsWith("archive:") ? { error: new Error("T3 said no") } : undefined) });
  const e = cycleEnv(f);
  await writeConfig(e.home, e.state, { organize: AUTOMATED_IMPORT });
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude"))];
  const auto = automatedItem(transcript(f, e.dir, ROOT, Date.now() - 3 * DAY));
  const o = await runSyncCycle(e.deps([auto]));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  if (o.kind !== "ok") return;
  assert.equal(o.counts.imported, 1);
  assert.equal(o.counts.organizeFailed, 1);
  assert.equal(f.calls.filter((c) => c.startsWith("archive:")).length, 1, "tried once");
  // The reasons survive the process: read back from the journal file alone.
  const { organizeFailures } = await import("../../src/core/journal.ts");
  const fromDisk = readFileSync(join(e.state, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const failed = organizeFailures(fromDisk, o.runId!);
  assert.deepEqual(failed.map((x) => [x.kind, x.target, x.error]), [["archive", `import:claudeAgent:${auto.session.nativeId}`, "T3 said no"]]);
  assert.equal(failed.length, o.counts.organizeFailed);
  assert.ok(f.threads.has(`import:claudeAgent:${auto.session.nativeId}`));
  assert.match(logLine(o, Date.now()), / organize-failed=1( |$)/);
  assert.ok(summaryLines(o).some((l) => /organiz/i.test(l)));
});

test("runSyncCycle: an account signed out in T3 raises signed-out with `t3sm accounts`", async () => {
  const f = fakeT3({ instances: [inst("claudeAgent", null, { authStatus: "unauthenticated" })] });
  const e = cycleEnv(f);
  const base = Date.now();
  await runSyncCycle(e.deps([transcript(f, e.dir, ROOT, base - 3 * DAY)], { now: () => base }));
  assert.deepEqual(statusOf(e.state).needsAttention, { reason: "signed-out", detail: "1 account is signed out in T3 Code; its sessions wait", command: "t3sm accounts", facts: { n: 1 }, since: new Date(base).toISOString() });
});

test("the watcher's heartbeat keeps what the cycles recorded in sync-status.json", async () => {
  const { recordSyncStatus, writeHeartbeatMerged } = await import("../../src/ops/syncStatus.ts");
  const t = tempHome();
  mkdirSync(t.state, { recursive: true });
  await recordSyncStatus(t.state, { cycle: "ok", attention: { reason: "undecided", detail: "d", command: "t3sm start" }, undecided: { home: 2 }, heldRehome: 1 }, new Date("2026-11-14T10:00:00Z"));
  await writeHeartbeatMerged(t.state, { pid: 1, startedAt: "x", lastCycleAt: null, lastResult: null, nextCycleAt: null });
  const s = JSON.parse(readFileSync(join(t.state, "sync-status.json"), "utf8"));
  assert.equal(s.pid, 1);
  assert.equal(s.needsAttention.since, "2026-11-14T10:00:00.000Z");
  assert.deepEqual(s.undecided, { home: 2 });
  assert.equal(s.heldRehome, 1);
  const before = readFileSync(join(t.state, "sync-status.json"), "utf8");
  await recordSyncStatus(t.state, { cycle: "ok", attention: { reason: "undecided", detail: "d", command: "t3sm start" }, undecided: { home: 2 }, heldRehome: 1 }, new Date("2026-11-14T11:00:00Z"));
  assert.equal(readFileSync(join(t.state, "sync-status.json"), "utf8"), before, "an unchanged cycle writes nothing");
});

test("rollbackRun of a sync run undoes the organize archive and the import together, journaling one rolled-back", async () => {
  const { rollbackRun } = await import("../../src/ops/rollback.ts");
  const { Journal } = await import("../../src/core/journal.ts");
  const f = fakeT3();
  const e = cycleEnv(f);
  await writeConfig(e.home, e.state, { organize: AUTOMATED_IMPORT });
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude"))];
  const now = Date.now();
  const auto = automatedItem(transcript(f, e.dir, ROOT, now - 3 * DAY));
  const human = transcript(f, e.dir, ROOT, now - 4 * DAY);
  const autoId = `import:claudeAgent:${auto.session.nativeId}`;
  const o = await runSyncCycle(e.deps([auto, human]));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  if (o.kind !== "ok") return;
  assert.equal(f.threads.get(autoId)?.archived, true, "organize archived the automated thread");
  const j = new Journal(join(e.state, "journal.jsonl"));
  const r = await rollbackRun(o.runId!, { journal: j, accountHomes: [join(e.home, ".claude")], connect: async () => f.api, allowUntested: true });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.organize.map((x) => [x.kind, x.target, x.status]), [["archive", autoId, "reverted"]]);
  assert.equal(f.threads.get(autoId)?.archived, false, "the archive is undone");
  assert.ok(f.calls.includes(`unarchive:${autoId}`));
  assert.ok(f.threads.has(`import:claudeAgent:${human.session.nativeId}`), "the import is rolled back as today (threads are listed for review, never deleted)");
  const entries = await j.readAll();
  assert.equal(entries.filter((x) => x.t === "rolled-back" && x.targetRunId === o.runId).length, 1);
});

test("runSyncCycle: a repeated-failures streak wins over undecided and over-limit", async () => {
  const { recordSyncStatus } = await import("../../src/ops/syncStatus.ts");
  const t = tempHome();
  mkdirSync(t.state, { recursive: true });
  const undecided = { reason: "undecided" as const, detail: "d", command: "t3sm start" };
  for (let i = 0; i < 2; i++) await recordSyncStatus(t.state, { cycle: "failed" }, new Date(2026, 10, 14, i));
  const s = await recordSyncStatus(t.state, { cycle: "failed", attention: undecided }, new Date(2026, 10, 14, 5));
  assert.equal(s.needsAttention?.reason, "repeated-failures");
  const inc = await recordSyncStatus(t.state, { cycle: "failed", attention: { reason: "t3-incompatible", detail: "d", command: "t3sm doctor" } }, new Date(2026, 10, 14, 6));
  assert.equal(inc.needsAttention?.reason, "t3-incompatible", "t3-incompatible still wins");
});

test("recordSyncStatus: ranked priority (t3-incompatible > signed-out > repeated-failures > over-limit > undecided)", async () => {
  const { recordSyncStatus, ATTENTION_PRIORITY } = await import("../../src/ops/syncStatus.ts");
  assert.deepEqual(ATTENTION_PRIORITY, ["t3-incompatible", "signed-out", "repeated-failures", "over-limit", "undecided", "update-failed"]);
  const att = (reason: "undecided" | "over-limit" | "signed-out" | "t3-incompatible") => ({ reason, detail: "d", command: "t3sm doctor" });
  const streak = async (dir: string): Promise<void> => { for (let i = 0; i < 2; i++) await recordSyncStatus(dir, { cycle: "failed" }, new Date(2026, 10, 14, i)); };
  const a = tempHome(); mkdirSync(a.state, { recursive: true }); await streak(a.state);
  assert.equal((await recordSyncStatus(a.state, { cycle: "failed", attention: att("signed-out") }, new Date(2026, 10, 14, 5))).needsAttention?.reason, "signed-out", "signed-out beats a failing streak");
  const b = tempHome(); mkdirSync(b.state, { recursive: true }); await streak(b.state);
  assert.equal((await recordSyncStatus(b.state, { cycle: "failed", attention: att("over-limit") }, new Date(2026, 10, 14, 5))).needsAttention?.reason, "repeated-failures", "a streak beats over-limit");
  const c = tempHome(); mkdirSync(c.state, { recursive: true }); await streak(c.state);
  const s = await recordSyncStatus(c.state, { cycle: "failed", attention: att("t3-incompatible") }, new Date(2026, 10, 14, 5));
  assert.equal(s.needsAttention?.reason, "t3-incompatible", "t3-incompatible beats all");
  const d = tempHome(); mkdirSync(d.state, { recursive: true });
  assert.equal((await recordSyncStatus(d.state, { cycle: "ok", attention: att("signed-out") }, new Date(2026, 10, 14, 5))).needsAttention?.reason, "signed-out", "no streak: the cycle's own reason");
});

test("runSyncCycle: a journal failure while organizing ends the cycle as an error; a T3 refusal stays isolated", async () => {
  const { Journal } = await import("../../src/core/journal.ts");
  const f = fakeT3();
  const e = cycleEnv(f);
  await writeConfig(e.home, e.state, { organize: AUTOMATED_IMPORT });
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude"))];
  const auto = automatedItem(transcript(f, e.dir, ROOT, Date.now() - 3 * DAY));
  const orig = Journal.prototype.append;
  Journal.prototype.append = async function (this: InstanceType<typeof Journal>, entry: Parameters<typeof orig>[0]) {
    if (entry.t === "organize-change") throw new Error("disk full");
    return orig.call(this, entry);
  } as typeof orig;
  try {
    const o = await runSyncCycle(e.deps([auto]));
    assert.equal(o.kind, "error", JSON.stringify(o));
    if (o.kind === "error") assert.equal((o.error as Error).name, "JournalWriteError");
  } finally { Journal.prototype.append = orig; }
});

// ---------- system notifications (Task 18) ----------

function notifierSpy(): { notifier: { notify(t: string, b: string): Promise<boolean> }; sent: { title: string; body: string }[] } {
  const sent: { title: string; body: string }[] = [];
  return { sent, notifier: { notify: async (title, body) => { sent.push({ title, body }); return true; } } };
}

test("runSyncCycle: an unattended cycle that needs a person raises one notification per 24 h (default mode attention); --dry-run never", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const base = Date.now();
  const a = automatedItem(transcript(f, e.dir, ROOT, base - 3 * DAY));
  const spy = notifierSpy();
  await runSyncCycle(e.deps([a], { now: () => base, notifier: spy.notifier, dryRun: true }));
  assert.equal(spy.sent.length, 0, "dry-run");
  await runSyncCycle(e.deps([a], { now: () => base, notifier: spy.notifier }));
  assert.deepEqual(spy.sent, [{ title: "t3sm needs attention", body: "1 session in 1 category waits for your decision. Open T3 Code and type /t3sm:status, or run t3sm start." }]);
  await runSyncCycle(e.deps([a], { now: () => base + 3_600_000, notifier: spy.notifier }));
  assert.equal(spy.sent.length, 1, "same reason within 24 h");
  await runSyncCycle(e.deps([a], { now: () => base + 25 * 3_600_000, notifier: spy.notifier }));
  assert.equal(spy.sent.length, 2, "a day later");
  assert.ok(Object.keys(statusOf(e.state)).includes("lastNotified"));
});

test("runSyncCycle: notify off never notifies; notify all adds a summary after an import (counts and project names only)", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  const a = automatedItem(transcript(f, e.dir, ROOT, Date.now() - 3 * DAY));
  const off = defaultConfig([{ id: "claudeAgent", home: join(e.home, ".claude"), displayName: "Claude", accentColor: null }]);
  off.notify = "off";
  await saveConfig(e.state, off);
  const spy = notifierSpy();
  await runSyncCycle(e.deps([a], { notifier: spy.notifier }));
  assert.equal(spy.sent.length, 0);

  const g = fakeT3();
  const e2 = cycleEnv(g);
  const all = defaultConfig([{ id: "claudeAgent", home: join(e2.home, ".claude"), displayName: "Claude", accentColor: null }]);
  all.notify = "all";
  all.organize = AUTOMATED_IMPORT;
  await saveConfig(e2.state, all);
  const b = automatedItem(transcript(g, e2.dir, ROOT, Date.now() - 3 * DAY));
  const spy2 = notifierSpy();
  const o = await runSyncCycle(e2.deps([b], { notifier: spy2.notifier }));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  assert.equal(spy2.sent.length, 1);
  assert.equal(spy2.sent[0]!.title, "t3sm");
  assert.match(spy2.sent[0]!.body, /^1 new conversation in 1 project\.( New project: [^.]+\.)?$/);
});

// ---------- Task 9: the history rule in sync (once a day, and right after an import) ----------

type FakeThread = FakeT3["threads"] extends Map<string, infer T> ? T : never;
/** An imported thread shown inside `projectId`, last active `daysAgo` days before `now`. */
const shownThread = (id: string, projectId: string, now: number, daysAgo: number): FakeThread => ({
  id, projectId, instanceId: "claudeAgent", archived: false, title: id, updatedAt: now - daysAgo * DAY,
  latestUserMessageAt: new Date(now - daysAgo * DAY).toISOString(), settledOverride: null, settledAt: null,
});
const settles = (f: FakeT3): string[] => f.calls.filter((c) => c.startsWith("settle:"));
/** The unsettles: here only marks of conversations already shown, kept for the minimum (src/organize/history.ts, step 6). */
const marks = (f: FakeT3): string[] => f.calls.filter((c) => c.startsWith("unsettle:"));
/** `unsettle:` calls for `prefix` + the given numbers, in that order. */
const marked = (prefix: string, ns: number[]): string[] => ns.map((n) => `unsettle:import:claudeAgent:${prefix}${n}`);
const historyAt = (state: string): unknown => (JSON.parse(readFileSync(join(state, "sync-status.json"), "utf8")) as { lastHistoryAt?: unknown }).lastHistoryAt;

test("sync applies the rule once per day, not every cycle (journaled in the cycle's own run, rolled back whole)", async () => {
  const { rollbackRun } = await import("../../src/ops/rollback.ts");
  const { Journal } = await import("../../src/core/journal.ts");
  const f = fakeT3();
  const e = cycleEnv(f);
  await writeConfig(e.home, e.state);
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude"))];
  f.projects.push(project("p0", ROOT, "claudeAgent"));
  const base = Date.now();
  // 12 imported conversations shown, all older than 90 days: the 10 most recent stay (marked, so T3 Code's own
  // auto-settle never puts them away), the 2 oldest are settled.
  for (let i = 0; i < 12; i++) f.threads.set(`import:claudeAgent:h${i}`, shownThread(`import:claudeAgent:h${i}`, "p0", base, 100 + i));
  let clock = base;
  const deps = e.deps([], { now: () => clock });
  const first = await runSyncCycle(deps);
  assert.equal(first.kind, "ok", JSON.stringify(first));
  assert.deepEqual(settles(f), ["settle:import:claudeAgent:h11", "settle:import:claudeAgent:h10"], "oldest first");
  assert.deepEqual(marks(f), marked("h", [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]), "the kept ones marked, oldest first, before any settle");
  assert.ok(f.calls.indexOf("unsettle:import:claudeAgent:h0") < f.calls.indexOf("settle:import:claudeAgent:h11"));
  assert.equal(historyAt(e.state), new Date(base).toISOString());
  const journal = readFileSync(join(e.state, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const runId = first.kind === "ok" ? first.runId : null;
  assert.ok(runId);
  assert.deepEqual(journal.map((x) => x.t), ["run-start", ...Array<string>(12).fill("organize-change"), "run-end"]);
  assert.equal(journal[0].command, `sync ${runId}`);
  assert.ok(journal.every((x) => x.runId === runId));
  assert.equal(journal.at(-1).status, "ok");
  if (first.kind === "ok") assert.equal(first.counts.organized, 12);
  assert.equal(f.autoSettleDays, 7, "sync never changes T3 Code's own setting");
  assert.ok(!f.calls.some((c) => /^(auto-settle|pin|archive|title|delete-project):/.test(c)));

  // A thread that would now be settled appears; an hour later nothing moves; a day later it is settled.
  f.threads.set("import:claudeAgent:h12", shownThread("import:claudeAgent:h12", "p0", base, 200));
  clock = base + 3_600_000;
  const second = await runSyncCycle(deps);
  assert.equal(second.kind, "noop", JSON.stringify(second));
  assert.equal(settles(f).length, 2, "not every cycle");
  clock = base + 25 * 3_600_000;
  const third = await runSyncCycle(deps);
  assert.equal(third.kind, "ok", JSON.stringify(third));
  assert.deepEqual(settles(f).slice(2), ["settle:import:claudeAgent:h12"]);
  assert.equal(marks(f).length, 10, "marked once");
  assert.equal(historyAt(e.state), new Date(clock).toISOString());

  const r = await rollbackRun(runId!, { journal: new Journal(join(e.state, "journal.jsonl")), accountHomes: [join(e.home, ".claude")], connect: async () => f.api, allowUntested: true });
  assert.deepEqual(r.errors, []);
  // The settles are undone; the marks have nothing to put back (the conversations were shown and stay shown).
  assert.deepEqual(r.organize.map((x) => [x.kind, x.status]), [["settle", "reverted"], ["settle", "reverted"], ...Array.from({ length: 10 }, () => ["unsettle", "kept"])]);
  assert.equal(f.threads.get("import:claudeAgent:h11")?.settledOverride, "active", "the settle is undone");
});

test("sync applies it to projects that got new threads right after import (other projects wait for the daily pass)", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  await writeConfig(e.home, e.state);
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude"))];
  f.projects.push(project("p0", ROOT, "claudeAgent"), project("p1", ROOT2, "claudeAgent"));
  const now = Date.now();
  for (let i = 0; i < 11; i++) {
    f.threads.set(`import:claudeAgent:a${i}`, shownThread(`import:claudeAgent:a${i}`, "p0", now, 100 + i));
    f.threads.set(`import:claudeAgent:b${i}`, shownThread(`import:claudeAgent:b${i}`, "p1", now, 100 + i));
  }
  // The daily pass ran an hour ago.
  mkdirSync(e.state, { recursive: true });
  writeFileSync(join(e.state, "sync-status.json"), JSON.stringify({ lastHistoryAt: new Date(now - 3_600_000).toISOString() }));
  // T3 dates an imported thread by its transcript (the fake does not): stamp it after the import.
  const importSessions = f.api.importSessions;
  f.api.importSessions = async (p, r) => {
    const res = await importSessions(p, r);
    for (const t of f.threads.values()) if (t.latestUserMessageAt == null) t.latestUserMessageAt = new Date(t.updatedAt).toISOString();
    return res;
  };
  const fresh = transcript(f, e.dir, ROOT, now - 3 * DAY);
  const o = await runSyncCycle(e.deps([fresh], { now: () => now }));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  if (o.kind !== "ok") return;
  assert.equal(o.counts.imported, 1);
  // p0 held 12 (11 old and the new one): the new one and the 9 most recent stay shown (at least 10 per project), the 2
  // oldest are settled; p1 got nothing new and waits for the daily pass.
  // The 10 kept are marked (shown with no override, so T3 Code's own auto-settle, here at 7 days, leaves them): the 9
  // old ones, and the new one too (3 days old: T3 Code would reach it within a week).
  const freshId = `import:claudeAgent:${fresh.session.nativeId}`;
  assert.deepEqual(settles(f), ["settle:import:claudeAgent:a10", "settle:import:claudeAgent:a9"]);
  assert.deepEqual(marks(f), [...marked("a", [8, 7, 6, 5, 4, 3, 2, 1, 0]), `unsettle:${freshId}`]);
  const journal = readFileSync(join(e.state, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(journal.filter((x) => x.t === "organize-change").map((x) => [x.kind, x.target, x.runId]),
    [...[8, 7, 6, 5, 4, 3, 2, 1, 0].map((n) => ["unsettle", `import:claudeAgent:a${n}`, o.runId]), ["unsettle", freshId, o.runId], ["settle", "import:claudeAgent:a10", o.runId], ["settle", "import:claudeAgent:a9", o.runId]]);
  assert.equal(journal.filter((x) => x.t === "run-start").length, 1, "inside the import's own run");
  assert.equal(historyAt(e.state), new Date(now - 3_600_000).toISOString(), "the daily pass is not marked by it");
});

test("sync: the daily pass makes at most historyPerCycle changes; the rest continues next cycle", async () => {
  const f = fakeT3();
  const e = cycleEnv(f);
  await writeConfig(e.home, e.state);
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude"))];
  f.projects.push(project("p0", ROOT, "claudeAgent"));
  const base = Date.now();
  for (let i = 0; i < 13; i++) f.threads.set(`import:claudeAgent:h${i}`, shownThread(`import:claudeAgent:h${i}`, "p0", base, 100 + i));
  let clock = base;
  // 10 marks (the kept ones) and 3 settles; 12 per cycle: the oldest settle waits.
  const deps = e.deps([], { now: () => clock, historyPerCycle: 12 });
  const first = await runSyncCycle(deps);
  assert.equal(first.kind, "ok", JSON.stringify(first));
  assert.equal(marks(f).length, 10);
  assert.equal(settles(f).length, 2);
  if (first.kind === "ok") assert.equal(first.counts.historyDeferred, 1);
  assert.equal(historyAt(e.state), undefined, "not done: the next cycle continues");
  assert.ok(summaryLines(first).some((l) => /1 history change waits for the next cycle/.test(l)), summaryLines(first).join("\n"));
  assert.match(logLine(first, clock), / history-deferred=1( |$)/);
  clock = base + 60_000;
  const second = await runSyncCycle(deps);
  assert.equal(second.kind, "ok", JSON.stringify(second));
  assert.deepEqual(settles(f).slice(2), ["settle:import:claudeAgent:h10"]);
  assert.equal(historyAt(e.state), new Date(clock).toISOString());
  const { HISTORY_PER_CYCLE } = await import("../../src/ops/sync.ts");
  assert.equal(HISTORY_PER_CYCLE, 200);
});

test("the watcher's heartbeat keeps lastHistoryAt", async () => {
  const { markHistoryPass, readLastHistoryAt, writeHeartbeatMerged } = await import("../../src/ops/syncStatus.ts");
  const t = tempHome();
  mkdirSync(t.state, { recursive: true });
  await markHistoryPass(t.state, new Date("2026-11-14T10:00:00Z"));
  await writeHeartbeatMerged(t.state, { pid: 1, startedAt: "x", lastCycleAt: null, lastResult: null, nextCycleAt: null });
  assert.equal(await readLastHistoryAt(t.state), Date.parse("2026-11-14T10:00:00Z"));
  await markHistoryPass(t.state, null);
  assert.equal(await readLastHistoryAt(t.state), null);
  assert.equal(JSON.parse(readFileSync(join(t.state, "sync-status.json"), "utf8")).pid, 1);
});

test("recordUpdateOutcome: a failed update needs attention until an update installs; cycles keep it; never a path", async () => {
  const { recordSyncStatus, recordUpdateOutcome, readSyncStatus } = await import("../../src/ops/syncStatus.ts");
  const t = tempHome();
  mkdirSync(t.state, { recursive: true });
  await recordUpdateOutcome(t.state, { outcome: "failed", from: "0.3.0", to: "0.3.1", error: "git clone of file:///D:/code/t3sm failed" }, new Date(2026, 10, 15, 1));
  let s = await readSyncStatus(t.state);
  assert.equal(s.needsAttention?.reason, "update-failed");
  assert.equal(s.needsAttention?.command, "t3sm update --check");
  assert.match(s.needsAttention?.detail ?? "", /0\.3\.0.*0\.3\.1/);
  assert.doesNotMatch(readFileSync(join(t.state, "sync-status.json"), "utf8"), /code[\/]+t3sm|file:/, "no path, no error text");
  // A quiet cycle (nothing needs a person) keeps it; any other reason wins over it.
  s = await recordSyncStatus(t.state, { cycle: "ok", attention: null }, new Date(2026, 10, 15, 2));
  assert.equal(s.needsAttention?.reason, "update-failed");
  assert.equal(s.needsAttention?.since, new Date(2026, 10, 15, 1).toISOString(), "since the failure");
  s = await recordSyncStatus(t.state, { cycle: "ok", attention: { reason: "undecided", detail: "d", command: "t3sm start" } }, new Date(2026, 10, 15, 3));
  assert.equal(s.needsAttention?.reason, "undecided");
  s = await recordSyncStatus(t.state, { cycle: "ok", attention: null }, new Date(2026, 10, 15, 4));
  assert.equal(s.needsAttention?.reason, "update-failed", "back once the other reason is gone");
  // An installed update clears it, at once and for the next cycles.
  await recordUpdateOutcome(t.state, { outcome: "installed", from: "0.3.0", to: "0.3.2" }, new Date(2026, 10, 16));
  assert.equal((await readSyncStatus(t.state)).needsAttention, null);
  s = await recordSyncStatus(t.state, { cycle: "ok", attention: null }, new Date(2026, 10, 16, 1));
  assert.equal(s.needsAttention, null);
});

test("recordUpdateOutcome: a rolled-back update is recorded but never raises update-failed (status ranks it info; --json agrees)", async () => {
  const { recordSyncStatus, recordUpdateOutcome, readSyncStatus, readUpdateFailure } = await import("../../src/ops/syncStatus.ts");
  const t = tempHome();
  mkdirSync(t.state, { recursive: true });
  await recordUpdateOutcome(t.state, { outcome: "rolled-back", from: "0.3.0", to: "0.3.1" }, new Date(2026, 10, 15, 1));
  assert.equal((await readSyncStatus(t.state)).needsAttention, null);
  assert.equal((await readUpdateFailure(t.state))?.outcome, "rolled-back", "kept for the info item");
  const s = await recordSyncStatus(t.state, { cycle: "ok", attention: null }, new Date(2026, 10, 15, 2));
  assert.equal(s.needsAttention, null, "a quiet cycle does not raise it either");
  // A rolled-back update after a failed one: the old failure's attention goes, the rolled-back one does not replace it.
  await recordUpdateOutcome(t.state, { outcome: "failed", from: "0.3.0", to: "0.3.1" }, new Date(2026, 10, 15, 3));
  assert.equal((await readSyncStatus(t.state)).needsAttention?.reason, "update-failed");
  await recordUpdateOutcome(t.state, { outcome: "rolled-back", from: "0.3.0", to: "0.3.2" }, new Date(2026, 10, 15, 4));
  assert.equal((await readSyncStatus(t.state)).needsAttention, null);
  // Another reason a cycle saw is left alone.
  await recordSyncStatus(t.state, { cycle: "ok", attention: { reason: "undecided", detail: "d", command: "t3sm start" } }, new Date(2026, 10, 15, 5));
  await recordUpdateOutcome(t.state, { outcome: "rolled-back", from: "0.3.0", to: "0.3.3" }, new Date(2026, 10, 15, 6));
  assert.equal((await readSyncStatus(t.state)).needsAttention?.reason, "undecided");
});

test("log lines unchanged: sync.log and the heartbeat never carry the screen's failures, titles or projects (Task 21)", () => {
  const at = Date.parse("2026-11-15T12:00:00Z");
  const base: CycleOutcome = { kind: "partial", runId: "r1", counts: { ...zeroCounts(), imported: 4, failed: 1, deferred: 1, heldInUse: 1 },
    held: [{ project: "Demo App", root: "C:/work/demo", file: "C:/work/demo/a.jsonl", title: "Synthetic work", modifiedAt: new Date(at - 3 * 60_000).toISOString() }] };
  const withFailures: CycleOutcome = { ...base, failures: [{ harness: "claude", nativeId: "n1", reason: "not-imported", projectRoot: "C:/work/demo", title: "Secret title" }] };
  const line = "2026-11-15T12:00:00.000Z partial run=r1 imported=4 failed=1 deferred=1 parked=0 held-in-use=1 held-dedupe=0 held-accounts=0 held-failed=0 held-projects=1";
  assert.equal(logLine(base, at), line);
  assert.equal(logLine(withFailures, at), line, "the failures never reach sync.log");
  assert.deepEqual(resultSummary(withFailures), resultSummary(base), "nor the heartbeat");
  assert.ok(!JSON.stringify(resultSummary(withFailures)).includes("Secret title"));
  // The English summary is the same words as before; Portuguese on request.
  assert.deepEqual(summaryLines(withFailures, at), summaryLines(base, at));
  assert.equal(summaryLines(base, at)[0], "Imported 4, failed 1. Run r1.");
  assert.ok(summaryLines(base, at).includes("waiting: Demo App — 'Synthetic work' written 3 min ago; retried after 10 min idle"));
  assert.equal(summaryLines(base, at, { lang: "pt" })[0], "Importadas 4, falharam 1. Execução r1.");
  assert.ok(summaryLines(base, at, { dash: "-" }).includes("waiting: Demo App - 'Synthetic work' written 3 min ago; retried after 10 min idle"));
});
