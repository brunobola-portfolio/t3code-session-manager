// Rehome copies follow their original (Task 6, spec §5.1.4): synthetic transcripts in temp homes, the copy written by
// materializeConversions exactly as apply writes it, a fake T3. Never touches a real home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { followRehomed, FOLLOWS_PER_CYCLE, type FollowCtx } from "../../src/ops/follow.ts";
import { materializeConversions } from "../../src/apply/materialize.ts";
import { faithfulCopy } from "../../src/apply/copyTranscript.ts";
import { rollbackRun } from "../../src/ops/rollback.ts";
import { runSyncCycle, logLine, resultSummary, summaryLines, type SyncCycleDeps } from "../../src/ops/sync.ts";
import { markHistoryPass, readLastHistoryAt, readSyncStatus } from "../../src/ops/syncStatus.ts";
import { swapThreads } from "../../src/ops/merge.ts";
import { JournalWriteError } from "../../src/ops/quarantine.ts";
import { buildOrganizePlan } from "../../src/organize/plan.ts";
import { defaultConfig, organizeSettings, saveConfig } from "../../src/core/config.ts";
import { Journal } from "../../src/core/journal.ts";
import { encodeClaudeProjectDir } from "../../src/core/paths.ts";
import { revisionUuid, uuidV5 } from "../../src/core/uuid.ts";
import type { AccountConfig, DiscoveredSession, JournalEntry, PlanItem } from "../../src/core/types.ts";
import type { T3Api } from "../../src/t3/api.ts";
import { RpcClosed } from "../../src/t3/errors.ts";
import type { SourceAdapter } from "../../src/sources/types.ts";
import { DAY, fakeT3, inst, tempHome, type FakeT3 } from "../apply/fake-t3.ts";

const ROOT = "C:/work/demo";
const ORIG = "22222222-3333-4444-8555-666666666666";
const COPY_RUN = "20261101-100000-copy";
const RUN = "20261115-120000-folw";
type Rec = Record<string, unknown>;
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const parse = (p: string): Rec[] => readFileSync(p, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Rec);

/** One home-folder conversation and its faithful copy in ROOT, imported as `import:claudeAgent:<copy>`. */
interface Conv {
  src: string; copyId: string; copy: string; copyThread: string;
  /** Appends one record to the original; idle (mtime = its own time, in the past) unless `active`. */
  grow(text: string, o?: { active?: boolean; extra?: Rec }): void;
  /** Sets the original's mtime: in use (now) or idle. */
  touch(active: boolean): void;
}

interface Env extends Conv {
  home: string; claudeHome: string; dir: string; state: string; homeCwd: string;
  f: FakeT3; journal: Journal;
  /** Another conversation of the same home folder, copied and imported the same way. */
  add(id: string, o?: { title?: string; ageDays?: number }): Promise<Conv>;
}

/**
 * A home-folder conversation (the folder T3 Code refuses), its faithful copy in ROOT written and journaled by
 * materializeConversions (as `t3sm apply` does), imported as thread `import:claudeAgent:<copy>` titled `title` with
 * `settled` as its settledOverride.
 */
async function env(o: { title?: string; settled?: "settled" | "active" | null } = {}): Promise<Env> {
  const t = tempHome();
  const claudeHome = join(t.home, ".claude");
  const homeCwd = t.home;
  const srcDir = join(claudeHome, "projects", encodeClaudeProjectDir(homeCwd));
  mkdirSync(srcDir, { recursive: true });
  const f = fakeT3({ instances: [inst("claudeAgent", claudeHome)] });
  f.projects.push({ id: "p1", title: "demo", workspaceRoot: ROOT, defaultModelSelection: { instanceId: "claudeAgent", model: "m" }, archived: false, deleted: false, pinned: false, createdAt: null } as never);
  // T3's scan sees every transcript of the project folder (a revision included, once it exists).
  f.opts.onScan = () => {
    for (const x of readdirSync(t.dir)) {
      const p = join(t.dir, x);
      if (x.endsWith(".jsonl") && !f.files.some((y) => y.path === p)) f.files.push({ path: p, root: ROOT });
    }
  };
  const journal = new Journal(join(t.state, "journal.jsonl"));
  const accounts: AccountConfig[] = [{ id: "claudeAgent", home: claudeHome, displayName: "Personal", accentColor: null }];

  const conversation = async (id: string, c: { title?: string; settled?: "settled" | "active" | null; ageDays?: number }): Promise<Conv> => {
    const src = join(srcDir, `${id}.jsonl`);
    const t0 = Date.now() - (c.ageDays ?? 3) * DAY;
    const at = (n: number): string => new Date(t0 + n * 60_000).toISOString();
    let n = 0;
    const rec = (type: "user" | "assistant", text: string, extra: Rec = {}): string =>
      JSON.stringify({ parentUuid: n === 1 ? null : `u-${n - 1}`, isSidechain: false, cwd: homeCwd, sessionId: id, type, message: { role: type, content: text }, uuid: `u-${n}`, timestamp: at(n), ...extra }) + "\n";
    const touch = (active: boolean): void => {
      const m = active ? Date.now() / 1000 : (t0 + n * 60_000) / 1000;
      utimesSync(src, m, m);
    };
    const grow = (text: string, g: { active?: boolean; extra?: Rec } = {}): void => {
      n++;
      appendFileSync(src, rec(n % 2 === 1 ? "user" : "assistant", text, g.extra));
      touch(g.active === true);
    };
    grow("synthetic question about the demo");
    grow("synthetic answer");
    const copyId = uuidV5(`claude:${id}`);
    const copy = join(t.dir, `${copyId}.jsonl`);
    const st = statSync(src);
    const session: DiscoveredSession = {
      harness: "claude", accountId: "claudeAgent", nativeId: id, cwd: homeCwd, startedAt: at(1), updatedAt: at(n), messageCount: n, corruptLines: 0,
      file: { path: src, size: st.size, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs }, flags: [], cwdOffsetBytes: 0,
    };
    const copyThread = `import:claudeAgent:${copyId}`;
    const item: PlanItem = {
      session,
      action: { kind: "convert-import", projectRoot: ROOT, instanceId: "claudeAgent", expectedThreadId: copyThread, uuid: copyId, targetFile: copy, copy: "faithful", rehomeFrom: homeCwd },
      notes: [],
    };
    const m = await materializeConversions([item], new Map(), accounts, journal, COPY_RUN, {});
    assert.deepEqual(m.written, [copy], JSON.stringify(m));
    const cst = statSync(copy);
    await journal.append({ t: "imported", runId: COPY_RUN, harness: "claude", nativeId: id, threadId: copyThread, source: { path: copy, size: cst.size, mtimeMs: cst.mtimeMs } });
    f.threads.set(copyThread, { id: copyThread, projectId: "p1", instanceId: "claudeAgent", archived: false, title: c.title ?? "Home chat", updatedAt: cst.mtimeMs, settledOverride: c.settled ?? null });
    f.files.push({ path: copy, root: ROOT, threadId: copyThread });
    return { src, copyId, copy, copyThread, grow, touch };
  };
  const first = await conversation(ORIG, o);
  return { ...first, home: t.home, claudeHome, dir: t.dir, state: t.state, homeCwd, f, journal, add: (id, c = {}) => conversation(id, c) };
}

