import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, effectiveWrites, importedIndex, near, newRunId, recoverPendingMtimes } from "../../src/core/journal.ts";
import type { JournalEntry } from "../../src/core/types.ts";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "t3sm-journal-"));
}
const R = "20260101-000000-abcd";
const all = [
  { t: "run-start", runId: R, at: "2026-01-01T00:00:00Z", command: "import" },
  { t: "mtime-bump", runId: R, files: [{ path: "/a", atimeMs: 1, mtimeMs: 2 }] },
  { t: "mtime-restore", runId: R, paths: ["/a"] },
  { t: "file-written", runId: R, path: "/a", sha256: "ff" },
  { t: "instance-created", runId: R, instanceId: "i", homePath: null },
  { t: "project-created", runId: R, projectId: "p", root: "/r" },
  { t: "project-default-set", runId: R, projectId: "p", previous: null, next: { a: 1 } },
  { t: "imported", runId: R, harness: "claude", nativeId: "n", threadId: "t", source: { path: "/s", size: 1, mtimeMs: 2 } },
  { t: "import-failed", runId: R, harness: "codex", nativeId: "n", reason: "x" },
  { t: "quarantined", runId: R, from: "/a", to: "/b", reason: "backup-dir" },
  { t: "instance-pinned", runId: R, instanceId: "i", previous: { homePath: null }, next: { homePath: "x" } },
  { t: "unquarantined", runId: R, from: "/b", to: "/a" },
  { t: "merged", runId: R, harness: "claude", nativeId: "n", revisionUuid: "u", revisionFile: "f", oldThreadId: "o", newThreadId: "nn" },
  { t: "thread-archived", runId: R, threadId: "t" },
  { t: "thread-unarchived", runId: R, threadId: "t" },
  { t: "run-end", runId: R, at: "2026-01-01T00:01:00Z", status: "ok" },
] as JournalEntry[];

