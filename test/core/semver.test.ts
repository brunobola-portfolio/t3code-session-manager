import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSemver, parseSemver } from "../../src/core/semver.ts";

test("semver order and v prefix", () => {
  assert.deepEqual(parseSemver("v0.3.1"), [0, 3, 1]);
  assert.deepEqual(parseSemver("0.3.1"), [0, 3, 1]);
  assert.deepEqual(parseSemver("10.20.30"), [10, 20, 30]);
  // Prereleases, build metadata, partial versions, leading zeros and junk are not releases.
  for (const bad of ["v0.3.1-rc1", "0.3.1+build", "0.3", "v1", "01.2.3", "1.02.3", " 0.3.1", "0.3.1 ", "V0.3.1", "vv0.3.1", "", "x.y.z", "1.2.3.4"]) {
    assert.equal(parseSemver(bad), null, bad);
  }
  assert.equal(compareSemver("v0.3.0", "0.3.0"), 0);
  assert.ok(compareSemver("0.10.0", "0.9.9") > 0, "numeric, not string, order");
  assert.ok(compareSemver("0.2.1", "0.3.0") < 0);
  assert.ok(compareSemver("1.0.0", "0.99.99") > 0);
  assert.ok(compareSemver("0.3.10", "v0.3.9") > 0);
  assert.deepEqual(["0.3.0", "v0.10.0", "0.2.1", "0.3.1"].sort(compareSemver), ["0.2.1", "0.3.0", "0.3.1", "v0.10.0"]);
  assert.throws(() => compareSemver("0.3.1-rc1", "0.3.0"), /not a release version/);
});
