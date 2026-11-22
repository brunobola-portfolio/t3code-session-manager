import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOrganizePlan, isOnSettledShelf, isVisibleInProject } from "../../src/organize/plan.ts";
import type { OrganizeAction, OrganizeInput, OrganizeKind } from "../../src/organize/types.ts";
import type { FolderCategory, JournalEntry, OrganizeConfig } from "../../src/core/types.ts";
import type { T3Project, T3Thread } from "../../src/t3/api.ts";
import { organizeSettings } from "../../src/core/config.ts";
import { DAY, NOW, cfg } from "../plan/helpers.ts";

// Synthetic fixtures only: invented ids, titles and `C:/work/...` folders.

const iso = (ms: number): string => new Date(ms).toISOString();

function thread(id: string, o: Partial<T3Thread> = {}): T3Thread {
  return {
    id, projectId: "p1", instanceId: "claudeAgent", archived: false, title: "A tidy title",
    latestUserMessageAt: iso(NOW - 2 * DAY), settledOverride: "settled", settledAt: iso(NOW - DAY), unsettledAt: null,
    ...o,
  };
}

function project(id: string, o: Partial<T3Project> = {}): T3Project {
  return {
    id, title: id.toUpperCase(), workspaceRoot: `C:/work/${id}`, defaultModelSelection: null,
    archived: false, deleted: false, pinned: false, createdAt: null, ...o,
  };
}

type Sess = { origin: "human" | "automated"; title: string | null };

interface Over {
  threads?: T3Thread[]; projects?: T3Project[]; journal?: JournalEntry[];
  config?: Partial<OrganizeConfig>; sessions?: Record<string, Partial<Sess>>;
  scope?: Partial<OrganizeInput["scope"]>; projectCategory?: Record<string, FolderCategory>;
  isTechnicalTitle?: (t: string) => boolean; autoSettle?: OrganizeInput["autoSettle"]; backdate?: boolean; t3AutoSettleDays?: number | null;
}

function input(o: Over = {}): OrganizeInput {
  const base = organizeSettings(cfg(), "en");
  const sessions = new Map<string, Sess>();
  for (const [k, v] of Object.entries(o.sessions ?? {})) sessions.set(k, { origin: "human", title: null, ...v });
  const i: OrganizeInput = {
    runId: "run-org-1",
    threads: o.threads ?? [],
    projects: o.projects ?? [project("p1")],
    journal: o.journal ?? [],
    config: { ...base, ...o.config },
    sessions,
    now: NOW,
    scope: { allowPins: true, allowDeletes: true, ...o.scope },
  };
  if (o.projectCategory) i.projectCategory = new Map(Object.entries(o.projectCategory));
  if (o.isTechnicalTitle) i.isTechnicalTitle = o.isTechnicalTitle;
  if (o.autoSettle) i.autoSettle = o.autoSettle;
  if (o.t3AutoSettleDays !== undefined) i.t3AutoSettleDays = o.t3AutoSettleDays;
  if (o.backdate !== undefined) i.backdate = o.backdate;
  return i;
}

/** Defaults that switch off the parts a test does not look at. */
const quiet: Partial<OrganizeConfig> = { pinRecent: { enabled: false, count: 5 }, history: "off" };
const showAll: Partial<OrganizeConfig> = { ...quiet, history: "all" };

const of = (actions: OrganizeAction[], kind: OrganizeKind): OrganizeAction[] => actions.filter((a) => a.kind === kind);
const targets = (actions: OrganizeAction[], kind: OrganizeKind): string[] => of(actions, kind).map((a) => a.target);

function change(kind: OrganizeKind, target: string, previous: unknown, next: unknown, runId = "run-org-0"): JournalEntry {
  return { t: "organize-change", runId, kind, target, previous, next };
}

// ---- scope ----

test("native thread (id not import:) never in the plan", () => {
  const p = buildOrganizePlan(input({
    config: { pinRecent: { enabled: true, count: 5 } },
    threads: [
      thread("native-1", { title: "<command-name>x</command-name>" }),
      thread("native-2"),
    ],
    sessions: { "native-1": { origin: "automated", title: "Clean" }, "native-2": { origin: "human", title: "Other" } },
  }));
  for (const a of p.actions) assert.ok(!a.target.startsWith("native"), `native in ${a.kind}`);
  assert.deepEqual(p.actions.filter((a) => a.kind !== "pin"), []);
});

test("scope.onlyThreads limits thread actions", () => {
  const p = buildOrganizePlan(input({
    config: showAll,
    threads: [
      thread("import:a", { title: "<ide_opened_file>" }), thread("import:b", { title: "<ide_opened_file>" }),
      thread("import:c"), thread("import:d"),
    ],
    sessions: {
      "import:a": { title: "Fix the login" }, "import:b": { title: "Fix the logout" },
      "import:c": { origin: "automated" }, "import:d": {},
    },
    scope: { onlyThreads: new Set(["import:a", "import:d"]) },
  }));
  assert.deepEqual(targets(p.actions, "title"), ["import:a"]);
  assert.deepEqual(targets(p.actions, "archive"), []);
  assert.deepEqual(targets(p.actions, "unsettle"), ["import:a", "import:d"]);
});

test("scope.historyThreads: the history rule moves only those (import: ones); archive and title stay on onlyThreads", () => {
  const p = buildOrganizePlan(input({
    config: showAll,
    threads: [
      thread("import:a", { title: "<ide_opened_file>" }), thread("import:b", { title: "<ide_opened_file>" }),
      thread("import:c"), thread("native-1"),
    ],
    sessions: { "import:a": { title: "Fix the login" }, "import:b": { title: "Fix the logout" } },
    scope: { onlyThreads: new Set(), historyThreads: new Set(["import:b", "import:c", "native-1"]), allowPins: false, allowDeletes: false },
  }));
  assert.deepEqual(targets(p.actions, "title"), [], "an empty onlyThreads: no archive, no title");
  assert.deepEqual(targets(p.actions, "unsettle").sort(), ["import:b", "import:c"], "a native thread never moves, even when listed");
});

test("a thread whose settledOverride this t3sm does not know (a newer T3 Code) gets no change at all", () => {
  const p = buildOrganizePlan(input({
    config: { ...showAll, pinRecent: { enabled: true, count: 5 } },
    threads: [
      thread("import:future", { settledOverride: "unknown", title: "<command-name>/clear</command-name>" }),
      thread("import:future-auto", { settledOverride: "unknown" }),
      thread("import:known"),
    ],
    sessions: { "import:future": { title: "Fix the login form" }, "import:future-auto": { origin: "automated" }, "import:known": {} },
  }));
  assert.deepEqual(p.actions.filter((a) => a.target.startsWith("import:future")), []);
  assert.deepEqual(targets(p.actions, "unsettle"), ["import:known"]);
  assert.deepEqual(targets(p.actions, "pin"), ["p1"], "pins are unaffected");
});