test("round-trips every entry kind and creates parent dir", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "sub", "journal.jsonl"));
    for (const e of all) await j.append(e);
    assert.deepEqual(await j.readAll(), all);
    assert.equal(j.lastReadCorruptLines, 0);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("concurrent appends never interleave", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "j.jsonl"));
    const big = "x".repeat(50_000);
    await Promise.all(Array.from({ length: 30 }, (_, i) =>
      j.append({ t: "import-failed", runId: R, harness: "claude", nativeId: String(i), reason: big })));
    const es = await j.readAll();
    assert.equal(es.length, 30);
    assert.equal(j.lastReadCorruptLines, 0);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("tolerates truncated tail, blanks, BOM, corrupt middle; append after truncation stays clean", async () => {
  const d = await tmp();
  try {
    const f = join(d, "j.jsonl");
    const a = JSON.stringify(all[0]);
    const b = JSON.stringify(all[1]);
    await writeFile(f, `﻿${a}\n\n{not json}\n${b}\n{"t":"run-end","runId":"x`, "utf8");
    const j = new Journal(f);
    assert.deepEqual(await j.readAll(), [all[0], all[1]]);
    assert.equal(j.lastReadCorruptLines, 1);
    await j.append(all[2]!);
    assert.deepEqual(await j.readAll(), [all[0], all[1], all[2]]);
    assert.equal(j.lastReadCorruptLines, 2); // truncated line is now mid-file
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("missing file reads empty; unknown t kept; non-string runId dropped", async () => {
  const d = await tmp();
  try {
    const f = join(d, "j.jsonl");
    const j = new Journal(f);
    assert.deepEqual(await j.readAll(), []);
    await writeFile(f, `{"t":"future","runId":"r1","z":1}\n{"t":"x","runId":5}\n{"runId":"r"}\n`);
    const es = await j.readAll();
    assert.equal(es.length, 1);
    assert.equal(es[0]!.t as string, "future");
    assert.equal(j.lastReadCorruptLines, 2);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("newRunId format, UTC", () => {
  const id = newRunId(new Date(Date.UTC(2026, 10, 9, 8, 7, 6)));
  assert.match(id, /^20261109-080706-[0-9a-f]{4}$/);
});

test("importedIndex later wins", () => {
  const mk = (threadId: string): JournalEntry => ({ t: "imported", runId: R, harness: "claude", nativeId: "n", threadId, source: { path: "/s", size: 1, mtimeMs: 2 } });
  const m = importedIndex([mk("t1"), mk("t2"), all[0]!]);
  assert.equal(m.size, 1);
  assert.equal(m.get("claude:n")!.threadId, "t2");
});

async function mkf(d: string, name: string, mtimeMs: number, atimeMs: number): Promise<string> {
  const p = join(d, name);
  await writeFile(p, "data");
  await utimes(p, atimeMs / 1000, mtimeMs / 1000);
  return p;
}
const ms = async (p: string) => Math.round((await stat(p)).mtimeMs);
const setM = (p: string, v: number) => utimes(p, v / 1000, v / 1000);
const BUMP = 1_700_000_000_000;
const empty = { restored: [], missing: [], failed: [], skippedModified: [], malformed: 0 };

test("recover restores pending, leaves restored alone, idempotent", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "j.jsonl"));
    const p1 = await mkf(d, "a.jsonl", 1_600_000_000_123, 1_600_000_000_456);
    const p2 = await mkf(d, "b.jsonl", 1_600_000_005_000, 1_600_000_005_000);
    await j.append({ t: "mtime-bump", runId: R, files: [
      { path: p1, atimeMs: 1_600_000_000_456, mtimeMs: 1_600_000_000_123, targetMtimeMs: BUMP },
      { path: p2, atimeMs: 1_600_000_005_000, mtimeMs: 1_600_000_005_000, targetMtimeMs: BUMP }] });
    await j.append({ t: "mtime-restore", runId: R, paths: [p2] });
    await setM(p1, BUMP);
    await setM(p2, BUMP);
    const r = await recoverPendingMtimes(j);
    assert.deepEqual(r, { ...empty, restored: [p1] });
    assert.equal(await ms(p1), 1_600_000_000_123);
    assert.equal(Math.round((await stat(p1)).atimeMs), 1_600_000_000_456);
    assert.equal(await ms(p2), BUMP, "p2 untouched");
    assert.deepEqual(await recoverPendingMtimes(j), empty);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("recover: double bump in one run restores FIRST original; restore is per run", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "j.jsonl"));
    const p = await mkf(d, "a.jsonl", 1_700_000_000_000, 1_700_000_000_000);
    await j.append({ t: "mtime-bump", runId: "r1", files: [{ path: p, atimeMs: 1_500_000_000_000, mtimeMs: 1_500_000_000_000, targetMtimeMs: 1_600_000_000_000 }] });
    await j.append({ t: "mtime-bump", runId: "r1", files: [{ path: p, atimeMs: 1_600_000_000_000, mtimeMs: 1_600_000_000_000, targetMtimeMs: 1_700_000_000_000 }] });
    await j.append({ t: "mtime-restore", runId: "r2", paths: [p] }); // other run: must not count
    const r = await recoverPendingMtimes(j);
    assert.deepEqual(r.restored, [p]);
    assert.equal(await ms(p), 1_500_000_000_000);
    const es = await j.readAll();
    assert.equal(es.filter((e) => e.t === "mtime-restore" && e.runId === "r1").length, 1);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("recover across runs: earliest pending original wins, both runs marked (reviewer probe)", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "j.jsonl"));
    const p = await mkf(d, "a.jsonl", 1_800_000_000_000, 1_800_000_000_000);
    const O = 1_500_000_000_000, B = 1_700_000_000_000;
    await j.append({ t: "mtime-bump", runId: "A", files: [{ path: p, atimeMs: O, mtimeMs: O, targetMtimeMs: B }] });
    await j.append({ t: "mtime-bump", runId: "B", files: [{ path: p, atimeMs: B, mtimeMs: B, targetMtimeMs: 1_800_000_000_000 }] });
    const r = await recoverPendingMtimes(j);
    assert.deepEqual(r, { ...empty, restored: [p] });
    assert.equal(await ms(p), O);
    const es = await j.readAll();
    for (const id of ["A", "B"]) {
      assert.equal(es.filter((e) => e.t === "mtime-restore" && e.runId === id).length, 1, id);
    }
    assert.deepEqual(await recoverPendingMtimes(j), empty);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("recover: same path spelled differently is one path", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "j.jsonl"));
    const p = await mkf(d, "a.jsonl", 1_800_000_000_000, 1_800_000_000_000);
    const alt = p.replace(/\\/g, "/");
    await j.append({ t: "mtime-bump", runId: "A", files: [{ path: p, atimeMs: 1000, mtimeMs: 1000, targetMtimeMs: 2000 }] });
    await j.append({ t: "mtime-bump", runId: "B", files: [{ path: alt, atimeMs: 2000, mtimeMs: 2000, targetMtimeMs: 1_800_000_000_000 }] });
    const r = await recoverPendingMtimes(j);
    assert.equal(r.restored.length, 1);
    assert.equal(await ms(p), 1000);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("recover: user-modified file is never moved backwards", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "j.jsonl"));
    const p = await mkf(d, "a.jsonl", 1_650_000_000_000, 1_650_000_000_000); // not the target
    await j.append({ t: "mtime-bump", runId: R, files: [{ path: p, atimeMs: 1000, mtimeMs: 1000, targetMtimeMs: BUMP }] });
    const r = await recoverPendingMtimes(j);
    assert.deepEqual(r, { ...empty, skippedModified: [p] });
    assert.equal(await ms(p), 1_650_000_000_000);
    assert.deepEqual(await recoverPendingMtimes(j), empty); // marked restored
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("recover: legacy bump without targetMtimeMs restores", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "j.jsonl"));
    const p = await mkf(d, "a.jsonl", BUMP, BUMP);
    await j.append({ t: "mtime-bump", runId: R, files: [{ path: p, atimeMs: 1_000_000, mtimeMs: 1_000_000 }] } as unknown as JournalEntry);
    assert.deepEqual((await recoverPendingMtimes(j)).restored, [p]);
    assert.equal(await ms(p), 1_000_000);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("recover: malformed bump/restore entries are counted, not thrown", async () => {
  const d = await tmp();
  try {
    const f = join(d, "j.jsonl");
    const j = new Journal(f);
    await writeFile(f, [
      '{"t":"mtime-bump","runId":"r","files":"nope"}',
      '{"t":"mtime-bump","runId":"r","files":[{"path":5}]}',
      '{"t":"mtime-restore","runId":"r","paths":{}}',
    ].join("\n") + "\n");
    assert.deepEqual(await recoverPendingMtimes(j), { ...empty, malformed: 3 });
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("recover: missing file is reported and marked restored; no retry", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "j.jsonl"));
    const gone = join(d, "gone.jsonl");
    await j.append({ t: "mtime-bump", runId: R, files: [{ path: gone, atimeMs: 1000, mtimeMs: 1000, targetMtimeMs: 2000 }] });
    assert.deepEqual(await recoverPendingMtimes(j), { ...empty, missing: [gone] });
    assert.deepEqual(await recoverPendingMtimes(j), empty);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("recover: other errors go to failed and are not marked", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "j.jsonl"));
    const ok = await mkf(d, "ok.jsonl", BUMP, BUMP);
    const bad = join(d, "x\0bad"); // invalid path -> not ENOENT
    await j.append({ t: "mtime-bump", runId: R, files: [
      { path: bad, atimeMs: 1000, mtimeMs: 1000, targetMtimeMs: 2000 },
      { path: ok, atimeMs: 1_500_000_000_000, mtimeMs: 1_500_000_000_000, targetMtimeMs: BUMP }] });
    const r = await recoverPendingMtimes(j);
    assert.deepEqual(r.restored, [ok]);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0]!.path, bad);
    const r2 = await recoverPendingMtimes(j);
    assert.equal(r2.failed.length, 1); // still pending
    assert.deepEqual(r2.restored, []);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("recover chain: user edit between two crashed runs is not rolled back (reviewer probe)", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "j.jsonl"));
    const p = await mkf(d, "a.jsonl", 1_700_000_000_000, 1_700_000_000_000);
    const O = 1_500_000_000_000, T1 = 1_600_000_000_000, M = 1_650_000_000_000, T2 = 1_700_000_000_000;
    await j.append({ t: "mtime-bump", runId: "A", files: [{ path: p, atimeMs: O, mtimeMs: O, targetMtimeMs: T1 }] });
    await j.append({ t: "mtime-bump", runId: "B", files: [{ path: p, atimeMs: M, mtimeMs: M, targetMtimeMs: T2 }] });
    const r = await recoverPendingMtimes(j);
    assert.deepEqual(r, { ...empty, restored: [p] });
    assert.equal(await ms(p), M); // not O
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("recover: crash after utimes but before restore entry is classified restored", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "j.jsonl"));
    const O = 1_500_000_000_000;
    const p = await mkf(d, "a.jsonl", O, O); // already back at original
    await j.append({ t: "mtime-bump", runId: R, files: [{ path: p, atimeMs: O, mtimeMs: O, targetMtimeMs: BUMP }] });
    assert.deepEqual(await recoverPendingMtimes(j), { ...empty, restored: [p] });
    assert.equal(await ms(p), O);
    assert.deepEqual(await recoverPendingMtimes(j), empty);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("recover chain3: restore-without-entry then later run (no user edit) still ends at O", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "j.jsonl"));
    const O = 1_500_000_000_000, T1 = 1_600_000_000_000, T2 = 1_650_000_000_000, T3 = 1_700_000_000_000;
    const p = await mkf(d, "a.jsonl", T3, T3);
    await j.append({ t: "mtime-bump", runId: "A", files: [{ path: p, atimeMs: O, mtimeMs: O, targetMtimeMs: T1 }] });
    await j.append({ t: "mtime-bump", runId: "B", files: [{ path: p, atimeMs: T1, mtimeMs: T1, targetMtimeMs: T2 }] });
    await j.append({ t: "mtime-bump", runId: "C", files: [{ path: p, atimeMs: T1, mtimeMs: T1, targetMtimeMs: T3 }] });
    const r = await recoverPendingMtimes(j);
    assert.deepEqual(r.restored, [p]);
    assert.equal(await ms(p), O);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("near(): coarse-timestamp filesystems", () => {
  assert.ok(near(1_000, 1_001));
  assert.ok(near(1_650_000_000_000, 1_650_000_000_789)); // 1 s truncation
  assert.ok(near(1_650_000_000_000, 1_650_000_001_500)); // 2 s FAT, even second
  assert.ok(!near(1_650_000_005_000, 1_650_000_000_789)); // different second
  assert.ok(!near(1_650_000_000_500, 1_650_000_000_789)); // sub-second but not coarse-aligned
});

