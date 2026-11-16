// A scripted harness for the guided assistant: fake dependencies that record every call and answer, a synthetic plan,
// and helpers to check that each write came right after a "y". Never touches a real home or a real T3 Code.

import { resolve } from "node:path";
import { normalizeCwd } from "../../src/core/paths.ts";
import type { Plan, PlanItem } from "../../src/core/types.ts";
import type { Check } from "../../src/ops/doctor.ts";
import type { RunSummary } from "../../src/ops/rollback.ts";
import type { OrganizePatch } from "../../src/core/config.ts";
import type { OrganizePlan, OrganizeAction } from "../../src/organize/types.ts";
import type { T3Project, T3Thread } from "../../src/t3/decode.ts";
import type { Term } from "../../src/ui/terminal.ts";
import type { AccountRow, AssistantDeps, OrganizePreview, PlanView, PluginRow } from "../../src/assistant/core.ts";
import type { InstallResult } from "../../src/ops/plugin.ts";
import { runAssistant } from "../../src/assistant/runner.ts";
import type { Lang } from "../../src/assistant/i18n.ts";
import type { Caps } from "../../src/ui/caps.ts";
import type { HistoryRule } from "../../src/core/types.ts";
import { cfg, sess } from "../plan/helpers.ts";

export const HOME = normalizeCwd(resolve("/home-demo"));
export const root = (n: string): string => normalizeCwd(resolve(`/work/${n}`));
export const DEMO = root("demo");
export const BIG = root("big");
export const BUSY = root("busy");

function item(r: string, instanceId: string, active = false): PlanItem {
  const s = sess({ cwd: r, flags: active ? ["active"] : [] });
  if (active) return { session: s, action: { kind: "skip", reason: "active" }, notes: [] };
  return { session: s, action: { kind: "import", projectRoot: r, instanceId, expectedThreadId: `import:${instanceId}:${s.nativeId}` }, notes: [] };
}

export const GENERAL = normalizeCwd(resolve("/home-demo/T3 General"));
export const SCRATCH = root("scratch");

/** Conversations from a refused folder, copied to `to` (a rehomed copy: convert-import with rehomeFrom). */
export interface Move { from: string; to: string; n: number; share?: { hits: number; total: number } }

/** The questions a plan finds unanswered, the way the planner reports them. */
export const PENDING = [
  { key: "home", sessions: 5, folders: 1 }, { key: "t3-refused", sessions: 1, folders: 1 },
  { key: "temp", sessions: 11, folders: 5 }, { key: "automated", sessions: 7, folders: 3 },
];

export const MOVES: Move[] = [{ from: HOME, to: DEMO, n: 3 }, { from: HOME, to: GENERAL, n: 2 }, { from: SCRATCH, to: GENERAL, n: 1 }];

