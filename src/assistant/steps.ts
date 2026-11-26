// The eleven steps of the guided assistant. Each step starts with its header (the rail of the 11 steps), says what will
// happen in a few short lines, then asks; the long explanation is behind "?". A step never writes by itself: every write
// is one of t3sm's own commands, run through ctx.d.run only after an explicit "y" in the question right before it (write
// questions default to No). The exceptions, saving the assistant's language and the decisions / organize choices (the
// "organize" section), are config.json only: they go through ctx.d.saveLanguage and ctx.d.saveOrganize (under the
// lock), after a "y", except the decisions (step 5): each one is an explicit answer, saved right after the last one.
// The assistant never calls T3 Code's write API itself.
//
// The screens use the UI kit (src/ui/components.ts) at the terminal's width, at most 80 columns. Text from disk or T3
// Code (folders, titles, account names, a child's output) goes through shownText before it reaches the terminal.

import { DEFAULT_HISTORY, HISTORY_V2, organizeSettings, type OrganizePatch } from "../core/config.ts";
import type { Check } from "../ops/doctor.ts";
import { isGlob, normalizeFolder, projectRows, type ProjectRow } from "../ops/projects.ts";
import { shownAccountName, shownText } from "../plan/names.ts";
import { SKIP_REASONS, summarize } from "../plan/report.ts";
import { expandHome, sameCwd, tildePath } from "../core/paths.ts";
import type { HistoryRule, OrganizeConfig } from "../core/types.ts";
import type { OrganizeAction } from "../organize/types.ts";
import { isShownMark } from "../organize/history.ts";
import { reviewList, type ListItem } from "../ui/list.ts";
import { appHeader, callout, kv, panel, table, type Column } from "../ui/components.ts";
import { organizePreviewTable } from "../ui/organizePreview.ts";
import { displayWidth, padStart, truncateEnd, truncateMiddle, wrapTo } from "../ui/text.ts";
import type { Term } from "../ui/terminal.ts";
import type { RunSummary } from "../ops/rollback.ts";
import {
  Back, Quit, Stop, TOTAL_STEPS, ask, askText, blank, glyphs, heading, lines, say, t, width,
  type AccountRow, type Ctx, type OrganizePreview, type PlanView, type Resume, type RunOutcome,
} from "./core.ts";
import type { Key } from "./i18n.ts";
import { LOCK_BUSY_LINE } from "../cli/locked.ts";
import { NOTHING_TO_CHANGE_MARKS } from "../cli/commands/projects.ts";
import { checkName, checkWords } from "../cli/commands/doctor.ts";
import { historyLine, previewWords } from "../cli/commands/organize.ts";
import { flowAtoms, leadLines, snugWidth } from "../cli/screen.ts";

/** `gated`: the step sent the user to the decisions before showing anything, so Back from there skips it (no bounce). */
export type StepResult = { to: "next" } | { to: "skip" } | { to: "goto"; step: number; gated?: true };
export type Step = (ctx: Ctx) => Promise<StepResult>;

const NEXT: StepResult = { to: "next" };
/** Projects per page of the plan's table: the summary, one page and the question fit 24 rows. */
const PAGE = 8;
const YES_WORDS = new Set(["y", "yes", "s", "sim"]);
const NO_WORDS = new Set(["n", "no", "não", "nao"]);

/** Named colours offered for an account (catalogue key, #RRGGBB). */
export const PALETTE: [Key, string][] = [
  ["colorBlue", "#2563EB"], ["colorGreen", "#16A34A"], ["colorOrange", "#EA580C"],
  ["colorPurple", "#7C3AED"], ["colorRed", "#DC2626"], ["colorTeal", "#0D9488"],
];

// allowUntested is kept for compatibility and is never set now (untested versions only warn).
const ut = (ctx: Ctx): string[] => (ctx.allowUntested ? ["--allow-untested"] : []);

/** A folder for the screen: ~ for the home folder, sanitised, cut in the middle to `max` columns. */
function shown(ctx: Ctx, folder: string, max = 40): string {
  return truncateMiddle(shownText(tildePath(folder, ctx.d.home)), max, ctx.s.sym.ellipsis);
}

/** A name from config.json or T3 Code (an account, a project), sanitised for the screen; never rewritten otherwise. */
export function nameOf(_ctx: Ctx, s: string, max = 60): string {
  return shownText(s, max);
}

/** An account's display name: like nameOf, with any email address in it masked (people name accounts after theirs). */
export function accountOf(_ctx: Ctx, s: string, max = 60): string {
  return shownAccountName(s, max);
}

/** `✓ text`, wrapped under its text: a short success line. */
function okLine(ctx: Ctx, text: string): void {
  const [first = "", ...rest] = wrapTo(text, Math.max(1, width(ctx) - 2));
  lines(ctx, [`${ctx.s("ok", ctx.s.sym.ok)} ${ctx.s("title", first)}`, ...rest.map((l) => `  ${l}`)]);
}

/** A number in the user's locale ("4 007" in Portuguese). */
const num = (ctx: Ctx, n: number): string => ctx.f.n(n);

/** A body line of a panel: plain text, or a bullet (its symbol, then the text, which wraps under the text). */
type BodyLine = string | { bullet: string; text: string };

/**
 * A panel as wide as its content needs (at most the screen). Its body is wrapped here, to the panel's inner width, so a
 * bullet's continuation lines hang under its text (the panel itself would start them at the border).
 */
function box(ctx: Ctx, o: { title: string; body: BodyLine[]; tone?: "plain" | "ok" | "warn" | "err" }): string[] {
  const w = width(ctx);
  const inner = Math.max(1, w - 4);
  // A bullet's text wraps in its own column, so every continuation line (a blank bullet's too) starts under the text.
  const bulleted = (b: { bullet: string; text: string }): string[] => {
    const pw = displayWidth(b.bullet) + 1;
    return wrapTo(b.text, Math.max(1, inner - pw)).map((l, i) => (i === 0 ? `${b.bullet} ` : " ".repeat(pw)) + l);
  };
  const body = o.body.flatMap((b) => (typeof b === "string" ? wrapTo(b, inner) : bulleted(b)));
  return panel(ctx.s, { ...o, body }, snugWidth(o.title, body, w));
}

/** Aligned `label  value` rows for a panel body (the panel's border takes 4 columns). */
function rows(ctx: Ctx, r: [string, string][]): string[] {
  return kv(ctx.s, r, Math.max(1, width(ctx) - 4));
}

/** Counts right-aligned in one column, so the numbers line up under each other. */
function counts(ctx: Ctx, r: [string, number, string?][]): [string, string][] {
  const nw = Math.max(...r.map(([, n]) => num(ctx, n).length));
  return r.map(([k, n, more]) => [k, ctx.s("num", padStart(num(ctx, n), nw)) + (more ? ` ${more}` : "")]);
}

/** Refuses (and ends the assistant, exit 0) when another t3sm run holds the lock right now. */
async function guardLock(ctx: Ctx): Promise<void> {
  const h = await ctx.d.lockHolder();
  if (h) { say(ctx, t(ctx, "lockedNow", { pid: h.pid })); throw new Stop(0); }
}

type Undo = (runId: string | null) => string | null;

/**
 * The journal `command` a run of `argv` writes (or null for a write journaled without a run-start, like an accounts
 * change): a run that appeared meanwhile with another command belongs to another t3sm process (a sync), never to us.
 */
export function ownsRun(argv: string[], command: string | null): boolean {
  const c = command ?? "";
  switch (argv[0]) {
    case "apply": return argv.includes("--only") ? /^apply \S+ --only$/.test(c) : /^apply \S+$/.test(c);
    case "quarantine": return c === "quarantine";
    case "dedupe": return /^dedupe\b/.test(c);
    case "rollback": return c === `rollback ${argv[argv.indexOf("--run") + 1] ?? ""}`;
    case "projects": return c === "projects set";
    case "organize": return c === "organize";
    case "accounts": return command === null;
    default: return false;
  }
}

/**
 * Runs a writing t3sm command (after the user's "y") and records it for the summary with the run id it journaled and
 * how to undo it. The command prints its own screen (the progress bar, its result, its failures) as it runs. A command
 * that found the lock taken (exit 0 with the lock-busy signal, or its line) did nothing: nothing is recorded, the
 * assistant ends (exit 0). Exit 0 goes on; `tolerate` codes (5: some items failed) go on and are remembered; 130
 * (Ctrl+C) and any other code end the assistant with that code.
 */
async function write(ctx: Ctx, argv: string[], what: string, o: { tolerate?: number[]; undo?: Undo; busyReturns?: boolean } = {}): Promise<{ outcome: RunOutcome; runId: string | null; busy?: boolean }> {
  // busyReturns: a lock held by another run (before or during the command) is returned as `busy`, for the caller to retry.
  const busy = { outcome: { code: 0, output: "", locked: true }, runId: null, busy: true };
  if (o.busyReturns) { if (await ctx.d.lockHolder()) return busy; } else await guardLock(ctx);
  const before = new Set((await ctx.d.runs()).map((r) => r.runId));
  const outcome = await ctx.d.run(argv);
  if (outcome.code === 0 && (outcome.locked === true || outcome.output.includes(LOCK_BUSY_LINE))) {
    if (o.busyReturns) return busy;
    say(ctx, t(ctx, "lockedRace"));
    throw new Stop(0);
  }
  const fresh: RunSummary[] = (await ctx.d.runs()).filter((r) => !before.has(r.runId) && ownsRun(argv, r.command));
  const runId = fresh.at(-1)?.runId ?? null;
  const record = (): void => void ctx.done.push({ what, runId, undo: o.undo ? o.undo(runId) : null, ...(outcome.code !== 0 ? { partial: true } : {}) });
  if (outcome.code !== 0 && !(o.tolerate ?? []).includes(outcome.code)) {
    if (runId) record();
    say(ctx, t(ctx, outcome.code === 130 ? "stepInterrupted" : "stepFailed", { code: outcome.code }));
    throw new Stop(outcome.code);
  }
  ctx.worst = Math.max(ctx.worst, outcome.code);
  record();
  return { outcome, runId };
}

async function buildPlan(ctx: Ctx, key: Key = "planBuilding"): Promise<PlanView> {
  say(ctx, ctx.s("muted", t(ctx, key)));
  ctx.plan = await ctx.d.plan(ctx.allowUntested, ctx.lang);
  return ctx.plan;
}

const rowsOf = (p: PlanView): ProjectRow[] => projectRows(p.plan, p.names, null, p.config);

/** A write's symbol in the summaries: ✓ when it went through, ! when it ended with failures. */
const doneSym = (ctx: Ctx, d: Ctx["done"][number]): string => (d.partial ? ctx.s("warn", ctx.s.sym.warn) : ctx.s("ok", ctx.s.sym.ok));

/** The lines of "what this session did": each write with its run, and how to undo it. */
function didLines(ctx: Ctx): BodyLine[] {
  const out: BodyLine[] = [];
  for (const d of ctx.done) {
    out.push({ bullet: doneSym(ctx, d), text: d.runId ? t(ctx, "doneItemRun", { what: d.what, runId: d.runId }) : d.what });
    if (d.undo) out.push({ bullet: " ", text: t(ctx, "doneUndoLine", { undo: d.undo }) });
  }
  return out;
}

