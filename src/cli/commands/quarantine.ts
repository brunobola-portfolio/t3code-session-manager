// t3sm quarantine / t3sm dedupe: move backup folders and mirror copies to the account's reversible quarantine.
// Flow: --dry-run, or no --yes on a non-terminal: list (read-only, no lock) and exit 0 / 2.
// Otherwise: lock -> recoverPendingMtimes -> list -> confirm -> run-start -> moves -> run-end.

import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, Plan } from "../../core/types.ts";
import { expandHome, stateDir } from "../../core/paths.ts";
import { ConfigError, NoPlanError, defaultConfig, loadConfig } from "../../core/config.ts";
import { resolveAccounts } from "../../ops/discoverAccounts.ts";
import { Journal, newRunId, recoverPendingMtimes } from "../../core/journal.ts";
import { acquireLock } from "../../core/lock.ts";
import { PLAN_MAX_AGE_MS } from "../../apply/apply.ts";
import { dedupe, findBackupDirs, quarantine, type MoveReport } from "../../ops/quarantine.ts";
import type { T3Api } from "../../t3/api.ts";
import { latestPlan, readPlan } from "./apply.ts";
import { reportLockBusy } from "../locked.ts";
import type { Io } from "../main.ts";
import { cliUi, confirm, type CliKey, type CliUi, unknownOption, usageLine } from "../ui.ts";
import { FLAG_SPECS, flagsOf } from "../flags.ts";
import { bulletLines, fitLine, hardLines, noteLines } from "../screen.ts";
import { shownText } from "../../plan/names.ts";

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
      if (v === undefined || v.startsWith("--")) { usageLine(io, "common.needsValue", { option: a, help: `t3sm ${cmd} --help` }); return null; }
      out.values.set(a, v);
      i++;
    } else if (bool.includes(a)) out.flags.add(a);
    else { unknownOption(io, a, cmd); return null; }
  }
  if (out.flags.has("--dry-run") && out.flags.has("--yes")) { usageLine(io, "common.eitherDryRunOrYes"); return null; }
  return out;
}

/** Config accounts (or the discovered accounts when there is no config.json), homes expanded. */
export async function accountsOf(dir: string, home: string, env: NodeJS.ProcessEnv = {}): Promise<AccountConfig[]> {
  const cfg = (await loadConfig(dir, home)) ?? defaultConfig(await resolveAccounts(home, [], env));
  return cfg.accounts.map((a) => ({ ...a, home: expandHome(a.home, home) }));
}

/** The shared localized confirmation (cli/ui.ts), re-exported for the commands that import it from here. */
export { confirm };


interface Batch { account: AccountConfig; preview: MoveReport; /** How the batch is named on screen (default: the account and its home). */ label?: string }

/** What one account (or the plan, for dedupe) would move: a heading with the count, each move, then what stays and why. */
export function renderBatch(ui: CliUi, b: Batch, n: number, noun: CliKey, width: number = ui.width): string[] {
  const { s, t } = ui;
  const who = b.label ?? `${shownText(b.account.id, 60)} (${shownText(b.account.home, 200)})`;
  const head = t("moves.batch", { who, what: t(noun, { n }) }) + (b.preview.skipped.length ? t("moves.skippedCount", { n: b.preview.skipped.length }) : "");
  const out = fitLine(s("title", head), width, 2);
  for (const m of b.preview.moved) {
    out.push(...bulletLines(s, shownText(m.from, 400), width));
    out.push(...hardLines(`    ${s("muted", s.caps.unicode ? "→" : "->")} `, shownText(m.to, 400), width, 6));
  }
  for (const k of b.preview.skipped) out.push(...noteLines(s, "warn", t("moves.skip", { path: shownText(k.path, 400), reason: shownText(k.say ? t(k.say.key, k.say.vars) : k.reason, 200) }), width - 2).map((l) => "  " + l));
  return out;
}

/**
 * Shared skeleton of quarantine and dedupe. `preview` runs the move with dryRun (read-only); `execute` moves the
 * previewed sources. Exit 5 when an item that passed the preview could not be moved.
 */