/** demo: 2 pending (Personal, latest); big: 20 pending (Org, rule); busy: 1 pending and a session in use (held). */
export function planView(n = 0, routes: { match: string; account: string }[] = [], extra: { pending?: { key: string; sessions: number; folders: number }[]; moves?: Move[]; organize?: Record<string, unknown>; under?: string; skipped?: { harness: "pi" | "codex"; n: number }[] } = {}): PlanView {
  // under: the projects live in this folder (the screen snapshots put them under HOME, so they read the same on every system).
  const at = (name: string): string => (extra.under ? normalizeCwd(`${extra.under}/${name}`) : root(name));
  const [DEMO, BIG, BUSY] = [at("demo"), at("big"), at("busy")];
  const items: PlanItem[] = [
    item(DEMO, "claudeAgent"), item(DEMO, "claudeAgent"),
    ...Array.from({ length: 20 }, () => item(BIG, "claude-org")),
    item(BUSY, "claudeAgent"), item(BUSY, "claudeAgent", true),
  ];
  for (const sk of extra.skipped ?? []) {
    for (let k = 0; k < sk.n; k++) items.push({ session: { ...sess({ cwd: DEMO }), harness: sk.harness, accountId: null }, action: { kind: "skip", reason: "harness-unavailable" }, notes: [] });
  }
  for (const m of extra.moves ?? []) {
    for (let k = 0; k < m.n; k++) {
      const s = sess({ cwd: m.from });
      items.push({ session: s, action: { kind: "convert-import", projectRoot: m.to, instanceId: "claudeAgent", expectedThreadId: `import:claudeAgent:${s.nativeId}`, uuid: s.nativeId, targetFile: `${HOME}/.claude/projects/x/${s.nativeId}.jsonl`, copy: "faithful", rehomeFrom: m.from, ...(m.share ? { rehomeShare: m.share } : {}) }, notes: [] });
    }
  }
  const plan: Plan = {
    version: 1, runId: `P${n + 1}`, createdAt: new Date().toISOString(), t3Version: "0.1.9", instancesToCreate: [],
    projectsToCreate: [{ root: DEMO, title: "demo", defaultInstanceId: "claudeAgent" }],
    projectAccounts: [
      { root: BIG, accountId: "claude-org", source: "route" },
      { root: BUSY, accountId: "claudeAgent", source: "default" },
      { root: DEMO, accountId: "claudeAgent", source: "recent-activity" },
    ],
    projectDefaults: [], mirrorCopies: [{ path: "/h/.claude-org/projects/x/a.jsonl", nativeId: "a", keptPath: "/h/.claude/projects/x/a.jsonl", relation: "identical" }],
    items, warnings: [], ...(extra.pending && extra.pending.length > 0 ? { decisionsPending: extra.pending } : {}),
  };
  if ((extra.moves ?? []).some((m) => m.to === GENERAL)) plan.projectsToCreate.push({ root: GENERAL, title: "General", defaultInstanceId: "claudeAgent" });
  return { plan, names: { claudeAgent: "Claude · Personal", "claude-org": "Claude · Org" }, planPath: `${HOME}/.t3code-session-manager/runs/P${n + 1}/plan.md`, config: cfg({ routes, ...(extra.organize ? { organize: extra.organize } : {}) }) };
}

const project = (id: string, title: string, pinned = false): T3Project => ({ id, title, workspaceRoot: root(id), defaultModelSelection: null, archived: false, deleted: false, pinned, createdAt: null });
const thread = (id: string, projectId: string, title: string, at: string): T3Thread => ({ id, projectId, instanceId: "claudeAgent", archived: false, title, latestUserMessageAt: at, settledOverride: "settled", settledAt: "2026-11-01T00:00:00Z" });
const action = (kind: OrganizeAction["kind"], target: string, projectId: string | null, next: unknown, reason: string): OrganizeAction => ({ kind, target, projectId, previous: null, next, reason });

/** What organize would do (synthetic): 4 conversations shown in 2 projects, 2 titles, 3 automated archived, 2 pins, 1 empty project. */
export function previewFixture(o: { autoSettleDays?: number | null } = {}): OrganizePreview {
  const projects = [project("alpha", "alpha-app"), project("beta", "beta-api"), project("gamma", "gamma-docs"), project("empty", "scratchpad")];
  const threads = [
    thread("import:1", "alpha", "Fix login", "2026-11-10T10:00:00Z"), thread("import:2", "alpha", "Add dark mode", "2026-11-09T10:00:00Z"),
    thread("import:3", "beta", "Rate limiter", "2026-11-08T10:00:00Z"), thread("import:4", "beta", "Cache layer", "2026-11-07T10:00:00Z"),
  ];
  const actions: OrganizeAction[] = [
    action("archive", "import:a1", "alpha", true, "automated session (Agent SDK)"), action("archive", "import:a2", "alpha", true, "automated session (Agent SDK)"),
    action("archive", "import:a3", "beta", true, "automated session (Agent SDK)"),
    action("title", "import:1", "alpha", "Fix the login form", "technical title"), action("title", "import:3", "beta", "Rate limiting", "technical title"),
    ...["import:1", "import:2", "import:3", "import:4"].map((id, i) => action("unsettle", id, i < 2 ? "alpha" : "beta", "active", "history: all")),
    action("pin", "alpha", "alpha", true, "top 2 recent"), action("pin", "beta", "beta", true, "top 2 recent"),
    action("project-delete", "empty", "empty", null, "created by t3sm, no threads"),
  ];
  const counts = { archive: 3, title: 2, unsettle: 4, settle: 0, pin: 2, unpin: 0, "project-delete": 1, "project-title": 0, "auto-settle": 0 };
  const plan: OrganizePlan = {
    runId: "O1", actions, counts,
    byProject: [{ projectId: "alpha", title: "alpha-app", visibleBefore: 0, visibleAfter: 2 }, { projectId: "beta", title: "beta-api", visibleBefore: 0, visibleAfter: 2 }],
  };
  return { plan, projects, threads, autoSettleDays: o.autoSettleDays === undefined ? 7 : o.autoSettleDays };
}

