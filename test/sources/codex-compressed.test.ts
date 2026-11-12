// Codex compressed rollouts (`rollout-*.jsonl.zst`, Codex CLI >= 0.167): converted through the convert path. Fixtures
// are synthetic rollout JSONL compressed at test time with zlib.zstdCompressSync (no real content).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { createCodexAdapter, readRollout, zstdFrameContentSize } from "../../src/sources/codex.ts";
import { ACTIVE_WINDOW_MS, SessionActiveError, type Env } from "../../src/sources/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import type { CanonicalTranscript, Config, DiscoveredSession } from "../../src/core/types.ts";

const NOW = Date.parse("2026-06-01T00:00:00Z");
const OLD = new Date("2026-01-10T00:00:00Z");
const ID = (n: number) => `0190bbbb-0000-7000-8000-${String(n).padStart(12, "0")}`;
const temps: string[] = [];
after(async () => { for (const t of temps.splice(0)) await rm(t, { recursive: true, force: true }); });

const ts = (s: number) => new Date(Date.UTC(2026, 0, 2, 0, 0, s)).toISOString();
const meta = (id: string | null, extra: Record<string, unknown> = {}) =>
  ({ timestamp: ts(0), type: "session_meta", payload: { ...(id ? { id } : {}), timestamp: ts(0), cwd: "C:/work/demo", originator: "demo", ...extra } });
const msg = (s: number, role: string, text: string, turn?: string) =>
  ({ timestamp: ts(s), type: "response_item", payload: { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }], ...(turn ? { internal_chat_message_metadata_passthrough: { turn_id: turn } } : {}) } });
const event = (s: number, text: string) => ({ timestamp: ts(s), type: "event_msg", payload: { type: "user_message", message: text } });

/** A normal session: env context + prompt (canonical via the event), reasoning, a custom tool call and a function call, answer, second turn. */
function normal(id: string): object[] {
  return [
    meta(id),
    { timestamp: ts(1), type: "turn_context", payload: { turn_id: "t1", cwd: "C:/work/demo" } },
    msg(2, "developer", "synthetic rules", "t1"),
    msg(3, "user", "<environment_context>synthetic</environment_context>", "t1"),
    msg(4, "user", "list the files", "t1"),
    event(5, "list the files"),
    { timestamp: ts(6), type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "secret reasoning" }] } },
    { timestamp: ts(7), type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "*** Begin Patch", status: "completed" } },
    { timestamp: ts(8), type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: "Done!" } },
    { timestamp: ts(9), type: "response_item", payload: { type: "function_call", call_id: "c2", name: "shell", arguments: JSON.stringify({ command: "ls -la" }) } },
    { timestamp: ts(10), type: "response_item", payload: { type: "function_call_output", call_id: "c2", output: "x".repeat(800) } },
    msg(11, "assistant", "There is one file: ação ✅", "t1"),
    msg(12, "user", "thanks", "t2"),
    msg(13, "assistant", "you are welcome", "t2"),
  ];
}
const jsonl = (recs: object[]): string => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const zst = (recs: object[]): Buffer => zstdCompressSync(Buffer.from(jsonl(recs), "utf8"));

interface Ctx { dir: string; day: string; env: Env }
async function setup(config: Config = defaultConfig([])): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), "t3sm-codex-zst-"));
  temps.push(dir);
  const day = join(dir, ".codex", "sessions", "2026", "01", "02");
  await mkdir(day, { recursive: true });
  return { dir, day, env: { home: dir, platform: process.platform, now: () => NOW, config, stateDir: join(dir, "state"), env: {} } };
}
const name = (n: number, ext: ".jsonl" | ".jsonl.zst") => `rollout-2026-01-02T00-00-0${n % 10}-${ID(n)}${ext}`;
async function put(c: Ctx, file: string, data: string | Buffer, mtime: Date = OLD): Promise<string> {
  const p = join(c.day, file);
  await writeFile(p, data);
  await utimes(p, mtime, mtime);
  return p;
}
async function collect(it: AsyncIterable<DiscoveredSession>): Promise<DiscoveredSession[]> {
  const out: DiscoveredSession[] = [];
  for await (const s of it) out.push(s);
  return out;
}