// ---- 5.1 archive ----

test("archives automated import threads that are not archived", () => {
  const p = buildOrganizePlan(input({
    config: quiet,
    threads: [thread("import:auto"), thread("import:auto-old", { archived: true }), thread("import:human")],
    sessions: { "import:auto": { origin: "automated" }, "import:auto-old": { origin: "automated" }, "import:human": {} },
  }));
  const a = of(p.actions, "archive");
  assert.deepEqual(a.map((x) => x.target), ["import:auto"]);
  assert.deepEqual(a[0], {
    kind: "archive", target: "import:auto", projectId: "p1", previous: false, next: true,
    reason: "automated session (Agent SDK)",
  });
});

test("archiveAutomated false archives nothing", () => {
  const p = buildOrganizePlan(input({
    config: { ...showAll, archiveAutomated: false },
    threads: [thread("import:auto")], sessions: { "import:auto": { origin: "automated" } },
  }));
  assert.deepEqual(of(p.actions, "archive"), []);
});

test("user unarchived thread is never archived again", () => {
  const p = buildOrganizePlan(input({
    config: quiet,
    threads: [thread("import:auto", { archived: false })],
    sessions: { "import:auto": { origin: "automated" } },
    journal: [change("archive", "import:auto", false, true)],
  }));
  assert.deepEqual(p.actions, []);
});

// ---- 5.2 titles ----

test("retitles a technical title with the proposal", () => {
  const p = buildOrganizePlan(input({
    config: quiet,
    threads: [thread("import:t", { title: "<command-message>init</command-message>" }), thread("import:x", { title: "[external file block: a.txt]" })],
    sessions: { "import:t": { title: "Set up the repo" }, "import:x": { title: "Read the notes" } },
  }));
  assert.deepEqual(of(p.actions, "title"), [
    { kind: "title", target: "import:t", projectId: "p1", previous: "<command-message>init</command-message>", next: "Set up the repo", reason: "technical title" },
    { kind: "title", target: "import:x", projectId: "p1", previous: "[external file block: a.txt]", next: "Read the notes", reason: "technical title" },
  ]);
});

test("retitles a title t3sm set earlier when the proposal changed", () => {
  const p = buildOrganizePlan(input({
    config: quiet,
    threads: [thread("import:t", { title: "Old clean title" })],
    sessions: { "import:t": { title: "Newer clean title" } },
    journal: [change("title", "import:t", "<x>", "Old clean title")],
  }));
  assert.deepEqual(of(p.actions, "title").map((a) => [a.previous, a.next, a.reason]), [["Old clean title", "Newer clean title", "title set by t3sm earlier"]]);
});

test("no title action for a plain title, a null proposal, an equal proposal, or titles off", () => {
  const threads = [
    thread("import:plain", { title: "Something the user typed" }),
    thread("import:null", { title: "<x>" }),
    thread("import:same", { title: "<same>" }),
  ];
  const sessions = { "import:plain": { title: "Proposal" }, "import:null": { title: null }, "import:same": { title: "<same>" } };
  assert.deepEqual(of(buildOrganizePlan(input({ config: quiet, threads, sessions })).actions, "title"), []);
  const off = buildOrganizePlan(input({ config: { ...quiet, titles: false }, threads: [thread("import:t", { title: "<x>" })], sessions: { "import:t": { title: "Y" } } }));
  assert.deepEqual(of(off.actions, "title"), []);
});

test("title is not proposed for archived or to-be-archived threads", () => {
  const p = buildOrganizePlan(input({
    config: quiet,
    threads: [
      thread("import:arch", { title: "<x>", archived: true }),
      thread("import:auto", { title: "<x>" }),
      thread("import:ok", { title: "<x>" }),
    ],
    sessions: {
      "import:arch": { title: "Clean A" },
      "import:auto": { origin: "automated", title: "Clean B" },
      "import:ok": { title: "Clean C" },
    },
  }));
  assert.deepEqual(targets(p.actions, "archive"), ["import:auto"]);
  assert.deepEqual(targets(p.actions, "title"), ["import:ok"]);
});

test("the default technical-title test is the real one", () => {
  const p = buildOrganizePlan(input({
    config: quiet,
    threads: [thread("import:c", { title: "Caveat: The messages below" }), thread("import:t", { title: "Typed by the user" })],
    sessions: { "import:c": { title: "Clean" }, "import:t": { title: "Other" } },
  }));
  assert.deepEqual(targets(p.actions, "title"), ["import:c"]);
});

test("isTechnicalTitle predicate is injected", () => {
  const p = buildOrganizePlan(input({
    config: quiet, isTechnicalTitle: (t) => t.startsWith("Caveat:"),
    threads: [thread("import:a", { title: "Caveat: the messages below" }), thread("import:b", { title: "<x>" })],
    sessions: { "import:a": { title: "Real topic" }, "import:b": { title: "Other" } },
  }));
  assert.deepEqual(targets(p.actions, "title"), ["import:a"]);
});

test("user-renamed title is never touched again", () => {
  const p = buildOrganizePlan(input({
    config: quiet,
    // t3sm set "Clean title"; the user renamed it, even to something that looks technical.
    threads: [thread("import:t", { title: "<my own label>" })],
    sessions: { "import:t": { title: "Clean title v2" } },
    journal: [change("title", "import:t", "<x>", "Clean title")],
  }));
  assert.deepEqual(p.actions, []);
});

// ---- titles written by T3 Code (--ai-titles) ----

test("ai-title: never planned unless asked (aiTitles), whatever the titles setting", () => {
  const threads = [thread("import:t", { title: "<command-name>/clear</command-name>" })];
  const p = buildOrganizePlan(input({ config: quiet, threads, sessions: { "import:t": { title: null } } }));
  assert.deepEqual(of(p.actions, "ai-title"), []);
  assert.equal(p.aiTitles, undefined);
});

