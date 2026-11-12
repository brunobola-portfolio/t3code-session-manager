// t3sm rollback / t3sm runs.
// rollback flow: --dry-run, or no --yes on a non-terminal: list (read-only, no lock) and exit 0 / 2.
// Otherwise: lock -> recoverPendingMtimes -> list -> confirm -> rollbackRun. T3 Code is needed only for the T3 part
// (defaults, instances, threads); without it the file-level rollback still runs (exit 5, reported).

import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "../../core/paths.ts";
import { Journal, recoverPendingMtimes } from "../../core/journal.ts";
import { acquireLock } from "../../core/lock.ts";
import { connectT3 } from "../../t3/api.ts";
import { isRollbackRun, latestRunId, listRuns, rollbackRun, type RollbackReport } from "../../ops/rollback.ts";
import { accountsOf, confirm, parseFlags, type OpsDeps } from "./quarantine.ts";
import { reportLockBusy } from "../locked.ts";
import type { Io } from "../main.ts";

/** Anything in the report that rollbackRun would change (as opposed to only list). */
function actionable(r: RollbackReport): number {
  return r.filesRemoved.length + r.unquarantined.length + r.defaultsRestored.length + r.threadsArchived.length + r.threadsUnarchived.length
    + r.instanceChanges.filter((c) => c.status === "restored").length;
}

function render(r: RollbackReport, dry: boolean): string {
  const w = (did: string, will: string): string => (dry ? will : did);
  const out: string[] = [`Run ${r.targetRunId}${r.command ? ` (${r.command})` : ""}:`];
  const list = (title: string, xs: string[]): void => {
    if (xs.length === 0) return;
    out.push(`  ${title} (${xs.length}):`);
    for (const x of xs.slice(0, 50)) out.push(`    ${x}`);
    if (xs.length > 50) out.push(`    ... and ${xs.length - 50} more`);
  };
  list(w("Moved back from quarantine", "Move back from quarantine"), r.unquarantined);
  list(w("Removed converted files", "Remove converted files"), r.filesRemoved);
  list("Kept (edited since t3sm wrote them)", r.filesKeptModified);
  list("Kept (rewritten by a later run)", r.filesKeptRewritten);
  list("Kept (changed in the last 10 minutes; run rollback again later)", r.filesKeptActive);
  list("Left in quarantine (the original path exists again; compare and move by hand)", r.unquarantineConflicts.map((c) => `${c.from} -> ${c.to}`));
  list("Already back at the original path", r.alreadyRestored);
  list("Gone from quarantine and from the original path", r.unquarantineMissing);
  list("Could not move back", r.unquarantineFailed.map((f) => `${f.path}: ${f.reason}`));
  list(w("Restored the default account of projects", "Restore the default account of projects"), r.defaultsRestored);
  list("Defaults not restored", r.defaultsSkipped.map((d) => `${d.projectId}: ${d.reason}`));
  list("Instance changes", r.instanceChanges.map((c) => `${c.kind} ${c.instanceId}: ${JSON.stringify(c.previous)} <- ${JSON.stringify(c.next)} [${c.status === "restored" && dry ? "would restore" : c.status}]${c.note ? ` (${c.note})` : ""}`));
  if (r.instanceChanges.some((c) => c.status === "listed")) out.push("    (pass --instances to restore them)");
  list("Instances created (left in place)", r.instancesCreated);
  list("Projects created (left in place)", r.projectsCreated.map((p) => `${p.projectId} ${p.root}`));
  list(w("Unarchived threads (merges undone: the old thread is back)", "Unarchive threads (merges undone: the old thread comes back)"), r.threadsUnarchived);
  list("Merges kept (the revision was continued since; both threads stay)", r.mergesKept.map((m) => `${m.nativeId}: ${m.reason} (${m.revisionFile})`));
  list(w("Archived threads", "Archive threads"), r.threadsArchived);
  list("Left active for review in T3 Code (archiving would leave the session without an active thread)", r.needsReview.map((x) => `${x.threadId}: ${x.reason}`));
  const review = r.threadsToReview.filter((t) => !r.threadsArchived.includes(t));
  list(`Threads this run imported${r.threadsVerified ? "" : " (not checked: T3 Code unavailable)"}; t3sm never deletes them`, review);
  if (review.length > 0 && r.threadsArchived.length === 0) out.push("    (review them in T3 Code, or pass --archive-threads to archive them)");
  list("Copies parked during the run that have a T3 Code thread (not imported by t3sm; review only, never archived)", r.parkedThreads);
  if (r.t3Unavailable) out.push(`  T3 part not done: ${r.t3Unavailable}.`);
  for (const e of r.errors) out.push(`  Error: ${e}`);
  return out.join("\n") + "\n";
}

