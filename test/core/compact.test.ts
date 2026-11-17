import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPACT_COMMAND, CompactionMismatch, JournalChanged, assertEquivalent, backupName, compactJournal, dropLines, nodeCompactFs, planCompaction,
  type CompactFs,
} from "../../src/core/compact.ts";
import {
  Journal, effectiveWrites, importedIndex, organizeFailures, parseJournal, pendingBumps, pendingMtimePaths, recoverPendingMtimes,
} from "../../src/core/journal.ts";
import type { JournalEntry } from "../../src/core/types.ts";
import { pathKey } from "../../src/core/paths.ts";
import { isRollbackRun, latestRunId, listRuns, organizeOnlyRun, rollbackRun } from "../../src/ops/rollback.ts";
import { latestOrganizeRun } from "../../src/cli/commands/organize.ts";
import { ConfigError } from "../../src/core/config.ts";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const OLD = "2026-05-01T10:00:00.000Z";
const OLD_END = "2026-05-01T10:05:00.000Z";
const RECENT = "2026-11-10T10:00:00.000Z";
const SHA = "a".repeat(64);
const now = (): number => NOW;

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "t3sm-compact-"));
}

const start = (runId: string, command: string, at = OLD): JournalEntry => ({ t: "run-start", runId, at, command });
const end = (runId: string, at = OLD_END, status: "ok" | "partial" | "aborted" = "ok"): JournalEntry => ({ t: "run-end", runId, at, status });
const bump = (runId: string, ...paths: string[]): JournalEntry => ({
  t: "mtime-bump", runId, files: paths.map((path, i) => ({ path, atimeMs: 1_700_000_000_000 + i, mtimeMs: 1_700_000_000_000 + i, targetMtimeMs: 1_900_000_000_000 + i })),
});
const restore = (runId: string, ...paths: string[]): JournalEntry => ({ t: "mtime-restore", runId, paths });

/**
 * A journal with every entry kind of src/core/types.ts, spread over runs that must and must not be folded. `files`
 * holds the transcript paths (in a temp folder) so recovery can stat them: `pending` stays bumped (B's restore failed).
 */
