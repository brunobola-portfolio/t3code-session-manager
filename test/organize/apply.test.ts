import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { THREAD_BATCH, applyOrganize, failureText, undoOrganize } from "../../src/organize/apply.ts";
import { JournalWriteError } from "../../src/ops/quarantine.ts";
import { buildOrganizePlan } from "../../src/organize/plan.ts";
import type { OrganizeAction, OrganizeKind, OrganizePlan } from "../../src/organize/types.ts";
import { Journal, organizeFailures } from "../../src/core/journal.ts";
import type { JournalEntry } from "../../src/core/types.ts";
import { organizeSettings } from "../../src/core/config.ts";
import { TESTED_VERSIONS, organizeGate } from "../../src/t3/compat.ts";
import { RpcClosed, RpcError, RpcTimeout, ShapeError, T3HttpError } from "../../src/t3/errors.ts";
import type { T3Project, T3Thread } from "../../src/t3/api.ts";
import { fakeT3, type FakeT3 } from "../apply/fake-t3.ts";
import { cfg } from "../plan/helpers.ts";

// Synthetic fixtures only: invented ids, titles and `C:/work/...` folders.

const VERIFIED = "0.1.10-nightly.20261113.4630";
const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const temps: string[] = [];
after(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true }); });

function journal(): Journal {
  const d = mkdtempSync(join(tmpdir(), "t3sm-organize-"));
  temps.push(d);
  return new Journal(join(d, "journal.jsonl"));
}

const A = "import:claudeAgent:aaaa", B = "import:claudeAgent:bbbb", C = "import:claudeAgent:cccc";

function project(id: string, o: Partial<T3Project> = {}): T3Project {
  return { id, title: id.toUpperCase(), workspaceRoot: `C:/work/${id}`, defaultModelSelection: null, archived: false, deleted: false, pinned: false, createdAt: null, ...o };
}

function thread(id: string, o: Partial<T3Thread> = {}): T3Thread & { updatedAt: number } {
  return {
    id, projectId: "p1", instanceId: "claudeAgent", archived: false, title: "A tidy title",
    latestUserMessageAt: "2026-11-10T10:00:00.000Z", settledOverride: "settled", settledAt: "2026-11-11T10:00:00.000Z", unsettledAt: null,
    updatedAt: NOW, ...o,
  };
}

/** p1 holds a, b, c; p2 is an empty project t3sm created; p3 unpinned, p4 pinned. Auto-settle 7 days. */
function world(o: Parameters<typeof fakeT3>[0] = {}): FakeT3 {
  const f = fakeT3({ version: VERIFIED, ...o });
  f.projects.push(project("p1"), project("p2", { title: "new-chat" }), project("p3"), project("p4", { pinned: true }));
  f.threads.set(A, thread(A));
  f.threads.set(B, thread(B, { title: "<command-name>/clear</command-name>" }));
  f.threads.set(C, thread(C));
  f.autoSettleDays = 7;
  return f;
}

const act = (kind: OrganizeKind, target: string, previous: unknown, next: unknown, projectId: string | null = "p1"): OrganizeAction =>
  ({ kind, target, projectId, previous, next, reason: "test" });

/** One action of every kind organize plans today. */
function allActions(): OrganizeAction[] {
  return [
    act("archive", A, false, true),
    act("title", B, "<command-name>/clear</command-name>", "Fix the login form"),
    act("unsettle", C, "settled", "active"),
    act("pin", "p3", false, true, "p3"),
    act("unpin", "p4", true, false, "p4"),
    act("project-delete", "p2", { title: "new-chat", workspaceRoot: "C:/work/p2" }, null, "p2"),
    act("auto-settle", "sidebarAutoSettleAfterDays", 7, null, null),
  ];
}

function plan(actions: OrganizeAction[], runId = "org-run-1"): OrganizePlan {
  const counts = { archive: 0, title: 0, unsettle: 0, settle: 0, pin: 0, unpin: 0, "project-delete": 0, "project-title": 0, "auto-settle": 0 } as Record<OrganizeKind, number>;
  for (const a of actions) counts[a.kind]++;
  return { runId, actions, counts, byProject: [] };
}

/** What a user sees: every thread and project field organize touches, plus the setting. */
function state(f: FakeT3): unknown {
  return {
    threads: [...f.threads.values()].map((t) => ({ id: t.id, archived: t.archived, title: t.title, settled: t.settledOverride ?? null })),
    // Sorted by root: a re-created project gets a new id and lands at the end of T3's list.
    projects: f.projects.filter((p) => !p.deleted).map((p) => ({ title: p.title, root: p.workspaceRoot, pinned: p.pinned })).sort((a, b) => a.root.localeCompare(b.root)),
    autoSettle: f.autoSettleDays,
  };
}

const writes = (f: FakeT3): string[] => f.calls.filter((c) => c !== "close");
const changes = (es: JournalEntry[]) => es.filter((e): e is Extract<JournalEntry, { t: "organize-change" }> => e.t === "organize-change");

const UNTESTED_WARNING = "Warning: T3 Code 0.2.0 has not been tested with t3sm (tested: 0.1.8-nightly.20261105.4218, 0.1.9-nightly.20261110.4465, 0.1.10-nightly.20261113.4630). Proceeding; every change is journaled and can be undone with t3sm rollback.";

