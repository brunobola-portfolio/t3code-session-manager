// t3sm organize: tidy the history t3sm imported into T3 Code (spec §5) and undo it.
//   organize [--dry-run | --yes] [--only <folder>] [--history <days|all|off>] [--min <n>] [--auto-settle <days|off>]
//            [--no-delete] [--no-pin <ids>] [--no-archive-folders] [--allow-untested] [--plain]
//   organize --undo [<run>] [--dry-run | --yes] [--allow-untested]
// On a terminal (and without --plain) the confirmation also offers "d = details": the planned changes as an interactive
// review list (src/ui/list.ts), grouped by kind; an unchecked change is dropped from the plan before it is applied
// (ruling R3). Without a terminal, or with --plain, the output and the question stay as they were.
// --dry-run reads T3 Code and the transcripts and writes nothing (no lock, no journal, no discovery cache). Without
// --yes or --dry-run on a non-terminal: refuse (exit 2) before contacting T3 Code. Otherwise: lock ->
// recoverPendingMtimes -> connect -> plan -> summary -> confirm -> applyOrganize (journaled; undone by --undo or
// `t3sm rollback`). Organize runs on any T3 Code version with one warning (ruling R18): T3 is connected with
// allowUntested and organizeGate gives the warning.
// --history / --min override config.json's organize.history for this run only (same ranges: days 1..3650, all or off;
// minimum 0..1000). --auto-settle <1..90|off> sets T3 Code's own sidebarAutoSettleAfterDays (journaled, undone by --undo).
// --ai-titles (or organize.aiTitles.enabled; --no-ai-titles turns it off for one run) asks T3 Code to write, with its own
// text model and the user's provider tokens, the titles that stay technical: at most --ai-titles-max (default
// organize.aiTitles.maxPerRun, 50) per run, most recent first; the summary says how many, the model and the cap. Only
// this command plans them: sync and the guided assistant never do (src/organize/apply.ts refuses them without
// allowAiTitles).

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, HistoryConfig, HistoryRule, JournalEntry } from "../../core/types.ts";
import { expandHome, normalizeCwd, pathKey, sameCwd, stateDir, tildePath } from "../../core/paths.ts";
import { readSyncStatus } from "../../ops/syncStatus.ts";
import { latestPlan, readPlan } from "./apply.ts";
import type { Lang } from "../../assistant/i18n.ts";
import { AI_TITLES_MAX, ConfigError, DEFAULT_HISTORY, defaultConfig, loadConfig, normalizeHistory, organizeSettings } from "../../core/config.ts";
import { Journal, newRunId, recoverPendingMtimes } from "../../core/journal.ts";
import { acquireLock } from "../../core/lock.ts";
import { resolveAccounts } from "../../ops/discoverAccounts.ts";
import { normalizeFolder } from "../../ops/projects.ts";
import { AI_TITLE_WAIT_MS, applyOrganize, assertOrganizeOnly, undoOrganize, type UndoOrganizeResult } from "../../organize/apply.ts";
import { STOP_SIGNALS, type SignalSource } from "../../apply/apply.ts";
import { AUTO_SETTLE_TARGET, buildOrganizePlan } from "../../organize/plan.ts";
import { SHOWN_NO_OVERRIDE, isShownMark } from "../../organize/history.ts";
import { matchSessions } from "../../organize/sessions.ts";
import { proposeTitle } from "../../organize/titles.ts";
import type { OrganizeAction, OrganizeKind, OrganizePlan } from "../../organize/types.ts";
import { classifyFolder, type FolderEnv } from "../../plan/folders.ts";
import { shownText } from "../../plan/names.ts";
import { allAdapters } from "../../sources/registry.ts";
import type { SourceAdapter } from "../../sources/types.ts";
import { reviewList, type ListItem } from "../../ui/list.ts";
import { nodeTerm, type Term } from "../../ui/terminal.ts";
import { connectT3, type T3Api, type T3Project, type T3Thread } from "../../t3/api.ts";
import { organizeGate } from "../../t3/compat.ts";
import { reportLockBusy } from "../locked.ts";
import { FLAG_SPECS } from "../flags.ts";
import type { Io } from "../main.ts";
import { cliT, cliUi, confirm, confirmOrDetails, ioTerm, langOf, type CliKey, type CliUi, unknownOption, usageLine } from "../ui.ts";
import { fitLine, flowAtoms, noteLines, sectionLines, textLines } from "../screen.ts";
import { table as uiTable } from "../../ui/components.ts";
import { organizePreviewTable, type OrganizePreviewWords } from "../../ui/organizePreview.ts";
import { progressBar } from "../../ui/progress.ts";
import { discoverAll, makeEnv } from "./scan.ts";

