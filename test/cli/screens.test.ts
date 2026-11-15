// Task 21: the command screens' behaviour beyond the snapshot matrix (test/ui/screens.test.ts): failures as a table a
// person can act on, no reason codes on screen, help topics instead of a docs file, the error panel, the organize
// preview table, and the import progress (one bar; waves only with --verbose; nothing when silent).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ImportFailure } from "../../src/apply/apply.ts";
import type { Caps } from "../../src/ui/caps.ts";
import { makeCliUi } from "../../src/cli/ui.ts";
import { failureTable, failureWords } from "../../src/cli/failures.ts";
import { HELP_TOPICS, helpTopicFor } from "../../src/cli/helpTopics.ts";
import { importProgress, renderApplyResult } from "../../src/cli/applyScreen.ts";
import { renderError } from "../../src/cli/errors.ts";
import { renderStatus } from "../../src/cli/commands/status.ts";
import { renderTerminalSummary } from "../../src/plan/report.ts";
import { organizePreviewTable } from "../../src/ui/organizePreview.ts";
import { displayWidth } from "../../src/ui/text.ts";
import { makeStyle } from "../../src/ui/style.ts";
import { makeFmt } from "../../src/ui/locale.ts";
import { ConfigError } from "../../src/core/config.ts";
import { RpcClosed, T3NotRunning } from "../../src/t3/errors.ts";
import type { Io } from "../../src/cli/main.ts";
import { FAILURES, NOW, STATUS_NEEDS_YOU, demoPlan, organizePlan, syncOk } from "../ui/screens.commands.ts";
import { renderSyncResult } from "../../src/cli/commands/sync.ts";
import { renderOrganize } from "../../src/cli/commands/organize.ts";
import { failureOf, nameFailures } from "../../src/apply/apply.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PlanItem } from "../../src/core/types.ts";

const caps = (columns: number, unicode = true): Caps => ({ color: 0, unicode, isTTY: false, columns });
const en = (columns = 120, unicode = true) => makeCliUi(caps(columns, unicode), "en", () => NOW);
const pt = (columns = 120) => makeCliUi(caps(columns), "pt", () => NOW);

/** Every reason code an import can fail with (FailReason and ConvertFailReason). */
const REASONS: ImportFailure["reason"][] = [
  "not-imported", "cwd-unreadable-in-t3", "instance-unavailable", "project-mismatch", "no-reader", "target-outside-accounts",
  "target-exists", "read-failed: database is locked", "write-failed: EACCES", "target-folder: it is a temporary folder",
];
const CODE_WORDS = ["not-imported", "cwd-unreadable", "instance-unavailable", "project-mismatch", "no-reader", "target-outside", "target-exists", "read-failed", "write-failed", "target-folder"];

