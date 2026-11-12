import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { link, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { materializeConversions, type MaterializeFs } from "../../src/apply/materialize.ts";
import { toClaudeJsonl } from "../../src/apply/claudeWriter.ts";
import { Journal } from "../../src/core/journal.ts";
import { encodeClaudeProjectDir } from "../../src/core/paths.ts";
import { uuidV5 } from "../../src/core/uuid.ts";
import type { AccountConfig, CanonicalTranscript, DiscoveredSession, HarnessId, JournalEntry, PlanItem } from "../../src/core/types.ts";
import { SessionActiveError, SourceBusyError, type SourceAdapter } from "../../src/sources/types.ts";

const DAY = 86_400_000;
const ROOT = "C:/work/demo";
const NATIVE_ROOT = process.platform === "win32" ? "C:\\work\\demo" : ROOT;
const temps: string[] = [];
after(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

function setup() {
  const base = mkdtempSync(join(tmpdir(), "t3sm-materialize-"));
  temps.push(base);
  const home = join(base, ".claude");
  mkdirSync(join(home, "projects"), { recursive: true });
  const accounts: AccountConfig[] = [{ id: "claudeAgent", home, displayName: "Personal", accentColor: null }];
  const journal = new Journal(join(base, "state", "journal.jsonl"));
  const transcripts = new Map<string, CanonicalTranscript | Error>();
  const reads: string[] = [];
  const adapter: SourceAdapter = {
    id: "opencode", mode: "convert",
    isAvailable: async () => true,
    discover: async function* () { /* not used */ },
    read: async (s) => {
      reads.push(s.nativeId);
      const t = transcripts.get(s.nativeId);
      if (t === undefined) throw new Error(`no such session ${s.nativeId}`);
      if (t instanceof Error) throw t;
      return structuredClone(t);
    },
  };
  const adapters = new Map<HarnessId, SourceAdapter>([["opencode", adapter]]);
  const updatedMs = Date.now() - 3 * DAY;
  const item = (nativeId: string, over: { targetFile?: string; updatedAt?: string } = {}): PlanItem => {
    const uuid = uuidV5(`opencode:${nativeId}`);
    transcripts.set(nativeId, transcripts.get(nativeId) ?? {
      harness: "opencode", nativeId, cwd: ROOT, title: "demo", startedAt: "2026-01-01T00:00:00Z",
      messages: [
        { role: "user", text: `hello from ${nativeId}`, timestamp: "2026-01-01T00:00:01Z" },
        { role: "assistant", text: "[tool bash] ls → a.txt\n\nOne file: ação ✅", timestamp: "2026-01-01T00:00:02Z" },
      ],
    });
    const session: DiscoveredSession = {
      harness: "opencode", accountId: null, nativeId, cwd: ROOT, startedAt: "2026-01-01T00:00:00Z",
      updatedAt: over.updatedAt ?? new Date(updatedMs).toISOString(), messageCount: 2, corruptLines: 0,
      file: { path: join(base, "opencode.db"), size: 4096, mtimeMs: Date.now() - DAY, atimeMs: Date.now() - DAY }, flags: [], cwdOffsetBytes: 0,
    };
    const targetFile = over.targetFile ?? join(home, "projects", encodeClaudeProjectDir(ROOT), `${uuid}.jsonl`);
    return { session, action: { kind: "convert-import", projectRoot: ROOT, instanceId: "claudeAgent", expectedThreadId: `import:claudeAgent:${uuid}`, uuid, targetFile }, notes: [] };
  };
  const run = (items: PlanItem[], runId = "run-1", fs?: MaterializeFs) => materializeConversions(items, adapters, accounts, journal, runId, { fs });
  return { base, home, accounts, journal, transcripts, reads, adapters, item, run, updatedMs };
}

const target = (it: PlanItem): string => (it.action as { targetFile: string }).targetFile;
const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const fileWritten = (es: JournalEntry[]) => es.filter((e) => e.t === "file-written") as Extract<JournalEntry, { t: "file-written" }>[];

test("materializeConversions: writes the S3 transcript at the target, mtime = the session's last activity, journals file-written, returns a wave-ready item", async () => {
  const e = setup();
  const it = e.item("ses_a");
  const r = await e.run([it]);
  assert.deepEqual(r.written, [target(it)]);
  assert.deepEqual(r.failed, []);
  const text = readFileSync(target(it), "utf8");
  assert.equal(text, toClaudeJsonl(e.transcripts.get("ses_a") as CanonicalTranscript, { uuid: (it.action as { uuid: string }).uuid, cwd: NATIVE_ROOT }).text);
  const st = statSync(target(it));
  assert.ok(Math.abs(st.mtimeMs - e.updatedMs) <= 2, "mtime is the source's updatedAt, not now (so the file is not 'in use')");
  const fw = fileWritten(await e.journal.readAll());
  assert.equal(fw.length, 1);
  assert.deepEqual(fw[0], {
    t: "file-written", runId: "run-1", path: target(it), sha256: sha(text), mtimeMs: e.updatedMs,
    source: { harness: "opencode", nativeId: "ses_a", updatedAt: it.session.updatedAt, messageCount: 2 },
  });
  assert.equal(r.ready.length, 1);
  const ready = r.ready[0]!;
  assert.equal(ready.action, it.action);
  assert.equal(ready.session.file.path, target(it));
  assert.equal(ready.session.file.size, Buffer.byteLength(text));
  assert.ok(Math.abs(ready.session.file.mtimeMs - e.updatedMs) <= 2);
  assert.equal(ready.session.cwdOffsetBytes, Buffer.byteLength(text.slice(0, text.indexOf("\n") + 1)), "cwd is on the first record");
  assert.equal(ready.session.nativeId, "ses_a");
});

test("materializeConversions: a second run leaves every file unchanged (no write, no journal entry)", async () => {
  const e = setup();
  const items = [e.item("ses_a"), e.item("ses_b")];
  await e.run(items);
  const n = (await e.journal.readAll()).length;
  const before = items.map((i) => statSync(target(i)).mtimeMs);
  const r = await e.run(items, "run-2");
  assert.deepEqual(r.written, []);
  assert.deepEqual(r.unchanged.sort(), items.map(target).sort());
  assert.equal(r.ready.length, 2);
  assert.equal((await e.journal.readAll()).length, n);
  assert.deepEqual(items.map((i) => statSync(target(i)).mtimeMs), before);
});

test("materializeConversions: a file at the target that t3sm never wrote is never overwritten (failed: target-exists)", async () => {
  const e = setup();
  const it = e.item("ses_a");
  mkdirSync(path.dirname(target(it)), { recursive: true });
  writeFileSync(target(it), "someone else's transcript\n");
  const r = await e.run([it]);
  assert.deepEqual(r.failed.map((f) => f.reason), ["target-exists"]);
  assert.equal(r.failed[0]!.item, it);
  assert.deepEqual(r.ready, []);
  assert.equal(readFileSync(target(it), "utf8"), "someone else's transcript\n");
  assert.deepEqual(fileWritten(await e.journal.readAll()), []);
});

test("materializeConversions: our file resumed since (content changed) is left alone and still imported; a pristine one of ours is refreshed", async () => {
  const e = setup();
  const resumed = e.item("ses_a");
  const stale = e.item("ses_b");
  await e.run([resumed, stale]);
  appendFileSync(target(resumed), `{"type":"last-prompt","leafUuid":"x"}\n`);
  const resumedText = readFileSync(target(resumed), "utf8");
  const t = e.transcripts.get("ses_b") as CanonicalTranscript;
  t.messages.push({ role: "user", text: "continued in OpenCode", timestamp: "2026-01-01T00:00:03Z" });
  const r = await e.run([resumed, stale], "run-2");
  assert.deepEqual(r.resumed, [target(resumed)]);
  assert.ok(r.unchanged.includes(target(resumed)));
  assert.equal(readFileSync(target(resumed), "utf8"), resumedText, "never overwritten");
  assert.deepEqual(r.written, [target(stale)]);
  assert.match(readFileSync(target(stale), "utf8"), /continued in OpenCode/);
  assert.equal(r.ready.length, 2);
  const fw = fileWritten(await e.journal.readAll());
  assert.deepEqual(fw.map((x) => [x.runId, x.path]), [["run-1", target(resumed)], ["run-1", target(stale)], ["run-2", target(stale)]]);
});

test("materializeConversions: a read failure fails that session only; the others are written", async () => {
  const e = setup();
  const bad = e.item("ses_bad");
  e.transcripts.set("ses_bad", new Error("database is locked"));
  const good = e.item("ses_good");
  const r = await e.run([bad, good]);
  assert.deepEqual(r.failed.map((f) => [f.item.session.nativeId, f.reason]), [["ses_bad", "read-failed: database is locked"]]);
  assert.deepEqual(r.written, [target(good)]);
  assert.ok(!existsSync(target(bad)));
});

test("materializeConversions: never writes outside an account home's projects/<dir>/<uuid>.jsonl", async () => {
  const e = setup();
  const uuid = uuidV5("opencode:ses_x");
  const outside = [
    join(e.base, "elsewhere", "projects", "C--work-demo", `${uuid}.jsonl`), // not an account home
    join(e.home, "projects", `${uuid}.jsonl`), // directly in projects/
    join(e.home, "projects", "C--work-demo", "deeper", `${uuid}.jsonl`), // too deep
    `${e.home}/projects/C--work-demo/../C--work-demo/${uuid}.jsonl`, // `..` (join would normalize it away)
    join(e.home, "projects", "C--work-other", `${uuid}.jsonl`), // not the project's encoded dir
    join(e.home, "projects", "C--work-demo", `${uuidV5("opencode:other")}.jsonl`), // not the item's uuid
  ];
  for (const t of outside) {
    const it = e.item("ses_x", { targetFile: t });
    const r = await e.run([it]);
    assert.deepEqual(r.failed.map((f) => f.reason), ["target-outside-accounts"], t);
    assert.ok(!existsSync(t), t);
  }
  assert.deepEqual(e.reads, [], "nothing is read for a refused target");
  assert.deepEqual(fileWritten(await e.journal.readAll()), []);
});

test("materializeConversions: a harness without a reader fails its items (no-reader)", async () => {
  const e = setup();
  const it = e.item("ses_a");
  const r = await materializeConversions([it], new Map(), e.accounts, e.journal, "run-1");
  assert.deepEqual(r.failed.map((f) => f.reason), ["no-reader"]);
  assert.ok(!existsSync(target(it)));
});

test("materializeConversions: an unchanged file of ours left at a fresh mtime (crash between write and utimes) gets its mtime back", async () => {
  const e = setup();
  const it = e.item("ses_a");
  await e.run([it]);
  const now = Date.now() / 1000;
  utimesSync(target(it), now, now);
  const r = await e.run([it], "run-2");
  assert.deepEqual(r.unchanged, [target(it)]);
  assert.ok(Math.abs(statSync(target(it)).mtimeMs - e.updatedMs) <= 2);
  assert.ok(Math.abs(r.ready[0]!.session.file.mtimeMs - e.updatedMs) <= 2);
});

test("materializeConversions: an unchanged file of ours that aged past now - 20 days while waiting is re-clamped (utimes only, no rewrite, no new journal entry)", async () => {
  const e = setup();
  const it = e.item("ses_a", { updatedAt: new Date(Date.now() - 40 * DAY).toISOString() });
  await e.run([it]);
  const n = (await e.journal.readAll()).length;
  const aged = (Date.now() - 25 * DAY) / 1000; // written 20 days back, then waited 5 more days for its import
  utimesSync(target(it), aged, aged);
  const before = readFileSync(target(it));
  const r = await e.run([it], "run-2");
  assert.deepEqual(r.written, []);
  assert.deepEqual(r.unchanged, [target(it)]);
  const m = statSync(target(it)).mtimeMs;
  assert.ok(m >= Date.now() - 20 * DAY - 60_000 && m <= Date.now() - 20 * DAY + 60_000, `re-clamped to now - 20 days (${new Date(m).toISOString()})`);
  assert.ok(Math.abs(r.ready[0]!.session.file.mtimeMs - m) <= 2, "the importer sees the re-clamped time");
  assert.deepEqual(readFileSync(target(it)), before, "content untouched");
  assert.equal((await e.journal.readAll()).length, n);
});

const racing = (beforePublish: (target: string) => Promise<void>): MaterializeFs => ({ link, unlink, rename, beforePublish });
const tmpLeft = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith(".tmp"));
const FOREIGN = "a writer got here first\n";

test("materializeConversions: a file that appears at the target between the check and the publish is never replaced (link, EEXIST -> target-exists)", async () => {
  const e = setup();
  const it = e.item("ses_a");
  const r = await e.run([it], "run-1", racing(async (t) => { writeFileSync(t, FOREIGN); }));
  assert.deepEqual(r.failed.map((f) => f.reason), ["target-exists"]);
  assert.deepEqual(r.written, []);
  assert.equal(readFileSync(target(it), "utf8"), FOREIGN);
  assert.deepEqual(tmpLeft(path.dirname(target(it))), [], "temp file removed");
  // Next run: the journal has an entry for that path, but the file is not ours (first record) -> still target-exists.
  const again = await e.run([it], "run-2");
  assert.deepEqual(again.failed.map((f) => f.reason), ["target-exists"]);
  assert.equal(readFileSync(target(it), "utf8"), FOREIGN);
});

test("materializeConversions: a refresh of our own file is skipped when it changes right before the replace (re-hash) or is in use", async () => {
  const e = setup();
  const it = e.item("ses_a");
  await e.run([it]);
  (e.transcripts.get("ses_a") as CanonicalTranscript).messages.push({ role: "user", text: "more in OpenCode", timestamp: "2026-01-01T00:00:09Z" });
  const r = await e.run([it], "run-2", racing(async (t) => { appendFileSync(t, `{"type":"last-prompt","leafUuid":"x"}\n`); }));
  assert.deepEqual(r.written, []);
  assert.deepEqual(r.resumed, [target(it)]);
  assert.match(readFileSync(target(it), "utf8"), /last-prompt/, "the resumed file is left as it is");
  assert.doesNotMatch(readFileSync(target(it), "utf8"), /more in OpenCode/);
  assert.deepEqual(tmpLeft(path.dirname(target(it))), []);

  // In use (mtime within the active window): never refreshed either.
  const e2 = setup();
  const it2 = e2.item("ses_b");
  await e2.run([it2]);
  (e2.transcripts.get("ses_b") as CanonicalTranscript).messages.push({ role: "user", text: "more", timestamp: "2026-01-01T00:00:09Z" });
  const nowS = Date.now() / 1000;
  utimesSync(target(it2), nowS, nowS);
  const r2 = await e2.run([it2], "run-2");
  assert.deepEqual(r2.written, []);
  assert.deepEqual(r2.resumed, [target(it2)]);
});

test("materializeConversions: a busy source or a session in use is deferred (no failure, nothing written or journaled)", async () => {
  const e = setup();
  const busy = e.item("ses_busy");
  const live = e.item("ses_live");
  e.transcripts.set("ses_busy", new SourceBusyError("kept changing"));
  e.transcripts.set("ses_live", new SessionActiveError("in use"));
  const r = await e.run([busy, live]);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.deferred.map((d) => [d.item.session.nativeId, d.reason]), [["ses_busy", "source-busy"], ["ses_live", "active"]]);
  assert.deepEqual(fileWritten(await e.journal.readAll()), []);
  assert.ok(!existsSync(target(busy)) && !existsSync(target(live)));
});

