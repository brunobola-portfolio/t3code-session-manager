// t3sm rollback / t3sm runs.
// rollback flow: --dry-run, or no --yes on a non-terminal: list (read-only, no lock) and exit 0 / 2.
// Otherwise: lock -> recoverPendingMtimes -> list -> confirm -> rollbackRun. T3 Code is needed only for the T3 part
// (defaults, instances, threads); without it the file-level rollback still runs (exit 5, reported).

import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "../../core/paths.ts";
import { homeAsTilde } from "../screen.ts";
import { Journal, recoverPendingMtimes } from "../../core/journal.ts";
import { acquireLock } from "../../core/lock.ts";
import { connectT3, type T3Api } from "../../t3/api.ts";
import { changesOf, namesOf, undoLines, type Names } from "./organize.ts";
import { isCompactionRun, isRollbackRun, latestRunId, listRuns, organizeOnlyRun, rollbackRun, type RollbackReport, type RunSummary } from "../../ops/rollback.ts";
import { accountsOf, parseFlags, type OpsDeps } from "./quarantine.ts";
import { cliUi, confirm, type CliKey, type CliUi } from "../ui.ts";
import { reportLockBusy } from "../locked.ts";
import { FLAG_SPECS, flagsOf } from "../flags.ts";
import { panel } from "../../ui/components.ts";
import { noteLines, sectionLines, snugWidth, tableOrBlocks, textLines } from "../screen.ts";
import { shownAccountName, shownText } from "../../plan/names.ts";
import type { Io } from "../main.ts";

/** Anything in the report that rollbackRun would change (as opposed to only list). */
function actionable(r: RollbackReport): number {
  return r.filesRemoved.length + r.foldersRemoved.length + r.unquarantined.length + r.defaultsRestored.length + r.threadsArchived.length + r.threadsUnarchived.length
    + r.instanceChanges.filter((c) => c.status === "restored").length + r.organize.filter((x) => x.status === "reverted").length;
}

/** How organize changes are named: organize's sentences (`undoLines`), titles as T3 Code showed them before the rollback. */
interface OrganizeWords { changes: ReturnType<typeof changesOf>; names: Names }

/** An instance's journaled appearance with its display name masked (shownAccountName); anything else as it is. */
function maskedNames(v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  return typeof o["displayName"] === "string" ? { ...o, displayName: shownAccountName(o["displayName"], 200) } : o;
}

/** A path or id from the journal, safe to show. */
const shown = (x: string): string => shownText(x, 200);

/**
 * Why rollback kept or skipped something, in the user's language. The engine's reasons are English (the report is
 * also --json); each known one has a catalogue line, and an error's own text stays as it is. `show` makes every value
 * it carries safe to show (the rollback screen passes its own: the home folder as ~).
 */
