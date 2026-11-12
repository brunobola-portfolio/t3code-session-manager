import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPlan, ApplyRefusal, type ApplyDeps, type SignalSource } from "../../src/apply/apply.ts";
import { applyCommand } from "../../src/cli/commands/apply.ts";
import { main, type Io } from "../../src/cli/main.ts";
import { Journal } from "../../src/core/journal.ts";
import { acquireLock } from "../../src/core/lock.ts";
import type { CanonicalTranscript, JournalEntry, Plan, PlanItem } from "../../src/core/types.ts";
import { encodeClaudeProjectDir } from "../../src/core/paths.ts";
import { uuidV5 } from "../../src/core/uuid.ts";
import { SessionActiveError, SourceBusyError, type SourceAdapter } from "../../src/sources/types.ts";
import { T3Incompatible } from "../../src/t3/errors.ts";
import type { T3Api } from "../../src/t3/api.ts";
import { DAY, fakeT3, inst, tempHome, transcript, type FakeT3 } from "./fake-t3.ts";

const ROOT = "C:/work/demo";
const ROOT2 = "C:/work/other";
const VERSION = "0.1.9-nightly.20261110.4465";

function mkPlan(items: PlanItem[], over: Partial<Plan> = {}): Plan {
  const roots = [...new Set(items.flatMap((i) => (i.action.kind === "skip" ? [] : [i.action.projectRoot])))];
  return {
    version: 1, runId: "20261111-120000-abcd", createdAt: new Date().toISOString(), t3Version: VERSION,
    instancesToCreate: [], projectsToCreate: roots.map((r) => ({ root: r, title: r.split("/").at(-1)!, defaultInstanceId: "claudeAgent" })),
    projectAccounts: [], projectDefaults: roots.map((r) => ({ root: r, instanceId: "claudeAgent" })), mirrorCopies: [], items, warnings: [],
    ...over,
  };
}

class FakeSignals implements SignalSource {
  handlers = new Map<string, Set<() => void>>();
  on(sig: string, fn: () => void) { (this.handlers.get(sig) ?? this.handlers.set(sig, new Set()).get(sig)!).add(fn); }
  off(sig: string, fn: () => void) { this.handlers.get(sig)?.delete(fn); }
  emit(sig: string) { for (const fn of this.handlers.get(sig) ?? []) fn(); }
  count() { return [...this.handlers.values()].reduce((a, s) => a + s.size, 0); }
}

function env(f: FakeT3) {
  const t = tempHome();
  const signals = new FakeSignals();
  const lines: string[] = [];
  const deps = (over: Partial<ApplyDeps> = {}): ApplyDeps => ({
    stateDir: t.state, home: t.home, now: Date.now, connect: async () => f.api, signals,
    batch: { filesPerProject: 50, projectsPerWave: 5 }, onProgress: (l) => void lines.push(l), ...over,
  });
  const journal = () => new Journal(join(t.state, "journal.jsonl")).readAll();
  return { ...t, signals, deps, journal, lines };
}

function mtimes(items: PlanItem[]) { return items.map((i) => statSync(i.session.file.path).mtimeMs); }

test("applyPlan: creates the project, sets its default, imports every session through waves, restores mtimes, journals the run", async () => {
  const f = fakeT3();
  const e = env(f);
  const now = Date.now();
  const items = [transcript(f, e.dir, ROOT, now - 60 * DAY), transcript(f, e.dir, ROOT, now - 3 * DAY)];
  const before = mtimes(items);
  const r = await applyPlan(mkPlan(items), e.deps());
  assert.equal(r.status, "ok");
  assert.equal(r.imported, 2);
  assert.equal(r.failed, 0);
  assert.deepEqual(mtimes(items).map((m, k) => Math.abs(m - before[k]!) <= 2), [true, true]);
  const es = await e.journal();
  const kinds = es.map((x) => x.t);
  assert.equal(kinds[0], "run-start");
  assert.equal(kinds.at(-1), "run-end");
  assert.equal((es.at(-1) as Extract<JournalEntry, { t: "run-end" }>).status, "ok");
  assert.ok(kinds.indexOf("project-created") < kinds.indexOf("project-default-set"));
  assert.ok(kinds.indexOf("project-default-set") < kinds.indexOf("mtime-bump"));
  assert.equal(kinds.filter((k) => k === "imported").length, 2);
  assert.deepEqual(f.calls.filter((c) => c.startsWith("create:")), [`create:${process.platform === "win32" ? "C:\\work\\demo" : ROOT}`]);
  assert.ok(f.calls.includes("close"));
  assert.equal(e.signals.count(), 0, "signal handlers removed");
  assert.ok(!existsSync(join(e.state, "lock")), "lock released");
});

test("applyPlan: re-applying the same plan makes zero importSessions calls and no bumps", async () => {
  const f = fakeT3();
  const e = env(f);
  const now = Date.now();
  const items = [transcript(f, e.dir, ROOT, now - 60 * DAY), transcript(f, e.dir, ROOT, now - 40 * DAY)];
  const plan = mkPlan(items);
  await applyPlan(plan, e.deps());
  const n = (await e.journal()).length;
  f.calls.length = 0;
  const r = await applyPlan(plan, e.deps());
  assert.equal(r.status, "ok");
  assert.equal(f.calls.filter((c) => c.startsWith("import:") || c === "scan" || c.startsWith("create:") || c.startsWith("default:")).length, 0);
  const added = (await e.journal()).slice(n).map((x) => x.t);
  assert.deepEqual(added, ["run-start", "run-end"]);
});

test("applyPlan: listProjects with a mutated shape -> T3Incompatible before any write: no journal write entries, no mtime changed", async () => {
  const f = fakeT3();
  const e = env(f);
  const items = [transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)];
  const before = mtimes(items);
  (f.api as { listProjects: T3Api["listProjects"] }).listProjects = async () => [{ id: 7, root: ROOT }] as never;
  await assert.rejects(applyPlan(mkPlan(items), e.deps()), T3Incompatible);
  assert.deepEqual(await e.journal(), []);
  assert.deepEqual(mtimes(items), before);
  assert.ok(!f.calls.some((c) => c.startsWith("create:") || c.startsWith("import:")));
  assert.ok(f.calls.includes("close"));
  assert.ok(!existsSync(join(e.state, "lock")));
});

test("applyPlan: stale plans are refused before any write (older than 24 h, or another T3Code version)", async () => {
  const f = fakeT3();
  const e = env(f);
  const items = [transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)];
  await assert.rejects(applyPlan(mkPlan(items, { createdAt: new Date(Date.now() - 25 * 3_600_000).toISOString() }), e.deps()), (x: unknown) => x instanceof ApplyRefusal && /stale/.test(x.message));
  await assert.rejects(applyPlan(mkPlan(items, { t3Version: "0.0.1" }), e.deps()),
    (x: unknown) => x instanceof ApplyRefusal && new RegExp(`T3 Code changed from 0\\.0\\.1 to ${VERSION.replaceAll(".", "\\.")} since the plan`).test(x.message));
  assert.deepEqual(await e.journal(), []);
});

