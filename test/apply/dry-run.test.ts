// `apply --dry-run`: every read-only step of apply, then a report of what it would do; nothing is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPlan, type ApplyDeps } from "../../src/apply/apply.ts";
import { applyCommand } from "../../src/cli/commands/apply.ts";
import { main, type Io } from "../../src/cli/main.ts";
import type { Plan, PlanItem } from "../../src/core/types.ts";
import { CWD_SCAN_MAX_BYTES } from "../../src/sources/types.ts";
import { DAY, fakeT3, inst, tempHome, transcript, type FakeT3 } from "./fake-t3.ts";

const ROOT = "C:/work/demo";
const ROOT2 = "C:/work/other";
const VERSION = "0.1.9-nightly.20261110.4465";
const ORG = { id: "claude-org", driver: "claudeAgent" as const, displayName: "Org", accentColor: null, homePath: "C:/Users/demo/.claude-org", environment: [] };

function mkPlan(items: PlanItem[], over: Partial<Plan> = {}): Plan {
  const roots = [...new Set(items.flatMap((i) => (i.action.kind === "skip" ? [] : [i.action.projectRoot])))];
  return {
    version: 1, runId: "20261111-120000-abcd", createdAt: new Date().toISOString(), t3Version: VERSION,
    instancesToCreate: [], projectsToCreate: roots.map((r) => ({ root: r, title: r.split("/").at(-1)!, defaultInstanceId: "claudeAgent" })),
    projectAccounts: [], projectDefaults: roots.map((r) => ({ root: r, instanceId: "claudeAgent" })), mirrorCopies: [], items, warnings: [],
    ...over,
  };
}

const noSignals = { on: () => {}, off: () => {} };

/** Every file under `dir` with its size and mtime: a dry run must leave this identical. */
function snapshot(dir: string): string {
  if (!existsSync(dir)) return "(absent)";
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = statSync(p); out.push(`${p} ${s.size} ${s.mtimeMs}`); }
    }
  };
  walk(dir);
  return out.sort().join("\n");
}

/** A plan with: two importable sessions in ROOT (one existing project whose default differs), one in ROOT2 on an
 *  instance still to create, one that fails up front (cwd beyond T3's 1 MiB window); plus a pending journal bump. */
function scenario() {
  const f = fakeT3({ instances: [inst("claudeAgent", null)] });
  const t = tempHome();
  const now = Date.now();
  const a = transcript(f, t.dir, ROOT, now - 60 * DAY);
  const b = transcript(f, t.dir, ROOT, now - 3 * DAY);
  const c = transcript(f, t.dir, ROOT2, now - 40 * DAY, { instanceId: "claude-org" });
  const big = transcript(f, t.dir, ROOT, now - 50 * DAY, { cost: CWD_SCAN_MAX_BYTES + 1 });
  f.projects.push({ id: "p-existing", title: "demo", workspaceRoot: ROOT, defaultModelSelection: { instanceId: "claude-org", model: "m" } as never, archived: false, deleted: false });
  const plan = mkPlan([a, b, c, big], { instancesToCreate: [ORG], projectsToCreate: [{ root: ROOT2, title: "other", defaultInstanceId: "claude-org" }],
    projectDefaults: [{ root: ROOT, instanceId: "claudeAgent" }, { root: ROOT2, instanceId: "claude-org" }] });
  // An interrupted run left a bump behind: a dry run reports it and does not restore it.
  mkdirSync(t.state, { recursive: true });
  const bumped = a.session.file.path;
  writeFileSync(join(t.state, "journal.jsonl"), JSON.stringify({ t: "mtime-bump", runId: "r0", files: [{ path: bumped, atimeMs: 1, mtimeMs: 1, targetMtimeMs: 2 }] }) + "\n");
  return { f, t, plan, items: [a, b, c, big] };
}

