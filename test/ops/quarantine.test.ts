import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, link as linkCb, mkdirSync, readFileSync, rename as renameCb, statSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import {
  dedupe, findBackupDirs, findOrphanedQuarantine, JournalWriteError, moveEntry, MoveRefused, nodeMoveFs, quarantine, QUARANTINE_DIR, subdirOf,
} from "../../src/ops/quarantine.ts";
import type { AccountConfig, Plan } from "../../src/core/types.ts";
import { FailingJournal, OLD, entries, lines, put, tempRoot } from "./helpers.ts";

const rename = promisify(renameCb);
const acct = (id: string, home: string): AccountConfig => ({ id, home, displayName: id, accentColor: null });

test("findBackupDirs matches .bak- and <dir>.bak[-stamp] children of projects/, directories only", async () => {
  const t = tempRoot();
  for (const n of [".bak-20260624-152222", "D--X.bak-20260630-111703", "D--Y.bak", "D--Xbak", "D--X", "D--X.bak-2026", "D--X.bakery"]) mkdirSync(join(t.projects, n));
  writeFileSync(join(t.projects, "file.bak"), "not a dir");
  const got = (await findBackupDirs(t.home)).map((p) => p.split(/[\\/]/).at(-1));
  assert.deepEqual(got.sort(), [".bak-20260624-152222", "D--X.bak-20260630-111703", "D--Y.bak"].sort());
});

test("findBackupDirs: an account without projects/ has none", async () => {
  const t = tempRoot();
  assert.deepEqual(await findBackupDirs(join(t.root, "nope")), []);
});

test("quarantine moves backup dirs under session-manager-quarantine/backups, keeps file times, journals after the rename", async () => {
  const t = tempRoot();
  const bak = join(t.projects, "D--X.bak-20260630-111703");
  const f = put(join(bak, "a.jsonl"), lines(2));
  const before = statSync(f);
  const r = await quarantine([bak], t.home, t.journal, "run1");
  const to = join(t.home, QUARANTINE_DIR, "backups", "D--X.bak-20260630-111703");
  assert.deepEqual(r.moved, [{ from: bak, to }]);
  assert.deepEqual(r.skipped, []);
  assert.equal(existsSync(bak), false);
  const after = statSync(join(to, "a.jsonl"));
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.atimeMs, before.atimeMs);
  assert.deepEqual(await entries(t.journal), [{ t: "quarantined", runId: "run1", from: bak, to, reason: "backup-dir" }]);
});

test("quarantine: a name already in quarantine gets -2, then -3", async () => {
  const t = tempRoot();
  mkdirSync(join(t.home, QUARANTINE_DIR, "backups", ".bak-1"), { recursive: true });
  mkdirSync(join(t.home, QUARANTINE_DIR, "backups", ".bak-1-2"), { recursive: true });
  const bak = join(t.projects, ".bak-1");
  put(join(bak, "x.jsonl"), "{}\n");
  const r = await quarantine([bak], t.home, t.journal, "run1");
  assert.equal(r.moved[0]!.to, join(t.home, QUARANTINE_DIR, "backups", ".bak-1-3"));
  assert.ok(existsSync(join(r.moved[0]!.to, "x.jsonl")));
});

test("quarantine skips a backup dir holding a file written in the last 10 minutes", async () => {
  const t = tempRoot();
  const bak = join(t.projects, ".bak-live");
  put(join(bak, "old.jsonl"), "{}\n");
  put(join(bak, "deep", "new.jsonl"), "{}\n", Date.now() - 60_000);
  const r = await quarantine([bak], t.home, t.journal, "run1");
  assert.deepEqual(r.moved, []);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0]!.reason, /active/);
  assert.ok(existsSync(join(bak, "deep", "new.jsonl")));
  assert.deepEqual(await entries(t.journal), []);
});

