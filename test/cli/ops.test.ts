import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, type Io } from "../../src/cli/main.ts";
import { quarantineCommand, dedupeCommand } from "../../src/cli/commands/quarantine.ts";
import { rollbackCommand, runsCommand } from "../../src/cli/commands/rollback.ts";
import { acquireLock } from "../../src/core/lock.ts";
import { QUARANTINE_DIR } from "../../src/ops/quarantine.ts";
import { T3NotRunning } from "../../src/t3/errors.ts";
import type { T3Api } from "../../src/t3/api.ts";
import { lines, put, tempRoot } from "../ops/helpers.ts";
import { fakeT3 } from "../apply/fake-t3.ts";
import { applyOrganize } from "../../src/organize/apply.ts";
import type { OrganizeAction, OrganizeKind } from "../../src/organize/types.ts";
import { compatGate } from "../../src/t3/compat.ts";

function fakeIo(state: string, over: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: false, prompt: async () => "", env: { T3SM_HOME: state, LANG: "en_US.UTF-8" }, ...over };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

const down = async (): Promise<never> => { throw new T3NotRunning(); };

/** The newest run id in the journal (`t3sm runs --json`). */
async function lastRun(state: string): Promise<string> {
  const r = fakeIo(state);
  await runsCommand(["--json"], r.io);
  return (JSON.parse(r.out()) as { runId: string }[]).at(-1)!.runId;
}

function setup() {
  const t = tempRoot();
  const bak = join(t.projects, "D--X.bak-20260630-111703");
  put(join(bak, "a.jsonl"), lines(2));
  return { ...t, bak, deps: { home: t.root, connect: down } };
}

test("quarantine in a non-TTY without --yes lists the folders and exits 2, moving nothing", async () => {
  const s = setup();
  const f = fakeIo(s.state);
  assert.equal(await quarantineCommand([], f.io, s.deps), 2);
  assert.match(f.out(), /D--X\.bak-20260630-111703/);
  assert.match(f.err(), /--yes/);
  assert.ok(existsSync(s.bak));
  assert.equal(existsSync(join(s.state, "journal.jsonl")), false);
});

test("quarantine --dry-run lists and exits 0 without writing", async () => {
  const s = setup();
  const f = fakeIo(s.state);
  assert.equal(await quarantineCommand(["--dry-run"], f.io, s.deps), 0);
  assert.match(f.out(), /1 backup folder/);
  assert.ok(existsSync(s.bak));
  assert.equal(existsSync(join(s.state, "journal.jsonl")), false);
});

test("quarantine --yes moves, runs lists the run, rollback --yes puts it back", async () => {
  const s = setup();
  const f = fakeIo(s.state);
  assert.equal(await quarantineCommand(["--yes"], f.io, s.deps), 0);
  assert.equal(existsSync(s.bak), false);
  assert.ok(existsSync(join(s.home, QUARANTINE_DIR, "backups", "D--X.bak-20260630-111703", "a.jsonl")));

  const r = fakeIo(s.state);
  assert.equal(await runsCommand([], r.io), 0);
  assert.match(r.out(), /quarantine/);
  assert.match(r.out(), /quarantined 1/);

  const b = fakeIo(s.state);
  assert.equal(await rollbackCommand(["--yes", "--run", await lastRun(s.state)], b.io, s.deps), 0, b.err());
  assert.ok(existsSync(join(s.bak, "a.jsonl")));

  const again = fakeIo(s.state);
  assert.equal(await quarantineCommand(["--dry-run"], again.io, s.deps), 0);
  const r2 = fakeIo(s.state);
  assert.equal(await runsCommand([], r2.io), 0);
  assert.match(r2.out(), /rolled back/);
});

test("quarantine interactive: declining changes nothing", async () => {
  const s = setup();
  const f = fakeIo(s.state, { isTTY: true, prompt: async () => "no" });
  assert.equal(await quarantineCommand([], f.io, s.deps), 0);
  assert.ok(existsSync(s.bak));
  assert.match(f.out(), /Nothing changed/);
});

