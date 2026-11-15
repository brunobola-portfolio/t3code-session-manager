// t3sm merge: bring work continued in a terminal into T3 Code as a revision thread (spec §4.6, src/ops/merge.ts).
// Flow: neither --session nor --all, or --dry-run: list the candidates (read-only, no lock) and exit 0. Writing without
// --yes on a non-terminal: exit 2 before anything else. Otherwise: lock -> recoverPendingMtimes -> connect -> fresh plan
// -> candidates -> confirm -> run-start (only once something is written) -> merges -> run-end.

import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, stateDir } from "../../core/paths.ts";
import { Journal, newRunId, recoverPendingMtimes } from "../../core/journal.ts";
import { acquireLock } from "../../core/lock.ts";
import { connectT3, type T3Api } from "../../t3/api.ts";
import { STOP_SIGNALS, type SignalSource } from "../../apply/apply.ts";
import type { SourceAdapter } from "../../sources/types.ts";
import {
  FAILED_REASONS, executeMerges, findMergeCandidates, setMergePending, type OrphanedWork, type MergeCandidate, type MergeDeps, type MergeSkip, type MergeSkipReason, type MergedSession,
} from "../../ops/merge.ts";
import { freshPlan } from "./plan.ts";
import { parseFlags } from "./quarantine.ts";
import { cliUi, confirm, type CliKey, type CliUi } from "../ui.ts";
import { flagsOf } from "../flags.ts";
import { table } from "../../ui/components.ts";
import { bulletLines, fitLine, noteLines, textLines } from "../screen.ts";
import { folderName } from "../words.ts";
import { shownText } from "../../plan/names.ts";
import { reportLockBusy } from "../locked.ts";
import type { Io } from "../main.ts";