function realistic(d: string): { entries: JournalEntry[]; pending: string; folded: string[] } {
  const p = (n: string): string => join(d, "home", ".claude", "projects", "C--work-demo", n);
  const a1 = p("a1.jsonl"), a2 = p("a2.jsonl"), pending = p("pending.jsonl"), c1 = p("c1.jsonl"), f1 = p("f1.jsonl"), h1 = p("h1.jsonl"), i1 = p("i1.jsonl"), k1 = p("k1.jsonl");
  const src = { path: a1, size: 10, mtimeMs: 1_700_000_000_000 };
  const entries: JournalEntry[] = [
    // A: an old apply, finished, everything resolved: folded.
    start("A", "apply 20260501-095000-aaaa"),
    { t: "instance-created", runId: "A", instanceId: "claude-work", homePath: "~/.claude-work" },
    { t: "instance-pinned", runId: "A", instanceId: "claudeAgent", previous: { homePath: null }, next: { homePath: "~/.claude" } },
    { t: "instance-updated", runId: "A", instanceId: "claude-work", previous: { displayName: null, accentColor: null, homePath: null }, next: { displayName: "Work", accentColor: "#112233", homePath: "~/.claude-work" } },
    { t: "folder-created", runId: "A", path: join(d, "General"), created: join(d, "General") },
    { t: "project-created", runId: "A", projectId: "proj-1", root: "C:/work/demo", title: "demo" },
    { t: "project-default-set", runId: "A", projectId: "proj-1", previous: null, next: { instanceId: "claude-work", model: "m" } },
    { t: "file-written", runId: "A", path: p("conv.jsonl"), sha256: SHA, mtimeMs: 1_700_000_000_000, source: { harness: "codex", nativeId: "cx-1", updatedAt: OLD, messageCount: 3 } },
    { t: "file-written", runId: "A", path: p("lost.jsonl"), sha256: SHA },
    { t: "file-write-aborted", runId: "A", path: p("lost.jsonl") },
    bump("A", a1, a2),
    { t: "import-attempt", runId: "A", items: [{ harness: "claude", nativeId: "n-a1", threadId: "import:a1", source: src }, { harness: "claude", nativeId: "n-a2", threadId: "import:a2" }], parked: [{ harness: "claude", nativeId: "n-park", threadId: "import:park" }] },
    { t: "imported", runId: "A", harness: "claude", nativeId: "n-a1", threadId: "import:a1", source: src },
    { t: "import-failed", runId: "A", harness: "claude", nativeId: "n-a2", reason: "not found after the scan" },
    restore("A", a1, a2),
    { t: "quarantined", runId: "A", from: p("x.bak"), to: join(d, "q", "x.bak"), reason: "backup-dir" },
    end("A"),
    // J: old, finished, but it bumped the path B left pending: kept (recovery reads that path's spelling from J).
    start("J", "sync J", OLD), bump("J", pending), restore("J", pending), end("J"),
    // B: old sync whose restore failed: its bump is still pending. Kept.
    start("B", "sync B"), bump("B", pending), end("B", OLD_END, "partial"),
    // C: old apply with an import attempt that never got an outcome. Kept.
    start("C", "apply 20260501-000000-cccc"), bump("C", c1),
    { t: "import-attempt", runId: "C", items: [{ harness: "claude", nativeId: "n-c1", threadId: "import:c1" }] },
    restore("C", c1), end("C"),
    // D: an organize run (no file times).
    start("D", "organize"),
    { t: "organize-change", runId: "D", kind: "title", target: "import:a1", previous: "old", next: "new" },
    { t: "organize-failed", runId: "D", kind: "archive", target: "import:a2", projectId: "proj-1", error: "refused" },
    end("D"),
    // E: the rollback of D.
    start("E", "rollback D"),
    { t: "organize-undone", runId: "E", targetRunId: "D", kind: "title", target: "import:a1", previous: "new", next: "old" },
    { t: "rolled-back", runId: "E", targetRunId: "D", at: OLD_END },
    end("E"),
    // F: an old merge: folded.
    start("F", "merge --all"), bump("F", f1),
    { t: "file-written", runId: "F", path: p("rev.jsonl"), sha256: SHA, revisionOf: { harness: "claude", nativeId: "n-f1" } },
    { t: "merged", runId: "F", harness: "claude", nativeId: "n-f1", revisionUuid: "u", revisionFile: p("rev.jsonl"), oldThreadId: "import:f1", newThreadId: "import:u", sourceSize: 5, sourceMtimeMs: 6 },
    restore("F", f1), end("F"),
    // G: a follow, archive and unquarantine (no file times).
    start("G", "sync G"),
    { t: "followed", runId: "G", original: f1, copy: p("copy.jsonl"), oldThread: "import:x", newThread: null, mode: "refresh" },
    { t: "thread-archived", runId: "G", threadId: "import:x" },
    { t: "thread-unarchived", runId: "G", threadId: "import:y" },
    { t: "unquarantined", runId: "G", from: join(d, "q", "x.bak"), to: p("x.bak") },
    end("G"),
    // U: a t3sm update.
    { t: "update", runId: "U", from: "0.4.0", to: "0.4.1", source: { kind: "npm", name: "t3code-session-manager" }, outcome: "pending" },
    { t: "update", runId: "U", from: "0.4.0", to: "0.4.1", source: { kind: "npm", name: "t3code-session-manager" }, outcome: "installed" },
    // I: killed (no run-end); recovery restored its bump later. Kept: unfinished.
    start("I", "apply 20260501-000000-iiii"), bump("I", i1), restore("I", i1),
    // K: old and finished, but with a malformed bump. Kept.
    start("K", "sync K"), { t: "mtime-bump", runId: "K", files: "nope" } as unknown as JournalEntry, restore("K", k1), end("K"),
    // H: recent: kept, and it is the newest run.
    start("H", "sync H", RECENT), bump("H", h1), restore("H", h1), end("H", RECENT),
  ];
  return { entries, pending, folded: ["A", "F"] };
}

function write(file: string, entries: JournalEntry[], extra = ""): string {
  const text = entries.map((e) => JSON.stringify(e)).join("\n") + "\n" + extra;
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return text;
}

