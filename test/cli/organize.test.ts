// `t3sm organize`: the CLI over the organize planner, apply and undo. Fake T3 Code, temp homes and state folders,
// synthetic transcripts (invented text, `<home>/work/...` folders) only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "../../src/cli/main.ts";
import { keepChecked, namesOf, organizeCommand, reviewItems, type OrganizeDeps } from "../../src/cli/commands/organize.ts";
import type { OrganizeKind, OrganizePlan } from "../../src/organize/types.ts";
import type { Term } from "../../src/ui/terminal.ts";
import { acquireLock } from "../../src/core/lock.ts";
import { Journal } from "../../src/core/journal.ts";
import { normalizeCwd } from "../../src/core/paths.ts";
import type { JournalEntry } from "../../src/core/types.ts";
import type { T3Api, T3Project, T3Thread } from "../../src/t3/api.ts";
import { compatGate } from "../../src/t3/compat.ts";
import { T3NotRunning } from "../../src/t3/errors.ts";
import { fakeT3, inst, type FakeT3 } from "../apply/fake-t3.ts";
import { uuid } from "../plan/helpers.ts";

const VERIFIED = "0.1.10-nightly.20261113.4630";
const temps: string[] = [];
after(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

const H1 = uuid(1), A1 = uuid(2), H2 = uuid(3), H3 = uuid(4), GONE = uuid(5);
const tid = (n: string): string => `import:claudeAgent:${n}`;

/** One Claude transcript: a user record carrying session id, folder and entrypoint, then the given user texts. */
function transcript(dir: string, id: string, cwd: string, entrypoint: string, texts: string[]): void {
  const lines = texts.map((text) => JSON.stringify({ type: "user", sessionId: id, cwd, entrypoint, timestamp: "2026-11-10T10:00:00.000Z", message: { role: "user", content: text } }));
  writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
}

interface World {
  home: string; state: string; demo: string; other: string; empty: string; f: FakeT3; journal: Journal;
  deps: (o?: Partial<OrganizeDeps>) => OrganizeDeps; connects: () => number;
}

/**
 * demo (a user project): h1 (technical title), a1 (Agent SDK), h2, a thread with no transcript here, a native thread.
 * other (a user project): h3. empty: a project t3sm created, with no threads. Every imported thread is settled.
 */
function world(o: { version?: string; organize?: Record<string, unknown> } = {}): World {
  const home = mkdtempSync(join(tmpdir(), "t3sm-organize-cli-"));
  temps.push(home);
  const state = join(home, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "config.json"), JSON.stringify({
    version: 1,
    accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }],
    defaultAccount: "claudeAgent", routes: [],
    ...(o.organize ? { organize: o.organize } : {}),
  }, null, 2));
  const demo = normalizeCwd(join(home, "work", "demo"));
  const other = normalizeCwd(join(home, "work", "other"));
  const empty = normalizeCwd(join(home, "work", "empty"));
  const tdir = join(home, ".claude", "projects", "work-demo");
  mkdirSync(tdir, { recursive: true });
  transcript(tdir, H1, demo, "cli", ["<command-name>/clear</command-name>", "Fix the login form"]);
  transcript(tdir, A1, demo, "sdk-ts", ["Summarize this file"]);
  transcript(tdir, H2, demo, "cli", ["Tidy the README"]);
  transcript(tdir, H3, other, "claude-vscode", ["Plan the release"]);

  const f = fakeT3({ version: o.version ?? VERIFIED, instances: [inst("claudeAgent", join(home, ".claude"))] });
  const project = (id: string, root: string, title: string): T3Project =>
    ({ id, title, workspaceRoot: root, defaultModelSelection: null, archived: false, deleted: false, pinned: false, createdAt: null });
  f.projects.push(project("p1", demo, "demo"), project("p2", other, "other"), project("p3", empty, "empty"));
  const thread = (id: string, projectId: string, x: Partial<T3Thread> = {}): T3Thread & { updatedAt: number } => ({
    id, projectId, instanceId: "claudeAgent", archived: false, title: "A tidy title",
    latestUserMessageAt: "2026-11-10T10:00:00.000Z", settledOverride: "settled", settledAt: "2026-11-11T10:00:00.000Z", unsettledAt: null,
    updatedAt: 0, ...x,
  });
  f.threads.set(tid(H1), thread(tid(H1), "p1", { title: "<command-name>/clear</command-name>" }));
  f.threads.set(tid(A1), thread(tid(A1), "p1", { title: "Summarize this file" }));
  f.threads.set(tid(H2), thread(tid(H2), "p1"));
  f.threads.set(tid(GONE), thread(tid(GONE), "p1"));
  f.threads.set("native-1", thread("native-1", "p1", { settledOverride: null, settledAt: null, latestUserMessageAt: "2026-11-12T10:00:00.000Z" }));
  f.threads.set(tid(H3), thread(tid(H3), "p2", { latestUserMessageAt: "2026-11-09T10:00:00.000Z" }));

  const journal = new Journal(join(state, "journal.jsonl"));
  let n = 0;
  const connect = async (_home: string, c: { allowUntested: boolean; onNotice: (l: string) => void }): Promise<T3Api> => {
    n++;
    compatGate(f.api.version, { allowUntested: c.allowUntested, onNotice: c.onNotice }); // as connectT3 does
    return f.api;
  };
  const deps = (x: Partial<OrganizeDeps> = {}): OrganizeDeps => ({
    home, now: () => Date.parse("2026-11-14T12:00:00.000Z"), connect,
    // The temp home lives under os.tmpdir(): classify folders against an unrelated temp dir.
    folderEnv: { platform: process.platform, home, tmpdir: join(home, "no-such-tmp"), env: {}, t3BaseDir: join(home, ".t3"), t3WorktreesDir: join(home, ".t3", "worktrees") },
    ...x,
  });
  return { home, state, demo, other, empty, f, journal, deps, connects: () => n };
}

