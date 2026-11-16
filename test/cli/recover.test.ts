// `t3sm recover <id>`: a conversation started in T3 Code whose thread is gone, brought back as a faithful copy with a new
// id (planned under the lock, written and imported by apply, journaled, rolled back). Fake T3 Code, a temp home and
// synthetic transcripts (invented text, `<home>/work/demo`) only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recoverCommand, type RecoverDeps } from "../../src/cli/commands/recover.ts";
import { rollbackCommand } from "../../src/cli/commands/rollback.ts";
import { planCommand } from "../../src/cli/commands/plan.ts";
import { statusCommand } from "../../src/cli/commands/status.ts";
import type { Plan } from "../../src/core/types.ts";
import { main, type Io } from "../../src/cli/main.ts";
import { Journal } from "../../src/core/journal.ts";
import { encodeClaudeProjectDir, normalizeCwd } from "../../src/core/paths.ts";
import { uuidV5 } from "../../src/core/uuid.ts";
import type { SignalSource } from "../../src/apply/apply.ts";
import { DAY, fakeT3, inst, tempHome, type FakeT3 } from "../apply/fake-t3.ts";

const NATIVE = "4a1b2c3d-1111-4222-8333-444444444444";
const OTHER = "5b2c3d4e-1111-4222-8333-444444444444";
const LIVE = "6c3d4e5f-1111-4222-8333-444444444444";

class NoSignals implements SignalSource { on(): void {} off(): void {} }

interface World { home: string; state: string; demo: string; f: FakeT3; copy: string; copyId: string; deps: RecoverDeps }

/** demo holds three Claude conversations 3 days old: NATIVE and LIVE started in T3 Code (no thread id in them), OTHER in a terminal. */
function world(): World {
  const t = tempHome();
  const claudeHome = join(t.home, ".claude");
  const f = fakeT3({ instances: [inst("claudeAgent", claudeHome)] });
  // T3 Code's settings name the instance's home, so the plan finds it (no instance to create).
  (f.api as { getConfig: unknown }).getConfig = async () => ({ settings: { providerInstances: { claudeAgent: { driver: "claudeAgent", config: { homePath: claudeHome } } } }, providers: [] });
  const demo = normalizeCwd(join(t.home, "work", "demo"));
  mkdirSync(demo, { recursive: true });
  mkdirSync(t.state, { recursive: true });
  writeFileSync(join(t.state, "config.json"), JSON.stringify({ version: 1, accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }], defaultAccount: "claudeAgent", routes: [] }));
  f.projects.push({ id: "p1", title: "demo", workspaceRoot: demo, defaultModelSelection: null, archived: false, deleted: false, pinned: false, createdAt: null });
  const dir = join(claudeHome, "projects", encodeClaudeProjectDir(demo));
  mkdirSync(dir, { recursive: true });
  const at = Date.now() - 3 * DAY;
  for (const [id, entrypoint] of [[NATIVE, "t3-code"], [OTHER, "cli"], [LIVE, "t3-code"]] as const) {
    const p = join(dir, `${id}.jsonl`);
    writeFileSync(p, JSON.stringify({ parentUuid: null, isSidechain: false, cwd: demo, sessionId: id, type: "user", entrypoint, message: { role: "user", content: "synthetic question" }, uuid: `u-${id.slice(0, 4)}`, timestamp: new Date(at).toISOString() }) + "\n");
    utimesSync(p, at / 1000, at / 1000);
  }
  // T3 Code would import OTHER if it saw it: the run must keep it out (it is exposed, never part of this run).
  f.files.push({ path: join(dir, `${OTHER}.jsonl`), root: demo, threadId: `import:claudeAgent:${OTHER}` });
  // LIVE's thread is still in T3 Code (T3 Code's own record of the session).
  f.threads.set("t3-live", { id: "t3-live", projectId: "p1", instanceId: "claudeAgent", archived: false, title: "Live", nativeSessionId: LIVE, updatedAt: 0 });
  const copyId = uuidV5(`claude-orphan:${NATIVE}`);
  const copy = join(dir, `${copyId}.jsonl`);
  f.files.push({ path: copy, root: demo, threadId: `import:claudeAgent:${copyId}` });
  const deps: RecoverDeps = {
    home: t.home, connect: async () => f.api, signals: new NoSignals(),
    folderEnv: { platform: process.platform, home: t.home, tmpdir: join(t.home, "no-such-tmp"), env: {}, t3BaseDir: join(t.home, ".t3"), t3WorktreesDir: join(t.home, ".t3", "worktrees") },
  };
  return { home: t.home, state: t.state, demo, f, copy, copyId, deps };
}

