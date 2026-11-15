import { test } from "node:test";
import assert from "node:assert/strict";
import { watcherHealth } from "../../src/ops/watcherHealth.ts";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const HB = { pid: 7, startedAt: "2026-11-14T11:00:00.000Z", lastCycleAt: "2026-11-14T11:57:00.000Z", lastResult: null, nextCycleAt: "2026-11-14T12:07:00.000Z", version: "0.3.0", stamp: "s1", installRoot: "C:/work/t3sm" };
const o = (inst: { version: string; stamp: string } | null) => ({ now: NOW, pidAlive: () => true, install: () => (inst ? { ...inst, changedAtMs: 0 } : null), everyMinutes: 15 });

test("watcherHealth: a heartbeat version that is not a release version counts as unknown (no-version)", () => {
  assert.equal(watcherHealth({ ...HB, version: "0.3.0\u001b[31m" }, o({ version: "0.3.0", stamp: "s1" })).state, "no-version");
  assert.equal(watcherHealth({ ...HB }, o({ version: "0.3.0", stamp: "s1" })).state, "running");
});

test("watcherHealth: an install whose version is not a release version is unreadable (no stale-version, no pending switch)", () => {
  const h = watcherHealth({ ...HB }, o({ version: "0.3.1\u001b]0;x\u0007", stamp: "s2" }));
  assert.equal(h.state, "running");
  assert.equal(h.state === "running" ? h.pendingVersion : "x", null);
  assert.equal(watcherHealth({ ...HB }, o({ version: "0.3.1", stamp: "s2" })).state, "stale-version");
});
