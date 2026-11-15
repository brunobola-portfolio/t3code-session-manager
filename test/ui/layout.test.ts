// The screens' wrapping helpers: a command stays whole on a line when it fits, and one wider than a line wraps at its
// own spaces instead of being cut inside a word (a run id, a session id).
import { test } from "node:test";
import assert from "node:assert/strict";
import { leadLines, noteLines, textLines, wrapAtoms } from "../../src/ui/layout.ts";
import { makeStyle } from "../../src/ui/style.ts";

const s = makeStyle({ color: 0, unicode: true, isTTY: false, columns: 40 });

test("a command that fits a line is never split", () => {
  assert.deepEqual(textLines(s, "Undo it with `t3sm rollback --run R1`.", 24), ["Undo it with", "t3sm rollback --run R1."]);
});

test("a command wider than a line wraps at its spaces; no word is cut", () => {
  const out = noteLines(s, "ok", "Merged 1 session; undo with `t3sm rollback --run 20261115-120000-a1b2`.", 40);
  assert.deepEqual(out, ["✓ Merged 1 session; undo with t3sm", "  rollback --run 20261115-120000-a1b2."]);
  const projects = textLines(s, "Change one with `t3sm projects set \"<folder>\" <account>`.", 38);
  assert.ok(projects.every((l) => l.trim() !== "."), "the full stop never sits alone on a line");
});

test("only a single word wider than a line is broken", () => {
  assert.deepEqual(wrapAtoms(["abcdefghij"], 4, 4), ["abcd", "efgh", "ij"]);
});

test("a lead line keeps its note whole: on the same line when it fits, else wrapped below, never cut", () => {
  const o = { sym: "✓", tone: "ok" as const, word: "All good", note: "t3sm does not need anything from you" };
  assert.deepEqual(leadLines(s, o, 80), ["✓ All good · t3sm does not need anything from you"]);
  assert.deepEqual(leadLines(s, o, 30), ["✓ All good", "  t3sm does not need anything", "  from you"]);
  assert.ok(leadLines(s, o, 30).every((l) => !l.includes("…")));
});

test("homeAsTilde: the home folder before any punctuation becomes ~; a longer folder name is left alone", async () => {
  const { homeAsTilde } = await import("../../src/ui/layout.ts");
  const home = "C:/Users/demo";
  assert.equal(homeAsTilde("EPERM (C:/Users/demo)", home), "EPERM (~)");
  assert.equal(homeAsTilde("open 'C:/Users/demo'", home), "open '~'");
  assert.equal(homeAsTilde("in C:\\Users\\demo\\x and C:/Users/demo/y", home), "in ~\\x and ~/y");
  assert.equal(homeAsTilde("C:/Users/demo2/x", home), "C:/Users/demo2/x");
});