test("compressed rollout: discovered by streaming decompression, mode convert, id/cwd/times/count from the content", async () => {
  const c = await setup();
  const p = await put(c, name(1, ".jsonl.zst"), zst(normal(ID(1))));
  const adapter = createCodexAdapter();
  const all = await collect(adapter.discover(c.env));
  assert.equal(all.length, 1);
  const s = all[0]!;
  assert.equal(s.nativeId, ID(1));
  assert.equal(s.mode, "convert");
  assert.deepEqual(s.flags, ["compressed"]);
  assert.equal(s.cwd, "C:/work/demo");
  assert.equal(s.startedAt, ts(0));
  assert.equal(s.updatedAt, ts(13));
  // T3's rule: turn t1's response-item user copies are canonical (the event carries the prompt) -> prompt, answer,
  // thanks, welcome.
  assert.equal(s.messageCount, 4);
  assert.equal(s.cwdOffsetBytes, 0, "the converted transcript carries cwd on its first record");
  assert.equal(s.file.path, p);
  assert.deepEqual(adapter.lastErrors, []);
});

test("read(): canonical transcript with T3's message rules, tool calls flattened, reasoning dropped", async () => {
  const c = await setup();
  await put(c, name(1, ".jsonl.zst"), zst(normal(ID(1))));
  const adapter = createCodexAdapter({ now: () => NOW });
  const [s] = await collect(adapter.discover(c.env));
  const t = await adapter.read!(s!);
  assert.equal(t.harness, "codex");
  assert.equal(t.nativeId, ID(1));
  assert.equal(t.cwd, "C:/work/demo");
  assert.equal(t.startedAt, ts(0));
  assert.deepEqual(t.activity, { updatedAt: ts(13), messageCount: 4 });
  assert.deepEqual(t.messages.map((m) => [m.role, m.text.slice(0, 60), m.timestamp]), [
    ["user", "list the files", ts(5)],
    ["assistant", "[tool apply_patch] *** Begin Patch → Done!", ts(7)],
    ["assistant", `[tool shell] ls -la → ${"x".repeat(38)}`, ts(9)],
    ["assistant", "There is one file: ação ✅", ts(11)],
    ["user", "thanks", ts(12)],
    ["assistant", "you are welcome", ts(13)],
  ]);
  const shell = t.messages[2]!.text;
  assert.equal(shell.length, "[tool shell] ".length + 500 + 1, "the part after the name is clipped to 500 characters, … appended");
  assert.ok(shell.endsWith("…"));
  assert.ok(!t.messages.some((m) => m.text.includes("secret reasoning")));
  assert.ok(!t.messages.some((m) => m.text.includes("environment_context") || m.text.includes("synthetic rules")));
});

test("shared mapping: the same rollout as .jsonl and .jsonl.zst reads to identical canonical messages, and counts agree with discovery", async () => {
  const c = await setup();
  const recs = normal(ID(2));
  const plain = await put(c, "plain.jsonl", jsonl(recs));
  const comp = await put(c, "comp.jsonl.zst", zst(recs));
  const a = await readRollout(plain);
  const b = await readRollout(comp);
  assert.deepEqual(a, b);
  assert.equal(a.messages.length, 6);
  assert.equal(a.messageCount, 4, "tool lines are not messages T3 counts");
  assert.equal(a.messages.filter((m) => !m.text.startsWith("[tool ")).length, a.messageCount);
});

test("subagent rollout and a rollout without a session_meta id keep their skip flags", async () => {
  const c = await setup();
  await put(c, name(3, ".jsonl.zst"), zst([
    { timestamp: ts(0), type: "session_meta", payload: { id: ID(3), cwd: "C:/work/demo", source: { subagent: { review: true } } } },
    msg(1, "user", "sub task"), msg(2, "assistant", "done"),
  ]));
  await put(c, name(4, ".jsonl.zst"), zst([meta(null), msg(1, "user", "no id"), msg(2, "assistant", "ok")]));
  const all = await collect(createCodexAdapter().discover(c.env));
  const sub = all.find((s) => s.nativeId === ID(3))!;
  assert.deepEqual(sub.flags.toSorted(), ["compressed", "subagent"]);
  assert.equal(sub.cwd, null);
  const noId = all.find((s) => s.nativeId !== ID(3))!;
  assert.deepEqual(noId.flags.toSorted(), ["compressed", "no-session-id"]);
  assert.equal(noId.nativeId, `rollout-2026-01-02T00-00-04-${ID(4)}`, "display id from the file name");
});

