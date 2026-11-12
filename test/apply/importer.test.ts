import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, statSync, truncateSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { PARK_AHEAD_MS, runWaves, type Progress, type WaveCtx } from "../../src/apply/importer.ts";
import { exposureOf } from "../../src/apply/apply.ts";
import { buildWaves } from "../../src/apply/waves.ts";
import { Journal } from "../../src/core/journal.ts";
import type { JournalEntry, PlanItem } from "../../src/core/types.ts";
import { RpcError } from "../../src/t3/errors.ts";
import { DAY, fakeT3, inst, tempHome, transcript, type FakeT3 } from "./fake-t3.ts";

const ROOT = "C:/work/demo";
const ROOT2 = "C:/work/other";

function near(a: number, b: number): boolean { return Math.abs(a - b) <= 2; }

function setup(f: FakeT3, roots: string[] = [ROOT]) {
  const t = tempHome();
  const j = new Journal(join(t.state, "journal.jsonl"));
  const projectIds = new Map<string, string>();
  for (const r of roots) {
    const id = `p-${projectIds.size + 1}`;
    f.projects.push({ id, title: r, workspaceRoot: r, defaultModelSelection: null, archived: false, deleted: false });
    projectIds.set(r, id);
  }
  const progress: Progress[] = [];
  const ctx = (over: Partial<WaveCtx> = {}): WaveCtx => ({
    api: f.api, journal: j, runId: "run-1", projectIds, now: Date.now, onProgress: (p) => void progress.push(p),
    batch: { filesPerProject: 50, projectsPerWave: 5 }, ...over,
  });
  return { ...t, j, ctx, progress };
}

function waves(items: PlanItem[], batch = { filesPerProject: 50, projectsPerWave: 5 }) {
  return buildWaves(items, batch, (i) => i.session.cwdOffsetBytes);
}

function originals(items: PlanItem[]) {
  return items.map((i) => ({ path: i.session.file.path, mtimeMs: i.session.file.mtimeMs, atimeMs: i.session.file.atimeMs }));
}

function assertRestored(o: ReturnType<typeof originals>) {
  for (const x of o) {
    const s = statSync(x.path);
    assert.ok(near(s.mtimeMs, x.mtimeMs), `mtime of ${x.path} restored (${s.mtimeMs} vs ${x.mtimeMs})`);
    assert.ok(near(s.atimeMs, x.atimeMs), `atime of ${x.path} restored`);
  }
}

test("runWaves: importSessions throws -> every bumped and parked file is back at its original mtime and atime; journal has the matching mtime-restore", async () => {
  const f = fakeT3({ importError: () => new Error("boom") });
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, s.dir, ROOT, now - 50 * DAY);
  const parked = transcript(f, s.dir, ROOT, now - 5 * DAY);
  const all = [a, b, parked];
  const o = originals(all);
  await assert.rejects(runWaves(s.ctx({ batch: { filesPerProject: 2, projectsPerWave: 5 } }), waves(all, { filesPerProject: 2, projectsPerWave: 5 })), /boom/);
  assertRestored(o);
  const es = await s.j.readAll();
  const bump = es.find((e) => e.t === "mtime-bump") as Extract<JournalEntry, { t: "mtime-bump" }>;
  const restore = es.find((e) => e.t === "mtime-restore") as Extract<JournalEntry, { t: "mtime-restore" }>;
  assert.ok(bump && restore, "bump and restore journaled");
  assert.ok(es.indexOf(bump) < es.indexOf(restore));
  assert.deepEqual([...restore.paths].sort(), bump.files.map((x) => x.path).sort());
  assert.deepEqual(bump.files.map((x) => x.path).sort(), o.map((x) => x.path).sort(), "bumped a, b and parked the in-window one");
  const pf = bump.files.find((x) => x.path === parked.session.file.path)!;
  assert.ok(pf.targetMtimeMs > now + 23 * 3_600_000, "parked in the future (T3 skips it; never a past mtime)");
  for (const x of bump.files) assert.ok(near(x.mtimeMs, o.find((y) => y.path === x.path)!.mtimeMs), "journal carries the originals");
});

test("runWaves: a file in use holds its whole project this run (T3 would import it now): nothing of the root is bumped", async () => {
  const f = fakeT3();
  const s = setup(f, [ROOT, ROOT2]);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const active = transcript(f, s.dir, ROOT, now - 40 * DAY);
  const other = transcript(f, s.dir, ROOT2, now - 50 * DAY);
  utimesSync(active.session.file.path, new Date(), new Date()); // in use right now
  const r = await runWaves(s.ctx(), waves([a, active, other]));
  assert.deepEqual(r.imported.map((i) => i.session.nativeId), [other.session.nativeId], "the other project goes on");
  assert.deepEqual(r.deferred.map((d) => [d.item.session.nativeId, d.reason]).sort(), [[a.session.nativeId, "project-in-use"], [active.session.nativeId, "active"]].sort());
  assert.equal(r.failed.length, 0);
  const es = await s.j.readAll();
  for (const e of es) {
    if (e.t === "mtime-bump") assert.ok(!e.files.some((x) => x.path === active.session.file.path || x.path === a.session.file.path), "held root never bumped");
    if (e.t === "imported" || e.t === "import-failed") assert.ok(e.nativeId !== active.session.nativeId && e.nativeId !== a.session.nativeId);
  }
  assert.ok(Date.now() - statSync(active.session.file.path).mtimeMs < 60_000, "active file untouched");
  assert.ok(!f.calls.includes("import:p-1"), "the held project is never imported");
});

test("runWaves: a held project is imported by the next run once its session is idle", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const active = transcript(f, s.dir, ROOT, now - 40 * DAY);
  utimesSync(active.session.file.path, new Date(), new Date());
  const r1 = await runWaves(s.ctx(), waves([a, active]));
  assert.equal(r1.imported.length, 0);
  const idle = Date.now() - 20 * 60_000;
  utimesSync(active.session.file.path, idle / 1000, idle / 1000);
  const st = statSync(active.session.file.path);
  active.session.file = { path: active.session.file.path, size: st.size, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs };
  const r2 = await runWaves(s.ctx({ runId: "run-2" }), waves([a, active]));
  assert.deepEqual(r2.imported.map((i) => i.session.nativeId).sort(), [a, active].map((i) => i.session.nativeId).sort());
  assert.deepEqual(r2.deferred, []);
});

