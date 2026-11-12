import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, link as linkCb, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { dedupe, nodeMoveFs, quarantine } from "../../src/ops/quarantine.ts";
import { latestRunId, rollbackRun } from "../../src/ops/rollback.ts";
import { sha256File } from "../../src/core/fsutil.ts";
import type { JournalEntry } from "../../src/core/types.ts";
import type { ProviderInstanceInfo, T3Api, T3Project, T3Thread } from "../../src/t3/api.ts";
import { T3NotRunning } from "../../src/t3/errors.ts";
import { entries, lines, put, snapshot, tempRoot, times } from "./helpers.ts";

interface FakeApi { api: T3Api; calls: string[]; projects: T3Project[]; threads: T3Thread[]; instances: ProviderInstanceInfo[] }

function fakeApi(over: { projects?: T3Project[]; threads?: T3Thread[]; instances?: ProviderInstanceInfo[] } = {}): FakeApi {
  const f: FakeApi = { api: null as never, calls: [], projects: over.projects ?? [], threads: over.threads ?? [], instances: over.instances ?? [] };
  f.api = {
    version: "test",
    listProjects: async () => f.projects.map((p) => ({ ...p })),
    listThreads: async () => f.threads.map((t) => ({ ...t })),
    providerInstances: async () => f.instances.map((i) => ({ ...i })),
    setProjectDefault: async (projectId: string, instanceId: string | null, model?: string) => {
      f.calls.push(`default:${projectId}:${instanceId}:${model ?? ""}`);
      const p = f.projects.find((x) => x.id === projectId)!;
      const previous = p.defaultModelSelection;
      p.defaultModelSelection = instanceId === null ? null : ({ instanceId, model: model ?? "m" } as never);
      return { previous };
    },
    archiveThread: async (id: string) => {
      f.calls.push(`archive:${id}`);
      const t = f.threads.find((x) => x.id === id);
      if (t) t.archived = true;
    },
    unarchiveThread: async (id: string) => {
      f.calls.push(`unarchive:${id}`);
      const t = f.threads.find((x) => x.id === id);
      if (t) t.archived = false;
    },
    updateInstanceAppearance: async (id: string, a: { displayName?: string; accentColor?: string }) => {
      f.calls.push(`appearance:${id}:${a.displayName ?? ""}:${a.accentColor ?? ""}`);
      const i = f.instances.find((x) => x.instanceId === id)!;
      if (a.displayName !== undefined) i.displayName = a.displayName;
      if (a.accentColor !== undefined) i.accentColor = a.accentColor;
      return { previous: null, changed: true };
    },
    pinInstanceHome: async (id: string, home: string) => {
      f.calls.push(`pin:${id}:${home}`);
      return { previous: null, changed: true };
    },
    close: async () => void f.calls.push("close"),
  } as unknown as T3Api;
  return f;
}

const project = (id: string, instanceId: string | null): T3Project =>
  ({ id, title: id, workspaceRoot: `C:/work/${id}`, defaultModelSelection: instanceId === null ? null : { instanceId, model: "m" }, archived: false, deleted: false }) as T3Project;
const thread = (id: string, archived = false): T3Thread => ({ id, projectId: "p1", instanceId: "claudeAgent", archived, title: "t" }) as T3Thread;
const inst = (id: string, displayName: string, accentColor: string | null): ProviderInstanceInfo =>
  ({ instanceId: id, driver: "claudeAgent", homePath: "/h", displayName, accentColor, email: null, authStatus: "authenticated", enabled: true, availability: "available" });

async function append(j: { append(e: JournalEntry): Promise<void> }, es: JournalEntry[]): Promise<void> {
  for (const e of es) await j.append(e);
}

test("quarantine then rollback restores the exact tree, file times included", async () => {
  const t = tempRoot();
  const bak1 = join(t.projects, "D--X.bak-20260630-111703");
  const bak2 = join(t.projects, ".bak-20260624-152222");
  put(join(bak1, "a.jsonl"), lines(3));
  put(join(bak1, "a", "subagents", "s.jsonl"), lines(1));
  put(join(bak2, "C--y", "b.jsonl"), lines(2));
  put(join(t.projects, "C--live", "c.jsonl"), lines(2));
  const before = snapshot(t.projects);
  await append(t.journal, [{ t: "run-start", runId: "q1", at: "2026-11-11T10:00:00.000Z", command: "quarantine" }]);
  const q = await quarantine([bak1, bak2], t.home, t.journal, "q1");
  assert.equal(q.moved.length, 2);
  assert.notDeepEqual(snapshot(t.projects), before);
  const r = await rollbackRun("q1", { journal: t.journal, accountHomes: [t.home] });
  assert.deepEqual(r.unquarantined.sort(), [bak1, bak2].sort());
  assert.deepEqual(snapshot(t.projects), before);
  const es = await entries(t.journal);
  assert.equal(es.filter((e) => e.t === "unquarantined").length, 2);
  const rb = es.find((e) => e.t === "rolled-back") as Extract<JournalEntry, { t: "rolled-back" }>;
  assert.equal(rb.targetRunId, "q1");
  assert.equal(rb.runId, r.runId);
});

test("dedupe then rollback puts mirror and sidecar back with their original mtime", async () => {
  const t = tempRoot();
  const org = join(t.root, ".claude-org");
  const k = put(join(org, "projects", "C--work-demo", "s.jsonl"), lines(4));
  const m = put(join(t.projects, "C--work-demo", "s.jsonl"), lines(2));
  put(join(t.projects, "C--work-demo", "s", "subagents", "a.jsonl"), lines(1));
  const before = snapshot(t.projects);
  const d = await dedupe([{ path: m, nativeId: "s", keptPath: k, relation: "prefix" }], [
    { id: "claudeAgent", home: t.home, displayName: "P", accentColor: null },
    { id: "claude-org", home: org, displayName: "O", accentColor: null },
  ], t.journal, "d1");
  assert.equal(d.moved.length, 2);
  assert.equal(existsSync(m), false);
  const r = await rollbackRun("d1", { journal: t.journal, accountHomes: [t.home, org] });
  assert.equal(r.unquarantined.length, 2);
  assert.deepEqual(snapshot(t.projects), before);
});

