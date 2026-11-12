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
  FAILED_REASONS, executeMerges, findMergeCandidates, setMergePending, type OrphanedWork, type MergeCandidate, type MergeDeps, type MergeSkip, type MergeSkipReason,
} from "../../ops/merge.ts";
import { freshPlan } from "./plan.ts";
import { confirm, parseFlags } from "./quarantine.ts";
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

const REASON_TEXT: Record<MergeSkipReason, string> = {
  "active": "written in the last 10 minutes; close it (or wait) and run again",
  "not-continued": "no terminal work since t3sm imported it (no message from another entrypoint on the branch `claude --resume` continues)",
  "no-t3-marker": "T3 Code wrote to it, but no record carries T3 Code's marker (entrypoint \"t3-code\"); not merged to be safe",
  "broken-chain": "its message chain is broken (a missing parent or a cycle); a revision would be truncated",
  "corrupt-lines": "unreadable lines inside its message chain; a revision would be truncated",
  "compacted": "this session was compacted; merging compacted sessions is not supported yet",
  "unsettled": "its last line is incomplete (being written?); run again later",
  "thread-archived": "its T3 Code thread is archived",
  "revision-in-use": "the revision t3sm wrote earlier was continued since; continue there (or run `t3sm rollback`)",
  "already-merged": "already merged (its revision thread is in T3 Code)",
  "target-exists": "a file t3sm did not write already sits at the revision path; left alone",
  "copy-failed": "the transcript could not be read or the revision could not be written",
  "import-failed": "T3 Code did not import the revision; the revision was removed and the old thread left as it was",
  "import-unverified": "T3 Code's thread list could not be read after the import; run `t3sm merge` again",
  "project-in-use": "another session of its project is in use; run again when it is idle",
  "archive-failed": "the new thread exists but the old one could not be archived; run `t3sm merge` again",
  "over-cap": "over this run's limit; run again",
  "clock-jump": "the system clock jumped (sleep or a time change) during the import; run again",
  "file-busy": "a session file of its project was locked by another program; run again",
  "aborted": "interrupted before it was merged",
};

const baseName = (root: string): string => root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || root;
const short = (id: string): string => id.slice(0, 8);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const when = (iso: string | null): string => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") : "-");

const NOTE = `The revision is a new session file next to the original; the original session file is never changed. After a merge, continue on the new thread in T3 Code, or in a
terminal with \`claude --resume <revision id>\`. The original session id stays resumable in the terminal but
is now a stale branch, and \`claude --resume\`'s picker lists both. Never have the same session open in T3 Code
and a terminal at the same time.
`;

function table(cs: MergeCandidate[]): string {
  const rows: string[][] = [["Project", "Session", "Last terminal activity (UTC)", "Messages added", "T3 title"]];
  for (const c of cs) {
    rows.push([baseName(c.projectRoot), short(c.nativeId), when(c.lastActivity), `+${c.addedMessages}${c.divergedLeaves ? ` (${c.divergedLeaves} other branch${c.divergedLeaves === 1 ? "" : "es"} not merged)` : ""}`, c.oldTitle]);
  }
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => `  ${r.map((x, i) => x.padEnd(w[i]!)).join("  ").trimEnd()}`).join("\n") + "\n";
}

/** Terminal work on a side branch: never merged automatically; the user recovers it in a terminal. */
function orphanText(o: OrphanedWork[]): string {
  if (o.length === 0) return "";
  const lines = o.map((x) => `  ${baseName(x.projectRoot)} ${short(x.nativeId)}: claude --resume ${x.nativeId}\n`).join("");
  return `\n${plural(o.length, "session has", "sessions have")} terminal work on a side branch that T3 Code cannot show (never merged:
it is not the branch \`claude --resume\` continues). Recover it in a terminal:\n${lines}`;
}

function skipSummary(sk: MergeSkip[]): string {
  const by = new Map<MergeSkipReason, number>();
  for (const s of sk) if (s.reason !== "not-continued") by.set(s.reason, (by.get(s.reason) ?? 0) + 1);
  return [...by].map(([r, n]) => `  ${plural(n, "session", "sessions")} not merged: ${REASON_TEXT[r]}\n`).join("");
}

