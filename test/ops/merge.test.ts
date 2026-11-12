// Merge revisions (Task 23): synthetic transcripts in temp homes, a fake T3. Never touches a real home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { executeMerges, findMergeCandidates, prepareRevision, readBranch, readMergePending, revisionUuid, sweepStaleTemps, type MergeDeps, type MergeResult } from "../../src/ops/merge.ts";
import { effectiveWrites } from "../../src/core/journal.ts";
import { rollbackRun } from "../../src/ops/rollback.ts";
import { uuidV5 } from "../../src/core/uuid.ts";

const uuidOfProvenance = (rev: string): string => uuidV5(`rev-provenance:${rev}`);
import { runSyncCycle, logLine, summaryLines, type SyncCycleDeps } from "../../src/ops/sync.ts";
import { mergeCommand } from "../../src/cli/commands/merge.ts";
import { defaultConfig, saveConfig } from "../../src/core/config.ts";
import { Journal } from "../../src/core/journal.ts";
import type { JournalEntry, PlanItem } from "../../src/core/types.ts";
import type { T3Api } from "../../src/t3/api.ts";
import type { SourceAdapter } from "../../src/sources/types.ts";
import type { Io } from "../../src/cli/main.ts";
import { DAY, fakeT3, inst, tempHome, type FakeT3 } from "../apply/fake-t3.ts";
import { HOME, NOW, cfg, sess } from "../plan/helpers.ts";
import { buildPlan } from "../../src/plan/planner.ts";

const ROOT = "C:/work/demo";
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0);
const u = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Rec = Record<string, unknown>;

/** A chained message record of session `sid` (uuid u(n), parent u(parent) or null). */
function rec(sid: string, n: number, parent: number | null, type: "user" | "assistant", text: string, extra: Rec = {}): Rec {
  return {
    parentUuid: parent === null ? null : u(parent), isSidechain: false, type,
    message: type === "user" ? { role: "user", content: text } : { role: "assistant", content: [{ type: "text", text }] },
    uuid: u(n), timestamp: new Date(T0 + n * 1000).toISOString(), cwd: ROOT, sessionId: sid, ...extra,
  };
}
const jsonl = (rs: Rec[]): string => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const parse = (p: string): Rec[] => readFileSync(p, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Rec);
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