test("ai-title: a technical title with no transcript proposal is handed to T3 Code; previous is the title, next null until requested", () => {
  const i = input({
    config: quiet,
    threads: [
      thread("import:none", { title: "<command-name>/clear</command-name>" }),
      thread("import:clean", { title: "<command-message>init</command-message>" }),
      thread("import:plain", { title: "Typed by the user" }),
    ],
    sessions: { "import:none": { title: null }, "import:clean": { title: "Set up the repo" }, "import:plain": { title: null } },
  });
  i.aiTitles = { max: 50 };
  const p = buildOrganizePlan(i);
  // The transcript gave a clean title for import:clean: t3sm sets that one itself, no tokens spent.
  assert.deepEqual(targets(p.actions, "title"), ["import:clean"]);
  assert.deepEqual(of(p.actions, "ai-title"), [
    { kind: "ai-title", target: "import:none", projectId: "p1", previous: "<command-name>/clear</command-name>", next: null, reason: "technical title" },
  ]);
  assert.deepEqual(p.aiTitles, { eligible: 1, max: 50 });
  assert.equal(p.counts["ai-title"], 1);
});

test("ai-title: with titles off every technical title is a candidate", () => {
  const i = input({ config: { ...quiet, titles: false }, threads: [thread("import:t", { title: "<x>" })], sessions: { "import:t": { title: "Clean" } } });
  i.aiTitles = { max: 5 };
  assert.deepEqual(targets(buildOrganizePlan(i).actions, "ai-title"), ["import:t"]);
});

test("ai-title: the cap keeps the most recent conversations; eligible counts them all", () => {
  const threads = [1, 2, 3, 4].map((n) => thread(`import:t${n}`, { title: "<x>", latestUserMessageAt: iso(NOW - n * DAY) }));
  threads.push(thread("import:t0", { title: "<x>", latestUserMessageAt: null }));
  const i = input({ config: { ...quiet, titles: false }, threads });
  i.aiTitles = { max: 2 };
  const p = buildOrganizePlan(i);
  assert.deepEqual(targets(p.actions, "ai-title"), ["import:t1", "import:t2"]);
  assert.deepEqual(p.aiTitles, { eligible: 5, max: 2 });
});

test("ai-title: never for a native, archived, to-be-archived, automated, or unknown-settle thread, nor one T3 Code is already retitling", () => {
  const i = input({
    config: { ...quiet, titles: false },
    threads: [
      thread("native-1", { title: "<x>" }),
      thread("import:arch", { title: "<x>", archived: true }),
      thread("import:auto", { title: "<x>" }),
      thread("import:unknown", { title: "<x>", settledOverride: "unknown" }),
      thread("import:busy", { title: "<x>", titleRegeneration: { requestId: "r0", startedAt: iso(NOW) } }),
      thread("import:ok", { title: "<x>" }),
    ],
    sessions: { "import:auto": { origin: "automated" } },
  });
  i.aiTitles = { max: 50 };
  assert.deepEqual(targets(buildOrganizePlan(i).actions, "ai-title"), ["import:ok"]);
});

test("ai-title: never for a title the user changed by hand, nor one T3 Code was asked for before (no title action either)", () => {
  const i = input({
    config: quiet,
    threads: [
      thread("import:user", { title: "<my own label>" }),
      thread("import:asked", { title: "<x>" }),
      thread("import:asked-done", { title: "Release notes draft" }),
    ],
    sessions: { "import:user": { title: null }, "import:asked": { title: "Clean" }, "import:asked-done": { title: "Clean" } },
    journal: [
      change("title", "import:user", "<x>", "Clean title"),
      change("ai-title", "import:asked", "<x>", { requestId: "r1" }),
      change("ai-title", "import:asked-done", "<y>", { requestId: "r2" }),
      change("title", "import:asked-done", "<y>", "Release notes draft"),
    ],
  });
  i.aiTitles = { max: 50 };
  const p = buildOrganizePlan(i);
  assert.deepEqual(of(p.actions, "ai-title"), []);
  assert.deepEqual(of(p.actions, "title"), [], "a title T3 Code wrote is never replaced by the transcript's");
});

test("ai-title: never in a sync-scoped plan built without aiTitles, even with organize.aiTitles enabled in config", () => {
  const p = buildOrganizePlan(input({
    config: { ...quiet, titles: false, aiTitles: { enabled: true, maxPerRun: 50 } },
    threads: [thread("import:t", { title: "<x>" })],
    scope: { onlyThreads: new Set(["import:t"]), allowPins: false, allowDeletes: false },
  }));
  assert.deepEqual(of(p.actions, "ai-title"), []);
});

// ---- 5.3 unsettle ----

test("unsettles human settled import threads never unsettled (history all)", () => {
  const p = buildOrganizePlan(input({
    config: showAll,
    threads: [
      thread("import:ok"),
      thread("import:auto", { archived: true }),
      thread("import:arch", { archived: true }),
      thread("import:active", { settledOverride: "active", settledAt: null }),
      thread("import:none", { settledOverride: null, settledAt: null }),
      thread("import:was", { unsettledAt: iso(NOW - 3 * DAY) }),
      thread("import:nosess"),
    ],
    sessions: { "import:ok": {}, "import:auto": { origin: "automated" }, "import:arch": {}, "import:active": {}, "import:none": {}, "import:was": {} },
  }));
  assert.deepEqual(targets(p.actions, "unsettle"), ["import:nosess", "import:ok"], "oldest first, then by id");
  assert.deepEqual(of(p.actions, "unsettle")[1], {
    kind: "unsettle", target: "import:ok", projectId: "p1", previous: "settled", next: "active", reason: "history: all",
  });
});

test("automated thread is never unsettled", () => {
  const p = buildOrganizePlan(input({
    config: { ...showAll, archiveAutomated: false },
    threads: [thread("import:auto")], sessions: { "import:auto": { origin: "automated" } },
  }));
  assert.deepEqual(p.actions, []);
});

test("history off unsettles nothing", () => {
  const p = buildOrganizePlan(input({ config: { ...quiet, history: "off" }, threads: [thread("import:a")], sessions: { "import:a": {} } }));
  assert.deepEqual(p.actions, []);
});

test("history of 30 days (no minimum) only unsettles threads active in the last 30 days", () => {
  const p = buildOrganizePlan(input({
    config: { ...quiet, history: { days: 30, minPerProject: 0 } },
    threads: [
      thread("import:recent", { latestUserMessageAt: iso(NOW - 29 * DAY) }),
      thread("import:edge", { latestUserMessageAt: iso(NOW - 30 * DAY) }),
      thread("import:old", { latestUserMessageAt: iso(NOW - 31 * DAY) }),
      thread("import:unknown", { latestUserMessageAt: null }),
    ],
  }));
  assert.deepEqual(targets(p.actions, "unsettle"), ["import:edge", "import:recent"], "oldest first");
  assert.equal(of(p.actions, "unsettle")[0]?.reason, "history: last 30 days");
});