test("quarantine with nothing to move exits 0", async () => {
  const t = tempRoot();
  const f = fakeIo(t.state);
  assert.equal(await quarantineCommand(["--yes"], f.io, { home: t.root, connect: down }), 0);
  assert.match(f.out(), /No backup folders/);
});

test("quarantine exits 0 without touching anything while another run holds the lock", async () => {
  const s = setup();
  mkdirSync(s.state, { recursive: true });
  const lock = await acquireLock(s.state);
  try {
    const f = fakeIo(s.state);
    assert.equal(await quarantineCommand(["--yes"], f.io, s.deps), 0);
    assert.match(f.out(), /Another t3sm run/);
    assert.ok(existsSync(s.bak));
  } finally { await lock!.release(); }
});

test("dedupe refuses a plan older than 24 h (exit 2)", async () => {
  const t = tempRoot();
  const planDir = join(t.state, "runs", "20261101-000000-aaaa");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "plan.json"), JSON.stringify({
    version: 1, runId: "20261101-000000-aaaa", createdAt: "2026-11-01T00:00:00.000Z", t3Version: "x",
    instancesToCreate: [], projectsToCreate: [], projectAccounts: [], projectDefaults: [], mirrorCopies: [], items: [], warnings: [],
  }));
  const f = fakeIo(t.state);
  assert.equal(await dedupeCommand(["--yes"], f.io, { home: t.root, connect: down }), 2);
  assert.match(f.err(), /stale|older than 24 h/);
});

test("dedupe --dry-run lists the plan's mirror copies", async () => {
  const t = tempRoot();
  const org = join(t.root, ".claude-org");
  mkdirSync(join(org, "projects"), { recursive: true });
  const k = put(join(org, "projects", "C--w", "s.jsonl"), lines(3));
  const m = put(join(t.projects, "C--w", "s.jsonl"), lines(3));
  const planDir = join(t.state, "runs", "20261111-000000-aaaa");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "plan.json"), JSON.stringify({
    version: 1, runId: "20261111-000000-aaaa", createdAt: new Date().toISOString(), t3Version: "x",
    instancesToCreate: [], projectsToCreate: [], projectAccounts: [], projectDefaults: [], items: [], warnings: [],
    mirrorCopies: [{ path: m, nativeId: "s", keptPath: k, relation: "identical" }],
  }));
  const f = fakeIo(t.state);
  assert.equal(await dedupeCommand(["--dry-run"], f.io, { home: t.root, connect: down }), 0, f.err());
  assert.match(f.out(), /1 mirror cop/);
  assert.ok(existsSync(m));
  const y = fakeIo(t.state);
  assert.equal(await dedupeCommand(["--yes"], y.io, { home: t.root, connect: down }), 0, y.err());
  assert.equal(existsSync(m), false);
});

test("rollback --run with an unknown id exits 2", async () => {
  const t = tempRoot();
  const f = fakeIo(t.state);
  assert.equal(await rollbackCommand(["--run", "nope", "--yes"], f.io, { home: t.root, connect: down }), 2);
  assert.match(f.err(), /nope/);
});

test("rollback with an empty journal: nothing to roll back, exit 0", async () => {
  const t = tempRoot();
  const f = fakeIo(t.state);
  assert.equal(await rollbackCommand(["--yes"], f.io, { home: t.root, connect: down }), 0);
  assert.match(f.out(), /Nothing to roll back/);
});

test("rollback in a non-TTY without --yes lists and exits 2", async () => {
  const s = setup();
  const f0 = fakeIo(s.state);
  assert.equal(await quarantineCommand(["--yes"], f0.io, s.deps), 0);
  const f = fakeIo(s.state);
  assert.equal(await rollbackCommand([], f.io, s.deps), 2);
  assert.match(f.out(), /D--X\.bak-20260630-111703/);
  assert.equal(existsSync(s.bak), false);
});