test("applyPlan: an in-window mirror copy only warns (dedupe recommended); it and a .bak copy are parked, never imported", async () => {
  const f = fakeT3();
  const e = env(f);
  const claudeHome = join(e.home, ".claude");
  const orgHome = join(e.home, ".claude-org");
  f.opts.instances = [inst("claudeAgent", claudeHome), inst("claude-org", orgHome)];
  const now = Date.now();
  const kept = transcript(f, e.dir, ROOT, now - 60 * DAY);
  const orgDir = join(orgHome, "projects", "C--work-demo");
  const bakDir = join(claudeHome, "projects", "C--work-demo.bak");
  mkdirSync(orgDir, { recursive: true });
  mkdirSync(bakDir, { recursive: true });
  const m = transcript(null, orgDir, ROOT, now - 3 * DAY);
  const b = transcript(null, bakDir, ROOT, now - 4 * DAY);
  const mirror: PlanItem = { session: { ...m.session, accountId: "claude-org" }, action: { kind: "skip", reason: "mirror-copy" }, notes: [] };
  const bak: PlanItem = { session: { ...b.session, flags: ["backup-copy"] }, action: { kind: "skip", reason: "backup-copy" }, notes: [] };
  const mirrorTid = `import:claude-org:${m.session.nativeId}`;
  const bakTid = `import:claudeAgent:${b.session.nativeId}`;
  f.files.push({ path: m.session.file.path, root: ROOT, threadId: mirrorTid }, { path: b.session.file.path, root: ROOT, threadId: bakTid });
  const before = [m, b].map((x) => statSync(x.session.file.path).mtimeMs);
  const plan = mkPlan([kept, mirror, bak], { mirrorCopies: [{ path: m.session.file.path, nativeId: m.session.nativeId, keptPath: kept.session.file.path, relation: "identical" }] });
  const notices: string[] = [];
  const r = await applyPlan(plan, e.deps({ onNotice: (l) => void notices.push(l) }));
  assert.equal(r.status, "ok");
  assert.equal(r.imported, 1);
  assert.ok(f.threads.has(`import:claudeAgent:${kept.session.nativeId}`));
  assert.ok(!f.threads.has(mirrorTid), "mirror not imported under the wrong account");
  assert.ok(!f.threads.has(bakTid), "backup copy not imported");
  assert.deepEqual([m, b].map((x) => Math.abs(statSync(x.session.file.path).mtimeMs - before.shift()!) <= 2), [true, true], "parked files restored");
  assert.ok(notices.some((n) => /1 mirror copy/.test(n) && /t3sm dedupe/.test(n)), notices.join("\n"));
});

test("applyPlan: an instance whose home no longer holds the session's transcript is refused (would import under the wrong account)", async () => {
  const f = fakeT3({ instances: [inst("claudeAgent", "C:/Users/someone-else/.claude-org")] });
  const e = env(f);
  const items = [transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)];
  await assert.rejects(applyPlan(mkPlan(items), e.deps()), (x: unknown) => x instanceof ApplyRefusal && /claudeAgent/.test(x.message));
  assert.deepEqual(await e.journal(), []);
});

test("applyPlan: --only keeps one root's items, project and default", async () => {
  const f = fakeT3({ platform: "win32" });
  const e = env(f);
  const now = Date.now();
  const a = transcript(f, e.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, e.dir, ROOT2, now - 60 * DAY);
  // A Windows spelling of ROOT (other case, backslashes, trailing separator): Windows path rules on every host.
  const r = await applyPlan(mkPlan([a, b]), e.deps({ only: "c:\\work\\demo\\", platform: "win32" }));
  assert.equal(r.imported, 1);
  assert.equal(f.projects.length, 1);
  assert.equal(f.calls.filter((c) => c.startsWith("default:")).length, 1);
});

test("applyPlan: --only with instancesToCreate creates only the instances that root uses (and asks providers:manage only then)", async () => {
  const org = { id: "claude-org", driver: "claudeAgent" as const, displayName: "Org", accentColor: null, homePath: "C:/Users/demo/.claude-org", environment: [] };
  for (const [only, adds, manage] of [[ROOT, [], false], [ROOT2, ["add:claude-org"], true]] as const) {
    const f = fakeT3();
    const e = env(f);
    const now = Date.now();
    const a = transcript(f, e.dir, ROOT, now - 60 * DAY);
    const b = transcript(f, e.dir, ROOT2, now - 60 * DAY, { instanceId: "claude-org" });
    const seen: boolean[] = [];
    const r = await applyPlan(mkPlan([a, b], { instancesToCreate: [org] }), e.deps({ only, connect: async (_h, o) => { seen.push(o.manageProviders); return f.api; } }));
    assert.equal(r.imported, 1);
    assert.deepEqual(f.calls.filter((c) => c.startsWith("add:")), [...adds]);
    assert.deepEqual(seen, [manage]);
  }
});

test("applyPlan: --only that matches nothing in the plan -> refused before connecting, nothing journaled", async () => {
  const f = fakeT3();
  const e = env(f);
  const items = [transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)];
  await assert.rejects(applyPlan(mkPlan(items), e.deps({ only: "C:/elsewhere/none" })), (x: unknown) => x instanceof ApplyRefusal && /No sessions or projects under C:\/elsewhere\/none in this plan\./.test(x.message));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await e.journal(), []);
});

test("applyPlan: third SIGINT during a T3 call restores the wave synchronously and exits 130; the second prints a notice once", async () => {
  let e!: ReturnType<typeof env>;
  const f = fakeT3({ onScan: () => { e.signals.emit("SIGINT"); e.signals.emit("SIGINT"); e.signals.emit("SIGINT"); } });
  e = env(f);
  const now = Date.now();
  const items = [transcript(f, e.dir, ROOT, now - 60 * DAY), transcript(f, e.dir, ROOT, now - 59 * DAY)];
  const before = mtimes(items);
  const notices: string[] = [];
  let atExit: number[] | null = null;
  let code: number | null = null;
  class Exited extends Error {}
  const exit = (c: number): never => { code = c; atExit = mtimes(items); throw new Exited(); };
  await assert.rejects(applyPlan(mkPlan(items), e.deps({ exit, onNotice: (l) => void notices.push(l) })), Exited);
  assert.equal(code, 130);
  assert.deepEqual(atExit!.map((m, k) => Math.abs(m - before[k]!) <= 2), [true, true], "restored synchronously before exit");
  assert.deepEqual(notices.filter((l) => /Still restoring file times/.test(l)).length, 1);
  assert.ok(notices.includes("Forced exit after restoring file times."), notices.join(" | "));
});

test("applyPlan: in-window sessions the plan skips do not shrink the waves (R = 0)", async () => {
  const f = fakeT3();
  const e = env(f);
  const now = Date.now();
  const items = Array.from({ length: 50 }, (_, k) => transcript(f, e.dir, ROOT, now - 60 * DAY + k * 1000));
  const skipped: PlanItem[] = Array.from({ length: 60 }, (_, k) => {
    const it = transcript(null, e.dir, ROOT, now - 5 * DAY + k * 1000);
    return { ...it, action: { kind: "skip", reason: "non-uuid-id" } };
  });
  const r = await applyPlan(mkPlan([...items, ...skipped]), e.deps());
  assert.equal(r.imported, 50);
  assert.equal(f.calls.filter((c) => c === "scan").length, 1, "one wave of 50");
});