test("user re-settled thread is never unsettled again", () => {
  // As T3 really leaves it (unsettledAt kept) and with unsettledAt cleared: the journal alone must block it.
  for (const unsettledAt of [iso(NOW - DAY), null]) {
    const p = buildOrganizePlan(input({
      config: showAll,
      threads: [thread("import:x", { settledOverride: "settled", unsettledAt })],
      journal: [change("unsettle", "import:x", "settled", "active")],
    }));
    assert.deepEqual(p.actions, [], `unsettledAt=${unsettledAt}`);
  }
});

// ---- 5.2 the per-project history rule ----

/** `n` import threads in p1 named `prefix<age>`, last active `from`, `from + 1`, ... days ago; shown when `shown`. */
function aged(prefix: string, n: number, from: number, o: Partial<T3Thread> & { shown?: boolean } = {}): T3Thread[] {
  const { shown, ...rest } = o;
  return Array.from({ length: n }, (_, i) => thread(`${prefix}${from + i}`, {
    latestUserMessageAt: iso(NOW - (from + i) * DAY), ...(shown ? { settledOverride: "active" as const, settledAt: null } : {}), ...rest,
  }));
}
const shownBy = (ts: T3Thread[]): JournalEntry[] => ts.map((t) => change("unsettle", t.id, "settled", "active"));

test("history rule (90 days, at least 10): per project, recent shown, older settle down to the minimum", () => {
  const q = aged("import:q", 12, 200, { projectId: "p2", shown: true });
  const p = buildOrganizePlan(input({
    config: { ...quiet, history: { days: 90, minPerProject: 10 } },
    projects: [project("p1"), project("p2")],
    // p1: 3 recent + 20 old, all settled (as imported). p2: 12 old, shown by t3sm earlier.
    threads: [...aged("import:r", 3, 1), ...aged("import:o", 20, 100), ...q],
    journal: shownBy(q),
  }));
  assert.equal(of(p.actions, "unsettle").length, 10);
  assert.deepEqual(targets(p.actions, "settle"), ["import:q211", "import:q210"]);
  assert.equal(p.counts.settle, 2);
  assert.deepEqual(of(p.actions, "settle")[0], {
    // Backdated by default (SETTLE_BACKDATE): T3 Code records the conversation's own last activity.
    kind: "settle", target: "import:q211", projectId: "p2", previous: "active", next: { settledAt: iso(NOW - 211 * DAY) },
    reason: "history: older than 90 days",
  });
  assert.deepEqual(p.byProject.map((r) => [r.projectId, r.visibleBefore, r.visibleAfter]), [["p1", 0, 10], ["p2", 12, 10]]);
  const kinds = p.actions.map((a) => a.kind);
  assert.ok(kinds.lastIndexOf("unsettle") < kinds.indexOf("settle"), "every unsettle before any settle");
});

test("history rule in the planner: native and pinned threads count toward the minimum but never move", () => {
  const t = aged("import:t", 10, 100, { shown: true });
  const p = buildOrganizePlan(input({
    config: { ...quiet, history: { days: 90, minPerProject: 10 } },
    threads: [
      ...[1, 2, 3, 4].map((d) => thread(`native-${d}`, { latestUserMessageAt: iso(NOW - d * DAY), settledOverride: null, settledAt: null })),
      thread("native-old", { latestUserMessageAt: iso(NOW - 300 * DAY), settledOverride: null }),
      thread("import:pin-recent", { latestUserMessageAt: iso(NOW - DAY), pinnedAt: iso(NOW - DAY) }),
      ...aged("import:pin", 2, 150, { shown: true, pinnedAt: iso(NOW - DAY) }),
      ...t,
    ],
    journal: shownBy([...t, ...aged("import:pin", 2, 150)]),
  }));
  assert.deepEqual(targets(p.actions, "unsettle"), []);
  assert.deepEqual(targets(p.actions, "settle"), ["import:t109", "import:t108", "import:t107", "import:t106"]);
});

test("manual settle or unsettle is never undone", () => {
  const p = buildOrganizePlan(input({
    config: { ...quiet, history: { days: 90, minPerProject: 0 } },
    threads: [
      // t3sm showed it, the user put it away again: recent, but stays settled.
      thread("import:resettled", { latestUserMessageAt: iso(NOW - DAY) }),
      // t3sm settled it, the user showed it again: old, but stays shown.
      thread("import:reshown", { latestUserMessageAt: iso(NOW - 200 * DAY), settledOverride: "active", settledAt: null }),
      // No t3sm change on record: shown by hand (imports arrive settled), and settled again after an unsettle.
      thread("import:hand-shown", { latestUserMessageAt: iso(NOW - 200 * DAY), settledOverride: "active", settledAt: null }),
      thread("import:hand-settled", { latestUserMessageAt: iso(NOW - DAY), unsettledAt: iso(NOW - 3 * DAY) }),
      // t3sm settled it backdated and nobody touched it since: active again lately, so shown again.
      thread("import:ours", { latestUserMessageAt: iso(NOW - DAY) }),
      // t3sm showed it and nobody touched it since: old now, so it settles.
      thread("import:ours-old", { latestUserMessageAt: iso(NOW - 200 * DAY), settledOverride: "active", settledAt: null }),
    ],
    journal: [
      change("unsettle", "import:resettled", "settled", "active"),
      change("settle", "import:reshown", "active", "settled"),
      change("settle", "import:ours", "active", { settledAt: iso(NOW - 120 * DAY) }),
      change("unsettle", "import:ours-old", "settled", "active"),
    ],
  }));
  assert.deepEqual(p.actions.map((a) => `${a.kind}:${a.target}`), ["unsettle:import:ours", "settle:import:ours-old"]);
});

/** A run of t3sm (run-start, its organize changes, run-end) that ran from `start` to `start + 1 minute`. */
function run(runId: string, start: number, cs: [OrganizeKind, string, unknown, unknown][]): JournalEntry[] {
  return [
    { t: "run-start", runId, at: iso(start), command: "organize" },
    ...cs.map(([k, target, previous, next]) => change(k, target, previous, next, runId)),
    { t: "run-end", runId, at: iso(start + 60_000), status: "ok" },
  ];
}

