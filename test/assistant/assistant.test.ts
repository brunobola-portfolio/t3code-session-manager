import { test } from "node:test";
import assert from "node:assert/strict";
import { T3NotRunning } from "../../src/t3/errors.ts";
import { accountOf, decisions, nameOf, resumePoint } from "../../src/assistant/steps.ts";
import { en } from "../../src/assistant/messages.en.ts";
import { pt } from "../../src/assistant/messages.pt.ts";
import type { RunSummary } from "../../src/ops/rollback.ts";
import { BIG, DEMO, harness, writesFollowYes } from "./helpers.ts";
import { Back, Quit, ask, newCtx } from "../../src/assistant/core.ts";
import type { Event } from "./helpers.ts";

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
  "run schedule install --watch --yes",
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
    "plan", "run apply --yes", "organizePreview",
    "run schedule install --watch --yes",
  ]);
  const text = h.flat();
  // Decisions (5) and Organize (9) say nothing when there is nothing to decide or to tidy.
  for (const n of [1, 2, 3, 4, 6, 7, 8, 10, 11]) assert.ok(text.includes(`Step ${n} of 11`), `step ${n} shown`);
  assert.doesNotMatch(text, /Step (5|9) of 11/);
  assert.match(text, /an "instance": a Claude account inside T3 Code/);
  assert.match(text, /b\*\*\*@example\.com/);
  assert.match(text, /To import\s+23/);
  assert.match(text, /✓ Imported everything \(run R\d\)/);
  assert.match(text, /t3sm rollback --run <id>/);
  assert.match(h.text(), /t3sm status  +is everything fine\? what needs you\?.*\n.*t3sm projects  +which account.*\n.*t3sm merge  +bring in work/);
  assert.match(text, /In Portuguese: t3sm start --lang pt/);
});

test("happy path in Portuguese: same calls, Portuguese text, s counts as yes", async () => {
  const answers = HAPPY.map((a) => (a === "y" ? "s" : a));
  const h = harness({ answers, lang: "pt" });
  assert.equal(await h.run(), 0, h.text());
  assert.deepEqual(h.writes(), EXPECTED_WRITES);
  assert.deepEqual(writesFollowYes(h.events), []);
  const text = h.flat();
  assert.match(text, /Passo 1 de 11 · Boas-vindas/);
  assert.match(text, /Passo 11 de 11 · Concluído/);
  assert.match(text, /Em inglês: t3sm start --lang en/);
  assert.match(h.prompts.join("\n"), /Pronto para começar\? \[S\/n\/\?\/q\]/);
});

test("pressing Enter at every question never writes (write questions default to No)", async () => {
  const h = harness({ answers: Array.from({ length: 40 }, () => "") });
  assert.equal(await h.run(), 0, h.text());
  assert.deepEqual(h.writes(), [], h.calls().join("\n"));
  assert.ok(h.calls().includes(`run apply --dry-run --only ${DEMO}`), "the dry run (read-only) still shows what would happen");
  assert.match(h.flat(), /During the import t3sm hides these copies/);
  assert.match(h.flat(), /Step 11 of 11/);
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
  assert.ok(h.flat().includes("The steps: 2 checks this computer"));
  assert.match(h.flat(), /Please answer y \(yes\), n \(no\), \? \(more detail\) or q \(quit\)\./);
  assert.equal(h.prompts[0], h.prompts[1]);
  assert.equal(h.prompts[1], h.prompts[2]);
});

test("b goes back a step; after a write it says going back undoes nothing, and nothing is redone without a new yes", async () => {
  const h = harness({ answers: ["y", "b", "y", "y", "n", "y", "c", "y", "n", "b", "n", "n", "q"] });
  assert.equal(await h.run(), 0, h.text());
  assert.equal(h.text().split("Step 1 of 11").length - 1, 2, "b at the check returns to the welcome");
  assert.match(h.flat(), /Going back does not undo what was already done/);
  assert.equal(h.text().split("Step 6 of 11").length - 1, 2, "b at the pilot returns to the clean-up");
  assert.deepEqual(h.writes(), ["run quarantine --yes"]);
  assert.deepEqual(writesFollowYes(h.events), []);
  const first = harness({ answers: ["b", "q"] });
  await first.run();
  assert.match(first.flat(), /Please answer y \(yes\), n \(no\), \? \(more detail\) or q \(quit\)/, "no b on the first question");
});