/** A convert-mode (OpenCode) plan item for `root`, its transcript served by `adapter`; the fake T3 learns its target. */
function converted(f: FakeT3, home: string, root: string, nativeId: string, updatedMs: number, reads: Map<string, CanonicalTranscript | Error>): PlanItem {
  const uuid = uuidV5(`opencode:${nativeId}`);
  const targetFile = join(home, ".claude", "projects", encodeClaudeProjectDir(root), `${uuid}.jsonl`);
  const threadId = `import:claudeAgent:${uuid}`;
  reads.set(nativeId, {
    harness: "opencode", nativeId, cwd: root, title: null, startedAt: new Date(updatedMs - 60_000).toISOString(),
    messages: [{ role: "user", text: `question ${nativeId}`, timestamp: new Date(updatedMs - 30_000).toISOString() }, { role: "assistant", text: "answer", timestamp: new Date(updatedMs).toISOString() }],
  });
  f.files.push({ path: targetFile, root, threadId });
  return {
    session: {
      harness: "opencode", accountId: null, nativeId, cwd: root, startedAt: new Date(updatedMs - 60_000).toISOString(), updatedAt: new Date(updatedMs).toISOString(),
      messageCount: 2, corruptLines: 0, file: { path: join(home, "opencode.db"), size: 1, mtimeMs: Date.now() - 1000, atimeMs: Date.now() - 1000 }, flags: [], cwdOffsetBytes: 0,
    },
    action: { kind: "convert-import", projectRoot: root, instanceId: "claudeAgent", expectedThreadId: threadId, uuid, targetFile },
    notes: [],
  };
}

function convertEnv() {
  const f = fakeT3();
  const e = env(f);
  const claudeHome = join(e.home, ".claude");
  f.opts.instances = [inst("claudeAgent", claudeHome)];
  const reads = new Map<string, CanonicalTranscript | Error>();
  const adapter: SourceAdapter = {
    id: "opencode", mode: "convert", isAvailable: async () => true, discover: async function* () { /* unused */ },
    read: async (s) => { const t = reads.get(s.nativeId); if (!t || t instanceof Error) throw t ?? new Error("gone"); return t; },
  };
  const deps = (over: Partial<ApplyDeps> = {}) => e.deps({ adapters: [adapter], accountHomes: () => ({ claudeAgent: claudeHome }), ...over });
  return { f, e, reads, deps, claudeHome };
}

test("applyPlan: convert-import items are converted, then imported through the same waves (mtime back to the written time); a convert-only root gets its project", async () => {
  const { f, e, reads, deps } = convertEnv();
  const now = Date.now();
  const a = converted(f, e.home, ROOT2, "ses_old", now - 50 * DAY, reads);
  const b = converted(f, e.home, ROOT2, "ses_new", now - 2 * DAY, reads);
  const plan = mkPlan([a, b]);
  const r = await applyPlan(plan, deps());
  assert.equal(r.status, "ok");
  assert.equal(r.converted, 2);
  assert.equal(r.imported, 2);
  assert.deepEqual(f.calls.filter((c) => c.startsWith("create:")), [`create:${process.platform === "win32" ? "C:\\work\\other" : ROOT2}`]);
  for (const it of [a, b]) {
    const t = (it.action as { targetFile: string }).targetFile;
    // Restored after the wave to the time it was written with: the source's updatedAt, never older than now - 20 days.
    const want = Math.max(Date.parse(it.session.updatedAt), now - 20 * DAY);
    assert.ok(Math.abs(statSync(t).mtimeMs - want) <= 60_000, "mtime restored to the written time after the wave");
    assert.ok(f.threads.has((it.action as { expectedThreadId: string }).expectedThreadId));
  }
  const es = await e.journal();
  const kinds = es.map((x) => x.t);
  assert.ok(kinds.indexOf("file-written") < kinds.indexOf("project-created"), "converted before the project is created");
  assert.ok(kinds.lastIndexOf("file-written") < kinds.indexOf("mtime-bump"));
  const imp = es.filter((x) => x.t === "imported") as Extract<JournalEntry, { t: "imported" }>[];
  assert.deepEqual(imp.map((x) => [x.harness, x.nativeId, x.source.path]).sort(), [a, b].map((i) => ["opencode", i.session.nativeId, (i.action as { targetFile: string }).targetFile]).sort());

  f.calls.length = 0;
  const n = es.length;
  const r2 = await applyPlan(plan, deps());
  assert.equal(r2.converted, 0);
  assert.equal(r2.alreadyInT3, 2);
  assert.deepEqual((await e.journal()).slice(n).map((x) => x.t), ["run-start", "run-end"], "re-apply writes nothing");
});

test("applyPlan: a Codex convert-import whose session T3 already holds in its native form (thread appeared since planning) is already in T3: never converted", async () => {
  const { f, e, reads, deps } = convertEnv();
  const id = "0190ffff-0000-7000-8000-000000000001";
  const base = converted(f, e.home, ROOT2, id, Date.now() - 3 * DAY, reads);
  const uuid = uuidV5(`codex:${id}`);
  const it: PlanItem = {
    ...base,
    session: { ...base.session, harness: "codex", mode: "convert", flags: ["compressed"] },
    action: { ...(base.action as Extract<PlanItem["action"], { kind: "convert-import" }>), uuid, expectedThreadId: `import:claudeAgent:${uuid}` },
  };
  let readCalls = 0;
  const codex: SourceAdapter = { id: "codex", mode: "native", isAvailable: async () => true, discover: async function* () { /* unused */ }, read: async () => { readCalls++; throw new Error("must not be read"); } };
  f.threads.set(`import:codex:${id}`, { id: `import:codex:${id}`, projectId: "p0", instanceId: "codex", archived: false, title: "t", updatedAt: Date.now() });
  const r = await applyPlan(mkPlan([it]), deps({ adapters: [codex] }));
  assert.equal(r.converted, 0);
  assert.equal(r.alreadyInT3, 1);
  assert.equal(readCalls, 0);
  assert.ok(!f.calls.some((c) => c.startsWith("import:") || c.startsWith("create:")));
});

test("applyPlan: a conversion that fails is reported per session (import-failed journaled), the rest import; its convert-only root gets no empty project", async () => {
  const { f, e, reads, deps } = convertEnv();
  const now = Date.now();
  const bad = converted(f, e.home, ROOT2, "ses_bad", now - 5 * DAY, reads);
  reads.set("ses_bad", new Error("database disk image is malformed"));
  const good = converted(f, e.home, ROOT, "ses_good", now - 5 * DAY, reads);
  const r = await applyPlan(mkPlan([bad, good]), deps());
  assert.equal(r.status, "partial");
  assert.equal(r.imported, 1);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.failures, [{ harness: "opencode", nativeId: "ses_bad", reason: "read-failed: database disk image is malformed" }]);
  const failed = (await e.journal()).filter((x) => x.t === "import-failed") as Extract<JournalEntry, { t: "import-failed" }>[];
  assert.deepEqual(failed.map((x) => [x.nativeId, x.reason]), [["ses_bad", "convert: read-failed: database disk image is malformed"]]);
  assert.ok(!f.calls.some((c) => c.toLowerCase().includes("other")), "no project for the root whose only session failed to convert");
});