test("planCompaction folds only old, finished runs with nothing pending, and says why the others stay", () => {
  const d = "/x";
  const { entries, folded } = realistic(d);
  const text = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const plan = planCompaction(text, { now: NOW, olderThanDays: 90, platform: "linux" });
  assert.deepEqual(plan.runs, folded);
  assert.equal(plan.entries, 4);
  assert.deepEqual(plan.kept, { pending: 4, recent: 0, unfinished: 2 }); // J, B, C, K / I, H (the newest run)
  assert.ok(plan.bytesAfter < plan.bytesBefore);
  const after = parseJournal(dropLines(text, plan.drop)).entries;
  assert.equal(after.filter((e) => (e.runId === "A" || e.runId === "F") && (e.t === "mtime-bump" || e.t === "mtime-restore")).length, 0);
  assert.equal(after.length, entries.length - 4);
});

test("planCompaction: a shorter threshold folds the recent run too, but never the newest run", () => {
  const { entries } = realistic("/x");
  const text = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  assert.deepEqual(planCompaction(text, { now: NOW, olderThanDays: 1, platform: "linux" }).runs, ["A", "F"]); // H is the newest
  const more = text + JSON.stringify(start("Z", "sync Z", RECENT)) + "\n" + JSON.stringify(end("Z", RECENT)) + "\n";
  assert.deepEqual(planCompaction(more, { now: NOW, olderThanDays: 1, platform: "linux" }).runs, ["A", "F", "H"]);
  // A compaction run is not "the newest run": it never hides the run before it.
  const withCompaction = text + JSON.stringify(start("Q", COMPACT_COMMAND, RECENT)) + "\n";
  assert.deepEqual(planCompaction(withCompaction, { now: NOW, olderThanDays: 1, platform: "linux" }).runs, ["A", "F"]);
});

test("planCompaction: a run's path that is pending in another run under another spelling (win32) keeps it", () => {
  const es = [start("A", "apply"), bump("A", "C:/Work/A.jsonl"), restore("A", "C:/Work/A.jsonl"), end("A"),
    start("B", "sync"), bump("B", "c:/work/a.jsonl"), end("B"), start("Z", "sync", RECENT), end("Z", RECENT)];
  const text = es.map((e) => JSON.stringify(e)).join("\n") + "\n";
  assert.deepEqual(planCompaction(text, { now: NOW, olderThanDays: 90, platform: "win32" }).runs, []);
  assert.deepEqual(planCompaction(text, { now: NOW, olderThanDays: 90, platform: "linux" }).runs, ["A"]);
});

/** Everything a reader computes from the journal that does not touch the world. */
function readers(entries: JournalEntry[], platform: NodeJS.Platform): unknown {
  const runIds = [...new Set(entries.map((e) => e.runId))];
  const key = (p: string): string => pathKey(p, platform);
  return {
    runs: listRuns(entries),
    latest: latestRunId(entries),
    writes: effectiveWrites(entries, key),
    imported: [...importedIndex(entries)],
    pendingPaths: pendingMtimePaths(entries, platform),
    pendingBumps: pendingBumps(entries, platform),
    organize: latestOrganizeRun(entries),
    perRun: runIds.map((id) => ({ id, failures: organizeFailures(entries, id), rollback: isRollbackRun(entries, id), organizeOnly: organizeOnlyRun(entries, id) })),
  };
}

