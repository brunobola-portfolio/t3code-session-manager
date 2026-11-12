// The guided assistant's shared types and prompt helpers. Steps never touch the world themselves: everything goes
// through AssistantDeps (reads, and t3sm's own commands for every write), so each step runs in tests with scripted
// answers and fakes.

import type { Config, Plan } from "../core/types.ts";
import type { Check } from "../ops/doctor.ts";
import type { RunSummary } from "../ops/rollback.ts";
import { CATALOGUES, fmt, wrap, type Catalogue, type Key, type Lang } from "./i18n.ts";

export interface AccountRow {
  id: string;
  displayName: string;
  /** Masked (b***@example.com), or null when unknown / signed out. */
  email: string | null;
  /** Shown with the home folder as ~. */
  home: string;
  /** Discovery sources (default, folder, shell-profile, vscode-pin, env, t3-instance, config); the step words them. */
  foundVia: string[];
  /** The shell alias that names the account, when one was found. */
  alias: string | null;
  hasInstance: boolean;
}

/** Where a returning user continues (steps.resumePoint). n: failures of the last full import; runId: the pilot's run. */
export interface Resume { step: number; what: Key; n?: number; runId?: string }

export interface PlanView { plan: Plan; names: Record<string, string>; planPath: string; config: Config }

/**
 * A t3sm command run by the assistant: its exit code, what it printed (also shown to the user as it ran) and whether it
 * found the lock taken and did nothing (Io.onLockBusy).
 */
export interface RunOutcome { code: number; output: string; locked?: boolean }

export interface AssistantDeps {
  /** The user's home folder (paths are shown relative to it, as ~). */
  home: string;
  print(s: string): void;
  /** One answer line. A rejected promise (input closed) counts as quit; "\u0003" is Ctrl+C at the prompt. */
  prompt(q: string): Promise<string>;
  /** The live process holding t3sm's lock, or null. */
  lockHolder(): Promise<{ pid: number } | null>;
  doctor(): Promise<Check[]>;
  /** hasPlan: a complete plan (runs/<id>/plan.json) exists. */
  config(): Promise<{ exists: boolean; language: Lang | null; hasPlan: boolean }>;
  runs(): Promise<RunSummary[]>;
  scheduleInstalled(): Promise<boolean>;
  /** Read-only: the config's (or detected) accounts against T3 Code's instances. Needs T3 Code. */
  accounts(allowUntested: boolean): Promise<AccountRow[]>;
  /** `t3sm plan` without its printout: a fresh plan, written to runs/<id>/plan.md and plan.json. */
  plan(allowUntested: boolean): Promise<PlanView>;
  /** Dry-run counts of `t3sm quarantine` and `t3sm dedupe` (nothing moved). */
  cleanupCounts(plan: Plan): Promise<{ backupFolders: number; mirrorCopies: number }>;
  /** config.json "language", under the lock; false when another run holds it (nothing written). */
  saveLanguage(lang: Lang): Promise<boolean>;
  /** Runs one t3sm command (argv without "t3sm"); every write the assistant makes goes through here. */
  run(argv: string[]): Promise<RunOutcome>;
}

export interface Ctx {
  d: AssistantDeps;
  lang: Lang;
  m: Catalogue;
  color: boolean;
  /** --lang was given on the command line (the welcome offers to save it). */
  langFromFlag: boolean;
  allowUntested: boolean;
  plan: PlanView | null;
  /** Writes made in this session, for the summary: what, the run it journaled, how to undo it. */
  done: { what: string; runId: string | null; undo: string | null }[];
  /** Worst non-fatal exit code so far (5: some sessions failed). */
  worst: number;
  resume: Resume | null;
  /** Set by the welcome when the user continues where they were; consumed by the check step. */
  jumpTo: number | null;
  /** The pilot run to check in T3 Code first (resuming after a pilot); consumed by the pilot step. */
  pilotVerify: string | null;
  fullDone: boolean;
  /** The --lang save offer was made (once per session). */
  langOffered: boolean;
  /** "What this session did" was printed. */
  summaryShown: boolean;
}