test("quarantine: EXDEV aborts that dir only (never copy+delete), nothing journaled for it", async () => {
  const t = tempRoot();
  const a = join(t.projects, ".bak-a");
  const b = join(t.projects, ".bak-b");
  put(join(a, "x.jsonl"), "{}\n");
  put(join(b, "y.jsonl"), "{}\n");
  const fs = {
    ...nodeMoveFs,
    rename: async (from: string, to: string) => {
      if (from === a) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      await rename(from, to);
    },
  };
  const r = await quarantine([a, b], t.home, t.journal, "run1", { fs });
  assert.equal(r.moved.length, 1);
  assert.equal(r.moved[0]!.from, b);
  assert.equal(r.skipped[0]!.path, a);
  assert.match(r.skipped[0]!.reason, /another drive|EXDEV/);
  assert.ok(existsSync(join(a, "x.jsonl")));
  const es = await entries(t.journal);
  assert.equal(es.length, 1);
  assert.equal((es[0] as { from: string }).from, b);
});

test("quarantine: when journaling fails the dir is renamed back and the error surfaces", async () => {
  const t = tempRoot();
  const bak = join(t.projects, ".bak-j");
  put(join(bak, "x.jsonl"), "{}\n");
  const j = new FailingJournal(t.journal.file);
  await assert.rejects(quarantine([bak], t.home, j, "run1"), /ENOSPC/);
  assert.ok(existsSync(join(bak, "x.jsonl")));
  assert.equal(existsSync(join(t.home, QUARANTINE_DIR, "backups", ".bak-j")), false);
});

test("quarantine refuses a dir that is not a direct child of the account's projects/", async () => {
  const t = tempRoot();
  const other = join(t.root, "elsewhere.bak");
  put(join(other, "x.jsonl"), "{}\n");
  const r = await quarantine([other], t.home, t.journal, "run1");
  assert.deepEqual(r.moved, []);
  assert.match(r.skipped[0]!.reason, /not a backup folder/);
  assert.ok(existsSync(join(other, "x.jsonl")));
});

test("quarantine dryRun reports the target and changes nothing", async () => {
  const t = tempRoot();
  const bak = join(t.projects, ".bak-d");
  put(join(bak, "x.jsonl"), "{}\n");
  const r = await quarantine([bak], t.home, t.journal, "run1", { dryRun: true });
  assert.equal(r.moved[0]!.to, join(t.home, QUARANTINE_DIR, "backups", ".bak-d"));
  assert.ok(existsSync(join(bak, "x.jsonl")));
  assert.deepEqual(await entries(t.journal), []);
});

// ---------------- dedupe ----------------

function mirrorSetup() {
  const t = tempRoot();
  const org = join(t.root, ".claude-org");
  const enc = "C--work-demo";
  const kept = (n: string, body: string) => put(join(org, "projects", enc, n), body);
  const mirror = (n: string, body: string, m = OLD) => put(join(t.projects, enc, n), body, m);
  const accounts = [acct("claudeAgent", t.home), acct("claude-org", org)];
  return { t, org, enc, kept, mirror, accounts };
}

const copy = (path: string, keptPath: string, relation: "identical" | "prefix" = "identical"): Plan["mirrorCopies"][number] => ({ path, nativeId: "n", keptPath, relation });

test("dedupe moves an identical mirror and a stale prefix mirror to quarantine/mirror/<encoded dir>/, keeping mtimes", async () => {
  const s = mirrorSetup();
  const k1 = s.kept("11111111-1111-4111-8111-111111111111.jsonl", lines(3));
  const m1 = s.mirror("11111111-1111-4111-8111-111111111111.jsonl", lines(3));
  const k2 = s.kept("22222222-2222-4222-8222-222222222222.jsonl", lines(5));
  const m2 = s.mirror("22222222-2222-4222-8222-222222222222.jsonl", lines(2));
  const m1Before = statSync(m1).mtimeMs, m2Before = statSync(m2).mtimeMs;
  const r = await dedupe([copy(m1, k1), copy(m2, k2, "prefix")], s.accounts, s.t.journal, "run1");
  const dest = join(s.t.home, QUARANTINE_DIR, "mirror", s.enc);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.moved.map((m) => m.to), [join(dest, "11111111-1111-4111-8111-111111111111.jsonl"), join(dest, "22222222-2222-4222-8222-222222222222.jsonl")]);
  assert.equal(existsSync(m1), false);
  assert.equal(existsSync(m2), false);
  assert.ok(existsSync(k1) && existsSync(k2));
  assert.equal(statSync(r.moved[0]!.to).mtimeMs, m1Before);
  assert.equal(statSync(r.moved[1]!.to).mtimeMs, m2Before);
  const es = await entries(s.t.journal);
  assert.deepEqual(es.map((e) => (e as { reason: string }).reason), ["mirror-copy", "mirror-copy"]);
});

