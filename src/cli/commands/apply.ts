import { homedir } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Plan } from "../../core/types.ts";
import { expandHome, stateDir } from "../../core/paths.ts";
import { ConfigError, defaultConfig, loadConfig } from "../../core/config.ts";
import { allAdapters } from "../../sources/registry.ts";
import { discoverAll, makeEnv } from "./scan.ts";
import { renderTerminalSummary } from "../../plan/report.ts";
import { applyPlan, type ApplyDeps, type DryRunReport, type SignalSource } from "../../apply/apply.ts";
import type { T3Api } from "../../t3/api.ts";
import { reportLockBusy } from "../locked.ts";
import type { Io } from "../main.ts";

export interface ApplyCommandDeps {
  home?: string;
  now?: () => number;
  connect?: (home: string, opts: { allowUntested: boolean; manageProviders: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;
  signals?: SignalSource;
}

const FLAGS = new Set(["--yes", "--allow-untested", "--quiet", "--dry-run"]);

/** A project root's last folder name (what the user knows the project by). */
const baseName = (root: string): string => root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || root;

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

/** `apply --dry-run`: the confirmation's summary, then what a run would do. */
function renderDryRun(d: DryRunReport, planPath: string, io: Io): string {
  const L: string[] = [renderTerminalSummary(d.plan, { color: io.isTTY && !io.env["NO_COLOR"], planPath }).trimEnd()];
  if (d.held.roots.length > 0) L.push(`held: in use: ${d.held.roots.map(baseName).join(", ")} (${d.held.sessions} session${d.held.sessions === 1 ? "" : "s"}; not part of this run)`);
  const rows: [string, string][] = [
    ["instances to create", `${d.instancesToCreate.length}${d.instancesToCreate.length ? ` (${d.instancesToCreate.join(", ")})` : ""}`],
    ["default instance pin", d.pinDefault ? `claudeAgent -> ${d.pinDefault}` : "none"],
    ["projects to create", `${d.projectsToCreate.length}${d.projectsToCreate.length ? ` (${d.projectsToCreate.map(baseName).join(", ")})` : ""}`],
    ["project defaults to set", String(d.defaultsToSet.length)],
    ["conversions to write", String(d.conversions)],
    ["import waves", `${d.waves} (${d.waveSessions} session${d.waveSessions === 1 ? "" : "s"})`],
    ["already in T3 Code", String(d.alreadyInT3)],
    ["held (in use)", `${d.held.roots.length} project${d.held.roots.length === 1 ? "" : "s"}, ${d.held.sessions} session${d.held.sessions === 1 ? "" : "s"}`],
    ["would fail up front", String(d.failUpFront.length)],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  L.push("", "Would do:", ...rows.map(([k, v]) => `  ${k.padEnd(w)}  ${v}`));
  for (const f of d.failUpFront.slice(0, 20)) L.push(`    ${f.reason}: ${f.harness} ${f.nativeId}`);
  if (d.failUpFront.length > 20) L.push(`    ... and ${d.failUpFront.length - 20} more`);
  if (d.pendingRecovery.length > 0) {
    const n = d.pendingRecovery.length;
    L.push("", `Note: ${n} transcript file time${n === 1 ? "" : "s"} left bumped by an interrupted run; a real apply restores ${n === 1 ? "it" : "them"} first.`);
  }
  L.push("", "Dry run: nothing was written. Run `t3sm apply` to do it.");
  return L.join("\n") + "\n";
}

export async function applyCommand(args: string[], io: Io, deps: ApplyCommandDeps = {}): Promise<number> {
  const flags = new Set<string>();
  let planPath: string | null = null;
  let only: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--plan" || a === "--only") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) { io.stderr(`${a} needs a value. Run \`t3sm apply --help\`.\n`); return 2; }
      if (a === "--plan") planPath = v; else only = resolve(v);
      i++;
    } else if (FLAGS.has(a)) flags.add(a);
    else { io.stderr(`Unknown option: ${a}. Run \`t3sm apply --help\`.\n`); return 2; }
  }
  const yes = flags.has("--yes");
  const quiet = flags.has("--quiet");
  const dryRun = flags.has("--dry-run");
  if (yes && dryRun) { io.stderr("Use either --dry-run or --yes.\n"); return 2; }
  if (!yes && !dryRun && !io.isTTY) {
    io.stderr("Refusing to change T3 Code without confirmation: pass --yes (non-interactive).\n");
    return 2;
  }

  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const dir = stateDir(io.env, home);
  let shownPath = "";
  // Read under the lock (inside applyPlan): a held lock wins over a missing or stale plan (exit 0, nothing touched).
  const load = async (): Promise<Plan> => {
    const p = planPath ?? (await latestPlan(dir));
    if (p === null) throw new ConfigError("No plan found. Run `t3sm plan` first.");
    shownPath = p.replace(/plan\.json$/, "plan.md");
    return readPlan(p);
  };

  const config = await loadConfig(dir, home);
  const out = (s: string): void => { if (!quiet) io.stdout(s); };
  const applyDeps: ApplyDeps = {
    stateDir: dir, home, now, connect: deps.connect, signals: deps.signals,
    allowUntested: flags.has("--allow-untested"), only, dryRun,
    batch: config?.batch,
    onProgress: (l) => out(`${l}\n`),
    // Codex / Pi transcripts created after planning (Claude's are listed directly from the instance homes). A dry run
    // reads them with the read-only env (no discovery cache written).
    rediscover: async () => (await discoverAll(allAdapters().filter((a) => a.id !== "claude"), { ...makeEnv(io, home, config ?? defaultConfig([]), now), readOnly: dryRun })).sessions,
    onNotice: (l) => io.stderr(`${l}\n`),
    accountHomes: () => Object.fromEntries((config?.accounts ?? []).map((a) => [a.id, expandHome(a.home, home)])),
    confirm: yes || dryRun ? undefined : async (plan, held) => {
      io.stdout(renderTerminalSummary(plan, { color: io.isTTY && !io.env["NO_COLOR"], planPath: shownPath }));
      if (held.roots.length > 0) io.stdout(`held: in use: ${held.roots.map(baseName).join(", ")} (${held.sessions} session${held.sessions === 1 ? "" : "s"}; not part of this run)\n`);
      const ans = (await io.prompt("Apply this plan? Type yes to continue: ")).trim().toLowerCase();
      return ans === "yes" || ans === "y";
    },
  };
  const r = await applyPlan(load, applyDeps);
  if (r.status === "locked") { reportLockBusy(io, quiet); return 0; } // --quiet: silent, like sync
  if (r.status === "declined") { io.stdout("Nothing changed.\n"); return 0; }
  if (r.status === "dry-run" && r.dryRun) { io.stdout(renderDryRun(r.dryRun, shownPath, io)); return 0; }
  const rec = r.recovered;
  if (rec && rec.restored.length > 0) io.stderr(`Restored the file times of ${rec.restored.length} transcript(s) left by an interrupted run.\n`);
  if (rec && rec.failed.length > 0) io.stderr(`Could not restore ${rec.failed.length} file time(s) from an interrupted run; they are retried on the next run.\n`);

  if (r.status === "aborted" && r.runId === null) { io.stderr("Interrupted before any change was made.\n"); return 130; }

  const parts = [`Imported ${r.imported}`, `failed ${r.failed}`];
  if (r.converted) parts.push(`converted ${r.converted}`);
  if (r.unverified) parts.push(`unverified ${r.unverified}`);
  if (r.alreadyInT3) parts.push(`already in T3 Code ${r.alreadyInT3}`);
  if (r.deferred - r.deferredInUse) parts.push(`deferred ${r.deferred - r.deferredInUse} (in use, changed or locked; next run)`);
  if (r.deferredInUse) parts.push(`held ${r.deferredInUse} (a session of their project is in use; next run)`);
  out(`${parts.join(", ")}.${r.runId ? ` Run ${r.runId}.` : ""}\n`);
  if (r.heldRoots.length > 0) {
    out(`Held (a session is in use): ${r.heldRoots.map(baseName).join(", ")}. Close the session or wait 10 minutes, then run again.\n`);
  }
  for (const f of r.failures.slice(0, 20)) out(`  failed: ${f.harness} ${f.nativeId} (${f.reason})\n`);
  if (r.failures.length > 20) out(`  ... and ${r.failures.length - 20} more (see journal.jsonl)\n`);
  if (r.restoreErrors.length > 0) {
    io.stderr(`Warning: could not restore the file times of ${r.restoreErrors.length} transcript(s) (first: ${r.restoreErrors[0]!.path}: ${r.restoreErrors[0]!.error}). The next t3sm run restores them.\n`);
  }
  if (r.unverified > 0) io.stderr("Could not verify imports with T3 Code; stopped. Run `t3sm plan` and `t3sm apply` again.\n");
  if (r.status === "aborted") { io.stderr("Interrupted: file times restored, no further waves started. Run `t3sm apply` again to continue.\n"); return 130; }
  return r.failed > 0 || r.unverified > 0 || r.restoreErrors.length > 0 ? 5 : 0;
}
