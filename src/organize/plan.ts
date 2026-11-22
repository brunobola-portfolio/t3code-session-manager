// What `t3sm organize` would change in T3 Code (spec §5), decided from a T3 snapshot, the journal and the config.
// Pure: no I/O, no clock (input.now). Task 12 applies the plan; organize, sync and the assistant build it.
//
// Rules (spec §5, controller rulings):
// - Thread actions only for `import:*` threads (and scope.onlyThreads when given; the history rule follows
//   scope.historyThreads instead when given); a native T3 thread is never in it.
// - User-touched: for each target t3sm changed (journal `organize-change`), the latest change of that family
//   (archive | title | settle | pin; settle covers settle and unsettle) is compared with the current state; a difference
//   means the user changed it, and no action of that family is planned on that target again, the opposite one included.
//   In the settle family a thread t3sm never changed is user-touched too when only a person makes its state: shown
//   (override "active": imports arrive settled), or settled again after an unsettle (`unsettledAt` set). A thread back
//   at t3sm's value is user-touched when T3 dated a settle or unsettle after t3sm's run (away and back by hand):
//   `unsettledAt`, or `settledAt` while settled, later than the run's bound + OWN_WRITE_MARGIN_MS. The bound is the
//   run's end; for a run killed before its run-end, the next run's start (runs are serialised by the lock), else `now`
//   (the planner runs under the lock: no earlier run can still be writing). A follow's revision thread (a standing
//   `followed` entry names it as newThread) is user-touched in the settle family when its old thread is: follow carries
//   the old thread's settled state, and a state the user chose there stays theirs.
// - History (spec §5.2, src/organize/history.ts): per project, recent conversations shown, at least `minPerProject`
//   shown, older ones settled (they stay on the project's Settled shelf). Native, pinned and automated threads and
//   those of an unknown settle state count toward the minimum but never move; archived and to-be-archived threads
//   neither count nor move.
// - project-delete only for projects t3sm created with zero threads (any state): T3 refuses to delete a project that
//   still holds a thread unless `force`, which t3sm never sends. Never one created in the last 24 h, nor one with
//   sessions waiting to import (input.keepProjects): apply creates a held root's project empty and imports later.
import { normalizeHistory } from "../core/history.ts";
import type { JournalEntry, OrganizeKind } from "../core/types.ts";
import { SETTLE_BACKDATE } from "../t3/compat.ts";
import type { T3Project, T3Thread } from "../t3/decode.ts";
import { DAY_MS, historyActions, isOnSettledShelf, isVisibleInProject, ms, settleShown } from "./history.ts";
import { isTechnicalTitle } from "./titles.ts";
import type { OrganizeAction, OrganizeInput, OrganizePlan } from "./types.ts";

/**
 * T3 dates t3sm's own settle / unsettle when it applies it, inside t3sm's run: a date up to this long after the run's
 * bound is t3sm's own (clock rounding between the two processes on one machine).
 */
const OWN_WRITE_MARGIN_MS = 60_000;

export const AUTO_SETTLE_TARGET = "sidebarAutoSettleAfterDays";

type Family = "archive" | "title" | "settle" | "pin";

const FAMILY: Partial<Record<OrganizeKind, Family>> = {
  archive: "archive", title: "title", unsettle: "settle", settle: "settle", pin: "pin", unpin: "pin",
};

/** Latest `next` t3sm recorded per family and target ("family\u0000target"), and the run that recorded it. */
function lastChanges(journal: JournalEntry[]): { next: Map<string, unknown>; runOf: Map<string, string> } {
  const next = new Map<string, unknown>();
  const runOf = new Map<string, string>();
  for (const e of journal) {
    if (e.t !== "organize-change") continue;
    const f = FAMILY[e.kind];
    if (!f) continue;
    const k = `${f}\u0000${e.target}`;
    next.set(k, settleShown(e.kind, e.next));
    runOf.set(k, e.runId);
  }
  return { next, runOf };
}

export { isOnSettledShelf, isVisibleInProject };

const KINDS: OrganizeKind[] = ["archive", "title", "ai-title", "unsettle", "settle", "pin", "unpin", "project-delete", "project-title", "auto-settle"];

