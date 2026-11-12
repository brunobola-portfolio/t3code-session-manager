import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeAdapter, scanTranscript } from "../../src/sources/claude.ts";
import { ACTIVE_WINDOW_MS, CWD_SCAN_MAX_BYTES, type Env } from "../../src/sources/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import type { DiscoveredSession } from "../../src/core/types.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "claude");
const NOW = Date.parse("2026-06-01T00:00:00Z");
const OLD = new Date("2026-01-02T00:00:00Z");
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Ctx { dir: string; env: Env; a: string; b: string }

async function setup(): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), "t3sm-claude-"));
  await cp(FIX, dir, { recursive: true });
  const a = join(dir, "home-a");
  const b = join(dir, "home-b");
  const stamp = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await stamp(p);
      else await utimes(p, OLD, OLD);
    }
  };
  await stamp(a);
  await stamp(b);
  const config = defaultConfig([
    { id: "personal", home: a, displayName: "Personal", accentColor: null },
    { id: "org", home: b, displayName: "Org", accentColor: null },
  ]);
  return { dir, a, b, env: { home: dir, platform: process.platform, now: () => NOW, config, stateDir: join(dir, "state") } };
}

async function collect(it: AsyncIterable<DiscoveredSession>): Promise<DiscoveredSession[]> {
  const out: DiscoveredSession[] = [];
  for await (const s of it) out.push(s);
  return out;
}

const find = (all: DiscoveredSession[], id: string, account?: string): DiscoveredSession => {
  const s = all.find((x) => x.nativeId === id && (account === undefined || x.accountId === account));
  assert.ok(s, `session ${id} not found`);
  return s;
};

