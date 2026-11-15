// The guided assistant's shared types and prompt helpers. Steps never touch the world themselves: everything goes
// through AssistantDeps (reads, and t3sm's own commands for every write), so each step runs in tests with scripted
// answers and fakes.

import type { OrganizePatch } from "../core/config.ts";
import type { Config, HistoryRule, Plan } from "../core/types.ts";
import type { Check } from "../ops/doctor.ts";
import type { InstallResult, PluginState } from "../ops/plugin.ts";
import type { RunSummary } from "../ops/rollback.ts";
import type { OrganizePlan } from "../organize/types.ts";
import type { T3Project, T3Thread } from "../t3/decode.ts";
import { makeCliUi, type CliUi } from "../cli/ui.ts";
import type { Caps } from "../ui/caps.ts";
import { stepHeader } from "../ui/components.ts";
import type { Fmt } from "../ui/locale.ts";
import type { Style } from "../ui/style.ts";
import { capsOf, type Term } from "../ui/terminal.ts";
import { wrapTo } from "../ui/text.ts";
import { CATALOGUES, fmt, type Catalogue, type Key, type Lang } from "./i18n.ts";

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

/** The steps of the assistant (steps.STEPS has exactly this many); `{total}` in a message is this number. */
export const TOTAL_STEPS = 11;

/** What organize would change in T3 Code, read-only (the dry run behind `t3sm organize`), with what the preview draws. */
export interface OrganizePreview {
  plan: OrganizePlan;
  projects: T3Project[];
  threads: T3Thread[];
  /** T3 Code's auto-settle days now (null = off); undefined when T3 Code does not report it. */
  autoSettleDays?: number | null;
  /** The history rule the plan was built with (config.json's, the default when it is off there); undefined: the default. */
  history?: HistoryRule | null;
  /** Parts config.json has turned off: the plan still counts them, so the assistant can say what turning them on does. */
  off?: { history: boolean; titles: boolean; archiveAutomated: boolean; pinRecent: boolean };
}

/** One configured Claude account and whether the t3sm plugin is installed in it (read from its installed_plugins.json). */
export interface PluginRow {
  id: string;
  displayName: string;
  /** Shown with the home folder as ~. */
  home: string;
  state: PluginState;
}

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
  /** hasPlan: a complete plan (runs/<id>/plan.json) exists; decisionsPending: the newest plan still has unanswered questions. */
  config(): Promise<{ exists: boolean; language: Lang | null; hasPlan: boolean; decisionsPending?: boolean }>;
  runs(): Promise<RunSummary[]>;
  scheduleInstalled(): Promise<boolean>;
  /** Read-only: the config's (or detected) accounts against T3 Code's instances. Needs T3 Code. */
  accounts(allowUntested: boolean): Promise<AccountRow[]>;
  /** `t3sm plan` without its printout: a fresh plan (General folder in `lang`), written to runs/<id>/plan.md and plan.json. */
  plan(allowUntested: boolean, lang: Lang): Promise<PlanView>;
  /**
   * Read-only: what `t3sm organize` would change now, with T3 Code's conversations and projects; null: nothing imported
   * to organize. `rule`: plan the history with these numbers (null: the rule off) instead of config.json's.
   */
  organizePreview(allowUntested: boolean, rule?: HistoryRule | null): Promise<OrganizePreview | null>;
  /** t3sm's version and how many Claude accounts it knows (config.json's, else the detected ones), for the app header. */
  about(): Promise<{ version: string; accounts: number }>;
  /** Read-only: the configured Claude accounts and the t3sm plugin in each. No child process, no network. */
  pluginAccounts(): Promise<PluginRow[]>;
  /**
   * Installs the plugin in one account (by id): two `claude plugin` children with that account's CLAUDE_CONFIG_DIR, and
   * only theirs. The only place the assistant touches the network; called only after the user's yes.
   */
  installPlugin(accountId: string): Promise<InstallResult>;
  /** Dry-run counts of `t3sm quarantine` and `t3sm dedupe` (nothing moved). */
  cleanupCounts(plan: Plan): Promise<{ backupFolders: number; mirrorCopies: number }>;
  /** config.json "language", under the lock; false when another run holds it (nothing written). */
  saveLanguage(lang: Lang): Promise<boolean>;
  /** config.json "organize" (the decisions and organize choices), under the lock; false when another run holds it (nothing written). */
  saveOrganize(patch: OrganizePatch): Promise<boolean>;
  /**
   * The one terminal: the review lists read their lines from it, and (without a TTY) the assistant's own prompts must too,
   * so piped answers are never split between two readers.
   */
  term: Term;
  /** Runs one t3sm command (argv without "t3sm"); every write the assistant makes goes through here. */
  run(argv: string[]): Promise<RunOutcome>;
  /** Waits `ms` (a step that retries while another run holds the lock); default a real timer. */
  wait?(ms: number): Promise<void>;
}