export function rollbackWhy(ui: CliUi, reason: string, show: (x: string) => string = shown): string {
  const { t } = ui;
  const fixed: Record<string, CliKey> = {
    "revision continued": "rollback.why.revisionContinued",
    "revision in use": "rollback.why.revisionInUse",
    "revision rewritten": "rollback.why.revisionRewritten",
    "T3 Code unreachable": "rollback.why.t3Unreachable",
    "T3 Code not connected": "rollback.why.t3NotConnected",
    "T3 Code not running": "rollback.why.t3NotRunning",
    "project no longer exists in T3 Code": "rollback.why.projectGone",
    "left active: it is the session's only active thread (its original thread is archived and could not be brought back)": "rollback.why.onlyActive",
  };
  const k = fixed[reason];
  if (k) return t(k);
  let m: RegExpExecArray | null;
  if ((m = /^followed again by run (\S+); roll back \S+ first$/.exec(reason))) return t("rollback.why.followedAgain", { runId: show(m[1]!) });
  if ((m = /^changed since \(now (.*)\)$/.exec(reason))) return t("rollback.why.changedSince", { now: m[1] === "none" ? t("rollback.why.none") : show(m[1]!) });
  if ((m = /^T3 Code not reachable \((.*)\)$/s.exec(reason))) return t("rollback.why.t3NotReachable", { error: show(m[1]!) });
  if ((m = /^failed: (.*)$/s.exec(reason))) return t("rollback.why.failed", { error: show(m[1]!) });
  if ((m = /^left active: the session's other thread \((.*)\) no longer exists in T3 Code, so this is its only thread$/.exec(reason))) return t("rollback.why.otherThreadGone", { threads: show(m[1]!) });
  if ((m = /^could not read T3 projects \((.*)\)$/s.exec(reason))) return t("rollback.why.projectsUnreadable", { error: show(m[1]!) });
  if ((m = /^left active: its original thread (\S+) could not be unarchived$/.exec(reason))) return t("rollback.why.originalNotUnarchived", { thread: show(m[1]!) });
  if ((m = /^could not move back \((.*)\)$/s.exec(reason))) return t("rollback.why.moveBack", { error: show(m[1]!) });
  return show(reason);
}

/**
 * What a rollback did (or, `dry`, would do), in the user's language: a panel naming the run, then one titled list per
 * kind of change (at most 50 items each), what was kept and why, and what could not be done.
 */
export function renderRollback(ui: CliUi, r: RollbackReport, dry: boolean, words: OrganizeWords, width: number = ui.width, home?: string): string[] {
  const { s, t } = ui;
  // Paths with the home folder as ~ (shorter, and never a user name on screen).
  const shown = (x: string): string => shownText(home ? homeAsTilde(x, home) : x, 300);
  const w = Math.max(1, width);
  const head = t(r.command ? "rollback.runCommand" : "rollback.run", { runId: shown(r.targetRunId), command: shown(r.command ?? "") });
  const out: string[] = [];
  const list = (key: CliKey, xs: string[], vars: Record<string, string> = {}): void => {
    const lines = sectionLines(s, t(key, vars), xs.map(shown), w, { more: (n) => t("common.andMore", { n }) });
    if (lines.length > 0) out.push("", ...lines);
  };
  const did = (done: CliKey, will: CliKey): CliKey => (dry ? will : done);
  list(did("rollback.unquarantined", "rollback.dry.unquarantined"), r.unquarantined);
  list(did("rollback.filesRemoved", "rollback.dry.filesRemoved"), r.filesRemoved);
  list("rollback.keptModified", r.filesKeptModified);
  list("rollback.keptRewritten", r.filesKeptRewritten);
  list("rollback.keptRefreshed", r.filesKeptRefreshed);
  list("rollback.keptActive", r.filesKeptActive);
  list(did("rollback.foldersRemoved", "rollback.dry.foldersRemoved"), r.foldersRemoved);
  list("rollback.foldersKept", r.foldersKept);
  list("rollback.conflicts", r.unquarantineConflicts.map((c) => `${c.from} -> ${c.to}`));
  list("rollback.alreadyRestored", r.alreadyRestored);
  list("rollback.missing", r.unquarantineMissing);
  list("rollback.moveFailed", r.unquarantineFailed.map((f) => `${f.path}: ${rollbackWhy(ui, f.reason, shown)}`));
  list(did("rollback.defaultsRestored", "rollback.dry.defaultsRestored"), r.defaultsRestored);
  list("rollback.defaultsSkipped", r.defaultsSkipped.map((d) => `${d.projectId}: ${rollbackWhy(ui, d.reason, shown)}`));
  list("rollback.instanceChanges", r.instanceChanges.map((c) => `${c.kind} ${c.instanceId}: ${JSON.stringify(maskedNames(c.previous))} <- ${JSON.stringify(maskedNames(c.next))} [${c.status === "restored" && dry ? t("rollback.wouldRestore") : c.status}]${c.note ? ` (${c.note.replace(/"([^"]*)"/g, (_m, n: string) => JSON.stringify(shownAccountName(n, 200)))})` : ""}`));
  if (r.instanceChanges.some((c) => c.status === "listed")) out.push(...textLines(s, t("rollback.passInstances"), w, 2));
  list("rollback.instancesCreated", r.instancesCreated);
  list("rollback.projectsCreated", r.projectsCreated.map((p) => `${p.projectId} ${p.root}`));
  list(did("rollback.unarchived", "rollback.dry.unarchived"), r.threadsUnarchived);
  list("rollback.mergesKept", r.mergesKept.map((m) => `${m.nativeId}: ${rollbackWhy(ui, m.reason, shown)} (${m.revisionFile})`));
  list(did("rollback.archived", "rollback.dry.archived"), r.threadsArchived);
  list("rollback.needsReview", r.needsReview.map((x) => `${x.threadId}: ${rollbackWhy(ui, x.reason, shown)}`));
  const review = r.threadsToReview.filter((x) => !r.threadsArchived.includes(x));
  list(r.threadsVerified ? "rollback.imported" : "rollback.importedUnchecked", review);
  if (review.length > 0 && r.threadsArchived.length === 0) out.push(...textLines(s, t("rollback.reviewHint"), w, 2));
  const org = undoLines(r.organize, words.changes, words.names);
  list(did("rollback.reverted", "rollback.dry.reverted"), org.reverted);
  list("rollback.orgUserChanged", org.userChanged);
  list("organize.undo.keptTitle", org.kept);
  list("rollback.orgFailed", org.failed);
  list("rollback.parked", r.parkedThreads);
  if (r.t3Unavailable) out.push("", ...noteLines(s, "warn", t("rollback.t3Part", { why: rollbackWhy(ui, r.t3Unavailable, shown) }), w));
  for (const e of r.errors) out.push(...noteLines(s, "err", t("rollback.error", { error: shown(e) }), w));
  const body = textLines(s, t(dry ? "rollback.dry.lead" : "rollback.lead"), Math.max(1, w - 4));
  return [...panel(s, { title: head, body }, snugWidth(head, body, w)), ...out];
}

export async function rollbackCommand(args: string[], io: Io, deps: OpsDeps = {}): Promise<number> {
  const spec = flagsOf("rollback");
  const p = parseFlags(args, io, "rollback", spec.bool, spec.valued);
  if (!p) return 2;
  const yes = p.flags.has("--yes");
  const dry = p.flags.has("--dry-run");
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const ui = cliUi(io, { now });
  const say = (l: string[]): void => io.stdout(l.join("\n") + "\n");
  const dir = stateDir(io.env, home);
  const j = new Journal(join(dir, "journal.jsonl"));
  const entries = await j.readAll();
  const target = p.values.get("--run") ?? latestRunId(entries);
  if (target === null) { say(noteLines(ui.s, "ok", ui.t("rollback.noRuns"), ui.width)); return 0; }
  if (!entries.some((e) => e.runId === target)) { io.stderr(`${ui.t("rollback.noSuchRun", { runId: shown(target) })}\n`); return 2; }
  if (isRollbackRun(entries, target)) { io.stderr(`${ui.t("rollback.ofRollback")}\n`); return 2; }
  if (isCompactionRun(entries, target)) { io.stderr(`${ui.t("rollback.ofCompaction")}\n`); return 2; }
  // Without --run the target is the newest run, which may be an unattended `sync`: never chosen silently.
  if (yes && !p.values.has("--run")) {
    io.stderr(`${ui.t("rollback.needsRun", { runId: shown(target) })}\n`);
    return 2;
  }

  const instances = p.flags.has("--instances");
  const archiveThreads = p.flags.has("--archive-threads");
  const connectFn = deps.connect ?? connectT3;
  const allowUntested = p.flags.has("--allow-untested");
  // Each notice once per command, although the interactive path runs a preview and then the rollback (two connects).
  const seen = new Set<string>();
  const onNotice = (l: string): void => {
    if (seen.has(l)) return;
    seen.add(l);
    io.stderr(`${l}\n`);
  };
  // A rollback that touches T3 only through organize's commands runs on any version (ruling R18): the connection's own
  // version gate is passed (allowUntested) and its notice, the only one connecting gives, is dropped; organizeGate in
  // rollbackRun gives the one warning. Notices after the connection (a failed revoke at close) still show.
  const organizeOnly = organizeOnlyRun(entries, target);
  // providers:manage only for the run that may restore instances; a listing never asks for it.
  // Organize changes are listed by title: T3 Code's threads and projects are read once, right after connecting and
  // before anything is reverted (the titles the user knows them by now).
  const changes = changesOf(entries, target);
  const words: OrganizeWords = { changes, names: namesOf([], [], home, ui.lang) };
  let named = false;
  const nameFrom = async (api: T3Api): Promise<T3Api> => {
    if (changes.size === 0 || named) return api;
    named = true;
    try { words.names = namesOf(await api.listThreads(), await api.listProjects(), home, ui.lang); } catch { /* the rollback reports what it could not read */ }
    return api;
  };
  // settings:write only for the rollback that may put T3 Code's own auto-settle option back (an organize change).
  const settingBack = [...changes.values()].some((c) => c.kind === "auto-settle");
  const connectWith = (manageProviders: boolean, writeSettings = false) => async () => {
    const extra = writeSettings ? { writeSettings } : {};
    if (!organizeOnly) return nameFrom(await connectFn(home, { allowUntested, manageProviders, ...extra, onNotice }));
    let connecting = true;
    try {
      return await nameFrom(await connectFn(home, { allowUntested: true, manageProviders, ...extra, onNotice: (l) => { if (!connecting) onNotice(l); } }));
    } finally {
      connecting = false;
    }
  };
  const accountHomes = (await accountsOf(dir, home, io.env)).map((a) => a.home);
  const opts = { journal: j, accountHomes, connect: connectWith(instances, settingBack), now, instances, archiveThreads, allowUntested, onNotice };
  const dryOpts = { ...opts, connect: connectWith(false), dryRun: true };
  const nothing = (): void => say(noteLines(ui.s, "ok", ui.t("rollback.nothing", { runId: shown(target) }), ui.width));

  if (dry || (!yes && !io.isTTY)) {
    const r = await rollbackRun(target, dryOpts);
    say(renderRollback(ui, r, true, words, ui.width, home));
    if (actionable(r) === 0) { nothing(); return 0; }
    if (dry) { say(["", ...noteLines(ui.s, "info", ui.t("rollback.dryDone", { runId: shown(target) }), ui.width)]); return 0; }
    io.stderr(`${ui.t("rollback.needsYes")}\n`);
    return 2;
  }

  const lock = await acquireLock(dir);
  if (!lock) { reportLockBusy(io); return 0; }
  try {
    const rec = await recoverPendingMtimes(j);
    if (rec.restored.length > 0) io.stderr(`${ui.t("apply.recovered", { n: rec.restored.length })}\n`);
    if (!yes) {
      const preview = await rollbackRun(target, dryOpts);
      say(renderRollback(ui, preview, true, words, ui.width, home));
      if (actionable(preview) === 0) { nothing(); return 0; }
      io.stdout("\n");
      if (!(await confirm(io, preview.command ? ui.t("rollback.confirmCommand", { runId: target, command: preview.command }) : ui.t("rollback.confirm", { runId: target })))) {
        io.stdout(`${ui.t("common.nothingChanged")}\n`);
        return 0;
      }
    }
    const r = await rollbackRun(target, opts);
    say(renderRollback(ui, r, false, words, ui.width, home));
    if (r.runId === null) nothing();
    else say(["", ...noteLines(ui.s, "ok", ui.t("rollback.done", { runId: shown(target), journal: r.runId }), ui.width)]);
    const incomplete = r.unquarantineConflicts.length + r.unquarantineFailed.length + r.defaultsSkipped.length + r.errors.length + r.needsReview.length
      + r.instanceChanges.filter((c) => c.status === "failed").length + r.organize.filter((x) => x.status === "failed").length;
    return incomplete > 0 ? 5 : 0;
  } finally {
    await lock.release();
  }
}

const CHANGE_WORDS: [keyof RunSummary["counts"], CliKey][] = [
  ["imported", "runs.change.imported"], ["importFailed", "runs.change.failed"], ["filesWritten", "runs.change.files"],
  ["quarantined", "runs.change.quarantined"], ["unquarantined", "runs.change.unquarantined"], ["defaults", "runs.change.defaults"],
  ["instances", "runs.change.instances"], ["projects", "runs.change.projects"], ["archived", "runs.change.archived"],
  ["merged", "runs.change.merged"], ["organized", "runs.change.organized"], ["organizeReverted", "runs.change.reverted"],
];

const STATUS_WORDS: Record<string, CliKey> = { ok: "runs.status.ok", partial: "runs.status.partial", aborted: "runs.status.aborted", incomplete: "runs.status.incomplete" };

interface RunRow { id: string; at: string; command: string; status: string; changes: string }

/**
 * The runs in the journal, newest last: a table (run, started, command, status, changes) when it fits, else each run
 * as a short block, so nothing is cut. Counts and statuses in words; the run ids and commands as they are.
 */
export function renderRuns(ui: CliUi, runs: RunSummary[], width: number = ui.width): string[] {
  const { s, t, f } = ui;
  if (runs.length === 0) return noteLines(s, "ok", t("runs.none"), width);
  const rows: RunRow[] = runs.map((r) => {
    const status = STATUS_WORDS[r.status] ? t(STATUS_WORDS[r.status]!) : r.status;
    const changes = CHANGE_WORDS.filter(([k]) => r.counts[k] > 0).map(([k, w]) => t(w, { n: f.n(r.counts[k]) })).join(", ");
    return {
      id: shown(r.runId), at: r.at ? f.date(r.at) : "-", command: shown(r.command ?? "-"),
      status: r.rolledBackBy ? t("runs.rolledBack", { status, runId: shown(r.rolledBackBy) }) : status, changes: changes || "-",
    };
  });
  // Never cut: a run id, a count or a status that lost its end would say something else. A table when every cell fits
  // whole, else one block per run (every value whole, wrapped under its label).
  const col = (header: string, get: (r: RunRow) => string) => ({ header, get: (r: unknown) => get(r as RunRow) });
  const cols = [
    col(t("runs.col.run"), (r) => r.id),
    col(t("runs.col.started"), (r) => r.at),
    col(t("runs.col.command"), (r) => r.command),
    col(t("runs.col.status"), (r) => r.status),
    col(t("runs.col.changes"), (r) => r.changes),
  ];
  return tableOrBlocks(s, cols, rows, width);
}

export async function runsCommand(args: string[], io: Io, deps: { home?: string } = {}): Promise<number> {
  const p = parseFlags(args, io, "runs", [...FLAG_SPECS.runs.bool]);
  if (!p) return 2;
  const dir = stateDir(io.env, deps.home ?? homedir());
  const runs = listRuns(await new Journal(join(dir, "journal.jsonl")).readAll());
  if (p.flags.has("--json")) { io.stdout(JSON.stringify(runs, null, 2) + "\n"); return 0; }
  io.stdout(renderRuns(cliUi(io), runs).join("\n") + "\n");
  return 0;
}

/** The options `t3sm rollback` accepts: the run is only ever named with --run (a positional is refused). */
export const ROLLBACK_FLAGS = [...FLAG_SPECS.rollback.bool];
export const ROLLBACK_VALUED = [...FLAG_SPECS.rollback.valued];