test("unquarantine conflict: the original path exists again -> left in quarantine and reported", async () => {
  const t = tempRoot();
  const bak = join(t.projects, ".bak-c");
  put(join(bak, "a.jsonl"), lines(1));
  const q = await quarantine([bak], t.home, t.journal, "q1");
  mkdirSync(bak);
  writeFileSync(join(bak, "new.jsonl"), "new");
  const r = await rollbackRun("q1", { journal: t.journal, accountHomes: [t.home] });
  assert.deepEqual(r.unquarantined, []);
  assert.deepEqual(r.unquarantineConflicts, [{ from: q.moved[0]!.to, to: bak }]);
  assert.ok(existsSync(join(q.moved[0]!.to, "a.jsonl")));
  assert.ok(existsSync(join(bak, "new.jsonl")));
  assert.equal(existsSync(join(bak, "a.jsonl")), false);
});

test("file-written: unchanged converted file is removed, an edited one is kept and reported", async () => {
  const t = tempRoot();
  const a = put(join(t.projects, "C--w", "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa.jsonl"), lines(2));
  const b = put(join(t.projects, "C--w", "bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb.jsonl"), lines(2, "b"));
  await append(t.journal, [
    { t: "run-start", runId: "a1", at: "2026-11-11T10:00:00.000Z", command: "apply p" },
    { t: "file-written", runId: "a1", path: a, sha256: await sha256File(a) },
    { t: "file-written", runId: "a1", path: b, sha256: await sha256File(b) },
    { t: "run-end", runId: "a1", at: "2026-11-11T10:01:00.000Z", status: "ok" },
  ]);
  writeFileSync(b, lines(3, "b")); // the user continued the session in Claude Code
  const r = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home] });
  assert.deepEqual(r.filesRemoved, [a]);
  assert.deepEqual(r.filesKeptModified, [b]);
  assert.equal(existsSync(a), false);
  assert.ok(existsSync(b));
});

test("file-written rewritten by a later run is not removed by rolling back the earlier run", async () => {
  const t = tempRoot();
  const a = put(join(t.projects, "C--w", "a.jsonl"), lines(2));
  const sha = await sha256File(a);
  await append(t.journal, [
    { t: "run-start", runId: "a1", at: "2026-11-11T10:00:00.000Z", command: "apply p" },
    { t: "file-written", runId: "a1", path: a, sha256: sha },
    { t: "run-start", runId: "a2", at: "2026-11-11T11:00:00.000Z", command: "apply p" },
    { t: "file-written", runId: "a2", path: a, sha256: sha },
  ]);
  const r = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home] });
  assert.deepEqual(r.filesRemoved, []);
  assert.ok(existsSync(a));
});

test("file-written cancelled by file-write-aborted (never published) is never removed, even with a matching sha", async () => {
  const t = tempRoot();
  const a = put(join(t.projects, "C--w", "cccccccc-cccc-5ccc-8ccc-cccccccccccc.jsonl"), lines(2));
  await append(t.journal, [
    { t: "run-start", runId: "a1", at: "2026-11-11T10:00:00.000Z", command: "apply p" },
    { t: "file-written", runId: "a1", path: a, sha256: await sha256File(a) },
    { t: "file-write-aborted", runId: "a1", path: a },
    { t: "run-end", runId: "a1", at: "2026-11-11T10:01:00.000Z", status: "ok" },
  ]);
  const r = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home] });
  assert.deepEqual(r.filesRemoved, []);
  assert.ok(existsSync(a));
});

test("rollback twice is a no-op: nothing moves and nothing is journaled the second time", async () => {
  const t = tempRoot();
  const bak = join(t.projects, ".bak-t");
  put(join(bak, "a.jsonl"), lines(1));
  const f = put(join(t.projects, "C--w", "c.jsonl"), lines(1));
  await append(t.journal, [{ t: "run-start", runId: "a1", at: "2026-11-11T10:00:00.000Z", command: "apply p" }, { t: "file-written", runId: "a1", path: f, sha256: await sha256File(f) }]);
  await quarantine([bak], t.home, t.journal, "a1");
  const r1 = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home] });
  assert.equal(r1.unquarantined.length, 1);
  assert.equal(r1.filesRemoved.length, 1);
  const n = (await entries(t.journal)).length;
  const snap = snapshot(t.root);
  const r2 = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home] });
  assert.deepEqual([r2.unquarantined, r2.filesRemoved, r2.filesKeptModified, r2.unquarantineConflicts], [[], [], [], []]);
  assert.equal(r2.runId, null);
  assert.equal((await entries(t.journal)).length, n);
  assert.deepEqual(snapshot(t.root), snap);
});

test("T3 down: file-level rollback still runs; defaults are reported as not restored", async () => {
  const t = tempRoot();
  const bak = join(t.projects, ".bak-x");
  put(join(bak, "a.jsonl"), lines(1));
  await append(t.journal, [
    { t: "run-start", runId: "a1", at: "2026-11-11T10:00:00.000Z", command: "apply p" },
    { t: "project-default-set", runId: "a1", projectId: "p1", previous: null, next: { instanceId: "claude-org" } },
  ]);
  await quarantine([bak], t.home, t.journal, "a1");
  const r = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home], connect: async () => { throw new T3NotRunning(); } });
  assert.equal(r.unquarantined.length, 1);
  assert.ok(existsSync(join(bak, "a.jsonl")));
  assert.match(r.t3Unavailable ?? "", /T3 Code not running/);
  assert.deepEqual(r.defaultsRestored, []);
  assert.deepEqual(r.defaultsSkipped, [{ projectId: "p1", reason: "T3 Code not running" }]);
});