test("organizeGate never throws: silent on the verified version and with allowUntested, one warning otherwise", () => {
  assert.ok(TESTED_VERSIONS.includes(VERIFIED));
  const notices: string[] = [];
  const onNotice = (l: string) => notices.push(l);
  organizeGate(VERIFIED, { allowUntested: false, onNotice });
  organizeGate("0.2.0", { allowUntested: true, onNotice });
  assert.deepEqual(notices, []);
  organizeGate("0.2.0", { allowUntested: false, onNotice });
  assert.deepEqual(notices, [UNTESTED_WARNING]);
});

test("organize warns but proceeds on an unverified T3 version", async () => {
  const f = world({ version: "0.2.0" });
  const j = journal();
  const notices: string[] = [];
  const r = await applyOrganize(plan(allActions()), { api: f.api, journal: j, runId: "org-run-1", onNotice: (l) => notices.push(l) });
  assert.deepEqual(notices, [UNTESTED_WARNING]);
  assert.deepEqual(r, { done: 7, skippedChanged: 0, failed: [], status: "ok" });
  assert.equal(writes(f).length, 7);
  assert.equal(changes(await j.readAll()).length, 7);
});

test("each action calls the right API and journals previous/next", async () => {
  const f = world();
  const j = journal();
  const progress: string[] = [];
  const r = await applyOrganize(plan(allActions()), { api: f.api, journal: j, runId: "org-run-1", now: () => NOW, onProgress: (l) => progress.push(l) });
  assert.deepEqual(r, { done: 7, skippedChanged: 0, failed: [], status: "ok" });
  assert.deepEqual(writes(f), [
    `archive:${A}`, `title:${B}:Fix the login form`, `unsettle:${C}`, "pin:p3:true", "pin:p4:false", "delete-project:p2", "auto-settle:null",
  ]);
  assert.equal(f.threads.get(A)!.archived, true);
  assert.equal(f.threads.get(B)!.title, "Fix the login form");
  assert.equal(f.threads.get(C)!.settledOverride, "active");
  assert.deepEqual(f.projects.map((p) => [p.id, p.pinned, p.deleted]), [["p1", false, false], ["p2", false, true], ["p3", true, false], ["p4", false, false]]);
  assert.equal(f.autoSettleDays, null);

  const es = await j.readAll();
  assert.deepEqual(es[0], { t: "run-start", runId: "org-run-1", at: new Date(NOW).toISOString(), command: "organize" });
  assert.deepEqual(es.at(-1), { t: "run-end", runId: "org-run-1", at: new Date(NOW).toISOString(), status: "ok" });
  assert.deepEqual(changes(es).map(({ kind, target, previous, next, runId }) => ({ runId, kind, target, previous, next })),
    allActions().map(({ kind, target, previous, next }) => ({ runId: "org-run-1", kind, target, previous, next })));
  assert.equal(es.length, 9);
  assert.equal(progress.length, 7);
});

test("the journal entry is written only after T3 accepted the command", async () => {
  const j = journal();
  let seenAtWrite: number | null = null;
  const f = world();
  // Spy: the title write must happen before its organize-change entry exists.
  const orig = f.api.setThreadTitle;
  f.api.setThreadTitle = async (id, title) => {
    seenAtWrite = changes(await j.readAll()).filter((e) => e.target === id).length;
    return orig(id, title);
  };
  await applyOrganize(plan([allActions()[1]!]), { api: f.api, journal: j, runId: "org-run-1" });
  assert.equal(seenAtWrite, 0);
  assert.equal(changes(await j.readAll()).length, 1);
});

test("a failed action does not stop the others, status partial", async () => {
  const f = world({ writeError: (call) => (call.startsWith("title:") ? { error: new Error("thread was deleted meanwhile") } : undefined) });
  const j = journal();
  const r = await applyOrganize(plan(allActions()), { api: f.api, journal: j, runId: "org-run-1" });
  assert.equal(r.status, "partial");
  assert.equal(r.done, 6);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0]!.action.kind, "title");
  assert.match(r.failed[0]!.error, /deleted meanwhile/);
  const es = await j.readAll();
  assert.deepEqual(changes(es).map((e) => e.kind), ["archive", "unsettle", "pin", "unpin", "project-delete", "auto-settle"]);
  assert.equal((es.at(-1) as Extract<JournalEntry, { t: "run-end" }>).status, "partial");
});

test("an action whose target changed since the plan is skipped (skippedChanged), never failed or journaled", async () => {
  const f = world();
  // The user renamed b, archived c, pinned p3 themselves, and a thread appeared in p2 after the plan was built.
  f.threads.get(B)!.title = "My own title";
  f.threads.get(C)!.archived = true;
  f.threads.get(C)!.settledOverride = "active";
  f.projects.find((p) => p.id === "p3")!.pinned = true;
  f.threads.set("import:claudeAgent:dddd", thread("import:claudeAgent:dddd", { projectId: "p2" }));
  f.autoSettleDays = 14;
  const j = journal();
  const r = await applyOrganize(plan(allActions()), { api: f.api, journal: j, runId: "org-run-1" });
  assert.deepEqual({ done: r.done, skipped: r.skippedChanged, failed: r.failed.length, status: r.status }, { done: 2, skipped: 5, failed: 0, status: "ok" });
  assert.deepEqual(writes(f), [`archive:${A}`, "pin:p4:false"]);
  assert.equal(f.threads.get(B)!.title, "My own title");
  assert.equal(f.autoSettleDays, 14);
  assert.deepEqual(changes(await j.readAll()).map((e) => e.target), [A, "p4"]);
});

