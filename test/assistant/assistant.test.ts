import { test } from "node:test";
import assert from "node:assert/strict";
import { T3NotRunning } from "../../src/t3/errors.ts";
import { resumePoint } from "../../src/assistant/steps.ts";
import { en } from "../../src/assistant/messages.en.ts";
import { pt } from "../../src/assistant/messages.pt.ts";
import type { RunSummary } from "../../src/ops/rollback.ts";
import { BIG, DEMO, harness, writesFollowYes } from "./helpers.ts";

/** Every prompt of the full happy path, in order (fresh machine: no config, no runs). */
const HAPPY = [
  "y", // 1 ready to start
  "y", // 2 continue to the accounts
  "y", // 3 create the missing instance
  "n", //   names right? no
  "1", //   which account
  "Personal", // new name
  "4", //   colour purple
  "y", //   rename
  "n", //   another?
  "1", // 4 change project #1 (big)
  "1", //   to account 1 (Personal)
  "y", //   save the route
  "c", //   continue
  "y", // 5 quarantine
  "y", //   dedupe
  "", //  6 pilot: Enter = suggestion 1 (demo)
  "y", //   import it
  "y", //   looks right
  "y", // 7 import everything
  "y", // 8 install the watcher
];

const EXPECTED_WRITES = [
  "run accounts --init",
  "run accounts --apply --yes",
  "run accounts --rename claudeAgent Personal --color #7C3AED",
  `run projects set ${BIG} claudeAgent --yes`,
  "run quarantine --yes",
  "run dedupe --yes",
  `run apply --yes --only ${DEMO}`,
  "run apply --yes",
  "run schedule install --watch",
];

const flow = (calls: string[]): string[] => calls.filter((c) => c !== "lockHolder" && c !== "config" && c !== "scheduleInstalled");

test("happy path in English: every step in order, each write right after a yes", async () => {
  const h = harness({ answers: HAPPY });
  assert.equal(await h.run(), 0, h.text());
  assert.equal(h.left(), 0, "every scripted answer was used");
  assert.deepEqual(h.writes(), EXPECTED_WRITES);
  assert.deepEqual(writesFollowYes(h.events), []);
  assert.deepEqual(flow(h.calls()), [
    "doctor", "accounts", "run accounts --init", "run accounts --apply --yes", "accounts",
    "run accounts --rename claudeAgent Personal --color #7C3AED",
    "plan", `run projects set ${BIG} claudeAgent --yes`, "plan",
    "cleanupCounts", "run quarantine --yes", "run dedupe --yes", "plan",
    `run apply --dry-run --only ${DEMO}`, `run apply --yes --only ${DEMO}`,
    "plan", "run apply --yes",
    "run schedule install --watch",
  ]);
  const text = h.flat();
  for (let n = 1; n <= 9; n++) assert.ok(text.includes(`Step ${n} of 9`), `step ${n} shown`);
  assert.match(text, /an "instance": a Claude account inside T3 Code/);
  assert.match(text, /b\*\*\*@example\.com/);
  assert.match(text, /Sessions to import\s+23/);
  assert.match(text, /- Imported everything \(run R\d\)/);
  assert.match(text, /t3sm rollback --run <id>/);
  assert.match(h.text(), /\n  t3sm doctor  +checks.*\n  t3sm projects  +shows.*\n  t3sm merge  +brings/);
  assert.match(text, /Preferes português\? \/ Prefer Portuguese\? Run: t3sm start --lang pt/);
});

test("happy path in Portuguese: same calls, Portuguese text, s counts as yes", async () => {
  const answers = HAPPY.map((a) => (a === "y" ? "s" : a));
  const h = harness({ answers, lang: "pt" });
  assert.equal(await h.run(), 0, h.text());
  assert.deepEqual(h.writes(), EXPECTED_WRITES);
  assert.deepEqual(writesFollowYes(h.events), []);
  const text = h.flat();
  assert.match(text, /Passo 1 de 9 · Boas-vindas/);
  assert.match(text, /Passo 9 de 9 · Concluído/);
  assert.match(text, /Prefer English\? \/ Preferes inglês\?/);
  assert.match(h.prompts.join("\n"), /Pronto para começar\? \[Y\/n\/\?\/q\]/);
});