test("runWaves: a mirror copy and a .bak copy in the window are parked, restored and never imported", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const orgDir = join(s.home, ".claude-org", "projects", "C--work-demo");
  const bakDir = join(s.home, ".claude", "projects", "C--work-demo.bak");
  mkdirSync(orgDir, { recursive: true });
  mkdirSync(bakDir, { recursive: true });
  const mirror = transcript(null, orgDir, ROOT, now - 3 * DAY);
  const bak = transcript(null, bakDir, ROOT, now - 4 * DAY);
  const mirrorTid = `import:claude-org:${mirror.session.nativeId}`;
  const bakTid = `import:claudeAgent:${bak.session.nativeId}`;
  f.files.push({ path: mirror.session.file.path, root: ROOT, threadId: mirrorTid }, { path: bak.session.file.path, root: ROOT, threadId: bakTid });
  const o = originals([a, mirror, bak]);
  const exposure = [
    { path: mirror.session.file.path, cwd: ROOT, threadIds: [mirrorTid], refs: [`claude-org:${mirror.session.nativeId}`] },
    { path: bak.session.file.path, cwd: ROOT, threadIds: [bakTid], refs: [`claudeAgent:${bak.session.nativeId}`] },
  ];
  const r = await runWaves(s.ctx({ exposure }), waves([a]));
  assert.deepEqual(r.imported.map((i) => i.session.nativeId), [a.session.nativeId]);
  assert.ok(!f.threads.has(mirrorTid), "mirror not imported under the wrong account");
  assert.ok(!f.threads.has(bakTid), "backup copy not imported");
  const bump = (await s.j.readAll()).find((e) => e.t === "mtime-bump") as Extract<JournalEntry, { t: "mtime-bump" }>;
  for (const p of [mirror, bak]) {
    const x = bump.files.find((y) => y.path === p.session.file.path)!;
    assert.ok(x && x.targetMtimeMs > now + 23 * 3_600_000, "parked in the future, journaled with the bump");
  }
  assertRestored(o.slice(1));
});

test("runWaves: an active transcript outside the plan (e.g. a mirror being written) holds the project", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const orgDir = join(s.home, ".claude-org", "projects", "C--work-demo");
  mkdirSync(orgDir, { recursive: true });
  const live = transcript(null, orgDir, ROOT, now - 60_000);
  const r = await runWaves(s.ctx({ exposure: [{ path: live.session.file.path, cwd: ROOT, threadIds: ["import:claude-org:x"], refs: [] }] }), waves([a]));
  assert.deepEqual(r.imported, []);
  assert.deepEqual(r.deferred.map((d) => d.reason), ["project-in-use"]);
  assert.ok(!f.calls.includes("scan"));
});

test("runWaves: an active session already in T3 (started inside T3: matched by its native ref) never holds the project", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const live = transcript(null, s.dir, ROOT, now - 60_000);
  f.threads.set("t3-own", { id: "t3-own", projectId: "p-1", instanceId: "claudeAgent", archived: false, title: "t", nativeSessionId: live.session.nativeId, updatedAt: now } as never);
  const exposure = [{ path: live.session.file.path, cwd: ROOT, threadIds: [`import:claudeAgent:${live.session.nativeId}`], refs: [`claudeAgent:${live.session.nativeId}`] }];
  const r = await runWaves(s.ctx({ exposure }), waves([a]));
  assert.deepEqual(r.imported.map((i) => i.session.nativeId), [a.session.nativeId]);
});

test("runWaves: a file whose size changed since planning is dropped, not bumped", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const grown = transcript(f, s.dir, ROOT, now - 60 * DAY);
  appendFileSync(grown.session.file.path, "{}\n");
  utimesSync(grown.session.file.path, (now - 60 * DAY) / 1000, (now - 60 * DAY) / 1000);
  const r = await runWaves(s.ctx(), waves([grown]));
  assert.equal(r.imported.length, 0);
  assert.deepEqual(r.deferred.map((d) => d.reason), ["changed"]);
  assert.ok(!f.calls.includes("scan"), "no wave ran");
  assert.equal((await s.j.readAll()).length, 0);
});

test("runWaves: a file whose mtime changed since planning (same size, not active) is dropped, not bumped", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const moved = transcript(f, s.dir, ROOT, now - 60 * DAY);
  utimesSync(moved.session.file.path, (now - 20 * DAY) / 1000, (now - 20 * DAY) / 1000); // touched by someone, days ago
  const r = await runWaves(s.ctx(), waves([moved]));
  assert.equal(r.imported.length, 0);
  assert.deepEqual(r.deferred.map((d) => d.reason), ["changed"]);
  assert.ok(!f.calls.includes("scan"), "no wave ran");
  assert.equal((await s.j.readAll()).length, 0, "nothing journaled for it");
  assert.ok(near(statSync(moved.session.file.path).mtimeMs, now - 20 * DAY), "left where it was");
});

test("runWaves: an in-window session of the wave's project that changed since planning is parked for the wave, restored, not imported", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const old = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const changed = transcript(f, s.dir, ROOT, now - 5 * DAY);
  appendFileSync(changed.session.file.path, "{}\n");
  utimesSync(changed.session.file.path, (now - 4 * DAY) / 1000, (now - 4 * DAY) / 1000);
  const before = statSync(changed.session.file.path).mtimeMs;
  const batch = { filesPerProject: 1, projectsPerWave: 5 };
  const r = await runWaves(s.ctx({ batch }), waves([old, changed], batch));
  const bump = (await s.j.readAll()).find((e) => e.t === "mtime-bump") as Extract<JournalEntry, { t: "mtime-bump" }>;
  const x = bump.files.find((y) => y.path === changed.session.file.path)!;
  assert.ok(x.targetMtimeMs > now + 23 * 3_600_000, "parked in the future");
  assert.ok(near(statSync(changed.session.file.path).mtimeMs, before), "restored");
  assert.deepEqual(r.imported.map((i) => i.session.nativeId), [old.session.nativeId]);
  assert.deepEqual(r.deferred.map((d) => d.reason), ["changed"]);
});

test("runWaves: active in-window sessions hold their project: nothing bumped, nothing scanned, all retried next run", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const old = Array.from({ length: 90 }, (_, k) => transcript(f, s.dir, ROOT, now - 60 * DAY + k * 1000));
  const active = Array.from({ length: 11 }, () => transcript(f, s.dir, ROOT, now - 3 * DAY));
  for (const a of active) utimesSync(a.session.file.path, new Date(), new Date());
  const batch = { filesPerProject: 90, projectsPerWave: 5 };
  const r = await runWaves(s.ctx({ batch }), waves([...old, ...active], batch));
  assert.equal(r.imported.length, 0);
  // Wave 1 (the 90 old ones) finds the active ones and holds the project; the 11 active ones, in a later wave, are
  // deferred by that run-wide hold before they are even re-stat'ed.
  assert.equal(r.deferred.length, 101);
  assert.ok(r.deferred.every((d) => d.reason === "project-in-use"));
  assert.deepEqual(r.heldRoots, [ROOT]);
  assert.equal((await s.j.readAll()).filter((e) => e.t === "mtime-bump").length, 0);
  assert.equal(f.calls.filter((c) => c === "scan").length, 0);
});

