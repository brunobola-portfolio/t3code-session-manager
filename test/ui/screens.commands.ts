// The command screens (Task 21): status, doctor, plan, apply, sync, organize and the error panel, each in the states a
// user meets, on synthetic data. Registered in SCREENS by screens.ts, so the matrix runs every one of them (widths
// 40/80/120 x colour x Unicode x en/pt) and snapshots the English ones.

import type { Lang } from "../../src/assistant/i18n.ts";
import type { Caps } from "../../src/ui/caps.ts";
import type { ApplyResult, DryRunReport, ImportFailure } from "../../src/apply/apply.ts";
import { sayText, type Check, type SayPart } from "../../src/ops/doctor.ts";
import type { CycleOutcome } from "../../src/ops/sync.ts";
import { zeroCounts } from "../../src/ops/sync.ts";
import type { OrganizePlan } from "../../src/organize/types.ts";
import type { Plan, PlanItem } from "../../src/core/types.ts";
import { makeCliUi } from "../../src/cli/ui.ts";
import { relative, renderStatus, sayingItem, undecidedItem, type StatusReport } from "../../src/cli/commands/status.ts";
import { renderDoctor } from "../../src/cli/commands/doctor.ts";
import { renderTerminalSummary } from "../../src/plan/report.ts";
import { renderApplyResult } from "../../src/cli/applyScreen.ts";
import { renderDryRun } from "../../src/cli/commands/apply.ts";
import { renderSyncResult } from "../../src/cli/commands/sync.ts";
import { renderOrganize } from "../../src/cli/commands/organize.ts";
import { renderError } from "../../src/cli/errors.ts";
import { ConfigError } from "../../src/core/config.ts";
import { T3NotRunning } from "../../src/t3/errors.ts";
import type { Screen } from "./screens.ts";

export const NOW = Date.parse("2026-11-15T12:00:00Z");
const MIN = 60_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const ui = (caps: Caps, lang: Lang) => makeCliUi(caps, lang, () => NOW);
const lines = (s: string): string[] => s.replace(/\n$/, "").split("\n");

// ---------------- status ----------------

function report(o: Partial<StatusReport>): StatusReport {
  return {
    version: 2, ran: true, level: "ok", items: [], needsAttention: null, waiting: [], heldRehome: 0, decisionsPending: {},
    pendingImports: { count: 0, source: "sync", at: null },
    lastSync: { at: ago(3 * MIN), outcome: "ok", runId: "20261115-115700-a1b2" },
    nextSync: { at: new Date(NOW + 7 * MIN).toISOString(), source: "watcher" },
    watcher: { running: true, pid: 4321, version: "0.3.0", stale: false },
    update: { installed: "0.3.0", available: null, failure: null, lastInstalled: null },
    runInProgress: null, lastOrganize: null,
    plugin: [{ account: "personal", name: "Claude Personal", state: "installed", version: "0.3.0" }],
    t3Code: { running: true, version: "0.1.9" },
    ...o,
  };
}

const statusScreen = (name: string, r: (lang: Lang) => StatusReport): Screen => ({
  name, render: (caps, lang) => lines(renderStatus(r(lang), { ui: ui(caps, lang), now: NOW, version: "0.3.0" })),
});

/** "25 min ago" the way `t3sm status` words it, in the screen's language (Task 22: the PT fixture said it in English). */
const agoIn = (ms: number, lang: Lang): string => relative(ms, lang);

export const STATUS_NEEDS_YOU = (lang: Lang = "en"): StatusReport => report({
  level: "needs-you",
  items: [
    undecidedItem({ automated: 2, "t3-refused": 1 }),
    sayingItem("needs-you", "watcher-gone", "status.watcher.gone", { pid: 4321, last: agoIn(25 * MIN, lang) }, "t3sm schedule restart"),
    sayingItem("info", "held:demo", "status.held", { project: "demo", title: "Fix the login form", ago: agoIn(25 * MIN, lang) }, null),
    sayingItem("info", "update-available", "status.update.available", { version: "0.3.1" }, "t3sm update"),
  ],
  decisionsPending: { automated: 2, "t3-refused": 1 },
  pendingImports: { count: 3, source: "plan", at: ago(20 * 60 * MIN) },
  watcher: { running: false, pid: 4321, version: "0.3.0", stale: true },
  lastOrganize: { runId: "20261114-090000-c3d4", at: ago(3 * 24 * 60 * MIN), changes: 12, reverted: 0, rolledBackBy: null },
  plugin: [{ account: "personal", name: "Claude Personal", state: "installed", version: "0.3.0" }, { account: "work", name: "Claude Work", state: "missing", version: null }],
});