export function buildOrganizePlan(i: OrganizeInput): OrganizePlan {
  const cfg = i.config;
  const { next: last, runOf } = lastChanges(i.journal);
  /** t3sm's latest change of `family` on `target` is not the current state: the user changed it since. */
  const touched = (family: Family, target: string, current: unknown): boolean => {
    const k = `${family}\u0000${target}`;
    return last.has(k) && last.get(k) !== current;
  };
  const isTechnical = i.isTechnicalTitle ?? isTechnicalTitle;
  const category = (projectId: string) => i.projectCategory?.get(projectId) ?? "project";

  const created = new Set<string>();
  /** project id -> when t3sm created it (its run's start, else the time in its run id); absent when unknown. */
  const createdAt = new Map<string, number>();
  const runStart = new Map<string, number>();
  /** run id -> the latest time it can have written: its run-end, else the next run's start, else now. */
  const runBound = new Map<string, number>();
  {
    const unended: string[] = [];
    for (const e of i.journal) {
      if (e.t !== "run-start" && e.t !== "run-end") continue;
      const at = Date.parse(e.at);
      if (!Number.isFinite(at)) continue;
      if (e.t === "run-end") { runBound.set(e.runId, at); continue; }
      runStart.set(e.runId, at);
      // A run still open when the next one starts was killed (the lock serialises runs): bounded by that start.
      for (const r of unended.splice(0)) if (!runBound.has(r)) runBound.set(r, at);
      unended.push(e.runId);
    }
    for (const r of unended) if (!runBound.has(r)) runBound.set(r, i.now);
  }
  for (const e of i.journal) {
    if (e.t !== "project-created") continue;
    created.add(e.projectId);
    const at = runStart.get(e.runId) ?? runIdTime(e.runId);
    if (at !== null) createdAt.set(e.projectId, at);
  }

  const inScope = (t: T3Thread): boolean =>
    t.id.startsWith("import:") && (i.scope.onlyThreads === undefined || i.scope.onlyThreads.has(t.id));

  const archive: OrganizeAction[] = [];
  const title: OrganizeAction[] = [];
  const archived = new Set<string>();
  const aiCandidates: T3Thread[] = [];
  /** Threads T3 Code was asked to title; one it then failed to write may be asked again. */
  const aiTitled = new Set<string>();
  for (const e of i.journal) {
    if (e.t === "organize-change" && e.kind === "ai-title") aiTitled.add(e.target);
    else if (e.t === "organize-failed" && e.kind === "ai-title") aiTitled.delete(e.target);
  }

  for (const t of i.threads) {
    if (!inScope(t)) continue;
    // A settle state this t3sm does not know (a newer T3 Code): nothing is planned for that thread.
    if (t.settledOverride === "unknown") continue;
    const s = i.sessions.get(t.id);
    const automated = s?.origin === "automated";

    // 5.1 / 5.5: archive automated sessions, and threads of a t3sm project in a temp/system folder (unless the user
    // chose to import that folder kind).
    if (!t.archived && !touched("archive", t.id, t.archived)) {
      const cat = category(t.projectId);
      let reason: string | null = null;
      if (cfg.archiveAutomated && automated) reason = "automated session (Agent SDK)";
      else if (i.archiveFolders !== false && (cat === "temp" || cat === "system") && created.has(t.projectId) && cfg.folders[cat] !== "import") {
        reason = `${cat} folder`;
      }
      if (reason !== null) {
        archive.push({ kind: "archive", target: t.id, projectId: t.projectId, previous: false, next: true, reason });
        archived.add(t.id);
      }
    }

    // 5.2: a new title when T3's title is technical, or still the one t3sm set. Not for archived or to-be-archived
    // threads (R16).
    // A thread T3 Code was asked to title (ai-title, any run) is never retitled again: its title is T3's, or the user's.
    const proposal = s?.title ?? null;
    let retitled = false;
    const titleFree = !t.archived && !archived.has(t.id) && !aiTitled.has(t.id) && !touched("title", t.id, t.title);
    if (cfg.titles && titleFree && proposal !== null && proposal !== t.title) {
      const k = `title\u0000${t.id}`;
      const ours = last.has(k) && last.get(k) === t.title;
      if (ours || isTechnical(t.title)) {
        title.push({
          kind: "title", target: t.id, projectId: t.projectId, previous: t.title, next: proposal,
          reason: ours ? "title set by t3sm earlier" : "technical title",
        });
        retitled = true;
      }
    }
    // A title that stays technical (no clean one from the transcript): T3 Code may write it (`--ai-titles`), unless an
    // automated conversation (archived, or noise) or one T3 Code is retitling right now.
    if (i.aiTitles && titleFree && !retitled && !automated && t.titleRegeneration == null && isTechnical(t.title)) {
      aiCandidates.push(t);
    }
  }

  // The cap spends the tokens on the most recent conversations (no activity date last, then by id).
  aiCandidates.sort((a, b) => (ms(b.latestUserMessageAt) ?? -Infinity) - (ms(a.latestUserMessageAt) ?? -Infinity) || cmp(a.id, b.id));
  const aiTitle: OrganizeAction[] = i.aiTitles === undefined ? [] : aiCandidates.slice(0, Math.max(0, i.aiTitles.max)).map((t) => ({
    kind: "ai-title", target: t.id, projectId: t.projectId, previous: t.title, next: null, reason: "technical title",
  }));

  // History (spec §5.2, §5.3): the rule, per project, over every thread (native and pinned ones count toward the minimum).
  /** A settle state only a person makes, or one changed since t3sm's last change of the settle family. */
  const settleTouched = (t: T3Thread, seen: Set<string> = new Set()): boolean => {
    if (ownSettleTouched(t)) return true;
    // A follow's revision thread (src/ops/follow.ts) continues its old thread and carries its settled state: a state the
    // user chose there stays theirs here (spec §5.2: manual choices win), whether the carry had to be sent or not.
    const from = followedFrom.get(t.id);
    const old = from === undefined || seen.has(from) ? undefined : threadById.get(from);
    return old !== undefined && settleTouched(old, seen.add(t.id));
  };
  /** newThread -> oldThread of every standing revision `followed` entry (a rolled-back run counts for nothing). */
  const followedFrom = new Map<string, string>();
  {
    const rolledBack = new Set(i.journal.flatMap((e) => (e.t === "rolled-back" ? [e.targetRunId] : [])));
    for (const e of i.journal) if (e.t === "followed" && typeof e.newThread === "string" && !rolledBack.has(e.runId)) followedFrom.set(e.newThread, e.oldThread);
  }
  const threadById = new Map(i.threads.map((t) => [t.id, t] as const));
  function ownSettleTouched(t: T3Thread): boolean {
    const cur = t.settledOverride ?? null;
    const k = `settle\u0000${t.id}`;
    if (!last.has(k)) return cur === "active" || (cur === "settled" && t.unsettledAt != null);
    if (touched("settle", t.id, cur)) return true;
    // Back at t3sm's value: by hand when T3 dated a settle or unsettle after t3sm's run (A -> B -> A). The run's bound
    // (runBound) is the latest time t3sm's own write can carry. A run with no run-start nor run-end: not checked.
    const ref = runBound.get(runOf.get(k)!);
    if (ref === undefined) return false;
    const after = (v: string | null | undefined): boolean => { const x = ms(v); return x !== null && x > ref + OWN_WRITE_MARGIN_MS; };
    return after(t.unsettledAt) || (cur === "settled" && after(t.settledAt));
  }
  const historyScope = i.scope.historyThreads;
  const inHistory = (t: T3Thread): boolean => (historyScope === undefined ? inScope(t) : t.id.startsWith("import:") && historyScope.has(t.id));
  const movable = (t: T3Thread): boolean =>
    inHistory(t) && !t.archived && !archived.has(t.id) && t.pinnedAt == null && t.settledOverride !== "unknown" &&
    i.sessions.get(t.id)?.origin !== "automated" && !settleTouched(t);
  const rule = normalizeHistory(cfg.history);
  const history = rule === null ? [] : historyActions(
    i.threads.map((t) => (archived.has(t.id) ? { ...t, archived: true } : t)), rule, i.now,
    // T3 Code's own auto-settle as it will be after this run (this run's change, else its current value): the marks.
    { movable, backdate: i.backdate ?? SETTLE_BACKDATE, t3AutoSettleDays: i.autoSettle ? i.autoSettle.want : i.t3AutoSettleDays },
  );
  const unsettle = history.filter((a) => a.kind === "unsettle");
  const settle = history.filter((a) => a.kind === "settle");
  const unsettled = new Set(unsettle.map((a) => a.target));
  const settled = new Set(settle.map((a) => a.target));

  // 5.4: pin the most recently active projects.
  const pin: OrganizeAction[] = [];
  const unpin: OrganizeAction[] = [];
  if (i.scope.allowPins && cfg.pinRecent.enabled) {
    const count = cfg.pinRecent.count;
    const newest = new Map<string, number>();
    for (const t of i.threads) {
      if (t.archived || archived.has(t.id)) continue; // noise does not make a project recent
      const at = ms(t.latestUserMessageAt);
      if (at === null) continue;
      const prev = newest.get(t.projectId);
      if (prev === undefined || at > prev) newest.set(t.projectId, at);
    }
    const ranked = i.projects
      .filter((p) => !p.deleted && !p.archived && newest.has(p.id))
      .sort((a, b) => (newest.get(b.id)! - newest.get(a.id)!) || cmp(a.title, b.title) || cmp(a.id, b.id));
    const top = ranked.slice(0, count);
    const topIds = new Set(top.map((p) => p.id));
    const reason = `top ${count} recent`;
    for (const p of top) {
      if (p.pinned || touched("pin", p.id, p.pinned)) continue;
      pin.push({ kind: "pin", target: p.id, projectId: p.id, previous: false, next: true, reason });
    }
    for (const p of i.projects) {
      if (p.deleted || !p.pinned || topIds.has(p.id)) continue;
      const k = `pin\u0000${p.id}`;
      if (!last.has(k) || last.get(k) !== true) continue; // only pins t3sm made and the user left alone
      unpin.push({ kind: "unpin", target: p.id, projectId: p.id, previous: true, next: false, reason: `left the ${reason}` });
    }
  }

  // 5.5: delete empty projects t3sm created.
  const del: OrganizeAction[] = [];
  if (i.scope.allowDeletes) {
    const withThreads = new Set(i.threads.map((t) => t.projectId));
    for (const p of i.projects) {
      if (p.deleted || !created.has(p.id) || withThreads.has(p.id)) continue;
      // Its sessions may still be on their way (held while a conversation was in use): kept for now.
      if (i.keepProjects?.has(p.id)) continue;
      const at = createdAt.get(p.id);
      if (at !== undefined && i.now - at < DAY_MS) continue;
      del.push({
        kind: "project-delete", target: p.id, projectId: p.id,
        previous: { title: p.title, workspaceRoot: p.workspaceRoot }, next: null, reason: "created by t3sm, no threads",
      });
    }
  }

  const auto: OrganizeAction[] = [];
  if (i.autoSettle && i.autoSettle.want !== i.autoSettle.current) {
    auto.push({
      kind: "auto-settle", target: AUTO_SETTLE_TARGET, projectId: null,
      previous: i.autoSettle.current, next: i.autoSettle.want, reason: "global auto-settle",
    });
  }

  const actions = [...archive, ...title, ...aiTitle, ...unsettle, ...settle, ...pin, ...unpin, ...del, ...auto];
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<OrganizeKind, number>;
  for (const a of actions) counts[a.kind]++;

  return {
    runId: i.runId, actions, counts, byProject: byProject(i.projects, i.threads, archived, unsettled, settled),
    ...(i.aiTitles !== undefined ? { aiTitles: { eligible: aiCandidates.length, max: i.aiTitles.max } } : {}),
  };
}

/** A run's start time from its id (`YYYYMMDD-HHMMSS-…`, UTC), or null. */
function runIdTime(runId: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(runId);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byProject(projects: T3Project[], threads: T3Thread[], archived: Set<string>, unsettled: Set<string>, settled: Set<string>): OrganizePlan["byProject"] {
  const rows = new Map<string, { before: number; after: number }>();
  for (const t of threads) {
    const r = rows.get(t.projectId) ?? { before: 0, after: 0 };
    const before = isVisibleInProject(t);
    const after = archived.has(t.id) || settled.has(t.id) ? false : unsettled.has(t.id) ? true : before;
    if (before) r.before++;
    if (after) r.after++;
    rows.set(t.projectId, r);
  }
  const out: OrganizePlan["byProject"] = [];
  for (const p of projects) {
    const r = rows.get(p.id);
    if (p.deleted || !r) continue;
    out.push({ projectId: p.id, title: p.title, visibleBefore: r.before, visibleAfter: r.after });
  }
  return out.sort((a, b) => (b.visibleAfter - a.visibleAfter) || cmp(a.title, b.title) || cmp(a.projectId, b.projectId));
}