export interface Ctx {
  d: AssistantDeps;
  lang: Lang;
  m: Catalogue;
  color: boolean;
  /** The UI kit in the assistant's language and the terminal's capabilities (style, symbols, locale formatting). */
  ui: CliUi;
  s: Style;
  f: Fmt;
  /** --lang was given on the command line (the welcome offers to save it). */
  langFromFlag: boolean;
  /** The language t3sm uses without --lang and without config.json "language" (T3SM_LANG, then the system's). */
  defaultLang: Lang;
  /** Kept for compatibility; never set now (untested T3 Code versions only warn). */
  allowUntested: boolean;
  plan: PlanView | null;
  /** Writes made in this session, for the summary: what, the run it journaled, how to undo it. */
  /** What this session wrote; `partial`: it ended with failures (drawn with the warning symbol, never the success one). */
  done: { what: string; runId: string | null; undo: string | null; partial?: boolean }[];
  /** Worst non-fatal exit code so far (5: some sessions failed). */
  worst: number;
  resume: Resume | null;
  /** Set by the welcome when the user continues where they were; consumed by the check step. */
  jumpTo: number | null;
  /** The pilot run to check in T3 Code first (resuming after a pilot); consumed by the pilot step. */
  pilotVerify: string | null;
  fullDone: boolean;
  /** Background sync is installed (seen or installed in this session): the last screen says what happens next. */
  syncOn: boolean;
  /** The --lang save offer was made (once per session). */
  langOffered: boolean;
  /** "What this session did" was printed. */
  summaryShown: boolean;
  /** The step the decisions gate was called from; the decisions step goes back there when it ends. */
  returnTo: number | null;
  /** Decision keys asked in this session (saved or not): the gate does not send the user back for them again. */
  asked: Set<string>;
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

export interface CtxOptions {
  lang: Lang; color: boolean; langFromFlag: boolean; defaultLang?: Lang;
  /** The terminal's capabilities (default: the term's own); `color` false turns colour off either way. */
  caps?: Caps;
  /** The clock for relative dates ("2 h ago"); default Date.now. */
  now?: () => number;
}

export function newCtx(d: AssistantDeps, o: CtxOptions): Ctx {
  const base = o.caps ?? capsOf(d.term);
  const caps: Caps = { ...base, color: o.color ? (base.color === 0 ? 1 : base.color) : 0 };
  const ui = makeCliUi(caps, o.lang, o.now ?? Date.now);
  return {
    d, lang: o.lang, m: CATALOGUES[o.lang], color: caps.color > 0, ui, s: ui.s, f: ui.f, langFromFlag: o.langFromFlag,
    defaultLang: o.defaultLang ?? "en", allowUntested: false, plan: null, done: [], worst: 0, resume: null, jumpTo: null, pilotVerify: null,
    fullDone: false, syncOn: false, langOffered: false, summaryShown: false, returnTo: null, asked: new Set(),
  };
}

/**
 * The assistant's own glyphs as ASCII, for a console without Unicode: · « » “ ” ‘ ’ – — • … →. Only ever applied to
 * catalogue text (before its placeholders are filled) and to the kit's words; never to a name, a folder or anything
 * else that came from the user's data, which is shown as it is.
 */
export function asciiText(s: string): string {
  return s.replace(/·/g, "-").replace(/[«»“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/•/g, "*")
    .replace(/…/g, "...").replace(/→/g, "->");
}

/** The assistant's own text (a catalogue template, a kit word) as this terminal can show it. Never for data. */
export function glyphs(ctx: Ctx, s: string): string {
  return ctx.s.caps.unicode ? s : asciiText(s);
}

/** A catalogue message: its template's glyphs folded for the terminal, then its placeholders filled (data untouched). */
export function t(ctx: Ctx, key: Key, vars: Record<string, string | number> = {}): string {
  return fmt(glyphs(ctx, ctx.m[key]), { total: TOTAL_STEPS, ...vars });
}

/** The columns the assistant lays out for: the terminal's width, at most 80 (read each time: the window can be resized). */
export function width(ctx: Ctx): number {
  return Math.max(1, Math.min(80, Math.floor(ctx.d.term.columns) || 80));
}

/** Prints text wrapped to the terminal's width (at most 80 columns). */
export function say(ctx: Ctx, text: string): void {
  ctx.d.print(wrapTo(text, width(ctx)).join("\n") + "\n");
}

/** Prints lines already laid out (components). */
export function lines(ctx: Ctx, ls: string[]): void {
  if (ls.length === 0) return;
  ctx.d.print(ls.join("\n") + "\n");
}

export function blank(ctx: Ctx): void {
  ctx.d.print("\n");
}

/** The step header: the rail of the 11 steps (every step before this one marked as behind) and "Step 3 of 11 · Accounts". */
export function heading(ctx: Ctx, n: number): void {
  const done = Array.from({ length: n - 1 }, (_, i) => i + 1);
  blank(ctx);
  lines(ctx, stepHeader(ctx.s, { n, total: TOTAL_STEPS, title: t(ctx, `title${n}` as Key), done, word: { step: t(ctx, "stepWord"), of: t(ctx, "ofWord") } }, width(ctx)));
}

/** The question's wrapped lines: all but the last are printed, the last one is the prompt itself. */
async function rawAsk(ctx: Ctx, question: string): Promise<string> {
  // Room for the answer on the prompt line; a no-break space (ask) keeps the choices with the last word.
  const ls = wrapTo(question, Math.max(1, width(ctx) - 4)).map((l) => l.replaceAll(NBSP, " "));
  if (ls.length > 1) ctx.d.print(ls.slice(0, -1).join("\n") + "\n");
  let a: string;
  try { a = await ctx.d.prompt(ls.at(-1)! + " "); } catch { throw new Quit(); }
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
/** In Portuguese v (voltar) goes back too; b still does. */
const BACK_PT = new Set(["v"]);

/** The answer keys shown after a yes/no question: yes, no, back (the default in capitals). */
const KEYS: Record<Lang, { yes: string; no: string; back: string }> = { en: { yes: "y", no: "n", back: "b" }, pt: { yes: "s", no: "n", back: "v" } };

/**
 * A yes/no question with `[Y/n/?/b/q]` in English and `[S/n/?/v/q]` in Portuguese (the default in capitals; b / v only
 * when going back is offered). `?` prints the longer explanation and asks again. Returns true for yes (y, yes; in
 * Portuguese also s, sim); q throws Quit, b (in Portuguese also v, voltar) throws Back. Write questions default to no.
 */
export async function ask(ctx: Ctx, question: string, o: { def: "y" | "n"; help: string; back?: boolean }): Promise<boolean> {
  const back = o.back !== false;
  const k = KEYS[ctx.lang];
  const keys = `[${o.def === "y" ? `${k.yes.toUpperCase()}/${k.no}` : `${k.yes}/${k.no.toUpperCase()}`}/?${back ? `/${k.back}` : ""}/q]`;
  for (;;) {
    const a = (await rawAsk(ctx, `${question}${NBSP}${keys}`)).toLowerCase();
    if (a === "") return o.def === "y";
    if (YES.has(a) || (ctx.lang === "pt" && YES_PT.has(a))) return true;
    if (NO.has(a) || (ctx.lang === "pt" && NO_PT.has(a))) return false;
    if (QUIT.has(a)) throw new Quit();
    if (back && (BACK.has(a) || (ctx.lang === "pt" && BACK_PT.has(a)))) throw new Back();
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