// ---------------- doctor ----------------

// Worded from the catalogue like doctor's own checks (Task 22), so the Portuguese screen is Portuguese.
const said = (id: string, status: Check["status"], msg: SayPart[], fix?: SayPart[]): Check =>
  ({ id, status, message: sayText(msg, "en"), say: msg, ...(fix ? { fix: sayText(fix, "en"), sayFix: fix } : {}) });
const part = (key: SayPart["key"], vars?: SayPart["vars"]): SayPart => ({ key, ...(vars ? { vars } : {}) });
const CHECKS_READY: Check[] = [
  said("node-version", "ok", [part("doctor.say.nodeVersion.ok", { version: "24.11.1" })]),
  said("state-dir", "ok", [part("doctor.say.stateDir.ok", { dir: "~/.t3code-session-manager" })]),
  said("t3-reachable", "ok", [part("doctor.say.t3Reachable.ok", { origin: "http://127.0.0.1:3773" })]),
  said("claude-env", "warn", [part("doctor.say.claudeEnv.set", { dir: "C:/work/demo/.claude-alt" })], [part("doctor.fix.claudeEnv.win")]),
  said("harness:codex", "skip", [part("doctor.say.harness.none")]),
];
const CHECKS_PROBLEMS: Check[] = [
  said("node-version", "ok", [part("doctor.say.nodeVersion.ok", { version: "24.11.1" })]),
  said("t3-reachable", "fail", [part("doctor.say.t3Reachable.fail", { origin: "http://127.0.0.1:3773" })], [part("doctor.fix.openT3.win")]),
  said("t3-token", "skip", [part("doctor.say.needsT3")]),
  said("backups-present", "warn", [part("doctor.say.backups.found", { n: 2, per: "~/.claude: 2" })], [part("doctor.fix.backups")]),
  said("sync-watcher", "warn", [part("doctor.say.watcher.late", { pid: 4321, last: [part("doctor.say.watcher.lastCycle", { ageMs: 50 * MIN })], due: "11:20" })], [part("doctor.fix.watcher.late", { pid: 4321 })]),
];

// ---------------- plan ----------------

function item(n: number, harness: "claude" | "opencode", action: PlanItem["action"], cwd = "C:/work/demo"): PlanItem {
  return {
    session: {
      harness, accountId: harness === "claude" ? "claudeAgent" : null, nativeId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, cwd,
      startedAt: ago(10 * MIN), updatedAt: ago(5 * MIN), messageCount: 4, corruptLines: 0, flags: [], cwdOffsetBytes: 100,
      file: { path: `C:/work/demo/${n}.jsonl`, size: 100, mtimeMs: NOW, atimeMs: NOW },
    },
    action, notes: [],
  };
}

export function demoPlan(): Plan {
  const items: PlanItem[] = [];
  let n = 0;
  const add = (k: number, f: () => PlanItem["action"], harness: "claude" | "opencode" = "claude"): void => { for (let i = 0; i < k; i++) items.push(item(++n, harness, f())); };
  add(251, () => ({ kind: "import", projectRoot: "C:/work/demo", instanceId: "claude-work", expectedThreadId: `import:claude-work:${n}` }));
  add(155, () => ({ kind: "import", projectRoot: "C:/work/app", instanceId: "claudeAgent", expectedThreadId: `import:claudeAgent:${n}` }));
  add(6, () => ({ kind: "convert-import", projectRoot: "C:/work/app", instanceId: "claudeAgent", expectedThreadId: `import:claudeAgent:c${n}`, uuid: `u${n}`, targetFile: `C:/work/app/u${n}.jsonl` }), "opencode");
  add(41, () => ({ kind: "skip", reason: "backup-copy" }));
  add(9, () => ({ kind: "skip", reason: "cwd-missing" }));
  add(5, () => ({ kind: "skip", reason: "active" }));
  return {
    version: 1, runId: "20261115-093012-a1b2", createdAt: ago(5 * MIN), t3Version: "0.1.9",
    instancesToCreate: [{ id: "claude-work", driver: "claudeAgent", displayName: "Claude Work", accentColor: null, homePath: "~/.claude-work", environment: [] }],
    projectsToCreate: Array.from({ length: 12 }, (_, i) => ({ root: `C:/work/p${i}`, title: `p${i}`, defaultInstanceId: null })),
    projectAccounts: [], projectDefaults: [], mirrorCopies: [], items, warnings: [],
    decisionsPending: [{ key: "automated", sessions: 2, folders: 1 }, { key: "home", sessions: 1, folders: 1 }],
  } as Plan;
}
const NAMES = { claudeAgent: "Claude Personal", "claude-work": "Claude Work" };
const PLAN_PATH = "~/.t3code-session-manager/runs/20261115-093012-a1b2/plan.md";

