import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Io } from "../../src/cli/main.ts";
import { journalCommand } from "../../src/cli/commands/journal.ts";
import { rollbackCommand, runsCommand } from "../../src/cli/commands/rollback.ts";
import { acquireLock } from "../../src/core/lock.ts";
import type { JournalEntry } from "../../src/core/types.ts";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const OLD = "2026-05-01T10:00:00.000Z";
const RECENT = "2026-11-16T10:00:00.000Z";

function fakeIo(state: string, over: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: false, prompt: async () => "", env: { T3SM_HOME: state, LANG: "en_US.UTF-8" }, ...over };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

/** A state folder whose journal has two old finished runs with file times (A, B), one pending (P) and a recent one. */
function setup(): { root: string; state: string; file: string; text: string; pendingFile: string; deps: { home: string; now: () => number } } {
  const root = mkdtempSync(join(tmpdir(), "t3sm-journal-cli-"));
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const pendingFile = join(root, "home", "p.jsonl");
  mkdirSync(join(root, "home"), { recursive: true });
  writeFileSync(pendingFile, "x");
  const f = (n: string): string => join(root, "home", n);
  const bump = (runId: string, path: string, target = 1_900_000_000_000): JournalEntry => ({ t: "mtime-bump", runId, files: [{ path, atimeMs: 1_700_000_000_000, mtimeMs: 1_700_000_000_000, targetMtimeMs: target }] });
  const es: JournalEntry[] = [
    { t: "run-start", runId: "A", at: OLD, command: "apply 1" }, bump("A", f("a.jsonl")), { t: "mtime-restore", runId: "A", paths: [f("a.jsonl")] }, { t: "run-end", runId: "A", at: OLD, status: "ok" },
    { t: "run-start", runId: "B", at: OLD, command: "sync B" }, bump("B", f("b.jsonl")), { t: "mtime-restore", runId: "B", paths: [f("b.jsonl")] }, { t: "run-end", runId: "B", at: OLD, status: "ok" },
    { t: "run-start", runId: "P", at: OLD, command: "sync P" }, bump("P", pendingFile), { t: "run-end", runId: "P", at: OLD, status: "partial" },
    { t: "run-start", runId: "R", at: RECENT, command: "sync R" }, { t: "run-end", runId: "R", at: RECENT, status: "ok" },
  ];
  const file = join(state, "journal.jsonl");
  const text = es.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, text);
  return { root, state, file, text, pendingFile, deps: { home: join(root, "home"), now: () => NOW } };
}

const backups = (state: string): string[] => readdirSync(state).filter((n) => n.endsWith(".bak.jsonl"));

test("journal compact on a non-terminal without --yes shows what it would fold and exits 2, writing nothing", async () => {
  const s = setup();
  const f = fakeIo(s.state);
  assert.equal(await journalCommand(["compact"], f.io, s.deps), 2);
  assert.match(f.out(), /2 finished runs older than 90 days can be folded: 4 file-time entries/);
  assert.match(f.out(), /Left as they are: 1 run/);
  assert.match(f.err(), /--yes/);
  assert.equal(readFileSync(s.file, "utf8"), s.text);
  assert.deepEqual(backups(s.state), []);
});

test("journal compact --dry-run shows the sizes and exits 0, writing nothing", async () => {
  const s = setup();
  const f = fakeIo(s.state);
  assert.equal(await journalCommand(["compact", "--dry-run"], f.io, s.deps), 0);
  assert.match(f.out(), /journal\.jsonl: \d+ KB now, \d+ KB after/);
  assert.match(f.out(), /Dry run: nothing was changed/);
  assert.equal(readFileSync(s.file, "utf8"), s.text);
  assert.deepEqual(backups(s.state), []);
});