test("manual settle or unsettle is never undone: away and back by hand (A -> B -> A) after t3sm's change", () => {
  const T0 = NOW - 300 * DAY;
  const p = buildOrganizePlan(input({
    config: { ...quiet, history: { days: 90, minPerProject: 0 } },
    threads: [
      // t3sm settled X; later the user showed it, worked in it and settled it again by hand: recent, but stays settled.
      thread("import:x", { latestUserMessageAt: iso(NOW - DAY), settledOverride: "settled", settledAt: iso(NOW - DAY), unsettledAt: iso(NOW - 20 * DAY) }),
      // The same with a backdated settle of t3sm's (its settledAt is old; the user's new settle is not).
      thread("import:xb", { latestUserMessageAt: iso(NOW - DAY), settledOverride: "settled", settledAt: iso(NOW - DAY), unsettledAt: iso(NOW - 20 * DAY) }),
      // t3sm showed Y; later the user settled it and showed it again by hand: old now, but stays shown.
      thread("import:y", { latestUserMessageAt: iso(NOW - 200 * DAY), settledOverride: "active", settledAt: null, unsettledAt: iso(NOW - 10 * DAY) }),
    ],
    journal: run("20260115-120000-aaaa", T0, [
      ["settle", "import:x", "active", "settled"],
      ["settle", "import:xb", "active", { settledAt: iso(T0 - 50 * DAY) }],
      ["unsettle", "import:y", "settled", "active"],
    ]),
  }));
  assert.deepEqual(p.actions, []);
});

test("t3sm's own last settle or unsettle is not taken for a change by hand (T3 dates it at the write)", () => {
  const T0 = NOW - 300 * DAY;
  const p = buildOrganizePlan(input({
    config: { ...quiet, history: { days: 90, minPerProject: 0 } },
    threads: [
      // Settled by t3sm 30 s into its run (T3 dated the settle then); active again lately: shown again.
      thread("import:x", { latestUserMessageAt: iso(NOW - DAY), settledOverride: "settled", settledAt: iso(T0 + 30_000), unsettledAt: iso(T0 - 9 * DAY) }),
      // Shown by t3sm 50 s into its run; old now: settles.
      thread("import:y", { latestUserMessageAt: iso(NOW - 200 * DAY), settledOverride: "active", settledAt: null, unsettledAt: iso(T0 + 50_000) }),
    ],
    journal: run("20260115-120000-bbbb", T0, [["settle", "import:x", "active", "settled"], ["unsettle", "import:y", "settled", "active"]]),
  }));
  assert.deepEqual(p.actions.map((a) => `${a.kind}:${a.target}`), ["unsettle:import:x", "settle:import:y"]);
});

/** Plans one old thread t3sm showed in `journal`'s run, with T3's `unsettledAt` at `at`: 1 when it settles, 0 when left alone. */
const settlesAt = (journal: JournalEntry[], at: number): number => buildOrganizePlan(input({
  config: { ...quiet, history: { days: 90, minPerProject: 0 } }, journal,
  threads: [thread("import:y", { latestUserMessageAt: iso(NOW - 200 * DAY), settledOverride: "active", settledAt: null, unsettledAt: iso(at) })],
})).actions.length;

test("a run killed before its run-end, followed by another run: its writes up to the next run's start are t3sm's own", () => {
  const T0 = NOW - 300 * DAY;
  const killed = run("20260115-120000-cccc", T0, [["unsettle", "import:y", "settled", "active"]]).slice(0, -1);
  const next = run("20260115-150000-dddd", T0 + 3 * 3_600_000, []);
  assert.equal(settlesAt([...killed, ...next], T0 + 2 * 3_600_000), 1, "written two hours into the killed run: t3sm's");
  assert.equal(settlesAt([...killed, ...next], T0 + 4 * 3_600_000), 0, "after the next run started: by hand");
});

test("a run killed before its run-end, the last one: its writes are t3sm's own when planning now", () => {
  const T0 = NOW - 300 * DAY;
  const killed = run("20260115-120000-cccc", T0, [["unsettle", "import:y", "settled", "active"]]).slice(0, -1);
  assert.equal(settlesAt(killed, T0 + 5 * 3_600_000), 1);
  assert.equal(settlesAt(killed, NOW - DAY), 1, "the planner runs under the lock: no earlier run can still be writing");
});

test("t3sm's own write is bounded by its run-end plus one minute", () => {
  const T0 = NOW - 300 * DAY;
  const j = run("20260115-120000-eeee", T0, [["unsettle", "import:y", "settled", "active"]]); // run-end at T0 + 60 s
  assert.equal(settlesAt(j, T0 + 60_000 + 59_000), 1, "inside the margin: t3sm's own");
  assert.equal(settlesAt(j, T0 + 60_000 + 61_000), 0, "past the margin: by hand");
});

test("settle is backdated to the activity date when input.backdate is on", () => {
  const w = (backdate: boolean): OrganizeAction[] => buildOrganizePlan(input({
    config: { ...quiet, history: { days: 90, minPerProject: 0 } }, backdate,
    threads: [thread("import:old", { latestUserMessageAt: iso(NOW - 120 * DAY), settledOverride: null, settledAt: null })],
  })).actions;
  assert.deepEqual(w(true), [{
    kind: "settle", target: "import:old", projectId: "p1", previous: null, next: { settledAt: iso(NOW - 120 * DAY) }, reason: "history: older than 90 days",
  }]);
  assert.equal(w(false)[0]!.next, "settled");
});

test("history rule: automated, to-be-archived, unknown-state and out-of-scope threads never move", () => {
  const p = buildOrganizePlan(input({
    config: { ...quiet, history: { days: 90, minPerProject: 0 }, archiveAutomated: false },
    projects: [project("p1"), project("ptmp")], projectCategory: { ptmp: "temp" },
    threads: [
      thread("import:auto", { latestUserMessageAt: iso(NOW - DAY) }),
      thread("import:tmp", { projectId: "ptmp", latestUserMessageAt: iso(NOW - DAY) }),
      thread("import:unknown", { latestUserMessageAt: iso(NOW - 200 * DAY), settledOverride: "unknown", settledAt: null }),
      thread("import:other", { latestUserMessageAt: iso(NOW - DAY) }),
      thread("import:mine", { latestUserMessageAt: iso(NOW - DAY) }),
    ],
    sessions: { "import:auto": { origin: "automated" } },
    journal: [{ t: "project-created", runId: "r0", projectId: "ptmp", root: "C:/Users/demo/AppData/Local/Temp/x" }],
    scope: { onlyThreads: new Set(["import:auto", "import:tmp", "import:unknown", "import:mine"]) },
  }));
  assert.deepEqual(p.actions.map((a) => `${a.kind}:${a.target}`), ["archive:import:tmp", "unsettle:import:mine"]);
});