async function runMoves(
  io: Io, p: Parsed, dir: string, now: () => number, what: { command: string; noun: CliKey; question: "quarantine.confirm" | "dedupe.confirm"; nothing: CliKey; countOf?: (r: MoveReport) => number },
  preview: (j: Journal) => Promise<Batch[]>,
  execute: (b: Batch, j: Journal, runId: string) => Promise<MoveReport>,
): Promise<number> {
  const yes = p.flags.has("--yes");
  const dry = p.flags.has("--dry-run");
  const j = new Journal(join(dir, "journal.jsonl"));
  const ui = cliUi(io, { now });
  const say = (l: string[]): void => io.stdout(l.join("\n") + "\n");
  const show = (bs: Batch[]): number => {
    let total = 0;
    for (const b of bs) {
      if (b.preview.moved.length === 0 && b.preview.skipped.length === 0) continue;
      const n = what.countOf ? what.countOf(b.preview) : b.preview.moved.length;
      total += n;
      say(renderBatch(ui, b, n, what.noun));
    }
    return total;
  };
  const nothing = (): void => say(noteLines(ui.s, "ok", ui.t(what.nothing), ui.width));

  if (dry || (!yes && !io.isTTY)) {
    const total = show(await preview(j));
    if (total === 0) { nothing(); return 0; }
    if (dry) { say(["", ...noteLines(ui.s, "info", ui.t("moves.dry", { what: ui.t(what.noun, { n: total }), command: what.command.split(" ")[0]! }), ui.width)]); return 0; }
    io.stderr(`${ui.t("moves.needsYes")}\n`);
    return 2;
  }

  const lock = await acquireLock(dir);
  if (!lock) { reportLockBusy(io); return 0; }
  try {
    const rec = await recoverPendingMtimes(j);
    if (rec.restored.length > 0) io.stderr(`${ui.t("apply.recovered", { n: rec.restored.length })}\n`);
    const batches = await preview(j);
    const total = show(batches);
    if (total === 0) { nothing(); return 0; }
    if (!yes) {
      io.stdout("\n");
      if (!(await confirm(io, ui.t(what.question)))) { io.stdout(`${ui.t("common.nothingChanged")}\n`); return 0; }
    }

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
    say(["", ...noteLines(ui.s, "ok", ui.t("moves.done", { n: moved, runId }), ui.width)]);
    for (const f of failed) io.stderr(`${ui.t("moves.notMoved", { path: shownText(f.path, 400), reason: shownText(f.reason, 200) })}\n`);
    return failed.length > 0 ? 5 : 0;
  } finally {
    await lock.release();
  }
}

export async function quarantineCommand(args: string[], io: Io, deps: OpsDeps = {}): Promise<number> {
  const p = parseFlags(args, io, "quarantine", [...FLAG_SPECS.quarantine.bool]);
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
    command: "quarantine", noun: "quarantine.noun", question: "quarantine.confirm", nothing: "quarantine.nothing",
  }, preview, (b, j, runId) => quarantine(b.preview.moved.map((m) => m.from), b.account.home, j, runId, { now }));
}

export async function dedupeCommand(args: string[], io: Io, deps: OpsDeps = {}): Promise<number> {
  const spec = flagsOf("dedupe");
  const p = parseFlags(args, io, "dedupe", spec.bool, spec.valued);
  if (!p) return 2;
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const dir = stateDir(io.env, home);
  let plan: Plan;
  try {
    const path = p.values.get("--plan") ?? (await latestPlan(dir));
    if (path === null) throw new NoPlanError();
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
    return [{ account: { id: "mirror copies", home: "plan " + plan.runId, displayName: "", accentColor: null }, preview: r, label: cliUi(io).t("dedupe.who", { runId: shownText(plan.runId) }) }];
  };
  return runMoves(io, p, dir, now, {
    command: `dedupe ${plan.runId}`, noun: "dedupe.noun", question: "dedupe.confirm",
    nothing: "dedupe.nothing", countOf: (r) => r.moved.filter((m) => copyPaths.has(m.from)).length,
  }, preview, (b, j, runId) => {
    const planned = new Set(b.preview.moved.map((m) => m.from));
    return dedupe(plan.mirrorCopies.filter((c) => planned.has(c.path)), accounts, j, runId, { now, home });
  });
}
