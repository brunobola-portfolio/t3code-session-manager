// The remaining command screens (Task 22): help (usage, a command, the topic list, a topic), scan, runs, rollback,
// quarantine, merge, schedule status, update --check, the release notes, projects, accounts, an organize undo and the
// elevated-shell warning, each on synthetic data. Registered in SCREENS by screens.ts, so the matrix runs every one
// (widths 40/80/120 x colour x Unicode x en/pt) and stores the snapshots in both languages.

import { join } from "node:path";
import type { Lang } from "../../src/assistant/i18n.ts";
import type { Caps } from "../../src/ui/caps.ts";
import type { DiscoveredSession } from "../../src/core/types.ts";
import type { RollbackReport, RunSummary } from "../../src/ops/rollback.ts";
import type { MergeCandidate } from "../../src/ops/merge.ts";
import type { ProjectRow } from "../../src/ops/projects.ts";
import type { ProviderInstanceInfo } from "../../src/t3/api.ts";
import { makeCliUi, cliT } from "../../src/cli/ui.ts";
import { commandHelp, renderHelpText, usageHelp } from "../../src/cli/helpText.ts";
import { readTopic, renderMarkdown, renderTopicList } from "../../src/cli/commands/help.ts";
import { renderScan } from "../../src/cli/commands/scan.ts";
import { renderRollback, renderRuns } from "../../src/cli/commands/rollback.ts";
import { renderBatch } from "../../src/cli/commands/quarantine.ts";
import { renderMergeList, renderMergeResult } from "../../src/cli/commands/merge.ts";
import { renderScheduleStatus } from "../../src/cli/commands/schedule.ts";
import { renderNotes, renderUpdateCheck } from "../../src/cli/commands/update.ts";
import { renderProjects, renameLines } from "../../src/cli/commands/projects.ts";
import { renderAccounts } from "../../src/cli/commands/accounts.ts";
import { namesOf, renderUndo } from "../../src/cli/commands/organize.ts";
import { changelogSections } from "../../src/core/changelog.ts";
import type { Config } from "../../src/core/types.ts";
import { noteLines } from "../../src/cli/screen.ts";
import { NOW } from "./screens.commands.ts";
import type { Screen } from "./screens.ts";

const MIN = 60_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const ui = (caps: Caps, lang: Lang) => makeCliUi(caps, lang, () => NOW);
const HELP_DIR = join(import.meta.dirname, "..", "..", "docs", "help");
const HOME = "C:/Users/demo";

// ---------------- scan ----------------

const session = (harness: "claude" | "codex" | "opencode", accountId: string | null, flags: string[] = []): DiscoveredSession => ({
  harness, accountId, nativeId: "00000000-0000-4000-8000-000000000001", cwd: "C:/work/demo", startedAt: ago(60 * MIN), updatedAt: ago(5 * MIN),
  messageCount: 4, corruptLines: 0, flags: flags as DiscoveredSession["flags"], cwdOffsetBytes: 100, file: { path: "C:/work/demo/1.jsonl", size: 100, mtimeMs: NOW, atimeMs: NOW },
});
const DISCOVERY = {
  sessions: [
    ...Array.from({ length: 1234 }, () => session("claude", "claudeAgent")), ...Array.from({ length: 56 }, () => session("claude", "claude-work", ["backup-copy"])),
    ...Array.from({ length: 7 }, () => session("codex", null)),
  ],
  errors: 2, unavailable: ["pi", "opencode"],
};

// ---------------- runs and rollback ----------------

const counts = (o: Partial<RunSummary["counts"]>): RunSummary["counts"] => ({
  imported: 0, importFailed: 0, filesWritten: 0, quarantined: 0, unquarantined: 0, defaults: 0, instances: 0, projects: 0, archived: 0, merged: 0, organized: 0, organizeReverted: 0, ...o,
});
const RUNS: RunSummary[] = [
  { runId: "20261114-093125-c3d4", at: ago(26 * 60 * MIN), command: "apply", status: "ok", rolledBackBy: null, counts: counts({ imported: 412, filesWritten: 6, projects: 12, instances: 1 }) },
  { runId: "20261115-090000-a1b2", at: ago(3 * 60 * MIN), command: "organize", status: "partial", rolledBackBy: "20261115-110000-e5f6", counts: counts({ organized: 41 }) },
  { runId: "20261115-110000-e5f6", at: ago(60 * MIN), command: "rollback 20261115-090000-a1b2", status: "ok", rolledBackBy: null, counts: counts({ organizeReverted: 40 }) },
];