function ctx(e: Env, over: Partial<FollowCtx> = {}): FollowCtx {
  return { api: e.f.api, journal: e.journal, runId: RUN, now: Date.now, accountHomes: { claudeAgent: e.claudeHome }, mode: "revision", ...over };
}

const kinds = (es: JournalEntry[]): string[] => es.map((x) => x.t).filter((t) => t !== "mtime-bump" && t !== "mtime-restore" && t !== "import-attempt");
const jsonlIn = (dir: string): string[] => readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort();
const none = { followed: 0, conflicts: [], deferred: 0, failed: [] };

test("revision mode: original grew, copy untouched: one revision, old thread archived, title and visibility carried", async () => {
  const e = await env({ title: "Home chat", settled: "settled" });
  const copyBytes = readFileSync(e.copy);
  e.grow("continued in VS Code from the home folder");
  e.grow("and answered there");
  const srcBytes = readFileSync(e.src);
  const srcSt = statSync(e.src);
  const rev = revisionUuid(e.copyId, srcSt.size);
  const revFile = join(e.dir, `${rev}.jsonl`);
  const newThread = `import:claudeAgent:${rev}`;

  const r = await followRehomed(ctx(e));
  assert.deepEqual(r, { followed: 1, conflicts: [], deferred: 0, failed: [] });

  // The revision is the faithful copy of the grown original, under its own id, in the project folder.
  assert.equal(readFileSync(revFile, "utf8"), (await faithfulCopy(e.src, {
    cwd: parse(e.copy)[0]!.cwd as string, sessionId: rev, provenance: { fromPath: e.src, fromSessionId: ORIG, fromCwd: e.homeCwd },
  })).text);
  const recs = parse(revFile);
  assert.equal(recs.filter((x) => x.type === "user" || x.type === "assistant").length, 4);
  assert.ok(recs.filter((x) => "sessionId" in x).every((x) => x.sessionId === rev));
  assert.deepEqual(jsonlIn(e.dir), [`${e.copyId}.jsonl`, `${rev}.jsonl`].sort(), "exactly one revision");

  // Threads: the new one active with the old one's title and settled state; the old one archived.
  const nt = e.f.threads.get(newThread)!;
  assert.equal(nt.archived, false);
  assert.equal(nt.title, "Home chat");
  assert.equal(nt.settledOverride, "settled");
  assert.equal(e.f.threads.get(e.copyThread)!.archived, true);
  assert.ok(e.f.calls.indexOf(`archive:${e.copyThread}`) > e.f.calls.indexOf(`title:${newThread}:Home chat`), "archived only after the new thread is ready");

  // The original and the copy are never modified.
  assert.deepEqual(readFileSync(e.src), srcBytes);
  assert.equal(statSync(e.src).mtimeMs, srcSt.mtimeMs);
  assert.deepEqual(readFileSync(e.copy), copyBytes);

  // Everything journaled, in order.
  const mine = (await e.journal.readAll()).filter((x) => x.runId === RUN);
  assert.deepEqual(kinds(mine), ["file-written", "imported", "organize-change", "organize-change", "thread-archived", "merged", "followed"]);
  const fw = mine[0] as Extract<JournalEntry, { t: "file-written" }>;
  assert.equal(fw.path, revFile);
  assert.equal(fw.sha256, sha(revFile));
  assert.deepEqual(fw.revisionOf, { harness: "claude", nativeId: e.copyId });
  assert.deepEqual(fw.rehomeOf, { path: e.src, nativeId: ORIG, cwd: e.homeCwd, size: srcSt.size, mtimeMs: srcSt.mtimeMs });
  assert.equal(fw.source?.messageCount, 4);
  const oc = mine.filter((x): x is Extract<JournalEntry, { t: "organize-change" }> => x.t === "organize-change");
  assert.deepEqual(oc.map((x) => [x.kind, x.target, x.previous, x.next]), [["title", newThread, "t", "Home chat"], ["settle", newThread, null, "settled"]]);
  assert.deepEqual(mine.find((x) => x.t === "merged"), {
    t: "merged", runId: RUN, harness: "claude", nativeId: e.copyId, revisionUuid: rev, revisionFile: revFile,
    oldThreadId: e.copyThread, newThreadId: newThread, sourceSize: srcSt.size, sourceMtimeMs: srcSt.mtimeMs,
  });
  assert.deepEqual(mine.at(-1), { t: "followed", runId: RUN, original: e.src, copy: revFile, oldThread: e.copyThread, newThread, mode: "revision" });

  // Nothing more to do: the revision is now the copy that follows the original.
  const n = (await e.journal.readAll()).length;
  assert.deepEqual(await followRehomed(ctx(e, { runId: "20261115-130000-folw" })), none);
  assert.equal((await e.journal.readAll()).length, n);

  // It grows again: the revision is followed in turn (its thread archived), never the archived first copy.
  e.grow("a third turn in VS Code");
  const rev2 = revisionUuid(e.copyId, statSync(e.src).size);
  const r2 = await followRehomed(ctx(e, { runId: "20261115-140000-folw" }));
  assert.equal(r2.followed, 1, JSON.stringify(r2));
  assert.equal(e.f.threads.get(newThread)!.archived, true);
  assert.equal(e.f.threads.get(`import:claudeAgent:${rev2}`)!.archived, false);
  assert.equal(e.f.threads.get(`import:claudeAgent:${rev2}`)!.title, "Home chat");
  assert.deepEqual([...e.f.threads.values()].filter((x) => !x.archived).map((x) => x.id), [`import:claudeAgent:${rev2}`], "one active thread");
});

test("revision mode: an active (unsettled by hand) old thread makes the new one active too; an unchanged title is not rewritten", async () => {
  const e = await env({ title: "t", settled: "active" });
  e.grow("continued in VS Code");
  const rev = revisionUuid(e.copyId, statSync(e.src).size);
  const newThread = `import:claudeAgent:${rev}`;
  const r = await followRehomed(ctx(e));
  assert.equal(r.followed, 1, JSON.stringify(r));
  assert.equal(e.f.threads.get(newThread)!.settledOverride, "active");
  assert.ok(!e.f.calls.some((c) => c.startsWith(`title:${newThread}`)), "same title: nothing sent");
  const oc = (await e.journal.readAll()).filter((x): x is Extract<JournalEntry, { t: "organize-change" }> => x.t === "organize-change");
  assert.deepEqual(oc.map((x) => [x.kind, x.previous, x.next]), [["unsettle", null, "active"]]);
});