test("apply failure lists project · conversation · why · what to do", () => {
  const lines = failureTable(en(120), FAILURES);
  assert.match(lines[0]!, /^✗ 6 conversations could not be imported$/);
  assert.match(lines[1]!, /^Project +Conversation +Why +What to do$/);
  const row = (project: string, conversation: string, why: string, todo: string): RegExp =>
    new RegExp(`^${project} +${conversation} +${why} +${todo}$`, "m");
  const text = lines.join("\n");
  assert.match(text, row("demo", "Fix the login form", "T3 Code did not import it", "run t3sm apply again"));
  assert.match(text, row("api", "Plan the API", "its folder is unreadable", "resume it in a terminal"));
  assert.match(text, row("app", "untitled conversation", "account off in T3 Code", "turn it on in T3 Code"), "no title: the catalogue's words, never the id");
  assert.doesNotMatch(text, /00000000-0000-4000-8000/, "never a session uuid");
  // One help line naming every topic shown, never a docs file.
  // The topics after one `t3sm help`, separated by commas (an ASCII console would draw "·" as "-", Task 22).
  assert.match(text, /^› More help: t3sm help not-imported, cwd-unreadable, instance-unavailable, project-mismatch, convert$/m);
  assert.equal(text.split("More help").length, 2, "one help line");
  assert.doesNotMatch(text, /troubleshooting/);
  // In Portuguese too.
  const p = failureTable(pt(120), FAILURES).join("\n");
  assert.match(p, /^Projeto +Conversa +Porquê +O que fazer$/m);
  assert.match(p, /conversa sem título/);
  // Below 100 columns (here 80 and 40, English and Portuguese): one entry per conversation, the reason under it, and
  // neither the title nor what to do is ever cut.
  for (const ui of [en(80), en(40, false), pt(80), pt(40)]) {
    const lines2 = failureTable(ui, FAILURES);
    const flat = lines2.join("\n").replace(/\n +/g, " ");
    for (const l of lines2) assert.ok(l.length <= ui.width, `${ui.lang} ${ui.width}: ${l}`);
    assert.doesNotMatch(flat, /…|\.\.\./, `${ui.lang} ${ui.width}: nothing cut`);
    assert.ok(flat.includes("Refactor the billing module and add tests for it"), `${ui.lang} ${ui.width}: the whole title`);
    assert.ok(flat.includes(ui.lang === "en" ? "run t3sm apply again" : "corre t3sm apply outra vez"), `${ui.lang} ${ui.width}: what to do whole`);
    assert.doesNotMatch(lines2.join("\n"), /^(Project|Projeto) +/m, "a list, not a table");
  }
  assert.match(failureTable(en(80), FAILURES).join("\n"), /^app · untitled conversation\n  account off in T3 Code · turn it on in T3 Code$/m);
  const narrow = failureTable(en(40, false), FAILURES).join("\n");
  assert.match(narrow, /^> More help: t3sm help not-imported,\n  cwd-unreadable, instance-unavailable,\n  project-mismatch, convert$/m, "a topic is never split");
  // More than 20: the rest counted, pointing at t3sm runs.
  const many = Array.from({ length: 25 }, (_, i) => ({ ...FAILURES[0]!, nativeId: `id-${i}` }));
  assert.match(failureTable(en(120), many).join("\n"), /… and 5 more \(t3sm runs\)/);
});

test("apply failure: the CLI's result panel then the table, project and title from the failure", () => {
  const out = renderApplyResult(en(120), {
    status: "partial", runId: "r1", imported: 1, failed: 1, converted: 0, deferred: 0, deferredInUse: 0, heldRoots: [], held: [], alreadyInT3: 0,
    restoreErrors: [], unverified: 0, parked: 0, recovered: null,
    failures: [{ harness: "claude", nativeId: "00000000-0000-4000-8000-000000000001", reason: "not-imported", projectRoot: "C:/work/billing", title: "Close the books" }],
  }).join("\n");
  assert.match(out, /^╭─ ! Imported 1, 1 could not be imported ─+╮$/m);
  assert.ok(out.split("\n")[0]!.length < 80, "the panel is as wide as its content, not the window");
  assert.match(out, /^billing +Close the books +T3 Code did not import it +run t3sm apply again$/m);
});

test("no raw reason codes on screen", () => {
  // Every import failure reason has words of its own (never the fallback for a known code) ...
  for (const r of REASONS) assert.notEqual(failureWords(r).why, "fail.why.other", r);
  // ... and the table shows only those words: no code outside the help commands, in either language, at any width.
  const all = REASONS.map((reason, i) => ({ harness: "claude", nativeId: `n${i}`, reason, projectRoot: "C:/work/demo", title: `T${i}` }));
  for (const ui of [en(120), en(80), en(40, false), pt(120), pt(40)]) {
    const t = failureTable(ui, all);
    const shown = t.slice(0, t.findIndex((l) => /help/.test(l))).join("\n");
    for (const c of CODE_WORDS) assert.ok(!shown.includes(c), `${ui.lang} ${ui.width}: ${c} on screen:\n${shown}`);
  }
  // The plan summary names skip reasons and organize questions in words.
  const plan = renderTerminalSummary(demoPlan(), { planPath: "plan.md", ui: en(120) });
  for (const c of ["backup-copy", "cwd-missing", "automated 2", "home 1"]) assert.ok(!plan.includes(c), `${c} in the plan summary`);
  // status names the organize questions in words (its --json keeps the keys).
  const r = STATUS_NEEDS_YOU();
  const status = renderStatus(r, { ui: en(120), now: NOW, version: "0.3.0" });
  assert.ok(!/automated 2|t3-refused 1/.test(status), status);
  assert.match(status, /automated sessions 2, folders T3 Code refuses 1/);
  assert.match(r.items.find((i) => i.key === "undecided")!.text, /\(automated 2, t3-refused 1\)$/, "--json text unchanged");
});