function rollbackReport(): RollbackReport {
  return {
    runId: null, targetRunId: "20261115-093125-c3d4", command: "quarantine",
    filesRemoved: ["C:/Users/demo/.claude/projects/C--work-demo/0001.jsonl"], filesKeptModified: [], filesKeptActive: [], foldersRemoved: [], foldersKept: [],
    filesKeptRewritten: [], filesKeptRefreshed: [],
    unquarantined: ["C:/Users/demo/.claude/projects/C--work-demo.bak-20260630-111703", "C:/Users/demo/.claude/projects/C--work-app.bak"],
    unquarantineConflicts: [], alreadyRestored: [], unquarantineMissing: [], unquarantineFailed: [], defaultsRestored: [], defaultsSkipped: [],
    instanceChanges: [], instancesCreated: [], projectsCreated: [], threadsToReview: ["import:claudeAgent:0001"], threadsVerified: true, threadsArchived: [],
    parkedThreads: [], threadsUnarchived: [], mergesKept: [], needsReview: [], organize: [], t3Unavailable: null, errors: [],
  } as RollbackReport;
}

// ---------------- merge ----------------

const candidate = (id: string, root: string, added: number, title: string, diverged = 0): MergeCandidate => ({
  nativeId: id, projectRoot: root, addedMessages: added, oldTitle: title, divergedLeaves: diverged, lastActivity: ago(40 * MIN),
} as unknown as MergeCandidate);
const CANDIDATES = [
  candidate("1a2b3c4d-0000-4000-8000-000000000001", "C:/work/demo", 12, "Fix the login form"),
  candidate("5e6f7a8b-0000-4000-8000-000000000002", "C:/work/app", 3, "Plan the API", 1),
];

// ---------------- projects and accounts ----------------

const PROJECT_ROWS: ProjectRow[] = [
  { folder: "C:/Users/demo/code/app", account: "claudeAgent", accountName: "Claude Personal", reason: "recent-activity", pending: 12, inT3: "yes", held: false },
  { folder: "C:/work/demo/packages/billing-service", account: "claude-work", accountName: "Claude Work", reason: "route", pending: 0, inT3: "archived", held: true },
  { folder: "C:/work/new", account: "claude-work", accountName: "Claude Work", reason: "default", pending: 3, inT3: "no", held: false },
];

const inst = (id: string, home: string, email: string | null, auth = "authenticated"): ProviderInstanceInfo =>
  ({ instanceId: id, driver: "claudeAgent", homePath: home, displayName: id === "claudeAgent" ? "Claude Personal" : "Claude Work", accentColor: null, email, authStatus: auth, enabled: true, availability: "available" });
const CONFIG = {
  accounts: [
    { id: "claudeAgent", home: "~/.claude", displayName: "Claude Personal", accentColor: null },
    { id: "claude-work", home: "~/.claude-work", displayName: "Claude Work", accentColor: null },
    { id: "claude-old", home: "~/.claude-old", displayName: "Claude Old", accentColor: null },
  ],
} as unknown as Config;

// ---------------- release notes ----------------

const NOTES = `# Changelog

## [0.3.1] - 2026-11-15

### Fixed

- **Undo lines name the run.** The result of \`t3sm apply\` says \`t3sm rollback --run <id>\`, which the command accepts.
- A long line of notes that has to wrap at forty columns and again at eighty, so the bullet's text hangs under itself.
`;