/** writeSettings: the session may change T3 Code's own settings (settings:write), only for a run that changes one. */
export type ConnectFn = (home: string, opts: { allowUntested: boolean; manageProviders: boolean; writeSettings?: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;

export interface OrganizeDeps {
  home?: string;
  now?: () => number;
  connect?: ConnectFn;
  /** Source adapters (only the Claude one is used: transcripts of imported threads). */
  adapters?: SourceAdapter[];
  /** How project folders are classified (temp, system, ...); default: this machine. */
  folderEnv?: FolderEnv;
  /** The terminal of the interactive review list (default: this process's). */
  term?: Term;
  /** How folders compare (case, separators); default: this machine. */
  platform?: NodeJS.Platform;
  /** Ctrl+C, a kill and the terminal closing (default: this process's): the run stops after the current change. */
  signals?: SignalSource;
  /** How the run waits between two reads while T3 Code writes titles (`--ai-titles`; default a timer). */
  sleep?: (ms: number) => Promise<void>;
}

const processSignals: SignalSource = {
  on: (sig, fn) => void process.on(sig as NodeJS.Signals, fn),
  off: (sig, fn) => void process.off(sig as NodeJS.Signals, fn),
};

/** Same sentence as `apply`. */
const TITLE_MAX = 80;
/** Commands whose runs `organize --undo` picks by itself (an unattended sync is only undone when named). */
const OWN_COMMANDS: ReadonlySet<string> = new Set(["organize", "projects rename"]);

const fmt = (n: number): string => n.toLocaleString("en-US");

/** Each line once per command, on stderr. */
export function noticeOnce(io: Io): (l: string) => void {
  const seen = new Set<string>();
  return (l) => {
    if (seen.has(l)) return;
    seen.add(l);
    io.stderr(`${l}\n`);
  };
}

/**
 * Connects for organize work (ruling R18): the connection's own version gate is passed (allowUntested) and its notice
 * dropped; organizeGate then gives the one warning (none with --allow-untested). Notices after connecting (a failed
 * revoke at close) still show.
 */
export async function connectForOrganize(connect: ConnectFn, home: string, allowUntested: boolean, onNotice: (l: string) => void, writeSettings = false): Promise<T3Api> {
  let connecting = true;
  let api: T3Api;
  try {
    api = await connect(home, { allowUntested: true, manageProviders: false, ...(writeSettings ? { writeSettings } : {}), onNotice: (l) => { if (!connecting) onNotice(l); } });
  } finally {
    connecting = false;
  }
  organizeGate(api.version, { allowUntested, onNotice });
  return api;
}

/** What a plan is built for (the guided assistant passes the same, read-only). */
export interface BuildOptions {
  /** Only this folder's conversations (no pins, no deletes). */
  only: string | null;
  /** Only these thread ids (no pins, no deletes): what an unattended sync organizes, the threads it has just imported. */
  onlyThreads?: ReadonlySet<string>;
  /**
   * Which threads the history rule may move: "same" (default) the ones archive and title may change (onlyThreads, --only,
   * or every one); "projects" every thread of the projects of onlyThreads (sync, right after an import); "all" every
   * project (sync's daily pass). Only `import:*` threads ever move.
   */
  historyScope?: "same" | "projects" | "all";
  /** organize.history for this run only (`--history`, `--min`): "off", or the days and / or the minimum to use. */
  history?: "off" | { days?: number | "all"; min?: number };
  /** Writes nothing, not even the discovery cache. */
  dryRun: boolean;
  /** Also plan this change of T3 Code's own auto-settle (days 1..90, null = off); undefined leaves it alone. */
  autoSettle?: number | null;
  /** No project deletes. */
  noDelete?: boolean;
  /** Project ids that are never pinned. */
  noPin?: ReadonlySet<string>;
  /** Do not archive the conversations of t3sm's projects in temp / system folders (`--no-archive-folders`). */
  noArchiveFolders?: boolean;
  /** Plan every part as if on (history, titles, archive automated, pins), whatever config.json says: the assistant offers them. */
  offerAll?: boolean;
  /**
   * Ask T3 Code to write the titles that stay technical, at most `max` (`t3sm organize --ai-titles`). Never set from
   * config.json here: only the organize command resolves organize.aiTitles; sync and the assistant leave it out.
   */
  aiTitles?: { max: number };
}

interface Parsed extends BuildOptions {
  yes: boolean; allowUntested: boolean; plain: boolean; undo: string | null | undefined;
  /** --ai-titles (true) or --no-ai-titles (false); undefined: organize.aiTitles.enabled decides. */
  aiFlag?: boolean;
  /** --ai-titles-max. */
  aiMax?: number;
}

const ORGANIZE_FLAGS = new Set<string>([...FLAG_SPECS.organize.bool, ...FLAG_SPECS.organize.valued]);
const HISTORY_BAD = "--history takes a number of days from 1 to 3650, all or off. Run `t3sm organize --help`.\n";
const MIN_BAD = "--min takes a number from 0 to 1000 (conversations shown per project at least). Run `t3sm organize --help`.\n";
const AUTO_SETTLE_BAD = "--auto-settle takes a number of days from 1 to 90, or off (T3 Code accepts nothing else). Run `t3sm organize --help`.\n";

/** A whole number in lo..hi written with digits only; null otherwise. */
function intArg(v: string | undefined, lo: number, hi: number): number | null {
  if (v === undefined || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= lo && n <= hi ? n : null;
}

/** `t3sm organize` arguments (exported for the test that every printed undo command parses). */
export function parseOrganizeArgs(args: string[], io: Io): Parsed | null {
  const p: Parsed = { dryRun: false, yes: false, allowUntested: false, plain: false, undo: undefined, only: null, noDelete: false, noPin: new Set() };
  let days: number | "all" | "off" | undefined;
  let min: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // Only the options src/cli/flags.ts lists (what --help documents and a test checks); each is handled below.
    if (!ORGANIZE_FLAGS.has(a)) { unknownOption(io, a, "organize"); return null; }
    if (a === "--dry-run") p.dryRun = true;
    else if (a === "--yes") p.yes = true;
    else if (a === "--allow-untested") p.allowUntested = true;
    else if (a === "--plain") p.plain = true;
    else if (a === "--undo") {
      const v = args[i + 1];
      if (v !== undefined && !v.startsWith("--")) { p.undo = v; i++; } else p.undo = null;
    } else if (a === "--only") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) { usageLine(io, "common.needsValue", { option: "--only", help: "t3sm organize --help" }); return null; }
      p.only = v;
      i++;
    } else if (a === "--auto-settle") {
      const v = args[i + 1];
      const n = intArg(v, 1, 90);
      if (v !== "off" && n === null) { io.stderr(AUTO_SETTLE_BAD); return null; }
      p.autoSettle = v === "off" ? null : n;
      i++;
    } else if (a === "--history") {
      const v = args[i + 1]?.toLowerCase();
      const n = intArg(v, 1, 3650);
      if (v !== "all" && v !== "off" && n === null) { io.stderr(HISTORY_BAD); return null; }
      days = v === "all" || v === "off" ? v : n!;
      i++;
    } else if (a === "--min") {
      const n = intArg(args[i + 1], 0, 1000);
      if (n === null) { io.stderr(MIN_BAD); return null; }
      min = n;
      i++;
    } else if (a === "--ai-titles" || a === "--no-ai-titles") {
      const on = a === "--ai-titles";
      if (p.aiFlag !== undefined && p.aiFlag !== on) { usageLine(io, "usage.aiTitlesBoth"); return null; }
      p.aiFlag = on;
    } else if (a === "--ai-titles-max") {
      const n = intArg(args[i + 1], 1, AI_TITLES_MAX);
      if (n === null) { usageLine(io, "usage.aiTitlesMaxBad", { max: AI_TITLES_MAX }); return null; }
      p.aiMax = n;
      i++;
    } else if (a === "--no-delete") p.noDelete = true;
    else if (a === "--no-archive-folders") p.noArchiveFolders = true;
    else if (a === "--no-pin") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) { usageLine(io, "usage.noPinValue"); return null; }
      for (const id of v.split(",")) if (id.trim() !== "") (p.noPin as Set<string>).add(id.trim());
      i++;
    } else { unknownOption(io, a, "organize"); return null; }
  }
  if (p.dryRun && p.yes) { usageLine(io, "common.eitherDryRunOrYes"); return null; }
  if (p.undo !== undefined && p.only !== null) { usageLine(io, "usage.onlyNotUndo"); return null; }
  if (p.aiFlag === false && p.aiMax !== undefined) { usageLine(io, "usage.aiTitlesMaxOff"); return null; }
  if (p.undo !== undefined && (p.autoSettle !== undefined || days !== undefined || min !== undefined || p.noDelete === true || p.noPin!.size > 0 || p.noArchiveFolders === true
    || p.aiFlag !== undefined || p.aiMax !== undefined)) {
    usageLine(io, "usage.notWithUndo");
    return null;
  }
  if (days === "off" && min !== undefined) { usageLine(io, "usage.minHistoryOff"); return null; }
  if (days === "off") p.history = "off";
  else if (days !== undefined || min !== undefined) p.history = { ...(days !== undefined ? { days } : {}), ...(min !== undefined ? { min } : {}) };
  return p;
}

