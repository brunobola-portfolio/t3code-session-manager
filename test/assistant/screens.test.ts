// The guided assistant's premium screens (Task 20): the resume checklist, the failure list after an import, the doctor
// warnings that matter to this user only, the organize history fixes carried from Task 9, and the child commands
// rendering with the assistant's language and terminal. Scripted answers over fake dependencies; synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { realAssistantDeps } from "../../src/assistant/deps.ts";
import type { Io } from "../../src/cli/main.ts";
import type { Caps } from "../../src/ui/caps.ts";
import type { Check } from "../../src/ops/doctor.ts";
import type { RunSummary } from "../../src/ops/rollback.ts";
import type { OrganizeAction } from "../../src/organize/types.ts";
import { stripAnsi } from "../../src/ui/text.ts";
import { HOME, harness, previewFixture, writesFollowYes } from "./helpers.ts";
import { renderScenario } from "../ui/screens.assistant.ts";

const CAPS = (columns: number, unicode = true): Caps => ({ color: 0, unicode, isTTY: true, columns });
const runOf = (runId: string, command: string, status = "ok", importFailed = 0): RunSummary => ({
  runId, at: null, command, status, rolledBackBy: null,
  counts: { imported: 2, importFailed, filesWritten: 0, quarantined: 0, unquarantined: 0, defaults: 0, instances: 0, projects: 0, archived: 0, merged: 0, organized: 0, organizeReverted: 0 },
});
const SET_UP = { exists: true, language: null, hasPlan: true };
const NOW = Date.parse("2026-11-15T12:00:00Z");

test("resume says which steps are done instead of jumping", async () => {
  const h = harness({ answers: ["y", "y", "q"], config: SET_UP, runs: [runOf("R0", "apply P0", "partial", 3)] });
  await h.run();
  const t = h.text();
  // The checklist: steps 3-7 done, 8 next, 9-11 later; then what happened last time and where it continues.
  assert.match(t, /Welcome back\. Here is where you are:/);
  assert.match(t, /✓ Accounts +✓ Plan +✓ Decisions +✓ Clean-up +✓ Pilot/);
  assert.match(t, /◉ Full import\s+○ Organize +○ Keep in sync +○ Done/);
  assert.match(t, /Last time: the full import finished with 3 failures\./);
  assert.match(t, /Next: a quick check, then step 8 · Full import\./);
  assert.match(h.prompts.join("\n"), /Continue at step 8\? \[Y\/n\/\?\/q\]/);
  // The rail of step 8 shows the steps behind it as done (● after the welcome ◉ and the check).
  const rail = t.split("\n").find((l) => /Step 8 of 11 · Full import/.test(l))!;
  assert.match(rail, /^● ● ● ● ● ● ● ◉ ○ ○ ○  Step 8 of 11/);
  // ASCII console: the same checklist with ASCII marks.
  const a = harness({ answers: ["q"], config: SET_UP, runs: [runOf("R0", "apply P0", "partial", 3)], caps: CAPS(80, false) });
  await a.run();
  assert.match(a.text(), /v Accounts +v Plan .*@ Full import\s+o Organize/s);
  assert.doesNotMatch(a.text(), /[^\x00-\x7f]/);
  // Portuguese.
  const p = harness({ answers: ["q"], lang: "pt", config: SET_UP, runs: [runOf("R0", "apply P0", "partial", 3)] });
  await p.run();
  assert.match(p.text(), /✓ Contas +✓ Plano .*◉ Importação completa/s);
  assert.match(p.flat(), /Da última vez: a importação completa terminou com 3 falhas\. A seguir: uma verificação rápida, depois o passo 8 · Importação completa\./);
});

test("failures show project and title, never a uuid, with a t3sm help topic", async () => {
  for (const lang of ["en", "pt"] as const) {
    for (const columns of [80, 120]) {
      const lines = await renderScenario("start-full-partial", CAPS(columns), lang);
      const t = lines.map(stripAnsi).join("\n");
      assert.doesNotMatch(t, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, `${lang} ${columns}: a uuid`);
      assert.doesNotMatch(t, /cwd-unreadable-in-t3|instance-unavailable:|read-failed:|target-folder:/, `${lang} ${columns}: a raw reason`);
      assert.match(t, /Fix the login form/);
      assert.match(t, /billing-service/);
      assert.match(t, /t3sm help not-imported/);
      assert.equal(t.match(/(More help|Mais ajuda)/g)?.length, 1, `${lang} ${columns}: one help line`);
      assert.doesNotMatch(t, /troubleshooting\.md/);
      // Then what it means for the user, without a second pointer to the help.
      assert.match(t, lang === "en" ? /Some conversations were not imported: the list above says why\./ : /Algumas conversas não foram importadas: a lista acima diz porquê\./);
    }
  }
});