test("refresh mode: original grew, copy untouched: the copy is rewritten in place (same id) and imported again; one thread", async () => {
  const e = await env();
  e.grow("continued in VS Code from the home folder");
  const srcSt = statSync(e.src);
  const before = e.f.calls.length;
  const r = await followRehomed(ctx(e, { mode: "refresh" }));
  assert.deepEqual(r, { followed: 1, conflicts: [], deferred: 0, failed: [] });
  assert.equal(readFileSync(e.copy, "utf8"), (await faithfulCopy(e.src, {
    cwd: parse(e.copy)[0]!.cwd as string, sessionId: e.copyId, provenance: { fromPath: e.src, fromSessionId: ORIG, fromCwd: e.homeCwd },
  })).text);
  assert.match(readFileSync(e.copy, "utf8"), /continued in VS Code/);
  assert.deepEqual(jsonlIn(e.dir), [`${e.copyId}.jsonl`], "same file, same id");
  assert.ok(e.f.calls.slice(before).includes("import:p1"), "agentSessions.import called again");
  assert.deepEqual([...e.f.threads.values()].map((x) => [x.id, x.archived]), [[e.copyThread, false]]);
  const mine = (await e.journal.readAll()).filter((x) => x.runId === RUN);
  assert.deepEqual(kinds(mine), ["file-written", "imported", "followed"]);
  const fw = mine[0] as Extract<JournalEntry, { t: "file-written" }>;
  assert.equal(fw.path, e.copy);
  assert.deepEqual(fw.rehomeOf, { path: e.src, nativeId: ORIG, cwd: e.homeCwd, size: srcSt.size, mtimeMs: srcSt.mtimeMs });
  assert.deepEqual(mine.at(-1), { t: "followed", runId: RUN, original: e.src, copy: e.copy, oldThread: e.copyThread, newThread: null, mode: "refresh" });
  assert.deepEqual(await followRehomed(ctx(e, { mode: "refresh", runId: "20261115-130000-folw" })), none, "followed: nothing left");

  // Rolling the refresh back keeps the copy: T3's thread already holds its records.
  const rb = await rollbackRun(RUN, { journal: e.journal, accountHomes: [e.claudeHome], connect: async () => e.f.api });
  assert.ok(existsSync(e.copy));
  assert.deepEqual(rb.filesRemoved, []);
  assert.deepEqual(rb.filesKeptRefreshed, [e.copy]);
  // The kept copy is still the one that follows: no conflict with itself, and a later growth refreshes it again. (A
  // rollback that undid something else of the run journals `rolled-back` for all of it: as here.)
  await e.journal.append({ t: "rolled-back", runId: "20261115-145900-rlbk", targetRunId: RUN, at: new Date().toISOString() });
  assert.deepEqual(await followRehomed(ctx(e, { mode: "refresh", runId: "20261115-150000-folw" })), none);
  e.grow("later work in VS Code");
  assert.equal((await followRehomed(ctx(e, { mode: "refresh", runId: "20261115-160000-folw" }))).followed, 1);
  assert.match(readFileSync(e.copy, "utf8"), /later work in VS Code/);
});

for (const mode of ["revision", "refresh"] as const) {
  test(`${mode} mode: copy continued in T3 and original grew: conflict listed, nothing written`, async () => {
    const e = await env({ title: "Renamed in T3" });
    appendFileSync(e.copy, JSON.stringify({ type: "user", cwd: ROOT, sessionId: e.copyId, entrypoint: "t3-code", message: { role: "user", content: "more in T3" }, uuid: "t-1", timestamp: new Date().toISOString() }) + "\n");
    const old = (Date.now() - DAY) / 1000;
    utimesSync(e.copy, old, old);
    e.grow("and more in VS Code");
    const copyBytes = readFileSync(e.copy);
    const n = (await e.journal.readAll()).length;
    const calls = e.f.calls.length;
    const r = await followRehomed(ctx(e, { mode }));
    assert.deepEqual(r, { followed: 0, deferred: 0, failed: [], conflicts: [{ original: e.src, copy: e.copy, originalTitle: "synthetic question about the demo", copyTitle: "Renamed in T3" }] });
    assert.equal((await e.journal.readAll()).length, n, "nothing journaled");
    assert.deepEqual(readFileSync(e.copy), copyBytes);
    assert.deepEqual(jsonlIn(e.dir), [`${e.copyId}.jsonl`]);
    assert.deepEqual(e.f.calls.slice(calls).filter((x) => x !== "close"), [], "nothing sent to T3");
  });
}

test("Review Focus 1: follow waits while the original or the copy is active and never writes two revisions", async () => {
  const e = await env();
  const n0 = (await e.journal.readAll()).length;
  // The original grows and is still being written: deferred, nothing written.
  e.grow("first new turn", { active: true });
  assert.deepEqual(await followRehomed(ctx(e)), { ...none, deferred: 1 });
  e.grow("second new turn", { active: true });
  assert.deepEqual(await followRehomed(ctx(e, { runId: "20261115-121000-folw" })), { ...none, deferred: 1 });
  assert.deepEqual(jsonlIn(e.dir), [`${e.copyId}.jsonl`]);
  assert.equal((await e.journal.readAll()).length, n0, "nothing journaled while it waits");

  // The original is idle but the copy is in use (opened in T3 a moment ago, same bytes): deferred too.
  e.touch(false);
  const now = Date.now() / 1000;
  utimesSync(e.copy, now, now);
  assert.deepEqual(await followRehomed(ctx(e, { runId: "20261115-122000-folw" })), { ...none, deferred: 1 });
  assert.deepEqual(jsonlIn(e.dir), [`${e.copyId}.jsonl`]);

  // Both idle: exactly one revision, of the final size.
  const old = (Date.now() - DAY) / 1000;
  utimesSync(e.copy, old, old);
  const r = await followRehomed(ctx(e, { runId: "20261115-123000-folw" }));
  assert.equal(r.followed, 1, JSON.stringify(r));
  const rev = revisionUuid(e.copyId, statSync(e.src).size);
  assert.deepEqual(jsonlIn(e.dir), [`${e.copyId}.jsonl`, `${rev}.jsonl`].sort());
  assert.match(readFileSync(join(e.dir, `${rev}.jsonl`), "utf8"), /second new turn/);
  assert.deepEqual(await followRehomed(ctx(e, { runId: "20261115-124000-folw" })), none);
  assert.equal(jsonlIn(e.dir).length, 2, "never a second revision");
  assert.equal((await e.journal.readAll()).filter((x) => x.t === "file-written" && x.revisionOf).length, 1);
});

test("original deleted: nothing, no error", async () => {
  const e = await env();
  e.grow("continued");
  rmSync(e.src);
  const n = (await e.journal.readAll()).length;
  assert.deepEqual(await followRehomed(ctx(e)), none);
  assert.deepEqual(await followRehomed(ctx(e, { mode: "refresh" })), none);
  assert.equal((await e.journal.readAll()).length, n);
  assert.deepEqual(jsonlIn(e.dir), [`${e.copyId}.jsonl`]);
});