test("applyPlan: a busy source or a session in use at read time is deferred, not failed (no import-failed, status ok)", async () => {
  const { f, e, reads, deps } = convertEnv();
  const now = Date.now();
  const busy = converted(f, e.home, ROOT, "ses_busy", now - 5 * DAY, reads);
  const live = converted(f, e.home, ROOT, "ses_live", now - 5 * DAY, reads);
  const ok = converted(f, e.home, ROOT, "ses_ok", now - 5 * DAY, reads);
  reads.set("ses_busy", new SourceBusyError("kept changing"));
  reads.set("ses_live", new SessionActiveError("in use"));
  const r = await applyPlan(mkPlan([busy, live, ok]), deps());
  assert.equal(r.status, "ok");
  assert.equal(r.failed, 0);
  assert.equal(r.deferred, 2);
  assert.equal(r.imported, 1);
  assert.deepEqual((await e.journal()).filter((x) => x.t === "import-failed"), []);
});

test("applyPlan: a converted transcript rediscovered as a Claude session (skip: converted) gives the importer one candidate for its path", async () => {
  const { f, e, reads, deps } = convertEnv();
  const conv = converted(f, e.home, ROOT, "ses_a", Date.now() - 5 * DAY, reads);
  const target = (conv.action as { targetFile: string }).targetFile;
  const plan1 = mkPlan([conv]);
  await applyPlan(plan1, deps({ only: ROOT }));
  // Next plan: thread missing again (e.g. deleted in T3), and the Claude adapter now also finds the converted file.
  f.threads.clear();
  const claudeCopy: PlanItem = {
    session: { ...conv.session, harness: "claude", accountId: "claudeAgent", nativeId: (conv.action as { uuid: string }).uuid, file: { path: target, size: statSync(target).size, mtimeMs: statSync(target).mtimeMs, atimeMs: statSync(target).atimeMs } },
    action: { kind: "skip", reason: "converted" }, notes: [],
  };
  const n = (await e.journal()).length;
  const r = await applyPlan(mkPlan([conv, claudeCopy]), deps());
  assert.equal(r.imported, 1);
  const added = (await e.journal()).slice(n);
  const bumps = added.filter((x) => x.t === "mtime-bump") as Extract<JournalEntry, { t: "mtime-bump" }>[];
  const paths = bumps.flatMap((b) => b.files.map((x) => x.path));
  assert.deepEqual(paths, [target], "the target is bumped once, never also parked as a second candidate");
  assert.equal(added.filter((x) => x.t === "imported").length, 1);
});

test("applyPlan: --only converts only that root's sessions", async () => {
  const { f, e, reads, deps } = convertEnv();
  const now = Date.now();
  const a = converted(f, e.home, ROOT, "ses_a", now - 5 * DAY, reads);
  const b = converted(f, e.home, ROOT2, "ses_b", now - 5 * DAY, reads);
  const r = await applyPlan(mkPlan([a, b]), deps({ only: ROOT }));
  assert.equal(r.converted, 1);
  assert.ok(existsSync((a.action as { targetFile: string }).targetFile));
  assert.ok(!existsSync((b.action as { targetFile: string }).targetFile));
});

test("applyPlan: a convert target outside the instance's live home is refused before any write (the home moved since planning)", async () => {
  const { f, e, reads, deps } = convertEnv();
  const a = converted(f, e.home, ROOT, "ses_a", Date.now() - 5 * DAY, reads);
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude-elsewhere"))];
  // The default instance moved away from the ~/.claude account: refused as drift, before the per-item check.
  const { InstanceHomeDrift } = await import("../../src/ops/accounts.ts");
  await assert.rejects(applyPlan(mkPlan([a]), deps()), InstanceHomeDrift);
  // Without a config account for ~/.claude, the per-item home check still refuses it.
  await assert.rejects(applyPlan(mkPlan([a]), deps({ accountHomes: () => ({}) })), (x: unknown) => x instanceof ApplyRefusal && /ses_a/.test(x.message));
  assert.deepEqual(await e.journal(), []);
  assert.ok(!existsSync((a.action as { targetFile: string }).targetFile));
});

test("applyPlan: a convert-only root whose existing converted transcript is in use is held before anything is written", async () => {
  const { f, e, reads, deps } = convertEnv();
  const a = converted(f, e.home, ROOT2, "ses_a", Date.now() - 5 * DAY, reads);
  const t = (a.action as { targetFile: string }).targetFile;
  mkdirSync(join(t, ".."), { recursive: true });
  writeFileSync(t, "resumed right now\n"); // e.g. `claude --resume` is writing it (mtime = now)
  const r = await applyPlan(mkPlan([a]), deps({ noopWithoutWrites: true }));
  assert.equal(r.status, "noop");
  assert.deepEqual(r.heldRoots, [ROOT2]);
  assert.deepEqual(await e.journal(), []);
  assert.equal(readFileSync(t, "utf8"), "resumed right now\n");
});

test("applyPlan: SIGINT during a wave -> that wave's mtimes restored, no new wave, run-end aborted", async () => {
  let e!: ReturnType<typeof env>;
  const f = fakeT3({ onScan: () => e.signals.emit("SIGINT") });
  e = env(f);
  const now = Date.now();
  const items = [transcript(f, e.dir, ROOT, now - 60 * DAY), transcript(f, e.dir, ROOT, now - 59 * DAY)];
  const before = mtimes(items);
  const r = await applyPlan(mkPlan(items), e.deps({ batch: { filesPerProject: 1, projectsPerWave: 1 } }));
  assert.equal(r.status, "aborted");
  assert.equal(f.calls.filter((c) => c === "scan").length, 1);
  assert.deepEqual(mtimes(items).map((m, k) => Math.abs(m - before[k]!) <= 2), [true, true]);
  const es = await e.journal();
  assert.equal((es.at(-1) as Extract<JournalEntry, { t: "run-end" }>).status, "aborted");
  assert.equal(e.signals.count(), 0);
});

// ---------- CLI ----------

function cli(state: string, isTTY = false, answer = "") {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY, prompt: async () => answer, env: { T3SM_HOME: state } };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

function savePlan(state: string, plan: Plan): string {
  const dir = join(state, "runs", plan.runId);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "plan.json");
  writeFileSync(p, JSON.stringify(plan));
  return p;
}

test("applyPlan: a mirror in the home of an instance created by this very run is parked, never imported", async () => {
  const f = fakeT3();
  const e = env(f);
  const claudeHome = join(e.home, ".claude");
  const orgHome = join(e.home, ".claude-org");
  f.opts.instances = [inst("claudeAgent", claudeHome)]; // explicit homes: T3 stamps threads by the owning home
  const now = Date.now();
  const kept = transcript(f, e.dir, ROOT, now - 60 * DAY);
  const orgDir = join(orgHome, "projects", "C--work-demo");
  mkdirSync(orgDir, { recursive: true });
  const m = transcript(null, orgDir, ROOT, now - 3 * DAY);
  f.files.push({ path: m.session.file.path, root: ROOT }); // T3 reads it once claude-org exists
  const mirror: PlanItem = { session: { ...m.session, accountId: "claude-org" }, action: { kind: "skip", reason: "mirror-copy" }, notes: [] };
  const plan = mkPlan([kept, mirror], {
    instancesToCreate: [{ id: "claude-org", driver: "claudeAgent", displayName: "Org", accentColor: null, homePath: orgHome, environment: [] }],
  });
  const before = statSync(m.session.file.path).mtimeMs;
  const r = await applyPlan(plan, e.deps());
  assert.equal(r.status, "ok");
  assert.ok(f.calls.includes("add:claude-org"));
  assert.ok(f.threads.has(`import:claudeAgent:${kept.session.nativeId}`));
  assert.ok(!f.threads.has(`import:claude-org:${m.session.nativeId}`), "the mirror is not imported under the new instance");
  assert.ok(Math.abs(statSync(m.session.file.path).mtimeMs - before) <= 2, "restored");
});