const PI_WARN: Check = { id: "harness:pi", status: "warn", message: "sessions found but T3 Code has no pi instance; they will be skipped", fix: "Enable Pi in T3 Code settings (Providers), then run t3sm plan again", data: { harness: "pi", sessions: null, readErrors: 0, noInstance: true } };

test("Pi warning hidden without Pi sessions", async () => {
  const checks = [[{ id: "node-version" as const, status: "ok" as const, message: "Node 24" }, PI_WARN]];
  // No Pi session in the plan: never mentioned, neither at the check nor at the plan.
  const none = harness({ answers: ["y", "y", "n", "y", "q"], checks });
  await none.run();
  assert.doesNotMatch(none.flat(), /no pi instance|Enable Pi|Pi: \d/i);
  assert.match(none.flat(), /All good · 2 of 2 checks passed/, "a warning that does not concern you is not counted against you");
  // Pi sessions the plan skips for it: said at the plan, with how many.
  const some = harness({ answers: ["y", "y", "n", "y", "q"], checks, skipped: [{ harness: "pi", n: 4 }] });
  await some.run();
  assert.match(some.flat(), /! Pi: 4 sessions will be skipped T3 Code has no Pi instance\. To bring them, enable Pi in T3 Code settings \(Providers\), then run t3sm again\./);
  assert.doesNotMatch(some.text().split("Step 4 of 11")[0]!, /Pi: 4/, "not at the check: only the plan knows the count");
});

test("\"continued in a terminal\" uses a relative date and the merge command", async () => {
  const at = new Date(NOW - 2 * 3600_000).toISOString();
  // Worded from the check's data, never from its English message (here deliberately unparseable).
  const checks: Check[][] = [[{ id: "merge-pending", status: "warn", message: "(doctor's own words)", fix: "Run t3sm merge", data: { continued: 3, sideBranch: 1, at } }]];
  const h = harness({ answers: ["y", "q"], checks, now: () => NOW });
  await h.run();
  const t = h.text();
  assert.match(t, /! Continued sessions\n(?: {2}.*\n)*? {2}3 conversations were continued in a terminal \(checked 2 h ago\)\./);
  assert.match(t, /\n  › t3sm merge\n/);
  assert.match(h.flat(), /1 session has work on a side branch that T3 Code cannot show: continue it in a terminal with claude --resume\./, "the side-branch clause is kept");
  assert.doesNotMatch(t, /as of|2026-11-15T/, "never the raw ISO date");
  const p = harness({ answers: ["s", "q"], checks, now: () => NOW, lang: "pt" });
  await p.run();
  assert.match(p.flat(), /3 conversas foram continuadas num terminal \(verificado há 2 h\)\./);
});

test("the other doctor warnings: each id decides; the ones a later step handles say which", async () => {
  const checks = [[
    { id: "instance-unpinned" as const, status: "warn" as const, message: "claudeAgent has no explicit home", fix: "Run t3sm apply" },
    { id: "t3sm-plugin" as const, status: "warn" as const, message: "Claude Org has t3sm plugin 0.2.1", fix: "Run claude plugin update" },
    { id: "backups-present" as const, status: "warn" as const, message: "2 backup folders inside projects/", fix: "Run t3sm quarantine (reversible)" },
    { id: "claude-env" as const, status: "warn" as const, message: "T3 Code started from this shell would read ~/.claude-x", fix: "Remove CLAUDE_CONFIG_DIR" },
  ]];
  const h = harness({ answers: ["y", "q"], checks });
  await h.run();
  const t = h.flat();
  assert.doesNotMatch(t, /no explicit home|plugin 0\.2\.1/, "handled elsewhere: not repeated");
  assert.match(t, /2 backup folders inside projects\/ Step 6 offers to move them aside\./);
  assert.doesNotMatch(t, /Run t3sm quarantine/);
  assert.match(t, /would read ~\/\.claude-x What to do: Remove CLAUDE_CONFIG_DIR/);
  assert.match(t, /Ready, 2 worth knowing/);
});