test("an original that did not grow (or the copy's thread archived by the user): nothing, no error", async () => {
  const e = await env();
  assert.deepEqual(await followRehomed(ctx(e)), none, "not grown");
  e.grow("continued");
  e.f.threads.get(e.copyThread)!.archived = true;
  assert.deepEqual(await followRehomed(ctx(e)), none, "archived by the user: left alone");
  assert.deepEqual(jsonlIn(e.dir), [`${e.copyId}.jsonl`]);
});

test("compacted original refused with reason compacted", async () => {
  const e = await env();
  e.grow("summary of the earlier conversation", { extra: { type: "system", subtype: "compact_boundary", message: undefined } });
  e.grow("after the compaction");
  const n = (await e.journal.readAll()).length;
  const r = await followRehomed(ctx(e));
  assert.deepEqual(r, { ...none, failed: [{ copy: e.copy, reason: "compacted" }] });
  assert.equal((await e.journal.readAll()).length, n);
  assert.deepEqual(jsonlIn(e.dir), [`${e.copyId}.jsonl`]);
  assert.equal(e.f.threads.get(e.copyThread)!.archived, false);
});

test("T3 down: deferred, retried next cycle", async () => {
  const e = await env();
  e.grow("continued while T3 Code is closed");
  const down = { ...e.f.api, listThreads: async () => { throw new RpcClosed(); }, listProjects: async () => { throw new RpcClosed(); } } as T3Api;
  const n = (await e.journal.readAll()).length;
  assert.deepEqual(await followRehomed(ctx(e, { api: down })), { ...none, deferred: 1 });
  assert.equal((await e.journal.readAll()).length, n, "nothing journaled");
  assert.deepEqual(jsonlIn(e.dir), [`${e.copyId}.jsonl`]);

  // T3 drops right after the revision is written (the import cannot be verified): deferred, the revision kept for reuse.
  let lists = 0;
  const flaky = { ...e.f.api, listThreads: async () => { if (++lists > 1) throw new RpcClosed(); return e.f.api.listThreads(); } } as T3Api;
  const r1 = await followRehomed(ctx(e, { api: flaky, runId: "20261115-121000-folw" }));
  assert.deepEqual(r1, { ...none, deferred: 1 });
  assert.equal(e.f.threads.get(e.copyThread)!.archived, false, "old thread untouched");

  // Next cycle, T3 back: followed once, the kept revision reused (one revision file).
  const r2 = await followRehomed(ctx(e, { runId: "20261115-122000-folw" }));
  assert.equal(r2.followed, 1, JSON.stringify(r2));
  assert.equal(e.f.threads.get(e.copyThread)!.archived, true);
  assert.equal(jsonlIn(e.dir).length, 2);
  const revWrites = (await e.journal.readAll()).filter((x): x is Extract<JournalEntry, { t: "file-written" }> => x.t === "file-written" && !!x.revisionOf);
  assert.deepEqual(revWrites.map((x) => x.runId), ["20261115-121000-folw", "20261115-122000-folw"], "written once, journaled again by the run that reuses it");
  assert.equal(new Set(revWrites.map((x) => x.sha256)).size, 1);
});

test(`at most FOLLOWS_PER_CYCLE (${FOLLOWS_PER_CYCLE}) follows per cycle: over the limit, a copy waits for the next cycle`, async () => {
  const e = await env();
  e.grow("continued");
  const n = (await e.journal.readAll()).length;
  assert.deepEqual(await followRehomed(ctx(e, { limit: 0 })), { ...none, deferred: 1 });
  assert.equal((await e.journal.readAll()).length, n);
  assert.equal((await followRehomed(ctx(e, { limit: 1 }))).followed, 1);
});

// ---------- sync ----------

function adapterOf(items: PlanItem[]): SourceAdapter {
  return { id: "claude", mode: "native", isAvailable: async () => true, async *discover() { for (const i of items) yield i.session; } };
}

function syncDeps(e: Env, over: Partial<SyncCycleDeps> = {}): SyncCycleDeps {
  const api = { ...e.f.api, getConfig: async () => ({ settings: { providerInstances: { claudeAgent: { driver: "claudeAgent", config: { homePath: e.claudeHome } } } }, providers: [] }) } as T3Api;
  return {
    home: e.home, stateDir: e.state, env: { T3SM_HOME: e.state }, now: Date.now,
    adapters: [adapterOf([])], existsDir: async () => true, isT3Running: async () => true,
    connect: async () => api, signals: { on() {}, off() {} }, ...over,
  };
}

test("sync follows a rehome copy whatever sync.autoMerge says, inside the cycle's own run; rollback of the sync run undoes the follow", async () => {
  const e = await env({ title: "Home chat", settled: "settled" });
  const c = defaultConfig([{ id: "claudeAgent", home: e.claudeHome, displayName: "Claude", accentColor: null }]);
  await saveConfig(e.state, { ...c, sync: { ...c.sync, autoMerge: false } });
  e.grow("continued in VS Code");
  const srcBytes = readFileSync(e.src);
  const copyBytes = readFileSync(e.copy);
  const rev = revisionUuid(e.copyId, statSync(e.src).size);
  const revFile = join(e.dir, `${rev}.jsonl`);
  const newThread = `import:claudeAgent:${rev}`;

  const o = await runSyncCycle(syncDeps(e));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  if (o.kind !== "ok") return;
  assert.equal(o.counts.followed, 1);
  assert.ok(o.runId);
  const es = await e.journal.readAll();
  const run = es.filter((x) => x.runId === o.runId);
  assert.deepEqual(run.map((x) => x.t).filter((t) => t === "run-start" || t === "followed" || t === "run-end"), ["run-start", "followed", "run-end"]);
  assert.match((run[0] as { command: string }).command, /^sync /, "the cycle's own run, not a sync-merge run");
  assert.match(logLine(o, Date.now()), / followed=1/);
  assert.ok(summaryLines(o).some((l) => /followed (its|their) original/.test(l)), summaryLines(o).join("\n"));
  assert.equal(e.f.threads.get(e.copyThread)!.archived, true);
  assert.equal(e.f.threads.get(newThread)!.archived, false);

  const rb = await rollbackRun(o.runId, { journal: e.journal, accountHomes: [e.claudeHome], connect: async () => e.f.api });
  assert.deepEqual(rb.errors, []);
  assert.deepEqual(rb.organize.filter((x) => x.status === "failed"), [], "the carried title and settled state stay with the archived revision thread");
  assert.deepEqual(rb.filesRemoved, [revFile]);
  assert.ok(!existsSync(revFile));
  assert.equal(e.f.threads.get(e.copyThread)!.archived, false, "the copy's thread is back");
  assert.equal(e.f.threads.get(e.copyThread)!.title, "Home chat");
  assert.equal(e.f.threads.get(newThread)!.archived, true, "the revision's thread archived");
  assert.deepEqual(readFileSync(e.src), srcBytes, "the original untouched");
  assert.deepEqual(readFileSync(e.copy), copyBytes, "the copy untouched");

  // The next cycle does not follow the same state again (the user rolled it back); a later growth is followed.
  const again = await runSyncCycle(syncDeps(e));
  assert.equal(again.kind, "noop", JSON.stringify(again));
  e.grow("later work in VS Code");
  const later = await runSyncCycle(syncDeps(e));
  assert.equal(later.kind, "ok", JSON.stringify(later));
  if (later.kind === "ok") assert.equal(later.counts.followed, 1);
  assert.equal(e.f.threads.get(e.copyThread)!.archived, true);
});

