import { test } from "node:test";
import assert from "node:assert/strict";
import { SHOWN_NO_OVERRIDE, activityAt, historyActions, settleShown } from "../../src/organize/history.ts";
import type { OrganizeAction } from "../../src/organize/types.ts";
import type { HistoryRule } from "../../src/core/types.ts";
import type { T3Thread } from "../../src/t3/api.ts";
import { DAY, NOW } from "../plan/helpers.ts";

// Synthetic fixtures only: invented ids and titles.

const iso = (ms: number): string => new Date(ms).toISOString();
const RULE: HistoryRule = { days: 90, minPerProject: 10 };

/** A thread last active `age` days ago; settled as an import leaves it unless `shown`. */
function th(id: string, age: number, o: Partial<T3Thread> & { shown?: boolean } = {}): T3Thread {
  const { shown, ...rest } = o;
  return {
    id, projectId: "p1", instanceId: "claudeAgent", archived: false, title: "A tidy title",
    latestUserMessageAt: iso(NOW - age * DAY),
    ...(shown ? { settledOverride: "active" as const, settledAt: null } : { settledOverride: "settled" as const, settledAt: iso(NOW - DAY) }),
    unsettledAt: null, pinnedAt: null,
    ...rest,
  };
}

/** The real rule's movable, minus the journal: an import thread, not archived, not pinned. */
const movable = (t: T3Thread): boolean => t.id.startsWith("import:") && !t.archived && t.pinnedAt == null;
/** T3 Code's own auto-settle in these tests: on, at 15 days (the marks are planned only while it is on). */
const plan = (threads: T3Thread[], rule: HistoryRule = RULE, backdate = false, t3AutoSettleDays: number | null = 15): OrganizeAction[] =>
  historyActions(threads, rule, NOW, { movable, backdate, t3AutoSettleDays });
const ids = (as: OrganizeAction[], kind: "settle" | "unsettle"): string[] => as.filter((a) => a.kind === kind).map((a) => a.target);
const range = (n: number, from = 0): number[] => Array.from({ length: n }, (_, i) => from + i);

test("project with 3 recent and 20 old: 3 + 7 most recent old visible, 13 settled", () => {
  const recent = range(3, 1).map((d) => `import:r${d}`);
  const old = range(20, 100).map((d) => `import:o${d}`);
  // As imported: all settled. The 3 recent ones and the 7 newest old ones are shown.
  const settledWorld = [...range(3, 1).map((d) => th(`import:r${d}`, d)), ...range(20, 100).map((d) => th(`import:o${d}`, d))];
  const a = plan(settledWorld);
  assert.deepEqual(ids(a, "settle"), []);
  assert.deepEqual(ids(a, "unsettle").sort(), [...recent, ...old.slice(0, 7)].sort());
  assert.equal(settledWorld.length - ids(a, "unsettle").length, 13);
  assert.deepEqual(a.filter((x) => x.kind === "unsettle").map((x) => x.reason).filter((r) => r === "history: last 90 days").length, 3);
  assert.deepEqual(a.find((x) => x.target === "import:o100"), {
    kind: "unsettle", target: "import:o100", projectId: "p1", previous: "settled", next: "active", reason: "history: at least 10 per project",
  });

  // All shown today: the 13 oldest settle, 10 stay.
  const shownWorld = settledWorld.map((t) => ({ ...t, settledOverride: "active" as const, settledAt: null }));
  const b = plan(shownWorld);
  assert.deepEqual(ids(b, "unsettle"), []);
  assert.deepEqual(ids(b, "settle"), old.slice(7).reverse(), "the 13 oldest, oldest first");
  assert.deepEqual(b[0], {
    kind: "settle", target: "import:o119", projectId: "p1", previous: "active", next: "settled", reason: "history: older than 90 days",
  });
});

test("project with fewer than 10 threads: all visible", () => {
  const settled = range(5, 200).map((d) => th(`import:t${d}`, d));
  assert.deepEqual(ids(plan(settled), "unsettle").length, 5);
  assert.deepEqual(ids(plan(settled), "settle"), []);
  const shown = range(5, 200).map((d) => th(`import:t${d}`, d, { shown: true }));
  assert.deepEqual(plan(shown), []);
});

test("all older than 90 days: the 10 most recent stay visible", () => {
  const settled = range(15, 100).map((d) => th(`import:t${d}`, d));
  const a = plan(settled);
  assert.deepEqual(ids(a, "unsettle").sort(), range(10, 100).map((d) => `import:t${d}`).sort());
  assert.deepEqual(ids(a, "settle"), []);
  // 7 shown (the odd days), 8 settled: the 3 most recent settled ones are shown, nothing is settled.
  const mixed = range(15, 100).map((d) => th(`import:t${d}`, d, { shown: d % 2 === 1 }));
  const b = plan(mixed);
  assert.deepEqual(ids(b, "unsettle"), ["import:t104", "import:t102", "import:t100"]);
  assert.deepEqual(ids(b, "settle"), []);
});