test("a plan whose every action is stale writes nothing to the journal", async () => {
  const f = world();
  f.threads.get(A)!.archived = true;
  const j = journal();
  const r = await applyOrganize(plan([allActions()[0]!]), { api: f.api, journal: j, runId: "org-run-1" });
  assert.deepEqual(r, { done: 0, skippedChanged: 1, failed: [], status: "ok" });
  assert.deepEqual(await j.readAll(), []);
});

test("auto-settle: the value is read before writing; a write that throws after T3 applied it is confirmed by re-reading and journaled", async () => {
  const f = world({ writeError: (call) => (call.startsWith("auto-settle:") ? { error: new ShapeError("server.updateSettings", "$", "settings"), applied: true } : undefined) });
  const j = journal();
  const reads: string[] = [];
  const orig = f.api.getServerSetting;
  f.api.getServerSetting = async (k) => { reads.push(`read:${f.calls.length}`); return orig(k); };
  const r = await applyOrganize(plan([allActions()[6]!]), { api: f.api, journal: j, runId: "org-run-1" });
  assert.deepEqual(r, { done: 1, skippedChanged: 0, failed: [], status: "ok" });
  assert.equal(reads[0], "read:0", "read before the write");
  assert.ok(reads.length >= 2, "re-read after the failed write");
  assert.deepEqual(changes(await j.readAll()).map(({ previous, next }) => ({ previous, next })), [{ previous: 7, next: null }]);
});

test("auto-settle: a write that throws and was NOT applied is a failure, not journaled", async () => {
  const f = world({ writeError: (call) => (call.startsWith("auto-settle:") ? { error: new Error("socket closed") } : undefined) });
  const j = journal();
  const r = await applyOrganize(plan([allActions()[6]!]), { api: f.api, journal: j, runId: "org-run-1" });
  assert.equal(r.status, "partial");
  assert.equal(r.failed.length, 1);
  assert.equal(f.autoSettleDays, 7);
  assert.deepEqual(changes(await j.readAll()), []);
});

test("project-delete: a 2xx whose response did not decode (ShapeError) is confirmed by re-listing projects and journaled", async () => {
  const f = world({ writeError: (call) => (call.startsWith("delete-project:") ? { error: new ShapeError("POST /api/projects/mutate", "$.title", "string"), applied: true } : undefined) });
  const j = journal();
  const r = await applyOrganize(plan([allActions()[5]!]), { api: f.api, journal: j, runId: "org-run-1" });
  assert.deepEqual(r, { done: 1, skippedChanged: 0, failed: [], status: "ok" });
  assert.deepEqual(changes(await j.readAll()).map((e) => e.target), ["p2"]);
});

test("project-delete refused by T3 (the project still has a thread) is a failure, not journaled", async () => {
  const f = world({ writeError: (call) => (call.startsWith("delete-project:") ? { error: new T3HttpError("POST /api/projects/mutate", 409, { errorTag: "ProjectNotEmptyError" }) } : undefined) });
  const j = journal();
  const r = await applyOrganize(plan([allActions()[5]!]), { api: f.api, journal: j, runId: "org-run-1" });
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0]!.error, /ProjectNotEmptyError|409/);
  assert.equal(f.projects.find((p) => p.id === "p2")!.deleted, false);
  assert.deepEqual(changes(await j.readAll()), []);
});

test("project-delete 404 because the user deleted it is a failure, not journaled (a later undo never re-creates it)", async () => {
  // The user deletes p2 between t3sm's last read and its write; T3 answers ProjectNotFoundError.
  const f = world({ writeError: (call) => (call.startsWith("delete-project:") ? { error: new T3HttpError("POST /api/projects/mutate", 404, { errorTag: "ProjectNotFoundError" }), applied: true } : undefined) });
  const j = journal();
  const r = await applyOrganize(plan([allActions()[5]!]), { api: f.api, journal: j, runId: "org-run-1" });
  assert.equal(r.done, 0);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0]!.error, /ProjectNotFoundError|404/);
  assert.deepEqual(changes(await j.readAll()), []);
  const u = await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW });
  assert.equal(u.reverted, 0);
  assert.ok(!writes(f).some((c) => c.startsWith("create:")));
});

test("a refusal on archive (HTTP 4xx, or an RPC domain error) is a failure, not journaled, even when T3 shows the value", async () => {
  for (const error of [
    new T3HttpError("POST /api/orchestration", 400, { errorTag: "ThreadNotFound" }),
    new RpcError("orchestration.dispatchCommand", { _tag: "OrchestrationCommandInvariantError", message: "thread is already archived" }),
  ]) {
    const f = world({ writeError: (call) => (call.startsWith("archive:") ? { error, applied: true } : undefined) });
    const j = journal();
    const r = await applyOrganize(plan([allActions()[0]!]), { api: f.api, journal: j, runId: "org-run-1" });
    assert.equal(r.failed.length, 1, error.name);
    assert.deepEqual(changes(await j.readAll()), [], error.name);
  }
});