test("dedupe skips a pair that diverged, or whose 'mirror' is now the longer copy", async () => {
  const s = mirrorSetup();
  const k1 = s.kept("a.jsonl", lines(3));
  const m1 = s.mirror("a.jsonl", lines(2) + lines(1, "fork"));
  const k2 = s.kept("b.jsonl", lines(2));
  const m2 = s.mirror("b.jsonl", lines(4));
  const r = await dedupe([copy(m1, k1), copy(m2, k2, "prefix")], s.accounts, s.t.journal, "run1");
  assert.deepEqual(r.moved, []);
  assert.deepEqual(r.skipped.map((x) => x.reason), ["no longer a mirror", "no longer a mirror"]);
  assert.ok(existsSync(m1) && existsSync(m2));
  assert.deepEqual(await entries(s.t.journal), []);
});

test("dedupe skips an active mirror, a missing mirror, and a mirror whose kept copy is gone", async () => {
  const s = mirrorSetup();
  const k1 = s.kept("a.jsonl", lines(2));
  const m1 = s.mirror("a.jsonl", lines(2), Date.now() - 30_000);
  const k2 = s.kept("b.jsonl", lines(2));
  const m2 = join(s.t.projects, s.enc, "b.jsonl"); // never written
  const m3 = s.mirror("c.jsonl", lines(2));
  const k3 = join(s.org, "projects", s.enc, "c.jsonl"); // never written
  const r = await dedupe([copy(m1, k1), copy(m2, k2), copy(m3, k3)], s.accounts, s.t.journal, "run1");
  assert.deepEqual(r.moved, []);
  assert.deepEqual(r.skipped.map((x) => x.reason), ["active", "missing", "kept copy missing"]);
  assert.ok(existsSync(m1) && existsSync(m3));
});

test("dedupe moves the session's sidecar folder (<stem>/) with it", async () => {
  const s = mirrorSetup();
  const k = s.kept("33333333-3333-4333-8333-333333333333.jsonl", lines(2));
  const m = s.mirror("33333333-3333-4333-8333-333333333333.jsonl", lines(2));
  const side = join(s.t.projects, s.enc, "33333333-3333-4333-8333-333333333333");
  put(join(side, "subagents", "agent-1.jsonl"), lines(1));
  const r = await dedupe([copy(m, k)], s.accounts, s.t.journal, "run1");
  const dest = join(s.t.home, QUARANTINE_DIR, "mirror", s.enc);
  assert.deepEqual(r.moved.map((x) => x.to), [join(dest, "33333333-3333-4333-8333-333333333333.jsonl"), join(dest, "33333333-3333-4333-8333-333333333333")]);
  assert.equal(existsSync(side), false);
  assert.ok(existsSync(join(dest, "33333333-3333-4333-8333-333333333333", "subagents", "agent-1.jsonl")));
  assert.equal((await entries(s.t.journal)).length, 2);
});

test("dedupe collision: file and sidecar share the -2 suffix", async () => {
  const s = mirrorSetup();
  const dest = join(s.t.home, QUARANTINE_DIR, "mirror", s.enc);
  put(join(dest, "s.jsonl"), "older quarantined copy\n");
  const k = s.kept("s.jsonl", lines(2));
  const m = s.mirror("s.jsonl", lines(2));
  put(join(s.t.projects, s.enc, "s", "x.json"), "{}");
  const r = await dedupe([copy(m, k)], s.accounts, s.t.journal, "run1");
  assert.deepEqual(r.moved.map((x) => x.to), [join(dest, "s-2.jsonl"), join(dest, "s-2")]);
});