test("native and pinned threads count toward the minimum but never move", () => {
  const threads = [
    ...range(4, 1).map((d) => th(`native-${d}`, d, { shown: true, settledOverride: null })), // recent, shown
    th("native-old", 300, { settledOverride: null }), // settled by T3's own auto-settle: never shown by t3sm
    th("import:pin-recent", 2, { pinnedAt: iso(NOW - DAY) }), // settled and recent, but pinned
    ...[150, 151].map((d) => th(`import:pin${d}`, d, { shown: true, pinnedAt: iso(NOW - DAY) })),
    ...range(10, 100).map((d) => th(`import:t${d}`, d, { shown: true })),
  ];
  const a = plan(threads);
  // Shown: 4 native + 2 pinned + 10 imports = 16. Keep set: the 10 most recent (4 native + t100..t105).
  assert.deepEqual(ids(a, "unsettle"), []);
  assert.deepEqual(ids(a, "settle"), ["import:t109", "import:t108", "import:t107", "import:t106"]);
  for (const x of a) assert.ok(x.target.startsWith("import:t"), `${x.target} moved`);
});

test("minPerProject 0 and days \"all\"", () => {
  const threads = [th("import:a", 1), th("import:b", 500), th("import:c", 900, { shown: true })];
  const all = plan(threads, { days: "all", minPerProject: 0 });
  assert.deepEqual(ids(all, "unsettle"), ["import:b", "import:a"]);
  assert.deepEqual(ids(all, "settle"), [], "\"all\": nothing is ever settled");
  assert.ok(all.every((x) => x.reason === "history: all"));
  const none = plan(threads, { days: 90, minPerProject: 0 });
  assert.deepEqual(ids(none, "unsettle"), ["import:a"]);
  assert.deepEqual(ids(none, "settle"), ["import:c"], "minimum 0: an old conversation settles even when none is left");
  assert.deepEqual(plan(threads, { days: 90, minPerProject: 1000 }).length, 2, "a large minimum shows everything that can be shown");
});

test("odd dates: none, future, createdAt only", () => {
  const t = (o: Partial<T3Thread>): T3Thread => ({ id: "import:x", projectId: "p1", instanceId: "i", archived: false, title: "x", ...o });
  assert.equal(activityAt(t({}), NOW), 0, "no date at all: older than anything");
  assert.equal(activityAt(t({ latestUserMessageAt: "not a date", createdAt: null }), NOW), 0);
  assert.equal(activityAt(t({ latestUserMessageAt: iso(NOW + 5 * DAY) }), NOW), NOW, "the future counts as now");
  assert.equal(activityAt(t({ createdAt: iso(NOW - 7 * DAY) }), NOW), NOW - 7 * DAY, "createdAt when nothing else is known");
  assert.equal(activityAt(t({ createdAt: iso(NOW - DAY), latestUserMessageAt: iso(NOW - 9 * DAY) }), NOW), NOW - 9 * DAY,
    "createdAt only when no activity date is known");
  assert.equal(activityAt(t({
    latestUserMessageAt: iso(NOW - 9 * DAY), latestRunRequestedAt: iso(NOW - 8 * DAY), latestRunStartedAt: iso(NOW - 7 * DAY),
    latestRunCompletedAt: iso(NOW - 6 * DAY), createdAt: iso(NOW - 30 * DAY),
  }), NOW), NOW - 6 * DAY, "the latest of the four");
  assert.equal(activityAt(t({ latestUserMessageAt: null, latestRunCompletedAt: iso(NOW - 3 * DAY) }), NOW), NOW - 3 * DAY);

  // In the rule: a future date is recent; createdAt-only is used; an undated thread is the oldest.
  const threads = [
    ...range(10, 100).map((d) => th(`import:t${d}`, d, { shown: true })),
    th("import:future", 0, { latestUserMessageAt: iso(NOW + 30 * DAY) }),
    th("import:created", 0, { latestUserMessageAt: null, createdAt: iso(NOW - 5 * DAY) }),
    th("import:undated", 0, { latestUserMessageAt: null, shown: true }),
  ];
  const a = plan(threads, RULE, true);
  assert.deepEqual(ids(a, "unsettle"), ["import:created", "import:future"]);
  // Shown after: 10 + 2 = 12 + the undated one; keep 10 = future, created, t100..t107: t108, t109 and undated settle.
  assert.deepEqual(ids(a, "settle"), ["import:undated", "import:t109", "import:t108"]);
  assert.equal(a.find((x) => x.target === "import:undated")!.next, "settled", "nothing to backdate to: settled now");
  assert.deepEqual(a.find((x) => x.target === "import:t109")!.next, { settledAt: iso(NOW - 109 * DAY) });
});

