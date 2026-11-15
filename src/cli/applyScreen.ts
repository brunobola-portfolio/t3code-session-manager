// What `t3sm apply` and `t3sm sync` show while they import and when they finish: one progress bar for the whole import
// ("Importing 5 conversations · 4 projects"; the waves only with --verbose), the result as a panel, the conversations
// held because they are in use, and the failures as a table (src/cli/failures.ts).

import type { ApplyResult } from "../apply/apply.ts";
import type { Progress } from "../apply/importer.ts";
import { shownText } from "../plan/names.ts";
import { kv, panel } from "../ui/components.ts";
import { progressBar, type ExitProc, type ProgressSink } from "../ui/progress.ts";
import { padStart } from "../ui/text.ts";
import { failureTable } from "./failures.ts";
import type { Io } from "./main.ts";
import { fitLine, snugWidth } from "./screen.ts";
import { ioTerm, type CliUi } from "./ui.ts";
import { folderName } from "./words.ts";

/** "Importing 5 conversations · 4 projects". */
export function importLabel(ui: CliUi, n: { sessions: number; projects: number }): string {
  return ui.t("apply.importing", { n: n.sessions, p: n.projects, sep: ui.s.sym.sep });
}

export interface ImportProgress {
  /** ApplyDeps.onImportStart / onWave / onProgress. */
  onImportStart(n: { sessions: number; projects: number }): void;
  onWave(p: Progress): void;
  onProgress(line: string): void;
  /** A notice while the bar is drawn in place (it is printed above the bar); null when it should go to stderr as usual. */
  note(line: string): boolean;
  /** The bar's last line (no-op when no import started). */
  end(): void;
  dispose(): void;
}

/**
 * One progress bar for the waves of one import. `silent`: nothing at all (--quiet, --watch). `verbose`: every wave's line
 * too (above the bar on a terminal).
 */
export function importProgress(io: Io, ui: CliUi, clock: () => number, o: { silent: boolean; verbose: boolean; proc?: ExitProc }): ImportProgress {
  let bar: ProgressSink | null = null;
  let total = 0;
  let done = 0; // imported, failed or deferred: the bar's progress
  let imported = 0;
  let started = 0;
  const live = (): boolean => bar !== null && (ui.s.caps.cursor ?? ui.s.caps.isTTY);
  return {
    onImportStart(n) {
      if (o.silent || n.sessions === 0) return;
      // The label already says how many: no "(5)" after it.
      bar = progressBar(ioTerm(io, ui), ui.s, ui.f, clock, { words: { left: ui.t("progress.left") }, showTotal: false, ...(o.proc ? { proc: o.proc } : {}) });
      total = n.sessions;
      started = clock();
      bar.start(total, importLabel(ui, n));
    },
    onWave(p) {
      done += p.imported + p.failed + p.deferred;
      imported += p.imported;
      if (done > total) total = done;
      bar?.tick(Math.min(done, total));
    },
    onProgress(line) {
      if (o.silent || !o.verbose) return;
      if (bar) bar.note(line);
      else io.stdout(`${line}\n`);
    },
    note(line) {
      if (!live()) return false;
      bar!.note(line);
      return true;
    },
    end() {
      if (!bar) return;
      const dur = ui.f.dur(clock() - started);
      // Only what was imported is called imported: the rest failed or waits (the result panel says which).
      bar.end(imported === done ? ui.t("apply.importDone", { n: imported, total, dur })
        : ui.t("apply.importDoneMixed", { done, total, dur, n: imported, sep: ui.s.sym.sep }));
    },
    dispose() { bar?.dispose(); },
  };
}

/** Why a held project waits, in the user's language: "<project> waits: '<title>' is in use (written 3 min ago); ...". */
export function waitingLines(ui: CliUi, held: ApplyResult["held"], width: number = ui.width): string[] {
  return held.flatMap((h) => {
    const title = shownText(h.title ?? (h.file.split(/[\\/]/).pop() || h.file), 120);
    return fitLine(`${ui.s("warn", ui.s.sym.warn)} ${ui.t("apply.waiting", { project: shownText(h.project, 120), title, ago: ui.f.ago(h.modifiedAt) })}`, width, 2);
  });
}

/**
 * The result panel's rows: the counts aligned, with what they mean, and the run with how to undo it. Held projects named
 * under the panel (`heldNamed`) are only counted here: the lines under it say why.
 */
