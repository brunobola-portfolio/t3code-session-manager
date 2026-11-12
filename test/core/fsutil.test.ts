import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RENAME_RETRIES, atomicWrite, renameRetryDelay, sha256File, statSafe } from "../../src/core/fsutil.ts";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "t3sm-fs-"));
}

test("atomicWrite creates parents, leaves no .tmp, overwrites", async () => {
  const d = await tmp();
  try {
    const f = join(d, "a", "b", "x.json");
    await atomicWrite(f, "one");
    await atomicWrite(f, "two");
    assert.equal(await readFile(f, "utf8"), "two");
    assert.deepEqual(await readdir(join(d, "a", "b")), ["x.json"]);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("atomicWrite: a concurrent reader never sees a partial file", async () => {
  const d = await tmp();
  try {
    const f = join(d, "big.txt");
    const oldData = "a".repeat(5 * 1024 * 1024);
    const newData = "b".repeat(5 * 1024 * 1024);
    await writeFile(f, oldData);
    let done = false;
    const writer = atomicWrite(f, newData).finally(() => {
      done = true;
    });
    while (!done) {
      await new Promise((r) => setTimeout(r, 2)); // a polling reader, not a busy loop
      let s: string;
      try {
        s = await readFile(f, "utf8");
      } catch {
        continue; // Windows may briefly deny access during the rename
      }
      assert.ok(s === oldData || s === newData, "partial content observed");
    }
    await writer;
    assert.equal(await readFile(f, "utf8"), newData);
    assert.deepEqual(await readdir(d), ["big.txt"]);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

const eperm = (): NodeJS.ErrnoException => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });

test("atomicWrite: a rename refused while another process holds the target (EPERM) is retried with a growing delay", async () => {
  const d = await tmp();
  try {
    const f = join(d, "config.json");
    await writeFile(f, "old");
    let calls = 0;
    const slept: number[] = [];
    await atomicWrite(f, "new", {
      rename: async (a, b) => { if (++calls <= 3) throw eperm(); await rename(a, b); },
      sleep: async (ms) => void slept.push(ms),
    });
    assert.equal(calls, 4);
    assert.deepEqual(slept, [10, 20, 40]);
    assert.equal(await readFile(f, "utf8"), "new");
    assert.deepEqual(await readdir(d), ["config.json"], "no temp file left");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("atomicWrite: a rename that keeps failing gives up after about 5 s of retries, throws, and removes its temp file", async () => {
  const d = await tmp();
  try {
    const f = join(d, "config.json");
    await writeFile(f, "old");
    let calls = 0;
    const slept: number[] = [];
    await assert.rejects(atomicWrite(f, "new", { rename: async () => { calls++; throw eperm(); }, sleep: async (ms) => void slept.push(ms) }), { code: "EPERM" });
    assert.equal(calls, RENAME_RETRIES + 1);
    assert.equal(slept.length, RENAME_RETRIES);
    assert.ok(slept.every((ms, i) => ms === renameRetryDelay(i) && ms <= 250));
    const total = slept.reduce((a, b) => a + b, 0);
    assert.ok(total >= 4000 && total <= 6000, `total wait ${total} ms`);
    assert.equal(await readFile(f, "utf8"), "old");
    assert.deepEqual(await readdir(d), ["config.json"], "no temp file left");
    let other = 0;
    await assert.rejects(atomicWrite(f, "new", { rename: async () => { other++; throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); }, sleep: async () => {} }), { code: "EXDEV" });
    assert.equal(other, 1, "only EPERM / EBUSY / EACCES are retried");
    assert.deepEqual(await readdir(d), ["config.json"]);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("atomicWrite cleans up the temp file on failure", async () => {
  const d = await tmp();
  try {
    const target = join(d, "dir");
    await mkdir(target); // renaming a file over a directory fails
    await assert.rejects(atomicWrite(target, "x"));
    assert.deepEqual(await readdir(d), ["dir"]);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("sha256File", async () => {
  const d = await tmp();
  try {
    const f = join(d, "h.txt");
    await writeFile(f, "hello");
    assert.equal(await sha256File(f), createHash("sha256").update("hello").digest("hex"));
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("statSafe: SourceFile or null", async () => {
  const d = await tmp();
  try {
    const f = join(d, "s.txt");
    await writeFile(f, "abc");
    const s = await statSafe(f);
    assert.ok(s);
    assert.equal(s.path, f);
    assert.equal(s.size, 3);
    assert.equal(typeof s.mtimeMs, "number");
    assert.equal(typeof s.atimeMs, "number");
    assert.equal(await statSafe(join(d, "nope")), null);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