export interface MergeCommandDeps {
  home?: string;
  now?: () => number;
  connect?: (home: string, opts: { allowUntested: boolean; manageProviders: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;
  adapters?: SourceAdapter[];
  existsDir?: (p: string) => Promise<boolean>;
  signals?: SignalSource;
}

const processSignals: SignalSource = {
  on: (sig, fn) => void process.on(sig as NodeJS.Signals, fn),
  off: (sig, fn) => void process.off(sig as NodeJS.Signals, fn),
};

/** Why a session is not merged, in words (a catalogue key per reason). */
const REASON_KEY: Record<MergeSkipReason, CliKey> = {
  "active": "merge.why.active", "not-continued": "merge.why.notContinued", "rehomed-copy": "merge.why.rehomedCopy",
  "no-t3-marker": "merge.why.noT3Marker", "broken-chain": "merge.why.brokenChain", "corrupt-lines": "merge.why.corruptLines",
  "compacted": "merge.why.compacted", "unsettled": "merge.why.unsettled", "thread-archived": "merge.why.threadArchived",
  "revision-in-use": "merge.why.revisionInUse", "already-merged": "merge.why.alreadyMerged", "target-exists": "merge.why.targetExists",
  "copy-failed": "merge.why.copyFailed", "import-failed": "merge.why.importFailed", "import-unverified": "merge.why.importUnverified",
  "project-in-use": "merge.why.projectInUse", "archive-failed": "merge.why.archiveFailed", "over-cap": "merge.why.overCap",
  "clock-jump": "merge.why.clockJump", "file-busy": "merge.why.fileBusy", "aborted": "merge.why.aborted",
};

const short = (id: string): string => id.slice(0, 8);

interface CandidateRow { project: string; session: string; when: string; added: string; title: string }

/** The candidates as a table: project, session, last terminal activity, messages added, the T3 title. */
export function candidateTable(ui: CliUi, cs: MergeCandidate[], width: number = ui.width): string[] {
  const { s, t, f } = ui;
  const rows: CandidateRow[] = cs.map((c) => ({
    project: shownText(folderName(c.projectRoot), 60), session: short(c.nativeId),
    when: c.lastActivity && Number.isFinite(Date.parse(c.lastActivity)) ? f.date(c.lastActivity) : "-",
    added: `+${f.n(c.addedMessages)}`, title: shownText(c.oldTitle, 80),
  }));
  return table(s, [
    { header: t("merge.col.project"), get: (r) => (r as CandidateRow).project, priority: 8 },
    { header: t("merge.col.session"), get: (r) => (r as CandidateRow).session, priority: 9, min: 8 },
    { header: t("merge.col.when"), get: (r) => (r as CandidateRow).when, priority: 5 },
    { header: t("merge.col.added"), get: (r) => (r as CandidateRow).added, align: "right", priority: 7 },
    { header: t("merge.col.title"), get: (r) => (r as CandidateRow).title, priority: 4 },
  ], rows, width);
}

/** Terminal work on a side branch: never merged automatically; the user recovers it in a terminal. */
function orphanLines(ui: CliUi, o: OrphanedWork[], width: number): string[] {
  if (o.length === 0) return [];
  const { s, t } = ui;
  return ["", ...noteLines(s, "warn", t("merge.orphaned", { n: o.length }), width),
    ...o.flatMap((x) => bulletLines(s, `${shownText(folderName(x.projectRoot), 60)} ${short(x.nativeId)}: \`claude --resume ${x.nativeId}\``, width))];
}

/** Why the other sessions are not merged, counted per reason (the ones that were simply not continued are left out). */
function skipLines(ui: CliUi, sk: MergeSkip[], width: number): string[] {
  const by = new Map<MergeSkipReason, number>();
  for (const x of sk) if (x.reason !== "not-continued") by.set(x.reason, (by.get(x.reason) ?? 0) + 1);
  return [...by].flatMap(([r, n]) => bulletLines(ui.s, ui.t("merge.notMergedCount", { n, why: ui.t(REASON_KEY[r]) }), width));
}

/**
 * The listing of `t3sm merge`: how many sessions were continued outside T3 Code, the table, why others are not merged,
 * terminal work on side branches, and (listing only) what a merge would do.
 */
export function renderMergeList(ui: CliUi, chosen: MergeCandidate[], found: { skipped: MergeSkip[]; orphaned: OrphanedWork[] }, o: { listOnly: boolean; all: boolean }, width: number = ui.width): string[] {
  const { s, t } = ui;
  if (chosen.length === 0) {
    return [...noteLines(s, "ok", t("merge.none"), width), ...skipLines(ui, found.skipped, width), ...orphanLines(ui, found.orphaned, width)];
  }
  const out = [...noteLines(s, "info", t("merge.found", { n: chosen.length }), width), "", ...candidateTable(ui, chosen, width)];
  const branches = chosen.filter((c) => c.divergedLeaves > 0);
  for (const c of branches) out.push(...bulletLines(s, t("merge.otherBranches", { session: short(c.nativeId), n: c.divergedLeaves }), width));
  if (o.all) { const k = skipLines(ui, found.skipped, width); if (k.length > 0) out.push("", ...k); out.push(...orphanLines(ui, found.orphaned, width)); }
  if (o.listOnly) out.push("", ...textLines(s, t("merge.howTo"), width));
  return out;
}

/** What a merge did: each new thread, how to continue it, and what could not be merged. */
export function renderMergeResult(ui: CliUi, r: { merged: MergedSession[]; skipped: MergeSkip[] }, runId: string | null, width: number = ui.width): string[] {
  const { s, t, f } = ui;
  const out: string[] = [];
  if (r.merged.length > 0) {
    out.push(...noteLines(s, "ok", runId ? t("merge.doneRun", { n: r.merged.length, runId }) : t("merge.done", { n: r.merged.length }), width));
    for (const m of r.merged) {
      out.push("", ...fitLine(`${s("title", shownText(folderName(m.projectRoot), 60))} ${s("muted", s.sym.sep)} ${short(m.nativeId)}`, width, 2));
      out.push(...bulletLines(s, t("merge.newThread", { thread: shownText(m.newThreadId, 80), n: f.n(m.addedMessages) }), width));
      out.push(...bulletLines(s, t("merge.terminal", { id: m.revisionUuid }), width));
      out.push(...bulletLines(s, t("merge.oldTitle", { title: shownText(m.oldTitle, 80) }), width));
      if (m.divergedLeaves > 0) out.push(...bulletLines(s, t("merge.branchesLeft", { n: m.divergedLeaves }), width));
    }
    out.push("", ...textLines(s, t("merge.note"), width));
  }
  for (const x of r.skipped) out.push(...noteLines(s, "warn", t("merge.notMerged", { session: short(x.nativeId), why: t(REASON_KEY[x.reason]) }), width));
  return out;
}

export async function mergeCommand(args: string[], io: Io, deps: MergeCommandDeps = {}): Promise<number> {
  const spec = flagsOf("merge");
  const p = parseFlags(args, io, "merge", spec.bool, spec.valued);
  if (!p) return 2;
  const session = p.values.get("--session") ?? null;
  const all = p.flags.has("--all");
  const ui = cliUi(io, { now: deps.now });
  const say = (l: string[]): void => io.stdout(l.join("\n") + "\n");
  if (session !== null && all) { io.stderr(`${ui.t("merge.eitherOr")}\n`); return 2; }
  const listOnly = p.flags.has("--dry-run") || (session === null && !all);
  const yes = p.flags.has("--yes");
  if (!listOnly && !yes && !io.isTTY) {
    io.stderr(`${ui.t("merge.needsYes")}\n`);
    return 2;
  }

  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const dir = stateDir(io.env, home);
  const journal = new Journal(join(dir, "journal.jsonl"));
  const connect = deps.connect ?? connectT3;
  const notice = (l: string): void => io.stderr(`${l}\n`);

  const lock = listOnly ? null : await acquireLock(dir);
  if (!listOnly && !lock) { reportLockBusy(io); return 0; }
  const signals = deps.signals ?? processSignals;
  let abort = false;
  const onSignal = (): void => { abort = true; };
  for (const sig of STOP_SIGNALS) signals.on(sig, onSignal);
  try {
    if (!listOnly) {
      const rec = await recoverPendingMtimes(journal);
      if (rec.restored.length > 0) io.stderr(`${ui.t("apply.recovered", { n: rec.restored.length })}\n`);
    }
    const api = await connect(home, { allowUntested: p.flags.has("--allow-untested"), manageProviders: false, onNotice: notice });
    try {
      const fp = await freshPlan(api, {
        home, env: io.env, now, adapters: deps.adapters, existsDir: deps.existsDir, missingConfig: "memory", onNotice: notice, readOnly: listOnly,
      });
      let runId: string | null = null;
      const mdeps: MergeDeps = {
        api, journal, now, stateDir: dir, readOnly: listOnly, retryFailed: true, exposureItems: fp.plan.items, batch: fp.config.batch,
        accountHomes: Object.fromEntries(fp.config.accounts.map((a) => [a.id, expandHome(a.home, home)])),
        aborted: () => abort,
        runId: async () => {
          runId = newRunId(new Date(now()));
          await journal.append({ t: "run-start", runId, at: new Date(now()).toISOString(), command: `merge${session ? ` --session ${session}` : " --all"}` });
          return runId;
        },
      };
      const found = await findMergeCandidates(fp.plan.items, mdeps);
      let chosen = found.candidates;
      if (session !== null) {
        const want = session.toLowerCase();
        const ids = [...new Set(fp.plan.items.filter((i) => i.session.harness === "claude").map((i) => i.session.nativeId))];
        const exact = ids.filter((id) => id.toLowerCase() === want);
        const matches = exact.length > 0 ? exact : want.length >= 8 ? ids.filter((id) => id.toLowerCase().startsWith(want)) : [];
        if (matches.length !== 1) {
          io.stderr(`${matches.length === 0 ? ui.t("merge.noSession", { id: shownText(session, 80) }) : ui.t("merge.ambiguous", { id: shownText(session, 80), n: matches.length })}\n`);
          return 2;
        }
        const id = matches[0]!;
        chosen = found.candidates.filter((c) => c.nativeId === id);
        if (chosen.length === 0) {
          const why = found.skipped.find((s) => s.nativeId === id)?.reason;
          say([...noteLines(ui.s, "ok", ui.t("merge.nothingFor", { session: short(id), why: why ? ui.t(REASON_KEY[why]) : ui.t("merge.why.notInT3") }), ui.width),
            ...orphanLines(ui, found.orphaned.filter((o) => o.nativeId === id), ui.width)]);
          return 0;
        }
      }

      say(renderMergeList(ui, chosen, found, { listOnly, all: session === null }));
      if (chosen.length === 0 || listOnly) return 0;
      if (!yes) {
        io.stdout("\n");
        if (!(await confirm(io, ui.t("merge.confirm", { n: chosen.length })))) { io.stdout(`${ui.t("common.nothingChanged")}\n`); return 0; }
      }

      let status: "ok" | "partial" | "aborted" = "aborted";
      let r: Awaited<ReturnType<typeof executeMerges>>;
      try {
        r = await executeMerges(chosen, mdeps);
        const failed = r.skipped.filter((s) => FAILED_REASONS.has(s.reason)).length;
        status = abort ? "aborted" : failed > 0 ? "partial" : "ok";
      } finally {
        if (runId !== null) await journal.append({ t: "run-end", runId, at: new Date(now()).toISOString(), status });
      }
      if (r.merged.length > 0) await setMergePending(dir, Math.max(0, found.candidates.length - r.merged.length), new Date(now()));

      if (r.merged.length > 0 || r.skipped.length > 0) say(["", ...renderMergeResult(ui, r, runId)]);
      if (abort) { io.stderr(`${ui.t("merge.interrupted")}\n`); return 130; }
      return r.skipped.some((s) => FAILED_REASONS.has(s.reason)) ? 5 : 0;
    } finally {
      await api.close();
    }
  } finally {
    for (const sig of STOP_SIGNALS) signals.off(sig, onSignal);
    await lock?.release();
  }
}
