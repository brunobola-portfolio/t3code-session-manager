// The nine steps of the guided assistant. Each step explains itself, says what will happen, then asks. A step never
// writes by itself: every write is one of t3sm's own commands, run through ctx.d.run only after an explicit "y" in
// the question right before it (write questions default to No). The one exception, saving the assistant's language,
// is config.json only and goes through ctx.d.saveLanguage (under the lock), also after a "y".

import type { Check } from "../ops/doctor.ts";
import { isGlob, normalizeFolder, projectRows, type ProjectRow } from "../ops/projects.ts";
import { SKIP_REASONS, summarize } from "../plan/report.ts";
import { sameCwd, tildePath } from "../core/paths.ts";
import type { RunSummary } from "../ops/rollback.ts";
import { Quit, Stop, ask, askText, blank, heading, say, t, type AccountRow, type Ctx, type PlanView, type Resume, type RunOutcome } from "./core.ts";
import type { Key } from "./i18n.ts";
import { LOCK_BUSY_LINE } from "../cli/locked.ts";
import { NOTHING_TO_CHANGE } from "../cli/commands/projects.ts";

export type StepResult = { to: "next" } | { to: "skip" } | { to: "goto"; step: number };
export type Step = (ctx: Ctx) => Promise<StepResult>;

const NEXT: StepResult = { to: "next" };
const PAGE = 15;
const YES_WORDS = new Set(["y", "yes", "s", "sim"]);
const NO_WORDS = new Set(["n", "no", "não", "nao"]);

/** Named colours offered for an account (catalogue key, #RRGGBB). */
export const PALETTE: [Key, string][] = [
  ["colorBlue", "#2563EB"], ["colorGreen", "#16A34A"], ["colorOrange", "#EA580C"],
  ["colorPurple", "#7C3AED"], ["colorRed", "#DC2626"], ["colorTeal", "#0D9488"],
];

const ut = (ctx: Ctx): string[] => (ctx.allowUntested ? ["--allow-untested"] : []);

/** A folder for the screen: ~ for the home folder, shortened from the left to `max` columns. */
function shown(ctx: Ctx, folder: string, max = 40): string {
  const s = tildePath(folder, ctx.d.home);
  return s.length <= max ? s : "..." + s.slice(s.length - (max - 3));
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
    case "accounts": return command === null;
    default: return false;
  }
}

/**
 * Runs a writing t3sm command (after the user's "y") and records it for the summary with the run id it journaled and
 * how to undo it. A command that found the lock taken (exit 0 with the lock-busy signal, or its line) did nothing:
 * nothing is recorded, the assistant ends (exit 0). Exit 0 goes on; `tolerate` codes (5: some items failed) go on and
 * are remembered; 130 (Ctrl+C) and any other code end the assistant with that code.
 */
async function write(ctx: Ctx, argv: string[], what: string, o: { tolerate?: number[]; undo?: Undo } = {}): Promise<{ outcome: RunOutcome; runId: string | null }> {
  await guardLock(ctx);
  const before = new Set((await ctx.d.runs()).map((r) => r.runId));
  const outcome = await ctx.d.run(argv);
  if (outcome.code === 0 && (outcome.locked === true || outcome.output.includes(LOCK_BUSY_LINE))) {
    say(ctx, t(ctx, "lockedRace"));
    throw new Stop(0);
  }
  const fresh: RunSummary[] = (await ctx.d.runs()).filter((r) => !before.has(r.runId) && ownsRun(argv, r.command));
  const runId = fresh.at(-1)?.runId ?? null;
  const record = (): void => void ctx.done.push({ what, runId, undo: o.undo ? o.undo(runId) : null });
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
  say(ctx, t(ctx, key));
  ctx.plan = await ctx.d.plan(ctx.allowUntested);
  return ctx.plan;
}

const rowsOf = (p: PlanView): ProjectRow[] => projectRows(p.plan, p.names, null, p.config);