test("per-command help and unknown options", async () => {
  for (const c of ["quarantine", "dedupe", "rollback", "runs"]) {
    const f = fakeIo("unused");
    assert.equal(await main([c, "--help"], f.io), 0);
    assert.match(f.out(), new RegExp(`Usage: t3sm ${c}`));
    const g = fakeIo("unused");
    assert.equal(await main([c, "--bogus"], g.io), 2);
  }
  const u = fakeIo("unused");
  await main(["--help"], u.io);
  for (const c of ["quarantine", "dedupe", "rollback", "runs"]) assert.match(u.out(), new RegExp(`\\n  t3sm ${c} `));
});

test("rollback --run <a rollback run> is refused with exit 2", async () => {
  const s = setup();
  assert.equal(await quarantineCommand(["--yes"], fakeIo(s.state).io, s.deps), 0);
  assert.equal(await rollbackCommand(["--yes", "--run", await lastRun(s.state)], fakeIo(s.state).io, s.deps), 0);
  const runs = fakeIo(s.state);
  await runsCommand(["--json"], runs.io);
  const rb = (JSON.parse(runs.out()) as { runId: string; command: string | null }[]).find((r) => r.command?.startsWith("rollback"))!;
  const f = fakeIo(s.state);
  assert.equal(await rollbackCommand(["--run", rb.runId, "--yes"], f.io, s.deps), 2);
  assert.match(f.err(), /Cannot roll back a rollback run\./);
});

test("rollback --dry-run --instances never asks T3 Code for providers:manage", async () => {
  const s = setup();
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, "journal.jsonl"), [
    { t: "run-start", runId: "acc1", at: "2026-11-11T10:00:00.000Z", command: "accounts --rename" },
    { t: "instance-updated", runId: "acc1", instanceId: "claude-org", previous: { displayName: "Old", accentColor: null, homePath: null }, next: { displayName: "New", accentColor: null, homePath: null } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const seen: boolean[] = [];
  const connect = async (_h: string, o: { manageProviders: boolean }) => {
    seen.push(o.manageProviders);
    return { providerInstances: async () => [], close: async () => {} } as unknown as T3Api;
  };
  const f = fakeIo(s.state);
  assert.equal(await rollbackCommand(["--dry-run", "--instances"], f.io, { home: s.root, connect }), 0, f.err());
  assert.deepEqual(seen, [false]);
});

test("rollback --yes without --run is refused (exit 2, nothing changed): it could target an unattended sync run", async () => {
  const s = setup();
  assert.equal(await quarantineCommand(["--yes"], fakeIo(s.state).io, s.deps), 0);
  const f = fakeIo(s.state);
  assert.equal(await rollbackCommand(["--yes"], f.io, s.deps), 2);
  assert.match(f.err(), /--run <id>/);
  assert.equal(existsSync(s.bak), false, "still in quarantine");
});

test("rollback without --run on a terminal names the run in the question", async () => {
  const s = setup();
  assert.equal(await quarantineCommand(["--yes"], fakeIo(s.state).io, s.deps), 0);
  const id = await lastRun(s.state);
  const asked: string[] = [];
  const f = fakeIo(s.state, { isTTY: true, prompt: async (q: string) => { asked.push(q); return "no"; } });
  assert.equal(await rollbackCommand([], f.io, s.deps), 0);
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, new RegExp(`Roll back run ${id} \\(quarantine\\)\\?`));
  assert.equal(existsSync(s.bak), false);
});

// ---------- rollback of an organize run on any T3 Code version (ruling R18) ----------