test("pressing Enter at every question never writes (write questions default to No)", async () => {
  const h = harness({ answers: Array.from({ length: 40 }, () => "") });
  assert.equal(await h.run(), 0, h.text());
  assert.deepEqual(h.writes(), [], h.calls().join("\n"));
  assert.ok(h.calls().includes(`run apply --dry-run --only ${DEMO}`), "the dry run (read-only) still shows what would happen");
  assert.match(h.flat(), /During the import t3sm hides these copies/);
  assert.match(h.flat(), /Step 9 of 9/);
  for (const p of h.prompts.filter((q) => /T3 Code|config\.json|quarantine|scheduler/.test(q) && /\[/.test(q))) {
    assert.match(p, /\[y\/N/, `write question defaults to no: ${p}`);
  }
});

test("q at any question quits cleanly: exit 0, the quit line, and only the writes already confirmed before it", async () => {
  const full = harness({ answers: HAPPY });
  await full.run();
  const asks = full.events.map((e, i) => ({ e, i })).filter((x) => x.e.t === "ask");
  for (let k = 0; k < HAPPY.length; k++) {
    const before = full.events.slice(0, asks[k]!.i).filter((e) => e.t === "call" && e.write).map((e) => (e as { name: string }).name);
    const h = harness({ answers: [...HAPPY.slice(0, k), "q"] });
    assert.equal(await h.run(), 0, `q at answer ${k}`);
    assert.match(h.flat(), /Stopped\. Nothing is left half done; run t3sm again to continue\./, `q at answer ${k}`);
    assert.deepEqual(h.writes(), before, `q at answer ${k}`);
    assert.equal(h.left(), 0);
  }
});

test("Ctrl+C at a prompt and closed input behave like q", async () => {
  const c = harness({ answers: ["y", "\u0003"] });
  assert.equal(await c.run(), 0);
  assert.match(c.flat(), /Nothing is left half done/);
  const e = harness({ answers: ["y"] }); // the script runs out: prompt rejects (input closed)
  assert.equal(await e.run(), 0);
  assert.ok(e.exhausted());
  assert.match(e.flat(), /Nothing is left half done/);
  assert.deepEqual(e.writes(), []);
});

test("? prints the longer explanation and asks the same question again; an unknown answer re-asks", async () => {
  const h = harness({ answers: ["?", "maybe", "y", "q"] });
  assert.equal(await h.run(), 0);
  assert.ok(h.flat().includes("The steps: 2 checks this machine"));
  assert.match(h.flat(), /Please answer y \(yes\), n \(no\), \? \(more detail\) or q \(quit\)\./);
  assert.equal(h.prompts[0], h.prompts[1]);
  assert.equal(h.prompts[1], h.prompts[2]);
});

test("b goes back a step; after a write it says going back undoes nothing, and nothing is redone without a new yes", async () => {
  const h = harness({ answers: ["y", "b", "y", "y", "n", "y", "c", "y", "n", "b", "n", "n", "q"] });
  assert.equal(await h.run(), 0, h.text());
  assert.equal(h.text().split("Step 1 of 9").length - 1, 2, "b at the check returns to the welcome");
  assert.match(h.flat(), /Going back does not undo what was already done/);
  assert.equal(h.text().split("Step 5 of 9").length - 1, 2, "b at the pilot returns to the clean-up");
  assert.deepEqual(h.writes(), ["run quarantine --yes"]);
  assert.deepEqual(writesFollowYes(h.events), []);
  const first = harness({ answers: ["b", "q"] });
  await first.run();
  assert.match(first.flat(), /Please answer y \(yes\), n \(no\), \? \(more detail\) or q \(quit\)/, "no b on the first question");
});

test("a failing check stops with the fix and exit 1, before anything else", async () => {
  const h = harness({ answers: ["y"], checks: [[{ id: "config", status: "fail", message: "config.json: invalid JSON", fix: "Fix config.json, or delete it and run t3sm accounts --init" }]] });
  assert.equal(await h.run(), 1);
  assert.match(h.text(), /These must be fixed first:\n- config\.json: invalid JSON\n  What to do: Fix config\.json/);
  assert.match(h.flat(), /then run t3sm again\. Nothing was changed\./);
  assert.deepEqual(flow(h.calls()), ["doctor"]);
});

test("T3 Code not running: explains how to open it, re-checks on yes, quits on no", async () => {
  const down = [{ id: "t3-reachable", status: "fail" as const, message: "T3 Code is not answering", fix: "Open T3 Code from the Start menu" }];
  const ok = [{ id: "t3-reachable", status: "ok" as const, message: "answering" }];
  const h = harness({ answers: ["y", "y", "q"], checks: [down, ok] });
  assert.equal(await h.run(), 0);
  assert.match(h.flat(), /Open it the usual way \(Start menu, Dock or app launcher\), not from a terminal/);
  assert.match(h.flat(), /CLAUDE_CONFIG_DIR/);
  assert.equal(h.calls().filter((c) => c === "doctor").length, 2);
  const n = harness({ answers: ["y", "n"], checks: [down] });
  assert.equal(await n.run(), 0);
  assert.match(n.flat(), /Nothing is left half done/);
  assert.deepEqual(n.writes(), []);
});

test("an untested T3 Code version: Enter stops; yes passes --allow-untested to every command", async () => {
  const untested = [[{ id: "t3-version", status: "fail" as const, message: "0.2.0 is untested (tested: 0.1.9)", fix: "Update t3sm" }]];
  const no = harness({ answers: ["y", ""], checks: untested });
  assert.equal(await no.run(), 0);
  assert.match(no.flat(), /Update t3sm or T3 Code, then run t3sm again/);
  assert.deepEqual(flow(no.calls()), ["doctor"]);
  const yes = harness({ answers: ["y", "y", "y", "y", "y", "c", "n", "n", "1", "y", "q"], checks: untested });
  assert.equal(await yes.run(), 0, yes.text());
  assert.match(yes.flat(), /0\.2\.0 is untested/);
  assert.ok(yes.calls().includes("accounts:untested"));
  assert.ok(yes.calls().includes("plan:untested"));
  assert.ok(yes.writes().includes("run accounts --apply --yes --allow-untested"));
  assert.ok(yes.writes().includes(`run apply --yes --only ${DEMO} --allow-untested`));
});

test("pilot looks wrong: offers to undo that run (archiving its threads) and stops with next steps", async () => {
  const h = harness({ answers: ["y", "y", "n", "y", "c", "n", "n", "", "y", "n", "y"] });
  assert.equal(await h.run(), 0, h.text());
  assert.deepEqual(h.writes(), [`run apply --yes --only ${DEMO}`, "run rollback --run R1 --yes --archive-threads"]);
  assert.deepEqual(writesFollowYes(h.events), []);
  assert.match(h.flat(), /Undo the pilot \(run R1\)\?/);
  assert.match(h.flat(), /t3sm projects set "<folder>" <account>/);
  assert.doesNotMatch(h.flat(), /Step 7 of 9/);
});

test("another t3sm run holds the lock: explains and exits 0 without a single check", async () => {
  const h = harness({ answers: [], lock: () => ({ pid: 4242 }) });
  assert.equal(await h.run(), 0);
  assert.match(h.flat(), /Another t3sm run is working right now \(process 4242\)/);
  assert.deepEqual(h.calls(), ["lockHolder"]);
});

test("a lock taken meanwhile stops before the write it would have run", async () => {
  const h = harness({ answers: ["y", "y", "y"], lock: (n) => (n === 0 ? null : { pid: 7 }) });
  assert.equal(await h.run(), 0);
  assert.match(h.flat(), /Another t3sm run started meanwhile \(process 7\)/);
  assert.deepEqual(h.writes(), []);
});

test("a failing command's exit code propagates, with what to do", async () => {
  const h = harness({ answers: ["y", "y", "n", "y", "c", "y"], codes: (a) => (a[0] === "quarantine" ? 1 : 0) });
  assert.equal(await h.run(), 1);
  assert.match(h.flat(), /That step did not finish \(exit code 1\)/);
  const e = harness({ answers: ["y", "y", "n", "y"], planError: new T3NotRunning() });
  assert.equal(await e.run(), 3);
  assert.match(e.flat(), /T3 Code is not running\. Open it from the Start menu/);
  assert.match(e.flat(), /Fix that, then run t3sm again/);
});

test("the full import with failures and held projects says what to do for each and ends with exit 5", async () => {
  const answers = ["y", "y", "n", "y", "c", "n", "n", "n", "y", "n"];
  const h = harness({
    answers,
    codes: (a) => (a[0] === "apply" && !a.includes("--only") && a.includes("--yes") ? 5 : 0),
    output: (a) => (a[0] === "apply" && a.includes("--yes") ? "Imported 20, failed 1, held 1. Run R1.\nHeld (a session is in use): busy. Close the session or wait 10 minutes, then run again.\n" : "ok\n"),
  });
  assert.equal(await h.run(), 5, h.text());
  assert.match(h.flat(), /Some sessions could not be imported/);
  assert.match(h.flat(), /Some projects were held because one of their sessions was in use/);
  assert.match(h.flat(), /Projects in use right now \(they wait for a later run\): 1\./);
});

const runOf = (runId: string, command: string, extra: Partial<RunSummary> = {}, importFailed = 0): RunSummary => ({
  runId, at: null, command, status: "ok", rolledBackBy: null,
  counts: { imported: 2, importFailed, filesWritten: 0, quarantined: 0, unquarantined: 0, defaults: 0, instances: 0, projects: 0, archived: 0, merged: 0 }, ...extra,
});
const SET_UP = { exists: true, language: null, hasPlan: true };

test("resume after a pilot: asks to check it in T3 Code first (q there last time), or starts over without undoing anything", async () => {
  const runs = [runOf("R0", "apply P0 --only")];
  const h = harness({ answers: ["y", "y", "y", "q"], runs, config: SET_UP });
  assert.equal(await h.run(), 0);
  assert.match(h.flat(), /It looks like you already imported a pilot project\. After the check, I continue at step 6 \(Pilot\)\./);
  assert.match(h.flat(), /Your pilot import \(run R0\) is in T3 Code/);
  assert.doesNotMatch(h.flat(), /Project to try/);
  assert.match(h.flat(), /Step 7 of 9/, "it looked right: on to the full import");
  const wrong = harness({ answers: ["y", "y", "n", "y"], runs, config: SET_UP });
  assert.equal(await wrong.run(), 0);
  assert.deepEqual(wrong.writes(), ["run rollback --run R0 --yes --archive-threads"]);
  assert.deepEqual(writesFollowYes(wrong.events), []);
  const over = harness({ answers: ["y", "n", "y", "q"], runs, config: SET_UP });
  assert.equal(await over.run(), 0);
  assert.match(over.flat(), /Step 3 of 9/);
  assert.deepEqual(over.writes(), []);
});

test("resume after a full import that failed partly or was interrupted: says so and continues at the full import", async () => {
  const partial = harness({ answers: ["y", "y", "q"], runs: [runOf("R0", "apply P0", { status: "partial" }, 3)], config: SET_UP });
  await partial.run();
  assert.match(partial.flat(), /It looks like you already ran the full import, but the last one finished with 3 failures\. After the check, I continue at step 7 \(Full import\)\./);
  const cut = harness({ answers: ["y", "y", "q"], runs: [runOf("R0", "apply P0", { status: "aborted" })], config: SET_UP });
  await cut.run();
  assert.match(cut.flat(), /started the full import, but the last one was interrupted\. .*step 7 \(Full import\)/);
  const ok = harness({ answers: ["y", "y", "q"], runs: [runOf("R0", "apply P0", { status: "partial" }, 3), runOf("R1", "apply P1")], config: SET_UP });
  await ok.run();
  assert.match(ok.flat(), /you already ran the full import\. After the check, I continue at step 8/);
});

test("resumePoint: from config, plan, journal runs and the scheduler only", () => {
  const base = { configExists: true, hasPlan: true, scheduleInstalled: false };
  assert.equal(resumePoint({ ...base, configExists: false, hasPlan: false, runs: [] }), null);
  assert.equal(resumePoint({ ...base, hasPlan: false, runs: [] }), null, "config.json alone is not a plan");
  assert.deepEqual(resumePoint({ ...base, runs: [] }), { step: 4, what: "resumeConfig" });
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "quarantine")] }), { step: 5, what: "resumeCleanupPart" }, "dedupe still to ask");
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "quarantine"), runOf("y", "dedupe P1")] }), { step: 6, what: "resumeCleanup" });
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "dedupe P1"), runOf("p", "apply P1 --only")] }), { step: 6, what: "resumePilot", runId: "p" });
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "apply P1", { status: "partial" }, 4)] }), { step: 7, what: "resumeFullPartial", n: 4 });
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "apply P1", { status: "incomplete" })] }), { step: 7, what: "resumeFullInterrupted" });
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "apply P1")] }), { step: 8, what: "resumeFull" });
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "apply P1")], scheduleInstalled: true }), { step: 9, what: "resumeFullSync" });
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "apply P1 --only", { rolledBackBy: "y" })] }), { step: 4, what: "resumeConfig" }, "a rolled-back pilot does not count");
});