/** "What this session did": each write, its run id and how to undo it. Shown once (the summary step, or any exit). */
export function summary(ctx: Ctx): void {
  ctx.summaryShown = true;
  if (ctx.done.length === 0) { say(ctx, t(ctx, "doneNothing")); return; }
  blank(ctx);
  say(ctx, t(ctx, "doneHead"));
  for (const d of ctx.done) {
    say(ctx, d.runId ? t(ctx, "doneItemRun", { what: d.what, runId: d.runId }) : t(ctx, "doneItem", { what: d.what }));
    if (d.undo) say(ctx, t(ctx, "doneUndoLine", { undo: d.undo }));
  }
  if (ctx.done.some((d) => d.runId !== null)) say(ctx, t(ctx, "doneUndo"));
}

/** `--lang` given and config.json exists (now or since the plan): offers once to save the language there. */
async function offerLanguage(ctx: Ctx): Promise<void> {
  if (ctx.langOffered || !ctx.langFromFlag) return;
  const cfg = await ctx.d.config();
  if (!cfg.exists) return;
  ctx.langOffered = true;
  if ((cfg.language ?? "en") === ctx.lang) return;
  if (!(await ask(ctx, t(ctx, "saveLangAsk"), { def: "n", help: t(ctx, "saveLangHelp"), back: false }))) return;
  await guardLock(ctx);
  if (!(await ctx.d.saveLanguage(ctx.lang))) { say(ctx, t(ctx, "lockedRace")); throw new Stop(0); }
  ctx.done.push({ what: t(ctx, "didLanguage"), runId: null, undo: t(ctx, "undoLanguage") });
  say(ctx, t(ctx, "langSaved"));
}

// ---------------- 1 welcome ----------------

export const welcome: Step = async (ctx) => {
  heading(ctx, 1);
  say(ctx, t(ctx, "welcomeBody"));
  if (ctx.lang === "pt") say(ctx, t(ctx, "outputEnglish"));
  say(ctx, t(ctx, "langSwitch"));
  blank(ctx);
  if (!(await ask(ctx, t(ctx, "welcomeAsk"), { def: "y", help: t(ctx, "welcomeHelp"), back: false }))) throw new Quit();
  await offerLanguage(ctx);
  ctx.jumpTo = null;
  ctx.pilotVerify = null;
  const r = ctx.resume;
  if (r) {
    const what = t(ctx, r.what, { n: r.n ?? 0 });
    say(ctx, t(ctx, "resumeSay", { what, n: r.step, title: ctx.m[`title${r.step}` as Key] }));
    if (await ask(ctx, t(ctx, "resumeAsk"), { def: "y", help: t(ctx, "resumeHelp"), back: false })) {
      ctx.jumpTo = r.step;
      ctx.pilotVerify = r.runId ?? null;
    }
  }
  return NEXT;
};

// ---------------- 2 check ----------------

const T3_DOWN = new Set(["t3-runtime", "t3-reachable"]);
/** Warnings a later step deals with: said in plain words instead of the doctor's command. */
const HANDLED: Record<string, Key> = { "backups-present": "checkLater5", instances: "checkLater3", "instance-unpinned": "checkLaterImport" };

function listChecks(ctx: Ctx, cs: Check[]): void {
  for (const c of cs) {
    say(ctx, `- ${c.message}`);
    const later = Object.hasOwn(HANDLED, c.id) ? HANDLED[c.id]! : null;
    if (later) say(ctx, `  ${t(ctx, later)}`);
    else if (c.fix) say(ctx, `  ${t(ctx, "checkFix", { fix: c.fix })}`);
  }
}

