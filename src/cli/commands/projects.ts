// t3sm projects: which account each project folder uses, and the supported way to change it.
//   projects [--json]                     read-only table (T3 Code down: local columns only, exit 0)
//   projects set "<folder>" <account>     exact-folder route in config.json; the T3 project's default (journaled)
//   projects unset "<folder>"             removes that route (T3 Code unchanged)
//   projects rename --suggest             clean titles for t3sm's projects still named as t3sm named them (journaled
//                                         organize changes: `t3sm organize --undo` reverts them)
// set: --dry-run, or no --yes on a non-terminal: exit 0 / 2 before any write.
// Otherwise: lock -> recoverPendingMtimes -> read T3 (optional) -> confirm -> config.json -> T3 default (journaled run).

import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, Plan } from "../../core/types.ts";
import { expandHome, sameCwd, stateDir, tildePath } from "../../core/paths.ts";
import { displayWidth } from "../../ui/text.ts";
import { ConfigError, defaultConfig, loadConfig, organizeSettings, routeAccount, saveConfig } from "../../core/config.ts";
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
import { parseFlags } from "./quarantine.ts";
import { cliT, cliUi, confirm, isCliKey, langOf, type CliUi, usageLine } from "../ui.ts";
import type { Lang } from "../../assistant/i18n.ts";
import type { Column } from "../../ui/components.ts";
import { bulletLines, fitLine, noteLines, tableOrBlocks, textLines } from "../screen.ts";
import { discoverAll, makeEnv } from "./scan.ts";
import { reportLockBusy } from "../locked.ts";
import { applyOrganize } from "../../organize/apply.ts";
import { suggestProjectTitles } from "../../organize/rename.ts";
import type { OrganizeAction, OrganizeKind } from "../../organize/types.ts";
import { resolveGeneralFolder } from "../../plan/categories.ts";
import { shownAccountName, shownText } from "../../plan/names.ts";
import { connectForOrganize, noticeOnce } from "./organize.ts";
import { PROJECTS_FLAGS } from "../flags.ts";
import type { Io } from "../main.ts";