/** "What this session did" as a panel: each write, its run id and how to undo it. Shown once (the last step, or any exit). */
export function summary(ctx: Ctx): void {
  ctx.summaryShown = true;
  if (ctx.done.length === 0) { say(ctx, t(ctx, "doneNothing")); return; }
  blank(ctx);
  const body = didLines(ctx);
  if (ctx.done.some((d) => d.runId !== null)) body.push("", t(ctx, "doneUndo"));
  lines(ctx, box(ctx, { title: t(ctx, "doneHead"), body }));
}

/** `--lang` given and config.json exists (now or since the plan): offers once to save the language there. */
async function offerLanguage(ctx: Ctx): Promise<void> {
  if (ctx.langOffered || !ctx.langFromFlag) return;
  const cfg = await ctx.d.config();
  if (!cfg.exists) return;
  ctx.langOffered = true;
  if ((cfg.language ?? ctx.defaultLang) === ctx.lang) return; // the language t3sm would use anyway: nothing to save
  if (!(await ask(ctx, t(ctx, "saveLangAsk"), { def: "n", help: t(ctx, "saveLangHelp"), back: false }))) return;
  await guardLock(ctx);
  if (!(await ctx.d.saveLanguage(ctx.lang))) { say(ctx, t(ctx, "lockedRace")); throw new Stop(0); }
  ctx.done.push({ what: t(ctx, "didLanguage"), runId: null, undo: t(ctx, "undoLanguage") });
  say(ctx, t(ctx, "langSaved"));
}

// ---------------- 1 welcome ----------------

/** The steps a returning user sees as a checklist: ✓ done, ◉ next, ○ later (steps 3 to 11; 1 and 2 run every time). */
export function resumeChecklist(ctx: Ctx, next: number): string[] {
  const { s } = ctx;
  const atoms: string[] = [];
  for (let n = 3; n <= TOTAL_STEPS; n++) {
    const title = t(ctx, `title${n}` as Key);
    const mark = n < next ? s("ok", s.sym.ok) : n === next ? s("accent", s.sym.cur) : s("muted", s.sym.ring);
    atoms.push(`${mark}${" "}${n === next ? s("title", title.replace(/ /g, " ")) : title.replace(/ /g, " ")}${n < TOTAL_STEPS ? " " : ""}`);
  }
  return flowAtoms(atoms, Math.max(1, width(ctx) - 2), 0).map((l) => `  ${l.replace(/ /g, " ")}`.replace(/ +$/, ""));
}

/** "y yes · n no · ...": a key stays with its word and a line never starts with the separator (a "-" without Unicode). */
function keyLegend(ctx: Ctx): string[] {
  const NB = "\u00a0";
  const parts = ctx.m.welcomeKeys.split(" · ").map((x) => glyphs(ctx, x));
  const atoms = parts.map((x, i) => x.replace(/ /g, NB) + (i < parts.length - 1 ? NB + ctx.s.sym.sep : ""));
  return flowAtoms(atoms, width(ctx), 0).map((l) => ctx.s("muted", l.replace(/\u00a0/g, " ")));
}

export const welcome: Step = async (ctx) => {
  const about = await ctx.d.about().catch(() => null);
  if (about) {
    blank(ctx);
    // The version is data (sanitised); the rule spans the screen.
    lines(ctx, appHeader(ctx.s, { version: shownText(about.version, 20), subtitle: t(ctx, "appAccounts", { n: about.accounts }) }, width(ctx)));
  }
  heading(ctx, 1);
  const r = ctx.resume;
  if (r) {
    say(ctx, t(ctx, "resumeHead"));
    lines(ctx, resumeChecklist(ctx, r.step));
    say(ctx, t(ctx, "resumeLast", { what: t(ctx, r.what, { n: r.n ?? 0 }) }));
    say(ctx, t(ctx, "resumeNext", { n: r.step, title: t(ctx, `title${r.step}` as Key) }));
  } else {
    say(ctx, t(ctx, "welcomeBody"));
    blank(ctx);
    lines(ctx, box(ctx, { title: t(ctx, "welcomePanelTitle"), body: t(ctx, "welcomePanel").split("\n").map((l) => ({ bullet: ctx.s("accent", ctx.s.sym.sep), text: l })) }));
    lines(ctx, keyLegend(ctx));
  }
  say(ctx, ctx.s("muted", t(ctx, "langSwitch")));
  ctx.jumpTo = null;
  ctx.pilotVerify = null;
  if (r) {
    // A returning user is asked one thing: continue where they were (y), or go through the steps again (n).
    if (await ask(ctx, t(ctx, "resumeAsk", { n: r.step }), { def: "y", help: t(ctx, "resumeHelp"), back: false })) {
      ctx.jumpTo = r.step;
      ctx.pilotVerify = r.runId ?? null;
    }
  } else if (!(await ask(ctx, t(ctx, "welcomeAsk"), { def: "y", help: t(ctx, "welcomeHelp"), back: false }))) throw new Quit();
  await offerLanguage(ctx);
  return NEXT;
};

// ---------------- 2 check ----------------

const T3_DOWN = new Set(["t3-runtime", "t3-reachable"]);

/** What a doctor warning means for this user, decided by its check id and its structured data (never its English words). */
type Relevance =
  | { show: false; why: string }
  | { show: true; body: string[]; command?: string };

/**
 * The relevance rule of each doctor warning (spec §5.4: "Worth knowing" only for things that matter to this user):
 * - t3-version: never a callout; said once in the user's language (checkUntested).
 * - instance-unpinned: hidden. The import pins the account's folder itself; there is nothing for the user to do.
 * - t3sm-plugin (an outdated plugin): hidden here; the last step names the account and the update command.
 * - harness:<agent> (from its data): unreadable files are always said, in words, with `t3sm scan` and the help topic.
 *   A missing instance for the agent is hidden here: whether it matters depends on whether any of that agent's sessions
 *   would be skipped for it, which only the plan knows; the plan step shows it then, with how many (planAgents). An
 *   agent with no sessions is never mentioned.
 * - merge-pending (from its data): the sessions continued in a terminal, how many, a relative date and `t3sm merge`;
 *   the sessions with work on a side branch, and how to continue them.
 * A check without data (an older doctor) is shown as doctor words it: the assistant never parses doctor's English.
 * - backups-present, instances: shown, with the step that deals with them.
 * - Any other warning: shown as doctor words it, with its fix.
 * Doctor's words come from its catalogue parts (checkWords), in the user's language, as `t3sm doctor` shows them.
 */
export function relevance(ctx: Ctx, c: Check): Relevance {
  const w = checkWords(c, ctx.lang);
  const msg = shownText(w.message, 600);
  const fix = w.fix ? [t(ctx, "checkFix", { fix: shownText(w.fix, 600) })] : [];
  if (c.id === "instance-unpinned") return { show: false, why: "the import pins it" };
  if (c.id === "t3sm-plugin") return { show: false, why: "the last step offers the update" };
  const d = c.data;
  if (/^harness:/.test(c.id) && d && "harness" in d) {
    // Unreadable files are always said; a missing instance only at the plan, which knows how many sessions it skips.
    const name = AGENT_NAME[d.harness] ?? shownText(d.harness, 30);
    if (d.readErrors > 0) return { show: true, body: [t(ctx, "checkReadErrors", { n: d.readErrors, name })] };
    if (d.noInstance) return { show: false, why: "the plan step says it, only when sessions are skipped" };
  }
  if (c.id === "merge-pending" && d && "continued" in d) {
    // The side branch first (continued in a terminal by hand); then the merge, which the command at the end is for.
    const body: string[] = [];
    if (d.sideBranch > 0) body.push(t(ctx, "checkSideBranch", { n: d.sideBranch }));
    if (d.continued > 0) {
      const when = Number.isNaN(Date.parse(d.at)) ? null : ctx.f.ago(d.at);
      body.push(t(ctx, when ? "checkMerge" : "checkMergeNoDate", { n: d.continued, ago: when ?? "" }), t(ctx, "checkMergeWhy"));
    }
    if (body.length > 0) return { show: true, body, ...(d.continued > 0 ? { command: "t3sm merge" } : {}) };
  }
  if (c.id === "backups-present") return { show: true, body: [msg, t(ctx, "checkLater6")] };
  if (c.id === "instances") return { show: true, body: [msg, t(ctx, "checkLater3")] };
  return { show: true, body: [msg, ...fix] };
}

/** The untested T3 Code version, from the check's own parts (an older doctor without them: its message's first word). */
function untestedVersion(c: Check): string {
  const v = c.say?.find((p) => p.key === "doctor.say.t3Version.untested")?.vars?.["version"];
  return typeof v === "string" ? v : c.message.split(" ")[0] ?? "";
}

/** Every check as a compact grid: `✓ Node   ! Backup folders   ○ Pi sessions` (○: nothing to do here). */
function checkGrid(ctx: Ctx, checks: Check[], hidden: Set<Check>): string[] {
  const { s } = ctx;
  const cells = checks.map((c) => {
    const sym = c.status === "fail" ? s("err", s.sym.err) : c.status === "warn" && !hidden.has(c) ? s("warn", s.sym.warn)
      : c.status === "ok" ? s("ok", s.sym.ok) : s("muted", s.sym.ring);
    return { sym, name: glyphs(ctx, checkName(ctx.ui, c.id)) };
  });
  const w = width(ctx);
  const cw = Math.min(Math.max(...cells.map((c) => 2 + displayWidth(c.name))), Math.max(4, w - 2));
  const per = Math.max(1, Math.floor((w - 2 + 3) / (cw + 3)));
  const out: string[] = [];
  for (let i = 0; i < cells.length; i += per) {
    out.push(("  " + cells.slice(i, i + per).map((c) => {
      const name = truncateEnd(c.name, cw - 2, s.sym.ellipsis);
      return `${c.sym} ${name}${" ".repeat(Math.max(0, cw - 2 - displayWidth(name)))}`;
    }).join("   ")).replace(/ +$/, ""));
  }
  return out;
}

