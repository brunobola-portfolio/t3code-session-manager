import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCompat, TESTED_VERSIONS, compatGate } from "../../src/t3/compat.ts";

const TESTED_LIST = "0.1.8-nightly.20261105.4218, 0.1.9-nightly.20261110.4465, 0.1.10-nightly.20261113.4630";

test("TESTED_VERSIONS holds the spike versions and the live-verified organize nightly", () => {
  assert.deepEqual([...TESTED_VERSIONS], ["0.1.8-nightly.20261105.4218", "0.1.9-nightly.20261110.4465", "0.1.10-nightly.20261113.4630"]);
});

test("checkCompat: exact -> tested, same major.minor -> same-minor, else untested", () => {
  assert.equal(checkCompat("0.1.9-nightly.20261110.4465"), "tested");
  assert.equal(checkCompat("0.1.10-nightly.20261113.4630"), "tested");
  assert.equal(checkCompat("0.1.8-nightly.20261201.1"), "same-minor");
  assert.equal(checkCompat("0.1.9"), "same-minor");
  assert.equal(checkCompat("0.1.10-nightly.1"), "same-minor");
  assert.equal(checkCompat("0.2.0"), "untested");
  assert.equal(checkCompat("1.1.9"), "untested");
  assert.equal(checkCompat("0.11.0"), "untested");
  assert.equal(checkCompat("garbage"), "untested");
  assert.equal(checkCompat(""), "untested");
});

test("compatGate never throws for an untested version: one warning and it proceeds; silent with allowUntested", () => {
  const notes: string[] = [];
  const onNotice = (l: string) => notes.push(l);
  assert.equal(compatGate("0.1.9-nightly.20261110.4465", { allowUntested: false, onNotice }), "tested");
  assert.deepEqual(notes, []);
  assert.equal(compatGate("0.2.0", { allowUntested: false, onNotice }), "untested");
  assert.deepEqual(notes, [`Warning: T3 Code 0.2.0 has not been tested with t3sm (tested: ${TESTED_LIST}). Proceeding; every change is journaled and can be undone with t3sm rollback.`]);
  assert.equal(compatGate("0.2.0", { allowUntested: true, onNotice }), "untested");
  assert.equal(compatGate("0.1.8-nightly.20261201.1", { allowUntested: true, onNotice }), "same-minor");
  assert.equal(notes.length, 1);
  assert.equal(compatGate("0.2.0", { allowUntested: false }), "untested", "no onNotice is fine");
});

test("compatGate: a same-minor nightly gets the same single warning (one wording everywhere), newlines in the version are flattened", () => {
  const notes: string[] = [];
  assert.equal(compatGate("0.1.8-nightly.20261201.1", { allowUntested: false, onNotice: (l) => notes.push(l) }), "same-minor");
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /^Warning: T3 Code 0\.1\.8-nightly\.20261201\.1 has not been tested with t3sm \(tested: /);
  compatGate("0.2.0\nx", { allowUntested: false, onNotice: (l) => notes.push(l) });
  assert.ok(!notes[1]!.includes("\n"));
});