test("runWaves: a restore that fails is reported, left pending in the journal, and recoverPendingMtimes puts it back", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, s.dir, ROOT, now - 59 * DAY);
  const o = originals([a, b]);
  const { utimes } = await import("node:fs/promises");
  let restoring = false;
  f.opts.onImport = () => { restoring = true; };
  const flaky = async (p: string, at: number, mt: number): Promise<void> => {
    if (restoring && p === b.session.file.path) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    await utimes(p, at, mt);
  };
  const r = await runWaves(s.ctx({ utimes: flaky }), waves([a, b]));
  assert.deepEqual(r.restoreErrors.map((x) => x.path), [b.session.file.path]);
  assert.equal(r.imported.length, 2);
  const restore = (await s.j.readAll()).find((e) => e.t === "mtime-restore") as Extract<JournalEntry, { t: "mtime-restore" }>;
  assert.deepEqual(restore.paths, [a.session.file.path], "the failed one stays pending");
  assert.ok(!near(statSync(b.session.file.path).mtimeMs, o[1]!.mtimeMs), "b is still bumped");
  const { recoverPendingMtimes } = await import("../../src/core/journal.ts");
  const rec = await recoverPendingMtimes(s.j);
  assert.deepEqual(rec.restored, [b.session.file.path]);
  assertRestored(o);
});

test("runWaves: a file written between the bump entry and its own utimes is skipped: fresh mtimes of a bumped and a parked file survive", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, s.dir, ROOT, now - 59 * DAY);
  const parked = transcript(f, s.dir, ROOT, now - 5 * DAY);
  const { utimes } = await import("node:fs/promises");
  let first = true;
  const racing = async (p: string, at: number, mt: number): Promise<void> => {
    if (first) { // while A is being bumped, someone writes to B (bumped later in the list) and to the parked one
      first = false;
      appendFileSync(b.session.file.path, "{}\n");
      appendFileSync(parked.session.file.path, "{}\n");
    }
    await utimes(p, at, mt);
  };
  const batch = { filesPerProject: 2, projectsPerWave: 5 };
  const r = await runWaves(s.ctx({ batch, utimes: racing }), waves([a, b, parked], batch));
  for (const x of [b, parked]) assert.ok(Date.now() - statSync(x.session.file.path).mtimeMs < 60_000, "fresh mtime kept");
  assertRestored(originals([a]));
  assert.equal(r.restoreErrors.length, 0);
  assert.ok(!r.failed.some((x) => x.item === b), "a file skipped at bump time is not an import failure");
});

test("runWaves: a file skipped at bump time is resolved without utimes even if a coarse-timestamp stat reports it at its target; journaled restored right after the bump loop", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, s.dir, ROOT, now - 59 * DAY);
  const { utimes, stat } = await import("node:fs/promises");
  let first = true;
  const racing = async (p: string, at: number, mt: number): Promise<void> => {
    if (first) { first = false; appendFileSync(b.session.file.path, "{}\n"); }
    await utimes(p, at, mt);
  };
  // Coarse filesystem: once the wave is past the bump loop, B's fresh mtime reads as exactly its bump target.
  const coarse = async (p: string) => {
    const st = await stat(p);
    if (p === b.session.file.path && f.calls.includes("scan")) {
      const bump = (await s.j.readAll()).find((e) => e.t === "mtime-bump") as Extract<JournalEntry, { t: "mtime-bump" }>;
      return { size: st.size, mtimeMs: bump.files.find((x) => x.path === p)!.targetMtimeMs };
    }
    return st;
  };
  await runWaves(s.ctx({ utimes: racing, stat: coarse }), waves([a, b]));
  assert.ok(Date.now() - statSync(b.session.file.path).mtimeMs < 60_000, "fresh mtime of B kept");
  const es = await s.j.readAll();
  const kinds = es.map((e) => e.t);
  const firstRestore = es.find((e) => e.t === "mtime-restore") as Extract<JournalEntry, { t: "mtime-restore" }>;
  assert.deepEqual(firstRestore.paths, [b.session.file.path], "skipped path journaled restored first");
  assert.ok(kinds.indexOf("mtime-restore") < kinds.indexOf("imported"));
  const { recoverPendingMtimes } = await import("../../src/core/journal.ts");
  await recoverPendingMtimes(s.j);
  assert.ok(Date.now() - statSync(b.session.file.path).mtimeMs < 60_000, "recovery leaves B alone too");
});

test("runWaves: a file deleted between the re-stat and its utimes is deferred as missing", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, s.dir, ROOT, now - 59 * DAY);
  const { utimes } = await import("node:fs/promises");
  const { unlinkSync } = await import("node:fs");
  let first = true;
  const racing = async (p: string, at: number, mt: number): Promise<void> => {
    if (first) { first = false; unlinkSync(b.session.file.path); }
    await utimes(p, at, mt);
  };
  const r = await runWaves(s.ctx({ utimes: racing }), waves([a, b]));
  assert.deepEqual(r.deferred.map((d) => [d.item.session.nativeId, d.reason]), [[b.session.nativeId, "missing"]]);
  assert.equal(r.restoreErrors.length, 0);
});

test("runWaves: import-attempt lists the wave's items only; every other in-window transcript of the project is parked", async () => {
  const f = fakeT3();
  const s = setup(f, [ROOT, ROOT2]);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const changed = transcript(f, s.dir, ROOT, now - 5 * DAY);
  appendFileSync(changed.session.file.path, "{}\n");
  utimesSync(changed.session.file.path, (now - 4 * DAY) / 1000, (now - 4 * DAY) / 1000);
  const parked = transcript(f, s.dir, ROOT, now - 6 * DAY);
  const old = transcript(f, s.dir, ROOT, now - 50 * DAY); // out of window: T3 cannot take it
  const other = transcript(f, s.dir, ROOT2, now - 2 * DAY); // another project: not imported in this wave
  const batch = { filesPerProject: 1, projectsPerWave: 1 };
  await runWaves(s.ctx({ batch }), waves([a, changed, parked, old, other], batch));
  const es = await s.j.readAll();
  const first = es.find((e) => e.t === "import-attempt") as Extract<JournalEntry, { t: "import-attempt" }>;
  assert.deepEqual(first.items.map((x) => x.nativeId), [a.session.nativeId]);
  const bump = es.find((e) => e.t === "mtime-bump") as Extract<JournalEntry, { t: "mtime-bump" }>;
  assert.deepEqual(bump.files.map((x) => x.path).sort(), [a, changed, parked].map((i) => i.session.file.path).sort(), "changed and later-wave ones parked; old and other-project ones untouched");
  assert.ok(!f.threads.has(changed.action.kind === "import" ? changed.action.expectedThreadId : ""), "the changed one is never imported by the side effect");
});

test("runWaves: utimes throwing in the middle of the bump list -> only the files actually bumped are restored", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const all = [transcript(f, s.dir, ROOT, now - 60 * DAY), transcript(f, s.dir, ROOT, now - 59 * DAY), transcript(f, s.dir, ROOT, now - 58 * DAY)];
  const o = originals(all);
  const { utimes } = await import("node:fs/promises");
  const calls: string[] = [];
  let n = 0;
  const flaky = async (p: string, at: number, mt: number): Promise<void> => {
    if (++n === 2) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); // not a busy file: the run stops
    calls.push(p);
    await utimes(p, at, mt);
  };
  await assert.rejects(runWaves(s.ctx({ utimes: flaky }), waves(all)), /EIO/);
  assertRestored(o);
  assert.deepEqual(calls, [all[0]!.session.file.path, all[0]!.session.file.path], "bump + restore of the first file only");
  assert.ok(!f.calls.includes("scan"));
  const restore = (await s.j.readAll()).find((e) => e.t === "mtime-restore") as Extract<JournalEntry, { t: "mtime-restore" }>;
  assert.equal(restore.paths.length, 3, "untouched files are resolved too");
});

