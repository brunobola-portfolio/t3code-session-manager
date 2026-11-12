// t3sm projects: which account each project folder uses, and the supported way to change it.
//   projects [--json]                     read-only table (T3 Code down: local columns only, exit 0)
//   projects set "<folder>" <account>     exact-folder route in config.json; the T3 project's default (journaled)
//   projects unset "<folder>"             removes that route (T3 Code unchanged)
// set: --dry-run, or no --yes on a non-terminal: exit 0 / 2 before any write.
// Otherwise: lock -> recoverPendingMtimes -> read T3 (optional) -> confirm -> config.json -> T3 default (journaled run).

import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, Plan } from "../../core/types.ts";
import { expandHome, sameCwd, stateDir } from "../../core/paths.ts";
import { ConfigError, defaultConfig, loadConfig, routeAccount, saveConfig } from "../../core/config.ts";
import { Journal, newRunId, recoverPendingMtimes } from "../../core/journal.ts";
import { acquireLock } from "../../core/lock.ts";
import { applyProjectDefaults } from "../../ops/accounts.ts";
import { resolveAccounts } from "../../ops/discoverAccounts.ts";
import { isGlob, normalizeFolder, otherFoldersChanged, projectRows, setRoute, unsetRoute, type ProjectRow } from "../../ops/projects.ts";
import { latestPlan, readPlan } from "./apply.ts";
import { buildPlan } from "../../plan/planner.ts";
import { allAdapters } from "../../sources/registry.ts";
import type { SourceAdapter } from "../../sources/types.ts";
import { connectT3, type T3Api, type T3Project } from "../../t3/api.ts";
import { T3NotRunning } from "../../t3/errors.ts";
import { freshPlan, isDir } from "./plan.ts";
import { confirm, parseFlags } from "./quarantine.ts";
import { discoverAll, makeEnv } from "./scan.ts";
import { reportLockBusy } from "../locked.ts";
import type { Io } from "../main.ts";