// ---- 5.4 pins ----

function pinWorld(): Over {
  // p1 newest ... p6 oldest; p7 has no thread; pX archived, pD deleted (both very recent).
  const projects = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"].map((id) => project(id));
  projects.push(project("pX", { archived: true }), project("pD", { deleted: true }));
  const threads = [
    thread("t1", { projectId: "p1", latestUserMessageAt: iso(NOW - 1 * DAY) }), // native thread counts
    thread("import:2", { projectId: "p2", latestUserMessageAt: iso(NOW - 2 * DAY) }),
    thread("import:3", { projectId: "p3", latestUserMessageAt: iso(NOW - 3 * DAY) }),
    thread("import:3b", { projectId: "p3", latestUserMessageAt: iso(NOW - 90 * DAY) }),
    thread("import:4", { projectId: "p4", latestUserMessageAt: iso(NOW - 4 * DAY) }),
    thread("import:5", { projectId: "p5", latestUserMessageAt: iso(NOW - 5 * DAY) }),
    thread("import:6", { projectId: "p6", latestUserMessageAt: iso(NOW - 6 * DAY) }),
    thread("import:x", { projectId: "pX", latestUserMessageAt: iso(NOW - 0.5 * DAY) }),
    thread("import:d", { projectId: "pD", latestUserMessageAt: iso(NOW - 0.5 * DAY) }),
  ];
  return { projects, threads, config: { history: "off", pinRecent: { enabled: true, count: 5 } } };
}

test("pins the top count projects by newest activity (native included), skipping already pinned", () => {
  const w = pinWorld();
  w.projects = w.projects!.map((p) => (p.id === "p3" ? { ...p, pinned: true } : p));
  const p = buildOrganizePlan(input(w));
  assert.deepEqual(targets(p.actions, "pin"), ["p1", "p2", "p4", "p5"]);
  assert.deepEqual(of(p.actions, "pin")[0], { kind: "pin", target: "p1", projectId: "p1", previous: false, next: true, reason: "top 5 recent" });
  assert.deepEqual(of(p.actions, "unpin"), []);
});

test("pin ties are broken by title then id", () => {
  const at = iso(NOW - DAY);
  const p = buildOrganizePlan(input({
    config: { history: "off", pinRecent: { enabled: true, count: 2 } },
    projects: [project("pb", { title: "Same" }), project("pa", { title: "Same" }), project("pc", { title: "Alpha" })],
    threads: [thread("t1", { projectId: "pb", latestUserMessageAt: at }), thread("t2", { projectId: "pa", latestUserMessageAt: at }), thread("t3", { projectId: "pc", latestUserMessageAt: at })],
  }));
  assert.deepEqual(targets(p.actions, "pin"), ["pc", "pa"]);
});

test("unpins projects t3sm pinned that left the top; leaves the user's own pins", () => {
  const w = pinWorld();
  w.projects = w.projects!.map((p) => (p.id === "p6" || p.id === "p7" || p.id === "pX" ? { ...p, pinned: true } : p));
  w.journal = [change("pin", "p6", false, true), change("pin", "pX", false, true)]; // p7: the user's own pin
  const p = buildOrganizePlan(input(w));
  assert.deepEqual(targets(p.actions, "unpin"), ["p6", "pX"]);
  assert.deepEqual(of(p.actions, "unpin")[0], { kind: "unpin", target: "p6", projectId: "p6", previous: true, next: false, reason: "left the top 5 recent" });
});

test("user unpinned project is never pinned again", () => {
  const w = pinWorld();
  w.journal = [change("pin", "p1", false, true)]; // t3sm pinned p1; p1 is not pinned now
  const p = buildOrganizePlan(input(w));
  assert.deepEqual(targets(p.actions, "pin"), ["p2", "p3", "p4", "p5"]);
  assert.deepEqual(of(p.actions, "unpin"), []);
});

test("user re-pinned project t3sm unpinned is never unpinned again", () => {
  const w = pinWorld();
  w.projects = w.projects!.map((p) => (p.id === "p6" ? { ...p, pinned: true } : p));
  w.journal = [change("pin", "p6", false, true), change("unpin", "p6", true, false)];
  const p = buildOrganizePlan(input(w));
  assert.deepEqual(of(p.actions, "unpin"), []);
});

test("allowPins false → no pin/unpin", () => {
  const w = pinWorld();
  w.projects = w.projects!.map((p) => (p.id === "p6" ? { ...p, pinned: true } : p));
  w.journal = [change("pin", "p6", false, true)];
  w.scope = { allowPins: false };
  const p = buildOrganizePlan(input(w));
  assert.deepEqual([...of(p.actions, "pin"), ...of(p.actions, "unpin")], []);
});

test("pinRecent disabled → no pin/unpin", () => {
  const w = pinWorld();
  w.config = { history: "off", pinRecent: { enabled: false, count: 5 } };
  assert.deepEqual(buildOrganizePlan(input(w)).actions, []);
});

test("archived threads and threads planned for archive do not rank a project", () => {
  const p = buildOrganizePlan(input({
    config: { history: "off", pinRecent: { enabled: true, count: 1 } },
    projects: [project("pa"), project("pb"), project("pc")],
    threads: [
      thread("import:a", { projectId: "pa", latestUserMessageAt: iso(NOW - 1 * DAY), archived: true }),
      thread("import:b", { projectId: "pb", latestUserMessageAt: iso(NOW - 2 * DAY) }),
      thread("import:c", { projectId: "pc", latestUserMessageAt: iso(NOW - 3 * DAY) }),
    ],
    sessions: { "import:b": { origin: "automated" } },
  }));
  assert.deepEqual(targets(p.actions, "pin"), ["pc"]);
});

// ---- 5.5 project cleanup ----

test("deletes t3sm-created projects with zero threads only", () => {
  const p = buildOrganizePlan(input({
    config: quiet,
    projects: [project("p1"), project("empty"), project("arch-only"), project("user-empty")],
    threads: [thread("import:a", { projectId: "p1" }), thread("import:z", { projectId: "arch-only", archived: true })],
    sessions: { "import:a": {} },
    journal: [
      { t: "project-created", runId: "r0", projectId: "empty", root: "C:/work/empty" },
      { t: "project-created", runId: "r0", projectId: "arch-only", root: "C:/work/arch-only" },
      { t: "project-created", runId: "r0", projectId: "gone", root: "C:/work/gone" },
    ],
  }));
  assert.deepEqual(of(p.actions, "project-delete"), [{
    kind: "project-delete", target: "empty", projectId: "empty",
    previous: { title: "EMPTY", workspaceRoot: "C:/work/empty" }, next: null, reason: "created by t3sm, no threads",
  }]);
});