test("dedupe never touches a mirror outside every configured account", async () => {
  const s = mirrorSetup();
  const k = s.kept("a.jsonl", lines(2));
  const stray = put(join(s.t.root, "elsewhere", "a.jsonl"), lines(2));
  const r = await dedupe([copy(stray, k)], s.accounts, s.t.journal, "run1");
  assert.deepEqual(r.moved, []);
  assert.match(r.skipped[0]!.reason, /not inside/);
  assert.ok(existsSync(stray));
});

// ---------------- review fixes: no-clobber moves, sidecar failure, subdirOf, orphans ----------------

test("moveEntry: a file keeps mtime and atime (link + unlink); an existing destination file or folder is never replaced", async () => {
  const t = tempRoot();
  const a = put(join(t.root, "src", "a.jsonl"), lines(2));
  const before = statSync(a);
  const dst = join(t.root, "dst", "a.jsonl");
  mkdirSync(join(t.root, "dst"));
  await moveEntry(a, dst);
  const after = statSync(dst);
  assert.equal(existsSync(a), false);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.atimeMs, before.atimeMs);

  const b = put(join(t.root, "src", "b.jsonl"), "mine");
  const taken = put(join(t.root, "dst", "b.jsonl"), "theirs");
  await assert.rejects(moveEntry(b, taken), (e: Error) => e instanceof MoveRefused && e.code === "EEXIST");
  assert.equal(readFileSync(taken, "utf8"), "theirs");
  assert.equal(readFileSync(b, "utf8"), "mine");

  const d = join(t.root, "srcdir");
  put(join(d, "x"), "x");
  const dd = join(t.root, "dstdir");
  mkdirSync(dd);
  await assert.rejects(moveEntry(d, dd), (e: Error) => e instanceof MoveRefused);
  assert.ok(existsSync(join(d, "x")));
});

test("dedupe: a file appearing at the destination between the check and the move is never overwritten", async () => {
  const s = mirrorSetup();
  const k = s.kept("a.jsonl", lines(2));
  const m = s.mirror("a.jsonl", lines(2));
  const fs = {
    ...nodeMoveFs,
    link: async (from: string, to: string) => {
      writeFileSync(to, "someone else's file"); // races in after pickFree
      await promisify(linkCb)(from, to);
    },
  };
  const r = await dedupe([copy(m, k)], s.accounts, s.t.journal, "run1", { fs });
  assert.deepEqual(r.moved, []);
  assert.match(r.skipped[0]!.reason, /already exists; nothing was changed/);
  assert.equal(readFileSync(m, "utf8"), lines(2));
  assert.equal(readFileSync(join(s.t.home, QUARANTINE_DIR, "mirror", s.enc, "a.jsonl"), "utf8"), "someone else's file");
  assert.deepEqual(await entries(s.t.journal), []);
});

test("dedupe: no hard-link support aborts the item (never copy+delete)", async () => {
  const s = mirrorSetup();
  const k = s.kept("a.jsonl", lines(2));
  const m = s.mirror("a.jsonl", lines(2));
  const fs = { ...nodeMoveFs, link: async () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); } };
  const r = await dedupe([copy(m, k)], s.accounts, s.t.journal, "run1", { fs });
  assert.match(r.skipped[0]!.reason, /cannot hard-link/);
  assert.ok(existsSync(m));
  assert.deepEqual(await entries(s.t.journal), []);
});

function sidecarSetup() {
  const s = mirrorSetup();
  const k = s.kept("s.jsonl", lines(2));
  const m = s.mirror("s.jsonl", lines(2));
  const side = join(s.t.projects, s.enc, "s");
  put(join(side, "x.jsonl"), lines(1));
  const fs = {
    ...nodeMoveFs,
    rename: async (from: string, to: string) => {
      if (from === side) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      await rename(from, to);
    },
  };
  return { ...s, k, m, side, fs };
}