test("materializeConversions: the journal and the mtime use the activity the read saw (not the plan's)", async () => {
  const e = setup();
  const it = e.item("ses_a");
  const readAt = new Date(Date.now() - 2 * DAY).toISOString();
  (e.transcripts.get("ses_a") as CanonicalTranscript).activity = { updatedAt: readAt, messageCount: 7 };
  await e.run([it]);
  const fw = fileWritten(await e.journal.readAll())[0]!;
  assert.deepEqual(fw.source, { harness: "opencode", nativeId: "ses_a", updatedAt: readAt, messageCount: 7 });
  assert.equal(fw.mtimeMs, Date.parse(readAt));
  assert.ok(Math.abs(statSync(target(it)).mtimeMs - Date.parse(readAt)) <= 2);
});

test("materializeConversions: a write that is not published gets a compensating file-write-aborted; an aborted refresh is retried, not 'resumed' forever", async () => {
  const e = setup();
  const it = e.item("ses_a");
  await e.run([it], "run-1", racing(async (t) => { writeFileSync(t, FOREIGN); }));
  const es = await e.journal.readAll();
  assert.deepEqual(es.slice(-2).map((x) => x.t), ["file-written", "file-write-aborted"], "the journal never ends with an unpublished write");

  const e2 = setup();
  const it2 = e2.item("ses_b");
  await e2.run([it2]);
  (e2.transcripts.get("ses_b") as CanonicalTranscript).messages.push({ role: "user", text: "more in OpenCode", timestamp: "2026-01-01T00:00:09Z" });
  // The refresh is skipped at the last moment: the file looks in use right then (mtime touched to now).
  const r1 = await e2.run([it2], "run-2", racing(async (t) => { const n = Date.now() / 1000; utimesSync(t, n, n); }));
  assert.deepEqual(r1.written, []);
  assert.deepEqual((await e2.journal.readAll()).at(-1)!.t, "file-write-aborted");
  // Later it is idle again and unchanged: refreshed, not classed "resumed" forever.
  const old = (Date.now() - DAY) / 1000;
  utimesSync(target(it2), old, old);
  const r2 = await e2.run([it2], "run-3");
  assert.deepEqual(r2.resumed, []);
  assert.deepEqual(r2.written, [target(it2)]);
  assert.match(readFileSync(target(it2), "utf8"), /more in OpenCode/);
});