test("discovers sessions per account, ignores subagent dirs and non-jsonl", async () => {
  const c = await setup();
  try {
    const all = await collect(createClaudeAdapter().discover(c.env));
    assert.equal(all.length, 14);
    assert.ok(all.every((s) => s.harness === "claude"));
    assert.equal(all.filter((s) => s.accountId === "personal").length, 11);
    assert.equal(all.filter((s) => s.accountId === "org").length, 3);
    for (const s of all) assert.ok(s.file.path.startsWith(s.accountId === "personal" ? c.a : c.b));
    assert.ok(!all.some((s) => s.file.path.includes("subagents")));
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("normal session: counts, cwd, timestamps, no flags", async () => {
  const c = await setup();
  try {
    const s = find(await collect(createClaudeAdapter().discover(c.env)), uid(1));
    assert.equal(s.cwd, "C:/work/demo");
    // user, assistant, (tool_result only: excluded), user, assistant
    assert.equal(s.messageCount, 4);
    assert.equal(s.startedAt, "2026-01-01T00:00:01.000Z");
    assert.equal(s.updatedAt, "2026-01-01T00:00:05.000Z");
    assert.equal(s.corruptLines, 0);
    assert.deepEqual(s.flags, []);
    assert.equal(s.file.size > 0, true);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("corrupt middle line is counted but the session is still discovered", async () => {
  const c = await setup();
  try {
    const s = find(await collect(createClaudeAdapter().discover(c.env)), uid(2));
    assert.equal(s.corruptLines, 1);
    assert.equal(s.messageCount, 2);
    assert.deepEqual(s.flags, ["corrupt-lines"]);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("only hidden records -> only-hidden", async () => {
  const c = await setup();
  try {
    const s = find(await collect(createClaudeAdapter().discover(c.env)), uid(3));
    assert.equal(s.messageCount, 0);
    assert.deepEqual(s.flags, ["only-hidden"]);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("non-uuid file name -> non-uuid-id", async () => {
  const c = await setup();
  try {
    const s = find(await collect(createClaudeAdapter().discover(c.env)), "not-a-uuid");
    assert.deepEqual(s.flags, ["non-uuid-id"]);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("sidechain records are excluded from messageCount", async () => {
  const c = await setup();
  try {
    const s = find(await collect(createClaudeAdapter().discover(c.env)), uid(4));
    assert.equal(s.messageCount, 2);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("no cwd anywhere -> no-cwd + cwd-unreadable, offset = size, timestamps fall back to mtime", async () => {
  const c = await setup();
  try {
    const all = await collect(createClaudeAdapter().discover(c.env));
    const s = find(all, uid(5));
    assert.equal(s.cwd, null);
    assert.deepEqual(s.flags, ["no-cwd", "cwd-unreadable"]);
    assert.equal(s.cwdOffsetBytes, s.file.size);
    assert.equal(s.startedAt, OLD.toISOString());
    assert.equal(s.updatedAt, OLD.toISOString());
    const s6 = find(all, uid(6));
    assert.equal(s6.startedAt, "2026-01-01T00:00:01.000Z"); // parsed timestamp wins over mtime
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("backup dirs and .bak-* nested dirs are flagged backup-copy", async () => {
  const c = await setup();
  try {
    const all = await collect(createClaudeAdapter().discover(c.env));
    assert.deepEqual(find(all, uid(8)).flags, ["backup-copy"]);
    assert.deepEqual(find(all, uid(9)).flags, ["backup-copy"]);
    assert.equal(all.filter((s) => s.flags.includes("backup-copy")).length, 2);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("same uuid in case-variant dirs of different accounts: two sessions, same nativeId", async () => {
  const c = await setup();
  try {
    const all = await collect(createClaudeAdapter().discover(c.env));
    const same = all.filter((s) => s.nativeId === uid(7) && !s.flags.includes("backup-copy"));
    assert.equal(same.length, 2);
    assert.deepEqual(same.map((s) => s.accountId).sort(), ["org", "personal"]);
    assert.equal(find(all, uid(7), "personal").cwd, "D:/Work/X");
    assert.equal(find(all, uid(7), "org").cwd, "d:/Work/X");
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("active flag: mtime within the window; recomputed from now", async () => {
  const c = await setup();
  try {
    const p = join(c.a, "projects", "C--work-demo", `${uid(1)}.jsonl`);
    const recent = new Date(NOW - 1000);
    await utimes(p, recent, recent);
    let all = await collect(createClaudeAdapter().discover(c.env));
    assert.deepEqual(find(all, uid(1)).flags, ["active"]);
    // later, same file unchanged: no longer active (cache must not freeze the flag)
    const later = { ...c.env, now: () => NOW + ACTIVE_WINDOW_MS + 1000 };
    all = await collect(createClaudeAdapter().discover(later));
    assert.deepEqual(find(all, uid(1)).flags, []);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("accounts without a projects dir are skipped", async () => {
  const c = await setup();
  try {
    const cfg = defaultConfig([{ id: "ghost", home: join(c.dir, "nope"), displayName: "G", accentColor: null }, ...c.env.config.accounts]);
    const env = { ...c.env, config: cfg };
    const ad = createClaudeAdapter();
    assert.equal(await ad.isAvailable(env), true);
    assert.equal((await collect(ad.discover(env))).length, 14);
    assert.equal(await ad.isAvailable({ ...env, config: defaultConfig([{ id: "ghost", home: join(c.dir, "nope"), displayName: "G", accentColor: null }]) }), false);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("cwdOffsetBytes counts bytes (multi-byte chars, CRLF) up to the end of the first cwd record", async () => {
  const c = await setup();
  try {
    const f = join(c.dir, "bytes.jsonl");
    const l1 = JSON.stringify({ type: "mode", note: "açãoé✓" });
    const l2 = JSON.stringify({ type: "user", message: { role: "user", content: "olá" }, cwd: "C:/work/ção" });
    const l3 = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [] } });
    await writeFile(f, `${l1}\r\n${l2}\r\n${l3}`);
    const r = await scanTranscript(f);
    assert.equal(r.cwd, "C:/work/ção");
    assert.equal(r.cwdOffsetBytes, Buffer.byteLength(l1) + 2 + Buffer.byteLength(l2) + 2);
    assert.equal(r.cwdReadable, true);
    assert.equal(r.corruptLines, 0);
    assert.equal(r.messageCount, 2);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("cwd beyond 1000 records or 1 MiB -> cwd-unreadable but cwd and offset still reported", async () => {
  const c = await setup();
  try {
    const pad = JSON.stringify({ type: "mode", mode: "normal" });
    const withCwd = JSON.stringify({ type: "user", message: { role: "user", content: "x" }, cwd: "C:/work/late" });
    const byRecords = join(c.dir, "records.jsonl");
    await writeFile(byRecords, Array(1000).fill(pad).join("\n") + "\n" + withCwd + "\n");
    const r1 = await scanTranscript(byRecords);
    assert.equal(r1.cwd, "C:/work/late");
    assert.equal(r1.cwdReadable, false);

    const exactly = join(c.dir, "records-ok.jsonl");
    await writeFile(exactly, Array(999).fill(pad).join("\n") + "\n" + withCwd + "\n");
    assert.equal((await scanTranscript(exactly)).cwdReadable, true); // 1000th record

    const bigPad = JSON.stringify({ type: "mode", blob: "x".repeat(CWD_SCAN_MAX_BYTES) });
    const byBytes = join(c.dir, "bytes-big.jsonl");
    await writeFile(byBytes, bigPad + "\n" + withCwd + "\n");
    const r2 = await scanTranscript(byBytes);
    assert.equal(r2.cwdReadable, false);
    assert.equal(r2.cwdOffsetBytes, Buffer.byteLength(bigPad) + 1 + Buffer.byteLength(withCwd) + 1);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("lines split across read chunks (large records) are parsed correctly", async () => {
  const c = await setup();
  try {
    const f = join(c.dir, "chunks.jsonl");
    const big = JSON.stringify({ type: "user", message: { role: "user", content: "é".repeat(300_000) }, cwd: "C:/x", timestamp: "2026-01-01T00:00:00Z" });
    await writeFile(f, big + "\n" + big + "\n");
    const r = await scanTranscript(f);
    assert.equal(r.corruptLines, 0);
    assert.equal(r.messageCount, 2);
    assert.equal(r.cwdOffsetBytes, Buffer.byteLength(big) + 1);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("over-32mib flag by size", async () => {
  const c = await setup();
  try {
    const f = join(c.a, "projects", "C--work-demo", `${uid(20)}.jsonl`);
    const line = JSON.stringify({ type: "user", message: { role: "user", content: "x" }, cwd: "C:/work/demo" }) + "\n";
    await writeFile(f, line + " ".repeat(32 * 1024 * 1024 + 1));
    await utimes(f, OLD, OLD);
    const s = find(await collect(createClaudeAdapter().discover(c.env)), uid(20));
    assert.ok(s.flags.includes("over-32mib"));
    assert.ok(!s.flags.includes("over-4gib"));
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("warm discover reuses the cache: unchanged files are not opened; changed ones are", async () => {
  const c = await setup();
  try {
    const opened: string[] = [];
    const ad = createClaudeAdapter({ onScan: (p) => opened.push(p) });
    const first = await collect(ad.discover(c.env));
    assert.equal(opened.length, 14);
    opened.length = 0;
    const second = await collect(ad.discover(c.env));
    assert.equal(opened.length, 0);
    const noAtime = (l: DiscoveredSession[]) => l.map((s) => ({ ...s, file: { ...s.file, atimeMs: 0 } }));
    assert.deepEqual(noAtime(second), noAtime(first)); // atime moves when a file is read
    // modify one file (size changes) -> only that one is re-scanned
    const p = join(c.a, "projects", "C--work-demo", `${uid(1)}.jsonl`);
    await writeFile(p, JSON.stringify({ type: "user", message: { role: "user", content: "new" }, cwd: "C:/work/new" }) + "\n");
    await utimes(p, OLD, OLD);
    const third = await collect(ad.discover(c.env));
    assert.deepEqual(opened, [p]);
    assert.equal(find(third, uid(1), "personal").cwd, "C:/work/new");
    assert.equal((await stat(join(c.env.stateDir, "cache", "claude-discovery.json"))).isFile(), true);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("corrupt cache is ignored and rebuilt", async () => {
  const c = await setup();
  try {
    await mkdir(join(c.env.stateDir, "cache"), { recursive: true });
    await writeFile(join(c.env.stateDir, "cache", "claude-discovery.json"), "{ not json");
    const opened: string[] = [];
    const ad = createClaudeAdapter({ onScan: (p) => opened.push(p) });
    assert.equal((await collect(ad.discover(c.env))).length, 14);
    assert.equal(opened.length, 14);
    opened.length = 0;
    await collect(ad.discover(c.env));
    assert.equal(opened.length, 0);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("unreadable file is skipped and reported in lastErrors, never thrown", async () => {
  const c = await setup();
  try {
    const bad = join(c.a, "projects", "C--work-demo", `${uid(1)}.jsonl`);
    const ad = createClaudeAdapter({
      onScan: (p) => { if (p === bad) throw Object.assign(new Error("busy"), { code: "EBUSY" }); },
    });
    const all = await collect(ad.discover(c.env));
    assert.equal(all.length, 13);
    assert.ok(!all.some((s) => s.file.path === bad));
    assert.deepEqual(ad.lastErrors, [{ path: bad, error: "EBUSY" }]);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

// ---- hardening ----

const CACHE = (c: Ctx) => join(c.env.stateDir, "cache", "claude-discovery.json");

test("messageCount semantics: tool_use-only assistant counts, tool_result-only user does not", async () => {
  const c = await setup();
  try {
    // user, assistant(tool_use only), [tool_result user excluded], assistant(text) = 3
    const s = find(await collect(createClaudeAdapter().discover(c.env)), uid(12));
    assert.equal(s.messageCount, 3);
    assert.deepEqual(s.flags, []);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("cache entry missing a field is dropped and rescanned, not partially used", async () => {
  const c = await setup();
  try {
    await collect(createClaudeAdapter().discover(c.env));
    const cache = JSON.parse(await readFile(CACHE(c), "utf8"));
    const victim = join(c.a, "projects", "C--work-demo", `${uid(1)}.jsonl`);
    assert.ok(cache.entries[victim]);
    delete cache.entries[victim].result.cwdOffsetBytes;
    const victim2 = join(c.a, "projects", "C--work-demo", `${uid(2)}.jsonl`);
    cache.entries[victim2].result.corruptLines = "1"; // wrong type
    await writeFile(CACHE(c), JSON.stringify(cache));
    const opened: string[] = [];
    const s = await collect(createClaudeAdapter({ onScan: (p) => opened.push(p) }).discover(c.env));
    assert.deepEqual(opened.sort(), [victim, victim2].sort());
    assert.equal(find(s, uid(1), "personal").cwdOffsetBytes, 198);
    assert.equal(find(s, uid(2), "personal").corruptLines, 1);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("stale cache entry for a deleted file is pruned", async () => {
  const c = await setup();
  try {
    const ad = createClaudeAdapter();
    await collect(ad.discover(c.env));
    const gone = join(c.a, "projects", "C--work-demo", `${uid(1)}.jsonl`);
    assert.ok(JSON.parse(await readFile(CACHE(c), "utf8")).entries[gone]);
    await rm(gone);
    const all = await collect(ad.discover(c.env));
    assert.equal(all.length, 13);
    assert.equal(JSON.parse(await readFile(CACHE(c), "utf8")).entries[gone], undefined);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("CACHE_VERSION mismatch forces a full rescan", async () => {
  const c = await setup();
  try {
    await collect(createClaudeAdapter().discover(c.env));
    const cache = JSON.parse(await readFile(CACHE(c), "utf8"));
    cache.version += 1;
    for (const e of Object.values(cache.entries) as { result: { messageCount: number } }[]) e.result.messageCount = 999;
    await writeFile(CACHE(c), JSON.stringify(cache));
    const opened: string[] = [];
    const all = await collect(createClaudeAdapter({ onScan: (p) => opened.push(p) }).discover(c.env));
    assert.equal(opened.length, 14);
    assert.ok(all.every((s) => s.messageCount !== 999));
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("a consumer that breaks out early does not write the cache", async () => {
  const c = await setup();
  try {
    await collect(createClaudeAdapter().discover(c.env));
    const before = await readFile(CACHE(c), "utf8");
    const p = join(c.a, "projects", "C--work-demo", `${uid(1)}.jsonl`);
    await writeFile(p, JSON.stringify({ type: "user", message: { role: "user", content: "new" }, cwd: "C:/work/new" }) + "\n");
    await utimes(p, OLD, OLD);
    for await (const s of createClaudeAdapter().discover(c.env)) { void s; break; }
    assert.equal(await readFile(CACHE(c), "utf8"), before);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("cwd record ending exactly at 1 MiB is readable; one byte later is cwd-unreadable", async () => {
  const c = await setup();
  try {
    const mk = (target: number): string => {
      const head = JSON.stringify({ type: "user", message: { role: "user", content: "x" }, cwd: "C:/work/b", pad: "" });
      const pad = "p".repeat(target - 1 - Buffer.byteLength(head)); // -1 for the newline
      return JSON.stringify({ type: "user", message: { role: "user", content: "x" }, cwd: "C:/work/b", pad }) + "\n";
    };
    const exact = join(c.dir, "exact.jsonl");
    await writeFile(exact, mk(CWD_SCAN_MAX_BYTES));
    const r1 = await scanTranscript(exact);
    assert.equal(r1.cwdOffsetBytes, CWD_SCAN_MAX_BYTES);
    assert.equal(r1.cwdReadable, true);
    const over = join(c.dir, "over.jsonl");
    await writeFile(over, mk(CWD_SCAN_MAX_BYTES + 1));
    const r2 = await scanTranscript(over);
    assert.equal(r2.cwdOffsetBytes, CWD_SCAN_MAX_BYTES + 1);
    assert.equal(r2.cwdReadable, false);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("tiny read chunks: cwd record straddling chunks, and a final line without trailing newline", async () => {
  const c = await setup();
  try {
    const l1 = JSON.stringify({ type: "mode", note: "ação✓" });
    const l2 = JSON.stringify({ type: "user", message: { role: "user", content: "olá ✓" }, cwd: "C:/work/ção", timestamp: "2026-01-01T00:00:01Z" });
    const f = join(c.dir, "tiny.jsonl");
    await writeFile(f, `${l1}\n${l2}`); // cwd record is the last line, no newline
    for (const hwm of [1, 3, 7, 16]) {
      const r = await scanTranscript(f, { highWaterMark: hwm });
      assert.equal(r.cwd, "C:/work/ção", `hwm ${hwm}`);
      assert.equal(r.cwdOffsetBytes, Buffer.byteLength(l1) + 1 + Buffer.byteLength(l2), `hwm ${hwm}`);
      assert.equal(r.corruptLines, 0);
      assert.equal(r.messageCount, 1);
      assert.equal(r.updatedAt, "2026-01-01T00:00:01.000Z");
    }
    // same through the adapter option
    const opened: string[] = [];
    const ad = createClaudeAdapter({ onScan: (p) => opened.push(p), readOptions: { highWaterMark: 5 } });
    const all = await collect(ad.discover(c.env));
    assert.equal(all.length, 14);
    assert.equal(find(all, uid(1), "personal").cwdOffsetBytes, 198);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("UTF-8 BOM at file start is stripped before parsing and counted in offsets", async () => {
  const c = await setup();
  try {
    const l1 = JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, cwd: "C:/work/bom" });
    const f = join(c.dir, "bom.jsonl");
    await writeFile(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(l1 + "\n")]));
    for (const hwm of [undefined, 2]) {
      const r = await scanTranscript(f, { highWaterMark: hwm });
      assert.equal(r.corruptLines, 0);
      assert.equal(r.cwd, "C:/work/bom");
      assert.equal(r.messageCount, 1);
      assert.equal(r.cwdOffsetBytes, 3 + Buffer.byteLength(l1) + 1);
    }
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("blank lines count toward the 1000-record window (T3 reserves a record per split line)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3sm-claude-blank-"));
  try {
    const rec = JSON.stringify({ type: "user", cwd: "C:/work/demo", message: { role: "user", content: "q" } });
    const f = join(dir, "s.jsonl");
    await writeFile(f, "\n".repeat(1000) + rec + "\n");
    const r = await scanTranscript(f);
    assert.equal(r.cwd, "C:/work/demo");
    assert.equal(r.cwdReadable, false);
    await writeFile(f, "\n".repeat(999) + rec + "\n");
    assert.equal((await scanTranscript(f)).cwdReadable, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an older cache file (version 1 or 2: before the shared scanner, before sessionId) triggers a full rescan", async () => {
  const c = await setup();
  try {
    const opened: string[] = [];
    const ad = createClaudeAdapter({ onScan: (p) => opened.push(p) });
    await collect(ad.discover(c.env));
    const file = join(c.env.stateDir, "cache", "claude-discovery.json");
    const cache = JSON.parse(await readFile(file, "utf8"));
    assert.equal(cache.version, 3);
    cache.version = 2;
    await writeFile(file, JSON.stringify(cache));
    opened.length = 0;
    await collect(ad.discover(c.env));
    assert.equal(opened.length, 14);
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test("B11: nativeId follows T3's rule: the last non-hidden record's sessionId (trimmed), else the file stem; a different one is flagged id-mismatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3sm-claude-id-"));
  try {
    const home = join(dir, "home");
    const proj = join(home, "projects", "C--work-demo");
    await mkdir(proj, { recursive: true });
    const rec = (o: Record<string, unknown>) => JSON.stringify({ type: "user", cwd: "C:/work/demo", message: { role: "user", content: "hi" }, timestamp: "2026-01-01T00:00:00Z", ...o });
    const write = async (stem: string, lines: string[]) => {
      const p = join(proj, `${stem}.jsonl`);
      await writeFile(p, lines.join("\n") + "\n");
      await utimes(p, OLD, OLD);
    };
    await write(uid(101), [rec({ sessionId: uid(101) }), rec({ sessionId: ` ${uid(102)} ` }), rec({ isMeta: true, sessionId: uid(103) }), rec({ isSidechain: true, sessionId: uid(104) })]);
    await write(uid(110), [rec({})]);
    await write(uid(120), [rec({ sessionId: uid(120) })]);
    const config = defaultConfig([{ id: "personal", home, displayName: "P", accentColor: null }]);
    const all = await collect(createClaudeAdapter().discover({ home: dir, platform: process.platform, now: () => NOW, config, stateDir: join(dir, "state") }));
    const byFile = (stem: string) => all.find((s) => s.file.path.endsWith(`${stem}.jsonl`))!;
    assert.equal(byFile(uid(101)).nativeId, uid(102), "last non-hidden sessionId, trimmed (meta and sidechain records do not count)");
    assert.ok(byFile(uid(101)).flags.includes("id-mismatch"));
    assert.equal(byFile(uid(110)).nativeId, uid(110), "no sessionId: the file stem");
    assert.ok(!byFile(uid(110)).flags.includes("id-mismatch"));
    assert.equal(byFile(uid(120)).nativeId, uid(120));
    assert.ok(!byFile(uid(120)).flags.includes("id-mismatch"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
