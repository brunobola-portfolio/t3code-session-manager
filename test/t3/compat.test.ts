import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCompat, TESTED_VERSIONS, compatGate } from "../../src/t3/compat.ts";
import { T3Incompatible } from "../../src/t3/errors.ts";

test("TESTED_VERSIONS holds both spike versions", () => {
  assert.deepEqual([...TESTED_VERSIONS], ["0.1.8-nightly.20261105.4218", "0.1.9-nightly.20261110.4465"]);
});

test("checkCompat: exact -> tested, same major.minor -> same-minor, else untested", () => {
  assert.equal(checkCompat("0.1.9-nightly.20261110.4465"), "tested");
  assert.equal(checkCompat("0.1.8-nightly.20261105.4218"), "tested");
  assert.equal(checkCompat("0.1.8-nightly.20261201.1"), "same-minor");
  assert.equal(checkCompat("0.1.9"), "same-minor");
  assert.equal(checkCompat("0.1.10-nightly.1"), "same-minor");
  assert.equal(checkCompat("0.2.0"), "untested");
  assert.equal(checkCompat("1.1.9"), "untested");
  assert.equal(checkCompat("0.11.0"), "untested");
  assert.equal(checkCompat("garbage"), "untested");
  assert.equal(checkCompat(""), "untested");
});

test("compatGate: same-minor proceeds with exactly one notice line; untested throws unless allowed", () => {
  const notes: string[] = [];
  assert.equal(compatGate("0.1.9-nightly.20261110.4465", { allowUntested: false, onNotice: (l) => notes.push(l) }), "tested");
  assert.equal(notes.length, 0);
  assert.equal(compatGate("0.1.8-nightly.20261201.1", { allowUntested: false, onNotice: (l) => notes.push(l) }), "same-minor");
  assert.equal(notes.length, 1);
  assert.ok(!notes[0]!.includes("\n"));
  assert.ok(notes[0]!.includes("0.1.8-nightly.20261201.1"));
  assert.throws(() => compatGate("0.2.0", { allowUntested: false }), (e: unknown) => e instanceof T3Incompatible && e.exitCode === 4 && e.version === "0.2.0" && /--allow-untested/.test(e.message));
  assert.equal(compatGate("0.2.0", { allowUntested: true, onNotice: (l) => notes.push(l) }), "untested");
  assert.equal(notes.length, 2);
});