// ---------------- apply ----------------

const failure = (n: number, reason: ImportFailure["reason"], title: string | null, root = "C:/work/demo"): ImportFailure =>
  ({ harness: "claude", nativeId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, reason, projectRoot: root, title });

export const FAILURES: ImportFailure[] = [
  failure(1, "not-imported", "Fix the login form"),
  failure(2, "cwd-unreadable-in-t3", "Plan the API", "C:/work/api"),
  failure(3, "instance-unavailable", null, "C:/work/app"),
  failure(4, "project-mismatch", "Refactor the billing module and add tests for it", "C:/work/billing-service"),
  failure(5, "read-failed: database is locked", "Notes"),
  failure(6, "target-folder: it is a temporary folder", null),
];

function applyResult(o: Partial<ApplyResult>): ApplyResult {
  return {
    status: "ok", runId: "20261115-093125-c3d4", imported: 412, failed: 0, failures: [], converted: 6, deferred: 0, deferredInUse: 0,
    heldRoots: [], held: [], alreadyInT3: 3, restoreErrors: [], unverified: 0, parked: 0, recovered: null, ...o,
  };
}
const HELD = [{ project: "demo", root: "C:/work/demo", file: "C:/work/demo/x.jsonl", title: "Fix the build", modifiedAt: ago(3 * MIN) }];

function dryRun(): DryRunReport {
  return {
    plan: demoPlan(), pendingRecovery: ["C:/work/demo/1.jsonl"], instancesToCreate: ["claude-work"], projectsToCreate: ["C:/work/p0", "C:/work/p1"],
    defaultsToSet: [], conversions: 6, waves: 4, waveSessions: 406, alreadyInT3: 3, held: { roots: ["C:/work/demo"], sessions: 2 },
    failUpFront: [{ ...failure(9, "cwd-unreadable-in-t3", "Long setup"), reason: "cwd-unreadable-in-t3" }], pinDefault: "~/.claude", foldersToCreate: ["C:/work/General"],
  };
}

// ---------------- sync ----------------

export function syncOk(): CycleOutcome {
  return {
    kind: "partial", runId: "20261115-120000-e5f6",
    counts: { ...zeroCounts(), imported: 4, failed: 1, deferred: 1, heldInUse: 1, organized: 3, undecided: { automated: 2 } },
    held: HELD, failures: [failure(7, "not-imported", "Write the release notes")],
  };
}

// ---------------- organize ----------------

export function organizePlan(): OrganizePlan {
  const a = (kind: OrganizePlan["actions"][number]["kind"], projectId: string, i: number, reason: string, next: unknown = true): OrganizePlan["actions"][number] =>
    ({ kind, target: `t-${projectId}-${i}`, projectId, previous: null, next, reason });
  const actions = [
    ...Array.from({ length: 30 }, (_, i) => a("settle", "p-demo", i, "history: older than 90 days", "settled")),
    ...Array.from({ length: 4 }, (_, i) => a("title", "p-demo", 100 + i, "technical title", `Title ${i}`)),
    ...Array.from({ length: 2 }, (_, i) => a("archive", "p-app", i, "automated session (Agent SDK)")),
    ...Array.from({ length: 5 }, (_, i) => a("unsettle", "p-app", 10 + i, "history: last 90 days", "active")),
  ];
  const counts = { archive: 2, title: 4, unsettle: 5, settle: 30, pin: 0, unpin: 0, "project-delete": 0, "project-title": 0, "auto-settle": 0 };
  return {
    runId: "20261115-120500-a7b8", actions, counts,
    byProject: [
      { projectId: "p-demo", title: "demo", visibleBefore: 42, visibleAfter: 12 },
      { projectId: "p-app", title: "app", visibleBefore: 3, visibleAfter: 6 },
      { projectId: "p-quiet", title: "a-very-long-project-name-for-the-table", visibleBefore: 2, visibleAfter: 2 },
    ],
  };
}