export const MORE_SCREENS: Screen[] = [
  { name: "help-usage", render: (caps, lang) => renderHelpText(ui(caps, lang), usageHelp(lang)) },
  { name: "help-command", render: (caps, lang) => renderHelpText(ui(caps, lang), commandHelp("rollback", lang)!) },
  { name: "help-topics", render: (caps, lang) => renderTopicList(ui(caps, lang), HELP_DIR) },
  { name: "help-topic", render: (caps, lang) => renderMarkdown(ui(caps, lang), readTopic(HELP_DIR, "held", lang)!) },
  { name: "scan", render: (caps, lang) => renderScan(ui(caps, lang), DISCOVERY, undefined, { claudeAgent: "Claude Personal", "claude-work": "Claude Work" }) },
  { name: "runs", render: (caps, lang) => renderRuns(ui(caps, lang), RUNS) },
  {
    name: "rollback-dry-run",
    render: (caps, lang) => renderRollback(ui(caps, lang), rollbackReport(), true, { changes: new Map(), names: namesOf([], [], HOME, lang) }, caps.columns, HOME),
  },
  {
    name: "quarantine",
    render: (caps, lang) => renderBatch(ui(caps, lang), {
      account: { id: "claudeAgent", home: "~/.claude", displayName: "", accentColor: null },
      preview: {
        moved: [{ from: "~/.claude/projects/C--work-demo.bak", to: "~/.claude/session-manager-quarantine/backups/C--work-demo.bak" }],
        skipped: [{ path: "~/.claude/projects/C--work-app.bak", reason: "active (session.jsonl changed in the last 10 minutes)", say: { key: "moves.why.activeFile", vars: { file: "session.jsonl" } } }],
      },
    }, 1, "quarantine.noun"),
  },
  { name: "merge-list", render: (caps, lang) => renderMergeList(ui(caps, lang), CANDIDATES, { skipped: [{ nativeId: "x", reason: "compacted" }], orphaned: [] }, { listOnly: true, all: true }) },
  {
    name: "merge-result",
    render: (caps, lang) => renderMergeResult(ui(caps, lang), {
      merged: [{ nativeId: "1a2b3c4d-0000-4000-8000-000000000001", revisionUuid: "9f8e7d6c-0000-4000-8000-000000000003", revisionFile: "C:/x.jsonl", newThreadId: "thread-9f8e", oldThreadId: "t1", oldTitle: "Fix the login form", addedMessages: 12, divergedLeaves: 0, projectRoot: "C:/work/demo" }],
      skipped: [{ nativeId: "5e6f7a8b-0000-4000-8000-000000000002", reason: "project-in-use" }],
    }, "20261115-120000-a1b2"),
  },
  {
    name: "schedule-status",
    render: (caps, lang) => renderScheduleStatus(ui(caps, lang), {
      kind: "schtasks", installed: true, nextRun: "N/A", detail: "Running", command: 'cmd.exe /c start "" /min "C:/n/node.exe" "C:/t3sm/bin/t3sm.mjs" sync --watch --quiet',
      missing: ["C:/old/t3sm/bin/t3sm.mjs"], watch: true,
      watcher: { running: true, pid: 4321, lastCycleAt: ago(4 * MIN), outcome: "ok", nextCycleAt: ago(-11 * MIN) },
      lastLogged: "2026-11-15T11:56:00.000Z ok run=20261115-115600-c3d4 imported=2 failed=0 deferred=0 parked=0 held-in-use=0 held-dedupe=0 held-accounts=0 held-failed=0", // as logLine writes it
    }),
  },
  {
    name: "update-check",
    render: (caps, lang) => renderUpdateCheck(ui(caps, lang), {
      installed: "0.3.0", kind: "global", root: "C:/npm/t3sm", latest: "0.3.1", skipped: false, auto: "0.3.1",
      source: { kind: "github", repo: "demo-owner/demo-app" }, automatic: true, lastCheckAt: ago(3 * 60 * MIN),
      lastUpdate: { from: "0.2.1", to: "0.3.0", outcome: "installed" },
      pending: { runId: "r", target: "0.3.1", startedAt: ago(30 * MIN), interrupted: true, previous: { version: "0.3.0", spec: "github:demo-owner/demo-app#v0.3.0" }, source: { kind: "github", repo: "demo-owner/demo-app" } } as never,
    }),
  },
  { name: "changelog", render: (caps, lang) => renderNotes(ui(caps, lang), changelogSections(NOTES)) },
  { name: "projects", render: (caps, lang) => renderProjects(ui(caps, lang), PROJECT_ROWS, false, caps.columns, HOME) },
  {
    name: "projects-rename",
    render: (caps, lang) => renameLines(ui(caps, lang), [
      { kind: "project-title", target: "p1", projectId: "p1", previous: "src", next: "demo/src", reason: "" },
      { kind: "project-title", target: "p2", projectId: "p2", previous: "C:/work/app-with-a-long-folder-name", next: "app-with-a-long-folder-name", reason: "" },
    ]),
  },
  {
    name: "accounts",
    render: (caps, lang) => renderAccounts(ui(caps, lang), [inst("claudeAgent", `${HOME}/.claude`, "personal@example.com"), inst("claude-work", `${HOME}/.claude-work`, null, "unauthenticated")],
      CONFIG, HOME, [{ home: `${HOME}/.claude`, sources: ["default"], alias: null }, { home: `${HOME}/.claude-extra`, sources: ["folder"], alias: null }]),
  },
  {
    name: "organize-undo",
    render: (caps, lang) => {
      const threads = [{ id: "t1", title: "Fix the login form", projectId: "p1" }, { id: "t2", title: "Plan the API", projectId: "p1" }] as never;
      const projects = [{ id: "p1", title: "demo" }] as never;
      const changes = new Map([
        ["archive\u0000t1", { t: "organize-change", runId: "r", kind: "archive", target: "t1", previous: false, next: true }],
        ["title\u0000t2", { t: "organize-change", runId: "r", kind: "title", target: "t2", previous: "<command-name>/clear</command-name>", next: "Plan the API" }],
        ["pin\u0000p1", { t: "organize-change", runId: "r", kind: "pin", target: "p1", previous: false, next: true }],
      ]) as never;
      return renderUndo(ui(caps, lang), {
        runId: null, reverted: 2, skippedUserChanged: 1, alreadyRestored: 0, kept: 0, failed: [],
        items: [{ kind: "archive", target: "t1", status: "reverted" }, { kind: "title", target: "t2", status: "reverted" }, { kind: "pin", target: "p1", status: "user-changed" }],
      }, "20261115-090000-a1b2", true, changes, namesOf(threads, projects, HOME, lang));
    },
  },
  { name: "elevated-warning", render: (caps, lang) => noteLines(ui(caps, lang).s, "warn", cliT(lang, "elevated.start"), caps.columns) },
];