test("integration: a compressed Codex rollout is discovered, planned convert-import, materialized as a Claude transcript; the next plan handles it (converted, then already-in-t3)", async () => {
  const { zstdCompressSync } = await import("node:zlib");
  const { createCodexAdapter } = await import("../../src/sources/codex.ts");
  const { createClaudeAdapter } = await import("../../src/sources/claude.ts");
  const { buildPlan } = await import("../../src/plan/planner.ts");
  const { defaultConfig } = await import("../../src/core/config.ts");
  const base = mkdtempSync(join(tmpdir(), "t3sm-materialize-cx-"));
  temps.push(base);
  const claudeHome = join(base, ".claude");
  mkdirSync(join(claudeHome, "projects"), { recursive: true });
  const proj = join(base, "proj");
  mkdirSync(proj);
  const day = join(base, ".codex", "sessions", "2026", "01", "02");
  mkdirSync(day, { recursive: true });
  const id = "0190cccc-0000-7000-8000-000000000001";
  const at = (s: number) => new Date(Date.now() - 3 * DAY + s * 1000).toISOString();
  const recs = [
    { timestamp: at(0), type: "session_meta", payload: { id, cwd: proj } },
    { timestamp: at(1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "synthetic question" }] } },
    { timestamp: at(2), type: "response_item", payload: { type: "function_call", call_id: "c1", name: "shell", arguments: "{\"command\":\"ls\"}" } },
    { timestamp: at(3), type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "a.txt" } },
    { timestamp: at(4), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "one file" }] } },
  ];
  const zst = join(day, `rollout-2026-01-02T00-00-00-${id}.jsonl.zst`);
  writeFileSync(zst, zstdCompressSync(Buffer.from(recs.map((r) => JSON.stringify(r)).join("\n") + "\n")));
  const old = (Date.now() - 3 * DAY) / 1000;
  utimesSync(zst, old, old);
  const zstBefore = readFileSync(zst);

  const accounts: AccountConfig[] = [{ id: "claudeAgent", home: claudeHome, displayName: "Personal", accentColor: null }];
  const config = defaultConfig(accounts);
  const env = { home: base, platform: process.platform, now: Date.now, config, stateDir: join(base, "state"), env: {} };
  const codex = createCodexAdapter();
  const discovered: DiscoveredSession[] = [];
  for await (const s of codex.discover(env)) discovered.push(s);
  assert.equal(discovered.length, 1);
  const instance = { id: "claudeAgent", driver: "claudeAgent" as const, displayName: "Personal", accentColor: null, homePath: claudeHome, environment: [] };
  const planOf = async (sessions: DiscoveredSession[], journal: JournalEntry[], threads: { id: string }[]) => buildPlan({
    sessions, config, journal, now: Date.now(), runId: "r", home: base,
    t3: { version: "0.1.9", projects: [], threads: threads.map((t) => ({ ...t, projectId: "p", instanceId: "claudeAgent", archived: false, title: "t" })), instances: [instance], providers: [] },
    existsDir: async (d) => { try { return statSync(d).isDirectory(); } catch { return false; } },
    readVscodePin: async () => null,
  });
  const p1 = await planOf(discovered, [], []);
  const it = p1.items[0]!;
  assert.equal(it.action.kind, "convert-import", JSON.stringify(it.action));
  if (it.action.kind !== "convert-import") return;
  assert.equal(it.action.uuid, uuidV5(`codex:${id}`));

  const journal = new Journal(join(base, "state", "journal.jsonl"));
  const r = await materializeConversions(p1.items, new Map<HarnessId, SourceAdapter>([["codex", codex]]), accounts, journal, "run-1");
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.written, [it.action.targetFile]);
  const lines = readFileSync(it.action.targetFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { message: { content: unknown } });
  assert.match(lines[0]!.message.content as string, new RegExp(`^Imported from codex session ${id} `));
  assert.deepEqual(lines.slice(1).map((l) => l.message.content), ["synthetic question", [{ type: "text", text: "[tool shell] ls → a.txt\n\none file" }]]);
  assert.deepEqual(readFileSync(zst), zstBefore, "the Codex file is never modified");
  assert.ok(Math.abs(statSync(zst).mtimeMs - old * 1000) <= 2, "nor its time");

  // Next plan: the converted file is rediscovered by the Claude adapter but never as a second session.
  const claude = createClaudeAdapter();
  const again: DiscoveredSession[] = [...discovered];
  for await (const s of claude.discover(env)) again.push(s);
  assert.equal(again.length, 2);
  const es = await journal.readAll();
  const p2 = await planOf(again, es, []);
  assert.deepEqual(p2.items.filter((i) => i.action.kind !== "skip").map((i) => i.session.harness), ["codex"]);
  assert.deepEqual(p2.items.find((i) => i.session.harness === "claude")!.action, { kind: "skip", reason: "converted" });
  const p3 = await planOf(again, es, [{ id: it.action.expectedThreadId }]);
  assert.deepEqual(p3.items.map((i) => i.action), [{ kind: "skip", reason: "already-in-t3" }, { kind: "skip", reason: "already-in-t3" }]);
});

