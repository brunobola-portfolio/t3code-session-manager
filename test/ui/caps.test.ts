import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCaps } from "../../src/ui/caps.ts";

const tty = { isTTY: true, columns: 100 };
const pipe = { isTTY: false };

test("detectCaps: colour matrix", () => {
  assert.equal(detectCaps({}, "linux", tty).color, 1);
  assert.equal(detectCaps({ NO_COLOR: "1" }, "linux", tty).color, 0);
  assert.equal(detectCaps({ NO_COLOR: "1", FORCE_COLOR: "3" }, "linux", tty).color, 0);
  assert.equal(detectCaps({ FORCE_COLOR: "0" }, "linux", tty).color, 0);
  assert.equal(detectCaps({ FORCE_COLOR: "1" }, "linux", pipe).color, 1);
  assert.equal(detectCaps({ FORCE_COLOR: "true" }, "linux", pipe).color, 1);
  assert.equal(detectCaps({ FORCE_COLOR: "2" }, "linux", pipe).color, 2);
  assert.equal(detectCaps({ FORCE_COLOR: "3" }, "linux", pipe).color, 3);
  assert.equal(detectCaps({}, "linux", pipe).color, 0);
  assert.equal(detectCaps({ TERM: "dumb" }, "linux", tty).color, 0);
  assert.equal(detectCaps({ TERM: "dumb", FORCE_COLOR: "3" }, "linux", tty).color, 0);
});

test("detectCaps: colour depth from the stream and the environment", () => {
  assert.equal(detectCaps({}, "linux", { isTTY: true, hasColors: (n) => n <= 16 }).color, 1);
  assert.equal(detectCaps({}, "linux", { isTTY: true, hasColors: (n) => n <= 256 }).color, 2);
  assert.equal(detectCaps({}, "linux", { isTTY: true, hasColors: () => true }).color, 3);
  assert.equal(detectCaps({ COLORTERM: "truecolor" }, "linux", tty).color, 3);
  assert.equal(detectCaps({ TERM: "xterm-256color" }, "linux", tty).color, 2);
});

test("detectCaps: unicode, tty, columns", () => {
  assert.equal(detectCaps({ TERM: "dumb" }, "linux", tty).unicode, false);
  assert.equal(detectCaps({}, "linux", tty).unicode, true);
  assert.equal(detectCaps({ LANG: "C" }, "linux", tty).unicode, false);
  assert.equal(detectCaps({}, "win32", tty).unicode, false);
  assert.equal(detectCaps({ WT_SESSION: "x" }, "win32", tty).unicode, true);
  const c = detectCaps({}, "linux", pipe);
  assert.deepEqual([c.isTTY, c.columns], [false, 80]);
  assert.equal(detectCaps({}, "linux", tty).columns, 100);
});

test("cursor control: only on a TTY and never for TERM=dumb", () => {
  assert.equal(detectCaps({}, "linux", tty).cursor, true);
  assert.equal(detectCaps({}, "linux", pipe).cursor, false);
  assert.equal(detectCaps({ TERM: "dumb" }, "linux", tty).cursor, false);
});