export const check: Step = async (ctx) => {
  heading(ctx, 2);
  say(ctx, t(ctx, "checkIntro"));
  let ids: string[] = [];
  for (;;) {
    say(ctx, ctx.s("muted", t(ctx, "checkRunning")));
    const checks = await ctx.d.doctor();
    if (checks.some((c) => c.status === "fail" && T3_DOWN.has(c.id))) {
      lines(ctx, callout(ctx.s, { kind: "needs-you", title: t(ctx, "t3DownTitle"), body: [t(ctx, "t3Down")] }, width(ctx)));
      if (await ask(ctx, t(ctx, "t3DownAsk"), { def: "y", help: t(ctx, "t3DownHelp") })) continue;
      throw new Quit();
    }
    const fails = checks.filter((c) => c.status === "fail");
    // An untested T3 Code version (same minor or not) is said once, in the user's language, instead of doctor's line.
    const untested = checks.find((c) => c.id === "t3-version" && c.status === "warn");
    const warns = checks.filter((c) => c.status === "warn" && c !== untested);
    const judged = new Map(warns.map((c) => [c, relevance(ctx, c)] as const));
    const shownWarns = warns.filter((c) => judged.get(c)!.show);
    const hidden = new Set(warns.filter((c) => !judged.get(c)!.show));
    if (untested) hidden.add(untested);
    ids = [...fails, ...shownWarns].map((c) => c.id);
    const ok = checks.filter((c) => c.status === "ok" || hidden.has(c)).length;
    const counted = checks.filter((c) => c.status !== "skip").length;
    lines(ctx, leadLines(ctx.s, fails.length > 0
      ? { sym: ctx.s.sym.err, tone: "err", word: t(ctx, "checkProblems", { n: fails.length }), note: t(ctx, "checkPassed", { ok, n: counted }) }
      : { sym: ctx.s.sym.ok, tone: "ok", word: t(ctx, shownWarns.length > 0 ? "checkReadyNotes" : "checkAllOk", { n: shownWarns.length }), note: t(ctx, "checkPassed", { ok, n: counted }) }, width(ctx)));
    lines(ctx, checkGrid(ctx, checks, hidden));
    if (fails.length > 0) {
      blank(ctx);
      say(ctx, t(ctx, "checkFailIntro"));
      for (const c of fails) {
        const w = checkWords(c, ctx.lang);
        lines(ctx, callout(ctx.s, { kind: "needs-you", title: glyphs(ctx, checkName(ctx.ui, c.id)), body: [shownText(w.message, 600), ...(w.fix ? [t(ctx, "checkFix", { fix: shownText(w.fix, 600) })] : [])] }, width(ctx)));
      }
      say(ctx, t(ctx, "checkFailStop"));
      throw new Stop(1);
    }
    if (untested) { blank(ctx); say(ctx, t(ctx, "checkUntested", { version: shownText(untestedVersion(untested), 60) })); }
    if (shownWarns.length > 0) {
      blank(ctx);
      say(ctx, t(ctx, "checkWarnIntro"));
      for (const c of shownWarns) {
        const r = judged.get(c) as Extract<Relevance, { show: true }>;
        lines(ctx, callout(ctx.s, { kind: "warn", title: glyphs(ctx, checkName(ctx.ui, c.id)), body: r.body, ...(r.command ? { command: r.command } : {}) }, width(ctx)));
      }
    }
    break;
  }
  if (ctx.jumpTo !== null) {
    const step = ctx.jumpTo;
    ctx.jumpTo = null;
    ctx.fullDone = step >= 9;
    return { to: "goto", step };
  }
  const help = t(ctx, "checkHelp") + (ids.length > 0 ? ` ${t(ctx, "checkIds", { ids: ids.join(", ") })}` : "");
  if (!(await ask(ctx, t(ctx, "checkAsk"), { def: "y", help }))) throw new Quit();
  return NEXT;
};

// ---------------- 3 accounts ----------------

async function ensureConfig(ctx: Ctx): Promise<void> {
  if ((await ctx.d.config()).exists) return;
  say(ctx, t(ctx, "accConfigFirst"));
  await write(ctx, ["accounts", "--init"], t(ctx, "accConfigFirst"));
  ctx.done.pop(); // part of the write the user just confirmed; the summary lists that write
}

/** A number from 1 to `max`; Enter is `def` when one is given. */
async function pickNumber(ctx: Ctx, question: string, max: number, help: string, def?: number): Promise<number> {
  for (;;) {
    const a = await askText(ctx, question, { help });
    if (a === "" && def !== undefined) return def;
    const n = /^\d+$/.test(a) ? Number(a) : NaN;
    if (n >= 1 && n <= max) return n;
    say(ctx, t(ctx, "badNumber"));
  }
}

async function pickColor(ctx: Ctx): Promise<{ hex: string; label: string } | null> {
  const names = Object.fromEntries(PALETTE.map(([k], i) => [`c${i + 1}`, ctx.m[k]]));
  say(ctx, t(ctx, "accColors", names));
  for (;;) {
    const a = await askText(ctx, t(ctx, "accColorAsk"), { help: t(ctx, "accNamesHelp") });
    if (a === "") return null;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= PALETTE.length) { const [k, hex] = PALETTE[n - 1]!; return { hex, label: `${ctx.m[k]} ${hex}` }; }
    if (n === 7) {
      for (;;) {
        const c = await askText(ctx, t(ctx, "accColorCustom"), { help: t(ctx, "accNamesHelp") });
        if (/^#[0-9A-Fa-f]{6}$/.test(c)) return { hex: c.toUpperCase(), label: c.toUpperCase() };
        say(ctx, t(ctx, "accColorBad"));
      }
    }
    say(ctx, t(ctx, "badNumber"));
  }
}

/** Where an account was found, in plain words. */
function foundFrom(ctx: Ctx, r: AccountRow): string {
  const word = (s: string): string => {
    switch (s) {
      case "default": return t(ctx, "via_default");
      case "folder": return t(ctx, "via_folder");
      case "shell-profile": return r.alias ? t(ctx, "via_shell", { alias: nameOf(ctx, r.alias, 40) }) : t(ctx, "via_shellNoAlias");
      case "vscode-pin": return t(ctx, "via_vscode");
      case "env": return t(ctx, "via_env");
      case "t3-instance": return t(ctx, "via_t3");
      case "config": return t(ctx, "via_config");
      default: return nameOf(ctx, s, 40);
    }
  };
  return [...new Set(r.foundVia.map(word))].join(", ");
}

/** The accounts as a table: number, name, whether T3 Code has it, folder, email (masked). Where each was found goes under it. */
function accountTable(ctx: Ctx, rs: AccountRow[]): string[] {
  const { s } = ctx;
  const cols: Column[] = [
    { header: "#", get: (r) => String(rs.indexOf(r as AccountRow) + 1), align: "right", priority: 10 },
    { header: t(ctx, "accColName"), get: (r) => accountOf(ctx, (r as AccountRow).displayName, 40), priority: 9, min: 10 },
    { header: t(ctx, "accColT3"), get: (r) => ((r as AccountRow).hasInstance ? `${s.sym.ok} ${t(ctx, "accYes")}` : `${s.sym.ring} ${t(ctx, "accNoInstance")}`), priority: 8 },
    { header: t(ctx, "accColFolder"), get: (r) => nameOf(ctx, (r as AccountRow).home, 80), priority: 6, truncate: "middle", min: 12 },
    { header: t(ctx, "accColEmail"), get: (r) => ((r as AccountRow).email ? nameOf(ctx, (r as AccountRow).email!, 60) : t(ctx, "accNoEmail")), priority: 4 },
  ];
  return table(s, cols, rs, width(ctx));
}

export const accounts: Step = async (ctx) => {
  heading(ctx, 3);
  let rs = await ctx.d.accounts(ctx.allowUntested);
  if (rs.length === 0) { say(ctx, t(ctx, "accNone")); throw new Stop(0); }
  say(ctx, t(ctx, "accIntro", { n: rs.length }));
  const show = (): void => {
    blank(ctx);
    lines(ctx, accountTable(ctx, rs));
    // Where each account was found: free text, too long for a column, so one muted line each under the table.
    for (const [i, r] of rs.entries()) say(ctx, ctx.s("muted", t(ctx, "accVia", { n: i + 1, via: foundFrom(ctx, r) })));
    blank(ctx);
  };
  show();
  const missing = rs.filter((r) => !r.hasInstance);
  if (missing.length > 0) {
    say(ctx, t(ctx, "accMissing", { n: missing.length, ids: missing.map((r) => nameOf(ctx, r.id, 40)).join(", ") }));
    if (await ask(ctx, t(ctx, "accCreateAsk"), { def: "n", help: t(ctx, "accCreateHelp") })) {
      await ensureConfig(ctx);
      await write(ctx, ["accounts", "--apply", "--yes", ...ut(ctx)], t(ctx, "didInstances"), { undo: () => t(ctx, "undoInstances") });
      rs = await ctx.d.accounts(ctx.allowUntested);
      show();
    }
  }
  if (await ask(ctx, t(ctx, "accNamesAsk"), { def: "y", help: t(ctx, "accNamesHelp") })) return NEXT;
  for (;;) {
    const r = rs[(await pickNumber(ctx, t(ctx, "accPick"), rs.length, t(ctx, "accNamesHelp"))) - 1]!;
    if (!r.hasInstance) say(ctx, t(ctx, "accRenameNoInstance", { id: nameOf(ctx, r.id, 40) }));
    else {
      const name = (await askText(ctx, t(ctx, "accNameAsk", { id: nameOf(ctx, r.id, 40), name: accountOf(ctx, r.displayName, 40) }), { help: t(ctx, "accNamesHelp") })) || r.displayName;
      const color = await pickColor(ctx);
      const q = t(ctx, "accRenameAsk", { id: nameOf(ctx, r.id, 40), name: accountOf(ctx, name, 40), color: color ? t(ctx, "accRenameColor", { color: color.label }) : "" });
      if (await ask(ctx, q, { def: "n", help: t(ctx, "accRenameHelp") })) {
        await ensureConfig(ctx);
        await write(ctx, ["accounts", "--rename", r.id, name, ...(color ? ["--color", color.hex] : []), ...ut(ctx)], t(ctx, "didRename", { id: nameOf(ctx, r.id, 40), name: accountOf(ctx, name, 40) }),
          { undo: (id) => (id ? t(ctx, "undoRename", { runId: id }) : null) });
        rs = rs.map((x) => (x.id === r.id ? { ...x, displayName: name } : x));
      }
    }
    if (!(await ask(ctx, t(ctx, "accMore"), { def: "n", help: t(ctx, "accNamesHelp") }))) return NEXT;
  }
};

// ---------------- 4 plan ----------------

const AGENT_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode" };

/**
 * The agents whose sessions this plan skips because T3 Code has no instance for them (skip reason
 * harness-unavailable), with how many: the doctor's "no <agent> instance" warning, shown only when it matters.
 */
export function planAgents(p: PlanView): { harness: string; n: number }[] {
  const by = new Map<string, number>();
  for (const i of p.plan.items) if (i.action.kind === "skip" && i.action.reason === "harness-unavailable") by.set(i.session.harness, (by.get(i.session.harness) ?? 0) + 1);
  return [...by.entries()].sort((a, b) => b[1] - a[1]).map(([harness, n]) => ({ harness, n }));
}

/** The plan's summary: a panel with the counts aligned (and the imports per account), then the notes that matter. */
function showSummary(ctx: Ctx, p: PlanView): void {
  const sum = summarize(p.plan);
  const imp = sum.byAction["import"] ?? 0;
  const conv = sum.byAction["convert-import"] ?? 0;
  const by = Object.entries(sum.byInstance).sort((a, b) => b[1] - a[1]);
  // One column of numbers: the totals, then (with more than one account) the imports of each account under its own label.
  const c = counts(ctx, [
    [t(ctx, "planImport"), imp], [t(ctx, "planConvert"), conv], [t(ctx, "planSkip"), sum.byAction["skip"] ?? 0],
    [t(ctx, "planNewProjects"), p.plan.projectsToCreate.length], [t(ctx, "planNewInstances"), p.plan.instancesToCreate.length],
    ...(by.length > 1 ? by.map(([id, n]): [string, number] => [`  ${accountOf(ctx, p.names[id] ?? id, 36)}`, n]) : []),
  ]);
  if (by.length > 1) c.splice(5, 0, [t(ctx, "planByAccount"), ""]);
  const body = rows(ctx, c);
  blank(ctx);
  lines(ctx, box(ctx, { title: t(ctx, "planHead"), body }));
  if (conv > 0) say(ctx, t(ctx, "planConvertNote"));
  const top = SKIP_REASONS.filter((r) => sum.byReason[r] > 0).sort((a, b) => sum.byReason[b] - sum.byReason[a]).slice(0, 3);
  if (top.length > 0) say(ctx, t(ctx, "planTopSkips", { reasons: top.map((r) => `${ctx.m[`skip_${r}` as Key] ?? r} (${num(ctx, sum.byReason[r])})`).join(", ") }));
  for (const a of planAgents(p)) {
    const name = AGENT_NAME[a.harness] ?? nameOf(ctx, a.harness, 30);
    lines(ctx, callout(ctx.s, { kind: "warn", title: t(ctx, "agentSkippedTitle", { name, n: a.n }), body: [t(ctx, "agentSkipped", { name })] }, width(ctx)));
  }
  if (imp + conv === 0) say(ctx, t(ctx, "planNothing"));
  say(ctx, ctx.s("muted", t(ctx, "planReport", { path: shown(ctx, p.planPath, Math.max(10, width(ctx) - 16)) })));
}

