// t3sm journal compact: fold the file-time entries of old, finished runs out of journal.jsonl (src/core/compact.ts).
// Flow: --dry-run, or no --yes on a non-terminal: preview (read-only, no lock) and exit 0 / 2.
// Otherwise: lock -> recoverPendingMtimes -> preview -> confirm -> compactJournal (run-start, backup, rename, run-end).

import { homedir } from "node:os";
import { join } from "node:path";
import { Journal, recoverPendingMtimes } from "../../core/journal.ts";
import { acquireLock } from "../../core/lock.ts";
import { stateDir, tildePath } from "../../core/paths.ts";
import {
  DEFAULT_OLDER_THAN_DAYS, OLDER_THAN_MAX, OLDER_THAN_MIN, compactJournal, nodeCompactFs, planCompaction,
  type CompactFs, type CompactionPlan,
} from "../../core/compact.ts";
import { reportLockBusy } from "../locked.ts";
import type { Io } from "../main.ts";
import { cliUi, confirm, type CliUi, usageLine } from "../ui.ts";
import { flagsOf } from "../flags.ts";
import { noteLines } from "../screen.ts";
import { parseFlags } from "./quarantine.ts";

export interface JournalDeps {
  home?: string;
  now?: () => number;
  /** The file calls of the compaction (tests fail them on purpose). */
  fs?: CompactFs;
}

/** A size in KB (rounded up; at least 1 KB for a non-empty file), in the screen's number format. */
function kb(ui: CliUi, bytes: number): string {
  return `${ui.f.n(bytes === 0 ? 0 : Math.max(1, Math.ceil(bytes / 1024)))} KB`;
}

function previewLines(ui: CliUi, plan: CompactionPlan, days: number): string[] {
  const out: string[] = [];
  const kept = plan.kept.pending + plan.kept.recent + plan.kept.unfinished;
  if (plan.runs.length === 0) out.push(...noteLines(ui.s, "ok", ui.t("journal.nothing", { days }), ui.width));
  else {
    out.push(...noteLines(ui.s, "info", ui.t("journal.summary", { runs: plan.runs.length, days, entries: plan.entries }), ui.width));
    out.push(...noteLines(ui.s, "info", ui.t("journal.size", { before: kb(ui, plan.bytesBefore), after: kb(ui, plan.bytesAfter) }), ui.width));
  }
  if (kept > 0) out.push(...noteLines(ui.s, "info", ui.t("journal.kept", { n: kept, ...plan.kept }), ui.width));
  return out;
}

export async function journalCommand(args: string[], io: Io, deps: JournalDeps = {}): Promise<number> {
  if (args[0] !== "compact") { usageLine(io, "journal.usage"); return 2; }
  const spec = flagsOf("journal");
  const p = parseFlags(args.slice(1), io, "journal", spec.bool, spec.valued);
  if (!p) return 2;
  let days = DEFAULT_OLDER_THAN_DAYS;
  const raw = p.values.get("--older-than");
  if (raw !== undefined) {
    if (!/^\d+$/.test(raw) || Number(raw) < OLDER_THAN_MIN || Number(raw) > OLDER_THAN_MAX) {
      usageLine(io, "journal.badDays", { value: raw, min: OLDER_THAN_MIN, max: OLDER_THAN_MAX });
      return 2;
    }
    days = Number(raw);
  }
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const fs = deps.fs ?? nodeCompactFs;
  const dir = stateDir(io.env, home);
  const j = new Journal(join(dir, "journal.jsonl"));
  const ui = cliUi(io, { now });
  const say = (l: string[]): void => io.stdout(l.join("\n") + "\n");
  const plan = async (): Promise<CompactionPlan> => {
    const text = await fs.readFile(j.file).then((b) => b.toString("utf8"), (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return "";
      throw e;
    });
    return planCompaction(text, { now: now(), olderThanDays: days });
  };

  const yes = p.flags.has("--yes");
  const dry = p.flags.has("--dry-run");
  if (dry || (!yes && !io.isTTY)) {
    const preview = await plan();
    say(previewLines(ui, preview, days));
    if (preview.runs.length === 0) return 0;
    if (dry) { say(["", ...noteLines(ui.s, "info", ui.t("journal.dry"), ui.width)]); return 0; }
    io.stderr(`${ui.t("journal.needsYes")}\n`);
    return 2;
  }

  const lock = await acquireLock(dir);
  if (!lock) { reportLockBusy(io); return 0; }
  try {
    const rec = await recoverPendingMtimes(j);
    if (rec.restored.length > 0) io.stderr(`${ui.t("apply.recovered", { n: rec.restored.length })}\n`);
    const preview = await plan();
    say(previewLines(ui, preview, days));
    if (preview.runs.length === 0) return 0;
    if (!yes) {
      io.stdout("\n");
      if (!(await confirm(io, ui.t("journal.confirm")))) { io.stdout(`${ui.t("common.nothingChanged")}\n`); return 0; }
    }
    const r = await compactJournal(j, { now, olderThanDays: days, fs });
    if (r.runId === null || r.backup === null) { say(noteLines(ui.s, "ok", ui.t("journal.nothing", { days }), ui.width)); return 0; }
    say(["", ...noteLines(ui.s, "ok", ui.t("journal.done", {
      runs: r.plan.runs.length, entries: r.plan.entries, before: kb(ui, r.plan.bytesBefore), after: kb(ui, r.plan.bytesAfter),
      backup: tildePath(r.backup, home), runId: r.runId,
    }), ui.width)]);
    return 0;
  } finally {
    await lock.release();
  }
}