test("lock race: a command that found the lock taken (exit 0) is not reported as done", async () => {
  const h = harness({ answers: ["y", "y", "n", "y", "c", "n", "n", "n", "y"], output: (a) => (a[0] === "apply" && a.includes("--yes") ? "Another t3sm run is in progress.\n" : "ok\n") });
  assert.equal(await h.run(), 0);
  assert.match(h.flat(), /Another t3sm run started meanwhile/);
  assert.doesNotMatch(h.flat(), /All done|Imported everything|Step 8 of 9/);
  const q = harness({ answers: ["y", "y", "n", "y", "c", "y"], output: (a) => (a[0] === "quarantine" ? "Another t3sm run is in progress.\n" : "ok\n") });
  assert.equal(await q.run(), 0);
  assert.match(q.flat(), /Another t3sm run started meanwhile/);
  assert.doesNotMatch(q.flat(), /Moved backup folders/);
});

test("--lang on a first run: the offer to save it comes once config.json exists (at the summary)", async () => {
  const h = harness({ answers: ["s", "s", "n", "s", "c", "n", "n", "n", "n", "s"], lang: "pt", langFromFlag: true });
  assert.equal(await h.run(), 0, h.text());
  assert.match(h.flat(), /Guardar o português como idioma do assistente/);
  assert.deepEqual(h.writes(), ["saveLanguage pt"]);
  assert.deepEqual(writesFollowYes(h.events), []);
});