test("recover: coarse stat (1 s) still matches our target, so the file is restored not skipped", async () => {
  const d = await tmp();
  try {
    const j = new Journal(join(d, "j.jsonl"));
    const p = await mkf(d, "a.jsonl", BUMP, BUMP);
    const target = 1_700_000_000_789;
    await j.append({ t: "mtime-bump", runId: R, files: [{ path: p, atimeMs: 1_000_000, mtimeMs: 1_000_000, targetMtimeMs: target }] });
    const coarse = async () => ({ mtimeMs: Math.floor(target / 1000) * 1000 });
    const r = await recoverPendingMtimes(j, { stat: coarse });
    assert.deepEqual(r, { ...empty, restored: [p] });
    assert.equal(await ms(p), 1_000_000);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("effectiveWrites: file-write-aborted cancels the latest file-written of the same run and path (case-folded key)", () => {
  const w = (runId: string, path: string, sha: string): JournalEntry => ({ t: "file-written", runId, path, sha256: sha.repeat(64) });
  const es: JournalEntry[] = [
    w("r1", "C:/a.jsonl", "1"), w("r2", "C:/a.jsonl", "2"), w("r2", "C:/b.jsonl", "3"), w("r2", "C:/a.jsonl", "4"),
    { t: "file-write-aborted", runId: "r2", path: "c:/A.JSONL" },
    { t: "file-write-aborted", runId: "r3", path: "C:/b.jsonl" }, // another run: cancels nothing
  ];
  const got = effectiveWrites(es, (p) => p.toLowerCase()).map((e) => (e as { sha256: string }).sha256[0]);
  assert.deepEqual(got, ["1", "2", "3"]);
});

test("B16: a torn mtime-bump as the journal's last line (crash while appending, before any utimes) restores nothing; later entries stay clean", async () => {
  const d = await tmp();
  try {
    const f = join(d, "t.jsonl");
    await writeFile(f, "x");
    const orig = Date.parse("2026-01-01T00:00:00Z");
    await utimes(f, orig / 1000, orig / 1000);
    const jf = join(d, "journal.jsonl");
    const j = new Journal(jf);
    await j.append({ t: "run-start", runId: "r1", at: "2026-11-11T10:00:00Z", command: "apply" });
    const whole = JSON.stringify({ t: "mtime-bump", runId: "r1", files: [{ path: f, atimeMs: orig, mtimeMs: orig, targetMtimeMs: Date.now() }] });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(jf, whole.slice(0, Math.floor(whole.length / 2))); // torn: no newline, cut mid-record
    const rec = await recoverPendingMtimes(j);
    assert.deepEqual([rec.restored, rec.failed, rec.skippedModified, rec.missing], [[], [], [], []]);
    assert.equal((await stat(f)).mtimeMs, orig, "never touched");
    await j.append({ t: "run-end", runId: "r1", at: "2026-11-11T10:01:00Z", status: "aborted" });
    const es = await j.readAll();
    assert.deepEqual(es.map((e) => e.t), ["run-start", "run-end"], "the next entry is not glued onto the torn tail");
    assert.equal(j.lastReadCorruptLines, 1, "the torn line is now a corrupt middle line, reported");
  } finally { await rm(d, { recursive: true, force: true }); }
});
