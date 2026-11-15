import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import fs from "node:fs";
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
    // The reader runs while the temp file is written and synced; the final rename waits for the read in flight and no
    // read starts until it is done. Windows refuses to rename over a file another handle has open (atomicWrite retries
    // that for about 5 s): a reader polling every 2 ms used to hold the file open nearly all the time, and on a loaded
    // machine, where each 5 MiB read takes longer, it kept the rename refused for the whole 5 s and the write failed.
    let inFlight: Promise<unknown> = Promise.resolve();
    let renaming = false;
    const renameAfterReads = async (from: string, to: string): Promise<void> => {
      renaming = true;
      try {
        await inFlight;
        await rename(from, to);
      } finally {
        renaming = false;
      }
    };
    const writer = atomicWrite(f, newData, { rename: renameAfterReads }).finally(() => {
      done = true;
    });
    while (!done) {
      await new Promise((r) => setTimeout(r, 2)); // a polling reader, not a busy loop
      if (renaming) continue;
      const read = readFile(f, "utf8");
      inFlight = read.catch(() => {});
      const s = await read;
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
    const moved: { from: string; to: string; data: string }[] = [];
    // Every rename is the stub's (no real rename, no real wait): a scanner on a loaded machine can never add a refusal.
    // The fourth call succeeds: what it would have moved is recorded instead.
    await atomicWrite(f, "new", {
      rename: async (a, b) => { if (++calls <= 3) throw eperm(); moved.push({ from: a, to: b, data: await readFile(a, "utf8") }); },
      sleep: async (ms) => void slept.push(ms),
    });
    assert.equal(calls, 4);
    assert.deepEqual(slept, [10, 20, 40]);
    assert.equal(moved.length, 1);
    assert.equal(moved[0]!.to, f);
    assert.equal(dirname(moved[0]!.from), d, "the temp file sits next to the target");
    assert.equal(moved[0]!.data, "new", "fsync'd temp file holds the new content");
    assert.equal(await readFile(f, "utf8"), "old", "the target is only ever replaced by the rename");
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

// Windows refuses to rename over (or delete) a file that is still open. sha256File used to resolve at the stream's
// "end", with the close of its descriptor still pending: a caller that replaced the file right after hashing it (the
// refresh of a converted transcript) was refused with EPERM whenever that close lagged, as it does on a loaded machine.
// The stream closes through fs.close, wrapped here to record when the close has completed.
test("sha256File resolves only once its file is closed", async (t) => {
  const d = await tmp();
  try {
    const f = join(d, "a.jsonl");
    await writeFile(f, "x".repeat(200_000));
    const real = fs.close;
    let closed = 0;
    t.mock.method(fs, "close", (fd: number, cb: (e: NodeJS.ErrnoException | null) => void) => real(fd, (e) => { closed++; cb(e); }));
    assert.equal(await sha256File(f), createHash("sha256").update("x".repeat(200_000)).digest("hex"));
    assert.equal(closed, 1, "the descriptor is closed when the hash is returned");
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