test("a lost reply after T3 applied the write (RPC timeout, closed socket, HTTP without a response) is confirmed by a fresh read and journaled", async () => {
  for (const [kind, error] of [
    ["archive", new RpcTimeout("orchestration.dispatchCommand", 15_000)],
    ["archive", new RpcClosed()],
    ["pin", new T3HttpError("POST /api/projects/mutate", null, { message: "timed out after 15 s" })],
  ] as const) {
    const f = world({ writeError: (call) => (call.startsWith(kind === "archive" ? "archive:" : "pin:") ? { error, applied: true } : undefined) });
    const j = journal();
    const a = kind === "archive" ? allActions()[0]! : allActions()[3]!;
    const r = await applyOrganize(plan([a]), { api: f.api, journal: j, runId: "org-run-1" });
    assert.deepEqual({ done: r.done, failed: r.failed.length }, { done: 1, failed: 0 }, error.name);
    assert.deepEqual(changes(await j.readAll()).map((e) => e.target), [a.target], error.name);
  }
});

test("projects are read again right before each project action: a change made during the run is seen", async () => {
  const f = world({
    writeError: (call) => {
      if (call === "pin:p3:true") f.projects.find((p) => p.id === "p4")!.pinned = false; // the user unpins p4 meanwhile
      return undefined;
    },
  });
  const j = journal();
  const r = await applyOrganize(plan(allActions().slice(3, 5)), { api: f.api, journal: j, runId: "org-run-1" });
  assert.deepEqual({ done: r.done, skipped: r.skippedChanged }, { done: 1, skipped: 1 });
  assert.deepEqual(writes(f), ["pin:p3:true"]);
});

test(`threads are read again every ${THREAD_BATCH} thread actions: a change made during the run is seen at the next batch`, async () => {
  const ids = Array.from({ length: 2 * THREAD_BATCH + 1 }, (_, i) => `import:claudeAgent:t${String(i).padStart(4, "0")}`);
  const f = world({
    writeError: (call) => {
      if (call === `archive:${ids[0]}`) f.threads.get(ids[THREAD_BATCH]!)!.archived = true; // the user archives it meanwhile
      return undefined;
    },
  });
  for (const id of ids) f.threads.set(id, thread(id));
  let reads = 0;
  const orig = f.api.listThreads;
  f.api.listThreads = async () => { reads++; return orig(); };
  const j = journal();
  const r = await applyOrganize(plan(ids.map((id) => act("archive", id, false, true))), { api: f.api, journal: j, runId: "org-run-1" });
  assert.equal(reads, 3); // the start, then before action THREAD_BATCH + 1 and 2 * THREAD_BATCH + 1
  assert.deepEqual({ done: r.done, skipped: r.skippedChanged }, { done: ids.length - 1, skipped: 1 });
  assert.ok(!writes(f).includes(`archive:${ids[THREAD_BATCH]}`));
});

test("undo: a journal failure after a revert stops with JournalWriteError naming what is reverted; a rerun finishes", async () => {
  const f = world();
  const j = journal();
  await applyOrganize(plan(allActions()), { api: f.api, journal: j, runId: "org-run-1" });
  const orig = j.append.bind(j);
  let undone = 0;
  j.append = async (e) => {
    if (e.t === "organize-undone" && ++undone === 2) throw new Error("disk full");
    return orig(e);
  };
  await assert.rejects(undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW }),
    (e: unknown) => e instanceof JournalWriteError && /disk full/.test(e.message) && /undo of project-delete p2/.test(e.message) && /reverted before it: auto-settle sidebarAutoSettleAfterDays/.test(e.message));
  j.append = orig;
  const u = await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW });
  // auto-settle and the re-created project are back already (the project's project-created was journaled first).
  assert.deepEqual({ reverted: u.reverted, already: u.alreadyRestored, changed: u.skippedUserChanged }, { reverted: 5, already: 2, changed: 0 });
});

test("a caller that owns the run (command null) gets no run-start / run-end from applyOrganize", async () => {
  const f = world();
  const j = journal();
  await applyOrganize(plan([allActions()[0]!], "sync-run-1"), { api: f.api, journal: j, runId: "sync-run-1", command: null });
  assert.deepEqual((await j.readAll()).map((e) => e.t), ["organize-change"]);
});

