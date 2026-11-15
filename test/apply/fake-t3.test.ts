// The fake T3 Code keeps what the real one keeps for a settle (tests of the history rule read it back).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeT3 } from "./fake-t3.ts";

test("fake settleThread stores the settledAt it is given, else the time of the call; unsettle clears it", async () => {
  const f = fakeT3();
  f.threads.set("t1", { id: "t1", projectId: "p1", instanceId: "claudeAgent", archived: false, title: "t", updatedAt: 0 });
  f.threads.set("t2", { id: "t2", projectId: "p1", instanceId: "claudeAgent", archived: false, title: "t", updatedAt: 0 });
  await f.api.settleThread("t1", "2026-07-01T00:00:00.000Z");
  assert.equal(f.threads.get("t1")!.settledAt, "2026-07-01T00:00:00.000Z");
  assert.equal(f.threads.get("t1")!.settledOverride, "settled");
  const before = Date.now();
  await f.api.settleThread("t2");
  assert.ok(Date.parse(f.threads.get("t2")!.settledAt!) >= before - 1000);
  await f.api.unsettleThread("t1");
  assert.equal(f.threads.get("t1")!.settledAt, null);
  assert.equal(f.threads.get("t1")!.settledOverride, "active");
});