// ---------- review fixes (round 1) ----------

test("the per-cycle limit counts real attempts only: a compacted original older than a good one never takes the slot; the refusal is reported once per state", async () => {
  const e = await env();
  const bad = await e.add("44444444-3333-4444-8555-666666666666", { ageDays: 6 });
  bad.grow("summary of the earlier conversation", { extra: { type: "system", subtype: "compact_boundary", message: undefined } });
  bad.grow("after the compaction");
  e.grow("continued in VS Code");
  assert.ok(statSync(bad.src).mtimeMs < statSync(e.src).mtimeMs, "the compacted one sorts first");

  const r = await followRehomed(ctx(e, { limit: 1, stateDir: e.state }));
  assert.deepEqual(r, { followed: 1, conflicts: [], deferred: 0, failed: [{ copy: bad.copy, reason: "compacted" }] });
  assert.equal(e.f.threads.get(e.copyThread)!.archived, true, "the good one followed");
  assert.equal(e.f.threads.get(bad.copyThread)!.archived, false);
  assert.ok(existsSync(join(e.state, "cache", "follow.json")));

  // The same state of the compacted original: not reported (nor read) again.
  assert.deepEqual(await followRehomed(ctx(e, { limit: 1, stateDir: e.state, runId: "20261115-130000-folw" })), none);
  // It changes: judged again, and still refused.
  bad.grow("more after the compaction");
  const r3 = await followRehomed(ctx(e, { limit: 1, stateDir: e.state, runId: "20261115-140000-folw" }));
  assert.deepEqual(r3.failed, [{ copy: bad.copy, reason: "compacted" }]);
});

test("the copy typed into in T3 Code during the import: the old thread is never archived; the revision's thread goes back to the archive; a conflict; rollback keeps it archived", async () => {
  const e = await env({ title: "Home chat" });
  e.grow("continued in VS Code");
  const rev = revisionUuid(e.copyId, statSync(e.src).size);
  const revFile = join(e.dir, `${rev}.jsonl`);
  const newThread = `import:claudeAgent:${rev}`;
  e.f.opts.onImport = () => {
    appendFileSync(e.copy, JSON.stringify({ type: "user", cwd: ROOT, sessionId: e.copyId, entrypoint: "t3-code", message: { role: "user", content: "typed in T3 meanwhile" }, uuid: "t-1", timestamp: new Date().toISOString() }) + "\n");
    const old = (Date.now() - DAY) / 1000;
    utimesSync(e.copy, old, old);
  };
  const r = await followRehomed(ctx(e));
  assert.deepEqual(r, { followed: 0, deferred: 0, failed: [], conflicts: [{ original: e.src, copy: e.copy, originalTitle: "synthetic question about the demo", copyTitle: "Home chat" }] });
  assert.equal(e.f.threads.get(e.copyThread)!.archived, false, "never forked: the thread the user is typing in stays");
  assert.equal(e.f.threads.get(newThread)!.archived, true, "the revision's thread is archived back");
  assert.equal(e.f.threads.get(newThread)!.title, "t", "nothing carried onto it");
  const mine = (await e.journal.readAll()).filter((x) => x.runId === RUN);
  assert.deepEqual(kinds(mine), ["file-written", "imported", "thread-archived"]);
  assert.deepEqual(mine.at(-1), { t: "thread-archived", runId: RUN, threadId: newThread });

  const rb = await rollbackRun(RUN, { journal: e.journal, accountHomes: [e.claudeHome], connect: async () => e.f.api });
  assert.deepEqual(rb.errors, []);
  assert.deepEqual(rb.filesRemoved, [revFile]);
  assert.equal(e.f.threads.get(newThread)!.archived, true, "the revision's thread stays archived");
  assert.equal(e.f.threads.get(e.copyThread)!.archived, false);
  assert.deepEqual(rb.threadsUnarchived, []);
});

test("the copy only in use during the import: the revision's thread goes back to the archive and the next cycle finishes the follow", async () => {
  const e = await env();
  e.grow("continued in VS Code");
  const rev = revisionUuid(e.copyId, statSync(e.src).size);
  const newThread = `import:claudeAgent:${rev}`;
  e.f.opts.onImport = () => { const now = Date.now() / 1000; utimesSync(e.copy, now, now); };
  assert.deepEqual(await followRehomed(ctx(e)), { ...none, deferred: 1 });
  assert.equal(e.f.threads.get(e.copyThread)!.archived, false);
  assert.equal(e.f.threads.get(newThread)!.archived, true);

  e.f.opts.onImport = undefined;
  const old = (Date.now() - DAY) / 1000;
  utimesSync(e.copy, old, old);
  const r = await followRehomed(ctx(e, { runId: "20261115-130000-folw" }));
  assert.equal(r.followed, 1, JSON.stringify(r));
  assert.equal(e.f.threads.get(newThread)!.archived, false, "unarchived (journaled) before the old one is archived");
  assert.equal(e.f.threads.get(e.copyThread)!.archived, true);
  const revWrites = (await e.journal.readAll()).filter((x): x is Extract<JournalEntry, { t: "file-written" }> => x.t === "file-written" && !!x.revisionOf);
  assert.deepEqual(revWrites.map((x) => x.runId), [RUN, "20261115-130000-folw"], "the revision reused (journaled again by the run that swaps it in)");
  assert.equal(new Set(revWrites.map((x) => x.sha256)).size, 1);
});

test("a journal failure during the swap aborts with JournalWriteError (never an ordinary failure the cycle goes on after)", async () => {
  const e = await env();
  e.grow("continued in VS Code");
  const j = new Journal(join(e.state, "journal.jsonl"));
  const append = j.append.bind(j);
  j.append = async (x: JournalEntry) => {
    if (x.t === "thread-archived") throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    return append(x);
  };
  await assert.rejects(followRehomed(ctx(e, { journal: j })), (err: Error) => err instanceof JournalWriteError && /ENOSPC/.test(err.message));

  // The unarchive step too: its journal failure is a JournalWriteError, not "archive-failed".
  const f = fakeT3();
  f.threads.set("import:claudeAgent:new", { id: "import:claudeAgent:new", projectId: "p1", instanceId: "claudeAgent", archived: true, title: "t", updatedAt: 0 });
  f.threads.set("import:claudeAgent:old", { id: "import:claudeAgent:old", projectId: "p1", instanceId: "claudeAgent", archived: false, title: "t", updatedAt: 0 });
  const j2 = new Journal(join(e.state, "journal2.jsonl"));
  j2.append = async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
  await assert.rejects(swapThreads({ api: f.api, journal: j2, runId: RUN, oldThreadId: "import:claudeAgent:old", newThreadId: "import:claudeAgent:new" }), JournalWriteError);
  assert.equal(f.threads.get("import:claudeAgent:old")!.archived, false, "stopped before the old thread was archived");
});