test("undo restores titles, settle state, archive state, pins, auto-settle setting (and recreates a deleted project)", async () => {
  const f = world();
  const before = state(f);
  const j = journal();
  await applyOrganize(plan(allActions()), { api: f.api, journal: j, runId: "org-run-1", now: () => NOW });
  const applied = readFileSync(j.file, "utf8");
  const applyCalls = writes(f).length;

  const u = await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW + 1000 });
  assert.equal(u.reverted, 7);
  assert.equal(u.skippedUserChanged, 0);
  assert.deepEqual(state(f), before);
  // Reverse order; the deleted project comes back with the same root and title (a new id).
  assert.deepEqual(writes(f).slice(applyCalls), ["auto-settle:7", "create:C:/work/p2", "pin:p4:true", "pin:p3:false", `settle:${C}`, `title:${B}:<command-name>/clear</command-name>`, `unarchive:${A}`]);

  // The journal only grew: the apply lines are untouched, undo writes no organize-change.
  const text = readFileSync(j.file, "utf8");
  assert.ok(text.startsWith(applied));
  const es = await j.readAll();
  const undoRun = u.runId!;
  const mine = es.filter((e) => e.runId === undoRun);
  assert.deepEqual(mine[0], { t: "run-start", runId: undoRun, at: new Date(NOW + 1000).toISOString(), command: "rollback org-run-1" });
  assert.equal(mine.filter((e) => e.t === "organize-change").length, 0);
  const created = mine.find((e): e is Extract<JournalEntry, { t: "project-created" }> => e.t === "project-created");
  assert.equal(created?.root, "C:/work/p2");
  assert.equal(created?.title, "new-chat", "the title it was re-created with (projects rename --suggest compares it)");
  assert.equal(created?.projectId, f.projects.find((p) => !p.deleted && p.workspaceRoot === "C:/work/p2")!.id);
  assert.deepEqual(mine.at(-2), { t: "rolled-back", runId: undoRun, targetRunId: "org-run-1", at: new Date(NOW + 1000).toISOString() });
  assert.equal((mine.at(-1) as Extract<JournalEntry, { t: "run-end" }>).status, "ok");
});

test("undo skips what the user changed since (and keeps the user's value)", async () => {
  const f = world();
  const j = journal();
  await applyOrganize(plan(allActions()), { api: f.api, journal: j, runId: "org-run-1" });
  f.threads.get(B)!.title = "Renamed by hand";
  f.threads.delete(A); // user deleted the thread
  f.projects.find((p) => p.id === "p3")!.pinned = false; // user unpinned: already what undo would set
  f.autoSettleDays = 30;
  f.projects.push(project("p9", { workspaceRoot: "C:/work/p2", title: "mine" })); // user re-created the folder's project
  const n = writes(f).length;
  const u = await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW });
  assert.equal(u.skippedUserChanged, 4); // title, auto-settle, project-delete (root taken again), archive (thread gone)
  assert.equal(u.reverted, 2); // unsettle, unpin
  assert.equal(u.alreadyRestored, 1); // p3: unpinned already
  assert.deepEqual(writes(f).slice(n), ["pin:p4:true", `settle:${C}`]);
  assert.equal(f.threads.get(B)!.title, "Renamed by hand");
  assert.equal(f.autoSettleDays, 30);
});

test("undo twice is a no-op: nothing written to T3 or to the journal the second time", async () => {
  const f = world();
  const j = journal();
  await applyOrganize(plan(allActions()), { api: f.api, journal: j, runId: "org-run-1" });
  await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW });
  const n = writes(f).length;
  const lines = (await j.readAll()).length;
  const u = await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW });
  assert.deepEqual({ reverted: u.reverted, changed: u.skippedUserChanged, already: u.alreadyRestored, runId: u.runId }, { reverted: 0, changed: 0, already: 7, runId: null });
  assert.equal(writes(f).length, n);
  assert.equal((await j.readAll()).length, lines);
});

test("undo: a failed revert is reported and the run ends partial; the rest is reverted", async () => {
  let failUnarchive = false;
  const f = world({ writeError: (call) => (failUnarchive && call.startsWith("unarchive:") ? { error: new Error("thread gone") } : undefined) });
  const j = journal();
  await applyOrganize(plan(allActions().slice(0, 3)), { api: f.api, journal: j, runId: "org-run-1" });
  failUnarchive = true;
  const u = await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW });
  assert.equal(u.reverted, 2);
  assert.deepEqual(u.failed.map((x) => x.target), [A]);
  const end = (await j.readAll()).at(-1) as Extract<JournalEntry, { t: "run-end" }>;
  assert.equal(end.status, "partial");
});

test("undo dry run lists what it would revert and writes nothing", async () => {
  const f = world();
  const j = journal();
  await applyOrganize(plan(allActions()), { api: f.api, journal: j, runId: "org-run-1" });
  const n = writes(f).length;
  const lines = (await j.readAll()).length;
  const u = await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW, dryRun: true });
  assert.equal(u.reverted, 7);
  assert.equal(u.runId, null);
  assert.equal(writes(f).length, n);
  assert.equal((await j.readAll()).length, lines);
});

test("undo warns but proceeds on an unverified T3 version", async () => {
  const f = world();
  const j = journal();
  await applyOrganize(plan(allActions()), { api: f.api, journal: j, runId: "org-run-1" });
  (f.api as { version: string }).version = "0.2.0";
  const notices: string[] = [];
  const u = await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW, onNotice: (l) => notices.push(l) });
  assert.deepEqual(notices, [UNTESTED_WARNING]);
  assert.equal(u.reverted, 7);
});