test("an empty project t3sm created in the last 24 h, or one with sessions still waiting to import, is never deleted", () => {
  const at = (ms: number): string => new Date(ms).toISOString();
  const idAt = (ms: number): string => `${at(ms).slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}-abcd`;
  const created = (projectId: string, ms: number, withStart = true): JournalEntry[] => [
    ...(withStart ? [{ t: "run-start" as const, runId: `run-${projectId}`, at: at(ms), command: "apply" }] : []),
    { t: "project-created", runId: withStart ? `run-${projectId}` : idAt(ms), projectId, root: `C:/work/${projectId}` },
  ];
  const p = buildOrganizePlan({
    ...input({
      config: quiet,
      projects: [project("old"), project("fresh"), project("fresh-id"), project("waiting"), project("day-old")],
      journal: [
        ...created("old", NOW - 3 * DAY), ...created("fresh", NOW - 2 * 3_600_000), ...created("fresh-id", NOW - 3_600_000, false),
        ...created("waiting", NOW - 5 * DAY), ...created("day-old", NOW - DAY - 60_000),
      ],
    }),
    keepProjects: new Set(["waiting"]),
  });
  assert.deepEqual(targets(p.actions, "project-delete"), ["old", "day-old"]);
});

test("allowDeletes false → no project-delete", () => {
  const p = buildOrganizePlan(input({
    config: quiet, scope: { allowDeletes: false }, projects: [project("empty")],
    journal: [{ t: "project-created", runId: "r0", projectId: "empty", root: "C:/work/empty" }],
  }));
  assert.deepEqual(p.actions, []);
});

test("t3sm project in a temp/system folder: its import threads are archived, the project is kept", () => {
  const p = buildOrganizePlan(input({
    config: showAll,
    projects: [project("ptmp"), project("psys"), project("pusr")],
    projectCategory: { ptmp: "temp", psys: "system", pusr: "temp" },
    threads: [
      thread("import:t1", { projectId: "ptmp" }), thread("native-t", { projectId: "ptmp" }),
      thread("import:t2", { projectId: "ptmp", archived: true }),
      thread("import:s1", { projectId: "psys" }),
      thread("import:u1", { projectId: "pusr" }), // project not created by t3sm
    ],
    journal: [
      { t: "project-created", runId: "r0", projectId: "ptmp", root: "C:/Users/demo/AppData/Local/Temp/x" },
      { t: "project-created", runId: "r0", projectId: "psys", root: "C:/Windows/x" },
    ],
  }));
  assert.deepEqual(of(p.actions, "archive").map((a) => [a.target, a.reason]), [
    ["import:t1", "temp folder"], ["import:s1", "system folder"],
  ]);
  assert.deepEqual(targets(p.actions, "unsettle"), ["import:u1"], "a thread planned for archive is not also shown");
  assert.deepEqual(of(p.actions, "project-delete"), []);
});

test("temp-folder threads are kept when the user chose to import that folder kind", () => {
  const base = organizeSettings(cfg(), "en");
  const p = buildOrganizePlan(input({
    config: { ...quiet, history: "off", folders: { ...base.folders, temp: "import" } },
    projects: [project("ptmp")], projectCategory: { ptmp: "temp" },
    threads: [thread("import:t1", { projectId: "ptmp" })],
    journal: [{ t: "project-created", runId: "r0", projectId: "ptmp", root: "C:/x" }],
  }));
  assert.deepEqual(p.actions, []);
});

// ---- auto-settle ----

test("auto-settle only when asked and different", () => {
  assert.deepEqual(of(buildOrganizePlan(input({ config: quiet })).actions, "auto-settle"), []);
  assert.deepEqual(of(buildOrganizePlan(input({ config: quiet, autoSettle: { want: 7, current: 7 } })).actions, "auto-settle"), []);
  assert.deepEqual(of(buildOrganizePlan(input({ config: quiet, autoSettle: { want: null, current: 7 } })).actions, "auto-settle"), [{
    kind: "auto-settle", target: "sidebarAutoSettleAfterDays", projectId: null, previous: 7, next: null, reason: "global auto-settle",
  }]);
});

test("auto-settle comes after every history change: T3 Code's option changes only once the rule marked what stays visible", () => {
  // 30 days, at least 1 per project: a recent settled one is shown again, an old visible one is settled.
  const p = buildOrganizePlan(input({
    config: { ...quiet, history: { days: 30, minPerProject: 1 } },
    threads: [
      thread("import:recent", { latestUserMessageAt: iso(NOW - 2 * DAY) }),
      thread("import:old", { latestUserMessageAt: iso(NOW - 200 * DAY), settledOverride: null, settledAt: null }),
    ],
    autoSettle: { want: 30, current: 15 },
  }));
  const kinds = p.actions.map((a) => a.kind);
  assert.ok(kinds.includes("unsettle") && kinds.includes("settle"), kinds.join(","));
  const auto = kinds.indexOf("auto-settle");
  assert.equal(auto, kinds.length - 1, "the setting is the last change");
  assert.ok(kinds.every((k, i) => (k !== "unsettle" && k !== "settle") || i < auto));
});

// ---- plan shape ----

test("runId, counts for every kind, project-title never planned", () => {
  const p = buildOrganizePlan(input({
    config: showAll,
    threads: [thread("import:a"), thread("import:b", { title: "<x>" })],
    sessions: { "import:a": { origin: "automated" }, "import:b": { title: "Nice" } },
  }));
  assert.equal(p.runId, "run-org-1");
  assert.deepEqual(p.counts, { archive: 1, title: 1, "ai-title": 0, unsettle: 1, settle: 0, pin: 0, unpin: 0, "project-delete": 0, "project-title": 0, "auto-settle": 0 });
});

