// The assistant's "Decisions" (5) and "Organize" (9) steps: scripted answers over fake dependencies. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOGUES } from "../../src/assistant/i18n.ts";
import { TOTAL_STEPS } from "../../src/assistant/core.ts";
import { STEPS } from "../../src/assistant/steps.ts";
import type { RunSummary } from "../../src/ops/rollback.ts";
import type { OrganizeAction } from "../../src/organize/types.ts";
import { tildePath } from "../../src/core/paths.ts";
import { BIG, HOME, MOVES, PENDING, SCRATCH, harness, previewFixture, writesFollowYes } from "./helpers.ts";

/** welcome, check, accounts (no new instance, names fine), plan (continue): then the decisions step. */
const PRE = ["y", "y", "n", "y", "c"];
/** clean-up (both no), pilot (skip), full import (no: ends at the summary). */
const SKIP_REST = ["n", "n", "n", "n"];
/** clean-up (both no), pilot (skip), full import (yes). */
const IMPORT_ALL = ["n", "n", "n", "y"];

const flat = (h: { flat: () => string }): string => h.flat();

test("the assistant has TOTAL_STEPS steps and a title for each, in both languages", () => {
  assert.equal(STEPS.length, TOTAL_STEPS);
  assert.equal(TOTAL_STEPS, 11);
  for (const lang of ["en", "pt"] as const) {
    for (let n = 1; n <= TOTAL_STEPS; n++) assert.ok(CATALOGUES[lang][`title${n}` as keyof (typeof CATALOGUES)["en"]], `${lang} title${n}`);
    assert.ok(!(`title${TOTAL_STEPS + 1}` in CATALOGUES[lang]));
    assert.ok(CATALOGUES[lang].stepWord !== "" && CATALOGUES[lang].ofWord !== "", "the step header's words");
  }
  assert.equal(CATALOGUES.en.title5, "Decisions");
  assert.equal(CATALOGUES.en.title9, "Organize");
});

// ---------------- decisions ----------------

