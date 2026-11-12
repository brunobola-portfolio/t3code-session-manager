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

function fakeIo(state: string, over: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: false, prompt: async () => "", env: { T3SM_HOME: state }, ...over };
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
  for (const c of ["quarantine", "dedupe", "rollback", "runs"]) assert.match(u.out(), new RegExp(`\\n  ${c}`));
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
