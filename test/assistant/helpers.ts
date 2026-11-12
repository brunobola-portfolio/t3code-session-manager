// A scripted harness for the guided assistant: fake dependencies that record every call and answer, a synthetic plan,
// and helpers to check that each write came right after a "y". Never touches a real home or a real T3 Code.

import { resolve } from "node:path";
import { normalizeCwd } from "../../src/core/paths.ts";
import type { Plan, PlanItem } from "../../src/core/types.ts";
import type { Check } from "../../src/ops/doctor.ts";
import type { RunSummary } from "../../src/ops/rollback.ts";
import type { AccountRow, AssistantDeps, PlanView } from "../../src/assistant/core.ts";
import { runAssistant } from "../../src/assistant/runner.ts";
import type { Lang } from "../../src/assistant/i18n.ts";
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

/** demo: 2 pending (Personal, latest); big: 20 pending (Org, rule); busy: 1 pending and a session in use (held). */
export function planView(n = 0, routes: { match: string; account: string }[] = []): PlanView {
  const items: PlanItem[] = [
    item(DEMO, "claudeAgent"), item(DEMO, "claudeAgent"),
    ...Array.from({ length: 20 }, () => item(BIG, "claude-org")),
    item(BUSY, "claudeAgent"), item(BUSY, "claudeAgent", true),
  ];
  const plan: Plan = {
    version: 1, runId: `P${n + 1}`, createdAt: new Date().toISOString(), t3Version: "0.1.9", instancesToCreate: [],
    projectsToCreate: [{ root: DEMO, title: "demo", defaultInstanceId: "claudeAgent" }],
    projectAccounts: [
      { root: BIG, accountId: "claude-org", source: "route" },
      { root: BUSY, accountId: "claudeAgent", source: "default" },
      { root: DEMO, accountId: "claudeAgent", source: "recent-activity" },
    ],
    projectDefaults: [], mirrorCopies: [{ path: "/h/.claude-org/projects/x/a.jsonl", nativeId: "a", keptPath: "/h/.claude/projects/x/a.jsonl", relation: "identical" }],
    items, warnings: [],
  };
  return { plan, names: { claudeAgent: "Claude · Personal", "claude-org": "Claude · Org" }, planPath: `${HOME}/.t3code-session-manager/runs/P${n + 1}/plan.md`, config: cfg({ routes }) };
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
}

export interface Harness {
  deps: AssistantDeps;
  events: Event[];
  out: string[];
  prompts: string[];
  /** Answers left over when the assistant ended (an exhausted script rejects, which reads as quit). */
  left: () => number;
  exhausted: () => boolean;
  run: () => Promise<number>;
  text: () => string;
  /** The transcript with every run of whitespace as one space (sentences are wrapped at 80 columns). */
  flat: () => string;
  /** Only what the assistant printed (no prompts, no command output). */
  printed: () => string;
  calls: () => string[];
  writes: () => string[];
}

const run = (id: string, command: string | null, status = "ok"): RunSummary => ({
  runId: id, at: null, command, status, rolledBackBy: null,
  counts: { imported: 0, importFailed: 0, filesWritten: 0, quarantined: 0, unquarantined: 0, defaults: 0, instances: 0, projects: 0, archived: 0, merged: 0 },
});

export function harness(o: HarnessOptions): Harness {
  const answers = [...o.answers];
  const events: Event[] = [];
  const out: string[] = [];
  const printed: string[] = [];
  const prompts: string[] = [];
  const runs: RunSummary[] = [...(o.runs ?? [])];
  let accounts = (o.accounts ?? ACCOUNTS).map((a) => ({ ...a }));
  let doctorN = 0, planN = 0, lockN = 0, runSeq = 0, exhausted = false;
  let config = { hasPlan: false, ...(o.config ?? { exists: false, language: null }) };
  const call = (name: string, write: boolean, argv?: string[]): void => void events.push({ t: "call", name, argv, write, at: out.length });
  const commandOf = (argv: string[]): string | null => {
    if (argv[0] === "apply") return argv.includes("--only") ? "apply P1 --only" : "apply P1";
    if (argv[0] === "quarantine") return "quarantine";
    if (argv[0] === "dedupe") return "dedupe P1";
    if (argv[0] === "rollback") return `rollback ${argv[argv.indexOf("--run") + 1]}`;
    return null;
  };
  const deps: AssistantDeps = {
    home: HOME,
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
    config: async () => { call("config", false); return config; },
    runs: async () => runs.map((r) => ({ ...r })),
    scheduleInstalled: async () => { call("scheduleInstalled", false); return o.schedule ?? false; },
    accounts: async (u) => { call(`accounts${u ? ":untested" : ""}`, false); return accounts.map((a) => ({ ...a })); },
    plan: async (u) => { call(`plan${u ? ":untested" : ""}`, false); if (o.planError) throw o.planError; config = { ...config, exists: true, hasPlan: true }; return planView(planN++, o.routes ?? []); },
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
      if (write && cmd && code !== 2 && !locked) runs.push(run(`R${++runSeq}`, cmd, code === 5 ? "partial" : code === 130 ? "aborted" : "ok"));
      if (write && argv[0] === "accounts" && argv[1] === "--rename" && !locked) runs.push(run(`R${++runSeq}`, null, "-"));
      out.push(output);
      return { code, output, locked };
    },
  };
  return {
    deps, events, out, prompts,
    left: () => answers.length,
    exhausted: () => exhausted,
    run: () => runAssistant(deps, { lang: o.lang ?? "en", color: o.color ?? false, langFromFlag: o.langFromFlag ?? false }),
    text: () => out.join(""),
    flat: () => out.join("").replace(/\s+/g, " "),
    printed: () => printed.join(""),
    calls: () => events.filter((e): e is Extract<Event, { t: "call" }> => e.t === "call").map((e) => e.name),
    writes: () => events.filter((e): e is Extract<Event, { t: "call" }> => e.t === "call" && e.write).map((e) => e.name),
  };
}

/** Every write call came right after a yes ("y", or "s" in Portuguese) to a question whose default is No ("[y/N"). */
export function writesFollowYes(events: Event[]): string[] {
  const bad: string[] = [];
  let last: Extract<Event, { t: "ask" }> | null = null;
  for (const e of events) {
    if (e.t === "ask") { last = e; continue; }
    if (!e.write) continue;
    const yes = last !== null && ["y", "s", "yes", "sim"].includes(last.a.toLowerCase());
    if (!yes || !last!.q.includes("[y/N")) bad.push(`${e.name} after ${last ? JSON.stringify(`${last.q}${last.a}`) : "no answer"}`);
  }
  return bad;
}