test("project-default-set.previous is restored through setProjectDefault and journaled; a later user change is left alone", async () => {
  const t = tempRoot();
  const f = fakeApi({ projects: [project("p1", "claude-org"), project("p2", "someoneElse"), project("p3", "claudeAgent")] });
  await append(t.journal, [
    { t: "run-start", runId: "a1", at: "2026-11-11T10:00:00.000Z", command: "apply p" },
    { t: "project-default-set", runId: "a1", projectId: "p1", previous: { instanceId: "claudeAgent", model: "opus" }, next: { instanceId: "claude-org" } },
    { t: "project-default-set", runId: "a1", projectId: "p2", previous: null, next: { instanceId: "claude-org" } },
    { t: "project-default-set", runId: "a1", projectId: "p3", previous: null, next: { instanceId: "claudeAgent" } },
  ]);
  const r = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api });
  assert.deepEqual(r.defaultsRestored.sort(), ["p1", "p3"]);
  assert.deepEqual(r.defaultsSkipped, [{ projectId: "p2", reason: "changed since (now someoneElse)" }]);
  assert.ok(f.calls.includes("default:p1:claudeAgent:opus"));
  assert.ok(f.calls.includes("default:p3:null:"));
  const es = await entries(t.journal);
  assert.equal(es.filter((e) => e.t === "project-default-set" && e.runId === r.runId).length, 2);
  // second run: already restored
  const r2 = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api });
  assert.deepEqual(r2.defaultsRestored, []);
  assert.equal(r2.runId, null);
});

test("threadsToReview comes from imported AND import-attempt entries, filtered by T3's thread list; never archived by default", async () => {
  const t = tempRoot();
  const f = fakeApi({ threads: [thread("th-imported"), thread("th-attempt"), thread("unrelated")] });
  await append(t.journal, [
    { t: "run-start", runId: "a1", at: "2026-11-11T10:00:00.000Z", command: "apply p" },
    { t: "import-attempt", runId: "a1", items: [{ harness: "claude", nativeId: "n1", threadId: "th-imported" }, { harness: "claude", nativeId: "n2", threadId: "th-attempt" }, { harness: "claude", nativeId: "n3", threadId: "th-never" }] },
    { t: "imported", runId: "a1", harness: "claude", nativeId: "n1", threadId: "th-imported", source: { path: "/x", size: 1, mtimeMs: 1 } },
  ]);
  const r = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api });
  assert.deepEqual(r.threadsToReview.sort(), ["th-attempt", "th-imported"]);
  assert.equal(r.threadsVerified, true);
  assert.deepEqual(r.threadsArchived, []);
  assert.equal(f.calls.filter((c) => c.startsWith("archive")).length, 0);
});

test("parked copies of an import-attempt are never threads to review or archive; an existing thread of theirs is listed apart", async () => {
  const t = tempRoot();
  const f = fakeApi({ threads: [thread("th-item"), thread("th-parked")] });
  await append(t.journal, [
    { t: "run-start", runId: "a1", at: "2026-11-11T10:00:00.000Z", command: "apply p" },
    { t: "import-attempt", runId: "a1", items: [{ harness: "claude", nativeId: "n1", threadId: "th-item" }],
      parked: [{ harness: "claude", nativeId: "n2", threadId: "th-parked" }, { harness: "claude", nativeId: "n3", threadId: "th-parked-none" }] },
  ]);
  const r = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api, archiveThreads: true });
  assert.deepEqual(r.threadsToReview, ["th-item"]);
  assert.deepEqual(r.threadsArchived, ["th-item"]);
  assert.deepEqual(r.parkedThreads, ["th-parked"], "only parked copies whose thread exists, for review");
  assert.ok(!f.calls.includes("archive:th-parked"));
});

test("--archive-threads archives (never deletes) this run's threads still active, journaling thread-archived", async () => {
  const t = tempRoot();
  const f = fakeApi({ threads: [thread("a"), thread("b", true)] });
  await append(t.journal, [
    { t: "run-start", runId: "a1", at: "2026-11-11T10:00:00.000Z", command: "apply p" },
    { t: "import-attempt", runId: "a1", items: [{ harness: "claude", nativeId: "n1", threadId: "a" }, { harness: "claude", nativeId: "n2", threadId: "b" }] },
  ]);
  const r = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api, archiveThreads: true });
  assert.deepEqual(r.threadsArchived, ["a"]);
  assert.deepEqual(f.calls.filter((c) => c.startsWith("archive")), ["archive:a"]);
  const es = await entries(t.journal);
  assert.deepEqual(es.filter((e) => e.t === "thread-archived").map((e) => (e as { threadId: string }).threadId), ["a"]);
});

test("instance changes are listed, and restored only with instances:true", async () => {
  const t = tempRoot();
  await append(t.journal, [
    { t: "run-start", runId: "a1", at: "2026-11-11T10:00:00.000Z", command: "accounts --rename" },
    { t: "instance-updated", runId: "a1", instanceId: "claude-org", previous: { displayName: "Old", accentColor: "#111111", homePath: "/h" }, next: { displayName: "New", accentColor: "#222222", homePath: "/h" } },
    { t: "instance-pinned", runId: "a1", instanceId: "claudeAgent", previous: { homePath: null }, next: { homePath: "/home/.claude" } },
    { t: "instance-created", runId: "a1", instanceId: "claude-org", homePath: "/h" },
  ]);
  const f = fakeApi({ instances: [inst("claude-org", "New", "#222222"), inst("claudeAgent", "Claude", null)] });
  const listed = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api });
  assert.equal(listed.instanceChanges.length, 2);
  assert.ok(listed.instanceChanges.every((c) => c.status === "listed"));
  assert.deepEqual(listed.instancesCreated, ["claude-org"]);
  assert.equal(f.calls.filter((c) => c.startsWith("appearance") || c.startsWith("pin")).length, 0);

  const r = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api, instances: true });
  const upd = r.instanceChanges.find((c) => c.kind === "updated")!;
  assert.equal(upd.status, "restored");
  assert.ok(f.calls.includes("appearance:claude-org:Old:#111111"));
  const pin = r.instanceChanges.find((c) => c.kind === "pinned")!;
  assert.equal(pin.status, "not-restorable"); // claudeAgent stays pinned to ~/.claude
  assert.equal(f.calls.filter((c) => c.startsWith("pin")).length, 0);
});

