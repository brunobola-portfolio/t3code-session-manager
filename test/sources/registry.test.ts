import { test } from "node:test";
import assert from "node:assert/strict";
import { allAdapters } from "../../src/sources/registry.ts";

test("allAdapters lists claude, codex, pi, opencode in order; only opencode converts", () => {
  assert.deepEqual(allAdapters().map((a) => a.id), ["claude", "codex", "pi", "opencode"]);
  assert.deepEqual(allAdapters().filter((a) => a.mode === "convert").map((a) => a.id), ["opencode"]);
  assert.equal(typeof allAdapters().find((a) => a.id === "opencode")!.read, "function");
});