export interface ProjectsDeps {
  home?: string;
  now?: () => number;
  connect?: (home: string, opts: { allowUntested: boolean; manageProviders: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;
  adapters?: SourceAdapter[];
  existsDir?: (p: string) => Promise<boolean>;
  /** How folders compare (case, separators); default: this machine. */
  platform?: NodeJS.Platform;
}

const USAGE_HINT = "Run `t3sm projects --help`.";
/** How `projects set` starts its line when config.json and T3 Code already say so (nothing written), in each language. */
export const NOTHING_TO_CHANGE_MARKS: readonly string[] = [cliT("en", "projects.nothingToChange"), cliT("pt", "projects.nothingToChange")];

interface Ctx { io: Io; home: string; now: () => number; dir: string; connect: NonNullable<ProjectsDeps["connect"]>; deps: ProjectsDeps; allowUntested: boolean; platform: NodeJS.Platform }

export async function projectsCommand(args: string[], io: Io, deps: ProjectsDeps = {}): Promise<number> {
  const sub = args[0] === "set" || args[0] === "unset" || args[0] === "rename" ? args[0] : null;
  const rest = sub ? args.slice(1) : args;
  const positional = rest.filter((a) => !a.startsWith("--"));
  const flags = rest.filter((a) => a.startsWith("--"));
  const allowed = [...PROJECTS_FLAGS[sub ?? "list"]];
  const p = parseFlags(flags, io, "projects", allowed);
  if (!p) return 2;
  const want = sub === "set" ? 2 : sub === "unset" ? 1 : 0;
  if (positional.length !== want || (sub === "rename" && !p.flags.has("--suggest"))) {
    io.stderr(sub === "set" ? `Usage: t3sm projects set "<folder>" <account>. ${USAGE_HINT}\n`
      : sub === "rename" ? `Usage: t3sm projects rename --suggest [--yes | --dry-run]. ${USAGE_HINT}\n`
      : sub === "unset" ? `Usage: t3sm projects unset "<folder>". ${USAGE_HINT}\n`
        : `Unknown argument: ${positional[0]}. ${USAGE_HINT}\n`);
    return 2;
  }
  const home = deps.home ?? homedir();
  const c: Ctx = { io, home, now: deps.now ?? Date.now, dir: stateDir(io.env, home), connect: deps.connect ?? connectT3, deps, allowUntested: p.flags.has("--allow-untested"), platform: deps.platform ?? process.platform };
  try {
    if (sub === "set") return await setProject(c, positional[0]!, positional[1]!, p.flags);
    if (sub === "unset") return await unsetProject(c, positional[0]!, p.flags.has("--dry-run"));
    if (sub === "rename") return await renameProjects(c, p.flags);
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
    rows = projectRows(plan, Object.fromEntries(config.accounts.map((a) => [a.id, shownAccountName(a.displayName)])), null, config);
  }
  if (json) { c.io.stdout(JSON.stringify(rows, null, 2) + "\n"); return 0; }
  c.io.stdout(renderProjects(cliUi(c.io), rows, offline, undefined, c.home).join("\n") + "\n");
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

/**
 * Every project folder t3sm knows as a table: the folder (cut in the middle), the account new threads start on and why,
 * the sessions waiting, whether it is in T3 Code and whether a session of it is in use; then what the reasons mean and
 * how to change an account. With T3 Code closed, a note first and the columns this machine can fill.
 */
export function renderProjects(ui: CliUi, rows: ProjectRow[], offline: boolean, width: number = ui.width, home?: string): string[] {
  const { s, t, f } = ui;
  // The short columns keep their full width (min = natural): the folder is the one that is cut, in the middle.
  const fit = (header: string, cells: string[]): number => Math.max(displayWidth(header), ...cells.map(displayWidth));
  const out: string[] = [];
  if (offline) out.push(...noteLines(s, "warn", t("projects.offline"), width), "");
  if (rows.length === 0) { out.push(...noteLines(s, "ok", t("projects.none"), width)); return out; }
  const yesNo = (b: boolean): string => t(b ? "projects.yes" : "projects.no");
  const inT3 = (x: ProjectRow["inT3"]): string => (x === null ? "-" : x === "yes" ? t("projects.yes") : x === "no" ? t("projects.no") : t("projects.archived"));
  const folder = (r: ProjectRow): string => shownText(home ? tildePath(r.folder, home) : r.folder, 300);
  const account = (r: ProjectRow): string => shownText(r.accountName, 60);
  // The reason in words (the --json keeps the code).
  const why = (r: ProjectRow): string => { const k = `projects.why.${r.reason.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())}`; return isCliKey(k) ? t(k) : shownText(r.reason, 30); };
  const col = (header: string, get: (r: ProjectRow) => string, priority: number, extra: Partial<Column> = {}): Column =>
    ({ header, get: (r) => get(r as ProjectRow), priority, min: fit(header, rows.map(get)), ...extra });
  const cols: Column[] = [
    col(t("projects.col.folder"), folder, 9, { truncate: "middle", min: 16 }),
    col(t("projects.col.account"), account, 8),
    col(t("projects.col.reason"), why, 4),
    col(t(offline ? "projects.col.sessions" : "projects.col.pending"), (r) => f.n(r.pending), 7, { align: "right" }),
    ...(offline ? [] : [col(t("projects.col.inT3"), (r) => inT3(r.inT3), 5)]),
    col(t("projects.col.inUse"), (r) => yesNo(r.held), 3),
  ];
  // A table while every column fits (the folder cut in the middle); narrower, one block per project, nothing dropped.
  out.push(...tableOrBlocks(s, cols, rows, width, { allowMin: true }), "");
  out.push(...textLines(s, t("projects.reasons"), width));
  out.push(...noteLines(s, "info", t("projects.change"), width));
  return out;
}

// ---------------- set / unset ----------------

async function requireConfig(c: Ctx): Promise<Config> {
  const cfg = await loadConfig(c.dir, c.home);
  if (cfg === null) throw new ConfigError(`${join(c.dir, "config.json")} not found. Run \`t3sm plan\` (or \`t3sm accounts --init\`) first.`);
  return cfg;
}

const nameOf = (cfg: Config, id: string | null | undefined, lang: Lang = "en"): string => (id ? ((n) => (n === undefined ? id : shownAccountName(n)))(cfg.accounts.find((a) => a.id === id)?.displayName) : cliT(lang, "projects.noneAccount"));

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
    throw new ConfigError(cliT(io.lang ?? "en", "projects.noAccount", { account: JSON.stringify(account), known: cfg.accounts.map((a) => a.id).join(", ") }));
  }
  const folder = normalizeFolder(rawFolder, c.platform, c.home);
  if (!flags.has("--force") && !(await (c.deps.existsDir ?? isDir)(folder))) {
    throw new ConfigError(cliT(io.lang ?? "en", "projects.noFolder", { folder }));
  }
  if (!dry && !yes && !io.isTTY) {
    io.stderr(`${cliT(io.lang ?? "en", "projects.needsYes")}\n`);
    return 2;
  }
  const ui = cliUi(io);
  const tt = ui.t;
  const name = (id: string | null | undefined): string => nameOf(cfg, id, ui.lang);
  const say = (l: string[]): void => io.stdout(l.join("\n") + "\n");
  const r = setRoute(cfg, folder, account);
  const routeLine = (would: boolean): string => r.previous === null
    ? tt(would ? "projects.route.wouldAdd" : "projects.route.add", { folder, name: name(account), account })
    : tt(would ? "projects.route.wouldChange" : "projects.route.change", { folder, name: name(account), account, was: name(r.before) });
  const describeT3 = (t: T3Part | "no-project" | "no-instance" | null, would: boolean): string | null => {
    if (t === null) return tt("projects.t3.down");
    if (t === "no-project") return tt("projects.t3.noProject");
    if (t === "no-instance") return tt("projects.t3.noInstance", { name: name(account) });
    if (t.current === t.instanceId) return null;
    return tt(would ? "projects.t3.wouldSet" : "projects.t3.set", { title: shownText(t.project.title, 60), name: name(account), was: name(t.current) });
  };
  const keep = tt("projects.keep", { name: name(account) });
  /** Refuses (exit 2) when the new routes would change any other known folder's account; returns the "unknown folder" note. */
  const check = async (api: T3Api | null): Promise<string | null> => {
    const known = await knownRoots(c, api);
    const roots = [...known.roots, ...cfg.routes.filter((x) => !isGlob(x.match)).map((x) => x.match)];
    if (routeAccount(folder, r.config) !== account) throw new ConfigError(tt("projects.stillNot", { folder, name: name(account) }));
    const others = otherFoldersChanged(cfg, r.config, roots, folder);
    if (others.length > 0) throw new ConfigError(othersRefusal(others, ui.lang));
    if (!known.read || known.roots.some((x) => sameCwd(x, folder))) return null;
    return tt("projects.unknownFolder", { folder });
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
    say([
      ...(note ? noteLines(ui.s, "warn", note, ui.width) : []),
      ...noteLines(ui.s, "info", r.changed ? routeLine(true) : tt("projects.route.already"), ui.width),
      ...(t3Line ? noteLines(ui.s, "info", t3Line, ui.width) : []),
      ...noteLines(ui.s, "ok", tt("projects.dryRun"), ui.width),
    ]);
    return 0;
  }

  const lock = await acquireLock(c.dir);
  if (!lock) { reportLockBusy(io); return 0; }
  try {
    const j = new Journal(join(c.dir, "journal.jsonl"));
    const rec = await recoverPendingMtimes(j);
    if (rec.restored.length > 0) io.stderr(`${tt("apply.recovered", { n: rec.restored.length })}\n`);
    const api = await connectOrNull(c);
    try {
      const t = api ? await t3PartOf(api, cfg, c.home, folder, account) : null;
      const note = await check(api);
      if (note) say(noteLines(ui.s, "warn", note, ui.width));
      const t3Write = t !== null && typeof t === "object" && t.current !== t.instanceId ? t : null;
      if (!r.changed && t3Write === null) { say(noteLines(ui.s, "ok", tt("projects.already", { folder, name: name(account) }), ui.width)); return 0; }
      const lines = [...(r.changed ? [routeLine(false)] : []), ...(describeT3(t, false) ? [describeT3(t, false)!] : [])];
      if (!yes) {
        say([...fitLine(ui.s("title", tt("projects.willDo")), ui.width), ...lines.flatMap((l) => bulletLines(ui.s, l, ui.width)), ""]);
        if (!(await confirm(io, tt("projects.confirmSet")))) { io.stdout(`${tt("common.nothingChanged")}\n`); return 0; }
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
      const done = [...(r.changed ? [r.previous === null ? tt("projects.added", { folder, name: name(account) }) : tt("projects.changed", { folder, name: name(account), was: name(r.before) })] : [])];
      if (t3Write && runId) done.push(tt("projects.t3.done", { title: shownText(t3Write.project.title, 60), name: name(account), runId }));
      else { const l = describeT3(t, false); if (l) done.push(l); }
      say([...done.flatMap((l) => noteLines(ui.s, "ok", l, ui.width)), ...textLines(ui.s, keep, ui.width, 2)]);
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
  const folder = normalizeFolder(rawFolder, c.platform, c.home);
  const r = unsetRoute(cfg, folder);
  const ui = cliUi(c.io);
  const say = (tone: "ok" | "info", text: string): void => c.io.stdout(noteLines(ui.s, tone, text, ui.width).join("\n") + "\n");
  if (r.removed === null) { say("ok", ui.t("projects.unset.none", { folder })); return 0; }
  const name = nameOf(cfg, r.removed, ui.lang);
  if (dry) { say("info", ui.t("projects.unset.would", { folder, name })); say("ok", ui.t("projects.dryRun")); return 0; }
  await saveConfig(c.dir, r.config, c.home);
  say("ok", ui.t("projects.unset.done", { folder, name }));
  return 0;
}

// ---------------- rename --suggest ----------------

/** The renames to propose, read from T3 Code and the journal (read-only). */
async function renamePlan(c: Ctx, api: T3Api, j: Journal): Promise<OrganizeAction[]> {
  const cfg = (await loadConfig(c.dir, c.home)) ?? defaultConfig([]);
  const lang = langOf(c.io, cfg.language);
  const projects = await api.listProjects();
  const platform = c.platform;
  return suggestProjectTitles(projects, await j.readAll(), {
    maxLength: organizeSettings(cfg, lang).names.maxLength, platform,
    generalFolder: resolveGeneralFolder(cfg, lang, projects.map((p) => p.workspaceRoot), { platform, home: c.home }),
  });
}

/** The refusal when a new route would move other folders to another account; folders are untrusted text (shownText). */
export function othersRefusal(others: string[], lang: Lang = "en"): string {
  return cliT(lang, "projects.others", { folders: others.map((x) => shownText(x, 120)).join(", ") });
}

/** A title in quotes, as the rename list shows it; untrusted text, so no control characters (shownText). */
const q = (t: unknown): string => `'${shownText(t, 60)}'`;

/** The renames, one per line ('before' -> 'after', the arrows aligned), or the line that says there is none. */
export function renameLines(ui: CliUi, actions: OrganizeAction[], width: number = ui.width): string[] {
  const { s, t } = ui;
  if (actions.length === 0) return noteLines(s, "ok", t("projects.rename.none"), width);
  const w = Math.max(...actions.map((a) => displayWidth(q(a.previous))));
  const out = noteLines(s, "info", t("projects.rename.head", { n: actions.length }), width);
  for (const a of actions) out.push(...bulletLines(s, `${q(a.previous)}${" ".repeat(w - displayWidth(q(a.previous)))} -> ${q(a.next)}`, width));
  return out;
}

async function renameProjects(c: Ctx, flags: Set<string>): Promise<number> {
  const { io } = c;
  const dry = flags.has("--dry-run");
  const yes = flags.has("--yes");
  if (!dry && !yes && !io.isTTY) { usageLine(io, "common.needsYesT3"); return 2; }
  const j = new Journal(join(c.dir, "journal.jsonl"));
  const onNotice = noticeOnce(io);
  // Organize commands: any T3 Code version, one warning (ruling R18).
  const connect = (): Promise<T3Api> => connectForOrganize(c.connect, c.home, c.allowUntested, onNotice);

  const ui = cliUi(io, { now: c.now });
  const say = (l: string[]): void => io.stdout(l.join("\n") + "\n");
  if (dry) {
    const api = await connect();
    try {
      const actions = await renamePlan(c, api, j);
      say(renameLines(ui, actions));
      if (actions.length > 0) say(["", ...noteLines(ui.s, "info", ui.t("projects.rename.dry"), ui.width)]);
    } finally {
      await api.close();
    }
    return 0;
  }

  const lock = await acquireLock(c.dir);
  if (!lock) { reportLockBusy(io); return 0; }
  try {
    const rec = await recoverPendingMtimes(j);
    if (rec.restored.length > 0) io.stderr(`${ui.t("apply.recovered", { n: rec.restored.length })}\n`);
    const api = await connect();
    try {
      const actions = await renamePlan(c, api, j);
      say(renameLines(ui, actions));
      if (actions.length === 0) return 0;
      if (!yes) {
        io.stdout("\n");
        if (!(await confirm(io, ui.t("projects.confirmRename")))) { io.stdout(`${ui.t("common.nothingChanged")}\n`); return 0; }
      }
      const runId = newRunId(new Date(c.now()));
      const counts: Record<OrganizeKind, number> = { archive: 0, title: 0, "ai-title": 0, unsettle: 0, settle: 0, pin: 0, unpin: 0, "project-delete": 0, "project-title": actions.length, "auto-settle": 0 };
      const r = await applyOrganize({ runId, actions, counts, byProject: [] }, {
        api, journal: j, runId, now: c.now, command: "projects rename", allowUntested: true, onNotice, // organizeGate already spoke
      });
      const out: string[] = [];
      for (const f of r.failed) out.push(...noteLines(ui.s, "err", ui.t("projects.rename.failed", { from: q(f.action.previous), to: q(f.action.next), error: shownText(f.error, 200) }), ui.width));
      const parts = [r.done > 0 ? ui.t("projects.rename.done", { n: r.done }) : ui.t("organize.madeNone")];
      if (r.skippedChanged > 0) parts.push(ui.t("projects.rename.leftAlone", { n: r.skippedChanged }));
      if (r.failed.length > 0) parts.push(ui.t("organize.failedCount", { n: r.failed.length }));
      if (r.done > 0) parts.push(ui.t("organize.runUndo", { runId }));
      out.push(...noteLines(ui.s, r.failed.length > 0 ? "warn" : "ok", parts.join(" "), ui.width));
      say(out);
      return r.failed.length > 0 ? 5 : 0;
    } finally {
      await api.close();
    }
  } finally {
    await lock.release();
  }
}