/** An organize run journaled in `t.state` on a fake T3 Code 0.2.0, and a connect stub running the real compatGate as connectT3 does. */
async function organizeRunOn020() {
  const t = tempRoot();
  const f = fakeT3({ version: "0.2.0" });
  f.projects.push({ id: "p3", title: "demo", workspaceRoot: "C:/work/demo", defaultModelSelection: null, archived: false, deleted: false, pinned: false, createdAt: null });
  f.threads.set("import:claudeAgent:a1", { id: "import:claudeAgent:a1", projectId: "p3", instanceId: "claudeAgent", archived: false, title: "t", updatedAt: 0 });
  const counts = Object.fromEntries(["archive", "title", "unsettle", "pin", "unpin", "project-delete", "project-title", "auto-settle"].map((k) => [k, 0])) as Record<OrganizeKind, number>;
  const actions: OrganizeAction[] = [
    { kind: "archive", target: "import:claudeAgent:a1", projectId: "p3", previous: false, next: true, reason: "test" },
    { kind: "pin", target: "p3", projectId: "p3", previous: false, next: true, reason: "test" },
  ];
  await applyOrganize({ runId: "org1", actions, counts, byProject: [] }, { api: f.api, journal: t.journal, runId: "org1", allowUntested: true });
  const connect = async (_home: string, o: { allowUntested: boolean; onNotice: (l: string) => void }): Promise<T3Api> => {
    compatGate(f.api.version, { allowUntested: o.allowUntested, onNotice: o.onNotice });
    return f.api;
  };
  return { t, f, connect };
}

const warnings = (err: string): string[] => err.split("\n").filter((l) => l.trim() !== "");

test("rollback of an organize run on T3 Code 0.2.0 proceeds with exactly one warning (--yes)", async () => {
  const { t, f, connect } = await organizeRunOn020();
  const b = fakeIo(t.state);
  assert.equal(await rollbackCommand(["--yes", "--run", "org1"], b.io, { home: t.root, connect }), 0, b.err());
  assert.deepEqual(warnings(b.err()), [
    "Warning: T3 Code 0.2.0 has not been tested with t3sm (tested: 0.1.8-nightly.20261105.4218, 0.1.9-nightly.20261110.4465, 0.1.10-nightly.20261113.4630). Proceeding; every change is journaled and can be undone with t3sm rollback.",
  ]);
  assert.equal(f.threads.get("import:claudeAgent:a1")!.archived, false);
  assert.equal(f.projects[0]!.pinned, false);
  assert.match(b.out(), /Reverted organize changes \(2\)/);
});

test("runs lists an organize run with its change counts, and the undo with what it reverted", async () => {
  const { t, connect } = await organizeRunOn020();
  const r = fakeIo(t.state);
  assert.equal(await runsCommand([], r.io), 0);
  assert.match(r.out(), /org1 .*organize .*organized 2/);
  assert.equal(await rollbackCommand(["--yes", "--run", "org1"], fakeIo(t.state).io, { home: t.root, connect }), 0);
  const r2 = fakeIo(t.state);
  assert.equal(await runsCommand(["--json"], r2.io), 0);
  const runs = JSON.parse(r2.out()) as { runId: string; command: string; counts: { organized: number; organizeReverted: number } }[];
  assert.equal(runs.find((x) => x.runId === "org1")!.counts.organized, 2);
  assert.equal(runs.find((x) => x.command === "rollback org1")!.counts.organizeReverted, 2);
  const r3 = fakeIo(t.state);
  await runsCommand([], r3.io);
  // 80 columns cannot show every value whole: one block per run, nothing cut (the rollback named in full).
  assert.match(r3.out(), /rollback org1\n(?: {2}.*\n)*? {2}Changes +reverted 2\n/);
  assert.match(r3.out(), /Status +ok, rolled back by \d{8}-\d{6}-[0-9a-f]{4}\n/);
});