test("sync: conflicts are named in the summary with both titles and kept in sync-status.json (session ids, never paths); a later cycle without them clears them", async () => {
  const e = await env({ title: "Renamed in T3" });
  appendFileSync(e.copy, JSON.stringify({ type: "user", cwd: ROOT, sessionId: e.copyId, entrypoint: "t3-code", message: { role: "user", content: "more in T3" }, uuid: "t-1", timestamp: new Date().toISOString() }) + "\n");
  const old = (Date.now() - DAY) / 1000;
  utimesSync(e.copy, old, old);
  e.grow("and more in VS Code");
  const o = await runSyncCycle(syncDeps(e));
  assert.equal(o.kind, "noop", JSON.stringify(o));
  const lines = summaryLines(o);
  assert.ok(lines.some((l) => /continued both in T3 Code and outside it.*`t3sm status`/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes(`"synthetic question about the demo" (outside T3 Code, session ${ORIG}) and "Renamed in T3" (in T3 Code, session ${e.copyId})`)), lines.join("\n"));
  const want = [{ originalId: ORIG, copyId: e.copyId, originalTitle: "synthetic question about the demo", copyTitle: "Renamed in T3" }];
  assert.deepEqual((await readSyncStatus(e.state)).followConflicts, want);
  assert.deepEqual(resultSummary(o).followConflictList, want);
  const raw = readFileSync(join(e.state, "sync-status.json"), "utf8");
  assert.ok(!raw.includes(e.home.replaceAll("\\", "\\\\")) && !raw.includes(".jsonl"), "no path in sync-status.json");

  rmSync(e.src); // the original is gone: no conflict any more
  await runSyncCycle(syncDeps(e));
  assert.equal((await readSyncStatus(e.state)).followConflicts, undefined);
  assert.ok(!readFileSync(join(e.state, "sync-status.json"), "utf8").includes("followConflicts"));
});

// ---------- final review A: runs that build on each other ----------

const activeIds = (e: Env): string[] => [...e.f.threads.values()].filter((x) => !x.archived).map((x) => x.id).sort();
const RUN_A = "20261115-120000-runa";
const RUN_B = "20261115-130000-runb";
const RUN_C = "20261115-140000-runc";
const rollback = (e: Env, runId: string, over: Record<string, unknown> = {}) =>
  rollbackRun(runId, { journal: e.journal, accountHomes: [e.claudeHome], connect: async () => e.f.api, ...over });

for (const variant of ["in-use", "archive-failed"] as const) {
  test(`C1 (${variant}): a later cycle that reuses a revision journals it again; rolling back the earlier run keeps it, rolling back the later one undoes the swap`, async () => {
    const e = await env({ title: "Home chat" });
    e.grow("continued in VS Code");
    const rev = revisionUuid(e.copyId, statSync(e.src).size);
    const revFile = join(e.dir, `${rev}.jsonl`);
    const newThread = `import:claudeAgent:${rev}`;
    if (variant === "in-use") e.f.opts.onImport = () => { const now = Date.now() / 1000; utimesSync(e.copy, now, now); };
    else { let once = true; e.f.opts.writeError = (call) => (call === `archive:${e.copyThread}` && once ? (once = false, { error: new Error("boom") }) : undefined); }
    const a = await followRehomed(ctx(e, { runId: RUN_A }));
    assert.equal(a.followed, 0, JSON.stringify(a));
    e.f.opts.onImport = undefined;
    const old = (Date.now() - DAY) / 1000;
    utimesSync(e.copy, old, old);
    const b = await followRehomed(ctx(e, { runId: RUN_B }));
    assert.equal(b.followed, 1, JSON.stringify(b));
    assert.deepEqual(activeIds(e), [newThread]);
    const fwB = (await e.journal.readAll()).filter((x): x is Extract<JournalEntry, { t: "file-written" }> => x.t === "file-written" && x.runId === RUN_B);
    assert.equal(fwB.length, 1, "the reused revision is journaled in the run that swaps it in");
    assert.equal(fwB[0]!.path, revFile);
    assert.equal(fwB[0]!.sha256, sha(revFile));
    assert.deepEqual(fwB[0]!.revisionOf, { harness: "claude", nativeId: e.copyId });
    assert.equal(fwB[0]!.rehomeOf?.size, statSync(e.src).size);

    // Rolling back A keeps the revision: it is the transcript of the conversation's only active thread.
    const ra = await rollback(e, RUN_A, { archiveThreads: true });
    assert.deepEqual(ra.errors, []);
    assert.deepEqual(ra.filesRemoved, []);
    assert.deepEqual(ra.filesKeptRewritten, [revFile]);
    assert.deepEqual(ra.needsReview, []);
    assert.ok(existsSync(revFile));
    assert.deepEqual(activeIds(e), [newThread], "B's thread stays the active one");

    // Rolling back B undoes the swap: the copy's thread back, the revision's thread archived, the revision removed.
    const rbB = await rollback(e, RUN_B);
    assert.deepEqual(rbB.errors, []);
    assert.deepEqual(rbB.filesRemoved, [revFile]);
    assert.deepEqual(activeIds(e), [e.copyThread]);
    assert.ok(existsSync(e.copy));
  });
}

test("C2: rolling back an earlier follow of a chain changes nothing while a later run built on it; rolled back in order, the copy's thread alone is back", async () => {
  const e = await env({ title: "Home chat" });
  e.grow("turn 2"); e.grow("turn 2 answer");
  const r1 = revisionUuid(e.copyId, statSync(e.src).size);
  const r1File = join(e.dir, `${r1}.jsonl`);
  const t1 = `import:claudeAgent:${r1}`;
  assert.equal((await followRehomed(ctx(e, { runId: RUN_A }))).followed, 1);
  e.grow("turn 3"); e.grow("turn 3 answer");
  const r2 = revisionUuid(e.copyId, statSync(e.src).size);
  const r2File = join(e.dir, `${r2}.jsonl`);
  const t2 = `import:claudeAgent:${r2}`;
  assert.equal((await followRehomed(ctx(e, { runId: RUN_B }))).followed, 1);
  assert.deepEqual(activeIds(e), [t2]);
  const titleOfT1 = e.f.threads.get(t1)!.title;

  const n = (await e.journal.readAll()).length;
  const calls = e.f.calls.length;
  for (const archiveThreads of [false, true]) {
    const ra = await rollback(e, RUN_A, { archiveThreads });
    assert.equal(ra.runId, null, "nothing written");
    assert.deepEqual(ra.filesRemoved, []);
    assert.deepEqual(ra.threadsUnarchived, []);
    assert.deepEqual(ra.threadsArchived, []);
    assert.deepEqual(ra.mergesKept, [{ nativeId: e.copyId, revisionFile: r1File, reason: `followed again by run ${RUN_B}; roll back ${RUN_B} first` }]);
    assert.deepEqual(ra.organize.filter((x) => x.status === "reverted"), [], "the carried title stays");
  }
  assert.equal((await e.journal.readAll()).length, n);
  assert.deepEqual(e.f.calls.slice(calls).filter((x) => x !== "close"), [], "nothing sent to T3");
  assert.ok(existsSync(r1File) && existsSync(r2File));
  assert.deepEqual(activeIds(e), [t2]);
  assert.equal(e.f.threads.get(t1)!.title, titleOfT1);

  const rbB = await rollback(e, RUN_B);
  assert.deepEqual(rbB.errors, []);
  assert.deepEqual(rbB.filesRemoved, [r2File]);
  assert.deepEqual(activeIds(e), [t1]);
  const ra = await rollback(e, RUN_A);
  assert.deepEqual(ra.errors, []);
  assert.deepEqual(ra.filesRemoved, [r1File]);
  assert.deepEqual(activeIds(e), [e.copyThread], "the copy's thread alone");
  assert.ok(existsSync(e.copy));
});