test("applyPlan: a transcript created after planning (listed at wave time) is parked when idle and holds the project when active", async () => {
  const f = fakeT3();
  const e = env(f);
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude"))];
  const now = Date.now();
  const a = transcript(f, e.dir, ROOT, now - 60 * DAY);
  const plan = mkPlan([a]);
  const late = transcript(null, e.dir, ROOT, now - 2 * DAY); // appears after the plan was built
  f.files.push({ path: late.session.file.path, root: ROOT });
  const r = await applyPlan(plan, e.deps());
  assert.equal(r.imported, 1);
  assert.ok(!f.threads.has(`import:claudeAgent:${late.session.nativeId}`), "the new file was parked, not imported");
  assert.ok(Math.abs(statSync(late.session.file.path).mtimeMs - (now - 2 * DAY)) <= 2);

  const g = fakeT3();
  const e2 = env(g);
  g.opts.instances = [inst("claudeAgent", join(e2.home, ".claude"))];
  const b = transcript(g, e2.dir, ROOT, now - 60 * DAY);
  const plan2 = mkPlan([b]);
  const fresh = transcript(null, e2.dir, ROOT, now - 60 * DAY);
  utimesSync(fresh.session.file.path, new Date(), new Date()); // being written right now
  g.files.push({ path: fresh.session.file.path, root: ROOT });
  const r2 = await applyPlan(plan2, e2.deps());
  assert.equal(r2.imported, 0);
  assert.equal(r2.deferredInUse, 1);
  assert.deepEqual(r2.heldRoots, [ROOT]);
  assert.ok(!g.calls.includes("scan"));
});

test("applyPlan (noopWithoutWrites): a cycle where everything pending is held writes nothing at all", async () => {
  const f = fakeT3();
  const e = env(f);
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude"))];
  const now = Date.now();
  const a = transcript(f, e.dir, ROOT, now - 60 * DAY);
  const busy = transcript(null, e.dir, ROOT, now - 60 * DAY);
  utimesSync(busy.session.file.path, new Date(), new Date());
  const r = await applyPlan(mkPlan([a]), e.deps({ noopWithoutWrites: true }));
  assert.equal(r.status, "noop");
  assert.equal(r.deferredInUse, 1);
  assert.deepEqual(r.heldRoots, [ROOT]);
  assert.deepEqual(await e.journal(), [], "no run-start");
  assert.ok(!f.calls.some((c) => c.startsWith("create:") || c.startsWith("default:")), "no project created, no default set");
});

test("applyPlan: an instance T3 reports without a home is listed through the config account's home; unknown -> a warning, nothing held", async () => {
  const now = Date.now();
  const run = async (withConfigHome: boolean) => {
    const f = fakeT3(); // claudeAgent with homePath null (an implicit instance T3 has not resolved)
    const e = env(f);
    const a = transcript(f, e.dir, ROOT, now - 60 * DAY);
    const late = transcript(null, e.dir, ROOT, now - 2 * DAY);
    const tid = `import:claudeAgent:${late.session.nativeId}`;
    f.files.push({ path: late.session.file.path, root: ROOT, threadId: tid });
    const notices: string[] = [];
    const accountHomes = withConfigHome ? () => ({ claudeAgent: join(e.home, ".claude") }) : undefined;
    const r = await applyPlan(mkPlan([a]), e.deps({ accountHomes, onNotice: (l) => void notices.push(l) }));
    return { r, notices, lateImported: f.threads.has(tid) };
  };
  const listed = await run(true);
  assert.equal(listed.r.imported, 1);
  assert.equal(listed.lateImported, false, "found through the config home and parked");
  const unknown = await run(false);
  assert.ok(unknown.notices.some((n) => /could not list claudeAgent: home unknown/.test(n)), unknown.notices.join("\n"));
  assert.equal(unknown.r.deferredInUse, 0, "nothing held for an unknown home");
});

test("applyPlan: confirm() gets the runnable plan (held projects removed) and the held roots separately", async () => {
  const f = fakeT3();
  const e = env(f);
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude"))];
  const now = Date.now();
  const busyItem = transcript(f, e.dir, ROOT, now - 60 * DAY);
  const busy = transcript(null, e.dir, ROOT, now - 60 * DAY);
  utimesSync(busy.session.file.path, new Date(), new Date());
  const otherDir = join(e.home, ".claude", "projects", "C--work-other");
  mkdirSync(otherDir, { recursive: true });
  const other = transcript(f, otherDir, ROOT2, now - 60 * DAY);
  let seen: { roots: string[]; items: string[]; sessions: number } | null = null;
  const r = await applyPlan(mkPlan([busyItem, other]), e.deps({
    confirm: async (plan, held) => {
      seen = { roots: held.roots, sessions: held.sessions, items: plan.items.map((i) => (i.action.kind === "skip" ? "" : i.action.projectRoot)) };
      return true;
    },
  }));
  assert.deepEqual(seen, { roots: [ROOT], sessions: 1, items: [ROOT2] });
  assert.equal(r.imported, 1);
  const g = fakeT3();
  const e2 = env(g);
  g.opts.instances = [inst("claudeAgent", join(e2.home, ".claude"))];
  savePlan(e2.state, mkPlan([transcript(g, e2.dir, ROOT, now - 60 * DAY)]));
  const b2 = transcript(null, e2.dir, ROOT, now - 60 * DAY);
  utimesSync(b2.session.file.path, new Date(), new Date());
  const c2 = cli(e2.state, true, "no");
  assert.equal(await applyCommand([], c2.io, { home: e2.home, connect: async () => g.api, signals: e2.signals }), 0);
  assert.match(c2.out(), /held: in use: demo \(1 session; not part of this run\)/);
});

test("t3sm apply: held projects are named with the hint to close the session or wait", async () => {
  const f = fakeT3();
  const e = env(f);
  f.opts.instances = [inst("claudeAgent", join(e.home, ".claude"))];
  const now = Date.now();
  savePlan(e.state, mkPlan([transcript(f, e.dir, ROOT, now - 60 * DAY)]));
  const busy = transcript(null, e.dir, ROOT, now - 60 * DAY);
  utimesSync(busy.session.file.path, new Date(), new Date());
  const c = cli(e.state);
  assert.equal(await applyCommand(["--yes"], c.io, { home: e.home, connect: async () => f.api, signals: e.signals }), 0);
  assert.match(c.out(), /Held \(a session is in use\): demo\. Close the session or wait 10 minutes, then run again\./);
});

