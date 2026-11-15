// The guided assistant's screens (Task 20): every step and state a user meets, as the transcript of a scripted run over
// the fake dependencies (test/assistant/helpers.ts), from the step of interest on. Registered in SCREENS by screens.ts,
// so the matrix renders each one at 40/80/120 columns x colour x Unicode x en/pt and snapshots it.
//
// The projects live under the fake home folder, so every path reads "~/code/..." on every system. Synthetic data only.

import type { Lang } from "../../src/assistant/i18n.ts";
import type { Caps } from "../../src/ui/caps.ts";
import type { Check } from "../../src/ops/doctor.ts";
import type { RunSummary } from "../../src/ops/rollback.ts";
import type { ApplyResult } from "../../src/apply/apply.ts";
import { makeCliUi } from "../../src/cli/ui.ts";
import { renderApplyResult } from "../../src/cli/applyScreen.ts";
import { stripAnsi } from "../../src/ui/text.ts";
import { HOME, PENDING, harness, previewFixture, type HarnessOptions } from "../assistant/helpers.ts";
import { FAILURES, NOW } from "./screens.commands.ts";
import type { Screen } from "./screens.ts";

const MIN = 60_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const UNDER = `${HOME}/code`;
const yes = (lang: Lang): string => (lang === "pt" ? "s" : "y");

const runOf = (runId: string, command: string, status = "ok", importFailed = 0): RunSummary => ({
  runId, at: null, command, status, rolledBackBy: null,
  counts: { imported: 2, importFailed, filesWritten: 0, quarantined: 0, unquarantined: 0, defaults: 0, instances: 0, projects: 0, archived: 0, merged: 0, organized: 0, organizeReverted: 0 },
});
const SET_UP = { exists: true, language: null, hasPlan: true };

// ASCII data, so the matrix's rule (nothing outside ASCII without Unicode) tests the assistant's own text: names and
// folders from the user's data are shown as they are, never folded (screens.test.ts checks that separately).
const ACCOUNTS = [
  { id: "claudeAgent", displayName: "Claude Personal", email: "b***@example.com", home: "~/.claude", foundVia: ["default"], alias: null, hasInstance: true },
  { id: "claude-org", displayName: "Claude Org", email: null, home: "~/.claude-org", foundVia: ["folder"], alias: null, hasInstance: false },
];
const NAMES = { claudeAgent: "Claude Personal", "claude-org": "Claude Org" };
const DATA = { accounts: ACCOUNTS, names: NAMES };

/** The result `t3sm apply` prints (Task 21's screen), at the child's width, in the assistant's language. */
function applyOutput(caps: Caps, lang: Lang, r: Partial<ApplyResult>): string {
  const ui = makeCliUi(caps, lang, () => NOW);
  const result: ApplyResult = {
    status: "ok", runId: "R1", imported: 22, failed: 0, failures: [], converted: 0, deferred: 0, deferredInUse: 0,
    heldRoots: [], held: [], alreadyInT3: 0, restoreErrors: [], unverified: 0, parked: 0, recovered: null, ...r,
  };
  // The progress bar's last line as importProgress ends it (no symbol; "processed" when some failed).
  const total = result.imported + result.failed;
  const done = result.failed === 0 ? ui.t("apply.importDone", { n: result.imported, total, dur: ui.f.dur(4200) })
    : ui.t("apply.importDoneMixed", { done: total, total, dur: ui.f.dur(4200), n: result.imported, sep: ui.s.sym.sep });
  return [done, "", ...renderApplyResult(ui, result)].join("\n") + "\n";
}

const HELD = [{ project: "busy", root: `${UNDER}/busy`, file: `${UNDER}/busy/x.jsonl`, title: "Fix the build", modifiedAt: ago(3 * MIN) }];

interface Scenario {
  name: string;
  /** The transcript is shown from this step's header on (default: from the start). */
  from?: number;
  options(caps: Caps, lang: Lang): HarnessOptions;
}