test("Ctrl+C during the import (exit 130) says it stopped at your request, not that something must be fixed", async () => {
  const h = harness({ answers: ["y", "y", "n", "y", "c", "n", "n", "n", "y"], codes: (a) => (a[0] === "apply" && a.includes("--yes") ? 130 : 0) });
  assert.equal(await h.run(), 130);
  assert.match(h.flat(), /Stopped at your request \(Ctrl\+C\)\. What was done so far stays done; run t3sm again to continue\./);
  assert.doesNotMatch(h.flat(), /did not finish|Fix it/);
});

test("input: y at the pilot's project question is not a folder; n on the last plan page means no change", async () => {
  const h = harness({ answers: ["y", "y", "n", "y", "n", "n", "n", "y", "n", "q"] });
  assert.equal(await h.run(), 0);
  assert.match(h.flat(), /Step 5 of 9/, "n on the last page continues");
  assert.match(h.flat(), /Type a number from the list, a folder path, or n to skip the pilot\./);
  assert.match(h.flat(), /OK, no pilot\./);
  assert.deepEqual(h.writes(), []);
});

test("every exit after a write shows what was done, with run ids and how to undo each", async () => {
  const q = harness({ answers: ["y", "y", "n", "y", "c", "y", "n", "q"] });
  assert.equal(await q.run(), 0);
  assert.match(q.flat(), /What this session did: - Moved backup folders to the quarantine \(run R1\) Undo: t3sm rollback --run R1/);
  assert.match(q.flat(), /Nothing is left half done/);
  const fail = harness({ answers: ["y", "y", "n", "y", "c", "y", "y"], codes: (a) => (a[0] === "dedupe" ? 1 : 0) });
  assert.equal(await fail.run(), 1);
  assert.match(fail.flat(), /What this session did: - Moved backup folders to the quarantine \(run R1\)/);
  const none = harness({ answers: ["q"] });
  await none.run();
  assert.doesNotMatch(none.flat(), /What this session did/);
  const full = harness({ answers: HAPPY });
  await full.run();
  assert.equal(full.flat().split("What this session did").length - 1, 1, "shown once");
  assert.match(full.flat(), /Imported everything \(run R\d\) Undo: t3sm rollback --run R\d --archive-threads/);
  assert.match(full.flat(), /Installed background sync Undo: t3sm schedule remove/);
  assert.match(full.flat(), /Undo: t3sm projects unset/);
});