test("a failing check stops with the fix and exit 1, before anything else", async () => {
  const h = harness({ answers: ["y"], checks: [[{ id: "config", status: "fail", message: "config.json: invalid JSON", fix: "Fix config.json, or delete it and run t3sm accounts --init" }]] });
  assert.equal(await h.run(), 1);
  assert.match(h.text(), /Fix these first:\n✗ config\.json\n  config\.json: invalid JSON\n  What to do: Fix config\.json/);
  assert.match(h.flat(), /Then run t3sm again\. Nothing was changed\./);
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

test("an untested T3 Code version: shown as a warning, the assistant goes on and passes no --allow-untested", async () => {
  const untested = [[{ id: "t3-version", status: "warn" as const, message: "0.2.0 has not been tested with t3sm (tested: 0.1.9); t3sm proceeds with a warning", fix: "Nothing is required" }]];
  const yes = harness({ answers: ["y", "y", "y", "y", "y", "c", "n", "n", "1", "y", "q"], checks: untested });
  assert.equal(await yes.run(), 0, yes.text());
  assert.match(yes.flat(), /0.2.0 has not been tested with t3sm/);
  assert.doesNotMatch(yes.flat(), /Continue anyway/);
  assert.ok(yes.calls().includes("accounts"));
  assert.ok(!yes.calls().includes("accounts:untested"));
  assert.ok(yes.writes().includes("run accounts --apply --yes"));
  assert.ok(yes.writes().includes(`run apply --yes --only ${DEMO}`));
  assert.ok(!yes.writes().some((w) => /--allow-untested/.test(w)));
});

test("any untested T3 Code version (same minor or not) gets the notice in the user's language, never the doctor's English line", async () => {
  for (const version of ["0.2.0", "0.1.9-nightly.20261111.4515"]) {
    const checks = [[{ id: "t3-version" as const, status: "warn" as const, message: `${version} has not been tested with t3sm (tested: 0.1.9); t3sm proceeds with a warning`, fix: "Nothing is required" }]];
    const en = harness({ answers: ["y", "q"], checks });
    await en.run();
    assert.match(en.flat(), new RegExp(`T3 Code ${version.replaceAll(".", "\\.")} has not been tested with t3sm\\. t3sm goes ahead: every change is journaled and can be undone with t3sm rollback\\.`), version);
    assert.equal(en.flat().split("has not been tested").length - 1, 1, `${version}: said once`);
    assert.doesNotMatch(en.flat(), /proceeds with a warning|Nothing is required/, version);
    const pt = harness({ answers: ["s", "q"], checks, lang: "pt" });
    await pt.run();
    assert.match(pt.flat(), new RegExp(`O T3 Code ${version.replaceAll(".", "\\.")} não foi testado com o t3sm\\. O t3sm continua: cada alteração fica no diário e pode ser desfeita com t3sm rollback\\.`), version);
    assert.doesNotMatch(pt.flat(), /has not been tested|proceeds with a warning|Nothing is required/, version);
  }
});

test("pilot looks wrong: offers to undo that run (archiving its threads) and stops with next steps", async () => {
  const h = harness({ answers: ["y", "y", "n", "y", "c", "n", "n", "", "y", "n", "y"] });
  assert.equal(await h.run(), 0, h.text());
  assert.deepEqual(h.writes(), [`run apply --yes --only ${DEMO}`, "run rollback --run R1 --yes --archive-threads"]);
  assert.deepEqual(writesFollowYes(h.events), []);
  assert.match(h.flat(), /Undo the pilot \(run R1\)\?/);
  assert.match(h.flat(), /t3sm projects set "<folder>" <account>/);
  assert.doesNotMatch(h.flat(), /Step 8 of 11/);
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
  assert.match(h.flat(), /Some conversations were not imported: the list above says why\./);
  // Before the question, from the plan; after the import, only the command says which projects wait (it knows).
  assert.match(h.flat(), /In use now 1 project waits for a later run/);
  assert.doesNotMatch(h.flat(), /project waits: a conversation in it is in use/);
  assert.match(h.flat(), /! Import finished with 2 failures \(run R1\)/, "recorded as what happened, not as everything imported");
  assert.doesNotMatch(h.flat(), /Imported everything/);
});

const runOf = (runId: string, command: string, extra: Partial<RunSummary> = {}, importFailed = 0): RunSummary => ({
  runId, at: null, command, status: "ok", rolledBackBy: null,
  counts: { imported: 2, importFailed, filesWritten: 0, quarantined: 0, unquarantined: 0, defaults: 0, instances: 0, projects: 0, archived: 0, merged: 0, organized: 0, organizeReverted: 0 }, ...extra,
});
const SET_UP = { exists: true, language: null, hasPlan: true };

test("resume after a pilot: asks to check it in T3 Code first (q there last time), or starts over without undoing anything", async () => {
  const runs = [runOf("R0", "apply P0 --only")];
  const h = harness({ answers: ["y", "y", "q"], runs, config: SET_UP });
  assert.equal(await h.run(), 0);
  assert.match(h.flat(), /Last time: you imported a pilot project\. Next: a quick check, then step 7 · Pilot\./);
  assert.match(h.flat(), /Your pilot \(run R0\) is in T3 Code/);
  assert.doesNotMatch(h.flat(), /Project to try/);
  assert.match(h.flat(), /Step 8 of 11/, "it looked right: on to the full import");
  const wrong = harness({ answers: ["y", "n", "y"], runs, config: SET_UP });
  assert.equal(await wrong.run(), 0);
  assert.deepEqual(wrong.writes(), ["run rollback --run R0 --yes --archive-threads"]);
  assert.deepEqual(writesFollowYes(wrong.events), []);
  const over = harness({ answers: ["n", "y", "q"], runs, config: SET_UP });
  assert.equal(await over.run(), 0);
  assert.match(over.flat(), /Step 3 of 11/);
  assert.deepEqual(over.writes(), []);
});

test("resume after a full import that failed partly or was interrupted: says so and continues at the full import", async () => {
  const partial = harness({ answers: ["y", "q"], runs: [runOf("R0", "apply P0", { status: "partial" }, 3)], config: SET_UP });
  await partial.run();
  assert.match(partial.flat(), /Last time: the full import finished with 3 failures\. Next: a quick check, then step 8 · Full import\./);
  const cut = harness({ answers: ["y", "q"], runs: [runOf("R0", "apply P0", { status: "aborted" })], config: SET_UP });
  await cut.run();
  assert.match(cut.flat(), /the full import was interrupted\. .*step 8 · Full import/);
  const ok = harness({ answers: ["y", "q"], runs: [runOf("R0", "apply P0", { status: "partial" }, 3), runOf("R1", "apply P1")], config: SET_UP });
  await ok.run();
  assert.match(ok.flat(), /Last time: the full import finished\. Next: a quick check, then step 9 · Organize/);
});

test("resumePoint: from config, plan, journal runs and the scheduler only", () => {
  const base = { configExists: true, hasPlan: true, scheduleInstalled: false };
  assert.equal(resumePoint({ ...base, configExists: false, hasPlan: false, runs: [] }), null);
  assert.equal(resumePoint({ ...base, hasPlan: false, runs: [] }), null, "config.json alone is not a plan");
  assert.deepEqual(resumePoint({ ...base, runs: [] }), { step: 4, what: "resumeConfig" });
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "quarantine")] }), { step: 6, what: "resumeCleanupPart" }, "dedupe still to ask");
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "quarantine"), runOf("y", "dedupe P1")] }), { step: 7, what: "resumeCleanup" });
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "dedupe P1"), runOf("p", "apply P1 --only")] }), { step: 7, what: "resumePilot", runId: "p" });
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "apply P1", { status: "partial" }, 4)] }), { step: 8, what: "resumeFullPartial", n: 4 });
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "apply P1", { status: "incomplete" })] }), { step: 8, what: "resumeFullInterrupted" });
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "apply P1")] }), { step: 9, what: "resumeFull" }, "imported, not organized yet: the organize step");
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "apply P1"), runOf("o", "organize")] }), { step: 10, what: "resumeFull" }, "organized: on to the sync");
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "apply P1"), runOf("o", "organize", { rolledBackBy: "u" })] }), { step: 9, what: "resumeFull" }, "an undone organize does not count");
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "apply P1")], scheduleInstalled: true }), { step: 11, what: "resumeFullSync" });
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "apply P1")], decisionsPending: true }), { step: 5, what: "resumeDecisions" }, "unanswered questions first");
  assert.deepEqual(resumePoint({ ...base, configExists: false, hasPlan: false, runs: [], decisionsPending: true }), null, "no plan, nothing to resume");
  assert.deepEqual(resumePoint({ ...base, runs: [runOf("x", "apply P1 --only", { rolledBackBy: "y" })] }), { step: 4, what: "resumeConfig" }, "a rolled-back pilot does not count");
});

