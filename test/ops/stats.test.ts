// t3sm stats: what the user has, counted from discovery and the journal. Pure; no T3 Code, nothing written.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { JournalEntry, Plan } from "../../src/core/types.ts";
import { computeStats } from "../../src/ops/stats.ts";
import { sess, uuid } from "../plan/helpers.ts";

const at = (iso: string): { mtimeMs: number } => ({ mtimeMs: Date.parse(iso) + 3_600_000 });

test("computeStats: sessions per agent, per Claude account (masked names) and per month (by start, UTC)", () => {
  const sessions = [
    sess({ ...at("2026-09-03T10:00:00Z") }),
    sess({ ...at("2026-09-20T10:00:00Z"), accountId: "claude-org" }),
    sess({ ...at("2026-10-01T10:00:00Z") }),
    sess({ harness: "codex", ...at("2026-10-05T10:00:00Z") }),
    sess({ harness: "pi", ...at("2026-11-02T10:00:00Z") }),
  ];
  const s = computeStats({ sessions, journal: [], latestPlan: null, names: { claudeAgent: "demo@example.com" }, unavailable: ["opencode"], readErrors: 1 });
  assert.equal(s.sessions, 5);
  assert.deepEqual(s.agents, [{ agent: "claude", sessions: 3 }, { agent: "codex", sessions: 1 }, { agent: "pi", sessions: 1 }]);
  assert.deepEqual(s.accounts, [
    { accountId: "claudeAgent", name: "d***@example.com", sessions: 2 },
    { accountId: "claude-org", name: null, sessions: 1 },
  ]);
  assert.deepEqual(s.months, [{ month: "2026-09", sessions: 2 }, { month: "2026-10", sessions: 2 }, { month: "2026-11", sessions: 1 }]);
  assert.equal(s.undated, 0);
  assert.deepEqual(s.notInstalled, ["opencode"]);
  assert.equal(s.readErrors, 1);
});

test("computeStats: imported and converted from the journal, a rolled-back run counts for nothing, a failure later imported is not failed", () => {
  const imp = (runId: string, n: number, harness: "claude" | "codex" = "claude"): JournalEntry =>
    ({ t: "imported", runId, harness, nativeId: uuid(n), threadId: `t${n}`, source: { path: "C:/x", size: 1, mtimeMs: 1 } });
  const journal: JournalEntry[] = [
    { t: "run-start", runId: "r1", at: "2026-10-01T10:00:00.000Z", command: "apply" },
    imp("r1", 1), imp("r1", 2), imp("r1", 3, "codex"),
    { t: "file-written", runId: "r1", path: "C:/Users/demo/.claude/projects/C--work-demo/a.jsonl", sha256: "x", source: { harness: "pi", nativeId: "p1", updatedAt: "2026-01-01T00:00:00Z", messageCount: 2 } },
    { t: "import-failed", runId: "r1", harness: "claude", nativeId: uuid(4), reason: "boom" },
    { t: "import-failed", runId: "r1", harness: "claude", nativeId: uuid(5), reason: "boom" },
    { t: "run-start", runId: "r2", at: "2026-10-02T10:00:00.000Z", command: "apply" },
    imp("r2", 6),
    { t: "file-written", runId: "r2", path: "C:/Users/demo/.claude/projects/C--work-demo/b.jsonl", sha256: "y", source: { harness: "pi", nativeId: "p2", updatedAt: "2026-01-01T00:00:00Z", messageCount: 2 } },
    { t: "rolled-back", runId: "r3", targetRunId: "r2", at: "2026-10-03T10:00:00.000Z" },
    { t: "run-start", runId: "r4", at: "2026-10-04T10:00:00.000Z", command: "sync" },
    imp("r4", 4),
    imp("r4", 1), // imported again: counted once
  ];
  const s = computeStats({ sessions: [], journal, latestPlan: null, names: {}, unavailable: [], readErrors: 0 });
  assert.equal(s.imported.threads, 4);
  assert.deepEqual(s.imported.byAgent, [{ agent: "claude", threads: 3 }, { agent: "codex", threads: 1 }]);
  assert.equal(s.imported.converted, 1);
  assert.equal(s.imported.failed, 1, "uuid(5) only: uuid(4) was imported later");
  assert.equal(s.imported.runs, 2);
  assert.equal(s.imported.lastAt, "2026-10-04T10:00:00.000Z");
});

test("computeStats: the latest plan's actions and skip reasons; an undated session is counted apart", () => {
  const a = sess();
  const b = { ...sess(), startedAt: null, updatedAt: "not a date" };
  const plan = {
    version: 1, runId: "20261110-120000-abcd", createdAt: "2026-11-10T12:00:00.000Z", t3Version: "0.0.30",
    instancesToCreate: [], projectsToCreate: [], projectAccounts: [], projectDefaults: [], mirrorCopies: [], warnings: [],
    items: [
      { session: a, action: { kind: "import", projectRoot: "C:/work/demo", instanceId: "claudeAgent", expectedThreadId: "x" }, notes: [] },
      { session: b, action: { kind: "skip", reason: "active" }, notes: [] },
      { session: b, action: { kind: "skip", reason: "active" }, notes: [] },
      { session: b, action: { kind: "skip", reason: "no-cwd" }, notes: [] },
    ],
  } as Plan;
  const s = computeStats({ sessions: [a, b], journal: [], latestPlan: plan, names: {}, unavailable: [], readErrors: 0 });
  assert.equal(s.undated, 1);
  assert.deepEqual(s.latestPlan, {
    runId: plan.runId, createdAt: plan.createdAt, import: 1, convert: 0, skip: 3,
    skipped: [{ reason: "active", sessions: 2 }, { reason: "no-cwd", sessions: 1 }],
  });
});