test("a corrupt zstd stream goes to lastErrors and the session is skipped; never a crash", async () => {
  const c = await setup();
  const good = zst(normal(ID(5)));
  const bad = Buffer.concat([good.subarray(0, 12), Buffer.from("this is not zstd data at all".repeat(4))]);
  const p = await put(c, name(6, ".jsonl.zst"), bad);
  await put(c, name(5, ".jsonl.zst"), good);
  await put(c, name(7, ".jsonl.zst"), "garbage, not even a frame header");
  // Truncated (a copy cut short): Node's zstd stream ends without an error; the frame's declared size catches it.
  const cut = await put(c, name(8, ".jsonl.zst"), good.subarray(0, good.length - 7));
  const adapter = createCodexAdapter();
  const all = await collect(adapter.discover(c.env));
  assert.deepEqual(all.map((s) => s.nativeId), [ID(5)]);
  assert.equal(adapter.lastErrors.length, 3, JSON.stringify(adapter.lastErrors));
  assert.ok(adapter.lastErrors.some((e) => e.path === p));
  assert.ok(adapter.lastErrors.some((e) => e.path === cut && e.error === "ZSTD_truncated"));
  // read() of a corrupt file fails (read-failed for its item), never hangs or crashes.
  const ok = all[0]!;
  await assert.rejects(adapter.read!({ ...ok, file: { ...ok.file, path: cut } }));
});

test("zstdFrameContentSize reads the declared size of every header form; null for anything else", () => {
  for (const n of [0, 5, 255, 256, 300, 65_791, 70_000, 5_000_000]) {
    assert.equal(zstdFrameContentSize(zstdCompressSync(Buffer.alloc(n, 97))), n, String(n));
  }
  assert.equal(zstdFrameContentSize(Buffer.from("not zstd at all")), null);
  assert.equal(zstdFrameContentSize(Buffer.alloc(3)), null);
});

test("the same id as .jsonl and .jsonl.zst is one session: the native file wins, the compressed copy is listed as a duplicate", async () => {
  const c = await setup();
  const recs = normal(ID(8));
  // The compressed copy sorts first in the day directory (newest name first): order must not matter.
  const plain = await put(c, `rollout-2026-01-02T00-00-00-${ID(8)}.jsonl`, jsonl(recs));
  const comp = await put(c, `rollout-2026-01-02T00-00-09-${ID(8)}.jsonl.zst`, zst(recs));
  const all = await collect(createCodexAdapter().discover(c.env));
  assert.equal(all.length, 2);
  const kept = all.find((s) => s.file.path === plain)!;
  assert.equal(kept.mode, undefined);
  assert.deepEqual(kept.flags, []);
  assert.deepEqual(all.find((s) => s.file.path === comp)!.flags, ["compressed", "duplicate-file"]);
});

test("two compressed rollouts with one session id (Codex `<id>_<child>` files): the parent rollout (name id = meta id) is planned, the other is listed as a duplicate; stable when activity changes", async () => {
  const c = await setup();
  const later = (recs: object[], add: number) => recs.map((r) => ({ ...r, timestamp: new Date(Date.parse((r as { timestamp: string }).timestamp) + add).toISOString() }));
  const parent = await put(c, `rollout-2026-01-02T00-00-09-${ID(15)}.jsonl.zst`, zst(normal(ID(15))));
  const child = await put(c, `rollout-2026-01-02T00-00-01-${ID(15)}_${ID(16)}.jsonl.zst`, zst(later(normal(ID(15)), 60_000)));
  const pick = async () => {
    const all = await collect(createCodexAdapter().discover(c.env));
    assert.equal(all.length, 2, "every copy is listed");
    return { kept: all.find((s) => !s.flags.includes("duplicate-file"))!, dup: all.find((s) => s.flags.includes("duplicate-file"))! };
  };
  const a = await pick();
  assert.equal(a.kept.file.path, parent, "the parent rollout, although the other one is newer");
  assert.equal(a.dup.file.path, child);
  assert.deepEqual(a.dup.flags, ["compressed", "duplicate-file"]);
  // The child gets newer activity again: the choice does not flip.
  await put(c, `rollout-2026-01-02T00-00-01-${ID(15)}_${ID(16)}.jsonl.zst`, zst(later(normal(ID(15)), 600_000)));
  assert.equal((await pick()).kept.file.path, parent);
});

test("duplicate rollouts: a usable copy ranks above an unusable one (sub-agent, too large, no cwd), even when the unusable one is the parent", async () => {
  const c = await setup();
  const noCwd = normal(ID(17)).map((r) => ((r as { type: string }).type === "session_meta" ? { ...r, payload: { id: ID(17) } } : (r as { type: string }).type === "turn_context" ? { ...r, payload: { turn_id: "t1" } } : r));
  const parent = await put(c, `rollout-2026-01-02T00-00-09-${ID(17)}.jsonl.zst`, zst(noCwd));
  const child = await put(c, `rollout-2026-01-02T00-00-01-${ID(17)}_${ID(18)}.jsonl.zst`, zst(normal(ID(17))));
  const all = await collect(createCodexAdapter().discover(c.env));
  assert.equal(all.find((s) => !s.flags.includes("duplicate-file"))!.file.path, child);
  assert.deepEqual(all.find((s) => s.file.path === parent)!.flags.toSorted(), ["compressed", "duplicate-file", "no-cwd"]);
});