export const ACCOUNTS: AccountRow[] = [
  { id: "claudeAgent", displayName: "Claude · Personal", email: "b***@example.com", home: "~/.claude", foundVia: ["default"], alias: null, hasInstance: true },
  { id: "claude-org", displayName: "Claude · Org", email: null, home: "~/.claude-org", foundVia: ["folder"], alias: null, hasInstance: false },
];

/** at: how much of the transcript (out) existed when it happened. */
export type Event = { t: "ask"; q: string; a: string; at: number } | { t: "call"; name: string; argv?: string[]; write: boolean; at: number };

export interface HarnessOptions {
  answers: string[];
  lang?: Lang;
  langFromFlag?: boolean;
  /** The language t3sm would use without --lang (system / T3SM_LANG); default English. */
  defaultLang?: Lang;
  color?: boolean;
  checks?: Check[][];
  accounts?: AccountRow[];
  cleanup?: { backupFolders: number; mirrorCopies: number };
  runs?: RunSummary[];
  schedule?: boolean;
  lock?: (callNo: number) => { pid: number } | null;
  config?: { exists: boolean; language: Lang | null; hasPlan?: boolean };
  codes?: (argv: string[]) => number;
  output?: (argv: string[]) => string;
  planError?: Error;
  /** Routes of the plan's config.json. */
  routes?: { match: string; account: string }[];
  /** A run another t3sm process journals while this command runs (a sync that took the lock). */
  foreign?: (argv: string[]) => RunSummary | null;
  /** Questions every plan finds unanswered until a saveOrganize answers them (planView extra). */
  pending?: { key: string; sessions: number; folders: number }[];
  /** Rehomed conversations a plan holds once home / t3-refused were saved as "rehome". */
  moves?: Move[];
  /** What the organize dry run finds (default: nothing imported to organize). */
  preview?: OrganizePreview | null;
  /** The configured accounts and their t3sm plugin (default: none, so the last step offers nothing). */
  plugins?: PluginRow[];
  /** The result of installing the plugin in one account (default: ok). */
  install?: (accountId: string) => InstallResult;
  /** The terminal is a TTY (default: not, so the review lists read numbered lines from the same answers as the prompts). */
  ttyTerm?: boolean;
  /** saveOrganize finds the lock taken. */
  saveLocked?: boolean;
  /** config() says the newest plan has pending decisions. */
  configPending?: boolean;
  /** The terminal's capabilities (default: 100 columns, Unicode, no colour). */
  caps?: Caps;
  /** The clock for relative dates. */
  now?: () => number;
  /** The plan's projects live in this folder (default: /work). */
  under?: string;
  /** Sessions the plan skips because T3 Code has no instance for their agent. */
  skipped?: { harness: "pi" | "codex"; n: number }[];
  /** Conversations an import that exits 5 journals as failed (default 2). */
  importFailed?: number;
  /** Projects the child `apply` held in use (journaled on its run-end; default none). */
  heldAfter?: number;
  /** The accounts' names in the plan (default "Claude · Personal" and "Claude · Org"). */
  names?: Record<string, string>;
  /** What the organize dry run finds when asked with a history rule (the assistant re-plans with the numbers typed). */
  previewFor?: (rule: HistoryRule | null, autoSettle?: number | null) => OrganizePreview | null;
}

export interface Harness {
  deps: AssistantDeps;
  events: Event[];
  out: string[];
  prompts: string[];
  /** Every patch saveOrganize received. */
  saved: OrganizePatch[];
  /** The language each plan was asked for. */
  planLangs: string[];
  /** How many times the terminal was disposed (the runner does it once, at the end; a list never does). */
  disposed: () => number;
  /** Answers left over when the assistant ended (an exhausted script rejects, which reads as quit). */
  left: () => number;
  exhausted: () => boolean;
  run: () => Promise<number>;
  text: () => string;
  /**
   * The transcript with every run of whitespace as one space (sentences are wrapped to the width), and the borders of
   * the panels left out, so a sentence wrapped inside a panel reads as one.
   */
  flat: () => string;
  /** Only what the assistant printed (no prompts, no command output). */
  printed: () => string;
  calls: () => string[];
  writes: () => string[];
}