export async function organizeCommand(args: string[], io: Io, deps: OrganizeDeps = {}): Promise<number> {
  const p = parseOrganizeArgs(args, io);
  if (!p) return 2;
  if (!p.yes && !p.dryRun && !io.isTTY) { usageLine(io, "common.needsYesT3"); return 2; }
  try {
    return p.undo !== undefined ? await undo(p, p.undo, io, deps) : await organize(p, io, deps);
  } catch (e) {
    if (e instanceof ConfigError) { io.stderr(`${e.message}\n`); return 2; }
    throw e;
  }
}

// ---------------- organize ----------------

export interface Built {
  plan: OrganizePlan; missing: number; names: Names;
  /** What T3 Code held when the plan was built (the guided assistant draws its preview from these). */
  threads: T3Thread[]; projects: T3Project[];
  /** T3 Code's auto-settle days now (null = off); undefined when T3 Code does not report it. */
  autoSettleDays: number | null | undefined;
  /** The history rule the plan was built with (null = off): config.json's, an override's, or with `offerAll` the default when off. */
  history: HistoryRule | null;
  /** Parts config.json has turned off (only with `offerAll`, which planned them anyway). */
  off: { history: boolean; titles: boolean; archiveAutomated: boolean; pinRecent: boolean };
  /**
   * The model T3 Code writes titles with (settings.textGenerationModelSelection), read only when titles written by T3
   * Code are asked for; null: not set or not reported (the summary says "T3 Code's text model").
   */
  textModel: string | null;
}

/** Reads T3 Code and the transcripts (writes nothing with `dryRun`) and plans the changes of `config.organize`. */
export async function buildOrganize(api: T3Api, j: Journal, config: Config, p: BuildOptions, io: Io, deps: OrganizeDeps, home: string, now: () => number): Promise<Built> {
  const platform = deps.platform ?? process.platform;
  const [threads, projects, instances, journal] = [await api.listThreads(), await api.listProjects(), await api.providerInstances(), await j.readAll()];
  const saved = organizeSettings(config, langOf(io, config.language));
  const off = { history: normalizeHistory(saved.history) === null, titles: !saved.titles, archiveAutomated: !saved.archiveAutomated, pinRecent: !saved.pinRecent.enabled };
  const offered = p.offerAll !== true ? saved : {
    ...saved, history: off.history ? { ...DEFAULT_HISTORY } : saved.history, titles: true, archiveAutomated: true, pinRecent: { ...saved.pinRecent, enabled: true },
  };
  const settings = { ...offered, history: overrideHistory(offered.history, p.history) };

  let onlyThreads: Set<string> | undefined;
  if (p.only !== null) {
    const folder = normalizeFolder(p.only, platform, home);
    const project = projects.find((x) => sameCwd(x.workspaceRoot, folder, platform));
    if (!project) throw new ConfigError(`${folder} is not a T3 Code project. Run \`t3sm projects\` to list them.`);
    onlyThreads = new Set(threads.filter((t) => t.projectId === project.id).map((t) => t.id));
  } else if (p.onlyThreads !== undefined) {
    onlyThreads = new Set(p.onlyThreads);
  }

  // The threads the history rule may move, when that is not the same set as archive and title (sync).
  let historyThreads: Set<string> | undefined;
  if (onlyThreads !== undefined && p.historyScope === "all") historyThreads = new Set(threads.filter((t) => t.id.startsWith("import:")).map((t) => t.id));
  else if (onlyThreads !== undefined && p.historyScope === "projects") {
    const touched = new Set(threads.filter((t) => onlyThreads!.has(t.id)).map((t) => t.projectId));
    historyThreads = new Set(threads.filter((t) => t.id.startsWith("import:") && touched.has(t.projectId)).map((t) => t.id));
  }

  const claude = (deps.adapters ?? allAdapters()).filter((a) => a.id === "claude");
  // A dry run writes nothing, not even the discovery cache.
  const found = await discoverAll(claude, { ...makeEnv(io, home, config, now), readOnly: p.dryRun });
  const match = (only: (t: T3Thread) => boolean, titles: boolean) => matchSessions({
    threads: threads.filter(only), instances, accounts: config.accounts, userHome: home, discovered: found.sessions, journal,
    title: titles ? (file) => proposeTitle(file, { maxLength: TITLE_MAX }) : null, platform,
  });
  const { sessions, missing } = await match((t) => onlyThreads === undefined || onlyThreads.has(t.id), settings.titles);
  // History-only threads: their origin (an automated one never moves), never a title.
  if (historyThreads !== undefined) {
    for (const [id, s] of (await match((t) => historyThreads!.has(t.id) && !sessions.has(t.id), false)).sessions) sessions.set(id, s);
  }

  const t3Base = normalizeCwd(expandHome("~/.t3", home), platform);
  const folderEnv: FolderEnv = deps.folderEnv ?? { platform, home, tmpdir: tmpdir(), env: io.env, t3BaseDir: t3Base, t3WorktreesDir: `${t3Base}/worktrees` };
  const projectCategory = new Map(projects.map((x) => [x.id, classifyFolder(x.workspaceRoot, folderEnv)] as const));

  let autoSettleDays: number | null | undefined;
  try { autoSettleDays = await api.getServerSetting(AUTO_SETTLE_TARGET); } catch (e) {
    autoSettleDays = undefined; // not reported, or a value this t3sm does not know: the setting is left alone
    if (p.autoSettle !== undefined) io.stderr(`${shownError(e)}: --auto-settle ${p.autoSettle === null ? "off" : p.autoSettle} is skipped.\n`);
  }

  const keepProjects = await waitingProjects(stateDir(io.env, home), projects, threads, platform);
  const built = buildOrganizePlan({
    runId: newRunId(new Date(now())), threads, projects, journal, config: settings, sessions, now: now(), projectCategory, keepProjects,
    archiveFolders: p.noArchiveFolders !== true,
    // --only: that project's conversations; pins and deletes span every project, so they wait for a full organize.
    scope: onlyThreads
      ? { onlyThreads, ...(historyThreads ? { historyThreads } : {}), allowPins: false, allowDeletes: false }
      : { allowPins: true, allowDeletes: p.noDelete !== true },
    ...(p.autoSettle !== undefined && autoSettleDays !== undefined ? { autoSettle: { want: p.autoSettle, current: autoSettleDays } } : {}),
    ...(autoSettleDays !== undefined ? { t3AutoSettleDays: autoSettleDays } : {}),
    ...(p.aiTitles !== undefined ? { aiTitles: p.aiTitles } : {}),
  });
  const skipPin = p.noPin ?? new Set<string>();
  const plan = skipPin.size === 0 ? built : keepChecked(built, built.actions.map((a, i): ListItem => ({ id: String(i), label: "", detail: "", checked: !(a.kind === "pin" && skipPin.has(a.target)) })));
  // The model is named when T3 Code reports it (server.getConfig, read only for this); otherwise "T3 Code's text model".
  let textModel: string | null = null;
  if (plan.counts["ai-title"] > 0) textModel = (await api.getConfig()).settings.textGenerationModelSelection?.model ?? null;
  return { plan, missing, names: namesOf(threads, projects, home), threads, projects, autoSettleDays, history: normalizeHistory(settings.history), off, textModel };
}