/** Changes a project's account through `t3sm projects set` (the route, and the T3 Code default when it exists). */
async function changeAccount(ctx: Ctx, row: ProjectRow): Promise<boolean> {
  const p = ctx.plan!;
  const folder = shown(ctx, row.folder, 60);
  say(ctx, t(ctx, "planAccountFor", { folder }));
  p.config.accounts.forEach((a, i) => say(ctx, `  ${i + 1}. ${accountOf(ctx, a.displayName, 40)} (${nameOf(ctx, a.id, 40)})`));
  const acct = p.config.accounts[(await pickNumber(ctx, t(ctx, "planAccountAsk"), p.config.accounts.length, t(ctx, "planPageHelp"))) - 1]!;
  // The undo puts back what config.json had: the folder's own route (its account), or no route at all.
  const full = tildePath(row.folder, ctx.d.home);
  const own = p.config.routes.find((r) => !isGlob(r.match) && sameCwd(r.match, row.folder))?.account ?? null;
  const undoRoute = own ? t(ctx, "undoRouteBack", { folder: full, account: own }) : t(ctx, "undoRoute", { folder: full });
  const name = accountOf(ctx, acct.displayName, 40);
  if (!(await ask(ctx, t(ctx, "planRouteAsk", { folder, name, undo: undoRoute }), { def: "n", help: t(ctx, "planRouteHelp") }))) return false;
  const { outcome } = await write(ctx, ["projects", "set", row.folder, acct.id, "--yes", ...ut(ctx)], t(ctx, "didRoute", { folder, name }),
    { undo: (id) => undoRoute + (id ? t(ctx, "undoT3Default", { runId: id }) : "") });
  if (NOTHING_TO_CHANGE_MARKS.some((m) => outcome.output.includes(m))) { ctx.done.pop(); return false; } // nothing was written
  await buildPlan(ctx, "planRouteSaved");
  return true;
}

/** One page of the project table: number, project, account, why that account. */
function projectTable(ctx: Ctx, page: ProjectRow[], start: number): string[] {
  const cols: Column[] = [
    { header: "#", get: (r) => String(start + page.indexOf(r as ProjectRow) + 1), align: "right", priority: 10 },
    { header: t(ctx, "colProject"), get: (r) => shown(ctx, (r as ProjectRow).folder, 60), priority: 9, truncate: "middle", min: 12 },
    { header: t(ctx, "colAccount"), get: (r) => accountOf(ctx, (r as ProjectRow).accountName, 30), priority: 8, min: 8 },
    { header: t(ctx, "colWhy"), get: (r) => t(ctx, `reason_${(r as ProjectRow).reason}` as Key), priority: 5 },
  ];
  return table(ctx.s, cols, page, width(ctx));
}

export const plan: Step = async (ctx) => {
  heading(ctx, 4);
  say(ctx, t(ctx, "planIntro"));
  let p = await buildPlan(ctx);
  showSummary(ctx, p);
  for (let start = 0; ;) {
    const rs = rowsOf(p);
    if (rs.length === 0) return NEXT;
    if (start === 0) { blank(ctx); say(ctx, t(ctx, "planTableIntro")); }
    const page = rs.slice(start, start + PAGE);
    lines(ctx, projectTable(ctx, page, start));
    const last = start + PAGE >= rs.length;
    if (rs.length > PAGE) say(ctx, ctx.s("muted", t(ctx, "planPage", { from: start + 1, to: start + page.length, total: rs.length })));
    const a = (await askText(ctx, t(ctx, last ? "planLastAsk" : "planMoreAsk"), { help: t(ctx, "planPageHelp") })).toLowerCase();
    // c, y and n (no change) all continue; Enter turns the page, or continues on the last one.
    if (a === "c" || YES_WORDS.has(a) || NO_WORDS.has(a) || (a === "" && last)) return NEXT;
    if (a === "") { start += PAGE; continue; }
    const n = /^\d+$/.test(a) ? Number(a) : NaN;
    if (!(n >= 1 && n <= rs.length)) { say(ctx, t(ctx, "badNumber")); continue; }
    if (await changeAccount(ctx, rs[n - 1]!)) { p = ctx.plan!; showSummary(ctx, p); start = 0; }
  }
};

// ---------------- 5 decisions ----------------

/** The terminal for a review list: the assistant's own, whose input the lists share but never close. */
function listTerm(ctx: Ctx): Term {
  return Object.create(ctx.d.term, { dispose: { value: undefined } }) as Term;
}

/** config.json "organize", under the lock, only after the "y" the caller just got. A held lock ends the assistant. */
async function saveSettings(ctx: Ctx, patch: OrganizePatch, what: string, undo: string): Promise<void> {
  await guardLock(ctx);
  if (!(await ctx.d.saveOrganize(patch))) { say(ctx, t(ctx, "lockedRace")); throw new Stop(0); }
  ctx.done.push({ what, runId: null, undo });
}

interface Decision { topic: Key; say: Key; ask: Key; why: Key; setting: string; yes: boolean; value(yes: boolean): string }
const FOLDER_YES = (yes: boolean): string => (yes ? "rehome" : "skip");
const TEMP_YES = (yes: boolean): string => (yes ? "import" : "skip");
/** The questions the planner can leave pending, in the words the assistant asks them (the keys are `organize.decided`'s). */
const DECISIONS: Record<string, Decision> = {
  home: { topic: "decHomeTopic", say: "decHomeSay", ask: "decHomeAsk", why: "decHomeWhy", setting: 'organize.folders.home ("rehome" | "import" | "skip")', yes: true, value: FOLDER_YES },
  "t3-refused": { topic: "decRefusedTopic", say: "decRefusedSay", ask: "decRefusedAsk", why: "decRefusedWhy", setting: 'organize.folders["t3-refused"] ("rehome" | "import" | "skip")', yes: true, value: FOLDER_YES },
  temp: { topic: "decTempTopic", say: "decTempSay", ask: "decTempAsk", why: "decTempWhy", setting: 'organize.folders.temp ("import" | "skip" | "rehome")', yes: false, value: TEMP_YES },
  system: { topic: "decSystemTopic", say: "decSystemSay", ask: "decSystemAsk", why: "decSystemWhy", setting: 'organize.folders.system ("import" | "skip" | "rehome")', yes: false, value: TEMP_YES },
  automated: { topic: "decAutoTopic", say: "decAutoSay", ask: "decAutoAsk", why: "decAutoWhy", setting: 'organize.sessions.automated ("import" | "skip")', yes: false, value: TEMP_YES },
  orphaned: { topic: "decOrphanedTopic", say: "decOrphanedSay", ask: "decOrphanedAsk", why: "decOrphanedWhy", setting: 'organize.sessions.orphaned ("copy" | "skip")', yes: true, value: (yes) => (yes ? "copy" : "skip") },
};

/**
 * Pending questions are a gate: a step that has just built a fresh plan sends the user to the decisions step first when
 * the plan has questions in DECISIONS that were not asked in this session, and the decisions step comes back to `from`.
 * Null: nothing to ask. Without this, a returning user resumed at the import and the questions the plan found since last
 * time were skipped (their conversations silently left out).
 */
export async function gateDecisions(ctx: Ctx, from: number): Promise<StepResult | null> {
  const pending = (ctx.plan?.plan.decisionsPending ?? []).filter((d) => Object.hasOwn(DECISIONS, d.key) && !ctx.asked.has(d.key));
  if (pending.length === 0) return null;
  blank(ctx);
  lines(ctx, callout(ctx.s, { kind: "needs-you", title: t(ctx, "decisionsNewTitle", { n: pending.length }), body: [t(ctx, "decisionsNew", { n: pending.length })] }, width(ctx)));
  ctx.returnTo = from;
  return { to: "goto", step: 5, gated: true };
}

/** Where the decisions step goes when it ends: back to the step that called the gate, else the next one. */
function afterDecisions(ctx: Ctx): StepResult {
  const back = ctx.returnTo;
  ctx.returnTo = null;
  return back === null ? NEXT : { to: "goto", step: back };
}

/** One group of moved conversations: the folder they came from, how many, and where the planner put them. */
interface MoveGroup { from: string; n: number; to: Map<string, number>; share: { hits: number; total: number } | null; shared: number }

function moveGroups(p: PlanView): MoveGroup[] {
  const groups = new Map<string, MoveGroup>();
  for (const i of p.plan.items) {
    if (i.action.kind !== "convert-import" || i.action.rehomeFrom === undefined) continue;
    const g = groups.get(i.action.rehomeFrom) ?? { from: i.action.rehomeFrom, n: 0, to: new Map(), share: null, shared: 0 };
    g.n++;
    if (i.action.rehomeShare) {
      g.shared++;
      g.share = { hits: (g.share?.hits ?? 0) + i.action.rehomeShare.hits, total: (g.share?.total ?? 0) + i.action.rehomeShare.total };
    }
    g.to.set(i.action.projectRoot, (g.to.get(i.action.projectRoot) ?? 0) + 1);
    groups.set(g.from, g);
  }
  return [...groups.values()].sort((a, b) => b.n - a.n || (a.from < b.from ? -1 : 1));
}

const OTHER_PROJECTS = 12;

/**
 * After the answers are saved and the plan redone: shows where each group of copied conversations goes (inferred
 * project or the General one), lets the user change a destination or leave a group out, and saves the changes as
 * `organize.overrides` (folder -> `rehome:<root>` or `skip`). The names of the projects to create are only shown.
 */