test("equivalence: every reader computes the same from the compacted journal (rollback, undo, recovery, runs, status)", async () => {
  const d = await tmp();
  try {
    const { entries, pending } = realistic(d);
    const file = join(d, "state", "journal.jsonl");
    const original = write(file, entries, "{not json\n");
    for (const f of [pending]) { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, "x"); }
    const j = new Journal(file);
    const r = await compactJournal(j, { now, olderThanDays: 90 });
    assert.deepEqual(r.plan.runs, ["A", "F"]);
    assert.ok(r.runId);
    const after = await j.readAll();
    const ours = after.filter((e) => e.runId === r.runId);
    assert.deepEqual(ours.map((e) => e.t), ["run-start", "journal-compacted", "run-end"]);
    // What the readers saw before, plus the compaction's own run (any run appends its entries).
    const beforeFile = join(d, "before", "journal.jsonl");
    write(beforeFile, [...entries, ...ours], "{not json\n");
    const jb = new Journal(beforeFile);
    const before = await jb.readAll();
    assert.equal(jb.lastReadCorruptLines, 1);
    assert.equal(j.lastReadCorruptLines, 1);
    for (const platform of ["win32", "linux", "darwin"] as const) assert.deepEqual(readers(after, platform), readers(before, platform));
    // Only file-time entries of A and F went; everything else is there, in order.
    const gone = before.filter((e) => !after.some((x) => JSON.stringify(x) === JSON.stringify(e)));
    assert.deepEqual(gone.map((e) => `${e.runId}:${e.t}`), ["A:mtime-bump", "A:mtime-restore", "F:mtime-bump", "F:mtime-restore"]);
    // Backup: the journal exactly as it was when the compaction started (its run-start appended).
    assert.equal(readFileSync(r.backup!, "utf8"), original + JSON.stringify(ours[0]) + "\n");
    assert.equal(r.backup, join(d, "state", backupName(r.runId!)));

    // rollback (dry run: what it would undo) of every run, from both journals.
    const home = join(d, "home");
    for (const id of [...new Set(before.map((e) => e.runId))]) {
      const a = await rollbackRun(id, { journal: jb, accountHomes: [home], dryRun: true, now }).catch((e: Error) => e.message);
      const b = await rollbackRun(id, { journal: j, accountHomes: [home], dryRun: true, now }).catch((e: Error) => e.message);
      assert.deepEqual(b, a, `rollback ${id}`);
    }

    // recovery: the same files restored and the same entries appended, from both journals.
    const bumped = (1_900_000_000_000) / 1000;
    utimesSync(pending, bumped, bumped);
    const ra = await recoverPendingMtimes(jb);
    const ma = statSync(pending).mtimeMs;
    utimesSync(pending, bumped, bumped);
    const rb = await recoverPendingMtimes(j);
    assert.deepEqual(rb, ra);
    assert.equal(statSync(pending).mtimeMs, ma);
    assert.deepEqual(ra.restored, [pending]);
    const tailA = (await jb.readAll()).slice(before.length);
    const tailB = (await j.readAll()).slice(after.length);
    assert.deepEqual(tailB, tailA);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("equivalence: recovery of a pending bump that the file moved away from (skipped as modified) is the same", async () => {
  const d = await tmp();
  try {
    const { entries, pending } = realistic(d);
    const file = join(d, "s", "journal.jsonl");
    write(file, entries);
    mkdirSync(join(pending, ".."), { recursive: true });
    writeFileSync(pending, "x");
    const j = new Journal(file);
    const r = await compactJournal(j, { now, olderThanDays: 90 });
    const ours = (await j.readAll()).filter((e) => e.runId === r.runId);
    const jb = new Journal(join(d, "b", "journal.jsonl"));
    write(jb.file, [...entries, ...ours]);
    utimesSync(pending, 1_800_000_000, 1_800_000_000); // neither the original nor the target: modified since
    assert.deepEqual(await recoverPendingMtimes(j), await recoverPendingMtimes(jb));
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("compacting twice folds nothing the second time and writes nothing", async () => {
  const d = await tmp();
  try {
    const { entries } = realistic(d);
    const file = join(d, "journal.jsonl");
    write(file, entries);
    const j = new Journal(file);
    await compactJournal(j, { now, olderThanDays: 90 });
    const once = readFileSync(file, "utf8");
    const r = await compactJournal(j, { now, olderThanDays: 90 });
    assert.equal(r.runId, null);
    assert.deepEqual(r.plan.runs, []);
    assert.equal(readFileSync(file, "utf8"), once);
    assert.equal(readdirSync(d).filter((n) => n.endsWith(".bak.jsonl")).length, 1);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("nothing to fold, or no journal at all: nothing is written", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "journal.jsonl"));
    assert.equal((await compactJournal(j, { now, olderThanDays: 90 })).runId, null);
    assert.equal(existsSync(j.file), false);
    write(j.file, [start("A", "apply"), bump("A", "/a"), restore("A", "/a"), end("A")]); // the newest run
    const text = readFileSync(j.file, "utf8");
    assert.equal((await compactJournal(j, { now, olderThanDays: 90 })).runId, null);
    assert.equal(readFileSync(j.file, "utf8"), text);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("the journal-compacted entry records what was folded and the backup; bytesAfter is the new size", async () => {
  const d = await tmp();
  try {
    const { entries } = realistic(d);
    const j = new Journal(join(d, "journal.jsonl"));
    write(j.file, entries);
    const r = await compactJournal(j, { now, olderThanDays: 90 });
    const c = (await j.readAll()).find((e) => e.t === "journal-compacted") as Extract<JournalEntry, { t: "journal-compacted" }>;
    assert.equal(c.runs, 2);
    assert.equal(c.entries, 4);
    assert.equal(c.olderThanDays, 90);
    assert.equal(c.backup, backupName(r.runId!));
    assert.equal(c.bytesBefore, statSync(r.backup!).size);
    assert.equal(c.bytesAfter, statSync(j.file).size);
    assert.equal(r.plan.bytesAfter, c.bytesAfter);
  } finally { await rm(d, { recursive: true, force: true }); }
});

/** A CompactFs that fails at step `at` (after `skip` successful calls of it). */
function failing(at: keyof CompactFs, error: Error, skip = 0): CompactFs {
  let n = 0;
  const fs = { ...nodeCompactFs };
  const real = fs[at] as (...a: unknown[]) => Promise<unknown>;
  (fs as Record<string, unknown>)[at] = async (...a: unknown[]) => {
    if (n++ >= skip) throw error;
    return real(...a);
  };
  return fs;
}

for (const [label, at, skip] of [
  ["the backup cannot be written", "writeNew", 0],
  ["the new journal cannot be written", "writeNew", 1],
  ["the rename fails", "rename", 0],
] as const) {
  test(`crash safety: when ${label}, the old journal stays as it was (plus the run's start and an aborted end), no temp is left`, async () => {
    const d = await tmp();
    try {
      const { entries } = realistic(d);
      const j = new Journal(join(d, "journal.jsonl"));
      const original = write(j.file, entries);
      const err = Object.assign(new Error("injected"), { code: "EIO" });
      await assert.rejects(compactJournal(j, { now, olderThanDays: 90, fs: failing(at, err, skip) }), /injected/);
      const after = await j.readAll();
      assert.deepEqual(after.slice(0, entries.length), entries);
      const ours = after.slice(entries.length);
      assert.deepEqual(ours.map((e) => e.t), ["run-start", "run-end"]);
      assert.equal((ours[1] as Extract<JournalEntry, { t: "run-end" }>).status, "aborted");
      assert.ok(readFileSync(j.file, "utf8").startsWith(original));
      assert.deepEqual(readdirSync(d).filter((n) => n.endsWith(".tmp")), []);
      // The journal still works: a later compaction succeeds.
      const r = await compactJournal(j, { now, olderThanDays: 90 });
      assert.deepEqual(r.plan.runs, ["A", "F"]);
    } finally { await rm(d, { recursive: true, force: true }); }
  });
}

test("crash safety: a process killed before the rename leaves the old journal usable and recovery unchanged", async () => {
  const d = await tmp();
  try {
    const { entries, pending } = realistic(d);
    mkdirSync(join(pending, ".."), { recursive: true });
    writeFileSync(pending, "x");
    const j = new Journal(join(d, "journal.jsonl"));
    write(j.file, entries);
    // "Killed": the rename never happens and nothing cleans up (the temp file stays, no run-end).
    class Killed extends Error {}
    const fs: CompactFs = { ...nodeCompactFs, rename: async () => { throw new Killed("killed"); }, rm: async () => {} };
    const append = j.append.bind(j);
    let dead = false;
    j.append = (e) => (dead ? Promise.reject(new Killed("killed")) : append(e).then(() => { if (e.t === "run-start") dead = true; }));
    await assert.rejects(compactJournal(j, { now, olderThanDays: 90, fs }), Killed);
    const fresh = new Journal(j.file);
    const es = await fresh.readAll();
    assert.deepEqual(es.slice(0, entries.length), entries);
    assert.deepEqual(es.slice(entries.length).map((e) => e.t), ["run-start"]);
    assert.deepEqual(listRuns(es).at(-1)!.status, "incomplete");
    utimesSync(pending, 1_900_000_000, 1_900_000_000);
    assert.deepEqual((await recoverPendingMtimes(fresh)).restored, [pending]);
    // A later compaction folds as usual (the killed run is not "the newest run"); recovery resolved B, so B and J fold too.
    assert.deepEqual((await compactJournal(fresh, { now, olderThanDays: 90 })).plan.runs, ["A", "J", "B", "F"]);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("crash safety: an append that slipped in during the compaction aborts it; nothing is lost", async () => {
  const d = await tmp();
  try {
    const { entries } = realistic(d);
    const j = new Journal(join(d, "journal.jsonl"));
    write(j.file, entries);
    const late: JournalEntry = { t: "thread-archived", runId: "LATE", threadId: "import:late" };
    const fs: CompactFs = { ...nodeCompactFs, size: async (p) => { await new Journal(p).append(late); return nodeCompactFs.size(p); } };
    await assert.rejects(compactJournal(j, { now, olderThanDays: 90, fs }), JournalChanged);
    const es = await j.readAll();
    assert.ok(es.some((e) => e.runId === "LATE"));
    assert.equal(es.filter((e) => e.t === "mtime-bump").length, entries.filter((e) => e.t === "mtime-bump").length);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("assertEquivalent refuses a result that drops anything but file-time entries or changes what is pending", () => {
  const es = [start("A", "apply"), bump("A", "/a"), restore("A", "/a"), end("A"), start("B", "sync"), bump("B", "/b"), end("B")];
  const text = es.map((e) => JSON.stringify(e)).join("\n") + "\n";
  assert.doesNotThrow(() => assertEquivalent(text, dropLines(text, [1, 2]), "linux"));
  assert.throws(() => assertEquivalent(text, dropLines(text, [3]), "linux"), CompactionMismatch); // a run-end
  assert.throws(() => assertEquivalent(text, dropLines(text, [5]), "linux"), CompactionMismatch); // B's pending bump
  assert.throws(() => assertEquivalent(text, dropLines(text, [2]), "linux"), CompactionMismatch); // A's restore alone
  assert.throws(() => assertEquivalent(text + "garbage\n", text, "linux"), CompactionMismatch);
});

test("readers: the compaction run is never the latest run to roll back, and rolling it back is refused", async () => {
  const d = await tmp();
  try {
    const { entries } = realistic(d);
    const j = new Journal(join(d, "journal.jsonl"));
    write(j.file, entries);
    const r = await compactJournal(j, { now, olderThanDays: 90 });
    const es = await j.readAll();
    assert.equal(latestRunId(es), "H");
    await assert.rejects(rollbackRun(r.runId!, { journal: j, accountHomes: [d], dryRun: true, now }), ConfigError);
    const row = listRuns(es).find((x) => x.runId === r.runId)!;
    assert.equal(row.command, COMPACT_COMMAND);
    assert.equal(row.status, "ok");
    assert.deepEqual(Object.values(row.counts).filter((n) => n !== 0), []);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("dropLines keeps every other line byte for byte (CRLF lines, a BOM, a corrupt line)", () => {
  const text = "\ufeff" + JSON.stringify(start("A", "x")) + "\r\n" + "{bad\n" + JSON.stringify(bump("A", "/a")) + "\n" + JSON.stringify(end("A")) + "\n";
  assert.equal(dropLines(text, [2]), "\ufeff" + JSON.stringify(start("A", "x")) + "\r\n" + "{bad\n" + JSON.stringify(end("A")) + "\n");
});

test("an older t3sm (no compaction guard) finds nothing to undo in a compaction run: journal-compacted is ignored", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "journal.jsonl"));
    // What an older reader sees: a run of a command it does not know, holding only the unknown journal-compacted entry.
    write(j.file, [
      start("A", "apply"), end("A"),
      start("C", "journal compact (as an older t3sm reads it)", RECENT),
      { t: "journal-compacted", runId: "C", at: RECENT, olderThanDays: 90, runs: 1, entries: 2, bytesBefore: 10, bytesAfter: 5, backup: "journal.C.bak.jsonl" },
      end("C", RECENT),
    ]);
    const r = await rollbackRun("C", { journal: j, accountHomes: [d], dryRun: true, now });
    assert.deepEqual(Object.entries(r).filter(([, v]) => Array.isArray(v) && v.length > 0), []);
    const row = listRuns(await j.readAll()).find((x) => x.runId === "C")!;
    assert.deepEqual(Object.values(row.counts).filter((n) => n !== 0), []);
  } finally { await rm(d, { recursive: true, force: true }); }
});