test("unsettle and settle ordered oldest first", () => {
  const threads = [
    th("import:a5", 5, { projectId: "pa" }), th("import:b3", 3, { projectId: "pb" }), th("import:a1", 1, { projectId: "pa" }),
    th("import:b9", 9, { projectId: "pb" }), th("import:tie-b", 4, { projectId: "pa" }), th("import:tie-a", 4, { projectId: "pb" }),
    th("import:a200", 200, { projectId: "pa", shown: true }), th("import:b300", 300, { projectId: "pb", shown: true }),
    th("import:a100", 100, { projectId: "pa", shown: true }),
  ];
  const a = plan(threads, { days: 90, minPerProject: 0 });
  assert.deepEqual(a.map((x) => `${x.kind}:${x.target}`), [
    "unsettle:import:b9", "unsettle:import:a5", "unsettle:import:tie-a", "unsettle:import:tie-b", "unsettle:import:b3", "unsettle:import:a1",
    "settle:import:b300", "settle:import:a200", "settle:import:a100",
  ]);
});

test("backdate sends the activity date", () => {
  const threads = [...range(10, 1).map((d) => th(`import:r${d}`, d, { shown: true })), th("import:old", 120, { shown: true })];
  assert.deepEqual(plan(threads, RULE, true).map((x) => x.next), [{ settledAt: iso(NOW - 120 * DAY) }]);
  assert.deepEqual(plan(threads, RULE, false).map((x) => x.next), ["settled"]);
});

test("settleShown: the override T3 shows for a settle-family journal value", () => {
  assert.equal(settleShown("settle", { settledAt: iso(NOW) }), "settled");
  assert.equal(settleShown("settle", "settled"), "settled");
  assert.equal(settleShown("settle", null), "active", "undoing a settle of a thread without an override leaves it shown");
  assert.equal(settleShown("unsettle", null), "settled", "undoing an unsettle of a thread without an override puts it on the shelf");
  assert.equal(settleShown("unsettle", "active"), "active");
  assert.equal(settleShown("title", null), null, "other kinds unchanged");
});

test("5 000 threads plan: counts and ordering", () => {
  // 50 projects x 100 threads: ages 1..100 days, the even ones shown, the odd ones settled. Native every 10th.
  const threads: T3Thread[] = [];
  for (const p of range(50)) {
    for (const d of range(100, 1)) {
      const id = d % 10 === 0 ? `native-${p}-${d}` : `import:${p}-${d}`;
      threads.push(th(id, d - p / 100, { projectId: `p${p}`, shown: d % 2 === 0 }));
    }
  }
  const a = plan(threads);
  // Per project: days 1..90 are recent, their 45 settled (odd) ones are shown; the natives sit on even days, shown
  // already. Days 91..100: 92, 94, 96, 98 are shown imports and settle; the odd ones stay settled.
  const un = a.filter((x) => x.kind === "unsettle"), se = a.filter((x) => x.kind === "settle");
  assert.equal(un.length, 50 * 45);
  assert.equal(se.length, 50 * 4);
  assert.ok(a.every((x) => !x.target.startsWith("native-")));
  const firstSettle = a.findIndex((x) => x.kind === "settle");
  assert.equal(firstSettle, un.length, "every unsettle before any settle");
  const at = new Map(threads.map((t) => [t.id, activityAt(t, NOW)]));
  for (const group of [un, se]) {
    for (let i = 1; i < group.length; i++) assert.ok(at.get(group[i - 1]!.target)! <= at.get(group[i]!.target)!, `oldest first at ${i}`);
  }
});