export const check: Step = async (ctx) => {
  heading(ctx, 2);
  say(ctx, t(ctx, "checkIntro"));
  let ids: string[] = [];
  for (;;) {
    say(ctx, t(ctx, "checkRunning"));
    const checks = await ctx.d.doctor();
    if (checks.some((c) => c.status === "fail" && T3_DOWN.has(c.id))) {
      say(ctx, t(ctx, "t3Down"));
      if (await ask(ctx, t(ctx, "t3DownAsk"), { def: "y", help: t(ctx, "t3DownHelp") })) continue;
      throw new Quit();
    }
    const untested = checks.find((c) => c.status === "fail" && c.id === "t3-version");
    const fails = checks.filter((c) => c.status === "fail" && c !== untested);
    const warns = checks.filter((c) => c.status === "warn");
    ids = [...fails, ...warns].map((c) => c.id);
    if (fails.length > 0) {
      say(ctx, t(ctx, "checkFailIntro"));
      listChecks(ctx, fails);
      say(ctx, t(ctx, "checkFailStop"));
      throw new Stop(1);
    }
    const near = checks.find((c) => c.id === "t3-version" && c.status === "ok" && /same minor/.test(c.message));
    if (near) say(ctx, t(ctx, "checkSameMinor", { version: near.message.split(" ")[0]! }));
    if (warns.length > 0) { say(ctx, t(ctx, "checkWarnIntro")); listChecks(ctx, warns); }
    else if (!untested) say(ctx, t(ctx, "checkAllOk"));
    if (untested && !ctx.allowUntested) {
      say(ctx, t(ctx, "untestedSay", { message: untested.message }));
      if (!(await ask(ctx, t(ctx, "untestedAsk"), { def: "n", help: t(ctx, "untestedHelp") }))) {
        say(ctx, t(ctx, "untestedNo"));
        throw new Stop(0);
      }
      ctx.allowUntested = true;
    }
    break;
  }
  if (ctx.jumpTo !== null) {
    const step = ctx.jumpTo;
    ctx.jumpTo = null;
    ctx.fullDone = step >= 8;
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

async function pickNumber(ctx: Ctx, question: string, max: number, help: string): Promise<number> {
  for (;;) {
    const a = await askText(ctx, question, { help });
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
      case "shell-profile": return r.alias ? t(ctx, "via_shell", { alias: r.alias }) : t(ctx, "via_shellNoAlias");
      case "vscode-pin": return t(ctx, "via_vscode");
      case "env": return t(ctx, "via_env");
      case "t3-instance": return t(ctx, "via_t3");
      case "config": return t(ctx, "via_config");
      default: return s;
    }
  };
  return [...new Set(r.foundVia.map(word))].join(", ");
}

export const accounts: Step = async (ctx) => {
  heading(ctx, 3);
  say(ctx, t(ctx, "accIntro"));
  let rows = await ctx.d.accounts(ctx.allowUntested);
  if (rows.length === 0) { say(ctx, t(ctx, "accNone")); throw new Stop(0); }
  const show = (): void => {
    blank(ctx);
    rows.forEach((r, i) => {
      say(ctx, t(ctx, "accRow", { n: i + 1, name: r.displayName, id: r.id }));
      const detail = t(ctx, "accDetail", { home: r.home, email: r.email ?? t(ctx, "accNoEmail"), via: foundFrom(ctx, r) });
      say(ctx, `   ${detail}${r.hasInstance ? "" : ` · ${t(ctx, "accNoInstance")}`}`);
    });
    blank(ctx);
  };
  show();
  const missing = rows.filter((r) => !r.hasInstance);
  if (missing.length > 0) {
    say(ctx, t(ctx, "accMissing", { ids: missing.map((r) => r.id).join(", ") }));
    if (await ask(ctx, t(ctx, "accCreateAsk"), { def: "n", help: t(ctx, "accCreateHelp") })) {
      await ensureConfig(ctx);
      await write(ctx, ["accounts", "--apply", "--yes", ...ut(ctx)], t(ctx, "didInstances"), { undo: () => t(ctx, "undoInstances") });
      rows = await ctx.d.accounts(ctx.allowUntested);
      show();
    }
  }
  if (await ask(ctx, t(ctx, "accNamesAsk"), { def: "y", help: t(ctx, "accNamesHelp") })) return NEXT;
  for (;;) {
    const r = rows[(await pickNumber(ctx, t(ctx, "accPick"), rows.length, t(ctx, "accNamesHelp"))) - 1]!;
    if (!r.hasInstance) say(ctx, t(ctx, "accRenameNoInstance", { id: r.id }));
    else {
      const name = (await askText(ctx, t(ctx, "accNameAsk", { id: r.id, name: r.displayName }), { help: t(ctx, "accNamesHelp") })) || r.displayName;
      const color = await pickColor(ctx);
      const q = t(ctx, "accRenameAsk", { id: r.id, name, color: color ? t(ctx, "accRenameColor", { color: color.label }) : "" });
      if (await ask(ctx, q, { def: "n", help: t(ctx, "accRenameHelp") })) {
        await ensureConfig(ctx);
        await write(ctx, ["accounts", "--rename", r.id, name, ...(color ? ["--color", color.hex] : []), ...ut(ctx)], t(ctx, "didRename", { id: r.id, name }),
          { undo: (id) => (id ? t(ctx, "undoRename", { runId: id }) : null) });
        rows = rows.map((x) => (x.id === r.id ? { ...x, displayName: name } : x));
      }
    }
    if (!(await ask(ctx, t(ctx, "accMore"), { def: "n", help: t(ctx, "accNamesHelp") }))) return NEXT;
  }
};

// ---------------- 4 plan ----------------

function showSummary(ctx: Ctx, p: PlanView): void {
  const sum = summarize(p.plan);
  const imp = sum.byAction["import"] ?? 0;
  const conv = sum.byAction["convert-import"] ?? 0;
  const rows: [string, number][] = [
    [t(ctx, "planImport"), imp], [t(ctx, "planConvert"), conv], [t(ctx, "planSkip"), sum.byAction["skip"] ?? 0],
    [t(ctx, "planNewProjects"), p.plan.projectsToCreate.length], [t(ctx, "planNewInstances"), p.plan.instancesToCreate.length],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  const vw = Math.max(...rows.map((r) => String(r[1]).length));
  blank(ctx);
  say(ctx, t(ctx, "planHead"));
  for (const [k, v] of rows) say(ctx, `  ${k.padEnd(w)}  ${String(v).padStart(vw)}`);
  const by = Object.entries(sum.byInstance).sort((a, b) => b[1] - a[1]);
  if (by.length > 0) {
    say(ctx, t(ctx, "planByAccount"));
    const nw = Math.min(40, Math.max(...by.map(([id]) => (p.names[id] ?? id).length)));
    const bw = Math.max(...by.map(([, n]) => String(n).length));
    for (const [id, n] of by) say(ctx, `  ${(p.names[id] ?? id).slice(0, nw).padEnd(nw)}  ${String(n).padStart(bw)}`);
  }
  if (conv > 0) say(ctx, t(ctx, "planConvertNote"));
  const top = SKIP_REASONS.filter((r) => sum.byReason[r] > 0).sort((a, b) => sum.byReason[b] - sum.byReason[a]).slice(0, 3);
  if (top.length > 0) say(ctx, t(ctx, "planTopSkips", { reasons: top.map((r) => `${ctx.m[`skip_${r}` as Key] ?? r} (${sum.byReason[r]})`).join(", ") }));
  if (imp + conv === 0) say(ctx, t(ctx, "planNothing"));
  say(ctx, t(ctx, "planReport", { path: p.planPath }));
}

/** Changes a project's account through `t3sm projects set` (the route, and the T3 Code default when it exists). */
async function changeAccount(ctx: Ctx, row: ProjectRow): Promise<boolean> {
  const p = ctx.plan!;
  const folder = shown(ctx, row.folder, 60);
  say(ctx, t(ctx, "planAccountFor", { folder }));
  p.config.accounts.forEach((a, i) => say(ctx, `  ${i + 1}. ${a.displayName} (${a.id})`));
  const acct = p.config.accounts[(await pickNumber(ctx, t(ctx, "planAccountAsk"), p.config.accounts.length, t(ctx, "planPageHelp"))) - 1]!;
  // The undo puts back what config.json had: the folder's own route (its account), or no route at all.
  const full = tildePath(row.folder, ctx.d.home);
  const own = p.config.routes.find((r) => !isGlob(r.match) && sameCwd(r.match, row.folder))?.account ?? null;
  const undoRoute = own ? t(ctx, "undoRouteBack", { folder: full, account: own }) : t(ctx, "undoRoute", { folder: full });
  if (!(await ask(ctx, t(ctx, "planRouteAsk", { folder, name: acct.displayName, undo: undoRoute }), { def: "n", help: t(ctx, "planRouteHelp") }))) return false;
  const { outcome } = await write(ctx, ["projects", "set", row.folder, acct.id, "--yes", ...ut(ctx)], t(ctx, "didRoute", { folder, name: acct.displayName }),
    { undo: (id) => undoRoute + (id ? t(ctx, "undoT3Default", { runId: id }) : "") });
  if (outcome.output.includes(NOTHING_TO_CHANGE)) { ctx.done.pop(); return false; } // nothing was written
  await buildPlan(ctx, "planRouteSaved");
  return true;
}

export const plan: Step = async (ctx) => {
  heading(ctx, 4);
  say(ctx, t(ctx, "planIntro"));
  let p = await buildPlan(ctx);
  showSummary(ctx, p);
  for (let start = 0; ;) {
    const rows = rowsOf(p);
    if (rows.length === 0) return NEXT;
    if (start === 0) { blank(ctx); say(ctx, t(ctx, "planTableIntro")); say(ctx, t(ctx, "planWhyLegend")); }
    const page = rows.slice(start, start + PAGE);
    const nW = String(rows.length).length;
    const fW = Math.min(40, Math.max(ctx.m.colProject.length, ...page.map((r) => shown(ctx, r.folder).length)));
    const aW = Math.min(22, Math.max(ctx.m.colAccount.length, ...page.map((r) => r.accountName.length)));
    blank(ctx);
    say(ctx, `  ${"#".padStart(nW)}  ${ctx.m.colProject.padEnd(fW)}  ${ctx.m.colAccount.padEnd(aW)}  ${ctx.m.colWhy}`);
    page.forEach((r, i) => say(ctx, `  ${String(start + i + 1).padStart(nW)}  ${shown(ctx, r.folder).padEnd(fW)}  ${r.accountName.slice(0, aW).padEnd(aW)}  ${ctx.m[`reason_${r.reason}` as Key]}`));
    const last = start + PAGE >= rows.length;
    say(ctx, t(ctx, "planPage", { from: start + 1, to: start + page.length, total: rows.length }));
    const a = (await askText(ctx, t(ctx, last ? "planLastAsk" : "planMoreAsk"), { help: t(ctx, "planPageHelp") })).toLowerCase();
    // c, y and n (no change) all continue; Enter turns the page, or continues on the last one.
    if (a === "c" || YES_WORDS.has(a) || NO_WORDS.has(a) || (a === "" && last)) return NEXT;
    if (a === "") { start += PAGE; continue; }
    const n = /^\d+$/.test(a) ? Number(a) : NaN;
    if (!(n >= 1 && n <= rows.length)) { say(ctx, t(ctx, "badNumber")); continue; }
    if (await changeAccount(ctx, rows[n - 1]!)) { p = ctx.plan!; showSummary(ctx, p); start = 0; }
  }
};

// ---------------- 5 clean-up ----------------

export const cleanup: Step = async (ctx) => {
  const p = ctx.plan ?? (await buildPlan(ctx));
  const c = await ctx.d.cleanupCounts(p.plan);
  if (c.backupFolders === 0 && c.mirrorCopies === 0) return { to: "skip" };
  heading(ctx, 5);
  say(ctx, t(ctx, "cleanIntro"));
  if (c.backupFolders > 0) say(ctx, t(ctx, "cleanBackups", { n: c.backupFolders }));
  if (c.mirrorCopies > 0) say(ctx, t(ctx, "cleanMirrors", { n: c.mirrorCopies }));
  say(ctx, t(ctx, "cleanReversible"));
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

// ---------------- 6 pilot ----------------

/** Asks whether the pilot looks right; on no, offers to undo that run, then stops with the next steps. */
async function verifyPilot(ctx: Ctx, runId: string): Promise<StepResult> {
  if (await ask(ctx, t(ctx, "pilotOkAsk"), { def: "y", help: t(ctx, "pilotOkHelp"), back: false })) return NEXT;
  if (await ask(ctx, t(ctx, "pilotUndoAsk", { runId }), { def: "n", help: t(ctx, "pilotUndoHelp", { runId }), back: false })) {
    await write(ctx, ["rollback", "--run", runId, "--yes", "--archive-threads", ...ut(ctx)], t(ctx, "didUndo"), { tolerate: [5] });
  }
  say(ctx, t(ctx, "pilotStopped"));
  throw new Stop(0);
}

export const pilot: Step = async (ctx) => {
  heading(ctx, 6);
  if (ctx.pilotVerify) {
    // Back after a pilot (the user stopped at "Does it look right?" last time): check it before anything else.
    const runId = ctx.pilotVerify;
    ctx.pilotVerify = null;
    say(ctx, t(ctx, "pilotCheckAgain", { runId }));
    return verifyPilot(ctx, runId);
  }
  const p = ctx.plan ?? (await buildPlan(ctx));
  const all = rowsOf(p).filter((r) => r.pending > 0);
  if (all.length === 0) { say(ctx, t(ctx, "pilotNone")); return NEXT; }
  const sugg = all.filter((r) => !r.held).sort((a, b) => a.pending - b.pending || a.folder.localeCompare(b.folder)).slice(0, 5);
  say(ctx, t(ctx, "pilotIntro"));
  if (sugg.length > 0) {
    say(ctx, t(ctx, "pilotSuggest"));
    sugg.forEach((r, i) => say(ctx, `  ${t(ctx, "pilotRow", { n: i + 1, folder: shown(ctx, r.folder), count: r.pending, name: r.accountName })}`));
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
  say(ctx, t(ctx, "pilotDry", { folder }));
  const dry = await ctx.d.run(["apply", "--dry-run", "--only", chosen.folder, ...ut(ctx)]);
  if (dry.code !== 0) { say(ctx, t(ctx, dry.code === 130 ? "stepInterrupted" : "stepFailed", { code: dry.code })); throw new Stop(dry.code); }
  if (!(await ask(ctx, t(ctx, "pilotApplyAsk", { folder }), { def: "n", help: t(ctx, "pilotApplyHelp") }))) { say(ctx, t(ctx, "pilotSkipped")); return NEXT; }
  const { runId } = await write(ctx, ["apply", "--yes", "--only", chosen.folder, ...ut(ctx)], t(ctx, "didPilot", { folder }),
    { tolerate: [5], undo: (id) => (id ? t(ctx, "undoImport", { runId: id }) : null) });
  if (runId === null) { say(ctx, t(ctx, "pilotNoRun")); return NEXT; }
  blank(ctx);
  say(ctx, t(ctx, "pilotCheck", { folder, name: chosen.accountName }));
  return verifyPilot(ctx, runId);
};

// ---------------- 7 full import ----------------

export const full: Step = async (ctx) => {
  heading(ctx, 7);
  say(ctx, t(ctx, "fullIntro"));
  say(ctx, t(ctx, "fullChecklist"));
  const p = await buildPlan(ctx, "fullRefreshing");
  const rows = rowsOf(p).filter((r) => r.pending > 0);
  if (rows.length === 0) { say(ctx, t(ctx, "fullNothing")); ctx.fullDone = true; return NEXT; }
  say(ctx, t(ctx, "fullCounts", { n: rows.reduce((s, r) => s + r.pending, 0), p: rows.length }));
  const held = rows.filter((r) => r.held).length;
  if (held > 0) say(ctx, t(ctx, "fullHeldNow", { n: held }));
  if (!(await ask(ctx, t(ctx, "fullAsk"), { def: "n", help: t(ctx, "fullHelp") }))) { say(ctx, t(ctx, "fullDeclined")); return { to: "goto", step: 9 }; }
  const { outcome } = await write(ctx, ["apply", "--yes", ...ut(ctx)], t(ctx, "didFull"),
    { tolerate: [5], undo: (id) => (id ? t(ctx, "undoImport", { runId: id }) : null) });
  if (outcome.code === 5) say(ctx, t(ctx, "fullFailed"));
  if (/Held \(a session is in use\)/.test(outcome.output)) say(ctx, t(ctx, "fullHeld"));
  if (outcome.code === 0) say(ctx, t(ctx, "fullOk"));
  ctx.fullDone = true;
  return NEXT;
};

// ---------------- 8 keep in sync ----------------

export const sync: Step = async (ctx) => {
  heading(ctx, 8);
  if (!ctx.fullDone) { say(ctx, t(ctx, "syncNeedsFull")); return NEXT; }
  say(ctx, t(ctx, "syncIntro"));
  if (await ctx.d.scheduleInstalled()) say(ctx, t(ctx, "syncInstalled"));
  else if (await ask(ctx, t(ctx, "syncAsk"), { def: "n", help: t(ctx, "syncHelp") })) {
    await write(ctx, ["schedule", "install", "--watch"], t(ctx, "didSchedule"), { undo: () => t(ctx, "undoSchedule") });
  } else say(ctx, t(ctx, "syncSkipped"));
  say(ctx, t(ctx, "syncMerge"));
  return NEXT;
};

// ---------------- 9 done ----------------

export const done: Step = async (ctx) => {
  heading(ctx, 9);
  await offerLanguage(ctx); // config.json may exist only since the plan step
  summary(ctx);
  if (ctx.plan) say(ctx, t(ctx, "doneReport", { path: ctx.plan.planPath }));
  blank(ctx);
  say(ctx, t(ctx, "doneRemember"));
  say(ctx, t(ctx, "doneBye"));
  return NEXT;
};

export const STEPS: Step[] = [welcome, check, accounts, plan, cleanup, pilot, full, sync, done];

/**
 * Where a returning user is, from real state only (journal runs not rolled back, config.json and a plan, the
 * scheduler); null = from the start. The newest full import decides: ok -> sync (or the summary when sync is
 * installed); partial or interrupted -> the full import again, saying so. A pilot -> its check in T3 Code. One kind of
 * clean-up done -> the clean-up step (the other kind may still wait), both -> the pilot.
 */
export function resumePoint(s: { configExists: boolean; hasPlan: boolean; runs: RunSummary[]; scheduleInstalled: boolean }): Resume | null {
  const live = s.runs.filter((r) => r.rolledBackBy === null);
  const ok = (r: RunSummary): boolean => r.status === "ok" || r.status === "partial";
  const lastFull = live.filter((r) => /^apply \S+$/.test(r.command ?? "")).at(-1);
  if (lastFull) {
    if (lastFull.status === "ok") return s.scheduleInstalled ? { step: 9, what: "resumeFullSync" } : { step: 8, what: "resumeFull" };
    if (lastFull.status === "partial") return { step: 7, what: "resumeFullPartial", n: lastFull.counts.importFailed };
    return { step: 7, what: "resumeFullInterrupted" };
  }
  const pilotRun = live.filter((r) => ok(r) && /^apply \S+ --only$/.test(r.command ?? "")).at(-1);
  if (pilotRun) return { step: 6, what: "resumePilot", runId: pilotRun.runId };
  const q = live.some((r) => ok(r) && /^quarantine\b/.test(r.command ?? ""));
  const d = live.some((r) => ok(r) && /^dedupe\b/.test(r.command ?? ""));
  if (q && d) return { step: 6, what: "resumeCleanup" };
  if (q || d) return { step: 5, what: "resumeCleanupPart" };
  if (s.configExists && s.hasPlan) return { step: 4, what: "resumeConfig" };
  return null;
}