export interface ProjectsDeps {
  home?: string;
  now?: () => number;
  connect?: (home: string, opts: { allowUntested: boolean; manageProviders: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;
  adapters?: SourceAdapter[];
  existsDir?: (p: string) => Promise<boolean>;
}

const USAGE_HINT = "Run `t3sm projects --help`.";
/** How `projects set` starts its line when config.json and T3 Code already say so (nothing written). */
export const NOTHING_TO_CHANGE = "Nothing to change";

interface Ctx { io: Io; home: string; now: () => number; dir: string; connect: NonNullable<ProjectsDeps["connect"]>; deps: ProjectsDeps; allowUntested: boolean }

export async function projectsCommand(args: string[], io: Io, deps: ProjectsDeps = {}): Promise<number> {
  const sub = args[0] === "set" || args[0] === "unset" ? args[0] : null;
  const rest = sub ? args.slice(1) : args;
  const positional = rest.filter((a) => !a.startsWith("--"));
  const flags = rest.filter((a) => a.startsWith("--"));
  const allowed = sub === "set" ? ["--yes", "--dry-run", "--force", "--allow-untested"] : sub === "unset" ? ["--dry-run"] : ["--json", "--allow-untested"];
  const p = parseFlags(flags, io, "projects", allowed);
  if (!p) return 2;
  const want = sub === "set" ? 2 : sub === "unset" ? 1 : 0;
  if (positional.length !== want) {
    io.stderr(sub === "set" ? `Usage: t3sm projects set "<folder>" <account>. ${USAGE_HINT}\n`
      : sub === "unset" ? `Usage: t3sm projects unset "<folder>". ${USAGE_HINT}\n`
        : `Unknown argument: ${positional[0]}. ${USAGE_HINT}\n`);
    return 2;
  }
  const home = deps.home ?? homedir();
  const c: Ctx = { io, home, now: deps.now ?? Date.now, dir: stateDir(io.env, home), connect: deps.connect ?? connectT3, deps, allowUntested: p.flags.has("--allow-untested") };
  try {
    if (sub === "set") return await setProject(c, positional[0]!, positional[1]!, p.flags);
    if (sub === "unset") return await unsetProject(c, positional[0]!, p.flags.has("--dry-run"));
    return await listProjects(c, p.flags.has("--json"));
  } catch (e) {
    if (e instanceof ConfigError) { io.stderr(`${e.message}\n`); return 2; }
    throw e;
  }
}

// ---------------- list ----------------

async function listProjects(c: Ctx, json: boolean): Promise<number> {
  let rows: ProjectRow[];
  let offline = false;
  let api: T3Api | null = null;
  try {
    api = await c.connect(c.home, { allowUntested: c.allowUntested, manageProviders: false, onNotice: (l) => c.io.stderr(`${l}\n`) });
  } catch (e) {
    if (!(e instanceof T3NotRunning)) throw e;
  }
  if (api) {
    try {
      // Read-only: no config.json saved, no discovery cache written.
      const f = await freshPlan(api, { home: c.home, env: c.io.env, now: c.now, adapters: c.deps.adapters, existsDir: c.deps.existsDir, missingConfig: "memory", readOnly: true });
      rows = projectRows(f.plan, f.names, f.projects, f.config);
    } finally {
      await api.close();
    }
  } else {
    offline = true;
    const { plan, config } = await offlinePlan(c);
    rows = projectRows(plan, Object.fromEntries(config.accounts.map((a) => [a.id, a.displayName])), null, config);
  }
  if (json) { c.io.stdout(JSON.stringify(rows, null, 2) + "\n"); return 0; }
  c.io.stdout(renderRows(rows, offline));
  return 0;
}

/**
 * T3 Code not running: the plan built against an empty T3 Code (nothing read from it). Account and reason are the same
 * as with T3 Code; "pending" counts the sessions found, since what T3 Code already holds is unknown.
 */
async function offlinePlan(c: Ctx): Promise<{ plan: Plan; config: Config }> {
  const config = (await loadConfig(c.dir, c.home)) ?? defaultConfig(await resolveAccounts(c.home, [], c.io.env));
  const { sessions } = await discoverAll(c.deps.adapters ?? allAdapters(), { ...makeEnv(c.io, c.home, config, c.now), readOnly: true });
  const journal = await new Journal(join(c.dir, "journal.jsonl")).readAll().catch(() => []);
  const plan = await buildPlan({
    sessions, config, journal, now: c.now(), runId: "offline", home: c.home, existsDir: c.deps.existsDir ?? isDir,
    t3: {
      version: "-", projects: [], threads: [],
      instances: config.accounts.map((a) => ({ id: a.id, driver: "claudeAgent" as const, displayName: a.displayName, accentColor: a.accentColor, homePath: expandHome(a.home, c.home), environment: [] })),
      // Assume T3 Code's own Codex and Pi instances exist, so their sessions count too.
      providers: [{ instanceId: "codex", driver: "codex" }, { instanceId: "pi", driver: "pi" }],
    },
  });
  return { plan, config };
}

function renderRows(rows: ProjectRow[], offline: boolean): string {
  const L: string[] = [];
  if (offline) L.push("T3 Code is not running: showing what this machine knows (sessions found, not what T3 Code already holds). Open T3 Code for the full table.", "");
  if (rows.length === 0) { L.push("No projects found."); return L.join("\n") + "\n"; }
  const head = offline ? ["Folder", "Account", "Reason", "Sessions", "In use"] : ["Folder", "Account", "Reason", "Pending", "In T3 Code", "In use"];
  const body = rows.map((r) => offline
    ? [r.folder, r.accountName, r.reason, String(r.pending), r.held ? "yes" : "no"]
    : [r.folder, r.accountName, r.reason, String(r.pending), r.inT3 ?? "-", r.held ? "yes" : "no"]);
  const all = [head, ...body];
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  const numeric = 3;
  for (const r of all) L.push(r.map((x, i) => (i === numeric && r !== head ? x.padStart(w[i]!) : x.padEnd(w[i]!))).join("  ").trimEnd());
  L.push("", "Reason: route (config.json), vscode-pin (.vscode/settings.json), recent-activity (most recent session), default (defaultAccount).");
  L.push("Change one with `t3sm projects set \"<folder>\" <account>`.");
  return L.join("\n") + "\n";
}

// ---------------- set / unset ----------------

async function requireConfig(c: Ctx): Promise<Config> {
  const cfg = await loadConfig(c.dir, c.home);
  if (cfg === null) throw new ConfigError(`${join(c.dir, "config.json")} not found. Run \`t3sm plan\` (or \`t3sm accounts --init\`) first.`);
  return cfg;
}

const nameOf = (cfg: Config, id: string | null | undefined): string => (id ? cfg.accounts.find((a) => a.id === id)?.displayName ?? id : "none");

interface T3Part { api: T3Api; project: T3Project; instanceId: string; current: string | null }

/** The T3 project for `folder` and the instance of `account` (null when either is missing). Read-only. */
async function t3PartOf(api: T3Api, cfg: Config, home: string, folder: string, account: string): Promise<T3Part | "no-project" | "no-instance"> {
  const project = (await api.listProjects()).find((p) => !p.deleted && sameCwd(p.workspaceRoot, folder));
  if (!project) return "no-project";
  const acct = cfg.accounts.find((a) => a.id === account)!;
  const inst = (await api.providerInstances()).find((i) => i.driver === "claudeAgent" && i.homePath !== null && sameCwd(i.homePath, expandHome(acct.home, home)));
  if (!inst) return "no-instance";
  const cur = project.defaultModelSelection?.instanceId;
  return { api, project, instanceId: inst.instanceId, current: typeof cur === "string" ? cur : null };
}

async function setProject(c: Ctx, rawFolder: string, account: string, flags: Set<string>): Promise<number> {
  const { io } = c;
  const dry = flags.has("--dry-run");
  const yes = flags.has("--yes");
  const cfg = await requireConfig(c);
  if (!cfg.accounts.some((a) => a.id === account)) {
    throw new ConfigError(`No account ${JSON.stringify(account)} in config.json (known: ${cfg.accounts.map((a) => a.id).join(", ")}). Run \`t3sm accounts\` to list them.`);
  }
  const folder = normalizeFolder(rawFolder, process.platform, c.home);
  if (!flags.has("--force") && !(await (c.deps.existsDir ?? isDir)(folder))) {
    throw new ConfigError(`The folder ${folder} does not exist. Check the spelling, or pass --force to add the route anyway.`);
  }
  if (!dry && !yes && !io.isTTY) {
    io.stderr("Refusing to change config.json and T3 Code without confirmation: pass --yes (non-interactive), or --dry-run to only show the change.\n");
    return 2;
  }
  const r = setRoute(cfg, folder, account);
  const routeLine = (would: boolean): string => r.previous === null
    ? `${would ? "Would add" : "Add"} a route in config.json: ${folder} -> ${nameOf(cfg, account)} (${account}).`
    : `${would ? "Would change" : "Change"} the route in config.json: ${folder} -> ${nameOf(cfg, account)} (${account}), was ${nameOf(cfg, r.before)}.`;
  const describeT3 = (t: T3Part | "no-project" | "no-instance" | null, would: boolean): string | null => {
    if (t === null) return "T3 Code is not running: only the route is saved. The next `t3sm apply` sets the project's default account.";
    if (t === "no-project") return "This folder is not a T3 Code project yet: the route applies when `t3sm apply` creates it.";
    if (t === "no-instance") return `${nameOf(cfg, account)} has no instance in T3 Code yet: \`t3sm accounts --apply\` (or \`t3sm apply\`) creates it and sets the default.`;
    if (t.current === t.instanceId) return null;
    return `${would ? "Would set" : "Set"} T3 Code project "${t.project.title}" to open new threads with ${nameOf(cfg, account)} (was ${nameOf(cfg, t.current)}).`;
  };
  const keep = `Threads already in T3 Code keep their account. New threads here start on ${nameOf(cfg, account)}, and OpenCode / compressed Codex sessions not imported yet go to it; Claude Code sessions keep the account they were recorded in.`;
  /** Refuses (exit 2) when the new routes would change any other known folder's account; returns the "unknown folder" note. */
  const check = async (api: T3Api | null): Promise<string | null> => {
    const known = await knownRoots(c, api);
    const roots = [...known.roots, ...cfg.routes.filter((x) => !isGlob(x.match)).map((x) => x.match)];
    if (routeAccount(folder, r.config) !== account) throw new ConfigError(`Refusing: ${folder} would still not use ${nameOf(cfg, account)} with these routes. Edit routes in config.json by hand.`);
    const others = otherFoldersChanged(cfg, r.config, roots, folder);
    if (others.length > 0) throw new ConfigError(`Refusing: this route would also change the account of ${others.join(", ")}. Edit routes in config.json by hand.`);
    if (!known.read || known.roots.some((x) => sameCwd(x, folder))) return null;
    return `Note: ${folder} is not a project folder t3sm knows (not in T3 Code or in the latest plan). A route applies to that exact folder only, not to its sub-folders.`;
  };

  if (dry) {
    let t: T3Part | "no-project" | "no-instance" | null = null;
    let note: string | null = null;
    const api = await connectOrNull(c);
    try {
      if (api) t = await t3PartOf(api, cfg, c.home, folder, account);
      note = await check(api);
    } finally { await api?.close(); }
    const t3Line = describeT3(t, true);
    io.stdout([...(note ? [note] : []), r.changed ? routeLine(true) : "The route is already set.", ...(t3Line ? [t3Line] : []), "Dry run: nothing was written."].join("\n") + "\n");
    return 0;
  }

  const lock = await acquireLock(c.dir);
  if (!lock) { reportLockBusy(io); return 0; }
  try {
    const j = new Journal(join(c.dir, "journal.jsonl"));
    const rec = await recoverPendingMtimes(j);
    if (rec.restored.length > 0) io.stderr(`Restored the file times of ${rec.restored.length} transcript(s) left by an interrupted run.\n`);
    const api = await connectOrNull(c);
    try {
      const t = api ? await t3PartOf(api, cfg, c.home, folder, account) : null;
      const note = await check(api);
      if (note) io.stdout(`${note}\n`);
      const t3Write = t !== null && typeof t === "object" && t.current !== t.instanceId ? t : null;
      if (!r.changed && t3Write === null) { io.stdout(`${NOTHING_TO_CHANGE}: ${folder} already uses ${nameOf(cfg, account)}.\n`); return 0; }
      const lines = [...(r.changed ? [routeLine(false)] : []), ...(describeT3(t, false) ? [describeT3(t, false)!] : [])];
      if (!yes) {
        io.stdout(`This will:\n${lines.map((l) => `  - ${l}`).join("\n")}\n`);
        if (!(await confirm(io, "Apply?"))) { io.stdout("Nothing changed.\n"); return 0; }
      }
      if (r.changed) await saveConfig(c.dir, r.config, c.home);
      let runId: string | null = null;
      if (t3Write) {
        runId = newRunId(new Date(c.now()));
        await j.append({ t: "run-start", runId, at: new Date(c.now()).toISOString(), command: "projects set" });
        try {
          await applyProjectDefaults(t3Write.api, [{ projectId: t3Write.project.id, instanceId: t3Write.instanceId }], j, runId);
        } catch (e) {
          await j.append({ t: "run-end", runId, at: new Date(c.now()).toISOString(), status: "aborted" }).catch(() => {});
          throw e;
        }
        await j.append({ t: "run-end", runId, at: new Date(c.now()).toISOString(), status: "ok" });
      }
      const done = [...(r.changed ? [r.previous === null ? `Added the route ${folder} -> ${nameOf(cfg, account)} to config.json.` : `Changed the route of ${folder} to ${nameOf(cfg, account)} (was ${nameOf(cfg, r.before)}).`] : [])];
      if (t3Write && runId) done.push(`T3 Code project "${t3Write.project.title}" now opens new threads with ${nameOf(cfg, account)}. Run ${runId}; undo the T3 Code part with \`t3sm rollback --run ${runId}\`.`);
      else { const l = describeT3(t, false); if (l) done.push(l); }
      done.push(keep);
      io.stdout(done.join("\n") + "\n");
      return 0;
    } finally {
      await api?.close();
    }
  } finally {
    await lock.release();
  }
}

/**
 * Project folders t3sm knows: T3 Code's projects (when connected) and the latest plan's project table. `read`: at least
 * one of the two could be read. Read-only.
 */
async function knownRoots(c: Ctx, api: T3Api | null): Promise<{ roots: string[]; read: boolean }> {
  const roots: string[] = [];
  let read = false;
  if (api) { roots.push(...(await api.listProjects()).filter((p) => !p.deleted).map((p) => p.workspaceRoot)); read = true; }
  try {
    const p = await latestPlan(c.dir);
    if (p !== null) { roots.push(...(await readPlan(p)).projectAccounts.map((x) => x.root)); read = true; }
  } catch { /* an unreadable plan is not this command's problem */ }
  return { roots, read };
}

/** A T3 session, or null when T3 Code is not running (every other error is thrown: exit 4, 1, ...). */
async function connectOrNull(c: Ctx): Promise<T3Api | null> {
  try {
    return await c.connect(c.home, { allowUntested: c.allowUntested, manageProviders: false, onNotice: (l) => c.io.stderr(`${l}\n`) });
  } catch (e) {
    if (e instanceof T3NotRunning) return null;
    throw e;
  }
}

async function unsetProject(c: Ctx, rawFolder: string, dry: boolean): Promise<number> {
  const cfg = await requireConfig(c);
  const folder = normalizeFolder(rawFolder, process.platform, c.home);
  const r = unsetRoute(cfg, folder);
  if (r.removed === null) { c.io.stdout(`No route for ${folder} in config.json (routes with wildcards are edited in config.json itself).\n`); return 0; }
  if (dry) { c.io.stdout(`Would remove the route ${folder} -> ${nameOf(cfg, r.removed)} from config.json.\nDry run: nothing was written.\n`); return 0; }
  await saveConfig(c.dir, r.config, c.home);
  c.io.stdout(`Removed the route ${folder} -> ${nameOf(cfg, r.removed)} from config.json. T3 Code was not changed: the project keeps its default account until you change it (\`t3sm projects set\`) or in T3 Code.\n`);
  return 0;
}