test("dryRun lists what would be undone and writes nothing", async () => {
  const t = tempRoot();
  const bak = join(t.projects, ".bak-dry");
  put(join(bak, "a.jsonl"), lines(1));
  const f = put(join(t.projects, "C--w", "c.jsonl"), lines(1));
  await append(t.journal, [{ t: "run-start", runId: "a1", at: "2026-11-11T10:00:00.000Z", command: "apply p" }, { t: "file-written", runId: "a1", path: f, sha256: await sha256File(f) }]);
  await quarantine([bak], t.home, t.journal, "a1");
  const n = (await entries(t.journal)).length;
  const r = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home], dryRun: true });
  assert.deepEqual(r.unquarantined, [bak]);
  assert.deepEqual(r.filesRemoved, [f]);
  assert.ok(existsSync(f));
  assert.equal(existsSync(join(bak, "a.jsonl")), false);
  assert.equal((await entries(t.journal)).length, n);
});

test("latestRunId: newest run with a run-start that is not itself a rollback", async () => {
  const es: JournalEntry[] = [
    { t: "run-start", runId: "r1", at: "2026-11-11T10:00:00.000Z", command: "apply p" },
    { t: "instance-pinned", runId: "acc", instanceId: "x", previous: { homePath: null }, next: { homePath: "/h" } },
    { t: "run-start", runId: "r2", at: "2026-11-11T11:00:00.000Z", command: "quarantine" },
    { t: "run-start", runId: "r3", at: "2026-11-11T12:00:00.000Z", command: "rollback r2" },
  ];
  assert.equal(latestRunId(es), "r2");
  assert.equal(latestRunId([]), null);
});

test("rollbackRun of an unknown run id throws a ConfigError", async () => {
  const t = tempRoot();
  await assert.rejects(rollbackRun("nope", { journal: t.journal, accountHomes: [t.home] }), (e: Error) => e.name === "ConfigError");
});

test("quarantine + rollback keep every file's mtime AND atime (stat only, no reads)", async () => {
  const t = tempRoot();
  const bak = join(t.projects, ".bak-m");
  const p = put(join(bak, "a.jsonl"), lines(1));
  put(join(bak, "a", "subagents", "x.jsonl"), lines(1));
  const before = times(t.projects);
  const m = statSync(p).mtimeMs;
  await quarantine([bak], t.home, t.journal, "q");
  const inQuarantine = Object.fromEntries(Object.entries(before).map(([k, v]) => [k.replace(/^\.bak-m\//, ""), v]));
  assert.deepEqual(times(join(t.home, "session-manager-quarantine", "backups", ".bak-m")), inQuarantine);
  await rollbackRun("q", { journal: t.journal, accountHomes: [t.home] });
  assert.deepEqual(times(t.projects), before);
  assert.equal(statSync(p).mtimeMs, m);
});

// ---------------- review fixes ----------------

function dedupedMirror() {
  const t = tempRoot();
  const org = join(t.root, ".claude-org");
  const k = put(join(org, "projects", "C--work-demo", "s.jsonl"), lines(4));
  const m = put(join(t.projects, "C--work-demo", "s.jsonl"), lines(2));
  const accounts = [
    { id: "claudeAgent", home: t.home, displayName: "P", accentColor: null },
    { id: "claude-org", home: org, displayName: "O", accentColor: null },
  ];
  return { t, org, k, m, accounts, homes: [t.home, org] };
}

test("rollback never overwrites a file that appears at the original path during the move (conflict, both kept)", async () => {
  const s = dedupedMirror();
  const d = await dedupe([{ path: s.m, nativeId: "s", keptPath: s.k, relation: "prefix" }], s.accounts, s.t.journal, "d1");
  const inQ = d.moved[0]!.to;
  const fs = {
    ...nodeMoveFs,
    link: async (from: string, to: string) => {
      writeFileSync(to, "new session written meanwhile");
      await promisify(linkCb)(from, to);
    },
  };
  const r = await rollbackRun("d1", { journal: s.t.journal, accountHomes: s.homes, fs });
  assert.deepEqual(r.unquarantined, []);
  assert.deepEqual(r.unquarantineConflicts, [{ from: inQ, to: s.m }]);
  assert.equal(readFileSync(s.m, "utf8"), "new session written meanwhile");
  assert.equal(readFileSync(inQ, "utf8"), lines(2));
});

test("rollback's link + unlink keeps the file's mtime and atime (stat only)", async () => {
  const s = dedupedMirror();
  const d = await dedupe([{ path: s.m, nativeId: "s", keptPath: s.k, relation: "prefix" }], s.accounts, s.t.journal, "d1");
  const before = statSync(d.moved[0]!.to);
  await rollbackRun("d1", { journal: s.t.journal, accountHomes: s.homes });
  const after = statSync(s.m);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.atimeMs, before.atimeMs);
});

test("tampered or malformed journal entries are reported and skipped; the rest is rolled back and run-end written", async () => {
  const t = tempRoot();
  const bak = join(t.projects, ".bak-ok");
  put(join(bak, "a.jsonl"), lines(1));
  const outside = put(join(t.root, "elsewhere", "victim.jsonl"), "do not touch");
  const evilWritten = put(join(t.root, "evil.jsonl"), "x");
  const victimDir = join(t.root, "victimdir");
  put(join(victimDir, "f"), "keep");
  await quarantine([bak], t.home, t.journal, "a1");
  await append(t.journal, [
    // to outside any quarantine: would move victim.jsonl into projects/
    { t: "quarantined", runId: "a1", from: join(t.projects, "C--x", "victim.jsonl"), to: outside, reason: "mirror-copy" },
    // from outside projects/: would move a quarantine entry onto an arbitrary path
    { t: "quarantined", runId: "a1", from: join(victimDir, "f2"), to: join(t.home, "session-manager-quarantine", "backups", "zzz"), reason: "backup-dir" },
    // `..` escape
    { t: "quarantined", runId: "a1", from: `${t.projects}/C--x/../../../victimdir`, to: join(t.home, "session-manager-quarantine", "backups", "y"), reason: "backup-dir" },
    { t: "quarantined", runId: "a1", from: join(t.projects, "C--x", "f.jsonl") } as unknown as JournalEntry, // `to` missing
    { t: "file-written", runId: "a1", path: evilWritten, sha256: await sha256File(evilWritten) }, // not under projects/<dir>/
    { t: "file-written", runId: "a1", path: 42 } as unknown as JournalEntry,
  ]);
  const r = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home] });
  assert.deepEqual(r.unquarantined, [bak]);
  assert.ok(existsSync(join(bak, "a.jsonl")));
  assert.equal(r.errors.length, 6, r.errors.join("\n"));
  assert.equal(readFileSync(outside, "utf8"), "do not touch");
  assert.ok(existsSync(evilWritten));
  assert.ok(existsSync(join(victimDir, "f")));
  const es = await entries(t.journal);
  const end = es.find((e) => e.t === "run-end" && e.runId === r.runId) as Extract<JournalEntry, { t: "run-end" }>;
  assert.equal(end.status, "partial");
});

