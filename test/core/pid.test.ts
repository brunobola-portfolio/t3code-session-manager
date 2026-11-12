import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidAlive } from "../../src/core/pid.ts";
import { sweepWriteTemps } from "../../src/core/fsutil.ts";

const answersAlive = (): void => {}; // a probe that would say "alive" for anything

test("pidAlive: a pid outside the valid range (<= 0, > 2^31 - 1, NaN, not an integer) is not alive, whatever the probe says", () => {
  for (const pid of [0, -1, -4242, 2 ** 31, 99_999_999_999, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.equal(pidAlive(pid, answersAlive), false, String(pid));
  }
  assert.equal(pidAlive(2 ** 31 - 1, answersAlive), true, "the top valid pid is probed");
  assert.equal(pidAlive(4242, answersAlive), true);
  assert.equal(pidAlive(4242, () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); }), false);
  assert.equal(pidAlive(4242, () => { throw Object.assign(new Error("x"), { code: "EPERM" }); }), true, "doubtful answer: alive (unchanged)");
});

test("sweepWriteTemps: temps carrying an out-of-range pid (0, > 2^31 - 1) are swept with the real probe; this process's are kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t3sm-pid-"));
  try {
    const uuid = "00000000-0000-4000-8000-000000000001";
    const zero = `.${uuid}.0.aaaaaaaaaaaa.tmp`;
    const huge = `.${uuid}.99999999999.bbbbbbbbbbbb.tmp`;
    const mine = `.${uuid}.${process.pid}.cccccccccccc.tmp`;
    for (const n of [zero, huge, mine]) writeFileSync(join(dir, n), "x");
    const swept = await sweepWriteTemps(dir);
    assert.deepEqual(swept.map((p) => p.slice(dir.length + 1)).sort(), [huge, zero].sort());
    assert.deepEqual(readdirSync(dir), [mine]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