test("undo of an unknown run, or of a rollback run, is refused", async () => {
  const f = world();
  const j = journal();
  await assert.rejects(undoOrganize("nope", { api: f.api, journal: j, now: () => NOW }), /No run nope/);
  await applyOrganize(plan(allActions()), { api: f.api, journal: j, runId: "org-run-1" });
  const u = await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW });
  await assert.rejects(undoOrganize(u.runId!, { api: f.api, journal: j, now: () => NOW }), /rollback run/);
});

test("project-title (planned by `projects rename --suggest`): apply sets it through setProjectTitle, journals it, undo puts it back", async () => {
  const f = world();
  const j = journal();
  const r = await applyOrganize(plan([act("project-title", "p1", "P1", "Demo", "p1")]), { api: f.api, journal: j, runId: "org-run-1", command: "projects rename" });
  assert.deepEqual({ done: r.done, failed: r.failed.length }, { done: 1, failed: 0 });
  assert.ok(writes(f).includes("project-title:p1:Demo"));
  assert.equal(f.projects[0]!.title, "Demo");
  const es = await j.readAll();
  assert.deepEqual(es.find((e) => e.t === "run-start"), { t: "run-start", runId: "org-run-1", at: (es[0] as { at: string }).at, command: "projects rename" });
  assert.deepEqual(changes(es).map((e) => [e.kind, e.target, e.previous, e.next]), [["project-title", "p1", "P1", "Demo"]]);
  // A project renamed since the plan is left alone.
  const stale = await applyOrganize(plan([act("project-title", "p3", "Other", "Demo 3", "p3")]), { api: f.api, journal: j, runId: "org-run-2" });
  assert.equal(stale.skippedChanged, 1);
  const u = await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW });
  assert.deepEqual({ reverted: u.reverted, failed: u.failed }, { reverted: 1, failed: [] });
  assert.equal(f.projects[0]!.title, "P1");
  // The user renamed it after t3sm: undo leaves it.
  await applyOrganize(plan([act("project-title", "p1", "P1", "Demo", "p1")], "org-run-4"), { api: f.api, journal: j, runId: "org-run-4" });
  f.projects[0]!.title = "Mine";
  const u2 = await undoOrganize("org-run-4", { api: f.api, journal: j, now: () => NOW });
  assert.equal(u2.skippedUserChanged, 1);
  assert.equal(f.projects[0]!.title, "Mine");
  // buildOrganizePlan never plans it: renames come only from `projects rename --suggest`.
  const p = buildOrganizePlan({
    runId: "x", threads: [...f.threads.values()], projects: f.projects, journal: [], config: organizeSettings(cfg(), "en"),
    sessions: new Map(), now: NOW, scope: { allowPins: true, allowDeletes: true },
  });
  assert.equal(p.counts["project-title"], 0);
});

test("after undo, a new plan leaves every undone target alone (the user-touched rule)", async () => {
  const f = world();
  const j = journal();
  const input = async () => ({
    runId: "org-run-3", threads: await f.api.listThreads(), projects: await f.api.listProjects(), journal: await j.readAll(),
    config: { ...organizeSettings(cfg(), "en"), pinRecent: { enabled: false, count: 5 } },
    sessions: new Map([[A, { origin: "automated" as const, title: null }], [B, { origin: "human" as const, title: "Fix the login form" }], [C, { origin: "human" as const, title: null }]]),
    now: NOW, scope: { allowPins: true, allowDeletes: false },
  });
  const p1 = buildOrganizePlan(await input());
  assert.deepEqual(p1.actions.map((a) => `${a.kind}:${a.target}`).sort(), [`archive:${A}`, `title:${B}`, `unsettle:${B}`, `unsettle:${C}`].sort());
  await applyOrganize(p1, { api: f.api, journal: j, runId: "org-run-1" });
  await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW });
  assert.deepEqual(buildOrganizePlan(await input()).actions, []);
});

test("undo of a run that also imported conversations (a sync run) is refused with the rollback hint; nothing is journaled", async () => {
  const f = world();
  const j = journal();
  const run = "20261114-100000-sync";
  await j.append({ t: "run-start", runId: run, at: "2026-11-14T10:00:00.000Z", command: `sync ${run}` });
  await j.append({ t: "imported", runId: run, harness: "claude", nativeId: "aaaa", threadId: A, source: { path: "C:/work/demo/a.jsonl", size: 1, mtimeMs: 1 } });
  await applyOrganize(plan([allActions()[0]!]), { api: f.api, journal: j, runId: run, command: null });
  await j.append({ t: "run-end", runId: run, at: "2026-11-14T10:00:00.000Z", status: "ok" });
  const before = readFileSync(j.file, "utf8");
  const callsBefore = writes(f).length;
  for (const dryRun of [true, false]) {
    await assert.rejects(undoOrganize(run, { api: f.api, journal: j, now: () => NOW, dryRun }),
      (e: Error) => e.name === "ConfigError" && e.message === `This run also imported conversations; use \`t3sm rollback --run ${run}\` to undo all of it.`);
  }
  assert.equal(readFileSync(j.file, "utf8"), before, "no rolled-back entry");
  assert.equal(writes(f).length, callsBefore);
});

// ---------- Task 4: every failed change is journaled ----------