test("Enter at every question, from every state a user can come back in: never writes, always ends", async () => {
  const ok = [{ id: "node-version", status: "ok" as const, message: "Node 22.18" }];
  const states: [string, Parameters<typeof harness>[0]][] = [
    ["fresh", { answers: [] }],
    ["config only", { answers: [], config: { exists: true, language: null } }],
    ["config and plan", { answers: [], config: SET_UP }],
    ["after quarantine", { answers: [], config: SET_UP, runs: [runOf("a", "quarantine")] }],
    ["after clean-up", { answers: [], config: SET_UP, runs: [runOf("a", "quarantine"), runOf("b", "dedupe P1")] }],
    ["after pilot", { answers: [], config: SET_UP, runs: [runOf("a", "apply P1 --only")] }],
    ["after full", { answers: [], config: SET_UP, runs: [runOf("a", "apply P1")] }],
    ["after partial full", { answers: [], config: SET_UP, runs: [runOf("a", "apply P1", { status: "partial" }, 2)] }],
    ["after full and sync", { answers: [], config: SET_UP, runs: [runOf("a", "apply P1")], schedule: true }],
    ["nothing to clean", { answers: [], cleanup: { backupFolders: 0, mirrorCopies: 0 } }],
    ["T3 Code down then up", { answers: [], checks: [[{ id: "t3-reachable", status: "fail", message: "down" }], ok] }],
    ["untested version", { answers: [], checks: [[{ id: "t3-version", status: "fail", message: "9.9 is untested" }]] }],
    ["--lang pt", { answers: [], lang: "pt", langFromFlag: true }],
  ];
  for (const [name, o] of states) {
    const h = harness({ ...o, answers: Array.from({ length: 80 }, () => "") });
    assert.equal(await h.run(), 0, name);
    assert.ok(!h.exhausted(), `${name}: ends by itself`);
    assert.deepEqual(h.writes(), [], name);
  }
});