/** Marks p3 as created by t3sm (an earlier apply run). */
async function createdByT3sm(w: World): Promise<void> {
  await w.journal.append({ t: "run-start", runId: "20261101-100000-aaaa", at: "2026-11-01T10:00:00.000Z", command: "apply" });
  await w.journal.append({ t: "project-created", runId: "20261101-100000-aaaa", projectId: "p3", root: w.empty, title: "empty" });
  await w.journal.append({ t: "run-end", runId: "20261101-100000-aaaa", at: "2026-11-01T10:00:00.000Z", status: "ok" });
}

/** The screen's text on one line (wrapped lines joined), so a sentence matches whatever the width. */
const flat = (s: string): string => s.replace(/\s+/g, " ");

function io(state: string, over: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const answers: string[] = [];
  const i: Io = {
    stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: false,
    prompt: async (q) => { asked.push(q); return answers.shift() ?? ""; }, env: { T3SM_HOME: state, LANG: "en_US.UTF-8" }, ...over,
  };
  return { io: i, out: () => out.join(""), err: () => err.join(""), asked, answers };
}

const writes = (f: FakeT3): string[] => f.calls.filter((c) => c !== "close");
const changes = (es: JournalEntry[]) => es.filter((e): e is Extract<JournalEntry, { t: "organize-change" }> => e.t === "organize-change");

