import { test } from "node:test";
import assert from "node:assert/strict";
import { displayWidth, padEnd, padStart, stripAnsi, truncateEnd, truncateMiddle, wrapText } from "../../src/ui/text.ts";
import { capsOf, type Term } from "../../src/ui/terminal.ts";

test("CJK and accented widths", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("日本語"), 6);
  assert.equal(displayWidth("한국어"), 6);
  assert.equal(displayWidth("ＡＢ"), 4);
  assert.equal(displayWidth("café"), 4);
  assert.equal(displayWidth("cafe\u0301"), 4);
  assert.equal(displayWidth("😀"), 2);
  assert.equal(displayWidth("👨‍👩‍👧"), 2);
  assert.equal(displayWidth("🇵🇹"), 2);
  assert.equal(displayWidth("✓ ● █"), 5);
  assert.equal(displayWidth("a\u0007b"), 2);
  assert.equal(displayWidth("\u001b[32mgreen\u001b[39m"), 5);
  assert.equal(stripAnsi("\u001b[1;32mx\u001b[0m"), "x");
});

test("RTL title passes through without breaking width", () => {
  const t = "שלום עולם";
  assert.equal(displayWidth(t), 9);
  assert.equal(displayWidth("\u200F" + t + "\u200E"), 9);
  assert.equal(truncateEnd(t, 20), t);
  assert.equal(displayWidth(truncateEnd(t, 5)), 5);
});

test("truncateEnd and pad", () => {
  assert.equal(truncateEnd("hello", 10), "hello");
  assert.equal(truncateEnd("hello world", 6), "hello…");
  assert.equal(truncateEnd("日本語日本語", 5), "日本…");
  assert.equal(truncateEnd("abc", 0), "");
  assert.equal(padEnd("日本", 6), "日本  ");
  assert.equal(padStart("ab", 4), "  ab");
  assert.equal(padEnd("abcdef", 3), "abcdef");
});

test("middle ellipsis on paths", () => {
  const p = "C:/work/demo/packages/app/src/index.ts";
  const t = truncateMiddle(p, 20);
  assert.equal(displayWidth(t), 20);
  assert.ok(t.startsWith("C:/work/") && t.endsWith("index.ts") && t.includes("…"));
  assert.equal(truncateMiddle("short", 10), "short");
  assert.equal(truncateMiddle("abcdef", 1), "…");
  assert.ok(displayWidth(truncateMiddle("日本語のパスです/ファイル", 9)) <= 9);
});

test("wrap at 40 with hanging indent", () => {
  const s = "The quick brown fox jumps over the lazy dog and keeps running through the long forest";
  const lines = wrapText(s, 40, { hang: 2 });
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => displayWidth(l) <= 40));
  assert.ok(lines.slice(1).every((l) => l.startsWith("  ") && !l.startsWith("   ")));
  assert.equal(lines.join(" ").replace(/\s+/g, " "), s);
});

test("wrap: long words, CJK, edge widths, newlines", () => {
  assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrapText("日本語日本", 4), ["日本", "語日", "本"]);
  assert.deepEqual(wrapText("a b", 0), ["a", "b"]);
  assert.deepEqual(wrapText("one\n\ntwo", 10), ["one", "", "two"]);
  assert.deepEqual(wrapText("", 10), [""]);
  assert.ok(wrapText("word ".repeat(20), 8, { hang: 20 }).every((l) => displayWidth(l) <= 8));
  assert.deepEqual(wrapText("ab cd", 5, { hang: 2 }), ["ab cd"]);
  assert.deepEqual(wrapText("abcdefgh ij", 4, { hang: 2 }), ["abcd", "  ef", "  gh", "  ij"]);
});

test("truncate budgets the ellipsis width (ASCII ellipsis is three cells)", () => {
  assert.equal(truncateEnd("abcdefghij", 6, "..."), "abc...");
  assert.equal(truncateMiddle("abcdefghij", 7, "..."), "ab...ij");
  assert.ok(displayWidth(truncateMiddle("C:/work/demo/packages/app/src/index.ts", 20, "...")) <= 20);
  assert.equal(truncateEnd("abcdef", 2, "..."), "..");
  assert.equal(truncateMiddle("abcdef", 0), "");
  assert.equal(truncateEnd("abcdef", 0, "..."), "");
});

test("truncation cuts on emoji and ZWJ clusters, never inside", () => {
  const fam = "👨‍👩‍👧";
  const s = `ab${fam}${fam}cd`;
  for (let w = 1; w <= 12; w++) {
    for (const t of [truncateEnd(s, w), truncateMiddle(s, w)]) {
      assert.ok(displayWidth(t) <= w, `${t} at ${w}`);
      assert.ok(!/\u200d$/.test(t.replace(/…$/, "")) && !t.includes("\ufffd"));
      const lone = t.replace(new RegExp(fam, "g"), "");
      assert.ok(!/[\u{1F468}\u{1F469}\u{1F467}\u200d]/u.test(lone), `split cluster in ${t}`);
    }
  }
});

test("padEnd and padStart measure ANSI input by its visible width", () => {
  const g = "\u001b[32mab\u001b[39m";
  assert.equal(padEnd(g, 5), g + "   ");
  assert.equal(padStart(g, 5), "   " + g);
  assert.equal(displayWidth(padEnd(g, 5)), 5);
});

test("wrapText keeps emoji clusters whole", () => {
  const fam = "👨‍👩‍👧";
  const lines = wrapText(`${fam}${fam}${fam}${fam}`, 4);
  assert.deepEqual(lines, [fam + fam, fam + fam]);
  assert.ok(wrapText(`x ${fam}${fam}`, 3).every((l) => displayWidth(l) <= 3 || l === fam));
});

test("capsOf uses term.caps, else rebuilds from the term's fields", () => {
  const caps = { color: 2 as const, unicode: true, isTTY: true, columns: 100 };
  assert.deepEqual(capsOf({ caps } as unknown as Term), caps);
  const t = { color: true, unicode: false, isTTY: false, columns: 50 } as unknown as Term;
  assert.deepEqual(capsOf(t), { color: 1, unicode: false, isTTY: false, columns: 50 });
  assert.equal(capsOf({ color: false, unicode: true, isTTY: true, columns: 0 } as unknown as Term).columns, 80);
});