async function moveReview(ctx: Ctx): Promise<void> {
  const p = ctx.plan!;
  const groups = moveGroups(p);
  if (groups.length === 0) return;
  const home = ctx.d.home;
  const settings = organizeSettings(p.config, ctx.lang);
  const generalTitle = ctx.lang === "pt" ? "Geral" : "General";
  const general = p.plan.projectsToCreate.find((x) => x.title === generalTitle)?.root ?? expandHome(settings.generalFolder, home);
  const isGeneral = (root: string): boolean => sameCwd(root, general);
  const roots = new Set(groups.flatMap((g) => [...g.to.keys()]));

  const created = p.plan.projectsToCreate.filter((x) => roots.has(x.root));
  blank(ctx);
  say(ctx, t(ctx, "decMoveIntro"));
  if (created.length > 0) say(ctx, t(ctx, "decNames", { count: created.length, names: created.map((x) => `"${nameOf(ctx, x.title, 40)}"`).join(", ") }));

  // Other projects a group could go to: the ones this plan imports into, busiest first.
  const known = new Map<string, number>();
  for (const i of p.plan.items) {
    if ((i.action.kind !== "import" && i.action.kind !== "convert-import") || (i.action.kind === "convert-import" && i.action.rehomeFrom !== undefined)) continue;
    known.set(i.action.projectRoot, (known.get(i.action.projectRoot) ?? 0) + 1);
  }
  const others = [...known.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, OTHER_PROJECTS).map(([r]) => r);

  const choiceAction = new Map<string, Map<string, string | null>>();
  const items = groups.map((g, idx): ListItem => {
    const dests = [...g.to.keys()];
    const single = dests.length === 1 ? dests[0]! : null;
    const suggested = single === null ? t(ctx, "decChoiceSuggestedMixed")
      : t(ctx, isGeneral(single) ? "decChoiceSuggestedGeneral" : "decChoiceSuggested", { path: shown(ctx, single, 50) });
    const actions = new Map<string, string | null>([[suggested, null]]);
    const add = (text: string, action: string): void => void (actions.has(text) || actions.set(text, action));
    for (const r of others) if (single === null || !sameCwd(r, single)) add(shown(ctx, r, 60), `rehome:${tildePath(r, home)}`);
    if (single === null || !isGeneral(single)) add(t(ctx, "decChoiceGeneral", { path: shown(ctx, general, 50) }), `rehome:${tildePath(general, home)}`);
    add(t(ctx, "decChoiceSkip"), "skip");
    choiceAction.set(String(idx), actions);
    const project = single === null ? "" : (tildePath(single, home).split("/").filter((x) => x !== "").at(-1) ?? single);
    const share = g.share !== null && g.shared === g.n && single !== null && !isGeneral(single) ? t(ctx, "decShare", { hits: g.share.hits, total: g.share.total, project: nameOf(ctx, project, 40) }) : null;
    const where = single === null ? t(ctx, "decToMixed") : isGeneral(single) ? t(ctx, "decToGeneral", { path: shown(ctx, single, 50) }) : share !== null ? ` ${share}.` : t(ctx, "decToInferred", { path: shown(ctx, single, 50) });
    const folder = shown(ctx, g.from, 50) + (sameCwd(g.from, home) ? ` ${t(ctx, "decHomeTag")}` : "");
    const label = g.n === 1 ? t(ctx, "decRowOne", { folder }) : t(ctx, "decRowMany", { folder, n: g.n });
    return {
      id: String(idx), label, checked: true,
      detail: t(ctx, sameCwd(g.from, home) ? "decWhyHome" : "decWhyRefused") + where,
      editable: { prompt: t(ctx, "decEditPrompt"), value: suggested, choices: [...actions.keys()] },
    };
  });

  blank(ctx);
  const r = await reviewList(listTerm(ctx), { title: t(ctx, "decListTitle"), help: t(ctx, "decListHelp"), items, lang: ctx.lang });
  const changes: { match: string; action: string }[] = [];
  if (r.confirmed) {
    r.items.forEach((it, idx) => {
      const action = it.checked ? (choiceAction.get(it.id)?.get(it.editable?.value ?? "") ?? null) : "skip";
      if (action !== null) changes.push({ match: tildePath(groups[idx]!.from, home), action });
    });
  }
  if (changes.length === 0) { say(ctx, t(ctx, "decMoveNone")); return; }
  if (!(await ask(ctx, t(ctx, "decMoveSaveAsk"), { def: "n", help: t(ctx, "decMoveSaveHelp") }))) { say(ctx, t(ctx, "decMoveNotSaved")); return; }
  const kept = (p.config.organize?.overrides ?? []).filter((o) => !changes.some((c) => sameCwd(expandHome(o.match, home), expandHome(c.match, home))));
  await saveSettings(ctx, { overrides: [...kept, ...changes] as OrganizeConfig["overrides"] }, t(ctx, "didOverrides"), t(ctx, "undoOverrides"));
  say(ctx, t(ctx, "decMoveSaved"));
  await buildPlan(ctx, "decReplan");
}

/** Leaving the step with Back drops the gate's return point: a later normal visit must go on to the next step. */
export const decisions: Step = async (ctx) => {
  try { return await decisionsStep(ctx); } catch (e) { if (e instanceof Back) ctx.returnTo = null; throw e; }
};

const decisionsStep: Step = async (ctx) => {
  const p = ctx.plan ?? (await buildPlan(ctx));
  const pending = (p.plan.decisionsPending ?? []).filter((d) => Object.hasOwn(DECISIONS, d.key));
  if (pending.length === 0) return ctx.returnTo === null ? { to: "skip" } : afterDecisions(ctx);
  heading(ctx, 5);
  say(ctx, t(ctx, "decisionsIntro", { n: pending.length }));
  const general = ctx.lang === "pt" ? "Geral" : "General";
  const answers = new Map<string, boolean>();
  for (const [i, d] of pending.entries()) {
    const q = DECISIONS[d.key]!;
    blank(ctx);
    // One panel per question: what happened, then the default and where to change it later.
    const body = [t(ctx, q.say, { sessions: d.sessions, folders: d.folders, general }), "", ...rows(ctx, [
      [t(ctx, "decDefaultLabel"), t(ctx, q.why)], [t(ctx, "decLaterLabel"), q.setting],
    ])];
    lines(ctx, box(ctx, { title: t(ctx, "decPanelTitle", { i: i + 1, n: pending.length, topic: t(ctx, q.topic) }), body }));
    const help = t(ctx, "decHelp", { why: t(ctx, q.why), setting: q.setting, key: d.key });
    answers.set(d.key, await ask(ctx, t(ctx, q.ask, { sessions: d.sessions, folders: d.folders }), { def: q.yes ? "y" : "n", help }));
    ctx.asked.add(d.key);
  }
  const patch: OrganizePatch = { decided: pending.map((d) => d.key) };
  for (const d of pending) {
    const yes = answers.get(d.key)!;
    if (d.key === "automated") patch.sessions = { ...patch.sessions, automated: DECISIONS[d.key]!.value(yes) as "import" | "skip" };
    else if (d.key === "orphaned") patch.sessions = { ...patch.sessions, orphaned: DECISIONS[d.key]!.value(yes) as "copy" | "skip" };
    else patch.folders = { ...patch.folders, [d.key]: DECISIONS[d.key]!.value(yes) as OrganizeConfig["folders"]["home"] };
  }
  // The answers are the decision: saved at once (config.json only, under the lock). A separate "save?" question with a
  // default No left every conversation of the answered questions out of the import (0.3.0). q or b before the last
  // answer leaves the loop above by its exception, so nothing is saved then.
  blank(ctx);
  await saveSettings(ctx, patch, t(ctx, "didDecisions"), t(ctx, "undoDecisions"));
  okLine(ctx, t(ctx, "decSaved"));
  await buildPlan(ctx, "decReplan");
  if (answers.get("home") === true || answers.get("t3-refused") === true) await moveReview(ctx);
  return afterDecisions(ctx);
};

// ---------------- 6 clean-up ----------------

export const cleanup: Step = async (ctx) => {
  const p = ctx.plan ?? (await buildPlan(ctx));
  const gate = await gateDecisions(ctx, 6);
  if (gate) return gate;
  const c = await ctx.d.cleanupCounts(p.plan);
  if (c.backupFolders === 0 && c.mirrorCopies === 0) return { to: "skip" };
  heading(ctx, 6);
  say(ctx, t(ctx, "cleanIntro"));
  const found: [string, number, string?][] = [];
  if (c.backupFolders > 0) found.push([t(ctx, "cleanBackupsLabel"), c.backupFolders, t(ctx, "cleanBackupsWhat", { n: c.backupFolders })]);
  if (c.mirrorCopies > 0) found.push([t(ctx, "cleanMirrorsLabel"), c.mirrorCopies, t(ctx, "cleanMirrorsWhat", { n: c.mirrorCopies })]);
  blank(ctx);
  lines(ctx, box(ctx, { title: t(ctx, "cleanHead"), body: [...rows(ctx, counts(ctx, found)), "", t(ctx, "cleanReversible")] }));
  const undo: Undo = (id) => (id ? t(ctx, "undoMove", { runId: id }) : null);
  let moved = false;
  if (c.backupFolders > 0 && (await ask(ctx, t(ctx, "cleanQuarantineAsk"), { def: "n", help: t(ctx, "cleanQuarantineHelp") }))) {
    await write(ctx, ["quarantine", "--yes"], t(ctx, "didQuarantine"), { tolerate: [5], undo });
    moved = true;
  }
  if (c.mirrorCopies > 0 && (await ask(ctx, t(ctx, "cleanDedupeAsk"), { def: "n", help: t(ctx, "cleanDedupeHelp") }))) {
    await write(ctx, ["dedupe", "--yes"], t(ctx, "didDedupe"), { tolerate: [5], undo });
    moved = true;
  }
  if (!moved) say(ctx, t(ctx, "cleanNoOk"));
  else await buildPlan(ctx, "cleanRefreshing");
  return NEXT;
};

// ---------------- 7 pilot ----------------

/** "Here is what I will do", with the counts aligned and how to undo it. */
function willDo(ctx: Ctx, r: [string, string][]): void {
  blank(ctx);
  lines(ctx, box(ctx, { title: t(ctx, "willHead"), body: rows(ctx, r) }));
}

/** Asks whether the pilot looks right; on no, offers to undo that run, then stops with the next steps. */
async function verifyPilot(ctx: Ctx, runId: string): Promise<StepResult> {
  if (await ask(ctx, t(ctx, "pilotOkAsk"), { def: "y", help: t(ctx, "pilotOkHelp"), back: false })) return NEXT;
  if (await ask(ctx, t(ctx, "pilotUndoAsk", { runId }), { def: "n", help: t(ctx, "pilotUndoHelp", { runId }), back: false })) {
    await write(ctx, ["rollback", "--run", runId, "--yes", "--archive-threads", ...ut(ctx)], t(ctx, "didUndo"), { tolerate: [5] });
  }
  say(ctx, t(ctx, "pilotStopped"));
  throw new Stop(0);
}

/** The suggested pilot projects as a table: number, project, conversations to import, account. */
function pilotTable(ctx: Ctx, sugg: ProjectRow[]): string[] {
  const cols: Column[] = [
    { header: "#", get: (r) => String(sugg.indexOf(r as ProjectRow) + 1), align: "right", priority: 10 },
    { header: t(ctx, "colProject"), get: (r) => shown(ctx, (r as ProjectRow).folder, 60), priority: 9, truncate: "middle", min: 12 },
    { header: t(ctx, "colConversations"), get: (r) => num(ctx, (r as ProjectRow).pending), align: "right", priority: 8 },
    { header: t(ctx, "colAccount"), get: (r) => accountOf(ctx, (r as ProjectRow).accountName, 30), priority: 5 },
  ];
  return table(ctx.s, cols, sugg, width(ctx));
}