/** organize.history with a run's override (`--history`, `--min`) applied; `--min` alone keeps the configured days (90 when off). */
export function overrideHistory(saved: HistoryConfig, o: BuildOptions["history"]): HistoryConfig {
  if (o === undefined) return saved;
  if (o === "off") return "off";
  const base = normalizeHistory(saved) ?? DEFAULT_HISTORY;
  return { days: o.days ?? base.days, minPerProject: o.min ?? base.minPerProject };
}

/**
 * Projects with sessions still waiting to import, which this organize never deletes: the roots of the latest plan's
 * imports T3 Code does not hold yet (a root held because a conversation was in use gets its project created empty and
 * is imported later), and the projects `sync-status.json` lists as held (by the name T3 Code shows). A missing or
 * unreadable file counts as none.
 */
async function waitingProjects(dir: string, projects: T3Project[], threads: T3Thread[], platform: NodeJS.Platform): Promise<Set<string>> {
  const inT3 = new Set(threads.map((t) => t.id));
  const roots = new Set<string>();
  try {
    const file = await latestPlan(dir);
    if (file !== null) {
      for (const i of (await readPlan(file)).items) {
        if (i.action.kind !== "skip" && !inT3.has(i.action.expectedThreadId)) roots.add(pathKey(i.action.projectRoot, platform));
      }
    }
  } catch { /* no usable plan: nothing known to be waiting */ }
  const held = new Set((await readSyncStatus(dir).catch(() => null))?.held.map((h) => h.project) ?? []);
  return new Set(projects.filter((p) => held.has(p.title) || roots.has(pathKey(p.workspaceRoot, platform))).map((p) => p.id));
}

// ---------------- names ----------------

/**
 * How conversations, projects and folders are named in the output: their T3 Code titles, never ids. Every name is
 * untrusted text (from a transcript or T3 Code): shownText strips control characters, so no escape reaches the
 * terminal.
 */
/** How a change names what it is about, in `lang`: a conversation ("'Fix the login form' (demo)"), a project, a folder. */
export interface Names { lang: Lang; thread(id: string): string; project(id: string): string; folder(path: string): string }

const TITLE_SHOWN = 60;
const quoted = (t: string): string => `'${shownText(t, TITLE_SHOWN)}'`;
/** Error texts and notes (they quote T3 Code's replies): one safe line. */
const ERROR_SHOWN = 200;
const shownError = (e: unknown): string => shownText(e, ERROR_SHOWN);

/**
 * Why a change failed, for the screen: T3 Code's refusal for a missing permission (an EnvironmentAuthorizationError, a
 * session without the scope the change needs) in plain words; any other error as T3 Code or t3sm worded it.
 */
export function failureWords(error: string, lang: "en" | "pt"): string {
  if (/EnvironmentAuthorizationError|missing required scope/i.test(error)) return cliT(lang, "organize.why.noPermission");
  return shownError(error);
}

export function namesOf(threads: T3Thread[], projects: T3Project[], home: string, lang: Lang = "en"): Names {
  const p = new Map(projects.map((x) => [x.id, x.title] as const));
  const t = new Map(threads.map((x) => [x.id, x] as const));
  return {
    lang,
    project: (id) => (p.has(id) ? cliT(lang, "organize.name.project", { title: quoted(p.get(id)!) }) : cliT(lang, "organize.name.projectGone")),
    thread: (id) => {
      const x = t.get(id);
      if (!x) return cliT(lang, "organize.name.threadGone");
      const pt = p.get(x.projectId);
      return `${quoted(x.title)}${pt !== undefined ? ` (${shownText(pt, TITLE_SHOWN)})` : ""}`;
    },
    folder: (path) => shownText(tildePath(path, home), 120),
  };
}

const days = (x: unknown, lang: Lang): string => (x === null ? cliT(lang, "organize.off") : cliT(lang, "organize.days", { n: Number(x) }));
const str = (x: unknown): string => (typeof x === "string" ? x : JSON.stringify(x));

/** One planned change, in words ("Archive 'Fix the login form' (demo)"), in the language of `n`. */
export function actionLine(a: { kind: OrganizeKind; target: string; next: unknown; previous?: unknown }, n: Names): string {
  const t = (k: CliKey, v: Record<string, string | number> = {}): string => cliT(n.lang, k, v);
  switch (a.kind) {
    case "archive": return t("organize.act.archive", { thread: n.thread(a.target) });
    case "title": return t("organize.act.title", { thread: n.thread(a.target), title: quoted(str(a.next)) });
    case "ai-title": return t("organize.act.aiTitle", { thread: n.thread(a.target) });
    case "unsettle": return t(a.previous === SHOWN_NO_OVERRIDE ? "organize.act.keep" : "organize.act.show", { thread: n.thread(a.target) });
    case "settle": return t("organize.act.settle", { thread: n.thread(a.target) });
    case "pin": return t("organize.act.pin", { project: n.project(a.target) });
    case "unpin": return t("organize.act.unpin", { project: n.project(a.target) });
    case "project-delete": return t("organize.act.delete", { project: n.project(a.target) });
    case "project-title": return t("organize.act.rename", { project: n.project(a.target), title: quoted(str(a.next)) });
    case "auto-settle": return t("organize.act.autoSettle", { days: days(a.next, n.lang) });
  }
}

/** What undoing one journaled change does, in words ("Unarchive 'Fix the login form' (demo)"), in the language of `n`. */
export function revertLine(e: { kind: OrganizeKind; target: string; previous: unknown; next: unknown }, n: Names): string {
  const t = (k: CliKey, v: Record<string, string | number> = {}): string => cliT(n.lang, k, v);
  switch (e.kind) {
    case "archive": return t(e.next === true ? "organize.rev.unarchive" : "organize.rev.archive", { thread: n.thread(e.target) });
    case "title": case "ai-title": return t("organize.rev.title", { thread: n.thread(e.target), title: quoted(str(e.previous)) });
    case "unsettle": return t(e.next === "active" ? "organize.rev.putAway" : "organize.rev.show", { thread: n.thread(e.target) });
    case "settle": return t("organize.rev.showInside", { thread: n.thread(e.target) });
    case "pin": case "unpin": return t(e.next === true ? "organize.rev.unpin" : "organize.rev.pin", { project: n.project(e.target) });
    case "project-delete": {
      const prev = e.previous as { title?: unknown; workspaceRoot?: unknown } | null;
      const folder = typeof prev?.workspaceRoot === "string" ? ` (${n.folder(prev.workspaceRoot)})` : "";
      return typeof prev?.title === "string" ? t("organize.rev.recreate", { title: quoted(prev.title), folder }) : t("organize.rev.recreateUntitled", { folder });
    }
    case "project-title": return t("organize.rev.rename", { project: n.project(e.target), title: quoted(str(e.previous)) });
    case "auto-settle": return t("organize.rev.autoSettle", { days: days(e.previous, n.lang) });
  }
}