test("runWaves: scanSessions throwing -> every file restored, error propagates", async () => {
  const f = fakeT3({ onScan: () => { throw new Error("scan exploded"); } });
  const s = setup(f);
  const now = Date.now();
  const all = [transcript(f, s.dir, ROOT, now - 60 * DAY), transcript(f, s.dir, ROOT, now - 3 * DAY)];
  const batch = { filesPerProject: 1, projectsPerWave: 5 };
  await assert.rejects(runWaves(s.ctx({ batch }), waves(all, batch)), /scan exploded/);
  assertRestored(originals(all));
  assert.ok(!f.calls.some((c) => c.startsWith("import:")));
});

test("runWaves: import-attempt is journaled before the import calls; listThreads failing twice after a wave leaves the items unverified", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  let lt = 0;
  const real = f.api.listThreads;
  (f.api as { listThreads: typeof real }).listThreads = async () => { if (++lt >= 2) throw new Error("shell down"); return real(); };
  let attemptBeforeImport = false;
  f.opts.onImport = async () => { attemptBeforeImport = (await s.j.readAll()).some((e) => e.t === "import-attempt"); };
  const r = await runWaves(s.ctx(), waves([a]));
  assert.equal(attemptBeforeImport, true);
  assert.equal(lt, 3, "initial + verify + one retry");
  assert.deepEqual(r.unverified.map((i) => i.session.nativeId), [a.session.nativeId]);
  assert.equal(r.imported.length + r.failed.length, 0);
  const es = await s.j.readAll();
  const att = es.find((e) => e.t === "import-attempt") as Extract<JournalEntry, { t: "import-attempt" }>;
  assert.deepEqual(att.items, [{
    harness: "claude", nativeId: a.session.nativeId, threadId: (a.action as { expectedThreadId: string }).expectedThreadId,
    source: { path: a.session.file.path, size: a.session.file.size, mtimeMs: att.items[0]!.source!.mtimeMs },
  }]);
  assert.ok(near(att.items[0]!.source!.mtimeMs, a.session.file.mtimeMs), "the attempt carries the ORIGINAL mtime");
  assertRestored(originals([a]));
});

test("runWaves: after an unverified wave no further wave starts", async () => {
  const f = fakeT3();
  const s = setup(f, [ROOT, ROOT2]);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, s.dir, ROOT2, now - 50 * DAY);
  let lt = 0;
  const real = f.api.listThreads;
  (f.api as { listThreads: typeof real }).listThreads = async () => { if (++lt >= 2) throw new Error("shell down"); return real(); };
  const batch = { filesPerProject: 1, projectsPerWave: 1 };
  const r = await runWaves(s.ctx({ batch }), waves([a, b], batch));
  assert.equal(f.calls.filter((c) => c === "scan").length, 1, "stopped after the unverified wave");
  assert.deepEqual(r.unverified.map((i) => i.session.nativeId), [a.session.nativeId]);
  assert.equal(r.stoppedUnverified, true);
  assert.equal(r.failed.length, 0);
  assertRestored(originals([a, b]));
});

test("runWaves: listThreads failing once after a wave is retried and verifies normally", async () => {
  const f = fakeT3();
  const s = setup(f);
  const a = transcript(f, s.dir, ROOT, Date.now() - 60 * DAY);
  let lt = 0;
  const real = f.api.listThreads;
  (f.api as { listThreads: typeof real }).listThreads = async () => { if (++lt === 2) throw new Error("blip"); return real(); };
  const r = await runWaves(s.ctx(), waves([a]));
  assert.equal(r.imported.length, 1);
  assert.equal(r.unverified.length, 0);
});

test("runWaves: a session whose first cwd is beyond 1 MiB fails up front (cwd-unreadable-in-t3) without spending a wave", async () => {
  const f = fakeT3();
  const s = setup(f);
  const deep = transcript(f, s.dir, ROOT, Date.now() - 60 * DAY, { cost: 2 * 1024 * 1024 });
  const r = await runWaves(s.ctx(), waves([deep]));
  assert.deepEqual(r.failed.map((x) => x.reason), ["cwd-unreadable-in-t3"]);
  assert.equal(f.calls.filter((c) => c === "scan").length, 0);
  assert.ok(!(await s.j.readAll()).some((e) => e.t === "mtime-bump"));
});

test("runWaves: the mtime-bump entry is written before any utimes (journal write fails -> no file touched)", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const o = originals([a]);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(s.j.file, { recursive: true }); // the journal path is a directory: append fails
  await assert.rejects(runWaves(s.ctx(), waves([a])));
  assertRestored(o);
  assert.ok(!f.calls.includes("scan"));
});

test("runWaves: in-window sessions are parked while an older wave runs, then imported in their own later wave; thread order follows the original order", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const old = transcript(f, s.dir, ROOT, now - 90 * DAY);
  const mid = transcript(f, s.dir, ROOT, now - 20 * DAY);
  const recent = transcript(f, s.dir, ROOT, now - 2 * DAY);
  const all = [recent, old, mid];
  const o = originals(all);
  const seen: string[][] = [];
  f.opts.onImport = () => void seen.push([...f.threads.keys()]);
  const batch = { filesPerProject: 1, projectsPerWave: 5 };
  const r = await runWaves(s.ctx({ batch }), waves(all, batch));
  assert.equal(r.imported.length, 3);
  assert.deepEqual(f.calls.filter((c) => c === "scan").length, 3);
  // After wave 1 only `old` exists: the in-window ones were parked.
  const t = (i: PlanItem) => f.threads.get(i.action.kind === "import" ? i.action.expectedThreadId : "")!;
  assert.ok(t(old).updatedAt < t(mid).updatedAt && t(mid).updatedAt < t(recent).updatedAt, "updatedAt order = original order");
  assertRestored(o);
  const es = await s.j.readAll();
  const firstBump = es.find((e) => e.t === "mtime-bump") as Extract<JournalEntry, { t: "mtime-bump" }>;
  assert.equal(firstBump.files.length, 3, "wave 1 bumps old, parks mid and recent");
  const imp = es.filter((e) => e.t === "imported") as Extract<JournalEntry, { t: "imported" }>[];
  assert.deepEqual(imp.map((e) => e.nativeId), [old, mid, recent].map((i) => i.session.nativeId));
  for (const e of imp) {
    const it = all.find((i) => i.session.nativeId === e.nativeId)!;
    assert.deepEqual(e.source, { path: it.session.file.path, size: it.session.file.size, mtimeMs: e.source.mtimeMs });
    assert.ok(near(e.source.mtimeMs, it.session.file.mtimeMs), "imported carries the ORIGINAL mtime");
  }
  assert.equal(s.progress.length, 3);
  assert.equal(s.progress[0]!.wave, 1);
});