export const pilot: Step = async (ctx) => {
  heading(ctx, 7);
  if (ctx.pilotVerify) {
    // Back after a pilot (the user stopped at "Does it look right?" last time): check it before anything else.
    const runId = ctx.pilotVerify;
    ctx.pilotVerify = null;
    say(ctx, t(ctx, "pilotCheckAgain", { runId }));
    return verifyPilot(ctx, runId);
  }
  const p = ctx.plan ?? (await buildPlan(ctx));
  const gate = await gateDecisions(ctx, 7);
  if (gate) return gate;
  const all = rowsOf(p).filter((r) => r.pending > 0);
  if (all.length === 0) { say(ctx, t(ctx, "pilotNone")); return NEXT; }
  const sugg = all.filter((r) => !r.held).sort((a, b) => a.pending - b.pending || a.folder.localeCompare(b.folder)).slice(0, 5);
  say(ctx, t(ctx, "pilotIntro"));
  if (sugg.length > 0) {
    blank(ctx);
    say(ctx, t(ctx, "pilotSuggest"));
    lines(ctx, pilotTable(ctx, sugg));
  }
  let chosen: ProjectRow | null = null;
  while (!chosen) {
    const a = await askText(ctx, t(ctx, "pilotAsk", { max: Math.max(1, sugg.length) }), { help: t(ctx, "pilotHelp") });
    const l = a.toLowerCase();
    if (NO_WORDS.has(l)) { say(ctx, t(ctx, "pilotSkipped")); return NEXT; }
    if (YES_WORDS.has(l)) { say(ctx, t(ctx, "pilotBadAnswer")); continue; } // a yes is not a folder name
    if (a === "" || /^\d+$/.test(a)) {
      const n = a === "" ? 1 : Number(a);
      if (n >= 1 && n <= sugg.length) chosen = sugg[n - 1]!;
      else say(ctx, t(ctx, "pilotBadAnswer"));
      continue;
    }
    const f = normalizeFolder(a, process.platform, ctx.d.home);
    chosen = all.find((r) => sameCwd(r.folder, f)) ?? null;
    if (!chosen) say(ctx, t(ctx, "pilotNotFound"));
  }
  const folder = shown(ctx, chosen.folder, 60);
  say(ctx, ctx.s("muted", t(ctx, "pilotDry", { folder })));
  const dry = await ctx.d.run(["apply", "--dry-run", "--only", chosen.folder, ...ut(ctx)]);
  if (dry.code !== 0) { say(ctx, t(ctx, dry.code === 130 ? "stepInterrupted" : "stepFailed", { code: dry.code })); throw new Stop(dry.code); }
  willDo(ctx, [
    [t(ctx, "willProject"), folder],
    [t(ctx, "willImport"), `${ctx.s("num", num(ctx, chosen.pending))} ${t(ctx, "willConversations", { n: chosen.pending })}`],
    [t(ctx, "willAccount"), accountOf(ctx, chosen.accountName, 40)],
    [t(ctx, "willUndo"), ctx.s("key", "t3sm rollback --run <id> --archive-threads")],
  ]);
  if (!(await ask(ctx, t(ctx, "pilotApplyAsk", { folder }), { def: "n", help: t(ctx, "pilotApplyHelp") }))) { say(ctx, t(ctx, "pilotSkipped")); return NEXT; }
  const { outcome, runId } = await write(ctx, ["apply", "--yes", "--only", chosen.folder, ...ut(ctx)], t(ctx, "didPilot", { folder }),
    { tolerate: [5], undo: (id) => (id ? t(ctx, "undoImport", { runId: id }) : null) });
  if (runId === null) { say(ctx, t(ctx, "pilotNoRun")); return NEXT; }
  blank(ctx);
  if (outcome.code === 5) say(ctx, t(ctx, "pilotPartly"));
  say(ctx, t(ctx, "pilotCheck", { folder, name: accountOf(ctx, chosen.accountName, 40) }));
  return verifyPilot(ctx, runId);
};

// ---------------- 8 full import ----------------

export const full: Step = async (ctx) => {
  heading(ctx, 8);
  say(ctx, t(ctx, "fullIntro"));
  say(ctx, t(ctx, "fullChecklist"));
  const p = await buildPlan(ctx, "fullRefreshing");
  const gate = await gateDecisions(ctx, 8);
  if (gate) return gate;
  const rs = rowsOf(p).filter((r) => r.pending > 0);
  if (rs.length === 0) { say(ctx, t(ctx, "fullNothing")); ctx.fullDone = true; return NEXT; }
  const n = rs.reduce((a, r) => a + r.pending, 0);
  const held = rs.filter((r) => r.held).length;
  const c = counts(ctx, [[t(ctx, "willImport"), n, t(ctx, "willConversations", { n })], [t(ctx, "willInto"), rs.length, t(ctx, "willProjects", { n: rs.length })],
    ...(held > 0 ? [[t(ctx, "willHeld"), held, t(ctx, "willHeldWhat", { n: held })] as [string, number, string]] : [])]);
  willDo(ctx, [...c, [t(ctx, "willUndo"), ctx.s("key", "t3sm rollback --run <id> --archive-threads")]]);
  if (!(await ask(ctx, t(ctx, "fullAsk"), { def: "n", help: t(ctx, "fullHelp") }))) { say(ctx, t(ctx, "fullDeclined")); return { to: "goto", step: 11 }; }
  const { outcome, runId } = await write(ctx, ["apply", "--yes", ...ut(ctx)], t(ctx, "didFull"),
    { tolerate: [5], undo: (id) => (id ? t(ctx, "undoImport", { runId: id }) : null) });
  // The command has just shown its result, why each held project waits and every failure (with the help topic): the
  // assistant only says what that means for the next steps, and records what really happened.
  blank(ctx);
  // What the import really did, from its run (the plan above was before it): failures and the projects it held.
  const run = runId === null ? undefined : (await ctx.d.runs()).find((r) => r.runId === runId);
  if (outcome.code === 5) {
    const failed = run?.counts.importFailed ?? 0;
    const last = ctx.done.at(-1);
    if (last && last.runId === runId) last.what = failed > 0 ? t(ctx, "didFullPartial", { n: failed }) : t(ctx, "didFullFailures");
    say(ctx, t(ctx, "fullFailed"));
  } else if ((run?.held ?? 0) > 0) {
    // The import left projects in use for a later run (journaled on its run-end): never "All done" while some wait.
    okLine(ctx, t(ctx, "fullOkHeld", { n: run!.held! }));
  } else okLine(ctx, t(ctx, "fullOk"));
  ctx.fullDone = true;
  return NEXT;
};

// ---------------- 9 organize ----------------

const ALL_WORDS = new Set(["all", "tudo", "todo", "todas", "todos"]);
const NONE_WORDS = new Set(["none", "off", "nada", "nenhum", "nenhuma"]);
const AUTOMATED_WHY = "automated session (Agent SDK)";

/** T3 Code's own auto-settle accepts 1..90 days only (sidebarAutoSettleAfterDays). */
const T3_MAX_DAYS = 90;

/** The days answer (a number 1-3650, all, none) as days, "all" or "off"; Enter is `def`; null when not understood. */
export function parseDays(answer: string, def: number | "all" | "off"): number | "all" | "off" | null {
  const a = answer.trim().toLowerCase();
  if (a === "") return def;
  if (ALL_WORDS.has(a)) return "all";
  if (NONE_WORDS.has(a)) return "off";
  const n = /^\d+$/.test(a) ? Number(a) : NaN;
  return n >= 1 && n <= 3650 ? n : null;
}

/** The minimum per project (0-1000); Enter is `def`; null when not understood. */
export function parseMin(answer: string, def: number): number | null {
  const a = answer.trim();
  if (a === "") return def;
  const n = /^\d+$/.test(a) ? Number(a) : NaN;
  return n >= 0 && n <= 1000 ? n : null;
}

/** A rule in words: "the last 90 days, at least 10 per project", or "all of it". */
function ruleScope(ctx: Ctx, r: HistoryRule): string {
  if (r.days === "all") return t(ctx, "organizeScopeAll");
  return t(ctx, "organizeScopeRule", { scope: t(ctx, "organizeScopeDays", { d: r.days }), min: r.minPerProject });
}

/** Asks the days (a number, all, none; Enter = `def`) and then the minimum. Null: the rule off. */
async function askNumbers(ctx: Ctx, planned: HistoryRule, def: number | "all" | "off", help: string): Promise<HistoryRule | null> {
  let days: number | "all" | "off" | null = null;
  while (days === null) {
    const shownDef = def === "all" ? t(ctx, "organizeScopeAll") : def === "off" ? t(ctx, "organizeT3Off") : String(def);
    days = parseDays(await askText(ctx, t(ctx, "organizeHistoryDaysAsk", { def: shownDef }), { help }), def);
    if (days === null) say(ctx, t(ctx, "organizeHistoryDaysBad"));
  }
  if (days === "off") return null;
  if (days === "all") return { days, minPerProject: planned.minPerProject };
  let min: number | null = null;
  while (min === null) {
    min = parseMin(await askText(ctx, t(ctx, "organizeHistoryMinAsk", { min: planned.minPerProject }), { help }), planned.minPerProject);
    if (min === null) say(ctx, t(ctx, "organizeHistoryMinBad"));
  }
  return { days, minPerProject: min };
}

/**
 * The history question (spec §5.2), with the rule the preview was planned with. On: Enter or y keeps it, n asks the days
 * (a number, all, none) and the minimum. Off in config.json: Enter or n keeps it off (one Enter, nothing more), y asks
 * the days and the minimum to turn it on with. Returns the rule chosen (null = off).
 */
async function askHistory(ctx: Ctx, planned: HistoryRule, off: boolean, c: { shown: number; settled: number; kept: number; p: number }, was?: string): Promise<HistoryRule | null> {
  const help = t(ctx, "organizeHistoryHelp2");
  const body = off ? [t(ctx, "organizeOffHistory"), t(ctx, "organizeHistoryNow", c)]
    : [t(ctx, "organizeHistoryNow", c), t(ctx, planned.days === "all" ? "organizeHistorySayAll" : "organizeHistorySay", { days: planned.days, min: planned.minPerProject })];
  if (c.kept > 0) body.push(t(ctx, "organizeHistoryKept", { kept: c.kept }));
  if (was !== undefined) body.push(t(ctx, "organizeHistoryWas", { was }));
  lines(ctx, box(ctx, { title: t(ctx, "organizeHistoryTitle"), body: [...body, "", ...rows(ctx, [[t(ctx, "decDefaultLabel"), t(ctx, off ? "organizeHistoryDefaultOff" : "organizeHistoryDefault")], [t(ctx, "willUndo"), "t3sm organize --undo"]])] }));
  if (off) {
    const on = await ask(ctx, t(ctx, "organizeHistoryAskOn", { days: planned.days === "all" ? t(ctx, "organizeScopeAll") : planned.days, min: planned.minPerProject }), { def: "n", help });
    return on ? askNumbers(ctx, planned, planned.days, help) : null;
  }
  const q = planned.days === "all" ? t(ctx, "organizeHistoryAskAll") : t(ctx, "organizeHistoryAsk2", { days: planned.days, min: planned.minPerProject });
  if (await ask(ctx, q, { def: "y", help })) return planned;
  return askNumbers(ctx, planned, planned.days, help);
}

/** A 0.2 organize.history value in words ("every conversation visible", "the last 30 days visible", ...). */
function wasWords(ctx: Ctx, h: "all" | "off" | `days:${number}`): string {
  if (h === "all") return t(ctx, "organizeWasAll");
  if (h === "off") return t(ctx, "organizeWasOff");
  return t(ctx, "organizeWasDays", { d: Number(h.slice("days:".length)) });
}

/** First run: no organize run of ours stands in the journal (so the projects to pin are confirmed one by one). */
async function firstOrganize(ctx: Ctx): Promise<boolean> {
  return !(await ctx.d.runs()).some((r) => r.rolledBackBy === null && r.command === "organize" && (r.status === "ok" || r.status === "partial"));
}