test("journal compact --yes: recovery first, then the fold, a backup, a run in `t3sm runs` that rollback refuses", async () => {
  const s = setup();
  utimesSync(s.pendingFile, 1_900_000_000, 1_900_000_000); // P's bump is still on the file: recovery puts it back
  const f = fakeIo(s.state);
  assert.equal(await journalCommand(["compact", "--yes"], f.io, s.deps), 0, f.err());
  assert.match(f.err(), /Restored the file times of 1 transcript/);
  assert.equal(statSync(s.pendingFile).mtimeMs, 1_700_000_000_000);
  assert.match(f.out(), /Folded 3 runs \(6 entries\)/); // A, B and P (recovery resolved P)
  assert.match(f.out().replace(/\n\s*/g, ""), /Backup:.*journal\.\S+\.bak\.jsonl/);
  assert.equal(backups(s.state).length, 1);
  assert.ok(readFileSync(join(s.state, backups(s.state)[0]!), "utf8").startsWith(s.text));
  const text = readFileSync(s.file, "utf8");
  assert.doesNotMatch(text, /mtime-bump/);
  assert.match(text, /"journal-compacted"/);

  const r = fakeIo(s.state);
  assert.equal(await runsCommand(["--json"], r.io), 0);
  const runs = JSON.parse(r.out()) as { runId: string; command: string | null; status: string }[];
  assert.deepEqual(runs.map((x) => x.runId).slice(0, 4), ["A", "B", "P", "R"]);
  const c = runs.at(-1)!;
  assert.equal(c.command, "journal compact");
  assert.equal(c.status, "ok");

  const b = fakeIo(s.state);
  assert.notEqual(await rollbackCommand(["--yes", "--run", c.runId], b.io, { home: s.deps.home }), 0);
  assert.match(b.err(), /journal compaction/);
  assert.equal(readFileSync(s.file, "utf8"), text);
});

test("journal compact: a bad --older-than, a missing or unknown subcommand, --dry-run with --yes: exit 2", async () => {
  const s = setup();
  for (const args of [["compact", "--older-than", "abc"], ["compact", "--older-than", "0"], ["compact", "--older-than", "4000"], [], ["shrink"], ["compact", "--dry-run", "--yes"], ["compact", "--nope"]]) {
    const f = fakeIo(s.state);
    assert.equal(await journalCommand(args, f.io, s.deps), 2, args.join(" "));
  }
  assert.equal(readFileSync(s.file, "utf8"), s.text);
});

test("journal compact --older-than: a longer threshold folds nothing", async () => {
  const s = setup();
  const f = fakeIo(s.state);
  assert.equal(await journalCommand(["compact", "--yes", "--older-than", "365"], f.io, s.deps), 0);
  assert.match(f.out(), /Nothing to fold: no finished run older than 365 days/);
  // Recovery ran under the lock (P's file changed since: marked done, never moved back); nothing was folded.
  assert.ok(readFileSync(s.file, "utf8").startsWith(s.text));
  assert.deepEqual(backups(s.state), []);
});

test("journal compact writes nothing while another run holds the lock", async () => {
  const s = setup();
  const lock = await acquireLock(s.state);
  assert.ok(lock);
  try {
    const f = fakeIo(s.state);
    assert.equal(await journalCommand(["compact", "--yes"], f.io, s.deps), 0);
    assert.match(f.out(), /Another t3sm run is in progress/);
    assert.equal(readFileSync(s.file, "utf8"), s.text);
  } finally { await lock!.release(); }
});

test("journal compact on a terminal asks; declining changes nothing", async () => {
  const s = setup();
  const f = fakeIo(s.state, { isTTY: true, prompt: async () => "n" });
  assert.equal(await journalCommand(["compact"], f.io, s.deps), 0);
  assert.match(f.out(), /Nothing changed/);
  assert.deepEqual(backups(s.state), []);
  // Recovery ran under the lock (it may append a restore); the compaction did not.
  assert.ok(readFileSync(s.file, "utf8").startsWith(s.text));
  assert.ok(!readFileSync(s.file, "utf8").includes("journal compact"));
});

test("t3sm journal compact through main, in Portuguese", async () => {
  const s = setup();
  const f = fakeIo(s.state, { env: { T3SM_HOME: s.state, LANG: "pt_PT.UTF-8" } });
  assert.equal(await main(["journal", "compact", "--dry-run"], f.io), 0);
  assert.match(f.out(), /Ensaio: nada foi alterado/);
  assert.ok(existsSync(s.file));
});
