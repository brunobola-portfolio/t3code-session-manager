// The per-project history rule (spec §5.2), owner's words: recent conversations stay visible; otherwise each project
// keeps at least `minPerProject` visible; older ones settle. Settled conversations stay in their project (T3's
// "Settled" shelf). Pure: no I/O, no clock (`now` is passed in).
//
// Per project:
//   1. visible = not archived and not settled (isVisibleInProject); settled = on the Settled shelf.
//   2. recent = activityAt >= now - days (every thread when days is "all").
//   3. Unsettle every movable recent settled thread.
//   4. While the projected visible count is below the minimum, unsettle the most recent movable settled threads.
//   5. Settle every movable visible thread that is not recent, except the keep set: the `minPerProject` most recent
//      threads of the projected visible ones, native and pinned threads included (they count, but never move).
//   6. While T3 Code's own auto-settle is on (HistoryOptions.t3AutoSettleDays), mark the ones the rule keeps for
//      the minimum per project (recent or not): movable, shown without an override, with a date t3sm can read, and
//      within MARK_AHEAD_DAYS of that option's days. A mark is an unsettle (previous SHOWN_NO_OVERRIDE): it gives the thread
//      the "active" override, which T3 Code's own auto-settle never touches (S6: `settledOverride !== null` is never
//      auto-settled). T3 Code 0.1.10's `thread.unsettle` on a thread not archived returns it with `settledOverride:
//      "active"`, `settledAt: null`, and `unsettledAt` set to now unless it was "active" already: that only moves it in
//      the sidebar's sort. Without the mark, T3 Code's option would put it away once it is older than its days, and
//      the project would drop below its minimum (spec §5.2: the kept imported threads are protected from it by
//      settledOverride "active"; owner-approved). A thread without a date is not marked: no evidence.
// Actions come oldest activity first, unsettle and settle alike; every unsettle before any settle, so a project never
// dips below its minimum while the plan is applied.
//
// Journal values (src/organize/types.ts): unsettle "settled"|null -> "active"; settle "active"|null -> "settled", or
// `{ settledAt }` when the settle is backdated. `settleShown` maps them to the settledOverride T3 shows.
import type { HistoryRule, OrganizeKind } from "../core/types.ts";
import type { T3Thread } from "../t3/decode.ts";
import type { OrganizeAction } from "./types.ts";

export const DAY_MS = 86_400_000;

/**
 * The one definition of "shown inside the project" (T3's rule, docs/spikes/S6-organize.md, ruling R20): not archived and
 * `settledAt == null`. An unsettled thread (override "active") has settledAt null; an auto-settled native thread has
 * override null and settledAt set, so it is settled.
 */
export function isVisibleInProject(t: T3Thread): boolean {
  return !t.archived && t.settledAt == null;
}

/** Not archived and settled (`settledAt` set): the "Settled" shelf. */
export function isOnSettledShelf(t: T3Thread): boolean {
  return !t.archived && t.settledAt != null;
}

/** An ISO date as epoch ms; null when absent or unparseable. */
export function ms(iso: string | null | undefined): number | null {
  if (typeof iso !== "string") return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
}

/**
 * When the thread was last active (epoch ms): the latest of its user message and its newest run's requested / started /
 * completed times; when none is known, its createdAt; when that is unknown too, 0 (older than anything). A date in the
 * future counts as `now`.
 */
export function activityAt(t: T3Thread, now: number): number {
  let at: number | null = null;
  for (const v of [t.latestUserMessageAt, t.latestRunRequestedAt, t.latestRunStartedAt, t.latestRunCompletedAt]) {
    const x = ms(v);
    if (x !== null && (at === null || x > at)) at = x;
  }
  at ??= ms(t.createdAt);
  if (at === null) return 0;
  return at > now ? now : at;
}

export const isObj = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u);

/**
 * The kind a journaled change really is. Task 6's follow (before `settle` existed) journaled a carried settled state as
 * kind `unsettle` with `next: "settled"`: that is a settle, and its null `previous` means "shown" (see settleShown).
 */
export function changeKind(kind: OrganizeKind, next: unknown): OrganizeKind {
  return kind === "unsettle" && settleShown("settle", next) === "settled" ? "settle" : kind;
}

/**
 * The settledOverride T3 shows once t3sm wrote `value` for a change of `kind` (settle or unsettle), as compared with the
 * current state: a backdated `{ settledAt }` is "settled"; null (a `previous` from a thread without an override, which T3
 * cannot restore) is the side the change left: "active" for settle, "settled" for unsettle. Other kinds: unchanged.
 */
export function settleShown(kind: OrganizeKind, value: unknown): unknown {
  if (kind !== "settle" && kind !== "unsettle") return value;
  if (kind === "unsettle" && value === SHOWN_NO_OVERRIDE) return null;
  if (isObj(value) && typeof value.settledAt === "string") return "settled";
  if (value === null) return kind === "settle" ? "active" : "settled";
  return value;
}

/**
 * `previous` of an unsettle that only marks a thread already shown without an override (step 6): the thread shows the
 * same before and after; undoing it leaves it shown (T3 Code cannot remove an override). The override T3 shows before it
 * is none (settleShown).
 */
export const SHOWN_NO_OVERRIDE = "shown";