/** The projects t3sm would pin, as a review list: the ones left unmarked (their ids) are never pinned. */
async function pinReview(ctx: Ctx, pins: OrganizeAction[], titles: Map<string, string>): Promise<string[]> {
  const items = pins.map((a): ListItem => ({
    id: a.target, label: nameOf(ctx, titles.get(a.target) ?? a.target, 60), checked: true,
    detail: t(ctx, "organizePinDetail", { n: pins.length }),
  }));
  const r = await reviewList(listTerm(ctx), { title: t(ctx, "organizePinListTitle"), help: t(ctx, "organizePinListHelp"), items, lang: ctx.lang });
  return r.confirmed ? r.items.filter((i) => !i.checked).map((i) => i.id) : [];
}

/** What organize would change, per project (before/after), and the history rule in words. */
function showPreview(ctx: Ctx, pv: OrganizePreview, rule: HistoryRule | null): void {
  const w = width(ctx);
  const pw = previewWords(ctx.ui);
  const words = { ...pw, project: glyphs(ctx, pw.project), visible: glyphs(ctx, pw.visible), settled: glyphs(ctx, pw.settled), retitled: glyphs(ctx, pw.retitled), archived: glyphs(ctx, pw.archived), more: (n: number) => glyphs(ctx, pw.more(n)) };
  const tbl = organizePreviewTable(ctx.s, ctx.f, pv.plan, words, w, { max: 8 });
  if (tbl.length === 0) return;
  blank(ctx);
  say(ctx, t(ctx, "organizePreviewHead"));
  lines(ctx, tbl);
  say(ctx, ctx.s("muted", glyphs(ctx, historyLine(ctx.ui, rule))));
}

export const organize: Step = async (ctx) => {
  if (!ctx.fullDone) { heading(ctx, 9); say(ctx, t(ctx, "organizeNeedsFull")); return NEXT; }
  let pv = await ctx.d.organizePreview(ctx.allowUntested);
  if (pv === null) return { to: "skip" };
  heading(ctx, 9);
  say(ctx, t(ctx, "organizeIntro"));
  // A 0.2 organize.history ("all", "off", "days:N") was answered before the 0.3 rule (days and a minimum per project)
  // existed: its question is asked once more, planned with the 0.3 default, saying what the user had.
  // As the user had it: "all" gets the 0.3 default (90 days, at least 10); "days:N" those days, at least 10; "off" the
  // off variant (Enter keeps it off).
  const legacy = pv.legacyHistory;
  const legacyRule: HistoryRule | null = legacy === "all" ? { ...DEFAULT_HISTORY }
    : legacy !== undefined && legacy !== "off" ? { days: Number(legacy.slice("days:".length)), minPerProject: DEFAULT_HISTORY.minPerProject } : null;
  if (legacyRule !== null) pv = (await ctx.d.organizePreview(ctx.allowUntested, legacyRule)) ?? pv;
  const histOff = legacy === "off" || (legacy === undefined && pv.off?.history === true);
  const planned: HistoryRule = legacyRule ?? pv.history ?? { ...DEFAULT_HISTORY };
  // The preview first, before any question: what each project shows today and with t3sm's defaults.
  showPreview(ctx, pv, planned);
  if (pv.plan.actions.length === 0 && legacy === undefined) { say(ctx, t(ctx, "organizeNothing")); return NEXT; }
  const of = (k: OrganizeAction["kind"]): OrganizeAction[] => pv!.plan.actions.filter((a) => a.kind === k);

  const patch: OrganizePatch = { decided: [] };
  const flags: string[] = [];
  /** "Here is what I will do": a count (aligned in one column) or words. */
  const will: [string, number | string][] = [];
  const yn = (key: string, def: "y" | "n", q: Key, help: Key, vars: Record<string, string | number>): Promise<boolean> =>
    ask(ctx, t(ctx, q, vars), { def, help: t(ctx, help) }).then((yes) => { if (key !== "") patch.decided!.push(key); return yes; });
  const part = (title: Key, say: string, extra: string[] = []): void => {
    blank(ctx);
    lines(ctx, callout(ctx.s, { kind: "info", title: t(ctx, title), body: [say, ...extra] }, width(ctx)));
  };

  // History (spec §5.2): asked whenever the rule shows or settles anything; the counts come from a preview planned with
  // the rule chosen, so "Here is what I will do" says what organize will really do.
  /** The rule organize will run with: the answer, else what config.json says (null = off). */
  let rule: HistoryRule | null = histOff ? null : planned;
  const historyAsked = legacy !== undefined || of("unsettle").length > 0 || of("settle").length > 0;
  const countsOf = (x: OrganizePreview): { shown: number; settled: number; kept: number; p: number } => {
    // A mark of a thread already shown (history step 6) shows nothing again: counted apart (`kept`), so the approval
    // screen still names every write.
    const sh = x.plan.actions.filter((a) => a.kind === "unsettle" && !isShownMark(a));
    const kp = x.plan.actions.filter((a) => isShownMark(a));
    const st = x.plan.actions.filter((a) => a.kind === "settle");
    return { shown: sh.length, settled: st.length, kept: kp.length, p: new Set([...sh, ...st].map((a) => a.projectId)).size };
  };
  /** Where the history rows end in `will`: the kept row goes there once T3 Code's option is chosen. */
  let historyEnd: number | null = null;
  if (historyAsked) {
    blank(ctx);
    rule = await askHistory(ctx, planned, histOff, countsOf(pv), legacy === undefined ? undefined : wasWords(ctx, legacy));
    patch.history = rule ?? "off";
    patch.decided!.push("history", HISTORY_V2);
    const same = rule !== null && rule.days === planned.days && rule.minPerProject === planned.minPerProject;
    if (rule !== null && !same) pv = (await ctx.d.organizePreview(ctx.allowUntested, rule)) ?? pv; // other numbers: plan them
    if (rule !== null) {
      const c = countsOf(pv);
      will.push([t(ctx, "organizeRowHistory"), ruleScope(ctx, rule)], [`  ${t(ctx, "organizeRowShown")}`, c.shown], [`  ${t(ctx, "organizeRowSettled")}`, c.settled]);
      historyEnd = will.length;
    }
  }

  const titles = of("title");
  if (titles.length > 0) {
    part("organizeTitlesTitle", t(ctx, "organizeTitlesSay", { n: titles.length }), pv.off?.titles ? [t(ctx, "organizeOffTitles", { n: titles.length })] : []);
    const yes = await yn("titles", pv.off?.titles ? "n" : "y", "organizeTitlesAsk", "organizeTitlesHelp", { n: titles.length });
    patch.titles = yes;
    if (yes) will.push([t(ctx, "organizeRowTitles"), titles.length]);
  }

  const automated = of("archive").filter((a) => a.reason === AUTOMATED_WHY);
  if (automated.length > 0) {
    part("organizeArchiveTitle", t(ctx, "organizeArchiveSay", { n: automated.length }), pv.off?.archiveAutomated ? [t(ctx, "organizeOffArchive", { n: automated.length })] : []);
    const yes = await yn("archiveAutomated", pv.off?.archiveAutomated ? "n" : "y", "organizeArchiveAsk", "organizeArchiveHelp", { n: automated.length });
    patch.archiveAutomated = yes;
    if (yes) will.push([t(ctx, "organizeRowArchive"), automated.length]);
  }

  // Conversations of projects t3sm created in temp or system folders: archived by the same command, so asked and listed too.
  const folders = of("archive").filter((a) => a.reason !== AUTOMATED_WHY);
  if (folders.length > 0) {
    part("organizeFoldersTitle", t(ctx, "organizeFoldersSay", { n: folders.length }));
    if (await yn("", "y", "organizeFoldersAsk", "organizeFoldersHelp", { n: folders.length })) will.push([t(ctx, "organizeRowFolders"), folders.length]);
    else flags.push("--no-archive-folders");
  }

  const pins = of("pin");
  if (pins.length > 0) {
    part("organizePinTitle", t(ctx, "organizePinSay", { n: pins.length }), pv.off?.pinRecent ? [t(ctx, "organizeOffPin", { n: pins.length })] : []);
    const yes = await yn("pinRecent", pv.off?.pinRecent ? "n" : "y", "organizePinAsk", "organizePinHelp", { n: pins.length });
    patch.pinRecent = { enabled: yes };
    if (yes) {
      const titlesById = new Map(pv.projects.map((x) => [x.id, x.title] as const));
      const left = (await firstOrganize(ctx)) ? await pinReview(ctx, pins, titlesById) : [];
      if (left.length > 0) flags.push("--no-pin", left.join(","));
      if (pins.length - left.length > 0) will.push([t(ctx, "organizeRowPin"), pins.length - left.length]);
    }
  }

  const del = of("project-delete");
  if (del.length > 0) {
    part("organizeDeleteTitle", t(ctx, "organizeDeleteSay", { n: del.length }));
    const yes = await yn("", "y", "organizeDeleteAsk", "organizeDeleteHelp", { n: del.length });
    if (yes) will.push([t(ctx, "organizeRowDelete"), del.length]);
    else flags.push("--no-delete");
  }

  // Separate from the parts above: T3 Code's own setting, for conversations started in T3 Code (spec §5.2). With a rule
  // of at most 90 days: let T3 Code put them away after the same days (default yes; n leaves it as it is, never off).
  // Otherwise T3 Code cannot follow: keep it, set it to 90 days, or turn it off (default keep). With the rule off: turn
  // it off? (default no). The order is safe: organize applies the history rule (unsettle, settle) before this setting.
  const days = pv.autoSettleDays;
  /** T3 Code's option as this run sets it (undefined: left as it is). */
  let t3Want: number | null | undefined;
  if (days !== undefined) {
    const current = days === null ? t(ctx, "organizeT3Off") : t(ctx, "organizeT3After", { days });
    if (rule !== null && rule.days !== "all" && rule.days <= T3_MAX_DAYS) {
      if (days !== rule.days) {
        // "Like the rule above" only when the history question was just asked; otherwise the rule is named.
        part("organizeT3Title", t(ctx, historyAsked ? "organizeT3Say" : "organizeT3SayAlone", { current, days: rule.days }));
        if (await yn("", "y", "organizeT3Ask", "organizeT3Help", { days: rule.days, current })) {
          t3Want = rule.days;
          flags.push("--auto-settle", String(rule.days));
          will.push([t(ctx, "organizeRowT3"), t(ctx, "organizeValT3", { days: rule.days, current })]);
        }
      }
    } else if (rule !== null) {
      const scope = rule.days === "all" ? t(ctx, "organizeScopeAllHistory") : t(ctx, "organizeScopeDays", { d: rule.days });
      part("organizeT3Title", t(ctx, "organizeT3KeepSay", { scope, current }));
      // undefined: keep it as it is; a number: set it to that; null: off.
      const choices: [string, number | null | undefined][] = [[t(ctx, "organizeT3ChoiceKeep", { current }), undefined]];
      if (days !== T3_MAX_DAYS) choices.push([t(ctx, "organizeT3ChoiceSet", { days: T3_MAX_DAYS }), T3_MAX_DAYS]);
      if (days !== null) choices.push([t(ctx, "organizeT3ChoiceOff"), null]);
      lines(ctx, choices.map(([label], i) => `  ${ctx.s("num", String(i + 1))}  ${label}`));
      const n = await pickNumber(ctx, t(ctx, "organizeT3ChoiceAsk", { n: choices.length }), choices.length, t(ctx, "organizeT3KeepHelp", { current }), 1);
      const want = choices[n - 1]![1];
      if (want !== undefined) {
        t3Want = want;
        flags.push("--auto-settle", want === null ? "off" : String(want));
        will.push([t(ctx, "organizeRowT3"), want === null ? t(ctx, "organizeValT3Off", { current }) : t(ctx, "organizeValT3", { days: want, current })]);
      }
    } else if (days !== null) {
      part("organizeT3Title", t(ctx, "organizeSettleSay", { days }));
      if (await yn("", "n", "organizeSettleAsk", "organizeSettleHelp", {})) {
        t3Want = null;
        flags.push("--auto-settle", "off");
        will.push([t(ctx, "organizeRowT3"), t(ctx, "organizeValT3Off", { current })]);
      }
    }
  }

  // The marks follow T3 Code's option as this run leaves it: a changed option is planned again (a dry run), so the
  // approval screen names the marks the run will write.
  if (t3Want !== undefined && t3Want !== days) pv = (await ctx.d.organizePreview(ctx.allowUntested, rule, t3Want)) ?? pv;
  const kept = countsOf(pv).kept;
  if (kept > 0 && rule !== null) {
    const row: [string, number] = [`  ${t(ctx, "organizeRowKept")}`, kept];
    if (historyEnd !== null) will.splice(historyEnd, 0, row);
    else will.unshift([t(ctx, "organizeRowHistory"), ruleScope(ctx, rule)], row);
  }

  blank(ctx);
  if (will.length === 0) {
    // The re-asked 0.2 history question answered "no rule" (kept off, or none) with nothing else chosen: the answer is
    // still saved (config.json only, like the decisions), so it is not asked again. Nothing changes in T3 Code.
    if (legacy !== undefined && rule === null) {
      await saveSettings(ctx, { history: "off", decided: ["history", HISTORY_V2] }, t(ctx, "didOrganizeSettings"), t(ctx, "undoOrganizeSettings"));
      okLine(ctx, t(ctx, "organizeHistoryOffSaved"));
      return NEXT;
    }
    say(ctx, t(ctx, "organizeNothingChosen"));
    return NEXT;
  }
  const nw = Math.max(...will.map(([, v]) => (typeof v === "number" ? num(ctx, v).length : 0)));
  const body = rows(ctx, [...will.map(([k, v]): [string, string] => [k, typeof v === "number" ? ctx.s("num", padStart(num(ctx, v), nw)) : v]),
    [t(ctx, "willUndo"), ctx.s("key", "t3sm organize --undo")]]);
  lines(ctx, box(ctx, { title: t(ctx, "willHead"), body }));
  if (!(await ask(ctx, t(ctx, "organizeApplyAsk"), { def: "n", help: t(ctx, "organizeApplyHelp") }))) { say(ctx, t(ctx, "organizeDeclined")); return NEXT; }
  await saveSettings(ctx, patch, t(ctx, "didOrganizeSettings"), t(ctx, "undoOrganizeSettings"));
  const { outcome } = await write(ctx, ["organize", "--yes", ...flags, ...ut(ctx)], t(ctx, "didOrganize"),
    { tolerate: [5], undo: (id) => (id ? t(ctx, "undoOrganize", { runId: id }) : null) });
  if (outcome.code === 5) say(ctx, t(ctx, "organizeFailed"));
  else okLine(ctx, t(ctx, "organizeOk"));
  return NEXT;
};

