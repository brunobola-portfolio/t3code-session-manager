// `t3sm stats`: what the user has, counted on this machine from discovery (the same adapters scan and plan use), t3sm's
// journal (what was imported and converted) and the latest plan (what it skips, and why). Pure: the command gathers the
// inputs read-only and this file only counts. Nothing is sent anywhere.

import type { DiscoveredSession, JournalEntry, Plan, SkipReason } from "../core/types.ts";
import { effectiveWrites } from "../core/journal.ts";
import { shownAccountName } from "../plan/names.ts";

export interface StatsInput {
  sessions: DiscoveredSession[];
  journal: JournalEntry[];
  /** The newest runs/<runId>/plan.json, or null when there is none (or it cannot be read). */
  latestPlan: Plan | null;
  /** Account id -> display name (config.json); masked here. */
  names: Readonly<Record<string, string>>;
  /** Agents whose adapter is not available on this machine. */
  unavailable: string[];
  /** Per-file read errors the adapters recorded. */
  readErrors: number;
}

/** `t3sm stats --json` prints this as it is: English keys, account names masked, no paths and no session content. */
export interface Stats {
  sessions: number;
  readErrors: number;
  notInstalled: string[];
  /** Sessions per agent, most first. */
  agents: { agent: string; sessions: number }[];
  /** Claude Code sessions per account, most first; `name` is the masked display name, null when config.json has none. */
  accounts: { accountId: string; name: string | null; sessions: number }[];
  /** Sessions per month they started (UTC, YYYY-MM), oldest first; a session without a readable date is `undated`. */
  months: { month: string; sessions: number }[];
  undated: number;
  imported: {
    /** Distinct sessions imported into T3 Code (a rolled-back run counts for nothing). */
    threads: number;
    byAgent: { agent: string; threads: number }[];
    /** Sessions of another agent t3sm converted into a Claude transcript. */
    converted: number;
    /** Sessions whose import failed and that were never imported since. */
    failed: number;
    /** Runs that imported something. */
    runs: number;
    /** When the newest of those runs started, or null. */
    lastAt: string | null;
  };
  /** The latest plan's counts, or null without one. */
  latestPlan: { runId: string; createdAt: string; import: number; convert: number; skip: number; skipped: { reason: SkipReason; sessions: number }[] } | null;
}

const byCount = <T extends { k: string; n: number }>(a: T, b: T): number => b.n - a.n || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0);

function tally<T>(xs: Iterable<T>, key: (x: T) => string | null): { k: string; n: number }[] {
  const m = new Map<string, number>();
  for (const x of xs) {
    const k = key(x);
    if (k !== null) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].map(([k, n]) => ({ k, n })).sort(byCount);
}

/** The month a session started (UTC), from startedAt, else its last activity; null when neither is a date. */
function monthOf(s: DiscoveredSession): string | null {
  for (const v of [s.startedAt, s.updatedAt]) {
    if (typeof v !== "string") continue;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 7);
  }
  return null;
}

export function computeStats(i: StatsInput): Stats {
  const months = tally(i.sessions, monthOf).sort((a, b) => (a.k < b.k ? -1 : 1));
  const undated = i.sessions.length - months.reduce((n, m) => n + m.n, 0);

  // The journal: runs a rollback undid count for nothing.
  const undone = new Set<string>();
  const startedAt = new Map<string, string>();
  for (const e of i.journal) {
    if (e.t === "rolled-back") undone.add(e.targetRunId);
    else if (e.t === "run-start") startedAt.set(e.runId, e.at);
  }
  const imported = new Map<string, string>(); // harness:nativeId -> harness
  const importRuns = new Set<string>();
  for (const e of i.journal) {
    if (e.t !== "imported" || undone.has(e.runId)) continue;
    imported.set(`${e.harness}:${e.nativeId}`, e.harness);
    importRuns.add(e.runId);
  }
  const failed = new Set<string>();
  for (const e of i.journal) {
    if (e.t === "import-failed" && !undone.has(e.runId) && !imported.has(`${e.harness}:${e.nativeId}`)) failed.add(`${e.harness}:${e.nativeId}`);
  }
  const converted = new Set<string>();
  for (const w of effectiveWrites(i.journal)) {
    if (w.source && !w.revisionOf && !undone.has(w.runId)) converted.add(`${w.source.harness}:${w.source.nativeId}`);
  }
  const lastAt = [...importRuns].map((r) => startedAt.get(r)).filter((x): x is string => typeof x === "string").sort().at(-1) ?? null;

  let latestPlan: Stats["latestPlan"] = null;
  if (i.latestPlan) {
    const p = i.latestPlan;
    const kinds = tally(p.items, (it) => it.action.kind);
    const n = (k: string): number => kinds.find((x) => x.k === k)?.n ?? 0;
    latestPlan = {
      runId: p.runId, createdAt: p.createdAt, import: n("import"), convert: n("convert-import"), skip: n("skip"),
      skipped: tally(p.items, (it) => (it.action.kind === "skip" ? it.action.reason : null)).map((x) => ({ reason: x.k as SkipReason, sessions: x.n })),
    };
  }

  return {
    sessions: i.sessions.length,
    readErrors: i.readErrors,
    notInstalled: [...i.unavailable],
    agents: tally(i.sessions, (s) => s.harness).map((x) => ({ agent: x.k, sessions: x.n })),
    accounts: tally(i.sessions, (s) => (s.harness === "claude" && s.accountId !== null ? s.accountId : null)).map((x) => {
      const name = i.names[x.k];
      return { accountId: x.k, name: typeof name === "string" && name.trim() !== "" ? shownAccountName(name) : null, sessions: x.n };
    }),
    months: months.map((x) => ({ month: x.k, sessions: x.n })),
    undated,
    imported: {
      threads: imported.size,
      byAgent: tally(imported.values(), (h) => h).map((x) => ({ agent: x.k, threads: x.n })),
      converted: converted.size,
      failed: failed.size,
      runs: importRuns.size,
      lastAt,
    },
    latestPlan,
  };
}
