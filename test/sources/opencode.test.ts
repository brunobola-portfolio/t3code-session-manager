import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createOpenCodeAdapter, openCodeDbPath, takeSnapshot, OPENCODE_QUERIES, OPENCODE_REQUIRED, type OpenCodeAdapter, type OpenCodeAdapterOptions, type Snapshotter } from "../../src/sources/opencode.ts";
import { ACTIVE_WINDOW_MS, HarnessSchemaError, SessionActiveError, SourceBusyError, type Env } from "../../src/sources/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { toClaudeJsonl } from "../../src/apply/claudeWriter.ts";
import type { DiscoveredSession } from "../../src/core/types.ts";
import { MARKERS, OPENCODE_1_19_DDL, T0, TOOL_OUTPUT, buildBulkOpenCodeDb, buildOpenCodeDb } from "../fixtures/opencode/build.ts";

const NOW = T0 + 30 * 86_400_000;
const temps: string[] = [];
after(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

interface Ctx { dir: string; db: string; env: Env; adapter: OpenCodeAdapter }

function setup(o: { ddl?: string[]; wal?: boolean; xdg?: boolean; now?: number; readOnly?: boolean; adapter?: OpenCodeAdapterOptions } = {}): Ctx {
  const dir = mkdtempSync(join(tmpdir(), "t3sm-oc-test-"));
  temps.push(dir);
  const data = o.xdg ? join(dir, "xdg-data") : join(dir, ".local", "share");
  mkdirSync(join(data, "opencode"), { recursive: true });
  const db = join(data, "opencode", "opencode.db");
  buildOpenCodeDb(db, { ddl: o.ddl, wal: o.wal });
  const env: Env = {
    home: dir, platform: process.platform, now: () => o.now ?? NOW, config: defaultConfig([]), stateDir: join(dir, "state"),
    env: o.xdg ? { XDG_DATA_HOME: data } : {}, readOnly: o.readOnly,
  };
  return { dir, db, env, adapter: createOpenCodeAdapter({ snapshotDir: join(dir, "read-snapshots"), ...o.adapter }) };
}

async function collect(a: OpenCodeAdapter, env: Env): Promise<DiscoveredSession[]> {
  const out: DiscoveredSession[] = [];
  for await (const s of a.discover(env)) out.push(s);
  return out;
}

/** Every file under `dir` (recursive). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

/** No secret marker appears in any byte of any file under `dir`. */
function assertNoMarkers(dir: string, extra: string[] = []): void {
  for (const f of filesUnder(dir)) {
    const bytes = readFileSync(f).toString("latin1");
    for (const m of [...Object.values(MARKERS), ...extra]) assert.ok(!bytes.includes(m), `${m} leaked into ${f}`);
  }
}

/** A snapshotter that counts its calls. */
function counting(): { calls: string[]; snapshot: Snapshotter } {
  const calls: string[] = [];
  return { calls, snapshot: (db, dir) => { calls.push(dir); return takeSnapshot(db, dir); } };
}

/** Every file in the OpenCode data dir with its sha256: proves the source is never written. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)) out[f] = createHash("sha256").update(readFileSync(join(dir, f))).digest("hex");
  return out;
}

test("fixture: buildOpenCodeDb commits once (one disk sync per test db, not one per row; slow CI disks timed the file out)", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3sm-oc-fixture-"));
  temps.push(dir);
  // SQLite's file change counter (header bytes 24-27, big-endian) goes up once per committed write transaction.
  const counter = (p: string) => readFileSync(p).readUInt32BE(24);
  buildOpenCodeDb(join(dir, "full.db"));
  assert.equal(counter(join(dir, "full.db")), 1);
  buildOpenCodeDb(join(dir, "drift.db"), { ddl: OPENCODE_1_19_DDL.slice(0, 2) });
  assert.equal(counter(join(dir, "drift.db")), 1);
});

test("openCodeDbPath: ~/.local/share/opencode/opencode.db, or $XDG_DATA_HOME/opencode/opencode.db", () => {
  const base: Env = { home: "/h", platform: "linux", now: () => 0, config: defaultConfig([]), stateDir: "/s", env: {} };
  assert.equal(openCodeDbPath(base).replace(/\\/g, "/"), "/h/.local/share/opencode/opencode.db");
  assert.equal(openCodeDbPath({ ...base, env: { XDG_DATA_HOME: "/x" } }).replace(/\\/g, "/"), "/x/opencode/opencode.db");
});

test("opencode isAvailable: true on the 1.19 schema; false when the db is missing or a required table is absent", async () => {
  const c = setup();
  assert.equal(await c.adapter.isAvailable(c.env), true);
  const x = setup({ xdg: true });
  assert.equal(await x.adapter.isAvailable(x.env), true, "XDG_DATA_HOME honoured");
  rmSync(c.db);
  assert.equal(await c.adapter.isAvailable(c.env), false);
  const drift = setup({ ddl: OPENCODE_1_19_DDL.filter((s) => !/TABLE `part`/.test(s) && !/ON `part`/.test(s)) });
  assert.equal(await drift.adapter.isAvailable(drift.env), false);
});

test("opencode availability: absent / ok / drift / unreadable (doctor warns on the last two)", async () => {
  const c = setup();
  assert.equal(await c.adapter.availability(c.env), "ok");
  const drift = setup({ ddl: OPENCODE_1_19_DDL.filter((s) => !/TABLE `part`/.test(s) && !/ON `part`/.test(s)) });
  const d = await drift.adapter.availability(drift.env);
  assert.ok(typeof d === "object" && "drift" in d && /part/.test(d.drift), JSON.stringify(d));
  const bad = setup();
  writeFileSync(bad.db, "this is not a database, just bytes ".repeat(200));
  const u = await bad.adapter.availability(bad.env);
  assert.ok(typeof u === "object" && "unreadable" in u, JSON.stringify(u));
  rmSync(c.db);
  assert.equal(await c.adapter.availability(c.env), "absent");
});

test("opencode discover: one session per OpenCode session with messages; subagent and hidden ones flagged; empty ones ignored", async () => {
  const c = setup();
  const all = await collect(c.adapter, c.env);
  assert.deepEqual(c.adapter.lastErrors, []);
  assert.deepEqual(all.map((s) => s.nativeId), ["ses_a", "ses_child", "ses_b", "ses_hidden"], "OpenCode creation order; ses_empty ignored");
  assert.deepEqual(all.filter((s) => s.flags.length === 0).map((s) => s.nativeId), ["ses_a", "ses_b"], "two importable sessions");
  const by = new Map(all.map((s) => [s.nativeId, s]));
  assert.deepEqual(by.get("ses_child")!.flags, ["subagent"]);
  assert.deepEqual(by.get("ses_hidden")!.flags, ["only-hidden"]);
  const a = by.get("ses_a")!;
  const st = statSync(c.db);
  assert.deepEqual(a, {
    harness: "opencode", accountId: null, nativeId: "ses_a", cwd: "C:/work/demo",
    startedAt: new Date(T0).toISOString(), updatedAt: new Date(T0 + 40_000).toISOString(),
    messageCount: 4, corruptLines: 0, file: { path: c.db, size: st.size, mtimeMs: st.mtimeMs, atimeMs: a.file.atimeMs }, flags: [], cwdOffsetBytes: 0,
  });
});

test("opencode discover: a session updated within the last 10 minutes is active", async () => {
  const c = setup({ now: T0 + 40_000 + ACTIVE_WINDOW_MS - 1 });
  const a = (await collect(c.adapter, c.env)).find((s) => s.nativeId === "ses_a")!;
  assert.deepEqual(a.flags, ["active"]);
});

test("opencode: never writes to the OpenCode data dir, even in WAL mode with a writer holding uncheckpointed pages; the WAL's rows are seen", async () => {
  const c = setup({ wal: true });
  const writer = new DatabaseSync(c.db);
  try {
    writer.exec("PRAGMA wal_autocheckpoint=0");
    writer.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_wal', 'prj_demo', 's', 'C:/work/demo', 'w', '1.19.5', ?, ?)").run(T0 + 500_000, T0 + 500_000);
    writer.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_w1', 'ses_wal', ?, ?, ?)").run(T0 + 500_000, T0 + 500_000, JSON.stringify({ role: "user", time: { created: T0 + 500_000 } }));
    writer.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_w1', 'msg_w1', 'ses_wal', ?, ?, ?)").run(T0 + 500_000, T0 + 500_000, JSON.stringify({ type: "text", text: "from the WAL" }));
    writer.prepare("INSERT INTO account (id, email, url, access_token, refresh_token, time_created, time_updated) VALUES ('acc_wal', 'w@example.com', 'u', 'MARKER-WAL-ONLY-TOKEN-99aa', 'r', 1, 1)").run();
    const src = join(c.db, "..");
    assert.ok(statSync(`${c.db}-wal`).size > 0, "the rows live only in the WAL");
    const before = fingerprint(src);
    assert.equal(await c.adapter.isAvailable(c.env), true);
    const all = await collect(c.adapter, c.env);
    const wal = all.find((s) => s.nativeId === "ses_wal");
    assert.ok(wal, "a session only in the WAL is discovered");
    const t = await c.adapter.read(wal);
    assert.deepEqual(t.messages.map((m) => m.text), ["from the WAL"]);
    assert.deepEqual(fingerprint(src), before, "db, -wal and -shm byte-identical; no file added");
    assertNoMarkers(c.env.stateDir, ["MARKER-WAL-ONLY-TOKEN-99aa"]);
    assertNoMarkers(join(c.dir, "read-snapshots"), ["MARKER-WAL-ONLY-TOKEN-99aa"]);
  } finally {
    writer.close();
  }
});

test("opencode discover: the snapshot lives in <stateDir>/cache/opencode and is reused while the db is unchanged; readOnly discovery writes no state", async () => {
  const c = setup();
  await collect(c.adapter, c.env);
  const cache = join(c.env.stateDir, "cache", "opencode");
  const first = readdirSync(cache).sort();
  assert.deepEqual(first.filter((f) => !f.endsWith(".db")), ["tmp"], "no -wal/-shm left");
  assert.deepEqual(readdirSync(join(cache, "tmp")), [], "no raw copy left");
  assert.equal(first.filter((f) => f.endsWith(".db")).length, 1);
  const snap = new DatabaseSync(join(cache, first.find((f) => f.endsWith(".db"))!), { readOnly: true });
  try {
    const tables = (snap.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    assert.deepEqual(tables, ["message", "part", "session"], "only what is read; OpenCode's other tables (accounts, credentials) are not kept");
    for (const [t, cols] of Object.entries(OPENCODE_REQUIRED)) {
      assert.deepEqual((snap.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((x) => x.name), [...cols], `${t}: only the columns read`);
    }
  } finally { snap.close(); }
  assertNoMarkers(c.env.stateDir);
  const born = statSync(join(cache, first.find((f) => f.endsWith(".db"))!)).birthtimeMs;
  await collect(c.adapter, c.env);
  assert.deepEqual(readdirSync(cache).sort(), first);
  assert.equal(statSync(join(cache, first.find((f) => f.endsWith(".db"))!)).birthtimeMs, born, "not copied again (same file)");

  const k = counting();
  const ro = setup({ readOnly: true, adapter: { snapshot: k.snapshot } });
  // Only this process's temp snapshots (`t3sm-opencode-<pid>-…`): other test files running at the same time create
  // and remove their own in the same shared tmpdir.
  const mine = (f: string) => f.startsWith(`t3sm-opencode-${process.pid}-`);
  const temps0 = readdirSync(tmpdir()).filter(mine);
  assert.equal(await ro.adapter.isAvailable(ro.env), true);
  assert.equal((await collect(ro.adapter, ro.env)).length, 4);
  assert.equal(k.calls.length, 1, "isAvailable and discover share one temp copy");
  assert.ok(!existsSync(ro.env.stateDir), "sync --dry-run: no state written");
  assert.deepEqual(readdirSync(tmpdir()).filter(mine), temps0, "its temp snapshot is removed");
});

test("opencode read: messages in order; text parts joined; tools flattened (500 chars); reasoning, steps and synthetic text dropped; attachments noted", async () => {
  const c = setup();
  const by = new Map((await collect(c.adapter, c.env)).map((s) => [s.nativeId, s]));
  const t = await c.adapter.read(by.get("ses_a")!);
  assert.equal(t.harness, "opencode");
  assert.equal(t.nativeId, "ses_a");
  assert.equal(t.cwd, "C:/work/demo");
  assert.equal(t.title, "List the files");
  assert.equal(t.startedAt, new Date(T0).toISOString());
  assert.deepEqual(t.activity, { updatedAt: new Date(T0 + 40_000).toISOString(), messageCount: 4 }, "read-time activity, same measure as discovery");
  assert.deepEqual(t.messages.map((m) => [m.role, m.timestamp]), [
    ["user", new Date(T0 + 1000).toISOString()], ["assistant", new Date(T0 + 2000).toISOString()],
    ["user", new Date(T0 + 30_000).toISOString()], ["assistant", new Date(T0 + 40_000).toISOString()],
  ]);
  assert.equal(t.messages[0]!.text, "List the files, please.\n\n[attachment: notes.txt]");
  const [tool, answer] = t.messages[1]!.text.split("\n\n");
  const body = `ls -la → ${TOOL_OUTPUT}`;
  assert.equal(tool, `[tool bash] ${body.slice(0, 500)}…`);
  assert.equal(answer, "There is one file: notas.txt.");
  assert.ok(!t.messages[1]!.text.includes("I should run ls"), "reasoning dropped");
  assert.equal(t.messages[2]!.text, "Thanks!", "synthetic text dropped");
  assert.equal(t.messages[3]!.text, `[tool grep] {"pattern":"TODO","include":"*.ts"} → error: No files found\n\nYou're welcome.`);

  const b = await c.adapter.read(by.get("ses_b")!);
  assert.deepEqual(b.messages.map((m) => m.text), ["Olá: ação, coração, pão 🍞✅", "Tudo certo — ação concluída."]);

  const jsonl = toClaudeJsonl(t, { uuid: "00000000-0000-4000-8000-000000000001", cwd: "C:\\work\\demo" });
  assert.equal(jsonl.text.split("\n").filter(Boolean).length, 5, "converts: provenance + 4 records");
});

test("opencode: schema drift -> HarnessSchemaError in lastErrors (never a crash); read() throws it", async () => {
  const ddl = OPENCODE_1_19_DDL.map((s) => s.replace("`directory` text NOT NULL,", "`dir` text NOT NULL,"));
  const c = setup({ ddl });
  assert.equal(await c.adapter.isAvailable(c.env), false);
  assert.deepEqual(await collect(c.adapter, c.env), []);
  assert.equal(c.adapter.lastErrors.length, 1);
  assert.match(c.adapter.lastErrors[0]!.error, /HarnessSchemaError: .*session.*directory/);
  const fake: DiscoveredSession = {
    harness: "opencode", accountId: null, nativeId: "ses_a", cwd: "C:/work/demo", startedAt: null, updatedAt: new Date(T0).toISOString(),
    messageCount: 1, corruptLines: 0, file: { path: c.db, size: 1, mtimeMs: 1, atimeMs: 1 }, flags: [], cwdOffsetBytes: 0,
  };
  await assert.rejects(c.adapter.read(fake), HarnessSchemaError);
});

test("opencode read: a session that no longer exists is an error naming it", async () => {
  const c = setup();
  const a = (await collect(c.adapter, c.env))[0]!;
  await assert.rejects(c.adapter.read({ ...a, nativeId: "ses_gone" }), /ses_gone/);
});

test("opencode: one snapshot per run: discovery pins it and every read() reuses it, even after the source changed", async () => {
  const k = counting();
  const c = setup({ adapter: { snapshot: k.snapshot } });
  const by = new Map((await collect(c.adapter, c.env)).map((s) => [s.nativeId, s]));
  const w = new DatabaseSync(c.db);
  try { w.prepare("UPDATE part SET data = ? WHERE id = 'prt_b1_00'").run(JSON.stringify({ type: "text", text: "changed after discovery" })); } finally { w.close(); }
  await c.adapter.read(by.get("ses_a")!);
  const b = await c.adapter.read(by.get("ses_b")!);
  assert.equal(k.calls.length, 1);
  assert.equal(b.messages[0]!.text, "Olá: ação, coração, pão 🍞✅", "the run's consistent state");

  const k2 = counting();
  const fresh = createOpenCodeAdapter({ snapshotDir: join(c.dir, "apply-snap"), snapshot: k2.snapshot });
  await fresh.read(by.get("ses_a")!);
  await fresh.read(by.get("ses_b")!);
  assert.equal(k2.calls.length, 1, "without a discovery (apply), the first read pins one");
});

test("opencode: a source that keeps changing -> SourceBusyError (discovery records it; read throws it for deferral)", async () => {
  const busy: Snapshotter = async () => { throw new SourceBusyError("kept changing"); };
  const c = setup({ adapter: { snapshot: busy } });
  assert.deepEqual(await collect(c.adapter, c.env), []);
  assert.match(c.adapter.lastErrors[0]!.error, /^SourceBusyError/);
  const ok = setup();
  const a = (await collect(ok.adapter, ok.env))[0]!;
  await assert.rejects(createOpenCodeAdapter({ snapshot: busy }).read(a), SourceBusyError);
});

test("opencode read: a session updated within ACTIVE_WINDOW_MS at read time -> SessionActiveError", async () => {
  const c = setup();
  const a = (await collect(c.adapter, c.env)).find((s) => s.nativeId === "ses_a")!;
  const live = createOpenCodeAdapter({ snapshotDir: join(c.dir, "s2"), now: () => T0 + 40_000 + 60_000 });
  await assert.rejects(live.read(a), SessionActiveError);
});

test("opencode snapshot: an injected failure mid-way leaves no raw copy and no secret anywhere in the cache; stale leftovers are swept", async () => {
  const c = setup({ wal: true });
  const w = new DatabaseSync(c.db);
  try {
    w.exec("PRAGMA wal_autocheckpoint=0");
    w.prepare("INSERT INTO account (id, email, url, access_token, refresh_token, time_created, time_updated) VALUES ('acc_wal', 'w', 'u', 'MARKER-WAL-ONLY-TOKEN-77bb', 'r', 1, 1)").run();
    const cache = join(c.dir, "cache");
    await assert.rejects(takeSnapshot(c.db, cache, { afterRawCopy: () => { throw new Error("injected"); } }), /injected/);
    assert.deepEqual(readdirSync(join(cache, "tmp")), [], "raw copy and its -wal removed");
    assertNoMarkers(cache, ["MARKER-WAL-ONLY-TOKEN-77bb"]);

    // Crash leftovers: a raw copy of a dead process, and an old one of a live pid.
    writeFileSync(join(cache, "tmp", "raw-2147483646-deadbeef.db"), `leftover ${MARKERS.accessToken}`);
    writeFileSync(join(cache, "tmp", `raw-${process.pid}-0ld0ld.db`), `leftover ${MARKERS.refreshToken}`);
    const old = (Date.now() - 6 * 60_000) / 1000;
    utimesSync(join(cache, "tmp", `raw-${process.pid}-0ld0ld.db`), old, old);
    const s = await takeSnapshot(c.db, cache);
    assert.ok(existsSync(s.path));
    assert.deepEqual(readdirSync(join(cache, "tmp")), [], "swept on entry");
    assertNoMarkers(cache, ["MARKER-WAL-ONLY-TOKEN-77bb"]);
  } finally {
    w.close();
  }
});

test("opencode discover: unknown part types are counted once in lastErrors; the sessions are still discovered", async () => {
  const c = setup();
  const w = new DatabaseSync(c.db);
  try {
    for (const id of ["prt_x1", "prt_x2"]) {
      w.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, 'msg_a1', 'ses_a', 1, 1, ?)").run(id, JSON.stringify({ type: "frobnicate" }));
    }
  } finally { w.close(); }
  const all = await collect(c.adapter, c.env);
  assert.equal(all.length, 4);
  assert.deepEqual(c.adapter.lastErrors.map((e) => e.error), ["opencode: 2 part(s) of unknown type (frobnicate) are left out of conversions"]);
});

test("opencode snapshot: every lookup query is an index search (EXPLAIN QUERY PLAN); only the part-type aggregate scans", async () => {
  const c = setup();
  const s = await takeSnapshot(c.db, join(c.dir, "cache"));
  const db = new DatabaseSync(s.path, { readOnly: true });
  try {
    const plan = (sql: string): string[] => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(sql.includes("?") ? ["ses_a"] : [])) as { detail: string }[]).map((r) => r.detail);
    for (const k of ["sessionById", "partsOfSession", "messagesOfSession"] as const) {
      const d = plan(OPENCODE_QUERIES[k]);
      assert.ok(d.length > 0 && d.every((x) => /^SEARCH /.test(x)), `${k}: ${d.join(" | ")}`);
      assert.ok(!d.some((x) => /USE TEMP B-TREE/.test(x)), `${k} sorts through its index: ${d.join(" | ")}`);
    }
    const sessions = plan(OPENCODE_QUERIES.sessions);
    // The outer loop reads every session (in index order); every correlated subquery must be an index search.
    assert.ok(sessions.some((x) => /^SCAN s USING (COVERING )?INDEX session_created/.test(x)), sessions.join(" | "));
    assert.deepEqual(sessions.filter((x) => /^SCAN /.test(x) && !/^SCAN s USING (COVERING )?INDEX session_created/.test(x)), [], sessions.join(" | "));
    assert.ok(sessions.filter((x) => /^SEARCH (m|p) /.test(x)).length >= 3, sessions.join(" | "));
  } finally {
    db.close();
  }
});

test("opencode perf smoke: 20k parts -> snapshot + discovery + 10 reads in under 2 s", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t3sm-oc-test-"));
  temps.push(dir);
  const data = join(dir, ".local", "share", "opencode");
  mkdirSync(data, { recursive: true });
  buildBulkOpenCodeDb(join(data, "opencode.db"), { sessions: 200, messages: 50, parts: 2 }); // 20 000 parts, 5 000 user messages
  const env: Env = { home: dir, platform: process.platform, now: () => NOW, config: defaultConfig([]), stateDir: join(dir, "state"), env: {} };
  const a = createOpenCodeAdapter();
  const t0 = performance.now();
  const all = await collect(a, env);
  for (const s of all.slice(0, 10)) await a.read(s);
  const ms = performance.now() - t0;
  assert.equal(all.length, 200);
  assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
});

test("opencode snapshot: versioned name; snapshots and temp files of the old format are deleted on entry", async () => {
  const c = setup();
  const cache = join(c.dir, "cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "opencode-0123456789abcdef.db"), `old ${MARKERS.accessToken}`);
  writeFileSync(join(cache, "opencode-0123456789abcdef.db.4242.a1b2c3d4.tmp"), `old ${MARKERS.refreshToken}`);
  const s = await takeSnapshot(c.db, cache);
  assert.match(s.path.split(/[\\/]/).pop()!, /^opencode-s2-[0-9a-f]{16}\.db$/);
  assert.deepEqual(readdirSync(cache).sort(), [s.path.split(/[\\/]/).pop()!, "tmp"].sort());
});

test("opencode snapshot: reuse marks it used (mtime = last use); a reader whose pinned snapshot vanished re-pins once", async () => {
  const c = setup();
  const cache = join(c.dir, "cache");
  const s1 = await takeSnapshot(c.db, cache);
  const old = (Date.now() - 60 * 60_000) / 1000;
  utimesSync(s1.path, old, old);
  const s2 = await takeSnapshot(c.db, cache);
  assert.equal(s2.path, s1.path);
  assert.ok(Date.now() - statSync(s2.path).mtimeMs < 60_000, "touched on reuse");

  const k = counting();
  const a = setup({ adapter: { snapshot: k.snapshot } });
  const ses = (await collect(a.adapter, a.env)).find((x) => x.nativeId === "ses_a")!;
  const pinned = readdirSync(join(a.env.stateDir, "cache", "opencode")).find((f) => f.endsWith(".db"))!;
  rmSync(join(a.env.stateDir, "cache", "opencode", pinned)); // pruned by a concurrent run, say
  const t = await a.adapter.read(ses);
  assert.equal(t.nativeId, "ses_a");
  assert.equal(k.calls.length, 2, "re-pinned once");
});
