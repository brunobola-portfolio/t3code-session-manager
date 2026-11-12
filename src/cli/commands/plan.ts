import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config, Plan } from "../../core/types.ts";
import { expandHome, normalizeCwd, sameCwd, stateDir, tildePath } from "../../core/paths.ts";
import { DEFAULT_ID, assertDefaultInstanceHome, defaultClaudeHome } from "../../ops/accounts.ts";
import { loadConfig, saveConfig, defaultConfig } from "../../core/config.ts";
import { resolveAccountsWithSources } from "../../ops/discoverAccounts.ts";
import { atomicWrite } from "../../core/fsutil.ts";
import { Journal, newRunId } from "../../core/journal.ts";
import { buildPlan } from "../../plan/planner.ts";
import { renderPlanMarkdown, renderTerminalSummary } from "../../plan/report.ts";
import { connectT3, instancesFromConfig, type T3Api, type T3Project } from "../../t3/api.ts";
import { allAdapters } from "../../sources/registry.ts";
import type { SourceAdapter } from "../../sources/types.ts";
import { RUN_IN_PROGRESS_NOTE, discoverAll, makeEnv, runInProgress } from "./scan.ts";
import type { Io } from "../main.ts";

export interface PlanDeps {
  adapters?: SourceAdapter[];
  home?: string;
  now?: () => number;
  connect?: (home: string, opts: { allowUntested: boolean; manageProviders: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;
  existsDir?: (p: string) => Promise<boolean>;
}

export async function isDir(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

export interface FreshPlanOptions {
  home: string;
  /** Process environment (T3SM_HOME, CODEX_HOME, ...). */
  env: NodeJS.ProcessEnv;
  now: () => number;
  runId?: string;
  adapters?: SourceAdapter[];
  existsDir?: (p: string) => Promise<boolean>;
  /** No config.json: "save" writes the detected default (plan), "memory" uses it without writing (sync). */
  missingConfig: "save" | "memory";
  onNotice?: (line: string) => void;
  /** Discovery writes nothing (no cache save): `sync --dry-run`. */
  readOnly?: boolean;
}

export interface FreshPlan {
  plan: Plan;
  config: Config;
  projects: T3Project[];
  names: Record<string, string>;
}

/** Read-only against T3 (an already connected api): read T3's state, discover sessions, build the plan. */
export async function freshPlan(api: T3Api, o: FreshPlanOptions): Promise<FreshPlan> {
  const dir = stateDir(o.env, o.home);
  const [projects, threads, providers, t3cfg] = await Promise.all([api.listProjects(), api.listThreads(), api.providerInstances(), api.getConfig()]);
  const instances = instancesFromConfig(t3cfg);

  let config = await loadConfig(dir, o.home);
  if (config === null) {
    const r = await resolveAccountsWithSources(o.home, instances, o.env);
    config = defaultConfig(r.accounts);
    if (o.missingConfig === "save") {
      await saveConfig(dir, config, o.home);
      const where = (h: string): string => {
        const f = r.found.find((x) => sameCwd(x.home, h));
        return f && f.sources.length > 0 ? f.sources.join(", ") : "folder";
      };
      const list = config.accounts.map((a) => `\n  ${a.id}  ${tildePath(a.home, o.home)}  (found via ${where(a.home)})`).join("");
      o.onNotice?.(`No config found: detected ${config.accounts.length} account(s) and saved ${join(dir, "config.json")}:${list}\nEdit it if an account is missing or wrong, then run \`t3sm plan\` again.`);
    }
  }

  // Before any discovery: T3's default Claude instance must read the config's ~/.claude account (by home, any id).
  const accountHomes = config.accounts.map((a) => expandHome(a.home, o.home));
  assertDefaultInstanceHome(providers, accountHomes, o.home, process.platform, t3cfg.settings.providerInstances);

  const io = { env: o.env } as Io;
  const { sessions } = await discoverAll(o.adapters ?? allAdapters(), { ...makeEnv(io, o.home, config, o.now), readOnly: o.readOnly ?? false });
  const journal = await new Journal(join(dir, "journal.jsonl")).readAll();
  const runId = o.runId ?? newRunId(new Date(o.now()));
  const plan: Plan = await buildPlan({
    sessions, config, journal, now: o.now(), runId, home: o.home,
    t3: { version: api.version, projects, threads, instances, providers },
    existsDir: o.existsDir ?? isDir,
  });
  // Implicit default instance (no settings entry) + a config account for ~/.claude: apply pins it there.
  const defHome = defaultClaudeHome(o.home);
  const implicit = providers.some((p) => p.instanceId === DEFAULT_ID && p.driver === "claudeAgent") && !Object.hasOwn(t3cfg.settings.providerInstances, DEFAULT_ID);
  plan.pinDefault = implicit && accountHomes.some((h) => sameCwd(h, defHome))
    ? { instanceId: DEFAULT_ID, homePath: normalizeCwd(defHome) } : null;
  const names: Record<string, string> = {};
  for (const a of config.accounts) names[a.id] = a.displayName;
  for (const i of instances) names[i.id] ??= i.displayName;
  return { plan, config, projects, names };
}

export async function planCommand(args: string[], io: Io, deps: PlanDeps = {}): Promise<number> {
  const known = new Set(["--json", "--allow-untested"]);
  const bad = args.find((a) => !known.has(a));
  if (bad !== undefined) {
    io.stderr(`Unknown option: ${bad}. Run \`t3sm plan --help\`.\n`);
    return 2;
  }
  const json = args.includes("--json");
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const dir = stateDir(io.env, home);
  const connect = deps.connect ?? connectT3;
  if (await runInProgress(dir)) io.stderr(`${RUN_IN_PROGRESS_NOTE}\n`);
  const { plan, names, planPath } = await writeFreshPlan(io, { ...deps, home, now, connect }, args.includes("--allow-untested"));
  if (json) io.stdout(JSON.stringify(plan, null, 2) + "\n");
  else {
    const color = io.isTTY && !io.env["NO_COLOR"];
    io.stdout(renderTerminalSummary(plan, { color, planPath, names }));
  }
  return 0;
}

/**
 * What `t3sm plan` does, without printing the summary: connect (read-only), build a fresh plan, write
 * runs/<runId>/plan.md and plan.json (and config.json on the first run). Shared with the guided assistant.
 */
export async function writeFreshPlan(io: Io, deps: PlanDeps, allowUntested: boolean): Promise<FreshPlan & { planPath: string }> {
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const dir = stateDir(io.env, home);
  const connect = deps.connect ?? connectT3;
  // Connect first: with T3 down (exit 3, thrown, mapped in main) nothing is written.
  const api = await connect(home, { allowUntested, manageProviders: false, onNotice: (l) => io.stderr(`${l}\n`) });
  try {
    const fresh = await freshPlan(api, {
      home, env: io.env, now, adapters: deps.adapters, existsDir: deps.existsDir, missingConfig: "save", onNotice: (l) => io.stderr(`${l}\n`),
    });
    const runDir = join(dir, "runs", fresh.plan.runId);
    await mkdir(runDir, { recursive: true });
    const planPath = join(runDir, "plan.md");
    // plan.md first, plan.json last: apply reads plan.json, so its presence means the run is complete.
    await atomicWrite(planPath, renderPlanMarkdown(fresh.plan, { names: fresh.names }));
    await atomicWrite(join(runDir, "plan.json"), JSON.stringify(fresh.plan, null, 2) + "\n");
    return { ...fresh, planPath };
  } finally {
    await api.close();
  }
}