test("rollback of an organize run on T3 Code 0.2.0, interactive (preview, then the run): the warning is printed once", async () => {
  const { t, f, connect } = await organizeRunOn020();
  const b = fakeIo(t.state, { isTTY: true, prompt: async () => "yes" });
  assert.equal(await rollbackCommand(["--run", "org1"], b.io, { home: t.root, connect }), 0, b.err());
  assert.equal(warnings(b.err()).length, 1, b.err());
  assert.match(b.out(), /Revert organize changes \(2\)/);
  assert.equal(f.projects[0]!.pinned, false);
});

test("rollback lists organize changes in organize's words (titles, never ids or raw JSON); a user-changed title is shown cleaned", async () => {
  const { t, f, connect } = await organizeRunOn020();
  const counts = Object.fromEntries(["archive", "title", "unsettle", "pin", "unpin", "project-delete", "project-title", "auto-settle"].map((k) => [k, 0])) as Record<OrganizeKind, number>;
  await applyOrganize({ runId: "org2", actions: [{ kind: "title", target: "import:claudeAgent:a1", projectId: "p3", previous: "t", next: "Fix the login form", reason: "test" }], counts, byProject: [] },
    { api: f.api, journal: t.journal, runId: "org2", allowUntested: true });
  // The user renamed the conversation in T3 Code since (with a terminal escape in it).
  f.threads.get("import:claudeAgent:a1")!.title = "Mine \u001b[31mred\u001b[0m";
  const a = fakeIo(t.state);
  assert.equal(await rollbackCommand(["--dry-run", "--run", "org2"], a.io, { home: t.root, connect }), 0, a.err());
  assert.match(a.out(), /Organize changes left alone \(changed in T3 Code since t3sm made them\) \(1\)\n {2}[-•] 'Mine \[31mred\[0m' \(demo\): changed in T3 Code since t3sm's change\n/);
  const b = fakeIo(t.state);
  assert.equal(await rollbackCommand(["--dry-run", "--run", "org1"], b.io, { home: t.root, connect }), 0, b.err());
  assert.match(b.out(), /Revert organize changes \(2\)\n {2}[-•] Unpin project 'demo'\n {2}[-•] Unarchive 'Mine \[31mred\[0m' \(demo\)\n/);
  for (const out of [a.out(), b.out()]) assert.doesNotMatch(out, /import:claudeAgent|pin p3|"|\u001b/);
});

test("rollback asks T3 Code for settings:write only to put T3 Code's own option back (a real run of an organize run that changed it)", async () => {
  const { t, f } = await organizeRunOn020();
  const counts = Object.fromEntries(["archive", "title", "unsettle", "pin", "unpin", "project-delete", "project-title", "auto-settle"].map((k) => [k, 0])) as Record<OrganizeKind, number>;
  await applyOrganize({ runId: "org3", actions: [{ kind: "auto-settle", target: "sidebarAutoSettleAfterDays", projectId: null, previous: 7, next: 30, reason: "test" }], counts, byProject: [] },
    { api: f.api, journal: t.journal, runId: "org3", allowUntested: true });
  assert.equal(f.autoSettleDays, 30);
  const seen: string[] = [];
  const connect = async (_h: string, o: { manageProviders: boolean; writeSettings?: boolean }): Promise<T3Api> => { seen.push(`${o.manageProviders}/${o.writeSettings === true}`); return f.api; };
  assert.equal(await rollbackCommand(["--dry-run", "--run", "org3"], fakeIo(t.state).io, { home: t.root, connect }), 0);
  assert.deepEqual(seen.splice(0), ["false/false"], "a preview never writes");
  assert.equal(await rollbackCommand(["--yes", "--run", "org1"], fakeIo(t.state).io, { home: t.root, connect }), 0);
  assert.deepEqual(seen.splice(0), ["false/false"], "an organize run without a settings change");
  const b = fakeIo(t.state);
  assert.equal(await rollbackCommand(["--yes", "--run", "org3"], b.io, { home: t.root, connect }), 0, b.err());
  assert.deepEqual(seen.splice(0), ["false/true"]);
  assert.equal(f.autoSettleDays, 7);
});
