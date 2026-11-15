import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, GENERIC_SEGMENTS, projectTitle, truncateTitle } from "../../src/plan/names.ts";

const o = { maxLength: 40, platform: "win32" as const };

test("projectTitle: same folder name under two parents gets a parent label on the second", () => {
  const taken = new Set<string>();
  const a = projectTitle("C:/work/TPB/ADDON V10", taken, o);
  assert.equal(a, "ADDON V10");
  taken.add(a);
  assert.equal(projectTitle("C:/work/PZO/ADDON V10", taken, o), "ADDON V10 · PZO");
});

test("projectTitle: collisions are case-insensitive", () => {
  assert.equal(projectTitle("C:/work/B/Demo", new Set(["demo"]), o), "Demo · B");
});

test("projectTitle: a generic last segment uses parent/last", () => {
  assert.equal(projectTitle("C:/x/GestaoDeEquipas/src", new Set(), o), "GestaoDeEquipas/src");
  assert.equal(projectTitle("C:/x/Shop/V10", new Set(), o), "Shop/V10");
  assert.ok(GENERIC_SEGMENTS.includes("src"));
});

test("projectTitle: a generic folder at the root has nothing to prefix", () => {
  assert.equal(projectTitle("C:/src", new Set(), o), "src");
});

test("projectTitle: a 200-char name is 40 graphemes with the ellipsis in the middle", () => {
  const name = "A".repeat(100) + "Z".repeat(100);
  const t = projectTitle(`C:/work/${name}`, new Set(), o);
  assert.equal([...new Intl.Segmenter().segment(t)].length, 40);
  assert.ok(t.startsWith("AAAA") && t.endsWith("ZZZZ") && t.includes("…"));
});

test("projectTitle: control chars and zero-width spaces are removed, accents kept", () => {
  assert.equal(projectTitle("C:/work/MIGRA\u200BÇÃO\u0007  2026\n", new Set(), o), "MIGRAÇÃO 2026");
});

test("projectTitle: still colliding goes one more level up, then numbers", () => {
  const taken = new Set(["app x"]);
  taken.add("app x · b");
  assert.equal(projectTitle("C:/w/a/b/App X", taken, o), "App X · a/b");
  taken.add("app x · a/b");
  assert.equal(projectTitle("C:/w/a/b/App X", taken, o), "App X (2)");
  taken.add("app x (2)");
  assert.equal(projectTitle("C:/w/a/b/App X", taken, o), "App X (3)");
});

test("projectTitle: a generic base is labelled with the grandparent, not the parent it already shows", () => {
  const taken = new Set<string>();
  const a = projectTitle("C:/a/GestaoDeEquipas/src", taken, o);
  assert.equal(a, "GestaoDeEquipas/src");
  taken.add(a);
  assert.equal(projectTitle("C:/b/GestaoDeEquipas/src", taken, o), "GestaoDeEquipas/src · b");
});

test("projectTitle: when the labels run out the third collision ends in (2) within the limit", () => {
  const long = "N".repeat(60);
  const taken = new Set<string>();
  const t1 = projectTitle(`C:/p/${long}`, taken, o);
  taken.add(t1);
  const t2 = projectTitle(`C:/p/${long}`, taken, o);
  assert.ok(t2.endsWith(" · p"));
  taken.add(t2);
  const t3 = projectTitle(`C:/p/${long}`, taken, o);
  assert.ok(t3.endsWith(" (2)"), t3);
  assert.ok([...new Intl.Segmenter().segment(t3)].length <= 40);
});

test("projectTitle: win32 roots with backslashes are split too", () => {
  assert.equal(projectTitle("C:\\work\\Shop\\src", new Set(), o), "Shop/src");
});

test("cleanText: NFC, strips invisible characters, collapses whitespace, keeps emoji", () => {
  assert.equal(cleanText("  e\u0301\t\u00ad x\u200B\uFEFFy  \n z "), "é xy z");
  assert.equal(cleanText("👨‍👩‍👧 ok 🚀"), "👨‍👩‍👧 ok 🚀");
});

test("truncateTitle: by grapheme, never splits an emoji", () => {
  assert.equal(truncateTitle("short", 10), "short");
  const s = "🚀".repeat(20);
  const t = truncateTitle(s, 7);
  assert.equal([...new Intl.Segmenter().segment(t)].length, 7);
  assert.equal(t, "🚀🚀🚀…🚀🚀🚀");
  assert.equal(truncateTitle("abcdef", 1), "…");
});
