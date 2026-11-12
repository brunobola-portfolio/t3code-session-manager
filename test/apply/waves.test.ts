import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWaves, bumpTargets, projectCapacity, waveItems, WAVE_COST_CAP, MAX_WAVE_FILES, type Wave } from "../../src/apply/waves.ts";
import type { PlanItem } from "../../src/core/types.ts";
import { DAY, NOW, sess } from "../plan/helpers.ts";

const MiB = 1024 * 1024;

function item(root: string, mtimeMs: number, cost = 100): PlanItem {
  const s = sess({ cwd: root, mtimeMs });
  s.cwdOffsetBytes = cost;
  return { session: s, action: { kind: "import", projectRoot: root, instanceId: "claudeAgent", expectedThreadId: `import:claudeAgent:${s.nativeId}` }, notes: [] };
}

const cost = (i: PlanItem): number => i.session.cwdOffsetBytes;

function threeByOneTwenty(): PlanItem[] {
  const out: PlanItem[] = [];
  const roots = ["C:/work/a", "C:/work/b", "C:/work/c"];
  // Interleaved mtimes across projects so the global order mixes them.
  for (let k = 0; k < 360; k++) out.push(item(roots[(k * 7) % 3]!, NOW - 300 * DAY + k * 3_600_000 + (k % 5)));
  return out;
}

function check(waves: Wave[], batch: { filesPerProject: number; projectsPerWave: number }): void {
  let prevMax = -Infinity;
  for (const w of waves) {
    assert.ok(w.projects.length >= 1 && w.projects.length <= batch.projectsPerWave, "projects per wave");
    for (const p of w.projects) assert.ok(p.items.length >= 1 && p.items.length <= batch.filesPerProject, "files per project");
    const its = waveItems(w);
    const min = Math.min(...its.map((i) => i.session.file.mtimeMs));
    const max = Math.max(...its.map((i) => i.session.file.mtimeMs));
    assert.ok(min >= prevMax, "every item's original mtime >= every item's in earlier waves");
    prevMax = max;
    assert.ok(its.reduce((a, i) => a + cost(i), 0) <= WAVE_COST_CAP, "56 MiB cost cap");
    for (let k = 1; k < its.length; k++) assert.ok(its[k]!.session.file.mtimeMs >= its[k - 1]!.session.file.mtimeMs, "waveItems ascending");
  }
}

test("buildWaves: 3 projects x 120 items, {50, 2}: limits, global ascending order, every item exactly once, deterministic", () => {
  const items = threeByOneTwenty();
  const batch = { filesPerProject: 50, projectsPerWave: 2 };
  const waves = buildWaves(items, batch, cost);
  check(waves, batch);
  const flat = waves.flatMap(waveItems);
  assert.equal(flat.length, 360);
  assert.equal(new Set(flat).size, 360);
  const again = buildWaves([...items].reverse(), batch, cost);
  assert.deepEqual(again, waves, "same waves whatever the input order");
});

test("buildWaves: a wave never exceeds the 56 MiB cost cap; an item over the cap alone still gets its own wave", () => {
  const items = Array.from({ length: 12 }, (_, k) => item("C:/work/a", NOW - 100 * DAY + k, 10 * MiB));
  items.push(item("C:/work/a", NOW - 50 * DAY, 60 * MiB));
  const waves = buildWaves(items, { filesPerProject: 50, projectsPerWave: 5 }, cost);
  for (const w of waves.slice(0, -1)) assert.ok(waveItems(w).length <= 5);
  check(waves.slice(0, -1), { filesPerProject: 50, projectsPerWave: 5 });
  assert.equal(waveItems(waves.at(-1)!).length, 1);
  assert.equal(waves.flatMap(waveItems).length, 13);
});

test("buildWaves: per-project capacity = min(filesPerProject, 90) (R = 0 with parking)", () => {
  assert.equal(projectCapacity(50), 50);
  assert.equal(projectCapacity(100), 90);
  assert.equal(projectCapacity(0), 1, "never zero");
  const items = Array.from({ length: 200 }, (_, k) => item("C:/work/a", NOW - 100 * DAY + k));
  const waves = buildWaves(items, { filesPerProject: 100, projectsPerWave: 5 }, cost);
  assert.deepEqual(waves.map((w) => waveItems(w).length), [90, 90, 20]);
});

test("buildWaves: case and slash variants of one root are one project (win32)", () => {
  const items = [item("C:/work/a", NOW - 10 * DAY), item("c:\\work\\A\\", NOW - 9 * DAY)];
  const waves = buildWaves(items, { filesPerProject: 50, projectsPerWave: 1 }, cost, { platform: "win32" });
  assert.equal(waves.length, 1);
  assert.equal(waves[0]!.projects.length, 1);
});

test("buildWaves: never more than MAX_WAVE_FILES files in one wave (bump offsets stay < 2 s)", () => {
  assert.ok(MAX_WAVE_FILES <= 2000);
});

test("bumpTargets: (now - 2 s) + i ms, strictly increasing, never in the future", () => {
  const now = 1_800_000_000_123;
  const t = bumpTargets(90 * 5, now);
  assert.equal(t[0], now - 2000);
  for (let k = 1; k < t.length; k++) assert.equal(t[k], t[k - 1]! + 1);
  assert.ok(t.every((x) => x <= now));
  assert.throws(() => bumpTargets(2001, now), /future/);
});
