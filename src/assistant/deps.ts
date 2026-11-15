// The guided assistant's real dependencies: thin wrappers over t3sm's own functions and commands. Reads call the
// functions behind doctor, accounts, plan, quarantine / dedupe (dry run), runs and schedule status; every write runs
// one of t3sm's commands (`run`), so each keeps its own lock, journal, checks and Ctrl+C handling.

import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { ConfigError, applyOrganizePatch, defaultConfig, detectAccounts, loadConfig, saveConfig, type OrganizePatch } from "../core/config.ts";
import { Journal } from "../core/journal.ts";
import { acquireLock, lockInfo } from "../core/lock.ts";
import { expandHome, sameCwd, stateDir, tildePath } from "../core/paths.ts";
import { pidAlive } from "../core/pid.ts";
import type { Config, Plan } from "../core/types.ts";
import { discoverAccountHomes, nodeDiscoveryEnv, resolveAccounts } from "../ops/discoverAccounts.ts";
import { defaultDoctorDeps, maskEmail, runDoctor } from "../ops/doctor.ts";
import { dedupe, findBackupDirs, quarantine } from "../ops/quarantine.ts";
import { listRuns } from "../ops/rollback.ts";
import { connectT3, type T3Api } from "../t3/api.ts";
import { freshPlan, writeFreshPlan } from "../cli/commands/plan.ts";
import { buildOrganize, connectForOrganize } from "../cli/commands/organize.ts";
import type { FolderEnv } from "../plan/folders.ts";
import { nodeTerm, type Term } from "../ui/terminal.ts";
import { accountsOf } from "../cli/commands/quarantine.ts";
import { latestPlan } from "../cli/commands/apply.ts";
import type { SourceAdapter } from "../sources/types.ts";
import type { Io } from "../cli/main.ts";
import type { AccountRow, AssistantDeps, OrganizePreview, PluginRow, RunOutcome } from "./core.ts";
import { installPlugin, packageVersion, readPluginState, type PluginExec } from "../ops/plugin.ts";
import { defaultRunner } from "../t3/auth.ts";
import { isLang, resolveLang, wrap, type Lang } from "./i18n.ts";