test("helpTopicFor: every reason a screen shows maps to one of the topic constants", () => {
  for (const r of [...REASONS, "convert: no-reader", "orphaned-in-t3", "t3-native-unknown", "undecided", "project-in-use", "watcher", "update-failed", "history: last 90 days", "something new"]) {
    assert.ok((HELP_TOPICS as readonly string[]).includes(helpTopicFor(r)), r);
  }
  assert.equal(helpTopicFor("not-imported"), "not-imported");
  assert.equal(helpTopicFor("cwd-unreadable-in-t3"), "cwd-unreadable");
  assert.equal(helpTopicFor("read-failed: x"), "convert");
  assert.equal(helpTopicFor("orphaned-in-t3"), "orphaned");
  assert.equal(helpTopicFor("t3-native-unknown"), "t3-native");
  assert.equal(helpTopicFor("undecided"), "decisions");
  assert.equal(helpTopicFor("something new"), "errors");
});

test("no string in src points at docs/troubleshooting.md any more", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const src = join(import.meta.dirname, "..", "..", "src");
  const hits = walk(src).filter((f) => f.endsWith(".ts") && readFileSync(f, "utf8").includes("docs/troubleshooting.md"));
  assert.deepEqual(hits, []);
});

test("errors: a panel with what happened, what to do and a command, in the user's language", () => {
  const down = renderError(new T3NotRunning(), en(80), "win32").join("\n");
  assert.match(down, /^╭─ ✗ T3 Code is not running ─+╮$/m);
  assert.match(down, /^│ What to do: Open it from the Start menu and try again\. +│$/m);
  assert.match(down, /^│ › t3sm doctor +│$/m);
  assert.match(renderError(new T3NotRunning(), en(80), "linux").join("\n"), /What to do: Open T3 Code and try again\./);
  const cfg = renderError(new ConfigError("~/.t3code-session-manager/config.json: invalid config:\n  schedule.everyMinutes: must be an integer 1..1440\nFix the file, or delete it to regenerate defaults with `t3sm accounts --init`."), en(80), "win32").join("\n");
  assert.match(cfg, /schedule\.everyMinutes: must be an integer 1\.\.1440/, "the error's own detail");
  assert.match(cfg, /^│   schedule\.everyMinutes: must be an integer 1\.\.1440 +│$/m, "one problem per line, indented as the message indents it");
  assert.match(cfg, /^│ Fix the file, or delete it/m, "the hint starts its own line");
  assert.doesNotMatch(cfg, /`/, "no Markdown backticks in a panel");
  assert.match(cfg, /› t3sm help errors/);
  const lost = renderError(new RpcClosed(), pt(80), "win32").join("\n");
  assert.match(lost, /Sem contacto com o T3 Code/);
  assert.match(lost, /O que fazer: /);
  for (const w of [40, 80]) for (const l of renderError(new Error("x".repeat(300)), en(w, false))) assert.ok(l.length <= w, l);
});

test("organizePreviewTable: one row per project, shown now → after, settled, retitled, archived; the changed projects first", () => {
  const s = makeStyle(caps(100));
  const f = makeFmt("en", () => NOW);
  const a = (kind: "settle" | "title" | "archive", projectId: string, i: number) => ({ kind, target: `${projectId}-${kind}-${i}`, projectId, previous: null, next: true, reason: "" });
  const plan = {
    runId: "r", counts: {} as never,
    actions: [a("settle", "p1", 1), a("settle", "p1", 2), a("title", "p1", 1), a("archive", "p2", 1)],
    byProject: [
      { projectId: "p0", title: "quiet", visibleBefore: 9, visibleAfter: 9 },
      { projectId: "p1", title: "demo", visibleBefore: 12, visibleAfter: 10 },
      { projectId: "p2", title: "app", visibleBefore: 3, visibleAfter: 2 },
    ],
  };
  const words = { project: "Project", visible: "Shown now {to} after", settled: "Settled", retitled: "Retitled", archived: "Archived", more: (n: number) => `and ${n} more` };
  const lines = organizePreviewTable(s, f, plan, words, 100);
  assert.deepEqual(lines.map((l) => l.replace(/ +/g, " ")), [
    "Project Shown now → after Settled Retitled Archived",
    lines[1]!.replace(/ +/g, " "),
    "demo 12 → 10 2 1 -",
    "app 3 → 2 - - 1",
    "quiet 9 → 9 - - -",
  ]);
  const ascii = organizePreviewTable(makeStyle(caps(100, false)), f, plan, words, 100, { max: 2 });
  assert.match(ascii[0]!, /Shown now -> after/);
  assert.equal(ascii.length, 5, "two rows, then the count of the others");
  assert.match(ascii[4]!, /^\.\.\. and 1 more$/);
  // 40 columns (Task 22): a list with a header naming the numbers; a long title is cut, its counts never are.
  const long = { ...plan, byProject: [...plan.byProject, { projectId: "p3", title: "a-very-long-project-name-for-the-narrow-window", visibleBefore: 2, visibleAfter: 2 }] };
  const narrow = organizePreviewTable(makeStyle(caps(40)), f, long, words, 40);
  assert.equal(narrow[0], "Project: Shown now → after");
  assert.deepEqual(narrow.slice(1), ["demo", "  12 → 10, Settled 2, Retitled 1", "app", "  3 → 2, Archived 1", "quiet", "  9 → 9", "a-very-long-project-name-for-the-narrow…", "  2 → 2"]);
  for (const l of narrow) assert.ok(displayWidth(l) <= 40, l);
});

function captureIo(isTTY = false): { io: Io; out: () => string } {
  const out: string[] = [];
  return { io: { stdout: (s) => void out.push(s), stderr: () => undefined, isTTY, prompt: async () => "", env: {} }, out: () => out.join("") };
}

test("import progress: one bar for the whole import; wave lines only with --verbose; nothing at all when silent", () => {
  const wave = { wave: 1, totalWaves: 2, projects: 4, sessions: 3, imported: 3, retry: 0, failed: 0, deferred: 0 };
  const plain = captureIo();
  const p = importProgress(plain.io, en(80), () => NOW, { silent: false, verbose: false });
  p.onImportStart({ sessions: 5, projects: 4 });
  p.onWave(wave);
  p.onProgress("Wave 1/2 · 4 projects · 3 sessions · imported 3 · retry 0");
  p.onWave({ ...wave, wave: 2, sessions: 2, imported: 2 });
  p.end();
  p.dispose();
  assert.match(plain.out(), /^Importing 5 conversations · 4 projects/);
  assert.doesNotMatch(plain.out(), /Wave /, "no wave lines without --verbose");
  assert.match(plain.out(), /Imported 5 of 5 in 0 s\n$/);

  const verbose = captureIo();
  const v = importProgress(verbose.io, en(80), () => NOW, { silent: false, verbose: true });
  v.onImportStart({ sessions: 5, projects: 4 });
  v.onProgress("Wave 1/2 · 4 projects · 3 sessions · imported 3 · retry 0");
  v.end();
  v.dispose();
  assert.match(verbose.out(), /^Wave 1\/2 · 4 projects/m);

  const quiet = captureIo(true);
  const q = importProgress(quiet.io, en(80), () => NOW, { silent: true, verbose: true });
  q.onImportStart({ sessions: 5, projects: 4 });
  q.onWave(wave);
  q.onProgress("Wave 1/2");
  assert.equal(q.note("a notice"), false, "a silent bar never takes a notice");
  q.end();
  q.dispose();
  assert.equal(quiet.out(), "");

  const pp = captureIo();
  const b = importProgress(pp.io, pt(80), () => NOW, { silent: false, verbose: false });
  b.onImportStart({ sessions: 5, projects: 4 });
  b.dispose();
  assert.match(pp.out(), /^A importar 5 conversas · 4 projetos/);
});

test("the import bar's last line never calls a failure imported (EN and PT)", () => {
  const all = { wave: 1, totalWaves: 1, projects: 1, sessions: 6, imported: 0, retry: 0, failed: 6, deferred: 0 };
  for (const [ui, done, mixed] of [[en(80), "Imported 6 of 6 in 0 s", "6 of 6 processed in 0 s · 0 imported"], [pt(80), "6 de 6 importadas em 0 s", "6 de 6 tratadas em 0 s · 0 importadas"]] as const) {
    const ok = captureIo();
    const a = importProgress(ok.io, ui, () => NOW, { silent: false, verbose: false });
    a.onImportStart({ sessions: 6, projects: 1 });
    a.onWave({ ...all, imported: 6, failed: 0 });
    a.end();
    a.dispose();
    assert.ok(ok.out().trimEnd().endsWith(done), ok.out());
    assert.doesNotMatch(ok.out(), /\(6\)/, "the label says the count once, no \"(6)\" after it");
    const bad = captureIo();
    const b = importProgress(bad.io, ui, () => NOW, { silent: false, verbose: false });
    b.onImportStart({ sessions: 6, projects: 1 });
    b.onWave(all);
    b.end();
    b.dispose();
    assert.ok(bad.out().trimEnd().endsWith(mixed), bad.out());
  }
});

test("panels at 40 columns never cut a label; short values leave the labels their room (EN and PT)", () => {
  const result = (ui: ReturnType<typeof en>) => renderApplyResult(ui, {
    status: "partial", runId: "r1", imported: 6, failed: 6, converted: 0, deferred: 3, deferredInUse: 2, heldRoots: [], held: [], alreadyInT3: 0,
    restoreErrors: [], unverified: 0, parked: 0, recovered: null, failures: [],
  }).join("\n");
  const e = result(en(40, false));
  assert.match(e, /^\| Could not import  6 +\|$/m);
  assert.doesNotMatch(e, /\.\.\. +\d/, "no label cut");
  const p = result(pt(40));
  assert.match(p, /^│ Não importadas  6 +│$/m);
  assert.match(result(pt(80)), /6 importadas, 6 não foram importadas/, "Portuguese plurals");
  const one = renderApplyResult(pt(80), {
    status: "partial", runId: "r1", imported: 1, failed: 1, converted: 0, deferred: 0, deferredInUse: 0, heldRoots: [], held: [], alreadyInT3: 0,
    restoreErrors: [], unverified: 0, parked: 0, recovered: null, failures: [],
  }).join("\n");
  assert.match(one, /1 importada, 1 não foi importada/);
  for (const ui of [en(40), pt(40)]) {
    const plan = renderTerminalSummary(demoPlan(), { planPath: "plan.md", ui });
    assert.ok(plan.includes(ui.lang === "en" ? "New accounts in T3 Code" : "Contas novas no T3 Code"), plan);
    assert.doesNotMatch(plan.split("\n").slice(1, 8).join("\n"), /…/, "no label cut in the plan's panel rows");
  }
  // At 80 the plan's panel is as wide as its rows, not the window.
  const p80 = renderTerminalSummary(demoPlan(), { planPath: "plan.md", ui: en(80) }).split("\n");
  assert.ok(p80[0]!.length < 60, p80[0]);
});

test("said once: held projects, the watcher, a doctor warning; an item's glyph differs from its command's", () => {
  // status: the watcher's state is the item; the details row only says "not running".
  const st = renderStatus(STATUS_NEEDS_YOU(), { ui: en(80), now: NOW, version: "0.3.0" });
  assert.match(st, /^Watcher +not running$/m);
  assert.equal(st.split("not running").length, 3, "the item and the short row, nothing more");
  assert.match(st, /^· t3sm 0\.3\.1 is available\n  › t3sm update$/m, "· for an item, › only for its command");
  // PT "working" keeps the start time at 80 columns.
  const w = renderStatus({ ...STATUS_NEEDS_YOU(), level: "working", items: [], runInProgress: { pid: 9876, startedAt: new Date(NOW - 120_000).toISOString() } }, { ui: pt(80), now: NOW, version: "0.3.0" });
  assert.match(w.split("\n")[0]!, /começou há 2 min\)$/);
});

test("sync's screen: commands whole and without backticks; a held project said once (EN and PT, 80 and 40)", () => {
  for (const ui of [en(80), en(40, false), pt(80), pt(40)]) {
    const out = renderSyncResult(ui, syncOk(), NOW).join("\n");
    assert.doesNotMatch(out, /`/, `${ui.lang} ${ui.width}: no backticks`);
    assert.doesNotMatch(out, /t3sm\n/, `${ui.lang} ${ui.width}: a command never split`);
    assert.doesNotMatch(out, /a session of their project is in use|uma sessão do projeto está em uso/, "the held count is in the panel, its why under it, never a third time");
    assert.equal(out.split(ui.lang === "en" ? "demo waits" : "demo à espera").length, 2, "the held project once");
  }
});