test("B3: a converted transcript never gets a time older than now - 20 days (Claude Code's cleanup zone); a future activity time is now; the chosen time is journaled", async () => {
  const { writtenMtime, WRITTEN_MAX_AGE_MS } = await import("../../src/apply/materialize.ts");
  const now = Date.parse("2026-11-11T12:00:00.000Z");
  assert.equal(WRITTEN_MAX_AGE_MS, 20 * DAY);
  assert.equal(writtenMtime(now - 3 * DAY, now), now - 3 * DAY);
  assert.equal(writtenMtime(now - 60 * DAY, now), now - 20 * DAY);
  assert.equal(writtenMtime(now + DAY, now), now);
  const e = setup();
  const old = new Date(Date.now() - 90 * DAY).toISOString();
  const it = e.item("ses_old", { updatedAt: old });
  await e.run([it]);
  const fw = fileWritten(await e.journal.readAll())[0]!;
  const st = statSync(target(it)).mtimeMs;
  assert.ok(Math.abs(Date.now() - 20 * DAY - st) < 60_000, `clamped to now - 20 days (${new Date(st).toISOString()})`);
  assert.ok(Math.abs(fw.mtimeMs! - st) <= 2, "the journal carries the chosen time");
  assert.equal(fw.source!.updatedAt, old, "the source's real activity is still recorded");
});