test("runWaves: a session T3 never imports is retried once in a later wave, then journaled import-failed with an S2 reason", async () => {
  const now = Date.now();
  const f = fakeT3({ instances: [inst("claudeAgent", null), inst("claude-org", null, { availability: "unavailable" })] });
  const s = setup(f, [ROOT, ROOT2]);
  const ok = transcript(f, s.dir, ROOT, now - 70 * DAY);
  const deep = transcript(f, s.dir, ROOT, now - 60 * DAY, { cost: 2 * 1024 * 1024 });
  const plain = transcript(f, s.dir, ROOT, now - 50 * DAY);
  const off = transcript(f, s.dir, ROOT2, now - 45 * DAY, { instanceId: "claude-org" });
  f.opts.never = new Set([deep, plain, off].map((i) => (i.action as { expectedThreadId: string }).expectedThreadId));
  const all = [ok, deep, plain, off];
  const r = await runWaves(s.ctx({ instanceAvailability: new Map([["claudeAgent", "available"], ["claude-org", "unavailable"]]) }), waves(all));
  assert.deepEqual(r.imported.map((i) => i.session.nativeId), [ok.session.nativeId]);
  const reasons = Object.fromEntries(r.failed.map((x) => [x.item.session.nativeId, x.reason]));
  assert.deepEqual(reasons, {
    [deep.session.nativeId]: "cwd-unreadable-in-t3",
    [plain.session.nativeId]: "not-imported",
    [off.session.nativeId]: "instance-unavailable",
  });
  assert.equal(f.calls.filter((c) => c === "scan").length, 2, "one retry wave, then stop");
  const failed = (await s.j.readAll()).filter((e) => e.t === "import-failed");
  assert.equal(failed.length, 3);
  assertRestored(originals(all));
});

test("runWaves: ProjectChanged from T3 -> project-mismatch after the retry; other projects of the wave still import", async () => {
  const now = Date.now();
  const f = fakeT3({ importError: (pid) => (pid === "p-1" ? new RpcError("agentSessions.import", { _tag: "AgentSessionImportProjectChangedError", projectId: pid }) : null) });
  const s = setup(f, [ROOT, ROOT2]);
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, s.dir, ROOT2, now - 59 * DAY);
  const r = await runWaves(s.ctx(), waves([a, b]));
  assert.deepEqual(r.imported.map((i) => i.session.nativeId), [b.session.nativeId]);
  assert.deepEqual(r.failed.map((x) => x.reason), ["project-mismatch"]);
  assertRestored(originals([a, b]));
});

test("runWaves: sessions already in T3 before their wave are journaled imported without a bump", async () => {
  const now = Date.now();
  const f = fakeT3();
  const s = setup(f);
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const tid = (a.action as { expectedThreadId: string }).expectedThreadId;
  f.threads.set(tid, { id: tid, projectId: "p-1", instanceId: "claudeAgent", archived: false, title: "t", updatedAt: 1 });
  const r = await runWaves(s.ctx(), waves([a]));
  assert.equal(r.imported.length, 1);
  assert.ok(!f.calls.some((c) => c.startsWith("import:")), "no importSessions");
  assert.ok(!(await s.j.readAll()).some((e) => e.t === "mtime-bump"));
});

test("runWaves: abort requested during a wave -> that wave restores, no new wave starts, result.aborted", async () => {
  const now = Date.now();
  let abort = false;
  const f = fakeT3({ onScan: () => { abort = true; } });
  const s = setup(f);
  const all = [transcript(f, s.dir, ROOT, now - 60 * DAY), transcript(f, s.dir, ROOT, now - 59 * DAY)];
  const o = originals(all);
  const batch = { filesPerProject: 1, projectsPerWave: 5 };
  const r = await runWaves(s.ctx({ batch, aborted: () => abort }), waves(all, batch));
  assert.equal(r.aborted, true);
  assert.equal(f.calls.filter((c) => c === "scan").length, 1);
  assert.equal(f.calls.filter((c) => c.startsWith("import:")).length, 0, "no import after the abort flag");
  assertRestored(o);
  assert.equal(r.failed.length, 0, "aborted items are not failures");
});

test("runWaves: a file written during the wave is never moved backwards by the restore", async () => {
  const now = Date.now();
  const f = fakeT3();
  const s = setup(f);
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  f.opts.onImport = () => { appendFileSync(a.session.file.path, "{}\n"); utimesSync(a.session.file.path, new Date(), new Date()); };
  const r = await runWaves(s.ctx(), waves([a]));
  assert.ok(Date.now() - statSync(a.session.file.path).mtimeMs < 60_000, "kept the fresh mtime");
  assert.equal(r.restoreErrors.length, 0);
  const es = await s.j.readAll();
  assert.ok(es.some((e) => e.t === "mtime-restore"), "bump resolved in the journal");
});

test("runWaves: parked files go to the FUTURE (now + 7 days + i ms), bumped ones to just before now; never a past mtime for a parked file", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const p1 = transcript(f, s.dir, ROOT, now - 5 * DAY);
  const p2 = transcript(f, s.dir, ROOT, now - 6 * DAY);
  const batch = { filesPerProject: 1, projectsPerWave: 5 };
  const seen: { path: string; mtime: number }[] = [];
  const { utimes } = await import("node:fs/promises");
  const spy = async (p: string, at: number, mt: number): Promise<void> => { seen.push({ path: p, mtime: mt * 1000 }); await utimes(p, at, mt); };
  await runWaves(s.ctx({ batch, utimes: spy }), waves([a, p1, p2], batch));
  const bump = (await s.j.readAll()).find((e) => e.t === "mtime-bump") as Extract<JournalEntry, { t: "mtime-bump" }>;
  const parkedFiles = bump.files.filter((x) => x.path !== a.session.file.path);
  assert.equal(parkedFiles.length, 2);
  for (const x of parkedFiles) {
    assert.ok(x.targetMtimeMs >= now + PARK_AHEAD_MS, "in the future");
    assert.ok(x.targetMtimeMs > x.mtimeMs, "never moved back in time");
  }
  assert.notEqual(parkedFiles[0]!.targetMtimeMs, parkedFiles[1]!.targetMtimeMs, "+ i ms");
  const bumped = bump.files.find((x) => x.path === a.session.file.path)!;
  assert.ok(bumped.targetMtimeMs <= Date.now() && bumped.targetMtimeMs > now - 60_000, "bumped just before now");
  const firstParkWrite = seen.find((x) => x.path === p1.session.file.path)!;
  assert.ok(firstParkWrite.mtime > now, "the utimes call itself set a future mtime");
});

test("runWaves: a project held in an early wave stays held for the rest of the run", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, s.dir, ROOT, now - 59 * DAY);
  const c = transcript(f, s.dir, ROOT, now - 58 * DAY);
  const busy = transcript(null, s.dir, ROOT, now - 60_000);
  const batch = { filesPerProject: 1, projectsPerWave: 5 };
  // The busy session is visible only while wave 2 is prepared (it goes idle-looking afterwards in this fake).
  const liveExposure = async (_root: string, wave: number) => (wave === 2 ? [{ path: busy.session.file.path, cwd: ROOT, threadIds: ["import:claudeAgent:busy"], refs: [] }] : []);
  const r = await runWaves(s.ctx({ batch, liveExposure }), waves([a, b, c], batch));
  assert.deepEqual(r.imported.map((i) => i.session.nativeId), [a.session.nativeId]);
  assert.deepEqual(r.deferred.map((d) => [d.item.session.nativeId, d.reason]), [[b.session.nativeId, "project-in-use"], [c.session.nativeId, "project-in-use"]]);
  assert.deepEqual(r.heldRoots, [ROOT]);
});