test("organize: the undo hint once, its command whole; at 40 columns a list that keeps the archived count (EN and PT)", () => {
  for (const ui of [en(80), en(40, false), pt(80), pt(40)]) {
    const out = renderOrganize(ui, organizePlan(), { days: 90, minPerProject: 10 });
    const text = out.join("\n");
    assert.equal(text.split("t3sm organize --undo").length, 2, `${ui.lang} ${ui.width}: once`);
    assert.ok(out.some((l) => l.includes("t3sm organize --undo")), "the command on one line");
    for (const l of out) assert.ok(l.length <= ui.width, l);
  }
  const narrow = renderOrganize(en(40, false), organizePlan(), { days: 90, minPerProject: 10 }).join("\n");
  assert.match(narrow, /^app\n  3 -> 6, Archived 2$/m);
  assert.match(narrow, /^Project: Shown now -> after\ndemo\n  42 -> 12, Settled 30, Retitled 4$/m);
  assert.match(renderOrganize(pt(40), organizePlan(), { days: 90, minPerProject: 10 }).join("\n"), /^app\n  3 → 6, Arquivadas 2$/m);
});

test("a dry run says the conversations would fail; only the failures shown get their title read, none when 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t3sm-titles-"));
  try {
    const item = (n: number): PlanItem => {
      const path = join(dir, `${n}.jsonl`);
      writeFileSync(path, JSON.stringify({ type: "custom-title", customTitle: `Title ${n}`, sessionId: `s${n}` }) + "\n");
      return { session: { harness: "claude", accountId: "claudeAgent", nativeId: `s${n}`, cwd: "C:/work/demo", startedAt: null, updatedAt: "", messageCount: 1, corruptLines: 0,
        file: { path, size: 1, mtimeMs: 0, atimeMs: 0 }, flags: [], cwdOffsetBytes: 0 }, action: { kind: "import", projectRoot: "C:/work/demo", instanceId: "claudeAgent", expectedThreadId: `t${n}` }, notes: [] };
    };
    const none = [failureOf(item(1), "not-imported"), failureOf(item(2), "not-imported")];
    await nameFailures(none, 0);
    assert.deepEqual(none.map((f) => f.title), [null, null], "a silent run reads no transcript");
    const some = [failureOf(item(3), "not-imported"), failureOf(item(4), "not-imported")];
    await nameFailures(some, 1);
    assert.deepEqual(some.map((f) => f.title), ["Title 3", null], "only the rows shown");
    const dry = failureTable(en(80), some, 80, { dry: true }).join("\n");
    assert.match(dry, /^✗ 2 conversations would fail to import$/m);
    assert.match(failureTable(pt(80), some, 80, { dry: true }).join("\n"), /2 conversas falhariam na importação/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs and accounts never cut a value or leave a column out: a table when it fits whole, else one block per row (EN and PT)", async () => {
  const { MORE_SCREENS } = await import("../ui/screens.more.ts");
  for (const name of ["runs", "accounts"]) {
    const screen = MORE_SCREENS.find((x) => x.name === name)!;
    for (const lang of ["en", "pt"] as const) for (const columns of [40, 80, 120]) for (const unicode of [true, false]) {
      const text = (await screen.render({ color: 0, unicode, isTTY: false, columns }, lang)).join("\n");
      assert.doesNotMatch(text.split("\n! ")[0]!, /…|\.\.\./, `${name} ${lang} ${columns}: nothing cut`);
    }
  }
  const runs = MORE_SCREENS.find((x) => x.name === "runs")!;
  const t = (await runs.render({ color: 0, unicode: true, isTTY: false, columns: 80 }, "en")).join("\n");
  assert.match(t, /imported 412, files 6, instances 1, projects 12/);
  assert.match(t, /partial, rolled back by 20261115-110000-e5f6/);
  assert.match(t, /rollback 20261115-090000-a1b2/);
});