test("duplicate rollouts: a copy with only hidden records counts as unusable", async () => {
  const c = await setup();
  const hidden = [meta(ID(25)), msg(1, "developer", "synthetic rules"), msg(2, "assistant", "nothing asked")];
  const parent = await put(c, `rollout-2026-01-02T00-00-09-${ID(25)}.jsonl.zst`, zst(hidden));
  const child = await put(c, `rollout-2026-01-02T00-00-01-${ID(25)}_${ID(26)}.jsonl.zst`, zst(normal(ID(25))));
  const all = await collect(createCodexAdapter().discover(c.env));
  assert.equal(all.find((s) => !s.flags.includes("duplicate-file"))!.file.path, child);
  assert.deepEqual(all.find((s) => s.file.path === parent)!.flags.toSorted(), ["compressed", "duplicate-file", "only-hidden"]);
});

test("a discovery cache of an older version (before strict zstd reading) is rebuilt, never trusted", async () => {
  const c = await setup();
  const p = await put(c, name(27, ".jsonl.zst"), zst(normal(ID(27))));
  const { stat: statP } = await import("node:fs/promises");
  const st = await statP(p);
  const stale = { id: ID(27), cwd: "C:/stale", startedAt: null, updatedAt: null, messageCount: 999, visibleUserCount: 1, corruptLines: 0, cwdOffsetBytes: 0, cwdReadable: true, subagent: false };
  await mkdir(join(c.env.stateDir, "cache"), { recursive: true });
  await writeFile(join(c.env.stateDir, "cache", "codex-discovery.json"), JSON.stringify({ version: 4, entries: { [p]: { size: st.size, mtimeMs: st.mtimeMs, result: stale } } }));
  const scans: string[] = [];
  const [s] = await collect(createCodexAdapter({ onScan: (x) => scans.push(x) }).discover(c.env));
  assert.deepEqual(scans, [p], "rescanned");
  assert.equal(s!.messageCount, 4);
  assert.equal(s!.cwd, "C:/work/demo");
  assert.equal((JSON.parse(await readFile(join(c.env.stateDir, "cache", "codex-discovery.json"), "utf8")) as { version: number }).version, 5);
});