export interface RealDepsOptions {
  /** Runs `t3sm <argv>` with this Io (main), returning its exit code. */
  main: (argv: string[], io: Io) => Promise<number>;
  home?: string;
  now?: () => number;
  /** Child commands print without colour (--no-color / NO_COLOR). */
  noColor: boolean;
  /** T3 Code connection for the read-only accounts view and the plan (tests pass a fake). */
  connect?: (home: string, opts: { allowUntested: boolean; manageProviders: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;
  /** Discovery adapters for the plan (tests pass fakes; default: all). */
  adapters?: SourceAdapter[];
  /** How project folders are classified for the organize preview (tests; default: this machine). */
  folderEnv?: FolderEnv;
  /** The one terminal (tests pass a fake; default: this process's). */
  term?: Term;
  /** Runs the `claude plugin` children (tests pass a fake; default: real child processes). */
  pluginExec?: PluginExec;
  /** Where `claude` is (tests; default: PATH). */
  claudeBin?: () => string | null;
}

/** One child with the given environment, 2 minutes at most (a marketplace clone and an install). */
const spawnPluginChild: PluginExec = async (file, args, env) => {
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
  if (shell && /["\r\n\0!%]/.test(file)) return { code: null, output: "unsafe path to claude" };
  const r = await defaultRunner(file, args, { shell, timeoutMs: 120_000, env });
  return { code: r.timedOut ? null : r.code, output: `${r.stdout}${r.stderr}` };
};

export function realAssistantDeps(io: Io, o: RealDepsOptions): AssistantDeps {
  const home = o.home ?? homedir();
  const now = o.now ?? Date.now;
  const dir = stateDir(io.env, home);
  const journal = new Journal(join(dir, "journal.jsonl"));
  const childEnv = o.noColor ? { ...io.env, NO_COLOR: "1" } : io.env;
  const readConfig = () => loadConfig(dir, home);
  const connect = o.connect ?? connectT3;
  // Notices from the read steps: each shown once, wrapped to 80 columns. The untested-version warning is left
  // out: step 2 says it once, in the user's language.
  const seen = new Set<string>();
  const notice = (l: string): void => {
    const s = l.replace(/\n+$/, "");
    if (s === "" || seen.has(s) || /has not been tested with t3sm/.test(s)) return;
    seen.add(s);
    io.stderr(wrap(s).join("\n") + "\n");
  };

  // One terminal for the review lists. Without a TTY the assistant's own prompts read from it too, so piped answers are
  // never split between two readers; on a TTY io.prompt is used (the lists read keys, the prompts read lines, never both).
  const term = o.term ?? nodeTerm({ env: io.env });

  return {
    home,
    print: (s) => io.stdout(s),
    prompt: async (q) => (io.isTTY ? io.prompt(q) : (await term.readLine(q)) ?? "\u0003"),
    term,

    async lockHolder() {
      const info = await lockInfo(dir).catch(() => null);
      if (info === null) return null;
      // A lock left by a process that is gone is not "held": the next command takes it over itself.
      if (info.hostname === hostname() && !pidAlive(info.pid)) return null;
      return { pid: info.pid };
    },

    async doctor() {
      return (await runDoctor(defaultDoctorDeps({ home, env: io.env, repair: false }))).checks;
    },

    async config() {
      const planFile = await latestPlan(dir);
      const hasPlan = planFile !== null;
      let cfg: Config | null = null;
      let language: Lang | null = null;
      let configBroken = false;
      try {
        cfg = await readConfig();
        language = cfg && isLang(cfg.language) ? cfg.language : null;
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        configBroken = true; // doctor reports it
      }
      const exists = cfg !== null || configBroken;
      // Questions still unanswered: from a fresh read-only plan when T3 Code answers (what the next plan will really ask),
      // else from the newest saved plan (its own field; a damaged plan.json is apply's to report).
      let decisionsPending: boolean | null = null;
      if (hasPlan && cfg !== null) {
        let api: T3Api | null = null;
        try {
          api = await connect(home, { allowUntested: false, manageProviders: false, onNotice: notice });
          const f = await freshPlan(api, { home, env: childEnv, now, adapters: o.adapters, missingConfig: "memory", readOnly: true, lang: io.lang ?? resolveLang(null, io.env, language), onNotice: notice });
          decisionsPending = (f.plan.decisionsPending ?? []).length > 0;
        } catch { decisionsPending = null; } finally { await api?.close().catch(() => undefined); }
      }
      decisionsPending ??= planFile === null ? false
        : await readFile(planFile, "utf8").then((t) => ((JSON.parse(t) as Partial<Plan>).decisionsPending ?? []).length > 0, () => false);
      return { exists, language, hasPlan, decisionsPending };
    },

    runs: async () => listRuns(await journal.readAll()),

    async scheduleInstalled() {
      try { return (await defaultDoctorDeps({ home, env: io.env, repair: false }).scheduleStatus()).installed; } catch { return false; }
    },

    async accounts(allowUntested) {
      const api = await connect(home, { allowUntested, manageProviders: false, onNotice: notice });
      try {
        const instances = (await api.providerInstances()).filter((i) => i.driver === "claudeAgent");
        const found = await discoverAccountHomes(nodeDiscoveryEnv({ home, env: io.env, instanceHomes: instances.flatMap((i) => (i.homePath === null ? [] : [i.homePath])) }));
        const config = (await readConfig()) ?? defaultConfig(await detectAccounts(home, [], found.map((f) => ({ home: f.home, alias: f.alias }))));
        return config.accounts.map((a): AccountRow => {
          const h = expandHome(a.home, home);
          const inst = instances.find((i) => i.homePath !== null && sameCwd(i.homePath, h));
          const f = found.find((x) => sameCwd(x.home, h));
          return {
            id: a.id, displayName: inst?.displayName ?? a.displayName, email: inst?.email ? maskEmail(inst.email) : null,
            home: tildePath(h, home), foundVia: f ? [...f.sources] : ["config"], alias: f?.alias ?? null, hasInstance: inst !== undefined,
          };
        });
      } finally {
        await api.close();
      }
    },

    async plan(allowUntested, lang) {
      const r = await writeFreshPlan({ ...io, env: childEnv, stderr: notice }, { home, now, connect, adapters: o.adapters, lang }, allowUntested);
      return { plan: r.plan, names: r.names, planPath: r.planPath, config: r.config };
    },

    async pluginAccounts(): Promise<PluginRow[]> {
      const config = (await readConfig()) ?? defaultConfig(await resolveAccounts(home, [], io.env));
      const version = packageVersion();
      return Promise.all(config.accounts.map(async (a) => {
        const h = expandHome(a.home, home);
        return { id: a.id, displayName: a.displayName, home: tildePath(h, home), state: await readPluginState(h, version) };
      }));
    },

    // Two `claude plugin` children for this account only; the network is touched only inside them.
    async installPlugin(accountId) {
      const config = (await readConfig()) ?? defaultConfig(await resolveAccounts(home, [], io.env));
      const a = config.accounts.find((x) => x.id === accountId);
      if (!a) return { ok: false, step: "claude", output: `unknown account ${accountId}` };
      return installPlugin(expandHome(a.home, home), { exec: o.pluginExec ?? spawnPluginChild, claudeBin: (o.claudeBin ?? (() => defaultDoctorDeps({ home, env: io.env, repair: false }).findBin("claude")))(), env: io.env });
    },

    async cleanupCounts(plan: Plan) {
      const accounts = await accountsOf(dir, home, io.env);
      let backupFolders = 0;
      for (const a of accounts) {
        const dirs = await findBackupDirs(a.home);
        if (dirs.length > 0) backupFolders += (await quarantine(dirs, a.home, journal, "preview", { dryRun: true, now })).moved.length;
      }
      const copies = new Set(plan.mirrorCopies.map((c) => c.path));
      const mirrorCopies = plan.mirrorCopies.length === 0 ? 0
        : (await dedupe(plan.mirrorCopies, accounts, journal, "preview", { dryRun: true, now, home })).moved.filter((m) => copies.has(m.from)).length;
      return { backupFolders, mirrorCopies };
    },

    // config.json only, under the lock like every other config writer that can meet a running command.
    async saveLanguage(lang: Lang) {
      const lock = await acquireLock(dir);
      if (!lock) return false;
      try {
        const c = await readConfig();
        if (c !== null) await saveConfig(dir, { ...c, language: lang }, home);
        return true;
      } finally {
        await lock.release();
      }
    },

    // The dry run behind `t3sm organize`: reads T3 Code and the transcripts, writes nothing (no lock, journal or cache).
    async organizePreview(allowUntested, rule): Promise<OrganizePreview | null> {
      const api = await connectForOrganize(connect, home, allowUntested, notice);
      try {
        const config = (await readConfig()) ?? defaultConfig(await resolveAccounts(home, [], io.env));
        const b = await buildOrganize(api, journal, config, { only: null, dryRun: true, offerAll: true, ...(rule === undefined ? {} : { history: rule === null ? "off" as const : { days: rule.days, min: rule.minPerProject } }) }, { ...io, env: childEnv, stderr: notice },
          { home, now, connect, adapters: o.adapters, folderEnv: o.folderEnv, platform: o.folderEnv?.platform }, home, now);
        if (!b.threads.some((t) => t.id.startsWith("import:"))) return null;
        return { plan: b.plan, projects: b.projects, threads: b.threads, autoSettleDays: b.autoSettleDays, history: b.history, off: b.off };
      } finally {
        await api.close();
      }
    },

    // config.json only, under the lock (see saveLanguage).
    async saveOrganize(patch: OrganizePatch) {
      const lock = await acquireLock(dir);
      if (!lock) return false;
      try {
        const c = (await readConfig()) ?? defaultConfig(await resolveAccounts(home, [], io.env));
        await saveConfig(dir, applyOrganizePatch(c, patch), home);
        return true;
      } finally {
        await lock.release();
      }
    },

    async about() {
      const config = await readConfig().catch(() => null);
      const accounts = config ? config.accounts.length : (await resolveAccounts(home, [], io.env).catch(() => [])).length;
      return { version: packageVersion(), accounts };
    },

    // The child prints in the assistant's language and with the terminal's capabilities, on the same terminal: its progress
    // bar is redrawn in place and its result, held projects and failures are shown as `t3sm apply` shows them.
    async run(argv): Promise<RunOutcome> {
      let output = "";
      let locked = false;
      const caps = io.caps && o.noColor ? { ...io.caps, color: 0 as const } : io.caps;
      const tee: Io = {
        ...io, env: childEnv, isTTY: io.isTTY, ...(io.lang ? { lang: io.lang } : {}), ...(caps ? { caps } : {}),
        stdout: (s) => { output += s; io.stdout(s); },
        stderr: (s) => { output += s; io.stderr(s); },
        onLockBusy: () => { locked = true; },
      };
      const code = await o.main(argv, tee);
      return { code, output, locked };
    },
  };
}
