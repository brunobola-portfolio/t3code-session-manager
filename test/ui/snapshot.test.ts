import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSnapshot } from "./snapshot.ts";

const dir = (): string => mkdtempSync(join(tmpdir(), "t3sm-snap-"));

test("a missing snapshot is written and logged; the next run compares it", () => {
  const d = dir();
  const logs: string[] = [];
  assertSnapshot("a/b", "x\r\ny", { dir: d, env: {}, log: (s) => logs.push(s) });
  assert.equal(readFileSync(join(d, "a", "b.txt"), "utf8"), "x\ny\n");
  assert.deepEqual(logs, ["snapshot written: a/b"]);
  assertSnapshot("a/b", "x\ny\n\n", { dir: d, env: {}, log: () => assert.fail("must not write") });
  assert.throws(() => assertSnapshot("a/b", "other", { dir: d, env: {} }));
});

test("in CI a missing snapshot fails; UPDATE_SNAPSHOTS=1 rewrites", () => {
  const d = dir();
  assert.throws(() => assertSnapshot("n", "x", { dir: d, env: { CI: "true" } }), /missing/);
  writeFileSync(join(d, "n.txt"), "old\n");
  assertSnapshot("n", "new", { dir: d, env: { CI: "true", UPDATE_SNAPSHOTS: "1" }, log: () => {} });
  assert.equal(readFileSync(join(d, "n.txt"), "utf8"), "new\n");
});

test("CI is only on when set and not false/0", () => {
  const d = dir();
  for (const ci of ["false", "0", ""]) {
    assertSnapshot(`n${ci}`, "x", { dir: d, env: { CI: ci }, log: () => {} });
  }
  assert.throws(() => assertSnapshot("m", "x", { dir: d, env: { CI: "1" } }), /missing/);
});
