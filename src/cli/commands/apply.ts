import { homedir, tmpdir } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config, Plan } from "../../core/types.ts";
import { expandHome, normalizeCwd, stateDir, tildePath } from "../../core/paths.ts";
import type { FolderEnv } from "../../plan/folders.ts";
import { shownAccountName, shownText } from "../../plan/names.ts";
import { ConfigError, NoPlanError, defaultConfig, loadConfig } from "../../core/config.ts";
import { allAdapters } from "../../sources/registry.ts";
import { discoverAll, makeEnv } from "./scan.ts";
import { renderTerminalSummary } from "../../plan/report.ts";
import { applyPlan, type ApplyDeps, type ApplyResult, type DryRunReport, type SignalSource } from "../../apply/apply.ts";
import type { T3Api } from "../../t3/api.ts";
import { reportLockBusy } from "../locked.ts";
import { FLAG_SPECS } from "../flags.ts";
import type { Io } from "../main.ts";
import { cliUi, confirm, type CliUi, unknownOption, usageLine } from "../ui.ts";
import { importProgress, renderApplyResult, waitingLines } from "../applyScreen.ts";
import { FAILURES_SHOWN, failureTable } from "../failures.ts";
import { folderName } from "../words.ts";
import { fitLine, snugWidth } from "../screen.ts";
import { kv, panel } from "../../ui/components.ts";
import { displayWidth, padEnd } from "../../ui/text.ts";