test("runWaves: a parked file written to between its stat and its utimes is named in a follow-up import-attempt", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const other = transcript(null, s.dir, ROOT, now - 4 * DAY);
  const { stat } = await import("node:fs/promises");
  const racing = async (p: string) => {
    const st = await stat(p);
    return p === other.session.file.path ? { size: st.size + 10, mtimeMs: st.mtimeMs } : st; // grew under us
  };
  const exposure = [{ path: other.session.file.path, cwd: ROOT, threadIds: [`import:claudeAgent:${other.session.nativeId}`], refs: [], harness: "claude" as const, nativeId: other.session.nativeId }];
  await runWaves(s.ctx({ stat: racing, exposure }), waves([a]));
  const attempts = (await s.j.readAll()).filter((e) => e.t === "import-attempt") as Extract<JournalEntry, { t: "import-attempt" }>[];
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0]!.items.map((x) => x.nativeId), [a.session.nativeId]);
  assert.deepEqual(attempts[1]!.items, [{ harness: "claude", nativeId: other.session.nativeId, threadId: `import:claudeAgent:${other.session.nativeId}` }]);
});

test("exposureOf: skips cwd-unreadable transcripts and Codex/Pi sessions whose instance is disabled or unavailable", async () => {
  const t = tempHome();
  const claude = transcript(null, t.dir, ROOT, Date.now() - 3 * DAY);
  const unreadable: PlanItem = { ...claude, session: { ...claude.session, flags: ["cwd-unreadable"] } };
  const codex: PlanItem = { ...claude, session: { ...claude.session, harness: "codex", accountId: null, file: { ...claude.session.file, path: "C:/x/rollout.jsonl" } } };
  const providers = [inst("claudeAgent", null), inst("codex", null, { driver: "codex", availability: "unavailable" })];
  assert.deepEqual(exposureOf([unreadable, codex], providers, "win32"), []);
  const ok = exposureOf([claude, codex], [inst("claudeAgent", null), inst("codex", null, { driver: "codex" })], "win32");
  assert.deepEqual(ok.map((x) => x.harness), ["claude", "codex"]);
  // A compressed rollout (convertible or not) is never read by T3 itself: not exposed as a Codex transcript.
  const zst = (mode: "convert" | undefined): PlanItem => ({ ...codex, session: { ...codex.session, ...(mode ? { mode } : {}), flags: ["compressed"], file: { ...codex.session.file, path: "C:/x/rollout.jsonl.zst" } } });
  assert.deepEqual(exposureOf([zst("convert"), zst(undefined)], [inst("claudeAgent", null), inst("codex", null, { driver: "codex" })], "win32"), []);
});

test("exposureIndex: a convert-import item (any harness, Codex included) costs the Claude metadata budget: its file is a Claude transcript", async () => {
  const { exposureIndex } = await import("../../src/apply/importer.ts");
  const t = tempHome();
  const claude = transcript(null, t.dir, ROOT, Date.now() - 3 * DAY);
  const conv: PlanItem = {
    session: { ...claude.session, harness: "codex", accountId: null, mode: "convert", flags: ["compressed"] },
    action: { kind: "convert-import", projectRoot: ROOT, instanceId: "claudeAgent", expectedThreadId: "import:claudeAgent:x", uuid: "x", targetFile: claude.session.file.path },
    notes: [],
  };
  const { rootKey } = await import("../../src/apply/waves.ts");
  const idx = exposureIndex({ entries: [], items: [conv], platform: "win32", inT3: () => false });
  const r = await idx.scan(rootKey(ROOT, "win32"), ROOT, Date.now, new Set(), 0);
  assert.equal(r.park.length, 1);
  assert.equal(r.park[0]!.source, "claude");
});

test("runWaves: a transcript written during the scan (mtime slightly AHEAD of the clock) holds the root", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const busy = transcript(null, s.dir, ROOT, now - 60 * DAY);
  const ahead = (Date.now() + 1000) / 1000;
  utimesSync(busy.session.file.path, ahead, ahead); // the writer's clock ran a second ahead of ours
  const exposure = [{ path: busy.session.file.path, cwd: ROOT, threadIds: ["import:claudeAgent:busy"], refs: [] }];
  const r = await runWaves(s.ctx({ exposure }), waves([a]));
  assert.deepEqual(r.imported, []);
  assert.deepEqual(r.deferred.map((d) => d.reason), ["project-in-use"]);
  assert.ok(!f.calls.includes("scan"), "never imported live");
});

test("runWaves: a parked leftover (mtime now + 7 days, from a crash) is neither parked again nor holding the root", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const left = transcript(null, s.dir, ROOT, now - 3 * DAY);
  const future = (now + PARK_AHEAD_MS) / 1000;
  utimesSync(left.session.file.path, future, future);
  const exposure = [{ path: left.session.file.path, cwd: ROOT, threadIds: ["import:claudeAgent:left"], refs: [] }];
  const r = await runWaves(s.ctx({ exposure }), waves([a]));
  assert.deepEqual(r.imported.map((i) => i.session.nativeId), [a.session.nativeId]);
  const bump = (await s.j.readAll()).find((e) => e.t === "mtime-bump") as Extract<JournalEntry, { t: "mtime-bump" }>;
  assert.ok(!bump.files.some((x) => x.path === left.session.file.path), "not parked again (T3 skips it already)");
});

// ---------- A1: clock jumps (suspend / time change) during a wave ----------

test("runWaves: a suspend of more than a day during an import call never lets a parked copy in (parked 7 days ahead)", async () => {
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  try {
    const f = fakeT3({ instances: [inst("claudeAgent", null)], onImport: () => { shift = 25 * 3_600_000; } });
    const s = setup(f);
    const a = transcript(f, s.dir, ROOT, realNow() - 40 * DAY);
    const mirror = transcript(f, s.dir, ROOT, realNow() - 5 * DAY, { instanceId: "claude-org" });
    const exposure = [{ path: mirror.session.file.path, cwd: ROOT, threadIds: [(mirror.action as { expectedThreadId: string }).expectedThreadId], refs: [], harness: "claude" as const, nativeId: mirror.session.nativeId }];
    await runWaves(s.ctx({ exposure, now: () => Date.now() }), waves([a]));
    assert.ok(PARK_AHEAD_MS >= 7 * DAY, "parked a week ahead");
    assert.ok(!f.threads.has((mirror.action as { expectedThreadId: string }).expectedThreadId), "the parked copy is never imported under its own instance");
  } finally { Date.now = realNow; }
});