export async function rollbackCommand(args: string[], io: Io, deps: OpsDeps = {}): Promise<number> {
  const p = parseFlags(args, io, "rollback", ["--yes", "--dry-run", "--instances", "--archive-threads", "--allow-untested"], ["--run"]);
  if (!p) return 2;
  const yes = p.flags.has("--yes");
  const dry = p.flags.has("--dry-run");
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const dir = stateDir(io.env, home);
  const j = new Journal(join(dir, "journal.jsonl"));
  const entries = await j.readAll();
  const target = p.values.get("--run") ?? latestRunId(entries);
  if (target === null) { io.stdout("Nothing to roll back: the journal has no runs.\n"); return 0; }
  if (!entries.some((e) => e.runId === target)) { io.stderr(`No run ${target} in the journal. Run \`t3sm runs\` to list them.\n`); return 2; }
  if (isRollbackRun(entries, target)) { io.stderr("Cannot roll back a rollback run.\n"); return 2; }
  // Without --run the target is the newest run, which may be an unattended `sync`: never chosen silently.
  if (yes && !p.values.has("--run")) {
    io.stderr(`Refusing to roll back without naming the run: pass --run <id> with --yes (\`t3sm runs\` lists them; the newest is ${target}).\n`);
    return 2;
  }

  const instances = p.flags.has("--instances");
  const archiveThreads = p.flags.has("--archive-threads");
  const connectFn = deps.connect ?? connectT3;
  // providers:manage only for the run that may restore instances; a listing never asks for it.
  const connectWith = (manageProviders: boolean) => () =>
    connectFn(home, { allowUntested: p.flags.has("--allow-untested"), manageProviders, onNotice: (l) => io.stderr(`${l}\n`) });
  const accountHomes = (await accountsOf(dir, home, io.env)).map((a) => a.home);
  const opts = { journal: j, accountHomes, connect: connectWith(instances), now, instances, archiveThreads };
  const dryOpts = { ...opts, connect: connectWith(false), dryRun: true };

  if (dry || (!yes && !io.isTTY)) {
    const r = await rollbackRun(target, dryOpts);
    io.stdout(render(r, true));
    if (actionable(r) === 0) { io.stdout(`Nothing to roll back for run ${target}.\n`); return 0; }
    if (dry) { io.stdout("Dry run: nothing was changed.\n"); return 0; }
    io.stderr("Refusing to roll back without confirmation: pass --yes (non-interactive), or --dry-run to only list.\n");
    return 2;
  }

  const lock = await acquireLock(dir);
  if (!lock) { reportLockBusy(io); return 0; }
  try {
    const rec = await recoverPendingMtimes(j);
    if (rec.restored.length > 0) io.stderr(`Restored the file times of ${rec.restored.length} transcript(s) left by an interrupted run.\n`);
    if (!yes) {
      const preview = await rollbackRun(target, dryOpts);
      io.stdout(render(preview, true));
      if (actionable(preview) === 0) { io.stdout(`Nothing to roll back for run ${target}.\n`); return 0; }
      if (!(await confirm(io, `Roll back run ${target}${preview.command ? ` (${preview.command})` : ""}?`))) { io.stdout("Nothing changed.\n"); return 0; }
    }
    const r = await rollbackRun(target, opts);
    io.stdout(render(r, false));
    if (r.runId === null) { io.stdout(`Nothing to roll back for run ${target}.\n`); }
    else io.stdout(`Rolled back run ${target} (journaled as ${r.runId}).\n`);
    const incomplete = r.unquarantineConflicts.length + r.unquarantineFailed.length + r.defaultsSkipped.length + r.errors.length + r.needsReview.length
      + r.instanceChanges.filter((c) => c.status === "failed").length;
    return incomplete > 0 ? 5 : 0;
  } finally {
    await lock.release();
  }
}

export async function runsCommand(args: string[], io: Io, deps: { home?: string } = {}): Promise<number> {
  const p = parseFlags(args, io, "runs", ["--json"]);
  if (!p) return 2;
  const dir = stateDir(io.env, deps.home ?? homedir());
  const runs = listRuns(await new Journal(join(dir, "journal.jsonl")).readAll());
  if (p.flags.has("--json")) { io.stdout(JSON.stringify(runs, null, 2) + "\n"); return 0; }
  if (runs.length === 0) { io.stdout("No runs in the journal.\n"); return 0; }
  const rows: string[][] = [["Run", "Started", "Command", "Status", "Changes"]];
  for (const r of runs) {
    const c = r.counts;
    const parts: string[] = [];
    if (c.imported) parts.push(`imported ${c.imported}`);
    if (c.importFailed) parts.push(`failed ${c.importFailed}`);
    if (c.filesWritten) parts.push(`files ${c.filesWritten}`);
    if (c.quarantined) parts.push(`quarantined ${c.quarantined}`);
    if (c.unquarantined) parts.push(`unquarantined ${c.unquarantined}`);
    if (c.defaults) parts.push(`defaults ${c.defaults}`);
    if (c.instances) parts.push(`instances ${c.instances}`);
    if (c.projects) parts.push(`projects ${c.projects}`);
    if (c.archived) parts.push(`archived ${c.archived}`);
    if (c.merged) parts.push(`merged ${c.merged}`);
    const status = r.rolledBackBy ? `${r.status}, rolled back (${r.rolledBackBy})` : r.status;
    rows.push([r.runId, r.at ?? "-", r.command ?? "-", status, parts.join(", ") || "-"]);
  }
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  io.stdout(rows.map((row) => row.map((x, i) => x.padEnd(w[i]!)).join("  ").trimEnd()).join("\n") + "\n");
  return 0;
}