export interface ApplyCommandDeps {
  home?: string;
  now?: () => number;
  connect?: (home: string, opts: { allowUntested: boolean; manageProviders: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;
  signals?: SignalSource;
  /** How a rehome destination folder is classified before it is created (default: this machine, as the planner does). */
  folderEnv?: FolderEnv;
  /** How folders compare and are classified; default: this machine. */
  platform?: NodeJS.Platform;
}

const FLAGS = new Set<string>(FLAG_SPECS.apply.bool);
const VALUED = new Set<string>(FLAG_SPECS.apply.valued);


/** The planner's folder classification inputs for `platform` (T3 Code under ~/.t3). */
export function defaultFolderEnv(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): FolderEnv {
  const t3Base = normalizeCwd(expandHome("~/.t3", home), platform);
  return { platform, home, tmpdir: tmpdir(), env, t3BaseDir: t3Base, t3WorktreesDir: `${t3Base}/worktrees` };
}

/** Newest `runs/<runId>/plan.json` (run ids sort by time). */
export async function latestPlan(dir: string): Promise<string | null> {
  let names: string[];
  try { names = await readdir(join(dir, "runs")); } catch { return null; }
  for (const n of names.sort().reverse()) {
    const p = join(dir, "runs", n, "plan.json");
    try { await readFile(p); return p; } catch { /* incomplete run dir */ }
  }
  return null;
}

export async function readPlan(p: string): Promise<Plan> {
  let u: unknown;
  try { u = JSON.parse(await readFile(p, "utf8")); } catch (e) {
    throw new ConfigError(`Could not read the plan ${p} (${(e as NodeJS.ErrnoException).code ?? "invalid JSON"}). Run \`t3sm plan\` again.`);
  }
  const o = u as Partial<Plan> | null;
  if (!o || typeof o !== "object" || o.version !== 1 || !Array.isArray(o.items) || typeof o.createdAt !== "string" || typeof o.t3Version !== "string"
    || !Array.isArray(o.projectsToCreate) || !Array.isArray(o.projectDefaults) || !Array.isArray(o.instancesToCreate) || !Array.isArray(o.mirrorCopies)) {
    throw new ConfigError(`${p} is not a t3sm plan. Run \`t3sm plan\` again.`);
  }
  return o as Plan;
}

/** One line per destination folder a run would create for rehome copies (home shown as ~). */
const folderLines = (ui: CliUi, roots: string[], home: string, platform: NodeJS.Platform): string[] =>
  roots.map((r) => ui.t("apply.willCreateFolder", { path: shownText(tildePath(r, home, platform)) }));

/** The accounts by name (config.json's display names; the plan adds the instances it creates). */
export const accountNames = (config: Config | null): Record<string, string> =>
  Object.fromEntries((config?.accounts ?? []).map((a) => [a.id, shownAccountName(a.displayName)]));

/** `apply --dry-run`: the confirmation's summary, then what a run would do (`waiting` lines under the held row). */
export function renderDryRun(d: DryRunReport, planPath: string, ui: CliUi, waiting: string[], folders: string[], accounts: Record<string, string> = {}): string {
  const { s, t, f } = ui;
  const width = Math.max(1, ui.width);
  const L: string[] = [renderTerminalSummary(d.plan, { planPath, ui, names: accounts }).trimEnd()];
  const names = (xs: string[]): string => (xs.length ? ` (${xs.map((x) => shownText(x, 60)).join(", ")})` : "");
  const nameOf = (id: string): string => { const n = d.plan.instancesToCreate.find((i) => i.id === id)?.displayName; return n !== undefined ? shownAccountName(n) : accounts[id] ?? id; };
  const held = d.held.roots.length > 0 ? ` (${d.held.roots.map((r) => shownText(folderName(r), 60)).join(", ")}; ${t("apply.notThisRun")})` : "";
  const rows: [string, string][] = [
    [t("apply.dry.instances"), `${f.n(d.instancesToCreate.length)}${names(d.instancesToCreate.map(nameOf))}`],
    [t("apply.dry.pin"), d.pinDefault ? `${shownText(nameOf("claudeAgent"), 60)} ${s.sym.arrow} ${shownText(d.pinDefault, 120)}` : t("apply.dry.none")],
    [t("apply.dry.folders"), f.n(d.foldersToCreate.length)],
    [t("apply.dry.projects"), `${f.n(d.projectsToCreate.length)}${names(d.projectsToCreate.map(folderName))}`],
    [t("apply.dry.defaults"), f.n(d.defaultsToSet.length)],
    [t("apply.dry.conversions"), f.n(d.conversions)],
    [t("apply.dry.waves"), t("apply.dry.wavesValue", { n: d.waves, sessions: d.waveSessions })],
    [t("apply.dry.already"), f.n(d.alreadyInT3)],
    [t("apply.dry.held"), t("apply.dry.heldValue", { n: d.held.roots.length, sessions: d.held.sessions }) + held],
    [t("apply.dry.failUpFront"), f.n(d.failUpFront.length)],
  ];
  // One kv call per row, every label padded to the widest: the rows stay aligned and the extra lines go under theirs.
  const lw = Math.max(...rows.map(([k]) => displayWidth(k)));
  const body: string[] = [];
  for (const [k, v] of rows) {
    body.push(...kv(s, [[padEnd(k, lw), v]], Math.max(1, width - 4)));
    if (k === t("apply.dry.held")) for (const x of waiting) body.push(`  ${x}`);
    if (k === t("apply.dry.folders")) for (const x of folders) body.push(`  ${x}`);
  }
  L.push("", ...panel(s, { title: t("apply.dry.title"), body }, snugWidth(t("apply.dry.title"), body, width)));
  if (d.failUpFront.length > 0) L.push("", ...failureTable(ui, d.failUpFront, width, { dry: true }));
  if (d.pendingRecovery.length > 0) L.push("", ...fitLine(`${s("warn", s.sym.warn)} ${t("apply.dry.pendingRecovery", { n: d.pendingRecovery.length })}`, width, 2));
  L.push("", ...fitLine(t("apply.dry.done"), width));
  return L.join("\n") + "\n";
}

export async function applyCommand(args: string[], io: Io, deps: ApplyCommandDeps = {}): Promise<number> {
  const flags = new Set<string>();
  let planPath: string | null = null;
  let only: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (VALUED.has(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) { usageLine(io, "common.needsValue", { option: a, help: "t3sm apply --help" }); return 2; }
      if (a === "--plan") planPath = v; else only = resolve(v);
      i++;
    } else if (FLAGS.has(a)) flags.add(a);
    else { unknownOption(io, a, "apply"); return 2; }
  }
  const yes = flags.has("--yes");
  const quiet = flags.has("--quiet");
  const dryRun = flags.has("--dry-run");
  if (yes && dryRun) { usageLine(io, "common.eitherDryRunOrYes"); return 2; }
  if (!yes && !dryRun && !io.isTTY) { usageLine(io, "common.needsYesT3"); return 2; }

  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const dir = stateDir(io.env, home);
  const ui = cliUi(io, { now });
  let shownPath = "";
  // Read under the lock (inside applyPlan): a held lock wins over a missing or stale plan (exit 0, nothing touched).
  const load = async (): Promise<Plan> => {
    const p = planPath ?? (await latestPlan(dir));
    if (p === null) throw new NoPlanError();
    shownPath = p.replace(/plan\.json$/, "plan.md");
    return readPlan(p);
  };

  const config = await loadConfig(dir, home);
  const out = (s: string): void => { if (!quiet) io.stdout(s); };
  const bar = importProgress(io, ui, now, { silent: quiet, verbose: flags.has("--verbose") });
  const names = accountNames(config);
  const applyDeps: ApplyDeps = {
    stateDir: dir, home, now, connect: deps.connect, signals: deps.signals,
    allowUntested: flags.has("--allow-untested"), only, dryRun,
    // An interactive apply creates a missing General / override destination folder (never sync: invariant 13).
    rehomeFolders: { env: deps.folderEnv ?? defaultFolderEnv(home, io.env, platform) }, platform,
    batch: config?.batch,
    // Titles are read only for the failures the screen shows (none with --quiet).
    failureTitles: quiet ? 0 : FAILURES_SHOWN,
    onImportStart: (n) => bar.onImportStart(n),
    onWave: (p) => bar.onWave(p),
    onProgress: (l) => bar.onProgress(l),
    // Codex / Pi transcripts created after planning (Claude's are listed directly from the instance homes). A dry run
    // reads them with the read-only env (no discovery cache written).
    rediscover: async () => (await discoverAll(allAdapters().filter((a) => a.id !== "claude"), { ...makeEnv(io, home, config ?? defaultConfig([]), now), readOnly: dryRun })).sessions,
    onNotice: (l) => { if (!bar.note(l)) io.stderr(`${l}\n`); }, lang: ui.lang,
    accountHomes: () => Object.fromEntries((config?.accounts ?? []).map((a) => [a.id, expandHome(a.home, home)])),
    confirm: yes || dryRun ? undefined : async (plan, held, extra) => {
      io.stdout(renderTerminalSummary(plan, { planPath: shownPath, ui, names, held }));
      for (const l of folderLines(ui, extra.foldersToCreate, home, platform)) io.stdout(`${l}\n`);
      return confirm(io, ui.t("apply.confirm"));
    },
  };
  let r: ApplyResult;
  try {
    r = await applyPlan(load, applyDeps);
    bar.end();
  } finally {
    bar.dispose();
  }
  if (r.status === "locked") { reportLockBusy(io, quiet); return 0; } // --quiet: silent, like sync
  if (r.status === "declined") { io.stdout(`${ui.t("common.nothingChanged")}\n`); return 0; }
  if (r.status === "dry-run" && r.dryRun) {
    io.stdout(renderDryRun(r.dryRun, shownPath, ui, waitingLines(ui, r.held, Math.max(1, ui.width - 6)), folderLines(ui, r.dryRun.foldersToCreate, home, platform), names));
    return 0;
  }
  const rec = r.recovered;
  if (rec && rec.restored.length > 0) io.stderr(`${ui.t("apply.recovered", { n: rec.restored.length })}\n`);
  if (rec && rec.failed.length > 0) io.stderr(`${ui.t("apply.recoverFailed", { n: rec.failed.length })}\n`);

  if (r.status === "aborted" && r.runId === null) { io.stderr(`${ui.t("apply.interruptedBefore")}\n`); return 130; }

  out(renderApplyResult(ui, r).join("\n") + "\n");
  if (r.restoreErrors.length > 0) {
    io.stderr(`${ui.t("apply.restoreWarning", { n: r.restoreErrors.length, path: r.restoreErrors[0]!.path, error: r.restoreErrors[0]!.error })}\n`);
  }
  if (r.unverified > 0) io.stderr(`${ui.t("apply.unverifiedStop")}\n`);
  if (r.status === "aborted") { io.stderr(`${ui.t("apply.interrupted")}\n`); return 130; }
  return r.failed > 0 || r.unverified > 0 || r.restoreErrors.length > 0 ? 5 : 0;
}