export const COMMAND_SCREENS: Screen[] = [
  statusScreen("status-ok", () => report({})),
  statusScreen("status-needs-you", STATUS_NEEDS_YOU),
  statusScreen("status-working", () => report({ level: "working", runInProgress: { pid: 9876, startedAt: ago(2 * MIN) } })),
  // The background watcher cannot come back by itself (final review B, I2): it stops at start-up, config.json is bad.
  statusScreen("status-cannot-start", (lang) => report({
    level: "needs-you",
    items: [
      sayingItem("needs-you", "watcher-cannot-start", "status.watcher.cannotStart", { ago: agoIn(40 * MIN, lang), name: "Error" }, "t3sm doctor"),
      sayingItem("needs-you", "config-error", "status.configError", { error: "~/.t3code-session-manager/config.json: schedule.everyMinutes must be an integer 1..1440 (got 0)." }, "t3sm doctor"),
    ],
    watcher: { running: false, pid: 4321, version: "0.3.0", stale: false },
  })),
  { name: "doctor-ready", render: (caps, lang) => lines(renderDoctor(CHECKS_READY, ui(caps, lang))) },
  { name: "doctor-problems", render: (caps, lang) => lines(renderDoctor(CHECKS_PROBLEMS, ui(caps, lang))) },
  { name: "plan-summary", render: (caps, lang) => lines(renderTerminalSummary(demoPlan(), { planPath: PLAN_PATH, names: NAMES, ui: ui(caps, lang) })) },
  { name: "apply-result-ok", render: (caps, lang) => renderApplyResult(ui(caps, lang), applyResult({})) },
  {
    name: "apply-result-failures",
    render: (caps, lang) => renderApplyResult(ui(caps, lang), applyResult({
      status: "partial", imported: 6, failed: FAILURES.length, failures: FAILURES, converted: 0, alreadyInT3: 0, deferred: 3, deferredInUse: 2,
      held: HELD, heldRoots: ["C:/work/demo", "C:/work/locked"],
    })),
  },
  { name: "apply-dry-run", render: (caps, lang) => lines(renderDryRun(dryRun(), PLAN_PATH, ui(caps, lang), ["demo waits"], ["will create folder C:/work/General"], NAMES)) },
  { name: "sync-result", render: (caps, lang) => renderSyncResult(ui(caps, lang), syncOk(), NOW) },
  { name: "sync-nothing", render: (caps, lang) => renderSyncResult(ui(caps, lang), { kind: "noop", runId: null, counts: { ...zeroCounts(), heldRehome: 2 } }, NOW) },
  {
    name: "sync-dry-run",
    render: (caps, lang) => renderSyncResult(ui(caps, lang), { kind: "dry-run", runId: null, counts: { ...zeroCounts(), wouldImport: 7 }, byHarness: { claude: 6, codex: 1 }, projects: 3, newProjects: 1, overLimit: null }, NOW),
  },
  { name: "organize-preview", render: (caps, lang) => renderOrganize(ui(caps, lang), organizePlan(), { days: 90, minPerProject: 10 }) },
  { name: "organize-nothing", render: (caps, lang) => renderOrganize(ui(caps, lang), { ...organizePlan(), actions: [] }, null) },
  { name: "error-t3-down", render: (caps, lang) => renderError(new T3NotRunning(), ui(caps, lang), "win32") },
  { name: "error-config", render: (caps, lang) => renderError(new ConfigError("~/.t3code-session-manager/config.json: invalid config:\n  schedule.everyMinutes: must be an integer 1..1440\nFix the file, or delete it to regenerate defaults with `t3sm accounts --init`."), ui(caps, lang), "win32") },
  { name: "error-unexpected", render: (caps, lang) => renderError(new Error("EACCES: permission denied, open 'C:/work/demo/state.json'"), ui(caps, lang), "win32") },
];
