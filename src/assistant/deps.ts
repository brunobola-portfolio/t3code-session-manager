// The guided assistant's real dependencies: thin wrappers over t3sm's own functions and commands. Reads call the
// functions behind doctor, accounts, plan, quarantine / dedupe (dry run), runs and schedule status; every write runs
// one of t3sm's commands (`run`), so each keeps its own lock, journal, checks and Ctrl+C handling.

import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { ConfigError, defaultConfig, detectAccounts, loadConfig, saveConfig } from "../core/config.ts";
import { Journal } from "../core/journal.ts";
import { acquireLock, lockInfo } from "../core/lock.ts";
import { expandHome, sameCwd, stateDir, tildePath } from "../core/paths.ts";
import { pidAlive } from "../core/pid.ts";
import type { Plan } from "../core/types.ts";
import { discoverAccountHomes, nodeDiscoveryEnv } from "../ops/discoverAccounts.ts";
import { defaultDoctorDeps, maskEmail, runDoctor } from "../ops/doctor.ts";
import { dedupe, findBackupDirs, quarantine } from "../ops/quarantine.ts";
import { listRuns } from "../ops/rollback.ts";
import { connectT3, type T3Api } from "../t3/api.ts";
import { writeFreshPlan } from "../cli/commands/plan.ts";
import { accountsOf } from "../cli/commands/quarantine.ts";
import { latestPlan } from "../cli/commands/apply.ts";
import type { SourceAdapter } from "../sources/types.ts";
import type { Io } from "../cli/main.ts";
import type { AccountRow, AssistantDeps, RunOutcome } from "./core.ts";
import { isLang, wrap, type Lang } from "./i18n.ts";

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
}

export function realAssistantDeps(io: Io, o: RealDepsOptions): AssistantDeps {
  const home = o.home ?? homedir();
  const now = o.now ?? Date.now;
  const dir = stateDir(io.env, home);
  const journal = new Journal(join(dir, "journal.jsonl"));
  const childEnv = o.noColor ? { ...io.env, NO_COLOR: "1" } : io.env;
  const readConfig = () => loadConfig(dir, home);
  const connect = o.connect ?? connectT3;
  // Notices from the read steps: each shown once, wrapped to 80 columns. The "not tested exactly" version notice is left
  // out: step 2 says it once, in the user's language.
  const seen = new Set<string>();
  const notice = (l: string): void => {
    const s = l.replace(/\n+$/, "");
    if (s === "" || seen.has(s) || /was not tested exactly/.test(s)) return;
    seen.add(s);
    io.stderr(wrap(s).join("\n") + "\n");
  };

  return {
    home,
    print: (s) => io.stdout(s),
    prompt: (q) => io.prompt(q),

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
      const hasPlan = (await latestPlan(dir)) !== null;
      try {
        const c = await readConfig();
        return { exists: c !== null, language: c && isLang(c.language) ? c.language : null, hasPlan };
      } catch (e) {
        if (e instanceof ConfigError) return { exists: true, language: null, hasPlan }; // doctor reports it
        throw e;
      }
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

    async plan(allowUntested) {
      const r = await writeFreshPlan({ ...io, env: childEnv, stderr: notice }, { home, now, connect, adapters: o.adapters }, allowUntested);
      return { plan: r.plan, names: r.names, planPath: r.planPath, config: r.config };
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

    async run(argv): Promise<RunOutcome> {
      let output = "";
      let locked = false;
      const tee: Io = {
        ...io, env: childEnv,
        stdout: (s) => { output += s; io.stdout(s); },
        stderr: (s) => { output += s; io.stderr(s); },
        onLockBusy: () => { locked = true; },
      };
      const code = await o.main(argv, tee);
      return { code, output, locked };
    },
  };
}