test("a failed action is journaled with kind, target and the redacted error", async () => {
  const f = world({ writeError: (call) => (call.startsWith("title:") ? { error: new Error("refused\n  token=sk-abc123def456ghi789jkl012mno345pqr " + "x".repeat(300)) } : undefined) });
  const j = journal();
  const r = await applyOrganize(plan(allActions()), { api: f.api, journal: j, runId: "org-run-1" });
  const es = await j.readAll();
  const failed = organizeFailures(es, "org-run-1");
  assert.equal(failed.length, 1);
  assert.deepEqual([failed[0]!.kind, failed[0]!.target, failed[0]!.projectId], ["title", B, "p1"]);
  assert.ok(!failed[0]!.error.includes("\n") && failed[0]!.error.length <= 200, failed[0]!.error);
  assert.ok(!failed[0]!.error.includes("sk-abc123def456ghi789jkl012mno345pqr"), failed[0]!.error);
  assert.match(failed[0]!.error, /^refused/);
  assert.equal(r.failed[0]!.error, failed[0]!.error, "the run's report and the journal say the same");
  assert.equal(es.filter((e) => e.t === "run-start").length, 1);
  assert.deepEqual(organizeFailures(es, "other-run"), []);
});

test("a journal write failure still aborts the run", async () => {
  const f = world({ writeError: (call) => (call.startsWith("title:") ? { error: new Error("T3 said no") } : undefined) });
  const j = journal();
  const orig = j.append.bind(j);
  j.append = async (e) => {
    if (e.t === "organize-failed") throw new Error("disk full");
    return orig(e);
  };
  await assert.rejects(applyOrganize(plan(allActions()), { api: f.api, journal: j, runId: "org-run-1" }),
    (e: unknown) => e instanceof JournalWriteError && /disk full/.test(e.message));
  const es = await j.readAll();
  assert.equal((es.at(-1) as Extract<JournalEntry, { t: "run-end" }>).status, "aborted");
});

test("auto-settle failure is journaled with target sidebarAutoSettleAfterDays", async () => {
  const f = world({ writeError: (call) => (call.startsWith("auto-settle:") ? { error: new Error("socket closed") } : undefined) });
  const j = journal();
  await applyOrganize(plan([allActions()[6]!]), { api: f.api, journal: j, runId: "org-run-1" });
  const failed = organizeFailures(await j.readAll(), "org-run-1");
  assert.deepEqual(failed.map((e) => [e.kind, e.target, e.projectId, e.error]), [["auto-settle", "sidebarAutoSettleAfterDays", null, "socket closed"]]);
});

// ---- settle (the per-project history rule, spec §5.2) ----

test("backdate sends the activity date: settle calls settleThread with it and journals it; undo shows the thread again", async () => {
  const f = world();
  f.threads.set(A, thread(A, { settledOverride: "active", settledAt: null }));
  const j = journal();
  const date = "2026-07-01T10:00:00.000Z";
  const r = await applyOrganize(plan([act("settle", A, "active", { settledAt: date }), act("settle", B, "active", "settled")]), { api: f.api, journal: j, runId: "org-run-1" });
  // B is settled already (not "active" as planned): stale, skipped. A is settled with the activity date.
  assert.deepEqual(r, { done: 1, skippedChanged: 1, failed: [], status: "ok" });
  assert.deepEqual(writes(f), [`settle:${A}`]);
  assert.equal(f.threads.get(A)!.settledOverride, "settled");
  assert.equal(f.threads.get(A)!.settledAt, date);
  assert.deepEqual(changes(await j.readAll()).map(({ kind, target, previous, next }) => ({ kind, target, previous, next })), [
    { kind: "settle", target: A, previous: "active", next: { settledAt: date } },
  ]);

  // The journaled `{ settledAt }` is compared as "settled": undo sees t3sm's value and shows the thread again.
  const u = await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW });
  assert.deepEqual({ reverted: u.reverted, changed: u.skippedUserChanged }, { reverted: 1, changed: 0 });
  assert.deepEqual(writes(f).slice(1), [`unsettle:${A}`]);
  assert.equal(f.threads.get(A)!.settledOverride, "active");
  assert.equal(f.threads.get(A)!.settledAt, null);
});

test("settle without backdating sends no date; a write whose reply was lost is confirmed as settled", async () => {
  const f = world({ writeError: (c) => (c === `settle:${A}` ? { error: new RpcTimeout("orchestration.dispatchCommand", 5000), applied: true } : undefined) });
  f.threads.set(A, thread(A, { settledOverride: "active", settledAt: null }));
  const j = journal();
  const r = await applyOrganize(plan([act("settle", A, "active", "settled")]), { api: f.api, journal: j, runId: "org-run-1" });
  assert.deepEqual(r, { done: 1, skippedChanged: 0, failed: [], status: "ok" });
  assert.equal(f.threads.get(A)!.settledOverride, "settled");
  assert.equal(changes(await j.readAll()).length, 1);
});