const run = (id: string, command: string | null, status = "ok", importFailed = 0, held = 0): RunSummary => ({
  runId: id, at: null, command, status, rolledBackBy: null, ...(held > 0 ? { held } : {}),
  counts: { imported: 0, importFailed, filesWritten: 0, quarantined: 0, unquarantined: 0, defaults: 0, instances: 0, projects: 0, archived: 0, merged: 0, organized: 0, organizeReverted: 0 },
});

export function harness(o: HarnessOptions): Harness {
  const answers = [...o.answers];
  const events: Event[] = [];
  const out: string[] = [];
  const printed: string[] = [];
  const prompts: string[] = [];
  const runs: RunSummary[] = [...(o.runs ?? [])];
  let accounts = (o.accounts ?? ACCOUNTS).map((a) => ({ ...a }));
  const saved: OrganizePatch[] = [];
  const planLangs: string[] = [];
  let disposed = 0;
  let doctorN = 0, planN = 0, lockN = 0, runSeq = 0, exhausted = false;
  let config = { hasPlan: false, ...(o.config ?? { exists: false, language: null }) };
  const call = (name: string, write: boolean, argv?: string[]): void => void events.push({ t: "call", name, argv, write, at: out.length });
  const commandOf = (argv: string[]): string | null => {
    if (argv[0] === "apply") return argv.includes("--only") ? "apply P1 --only" : "apply P1";
    if (argv[0] === "quarantine") return "quarantine";
    if (argv[0] === "dedupe") return "dedupe P1";
    if (argv[0] === "rollback") return `rollback ${argv[argv.indexOf("--run") + 1]}`;
    if (argv[0] === "organize") return "organize";
    return null;
  };
  const term: Term = {
    isTTY: o.ttyTerm ?? false, columns: o.caps?.columns ?? 100, rows: 30, color: false, unicode: o.caps?.unicode ?? true,
    write: (s) => void out.push(s),
    onKey: () => () => undefined,
    setRaw: () => undefined,
    // The same script as the assistant's prompts: one reader.
    readLine: async (q) => {
      prompts.push(q);
      if (answers.length === 0) { exhausted = true; return null; }
      const a = answers.shift()!;
      events.push({ t: "ask", q, a, at: out.length });
      out.push(`${q}${a}
`);
      return a;
    },
    dispose: () => void disposed++,
  };
  const deps: AssistantDeps = {
    home: HOME,
    term,
    print: (s) => { out.push(s); printed.push(s); },
    prompt: async (q) => {
      prompts.push(q);
      if (answers.length === 0) { exhausted = true; throw new Error("script exhausted"); }
      const a = answers.shift()!;
      events.push({ t: "ask", q, a, at: out.length });
      out.push(`${q}${a.replace("\u0003", "^C")}\n`); // the transcript shows the answer as typed
      return a;
    },
    lockHolder: async () => { call("lockHolder", false); return o.lock ? o.lock(lockN++) : null; },
    doctor: async () => { call("doctor", false); const c = o.checks ?? [[{ id: "node-version", status: "ok", message: "Node 22.18" }]]; return c[Math.min(doctorN++, c.length - 1)]!; },
    config: async () => { call("config", false); return { ...config, ...(o.configPending ? { decisionsPending: true } : {}) }; },
    runs: async () => runs.map((r) => ({ ...r })),
    scheduleInstalled: async () => { call("scheduleInstalled", false); return o.schedule ?? false; },
    accounts: async (u) => { call(`accounts${u ? ":untested" : ""}`, false); return accounts.map((a) => ({ ...a })); },
    plan: async (u, lang) => {
      call(`plan${u ? ":untested" : ""}`, false);
      planLangs.push(lang);
      if (o.planError) throw o.planError;
      config = { ...config, exists: true, hasPlan: true };
      // What the saved answers did: answered questions are gone; rehomed conversations appear once home / t3-refused say "rehome".
      const answered = new Set(saved.flatMap((x) => x.decided ?? []));
      const moved = saved.some((x) => x.folders?.home === "rehome" || x.folders?.["t3-refused"] === "rehome");
      const pending = (o.pending ?? []).filter((d) => !answered.has(d.key));
      const v = planView(planN++, o.routes ?? [], { pending, moves: moved ? o.moves : [], ...(o.under ? { under: o.under } : {}), ...(o.skipped ? { skipped: o.skipped } : {}) });
      return o.names ? { ...v, names: o.names } : v;
    },
    pluginAccounts: async () => (o.plugins ?? []).map((p) => ({ ...p })),
    installPlugin: async (id) => { call(`installPlugin ${id}`, true); return o.install ? o.install(id) : { ok: true, output: "" }; },
    organizePreview: async (u, rule, autoSettle) => {
      call(`organizePreview${u ? ":untested" : ""}${rule === undefined ? "" : ` ${JSON.stringify(rule)}`}${autoSettle === undefined ? "" : ` auto-settle=${autoSettle}`}`, false);
      return rule !== undefined && o.previewFor ? o.previewFor(rule, autoSettle) : o.preview ?? null;
    },
    about: async () => ({ version: "0.3.0", accounts: accounts.length }),
    saveOrganize: async (patch) => {
      call(`saveOrganize ${JSON.stringify(patch)}`, true);
      if (o.saveLocked || (o.lock && o.lock(lockN++))) return false;
      saved.push(patch);
      return true;
    },
    cleanupCounts: async () => { call("cleanupCounts", false); return o.cleanup ?? { backupFolders: 1, mirrorCopies: 1 }; },
    saveLanguage: async (l) => { call(`saveLanguage ${l}`, true); if (o.lock && o.lock(lockN++)) return false; config = { ...config, language: l }; return true; },
    run: async (argv) => {
      const write = !argv.includes("--dry-run");
      call(`run ${argv.join(" ")}`, write, argv);
      const code = o.codes ? o.codes(argv) : 0;
      if (argv[0] === "accounts" && argv[1] === "--init") config = { ...config, exists: true };
      if (argv[0] === "accounts" && argv[1] === "--apply") accounts = accounts.map((a) => ({ ...a, hasInstance: true }));
      const cmd = commandOf(argv);
      const output = o.output ? o.output(argv) : `ran ${argv[0]}\n`;
      const locked = /Another t3sm run is in progress/.test(output); // the command found the lock taken: it wrote nothing
      const other = o.foreign?.(argv) ?? null;
      if (other) runs.push(other);
      if (write && cmd && code !== 2 && !locked) runs.push(run(`R${++runSeq}`, cmd, code === 5 ? "partial" : code === 130 ? "aborted" : "ok", code === 5 && argv[0] === "apply" ? o.importFailed ?? 2 : 0, argv[0] === "apply" ? o.heldAfter ?? 0 : 0));
      if (write && argv[0] === "accounts" && argv[1] === "--rename" && !locked) runs.push(run(`R${++runSeq}`, null, "-"));
      out.push(output);
      return { code, output, locked };
    },
  };
  return {
    deps, events, out, prompts, saved, planLangs, disposed: () => disposed,
    left: () => answers.length,
    exhausted: () => exhausted,
    run: () => runAssistant(deps, { lang: o.lang ?? "en", color: o.color ?? (o.caps ? o.caps.color > 0 : false), langFromFlag: o.langFromFlag ?? false, defaultLang: o.defaultLang ?? "en", ...(o.caps ? { caps: o.caps } : {}), ...(o.now ? { now: o.now } : {}) }),
    text: () => out.join(""),
    flat: () => out.join("").replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " "),
    printed: () => printed.join(""),
    calls: () => events.filter((e): e is Extract<Event, { t: "call" }> => e.t === "call").map((e) => e.name),
    writes: () => events.filter((e): e is Extract<Event, { t: "call" }> => e.t === "call" && e.write).map((e) => e.name),
  };
}