test("applyPlan dryRun: read-only checks run, the report says what would happen, and nothing at all is written", async () => {
  const { f, t, plan } = scenario();
  const before = snapshot(t.home);
  const seen: boolean[] = [];
  const deps: ApplyDeps = {
    stateDir: t.state, home: t.home, signals: noSignals, dryRun: true, batch: { filesPerProject: 50, projectsPerWave: 5 },
    connect: async (_h, o) => { seen.push(o.manageProviders); return f.api; },
  };
  const r = await applyPlan(plan, deps);
  assert.equal(r.status, "dry-run");
  assert.equal(r.runId, null);
  const d = r.dryRun!;
  assert.deepEqual(d.pendingRecovery, [plan.items[0]!.session.file.path]);
  assert.deepEqual(d.instancesToCreate, ["claude-org"]);
  assert.deepEqual(d.projectsToCreate, [ROOT2]);
  assert.deepEqual(d.defaultsToSet, [{ root: ROOT, instanceId: "claudeAgent" }, { root: ROOT2, instanceId: "claude-org" }]);
  assert.equal(d.conversions, 0);
  assert.equal(d.waves, 1);
  assert.equal(d.waveSessions, 3);
  assert.deepEqual(d.held, { roots: [], sessions: 0 });
  assert.deepEqual(d.failUpFront.map((x) => x.reason), ["cwd-unreadable-in-t3"]);
  assert.deepEqual(seen, [false], "read-only connection (no providers:manage)");
  assert.deepEqual(f.calls, ["close"], "no T3 write call");
  assert.equal(snapshot(t.home), before, "no file written, moved or re-timed (journal, lock, run dir, caches, transcripts)");
});

test("applyPlan dryRun: a held project (a session in use) is reported, not imported", async () => {
  const f = fakeT3();
  const t = tempHome();
  f.opts.instances = [inst("claudeAgent", join(t.home, ".claude"))]; // its home is listed for transcripts not in the plan
  const a = transcript(f, t.dir, ROOT, Date.now() - 60 * DAY);
  transcript(null, t.dir, ROOT, Date.now()); // in use right now
  const before = snapshot(t.home);
  const r = await applyPlan(mkPlan([a]), { stateDir: t.state, home: t.home, signals: noSignals, dryRun: true, connect: async () => f.api });
  assert.deepEqual(r.dryRun!.held, { roots: [ROOT], sessions: 1 });
  assert.equal(r.dryRun!.waves, 0);
  assert.equal(snapshot(t.home), before);
});

function cli(state: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: false, prompt: async () => { throw new Error("no prompt in a dry run"); }, env: { T3SM_HOME: state } };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

test("t3sm apply --dry-run: no --yes needed off a terminal; prints the summary and the Would-do list; writes nothing; exit 0", async () => {
  const { f, t, plan } = scenario();
  mkdirSync(join(t.state, "runs", plan.runId), { recursive: true });
  writeFileSync(join(t.state, "runs", plan.runId, "plan.json"), JSON.stringify(plan));
  const before = snapshot(t.home);
  const c = cli(t.state);
  assert.equal(await applyCommand(["--dry-run"], c.io, { home: t.home, connect: async () => f.api, signals: noSignals }), 0, c.err());
  const o = c.out();
  assert.match(o, /^Plan 20261111-120000-abcd/m, "same summary as the confirmation");
  assert.match(o, /Would do:/);
  assert.match(o, /instances to create\s+1 \(claude-org\)/);
  assert.match(o, /projects to create\s+1/);
  assert.match(o, /project defaults to set\s+2/);
  assert.match(o, /conversions to write\s+0/);
  assert.match(o, /import waves\s+1 \(3 sessions\)/);
  assert.match(o, /would fail up front\s+1/);
  assert.match(o, /1 transcript file time left bumped by an interrupted run/);
  assert.match(o, /Dry run: nothing was written\./);
  assert.deepEqual(f.calls, ["close"]);
  assert.equal(snapshot(t.home), before);
});

test("t3sm apply --dry-run: a stale plan is still refused (exit 2); help lists --dry-run", async () => {
  const { f, t, plan } = scenario();
  plan.t3Version = "0.0.1";
  mkdirSync(join(t.state, "runs", plan.runId), { recursive: true });
  writeFileSync(join(t.state, "runs", plan.runId, "plan.json"), JSON.stringify(plan));
  const before = snapshot(t.home);
  const c = cli(t.state);
  const { commands } = await import("../../src/cli/main.ts");
  const orig = commands["apply"]!;
  commands["apply"] = (a, io) => applyCommand(a, io, { home: t.home, connect: async () => f.api, signals: noSignals });
  try {
    assert.equal(await main(["apply", "--dry-run"], c.io), 2);
    assert.match(c.err(), /Plan is stale/);
  } finally { commands["apply"] = orig; }
  assert.equal(snapshot(t.home), before);
  const h = cli(t.state);
  await main(["apply", "--help"], h.io);
  assert.match(h.out(), /--dry-run/);
  const g = cli(t.state);
  await main(["--help"], g.io);
  assert.match(g.out(), /apply .*--dry-run/);
});