function sid(n: number): string {
  return `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
}

// ---------- revisionUuid ----------

test("revisionUuid: deterministic, and a different size is a different revision", () => {
  const a = revisionUuid(sid(1), 1234);
  assert.equal(a, revisionUuid(sid(1), 1234));
  assert.notEqual(a, revisionUuid(sid(1), 1235));
  assert.notEqual(a, revisionUuid(sid(2), 1234));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// ---------- readBranch: the leaf `claude --resume` picks (S3 §6) ----------

/** P -> U1 -> A1, then branch X (b3, b4) and branch Y (b5, b6), both children of A1, X before Y in file order. */
function forked(s: string, over: { xTs?: number; yTs?: number } = {}): Rec[] {
  const ts = (n: number, t?: number): Rec => (t === undefined ? {} : { timestamp: new Date(T0 + t * 1000).toISOString() });
  return [
    rec(s, 0, null, "user", "P"), rec(s, 1, 0, "user", "U1"), rec(s, 2, 1, "assistant", "A1"),
    rec(s, 3, 2, "user", "BRANCH-X", ts(3, over.xTs)), rec(s, 4, 3, "assistant", "X done", ts(4, over.xTs)),
    rec(s, 5, 2, "user", "BRANCH-Y", ts(5, over.yTs)), rec(s, 6, 5, "assistant", "Y done", ts(6, over.yTs)),
  ];
}

test("readBranch: without last-prompt the leaf is the last record with a uuid in FILE order, not the newest timestamp (V1)", async () => {
  const e = tempHome();
  const p = join(e.dir, `${sid(1)}.jsonl`);
  writeFileSync(p, jsonl(forked(sid(1), { xTs: 100, yTs: 50 })));
  const b = await readBranch(p);
  assert.equal(b.leaf, u(6));
  assert.equal(b.leafSource, "file-order");
  assert.deepEqual(b.chain.map((n) => n.uuid), [u(0), u(1), u(2), u(5), u(6)]);
  assert.equal(b.divergedLeaves, 1, "branch X is reported, not silently dropped");
});

test("readBranch: a last-prompt whose leafUuid resolves wins (V2); the newest one counts; an unresolvable one is ignored", async () => {
  const e = tempHome();
  const p = join(e.dir, `${sid(1)}.jsonl`);
  writeFileSync(p, jsonl([...forked(sid(1)), { type: "last-prompt", leafUuid: u(6), sessionId: sid(1) }, { type: "last-prompt", leafUuid: u(4), sessionId: sid(1) }]));
  const b = await readBranch(p);
  assert.equal(b.leaf, u(4));
  assert.equal(b.leafSource, "last-prompt");
  assert.deepEqual(b.chain.map((n) => n.uuid), [u(0), u(1), u(2), u(3), u(4)]);

  writeFileSync(p, jsonl([...forked(sid(1)), { type: "last-prompt", leafUuid: u(99), sessionId: sid(1) }]));
  const c = await readBranch(p);
  assert.equal(c.leaf, u(6), "a stale leafUuid falls back to file order");
});

test("readBranch: summary.leafUuid is ignored (V3); a trailing system record with a uuid is the leaf (V4); sidechains are never nodes", async () => {
  const e = tempHome();
  const p = join(e.dir, `${sid(1)}.jsonl`);
  writeFileSync(p, jsonl([...forked(sid(1)), { type: "summary", summary: "s", leafUuid: u(4) }]));
  assert.equal((await readBranch(p)).leaf, u(6));

  const sys = { parentUuid: u(4), type: "system", subtype: "turn_end", uuid: u(7), timestamp: new Date(T0 + 7000).toISOString(), cwd: ROOT, sessionId: sid(1) };
  const side = { ...rec(sid(1), 8, 6, "user", "subagent prompt"), isSidechain: true };
  writeFileSync(p, jsonl([...forked(sid(1)), sys, side]));
  const b = await readBranch(p);
  assert.equal(b.leaf, u(7), "trailing system record = leaf, sidechain record skipped");
  assert.deepEqual(b.chain.map((n) => n.uuid), [u(0), u(1), u(2), u(3), u(4), u(7)]);
});

test("readBranch: T3 continued on one branch and the terminal on another -> the terminal branch (newest leaf); T3's branch is a diverged leaf", async () => {
  const e = tempHome();
  const p = join(e.dir, `${sid(1)}.jsonl`);
  const s = sid(1);
  const recs = [
    rec(s, 0, null, "user", "P"), rec(s, 1, 0, "user", "U1"), rec(s, 2, 1, "assistant", "A1"),
    rec(s, 3, 2, "user", "T3 turn", { entrypoint: "t3-code" }), rec(s, 4, 3, "assistant", "T3 reply", { entrypoint: "t3-code" }),
    { type: "last-prompt", leafUuid: u(4), sessionId: s },
    rec(s, 5, 2, "user", "terminal turn", { entrypoint: "cli" }), rec(s, 6, 5, "assistant", "terminal reply", { entrypoint: "cli" }),
    { type: "last-prompt", leafUuid: u(6), sessionId: s },
  ];
  writeFileSync(p, jsonl(recs));
  const b = await readBranch(p);
  assert.equal(b.leaf, u(6));
  assert.deepEqual(b.chain.map((n) => n.uuid), [u(0), u(1), u(2), u(5), u(6)]);
  assert.equal(b.addedMessages, 2, "the two terminal messages are what T3 does not have");
  assert.equal(b.divergedLeaves, 1);
});

test("readBranch (R1): terminal turns T3 resumed over still count (T3's timeline never showed them); T3's own turns never do", async () => {
  const e = tempHome();
  const p = join(e.dir, `${sid(1)}.jsonl`);
  const s = sid(1);
  writeFileSync(p, jsonl([
    rec(s, 0, null, "user", "P"), rec(s, 1, 0, "assistant", "A0"),
    rec(s, 2, 1, "user", "terminal", { entrypoint: "cli" }), rec(s, 3, 2, "assistant", "terminal reply", { entrypoint: "cli" }),
    rec(s, 4, 3, "user", "T3 turn", { entrypoint: "t3-code" }), rec(s, 5, 4, "assistant", "T3 reply", { entrypoint: "t3-code" }),
    { parentUuid: u(5), type: "system", uuid: u(6), entrypoint: "t3-code", timestamp: new Date(T0 + 6000).toISOString() },
    { type: "last-prompt", leafUuid: u(6), sessionId: s },
  ]));
  const b = await readBranch(p);
  assert.equal(b.leaf, u(6));
  assert.equal(b.addedMessages, 2, "the cli turn (u2, u3) is evidence; the t3-code turn is not");
  assert.equal(b.t3MarkerAfter, true);
});

test("readBranch (R1): only T3's own turns after the baseline -> nothing added", async () => {
  const e = tempHome();
  const p = join(e.dir, `${sid(1)}.jsonl`);
  const s = sid(1);
  const first = jsonl([rec(s, 0, null, "user", "P"), rec(s, 1, 0, "assistant", "A0")]);
  writeFileSync(p, first + jsonl([
    rec(s, 2, 1, "user", "T3 turn", { entrypoint: "t3-code" }), rec(s, 3, 2, "assistant", "T3 reply", { entrypoint: "t3-code" }),
    { type: "last-prompt", leafUuid: u(3), sessionId: s },
  ]));
  const b = await readBranch(p, { importedSize: Buffer.byteLength(first) });
  assert.equal(b.addedMessages, 0);
  assert.equal(b.t3MarkerAfter, true);
});

test("readBranch (R1): entrypoint 'cli' or 'sdk-ts' after the baseline is evidence; a record without entrypoint is not; meta/compact-summary/transcript-only records never count", async () => {
  const e = tempHome();
  const p = join(e.dir, `${sid(1)}.jsonl`);
  const s = sid(1);
  const first = jsonl([rec(s, 0, null, "user", "P", { entrypoint: "cli" }), rec(s, 1, 0, "assistant", "A0", { entrypoint: "cli" })]);
  const write = (after: Rec[]): void => writeFileSync(p, first + jsonl(after));
  const base = { importedSize: Buffer.byteLength(first) };
  write([rec(s, 2, 1, "user", "x", { entrypoint: "sdk-ts" }), rec(s, 3, 2, "assistant", "y", { entrypoint: "sdk-ts" })]);
  assert.equal((await readBranch(p, base)).addedMessages, 2);
  write([rec(s, 2, 1, "user", "x"), rec(s, 3, 2, "assistant", "y")]);
  assert.equal((await readBranch(p, base)).addedMessages, 0, "no entrypoint = no evidence");
  write([
    rec(s, 2, 1, "user", "meta", { entrypoint: "cli", isMeta: true }),
    rec(s, 3, 2, "user", "summary", { entrypoint: "cli", isCompactSummary: true }),
    rec(s, 4, 3, "user", "only in transcript", { entrypoint: "cli", isVisibleInTranscriptOnly: true }),
  ]);
  assert.equal((await readBranch(p, base)).addedMessages, 0);
});

test("readBranch: the newest RESOLVABLE last-prompt wins over a newer unresolvable one", async () => {
  const e = tempHome();
  const s = sid(1);
  const p = join(e.dir, `${s}.jsonl`);
  writeFileSync(p, jsonl([...forked(s), { type: "last-prompt", leafUuid: u(4) }, { type: "last-prompt", leafUuid: u(99) }]));
  const b = await readBranch(p);
  assert.equal(b.leaf, u(4));
  assert.equal(b.leafSource, "last-prompt");
});

test("readBranch: a chain that cannot be copied whole is flagged, never truncated (broken parent, cycle, corrupt line, compaction)", async () => {
  const e = tempHome();
  const s = sid(1);
  const p = join(e.dir, `${s}.jsonl`);
  writeFileSync(p, jsonl([rec(s, 1, 0, "user", "orphan root: parent u0 is not in the file"), rec(s, 2, 1, "assistant", "r")]));
  assert.equal((await readBranch(p)).problem, "broken-chain");
  writeFileSync(p, jsonl([rec(s, 0, 2, "user", "P"), rec(s, 1, 0, "assistant", "A1"), rec(s, 2, 1, "user", "U2")]));
  assert.equal((await readBranch(p)).problem, "broken-chain", "cycle");
  writeFileSync(p, jsonl([rec(s, 0, null, "user", "P"), rec(s, 1, 0, "assistant", "A1")]) + "{\"broken\n" + jsonl([rec(s, 2, 1, "user", "U2"), rec(s, 3, 2, "assistant", "A3")]));
  const c = await readBranch(p);
  assert.equal(c.problem, "corrupt-lines");
  assert.equal(c.corruptLines, 1);
  writeFileSync(p, jsonl([rec(s, 0, null, "user", "P"), rec(s, 1, 0, "assistant", "A1")]) + "{\"broken\n");
  assert.equal((await readBranch(p)).problem, "unsettled", "a torn line after the chain: being written, skip this run");
  writeFileSync(p, jsonl([
    rec(s, 0, null, "user", "P"), rec(s, 1, 0, "assistant", "A1"),
    { parentUuid: null, logicalParentUuid: u(1), isSidechain: false, type: "system", subtype: "compact_boundary", content: "Conversation compacted", uuid: u(10), timestamp: new Date(T0 + 10_000).toISOString(), cwd: ROOT, sessionId: s, entrypoint: "cli" },
    rec(s, 11, 10, "user", "summary", { isCompactSummary: true, isVisibleInTranscriptOnly: true, entrypoint: "cli" }),
  ]));
  const k = await readBranch(p);
  assert.equal(k.problem, "compacted");
  assert.equal(k.addedMessages, 0);
});

test("readBranch: only records past the baseline (the imported size) count", async () => {
  const e = tempHome();
  const p = join(e.dir, `${sid(1)}.jsonl`);
  const s = sid(1);
  const first = jsonl([rec(s, 0, null, "user", "P"), rec(s, 1, 0, "assistant", "A0")]);
  writeFileSync(p, first + jsonl([rec(s, 2, 1, "user", "more", { entrypoint: "cli" }), rec(s, 3, 2, "assistant", "more reply", { entrypoint: "cli" }), { type: "last-prompt", leafUuid: u(3) }]));
  assert.equal((await readBranch(p, { importedSize: Buffer.byteLength(first) })).addedMessages, 2);
  assert.equal((await readBranch(p, { importedSize: statSync(p).size })).addedMessages, 0);
});

// ---------- prepareRevision ----------

test("prepareRevision: provenance root + the branch root->leaf; only sessionId rewritten; root linked to the provenance; no last-prompt or uuid-less records; deterministic", async () => {
  const e = tempHome();
  const s = sid(1);
  const p = join(e.dir, `${s}.jsonl`);
  const recs = [
    { type: "custom-title", customTitle: "Mine", sessionId: s },
    rec(s, 0, null, "user", "P", { version: "2.1.322", gitBranch: "main" }), rec(s, 1, 0, "assistant", "A1 ação 🍞"),
    { type: "file-history-snapshot", messageId: "m", snapshot: {} },
    rec(s, 2, 1, "user", "side"), rec(s, 3, 2, "assistant", "side reply"),
    rec(s, 4, 1, "user", "main", { entrypoint: "cli" }), rec(s, 5, 4, "assistant", "main reply", { entrypoint: "cli" }),
    { type: "last-prompt", leafUuid: u(5), sessionId: s },
  ];
  writeFileSync(p, jsonl(recs));
  const rev = revisionUuid(s, statSync(p).size);
  const at = new Date(Date.UTC(2026, 10, 11, 12, 0, 0));
  const b = await readBranch(p);
  const r1 = await prepareRevision(p, b, { nativeId: s, revisionUuid: rev, at, cwd: ROOT });
  const r2 = await prepareRevision(p, b, { nativeId: s, revisionUuid: rev, at, cwd: ROOT });
  try {
    assert.equal(r1.sha256, r2.sha256, "byte-identical for the same input");
    assert.equal(sha(r1.tmp), r1.sha256);
    const out = parse(r1.tmp);
    assert.equal(out.length, 1 + 4);
    const prov = out[0]!;
    assert.equal(prov.type, "user");
    assert.equal(prov.isMeta, true);
    assert.equal(prov.parentUuid, null);
    assert.equal(prov.sessionId, rev);
    assert.equal(prov.cwd, ROOT);
    assert.equal((prov.message as Rec).content, `Merged revision of session ${s} on 2026-11-11T12:00:00.000Z by t3code-session-manager.`);
    assert.equal(r1.firstLineBytes, Buffer.byteLength(readFileSync(r1.tmp, "utf8").split("\n")[0]! + "\n"));
    // chain: provenance -> u0 -> u1 -> u4 -> u5, each parent the previous uuid
    assert.deepEqual(out.slice(1).map((x) => x.uuid), [u(0), u(1), u(4), u(5)]);
    for (let i = 1; i < out.length; i++) assert.equal(out[i]!.parentUuid, out[i - 1]!.uuid, `link ${i}`);
    // only sessionId (and the root's parentUuid) differ from the source records
    const src = new Map<unknown, Rec>((recs as Rec[]).filter((x) => typeof x.uuid === "string").map((x) => [x.uuid, x] as const));
    for (const [i, o] of out.slice(1).entries()) {
      const orig = src.get(o.uuid)!;
      assert.deepEqual(Object.keys(o), Object.keys(orig), "key order kept");
      assert.deepEqual(o, { ...orig, sessionId: rev, ...(i === 0 ? { parentUuid: prov.uuid } : {}) });
    }
    assert.ok(!out.some((x) => x.type === "last-prompt" || x.type === "custom-title" || x.type === "file-history-snapshot"));
  } finally {
    rmSync(r1.tmp, { force: true });
    rmSync(r2.tmp, { force: true });
  }
});

test("readBranch + prepareRevision stream a transcript over 32 MiB (a huge record on a side branch, never copied)", { timeout: 120_000 }, async () => {
  const e = tempHome();
  const s = sid(1);
  const p = join(e.dir, `${s}.jsonl`);
  const fd = openSync(p, "w");
  try {
    writeSync(fd, jsonl([rec(s, 0, null, "user", "P"), rec(s, 1, 0, "assistant", "A1")]));
    const big = "x".repeat(1024 * 1024);
    for (let i = 0; i < 34; i++) writeSync(fd, JSON.stringify(rec(s, 100 + i, i === 0 ? 1 : 99 + i, "user", big)) + "\n");
    writeSync(fd, jsonl([rec(s, 2, 1, "user", "main"), rec(s, 3, 2, "assistant", "main reply")]));
  } finally { closeSync(fd); }
  assert.ok(statSync(p).size > 32 * 1024 * 1024);
  const b = await readBranch(p);
  assert.deepEqual(b.chain.map((n) => n.uuid), [u(0), u(1), u(2), u(3)]);
  const r = await prepareRevision(p, b, { nativeId: s, revisionUuid: revisionUuid(s, statSync(p).size), at: new Date(T0), cwd: ROOT });
  try {
    assert.ok(statSync(r.tmp).size < 10_000);
    assert.deepEqual(parse(r.tmp).slice(1).map((x) => x.uuid), [u(0), u(1), u(2), u(3)]);
  } finally { rmSync(r.tmp, { force: true }); }
});

// ---------- mergeSessions against a fake T3 ----------

interface Env { home: string; dir: string; state: string; f: FakeT3; journal: Journal; claudeHome: string }

function env(): Env {
  const t = tempHome();
  const claudeHome = join(t.home, ".claude");
  const f = fakeT3({ instances: [inst("claudeAgent", claudeHome)] });
  f.projects.push({ id: "p1", title: "demo", workspaceRoot: ROOT, defaultModelSelection: null, archived: false, deleted: false } as never);
  // T3's scan sees every transcript of the folder (the revision included, once it exists).
  f.opts.onScan = () => {
    for (const n of readdirSync(t.dir)) {
      const p = join(t.dir, n);
      if (n.endsWith(".jsonl") && !f.files.some((x) => x.path === p)) f.files.push({ path: p, root: ROOT });
    }
  };
  const api = f.api as unknown as Record<string, unknown>;
  api.archiveThread = async (id: string) => { f.calls.push(`archive:${id}`); const th = f.threads.get(id); if (th) th.archived = true; };
  api.unarchiveThread = async (id: string) => { f.calls.push(`unarchive:${id}`); const th = f.threads.get(id); if (th) th.archived = false; };
  return { ...t, claudeHome, f, journal: new Journal(join(t.state, "journal.jsonl")) };
}

/**
 * A session imported by t3sm (journal `imported`, thread `import:claudeAgent:<id>` titled "My title"), then continued
 * in a terminal: `after` appended, mtime `mtimeAgo` ago.
 */
async function seeded(e: Env, s: string, o: { after?: Rec[]; before?: Rec[]; mtimeAgo?: number; journal?: boolean } = {}): Promise<{ path: string; item: PlanItem }> {
  const path = join(e.dir, `${s}.jsonl`);
  writeFileSync(path, jsonl(o.before ?? [rec(s, 0, null, "user", "P"), rec(s, 1, 0, "assistant", "A1")]));
  const importedMtime = Date.now() - 3 * DAY;
  utimesSync(path, importedMtime / 1000, importedMtime / 1000);
  const threadId = `import:claudeAgent:${s}`;
  if (o.journal !== false) {
    await e.journal.append({ t: "imported", runId: "20261101-100000-aaaa", harness: "claude", nativeId: s, threadId, source: { path, size: statSync(path).size, mtimeMs: importedMtime } });
  }
  e.f.threads.set(threadId, { id: threadId, projectId: "p1", instanceId: "claudeAgent", archived: false, title: "My title", updatedAt: importedMtime });
  e.f.files.push({ path, root: ROOT, threadId });
  appendFileSync(path, jsonl(o.after ?? [
    rec(s, 2, 1, "user", "terminal turn", { entrypoint: "cli" }), rec(s, 3, 2, "assistant", "terminal reply", { entrypoint: "cli" }),
    { type: "last-prompt", leafUuid: u(3), sessionId: s },
  ]));
  const m = Date.now() - (o.mtimeAgo ?? DAY);
  utimesSync(path, m / 1000, m / 1000);
  const st = statSync(path);
  const session = sess({ cwd: ROOT, nativeId: s, path, size: st.size, mtimeMs: st.mtimeMs });
  return { path, item: { session, action: { kind: "skip", reason: "already-in-t3" }, notes: ["continued-outside-t3"] } };
}

function deps(e: Env, over: Partial<MergeDeps> = {}): MergeDeps {
  return { api: e.f.api, journal: e.journal, runId: "20261111-120000-merg", now: Date.now, onProgress: () => {}, ...over };
}


/** find + execute in one call (what `t3sm merge --all` does). */
async function mergeSessions(items: PlanItem[], deps: MergeDeps): Promise<MergeResult> {
  const found = await findMergeCandidates(items, deps);
  const r = await executeMerges(found.candidates, deps);
  return { merged: r.merged, skipped: [...found.skipped, ...r.skipped] };
}

const kinds = (es: JournalEntry[]): string[] => es.map((x) => x.t).filter((t) => t !== "mtime-bump" && t !== "mtime-restore" && t !== "import-attempt");

test("mergeSessions: writes the revision, imports it as a new thread, archives the old one; the original is byte-identical", async () => {
  const e = env();
  const s = sid(1);
  const { path, item } = await seeded(e, s);
  const before = { sha: sha(path), mtimeMs: statSync(path).mtimeMs, size: statSync(path).size };
  const rev = revisionUuid(s, before.size);
  const revFile = join(e.dir, `${rev}.jsonl`);

  const r = await mergeSessions([item], deps(e));
  assert.deepEqual(r.skipped, []);
  assert.equal(r.merged.length, 1);
  const m = r.merged[0]!;
  assert.equal(m.revisionUuid, rev);
  assert.equal(m.newThreadId, `import:claudeAgent:${rev}`);
  assert.equal(m.oldThreadId, `import:claudeAgent:${s}`);
  assert.equal(m.oldTitle, "My title");
  assert.equal(m.revisionFile, revFile);
  assert.equal(m.addedMessages, 2);

  assert.equal(e.f.threads.get(`import:claudeAgent:${rev}`)?.archived, false, "new thread active");
  assert.equal(e.f.threads.get(`import:claudeAgent:${s}`)?.archived, true, "old thread archived");
  assert.equal(sha(path), before.sha, "original never modified");
  assert.ok(Math.abs(statSync(path).mtimeMs - before.mtimeMs) <= 2, "original mtime unchanged");
  assert.ok(Math.abs(statSync(revFile).mtimeMs - before.mtimeMs) <= 2, "revision mtime = source mtime");
  const out = parse(revFile);
  assert.deepEqual(out.slice(1).map((x) => x.uuid), [u(0), u(1), u(2), u(3)]);
  assert.ok(out.every((x) => x.sessionId === rev));

  const es = await e.journal.readAll();
  const mine = es.filter((x) => x.runId === "20261111-120000-merg");
  assert.deepEqual(kinds(mine), ["file-written", "imported", "thread-archived", "merged"]);
  const fw = mine[0] as Extract<JournalEntry, { t: "file-written" }>;
  assert.equal(fw.path, revFile);
  assert.equal(fw.sha256, sha(revFile));
  const merged = mine.at(-1) as Extract<JournalEntry, { t: "merged" }>;
  assert.deepEqual(merged, { t: "merged", runId: "20261111-120000-merg", harness: "claude", nativeId: s, revisionUuid: rev, revisionFile: revFile, oldThreadId: `import:claudeAgent:${s}`, newThreadId: `import:claudeAgent:${rev}`, sourceSize: before.size, sourceMtimeMs: before.mtimeMs });
  assert.ok(e.f.calls.indexOf(`archive:import:claudeAgent:${s}`) > e.f.calls.lastIndexOf("scan"), "archived only after the import");
});

test("mergeSessions: a second run on the same unchanged session -> already-merged, nothing written", async () => {
  const e = env();
  const { item } = await seeded(e, sid(1));
  await mergeSessions([item], deps(e));
  const n = (await e.journal.readAll()).length;
  const calls = e.f.calls.length;
  const r = await mergeSessions([item], deps(e, { runId: "20261111-130000-merg" }));
  assert.deepEqual(r.skipped, [{ nativeId: sid(1), reason: "already-merged" }]);
  assert.equal((await e.journal.readAll()).length, n);
  assert.ok(!e.f.calls.slice(calls).some((c) => c.startsWith("archive") || c === "scan"));
});

test("mergeSessions: only T3's own turns since the import -> not-continued, nothing written", async () => {
  const e = env();
  const s = sid(1);
  const { item } = await seeded(e, s, {
    after: [
      rec(s, 2, 1, "user", "T3", { entrypoint: "t3-code" }), rec(s, 3, 2, "assistant", "T3 reply", { entrypoint: "t3-code" }),
      { type: "last-prompt", leafUuid: u(3), sessionId: s },
    ],
  });
  const r = await mergeSessions([item], deps(e));
  assert.deepEqual(r, { merged: [], skipped: [{ nativeId: s, reason: "not-continued" }] });
  assert.equal(readdirSync(e.dir).length, 1);
  assert.equal((await e.journal.readAll()).length, 1, "only the seed entry");
});

test("mergeSessions: a session written in the last 10 minutes -> active, nothing written", async () => {
  const e = env();
  const { item } = await seeded(e, sid(1), { mtimeAgo: 60_000 });
  const r = await mergeSessions([item], deps(e));
  assert.deepEqual(r.skipped, [{ nativeId: sid(1), reason: "active" }]);
  assert.equal(readdirSync(e.dir).length, 1);
});

test("mergeSessions: a file t3sm did not write at the revision path -> target-exists, left untouched", async () => {
  const e = env();
  const { item } = await seeded(e, sid(1));
  const foreign = join(e.dir, `${revisionUuid(sid(1), item.session.file.size)}.jsonl`);
  writeFileSync(foreign, "not ours\n");
  const r = await mergeSessions([item], deps(e));
  assert.deepEqual(r.skipped, [{ nativeId: sid(1), reason: "target-exists" }]);
  assert.equal(readFileSync(foreign, "utf8"), "not ours\n");
});

test("mergeSessions: the import fails -> the revision is deleted, the old thread stays active, only the failure is journaled", async () => {
  const e = env();
  const s = sid(1);
  const { item } = await seeded(e, s);
  const rev = revisionUuid(s, item.session.file.size);
  e.f.opts.never = new Set([`import:claudeAgent:${rev}`]);
  const r = await mergeSessions([item], deps(e));
  assert.deepEqual(r.merged, []);
  assert.deepEqual(r.skipped, [{ nativeId: s, reason: "import-failed" }]);
  assert.ok(!existsSync(join(e.dir, `${rev}.jsonl`)), "revision deleted");
  assert.equal(e.f.threads.get(`import:claudeAgent:${s}`)?.archived, false);
  assert.ok(!e.f.calls.some((c) => c.startsWith("archive")));
  const es = await e.journal.readAll();
  assert.ok(es.some((x) => x.t === "import-failed"));
  assert.ok(!es.some((x) => x.t === "merged" || x.t === "thread-archived"));
});

test("mergeSessions: another transcript of the project in use -> deferred project-in-use, revision deleted, old thread untouched", async () => {
  const e = env();
  const s = sid(1);
  const { item } = await seeded(e, s);
  const busy = join(e.dir, `${sid(9)}.jsonl`);
  writeFileSync(busy, jsonl([rec(sid(9), 0, null, "user", "busy")])); // mtime now: being written
  const r = await mergeSessions([item], deps(e));
  assert.deepEqual(r.skipped, [{ nativeId: s, reason: "project-in-use" }]);
  assert.ok(!existsSync(join(e.dir, `${revisionUuid(s, item.session.file.size)}.jsonl`)));
  assert.equal(e.f.threads.get(`import:claudeAgent:${s}`)?.archived, false);
});

test("mergeSessions: a session t3sm did not import (no journal entry, no baseline) is never a candidate", async () => {
  const e = env();
  const a = sid(1);
  const x = await seeded(e, a, { journal: false });
  const r = await mergeSessions([{ ...x.item, notes: [] }], deps(e));
  assert.deepEqual(r, { merged: [], skipped: [{ nativeId: a, reason: "not-continued" }] });
});

test("mergeSessions (R1): 'sdk-ts' turns are evidence; missing entrypoints are not; T3 wrote without its marker -> no-t3-marker", async () => {
  const e = env();
  const a = sid(1), b = sid(2), c = sid(3);
  const turn = (s: string, extra: Rec): Rec[] => [rec(s, 2, 1, "user", "turn", extra), rec(s, 3, 2, "assistant", "reply", extra), { type: "last-prompt", leafUuid: u(3), sessionId: s }];
  const sdk = await seeded(e, a, { after: turn(a, { entrypoint: "sdk-ts" }) });
  const none = await seeded(e, b, { after: turn(b, {}) });
  const marker = await seeded(e, c, { after: turn(c, { entrypoint: "sdk-ts" }) });
  // T3 evidently wrote to c after the import (a user message newer than the imported file), yet nothing says t3-code.
  (e.f.threads.get(`import:claudeAgent:${c}`) as unknown as Rec).latestUserMessageAt = new Date(Date.now() - 2 * DAY).toISOString();
  const r = await mergeSessions([sdk.item, none.item, marker.item], deps(e));
  assert.deepEqual(r.merged.map((m) => m.nativeId), [a]);
  assert.deepEqual(r.skipped.sort((x, y) => (x.nativeId < y.nativeId ? -1 : 1)), [{ nativeId: b, reason: "not-continued" }, { nativeId: c, reason: "no-t3-marker" }]);
});

test("mergeSessions: corrupt lines in the chain and compactions are skipped with their reason; nothing is written", async () => {
  const e = env();
  const a = sid(1), b = sid(2);
  const corrupt = await seeded(e, a, { after: [rec(a, 2, 1, "user", "t", { entrypoint: "cli" })] });
  appendFileSync(corrupt.path, "{\"half a record\n" + jsonl([rec(a, 3, 2, "assistant", "r", { entrypoint: "cli" })]));
  const m = Date.now() - DAY;
  utimesSync(corrupt.path, m / 1000, m / 1000);
  const cst = statSync(corrupt.path);
  const compact = await seeded(e, b, {
    after: [
      { parentUuid: null, logicalParentUuid: u(1), isSidechain: false, type: "system", subtype: "compact_boundary", content: "Conversation compacted", uuid: u(10), timestamp: new Date(T0 + 10_000).toISOString(), cwd: ROOT, sessionId: b, entrypoint: "cli" },
      rec(b, 11, 10, "user", "summary", { isCompactSummary: true, isVisibleInTranscriptOnly: true, entrypoint: "cli" }),
      rec(b, 12, 11, "user", "after compact", { entrypoint: "cli" }), rec(b, 13, 12, "assistant", "r", { entrypoint: "cli" }),
    ],
  });
  const items = [{ ...corrupt.item, session: { ...corrupt.item.session, file: { ...corrupt.item.session.file, size: cst.size, mtimeMs: cst.mtimeMs } } }, compact.item];
  const r = await mergeSessions(items, deps(e));
  assert.deepEqual(r.merged, []);
  assert.deepEqual(r.skipped.sort((x, y) => (x.nativeId < y.nativeId ? -1 : 1)), [{ nativeId: a, reason: "corrupt-lines" }, { nativeId: b, reason: "compacted" }]);
  assert.equal(readdirSync(e.dir).filter((n) => n.endsWith(".jsonl")).length, 2);
});

test("mergeSessions: an archived thread (not merged) -> thread-archived", async () => {
  const e = env();
  const { item } = await seeded(e, sid(1));
  e.f.threads.get(`import:claudeAgent:${sid(1)}`)!.archived = true;
  assert.deepEqual((await mergeSessions([item], deps(e))).skipped, [{ nativeId: sid(1), reason: "thread-archived" }]);
});

test("merge -> rollback -> merge again at the same size: exactly one active thread (the revision), same bytes", async () => {
  const e = env();
  const s = sid(1);
  const { item } = await seeded(e, s);
  const rev = revisionUuid(s, item.session.file.size);
  const revFile = join(e.dir, `${rev}.jsonl`);
  await mergeSessions([item], deps(e, { runId: "20261111-120000-mer1" }));
  const bytes = readFileSync(revFile);
  const rb = await rollbackRun("20261111-120000-mer1", { journal: e.journal, accountHomes: [e.claudeHome], connect: async () => e.f.api });
  assert.deepEqual(rb.errors, []);
  assert.ok(!existsSync(revFile));
  assert.equal(e.f.threads.get(`import:claudeAgent:${rev}`)?.archived, true);
  assert.equal(e.f.threads.get(`import:claudeAgent:${s}`)?.archived, false);

  const r2 = await mergeSessions([item], deps(e, { runId: "20261111-130000-mer2" }));
  assert.equal(r2.merged.length, 1, JSON.stringify(r2));
  assert.deepEqual(readFileSync(revFile), bytes, "deterministic: the provenance date is the source's mtime");
  const active = [...e.f.threads.values()].filter((t) => !t.archived).map((t) => t.id);
  assert.deepEqual(active, [`import:claudeAgent:${rev}`]);
  const es = (await e.journal.readAll()).filter((x) => x.runId === "20261111-130000-mer2");
  assert.ok(es.findIndex((x) => x.t === "thread-unarchived") < es.findIndex((x) => x.t === "thread-archived"), "revision unarchived before the old thread is archived");
});

test("mergeSessions: the provenance text carries the source's mtime and the file-written entry names the session", async () => {
  const e = env();
  const s = sid(1);
  const { item } = await seeded(e, s);
  const r = await mergeSessions([item], deps(e));
  const first = parse(r.merged[0]!.revisionFile)[0]!;
  assert.equal((first.message as Rec).content, `Merged revision of session ${s} on ${new Date(item.session.file.mtimeMs).toISOString()} by t3code-session-manager.`);
  const fw = (await e.journal.readAll()).find((x) => x.t === "file-written") as Extract<JournalEntry, { t: "file-written" }>;
  assert.deepEqual(fw.revisionOf, { harness: "claude", nativeId: s });
});

test("mergeSessions: a revision written before a crash (journaled, published, not imported) is reused, not rewritten", async () => {
  const e = env();
  const s = sid(1);
  const { item } = await seeded(e, s);
  const rev = revisionUuid(s, item.session.file.size);
  const revFile = join(e.dir, `${rev}.jsonl`);
  const prep = await prepareRevision(item.session.file.path, await readBranch(item.session.file.path), { nativeId: s, revisionUuid: rev, at: new Date(item.session.file.mtimeMs), cwd: ROOT });
  await e.journal.append({ t: "file-written", runId: "20261111-110000-cras", path: revFile, sha256: prep.sha256, mtimeMs: item.session.file.mtimeMs, revisionOf: { harness: "claude", nativeId: s } });
  writeFileSync(revFile, readFileSync(prep.tmp));
  rmSync(prep.tmp);
  utimesSync(revFile, item.session.file.mtimeMs / 1000, item.session.file.mtimeMs / 1000);
  const r = await mergeSessions([item], deps(e));
  assert.equal(r.merged.length, 1, JSON.stringify(r));
  assert.equal(sha(revFile), prep.sha256);
  const mine = (await e.journal.readAll()).filter((x) => x.runId === "20261111-120000-merg");
  assert.deepEqual(kinds(mine), ["imported", "thread-archived", "merged"], "no second file-written");
});

test("mergeSessions: a reused revision that aged past now - 20 days while unmerged is re-clamped before its import (never left in Claude Code's cleanup zone)", async () => {
  const e = env();
  const s = sid(1);
  const { item } = await seeded(e, s);
  const rev = revisionUuid(s, item.session.file.size);
  const revFile = join(e.dir, `${rev}.jsonl`);
  const prep = await prepareRevision(item.session.file.path, await readBranch(item.session.file.path), { nativeId: s, revisionUuid: rev, at: new Date(item.session.file.mtimeMs), cwd: ROOT });
  await e.journal.append({ t: "file-written", runId: "20261111-110000-cras", path: revFile, sha256: prep.sha256, mtimeMs: item.session.file.mtimeMs, revisionOf: { harness: "claude", nativeId: s } });
  writeFileSync(revFile, readFileSync(prep.tmp));
  rmSync(prep.tmp);
  const aged = (Date.now() - 25 * DAY) / 1000;
  utimesSync(revFile, aged, aged);
  // The import fails (T3 never takes it): the revision stays unmerged, at whatever time the waves restore.
  const r = await mergeSessions([item], deps(e, { api: { ...e.f.api, importSessions: async () => ({ importedCount: 0, skippedCount: 0 }) } as never }));
  assert.equal(r.merged.length, 0, JSON.stringify(r));
  if (existsSync(revFile)) assert.ok(statSync(revFile).mtimeMs >= Date.now() - 20 * DAY - 60_000, "re-clamped, then restored to the re-clamped time");
  const bump = (await e.journal.readAll()).find((x) => x.t === "mtime-bump") as Extract<JournalEntry, { t: "mtime-bump" }> | undefined;
  const f = bump?.files.find((x) => x.path === revFile);
  assert.ok(f && f.mtimeMs >= Date.now() - 20 * DAY - 60_000, "its pre-bump time (the one restored) is inside the 20 days");
});

test("mergeSessions: archive-failed keeps the imported revision; the next run reuses it and finishes the swap; a revision continued since -> revision-in-use", async () => {
  const e = env();
  const s = sid(1);
  const { item } = await seeded(e, s);
  const api = e.f.api as unknown as Record<string, unknown>;
  const archive = api.archiveThread as (id: string) => Promise<void>;
  api.archiveThread = async () => { throw new Error("T3 refused"); };
  const r1 = await mergeSessions([item], deps(e, { runId: "20261111-120000-mer1" }));
  assert.deepEqual(r1.skipped, [{ nativeId: s, reason: "archive-failed" }]);
  const rev = revisionUuid(s, item.session.file.size);
  assert.ok(existsSync(join(e.dir, `${rev}.jsonl`)));
  assert.equal(e.f.threads.get(`import:claudeAgent:${rev}`)?.archived, false);

  api.archiveThread = archive;
  const r2 = await mergeSessions([item], deps(e, { runId: "20261111-130000-mer2" }));
  assert.equal(r2.merged.length, 1, JSON.stringify(r2));
  assert.equal(e.f.threads.get(`import:claudeAgent:${s}`)?.archived, true);

  // Same situation, but the revision was resumed in the meantime: never touched, reported.
  const e2 = env();
  const x = await seeded(e2, s);
  const api2 = e2.f.api as unknown as Record<string, unknown>;
  api2.archiveThread = async () => { throw new Error("T3 refused"); };
  await mergeSessions([x.item], deps(e2, { runId: "20261111-120000-mer1" }));
  appendFileSync(join(e2.dir, `${rev}.jsonl`), jsonl([rec(rev, 50, 3, "user", "continued in the revision", { entrypoint: "t3-code" })]));
  const r3 = await mergeSessions([x.item], deps(e2, { runId: "20261111-130000-mer2" }));
  assert.deepEqual(r3.skipped, [{ nativeId: s, reason: "revision-in-use" }]);
});

test("mergeSessions: a merge of a merge (the revision continued in a terminal) archives the first revision thread", async () => {
  const e = env();
  const s = sid(1);
  const { item } = await seeded(e, s);
  const r1 = await mergeSessions([item], deps(e, { runId: "20261111-120000-mer1" }));
  const rev = r1.merged[0]!.revisionUuid;
  const revFile = r1.merged[0]!.revisionFile;
  appendFileSync(revFile, jsonl([rec(rev, 20, 3, "user", "again in the terminal", { entrypoint: "cli" }), rec(rev, 21, 20, "assistant", "ok", { entrypoint: "cli" })]));
  const m = Date.now() - DAY / 2;
  utimesSync(revFile, m / 1000, m / 1000);
  const st = statSync(revFile);
  const revItem: PlanItem = { session: sess({ cwd: ROOT, nativeId: rev, path: revFile, size: st.size, mtimeMs: st.mtimeMs }), action: { kind: "skip", reason: "already-in-t3" }, notes: ["continued-outside-t3"] };
  const r2 = await mergeSessions([revItem], deps(e, { runId: "20261111-130000-mer2" }));
  assert.equal(r2.merged.length, 1, JSON.stringify(r2));
  assert.equal(r2.merged[0]!.addedMessages, 2);
  const rev2 = revisionUuid(rev, st.size);
  assert.equal(e.f.threads.get(`import:claudeAgent:${rev}`)?.archived, true);
  assert.equal(e.f.threads.get(`import:claudeAgent:${rev2}`)?.archived, false);
  assert.deepEqual(parse(join(e.dir, `${rev2}.jsonl`)).slice(1).map((x) => x.uuid), [uuidOfProvenance(rev), u(0), u(1), u(2), u(3), u(20), u(21)]);
});

test("mergeSessions: an earlier revision that was never merged and is still ours is removed; the planner never imports one on its own", async () => {
  const e = env();
  const s = sid(1);
  const { path, item } = await seeded(e, s);
  const rev1 = revisionUuid(s, item.session.file.size);
  const rev1File = join(e.dir, `${rev1}.jsonl`);
  const prep = await prepareRevision(path, await readBranch(path), { nativeId: s, revisionUuid: rev1, at: new Date(item.session.file.mtimeMs), cwd: ROOT });
  const stale: JournalEntry = { t: "file-written", runId: "20261111-110000-cras", path: rev1File, sha256: prep.sha256, revisionOf: { harness: "claude", nativeId: s } };
  await e.journal.append(stale);
  writeFileSync(rev1File, readFileSync(prep.tmp));
  rmSync(prep.tmp);

  const plan = await buildPlan({
    sessions: [sess({ cwd: ROOT, nativeId: rev1, path: rev1File })], config: cfg(), journal: [stale], now: NOW, runId: "r", home: HOME, platform: "win32", existsDir: async () => true,
    t3: { version: "v", projects: [], threads: [], providers: [], instances: [{ id: "claudeAgent", driver: "claudeAgent", displayName: "C", accentColor: null, homePath: `${HOME}/.claude`, environment: [] }] },
  });
  assert.deepEqual(plan.items[0]!.action, { kind: "skip", reason: "revision" });

  // The session grows again: its new revision replaces the stale one.
  appendFileSync(path, jsonl([rec(s, 4, 3, "user", "one more", { entrypoint: "cli" })]));
  const m = Date.now() - DAY / 2;
  utimesSync(path, m / 1000, m / 1000);
  const st = statSync(path);
  const grown = { ...item, session: { ...item.session, file: { ...item.session.file, size: st.size, mtimeMs: st.mtimeMs } } };
  const r = await mergeSessions([grown], deps(e));
  assert.equal(r.merged.length, 1, JSON.stringify(r));
  assert.ok(!existsSync(rev1File), "the stale, never-merged revision is gone");
});

test("sweepStaleTemps: removes revision temp files of dead t3sm processes only", async () => {
  const e = tempHome();
  const rev = revisionUuid(sid(1), 1);
  const dead = join(e.dir, `.${rev}.424242.abcdefabcdef.tmp`);
  const live = join(e.dir, `.${rev}.${process.pid}.abcdefabcdef.tmp`);
  const other = join(e.dir, "notes.tmp");
  for (const f of [dead, live, other]) writeFileSync(f, "x");
  assert.deepEqual(await sweepStaleTemps(e.dir, (pid) => pid === process.pid), [dead]);
  assert.ok(!existsSync(dead) && existsSync(live) && existsSync(other));
});

test("sync with autoMerge true: an exception during a merge counts as merge-failed; the cycle's result is unaffected; its run ends partial", async () => {
  const e = env();
  await saveCfg(e, { autoMerge: true });
  (e.f.projects[0] as { defaultModelSelection: unknown }).defaultModelSelection = { instanceId: "claudeAgent", model: "m" };
  const idle = await seeded(e, sid(1));
  (e.f.api as unknown as Record<string, unknown>).scanSessions = async () => { throw new Error("T3 hiccup"); };
  const o = await runSyncCycle(syncDeps(e, [idle.item]));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  if (o.kind !== "ok") return;
  assert.equal(o.counts.mergeFailed, 1);
  assert.equal(o.counts.merged, 0);
  assert.match(logLine(o, Date.now()), / merge-failed=1/);
  const es = await e.journal.readAll();
  assert.ok(es.some((x) => x.t === "run-end" && x.runId === o.runId && x.status === "partial"));
  assert.equal(e.f.threads.get(`import:claudeAgent:${sid(1)}`)?.archived, false);
});

test("sync with autoMerge true: a compacted session is skipped, never merged", async () => {
  const e = env();
  await saveCfg(e, { autoMerge: true });
  const b = sid(1);
  const compact = await seeded(e, b, {
    after: [
      { parentUuid: null, logicalParentUuid: u(1), isSidechain: false, type: "system", subtype: "compact_boundary", uuid: u(10), timestamp: new Date(T0 + 10_000).toISOString(), cwd: ROOT, sessionId: b, entrypoint: "cli" },
      rec(b, 12, 10, "user", "after compact", { entrypoint: "cli" }), rec(b, 13, 12, "assistant", "r", { entrypoint: "cli" }),
    ],
  });
  const o = await runSyncCycle(syncDeps(e, [compact.item]));
  assert.ok(o.kind === "ok" || o.kind === "noop", JSON.stringify(o));
  if (o.kind !== "ok" && o.kind !== "noop") return;
  assert.equal(o.counts.merged ?? 0, 0);
  assert.equal(e.f.threads.get(`import:claudeAgent:${b}`)?.archived, false);
});

test("mergeSessions: limit merges at most N and reports the rest as deferred (over-cap)", async () => {
  const e = env();
  const items = [];
  for (let i = 1; i <= 3; i++) items.push((await seeded(e, sid(i), { mtimeAgo: DAY + i * 60_000 })).item);
  const r = await mergeSessions(items, deps(e, { limit: 2 }));
  assert.equal(r.merged.length, 2);
  assert.deepEqual(r.skipped.map((x) => x.reason), ["over-cap"]);
});

test("buildPlan: a session merged at its current size is no longer continued-outside-t3; growing again brings the note back", async () => {
  const s = sess({ size: 2000 });
  const t = `import:claudeAgent:${s.nativeId}`;
  const imported: JournalEntry = { t: "imported", runId: "r0", harness: "claude", nativeId: s.nativeId, threadId: t, source: { path: s.file.path, size: 1000, mtimeMs: s.file.mtimeMs - DAY } };
  const merged: JournalEntry = { t: "merged", runId: "r1", harness: "claude", nativeId: s.nativeId, revisionUuid: revisionUuid(s.nativeId, 2000), revisionFile: "x", oldThreadId: t, newThreadId: "n" };
  const plan = (journal: JournalEntry[], session = s) => buildPlan({
    sessions: [session], config: cfg(), journal, now: NOW, runId: "r", home: HOME, platform: "win32", existsDir: async () => true,
    t3: { version: "v", projects: [], threads: [{ id: t, projectId: "p1", instanceId: "claudeAgent", archived: true, title: "t" }], providers: [],
      instances: [{ id: "claudeAgent", driver: "claudeAgent", displayName: "C", accentColor: null, homePath: `${HOME}/.claude`, environment: [] }] },
  });
  assert.deepEqual((await plan([imported])).items[0]!.notes, ["continued-outside-t3"]);
  assert.deepEqual((await plan([imported, merged])).items[0]!.notes, []);
  assert.deepEqual((await plan([imported, merged], { ...s, file: { ...s.file, size: 2500 } })).items[0]!.notes, ["continued-outside-t3"]);
});

// ---------- sync autoMerge ----------

function adapterOf(items: PlanItem[]): SourceAdapter {
  return { id: "claude", mode: "native", isAvailable: async () => true, async *discover() { for (const i of items) yield i.session; } };
}

function syncDeps(e: Env, items: PlanItem[], over: Partial<SyncCycleDeps> = {}): SyncCycleDeps {
  const api = { ...e.f.api, getConfig: async () => ({ settings: { providerInstances: { claudeAgent: { driver: "claudeAgent", config: { homePath: e.claudeHome } } } }, providers: [] }) } as T3Api;
  return {
    home: e.home, stateDir: e.state, env: { T3SM_HOME: e.state }, now: Date.now,
    adapters: [adapterOf(items)], existsDir: async () => true, isT3Running: async () => true,
    connect: async () => api, signals: { on() {}, off() {} }, ...over,
  };
}

async function saveCfg(e: Env, sync: Partial<{ autoMerge: boolean; maxUnattendedImports: number }>): Promise<void> {
  const c = defaultConfig([{ id: "claudeAgent", home: e.claudeHome, displayName: "Claude", accentColor: null }]);
  await saveConfig(e.state, { ...c, sync: { ...c.sync, ...sync } });
}

test("sync with autoMerge true: merges an inactive continued session in its own sync-merge run, leaves an active one", async () => {
  const e = env();
  await saveCfg(e, { autoMerge: true });
  const idle = await seeded(e, sid(1));
  const busy = await seeded(e, sid(2), { mtimeAgo: 60_000 });
  const o = await runSyncCycle(syncDeps(e, [idle.item, busy.item]));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  if (o.kind !== "ok") return;
  assert.equal(o.counts.merged, 1);
  assert.equal(o.counts.mergeDeferred, 0, "a session in active use is the user's own; not counted as deferred");
  assert.equal(e.f.threads.get(`import:claudeAgent:${sid(1)}`)?.archived, true);
  assert.equal(e.f.threads.get(`import:claudeAgent:${sid(2)}`)?.archived, false);
  assert.match(logLine(o, Date.now()), / merged=1 merge-deferred=0$/);
  const es = await e.journal.readAll();
  const m = es.find((x) => x.t === "merged")!;
  assert.ok(es.some((x) => x.t === "run-start" && x.runId === m.runId && x.command.startsWith("sync-merge ")), "journaled in its own sync-merge run");
  assert.ok(es.some((x) => x.t === "run-end" && x.runId === m.runId));
});

test("sync with autoMerge on a cycle with nothing to import: the merge journals its own sync-merge run", async () => {
  const e = env();
  await saveCfg(e, { autoMerge: true });
  (e.f.projects[0] as { defaultModelSelection: unknown }).defaultModelSelection = { instanceId: "claudeAgent", model: "m" };
  const idle = await seeded(e, sid(1));
  const o = await runSyncCycle(syncDeps(e, [idle.item]));
  assert.equal(o.kind, "ok", JSON.stringify(o));
  if (o.kind !== "ok") return;
  assert.equal(o.counts.merged, 1);
  const es = await e.journal.readAll();
  assert.ok(o.runId);
  assert.deepEqual(es.filter((x) => x.runId === o.runId).map((x) => x.t).filter((t) => t === "run-start" || t === "merged" || t === "run-end"), ["run-start", "merged", "run-end"]);
  assert.match((es.find((x) => x.t === "run-start" && x.runId === o.runId) as { command: string }).command, /^sync-merge /);

  const again = await runSyncCycle(syncDeps(e, [{ ...idle.item, notes: [] }]));
  assert.equal(again.kind, "noop", "merged = no longer continued-outside-t3; nothing written");
});

test("sync with autoMerge off (the default): nothing is merged; the pending count is reported once per change", async () => {
  const e = env();
  const idle = await seeded(e, sid(1)); // no config.json: defaults (autoMerge false)
  const o = await runSyncCycle(syncDeps(e, [idle.item]));
  assert.ok(o.kind === "ok" || o.kind === "noop", JSON.stringify(o)); // ok: sync sets the default-less project's default
  assert.equal(o.counts.merged, 0);
  assert.equal(o.counts.mergePending, 1);
  assert.match(logLine(o, Date.now()), / merge-pending=1$/);
  assert.ok(summaryLines(o).some((l) => /1 session was continued in a terminal; run `t3sm merge`/.test(l)));
  assert.equal((await readMergePending(e.state))?.count, 1, "doctor's merge-pending reads this");
  const again = await runSyncCycle(syncDeps(e, [idle.item]));
  assert.ok(again.kind === "ok" || again.kind === "noop");
  if (again.kind !== "ok" && again.kind !== "noop") return;
  assert.equal(again.counts.mergePending, undefined, "unchanged count: not reported again");
  assert.doesNotMatch(logLine(again, Date.now()), /merge-pending/);
  assert.equal(e.f.threads.get(`import:claudeAgent:${sid(1)}`)?.archived, false);
  assert.ok(!(await e.journal.readAll()).some((x) => x.t === "merged" || x.t === "file-written"));
});

test("sync with autoMerge: at most 20 merges per cycle", { timeout: 120_000 }, async () => {
  const e = env();
  await saveCfg(e, { autoMerge: true });
  const items = [];
  for (let i = 1; i <= 21; i++) items.push((await seeded(e, sid(i), { mtimeAgo: DAY + i * 60_000 })).item);
  const o = await runSyncCycle(syncDeps(e, items));
  assert.ok(o.kind === "ok", JSON.stringify(o));
  assert.equal(o.counts.merged, 20);
  assert.equal(o.counts.mergeDeferred, 1);
});

test("sync with autoMerge: a cycle over the unattended limit merges nothing", async () => {
  const e = env();
  await saveCfg(e, { autoMerge: true, maxUnattendedImports: 1 });
  const idle = await seeded(e, sid(1));
  const fresh = [sid(7), sid(8)].map((x) => {
    const p = join(e.dir, `${x}.jsonl`);
    writeFileSync(p, jsonl([rec(x, 0, null, "user", "new")]));
    const m = Date.now() - 2 * DAY;
    utimesSync(p, m / 1000, m / 1000);
    const st = statSync(p);
    return { session: sess({ cwd: ROOT, nativeId: x, path: p, size: st.size, mtimeMs: st.mtimeMs }), action: { kind: "skip", reason: "excluded" }, notes: [] } as PlanItem;
  });
  const o = await runSyncCycle(syncDeps(e, [idle.item, ...fresh]));
  assert.equal(o.kind, "over-limit");
  assert.equal(e.f.threads.get(`import:claudeAgent:${sid(1)}`)?.archived, false);
  assert.ok(!(await e.journal.readAll()).some((x) => x.t === "merged"));
});

// ---------- t3sm merge ----------

function io(over: Partial<Io> = {}): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: false, prompt: async () => "no", env: {}, out, err, ...over } as Io & { out: string[]; err: string[] };
}

function cmdDeps(e: Env, items: PlanItem[]) {
  const d = syncDeps(e, items);
  return { home: e.home, now: Date.now, connect: d.connect, adapters: d.adapters, existsDir: d.existsDir };
}

test("t3sm merge: without --session or --all it lists the candidates and exits 0 without writing", async () => {
  const e = env();
  const { item } = await seeded(e, sid(1));
  const x = io({ env: { T3SM_HOME: e.state } });
  const code = await mergeCommand([], x, cmdDeps(e, [item]));
  assert.equal(code, 0, x.err.join(""));
  const text = x.out.join("");
  assert.match(text, /11111111/);
  assert.match(text, /--all|--session/);
  assert.equal(readdirSync(e.dir).length, 1);
  assert.ok(!(await e.journal.readAll()).some((j) => j.runId !== "20261101-100000-aaaa"));
});

test("t3sm merge --all: refuses on a non-terminal without --yes (exit 2)", async () => {
  const e = env();
  const { item } = await seeded(e, sid(1));
  const x = io({ env: { T3SM_HOME: e.state } });
  assert.equal(await mergeCommand(["--all"], x, cmdDeps(e, [item])), 2);
  assert.equal(readdirSync(e.dir).length, 1);
});

test("t3sm merge --session <id> --yes: merges it and prints the new thread, the resume hint and the old title", async () => {
  const e = env();
  const { item } = await seeded(e, sid(1));
  const rev = revisionUuid(sid(1), item.session.file.size);
  const x = io({ env: { T3SM_HOME: e.state } });
  const code = await mergeCommand(["--session", sid(1), "--yes"], x, cmdDeps(e, [item]));
  assert.equal(code, 0, x.err.join("") + x.out.join(""));
  const text = x.out.join("");
  assert.match(text, new RegExp(`import:claudeAgent:${rev}`));
  assert.match(text, new RegExp(`claude --resume ${rev}`));
  assert.match(text, /My title/);
  assert.equal(e.f.threads.get(`import:claudeAgent:${sid(1)}`)?.archived, true);
});

// ---------- review round 2 ----------

/** Terminal turn on a side branch, T3's turn on the branch `claude --resume` continues (last-prompt). */
function sideBranch(s: string): Rec[] {
  return [
    rec(s, 2, 1, "user", "terminal turn", { entrypoint: "cli" }), rec(s, 3, 2, "assistant", "terminal reply", { entrypoint: "cli" }),
    rec(s, 4, 1, "user", "T3 turn", { entrypoint: "t3-code" }), rec(s, 5, 4, "assistant", "T3 reply", { entrypoint: "t3-code" }),
    { type: "last-prompt", leafUuid: u(5), sessionId: s },
  ];
}

test("O1: terminal work on a side branch is not merged but surfaced: findMergeCandidates, `t3sm merge`, sync's notice, the pending cache", async () => {
  const e = env();
  const s = sid(1);
  const { item } = await seeded(e, s, { after: sideBranch(s) });
  const f = await findMergeCandidates([item], deps(e, { stateDir: e.state }));
  assert.deepEqual(f.candidates, []);
  assert.deepEqual(f.skipped, [{ nativeId: s, reason: "not-continued" }]);
  assert.deepEqual(f.orphaned, [{ nativeId: s, projectRoot: ROOT, branches: 1 }]);
  assert.equal((await readMergePending(e.state))?.orphaned, 1);

  const x = io({ env: { T3SM_HOME: e.state } });
  assert.equal(await mergeCommand([], x, cmdDeps(e, [item])), 0);
  const text = x.out.join("");
  assert.match(text, /1 session has terminal work on a side branch that T3 Code cannot show/);
  assert.match(text, new RegExp(`claude --resume ${s}`));

  const e2 = env();
  const y = await seeded(e2, s, { after: sideBranch(s) });
  const o = await runSyncCycle(syncDeps(e2, [y.item]));
  assert.ok(o.kind === "ok" || o.kind === "noop", JSON.stringify(o));
  if (o.kind !== "ok" && o.kind !== "noop") return;
  assert.equal(o.counts.mergeOrphaned, 1);
  assert.ok(summaryLines(o).some((l) => /terminal work on a side branch that T3 Code cannot show/.test(l)));
  assert.match(logLine(o, Date.now()), / merge-orphaned=1/);
  assert.equal(e2.f.threads.get(`import:claudeAgent:${s}`)?.archived, false, "never merged automatically");
});

test("O3: a torn last line after the chain -> unsettled, skipped this run", async () => {
  const e = env();
  const s = sid(1);
  const { path, item } = await seeded(e, s);
  appendFileSync(path, '{"type":"assistant","uuid":"half');
  const m = Date.now() - DAY;
  utimesSync(path, m / 1000, m / 1000);
  const st = statSync(path);
  const it = { ...item, session: { ...item.session, file: { ...item.session.file, size: st.size, mtimeMs: st.mtimeMs } } };
  assert.deepEqual((await mergeSessions([it], deps(e))).skipped, [{ nativeId: s, reason: "unsettled" }]);
});

test("N1: a publish that hits a file t3sm did not write journals file-write-aborted; the journal never claims that file", async () => {
  const e = env();
  const s = sid(1);
  const { item } = await seeded(e, s);
  const d = deps(e);
  const f = await findMergeCandidates([item], d);
  assert.equal(f.candidates.length, 1);
  writeFileSync(f.candidates[0]!.revisionFile, "someone else's\n"); // appears between planning and publishing
  const r = await executeMerges(f.candidates, d);
  assert.deepEqual(r.skipped, [{ nativeId: s, reason: "target-exists" }]);
  assert.equal(readFileSync(f.candidates[0]!.revisionFile, "utf8"), "someone else's\n");
  const es = await e.journal.readAll();
  assert.ok(es.some((x) => x.t === "file-write-aborted" && x.path === f.candidates[0]!.revisionFile));
  assert.ok(!effectiveWrites(es).some((w) => w.path === f.candidates[0]!.revisionFile));
});

test("N1: the planner skips an unmerged revision only when T3 has no thread for it (a kept or archive-failed revision stays mergeable)", async () => {
  const REVA = revisionUuid(sid(1), 100), REVB = revisionUuid(sid(2), 200);
  const dir = `${HOME}/.claude/projects/C--work-demo`;
  const fa = `${dir}/${REVA}.jsonl`, fb = `${dir}/${REVB}.jsonl`;
  // The "mixed" run: both merged, then rolled back; B was kept (continued in T3), A was undone.
  const journal: JournalEntry[] = [
    { t: "file-written", runId: "m1", path: fa, sha256: "a".repeat(64), revisionOf: { harness: "claude", nativeId: sid(1) } },
    { t: "merged", runId: "m1", harness: "claude", nativeId: sid(1), revisionUuid: REVA, revisionFile: fa, oldThreadId: `import:claudeAgent:${sid(1)}`, newThreadId: `import:claudeAgent:${REVA}` },
    { t: "file-written", runId: "m1", path: fb, sha256: "b".repeat(64), revisionOf: { harness: "claude", nativeId: sid(2) } },
    { t: "merged", runId: "m1", harness: "claude", nativeId: sid(2), revisionUuid: REVB, revisionFile: fb, oldThreadId: `import:claudeAgent:${sid(2)}`, newThreadId: `import:claudeAgent:${REVB}` },
    { t: "rolled-back", runId: "rb1", targetRunId: "m1", at: "x" },
  ];
  const th = (id: string, archived: boolean) => ({ id, projectId: "p1", instanceId: "claudeAgent", archived, title: "t" });
  const plan = await buildPlan({
    sessions: [sess({ cwd: ROOT, nativeId: REVA, path: fa }), sess({ cwd: ROOT, nativeId: REVB, path: fb })], config: cfg(), journal, now: NOW, runId: "r", home: HOME,
    platform: "win32", existsDir: async () => true,
    t3: { version: "v", projects: [], threads: [th(`import:claudeAgent:${REVB}`, false)], providers: [], instances: [{ id: "claudeAgent", driver: "claudeAgent", displayName: "C", accentColor: null, homePath: `${HOME}/.claude`, environment: [] }] },
  });
  const by = new Map(plan.items.map((i) => [i.session.nativeId, i.action]));
  assert.deepEqual(by.get(REVA), { kind: "skip", reason: "revision" }, "no thread: never imported on its own");
  assert.deepEqual(by.get(REVB), { kind: "skip", reason: "already-in-t3" }, "kept revision with a thread: an ordinary session");
});

test("O4: a stale unmerged revision imported under ANOTHER instance is kept; the reuse path re-checks the source right before importing", async () => {
  const e = env();
  const s = sid(1);
  const { path, item } = await seeded(e, s);
  const rev1 = revisionUuid(s, item.session.file.size);
  const rev1File = join(e.dir, `${rev1}.jsonl`);
  const prep = await prepareRevision(path, await readBranch(path), { nativeId: s, revisionUuid: rev1, at: new Date(item.session.file.mtimeMs), cwd: ROOT });
  await e.journal.append({ t: "file-written", runId: "20261111-110000-cras", path: rev1File, sha256: prep.sha256, revisionOf: { harness: "claude", nativeId: s } });
  writeFileSync(rev1File, readFileSync(prep.tmp));
  rmSync(prep.tmp);
  utimesSync(rev1File, item.session.file.mtimeMs / 1000, item.session.file.mtimeMs / 1000);

  // Reuse path: the source is written to between planning and the import -> active, nothing imported.
  const d = deps(e);
  const f = await findMergeCandidates([item], d);
  assert.ok(f.candidates[0]!.reuse);
  appendFileSync(path, jsonl([rec(s, 9, 3, "user", "typing right now", { entrypoint: "cli" })]));
  assert.deepEqual((await executeMerges(f.candidates, d)).skipped, [{ nativeId: s, reason: "active" }]);
  assert.ok(!e.f.calls.includes("scan"));

  // The session grows; rev1 sits under another instance's thread: never removed.
  e.f.threads.set(`import:claude-org:${rev1}`, { id: `import:claude-org:${rev1}`, projectId: "p1", instanceId: "claude-org", archived: false, title: "t", updatedAt: 0 });
  const m = Date.now() - DAY / 2;
  utimesSync(path, m / 1000, m / 1000);
  const st = statSync(path);
  const grown = { ...item, session: { ...item.session, file: { ...item.session.file, size: st.size, mtimeMs: st.mtimeMs } } };
  const r = await mergeSessions([grown], deps(e, { runId: "20261111-130000-mer2" }));
  assert.equal(r.merged.length, 1, JSON.stringify(r));
  assert.ok(existsSync(rev1File), "held by a thread of another instance");
});

test("B4/B16: a filesystem without hard links never publishes a revision (no check-then-rename fallback): copy-failed, file-write-aborted, no temp left", async () => {
  const e = env();
  const idle = await seeded(e, sid(1));
  const found = await findMergeCandidates([idle.item], deps(e));
  assert.equal(found.candidates.length, 1, JSON.stringify(found.skipped));
  const c = found.candidates[0]!;
  const noLinks = { link: async () => { throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" }); }, unlink: async () => {} };
  const r = await executeMerges(found.candidates, deps(e, { linkFs: noLinks }));
  assert.deepEqual(r.skipped.map((s) => s.reason), ["copy-failed"]);
  assert.ok(!existsSync(c.revisionFile), "nothing at the revision path");
  const es = await e.journal.readAll();
  assert.ok(es.some((x) => x.t === "file-write-aborted" && x.path === c.revisionFile));
  assert.deepEqual(readdirSync(dirname(c.revisionFile)).filter((n) => n.endsWith(".tmp")), [], "temp removed");
});

test("B4: conversions and revisions share one temp-name pattern, and one sweep removes both kinds of leftovers", async () => {
  const { WRITE_TEMP_RE, writeTempPath, sweepWriteTemps } = await import("../../src/core/fsutil.ts");
  const e = tempHome();
  const conv = writeTempPath(e.dir, uuidV5("opencode:ses_x"));
  const rev = writeTempPath(e.dir, revisionUuid(sid(1), 1));
  for (const f of [conv, rev]) assert.match(basename(f), WRITE_TEMP_RE);
  const deadConv = conv.replace(`.${process.pid}.`, ".424242.");
  const deadRev = rev.replace(`.${process.pid}.`, ".424243.");
  for (const f of [deadConv, deadRev, conv]) writeFileSync(f, "x");
  assert.deepEqual((await sweepWriteTemps(e.dir, (pid) => pid === process.pid)).sort(), [deadConv, deadRev].sort());
  assert.ok(existsSync(conv));
});

test("B14: t3sm merge --dry-run (and the plain listing) write nothing, not even the merge cache", async () => {
  const e = env();
  const { item } = await seeded(e, sid(1));
  for (const args of [["--dry-run"], []]) {
    const x = io({ env: { T3SM_HOME: e.state } });
    assert.equal(await mergeCommand(args, x, cmdDeps(e, [item])), 0, x.err.join(""));
    assert.ok(!existsSync(join(e.state, "cache", "merge.json")), `no merge cache after ${args.join(" ") || "a listing"}`);
  }
});

test("B15: unmergedRevisionFiles folds path case on Windows (one revision, whatever the journaled spelling)", async () => {
  const { unmergedRevisionFiles } = await import("../../src/ops/merge.ts");
  const es: JournalEntry[] = [
    { t: "file-written", runId: "m1", path: "C:/H/projects/x/R.jsonl", sha256: "a".repeat(64), revisionOf: { harness: "claude", nativeId: "n" } },
    { t: "merged", runId: "m1", harness: "claude", nativeId: "n", revisionUuid: "r", revisionFile: "c:\\h\\projects\\x\\r.jsonl", oldThreadId: "o", newThreadId: "nw" },
  ];
  assert.deepEqual(unmergedRevisionFiles(es, "win32"), [], "the merge uses it");
  assert.equal(unmergedRevisionFiles(es, "linux").length, 1, "case matters on Linux");
});

test("B16: merge of a merge, then rolling both back newest first: no session is ever left without an active thread", async () => {
  const e = env();
  const s = sid(1);
  const { item } = await seeded(e, s);
  const r1 = await mergeSessions([item], deps(e, { runId: "20261111-120000-mer1" }));
  assert.equal(r1.merged.length, 1, JSON.stringify(r1));
  const rev1 = r1.merged[0]!.revisionUuid;
  const rev1File = r1.merged[0]!.revisionFile;
  // rev1 is continued in a terminal, then merged again (rev2 of rev1).
  appendFileSync(rev1File, jsonl([
    rec(rev1, 4, 3, "user", "more terminal work", { entrypoint: "cli" }), rec(rev1, 5, 4, "assistant", "reply", { entrypoint: "cli" }),
    { type: "last-prompt", leafUuid: u(5), sessionId: rev1 },
  ]));
  const m = Date.now() - DAY / 2;
  utimesSync(rev1File, m / 1000, m / 1000);
  const st = statSync(rev1File);
  e.f.files.push({ path: rev1File, root: ROOT, threadId: `import:claudeAgent:${rev1}` });
  const rev1Item: PlanItem = { session: sess({ cwd: ROOT, nativeId: rev1, path: rev1File, size: st.size, mtimeMs: st.mtimeMs }), action: { kind: "skip", reason: "already-in-t3" }, notes: ["continued-outside-t3"] };
  const r2 = await mergeSessions([rev1Item], deps(e, { runId: "20261111-130000-mer2" }));
  assert.equal(r2.merged.length, 1, JSON.stringify(r2));
  const rev2 = r2.merged[0]!.revisionUuid;
  const active = () => [...e.f.threads.values()].filter((t) => !t.archived).map((t) => t.id).sort();
  assert.deepEqual(active(), [`import:claudeAgent:${rev2}`]);

  const rb2 = await rollbackRun("20261111-130000-mer2", { journal: e.journal, accountHomes: [e.claudeHome], connect: async () => e.f.api });
  assert.deepEqual(rb2.errors, []);
  assert.ok(!existsSync(r2.merged[0]!.revisionFile), "rev2 removed");
  assert.deepEqual(active(), [`import:claudeAgent:${rev1}`], "rev1 is the active thread again");

  // rev1 was continued since t3sm wrote it: the first merge is kept whole, never leaving the session without a thread.
  const rb1 = await rollbackRun("20261111-120000-mer1", { journal: e.journal, accountHomes: [e.claudeHome], connect: async () => e.f.api });
  assert.deepEqual(rb1.mergesKept.map((k) => [k.nativeId, k.reason]), [[s, "revision continued"]]);
  assert.ok(existsSync(rev1File));
  assert.deepEqual(active(), [`import:claudeAgent:${rev1}`]);
});