test("C2: a later follow whose rollback kept it (its revision continued since) still holds the earlier one", async () => {
  const e = await env({ title: "Home chat" });
  e.grow("turn 2");
  const r1File = join(e.dir, `${revisionUuid(e.copyId, statSync(e.src).size)}.jsonl`);
  assert.equal((await followRehomed(ctx(e, { runId: RUN_A }))).followed, 1);
  e.grow("turn 3");
  const r2 = revisionUuid(e.copyId, statSync(e.src).size);
  const r2File = join(e.dir, `${r2}.jsonl`);
  assert.equal((await followRehomed(ctx(e, { runId: RUN_B }))).followed, 1);
  // Continued in T3 Code since: B's rollback keeps its merge whole.
  appendFileSync(r2File, JSON.stringify({ type: "user", cwd: ROOT, sessionId: r2, entrypoint: "t3-code", message: { role: "user", content: "typed in T3" }, uuid: "t-9", timestamp: new Date(Date.now() - DAY).toISOString() }) + "\n");
  const old = (Date.now() - DAY) / 1000;
  utimesSync(r2File, old, old);
  // B did something else that its rollback does undo, so B is journaled as rolled back.
  const other = "import:claudeAgent:44444444-0000-4000-8000-000000000001";
  e.f.threads.set(other, { id: other, projectId: "p1", instanceId: "claudeAgent", archived: true, title: "New title", updatedAt: 0 });
  await e.journal.append({ t: "organize-change", runId: RUN_B, kind: "title", target: other, previous: "Old title", next: "New title" });
  const rbB = await rollback(e, RUN_B);
  assert.deepEqual(rbB.mergesKept.map((x) => x.reason), ["revision continued"]);
  assert.ok(rbB.runId !== null && e.f.threads.get(other)!.title === "Old title", "B is rolled back");
  const ra = await rollback(e, RUN_A);
  assert.deepEqual(ra.mergesKept, [{ nativeId: e.copyId, revisionFile: r1File, reason: `followed again by run ${RUN_B}; roll back ${RUN_B} first` }]);
  assert.deepEqual(ra.filesRemoved, []);
  assert.ok(existsSync(r1File));
  assert.deepEqual(activeIds(e), [`import:claudeAgent:${r2}`], "the thread the user continues stays the only active one");
});

test("I1 (in use): a swap put off, then more growth: the archived revision is left as it is and the follow goes on to the new size", async () => {
  const e = await env();
  e.grow("continued in VS Code");
  const r1 = revisionUuid(e.copyId, statSync(e.src).size);
  const r1File = join(e.dir, `${r1}.jsonl`);
  e.f.opts.onImport = () => { const now = Date.now() / 1000; utimesSync(e.copy, now, now); };
  assert.deepEqual(await followRehomed(ctx(e, { runId: RUN_A })), { ...none, deferred: 1 });
  e.f.opts.onImport = undefined;
  const old = (Date.now() - DAY) / 1000;
  utimesSync(e.copy, old, old);
  e.grow("more in VS Code before the next cycle");
  const r2 = revisionUuid(e.copyId, statSync(e.src).size);
  const b = await followRehomed(ctx(e, { runId: RUN_B }));
  assert.deepEqual(b, { ...none, followed: 1 });
  assert.deepEqual(activeIds(e), [`import:claudeAgent:${r2}`]);
  assert.equal(e.f.threads.get(`import:claudeAgent:${r1}`)!.archived, true);
  assert.ok(existsSync(r1File), "an archived thread keeps its transcript");
  assert.deepEqual(await followRehomed(ctx(e, { runId: RUN_C })), none);
});

test("I1 (archive failed): the next cycle finishes that swap first, the one after follows the new growth; one active thread", async () => {
  const e = await env({ title: "Home chat" });
  e.grow("continued in VS Code");
  const r1 = revisionUuid(e.copyId, statSync(e.src).size);
  const t1 = `import:claudeAgent:${r1}`;
  let once = true;
  e.f.opts.writeError = (call) => (call === `archive:${e.copyThread}` && once ? (once = false, { error: new Error("boom") }) : undefined);
  const a = await followRehomed(ctx(e, { runId: RUN_A }));
  assert.deepEqual(a.failed.map((x) => x.reason), ["archive-failed"]);
  assert.deepEqual(activeIds(e), [e.copyThread, t1].sort(), "two threads active after A");
  const sizeR1 = statSync(e.src).size;
  e.grow("more in VS Code before the next cycle");
  const b = await followRehomed(ctx(e, { runId: RUN_B }));
  assert.deepEqual(b, { ...none, followed: 1 });
  assert.deepEqual(activeIds(e), [t1], "the swap of A finished");
  const merged = (await e.journal.readAll()).filter((x): x is Extract<JournalEntry, { t: "merged" }> => x.t === "merged" && x.runId === RUN_B);
  assert.deepEqual(merged.map((x) => [x.oldThreadId, x.newThreadId, x.sourceSize]), [[e.copyThread, t1, sizeR1]]);
  assert.equal(e.f.threads.get(t1)!.title, "Home chat");
  const r2 = revisionUuid(e.copyId, statSync(e.src).size);
  const c = await followRehomed(ctx(e, { runId: RUN_C }));
  assert.deepEqual(c, { ...none, followed: 1 });
  assert.deepEqual(activeIds(e), [`import:claudeAgent:${r2}`]);
  assert.deepEqual(await followRehomed(ctx(e, { runId: "20261115-150000-rund" })), none);
});

test("I2: a conflict the user settles by archiving the copy's thread is not reported again", async () => {
  const e = await env();
  appendFileSync(e.copy, JSON.stringify({ type: "user", sessionId: e.copyId, cwd: ROOT, uuid: "t3-1", parentUuid: "u-2", message: { role: "user", content: "typed in T3" }, timestamp: new Date(Date.now() - DAY).toISOString() }) + "\n");
  const old = (Date.now() - DAY) / 1000;
  utimesSync(e.copy, old, old);
  e.grow("continued in VS Code");
  assert.equal((await followRehomed(ctx(e))).conflicts.length, 1);
  e.f.threads.get(e.copyThread)!.archived = true;
  assert.deepEqual(await followRehomed(ctx(e, { runId: RUN_B })), none);
  e.f.threads.delete(e.copyThread);
  assert.deepEqual(await followRehomed(ctx(e, { runId: RUN_C })), none, "nor when T3 Code no longer has it");
});