test("decisions: one question per pending key, with the real numbers, default and how to change it; saves exactly the answered keys after a y", async () => {
  const h = harness({ answers: [...PRE, "y", "y", "n", "n", "y", "", ...SKIP_REST], pending: PENDING, moves: MOVES });
  assert.equal(await h.run(), 0, h.text());
  assert.equal(h.left(), 0);
  const t = flat(h);
  assert.match(t, /Step 5 of 11 · Decisions/);
  assert.match(t, /5 conversations were started in your home folder/);
  assert.match(t, /1 conversation comes from 1 folder that T3 Code refuses as a project/);
  assert.match(t, /11 conversations ran in 5 temporary folders/);
  assert.match(t, /7 conversations were started by programs, not by you/);
  assert.match(t, /Default +no: mostly throwaway experiments; you can say yes later Change later +organize\.folders\.temp \("import" \| "skip" \| "rehome"\)/);
  assert.match(t, /Change later +organize\.sessions\.automated/);
  assert.match(t, /1 of 4 · Your home folder .* 2 of 4 · Folders T3 Code refuses .* 3 of 4 · Temporary folders .* 4 of 4 · Started by programs/, "one panel per question");
  assert.match(t, /Put copies of these conversations into the right projects\? \[Y\/n/);
  assert.match(t, /Import these conversations anyway\? \[y\/N/);
  assert.match(t, /"General" project/);
  assert.deepEqual(h.saved[0], { decided: ["home", "t3-refused", "temp", "automated"], folders: { home: "rehome", "t3-refused": "rehome", temp: "skip" }, sessions: { automated: "skip" } });
  assert.equal(h.saved.length, 1, "no destination changed: nothing more is saved");
  assert.deepEqual(h.writes().map((w) => w.split(" ")[0]), ["saveOrganize"]);
  assert.deepEqual(writesFollowYes(h.events), []);
  assert.deepEqual(new Set(h.planLangs), new Set(["en"]), "every plan is asked in the assistant's language");
  assert.ok(h.calls().filter((c) => c === "plan").length >= 3, "re-planned after the answers were saved");
  assert.match(t, /Saved\. Updating the plan with your answers/);
  assert.match(t, /New projects t3sm will create: "demo", "General"\. Their names come from the folder; rename them in T3 Code if you like\./);
  assert.match(t, /Step 6 of 11 · Clean-up/);
  assert.match(t, /What changed ✓ Saved your answers about which conversations to bring .*How to undo · edit "organize" in config\.json/);
});

test("decisions in Portuguese: the numbers, the General project is Geral, every plan is asked in pt", async () => {
  const answers = [...PRE, "s", "s", "n", "n", "s", "", ...SKIP_REST].map((a) => (a === "y" ? "s" : a));
  const h = harness({ answers, lang: "pt", pending: PENDING, moves: MOVES });
  assert.equal(await h.run(), 0, h.text());
  const t = flat(h);
  assert.match(t, /Passo 5 de 11 · Decisões/);
  assert.match(t, /5 conversas começaram na tua pasta pessoal/);
  assert.match(t, /11 conversas correram em 5 pastas temporárias/);
  assert.match(t, /projeto "Geral"/);
  assert.match(t, /Mudar depois +organize\.folders\.temp/);
  assert.match(t, /Guardar as respostas no config\.json para não voltarem a ser perguntadas\? Desfazer: edita lá "organize"\. \[s\/N/);
  assert.match(t, /Projetos novos que o t3sm vai criar: "demo", "General"\. Os nomes vêm da pasta/, "the planner's own titles");
  assert.deepEqual(new Set(h.planLangs), new Set(["pt"]));
  assert.deepEqual(writesFollowYes(h.events), []);
});

test("decisions: only the keys in decisionsPending are asked; nothing pending means the step is not shown", async () => {
  const h = harness({ answers: [...PRE, "n", "n", ...SKIP_REST], pending: [{ key: "temp", sessions: 11, folders: 5 }] });
  assert.equal(await h.run(), 0, h.text());
  assert.equal(h.prompts.filter((p) => /Import these conversations anyway/.test(p)).length, 1);
  assert.doesNotMatch(h.prompts.join("\n"), /home folder|Put copies|started by programs/);
  assert.deepEqual(h.saved, [], "an n to the save question writes nothing");
  assert.match(flat(h), /OK, nothing saved\. These questions come back the next time you run t3sm start\./);
  assert.deepEqual(h.writes(), []);
  const none = harness({ answers: [...PRE, ...SKIP_REST] });
  await none.run();
  assert.doesNotMatch(flat(none), /Step 5 of 11|Decisions/);
  assert.equal(none.calls().filter((c) => c.startsWith("saveOrganize")).length, 0);
});

test("decisions: a temp or automated yes is saved as import, and a no to home as skip", async () => {
  const h = harness({ answers: [...PRE, "n", "y", "y", "y", ...SKIP_REST], pending: [{ key: "home", sessions: 5, folders: 1 }, { key: "temp", sessions: 2, folders: 1 }, { key: "automated", sessions: 7, folders: 3 }] });
  assert.equal(await h.run(), 0, h.text());
  assert.deepEqual(h.saved[0], { decided: ["home", "temp", "automated"], folders: { home: "skip", temp: "import" }, sessions: { automated: "import" } });
  assert.doesNotMatch(flat(h), /Where the copies go/, "no copies, no destination review");
});

test("decisions: the review list shares the assistant's one reader; a changed destination and an unmarked group are saved as overrides", async () => {
  // plain list: 1 = HOME group (5 conversations, two destinations), 2 = SCRATCH group. Toggle 2 off; edit 1 -> choice 2 (the busiest other project).
  const answers = [...PRE, "y", "n", "y", "2", "e1", "2", "", "y", ...SKIP_REST];
  const h = harness({ answers, pending: [{ key: "home", sessions: 5, folders: 1 }, { key: "t3-refused", sessions: 1, folders: 1 }], moves: MOVES });
  assert.equal(await h.run(), 0, h.text());
  assert.equal(h.left(), 0, "every piped answer was read, in order, by one reader");
  assert.ok(!h.exhausted());
  const t = flat(h);
  assert.match(t, /Where the copies go/);
  assert.match(t, /1\. \[x\] ~ \(home folder\) · 5 conversations/);
  assert.match(t, /2\. \[x\] .* · 1 conversation /);
  assert.match(t, /Your home folder: T3 Code does not accept it as a project\. Each one goes to the project it mostly worked in\./);
  assert.match(t, /T3 Code refuses this folder as a project\. Nothing pointed to one project, so they go to .*General\./);
  assert.match(t, /1\. Suggested: each one to the project it worked in/);
  assert.match(t, /Suggested: General project \(/);
  assert.match(t, /Leave these out/);
  assert.equal(h.saved.length, 2);
  assert.deepEqual(h.saved[1], { overrides: [{ match: "~", action: `rehome:${BIG}` }, { match: SCRATCH, action: "skip" }] });
  assert.equal(h.saved[1]!.overrides![0]!.match, tildePath(HOME, HOME));
  assert.match(t, /Destinations saved\./);
  assert.deepEqual(writesFollowYes(h.events), []);
  assert.equal(h.disposed(), 1, "a list never closes the shared reader; the assistant does, once, at the end");
});

test("decisions: leaving the list with q or confirming it untouched changes nothing and asks nothing to save", async () => {
  for (const leave of ["q", ""]) {
    const h = harness({ answers: [...PRE, "y", "n", "y", leave, ...SKIP_REST], pending: [{ key: "home", sessions: 5, folders: 1 }, { key: "t3-refused", sessions: 1, folders: 1 }], moves: MOVES });
    assert.equal(await h.run(), 0, h.text());
    assert.equal(h.saved.length, 1, leave);
    assert.match(flat(h), /No destination changed: t3sm's suggestions stand\./);
  }
});

test("decisions: a lock taken meanwhile saves nothing and ends the assistant", async () => {
  const h = harness({ answers: [...PRE, "y", "y", "n", "n", "y"], pending: PENDING, saveLocked: true });
  assert.equal(await h.run(), 0);
  assert.match(flat(h), /Another t3sm run started meanwhile/);
  assert.deepEqual(h.saved, []);
});

test("resume: unanswered questions in the newest plan bring the user back to the decisions", async () => {
  const run = (id: string, command: string): RunSummary => ({ runId: id, at: null, command, status: "ok", rolledBackBy: null, counts: { imported: 0, importFailed: 0, filesWritten: 0, quarantined: 0, unquarantined: 0, defaults: 0, instances: 0, projects: 0, archived: 0, merged: 0, organized: 0, organizeReverted: 0 } });
  const h = harness({ answers: ["y", "q"], config: { exists: true, language: null, hasPlan: true }, configPending: true, pending: PENDING, runs: [run("a", "apply P0")] });
  assert.equal(await h.run(), 0, h.text());
  assert.match(flat(h), /Last time: some questions about your sessions were left unanswered\. Next: a quick check, then step 5 · Decisions\./);
  assert.match(flat(h), /Step 5 of 11 · Decisions/);
});

// ---------------- organize ----------------

/** The full import has just run (yes): the organize step follows. */
const TO_ORGANIZE = [...PRE, ...IMPORT_ALL];
const ORGANIZE_ALL = ["", "y", "y", "y", "", "y", "n"]; // history rule kept, titles, archive, pin (+ list confirmed), delete, T3 option no

test("organize: the preview comes first (its exact header), then one question per part with default and undo, then Apply", async () => {
  const h = harness({ answers: [...TO_ORGANIZE, ...ORGANIZE_ALL, "y", "n"], preview: previewFixture() });
  assert.equal(await h.run(), 0, h.text());
  assert.equal(h.left(), 0);
  const raw = h.text();
  const at = raw.indexOf(CATALOGUES.en.organizePreviewHead);
  assert.ok(at > 0, "the preview header is printed");
  assert.ok(at < raw.indexOf("Show the last 90 days, and at least 10 per project?"), "preview before the first question");
  assert.ok(at < raw.indexOf("Give these conversations clearer titles?"));
  const t = flat(h);
  assert.match(t, /Project +Shown now → after +Settled +Retitled +Archived/);
  assert.match(t, /alpha-app/);
  assert.match(t, /Step 9 of 11 · Organize/);
  assert.match(t, /History inside projects 4 conversations shown again, 0 settled, in 2 projects\. The rule: each project shows its last 90 days, and at least 10 even if older\./);
  assert.match(t, /Default +yes Undo +t3sm organize --undo/);
  assert.match(t, /Give these conversations clearer titles\? \[Y\/n/);
  assert.match(t, /Archive these automated conversations\? \[Y\/n/);
  assert.match(t, /Pin these projects\? \[Y\/n/);
  assert.match(t, /Projects to pin/);
  assert.match(t, /Delete this empty project\? \[Y\/n/);
  assert.match(t, /Now: after 7 days\. t3sm can set it to 90 days, like the rule above\./);
  assert.match(t, /Also let T3 Code settle conversations started in T3 Code after 90 days\? \[Y\/n/);
  assert.match(flat(h), /Here is what I will do History +the last 90 days, at least 10 per project +shown again +4 +settled +0 +New titles +2 +Archive automated +3 +Pin projects +2 +Delete empty projects +1 +Undo +t3sm organize --undo/);
  assert.match(flat(h), /Apply these changes to T3 Code now\? Undo: t3sm organize --undo\. \[y\/N/);
  assert.deepEqual(h.saved.at(-1), { decided: ["history", "titles", "archiveAutomated", "pinRecent"], history: { days: 90, minPerProject: 10 }, titles: true, archiveAutomated: true, pinRecent: { enabled: true } });
  assert.equal(h.writes().at(-1), "run organize --yes");
  assert.ok(h.writes().at(-2)!.startsWith("saveOrganize "), "the choices are saved right before the command, after the same y");
  assert.deepEqual(writesFollowYes(h.events), []);
  assert.match(flat(h), /✓ Organized the imported history in T3 Code \(run R(\d)\) .*· t3sm organize --undo R\1/);
  assert.match(flat(h), /Done\. Open T3 Code: your projects now show their history\./);
  assert.match(flat(h), /Step 10 of 11 · Keep in sync/);
});

test("organize: n at Apply never writes (no config, no command); n to every part leaves nothing to apply", async () => {
  const no = harness({ answers: [...TO_ORGANIZE, ...ORGANIZE_ALL, "n", "n"], preview: previewFixture() });
  assert.equal(await no.run(), 0, no.text());
  assert.deepEqual(no.writes(), ["run apply --yes"], "only the import the user confirmed earlier");
  assert.deepEqual(no.saved, []);
  assert.match(flat(no), /OK, nothing changed\. Run t3sm organize any time to do it\./);
  const none = harness({ answers: [...TO_ORGANIZE, "n", "none", "n", "n", "n", "n", "n", "n"], preview: previewFixture() });
  assert.equal(await none.run(), 0, none.text());
  assert.deepEqual(none.writes(), ["run apply --yes"]);
  assert.match(flat(none), /Nothing selected, so nothing changes\./);
  assert.doesNotMatch(flat(none), /Apply these changes/);
});

test("organize: the answers become flags and settings (days, a pin left out, no delete, T3 Code's option to the same days)", async () => {
  // history: n, 30 days (after a bad answer), minimum Enter (10); titles no, archive yes, pin yes with the first project
  // unmarked, delete no, T3 Code's option yes, apply
  const answers = [...TO_ORGANIZE, "n", "x", "30", "", "n", "y", "y", "1", "", "n", "y", "y", "n"];
  const h = harness({ answers, preview: previewFixture() });
  assert.equal(await h.run(), 0, h.text());
  assert.match(flat(h), /Type a number from 1 to 3650, all, or none\./);
  assert.deepEqual(h.saved.at(-1), { decided: ["history", "titles", "archiveAutomated", "pinRecent"], history: { days: 30, minPerProject: 10 }, titles: false, archiveAutomated: true, pinRecent: { enabled: true } });
  assert.deepEqual(h.writes().at(-1), "run organize --yes --no-pin alpha --no-delete --auto-settle 30");
  assert.match(flat(h), /History +the last 30 days, at least 10 per project +shown again +4 +settled +0 +Archive automated +3 +Pin projects +1 +T3 Code's option +30 days \(now after 7 days\)/);
  assert.deepEqual(writesFollowYes(h.events), []);
});

test("organize: conversations from temp or system folders get their own question; listed when yes, --no-archive-folders when no (EN and PT)", async () => {
  const base = previewFixture();
  const folders: OrganizeAction[] = [
    { kind: "archive", target: "import:t1", projectId: "empty", previous: false, next: true, reason: "temp folder" },
    { kind: "archive", target: "import:s1", projectId: "empty", previous: false, next: true, reason: "system folder" },
  ];
  const preview = { ...base, plan: { ...base.plan, actions: [...base.plan.actions, ...folders], counts: { ...base.plan.counts, archive: 5 } } };
  // history all, titles, archive automated, folders (y / n), pin (+ list), delete, auto-settle no, apply
  const yes = harness({ answers: [...TO_ORGANIZE, "", "y", "y", "y", "y", "", "y", "n", "y", "n"], preview });
  assert.equal(await yes.run(), 0, yes.text());
  assert.match(flat(yes), /Temporary and system folders 2 conversations come from projects t3sm created in temporary or system folders \(scratch work\)\. t3sm can archive them; nothing is deleted\. Default: yes\. Undo: t3sm organize --undo\./);
  assert.match(flat(yes), /Archive these conversations from temporary and system folders\? \[Y\/n/);
  assert.match(flat(yes), /Archive automated +3 +Archive temp and system +2 /);
  assert.equal(yes.writes().at(-1), "run organize --yes");
  const no = harness({ answers: [...TO_ORGANIZE, "", "y", "y", "n", "y", "", "y", "n", "y", "n"], preview });
  assert.equal(await no.run(), 0, no.text());
  assert.doesNotMatch(flat(no), /Archive temp and system +\d/);
  assert.equal(no.writes().at(-1), "run organize --yes --no-archive-folders");
  assert.deepEqual(writesFollowYes(no.events), []);
  const pt = harness({ answers: [...TO_ORGANIZE, "", "s", "s", "s", "s", "", "s", "n", "s", "n"].map((a) => (a === "y" ? "s" : a)), lang: "pt", preview });
  assert.equal(await pt.run(), 0, pt.text());
  assert.match(flat(pt), /2 conversas vêm de projetos que o t3sm criou em pastas temporárias ou do sistema/);
  assert.match(flat(pt), /Arquivar estas conversas de pastas temporárias e de sistema\? \[S\/n/);
  assert.match(flat(pt), /Arquivar temporárias e do sistema +2 /);
  // Without such conversations the question is not asked.
  const none = harness({ answers: [...TO_ORGANIZE, ...ORGANIZE_ALL, "y", "n"], preview: previewFixture() });
  await none.run();
  assert.doesNotMatch(flat(none), /temporary or system folders/);
});

test("organize: pins are reviewed only the first time (an earlier organize run exists: no list)", async () => {
  const earlier: RunSummary = { runId: "O0", at: null, command: "organize", status: "ok", rolledBackBy: null, counts: { imported: 0, importFailed: 0, filesWritten: 0, quarantined: 0, unquarantined: 0, defaults: 0, instances: 0, projects: 0, archived: 0, merged: 0, organized: 5, organizeReverted: 0 } };
  const h = harness({ answers: [...TO_ORGANIZE, "", "y", "y", "y", "y", "n", "y"], preview: previewFixture(), runs: [earlier] });
  assert.equal(await h.run(), 0, h.text());
  assert.doesNotMatch(flat(h), /Projects to pin/);
  assert.equal(h.writes().at(-1), "run organize --yes");
});

test("organize: a T3 Code that does not report auto-settle gets no such question; Portuguese asks it in Portuguese", async () => {
  {
    const h = harness({ answers: [...TO_ORGANIZE, "", "y", "y", "y", "", "y", "n"], preview: { ...previewFixture(), autoSettleDays: undefined } });
    await h.run();
    assert.doesNotMatch(flat(h), /auto-settle for new conversations|settle conversations started in T3 Code/);
  }
  const pt = harness({ answers: [...TO_ORGANIZE, "", "y", "y", "y", "", "y", "n", "n"].map((a) => (a === "y" ? "s" : a)), lang: "pt", preview: previewFixture() });
  assert.equal(await pt.run(), 0, pt.text());
  const t = flat(pt);
  assert.match(t, /Passo 9 de 11 · Arrumar/);
  assert.match(t, new RegExp(CATALOGUES.pt.organizePreviewHead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(t, /Deixar também o T3 Code passar para Settled as conversas começadas no T3 Code passados 90 dias\? \[S\/n/);
  assert.match(t, /Agora: passados 7 dias\. O t3sm pode pô-la em 90 dias, como a regra acima\./);
  assert.match(t, /Aplicar estas alterações ao T3 Code agora\? Desfazer: t3sm organize --undo\. \[s\/N/);
  assert.deepEqual(pt.writes(), ["run apply --yes"], "n at Apply");
});

test("organize: nothing to tidy says so; nothing imported shows no step; a command failure (exit 5) says what to do", async () => {
  const empty = harness({ answers: [...TO_ORGANIZE], preview: { ...previewFixture(), plan: { ...previewFixture().plan, actions: [] } } });
  assert.equal(await empty.run(), 0, empty.text());
  assert.match(flat(empty), /Nothing to tidy: T3 Code already shows your history the way t3sm would leave it\./);
  const none = harness({ answers: [...TO_ORGANIZE], preview: null });
  await none.run();
  assert.doesNotMatch(flat(none), /Step 9 of 11/);
  const part = harness({ answers: [...TO_ORGANIZE, ...ORGANIZE_ALL, "y", "n"], preview: previewFixture(), codes: (a) => (a[0] === "organize" ? 5 : 0) });
  assert.equal(await part.run(), 5, part.text());
  assert.match(flat(part), /Some changes could not be made \(listed above\)\./);
});

test("organize on an untested T3 Code version: no --allow-untested, and a lock taken before the config is saved writes nothing", async () => {
  const untested = [[{ id: "t3-version" as const, status: "warn" as const, message: "0.2.0 has not been tested with t3sm (tested: 0.1.9)", fix: "Nothing is required" }]];
  const h = harness({ answers: ["y", "y", "n", "y", "c", "n", "n", "n", "y", ...ORGANIZE_ALL, "y", "n"], checks: untested, preview: previewFixture() });
  assert.equal(await h.run(), 0, h.text());
  assert.ok(h.calls().includes("organizePreview"));
  assert.equal(h.writes().at(-1), "run organize --yes");
  const locked = harness({ answers: [...TO_ORGANIZE, ...ORGANIZE_ALL, "y"], preview: previewFixture(), saveLocked: true });
  assert.equal(await locked.run(), 0);
  assert.deepEqual(locked.writes().filter((w) => w.startsWith("run organize")), []);
});

test("organize: Enter at every question, resuming after a full import, never writes", async () => {
  const run: RunSummary = { runId: "A", at: null, command: "apply P0", status: "ok", rolledBackBy: null, counts: { imported: 3, importFailed: 0, filesWritten: 0, quarantined: 0, unquarantined: 0, defaults: 0, instances: 0, projects: 0, archived: 0, merged: 0, organized: 0, organizeReverted: 0 } };
  const h = harness({ answers: Array.from({ length: 40 }, () => ""), config: { exists: true, language: null, hasPlan: true }, runs: [run], preview: previewFixture() });
  assert.equal(await h.run(), 0, h.text());
  assert.match(flat(h), /Next: a quick check, then step 9 · Organize\./);
  assert.match(flat(h), /Step 9 of 11 · Organize/);
  assert.deepEqual(h.writes(), []);
  assert.ok(!h.exhausted());
});

test("decisions: an inferred destination shows its share in the row's reason (EN and PT); several conversations add up", async () => {
  const moves = [{ from: SCRATCH, to: BIG, n: 1, share: { hits: 63, total: 80 } }];
  for (const lang of ["en", "pt"] as const) {
    const yes = lang === "pt" ? "s" : "y";
    const h = harness({ answers: [...PRE, yes, yes, "", ...SKIP_REST].map((a) => (lang === "pt" && a === "y" ? "s" : a)), lang, pending: [{ key: "t3-refused", sessions: 1, folders: 1 }], moves });
    await h.run();
    assert.match(flat(h), lang === "en" ? /63 of 80 paths in big\./ : /63 de 80 caminhos em big\./, lang);
  }
});

test("organize: a part the saved config turned off is still offered, saying it is off and what turning it on does", async () => {
  const off = { history: false, titles: true, archiveAutomated: false, pinRecent: false };
  const h = harness({ answers: [...TO_ORGANIZE, "", "y", "y", "y", "", "y", "n", "y", "n"], preview: { ...previewFixture(), off } });
  assert.equal(await h.run(), 0, h.text());
  assert.match(flat(h), /Clearer titles .*Off in your settings now; turning it on retitles 2 conversations\./);
  assert.match(flat(h), /Give these conversations clearer titles\? \[y\/N/, "default stays off");
  assert.equal(h.saved.at(-1)?.titles, true);
});

// ---------------- Task 9: the history rule question and T3 Code's own option ----------------

/** titles y, archive y, pin y (+ list confirmed), delete y. */
const PARTS_YES = ["y", "y", "y", "", "y"];

test("assistant: Enter keeps 90/10 and offers T3 option 90 (default yes)", async () => {
  const h = harness({ answers: [...TO_ORGANIZE, "?", "", ...PARTS_YES, "", "y", "n"], preview: previewFixture() });
  assert.equal(await h.run(), 0, h.text());
  assert.equal(h.left(), 0);
  const t = flat(h);
  assert.match(t, /each project shows its last 90 days, and at least 10 even if older/);
  assert.match(t, /4 conversations shown again, 0 settled, in 2 projects/);
  assert.match(t, /Show the last 90 days, and at least 10 per project\? \[Y\/n/);
  assert.match(t, /n lets you type others/, "? explains");
  assert.match(t, /Now: after 7 days\. t3sm can set it to 90 days, like the rule above\./);
  assert.match(t, /Also let T3 Code settle conversations started in T3 Code after 90 days\? \[Y\/n/);
  assert.doesNotMatch(t, /Also turn off T3 Code's auto-settle/);
  assert.match(t, /History +the last 90 days, at least 10 per project +shown again +4 +settled +0/);
  assert.match(t, /T3 Code's option +90 days \(now after 7 days\)/);
  assert.deepEqual(h.saved.at(-1)?.history, { days: 90, minPerProject: 10 });
  assert.ok(h.saved.at(-1)?.decided?.includes("history"));
  assert.equal(h.writes().at(-1), "run organize --yes --auto-settle 90");
  assert.deepEqual(writesFollowYes(h.events), []);
  // n to the T3 option: no flag; already 90 in T3 Code: not asked at all.
  const no = harness({ answers: [...TO_ORGANIZE, "", ...PARTS_YES, "n", "y", "n"], preview: previewFixture() });
  assert.equal(await no.run(), 0, no.text());
  assert.equal(no.writes().at(-1), "run organize --yes");
  const same = harness({ answers: [...TO_ORGANIZE, "", ...PARTS_YES, "y", "n"], preview: previewFixture({ autoSettleDays: 90 }) });
  assert.equal(await same.run(), 0, same.text());
  assert.doesNotMatch(flat(same), /settle conversations started in T3 Code after/);
  assert.equal(same.writes().at(-1), "run organize --yes");
  // T3 Code's option off today: offered too (default yes).
  const off = harness({ answers: [...TO_ORGANIZE, "", ...PARTS_YES, "", "y", "n"], preview: previewFixture({ autoSettleDays: null }) });
  assert.equal(await off.run(), 0, off.text());
  assert.match(flat(off), /Now: off\. t3sm can set it to 90 days/);
  assert.equal(off.writes().at(-1), "run organize --yes --auto-settle 90");
});

test("assistant: days 120 offers keep or off, never 120", async () => {
  for (const [answer, flags] of [["", "run organize --yes"], ["n", "run organize --yes --auto-settle off"]] as const) {
    // n, then a bad number, 120 days and a minimum of 5.
    const h = harness({ answers: [...TO_ORGANIZE, "n", "4000", "120", "x", "5", ...PARTS_YES, answer, "y", "n"], preview: previewFixture() });
    assert.equal(await h.run(), 0, h.text());
    assert.equal(h.left(), 0);
    const t = flat(h);
    assert.match(t, /Days each project shows: 1 to 3650, all, or none \(Enter = 90\):/);
    assert.match(t, /Type a number from 1 to 3650, all, or none\./);
    assert.match(t, /At least how many per project, even older ones\? 0 to 1000 \(Enter = 10\):/);
    assert.match(t, /Type a number from 0 to 1000\./);
    assert.match(t, /accepts at most 90 days, so it cannot follow the last 120 days/);
    assert.match(t, /Leave T3 Code's own option as it is \(now 7 days\)\? n turns it off\. \[Y\/n/);
    assert.doesNotMatch(t, /after 120 days\?|auto-settle 120/);
    assert.match(t, /History +the last 120 days, at least 5 per project +shown again +4 +settled +0/, "other numbers: counted by a preview planned with them");
    assert.ok(h.calls().includes('organizePreview {"days":120,"minPerProject":5}'));
    assert.deepEqual(h.saved.at(-1)?.history, { days: 120, minPerProject: 5 });
    assert.equal(h.writes().at(-1), flags);
    if (answer === "n") assert.match(t, /T3 Code's option +off \(now after 7 days\)/);
  }
  // all: no minimum question; same keep-or-off offer.
  const all = harness({ answers: [...TO_ORGANIZE, "n", "all", ...PARTS_YES, "", "y", "n"], preview: previewFixture() });
  assert.equal(await all.run(), 0, all.text());
  assert.doesNotMatch(flat(all), /At least how many per project/);
  assert.match(flat(all), /cannot follow all of its history/);
  assert.deepEqual(all.saved.at(-1)?.history, { days: "all", minPerProject: 10 });
  // none: the rule off; T3 Code's option keeps the old question (turn it off? default no).
  const none = harness({ answers: [...TO_ORGANIZE, "n", "none", ...PARTS_YES, "", "y", "n"], preview: previewFixture() });
  assert.equal(await none.run(), 0, none.text());
  assert.match(flat(none), /Also turn off T3 Code's auto-settle for new conversations\? \[y\/N/);
  assert.equal(none.saved.at(-1)?.history, "off");
  assert.equal(none.writes().at(-1), "run organize --yes");
});

test("assistant: a plan with only settles still asks the history question, and says how many are settled", async () => {
  const base = previewFixture();
  const settle = (id: string): OrganizeAction => ({ kind: "settle", target: id, projectId: "alpha", previous: null, next: { settledAt: "2026-07-01T00:00:00.000Z" }, reason: "history: older than 90 days" });
  const preview = { ...base, plan: { ...base.plan, actions: [settle("import:o1"), settle("import:o2"), settle("import:o3")], counts: { ...base.plan.counts, archive: 0, title: 0, unsettle: 0, settle: 3, pin: 0, "project-delete": 0 } } };
  const h = harness({ answers: [...TO_ORGANIZE, "", "", "y", "n"], preview });
  assert.equal(await h.run(), 0, h.text());
  assert.equal(h.left(), 0);
  const t = flat(h);
  assert.match(t, /0 conversations shown again, 3 settled, in 1 project/);
  assert.match(t, /Show the last 90 days, and at least 10 per project\? \[Y\/n/);
  assert.match(t, /History +the last 90 days, at least 10 per project +shown again +0 +settled +3/);
  assert.deepEqual(h.saved.at(-1)?.history, { days: 90, minPerProject: 10 });
  assert.equal(h.writes().at(-1), "run organize --yes --auto-settle 90");
});

test("assistant: the history question and T3 Code's option in Portuguese", async () => {
  const h = harness({ answers: [...TO_ORGANIZE, "", ...PARTS_YES, "", "s", "n"].map((a) => (a === "y" ? "s" : a)), lang: "pt", preview: previewFixture() });
  assert.equal(await h.run(), 0, h.text());
  const t = flat(h);
  assert.match(t, /Mostrar os últimos 90 dias, e pelo menos 10 por projeto\? \[S\/n/);
  assert.match(t, /4 conversas voltam a aparecer, 0 passam para Settled, em 2 projetos/);
  assert.match(t, /Deixar também o T3 Code passar para Settled as conversas começadas no T3 Code passados 90 dias\? \[S\/n/);
  assert.equal(h.writes().at(-1), "run organize --yes --auto-settle 90");
});