/** q, Ctrl+C or closed input at a prompt. */
export class Quit extends Error { override name = "Quit"; }
/** b at a prompt that allows it. */
export class Back extends Error { override name = "Back"; }
/** The assistant ends here with this exit code (it has already said why). */
export class Stop extends Error {
  override name = "Stop";
  readonly code: number;
  constructor(code: number) { super(`stop ${code}`); this.code = code; }
}

export function newCtx(d: AssistantDeps, o: { lang: Lang; color: boolean; langFromFlag: boolean }): Ctx {
  return { d, lang: o.lang, m: CATALOGUES[o.lang], color: o.color, langFromFlag: o.langFromFlag, allowUntested: false, plan: null, done: [], worst: 0, resume: null, jumpTo: null, pilotVerify: null, fullDone: false, langOffered: false, summaryShown: false };
}

export function t(ctx: Ctx, key: Key, vars: Record<string, string | number> = {}): string {
  return fmt(ctx.m[key], vars);
}

/** Prints text wrapped to 80 columns. */
export function say(ctx: Ctx, text: string): void {
  ctx.d.print(wrap(text).join("\n") + "\n");
}

export function blank(ctx: Ctx): void {
  ctx.d.print("\n");
}

export function heading(ctx: Ctx, n: number): void {
  const title = t(ctx, "stepTitle", { n, title: ctx.m[`title${n}` as Key] });
  ctx.d.print(`\n${ctx.color ? `\x1b[1m${title}\x1b[0m` : title}\n`);
}

/** The question's wrapped lines: all but the last are printed, the last one is the prompt itself. */
async function rawAsk(ctx: Ctx, question: string): Promise<string> {
  // Room for the answer on the prompt line; a no-break space (ask) keeps the choices with the last word.
  const lines = wrap(question, 76).map((l) => l.replaceAll(NBSP, " "));
  if (lines.length > 1) ctx.d.print(lines.slice(0, -1).join("\n") + "\n");
  let a: string;
  try { a = await ctx.d.prompt(lines.at(-1)! + " "); } catch { throw new Quit(); }
  if (a.includes("\u0003")) throw new Quit();
  return a.trim();
}

/** Joins the last word of a question to its choices so a wrap never leaves "[y/N/?/b/q]" alone on the prompt line. */
const NBSP = " ";

const YES = new Set(["y", "yes"]);
const NO = new Set(["n", "no"]);
const YES_PT = new Set(["s", "sim"]);
const NO_PT = new Set(["nao", "não"]);
const QUIT = new Set(["q", "quit", "sair", "exit"]);
const BACK = new Set(["b", "back", "voltar"]);

/**
 * A yes/no question with `[Y/n/?/b/q]` (the default in capitals; b only when going back is offered). `?` prints the
 * longer explanation and asks again. Returns true for yes; q throws Quit, b throws Back. Write questions default to no.
 */
export async function ask(ctx: Ctx, question: string, o: { def: "y" | "n"; help: string; back?: boolean }): Promise<boolean> {
  const back = o.back !== false;
  const keys = `[${o.def === "y" ? "Y/n" : "y/N"}/?${back ? "/b" : ""}/q]`;
  for (;;) {
    const a = (await rawAsk(ctx, `${question}${NBSP}${keys}`)).toLowerCase();
    if (a === "") return o.def === "y";
    if (YES.has(a) || (ctx.lang === "pt" && YES_PT.has(a))) return true;
    if (NO.has(a) || (ctx.lang === "pt" && NO_PT.has(a))) return false;
    if (QUIT.has(a)) throw new Quit();
    if (back && BACK.has(a)) throw new Back();
    if (a === "?") { say(ctx, o.help); continue; }
    say(ctx, t(ctx, back ? "invalidYN" : "invalidYNNoBack"));
  }
}

/** A free answer (a number, a name, a path). q quits, b goes back (when offered), ? explains. Returns it trimmed. */
export async function askText(ctx: Ctx, question: string, o: { help: string; back?: boolean }): Promise<string> {
  const back = o.back !== false;
  for (;;) {
    const a = await rawAsk(ctx, question);
    const l = a.toLowerCase();
    if (QUIT.has(l)) throw new Quit();
    if (back && BACK.has(l)) throw new Back();
    if (a === "?") { say(ctx, o.help); continue; }
    return a;
  }
}