test("t3sm apply: non-TTY without --yes -> exit 2, nothing touched", async () => {
  const f = fakeT3();
  const e = env(f);
  savePlan(e.state, mkPlan([transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)]));
  const c = cli(e.state);
  assert.equal(await applyCommand([], c.io, { home: e.home, connect: async () => f.api, signals: e.signals }), 2);
  assert.match(c.err(), /--yes/);
  assert.equal(f.calls.length, 0);
});

test("t3sm apply: lock held -> exit 0 with `Another t3sm run is in progress.`", async () => {
  const f = fakeT3();
  const e = env(f);
  savePlan(e.state, mkPlan([transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)]));
  const lock = await acquireLock(e.state);
  try {
    const c = cli(e.state);
    assert.equal(await applyCommand(["--yes"], c.io, { home: e.home, connect: async () => f.api, signals: e.signals }), 0);
    assert.match(c.out(), /Another t3sm run is in progress\./);
    assert.equal(f.calls.length, 0, "never connected");
  } finally { await lock!.release(); }
});

test("t3sm apply: the lock is taken first: lock held + stale plan, or no plan at all -> still exit 0 (even with --quiet)", async () => {
  const f = fakeT3();
  const e = env(f);
  savePlan(e.state, mkPlan([transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)], { createdAt: new Date(Date.now() - 48 * 3_600_000).toISOString() }));
  const lock = await acquireLock(e.state);
  try {
    const c = cli(e.state);
    assert.equal(await applyCommand(["--yes", "--quiet"], c.io, { home: e.home, connect: async () => f.api, signals: e.signals }), 0);
    assert.equal(c.out() + c.err(), "", "--quiet is silent on a held lock, like sync");
    const c2 = cli(join(e.home, "empty-state"));
    const lock2 = await acquireLock(join(e.home, "empty-state"));
    try {
      assert.equal(await applyCommand(["--yes"], c2.io, { home: e.home, connect: async () => f.api, signals: e.signals }), 0);
      assert.match(c2.out(), /Another t3sm run is in progress\./);
    } finally { await lock2!.release(); }
    assert.equal(f.calls.length, 0);
  } finally { await lock!.release(); }
});

test("t3sm apply: the interactive confirmation comes after the read-only T3 checks, under the lock, before any write", async () => {
  const f = fakeT3();
  const e = env(f);
  savePlan(e.state, mkPlan([transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)]));
  let connected = false;
  const seen: { lock: boolean; connected: boolean; writes: number }[] = [];
  const out: string[] = [];
  const io: Io = {
    stdout: (s) => void out.push(s), stderr: () => {}, isTTY: true, env: { T3SM_HOME: e.state },
    prompt: async () => {
      seen.push({ lock: existsSync(join(e.state, "lock")), connected, writes: f.calls.filter((c) => c !== "close").length });
      return "yes";
    },
  };
  assert.equal(await applyCommand([], io, { home: e.home, connect: async () => { connected = true; return f.api; }, signals: e.signals }), 0);
  assert.deepEqual(seen, [{ lock: true, connected: true, writes: 0 }]);
  assert.match(out.join(""), /Import/, "summary shown before the question");
  assert.equal(f.threads.size, 1);
});

test("t3sm apply: stale plan -> exit 2 `Plan is stale; run \\`t3sm plan\\` again.`", async () => {
  const f = fakeT3();
  const e = env(f);
  savePlan(e.state, mkPlan([transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)], { t3Version: "0.0.1" }));
  const c = cli(e.state);
  const saved = (await import("../../src/cli/main.ts")).commands["apply"];
  assert.ok(saved, "apply is registered");
  assert.equal(await applyCommand(["--yes"], c.io, { home: e.home, connect: async () => f.api, signals: e.signals }).catch(() => -1), -1);
  const c2 = cli(e.state);
  // Through main for the central error mapping.
  const { commands } = await import("../../src/cli/main.ts");
  const orig = commands["apply"]!;
  commands["apply"] = (a, io) => applyCommand(a, io, { home: e.home, connect: async () => f.api, signals: e.signals });
  try {
    assert.equal(await main(["apply", "--yes"], c2.io), 2);
    assert.match(c2.err(), /Plan is stale; run `t3sm plan` again\./);
  } finally { commands["apply"] = orig; }
});

test("t3sm apply: --yes runs the latest plan, prints one line per wave, exit 0; --quiet prints nothing", async () => {
  const f = fakeT3();
  const e = env(f);
  const now = Date.now();
  savePlan(e.state, mkPlan([transcript(f, e.dir, ROOT, now - 60 * DAY), transcript(f, e.dir, ROOT, now - 50 * DAY)]));
  const c = cli(e.state);
  assert.equal(await applyCommand(["--yes"], c.io, { home: e.home, connect: async () => f.api, signals: e.signals }), 0);
  assert.match(c.out(), /Wave 1\/1 · 1 projects? · 2 sessions · imported 2 · retry 0/);
  const f2 = fakeT3();
  f2.files.push(...f.files); // a fresh T3 that has none of them yet
  const c2 = cli(e.state);
  assert.equal(await applyCommand(["--yes", "--quiet"], c2.io, { home: e.home, connect: async () => f2.api, signals: e.signals }), 0);
  assert.equal(c2.out(), "");
});

test("t3sm apply: per-session failures -> exit 5; SIGINT -> exit 130", async () => {
  const now = Date.now();
  const f = fakeT3();
  const e = env(f);
  const a = transcript(f, e.dir, ROOT, now - 60 * DAY);
  f.opts.never = new Set([(a.action as { expectedThreadId: string }).expectedThreadId]);
  const p = savePlan(e.state, mkPlan([a]));
  const c = cli(e.state);
  assert.equal(await applyCommand(["--yes", "--plan", p], c.io, { home: e.home, connect: async () => f.api, signals: e.signals }), 5);
  let e2!: ReturnType<typeof env>;
  const g = fakeT3({ onScan: () => e2.signals.emit("SIGINT") });
  e2 = env(g);
  const p2 = savePlan(e2.state, mkPlan([transcript(g, e2.dir, ROOT, now - 60 * DAY)]));
  const c2 = cli(e2.state);
  assert.equal(await applyCommand(["--yes", "--plan", p2], c2.io, { home: e2.home, connect: async () => g.api, signals: e2.signals }), 130);
});

test("t3sm apply: --only is resolved to an absolute path; matching nothing -> exit 2 with the resolved path", async () => {
  const f = fakeT3();
  const e = env(f);
  savePlan(e.state, mkPlan([transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)]));
  const c2 = cli(e.state);
  const { commands } = await import("../../src/cli/main.ts");
  const orig = commands["apply"]!;
  commands["apply"] = (a, io) => applyCommand(a, io, { home: e.home, connect: async () => f.api, signals: e.signals });
  try {
    assert.equal(await main(["apply", "--yes", "--only", "nowhere-xyz"], c2.io), 2);
  } finally { commands["apply"] = orig; }
  const { resolve } = await import("node:path");
  assert.ok(c2.err().includes(`No sessions or projects under ${resolve("nowhere-xyz")} in this plan.`), c2.err());
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await e.journal(), []);
});