test("rerun after a crash: entry already back at its original path -> 'already restored', nothing written", async () => {
  const t = tempRoot();
  const bak = join(t.projects, ".bak-c");
  put(join(bak, "a.jsonl"), lines(1));
  const q = await quarantine([bak], t.home, t.journal, "q1");
  renameSync(q.moved[0]!.to, bak); // the earlier rollback moved it, then died before journaling
  const n = (await entries(t.journal)).length;
  const r = await rollbackRun("q1", { journal: t.journal, accountHomes: [t.home] });
  assert.deepEqual(r.alreadyRestored, [bak]);
  assert.deepEqual([r.unquarantined, r.unquarantineMissing, r.errors], [[], [], []]);
  assert.equal(r.runId, null);
  assert.equal((await entries(t.journal)).length, n);
});

test("rollback recreates a deleted project folder and removes the emptied quarantine folders", async () => {
  const s = dedupedMirror();
  put(join(s.t.projects, "C--work-demo", "s", "sub.jsonl"), lines(1));
  await dedupe([{ path: s.m, nativeId: "s", keptPath: s.k, relation: "prefix" }], s.accounts, s.t.journal, "d1");
  rmdirSync(join(s.t.projects, "C--work-demo")); // empty after the move; rmdir refuses otherwise
  assert.equal(existsSync(join(s.t.projects, "C--work-demo")), false);
  const r = await rollbackRun("d1", { journal: s.t.journal, accountHomes: s.homes });
  assert.equal(r.unquarantined.length, 2);
  assert.equal(readFileSync(s.m, "utf8"), lines(2));
  assert.ok(existsSync(join(s.t.projects, "C--work-demo", "s", "sub.jsonl")));
  assert.equal(existsSync(join(s.t.home, "session-manager-quarantine")), false);
});

test("emptied quarantine folders go, folders still holding something stay", async () => {
  const t = tempRoot();
  const a = join(t.projects, ".bak-a");
  const b = join(t.projects, ".bak-b");
  put(join(a, "x"), "x");
  put(join(b, "y"), "y");
  await quarantine([a], t.home, t.journal, "q1");
  await quarantine([b], t.home, t.journal, "q2");
  await rollbackRun("q1", { journal: t.journal, accountHomes: [t.home] });
  assert.ok(existsSync(join(t.home, "session-manager-quarantine", "backups", ".bak-b", "y")));
  await rollbackRun("q2", { journal: t.journal, accountHomes: [t.home] });
  assert.equal(existsSync(join(t.home, "session-manager-quarantine")), false);
});

test("a rollback run cannot itself be rolled back", async () => {
  const t = tempRoot();
  const bak = join(t.projects, ".bak-r");
  put(join(bak, "a.jsonl"), lines(1));
  await quarantine([bak], t.home, t.journal, "q1");
  const r = await rollbackRun("q1", { journal: t.journal, accountHomes: [t.home] });
  await assert.rejects(rollbackRun(r.runId!, { journal: t.journal, accountHomes: [t.home] }), (e: Error) => e.name === "ConfigError" && /Cannot roll back a rollback run/.test(e.message));
});

test("a converted file changed in the last 10 minutes is kept (in use) even when its sha still matches", async () => {
  const t = tempRoot();
  const f = put(join(t.projects, "C--w", "c.jsonl"), lines(1), Date.now() - 60_000);
  await append(t.journal, [{ t: "run-start", runId: "a1", at: "2026-11-11T10:00:00.000Z", command: "apply p" }, { t: "file-written", runId: "a1", path: f, sha256: await sha256File(f) }]);
  const r = await rollbackRun("a1", { journal: t.journal, accountHomes: [t.home] });
  assert.deepEqual(r.filesKeptActive, [f]);
  assert.deepEqual(r.filesRemoved, []);
  assert.ok(existsSync(f));
});

// ---------- merge revisions (Task 23) ----------

const SRC = "11111111-1111-4111-8111-000000000001";
const REV = "22222222-2222-5222-8222-000000000002";
const OLD_T = `import:claudeAgent:${SRC}`;
const NEW_T = `import:claudeAgent:${REV}`;