function io(state: string, o: { isTTY?: boolean; answer?: string; lang?: "en" | "pt" } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const i: Io = {
    stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: o.isTTY ?? false,
    prompt: async (q) => { asked.push(q); return o.answer ?? ""; }, env: { T3SM_HOME: state, LANG: "en_US.UTF-8" }, ...(o.lang ? { lang: o.lang } : {}),
  };
  return { io: i, out: () => out.join("").replace(/\s+/g, " "), err: () => err.join("").replace(/\s+/g, " "), asked };
}

const journal = (state: string) => new Journal(join(state, "journal.jsonl")).readAll();

test("recover --dry-run shows what it would do and the duplicate warning, and writes nothing", async () => {
  const w = world();
  const c = io(w.state);
  assert.equal(await recoverCommand([NATIVE.slice(0, 8), "--dry-run"], c.io, w.deps), 0, c.err());
  assert.match(c.out(), /Bring back a conversation/);
  assert.match(c.out(), new RegExp(`Conversation +demo \\(claude ${NATIVE.slice(0, 8)}\\)`));
  assert.match(c.out(), new RegExp(`New id +${w.copyId}`));
  assert.match(c.out(), /If the thread still exists there, this makes a duplicate\./);
  assert.match(c.out(), new RegExp(`Dry run: nothing written\\. To do it: t3sm recover ${NATIVE}`));
  assert.equal(existsSync(w.copy), false);
  assert.equal(existsSync(join(w.state, "journal.jsonl")), false);
  assert.deepEqual(w.f.calls.filter((x) => x !== "close"), []);
});

test("recover writes asks: without a terminal it needs --yes; on a terminal a no changes nothing", async () => {
  const w = world();
  const c = io(w.state);
  assert.equal(await recoverCommand([NATIVE], c.io, w.deps), 2);
  assert.match(c.err(), /pass --yes/);
  const no = io(w.state, { isTTY: true, answer: "no" });
  assert.equal(await recoverCommand([NATIVE], no.io, w.deps), 0, no.err());
  assert.equal(no.asked.length, 1);
  assert.match(no.asked[0]!, /Bring it back now as a copy\?/);
  assert.match(no.out(), /this makes a duplicate/, "said before the question");
  assert.match(no.out(), /Nothing changed\./);
  assert.equal(existsSync(w.copy), false);
  assert.ok(!(await journal(w.state)).some((e) => e.t === "file-written"));
});

test("recover --yes writes the faithful copy with a new id and imports it (journaled; the other conversations stay out); rollback undoes it", async () => {
  const w = world();
  const c = io(w.state);
  assert.equal(await recoverCommand([NATIVE, "--yes"], c.io, w.deps), 0, c.err() + c.out());
  assert.ok(existsSync(w.copy), "the copy is written");
  const lines = readFileSync(w.copy, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; sessionId?: string; message?: { content: string } });
  const user = lines.filter((l) => l.type === "user");
  assert.deepEqual(user.map((l) => [l.sessionId, l.message?.content]), [[w.copyId, "synthetic question"]], "record by record, under the new id");
  assert.ok(lines.every((l) => l.sessionId === undefined || l.sessionId === w.copyId));
  assert.ok(w.f.threads.has(`import:claudeAgent:${w.copyId}`), "imported into T3 Code");
  assert.ok(!w.f.threads.has(`import:claudeAgent:${OTHER}`), "nothing else was imported");
  const es = await journal(w.state);
  const start = es.find((e) => e.t === "run-start")!;
  assert.equal(start.t === "run-start" && start.command, `recover ${NATIVE}`);
  assert.ok(es.some((e) => e.t === "file-written"));
  assert.match(c.out(), new RegExp(`demo \\(claude ${NATIVE.slice(0, 8)}\\) is back in T3 Code as a new conversation\\. Undo: t3sm rollback --run ${start.runId} --archive-threads`));
  // Twice: the copy is there now.
  const again = io(w.state);
  assert.equal(await recoverCommand([NATIVE, "--yes"], again.io, w.deps), 2);
  assert.match(again.err(), /demo \(claude 4a1b2c3d\) was brought back already: its copy is in T3 Code\. Nothing changed\./);
  // A new plan counts it as in T3 Code (note recovered), and status no longer lists it as started in T3 Code.
  const pl = io(w.state);
  assert.equal(await planCommand(["--json"], pl.io, { home: w.home, connect: async () => w.f.api }), 0, pl.err());
  const planned = (JSON.parse(pl.out()) as Plan).items.find((i) => i.session.nativeId === NATIVE)!;
  assert.deepEqual([planned.action, planned.notes], [{ kind: "skip", reason: "already-in-t3" }, ["recovered"]]);
  const st = io(w.state);
  await statusCommand(["--json"], st.io, { home: w.home, readRuntime: async () => null, pidAlive: () => false });
  const keys = (JSON.parse(st.out()) as { items: { key: string }[] }).items.map((x) => x.key);
  assert.ok(!keys.includes("t3-native-unknown") && !keys.some((k) => k.startsWith("import-failing")), keys.join(", "));
  // Undo.
  const rb = io(w.state);
  assert.equal(await rollbackCommand(["--yes", "--run", start.runId, "--archive-threads"], rb.io, { home: w.home, connect: async () => w.f.api }), 0, rb.err());
  assert.equal(existsSync(w.copy), false, "the copy is deleted");
  assert.equal(w.f.threads.get(`import:claudeAgent:${w.copyId}`)!.archived, true);
});