test("--lang given on the command line: offers to save it in config.json (explicit yes), only when it differs", async () => {
  const h = harness({ answers: ["s", "s", "q"], lang: "pt", langFromFlag: true, config: { exists: true, language: null } });
  assert.equal(await h.run(), 0);
  assert.match(h.flat(), /Guardar o português como idioma do assistente/);
  assert.deepEqual(h.writes(), ["saveLanguage pt"]);
  assert.deepEqual(writesFollowYes(h.events), []);
  const same = harness({ answers: ["s", "q"], lang: "pt", langFromFlag: true, config: { exists: true, language: "pt" } });
  await same.run();
  assert.doesNotMatch(same.flat(), /Guardar o português/);
  const noFlag = harness({ answers: ["s", "q"], lang: "pt", langFromFlag: false, config: { exists: true, language: null } });
  await noFlag.run();
  assert.doesNotMatch(noFlag.flat(), /Guardar o português/);
});

test("output fits 80 columns, never prints a full email, and has no colour codes with colour off", async () => {
  for (const lang of ["en", "pt"] as const) {
    const h = harness({ answers: lang === "pt" ? HAPPY.map((a) => (a === "y" ? "s" : a)) : HAPPY, lang });
    await h.run();
    for (const line of h.printed().split("\n")) assert.ok(line.length <= 80, `${lang}: ${line.length} > 80: ${line}`);
    for (const p of h.prompts) assert.ok(p.length <= 77, `${lang} prompt leaves room for the answer: ${p}`);
    assert.doesNotMatch(h.flat(), /[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]+\.[a-z]{2,}/, "only masked emails");
    assert.doesNotMatch(h.flat(), /\x1b\[/);
  }
  const c = harness({ answers: ["q"], color: true });
  await c.run();
  assert.match(c.flat(), /\x1b\[1mStep 1 of 9/);
});

test("the catalogues: same keys, same placeholders, nothing empty, every message wraps to 80 columns", () => {
  assert.deepEqual(Object.keys(pt).sort(), Object.keys(en).sort());
  const holes = (s: string): string[] => [...s.matchAll(/\{([a-zA-Z0-9_-]+)\}/g)].map((m) => m[1]!).sort();
  for (const k of Object.keys(en) as (keyof typeof en)[]) {
    assert.ok(en[k].trim() !== "", `en.${k} empty`);
    assert.ok(pt[k].trim() !== "", `pt.${k} empty`);
    assert.deepEqual(holes(pt[k]), holes(en[k]), `placeholders of ${k}`);
  }
});

test("plain words: warnings the assistant handles later say which step, ids only under ?, accounts found from plain sources, skips in words", async () => {
  const checks = [[
    { id: "backups-present", status: "warn" as const, message: "27 backup folders inside projects/ (~/.claude: 16)", fix: "Run t3sm quarantine (reversible)" },
    { id: "instances", status: "warn" as const, message: "no T3 instance for claude-org (~/.claude-org)", fix: "Run t3sm accounts --apply" },
    { id: "t3-version", status: "ok" as const, message: "0.1.9-x (same minor as a tested version; t3sm proceeds with a notice)" },
  ]];
  const accounts = [{ id: "claude-org", displayName: "Org", email: null, home: "~/.claude-org", foundVia: ["folder", "shell-profile", "vscode-pin", "t3-instance"], alias: "claude-org", hasInstance: true }];
  const h = harness({ answers: ["y", "?", "y", "y", "q"], checks, accounts });
  await h.run();
  const t = h.flat();
  assert.match(t, /- 27 backup folders inside projects\/ \(~\/\.claude: 16\) Step 5 offers to fix this\./);
  assert.match(t, /- no T3 instance for claude-org \(~\/\.claude-org\) Step 3 offers this\./);
  assert.doesNotMatch(t, /Run t3sm quarantine/);
  assert.match(t, /T3 Code 0\.1\.9-x was not tested exactly, but it is close to a tested version \(same minor\): t3sm goes ahead\./);
  assert.match(t, /Check names \(for t3sm doctor\): backups-present, instances\./, "ids only in the ? detail");
  assert.equal(t.split("backups-present").length - 1, 1);
  assert.match(t, /found from: a ~\/\.claude-\* folder, your shell alias claude-org, VS Code project settings, T3 Code/);
  assert.match(t, /Most common skip reasons: in use right now \(1\)\./);
  const p = harness({ answers: ["q"], lang: "pt" });
  await p.run();
  assert.match(p.flat(), /O que os comandos do t3sm e o doctor escrevem continua em inglês\./);
  const e = harness({ answers: ["q"] });
  await e.run();
  assert.doesNotMatch(e.flat(), /stays in English|continua em inglês/);
});
const syncRun = (id: string): RunSummary => runOf(id, `sync ${id}`, { status: "incomplete" });
const LOCKED_OUT = "Another t3sm run is in progress.\n";

test("lock race where the other run journals its own run: never taken for this step's run (full import, pilot, quarantine)", async () => {
  const cases: [string, string[], (a: string[]) => boolean][] = [
    ["full import", ["y", "y", "n", "y", "c", "n", "n", "n", "y"], (a) => a[0] === "apply" && a.includes("--yes") && !a.includes("--only")],
    ["pilot", ["y", "y", "n", "y", "c", "n", "n", "", "y", "n", "y"], (a) => a[0] === "apply" && a.includes("--yes") && a.includes("--only")],
    ["quarantine", ["y", "y", "n", "y", "c", "y", "n", "q"], (a) => a[0] === "quarantine"],
  ];
  for (const [name, answers, hit] of cases) {
    const h = harness({ answers, output: (a) => (hit(a) ? LOCKED_OUT : "ok\n"), foreign: (a) => (hit(a) ? syncRun("SYNC1") : null) });
    assert.equal(await h.run(), 0, name);
    const t = h.flat();
    assert.match(t, /Another t3sm run started meanwhile/, name);
    assert.doesNotMatch(t, /SYNC1/, `${name}: the other run's id is never shown as ours`);
    assert.doesNotMatch(t, /All done|Does it look right|Moved backup folders/, name);
    assert.deepEqual(h.writes().filter((w) => w.startsWith("run rollback")), [], name);
  }
});

test("a run journaled by another process during a successful command is not taken as this command's run", async () => {
  const h = harness({ answers: ["y", "y", "n", "y", "c", "y", "n", "q"], foreign: (a) => (a[0] === "quarantine" ? syncRun("SYNC2") : null) });
  assert.equal(await h.run(), 0);
  assert.match(h.flat(), /Moved backup folders to the quarantine \(run R1\)/);
  assert.doesNotMatch(h.flat(), /SYNC2/);
});

test("route undo is true: back to the folder's own previous route, or unset; nothing recorded when nothing changed", async () => {
  const own = harness({ answers: ["y", "y", "n", "y", "1", "1", "y", "c", "q"], routes: [{ match: BIG, account: "claude-org" }] });
  await own.run();
  assert.match(own.flat(), new RegExp(`now uses Claude · Personal Undo: t3sm projects set "${BIG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" claude-org`));
  const none = harness({ answers: ["y", "y", "n", "y", "1", "1", "y", "c", "q"] });
  await none.run();
  assert.match(none.flat(), /now uses Claude · Personal Undo: t3sm projects unset "/);
  const same = harness({ answers: ["y", "y", "n", "y", "1", "1", "y", "c", "q"], output: (a) => (a[0] === "projects" ? "Nothing to change: it already uses Claude · Personal.\n" : "ok\n") });
  await same.run();
  assert.doesNotMatch(same.flat(), /What this session did/);
});

test("every write question says how to undo it, and its choices are never alone on the prompt line", async () => {
  for (const lang of ["en", "pt"] as const) {
    const h = harness({ answers: lang === "pt" ? HAPPY.map((a) => (a === "y" ? "s" : a)) : HAPPY, lang });
    await h.run();
    for (const p of h.prompts) assert.doesNotMatch(p.trim(), /^\[/, `${lang}: choices alone on the line: ${JSON.stringify(p)}`);
    const t = h.flat();
    if (lang === "en") {
      assert.match(t, /Create the missing instances in T3 Code now\?.* Undo: remove each new instance in T3 Code settings \(Providers\)\./);
      assert.match(t, /Rename claudeAgent to "Personal" .* Undo: t3sm rollback --run <id> --instances\./);
      assert.match(t, /Save in config\.json that .*big uses Claude · Personal \(new threads and converted sessions\), and its default in T3 Code\? Undo later: t3sm projects unset ".*big"\./);
      assert.match(t, /Install the background watcher now\?.* Undo: t3sm schedule remove\./);
      assert.match(t, /Move the backup folders to the quarantine\? Undo: t3sm rollback --run <id>\./);
      assert.match(t, /Import .*demo now\? This writes to T3 Code; afterwards you can undo it\. \[y\/N/);
    } else {
      assert.match(t, /e a predefinição do projeto no T3 Code\?/);
      assert.match(t, /encontrada através de:/);
      assert.match(t, /Desfazer: remove cada instância nova nas definições do T3 Code/);
    }
  }
  const l = harness({ answers: ["s", "s", "q"], lang: "pt", langFromFlag: true, config: { exists: true, language: null } });
  await l.run();
  assert.match(l.flat(), /Guardar o português como idioma do assistente no config\.json\? Para desfazer: edita lá "language"\./);
});
test("random answers from every state: each write comes right after a yes to its own question", async () => {
  const own: [RegExp, RegExp][] = [
    [/^run accounts --(init|apply)/, /Create the missing instances|Criar agora as instâncias|Rename .* in T3 Code and config\.json|Mudar o nome de/],
    [/^run accounts --rename/, /Rename .* in T3 Code and config\.json|Mudar o nome de/],
    [/^run projects set/, /Save in config\.json that|Guardar no config\.json que/],
    [/^run quarantine/, /Move the backup folders|Mover as pastas de backup/],
    [/^run dedupe/, /Move the mirror copies|Mover as cópias-espelho/],
    [/^run apply --yes --only/, /Import .* now\?|Importar .* agora\?/],
    [/^run apply --yes/, /Import everything now|Importar tudo agora/],
    [/^run rollback/, /Undo the pilot|Desfazer o piloto/],
    [/^run schedule install/, /Install the background watcher|Instalar agora a sincroniza/],
    [/^saveLanguage/, /Save English|Guardar o português/],
  ];
  const TOK = ["", "", "y", "y", "n", "q", "b", "?", "s", "1", "2", "c", "7", "#123456", "x", "\u0003", "yes", "sim", "Personal"];
  const states: Parameters<typeof harness>[0][] = [
    { answers: [] }, { answers: [], config: SET_UP }, { answers: [], config: SET_UP, runs: [runOf("a", "quarantine")] },
    { answers: [], config: SET_UP, runs: [runOf("a", "apply P1 --only")] }, { answers: [], config: SET_UP, runs: [runOf("a", "apply P1")] },
    { answers: [], lang: "pt", langFromFlag: true }, { answers: [], lang: "en", langFromFlag: true, config: { exists: true, language: "pt", hasPlan: true } },
  ];
  let seed = 7;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let writes = 0;
  for (let i = 0; i < 700; i++) {
    const answers = Array.from({ length: 5 + Math.floor(rnd() * 40) }, () => TOK[Math.floor(rnd() * TOK.length)]!);
    const h = harness({ ...states[i % states.length]!, answers });
    await h.run();
    assert.deepEqual(writesFollowYes(h.events), [], JSON.stringify(answers));
    let lastAsk: Extract<(typeof h.events)[number], { t: "ask" }> | null = null;
    let prevAt = -1;
    for (const e of h.events) {
      if (e.t === "ask") { prevAt = lastAsk?.at ?? -1; lastAsk = e; continue; }
      if (!e.write) continue;
      writes++;
      const rule = own.find(([w]) => w.test(e.name));
      assert.ok(rule, e.name);
      // The question as shown: everything printed after the previous answer, up to the prompt line that got the yes.
      const question = h.out.slice(prevAt + 1, lastAsk!.at + 1).join("").replace(/\s+/g, " ");
      assert.match(question, rule[1], `${e.name} after: ${question.slice(-300)}`);
    }
  }
  assert.ok(writes > 100, `${writes} writes exercised`);
});