// ---------------- 10 keep in sync ----------------

/** `schedule install --watch` while another run holds the lock: this many tries, this far apart. */
export const SCHEDULE_TRIES = 3;
export const SCHEDULE_RETRY_MS = 5000;

export const sync: Step = async (ctx) => {
  heading(ctx, 10);
  if (!ctx.fullDone) { say(ctx, t(ctx, "syncNeedsFull")); return NEXT; }
  say(ctx, t(ctx, "syncIntro"));
  if (await ctx.d.scheduleInstalled()) { ctx.syncOn = true; okLine(ctx, t(ctx, "syncInstalled")); }
  else if (await ask(ctx, t(ctx, "syncAsk"), { def: "n", help: t(ctx, "syncHelp") })) {
    // install --watch takes the lock: a sync cycle holding it is waited for a few times before the user is told.
    let busy = true;
    for (let i = 0; i < SCHEDULE_TRIES && busy; i++) {
      if (i > 0) await (ctx.d.wait ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms))))(SCHEDULE_RETRY_MS);
      busy = (await write(ctx, ["schedule", "install", "--watch", "--yes"], t(ctx, "didSchedule"), { undo: () => t(ctx, "undoSchedule"), busyReturns: true })).busy === true;
    }
    if (busy) say(ctx, t(ctx, "syncBusy"));
    else ctx.syncOn = true;
  } else say(ctx, t(ctx, "syncSkipped"));
  blank(ctx);
  lines(ctx, callout(ctx.s, { kind: "info", title: t(ctx, "syncMergeTitle"), body: [t(ctx, "syncMerge")], command: "t3sm merge" }, width(ctx)));
  return NEXT;
};

// ---------------- 11 done ----------------

/**
 * Offers the t3sm plugin (the /t3sm commands inside T3 Code) in each configured Claude account that lacks it: what it adds,
 * how to remove it, then a y/N (default No) per account before the two `claude plugin` children run for that account.
 * An outdated one is only mentioned. A failed install is reported and never ends the assistant.
 */
async function offerPlugin(ctx: Ctx): Promise<void> {
  let rs;
  try { rs = await ctx.d.pluginAccounts(); } catch { return; } // optional extra: never in the way
  const shownRow = (r: { displayName: string; home: string }) => ({ name: accountOf(ctx, r.displayName, 80), home: nameOf(ctx, r.home, 120) });
  for (const r of rs) if (r.state.state === "outdated") say(ctx, t(ctx, "pluginOutdated", shownRow(r)));
  const missing = rs.filter((r) => r.state.state === "missing");
  if (missing.length === 0) return;
  blank(ctx);
  lines(ctx, callout(ctx.s, { kind: "info", title: t(ctx, "pluginTitle"), body: [t(ctx, "pluginIntro")], command: "claude plugin uninstall t3sm@t3code-session-manager" }, width(ctx)));
  let declined = false;
  for (const r of missing) {
    const { name, home } = shownRow(r);
    if (!(await ask(ctx, t(ctx, "pluginAsk", { name, home }), { def: "n", help: t(ctx, "pluginHelp"), back: false }))) { declined = true; continue; }
    const res = await ctx.d.installPlugin(r.id);
    if (res.ok) {
      say(ctx, t(ctx, "pluginOk", { name }));
      ctx.done.push({ what: t(ctx, "didPlugin", { name }), runId: null, undo: t(ctx, "undoPlugin", { home }) });
    } else {
      const where = t(ctx, res.step === "install" ? "stepInstall" : res.step === "claude" ? "stepClaude" : "stepMarketplace");
      // The child's output is external text: every line goes through shownText, so no escape sequence reaches the terminal.
      const output = res.output.trim().split(/\r?\n/).slice(-6).map((l) => shownText(l, 200)).join("\n").slice(0, 600);
      say(ctx, t(ctx, "pluginFailed", { name, where, output, home }));
    }
  }
  if (declined) say(ctx, t(ctx, "pluginSkipped"));
}

/** The last screen: one panel with what changed, how to undo it, and what happens next. */
function donePanel(ctx: Ctx): void {
  ctx.summaryShown = true;
  const { s } = ctx;
  const head = (k: Key): string => s("title", t(ctx, k));
  const body: BodyLine[] = [head("doneChanged")];
  body.push(...(ctx.done.length > 0 ? ctx.done.map((d) => ({ bullet: doneSym(ctx, d), text: d.runId ? t(ctx, "doneItemRun", { what: d.what, runId: d.runId }) : d.what })) : [t(ctx, "doneNothing")]));
  const undos = ctx.done.filter((d) => d.undo !== null);
  if (undos.length > 0) {
    body.push("", head("doneHowUndo"), ...undos.map((d) => ({ bullet: s("accent", s.sym.sep), text: d.undo! })));
    if (ctx.done.some((d) => d.runId !== null)) body.push(t(ctx, "doneUndo"));
  }
  body.push("", head("doneNext"));
  body.push(t(ctx, ctx.syncOn ? "doneNextSync" : ctx.fullDone ? "doneNextNoSync" : "doneNextImport"));
  body.push(...rows(ctx, [["t3sm status", t(ctx, "doneCmdStatus")], ["t3sm projects", t(ctx, "doneCmdProjects")], ["t3sm merge", t(ctx, "doneCmdMerge")], ["t3sm cloud", t(ctx, "doneCmdCloud")]]));
  if (ctx.plan) body.push("", s("muted", t(ctx, "doneReport", { path: shown(ctx, ctx.plan.planPath, Math.max(10, width(ctx) - 20)) })));
  blank(ctx);
  lines(ctx, box(ctx, { title: t(ctx, "doneTitle"), tone: ctx.worst > 0 ? "warn" : "ok", body }));
}

export const done: Step = async (ctx) => {
  heading(ctx, 11);
  await offerLanguage(ctx); // config.json may exist only since the plan step
  await offerPlugin(ctx);
  donePanel(ctx);
  say(ctx, t(ctx, "doneBye"));
  return NEXT;
};

export const STEPS: Step[] = [welcome, check, accounts, plan, decisions, cleanup, pilot, full, organize, sync, done];

/**
 * Where a returning user is, from real state only (journal runs not rolled back, config.json and a plan, the
 * scheduler); null = from the start. Questions the newest plan still has unanswered -> the decisions. The newest full
 * import decides next: ok -> organize (when no organize run followed), else sync (or the summary when sync is
 * installed); partial or interrupted -> the full import again, saying so. A pilot -> its check in T3 Code. One kind of
 * clean-up done -> the clean-up step (the other kind may still wait), both -> the pilot.
 */
export function resumePoint(s: { configExists: boolean; hasPlan: boolean; runs: RunSummary[]; scheduleInstalled: boolean; decisionsPending?: boolean }): Resume | null {
  const live = s.runs.filter((r) => r.rolledBackBy === null);
  const ok = (r: RunSummary): boolean => r.status === "ok" || r.status === "partial";
  if (s.configExists && s.hasPlan && s.decisionsPending === true) return { step: 5, what: "resumeDecisions" };
  const lastFull = live.filter((r) => /^apply \S+$/.test(r.command ?? "")).at(-1);
  if (lastFull) {
    if (lastFull.status === "ok") {
      if (s.scheduleInstalled) return { step: 11, what: "resumeFullSync" };
      const organized = live.some((r) => ok(r) && r.command === "organize");
      return { step: organized ? 10 : 9, what: "resumeFull" };
    }
    if (lastFull.status === "partial") return { step: 8, what: "resumeFullPartial", n: lastFull.counts.importFailed };
    return { step: 8, what: "resumeFullInterrupted" };
  }
  const pilotRun = live.filter((r) => ok(r) && /^apply \S+ --only$/.test(r.command ?? "")).at(-1);
  if (pilotRun) return { step: 7, what: "resumePilot", runId: pilotRun.runId };
  const q = live.some((r) => ok(r) && /^quarantine\b/.test(r.command ?? ""));
  const d = live.some((r) => ok(r) && /^dedupe\b/.test(r.command ?? ""));
  if (q && d) return { step: 7, what: "resumeCleanup" };
  if (q || d) return { step: 6, what: "resumeCleanupPart" };
  if (s.configExists && s.hasPlan) return { step: 4, what: "resumeConfig" };
  return null;
}