const planOf = async (e: Env, now: number, cfg = defaultConfig([])) => buildOrganizePlan({
  runId: "plan", threads: await e.f.api.listThreads(), projects: e.f.projects, journal: await e.journal.readAll(),
  config: organizeSettings(cfg, "en"), sessions: new Map(), now, scope: { allowPins: false, allowDeletes: false },
});

for (const arrive of ["settled", null] as const) {
  test(`I3: a settle the user made by hand stays theirs after a follow (the import arrives ${arrive ?? "with no override"})`, async () => {
    // t3sm unsettled the copy's thread (the history rule); the user then settled it by hand.
    const e = await env({ settled: "settled" });
    const t0 = new Date(Date.now() - 2 * DAY).toISOString();
    await e.journal.append({ t: "run-start", runId: "20261113-100000-hist", at: t0, command: "organize" });
    await e.journal.append({ t: "organize-change", runId: "20261113-100000-hist", kind: "unsettle", target: e.copyThread, previous: "settled", next: "active" });
    await e.journal.append({ t: "run-end", runId: "20261113-100000-hist", at: t0, status: "ok" });
    const th = e.f.threads.get(e.copyThread)!;
    th.settledAt = new Date(Date.now() - DAY).toISOString();
    th.unsettledAt = t0;
    assert.deepEqual((await planOf(e, Date.now())).actions, [], "before the follow: the user's choice");
    e.grow("continued in VS Code");
    const imp = e.f.api.importSessions;
    e.f.api.importSessions = async (...a: Parameters<typeof imp>) => {
      const r = await imp(...a);
      for (const t of e.f.threads.values()) if (t.id !== e.copyThread && !t.archived) { t.settledOverride = arrive; t.settledAt = arrive ? new Date().toISOString() : null; }
      return r;
    };
    assert.equal((await followRehomed(ctx(e))).followed, 1);
    assert.deepEqual((await planOf(e, Date.now() + 1000)).actions, [], "after the follow: still the user's choice");
  });
}

test("I3: a thread the user unsettled by hand stays shown after a follow (never settled by the history rule)", async () => {
  const e = await env({ settled: "active" }); // shown: only a person makes that state
  const base = defaultConfig([]);
  const cfg = { ...base, organize: { ...base.organize, history: { days: 1, minPerProject: 0 } } };
  assert.deepEqual((await planOf(e, Date.now(), cfg)).actions, []);
  e.grow("continued in VS Code");
  assert.equal((await followRehomed(ctx(e))).followed, 1);
  assert.deepEqual((await planOf(e, Date.now() + 1000, cfg)).actions, []);
});

test("I4: a stop signal during the sync's organize step: no follow and no merge after it", async () => {
  const e = await env();
  const c = defaultConfig([{ id: "claudeAgent", home: e.claudeHome, displayName: "Claude", accentColor: null }]);
  await saveConfig(e.state, { ...c, organize: { ...c.organize, history: { days: 1, minPerProject: 0 } }, sync: { ...c.sync, autoMerge: true } });
  e.grow("continued in VS Code");
  const handlers = new Set<() => void>();
  const signals = { on: (_s: string, f: () => void) => void handlers.add(f), off: (_s: string, f: () => void) => void handlers.delete(f) };
  e.f.opts.writeError = (call) => { if (call.startsWith("settle:")) for (const h of [...handlers]) h(); return undefined; };
  const o = await runSyncCycle(syncDeps(e, { signals }));
  assert.ok(e.f.calls.some((x) => x.startsWith("settle:")), `organize ran: ${e.f.calls.join(" ")}`);
  assert.ok(!e.f.calls.some((x) => x.startsWith("import:")), `nothing imported after the signal: ${JSON.stringify(o)}`);
  assert.equal(e.f.threads.get(e.copyThread)!.archived, false, "not followed");
  assert.deepEqual(jsonlIn(e.dir), [`${e.copyId}.jsonl`]);
  assert.ok(!(await e.journal.readAll()).some((x) => x.t === "run-start" && x.command.startsWith("sync-merge")));
});

// ---------- final review A: cycle-level ----------

/** History on, one thread old enough to settle: a daily pass plans exactly one settle. */
async function historyConfig(e: Env, autoMerge = false): Promise<void> {
  const c = defaultConfig([{ id: "claudeAgent", home: e.claudeHome, displayName: "Claude", accentColor: null }]);
  await saveConfig(e.state, { ...c, organize: { ...c.organize, history: { days: 1, minPerProject: 0 } }, sync: { ...c.sync, autoMerge } });
}

test("sync: a journal failure inside the follow step ends the cycle as an error (never as an ordinary failure)", async () => {
  const e = await env();
  e.grow("continued in VS Code");
  const file = join(e.state, "journal.jsonl");
  // T3 Code archives the old thread, then the journal cannot be written: the cycle must stop as an error.
  e.f.opts.writeError = (call) => { if (call === `archive:${e.copyThread}`) chmodSync(file, 0o444); return undefined; };
  try {
    const o = await runSyncCycle(syncDeps(e));
    assert.equal(o.kind, "error", JSON.stringify(o));
    if (o.kind === "error") assert.ok(o.error instanceof JournalWriteError, String(o.error));
  } finally {
    chmodSync(file, 0o644);
  }
});

test("sync: the whole organize step failing is journaled with its reason (organize-failed, kind organize)", async () => {
  const e = await env();
  await historyConfig(e);
  const list = e.f.api.listThreads;
  e.f.api.listThreads = async () => {
    if (new Error().stack?.includes("buildOrganize")) throw new Error("synthetic organize failure");
    return list();
  };
  const o = await runSyncCycle(syncDeps(e));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  if (o.kind !== "ok") return;
  assert.equal(o.counts.organizeFailed, 1);
  const failed = (await e.journal.readAll()).filter((x) => x.t === "organize-failed");
  assert.deepEqual(failed.map((x) => x.t === "organize-failed" && [x.runId, x.kind, x.target, x.projectId, x.error]), [[o.runId, "organize", "history", null, "Unexpected error: synthetic organize failure"]]);
});

test("sync: a history pass dated in the future (the clock went back) is due", async () => {
  const e = await env();
  await historyConfig(e);
  await markHistoryPass(e.state, new Date(Date.now() + DAY));
  await runSyncCycle(syncDeps(e));
  assert.ok(e.f.calls.includes(`settle:${e.copyThread}`), e.f.calls.join(" "));
  const at = await readLastHistoryAt(e.state);
  assert.ok(at !== null && at <= Date.now(), "marked again, at the cycle's time");
});