test("kept visible by the minimum: older threads shown without an override are marked, so T3 Code's own auto-settle never puts them away", () => {
  // 3 recent + 20 old, all shown with no override (settledAt null, settledOverride null): T3 Code's auto-settle may
  // settle any of them that is older than its days. The rule keeps the 3 recent and the 7 newest old ones.
  const bare = { settledOverride: null, settledAt: null };
  const world = [...range(3, 1).map((d) => th(`import:r${d}`, d, bare)), ...range(20, 100).map((d) => th(`import:o${d}`, d, bare))];
  const a = plan(world);
  const marks = a.filter((x) => x.kind === "unsettle");
  assert.deepEqual(marks.map((x) => x.target), range(7, 100).map((d) => `import:o${d}`).reverse(), "the 7 kept old ones, oldest first; nothing for the recent ones");
  for (const m of marks) assert.deepEqual([m.previous, m.next, m.reason], [SHOWN_NO_OVERRIDE, "active", "history: kept visible, at least 10 per project"]);
  assert.deepEqual(ids(a, "settle"), range(13, 107).map((d) => `import:o${d}`).reverse(), "the 13 others settle, as before");
  assert.ok(a.findIndex((x) => x.kind === "settle") > a.findLastIndex((x) => x.kind === "unsettle"), "every mark before any settle");
  // Already marked by an earlier unsettle (override "active"): nothing to do.
  const marked = world.map((t) => (range(7, 100).some((d) => t.id === `import:o${d}`) ? { ...t, settledOverride: "active" as const } : t));
  assert.deepEqual(ids(plan(marked), "unsettle"), []);
  // A thread the user changed by hand (not movable) still counts toward the minimum, but is never marked.
  const notO100 = (t: T3Thread): boolean => movable(t) && t.id !== "import:o100";
  const u = historyActions(world, RULE, NOW, { movable: notO100, backdate: false, t3AutoSettleDays: 15 }).filter((x) => x.kind === "unsettle").map((x) => x.target);
  assert.deepEqual(u, range(6, 101).map((d) => `import:o${d}`).reverse());
  // No date t3sm can read: no evidence T3 Code's option would reach it, so it is not marked (it still counts).
  const undated = world.map((t) => (t.id === "import:o100" ? { ...t, latestUserMessageAt: null } : t));
  assert.ok(!ids(plan(undated), "unsettle").includes("import:o100"));
  // "all": every conversation is recent, nothing is marked; minimum 0: nothing is kept for the minimum.
  assert.deepEqual(plan(world, { days: "all", minPerProject: 10 }), []);
  assert.deepEqual(ids(plan(world, { days: 90, minPerProject: 0 }), "unsettle"), []);
});

test("settleShown: a mark of an already shown thread shows no override before it", () => {
  assert.equal(settleShown("unsettle", SHOWN_NO_OVERRIDE), null);
});

test("marks only while T3 Code's own auto-settle is on, and only for kept threads it could reach within a week", () => {
  const bare = { settledOverride: null, settledAt: null };
  const world = [...range(3, 1).map((d) => th(`import:r${d}`, d, bare)), ...range(20, 100).map((d) => th(`import:o${d}`, d, bare))];
  const unsettles = (t3: number | null | undefined): string[] => ids(historyActions(world, RULE, NOW, { movable, backdate: false, t3AutoSettleDays: t3 }), "unsettle");
  assert.deepEqual(unsettles(null), [], "T3 Code's option off: nothing can put them away");
  assert.deepEqual(unsettles(undefined), [], "unknown: no evidence, no marks");
  assert.equal(unsettles(15).length, 7, "T3 Code at 15 days");
  // Rule 30 days, T3 Code at 90: a kept thread 40 days old is 50 days from T3 Code's reach (not marked yet); one 85
  // days old is within a week of it.
  const near = [th("import:a40", 40, bare), th("import:a85", 85, bare), th("import:a200", 200, bare)];
  const m = ids(historyActions(near, { days: 30, minPerProject: 10 }, NOW, { movable, backdate: false, t3AutoSettleDays: 90 }), "unsettle");
  assert.deepEqual(m, ["import:a200", "import:a85"]);
});

test("with the defaults (rule and T3 Code both at 90 days) a kept conversation is marked a week before T3 Code reaches it, while still recent", () => {
  const bare = { settledOverride: null, settledAt: null };
  // 12 shown with no override, 80..91 days old: 80..90 are recent (90 days exactly included), 91 settles. The rule
  // keeps the 10 most recent for its minimum (80..89). T3 Code at 90 days could settle the ones of 83 days and more
  // within a week: marked; 80..82 not yet, and 90 (recent, not kept for the minimum) never.
  const world = range(12, 80).map((d) => th(`import:t${d}`, d, bare));
  const a = historyActions(world, { days: 90, minPerProject: 10 }, NOW, { movable, backdate: false, t3AutoSettleDays: 90 });
  assert.deepEqual(ids(a, "unsettle"), range(7, 83).map((d) => `import:t${d}`).reverse());
  assert.deepEqual(ids(a, "settle"), ["import:t91"]);
  // A recent conversation the rule does not keep for the minimum (beyond the 10) is never marked.
  const many = range(15, 80).map((d) => th(`import:m${d}`, d, bare));
  const b = historyActions(many, { days: 120, minPerProject: 10 }, NOW, { movable, backdate: false, t3AutoSettleDays: 90 });
  assert.deepEqual(ids(b, "unsettle"), range(7, 83).map((d) => `import:m${d}`).reverse(), "only the kept 10 (80..89), from 83 days on");
});