test("organize --dry-run prints one line per kind with why and undo, the projects before -> after, and writes nothing", async () => {
  const w = world();
  await createdByT3sm(w);
  const before = readFileSync(w.journal.file, "utf8");
  const c = io(w.state);
  assert.equal(await organizeCommand(["--dry-run"], c.io, w.deps()), 0, c.err());
  const out = flat(c.out());
  // Task 21: one line per kind, and how to undo said once under them (the command whole).
  assert.match(out, /Archive 1 automated conversation \(Agent SDK\) [·-] New titles/);
  assert.match(out, /New titles for 1 conversation \(technical first message\) [·-] /);
  assert.match(out, /Show 4 conversations inside 2 projects \(from the last 90 days; T3 Code's own auto-settle setting does not change\) [·-] /);
  assert.match(out, /Pin 2 projects \(among the 5 with the most recent activity\) [·-] /);
  assert.match(out, /Delete 1 empty project t3sm created \(no conversations\) Every change above can be undone: t3sm organize --undo/);
  assert.equal(c.out().split("t3sm organize --undo").length, 2, "the undo hint once");
  assert.match(c.out(), /^ *t3sm organize --undo$|: t3sm organize --undo$/m, "the command never split");
  // Task 21: the history rule in words, and one before/after table per project.
  assert.match(out, /History: the last 90 days, at least 10 per project/);
  assert.match(c.out(), /^Project +Shown now (→|->) after +Settled +Retitled +Archived$/m);
  assert.match(c.out(), /^demo +1 (→|->) 4 +- +1 +1$/m);
  assert.match(c.out(), /^other +0 (→|->) 1 /m);
  assert.match(out, /Dry run: nothing was changed\. Run `t3sm organize` to do it\./);
  assert.equal(c.err(), "1 imported conversation has no transcript on this machine: treated as started by a person, its title is left as it is.\n");
  assert.deepEqual(writes(w.f), [], "the fake T3 Code saw no write");
  assert.equal(readFileSync(w.journal.file, "utf8"), before, "journal untouched");
  assert.equal(existsSync(join(w.state, "cache")), false, "no discovery cache written");
  assert.equal(w.f.threads.get("native-1")!.settledOverride, null);
});

test("organize without a terminal and without --yes refuses (exit 2) before contacting T3 Code", async () => {
  const w = world();
  const c = io(w.state);
  assert.equal(await organizeCommand([], c.io, w.deps()), 2);
  assert.equal(c.err(), "Refusing to change T3 Code without confirmation: pass --yes (non-interactive).\n");
  assert.equal(w.connects(), 0);
  const u = io(w.state);
  assert.equal(await organizeCommand(["--undo"], u.io, w.deps()), 2);
  assert.equal(u.err(), "Refusing to change T3 Code without confirmation: pass --yes (non-interactive).\n");
  const both = io(w.state);
  assert.equal(await organizeCommand(["--yes", "--dry-run"], both.io, w.deps()), 2);
});

test("organize --undo with no organize run says so and changes nothing", async () => {
  const w = world();
  for (const args of [["--undo", "--yes"], ["--undo", "--dry-run"]]) {
    const c = io(w.state);
    assert.equal(await organizeCommand(args, c.io, w.deps()), 0, c.err());
    assert.match(c.out(), /Nothing to undo: no `t3sm organize` run in the journal\./);
  }
  assert.deepEqual(writes(w.f), []);
  assert.equal(existsSync(w.journal.file), false);
});

test("organize --only <folder> limits the changes to that project's conversations (no pins, no deletes)", async () => {
  const w = world();
  await createdByT3sm(w);
  const d = io(w.state);
  assert.equal(await organizeCommand(["--dry-run", "--only", w.other], d.io, w.deps()), 0, d.err());
  assert.match(d.out(), /Show 1 conversation inside 1 project/);
  assert.doesNotMatch(d.out(), /Archive \d|Pin \d|Delete \d|New titles/);

  const c = io(w.state);
  assert.equal(await organizeCommand(["--yes", "--only", w.other], c.io, w.deps()), 0, c.err());
  assert.deepEqual(writes(w.f), [`unsettle:${tid(H3)}`]);
  const bad = io(w.state);
  assert.equal(await organizeCommand(["--dry-run", "--only", join(w.home, "work", "nowhere")], bad.io, w.deps()), 2);
  assert.match(bad.err(), /not a T3 Code project/);
});

test("organize --yes applies, journals each change, names the run; organize --undo --yes puts everything back", async () => {
  const w = world();
  await createdByT3sm(w);
  const c = io(w.state);
  assert.equal(await organizeCommand(["--yes"], c.io, w.deps()), 0, c.err());
  assert.equal(w.f.threads.get(tid(A1))!.archived, true);
  assert.equal(w.f.threads.get(tid(H1))!.title, "Fix the login form");
  for (const t of [H1, H2, GONE, H3]) assert.equal(w.f.threads.get(tid(t))!.settledOverride, "active", t);
  assert.equal(w.f.threads.get("native-1")!.settledOverride, null, "a native thread is never touched");
  assert.deepEqual(w.f.projects.filter((p) => p.pinned).map((p) => p.id).sort(), ["p1", "p2"]);
  assert.equal(w.f.projects.find((p) => p.id === "p3")!.deleted, true);
  const es = await w.journal.readAll();
  const runId = changes(es)[0]!.runId;
  assert.equal(changes(es).length, 9);
  assert.equal(es.find((e) => e.t === "run-start" && e.runId === runId && e.command === "organize") !== undefined, true);
  assert.match(c.out(), new RegExp(`Made 9 changes\\. Run ${runId}; undo with \`t3sm organize --undo ${runId}\`\\.`));

  // Nothing left to do: a second organize plans nothing.
  const again = io(w.state);
  assert.equal(await organizeCommand(["--dry-run"], again.io, w.deps()), 0);
  assert.match(again.out(), /Nothing to organize/);

  // --yes never picks the run by itself.
  const unnamed = io(w.state);
  assert.equal(await organizeCommand(["--undo", "--yes"], unnamed.io, w.deps()), 2);
  assert.equal(unnamed.err(), `Refusing to undo without naming the run: pass --undo <run> with --yes (\`t3sm runs\` lists them; the newest organize run is ${runId}).\n`);
  assert.equal(w.f.threads.get(tid(A1))!.archived, true, "nothing reverted");

  const u = io(w.state);
  assert.equal(await organizeCommand(["--undo", runId, "--yes"], u.io, w.deps()), 0, u.err());
  assert.match(u.out(), new RegExp(`Undid organize run ${runId}: 9 changes reverted`));
  // Each revert in words, by title, never by id.
  for (const line of [
    "Unarchive 'Summarize this file' (demo)",
    "Retitle 'Fix the login form' (demo) back to '<command-name>/clear</command-name>'",
    "Put 'A tidy title' (other) away again",
    "Unpin project 'demo'",
    "Re-create project 'empty' (",
  ]) assert.ok(u.out().replace(/\n +/g, " ").includes(line), line);
  assert.doesNotMatch(u.out(), /import:|"/);
  assert.equal(w.f.threads.get(tid(A1))!.archived, false);
  assert.equal(w.f.threads.get(tid(H1))!.title, "<command-name>/clear</command-name>");
  assert.equal(w.f.threads.get(tid(H3))!.settledOverride, "settled");
  assert.deepEqual(w.f.projects.filter((p) => !p.deleted && p.pinned), []);
  assert.ok(w.f.projects.some((p) => !p.deleted && p.workspaceRoot === w.empty), "the deleted project is re-created");

  // The run is undone: --undo has nothing left.
  const twice = io(w.state);
  assert.equal(await organizeCommand(["--undo", runId, "--yes"], twice.io, w.deps()), 0);
  assert.match(twice.out(), new RegExp(`Nothing to undo for run ${runId}\\.`));
  const none = io(w.state);
  assert.equal(await organizeCommand(["--undo", "--yes"], none.io, w.deps()), 0);
  assert.match(none.out(), /Nothing to undo: every `t3sm organize` run is undone already/);
});

test("organize --undo <run> --dry-run lists what would be reverted and writes nothing", async () => {
  const w = world();
  assert.equal(await organizeCommand(["--yes"], io(w.state).io, w.deps()), 0);
  const runId = changes(await w.journal.readAll())[0]!.runId;
  const size = readFileSync(w.journal.file, "utf8").length;
  const callsBefore = writes(w.f).length;
  const c = io(w.state);
  assert.equal(await organizeCommand(["--undo", runId, "--dry-run"], c.io, w.deps()), 0, c.err());
  assert.match(c.out(), new RegExp(`Would revert \\d+ changes of organize run ${runId}`));
  assert.match(c.out(), /Will revert \(8\)\n {2}[-•] Unpin project 'other'\n[\s\S]*\n {2}[-•] Unarchive 'Summarize this file' \(demo\)\n/);
  assert.doesNotMatch(c.out(), /import:/);
  assert.match(c.out(), /Dry run: nothing was changed\./);
  assert.equal(writes(w.f).length, callsBefore);
  assert.equal(readFileSync(w.journal.file, "utf8").length, size);
  const unknown = io(w.state);
  assert.equal(await organizeCommand(["--undo", "20990101-000000-zzzz", "--dry-run"], unknown.io, w.deps()), 2);
  assert.match(unknown.err(), /No run 20990101-000000-zzzz/);
});

test("organize on a terminal shows the summary and asks; anything but yes changes nothing", async () => {
  const w = world();
  const no = io(w.state, { isTTY: true });
  no.answers.push("no");
  assert.equal(await organizeCommand([], no.io, w.deps()), 0);
  assert.deepEqual(no.asked, ["Apply these changes? Type yes to continue: "]);
  assert.match(no.out(), /Archive 1 automated conversation/);
  assert.match(no.out(), /Nothing changed\./);
  assert.deepEqual(writes(w.f), []);

  const yes = io(w.state, { isTTY: true });
  yes.answers.push("yes");
  assert.equal(await organizeCommand([], yes.io, w.deps()), 0);
  assert.equal(w.f.threads.get(tid(A1))!.archived, true);
});

test("organize on an untested T3 Code version proceeds with exactly one warning (ruling R18)", async () => {
  for (const args of [["--dry-run"], ["--yes"]]) {
    const w = world({ version: "0.2.0" });
    const c = io(w.state);
    assert.equal(await organizeCommand(args, c.io, w.deps()), 0, c.err());
    const lines = c.err().split("\n").filter((l) => l.startsWith("Warning") || /untested|not tested/.test(l));
    assert.deepEqual(lines, [
      "Warning: T3 Code 0.2.0 has not been tested with t3sm (tested: 0.1.8-nightly.20261105.4218, 0.1.9-nightly.20261110.4465, 0.1.10-nightly.20261113.4630). Proceeding; every change is journaled and can be undone with t3sm rollback.",
    ], args.join(" "));
  }
  const quiet = world({ version: "0.2.0" });
  const c = io(quiet.state);
  assert.equal(await organizeCommand(["--dry-run", "--allow-untested"], c.io, quiet.deps()), 0);
  assert.doesNotMatch(c.err(), /tested/);
});

test("organize: another run holds the lock -> says so, exits 0, nothing written", async () => {
  const w = world();
  const lock = await acquireLock(w.state);
  assert.ok(lock);
  try {
    const c = io(w.state);
    assert.equal(await organizeCommand(["--yes"], c.io, w.deps()), 0);
    assert.match(c.out(), /Another t3sm run is in progress/);
    assert.deepEqual(writes(w.f), []);
  } finally {
    await lock.release();
  }
});

test("organize: T3 Code not running -> T3NotRunning (exit 3 through main)", async () => {
  const w = world();
  const down = async (): Promise<never> => { throw new T3NotRunning(); };
  await assert.rejects(organizeCommand(["--dry-run"], io(w.state).io, w.deps({ connect: down })), T3NotRunning);
  await assert.rejects(organizeCommand(["--yes"], io(w.state).io, w.deps({ connect: down })), T3NotRunning);
});

test("organize with titles off reads no transcript for titles and plans no title", async () => {
  const w = world({ organize: { titles: false } });
  const c = io(w.state);
  assert.equal(await organizeCommand(["--dry-run"], c.io, w.deps()), 0, c.err());
  assert.doesNotMatch(c.out(), /New titles/);
  assert.match(c.out(), /Archive 1 automated conversation/);
});

test("organize --help lists every flag, examples and what is never touched", async () => {
  const c = io("unused");
  assert.equal(await main(["organize", "--help"], c.io), 0);
  assert.doesNotMatch(c.out(), /import:\*|native thread|default today/);
  for (const s of ["--dry-run", "--yes", "--undo [<run>]", "--only <folder>", "--allow-untested", "--plain", "Examples", "Conversations you started in T3 Code are never touched", "t3sm rollback"]) {
    assert.ok(c.out().includes(s), s);
  }
  const u = io("unused");
  await main(["--help"], u.io);
  assert.match(u.out(), /t3sm organize/);
});

test("summaryLines: mixed reasons are counted, unpin and auto-settle get their own line", async () => {
  const { summaryLines } = await import("../../src/cli/commands/organize.ts");
  const a = (kind: string, reason: string, projectId: string | null = "p1", previous: unknown = false, next: unknown = true) =>
    ({ kind, target: `${kind}-${Math.random()}`, projectId, previous, next, reason }) as never;
  const counts = Object.fromEntries(["archive", "title", "unsettle", "pin", "unpin", "project-delete", "project-title", "auto-settle"].map((k) => [k, 0]));
  const lines = summaryLines({
    runId: "r", counts: counts as never, byProject: [],
    actions: [
      a("archive", "automated session (Agent SDK)"), a("archive", "automated session (Agent SDK)"), a("archive", "temp folder"),
      a("title", "technical title"), a("title", "title set by t3sm earlier"),
      a("unsettle", "history: last 30 days", "p1"), a("unsettle", "history: last 30 days", "p2"),
      a("unpin", "left the top 5 recent", "p9", true, false),
      a("auto-settle", "global auto-settle", null, 7, null),
    ],
  });
  assert.deepEqual(lines, [
    "Archive 3 conversations (2 automated by the Agent SDK, 1 from a temp folder) — undo: t3sm organize --undo",
    "New titles for 2 conversations (1 technical first message, 1 title t3sm set earlier) — undo: t3sm organize --undo",
    "Show 2 conversations inside 2 projects (from the last 30 days; T3 Code's own auto-settle setting does not change) — undo: t3sm organize --undo",
    "Unpin 1 project t3sm pinned (no longer among the 5 with the most recent activity) — undo: t3sm organize --undo",
    "Change T3 Code's auto-settle from 7 days to off — undo: t3sm organize --undo",
  ]);
});

test("summaryLines and reviewItems: the history rule's settles and minimum get their own words", async () => {
  const { summaryLines } = await import("../../src/cli/commands/organize.ts");
  const a = (kind: OrganizeKind, target: string, reason: string, projectId = "p1", previous: unknown = "active", next: unknown = "settled") =>
    ({ kind, target, projectId, previous, next, reason });
  const counts = Object.fromEntries(["archive", "title", "unsettle", "settle", "pin", "unpin", "project-delete", "project-title", "auto-settle"].map((k) => [k, 0]));
  const plan = {
    runId: "r", counts, byProject: [],
    actions: [
      a("unsettle", "t1", "history: last 90 days", "p1", "settled", "active"), a("unsettle", "t2", "history: at least 10 per project", "p2", "settled", "active"),
      a("settle", "t3", "history: older than 90 days", "p1"), a("settle", "t4", "history: older than 90 days", "p2", null, { settledAt: "2026-01-01T00:00:00.000Z" }),
    ],
  } as unknown as OrganizePlan;
  assert.deepEqual(summaryLines(plan), [
    "Show 2 conversations inside 2 projects (from the last 90 days, so each project shows at least 10; T3 Code's own auto-settle setting does not change) — undo: t3sm organize --undo",
    "Settle 2 conversations in 2 projects (no activity in the last 90 days; they stay in their project, on its Settled shelf) — undo: t3sm organize --undo",
  ]);
  const items = reviewItems(plan, namesOf([], [], "/h"));
  assert.deepEqual(items.map((i) => [i.meta, i.detail]), [
    ["show", "from the last 90 days"], ["show", "so each project shows at least 10"],
    ["settle", "no activity in the last 90 days"], ["settle", "no activity in the last 90 days"],
  ]);
  assert.equal(items[2]!.label, "Settle a conversation no longer in T3 Code (it stays in its project, on the Settled shelf)");
});

test("organize --undo names what it leaves alone by title: a conversation the user renamed since", async () => {
  const w = world();
  assert.equal(await organizeCommand(["--yes"], io(w.state).io, w.deps()), 0);
  const runId = changes(await w.journal.readAll())[0]!.runId;
  w.f.threads.get(tid(H1))!.title = "My own title";
  const c = io(w.state, { isTTY: true });
  c.answers.push("no");
  assert.equal(await organizeCommand(["--undo"], c.io, w.deps()), 0, c.err());
  assert.deepEqual(c.asked, [`Undo organize run ${runId}? Type yes to continue: `]);
  assert.match(c.out().replace(/\x1b\[[0-9;]*m/g, ""), /Left alone, changed in T3 Code since t3sm made them \(1\)\n {2}[-•] 'My own title' \(demo\): changed in T3 Code since t3sm's change/);
  assert.match(c.out(), /Nothing changed\./);
});

// ---------- untrusted text never reaches the terminal raw (security review) ----------

const ESC_TITLE = "Fix \u001b[31mred\u001b[0m \u001b]8;;http://x\u0007link\u001b]8;;\u0007";
const ESC_ERROR = "refused \u001b[31mloudly\u001b]8;;http://x\u0007";
const raw = (s: string): boolean => /[\u001b\u0007\u009b]/.test(s);

test("organize: titles, project names, errors and notes with terminal escapes are printed without ESC/BEL (summary, failures, undo)", async () => {
  const w = world();
  w.f.projects.find((p) => p.id === "p1")!.title = `demo ${ESC_TITLE}`;
  w.f.threads.get(tid(A1))!.title = ESC_TITLE;
  w.f.opts.writeError = (call) => (call.startsWith("unsettle:") ? { error: new Error(ESC_ERROR) } : undefined);
  const c = io(w.state);
  assert.equal(await organizeCommand(["--yes"], c.io, w.deps()), 5);
  assert.match(c.out(), /^Project +Shown now (→|->) after/m);
  // Task 21: the failures as a table (the change, why), the hostile text cleaned.
  assert.match(c.out(), /^[✗x] 4 changes could not be made$/m);
  assert.match(c.out(), /^Show '.*  refused /m);
  assert.equal(raw(c.out() + c.err()), false, JSON.stringify(c.out()));

  const runId = changes(await w.journal.readAll())[0]!.runId;
  w.f.opts.writeError = (call) => (call.startsWith("unarchive:") ? { error: new Error(ESC_ERROR) } : undefined);
  const u = io(w.state);
  assert.equal(await organizeCommand(["--undo", runId, "--yes"], u.io, w.deps()), 5);
  assert.match(u.out().replace(/\n +/g, " "), /Could not revert \(1\) [-•] Unarchive 'Fix \[31mred\[0m \]8;;http:\/\/xlink\]8;;' \(demo .*\): refused/);
  assert.equal(raw(u.out() + u.err()), false, JSON.stringify(u.out()));

  const d = io(w.state);
  await organizeCommand(["--undo", runId, "--dry-run"], d.io, w.deps());
  assert.equal(raw(d.out() + d.err()), false);
});

// ---------------- interactive review ("d = details", ruling R3) ----------------

/** A terminal whose keys arrive right after the list first draws; `frames` collects what it wrote. */
function scriptedTerm(keys: { name: string; ch?: string }[]): { term: Term; frames: string[] } {
  const frames: string[] = [];
  const term: Term = {
    isTTY: true, columns: 100, rows: 40, color: false, unicode: false,
    write: (s) => void frames.push(s),
    onKey: (cb) => {
      queueMicrotask(() => { for (const k of keys) cb({ name: k.name, ch: k.ch ?? "", ctrl: false, meta: false }); });
      return () => {};
    },
    setRaw: () => {},
    readLine: async () => null,
  };
  return { term, frames };
}

test("organize on a terminal: d opens the review list and an unchecked change is not applied", async () => {
  const w = world();
  await createdByT3sm(w);
  // The list is grouped by kind: the first line is the archive of the Agent SDK conversation. Uncheck it, then confirm.
  const t = scriptedTerm([{ name: "space", ch: " " }, { name: "return" }]);
  const c = io(w.state, { isTTY: true });
  c.answers.push("d", "yes");
  assert.equal(await organizeCommand([], c.io, w.deps({ term: t.term })), 0, c.err());
  assert.deepEqual(c.asked, ["Apply these changes? Type yes to continue, or d for details: ", "Apply these changes? Type yes to continue, or d for details: "]);
  const screen = t.frames.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(screen, /> \[x\] Archive 'Summarize this file' \(demo\) +archive/);
  assert.match(screen, /automated conversation/);
  assert.match(screen, /\[x\] Retitle '<command-name>\/clear<\/command-name>' \(demo\) to 'Fix the login form'/);
  assert.match(c.out(), /Keeping 8 changes of 9\./);
  assert.doesNotMatch(c.out().split("Keeping")[1]!, /Archive/, "the reduced summary has no archive line");
  assert.equal(w.f.threads.get(tid(A1))!.archived, false, "the unchecked archive was not applied");
  assert.equal(w.f.threads.get(tid(H1))!.title, "Fix the login form", "the rest was");
  const done = changes(await w.journal.readAll());
  assert.equal(done.some((e) => e.kind === "archive"), false, "and is not in the journal");
  assert.equal(done.length, 8);
  assert.match(c.out(), /Made 8 changes\./);
});

test("organize on a terminal: cancelling the list changes nothing in the plan; unchecking everything applies nothing", async () => {
  const w = world();
  const t = scriptedTerm([{ name: "escape" }]);
  const c = io(w.state, { isTTY: true });
  c.answers.push("d", "no");
  assert.equal(await organizeCommand([], c.io, w.deps({ term: t.term })), 0, c.err());
  assert.match(c.out(), /Nothing changed\./);
  assert.deepEqual(writes(w.f), []);

  const all = scriptedTerm([{ name: "n", ch: "n" }, { name: "return" }]);
  const d = io(w.state, { isTTY: true });
  d.answers.push("d");
  assert.equal(await organizeCommand([], d.io, w.deps({ term: all.term })), 0, d.err());
  assert.match(d.out(), /Keeping 0 changes of \d+\.\nNothing left to apply\.\nNothing changed\./);
  assert.deepEqual(writes(w.f), []);
});

test("organize --plain or without a terminal keeps the plain question and never offers the list", async () => {
  const w = world();
  const t = scriptedTerm([]);
  const plain = io(w.state, { isTTY: true });
  plain.answers.push("no");
  assert.equal(await organizeCommand(["--plain"], plain.io, w.deps({ term: t.term })), 0);
  assert.deepEqual(plain.asked, ["Apply these changes? Type yes to continue: "]);
  assert.deepEqual(t.frames, []);
  const notTty = io(w.state, { isTTY: true });
  notTty.answers.push("no");
  assert.equal(await organizeCommand([], notTty.io, w.deps({ term: { ...t.term, isTTY: false } })), 0);
  assert.deepEqual(notTty.asked, ["Apply these changes? Type yes to continue: "]);
});

test("reviewItems groups by kind with the human sentence; keepChecked drops the unchecked actions and recounts", () => {
  const act = (kind: OrganizeKind, target: string, next: unknown = null, reason = "x") => ({ kind, target, projectId: "p1", previous: null, next, reason });
  const names = namesOf([], [], "/h");
  const plan = {
    runId: "r", byProject: [], counts: { archive: 2, title: 1, unsettle: 0, pin: 1, unpin: 0, "project-delete": 0, "project-title": 0, "auto-settle": 0 },
    actions: [act("pin", "p1"), act("archive", "t1", true, "automated session (Agent SDK)"), act("title", "t2", "New"), act("archive", "t3", true, "temp folder")],
  } as unknown as OrganizePlan;
  const items = reviewItems(plan, names);
  assert.deepEqual(items.map((i) => [i.id, i.meta, i.checked]), [["1", "archive", true], ["3", "archive", true], ["2", "retitle", true], ["0", "pin", true]]);
  assert.equal(items[0]!.label, "Archive a conversation no longer in T3 Code");
  assert.equal(items[0]!.detail, "automated conversation");
  items[1]!.checked = false;
  items[3]!.checked = false;
  const kept = keepChecked(plan, items);
  assert.deepEqual(kept.actions.map((a) => a.target), ["t1", "t2"]);
  assert.deepEqual([kept.counts.archive, kept.counts.title, kept.counts.pin], [1, 1, 0]);
  assert.equal(plan.actions.length, 4, "the input plan is untouched");
});

test("organize --auto-settle off / --no-delete / --no-pin: the asked parts are left out, auto-settle is planned and journaled", async () => {
  const w = world();
  await createdByT3sm(w);
  const d = io(w.state);
  assert.equal(await organizeCommand(["--dry-run", "--auto-settle", "off", "--no-delete", "--no-pin", "p1"], d.io, w.deps()), 0, d.err());
  assert.match(d.out(), /Pin 1 project \(/);
  assert.match(d.out(), /Change T3 Code's auto-settle from 7 days to off/);
  assert.doesNotMatch(d.out(), /Delete/);
  assert.deepEqual(writes(w.f), []);

  const c = io(w.state);
  assert.equal(await organizeCommand(["--yes", "--auto-settle", "off", "--no-delete", "--no-pin", "p1,p9"], c.io, w.deps()), 0, c.err());
  assert.equal(w.f.autoSettleDays, null);
  assert.deepEqual(w.f.projects.filter((p) => p.pinned).map((p) => p.id), ["p2"]);
  assert.equal(w.f.projects.find((p) => p.id === "p3")!.deleted, false, "--no-delete");
  assert.ok(changes(await w.journal.readAll()).some((e) => e.kind === "auto-settle" && e.previous === 7 && e.next === null));

  const bad = io(w.state);
  assert.equal(await organizeCommand(["--dry-run", "--auto-settle", "91"], bad.io, w.deps()), 2);
  assert.match(bad.err(), /--auto-settle takes a number of days from 1 to 90, or off/);
  const noIds = io(w.state);
  assert.equal(await organizeCommand(["--dry-run", "--no-pin"], noIds.io, w.deps()), 2);
  const undoMix = io(w.state);
  assert.equal(await organizeCommand(["--undo", "--no-delete"], undoMix.io, w.deps()), 2);
});

test("buildOrganize (the assistant's read-only preview) returns the plan with T3's threads, projects and auto-settle", async () => {
  const w = world();
  await createdByT3sm(w);
  const { buildOrganize } = await import("../../src/cli/commands/organize.ts");
  const { loadConfig } = await import("../../src/core/config.ts");
  const config = (await loadConfig(w.state, w.home))!;
  const b = await buildOrganize(w.f.api, w.journal, config, { only: null, dryRun: true }, io(w.state).io, w.deps(), w.home, () => Date.parse("2026-11-14T12:00:00.000Z"));
  assert.equal(b.plan.counts.archive, 1);
  assert.equal(b.projects.length, 3);
  assert.ok(b.threads.some((t) => t.id === tid(H1)));
  assert.equal(b.autoSettleDays, 7);
  assert.deepEqual(writes(w.f), [], "read only");
});

test("buildOrganize with offerAll plans a part config.json turned off, and says which are off", async () => {
  const w = world({ organize: { titles: false, archiveAutomated: false } });
  await createdByT3sm(w);
  const { buildOrganize } = await import("../../src/cli/commands/organize.ts");
  const { loadConfig } = await import("../../src/core/config.ts");
  const config = (await loadConfig(w.state, w.home))!;
  const run = (offerAll: boolean) => buildOrganize(w.f.api, w.journal, config, { only: null, dryRun: true, offerAll }, io(w.state).io, w.deps(), w.home, () => Date.parse("2026-11-14T12:00:00.000Z"));
  const asSaved = await run(false);
  assert.equal(asSaved.plan.counts.title + asSaved.plan.counts.archive, 0);
  const all = await run(true);
  assert.equal(all.plan.counts.archive, 1);
  assert.ok(all.plan.counts.title >= 1);
  assert.deepEqual(all.off, { history: false, titles: true, archiveAutomated: true, pinRecent: false });
});

test("organize --undo <sync run> that also imported: exit 2 with the rollback hint, before connecting; nothing written", async () => {
  const w = world();
  const run = "20261114-100000-sync";
  await w.journal.append({ t: "run-start", runId: run, at: "2026-11-14T10:00:00.000Z", command: `sync ${run}` });
  await w.journal.append({ t: "imported", runId: run, harness: "claude", nativeId: H1, threadId: tid(H1), source: { path: join(w.home, "x.jsonl"), size: 1, mtimeMs: 1 } });
  await w.journal.append({ t: "organize-change", runId: run, kind: "archive", target: tid(A1), previous: false, next: true });
  await w.journal.append({ t: "run-end", runId: run, at: "2026-11-14T10:00:00.000Z", status: "ok" });
  const size = readFileSync(w.journal.file, "utf8").length;
  for (const args of [["--undo", run, "--yes"], ["--undo", run, "--dry-run"]]) {
    const c = io(w.state);
    assert.equal(await organizeCommand(args, c.io, w.deps()), 2, args.join(" "));
    assert.equal(c.err(), `This run also imported conversations; use \`t3sm rollback --run ${run}\` to undo all of it.\n`);
  }
  assert.equal(w.connects(), 0);
  assert.equal(readFileSync(w.journal.file, "utf8").length, size);
});

test("organize uses the platform it is given (deps.platform), not the host's: --only matches folders by that platform's rules", async () => {
  const w = world();
  w.f.projects.push({ id: "p9", title: "Demo", workspaceRoot: "C:/Work/Demo", defaultModelSelection: null, archived: false, deleted: false, pinned: false, createdAt: null });
  const win = io(w.state);
  assert.equal(await organizeCommand(["--dry-run", "--only", "c:/work/demo"], win.io, w.deps({ platform: "win32" })), 0, win.err());
  const linux = io(w.state);
  assert.equal(await organizeCommand(["--dry-run", "--only", "c:/work/demo"], linux.io, w.deps({ platform: "linux" })), 2);
  assert.match(linux.err(), /is not a T3 Code project/);
});

test("organize --auto-settle off on a T3 Code whose auto-settle value t3sm does not know: skipped with a notice; the rest is planned", async () => {
  const w = world();
  w.f.api.getServerSetting = async () => { throw new Error("T3 Code reports an auto-settle value t3sm does not know; t3sm leaves that setting alone"); };
  const d = io(w.state);
  assert.equal(await organizeCommand(["--dry-run", "--auto-settle", "off"], d.io, w.deps()), 0, d.err());
  assert.doesNotMatch(d.out(), /auto-settle from/);
  assert.match(d.out(), /Archive 1 automated conversation/);
  assert.match(d.err(), /T3 Code reports an auto-settle value t3sm does not know; t3sm leaves that setting alone: --auto-settle off is skipped\./);
});

test("organize --no-archive-folders leaves conversations of t3sm projects in temp or system folders alone; not with --undo", async () => {
  const w = world();
  // p3 (t3sm's project) holds one imported human conversation and sits in a temp folder for this test.
  w.f.threads.set(tid(GONE), { ...w.f.threads.get(tid(GONE))!, projectId: "p3" });
  await createdByT3sm(w);
  const tmp = { ...w.deps().folderEnv!, tmpdir: join(w.home, "work") };
  const all = io(w.state);
  assert.equal(await organizeCommand(["--dry-run"], all.io, w.deps({ folderEnv: tmp })), 0, all.err());
  assert.match(all.out(), /1 from a temp folder/);
  const kept = io(w.state);
  assert.equal(await organizeCommand(["--dry-run", "--no-archive-folders"], kept.io, w.deps({ folderEnv: tmp })), 0, kept.err());
  assert.doesNotMatch(kept.out(), /temp folder/);
  assert.match(kept.out(), /Archive 1 automated conversation \(Agent SDK\)/);
  const undo = io(w.state);
  assert.equal(await organizeCommand(["--undo", "--dry-run", "--no-archive-folders"], undo.io, w.deps()), 2);
  assert.match(undo.err(), /--no-archive-folders/);
});

test("organize --help documents --no-archive-folders", async () => {
  const h = io(join(tmpdir(), "t3sm-none"));
  await main(["organize", "--help"], h.io);
  assert.match(h.out(), /--no-archive-folders +Leave the conversations of projects t3sm created in\s+temporary or system folders unarchived/);
});

test("organize: SIGINT, SIGTERM or SIGHUP stops after the current change, journals run-end aborted and exits 130", async () => {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const w = world();
    const handlers = new Map<string, Set<() => void>>();
    const signals = {
      on: (s: string, fn: () => void) => void (handlers.get(s) ?? handlers.set(s, new Set()).get(s)!).add(fn),
      off: (s: string, fn: () => void) => void handlers.get(s)?.delete(fn),
    };
    let sent = false;
    w.f.opts.writeError = () => {
      if (!sent) { sent = true; for (const fn of handlers.get(sig) ?? []) fn(); }
      return undefined;
    };
    const c = io(w.state);
    assert.equal(await organizeCommand(["--yes"], c.io, w.deps({ signals })), 130, sig);
    assert.equal(writes(w.f).length, 1, `${sig}: one change, then stop`);
    const es = await w.journal.readAll();
    assert.equal(changes(es).length, 1);
    assert.deepEqual(es.filter((e) => e.t === "run-end").map((e) => (e as Extract<JournalEntry, { t: "run-end" }>).status), ["aborted"]);
    assert.match(c.err(), /Interrupted/);
    assert.equal([...handlers.values()].reduce((a, s) => a + s.size, 0), 0, "handlers removed");
  }
});

// ---------------- Task 9: --history / --min / --auto-settle <days> ----------------

test("organize --history 30 --min 5 overrides config for this run (config.json untouched)", async () => {
  const w = world({ organize: { history: { days: 1, minPerProject: 0 } } });
  const cfgFile = join(w.state, "config.json");
  const before = readFileSync(cfgFile, "utf8");
  const plain = io(w.state);
  assert.equal(await organizeCommand(["--dry-run"], plain.io, w.deps()), 0, plain.err());
  assert.doesNotMatch(plain.out(), /^Show /m, "the saved rule (1 day, minimum 0) shows nothing");
  const days = io(w.state);
  assert.equal(await organizeCommand(["--dry-run", "--history", "30", "--min", "5"], days.io, w.deps()), 0, days.err());
  assert.match(days.out(), /Show 4 conversations inside 2 projects \(from the last 30 days; /);
  const min = io(w.state);
  assert.equal(await organizeCommand(["--dry-run", "--min", "5"], min.io, w.deps()), 0, min.err());
  assert.match(min.out(), /Show 4 conversations inside 2 projects \(so each project shows at least 5; /, "--min alone keeps the saved days");
  const all = io(w.state);
  assert.equal(await organizeCommand(["--dry-run", "--history", "all"], all.io, w.deps()), 0, all.err());
  assert.match(all.out(), /Show 4 conversations inside 2 projects \(from all of your history; /);
  const off = io(w.state);
  const on = world();
  assert.equal(await organizeCommand(["--dry-run", "--history", "off"], off.io, on.deps()), 0, off.err());
  assert.doesNotMatch(off.out(), /^Show |^Settle /m, "--history off: no history actions");
  assert.equal(readFileSync(cfgFile, "utf8"), before, "the override is for this run only");
  assert.deepEqual(writes(w.f), []);
});

test("organize --history / --min out of range or malformed: exit 2 with a clear message, before contacting T3 Code", async () => {
  const w = world();
  const bad: [string[], RegExp][] = [
    [["--history", "0"], /--history takes a number of days from 1 to 3650, all or off/],
    [["--history", "3651"], /--history takes a number of days from 1 to 3650, all or off/],
    [["--history", "abc"], /--history takes/],
    [["--history", "1.5"], /--history takes/],
    [["--history"], /--history takes/],
    [["--min", "-1"], /--min takes a number from 0 to 1000/],
    [["--min", "1001"], /--min takes a number from 0 to 1000/],
    [["--min", "x"], /--min takes/],
    [["--min"], /--min takes/],
    [["--history", "off", "--min", "3"], /--min does not apply with --history off/],
    [["--undo", "--history", "30"], /do not apply to --undo/],
  ];
  for (const [args, re] of bad) {
    const c = io(w.state);
    assert.equal(await organizeCommand(["--dry-run", ...args], c.io, w.deps()), 2, args.join(" "));
    assert.match(c.err(), re, args.join(" "));
  }
  assert.equal(w.connects(), 0);
});

test("--auto-settle 91 is refused (exit 2), as are 0, abc and a missing value", async () => {
  const w = world();
  for (const v of ["91", "0", "abc", "1.5", undefined]) {
    const c = io(w.state);
    const args = ["--dry-run", "--auto-settle", ...(v === undefined ? [] : [v])];
    assert.equal(await organizeCommand(args, c.io, w.deps()), 2, String(v));
    assert.match(c.err(), /--auto-settle takes a number of days from 1 to 90, or off \(T3 Code accepts nothing else\)/, String(v));
  }
  assert.equal(w.connects(), 0);
  assert.equal(w.f.autoSettleDays, 7);
});

test("--auto-settle 90 sets T3 to 90 (journaled, undone by --undo)", async () => {
  const w = world();
  const d = io(w.state);
  assert.equal(await organizeCommand(["--dry-run", "--auto-settle", "90"], d.io, w.deps()), 0, d.err());
  assert.match(flat(d.out()), /Change T3 Code's auto-settle from 7 days to 90 days Every change above can be undone: t3sm organize --undo/);
  const c = io(w.state);
  assert.equal(await organizeCommand(["--yes", "--auto-settle", "90"], c.io, w.deps()), 0, c.err());
  assert.equal(w.f.autoSettleDays, 90);
  const change = changes(await w.journal.readAll()).find((e) => e.kind === "auto-settle");
  assert.deepEqual([change?.previous, change?.next], [7, 90]);
  const same = io(w.state);
  assert.equal(await organizeCommand(["--dry-run", "--auto-settle", "90"], same.io, w.deps()), 0, same.err());
  assert.doesNotMatch(same.out(), /auto-settle from/, "already 90: nothing planned");
  const u = io(w.state);
  assert.equal(await organizeCommand(["--undo", change!.runId, "--yes"], u.io, w.deps()), 0, u.err());
  assert.equal(w.f.autoSettleDays, 7);
});

test("organize --help documents --history, --min and --auto-settle <1..90|off>", async () => {
  const h = io(join(tmpdir(), "t3sm-none"));
  await main(["organize", "--help"], h.io);
  for (const s of ["--history <days|all|off>", "--min <n>", "--auto-settle <days|off>", "t3sm organize --history 90 --min 10"]) assert.ok(h.out().includes(s), s);
  assert.doesNotMatch(h.out(), /"days:N"/, "the help describes the 0.3 rule");
});
