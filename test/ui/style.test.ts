import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStyle } from "../../src/ui/style.ts";
import type { Caps } from "../../src/ui/caps.ts";

const caps = (o: Partial<Caps> = {}): Caps => ({ color: 1, unicode: true, isTTY: true, columns: 80, ...o });

test("no ANSI when color 0", () => {
  const s = makeStyle(caps({ color: 0 }));
  for (const t of ["title", "accent", "muted", "ok", "warn", "err", "key", "path", "num"] as const) assert.equal(s(t, "x"), "x");
});

test("ANSI when color > 0, even off a TTY", () => {
  const s = makeStyle(caps({ color: 1, isTTY: false }));
  assert.equal(s("accent", "x"), "\u001b[32mx\u001b[39m");
  assert.equal(s("muted", "x"), "\u001b[90mx\u001b[39m");
  assert.equal(s("title", "x"), "\u001b[1mx\u001b[22m");
});

test("symbols: unicode and ascii", () => {
  const u = makeStyle(caps()).sym;
  assert.deepEqual([u.ok, u.err, u.warn, u.dot, u.ring, u.arrow, u.ellipsis], ["✓", "✗", "!", "●", "○", "›", "…"]);
  assert.deepEqual([u.h, u.v, u.tl, u.tr, u.bl, u.br, u.barFull, u.barEmpty], ["─", "│", "╭", "╮", "╰", "╯", "█", "░"]);
  const a = makeStyle(caps({ unicode: false })).sym;
  assert.deepEqual([a.ok, a.err, a.warn, a.dot, a.ring, a.arrow, a.ellipsis], ["v", "x", "!", "*", "o", ">", "..."]);
  assert.deepEqual([a.h, a.v, a.tl, a.tr, a.bl, a.br, a.barFull, a.barEmpty], ["-", "|", "+", "+", "+", "+", "#", "."]);
  assert.equal(makeStyle(caps()).caps.columns, 80);
});