test("lock race: a command that found the lock taken (exit 0) is not reported as done", async () => {
  const h = harness({ answers: ["y", "y", "n", "y", "c", "n", "n", "n", "y"], output: (a) => (a[0] === "apply" && a.includes("--yes") ? "Another t3sm run is in progress.\n" : "ok\n") });
  assert.equal(await h.run(), 0);
  assert.match(h.flat(), /Another t3sm run started meanwhile/);
  assert.doesNotMatch(h.flat(), /All done|Imported everything|Step 10 of 11/);
  const q = harness({ answers: ["y", "y", "n", "y", "c", "y"], output: (a) => (a[0] === "quarantine" ? "Another t3sm run is in progress.\n" : "ok\n") });
  assert.equal(await q.run(), 0);
  assert.match(q.flat(), /Another t3sm run started meanwhile/);
  assert.doesNotMatch(q.flat(), /Moved backup folders/);
});

test("--lang on a first run: the offer to save it comes once config.json exists (at the summary)", async () => {
  const h = harness({ answers: ["s", "s", "n", "s", "c", "n", "n", "n", "n", "s"], lang: "pt", langFromFlag: true });
  assert.equal(await h.run(), 0, h.text());
  assert.match(h.flat(), /Guardar o português como idioma do t3sm/);
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
  assert.match(h.flat(), /Step 6 of 11/, "n on the last page continues");
  assert.match(h.flat(), /Type a number from the list, a folder path, or n to skip the pilot\./);
  assert.match(h.flat(), /OK, no pilot\./);
  assert.deepEqual(h.writes(), []);
});