/** The transcript lines from the first header of step `n` on ("Step 8 of 11 · ..." or, narrow, "8/11 · ..."). */
function fromStep(lines: string[], n: number | undefined): string[] {
  if (n === undefined) return lines;
  const at = lines.findIndex((l) => new RegExp(`(?:^|\\s)(?:Step|Passo) ${n} (?:of|de) 11\\b|^${n}/11\\b`).test(stripAnsi(l).trim()));
  return at < 0 ? lines : lines.slice(at);
}

const SCENARIOS: Scenario[] = [
  // 1-3: a first run, from the welcome to the accounts (q at "Are these names right?").
  { name: "start-first-run", options: (_c, l) => ({ answers: [yes(l), yes(l), "n", "q"] }) },
  // A returning user after a full import with 3 failures: the checklist, then q at "Continue at step 8?".
  { name: "start-resume", options: () => ({ answers: ["q"], config: SET_UP, runs: [runOf("R0", "apply P0", "partial", 3)] }) },
  // 2: the check with things worth knowing (and a Pi warning that does not concern this user: no Pi sessions).
  {
    name: "start-check-notes", from: 2,
    options: (_c, l) => ({
      answers: [yes(l), "q"],
      checks: [[
        { id: "node-version", status: "ok", message: "Node 24.11.1", say: [{ key: "doctor.say.nodeVersion.ok", vars: { version: "24.11.1" } }] },
        { id: "t3-reachable", status: "ok", message: "T3 Code answers" },
        // As runDoctor returns them: the English message and fix (--json), and the catalogue parts the screens word.
        { id: "backups-present", status: "warn", message: "2 backup folders inside projects/ (~/.claude: 2); they can show up as duplicate sessions", fix: "Run t3sm quarantine (reversible)",
          say: [{ key: "doctor.say.backups.found", vars: { n: 2, per: "~/.claude: 2" } }], sayFix: [{ key: "doctor.fix.backups" }] },
        { id: "merge-pending", status: "warn", message: `3 sessions continued in a terminal since t3sm imported them; T3 Code does not show that work (as of ${ago(2 * 60 * MIN)})`, fix: "Run t3sm merge to list them", data: { continued: 3, sideBranch: 1, at: ago(2 * 60 * MIN) } },
        { id: "harness:pi", status: "warn", message: "sessions found but T3 Code has no pi instance; they will be skipped", fix: "Enable Pi in T3 Code settings (Providers), then run t3sm plan again", data: { harness: "pi", sessions: null, readErrors: 0, noInstance: true },
          say: [{ key: "doctor.say.harness.noDriver", vars: { driver: "pi" } }], sayFix: [{ key: "doctor.fix.harness.enable", vars: { agent: "Pi" } }] },
        { id: "harness:codex", status: "skip", message: "no sessions on this machine", say: [{ key: "doctor.say.harness.none" }] },
      ] satisfies Check[]],
    }),
  },
  // 4: the plan (q at the project table), with Pi sessions the plan skips.
  { name: "start-plan", from: 4, options: (_c, l) => ({ answers: [yes(l), yes(l), "n", yes(l), "q"], under: UNDER, skipped: [{ harness: "pi", n: 4 }] }) },
  // 5: the decisions, one panel per question (yes to the first, q at the second).
  { name: "start-decisions", from: 5, options: (_c, l) => ({ answers: [yes(l), yes(l), "n", yes(l), "c", yes(l), "q"], under: UNDER, pending: PENDING.slice(0, 3) }) },
  // 6: the clean-up (no to both), q at the pilot.
  { name: "start-cleanup", from: 6, options: (_c, l) => ({ answers: [yes(l), yes(l), "n", yes(l), "c", "n", "n", "q"], under: UNDER }) },
  // 7: the pilot imported, looks right; q at the full import's question.
  { name: "start-pilot-ok", from: 7, options: (_c, l) => ({ answers: [yes(l), yes(l), "n", yes(l), "c", "n", "n", "", yes(l), yes(l), "q"], under: UNDER }) },
  // 7: the pilot imported partly (the child's failure list), looks wrong: undo.
  {
    name: "start-pilot-failed", from: 7,
    options: (c, l) => ({
      answers: [yes(l), yes(l), "n", yes(l), "c", "n", "n", "", yes(l), "n", yes(l)], under: UNDER,
      codes: (a) => (a[0] === "apply" && a.includes("--yes") ? 5 : 0),
      output: (a) => (a[0] === "apply" && a.includes("--yes") ? applyOutput(c, l, { status: "partial", imported: 1, failed: 2, failures: FAILURES.slice(0, 2) }) : "ok\n"),
    }),
  },
  // 8: the full import, all fine; then 10 (keep in sync): q at its question.
  {
    name: "start-full-ok", from: 8,
    options: (c, l) => ({
      answers: [yes(l), yes(l), "n", yes(l), "c", "n", "n", "n", yes(l), "q"], under: UNDER,
      output: (a) => (a[0] === "apply" && a.includes("--yes") ? applyOutput(c, l, {}) : "ok\n"),
    }),
  },
  // 8: the full import with failures (exit 5): the child's failure list, one help line, then what it means.
  {
    name: "start-full-partial", from: 8,
    options: (c, l) => ({
      answers: [yes(l), yes(l), "n", yes(l), "c", "n", "n", "n", yes(l), "q"], under: UNDER,
      codes: (a) => (a[0] === "apply" && a.includes("--yes") ? 5 : 0), importFailed: FAILURES.length,
      output: (a) => (a[0] === "apply" && a.includes("--yes") ? applyOutput(c, l, { status: "partial", imported: 18, failed: FAILURES.length, failures: FAILURES }) : "ok\n"),
    }),
  },
  // 8: the full import with a project held because a conversation in it is in use.
  {
    name: "start-full-held", from: 8,
    options: (c, l) => ({
      answers: [yes(l), yes(l), "n", yes(l), "c", "n", "n", "n", yes(l), "q"], under: UNDER,
      heldAfter: 1,
      output: (a) => (a[0] === "apply" && a.includes("--yes") ? applyOutput(c, l, { imported: 22, deferred: 1, deferredInUse: 1, held: HELD, heldRoots: [`${UNDER}/busy`] }) : "ok\n"),
    }),
  },
  // 9: organize: the per-project table, each part, "Here is what I will do", applied; q at step 10.
  {
    name: "start-organize", from: 9,
    options: (_c, l) => ({
      answers: [yes(l), yes(l), "n", yes(l), "c", "n", "n", "n", yes(l), "", yes(l), yes(l), yes(l), "", yes(l), yes(l), yes(l), "q"], under: UNDER, preview: previewFixture(),
    }),
  },
  // 11: the end of the happy path: the summary panel (what changed, how to undo, what happens next).
  {
    name: "start-done", from: 11,
    options: (_c, l) => ({ answers: [yes(l), yes(l), yes(l), yes(l), "c", yes(l), yes(l), "", yes(l), yes(l), yes(l), yes(l)], under: UNDER }),
  },
];

/** A scenario's transcript, as the user sees it, at `caps`. */
export async function renderScenario(name: string, caps: Caps, lang: Lang): Promise<string[]> {
  const s = SCENARIOS.find((x) => x.name === name)!;
  const h = harness({ lang, caps, now: () => NOW, ...DATA, ...s.options(caps, lang) });
  await h.run();
  const lines = h.text().replace(/\n+$/, "").split("\n");
  return fromStep(lines, s.from);
}

export const ASSISTANT_SCREENS: Screen[] = SCENARIOS.map((s) => ({ name: s.name, render: (caps, lang) => renderScenario(s.name, caps, lang) }));