/** An unsettle that marks a thread already shown (step 6), not one that brings a thread back from the Settled shelf. */
export function isShownMark(a: { kind: OrganizeKind; previous: unknown }): boolean {
  return a.kind === "unsettle" && a.previous === SHOWN_NO_OVERRIDE;
}

export interface HistoryOptions {
  /** May the rule move this thread (an `import:` thread, not archived, not pinned, not changed by hand in the settle family)? */
  movable(t: T3Thread): boolean;
  /** Settle with the activity date (`next: { settledAt }`) instead of "now" (`next: "settled"`). */
  backdate: boolean;
  /**
   * T3 Code's own auto-settle days as they will be after this run (null: off; undefined: unknown). The marks (step 6)
   * are planned only while it is on, and only for a kept thread it could reach within a week (age >= its days - 7).
   */
  t3AutoSettleDays?: number | null;
}

/** How long before T3 Code's own auto-settle could reach a kept thread the mark is planned (the daily pass's margin). */
export const MARK_AHEAD_DAYS = 7;

interface Row { t: T3Thread; at: number }

const newestFirst = (a: Row, b: Row): number => b.at - a.at || (a.t.id < b.t.id ? -1 : a.t.id > b.t.id ? 1 : 0);
const oldestFirst = (a: Row, b: Row): number => a.at - b.at || (a.t.id < b.t.id ? -1 : a.t.id > b.t.id ? 1 : 0);

/** The unsettle and settle actions of the history rule over `threads` (all of T3's threads; archived ones are ignored). */
export function historyActions(threads: T3Thread[], rule: HistoryRule, now: number, o: HistoryOptions): OrganizeAction[] {
  const all = rule.days === "all";
  const days = rule.days === "all" ? 0 : rule.days;
  if (!all && (!Number.isFinite(days) || days <= 0)) return [];
  const since = all ? null : now - days * DAY_MS;
  const min = Math.max(0, Math.floor(rule.minPerProject));
  const recentWhy = all ? "history: all" : `history: last ${days} days`;
  const minWhy = `history: at least ${min} per project`;
  const settleWhy = `history: older than ${days} days`;
  const keepWhy = `history: kept visible, at least ${min} per project`;

  const byProject = new Map<string, Row[]>();
  for (const t of threads) {
    if (t.archived) continue;
    const rows = byProject.get(t.projectId) ?? [];
    rows.push({ t, at: activityAt(t, now) });
    byProject.set(t.projectId, rows);
  }

  const unsettle: { row: Row; reason: string; mark?: true }[] = [];
  const settle: Row[] = [];
  for (const rows of byProject.values()) {
    const recent = (r: Row): boolean => since === null || r.at >= since;
    const shown = new Set<Row>(rows.filter((r) => isVisibleInProject(r.t)));
    // 3. every recent conversation is shown.
    const shelf = rows.filter((r) => isOnSettledShelf(r.t) && o.movable(r.t)).sort(newestFirst);
    const rest: Row[] = [];
    for (const r of shelf) {
      if (recent(r)) { unsettle.push({ row: r, reason: recentWhy }); shown.add(r); } else rest.push(r);
    }
    // 4. the minimum, from the most recent settled ones.
    for (const r of rest) {
      if (shown.size >= min) break;
      unsettle.push({ row: r, reason: minWhy });
      shown.add(r);
    }
    // 5. older ones settle, except the `min` most recent of what is shown.
    if (since === null) continue;
    const keep = new Set([...shown].sort(newestFirst).slice(0, min));
    for (const r of shown) {
      if (keep.has(r) || recent(r) || !isVisibleInProject(r.t) || !o.movable(r.t)) continue;
      settle.push(r);
    }
    // 6. mark the kept ones shown without an override, so T3 Code's own auto-settle leaves them shown; only
    // while that option is on, and only once it could reach the thread within MARK_AHEAD_DAYS.
    const t3 = o.t3AutoSettleDays;
    for (const r of t3 == null ? [] : keep) {
      if (now - r.at < (t3! - MARK_AHEAD_DAYS) * DAY_MS) continue;
      // Only on evidence: a thread with no date t3sm can read (activity 0) may not be old to T3 Code either.
      // A kept one is marked even while recent: with T3 Code's option at the rule's days (the defaults), it reaches a
      // kept conversation a week after the mark, while the rule still counts it as recent.
      if (r.at === 0 || !isVisibleInProject(r.t) || !o.movable(r.t) || r.t.settledOverride != null) continue;
      unsettle.push({ row: r, reason: keepWhy, mark: true });
    }
  }

  unsettle.sort((a, b) => oldestFirst(a.row, b.row));
  settle.sort(oldestFirst);
  return [
    ...unsettle.map(({ row: { t }, reason, mark }): OrganizeAction => ({
      kind: "unsettle", target: t.id, projectId: t.projectId, previous: mark ? SHOWN_NO_OVERRIDE : t.settledOverride ?? null, next: "active", reason,
    })),
    ...settle.map(({ t, at }): OrganizeAction => ({
      kind: "settle", target: t.id, projectId: t.projectId, previous: t.settledOverride ?? null,
      next: o.backdate && at > 0 ? { settledAt: new Date(at).toISOString() } : "settled", reason: settleWhy,
    })),
  ];
}