/** What an undo item is about, without the change ("'Fix the login form' (demo)", "project 'demo'"). */
function subjectOf(e: { kind: OrganizeKind; target: string; previous: unknown }, n: Names): string {
  if (e.kind === "archive" || e.kind === "title" || e.kind === "ai-title" || e.kind === "unsettle" || e.kind === "settle") return n.thread(e.target);
  if (e.kind === "auto-settle") return cliT(n.lang, "organize.name.autoSettle");
  if (e.kind === "project-delete") {
    const prev = e.previous as { title?: unknown } | null;
    return typeof prev?.title === "string" ? cliT(n.lang, "organize.name.project", { title: quoted(prev.title) }) : cliT(n.lang, "organize.name.projectDeleted");
  }
  return n.project(e.target);
}

/** Groups `xs` by `key`, counted, most frequent first (ties: first seen). */
function tally(xs: OrganizeAction[], key: (a: OrganizeAction) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const a of xs) m.set(key(a), (m.get(key(a)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** The archive reasons as the review list names them ("automated conversation"). */
const ARCHIVE_NOUN: Record<string, CliKey> = {
  "automated session (Agent SDK)": "organize.why.automatedNoun", "temp folder": "organize.why.tempNoun", "system folder": "organize.why.systemNoun",
};

/**
 * How the summary is told: its language (English by default), the dash before the undo hint ("-" without Unicode), and
 * whether each line ends with the undo hint (default true; the screen says it once, under the lines).
 */
export interface OrganizeSummaryOptions {
  lang?: Lang; dash?: string; undo?: boolean;
  /** The model T3 Code writes titles with, named on the ai-title line when known (Built.textModel). */
  textModel?: string | null;
}

const ARCHIVE_WORDS: Record<string, CliKey> = {
  "automated session (Agent SDK)": "organize.why.automated", "temp folder": "organize.why.temp", "system folder": "organize.why.system",
};
const TITLE_WORDS: Record<string, CliKey> = { "technical title": "organize.why.technical", "title set by t3sm earlier": "organize.why.earlier" };

/** The planner's history reason in `lang` ("history: last 90 days" -> "from the last 90 days"). */
function historyWhy(lang: Lang, r: string): string {
  if (r === "history: all") return cliT(lang, "organize.why.all");
  const last = /^history: last (\d+) days$/.exec(r);
  if (last) return cliT(lang, "organize.why.last", { days: last[1]! });
  const min = /^history: at least (\d+) per project$/.exec(r);
  if (min) return cliT(lang, "organize.why.min", { min: min[1]! });
  const kept = /^history: kept visible, at least (\d+) per project$/.exec(r);
  if (kept) return cliT(lang, "organize.why.kept", { min: kept[1]! });
  const older = /^history: older than (\d+) days$/.exec(r);
  return older ? cliT(lang, "organize.why.older", { days: older[1]! }) : r;
}

/** One line per kind (spec §5.6): what, why, and how to undo; in `o.lang` (English by default). */
export function summaryLines(plan: OrganizePlan, o: OrganizeSummaryOptions = {}): string[] {
  const lang = o.lang ?? "en";
  const t = (k: CliKey, v: Record<string, string | number> = {}): string => cliT(lang, k, v);
  const undo = o.undo !== false ? ` ${o.dash ?? "—"} ${cliT(lang, "organize.undo")}` : "";
  const num = (n: number): string => (lang === "pt" ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") : fmt(n));
  const of = (k: OrganizeKind): OrganizeAction[] => plan.actions.filter((a) => a.kind === k);
  const L: string[] = [];
  const archive = of("archive");
  if (archive.length > 0) {
    const reasons = tally(archive, (a) => a.reason);
    if (reasons.length === 1 && reasons[0]![0] === "automated session (Agent SDK)") L.push(t("organize.sum.archiveAutomated", { n: num(archive.length) }) + undo);
    else {
      const why = reasons.map(([r, n]) => `${num(n)} ${ARCHIVE_WORDS[r] ? cliT(lang, ARCHIVE_WORDS[r]!) : r}`).join(", ");
      L.push(t("organize.sum.archive", { n: num(archive.length), why }) + undo);
    }
  }
  const title = of("title");
  if (title.length > 0) {
    const reasons = tally(title, (a) => a.reason);
    const word = (r: string): string => (TITLE_WORDS[r] ? cliT(lang, TITLE_WORDS[r]!) : r);
    const why = reasons.length === 1 ? word(reasons[0]![0]) : reasons.map(([r, n]) => `${num(n)} ${word(r)}`).join(", ");
    L.push(t("organize.sum.title", { n: num(title.length), why }) + undo);
  }
  // Titles T3 Code writes: how many, with which model, that it spends the user's tokens, and the cap of this run.
  const aiTitle = of("ai-title");
  if (aiTitle.length > 0) {
    const model = o.textModel ? t("organize.textModelNamed", { model: shownText(o.textModel, 60) }) : t("organize.textModel");
    const max = plan.aiTitles?.max ?? aiTitle.length;
    const eligible = plan.aiTitles?.eligible ?? aiTitle.length;
    L.push((eligible > aiTitle.length
      ? t("organize.sum.aiTitlesCapped", { n: num(aiTitle.length), eligible: num(eligible), model, max: num(max) })
      : t("organize.sum.aiTitles", { n: num(aiTitle.length), model, max: num(max) })) + undo);
  }
  const show = of("unsettle").filter((a) => !isShownMark(a));
  if (show.length > 0) {
    const projects = new Set(show.map((a) => a.projectId)).size;
    const why = tally(show, (a) => a.reason).map(([r]) => historyWhy(lang, r)).join(", ");
    L.push(t("organize.sum.show", { n: num(show.length), p: num(projects), why }) + undo);
  }
  // Already shown: marked so T3 Code's own auto-settle leaves them shown (src/organize/history.ts, step 6).
  const kept = of("unsettle").filter((a) => isShownMark(a));
  if (kept.length > 0) {
    const projects = new Set(kept.map((a) => a.projectId)).size;
    L.push(t("organize.sum.keep", { n: num(kept.length), p: num(projects) }) + undo);
  }
  const settle = of("settle");
  if (settle.length > 0) {
    const projects = new Set(settle.map((a) => a.projectId)).size;
    const why = tally(settle, (a) => a.reason).map(([r]) => historyWhy(lang, r)).join(", ");
    L.push(t("organize.sum.settle", { n: num(settle.length), p: num(projects), why }) + undo);
  }
  const pin = of("pin");
  if (pin.length > 0) {
    const top = /top (\d+) recent/.exec(pin[0]!.reason)?.[1];
    L.push(t("organize.sum.pin", { n: num(pin.length), why: top ? cliT(lang, "organize.why.pin", { top }) : pin[0]!.reason }) + undo);
  }
  const unpin = of("unpin");
  if (unpin.length > 0) {
    const top = /top (\d+) recent/.exec(unpin[0]!.reason)?.[1];
    L.push(t("organize.sum.unpin", { n: num(unpin.length), why: top ? cliT(lang, "organize.why.unpin", { top }) : unpin[0]!.reason }) + undo);
  }
  const del = of("project-delete");
  if (del.length > 0) L.push(t("organize.sum.delete", { n: num(del.length) }) + (undo ? `${undo} ${t("organize.recreates", { n: del.length })}` : ""));
  const rename = of("project-title");
  if (rename.length > 0) L.push(t("organize.sum.rename", { n: num(rename.length) }) + undo);
  for (const a of of("auto-settle")) {
    const v = (x: unknown): string => (x === null ? cliT(lang, "organize.off") : cliT(lang, "organize.days", { n: String(x) }));
    L.push(t("organize.sum.autoSettle", { from: v(a.previous), to: v(a.next) }) + undo);
  }
  return L;
}

const TOP_PROJECTS = 10;

/** The history rule in words: "History: the last 90 days, at least 10 per project". */
export function historyLine(ui: CliUi, rule: HistoryRule | null): string {
  if (rule === null) return ui.t("organize.history.off");
  if (rule.days === "all") return ui.t("organize.history.all");
  return ui.t("organize.history.rule", { days: ui.f.n(rule.days), min: ui.f.n(rule.minPerProject) });
}

/** The preview table's words in the CLI's language. */
export function previewWords(ui: CliUi): OrganizePreviewWords {
  return {
    project: ui.t("organize.col.project"), visible: ui.t("organize.col.visible", { to: "{to}" }), settled: ui.t("organize.col.settled"),
    retitled: ui.t("organize.col.retitled"), archived: ui.t("organize.col.archived"), more: (n) => ui.t("organize.moreProjects", { n }),
  };
}

/**
 * The organize screen: one line per kind of change (what, why, how to undo), the history rule in words, and the
 * per-project before/after table.
 */
export function renderOrganize(ui: CliUi, plan: OrganizePlan, history: HistoryRule | null, width: number = ui.width, textModel: string | null = null): string[] {
  const { s } = ui;
  const w = Math.max(1, width);
  const L = summaryLines(plan, { lang: ui.lang, undo: false, textModel });
  if (L.length === 0) return fitLine(`${s("ok", s.sym.ok)} ${ui.t("organize.nothing")}`, w, 2);
  const out = L.flatMap((l) => fitLine(`${s("accent", s.sym.sep)} ${l}`, w, 2));
  // How to undo, once for every line above; the command is never split.
  out.push(...flowAtoms([...ui.t("organize.undoAll").split(/\s+/), s("key", "t3sm organize --undo")], w, 2));
  out.push("", ...fitLine(s("muted", historyLine(ui, history)), w, 2));
  const table = organizePreviewTable(s, ui.f, plan, previewWords(ui), w, { max: TOP_PROJECTS });
  if (table.length > 0) out.push("", ...table);
  return out;
}

function render(b: Built, ui: CliUi): string {
  return renderOrganize(ui, b.plan, b.history, ui.width, b.textModel).join("\n") + "\n";
}

function missingNotice(n: number, lang: Lang): string {
  return cliT(lang, "organize.missing", { n });
}

// ---------------- review list ("d = details") ----------------

const KIND_ORDER: readonly OrganizeKind[] = ["archive", "title", "ai-title", "unsettle", "settle", "pin", "unpin", "project-delete", "project-title", "auto-settle"];
const KIND_LABEL: Record<OrganizeKind, CliKey> = {
  archive: "organize.kind.archive", title: "organize.kind.title", "ai-title": "organize.kind.aiTitle", unsettle: "organize.kind.show", settle: "organize.kind.settle", pin: "organize.kind.pin",
  unpin: "organize.kind.unpin", "project-delete": "organize.kind.delete", "project-title": "organize.kind.rename", "auto-settle": "organize.kind.setting",
};

/** The planner's reason in words, for the line's detail. */
function reasonText(a: OrganizeAction, lang: Lang): string {
  if (a.kind === "archive") return ARCHIVE_NOUN[a.reason] ? cliT(lang, ARCHIVE_NOUN[a.reason]!) : a.reason;
  if (a.kind === "title" || a.kind === "ai-title") return TITLE_WORDS[a.reason] ? cliT(lang, TITLE_WORDS[a.reason]!) : a.reason;
  if (a.kind === "unsettle" || a.kind === "settle") return historyWhy(lang, a.reason);
  return a.reason;
}

/**
 * The plan's actions as review items, grouped by kind (the planner's order inside a kind), each with its sentence, the
 * reason and the kind. The id is the action's index in plan.actions; every item starts checked.
 */
export function reviewItems(plan: OrganizePlan, names: Names): ListItem[] {
  const order = (k: OrganizeKind): number => KIND_ORDER.indexOf(k);
  return plan.actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => order(x.a.kind) - order(y.a.kind) || x.i - y.i)
    .map(({ a, i }): ListItem => ({ id: String(i), label: actionLine(a, names), detail: reasonText(a, names.lang), meta: cliT(names.lang, KIND_LABEL[a.kind]), checked: true }));
}

/** The plan without the changes that were unchecked in the review (ids are indexes into plan.actions). */
export function keepChecked(plan: OrganizePlan, items: ListItem[]): OrganizePlan {
  const keep = new Set(items.filter((i) => i.checked).map((i) => Number(i.id)));
  const actions = plan.actions.filter((_, i) => keep.has(i));
  const counts = { ...plan.counts };
  for (const k of Object.keys(counts) as OrganizeKind[]) counts[k] = actions.filter((a) => a.kind === k).length;
  return { ...plan, actions, counts };
}

/**
 * Asks whether to apply the plan. With a terminal, "d" opens the review list; confirming it narrows the plan to the
 * checked changes and asks again. Returns the plan to apply, or null for "no" (or nothing left to apply).
 */
async function decide(b: Built, io: Io, term: Term | null, lang: Lang): Promise<OrganizePlan | null> {
  const question = cliUi(io).t("organize.confirm");
  if (term === null) return (await confirm(io, question)) ? b.plan : null;
  let plan = b.plan;
  for (;;) {
    const ans = await confirmOrDetails(io, question);
    if (ans === "yes") return plan;
    if (ans === "no") return null;
    const r = await reviewList(term, {
      title: "t3sm organize", help: cliT(lang, "organize.reviewHelp"),
      items: reviewItems(plan, b.names), lang,
    });
    if (!r.confirmed) continue;
    const before = plan.actions.length;
    plan = keepChecked(plan, r.items);
    io.stdout(`${cliT(lang, "organize.keeping", { n: plan.actions.length, total: before })}\n`);
    if (plan.actions.length === 0) { io.stdout(`${cliT(lang, "organize.nothingLeft")}\n`); return null; }
    for (const l of summaryLines(plan, { lang, textModel: b.textModel })) io.stdout(`${l}\n`);
  }
}

async function organize(p: Parsed, io: Io, deps: OrganizeDeps): Promise<number> {
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const dir = stateDir(io.env, home);
  const j = new Journal(join(dir, "journal.jsonl"));
  const config = (await loadConfig(dir, home)) ?? defaultConfig(await resolveAccounts(home, [], io.env));
  // Titles written by T3 Code: --ai-titles / --no-ai-titles for this run, else organize.aiTitles.enabled.
  const ai = organizeSettings(config, langOf(io, config.language)).aiTitles;
  if (p.aiFlag ?? ai.enabled) p.aiTitles = { max: p.aiMax ?? ai.maxPerRun };
  else if (p.aiMax !== undefined) { usageLine(io, "usage.aiTitlesMaxOff"); return 2; }
  const onNotice = noticeOnce(io);
  // settings:write only for a run that may change T3 Code's own auto-settle option (--auto-settle); a dry run never writes.
  const connect = (): Promise<T3Api> => connectForOrganize(deps.connect ?? connectT3, home, p.allowUntested, onNotice, !p.dryRun && p.autoSettle !== undefined);

  const ui = cliUi(io, { now });
  const plan = async (api: T3Api): Promise<Built> => {
    const b = await buildOrganize(api, j, config, p, io, deps, home, now);
    if (b.missing > 0) onNotice(missingNotice(b.missing, ui.lang));
    io.stdout(render(b, ui));
    return b;
  };

  if (p.dryRun) {
    const api = await connect();
    try {
      const b = await plan(api);
      if (b.plan.actions.length > 0) io.stdout(`\n${ui.t("organize.dryRun")}\n`);
    } finally {
      await api.close();
    }
    return 0;
  }

  const lock = await acquireLock(dir);
  if (!lock) { reportLockBusy(io); return 0; }
  try {
    const rec = await recoverPendingMtimes(j);
    if (rec.restored.length > 0) io.stderr(`${cliT(io.lang ?? "en", "apply.recovered", { n: rec.restored.length })}\n`);
    const api = await connect();
    try {
      const b = await plan(api);
      if (b.plan.actions.length === 0) return 0;
      let chosen = b.plan;
      if (!p.yes) {
        const term = io.isTTY && !p.plain ? (deps.term ?? nodeTerm({ env: io.env })) : null;
        const c = await decide(b, io, term !== null && term.isTTY ? term : null, langOf(io, config.language));
        if (c === null) { io.stdout(`${ui.t("common.nothingChanged")}\n`); return 0; }
        chosen = c;
      }
      const n = chosen.actions.length;
      let i = 0;
      // One progress bar for the whole run (redrawn in place on a terminal, a few milestone lines otherwise).
      const bar = progressBar(ioTerm(io, ui), ui.s, ui.f, now, { words: { left: ui.t("progress.left") } });
      const started = now();
      const signals = deps.signals ?? processSignals;
      let stop = false;
      const onSignal = (): void => { stop = true; };
      for (const sig of STOP_SIGNALS) signals.on(sig, onSignal);
      let r: Awaited<ReturnType<typeof applyOrganize>>;
      let ended = false;
      const end = (): void => {
        if (ended) return;
        ended = true;
        bar.end(ui.t("organize.progressDone", { n: i, total: n, dur: ui.f.dur(now() - started) }));
      };
      try {
        io.stdout("\n");
        bar.start(n, ui.t("organize.progress", { n }));
        r = await applyOrganize(chosen, {
          api, journal: j, runId: chosen.runId, now, allowUntested: true, onNotice, // organizeGate already spoke
          aborted: () => stop,
          onProgress: () => { i++; bar.tick(i); },
          // Only this command may ask T3 Code for titles (never sync, never the assistant).
          allowAiTitles: p.aiTitles !== undefined,
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          onWaiting: (k) => { end(); io.stdout(`${ui.t("organize.aiWaiting", { n: k, dur: ui.f.dur(AI_TITLE_WAIT_MS) })}\n`); },
        });
        end();
      } finally {
        bar.dispose();
        for (const sig of STOP_SIGNALS) signals.off(sig, onSignal);
      }
      if (r.failed.length > 0) io.stdout(failedTable(ui, r.failed, b.names).join("\n") + "\n");
      const parts = [r.done > 0 ? ui.t("organize.made", { n: r.done }) : ui.t("organize.madeNone")];
      if (r.skippedChanged > 0) parts.push(ui.t("organize.leftAlone", { n: r.skippedChanged }));
      if (r.failed.length > 0) parts.push(ui.t("organize.failedCount", { n: r.failed.length }));
      if (r.done > 0) parts.push(ui.t("organize.runUndo", { runId: shownText(chosen.runId) }));
      io.stdout(parts.join(" ") + "\n");
      if (r.aiTitles) {
        const a = r.aiTitles;
        io.stdout(ui.t("organize.aiDone", { renamed: a.renamed, requested: a.requested }) + (a.waiting > 0 ? ` ${ui.t("organize.aiLate", { n: a.waiting })}` : "") + "\n");
        if (a.failed > 0) io.stdout(noteLines(ui.s, "warn", ui.t("organize.aiFailed", { n: a.failed, why: shownText(a.error ?? "?", 200).replace(/\.$/, "") }), ui.width).join("\n") + "\n");
      }
      if (r.status === "aborted") {
        io.stderr(`${ui.t("organize.interrupted")}\n`);
        return 130;
      }
      return r.failed.length > 0 ? 5 : 0;
    } finally {
      await api.close();
    }
  } finally {
    await lock.release();
  }
}

/** The changes that could not be made: the change in words and the error, as a table (at most 20 rows). */
function failedTable(ui: CliUi, failed: { action: OrganizeAction; error: string }[], names: Names, width: number = ui.width): string[] {
  const { s } = ui;
  const rows = failed.slice(0, 20).map((f) => [actionLine(f.action, names), failureWords(f.error, ui.lang)] as const);
  const out = [...fitLine(`${s("err", s.sym.err)} ${s("title", ui.t("organize.failedTitle", { n: failed.length }))}`, width, 2),
    ...uiTable(s, [
      { header: ui.t("organize.col.change"), get: (r) => (r as readonly [string, string])[0], priority: 5, min: 24 },
      { header: ui.t("organize.col.why"), get: (r) => (r as readonly [string, string])[1], priority: 9, min: 16 },
    ], rows, width)];
  if (failed.length > rows.length) out.push(...fitLine(s("muted", `${s.sym.ellipsis} ${ui.t("common.andMore", { n: failed.length - rows.length })} (t3sm runs)`), width));
  return out;
}

// ---------------- undo ----------------

/**
 * The newest run of `organize` / `projects rename` with organize changes that no rollback has undone yet (`latest`),
 * and whether there is any such run at all, undone or not (`any`).
 */
export function latestOrganizeRun(entries: JournalEntry[]): { latest: string | null; any: boolean } {
  const command = new Map<string, string>();
  const undone = new Set<string>();
  for (const e of entries) {
    if (e.t === "run-start") command.set(e.runId, e.command);
    else if (e.t === "rolled-back") undone.add(e.targetRunId);
  }
  let latest: string | null = null;
  let any = false;
  for (const e of entries) {
    if (e.t !== "organize-change" || !OWN_COMMANDS.has(command.get(e.runId) ?? "")) continue;
    any = true;
    if (!undone.has(e.runId)) latest = e.runId;
  }
  return { latest, any };
}

type Change = Extract<JournalEntry, { t: "organize-change" }>;
type UndoItem = UndoOrganizeResult["items"][number];

/** The organize-change entries of `target`, by kind and target (what each undo item reverts). */
export function changesOf(entries: JournalEntry[], target: string): Map<string, Change> {
  const m = new Map<string, Change>();
  for (const e of entries) if (e.t === "organize-change" && e.runId === target) m.set(`${e.kind}\u0000${e.target}`, e);
  return m;
}

/**
 * An undo's items in organize's words (shared with `t3sm rollback`): what is reverted, what is left alone and why, what
 * could not be reverted. Titles come from `names` (T3 Code as it was before the undo); never ids or raw JSON.
 */
export function undoLines(items: UndoItem[], changes: Map<string, Change>, names: Names): { reverted: string[]; userChanged: string[]; kept: string[]; failed: string[] } {
  const entry = (x: UndoItem) => changes.get(`${x.kind}\u0000${x.target}`) ?? { kind: x.kind, target: x.target, previous: null, next: null };
  const of = (status: UndoItem["status"], line: (x: UndoItem) => string): string[] => items.filter((x) => x.status === status).map(line);
  const why = (x: UndoItem): string => cliT(names.lang,
    /no longer exists/.test(x.note ?? "") ? "organize.undo.gone" : x.kind === "project-delete" ? "organize.undo.folderTaken"
      : x.kind === "ai-title" ? "organize.undo.aiLate" : "organize.undo.changed");
  return {
    reverted: of("reverted", (x) => revertLine(entry(x), names)),
    userChanged: of("user-changed", (x) => `${subjectOf(entry(x), names)}: ${why(x)}`),
    kept: of("kept", (x) => `${subjectOf(entry(x), names)}: ${cliT(names.lang, "organize.undo.kept")}`),
    failed: of("failed", (x) => `${revertLine(entry(x), names)}: ${failureWords(x.note ?? "failed", names.lang)}`),
  };
}

/**
 * An organize undo (or its preview, `dry`) in the user's language: a panel saying what is reverted, then what is
 * reverted, what is left alone and why, and what could not be reverted (at most 20 items each).
 */
export function renderUndo(ui: CliUi, r: UndoOrganizeResult, target: string, dry: boolean, changes: Map<string, Change>, names: Names, width: number = ui.width): string[] {
  const { s, t } = ui;
  const u = undoLines(r.items, changes, names);
  const head = dry ? t("organize.undo.would", { n: r.reverted, runId: shownText(target) })
    : t(r.runId ? "organize.undo.didJournal" : "organize.undo.did", { n: r.reverted, runId: shownText(target), journal: shownText(r.runId ?? "") });
  const out = noteLines(s, dry ? "info" : "ok", head, width);
  const list = (key: CliKey, xs: string[]): void => {
    const l = sectionLines(s, t(key), xs, width, { max: 20, more: (n) => t("common.andMore", { n }) });
    if (l.length > 0) out.push("", ...l);
  };
  list(dry ? "organize.undo.willRevert" : "organize.undo.reverted", u.reverted);
  list("organize.undo.leftAlone", u.userChanged);
  list("organize.undo.keptTitle", u.kept);
  if (r.alreadyRestored > 0) out.push("", ...textLines(s, t("organize.undo.alreadyBack", { n: r.alreadyRestored }), width));
  list("organize.undo.couldNot", u.failed);
  return out;
}

async function undo(p: Parsed, run: string | null, io: Io, deps: OrganizeDeps): Promise<number> {
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const dir = stateDir(io.env, home);
  const j = new Journal(join(dir, "journal.jsonl"));
  const entries = await j.readAll();
  const ui = cliUi(io, { now });
  const found = latestOrganizeRun(entries);
  const target = run ?? found.latest;
  if (target === null) {
    io.stdout(`${ui.t(found.any ? "organize.undo.allUndone" : "organize.undo.noRuns")}\n`);
    return 0;
  }
  // Without a run id the target is picked here: never silently with --yes (as `t3sm rollback`).
  if (p.yes && run === null) {
    io.stderr(`${ui.t("organize.undo.needsRun", { runId: shownText(target) })}\n`);
    return 2;
  }
  if (!entries.some((e) => e.runId === target)) throw new ConfigError(`No run ${shownText(target)} in the journal. Run \`t3sm runs\` to list them.`);
  if (!entries.some((e) => e.t === "organize-change" && e.runId === target)) {
    throw new ConfigError(`Run ${shownText(target)} made no organize changes. Use \`t3sm rollback --run ${shownText(target)}\` to undo it.`);
  }
  assertOrganizeOnly(entries, target); // a sync run that imported too: rollback undoes it whole (exit 2)
  const onNotice = noticeOnce(io);
  const changes = changesOf(entries, target);
  // settings:write only when the undo may put T3 Code's own auto-settle option back (never for a preview).
  const settingBack = [...changes.values()].some((c) => c.kind === "auto-settle");
  const connect = (): Promise<T3Api> => connectForOrganize(deps.connect ?? connectT3, home, p.allowUntested, onNotice, !p.dryRun && settingBack);
  const base = { journal: j, now, allowUntested: true, onNotice }; // organizeGate already spoke
  // Titles as T3 Code shows them before anything is reverted.
  const names = async (api: T3Api): Promise<Names> => namesOf(await api.listThreads(), await api.listProjects(), home, ui.lang);
  const say = (l: string[]): void => io.stdout(l.join("\n") + "\n");

  if (p.dryRun) {
    const api = await connect();
    try {
      const n = await names(api);
      const r = await undoOrganize(target, { ...base, api, dryRun: true });
      say(renderUndo(ui, r, target, true, changes, n));
      say(["", ...noteLines(ui.s, "info", ui.t("organize.undo.dryDone", { runId: shownText(target) }), ui.width)]);
    } finally {
      await api.close();
    }
    return 0;
  }

  const lock = await acquireLock(dir);
  if (!lock) { reportLockBusy(io); return 0; }
  try {
    const rec = await recoverPendingMtimes(j);
    if (rec.restored.length > 0) io.stderr(`${cliT(io.lang ?? "en", "apply.recovered", { n: rec.restored.length })}\n`);
    const api = await connect();
    try {
      const n = await names(api);
      if (!p.yes) {
        const preview = await undoOrganize(target, { ...base, api, dryRun: true });
        say(renderUndo(ui, preview, target, true, changes, n));
        if (preview.reverted === 0) { io.stdout(`${ui.t("organize.undo.nothing", { runId: shownText(target) })}\n`); return 0; }
        io.stdout("\n");
        if (!(await confirm(io, ui.t("organize.confirmUndo", { runId: shownText(target) })))) { io.stdout(`${ui.t("common.nothingChanged")}\n`); return 0; }
      }
      const r = await undoOrganize(target, { ...base, api });
      if (r.runId === null && r.failed.length === 0) { io.stdout(`${ui.t("organize.undo.nothing", { runId: shownText(target) })}\n`); return 0; }
      say(renderUndo(ui, r, target, false, changes, n));
      return r.failed.length > 0 ? 5 : 0;
    } finally {
      await api.close();
    }
  } finally {
    await lock.release();
  }
}