test("zstd completeness: multi-frame files are decoded frame after frame; a streamed file without a declared size must end complete", async () => {
  const c = await setup();
  const { createZstdCompress } = await import("node:zlib");
  const { Readable, Writable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  const streamed = async (b: Buffer): Promise<Buffer> => {
    const out: Buffer[] = [];
    await pipeline(Readable.from([b.subarray(0, 300), b.subarray(300)]), createZstdCompress(), new Writable({ write(x, _e, cb) { out.push(x); cb(); } }));
    return Buffer.concat(out);
  };
  const text = Buffer.from(jsonl(normal(ID(19))));
  const nl = text.indexOf(10) + 1;
  const multi = await put(c, name(19, ".jsonl.zst"), Buffer.concat([zstdCompressSync(text.subarray(0, nl)), zstdCompressSync(text.subarray(nl))]));
  const plain = await put(c, "ref.jsonl", text);
  assert.deepEqual(await readRollout(multi), await readRollout(plain), "both frames read");
  const s = await streamed(text);
  assert.equal(zstdFrameContentSize(s), null, "a streaming compressor declares no size");
  const okStream = await put(c, `rollout-2026-01-02T00-00-00-${ID(20)}.jsonl.zst`, s);
  assert.equal((await readRollout(okStream)).messageCount, 4);
  // Cut inside the frame (structure incomplete) and cut at a line end with no size declared: both truncated.
  const cut = await put(c, `rollout-2026-01-02T00-00-00-${ID(21)}.jsonl.zst`, s.subarray(0, Math.floor(s.length * 0.6)));
  await assert.rejects(readRollout(cut), (e: NodeJS.ErrnoException) => e.code === "ZSTD_truncated");
  const noEol = await put(c, `rollout-2026-01-02T00-00-00-${ID(22)}.jsonl.zst`, await streamed(text.subarray(0, text.length - 1)));
  await assert.rejects(readRollout(noEol), (e: NodeJS.ErrnoException) => e.code === "ZSTD_truncated");
  // Trailing bytes that are not a frame: corrupt, never ignored.
  const junk = await put(c, `rollout-2026-01-02T00-00-00-${ID(23)}.jsonl.zst`, Buffer.concat([zstdCompressSync(text), Buffer.from("junk")]));
  await assert.rejects(readRollout(junk));
});

test("one line longer than the per-line cap is too-large (never buffered up to the whole-file cap)", async () => {
  const c = await setup();
  const big = [...normal(ID(24)), msg(30, "assistant", "z".repeat(20_000))];
  await put(c, name(24, ".jsonl.zst"), zst(big));
  const [s] = await collect(createCodexAdapter({ maxLineBytes: 8192 }).discover(c.env));
  assert.ok(s!.flags.includes("too-large"), JSON.stringify(s!.flags));
});

test("codex.convertCompressed: false keeps compressed rollouts listed, never opened, flagged compressed", async () => {
  const c = await setup({ ...defaultConfig([]), codex: { convertCompressed: false } });
  await put(c, name(9, ".jsonl.zst"), zst(normal(ID(9))));
  const scans: string[] = [];
  const all = await collect(createCodexAdapter({ onScan: (p) => scans.push(p) }).discover(c.env));
  assert.equal(all.length, 1);
  assert.deepEqual(all[0]!.flags, ["compressed"]);
  assert.equal(all[0]!.mode, undefined);
  assert.equal(all[0]!.cwd, null);
  assert.equal(all[0]!.nativeId, ID(9));
  assert.deepEqual(scans, []);
});

test("decompressed size over the cap: flagged too-large (discovery stops at the cap); read() refuses it", async () => {
  const c = await setup();
  const big = [...normal(ID(10)), ...Array.from({ length: 50 }, (_, i) => msg(20, "assistant", `filler ${i} ${"y".repeat(200)}`))];
  await put(c, name(10, ".jsonl.zst"), zst(big));
  const adapter = createCodexAdapter({ maxDecompressedBytes: 4096, now: () => NOW });
  const [s] = await collect(adapter.discover(c.env));
  assert.ok(s!.flags.includes("too-large"));
  assert.ok(s!.flags.includes("compressed"));
  await assert.rejects(adapter.read!(s!), /too-large|larger than/);
});

test("warm discovery reads compressed rollouts from the cache (keyed by path, size, mtime)", async () => {
  const c = await setup();
  const p = await put(c, name(11, ".jsonl.zst"), zst(normal(ID(11))));
  const scans: string[] = [];
  const adapter = createCodexAdapter({ onScan: (x) => scans.push(x) });
  const first = await collect(adapter.discover(c.env));
  assert.deepEqual(scans, [p]);
  scans.length = 0;
  const second = await collect(adapter.discover(c.env));
  assert.deepEqual(scans, []);
  const noAtime = (xs: DiscoveredSession[]) => xs.map((s) => ({ ...s, file: { ...s.file, atimeMs: 0 } })); // reading moved atime
  assert.deepEqual(noAtime(second), noAtime(first));
  const cache = JSON.parse(await readFile(join(c.env.stateDir, "cache", "codex-discovery.json"), "utf8")) as { version: number };
  assert.equal(cache.version, 5);
});

test("read(): a rollout modified within ACTIVE_WINDOW_MS is deferred (SessionActiveError)", async () => {
  const c = await setup();
  const recent = new Date(NOW - ACTIVE_WINDOW_MS + 60_000);
  await put(c, name(12, ".jsonl.zst"), zst(normal(ID(12))), recent);
  const adapter = createCodexAdapter({ now: () => NOW });
  const [s] = await collect(adapter.discover(c.env));
  assert.ok(s!.flags.includes("active"));
  await assert.rejects(adapter.read!(s!), SessionActiveError);
});

test("read(): the file must still hold the discovered session", async () => {
  const c = await setup();
  const p = await put(c, name(13, ".jsonl.zst"), zst(normal(ID(13))));
  const adapter = createCodexAdapter({ now: () => NOW });
  const [s] = await collect(adapter.discover(c.env));
  await writeFile(p, zst(normal(ID(14))));
  await utimes(p, OLD, OLD);
  await assert.rejects(adapter.read!(s!), /holds session/);
  const t: CanonicalTranscript = await adapter.read!({ ...s!, nativeId: ID(14) });
  assert.equal(t.nativeId, ID(14));
});
