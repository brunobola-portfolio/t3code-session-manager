// t3sm quarantine / t3sm dedupe: move backup folders and mirror copies to the account's reversible quarantine.
// Flow: --dry-run, or no --yes on a non-terminal: list (read-only, no lock) and exit 0 / 2.
// Otherwise: lock -> recoverPendingMtimes -> list -> confirm -> run-start -> moves -> run-end.

import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, Plan } from "../../core/types.ts";
import { expandHome, stateDir } from "../../core/paths.ts";
import { ConfigError, defaultConfig, loadConfig } from "../../core/config.ts";
import { resolveAccounts } from "../../ops/discoverAccounts.ts";
import { Journal, newRunId, recoverPendingMtimes } from "../../core/journal.ts";
import { acquireLock } from "../../core/lock.ts";
import { PLAN_MAX_AGE_MS } from "../../apply/apply.ts";
import { dedupe, findBackupDirs, quarantine, type MoveReport } from "../../ops/quarantine.ts";
import type { T3Api } from "../../t3/api.ts";
import { latestPlan, readPlan } from "./apply.ts";
import { reportLockBusy } from "../locked.ts";
import type { Io } from "../main.ts";

export interface OpsDeps {
  home?: string;
  now?: () => number;
  connect?: (home: string, opts: { allowUntested: boolean; manageProviders: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;
}

export interface Parsed { flags: Set<string>; values: Map<string, string> }

/** Flags in `bool`, `--x <value>` options in `valued`; null after printing the error (exit 2). */
export function parseFlags(args: string[], io: Io, cmd: string, bool: string[], valued: string[] = []): Parsed | null {
  const out: Parsed = { flags: new Set(), values: new Map() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.includes(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) { io.stderr(`${a} needs a value. Run \`t3sm ${cmd} --help\`.\n`); return null; }
      out.values.set(a, v);
      i++;
    } else if (bool.includes(a)) out.flags.add(a);
    else { io.stderr(`Unknown option: ${a}. Run \`t3sm ${cmd} --help\`.\n`); return null; }
  }
  if (out.flags.has("--dry-run") && out.flags.has("--yes")) { io.stderr("Use either --dry-run or --yes.\n"); return null; }
  return out;
}

/** Config accounts (or the discovered accounts when there is no config.json), homes expanded. */
export async function accountsOf(dir: string, home: string, env: NodeJS.ProcessEnv = {}): Promise<AccountConfig[]> {
  const cfg = (await loadConfig(dir, home)) ?? defaultConfig(await resolveAccounts(home, [], env));
  return cfg.accounts.map((a) => ({ ...a, home: expandHome(a.home, home) }));
}

export async function confirm(io: Io, question: string): Promise<boolean> {
  const ans = (await io.prompt(`${question} Type yes to continue: `)).trim().toLowerCase();
  return ans === "yes" || ans === "y";
}

export const NEEDS_YES = "Refusing to move files without confirmation: pass --yes (non-interactive), or --dry-run to only list.\n";

function renderMoves(r: MoveReport, indent = "  "): string {
  let s = "";
  for (const m of r.moved) s += `${indent}${m.from}\n${indent}  -> ${m.to}\n`;
  for (const k of r.skipped) s += `${indent}skip ${k.path}: ${k.reason}\n`;
  return s;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

interface Batch { account: AccountConfig; preview: MoveReport }

/**
 * Shared skeleton of quarantine and dedupe. `preview` runs the move with dryRun (read-only); `execute` moves the
 * previewed sources. Exit 5 when an item that passed the preview could not be moved.
 */
async function runMoves(
  io: Io, p: Parsed, dir: string, now: () => number, what: { command: string; noun: [string, string]; question: string; nothing: string; countOf?: (r: MoveReport) => number },
  preview: (j: Journal) => Promise<Batch[]>,
  execute: (b: Batch, j: Journal, runId: string) => Promise<MoveReport>,
): Promise<number> {
  const yes = p.flags.has("--yes");
  const dry = p.flags.has("--dry-run");
  const j = new Journal(join(dir, "journal.jsonl"));
  const show = (bs: Batch[]): number => {
    let total = 0;
    for (const b of bs) {
      if (b.preview.moved.length === 0 && b.preview.skipped.length === 0) continue;
      const n = what.countOf ? what.countOf(b.preview) : b.preview.moved.length;
      total += n;
      io.stdout(`${b.account.id} (${b.account.home}): ${plural(n, what.noun[0], what.noun[1])} to move${b.preview.skipped.length ? `, ${b.preview.skipped.length} skipped` : ""}\n`);
      io.stdout(renderMoves(b.preview));
    }
    return total;
  };

  if (dry || (!yes && !io.isTTY)) {
    const total = show(await preview(j));
    if (total === 0) { io.stdout(`${what.nothing}\n`); return 0; }
    if (dry) { io.stdout(`Dry run: ${plural(total, what.noun[0], what.noun[1])} would move. Nothing was changed.\n`); return 0; }
    io.stderr(NEEDS_YES);
    return 2;
  }

  const lock = await acquireLock(dir);
  if (!lock) { reportLockBusy(io); return 0; }
  try {
    const rec = await recoverPendingMtimes(j);
    if (rec.restored.length > 0) io.stderr(`Restored the file times of ${rec.restored.length} transcript(s) left by an interrupted run.\n`);
    const batches = await preview(j);
    const total = show(batches);
    if (total === 0) { io.stdout(`${what.nothing}\n`); return 0; }
    if (!yes && !(await confirm(io, what.question))) { io.stdout("Nothing changed.\n"); return 0; }

    const runId = newRunId(new Date(now()));
    await j.append({ t: "run-start", runId, at: new Date(now()).toISOString(), command: what.command });
    let moved = 0;
    const failed: { path: string; reason: string }[] = [];
    try {
      for (const b of batches) {
        if (b.preview.moved.length === 0) continue;
        const r = await execute(b, j, runId);
        moved += r.moved.length;
        const planned = new Set(b.preview.moved.map((m) => m.from));
        for (const s of r.skipped) {
          if (planned.has(s.path)) failed.push(s);
        }
      }
    } catch (e) {
      await j.append({ t: "run-end", runId, at: new Date(now()).toISOString(), status: "aborted" }).catch(() => {});
      throw e;
    }
    await j.append({ t: "run-end", runId, at: new Date(now()).toISOString(), status: failed.length ? "partial" : "ok" });
    io.stdout(`Moved ${plural(moved, "item", "items")} to quarantine. Run ${runId}; undo with \`t3sm rollback --run ${runId}\`.\n`);
    for (const f of failed) io.stderr(`Not moved: ${f.path}: ${f.reason}\n`);
    return failed.length > 0 ? 5 : 0;
  } finally {
    await lock.release();
  }
}

export async function quarantineCommand(args: string[], io: Io, deps: OpsDeps = {}): Promise<number> {
  const p = parseFlags(args, io, "quarantine", ["--yes", "--dry-run"]);
  if (!p) return 2;
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const dir = stateDir(io.env, home);
  const accounts = await accountsOf(dir, home, io.env);
  const preview = async (j: Journal): Promise<Batch[]> => {
    const out: Batch[] = [];
    for (const a of accounts) {
      const dirs = await findBackupDirs(a.home);
      out.push({ account: a, preview: await quarantine(dirs, a.home, j, "preview", { dryRun: true, now }) });
    }
    return out;
  };
  return runMoves(io, p, dir, now, {
    command: "quarantine", noun: ["backup folder", "backup folders"], question: "Move these folders to quarantine?",
    nothing: "No backup folders to quarantine.",
  }, preview, (b, j, runId) => quarantine(b.preview.moved.map((m) => m.from), b.account.home, j, runId, { now }));
}

export async function dedupeCommand(args: string[], io: Io, deps: OpsDeps = {}): Promise<number> {
  const p = parseFlags(args, io, "dedupe", ["--yes", "--dry-run"], ["--plan"]);
  if (!p) return 2;
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const dir = stateDir(io.env, home);
  let plan: Plan;
  try {
    const path = p.values.get("--plan") ?? (await latestPlan(dir));
    if (path === null) throw new ConfigError("No plan found. Run `t3sm plan` first.");
    plan = await readPlan(path);
    const created = Date.parse(plan.createdAt);
    if (!Number.isFinite(created) || now() - created > PLAN_MAX_AGE_MS || created - now() > 3_600_000) {
      throw new ConfigError(`The plan ${path} is older than 24 h (stale). Run \`t3sm plan\` again.`);
    }
  } catch (e) {
    if (e instanceof ConfigError) { io.stderr(`${e.message}\n`); return 2; }
    throw e;
  }
  const accounts = await accountsOf(dir, home, io.env);
  const copyPaths = new Set(plan.mirrorCopies.map((c) => c.path));
  // One listing for the whole plan; dedupe derives each copy's account (and quarantine folder) itself.
  const preview = async (j: Journal): Promise<Batch[]> => {
    const r = await dedupe(plan.mirrorCopies, accounts, j, "preview", { dryRun: true, now, home });
    return [{ account: { id: "mirror copies", home: "plan " + plan.runId, displayName: "", accentColor: null }, preview: r }];
  };
  return runMoves(io, p, dir, now, {
    command: `dedupe ${plan.runId}`, noun: ["mirror copy", "mirror copies"], question: "Move these mirror copies (and their sidecar folders) to quarantine?",
    nothing: "No mirror copies to move.", countOf: (r) => r.moved.filter((m) => copyPaths.has(m.from)).length,
  }, preview, (b, j, runId) => {
    const planned = new Set(b.preview.moved.map((m) => m.from));
    return dedupe(plan.mirrorCopies.filter((c) => planned.has(c.path)), accounts, j, runId, { now, home });
  });
}