test("runWaves: the clock jumping forward between the bump and the scan stops the wave: nothing scanned or imported, files restored, items deferred clock-jump", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const p = transcript(null, s.dir, ROOT, now - 5 * DAY); // an exposed copy: parked for the wave
  const o = originals([a, p]);
  let shift = 0;
  const { utimes } = await import("node:fs/promises");
  const sleepy = async (path: string, at: number, mt: number): Promise<void> => { await utimes(path, at, mt); shift = 31 * 60_000; };
  const exposure = [{ path: p.session.file.path, cwd: ROOT, threadIds: ["import:claude-org:p"], refs: [] }];
  const r = await runWaves(s.ctx({ exposure, now: () => Date.now() + shift, utimes: sleepy }), waves([a]));
  assert.ok((await s.j.readAll()).some((e) => e.t === "mtime-bump" && e.files.some((x) => x.path === p.session.file.path)), "the copy was parked");
  assert.ok(!f.calls.includes("scan"), "no scan after the jump");
  assert.ok(!f.calls.some((c) => c.startsWith("import:")));
  assert.deepEqual(r.deferred.filter((d) => d.reason === "clock-jump").map((d) => d.item.session.nativeId), [a.session.nativeId]);
  assert.equal(r.failed.length, 0);
  assert.equal(r.clockJumps, 1);
  assertRestored(o);
});

test("runWaves: the clock jumping forward after one project's import defers the wave's other projects (clock-jump); the first is verified", async () => {
  const f = fakeT3();
  const s = setup(f, [ROOT, ROOT2]);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, s.dir, ROOT2, now - 59 * DAY);
  let shift = 0;
  f.opts.onImport = () => { shift = 2 * 3_600_000; };
  const r = await runWaves(s.ctx({ now: () => Date.now() + shift }), waves([a, b]));
  assert.deepEqual(r.imported.map((i) => i.session.nativeId), [a.session.nativeId]);
  assert.deepEqual(r.deferred.map((d) => [d.item.session.nativeId, d.reason]), [[b.session.nativeId, "clock-jump"]]);
  assert.equal(f.calls.filter((c) => c.startsWith("import:")).length, 1, "the second project is never imported");
  assertRestored(originals([a, b]));
});

test("runWaves: the clock going backwards before the scan stops the wave (clock-jump)", async () => {
  const f = fakeT3();
  const s = setup(f);
  const a = transcript(f, s.dir, ROOT, Date.now() - 60 * DAY);
  let shift = 0;
  const { utimes } = await import("node:fs/promises");
  const back = async (path: string, at: number, mt: number): Promise<void> => { await utimes(path, at, mt); shift = -5 * 60_000; };
  const r = await runWaves(s.ctx({ now: () => Date.now() + shift, utimes: back }), waves([a]));
  assert.ok(!f.calls.includes("scan"));
  assert.deepEqual(r.deferred.map((d) => d.reason), ["clock-jump"]);
  assertRestored(originals([a]));
});

test("runWaves: a clock jump between the exposure scan and the bump (a stray future-dated file would enter the window) defers the wave clock-jump before any utimes", async () => {
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift; // a real suspend moves T3's clock too
  try {
    const f = fakeT3();
    const s = setup(f);
    const a = transcript(f, s.dir, ROOT, realNow() - 60 * DAY);
    // Stray: an hour ahead (beyond the active window), so the scan leaves it alone as "T3 skips it".
    const stray = transcript(f, s.dir, ROOT, realNow() + 3_600_000);
    const strayTid = (stray.action as { expectedThreadId: string }).expectedThreadId;
    const exposure = [{ path: stray.session.file.path, cwd: ROOT, threadIds: [strayTid], refs: [] }];
    let reads = 0;
    const touched: string[] = [];
    const { utimes } = await import("node:fs/promises");
    const spy = async (p: string, at: number, mt: number): Promise<void> => { touched.push(p); await utimes(p, at, mt); };
    // Reading 1: the wave's first (re-stat); reading 2: the scan's, right after statting the stray file. Then 2 h pass.
    const clock = (): number => { const t = Date.now(); if (++reads === 2) shift = 2 * 3_600_000; return t; };
    const r = await runWaves(s.ctx({ exposure, now: clock, utimes: spy }), waves([a]));
    assert.deepEqual(touched, [], "no utimes at all");
    assert.ok(!(await s.j.readAll()).some((e) => e.t === "mtime-bump"), "nothing journaled as bumped");
    assert.ok(!f.calls.includes("scan") && !f.calls.some((c) => c.startsWith("import:")));
    assert.ok(!f.threads.has(strayTid), "the stray file is never imported");
    assert.deepEqual(r.deferred.map((d) => [d.item.session.nativeId, d.reason]), [[a.session.nativeId, "clock-jump"]]);
    assert.equal(r.clockJumps, 1);
  } finally { Date.now = realNow; }
});

test("runWaves: the clock guard tolerates a 1 s backward step; a 5 s backward step stops the wave", async () => {
  const run = async (stepMs: number) => {
    const f = fakeT3();
    const s = setup(f);
    const a = transcript(f, s.dir, ROOT, Date.now() - 60 * DAY);
    let shift = 0;
    const { utimes } = await import("node:fs/promises");
    const back = async (path: string, at: number, mt: number): Promise<void> => { await utimes(path, at, mt); shift = -stepMs; };
    return { r: await runWaves(s.ctx({ now: () => Date.now() + shift, utimes: back }), waves([a])), f, a };
  };
  const small = await run(1000);
  assert.deepEqual(small.r.imported.map((i) => i.session.nativeId), [small.a.session.nativeId]);
  assert.equal(small.r.clockJumps, 0);
  const big = await run(5000);
  assert.deepEqual(big.r.deferred.map((d) => d.reason), ["clock-jump"]);
  assert.ok(!big.f.calls.includes("scan"));
});

test("runWaves: a later wave after a clock jump starts afresh (new bump time) and imports", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, s.dir, ROOT, now - 59 * DAY);
  let shift = 0, jumped = false;
  const { utimes } = await import("node:fs/promises");
  const once = async (path: string, at: number, mt: number): Promise<void> => { await utimes(path, at, mt); if (!jumped) { jumped = true; shift = 40 * 60_000; } };
  const batch = { filesPerProject: 1, projectsPerWave: 5 };
  // The jump is seen once (a real suspend moves T3's clock too; the fake judges with the wall clock, so it is undone).
  const clock = (): number => { const t = Date.now() + shift; shift = 0; return t; };
  const r = await runWaves(s.ctx({ batch, now: clock, utimes: once }), waves([a, b], batch));
  assert.deepEqual(r.deferred.map((d) => [d.item.session.nativeId, d.reason]), [[a.session.nativeId, "clock-jump"]]);
  assert.deepEqual(r.imported.map((i) => i.session.nativeId), [b.session.nativeId]);
});

