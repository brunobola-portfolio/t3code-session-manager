import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { acquireLock, lockInfo, takeStealMutex } from "../../src/core/lock.ts";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "t3sm-lock-"));
}

test("second acquire is null; release frees it", async () => {
  const d = await tmp();
  try {
    const a = await acquireLock(d);
    assert.ok(a);
    assert.equal(await acquireLock(d), null);
    const body = JSON.parse(await readFile(join(d, "lock"), "utf8"));
    assert.equal(body.pid, process.pid);
    assert.equal(body.hostname, hostname());
    await a.release();
    const b = await acquireLock(d);
    assert.ok(b);
    await b.release();
    await b.release(); // idempotent
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("dead pid is stale and stolen", async () => {
  const d = await tmp();
  try {
    await writeFile(join(d, "lock"), JSON.stringify({ pid: 999999, startedAt: "x", hostname: hostname() }));
    const a = await acquireLock(d);
    assert.ok(a);
    assert.equal(JSON.parse(await readFile(join(d, "lock"), "utf8")).pid, process.pid);
    await a.release();
    assert.deepEqual((await readdir(d)).filter((n) => n.startsWith("lock")), []);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("different hostname is held even if pid is dead", async () => {
  const d = await tmp();
  try {
    await writeFile(join(d, "lock"), JSON.stringify({ pid: 999999, startedAt: "x", hostname: "other-host-xyz" }));
    assert.equal(await acquireLock(d), null);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("unparseable lock: young held, old stale", async () => {
  const d = await tmp();
  try {
    const f = join(d, "lock");
    await writeFile(f, "garbage");
    assert.equal(await acquireLock(d), null);
    const old = (Date.now() - 2 * 3600_000) / 1000;
    await utimes(f, old, old);
    const a = await acquireLock(d);
    assert.ok(a);
    await a.release();
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("release does not delete a lock owned by someone else", async () => {
  const d = await tmp();
  try {
    const a = await acquireLock(d);
    assert.ok(a);
    const other = JSON.stringify({ pid: process.pid, startedAt: "different", hostname: hostname() });
    await writeFile(join(d, "lock"), other);
    await a.release();
    assert.equal(await readFile(join(d, "lock"), "utf8"), other);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("creates the lock dir if missing", async () => {
  const d = await tmp();
  try {
    const a = await acquireLock(join(d, "nested", "dir"));
    assert.ok(a);
    await a.release();
  } finally { await rm(d, { recursive: true, force: true }); }
});


function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(r.pid);
  return r.pid;
}

test("pid of an exited child is stale", async () => {
  const d = await tmp();
  try {
    await writeFile(join(d, "lock"), JSON.stringify({ pid: deadPid(), startedAt: "x", hostname: hostname() }));
    const a = await acquireLock(d);
    assert.ok(a);
    await a.release();
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("EPERM from kill means alive => held; ESRCH => stale", async () => {
  const d = await tmp();
  try {
    await writeFile(join(d, "lock"), JSON.stringify({ pid: 4242, startedAt: "x", hostname: hostname() }));
    const eperm = () => { throw Object.assign(new Error("perm"), { code: "EPERM" }); };
    assert.equal(await acquireLock(d, { kill: eperm }), null);
    const esrch = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
    const a = await acquireLock(d, { kill: esrch });
    assert.ok(a);
    await a.release();
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("concurrent stealers of one stale lock: exactly one wins, no leftovers", async () => {
  for (let i = 0; i < 50; i++) {
    const d = await tmp();
    try {
      await writeFile(join(d, "lock"), JSON.stringify({ pid: 4242, startedAt: "x", hostname: hostname() }));
      const esrch = (pid: number) => { if (pid === 4242) throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
      const rs = await Promise.all([1, 2, 3].map(() => acquireLock(d, { kill: esrch })));
      const winners = rs.filter((r) => r !== null);
      assert.equal(winners.length, 1, `iteration ${i}`);
      await winners[0]!.release();
      assert.deepEqual(await readdir(d), []);
    } finally { await rm(d, { recursive: true, force: true }); }
  }
});

test("lockInfo reports owner and age; null when absent", async () => {
  const d = await tmp();
  try {
    assert.equal(await lockInfo(d), null);
    const a = await acquireLock(d);
    assert.ok(a);
    const info = await lockInfo(d);
    assert.equal(info!.pid, process.pid);
    assert.equal(info!.hostname, hostname());
    assert.ok(info!.ageMs >= 0 && info!.ageMs < 60_000);
    await a.release();
  } finally { await rm(d, { recursive: true, force: true }); }
});


test("multi-process stealers (stale lock, and stale lock + stale mutex): exactly one winner", { timeout: 60_000 }, async () => {
  const worker = join(import.meta.dirname, "lock-worker.ts");
  const dead = deadPid();
  const N = 4;
  for (let i = 0; i < 10; i++) {
    const d = await tmp();
    try {
      await writeFile(join(d, "lock"), JSON.stringify({ pid: dead, startedAt: "x", hostname: hostname() }));
      if (i % 2 === 1) {
        const m = join(d, "lock.steal");
        await writeFile(m, "dead-token");
        const old = (Date.now() - 60_000) / 1000;
        await utimes(m, old, old);
      }
      const goAt = Date.now() + 700;
      const kids = Array.from({ length: N }, () => {
        const c = spawn(process.execPath, [worker, d, String(goAt), String(dead)], { stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        const first = new Promise<string>((res) => {
          c.stdout.on("data", (b) => { out += b; if (out.includes("\n")) res(out.trim()); });
          c.on("close", () => res(out.trim() || "NOOUT"));
        });
        const closed = new Promise<void>((res) => c.on("close", () => res()));
        return { c, first, closed };
      });
      const results = await Promise.all(kids.map((k) => k.first));
      for (const k of kids) k.c.stdin.end();
      await Promise.all(kids.map((k) => k.closed));
      assert.equal(results.filter((r) => r === "WIN").length, 1, `iteration ${i}: ${results.join(",")}`);
      assert.ok(results.every((r) => r === "WIN" || r === "LOSE"), results.join(","));
      assert.deepEqual(await readdir(d), [], `iteration ${i} leftovers`);
    } finally { await rm(d, { recursive: true, force: true }); }
  }
});

test("fresh mutex displaced by a stale-break is put back; live holder keeps it, third stealer gets null", async () => {
  const d = await tmp();
  try {
    const m = join(d, "lock.steal");
    await writeFile(m, "stale-token");
    const old = (Date.now() - 60_000) / 1000;
    await utimes(m, old, old);
    // Between Y's stat (sees stale) and Y's rename, a holder X replaces the stale mutex with a fresh one.
    const y = await takeStealMutex(m, {
      afterStatBeforeBreak: async () => {
        await rm(m, { force: true });
        await writeFile(m, "holder-x-token");
      },
    });
    assert.equal(y, null);
    assert.equal(await readFile(m, "utf8"), "holder-x-token");
    assert.equal(await takeStealMutex(m), null); // third stealer
    assert.equal(await readFile(m, "utf8"), "holder-x-token");
    assert.deepEqual(await readdir(d), ["lock.steal"]); // no broken-* leftovers
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("lock staleness by uptime: rebooted since (uptime now below the stored one) -> stolen even with a live pid; a wall-clock step on the same boot -> kept", async () => {
  const d = await tmp();
  try {
    const alive = () => {}; // the reused pid answers: alive
    const lock = (body: Record<string, unknown>) => writeFile(join(d, "lock"), JSON.stringify({ pid: 4242, hostname: hostname(), ...body }));
    // Rebooted: the lock was taken at uptime 100 000 s, the machine has been up for an hour.
    await lock({ startedAt: new Date().toISOString(), uptimeSec: 100_000 });
    const a = await acquireLock(d, { kill: alive, uptime: () => 3600 });
    assert.ok(a, "taken over: its owner cannot have survived the reboot");
    const mine = JSON.parse(await readFile(join(d, "lock"), "utf8")) as Record<string, unknown>;
    assert.equal(mine.uptimeSec, 3600, "the lock body records this boot's uptime");
    await a.release();
    // Same boot, but the wall clock stepped forward (or startedAt looks ancient): judged by its pid, so held.
    await lock({ startedAt: new Date(Date.now() - 10 * 365 * 86400_000).toISOString(), uptimeSec: 3000 });
    assert.equal(await acquireLock(d, { kill: alive, uptime: () => 3600 }), null);
    // An old lock file without uptimeSec: the pid check only (no wall-clock boot comparison).
    await lock({ startedAt: new Date(Date.now() - 10 * 365 * 86400_000).toISOString() });
    assert.equal(await acquireLock(d, { kill: alive, uptime: () => 1 }), null);
    const gone = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
    const b = await acquireLock(d, { kill: gone, uptime: () => 1 });
    assert.ok(b, "dead pid: stolen");
    await b.release();
  } finally { await rm(d, { recursive: true, force: true }); }
});