test("recover refuses, with nothing written: an unknown id, a conversation not started in T3 Code, one T3 Code still holds, a bad id", async () => {
  const w = world();
  for (const [args, re] of [
    [["9f9f9f9f", "--yes"], /No Claude Code conversation on this computer has an id starting with 9f9f9f9f\./],
    [[OTHER, "--yes"], /demo \(claude 5b2c3d4e\) is not a T3 Code conversation; t3sm plan says what happens to it\./],
    [[LIVE, "--yes"], /T3 Code still has demo \(claude 6c3d4e5f\): its thread, or a copy t3sm brought back, is there\./],
  ] as const) {
    const c = io(w.state);
    assert.equal(await recoverCommand([...args], c.io, w.deps), 2, c.out());
    assert.match(c.err(), re);
  }
  for (const [args, re] of [[[], /Name the conversation to bring back/], [["xyz"], /xyz is not a session id/], [[NATIVE, OTHER], /One conversation at a time/], [[NATIVE, "--yes", "--dry-run"], /either --dry-run or --yes/]] as const) {
    const c = io(w.state);
    assert.equal(await recoverCommand([...args], c.io, w.deps), 2);
    assert.match(c.err(), re);
  }
  assert.equal(existsSync(w.copy), false);
  assert.ok(!(await journal(w.state)).some((e) => e.t === "file-written" || e.t === "imported"));
  const pt = io(w.state, { lang: "pt" });
  assert.equal(await recoverCommand([OTHER, "--yes"], pt.io, w.deps), 2);
  assert.match(pt.err(), /não é uma conversa do T3 Code; o t3sm plan diz o que lhe acontece\./);
});

test("t3sm recover is a command: its help in both languages, unknown options refused", async () => {
  const w = world();
  const h = io(w.state);
  assert.equal(await main(["recover", "--help"], h.io), 0);
  assert.match(h.out(), /Usage: t3sm recover <session id> \[--yes \| --dry-run\] \[--allow-untested\]/);
  assert.match(h.out(), /this makes a duplicate/);
  const u = io(w.state);
  assert.equal(await main(["recover", NATIVE, "--nope"], u.io), 2);
  assert.match(u.err(), /Unknown option: --nope/);
});

test("recover refuses an ambiguous short id, and an account without a T3 Code instance", async () => {
  const w = world();
  const dir = join(w.home, ".claude", "projects", encodeClaudeProjectDir(w.demo));
  const twin = "4a1b2c3d-9999-4222-8333-444444444444"; // the same first 8 characters as NATIVE
  const at = Date.now() - 3 * DAY;
  const line = (id: string) => JSON.stringify({ parentUuid: null, isSidechain: false, cwd: w.demo, sessionId: id, type: "user", entrypoint: "t3-code", message: { role: "user", content: "synthetic question" }, uuid: "u-twin", timestamp: new Date(at).toISOString() }) + "\n";
  writeFileSync(join(dir, `${twin}.jsonl`), line(twin));
  utimesSync(join(dir, `${twin}.jsonl`), at / 1000, at / 1000);
  const c = io(w.state);
  assert.equal(await recoverCommand(["4a1b2c3d", "--yes"], c.io, w.deps), 2);
  assert.match(c.err(), /4a1b2c3d starts the ids of 2 conversations: type more of it\./);
  // An account T3 Code has no instance for yet (~/.claude-org): run accounts --apply first.
  const orgId = "7d4e5f60-1111-4222-8333-444444444444";
  writeFileSync(join(w.state, "config.json"), JSON.stringify({ version: 1, accounts: [
    { id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }, { id: "claude-org", home: "~/.claude-org", displayName: "Org", accentColor: null },
  ], defaultAccount: "claudeAgent", routes: [] }));
  const orgDir = join(w.home, ".claude-org", "projects", encodeClaudeProjectDir(w.demo));
  mkdirSync(orgDir, { recursive: true });
  writeFileSync(join(orgDir, `${orgId}.jsonl`), line(orgId));
  utimesSync(join(orgDir, `${orgId}.jsonl`), at / 1000, at / 1000);
  const o = io(w.state);
  assert.equal(await recoverCommand([orgId, "--yes"], o.io, w.deps), 2);
  assert.match(o.err(), /demo \(claude 7d4e5f60\) belongs to an account with no T3 Code instance yet: run t3sm accounts --apply first\./);
  assert.ok(!(await journal(w.state)).some((e) => e.t === "file-written"));
});