test("runWaves: the import-attempt entry names the wave's parked copies under `parked`, apart from the items", async () => {
  const f = fakeT3();
  const s = setup(f);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const orgDir = join(s.home, ".claude-org", "projects", "C--work-demo");
  mkdirSync(orgDir, { recursive: true });
  const mirror = transcript(null, orgDir, ROOT, now - 3 * DAY);
  const tid = `import:claude-org:${mirror.session.nativeId}`;
  const exposure = [{ path: mirror.session.file.path, cwd: ROOT, threadIds: [tid], refs: [], harness: "claude" as const, nativeId: mirror.session.nativeId }];
  await runWaves(s.ctx({ exposure }), waves([a]));
  const att = (await s.j.readAll()).find((e) => e.t === "import-attempt") as Extract<JournalEntry, { t: "import-attempt" }>;
  assert.deepEqual(att.items.map((x) => x.nativeId), [a.session.nativeId]);
  assert.deepEqual(att.parked, [{ harness: "claude", nativeId: mirror.session.nativeId, threadId: tid }]);
});

// ---------- A4: parked files count against the wave's metadata budget ----------

/** Grows a synthetic transcript to `size` bytes (T3 never reads more of a file than it holds), keeping its mtime. */
function big(i: PlanItem, size: number): PlanItem {
  truncateSync(i.session.file.path, size);
  utimesSync(i.session.file.path, i.session.file.atimeMs / 1000, i.session.file.mtimeMs / 1000);
  return i;
}

test("runWaves: parked files are read first by T3's metadata pass: a wave whose bumped + parked cost exceeds 56 MiB is split by root", async () => {
  const MiB = 1024 * 1024;
  const f = fakeT3();
  const s = setup(f, [ROOT, ROOT2]);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, s.dir, ROOT2, now - 59 * DAY);
  // 40 copies per root, 0.8 MiB each to reach their cwd: 32 MiB of parked cost per root, 64 MiB together.
  const exposure = [ROOT, ROOT2].flatMap((root) => Array.from({ length: 40 }, () => {
    const c = big(transcript(null, s.dir, root, now - 3 * DAY), Math.floor(0.8 * MiB));
    return { path: c.session.file.path, cwd: root, threadIds: [`import:claude-org:${c.session.nativeId}`], refs: [], cost: Math.floor(0.8 * MiB) };
  }));
  const notices: string[] = [];
  const r = await runWaves(s.ctx({ exposure, onNotice: (l: string) => void notices.push(l) }), waves([a, b]));
  assert.deepEqual(r.imported.map((i) => i.session.nativeId).sort(), [a, b].map((i) => i.session.nativeId).sort());
  assert.equal(f.calls.filter((c) => c === "scan").length, 2, "one wave per root");
  const bumps = (await s.j.readAll()).filter((e) => e.t === "mtime-bump") as Extract<JournalEntry, { t: "mtime-bump" }>[];
  assert.equal(bumps.length, 2);
  assert.deepEqual(notices, [], "no root alone is over the budget");
});

test("runWaves: a single root whose bumped + parked cost alone exceeds the budget proceeds alone, with a warning line", async () => {
  const MiB = 1024 * 1024;
  const f = fakeT3();
  const s = setup(f, [ROOT, ROOT2]);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, s.dir, ROOT2, now - 59 * DAY);
  const exposure = Array.from({ length: 60 }, () => {
    const c = big(transcript(null, s.dir, ROOT, now - 3 * DAY), MiB);
    return { path: c.session.file.path, cwd: ROOT, threadIds: [`import:claude-org:${c.session.nativeId}`], refs: [], cost: MiB };
  });
  const notices: string[] = [];
  const r = await runWaves(s.ctx({ exposure, onNotice: (l: string) => void notices.push(l) }), waves([a, b]));
  assert.equal(r.imported.length, 2);
  assert.equal(f.calls.filter((c) => c === "scan").length, 2, "the heavy root went alone");
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /C:\/work\/demo/);
});

// ---------- B5: a busy file (EBUSY / EPERM / EACCES) holds its root, the run goes on ----------

const busyErr = () => Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });

test("runWaves: a bumped file that stays busy holds its root (deferred file-busy); other roots import; nothing thrown, files restored", async () => {
  const f = fakeT3();
  const s = setup(f, [ROOT, ROOT2]);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const a2 = transcript(f, s.dir, ROOT, now - 59 * DAY);
  const b = transcript(f, s.dir, ROOT2, now - 58 * DAY);
  const { utimes } = await import("node:fs/promises");
  let tries = 0;
  const busy = async (p: string, at: number, mt: number): Promise<void> => {
    if (p === a2.session.file.path && mt * 1000 > now - 60_000) { tries++; throw busyErr(); } // its bump only
    await utimes(p, at, mt);
  };
  const r = await runWaves(s.ctx({ utimes: busy, busyRetryMs: [1, 1, 1] }), waves([a, a2, b]));
  assert.equal(tries, 4, "tried, then retried 3 times");
  assert.deepEqual(r.imported.map((i) => i.session.nativeId), [b.session.nativeId]);
  assert.deepEqual(r.deferred.map((d) => [d.item.session.nativeId, d.reason]).sort(), [[a.session.nativeId, "file-busy"], [a2.session.nativeId, "file-busy"]].sort());
  assert.ok(!f.calls.includes("import:p-1"), "the busy root is not imported");
  assertRestored(originals([a, a2, b]));
});

test("runWaves: a parked copy that cannot be parked (busy) holds its root: never imported under its own account", async () => {
  const f = fakeT3();
  const s = setup(f, [ROOT, ROOT2]);
  const now = Date.now();
  const a = transcript(f, s.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, s.dir, ROOT2, now - 58 * DAY);
  const mirror = transcript(f, s.dir, ROOT, now - 3 * DAY, { instanceId: "claude-org" });
  const tid = (mirror.action as { expectedThreadId: string }).expectedThreadId;
  const { utimes } = await import("node:fs/promises");
  const busy = async (p: string, at: number, mt: number): Promise<void> => {
    if (p === mirror.session.file.path) throw busyErr();
    await utimes(p, at, mt);
  };
  const exposure = [{ path: mirror.session.file.path, cwd: ROOT, threadIds: [tid], refs: [], harness: "claude" as const, nativeId: mirror.session.nativeId }];
  const r = await runWaves(s.ctx({ utimes: busy, exposure, busyRetryMs: [1, 1, 1] }), waves([a, b]));
  assert.ok(!f.threads.has(tid), "the unparked copy was never exposed to an import call");
  assert.deepEqual(r.imported.map((i) => i.session.nativeId), [b.session.nativeId]);
  assert.deepEqual(r.deferred.map((d) => d.reason), ["file-busy"]);
  assertRestored(originals([a, b, mirror]));
});

test("runWaves: a file busy for a moment is retried and imported", async () => {
  const f = fakeT3();
  const s = setup(f);
  const a = transcript(f, s.dir, ROOT, Date.now() - 60 * DAY);
  const { utimes } = await import("node:fs/promises");
  let n = 0;
  const blip = async (p: string, at: number, mt: number): Promise<void> => { if (++n <= 2) throw busyErr(); await utimes(p, at, mt); };
  const r = await runWaves(s.ctx({ utimes: blip, busyRetryMs: [1, 1, 1] }), waves([a]));
  assert.equal(r.imported.length, 1);
  assert.deepEqual(r.deferred, []);
});