test("t3sm apply: interrupted before any write -> exit 130 `Interrupted before any change was made.`", async () => {
  const f = fakeT3();
  const e = env(f);
  savePlan(e.state, mkPlan([transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)]));
  const c = cli(e.state);
  assert.equal(await applyCommand(["--yes"], c.io, { home: e.home, connect: async () => { e.signals.emit("SIGINT"); return f.api; }, signals: e.signals }), 130);
  assert.match(c.err(), /Interrupted before any change was made\./);
  assert.doesNotMatch(c.err(), /file times restored/);
  assert.deepEqual(await e.journal(), []);
});

test("t3sm apply: sessions left unverified (shell unreachable after a wave) -> exit 5", async () => {
  const f = fakeT3();
  const e = env(f);
  const p = savePlan(e.state, mkPlan([transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)]));
  let lt = 0;
  const real = f.api.listThreads;
  (f.api as { listThreads: typeof real }).listThreads = async () => { if (++lt >= 3) throw new Error("shell down"); return real(); };
  const c = cli(e.state);
  assert.equal(await applyCommand(["--yes", "--plan", p], c.io, { home: e.home, connect: async () => f.api, signals: e.signals }), 5);
  assert.match(c.out() + c.err(), /unverified 1/);
  assert.ok(c.err().includes("Could not verify imports with T3 Code; stopped. Run `t3sm plan` and `t3sm apply` again."), c.err());
  const end = (await e.journal()).at(-1) as Extract<JournalEntry, { t: "run-end" }>;
  assert.equal(end.status, "partial");
});

test("applyPlan: a second signal outside a wave prints nothing; the forced exit says it restored the file times", async () => {
  const f = fakeT3();
  const e = env(f);
  const items = [transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)];
  const notices: string[] = [];
  const r = await applyPlan(mkPlan(items), e.deps({
    connect: async () => { e.signals.emit("SIGINT"); e.signals.emit("SIGINT"); return f.api; },
    onNotice: (l) => void notices.push(l),
  }));
  assert.equal(r.status, "aborted");
  assert.deepEqual(notices, [], "no 'Still restoring' outside a wave");
});

test("t3sm apply: interactive answer other than yes changes nothing", async () => {
  const f = fakeT3();
  const e = env(f);
  savePlan(e.state, mkPlan([transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)]));
  const c = cli(e.state, true, "no");
  assert.equal(await applyCommand([], c.io, { home: e.home, connect: async () => f.api, signals: e.signals }), 0);
  assert.deepEqual(f.calls, ["close"], "read-only checks only, then closed");
  assert.match(c.out(), /Nothing changed/);
  assert.deepEqual(await e.journal(), []);
  assert.ok(!existsSync(join(e.state, "lock")));
});

// ---------- B1 / B2: the default Claude instance ----------

function pinSpy(f: FakeT3, explicit = false) {
  const pins: string[] = [];
  (f.api as { pinInstanceHome: unknown }).pinInstanceHome = async (id: string, home: string) => { pins.push(`${id}:${home}`); return { previous: null, changed: true }; };
  if (explicit) (f.api as { getConfig: unknown }).getConfig = async () => ({ settings: { providerInstances: { claudeAgent: { driver: "claudeAgent", config: { homePath: "x" } } } }, providers: [] });
  return pins;
}

test("applyPlan: pins T3's default Claude instance to ~/.claude when it is implicit (journaled; providers:manage asked only then)", async () => {
  const f = fakeT3();
  const e = env(f);
  const pins = pinSpy(f);
  const manage: boolean[] = [];
  const connect = async (_h: string, o: { manageProviders: boolean }) => { manage.push(o.manageProviders); return f.api; };
  const home = join(e.home, ".claude");
  const items = [transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)];
  const r = await applyPlan(mkPlan(items, { pinDefault: { instanceId: "claudeAgent", homePath: home } }), e.deps({ connect }));
  assert.equal(r.status, "ok");
  assert.deepEqual(pins, [`claudeAgent:${home}`]);
  const pinned = (await e.journal()).find((x) => x.t === "instance-pinned") as Extract<JournalEntry, { t: "instance-pinned" }>;
  assert.deepEqual([pinned.instanceId, pinned.previous, pinned.next], ["claudeAgent", { homePath: null }, { homePath: home }]);
  await applyPlan(mkPlan(items), e.deps({ connect }));
  assert.deepEqual(manage, [true, false], "providers:manage only when a pin (or an instance) is planned");
});

test("applyPlan: no pin when the default instance became explicit since the plan, nor for sync (pinDefaultInstance:false)", async () => {
  const f = fakeT3();
  const e = env(f);
  const pins = pinSpy(f, true);
  const items = [transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)];
  const pinDefault = { instanceId: "claudeAgent", homePath: join(e.home, ".claude") };
  await applyPlan(mkPlan(items, { pinDefault }), e.deps());
  assert.deepEqual(pins, []);
  const g = fakeT3();
  const e2 = env(g);
  const pins2 = pinSpy(g);
  const manage: boolean[] = [];
  await applyPlan(mkPlan([transcript(g, e2.dir, ROOT, Date.now() - 60 * DAY)], { pinDefault }), e2.deps({ pinDefaultInstance: false, connect: async (_h, o) => { manage.push(o.manageProviders); return g.api; } }));
  assert.deepEqual(pins2, []);
  assert.deepEqual(manage, [false]);
});

test("applyPlan --dry-run reports the pin it would make, and makes none", async () => {
  const f = fakeT3();
  const e = env(f);
  const pins = pinSpy(f);
  const home = join(e.home, ".claude");
  const r = await applyPlan(mkPlan([transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)], { pinDefault: { instanceId: "claudeAgent", homePath: home } }), e.deps({ dryRun: true }));
  assert.equal(r.status, "dry-run");
  assert.equal(r.dryRun!.pinDefault, home);
  assert.deepEqual(pins, []);
});

test("applyPlan: the default instance reading another home than the ~/.claude account (custom account id) -> InstanceHomeDrift before any write", async () => {
  const e0 = tempHome();
  const f = fakeT3({ instances: [inst("claudeAgent", join(e0.home, ".claude-org"))] });
  const e = env(f);
  const items = [transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)];
  const { InstanceHomeDrift } = await import("../../src/ops/accounts.ts");
  await assert.rejects(applyPlan(mkPlan(items), e.deps({ accountHomes: () => ({ personal: join(e.home, ".claude"), org: join(e.home, ".claude-org") }) })), InstanceHomeDrift);
  assert.deepEqual(await e.journal(), []);
});

// ---------- B6: a wave that died before verification ----------