test("say wraps to the terminal's width, at most 80 columns", async () => {
  for (const columns of [50, 100]) {
    const h = harness({ answers: ["y", "y", "n", "y", "c", "n", "n", "n", "n"], caps: CAPS(columns) });
    await h.run();
    for (const l of h.printed().split("\n")) assert.ok(stripAnsi(l).length <= Math.min(columns, 80), `${columns}: ${l}`);
    for (const p of h.prompts) assert.ok(p.length <= Math.min(columns, 80) - 3, `${columns}: prompt ${p}`);
  }
});

test("no assistant text points at docs/troubleshooting.md", () => {
  const dir = join(import.meta.dirname, "..", "..", "src", "assistant");
  for (const f of readdirSync(dir)) assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), /troubleshooting\.md/, f);
});

// ---------------- organize: the history fixes carried from Task 9 ----------------

/** welcome, check, accounts, plan, clean-up (no, no), pilot (skip), full import (yes): then organize. */
const TO_ORGANIZE = ["y", "y", "n", "y", "c", "n", "n", "n", "y"];
/** titles, archive, pin (+ list), delete: yes. */
const PARTS_YES = ["y", "y", "y", "", "y"];

test("organize: other numbers re-run the preview with that rule, so the counts are right", async () => {
  const settle = (i: number): OrganizeAction => ({ kind: "settle", target: `import:s${i}`, projectId: "alpha", previous: null, next: "settled", reason: "history: older than 30 days" });
  const rules: unknown[] = [];
  const previewFor = (rule: unknown) => {
    rules.push(rule);
    const b = previewFixture();
    // With 30 days: 1 conversation shown again and 6 settled (instead of 4 and 0).
    const actions = [...b.plan.actions.filter((a) => a.kind !== "unsettle"), { ...b.plan.actions.find((a) => a.kind === "unsettle")! }, ...Array.from({ length: 6 }, (_, i) => settle(i))];
    return { ...b, plan: { ...b.plan, actions }, history: rule as { days: number; minPerProject: number } };
  };
  const h = harness({ answers: [...TO_ORGANIZE, "n", "30", "", ...PARTS_YES, "y", "y", "n"], preview: previewFixture(), previewFor });
  assert.equal(await h.run(), 0, h.text());
  assert.equal(h.left(), 0);
  assert.deepEqual(rules, [{ days: 30, minPerProject: 10 }], "planned again with the numbers typed");
  assert.ok(h.calls().includes('organizePreview {"days":30,"minPerProject":10}'));
  const panelText = (x: string): string => x.replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");
  assert.match(panelText(h.text()), /History the last 30 days, at least 10 per project shown again 1 settled 6/);
  assert.equal(h.writes().at(-1), "run organize --yes --auto-settle 30");
  assert.deepEqual(writesFollowYes(h.events), []);
  // Same numbers (Enter): no second preview.
  const same = harness({ answers: [...TO_ORGANIZE, "", ...PARTS_YES, "y", "y", "n"], preview: previewFixture(), previewFor });
  await same.run();
  assert.ok(!same.calls().some((c) => /^organizePreview \{/.test(c)));
  assert.match(panelText(same.text()), /History the last 90 days, at least 10 per project shown again 4 settled 0/);
});

test("organize: history off in config.json, one Enter keeps it off", async () => {
  const off = { history: true, titles: false, archiveAutomated: false, pinRecent: false };
  // history: Enter (kept off), then the parts, T3 Code's option (rule off: turn it off? Enter = no), apply, q at sync.
  const h = harness({ answers: [...TO_ORGANIZE, "", ...PARTS_YES, "", "y", "q"], preview: { ...previewFixture(), off } });
  await h.run();
  const t = h.flat();
  assert.match(t, /Off in your settings now\. Turning it on would do this:/);
  assert.match(t, /Turn it on: the last 90 days, at least 10 per project\? \[y\/N/);
  assert.doesNotMatch(t, /Days each project shows/, "no second question for the same Enter");
  assert.equal(h.saved.at(-1)?.history, "off");
  assert.doesNotMatch(t, /History +the last/);
  assert.match(t, /Also turn off T3 Code's auto-settle for new conversations\? \[y\/N/);
  // y turns it on: the days and the minimum (Enter keeps the defaults).
  const on = harness({ answers: [...TO_ORGANIZE, "y", "", "", ...PARTS_YES, "y", "y", "q"], preview: { ...previewFixture(), off } });
  await on.run();
  assert.deepEqual(on.saved.at(-1)?.history, { days: 90, minPerProject: 10 });
});

test("organize: T3 Code's option without the history question does not say \"like the rule above\"", async () => {
  const base = previewFixture();
  const preview = { ...base, plan: { ...base.plan, actions: base.plan.actions.filter((a) => a.kind !== "unsettle" && a.kind !== "settle") } };
  const h = harness({ answers: [...TO_ORGANIZE, ...PARTS_YES, "y", "y", "q"], preview });
  await h.run();
  const t = h.flat();
  assert.doesNotMatch(t, /like the rule above|the same as above/);
  assert.match(t, /t3sm can set it to 90 days, the days your history rule keeps \(organize\.history\)\./);
  const asked = harness({ answers: [...TO_ORGANIZE, "", ...PARTS_YES, "y", "y", "q"], preview: base });
  await asked.run();
  assert.match(asked.flat(), /t3sm can set it to 90 days, like the rule above\./);
});

// ---------------- the child commands render with the assistant's terminal ----------------

test("run passes the terminal's capabilities and the language to the command it runs, so its progress bar draws in place", async () => {
  const caps: Caps = { color: 3, unicode: true, isTTY: true, columns: 132, cursor: true };
  const seen: Io[] = [];
  const io: Io = { stdout: () => {}, stderr: () => {}, isTTY: true, prompt: async () => "q", env: {}, lang: "pt", caps };
  const main = async (_argv: string[], child: Io): Promise<number> => { seen.push(child); child.stdout("\r▕███░░▏ 3/5"); return 0; };
  const d = realAssistantDeps(io, { main, home: "/home-demo", noColor: false });
  const r = await d.run(["apply", "--yes"]);
  assert.equal(r.code, 0);
  assert.equal(seen[0]!.lang, "pt");
  assert.deepEqual(seen[0]!.caps, caps);
  assert.equal(seen[0]!.isTTY, true);
  assert.match(r.output, /3\/5/, "what the child printed is teed");
  const nc = realAssistantDeps(io, { main, home: "/home-demo", noColor: true });
  await nc.run(["apply", "--yes"]);
  assert.equal(seen[1]!.caps!.color, 0, "--no-color reaches the child");
});

// ---------------- fix round 1 ----------------

test("a doctor check is read from its data only: no data, its own words; read errors are never dropped", async () => {
  const raw = harness({ answers: ["y", "q"], checks: [[{ id: "merge-pending", status: "warn", message: "3 sessions continued in a terminal (as of 2026-11-15T10:00:00Z)", fix: "Run t3sm merge" }]] });
  await raw.run();
  assert.match(raw.flat(), /3 sessions continued in a terminal \(as of 2026-11-15T10:00:00Z\) What to do: Run t3sm merge/, "without data: shown as doctor words it");
  const codex: Check = { id: "harness:codex", status: "warn", message: "(doctor's own words)", fix: "Enable Codex. Some Codex files could not be read", data: { harness: "codex", sessions: 5, readErrors: 2, noInstance: true } };
  const h = harness({ answers: ["y", "q"], checks: [[codex]] });
  await h.run();
  assert.match(h.flat(), /! Codex sessions 2 Codex files could not be read \(corrupt, cut short or unsupported\)\. t3sm scan counts them; t3sm help convert explains them\./);
  assert.doesNotMatch(h.flat(), /Enable Codex/, "the missing instance waits for the plan, which knows how many sessions it skips");
});

test("names and folders are never rewritten, even on a console without Unicode", async () => {
  const accounts = [{ id: "claudeAgent", displayName: "Konto Łódź", email: null, home: "~/.claude", foundVia: ["default"], alias: null, hasInstance: true }];
  const h = harness({ answers: ["y", "y", "y", "q"], accounts, names: { claudeAgent: "Konto Łódź", "claude-org": "Org" }, under: `${HOME}/code/项目`, caps: CAPS(100, false) });
  await h.run();
  const t = h.text();
  assert.match(t, /Konto Łódź/);
  assert.match(t, /~\/code\/项目\/big/);
  assert.match(t, /Step 4 of 11 - Plan/, "the kit's own glyphs and the catalogue's are ASCII");
  assert.doesNotMatch(t, /[·…◉●○✓]/);
});

test("after the full import the held projects are the command's to say (no second, older count)", async () => {
  for (const name of ["start-full-held", "start-full-partial"]) {
    const t = (await renderScenario(name, CAPS(80), "en")).map(stripAnsi).join("\n");
    const after = t.slice(t.indexOf("Import everything now?"));
    assert.doesNotMatch(after, /project waits: a conversation in it is in use/, name);
  }
});

test("a returning user is asked one question; the rail marks the steps behind as done", async () => {
  const h = harness({ answers: ["y", "q"], config: SET_UP, runs: [runOf("R0", "apply P0", "partial", 3)] });
  await h.run();
  assert.doesNotMatch(h.prompts.join("\n"), /Ready to start/);
  assert.match(h.prompts[0]!, /^Continue at step 8\? \[Y\/n\/\?\/q\]/);
  // A first run with nothing to decide: step 5 is skipped, and the rail of step 6 still shows it behind.
  const f = harness({ answers: ["y", "y", "n", "y", "c", "q"] });
  await f.run();
  assert.match(f.text(), /\n● ● ● ● ● ◉ ○ ○ ○ ○ ○  Step 6 of 11 · Clean-up/);
});

test("ASCII screens: the key legend never starts a line with \"- \"; a bullet in a panel hangs under its text", async () => {
  for (const lang of ["en", "pt"] as const) {
    const ls = await renderScenario("start-first-run", CAPS(40, false), lang);
    for (const l of ls) assert.doesNotMatch(l, /^- /, `${lang}: ${l}`);
  }
  const done = (await renderScenario("start-done", CAPS(40), "en")).map(stripAnsi);
  const at = done.findIndex((l) => /^│ · remove each new instance/.test(l));
  assert.ok(at > 0);
  assert.match(done[at + 1]!, /^│ {3}\S/, "the bullet's next line is indented under its text");
});

test("a partial full import is recorded as such, with its failures; Portuguese settings read without English words", async () => {
  const t = (await renderScenario("start-full-partial", CAPS(80), "en")).map(stripAnsi).join("\n").replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");
  assert.match(t, /! Import finished with 6 failures \(run R1\)/);
  assert.doesNotMatch(t, /Imported everything/);
  const p = harness({ answers: ["s", "s", "n", "s", "c", "q"], lang: "pt", pending: [{ key: "home", sessions: 2, folders: 1 }] });
  await p.run();
  assert.match(p.flat(), /Mudar depois +organize\.folders\.home \("rehome" \| "import" \| "skip"\)/);
  assert.doesNotMatch(p.flat(), /" or "/);
});

test("lock held: the assistant does not run at the same time (nothing waits)", async () => {
  for (const [lang, re] of [["en", /does not run at the same time as another t3sm run/], ["pt", /não corre ao mesmo tempo que outra execução do t3sm/]] as const) {
    const h = harness({ answers: [], lock: () => ({ pid: 42 }), lang });
    await h.run();
    assert.match(h.flat(), re);
    assert.doesNotMatch(h.flat(), /waits for it|espera por ela/);
  }
});

test("a full import that held a project never says All done: it says how many wait (Task 22); the undo line hangs under its text", async () => {
  const en = (await renderScenario("start-full-held", CAPS(40), "en")).map(stripAnsi).join("\n");
  assert.doesNotMatch(en, /All done/);
  assert.match(en, /Done; 1 project waits until its/);
  // "What this session did": the undo line's continuation starts under the undo text, not two columns further.
  const box = en.split("\n").filter((l) => l.startsWith("│ "));
  const undo = box.findIndex((l) => /Undo: /.test(l));
  assert.ok(undo >= 0, en);
  const col = box[undo]!.indexOf("Undo:");
  assert.equal(box[undo + 1]!.search(/[^│ ]/), col, box.join("\n"));
  const pt = (await renderScenario("start-full-held", CAPS(80), "pt")).map(stripAnsi).join("\n");
  assert.doesNotMatch(pt, /Tudo feito/);
  assert.match(pt, /Feito; 1 projeto espera/);
  // The other direction: the plan showed a project in use before the import, but the import held none (it was idle
  // by then): "All done", counted after the fact from the run, never from the plan.
  const ok = (await renderScenario("start-full-ok", CAPS(80), "en")).map(stripAnsi).join("\n");
  assert.match(ok, /In use now +1/, "the plan before the import showed one");
  assert.match(ok, /All done/);
  assert.doesNotMatch(ok, /project waits until/);
});