test("byProject visibleAfter counts unsettled threads per project", () => {
  const p = buildOrganizePlan(input({
    config: showAll,
    projects: [project("pa", { title: "Beta" }), project("pb", { title: "Alpha" }), project("pc", { title: "Gamma" }), project("pe", { title: "Empty" })],
    threads: [
      thread("import:a1", { projectId: "pa" }), thread("import:a2", { projectId: "pa" }),
      thread("native-a", { projectId: "pa", settledOverride: null, settledAt: null }), // visible already
      thread("import:a3", { projectId: "pa", archived: true, settledOverride: null, settledAt: null }),
      thread("import:b1", { projectId: "pb", settledOverride: "active", settledAt: null }), // visible already
      thread("import:b2", { projectId: "pb" }), thread("import:b3", { projectId: "pb", settledOverride: null, settledAt: null }),
      thread("import:c1", { projectId: "pc", settledOverride: null, settledAt: null }), // visible, archived by plan
    ],
    sessions: { "import:a1": {}, "import:a2": {}, "import:b2": {}, "import:c1": { origin: "automated" } },
  }));
  assert.deepEqual(p.byProject, [
    { projectId: "pb", title: "Alpha", visibleBefore: 2, visibleAfter: 3 },
    { projectId: "pa", title: "Beta", visibleBefore: 1, visibleAfter: 3 },
    { projectId: "pc", title: "Gamma", visibleBefore: 1, visibleAfter: 0 },
  ]);
});

test("one definition of visible: not archived and settledAt null (R20)", () => {
  const t = (x: Partial<T3Thread>): T3Thread => ({ id: "t", projectId: "p", instanceId: "i", archived: false, title: "x", ...x });
  const auto = t({ settledOverride: null, settledAt: "2026-01-01T00:00:00Z" });
  assert.equal(isVisibleInProject(auto), false);
  assert.equal(isOnSettledShelf(auto), true);
  const odd = t({ settledOverride: "settled", settledAt: null });
  assert.equal(isVisibleInProject(odd), true);
  assert.equal(isVisibleInProject(t({ settledOverride: "active", settledAt: null })), true);
  assert.equal(isVisibleInProject(t({ archived: true })), false);
  assert.equal(isOnSettledShelf(t({ archived: true, settledAt: "2026-01-01T00:00:00Z" })), false);
});

test("history: a follow's revision thread inherits the user's settle choice from its old thread, along the chain; a rolled-back follow does not", () => {
  // The old thread was settled by hand (settled, unsettledAt set, t3sm never changed it); each follow carried it on.
  const old = thread("import:copy", { archived: true, latestUserMessageAt: iso(NOW - 200 * DAY), unsettledAt: iso(NOW - 3 * DAY) });
  const r1 = thread("import:r1", { archived: true, latestUserMessageAt: iso(NOW - 200 * DAY) });
  const r2 = thread("import:r2", { latestUserMessageAt: iso(NOW - 200 * DAY), settledOverride: "settled" });
  const followed = (runId: string, oldThread: string, newThread: string): JournalEntry =>
    ({ t: "followed", runId, original: "C:/work/home/a.jsonl", copy: `C:/work/demo/${newThread}.jsonl`, oldThread, newThread, mode: "revision" });
  const plan = (journal: JournalEntry[]) => buildOrganizePlan(input({
    threads: [old, r1, r2], journal, config: { ...quiet, history: { days: 30, minPerProject: 1 } },
  })).actions;
  const chain = [followed("run-f-1", "import:copy", "import:r1"), followed("run-f-2", "import:r1", "import:r2")];
  assert.deepEqual(plan(chain), [], "the user's choice, two follows on");
  // Without the follow lineage (or with its runs rolled back) r2 is an ordinary settled import: shown for the minimum.
  assert.deepEqual(plan([]).map((a) => [a.kind, a.target]), [["unsettle", "import:r2"]]);
  const undone = [...chain, { t: "rolled-back", runId: "run-rb", targetRunId: "run-f-2", at: iso(NOW) } as JournalEntry];
  assert.deepEqual(plan(undone).map((a) => [a.kind, a.target]), [["unsettle", "import:r2"]]);
});

test("5 000 threads with a 5 000-change journal: t3sm's own settles are shown again, the ones redone by hand stay", () => {
  // The history test plans 5 000 threads through historyActions alone; this goes through buildOrganizePlan with a
  // large journal, so the journal lookups (lastChanges, touched) run at that size too.
  const T0 = NOW - 300 * DAY;
  const threads: T3Thread[] = [];
  const changes: [OrganizeKind, string, unknown, unknown][] = [];
  for (let p = 0; p < 50; p++) {
    for (let n = 0; n < 100; n++) {
      const id = `import:p${p}-t${n}`;
      const own = n % 2 === 0;
      // Recent again; t3sm settled every one in its run. The even ones still carry t3sm's settle (T3 dated it in the
      // run); the odd ones were shown and settled again by hand since.
      threads.push(thread(id, {
        projectId: `p${p}`, latestUserMessageAt: iso(NOW - DAY), settledOverride: "settled",
        settledAt: own ? iso(T0 + 30_000) : iso(NOW - DAY), unsettledAt: own ? iso(T0 - 9 * DAY) : iso(NOW - 20 * DAY),
      }));
      changes.push(["settle", id, "active", "settled"]);
    }
  }
  const p = buildOrganizePlan(input({
    config: { ...quiet, history: { days: 90, minPerProject: 0 } },
    projects: Array.from({ length: 50 }, (_, i) => project(`p${i}`)),
    threads, journal: run("20260115-120000-eeee", T0, changes),
  }));
  const un = targets(p.actions, "unsettle");
  assert.equal(un.length, 2500);
  assert.ok(un.every((id) => Number(/-t(\d+)$/.exec(id)![1]) % 2 === 0), "only t3sm's own settles are undone");
  assert.equal(of(p.actions, "settle").length, 0);
});

test("marks follow T3 Code's own auto-settle as it will be after this run: the planned value, else its current one", () => {
  const bare = { settledOverride: null, settledAt: null };
  const threads = [thread("import:old1", { ...bare, latestUserMessageAt: iso(NOW - 200 * DAY) }), thread("import:old2", { ...bare, latestUserMessageAt: iso(NOW - 300 * DAY) })];
  const marks = (o: Over): string[] => targets(buildOrganizePlan(input({ config: { ...quiet, history: { days: 90, minPerProject: 10 } }, threads, ...o })).actions, "unsettle");
  assert.deepEqual(marks({}), [], "T3 Code's value unknown");
  assert.deepEqual(marks({ t3AutoSettleDays: null }), [], "off");
  assert.deepEqual(marks({ t3AutoSettleDays: 15 }), ["import:old2", "import:old1"]);
  assert.deepEqual(marks({ t3AutoSettleDays: 15, autoSettle: { want: null, current: 15 } }), [], "turned off by this run");
  assert.deepEqual(marks({ t3AutoSettleDays: null, autoSettle: { want: 30, current: null } }), ["import:old2", "import:old1"], "turned on by this run");
});