test("dedupe: the sidecar folder cannot move -> the transcript is moved back, journaled, and the reason names the sidecar", async () => {
  const s = sidecarSetup();
  const r = await dedupe([copy(s.m, s.k)], s.accounts, s.t.journal, "run1", { fs: s.fs });
  assert.deepEqual(r.moved, []);
  assert.match(r.skipped[0]!.reason, /^sidecar folder .* could not be moved \(could not move \(EPERM\)\); the transcript was left in place$/);
  assert.ok(existsSync(s.m) && existsSync(join(s.side, "x.jsonl")));
  assert.deepEqual((await entries(s.t.journal)).map((e) => e.t), ["quarantined", "unquarantined"]);
});

test("dedupe: the sidecar folder cannot move and the unquarantined entry cannot be journaled -> JournalWriteError, file back in place", async () => {
  const s = sidecarSetup();
  const j = new FailingJournal(s.t.journal.file, 1);
  await assert.rejects(dedupe([copy(s.m, s.k)], s.accounts, j, "run1", { fs: s.fs }), (e: Error) => e instanceof JournalWriteError && /back to/.test(e.message));
  assert.ok(existsSync(s.m) && existsSync(join(s.side, "x.jsonl")));
});

test("subdirOf: case-aware on win32/darwin, exact on linux, never absolute or climbing", () => {
  assert.equal(subdirOf("/Users/a/.claude/projects", "/users/A/.claude/projects/-Users-a-x", "darwin"), "-Users-a-x");
  assert.equal(subdirOf("/Users/a/.claude/projects", "/users/a/.claude/projects/-x", "linux"), null);
  assert.equal(subdirOf("D:\\Users\\A\\.claude\\projects", "d:/users/a/.claude/projects/D--x", "win32"), "D--x");
  assert.equal(subdirOf("/h/projects", "/h/projects", "linux"), "");
  assert.equal(subdirOf("/h/projects", "/h/projects/a/b", "linux"), "a/b");
  assert.equal(subdirOf("/h/projects", "/h/other", "linux"), null);
  assert.equal(subdirOf("/h/projects", "/h/projectsX/a", "linux"), null);
  assert.equal(subdirOf("/h/projects", "/h/projects/../escape", "linux"), null);
});

test("findOrphanedQuarantine lists quarantine entries no quarantined journal entry refers to", async () => {
  const s = mirrorSetup();
  const bak = join(s.t.projects, ".bak-1");
  put(join(bak, "x.jsonl"), "{}\n");
  await quarantine([bak], s.t.home, s.t.journal, "q");
  const k = s.kept("m.jsonl", lines(2));
  const m = s.mirror("m.jsonl", lines(2));
  put(join(s.t.projects, s.enc, "m", "sub.jsonl"), lines(1));
  await dedupe([copy(m, k)], s.accounts, s.t.journal, "d");
  const q = join(s.t.home, QUARANTINE_DIR);
  mkdirSync(join(q, "backups", ".bak-by-hand"));
  put(join(q, "mirror", s.enc, "orphan.jsonl"), "{}\n");
  put(join(q, "mirror", s.enc, "orphan", "sub.jsonl"), "{}\n");
  put(join(q, "mirror", "C--other", "lost.jsonl"), "{}\n");
  const got = await findOrphanedQuarantine(s.accounts.map((a) => ({ home: a.home })), await entries(s.t.journal));
  assert.deepEqual(got.map((o) => [o.kind, o.path]).sort(), [
    ["backup", join(q, "backups", ".bak-by-hand")],
    ["mirror", join(q, "mirror", "C--other", "lost.jsonl")],
    ["mirror", join(q, "mirror", s.enc, "orphan")],
    ["mirror", join(q, "mirror", s.enc, "orphan.jsonl")],
  ].sort());
  assert.deepEqual(await findOrphanedQuarantine([{ home: join(s.t.root, "none") }], []), []);
});