test("applyPlan: an import-attempt item whose thread now exists and whose file is unchanged gets its `imported` entry (under the attempt's run); a changed one does not", async () => {
  const f = fakeT3();
  const e = env(f);
  const now = Date.now();
  const a = transcript(f, e.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, e.dir, ROOT, now - 50 * DAY);
  const tid = (i: PlanItem) => (i.action as { expectedThreadId: string }).expectedThreadId;
  const j = new Journal(join(e.state, "journal.jsonl"));
  const src = (i: PlanItem) => ({ path: i.session.file.path, size: i.session.file.size, mtimeMs: i.session.file.mtimeMs });
  await j.append({ t: "run-start", runId: "dead-run", at: new Date(now - 3600_000).toISOString(), command: "apply x" });
  await j.append({ t: "import-attempt", runId: "dead-run", items: [{ harness: "claude", nativeId: a.session.nativeId, threadId: tid(a), source: src(a) }, { harness: "claude", nativeId: b.session.nativeId, threadId: tid(b), source: src(b) }] });
  for (const i of [a, b]) f.threads.set(tid(i), { id: tid(i), projectId: "p1", instanceId: "claudeAgent", archived: false, title: "t", updatedAt: now });
  appendFileSync(b.session.file.path, "{}\n"); // b continued since the attempt: what T3 holds is unknown
  utimesSync(b.session.file.path, (now - 50 * DAY) / 1000, (now - 50 * DAY) / 1000);
  f.projects.push({ id: "p1", title: "demo", workspaceRoot: ROOT, defaultModelSelection: null, archived: false, deleted: false });
  const r = await applyPlan(mkPlan([a, b], { projectsToCreate: [], projectDefaults: [] }), e.deps());
  assert.equal(r.status, "ok");
  const imp = (await e.journal()).filter((x) => x.t === "imported") as Extract<JournalEntry, { t: "imported" }>[];
  assert.deepEqual(imp.map((x) => [x.runId, x.nativeId]), [["dead-run", a.session.nativeId]]);
  assert.deepEqual(imp[0]!.source, src(a));
  // Idempotent: a second run adds nothing.
  await applyPlan(mkPlan([a, b], { projectsToCreate: [], projectDefaults: [] }), e.deps());
  assert.equal((await e.journal()).filter((x) => x.t === "imported").length, 1);
});

test("applyPlan: SIGHUP (terminal closed) during a wave stops like SIGTERM: mtimes restored, run-end aborted", async () => {
  let e!: ReturnType<typeof env>;
  const f = fakeT3({ onScan: () => e.signals.emit("SIGHUP") });
  e = env(f);
  const now = Date.now();
  const items = [transcript(f, e.dir, ROOT, now - 60 * DAY), transcript(f, e.dir, ROOT, now - 59 * DAY)];
  const before = mtimes(items);
  const r = await applyPlan(mkPlan(items), e.deps({ batch: { filesPerProject: 1, projectsPerWave: 1 } }));
  assert.equal(r.status, "aborted");
  assert.deepEqual(mtimes(items).map((m, k) => Math.abs(m - before[k]!) <= 2), [true, true]);
  assert.equal(e.signals.count(), 0, "every handler removed");
});

test("B14: apply rejects --yes with --dry-run (exit 2); --dry-run with the lock held says so and exits 0", async () => {
  const f = fakeT3();
  const e = env(f);
  savePlan(e.state, mkPlan([transcript(f, e.dir, ROOT, Date.now() - 60 * DAY)]));
  const c = cli(e.state);
  assert.equal(await applyCommand(["--yes", "--dry-run"], c.io, { home: e.home, connect: async () => f.api, signals: e.signals }), 2);
  assert.match(c.err(), /either --dry-run or --yes/);
  const lock = await acquireLock(e.state);
  try {
    const d = cli(e.state);
    assert.equal(await applyCommand(["--dry-run"], d.io, { home: e.home, connect: async () => f.api, signals: e.signals }), 0);
    assert.match(d.out(), /Another t3sm run is in progress\./);
  } finally { await lock!.release(); }
  assert.equal(f.calls.length, 0);
});

test("B15: the plan apply hands to beforeWrites (sync's plan.md) is the runnable one: held projects are not in it", async () => {
  const f = fakeT3();
  const e = env(f);
  const now = Date.now();
  const a = transcript(f, e.dir, ROOT, now - 60 * DAY);
  const heldDir = join(e.home, ".claude", "projects", "C--work-other");
  mkdirSync(heldDir, { recursive: true });
  const held = transcript(f, heldDir, ROOT2, now - 50 * DAY);
  utimesSync(held.session.file.path, new Date(), new Date()); // in use: its project is held at start
  held.session.file.mtimeMs = statSync(held.session.file.path).mtimeMs;
  let seen = null as Plan | null;
  await applyPlan(mkPlan([a, held]), e.deps({ beforeWrites: async (p) => { seen = p; } }));
  assert.ok(seen);
  assert.deepEqual(seen!.items.map((i) => i.session.nativeId), [a.session.nativeId]);
});

test("B13: a run warns once with the count of transcripts more than 10 minutes in the future that no pending journal entry explains", async () => {
  const f = fakeT3();
  const e = env(f);
  const now = Date.now();
  const a = transcript(f, e.dir, ROOT, now - 60 * DAY);
  const ahead = transcript(null, e.dir, ROOT, now + 2 * DAY); // a leftover nobody journaled
  const pendingOne = transcript(null, e.dir, ROOT, now + 3 * DAY); // parked by an interrupted run: recovery handles it
  const j = new Journal(join(e.state, "journal.jsonl"));
  await j.append({ t: "mtime-bump", runId: "old", files: [{ path: pendingOne.session.file.path, atimeMs: now - 5 * DAY, mtimeMs: now - 5 * DAY, targetMtimeMs: now + 3 * DAY }] });
  const notices: string[] = [];
  await applyPlan(mkPlan([a]), e.deps({ exposure: () => [a, ahead, pendingOne], onNotice: (l) => void notices.push(l) }));
  const w = notices.filter((l) => /in the future/.test(l));
  assert.equal(w.length, 1, notices.join("\n"));
  assert.match(w[0]!, /^Warning: 1 transcript /);
  assert.match(w[0]!, /t3sm doctor/);
});

test("liveExposure: a transcript created after planning whose sessionId differs from its file name is listed under T3's id (the one discovery uses), not the stem", async () => {
  const { liveExposure } = await import("../../src/apply/apply.ts");
  const t = tempHome();
  const ROOT = "C:/work/demo";
  const stem = "11111111-1111-4111-8111-111111111111";
  const inside = "22222222-2222-4222-8222-222222222222";
  const rec = (sessionId: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "user", cwd: ROOT, sessionId, message: { role: "user", content: "hi" }, ...extra });
  // Last non-hidden record carries `inside`; a later sidechain record does not count (T3's foldClaudeFields).
  writeFileSync(join(t.dir, `${stem}.jsonl`), [rec(stem), rec(inside), rec("33333333-3333-4333-8333-333333333333", { isSidechain: true })].join("\n") + "\n");
  const plain = "44444444-4444-4444-8444-444444444444";
  writeFileSync(join(t.dir, `${plain}.jsonl`), JSON.stringify({ type: "summary" }) + "\n"); // no sessionId: the stem
  const list = liveExposure(() => [inst("claudeAgent", join(t.home, ".claude"))], process.platform === "win32" ? "win32" : process.platform);
  const out = (await list(ROOT, 1)).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(out.map((x) => [x.nativeId, x.threadIds, x.refs]), [
    [inside, [`import:claudeAgent:${inside}`], [`claudeAgent:${inside}`]],
    [plain, [`import:claudeAgent:${plain}`], [`claudeAgent:${plain}`]],
  ]);
});