export async function mergeCommand(args: string[], io: Io, deps: MergeCommandDeps = {}): Promise<number> {
  const p = parseFlags(args, io, "merge", ["--all", "--dry-run", "--yes", "--allow-untested"], ["--session"]);
  if (!p) return 2;
  const session = p.values.get("--session") ?? null;
  const all = p.flags.has("--all");
  if (session !== null && all) { io.stderr("Use either --session <id> or --all. Run `t3sm merge --help`.\n"); return 2; }
  const listOnly = p.flags.has("--dry-run") || (session === null && !all);
  const yes = p.flags.has("--yes");
  if (!listOnly && !yes && !io.isTTY) {
    io.stderr("Refusing to change T3 Code without confirmation: pass --yes (non-interactive), or --dry-run to only list.\n");
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
      if (rec.restored.length > 0) io.stderr(`Restored the file times of ${rec.restored.length} transcript(s) left by an interrupted run.\n`);
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
          io.stderr(matches.length === 0
            ? `No Claude session ${session} found. Run \`t3sm merge\` to list the candidates.\n`
            : `${session} matches ${matches.length} sessions; give more of the id.\n`);
          return 2;
        }
        const id = matches[0]!;
        chosen = found.candidates.filter((c) => c.nativeId === id);
        if (chosen.length === 0) {
          const why = found.skipped.find((s) => s.nativeId === id)?.reason;
          io.stdout(`Session ${short(id)}: nothing to merge (${why ? REASON_TEXT[why] : "it is not in T3 Code as an active imported thread"}).\n`);
          io.stdout(orphanText(found.orphaned.filter((o) => o.nativeId === id)));
          return 0;
        }
      }

      if (chosen.length === 0) {
        io.stdout("No sessions to merge: nothing was continued outside T3 Code since it was imported.\n");
        io.stdout(skipSummary(found.skipped));
        io.stdout(orphanText(found.orphaned));
        return 0;
      }
      io.stdout(`${plural(chosen.length, "session was", "sessions were")} continued outside T3 Code:\n`);
      io.stdout(table(chosen));
      if (session === null) io.stdout(skipSummary(found.skipped) + orphanText(found.orphaned));
      if (listOnly) {
        io.stdout(`\nRun \`t3sm merge --all\` to merge them, or \`t3sm merge --session <id>\` for one. Each becomes a new T3 Code
thread with the terminal work; the old thread is archived (undo with \`t3sm rollback\`). Nothing was changed.\n`);
        return 0;
      }
      if (!yes && !(await confirm(io, `Merge ${plural(chosen.length, "session", "sessions")} into new threads and archive the old ones?`))) {
        io.stdout("Nothing changed.\n");
        return 0;
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

      if (r.merged.length > 0) {
        io.stdout(`\nMerged ${plural(r.merged.length, "session", "sessions")}.${runId ? ` Run ${runId}; undo with \`t3sm rollback --run ${runId}\`.` : ""}\n`);
        for (const m of r.merged) {
          io.stdout(`  ${baseName(m.projectRoot)} ${short(m.nativeId)}: new thread ${m.newThreadId} (+${m.addedMessages} messages); old thread archived.\n`);
          io.stdout(`    Terminal: claude --resume ${m.revisionUuid}\n`);
          io.stdout(`    T3 Code titles the new thread from its transcript; the old thread was titled "${m.oldTitle}" (rename the new one in T3 Code if you like).\n`);
          if (m.divergedLeaves > 0) io.stdout(`    ${plural(m.divergedLeaves, "other branch", "other branches")} of the original transcript (not the one \`claude --resume\` continues) was not merged.\n`);
        }
        io.stdout(`\n${NOTE}`);
      }
      for (const s of r.skipped) io.stdout(`  ${short(s.nativeId)}: not merged: ${REASON_TEXT[s.reason]}\n`);
      if (abort) { io.stderr("Interrupted: file times restored; run `t3sm merge` again to continue.\n"); return 130; }
      return r.skipped.some((s) => FAILED_REASONS.has(s.reason)) ? 5 : 0;
    } finally {
      await api.close();
    }
  } finally {
    for (const sig of STOP_SIGNALS) signals.off(sig, onSignal);
    await lock?.release();
  }
}