test("undo restores the previous state (history rule: unsettle and settle)", async () => {
  const f = world();
  f.threads.clear();
  // p1: 11 old conversations t3sm showed earlier, and one recent one still settled.
  const old = Array.from({ length: 11 }, (_, i) => `import:claudeAgent:old${100 + i}`);
  const day = 86_400_000;
  old.forEach((id, i) => f.threads.set(id, thread(id, { settledOverride: "active", settledAt: null, latestUserMessageAt: new Date(NOW - (100 + i) * day).toISOString() })));
  f.threads.set(A, thread(A, { latestUserMessageAt: new Date(NOW - day).toISOString() }));
  const j = journal();
  for (const id of old) await j.append({ t: "organize-change", runId: "org-run-0", kind: "unsettle", target: id, previous: "settled", next: "active" });
  const before = state(f);
  const p = buildOrganizePlan({
    runId: "org-run-1", threads: await f.api.listThreads(), projects: await f.api.listProjects(), journal: await j.readAll(),
    config: { ...organizeSettings(cfg(), "en"), pinRecent: { enabled: false, count: 5 }, titles: false, history: { days: 90, minPerProject: 10 } },
    sessions: new Map(), now: NOW, scope: { allowPins: false, allowDeletes: false }, backdate: true,
  });
  assert.deepEqual(p.actions.map((a) => `${a.kind}:${a.target}`), [`unsettle:${A}`, `settle:${old[10]}`, `settle:${old[9]}`]);
  await applyOrganize(p, { api: f.api, journal: j, runId: "org-run-1" });
  assert.equal(f.threads.get(old[10]!)!.settledAt, new Date(NOW - 110 * day).toISOString());
  assert.equal([...f.threads.values()].filter((t) => t.settledAt == null).length, 10);

  const u = await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW });
  assert.deepEqual({ reverted: u.reverted, changed: u.skippedUserChanged, failed: u.failed }, { reverted: 3, changed: 0, failed: [] });
  assert.deepEqual(state(f), before);
  // And nothing is planned on those threads again (an undone target differs from t3sm's last change).
  const again = buildOrganizePlan({
    runId: "org-run-2", threads: await f.api.listThreads(), projects: await f.api.listProjects(), journal: await j.readAll(),
    config: { ...organizeSettings(cfg(), "en"), pinRecent: { enabled: false, count: 5 }, titles: false, history: { days: 90, minPerProject: 10 } },
    sessions: new Map(), now: NOW, scope: { allowPins: false, allowDeletes: false },
  });
  assert.deepEqual(again.actions, []);
});

test("undo of a settle whose thread had no override shows it again (T3 cannot clear an override)", async () => {
  const f = world();
  f.threads.set(A, thread(A, { settledOverride: null, settledAt: null }));
  const j = journal();
  await applyOrganize(plan([act("settle", A, null, "settled")]), { api: f.api, journal: j, runId: "org-run-1" });
  assert.equal(f.threads.get(A)!.settledOverride, "settled");
  const u = await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW });
  assert.equal(u.reverted, 1);
  assert.equal(f.threads.get(A)!.settledAt, null, "shown inside its project again");
  const again = await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW });
  assert.deepEqual({ reverted: again.reverted, already: again.alreadyRestored }, { reverted: 0, already: 1 });
});

test("undo reads a legacy follow carry (kind unsettle, previous null, next \"settled\") as a settle: it shows the thread again", async () => {
  const f = world();
  const j = journal();
  await j.append({ t: "run-start", runId: "org-run-1", at: new Date(NOW).toISOString(), command: "organize" });
  await j.append({ t: "organize-change", runId: "org-run-1", kind: "unsettle", target: A, previous: null, next: "settled" });
  await j.append({ t: "run-end", runId: "org-run-1", at: new Date(NOW).toISOString(), status: "ok" });
  const u = await undoOrganize("org-run-1", { api: f.api, journal: j, now: () => NOW });
  assert.deepEqual({ reverted: u.reverted, already: u.alreadyRestored, changed: u.skippedUserChanged, failed: u.failed }, { reverted: 1, already: 0, changed: 0, failed: [] });
  assert.deepEqual(writes(f), [`unsettle:${A}`]);
  assert.equal(f.threads.get(A)!.settledOverride, "active");
  assert.deepEqual(u.items.map((x) => x.kind), ["settle"], "labelled as what it is");
});

test("aborted (a stop signal): applyOrganize stops after the current action and journals run-end aborted", async () => {
  const f = world();
  const j = journal();
  let stop = false;
  const r = await applyOrganize(plan(allActions()), {
    api: f.api, journal: j, runId: "org-run-1", now: () => NOW, aborted: () => stop,
    onProgress: () => { stop = true; },
  });
  assert.deepEqual(r, { done: 1, skippedChanged: 0, failed: [], status: "aborted" });
  assert.deepEqual(writes(f), [`archive:${A}`]);
  const es = await j.readAll();
  assert.deepEqual(es.at(-1), { t: "run-end", runId: "org-run-1", at: new Date(NOW).toISOString(), status: "aborted" });
  assert.equal(changes(es).length, 1);
});

test("failureText cuts by code points: never half a surrogate pair, at most 200 characters", () => {
  const long = "\u{1F600}".repeat(300); // cut at 199 UTF-16 units, this would end in half an emoji
  const t = failureText(long);
  assert.equal([...t].length, 200);
  assert.ok(t.endsWith("…"));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t), "no lone surrogate");
  assert.equal(failureText("  short \n reason "), "short reason");
});