/** The keys of the decisions step's questions (step 5; src/assistant/steps.ts DECISIONS). */
const DECISION_KEYS = new Set(["home", "t3-refused", "temp", "system", "automated", "orphaned"]);
const YES_NO_ANSWERS = new Set(["", "y", "n", "s", "yes", "no", "sim", "nao", "não"]);

/**
 * The decisions step's own save: config.json "organize" with exactly the answered decision keys (and their folders /
 * sessions values), right after the last of as many yes/no answers as it has keys. Allowed without a separate yes
 * because each decision WAS an explicit answer: the answers are the decision (0.3.0 asked "save the answers?" after
 * them, and its default No silently left every conversation of the answered questions out of T3 Code). It writes only
 * config.json; every import, move or T3 Code change still waits for its own default-No question.
 */
function decisionSave(e: Extract<Event, { t: "call" }>, asks: Extract<Event, { t: "ask" }>[]): boolean {
  const m = /^saveOrganize (.*)$/.exec(e.name);
  if (!m) return false;
  let patch: Record<string, unknown>;
  try { patch = JSON.parse(m[1]!) as Record<string, unknown>; } catch { return false; }
  const decided = patch["decided"];
  if (!Array.isArray(decided) || decided.length === 0 || !decided.every((k) => typeof k === "string" && DECISION_KEYS.has(k))) return false;
  if (!Object.keys(patch).every((k) => k === "decided" || k === "folders" || k === "sessions")) return false;
  // A "?" or an answer the question did not understand asks the same question again: only the final answers count.
  const answered = asks.filter((a) => YES_NO_ANSWERS.has(a.a.toLowerCase())).slice(-decided.length);
  return answered.length === decided.length && answered.every((a) => /\[(?:Y\/n|y\/N|S\/n|s\/N)/.test(a.q))
    && asks.at(-1) === answered.at(-1);
}

/** The history question's prompts (EN and PT): "turn it on?" (the off form) and the days asked after an n. */
const HISTORY_ON_Q = /^(?:Turn it on: the last|Ligar: os últimos)/;
const HISTORY_DAYS_Q = /^(?:Days each project shows|Dias que cada projeto mostra)/;
const NO_ANSWERS = new Set(["n", "no", "não", "nao"]);
const NONE_ANSWERS = new Set(["none", "off", "nada", "nenhum", "nenhuma"]);

/**
 * The organize step's save of the re-asked 0.2 history question answered "no rule" with nothing else chosen: exactly
 * `{ history: "off", decided: ["history", "history-v2"] }`, after the history question was kept off (Enter or n to
 * "turn it on?") or answered none (the days), and every question after it answered no (n, or Enter on a default-No
 * question; "?" asks again). Allowed for the same reason as decisionSave: the answer itself is the decision, and only
 * config.json is written (no T3 Code change).
 */
function historyOffSave(e: Extract<Event, { t: "call" }>, asks: Extract<Event, { t: "ask" }>[]): boolean {
  if (e.name !== 'saveOrganize {"history":"off","decided":["history","history-v2"]}') return false;
  const h = asks.findLastIndex((a) => HISTORY_ON_Q.test(a.q) || HISTORY_DAYS_Q.test(a.q));
  if (h < 0) return false;
  const q = asks[h]!;
  const a = q.a.trim().toLowerCase();
  const off = HISTORY_ON_Q.test(q.q) ? a === "" || NO_ANSWERS.has(a) : NONE_ANSWERS.has(a);
  const no = (x: Extract<Event, { t: "ask" }>): boolean => {
    const v = x.a.trim().toLowerCase();
    return v === "?" || NO_ANSWERS.has(v) || (v === "" && /\[(?:y\/N|s\/N)/.test(x.q));
  };
  return off && asks.slice(h + 1).every(no);
}

/**
 * Every write call came right after a yes ("y", or "s" in Portuguese) to a yes/no question whose default is No: "[y/N"
 * in English, "[s/N" in Portuguese. The exceptions are the decisions step's save of its answers (decisionSave) and
 * the re-asked history question's "no rule" (historyOffSave).
 */
export function writesFollowYes(events: Event[]): string[] {
  const bad: string[] = [];
  const asks: Extract<Event, { t: "ask" }>[] = [];
  for (const e of events) {
    if (e.t === "ask") { asks.push(e); continue; }
    if (!e.write) continue;
    const last = asks.at(-1) ?? null;
    if (decisionSave(e, asks)) continue;
    if (historyOffSave(e, asks)) continue;
    const yes = last !== null && ["y", "s", "yes", "sim"].includes(last.a.toLowerCase());
    if (!yes || !["[y/N", "[s/N"].some((k) => last!.q.includes(k))) bad.push(`${e.name} after ${last ? JSON.stringify(`${last.q}${last.a}`) : "no answer"}`);
  }
  return bad;
}