test("every exit after a write shows what was done, with run ids and how to undo each", async () => {
  const q = harness({ answers: ["y", "y", "n", "y", "c", "y", "n", "q"] });
  assert.equal(await q.run(), 0);
  assert.match(q.flat(), /What this session did ✓ Moved backup folders to the quarantine \(run R1\) Undo: t3sm rollback --run R1/);
  assert.match(q.flat(), /Nothing is left half done/);
  const fail = harness({ answers: ["y", "y", "n", "y", "c", "y", "y"], codes: (a) => (a[0] === "dedupe" ? 1 : 0) });
  assert.equal(await fail.run(), 1);
  assert.match(fail.flat(), /What this session did ✓ Moved backup folders to the quarantine \(run R1\)/);
  const none = harness({ answers: ["q"] });
  await none.run();
  assert.doesNotMatch(none.flat(), /What this session did/);
  const full = harness({ answers: HAPPY });
  await full.run();
  // At the end: one panel (what changed, how to undo, what happens next), not a second recap.
  assert.equal(full.flat().split("What changed").length - 1, 1, "shown once");
  assert.doesNotMatch(full.flat(), /What this session did/);
  assert.match(full.flat(), /✓ Imported everything \(run R(\d)\) .*How to undo .*· t3sm rollback --run R\1 --archive-threads/);
  assert.match(full.flat(), /✓ Installed background sync .*· t3sm schedule remove/);
  assert.match(full.flat(), /· t3sm projects unset/);
  assert.match(full.flat(), /What happens next The background watcher imports new sessions as you work\./);
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
    ["untested version", { answers: [], checks: [[{ id: "t3-version", status: "warn", message: "9.9 has not been tested with t3sm" }]] }],
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
  assert.match(h.flat(), /Guardar o português como idioma do t3sm/);
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
  assert.match(c.flat(), /\x1b\[1mStep 1 of 11/);
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
    { id: "t3-version", status: "warn" as const, message: "0.1.9-x has not been tested with t3sm (tested: 0.1.9); t3sm proceeds with a warning", fix: "Nothing is required" },
  ]];
  const accounts = [{ id: "claude-org", displayName: "Org", email: null, home: "~/.claude-org", foundVia: ["folder", "shell-profile", "vscode-pin", "t3-instance"], alias: "claude-org", hasInstance: true }];
  const h = harness({ answers: ["y", "?", "y", "y", "q"], checks, accounts });
  await h.run();
  const t = h.flat();
  assert.match(t, /! Backup folders 27 backup folders inside projects\/ \(~\/\.claude: 16\) Step 6 offers to move them aside\./);
  assert.match(t, /! Accounts in T3 Code no T3 instance for claude-org \(~\/\.claude-org\) Step 3 offers to create it\./);
  assert.doesNotMatch(t, /Run t3sm quarantine/);
  assert.match(t, /T3 Code 0\.1\.9-x has not been tested with t3sm\. t3sm goes ahead: every change is journaled and can be undone with t3sm rollback\./);
  assert.match(t, /Check names \(for t3sm doctor\): backups-present, instances\./, "ids only in the ? detail");
  assert.equal(t.split("backups-present").length - 1, 1);
  assert.match(t, /1\. Found from: a ~\/\.claude-\* folder, your shell alias claude-org, VS Code project settings, T3 Code/);
  assert.match(t, /Skipped most often: in use right now \(1\)\./);
  // Doctor's words come from its catalogue parts, in the user's language (as t3sm doctor shows them); never an apology.
  const worded = [[{ id: "backups-present" as const, status: "warn" as const, message: "2 backup folders inside projects/ (~/.claude: 2); they can show up as duplicate sessions", fix: "Run t3sm quarantine",
    say: [{ key: "doctor.say.backups.found" as const, vars: { n: 2, per: "~/.claude: 2" } }], sayFix: [{ key: "doctor.fix.backups" as const }] }]];
  const p = harness({ answers: ["s", "q"], lang: "pt", checks: worded });
  await p.run();
  assert.match(p.flat(), /2 pastas de cópia de segurança dentro de projects/);
  assert.doesNotMatch(p.flat(), /backup folders inside|em inglês/);
  const failing = [[{ id: "node-version" as const, status: "fail" as const, message: "Node 20.1.0 is too old", say: [{ key: "doctor.say.nodeVersion.old" as const, vars: { version: "20.1.0", min: "22.18" } }] }]];
  const f = harness({ answers: ["s", "q"], lang: "pt", checks: failing });
  await f.run();
  assert.doesNotMatch(f.flat(), /too old|em inglês/);
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
      assert.match(t, /1\. Origem: a pasta por omissão/);
      assert.match(t, /Desfazer: remove cada instância nova nas definições do T3 Code/);
    }
  }
  const l = harness({ answers: ["s", "s", "q"], lang: "pt", langFromFlag: true, config: { exists: true, language: null } });
  await l.run();
  assert.match(l.flat(), /Guardar o português como idioma do t3sm no config\.json\? Para desfazer: edita lá "language"\./);
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
    [/^run schedule install/, /Install the background watcher|Instalar agora o vigilante/],
    [/^saveLanguage/, /Save English|Guardar o português/],
    [/^saveOrganize/, /Save your answers in config\.json|Save these destinations|Guardar as respostas no config\.json|Guardar estes destinos/],
  ];
  const TOK = ["", "", "y", "y", "n", "q", "b", "?", "s", "1", "2", "c", "7", "#123456", "x", "\u0003", "yes", "sim", "Personal"];
  const states: Parameters<typeof harness>[0][] = [
    { answers: [] }, { answers: [], config: SET_UP }, { answers: [], config: SET_UP, runs: [runOf("a", "quarantine")] },
    { answers: [], config: SET_UP, runs: [runOf("a", "apply P1 --only")] }, { answers: [], config: SET_UP, runs: [runOf("a", "apply P1")] },
    { answers: [], lang: "pt", langFromFlag: true }, { answers: [], lang: "en", langFromFlag: true, config: { exists: true, language: "pt", hasPlan: true } },
    // Pending decisions (the gate): a first run, a resume at the full import, and a Portuguese one with the orphaned question.
    { answers: [], pending: GATE_PENDING },
    { answers: [], config: SET_UP, runs: [runOf("a", "apply P1", { status: "partial" })], pending: GATE_PENDING },
    { answers: [], lang: "pt", config: SET_UP, runs: [runOf("a", "apply P1", { status: "partial" })], pending: [...GATE_PENDING, { key: "orphaned", sessions: 3, folders: 0 }] },
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
// ---------------- decisions are a gate ----------------

const GATE_PENDING = [{ key: "home", sessions: 38, folders: 1 }, { key: "t3-refused", sessions: 1, folders: 1 }, { key: "automated", sessions: 2, folders: 1 }];

const at = (h: { events: Event[] }, re: RegExp): number => h.events.findIndex((e) => e.t === "call" && re.test(e.name));

test("resume at the full import with new pending decisions shows the decisions step first and then returns to the full import", async () => {
  // The saved plan had no questions (configPending false); the fresh plan the full import builds has three.
  const h = harness({
    answers: ["y", "y", "y", "n", "y", "y"], // resume, then 5: home y, t3-refused y, automated n, save y; 8: import yes
    config: { exists: true, language: null, hasPlan: true }, runs: [runOf("a", "apply P0", { status: "partial" })], pending: GATE_PENDING,
  });
  await h.run();
  const t = h.flat();
  assert.match(t, /Step 8 of 11/);
  assert.match(t, /3 new questions before the import They came up since last time\./);
  assert.ok(t.indexOf("Step 5 of 11 · Decisions") > t.indexOf("Step 8 of 11"), "the detour starts from the full import");
  assert.match(t, /38 conversations were started in your home folder/);
  assert.deepEqual(h.saved[0], { decided: ["home", "t3-refused", "automated"], folders: { home: "rehome", "t3-refused": "rehome" }, sessions: { automated: "skip" } });
  const save = at(h, /^saveOrganize/), apply = at(h, /^run apply --yes$/);
  assert.ok(save >= 0 && apply > save, "the answers are saved before the import runs");
  assert.ok(t.lastIndexOf("Step 8 of 11") > t.indexOf("Step 5 of 11 · Decisions"), "and the full import comes back after");
  assert.deepEqual(writesFollowYes(h.events), []);
});

test("first run shows decisions before the pilot", async () => {
  const h = harness({ answers: ["y", "y", "n", "y", "c", "y", "y", "n", "y", "n", "n", "n", "n"], pending: GATE_PENDING });
  await h.run();
  const t = h.flat();
  assert.ok(t.indexOf("Step 5 of 11 · Decisions") > 0 && t.indexOf("Step 5 of 11 · Decisions") < t.indexOf("Step 7 of 11"));
  assert.equal(t.match(/Step 5 of 11/g)?.length, 1, "asked once: no loop through the gate");
  assert.doesNotMatch(t, /new since last time/, "the normal order needs no detour message");
  assert.ok(at(h, /^saveOrganize/) >= 0);
});

test("no pending decisions: no detour", async () => {
  const h = harness({ answers: ["y", "y", "n"], config: { exists: true, language: null, hasPlan: true }, runs: [runOf("a", "apply P0", { status: "partial" })] });
  await h.run();
  assert.doesNotMatch(h.flat(), /Step 5 of 11|new since last time/);
  assert.match(h.flat(), /Step 8 of 11/);
});

test("a declined save is not asked again in the same session (no gate loop)", async () => {
  const h = harness({
    answers: ["y", "y", "y", "n", "n", "n"], // 5: home y, refused y, automated n, save NO; back at 8: import no
    config: { exists: true, language: null, hasPlan: true }, runs: [runOf("a", "apply P0", { status: "partial" })], pending: GATE_PENDING,
  });
  await h.run();
  assert.equal(h.flat().match(/Step 5 of 11 · Decisions/g)?.length, 1);
  assert.deepEqual(h.saved, []);
  assert.match(h.flat(), /nothing saved/i);
});

test("orphaned decision saved as sessions.orphaned (copy / skip), in both languages", async () => {
  const orphaned = [{ key: "orphaned", sessions: 3, folders: 2 }];
  const pre = ["y", "y", "n", "y", "c"];
  const yes = harness({ answers: [...pre, "y", "y", "n", "n", "n", "n"], pending: orphaned });
  await yes.run();
  assert.deepEqual(yes.saved[0], { decided: ["orphaned"], sessions: { orphaned: "copy" } });
  assert.match(yes.flat(), /3 conversations were started in T3 Code, but their T3 Code threads were deleted/);
  assert.match(yes.flat(), /Change later organize\.sessions\.orphaned \("copy" \| "skip"\)/);
  assert.match(yes.flat(), /Bring these conversations back as copies\? \[Y\/n/);
  const no = harness({ answers: [...pre, "n", "y", "n", "n", "n", "n"], pending: orphaned });
  await no.run();
  assert.deepEqual(no.saved[0], { decided: ["orphaned"], sessions: { orphaned: "skip" } });
  const pt = harness({ answers: [...pre, "s", "s", "n", "n", "n", "n"], pending: orphaned, lang: "pt" });
  await pt.run();
  assert.deepEqual(pt.saved[0], { decided: ["orphaned"], sessions: { orphaned: "copy" } });
  assert.match(pt.flat(), /Trazer de volta/);
});

test("resume at the clean-up with new pending decisions: decisions first, then the clean-up (the gate guards quarantine/dedupe too)", async () => {
  const h = harness({
    answers: ["y", "y", "y", "n", "y", "n", "n", "n", "n"], // resume; 5: home y, refused y, automated n, save y; 6: quarantine n, dedupe n; pilot skip; full no
    config: { exists: true, language: null, hasPlan: true }, runs: [runOf("a", "quarantine")], pending: GATE_PENDING,
  });
  await h.run();
  const t = h.flat();
  assert.match(t, /3 new questions before the import/);
  assert.ok(t.indexOf("Step 5 of 11 · Decisions") > 0 && t.indexOf("Step 6 of 11") > t.indexOf("Step 5 of 11 · Decisions"), "the clean-up comes only after the decisions");
  assert.deepEqual(writesFollowYes(h.events), []);
});

test("Back from the decisions drops the gate's return point: a later normal visit goes on to the next step", async () => {
  const h = harness({
    // resume at 8; 5: home y, refused y, automated n, save prompt: b (back to 8, keys already asked: no gate);
    // 8: import no (ends at 10/11...). Nothing is saved.
    answers: ["y", "y", "y", "n", "b", "n"],
    config: { exists: true, language: null, hasPlan: true }, runs: [runOf("a", "apply P0", { status: "partial" })], pending: GATE_PENDING,
  });
  await h.run();
  assert.deepEqual(h.saved, []);
  assert.equal(h.flat().match(/Step 5 of 11 · Decisions/g)?.length, 1, "not sent back to the decisions again");
  assert.match(h.flat(), /Step 8 of 11/);
});

test("Back out of the decisions step clears the gate's return point (a later visit goes on to step 6, not to the gated step)", async () => {
  // The end-to-end Back test above leaves through the save prompt with every key asked, so no later visit reads the
  // return point; this pins the clearing itself.
  const h = harness({ answers: ["b"], pending: GATE_PENDING });
  const ctx = newCtx(h.deps, { lang: "en", color: false, langFromFlag: false });
  ctx.returnTo = 8;
  await assert.rejects(decisions(ctx), Back);
  assert.equal(ctx.returnTo, null, "a later normal visit of step 5 must not jump to step 8");
});

test("Back at the first decision after a gate goes to the step shown before, never straight back into the decisions", async () => {
  const h = harness({
    // resume at 8 (after the check); 8's plan has 3 new questions: gate -> 5; b at the first question -> the check (the
    // step shown before), not step 8, whose gate would send the user straight back; then q.
    answers: ["y", "b", "q"],
    config: { exists: true, language: null, hasPlan: true }, runs: [runOf("a", "apply P0", { status: "partial" })], pending: GATE_PENDING,
  });
  await h.run();
  const t = h.flat();
  const first = t.indexOf("Step 5 of 11 · Decisions");
  assert.ok(first > 0, t);
  const after = t.slice(first);
  assert.equal(after.match(/Step 5 of 11 · Decisions/g)?.length, 1, "b did not bounce back into the decisions");
  assert.match(after, /Step 2 of 11 · Check/, "back to the step shown before the gated one");
  assert.deepEqual(h.saved, []);
});

// ---------- Task 19: localized prompts ----------

function askWith(lang: "en" | "pt", answers: string[]) {
  const h = harness({ answers, lang });
  const ctx = newCtx(h.deps, { lang, color: false, langFromFlag: false });
  return { h, ctx };
}

test("PT prompt shows [S/n] and accepts s, sim, n, nao, não, v", async () => {
  const { h, ctx } = askWith("pt", ["s", "sim", "S", "n", "nao", "não", "", "", "?", "y", "v", "voltar", "q", "sair", "b"]);
  const yes = { def: "y" as const, help: "Ajuda." };
  const no = { def: "n" as const, help: "Ajuda." };
  for (const want of [true, true, true, false, false, false]) assert.equal(await ask(ctx, "Continuar?", yes), want);
  assert.equal(await ask(ctx, "Continuar?", yes), true, "Enter: the default (yes)");
  assert.equal(await ask(ctx, "Gravar?", no), false, "Enter: the default (no)");
  assert.equal(await ask(ctx, "Continuar?", yes), true, "? explains, then y still counts as yes");
  assert.match(h.text(), /Ajuda\./);
  await assert.rejects(ask(ctx, "Continuar?", yes), Back, "v goes back");
  await assert.rejects(ask(ctx, "Continuar?", yes), Back, "voltar goes back");
  await assert.rejects(ask(ctx, "Continuar?", yes), Quit, "q quits");
  await assert.rejects(ask(ctx, "Continuar?", yes), Quit, "sair quits");
  assert.equal(h.prompts[0], "Continuar? [S/n/?/v/q] ");
  assert.ok(h.prompts.includes("Gravar? [s/N/?/v/q] "));
  // An unknown answer is asked again; the hint names the Portuguese keys (b, as before, still goes back).
  const r = askWith("pt", ["x", "n", "b"]);
  assert.equal(await ask(r.ctx, "Continuar?", yes), false);
  assert.match(r.h.text(), /Responde s \(sim\), n \(não\), \? \(mais detalhe\), v \(voltar\) ou q \(sair\)\./);
  await assert.rejects(ask(r.ctx, "Continuar?", yes), Back);
  const nb = askWith("pt", ["s"]);
  await ask(nb.ctx, "Continuar?", { ...yes, back: false });
  assert.equal(nb.h.prompts[0], "Continuar? [S/n/?/q] ");
});

test("EN unchanged: [Y/n/?/b/q], y / yes / n / no, b and back go back, q quits; sim and v are not English answers", async () => {
  const { h, ctx } = askWith("en", ["y", "yes", "n", "no", "", "b", "back", "q", "sim", "v", "n"]);
  const yes = { def: "y" as const, help: "Help." };
  for (const want of [true, true, false, false, true]) assert.equal(await ask(ctx, "Continue?", yes), want);
  await assert.rejects(ask(ctx, "Continue?", yes), Back);
  await assert.rejects(ask(ctx, "Continue?", yes), Back);
  await assert.rejects(ask(ctx, "Continue?", yes), Quit);
  assert.equal(await ask(ctx, "Continue?", yes), false, "sim and v are asked again; n answers");
  assert.equal(h.prompts[0], "Continue? [Y/n/?/b/q] ");
  assert.match(h.text(), /Please answer y \(yes\), n \(no\), \? \(more detail\), b \(back\) or q \(quit\)\./);
  const w = askWith("en", ["n"]);
  await ask(w.ctx, "Save?", { def: "n", help: "Help.", back: false });
  assert.equal(w.h.prompts[0], "Save? [y/N/?/q] ");
});

test("the --lang save offer compares with the language t3sm would use without --lang (not with English)", async () => {
  // System language Portuguese, no "language" in config.json: --lang pt changes nothing, so nothing is offered.
  const same = harness({ answers: ["s", "q"], lang: "pt", langFromFlag: true, defaultLang: "pt", config: { exists: true, language: null } });
  await same.run();
  assert.doesNotMatch(same.flat(), /Guardar o português/);
  // System language Portuguese, --lang en: offered.
  const other = harness({ answers: ["y", "n", "q"], lang: "en", langFromFlag: true, defaultLang: "pt", config: { exists: true, language: null } });
  await other.run();
  assert.match(other.flat(), /Save English as t3sm's language/);
});

test("step 10: a sync cycle holding the lock is waited for (3 tries) before the user is told to install the watcher by hand", async () => {
  const sched = (a: string[]): boolean => a[0] === "schedule" && a[1] === "install";
  let busyLeft = 2;
  const h = harness({ answers: HAPPY, output: (a) => (sched(a) && busyLeft-- > 0 ? LOCKED_OUT : "ok\n") });
  const waits: number[] = [];
  h.deps.wait = async (ms) => void waits.push(ms);
  assert.equal(await h.run(), 0, h.text());
  assert.equal(h.writes().filter((w) => w === "run schedule install --watch --yes").length, 3, "tried again while busy");
  assert.deepEqual(waits, [5000, 5000]);
  assert.match(h.flat(), /All done/);
  assert.doesNotMatch(h.flat(), /started meanwhile|was not installed/);

  const k = harness({ answers: HAPPY, output: (a) => (sched(a) ? LOCKED_OUT : "ok\n") });
  k.deps.wait = async () => {};
  assert.equal(await k.run(), 0, k.text());
  assert.equal(k.writes().filter((w) => w === "run schedule install --watch --yes").length, 3);
  assert.match(k.flat(), /background sync was not installed\. Run t3sm schedule install --watch --yes when it has finished/);
  assert.doesNotMatch(k.flat(), /started meanwhile/);
});

test("names on the assistant's screens: a project titled with an @ stays readable; only account names are masked", () => {
  const h = harness({ answers: [] });
  const ctx = newCtx(h.deps, { lang: "en", color: false, langFromFlag: false });
  assert.equal(nameOf(ctx, "react@18 migration"), "react@18 migration");
  assert.equal(nameOf(ctx, "C:/work/pkg@2.0"), "C:/work/pkg@2.0");
  assert.equal(accountOf(ctx, "demouser@example.com"), "d***@example.com");
  assert.equal(accountOf(ctx, "Claude Personal"), "Claude Personal");
});