function resultRows(ui: CliUi, r: ResultCounts): [string, string][] {
  const { s, t, f } = ui;
  const rows: [string, number, string | null][] = [[t("apply.label.imported"), r.imported, null]];
  if (r.failed) rows.push([t("apply.label.failed"), r.failed, null]);
  if (r.converted) rows.push([t("apply.label.converted"), r.converted, null]);
  if (r.unverified) rows.push([t("apply.label.unverified"), r.unverified, null]);
  if (r.alreadyInT3) rows.push([t("apply.label.already"), r.alreadyInT3, null]);
  if (r.deferred) rows.push([t("apply.label.deferred"), r.deferred, "apply.value.deferred"]);
  if (r.held) rows.push([t("apply.label.held"), r.held, r.heldNamed ? null : "apply.value.held"]);
  const nw = Math.max(...rows.map(([, n]) => f.n(n).length));
  const out: [string, string][] = rows.map(([k, n, more]) => {
    const num = s("num", padStart(f.n(n), nw));
    return [k, more === null ? num : t(more as "apply.value.deferred", { n: num })];
  });
  if (r.runId) {
    out.push([t("apply.label.run"), t("apply.value.run", { runId: shownText(r.runId, 60) })]);
    if (r.imported > 0 || r.converted > 0) out.push([t("apply.label.undo"), s("key", `t3sm rollback --run ${shownText(r.runId, 60)} --archive-threads`)]);
  }
  return out;
}

export interface ResultCounts {
  status: "ok" | "partial" | "aborted" | "noop";
  imported: number; failed: number; converted: number; unverified: number; alreadyInT3: number;
  /** Deferred for another reason than a project in use (next run). */
  deferred: number;
  /** Held because a conversation of their project is in use. */
  held: number;
  /** The held projects are named, with why, under the panel. */
  heldNamed?: boolean;
  runId: string | null;
}

/** The result as a panel: the title says what happened, the rows the counts. */
export function resultPanel(ui: CliUi, c: ResultCounts, width: number = ui.width): string[] {
  const { t } = ui;
  const tone = c.status === "aborted" || c.failed > 0 || c.unverified > 0 ? "warn" : "ok";
  const title = c.status === "aborted" ? t("apply.title.aborted", { n: c.imported })
    : c.failed > 0 ? t("apply.title.partial", { n: c.imported, failed: c.failed })
    : c.unverified > 0 ? t("apply.title.unverified", { n: c.imported, u: c.unverified })
    : c.imported === 0 && c.converted === 0 && c.held + c.deferred > 0 ? t("apply.title.waiting", { n: c.held + c.deferred })
    : c.imported === 0 && c.converted === 0 ? t("apply.title.nothing")
    : t("apply.title.ok", { n: c.imported });
  const body = kv(ui.s, resultRows(ui, c), Math.max(1, width - 4));
  return panel(ui.s, { tone, title, body }, snugWidth(title, body, width));
}

/**
 * `t3sm apply`'s result: the panel, why each held project waits, held projects with no transcript to name, and the
 * failures as a table.
 */
export function renderApplyResult(ui: CliUi, r: ApplyResult, width: number = ui.width): string[] {
  const status = r.status === "aborted" ? "aborted" : r.status === "partial" ? "partial" : "ok";
  const out = resultPanel(ui, {
    status, imported: r.imported, failed: r.failed, converted: r.converted, unverified: r.unverified, alreadyInT3: r.alreadyInT3,
    deferred: r.deferred - r.deferredInUse, held: r.deferredInUse, heldNamed: r.heldRoots.length > 0, runId: r.runId,
  }, width);
  // Each held project once, with why: the conversation in use, else (a file stayed locked) the project alone.
  const unexplained = r.heldRoots.filter((x) => !r.held.some((h) => h.root === x));
  const lines = [...waitingLines(ui, r.held, width),
    ...unexplained.flatMap((x) => fitLine(`${ui.s("warn", ui.s.sym.warn)} ${ui.t("apply.heldHint", { project: shownText(folderName(x), 60) })}`, width, 2))];
  if (lines.length > 0) out.push("", ...lines);
  if (r.failures.length > 0) out.push("", ...failureTable(ui, r.failures, width));
  return out;
}