async function mergedRun(t: ReturnType<typeof tempRoot>, revFile: string): Promise<void> {
  await append(t.journal, [
    { t: "run-start", runId: "m1", at: "2026-11-11T10:00:00.000Z", command: "merge" },
    { t: "file-written", runId: "m1", path: revFile, sha256: await sha256File(revFile) },
    { t: "imported", runId: "m1", harness: "claude", nativeId: REV, threadId: NEW_T, source: { path: revFile, size: statSync(revFile).size, mtimeMs: statSync(revFile).mtimeMs } },
    { t: "thread-archived", runId: "m1", threadId: OLD_T },
    { t: "merged", runId: "m1", harness: "claude", nativeId: SRC, revisionUuid: REV, revisionFile: revFile, oldThreadId: OLD_T, newThreadId: NEW_T },
    { t: "run-end", runId: "m1", at: "2026-11-11T10:00:01.000Z", status: "ok" },
  ]);
}

test("rollback of a merge: an untouched revision is deleted, the old thread unarchived, the revision thread archived; twice = no-op", async () => {
  const t = tempRoot();
  const revFile = put(join(t.projects, "C--work-demo", `${REV}.jsonl`), lines(2));
  await mergedRun(t, revFile);
  const f = fakeApi({ threads: [thread(OLD_T, true), thread(NEW_T)] });
  const r = await rollbackRun("m1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api });
  assert.deepEqual(r.filesRemoved, [revFile]);
  assert.ok(!existsSync(revFile));
  assert.deepEqual(r.threadsUnarchived, [OLD_T]);
  assert.deepEqual(r.threadsArchived, [NEW_T]);
  assert.deepEqual(r.mergesKept, []);
  assert.equal(f.threads.find((x) => x.id === OLD_T)!.archived, false);
  assert.equal(f.threads.find((x) => x.id === NEW_T)!.archived, true);
  const es = await entries(t.journal);
  assert.ok(es.some((e) => e.t === "thread-unarchived" && e.threadId === OLD_T && e.runId === r.runId));
  assert.ok(es.some((e) => e.t === "thread-archived" && e.threadId === NEW_T && e.runId === r.runId));
  assert.deepEqual(r.errors, []);

  const again = await rollbackRun("m1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api });
  assert.equal(again.runId, null, "nothing left to undo");
  assert.deepEqual(again.threadsUnarchived, []);
});

test("rollback of a merge whose revision was continued since: both threads and the revision are kept and reported", async () => {
  const t = tempRoot();
  const revFile = put(join(t.projects, "C--work-demo", `${REV}.jsonl`), lines(2));
  await mergedRun(t, revFile);
  put(revFile, lines(2) + lines(1, "more"));
  const f = fakeApi({ threads: [thread(OLD_T, true), thread(NEW_T)] });
  const r = await rollbackRun("m1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api });
  assert.deepEqual(r.filesKeptModified, [revFile]);
  assert.ok(existsSync(revFile));
  assert.deepEqual(r.mergesKept, [{ nativeId: SRC, revisionFile: revFile, reason: "revision continued" }]);
  assert.deepEqual(r.threadsUnarchived, []);
  assert.equal(f.threads.find((x) => x.id === OLD_T)!.archived, true, "the old thread stays archived");
  assert.ok(!f.calls.some((c) => c.startsWith("unarchive") || c.startsWith("archive")));
});

test("rollback dry run of a merge lists what it would undo and writes nothing", async () => {
  const t = tempRoot();
  const revFile = put(join(t.projects, "C--work-demo", `${REV}.jsonl`), lines(2));
  await mergedRun(t, revFile);
  const f = fakeApi({ threads: [thread(OLD_T, true), thread(NEW_T)] });
  const n = (await entries(t.journal)).length;
  const r = await rollbackRun("m1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api, dryRun: true });
  assert.deepEqual(r.threadsUnarchived, [OLD_T]);
  assert.ok(existsSync(revFile));
  assert.equal((await entries(t.journal)).length, n);
  assert.ok(!f.calls.some((c) => c.startsWith("unarchive") || c.startsWith("archive")));
});

test("rollback of a merge interrupted between thread-archived and merged: revision deleted, old thread unarchived, revision thread archived", async () => {
  const t = tempRoot();
  const revFile = put(join(t.projects, "C--work-demo", `${REV}.jsonl`), lines(2));
  await append(t.journal, [
    { t: "run-start", runId: "m1", at: "2026-11-11T10:00:00.000Z", command: "merge" },
    { t: "file-written", runId: "m1", path: revFile, sha256: await sha256File(revFile), revisionOf: { harness: "claude", nativeId: SRC } },
    { t: "imported", runId: "m1", harness: "claude", nativeId: REV, threadId: NEW_T, source: { path: revFile, size: statSync(revFile).size, mtimeMs: statSync(revFile).mtimeMs } },
    { t: "thread-archived", runId: "m1", threadId: OLD_T },
  ]);
  const f = fakeApi({ threads: [thread(OLD_T, true), thread(NEW_T)] });
  const r = await rollbackRun("m1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api });
  assert.deepEqual(r.filesRemoved, [revFile]);
  assert.deepEqual(r.threadsUnarchived, [OLD_T]);
  assert.deepEqual(r.threadsArchived, [NEW_T]);
  assert.equal(f.threads.find((x) => x.id === NEW_T)!.archived, true);
});

test("rollback of a merge with T3 Code unreachable: the revision file is left untouched and reported; nothing is half-undone", async () => {
  const t = tempRoot();
  const revFile = put(join(t.projects, "C--work-demo", `${REV}.jsonl`), lines(2));
  await mergedRun(t, revFile);
  const r = await rollbackRun("m1", { journal: t.journal, accountHomes: [t.home], connect: async () => { throw new T3NotRunning(); } });
  assert.ok(existsSync(revFile), "kept while its threads cannot be fixed");
  assert.deepEqual(r.filesRemoved, []);
  assert.deepEqual(r.mergesKept, [{ nativeId: SRC, revisionFile: revFile, reason: "T3 Code unreachable" }]);
  assert.ok(r.errors.some((x) => /kept the merge revision/.test(x)));
  assert.equal(r.t3Unavailable, "T3 Code not running");
});

test("rollback of a re-merge run that unarchived the revision thread and then stopped: revision removed, revision thread archived again", async () => {
  const t = tempRoot();
  const revFile = put(join(t.projects, "C--work-demo", `${REV}.jsonl`), lines(2));
  await append(t.journal, [
    { t: "run-start", runId: "m2", at: "2026-11-11T10:00:00.000Z", command: "merge" },
    { t: "file-written", runId: "m2", path: revFile, sha256: await sha256File(revFile), revisionOf: { harness: "claude", nativeId: SRC } },
    { t: "imported", runId: "m2", harness: "claude", nativeId: REV, threadId: NEW_T, source: { path: revFile, size: statSync(revFile).size, mtimeMs: statSync(revFile).mtimeMs } },
    { t: "thread-unarchived", runId: "m2", threadId: NEW_T },
    { t: "run-end", runId: "m2", at: "2026-11-11T10:00:01.000Z", status: "partial" },
  ]);
  const f = fakeApi({ threads: [thread(OLD_T), thread(NEW_T)] });
  const r = await rollbackRun("m2", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api });
  assert.deepEqual(r.filesRemoved, [revFile]);
  assert.deepEqual(r.threadsArchived, [NEW_T]);
  assert.equal(f.threads.find((x) => x.id === OLD_T)!.archived, false, "the old thread was never archived: stays active");
  assert.equal(f.threads.find((x) => x.id === NEW_T)!.archived, true);
  assert.deepEqual(r.errors, []);
});

test("rollback of a merge: when the old thread cannot be unarchived, the revision thread is left active (never zero active threads)", async () => {
  const t = tempRoot();
  const revFile = put(join(t.projects, "C--work-demo", `${REV}.jsonl`), lines(2));
  await mergedRun(t, revFile);
  const f = fakeApi({ threads: [thread(OLD_T, true), thread(NEW_T)] });
  (f.api as unknown as Record<string, unknown>).unarchiveThread = async () => { throw new Error("T3 refused"); };
  const r = await rollbackRun("m1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api });
  assert.ok(r.errors.some((x) => /could not unarchive thread/.test(x)));
  assert.deepEqual(r.needsReview.map((x) => x.threadId), [NEW_T]);
  assert.deepEqual(r.threadsArchived, []);
  assert.equal(f.threads.find((x) => x.id === NEW_T)!.archived, false);
});

test("rollback of a merge: T3 reachable but its thread list unreadable -> the revision file is kept and reported", async () => {
  const t = tempRoot();
  const revFile = put(join(t.projects, "C--work-demo", `${REV}.jsonl`), lines(2));
  await mergedRun(t, revFile);
  const f = fakeApi({ threads: [thread(OLD_T, true), thread(NEW_T)] });
  (f.api as unknown as Record<string, unknown>).listThreads = async () => { throw new Error("socket closed"); };
  const r = await rollbackRun("m1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api });
  assert.ok(existsSync(revFile));
  assert.deepEqual(r.filesRemoved, []);
  assert.deepEqual(r.mergesKept.map((m) => m.reason), ["T3 Code unreachable"]);
  assert.ok(r.errors.some((x) => /kept the merge revision .*could not read T3 threads/.test(x)));
});


// ---------- the lineage invariant: a rollback never leaves a session without an active thread ----------

type Scenario = { name: string; threads: T3Thread[]; setup?: (t: ReturnType<typeof tempRoot>, revFile: string) => void; api?: (f: FakeApi) => void; interrupted?: boolean };

const scenarios: Scenario[] = [
  { name: "plain merge", threads: [thread(OLD_T, true), thread(NEW_T)] },
  { name: "revision continued (kept)", threads: [thread(OLD_T, true), thread(NEW_T)], setup: (_t, f) => void put(f, lines(2) + lines(1, "more")) },
  { name: "old thread cannot be unarchived", threads: [thread(OLD_T, true), thread(NEW_T)], api: (f) => { (f.api as unknown as Record<string, unknown>).unarchiveThread = async () => { throw new Error("refused"); }; } },
  { name: "old thread deleted by the user", threads: [thread(NEW_T)] },
  { name: "old thread already active again", threads: [thread(OLD_T), thread(NEW_T)] },
  { name: "interrupted before merged", threads: [thread(OLD_T, true), thread(NEW_T)], interrupted: true },
];

async function runScenario(sc: Scenario, archiveThreads: boolean) {
  const t = tempRoot();
  const revFile = put(join(t.projects, "C--work-demo", `${REV}.jsonl`), lines(2));
  if (sc.interrupted) {
    await append(t.journal, [
      { t: "run-start", runId: "m1", at: "2026-11-11T10:00:00.000Z", command: "merge" },
      { t: "file-written", runId: "m1", path: revFile, sha256: await sha256File(revFile), revisionOf: { harness: "claude", nativeId: SRC } },
      { t: "imported", runId: "m1", harness: "claude", nativeId: REV, threadId: NEW_T, source: { path: revFile, size: statSync(revFile).size, mtimeMs: statSync(revFile).mtimeMs } },
      { t: "thread-archived", runId: "m1", threadId: OLD_T },
    ]);
  } else await mergedRun(t, revFile);
  sc.setup?.(t, revFile);
  const f = fakeApi({ threads: sc.threads.map((x) => ({ ...x })) });
  sc.api?.(f);
  const r = await rollbackRun("m1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api, archiveThreads });
  return { r, f };
}

for (const archiveThreads of [false, true]) {
  test(`lineage invariant${archiveThreads ? " (--archive-threads)" : ""}: every outcome leaves the session an active thread, or reports it as needing review`, async () => {
    for (const sc of scenarios) {
      const { r, f } = await runScenario(sc, archiveThreads);
      const active = f.threads.filter((x) => (x.id === OLD_T || x.id === NEW_T) && !x.archived);
      const reviewed = r.needsReview.some((x) => x.threadId === OLD_T || x.threadId === NEW_T);
      assert.ok(active.length >= 1 || reviewed, `${sc.name}: no active thread and nothing reported (${JSON.stringify({ threads: f.threads, r: r.needsReview })})`);
    }
  });
}

test("--archive-threads: a kept merge's revision thread (continued since) is never archived", async () => {
  const { r, f } = await runScenario(scenarios[1]!, true);
  assert.deepEqual(r.mergesKept.map((m) => m.reason), ["revision continued"]);
  assert.deepEqual(r.threadsArchived, []);
  assert.equal(f.threads.find((x) => x.id === NEW_T)!.archived, false);
});

test("--archive-threads: when the old thread cannot be unarchived, the revision thread stays active and is reported", async () => {
  const { r, f } = await runScenario(scenarios[2]!, true);
  assert.deepEqual(r.threadsArchived, []);
  assert.equal(f.threads.find((x) => x.id === NEW_T)!.archived, false);
  assert.deepEqual(r.needsReview.map((x) => x.threadId), [NEW_T]);
});

test("--archive-threads: when the old thread was deleted in T3 Code, the revision thread stays active and is reported", async () => {
  const { r, f } = await runScenario(scenarios[3]!, true);
  assert.deepEqual(r.threadsArchived, []);
  assert.equal(f.threads.find((x) => x.id === NEW_T)!.archived, false);
  assert.equal(r.needsReview.length, 1);
  assert.match(r.needsReview[0]!.reason, /no longer exists in T3 Code/);
});

test("--archive-threads: a plain undone merge still swaps (old active, revision archived)", async () => {
  const { r, f } = await runScenario(scenarios[0]!, true);
  assert.deepEqual(r.needsReview, []);
  assert.equal(f.threads.find((x) => x.id === OLD_T)!.archived, false);
  assert.equal(f.threads.find((x) => x.id === NEW_T)!.archived, true);
});

test("B9: malformed thread entries (thread-unarchived / thread-archived without a threadId, a revisionOf without a nativeId) are reported, never crash the rollback", async () => {
  const t = tempRoot();
  const f = fakeApi({ threads: [thread("a")] });
  await append(t.journal, [
    { t: "run-start", runId: "m1", at: "2026-11-11T10:00:00.000Z", command: "merge --all" },
    { t: "thread-unarchived", runId: "m1" } as unknown as JournalEntry,
    { t: "thread-archived", runId: "m1", threadId: 7 } as unknown as JournalEntry,
    { t: "file-written", runId: "m1", path: join(t.projects, "C--x", "r.jsonl"), sha256: "a".repeat(64), revisionOf: { harness: "claude" } } as unknown as JournalEntry,
    { t: "imported", runId: "m1", harness: "claude", nativeId: "n1", threadId: "a", source: { path: "/x", size: 1, mtimeMs: 1 } },
  ]);
  const r = await rollbackRun("m1", { journal: t.journal, accountHomes: [t.home], connect: async () => f.api });
  assert.equal(r.errors.filter((x) => /malformed/.test(x)).length, 3, r.errors.join("\n"));
  assert.deepEqual(r.threadsToReview, ["a"]);
});

// ---------- B15 ----------

test("B15: a rollback rerun after a crash between link and unlink (both names, same file) finishes the move", async () => {
  const t = tempRoot();
  const org = join(t.root, ".claude-org");
  const k = put(join(org, "projects", "C--work-demo", "s.jsonl"), lines(4));
  const m = put(join(t.projects, "C--work-demo", "s.jsonl"), lines(2));
  const d = await dedupe([{ path: m, nativeId: "s", keptPath: k, relation: "prefix" }], [
    { id: "claudeAgent", home: t.home, displayName: "P", accentColor: null },
    { id: "claude-org", home: org, displayName: "O", accentColor: null },
  ], t.journal, "d1");
  const moved = d.moved.find((x) => x.from === m)!;
  await promisify(linkCb)(moved.to, m); // the rollback's link happened, then it crashed before the unlink
  const r = await rollbackRun("d1", { journal: t.journal, accountHomes: [t.home, org] });
  assert.ok(r.unquarantined.includes(m), JSON.stringify(r));
  assert.deepEqual(r.unquarantineConflicts, []);
  assert.ok(existsSync(m) && !existsSync(moved.to), "only the original name is left");
  assert.equal(readFileSync(m, "utf8"), lines(2));
});

test("B15: runs counts only writes that happened (file-write-aborted cancels one) and shows merges", async () => {
  const { listRuns } = await import("../../src/ops/rollback.ts");
  const runs = listRuns([
    { t: "run-start", runId: "m1", at: "2026-11-11T10:00:00.000Z", command: "merge --all" },
    { t: "file-written", runId: "m1", path: "/h/projects/x/a.jsonl", sha256: "a".repeat(64) },
    { t: "file-written", runId: "m1", path: "/h/projects/x/b.jsonl", sha256: "b".repeat(64) },
    { t: "file-write-aborted", runId: "m1", path: "/h/projects/x/b.jsonl" },
    { t: "merged", runId: "m1", harness: "claude", nativeId: "n", revisionUuid: "r", revisionFile: "/h/projects/x/a.jsonl", oldThreadId: "o", newThreadId: "nw" },
  ]);
  assert.equal(runs[0]!.counts.filesWritten, 1);
  assert.equal(runs[0]!.counts.merged, 1);
});

test("B15: needsReview tells what to do", async () => {
  const src = readFileSync(new URL("../../src/cli/commands/rollback.ts", import.meta.url), "utf8");
  assert.match(src, /Left active for review in T3 Code \(archiving would leave the session without an active thread\)/);
});
