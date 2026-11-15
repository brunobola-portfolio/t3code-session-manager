// The interactive review list, driven by a fake terminal: key sequences in, frames out. Synthetic items only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewList, type ListItem, type ListStats } from "../../src/ui/list.ts";
import { CATALOGUES } from "../../src/assistant/i18n.ts";
import type { Term, TermKey } from "../../src/ui/terminal.ts";

const key = (name: string, extra: Partial<TermKey> = {}): TermKey => ({ name, ch: "", ctrl: false, meta: false, ...extra });
const chr = (c: string): TermKey => ({ name: c === " " ? "space" : c, ch: c, ctrl: false, meta: false });
const K = {
  up: key("up"), down: key("down"), pgup: key("pageup"), pgdn: key("pagedown"), enter: key("return"), esc: key("escape"),
  space: chr(" "), back: key("backspace"), ctrlC: key("c", { ctrl: true }),
};
const typed = (s: string): TermKey[] => [...s].map(chr);

interface Fake {
  term: Term; writes: string[]; raw: boolean[]; listeners: () => number;
  press(...ks: TermKey[]): void; frames(): string[]; frame(): string; lines: string[]; rawNow(): boolean; cursorHidden(): boolean;
  failWrites: { after: number }; end(): void;
}

// eslint-disable-next-line no-control-regex
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

function fakeTerm(o: { columns?: number; rows?: number; color?: boolean; unicode?: boolean; isTTY?: boolean; lines?: (string | null)[] } = {}): Fake {
  const writes: string[] = [];
  const raw: boolean[] = [];
  const cbs = new Set<(k: TermKey) => void>();
  const ends = new Set<() => void>();
  const lines = [...(o.lines ?? [])];
  const asked: string[] = [];
  const failWrites = { after: Infinity };
  let n = 0;
  const term: Term = {
    isTTY: o.isTTY ?? true, columns: o.columns ?? 80, rows: o.rows ?? 24, color: o.color ?? false, unicode: o.unicode ?? false,
    write(s) {
      if (n++ >= failWrites.after) { failWrites.after = Infinity; throw new Error("boom: write failed"); }
      writes.push(s);
    },
    onKey(cb, onEnd) { cbs.add(cb); if (onEnd) ends.add(onEnd); return () => { cbs.delete(cb); if (onEnd) ends.delete(onEnd); }; },
    setRaw(on) { raw.push(on); },
    async readLine(q) { asked.push(q); const l = lines.shift(); return l === undefined ? null : l; },
  };
  const frames = (): string[] => writes.map(strip).filter((s) => s.trim() !== "");
  return {
    term, writes, raw, listeners: () => cbs.size + ends.size, end: () => { for (const e of [...ends]) e(); },
    lines: asked, failWrites,
    press: (...ks) => { for (const k of ks) for (const cb of [...cbs]) cb(k); },
    frames, frame: () => frames().at(-1) ?? "",
    rawNow: () => raw.at(-1) === true,
    cursorHidden: () => { const h = writes.join("").lastIndexOf("\x1b[?25l"); const s = writes.join("").lastIndexOf("\x1b[?25h"); return h > s; },
  };
}

const item = (id: string, label: string, over: Partial<ListItem> = {}): ListItem => ({ id, label, detail: `detail of ${label}`, checked: false, ...over });
const three = (): ListItem[] => [item("a", "Alpha", { checked: true }), item("b", "Beta"), item("c", "Gamma")];
const base = { title: "Review", help: "Choose what to do", lang: "en" as const };
const states = (r: { items: ListItem[] }): string => r.items.map((i) => (i.checked ? "x" : "-")).join("");

test("arrows move, space toggles, the selected line shows its detail, Enter confirms", async () => {
  const f = fakeTerm();
  const p = reviewList(f.term, { ...base, items: three() });
  assert.match(f.frame(), /^Review$/m);
  assert.match(f.frame(), /Choose what to do/);
  assert.match(f.frame(), /> \[x\] Alpha/);
  assert.match(f.frame(), /detail of Alpha/);
  f.press(K.down);
  assert.match(f.frame(), /> \[ \] Beta/);
  assert.match(f.frame(), /detail of Beta/);
  f.press(K.space);
  assert.match(f.frame(), /> \[x\] Beta/);
  f.press(K.down, K.down, K.down); // stops at the last line
  assert.match(f.frame(), /> \[ \] Gamma/);
  f.press(K.up);
  f.press(K.enter);
  const r = await p;
  assert.equal(r.confirmed, true);
  assert.equal(states(r), "xx-");
  assert.deepEqual(r.items.map((i) => i.id), ["a", "b", "c"]);
});

test("j and k move, a and n mark all or none, PgDn and PgUp page", async () => {
  const items = Array.from({ length: 30 }, (_, i) => item(`i${i}`, `Item ${String(i).padStart(2, "0")}`));
  const f = fakeTerm({ rows: 12 }); // page of 5
  const p = reviewList(f.term, { ...base, items });
  f.press(chr("j"), chr("j"), chr("k"));
  assert.match(f.frame(), /> \[ \] Item 01/);
  f.press(K.pgdn);
  assert.match(f.frame(), /> \[ \] Item 06/);
  assert.doesNotMatch(f.frame(), /Item 00/);
  f.press(K.pgup);
  assert.match(f.frame(), /> \[ \] Item 01/);
  f.press(chr("a"));
  assert.match(f.frame(), /30 of 30 marked/);
  f.press(chr("n"));
  assert.match(f.frame(), /0 of 30 marked/);
  f.press(chr("a"), K.enter);
  assert.equal((await p).items.every((i) => i.checked), true);
});

test("/ filters by label and detail, a and n act on the lines shown, Esc in the filter clears it", async () => {
  const items = [item("1", "Fix login"), item("2", "Tidy README", { detail: "docs only" }), item("3", "Fix logout")];
  const f = fakeTerm();
  const p = reviewList(f.term, { ...base, items });
  f.press(chr("/"), ...typed("FIX"));
  assert.match(f.frame(), /Filter: FIX/);
  assert.match(f.frame(), /Fix login/);
  assert.doesNotMatch(f.frame(), /Tidy README/);
  f.press(K.enter, chr("a"));
  assert.match(f.frame(), /2 of 3 marked, 2 shown/);
  f.press(chr("/"), ...typed("docs"));
  assert.match(f.frame(), /Tidy README/);
  assert.doesNotMatch(f.frame(), /Fix login/);
  f.press(K.esc);
  assert.match(f.frame(), /Fix login/);
  assert.match(f.frame(), /Tidy README/);
  f.press(chr("/"), ...typed("zzz"));
  assert.match(f.frame(), /Nothing matches the filter\./);
  f.press(K.esc, K.enter);
  assert.equal(states(await p), "x-x");
});

test("e edits a text value (typing, Backspace, Enter), Esc keeps the old one, an item without editable says so", async () => {
  const items = [item("1", "~/code/app", { editable: { prompt: "Project name", value: "app" } }), item("2", "~/code/other")];
  const f = fakeTerm();
  const p = reviewList(f.term, { ...base, items });
  assert.match(f.frame(), /~\/code\/app -> app/);
  f.press(chr("e"));
  assert.match(f.frame(), /Project name: app_/);
  f.press(K.back, K.back, K.back, ...typed("web\u0007x"));
  assert.match(f.frame(), /Project name: webx_/);
  f.press(K.esc);
  assert.match(f.frame(), /~\/code\/app -> app/);
  f.press(chr("e"), K.back, ...typed("ui"), K.enter);
  assert.match(f.frame(), /~\/code\/app -> apui/);
  f.press(K.down, chr("e"));
  assert.match(f.frame(), /This line has nothing to edit\./);
  f.press(K.enter);
  const r = await p;
  assert.equal(r.items[0]!.editable!.value, "apui");
  assert.equal(r.items[0]!.editable!.prompt, "Project name");
});

test("e on a choice list picks with the arrows; Esc keeps the old choice", async () => {
  const items = [item("1", "~/work", { editable: { prompt: "Destination", value: "keep", choices: ["keep", "rehome", "skip"] } })];
  const f = fakeTerm();
  const p = reviewList(f.term, { ...base, items });
  f.press(chr("e"));
  assert.match(f.frame(), /Destination/);
  assert.match(f.frame(), /> keep/);
  f.press(K.down, K.down);
  assert.match(f.frame(), /> skip/);
  f.press(K.esc);
  assert.match(f.frame(), /~\/work -> keep/);
  f.press(chr("e"), K.down, K.enter);
  assert.match(f.frame(), /~\/work -> rehome/);
  f.press(K.enter);
  assert.equal((await p).items[0]!.editable!.value, "rehome");
});

test("Esc, q and Ctrl+C cancel: confirmed false, the items as they came", async () => {
  for (const cancel of [K.esc, chr("q"), K.ctrlC]) {
    const f = fakeTerm();
    const input = three();
    const p = reviewList(f.term, { ...base, items: input });
    f.press(K.down, K.space, chr("n"), chr("a"));
    f.press(cancel);
    const r = await p;
    assert.equal(r.confirmed, false);
    assert.equal(states(r), "x--", "unchanged");
    assert.equal(states({ items: input }), "x--", "the caller's items were not touched");
    assert.equal(f.rawNow(), false);
    assert.equal(f.cursorHidden(), false);
    assert.equal(f.listeners(), 0);
  }
});

test("? shows the keys (translated) and any key returns", async () => {
  const f = fakeTerm();
  const p = reviewList(f.term, { ...base, items: three() });
  f.press(chr("?"));
  assert.match(f.frame(), /Space: mark or unmark the line/);
  assert.match(f.frame(), /Press any key to go back\./);
  f.press(chr("x"));
  assert.match(f.frame(), /> \[x\] Alpha/);
  f.press(K.enter);
  await p;
  const g = fakeTerm();
  const q = reviewList(g.term, { ...base, lang: "pt", items: three() });
  assert.match(g.frame(), /Setas movem, Espaço marca/);
  assert.match(g.frame(), /1 de 3 marcados/);
  g.press(K.esc);
  await q;
});

test("without a TTY (or with plain) it falls back to numbered lines and the typed commands", async () => {
  const f = fakeTerm({ isTTY: false, lines: ["2 3", "e1", "newname", ""] });
  const items = [item("1", "One", { checked: true, editable: { prompt: "Name", value: "old" } }), item("2", "Two"), item("3", "Three", { meta: "3 items" })];
  const r = await reviewList(f.term, { ...base, items });
  const out = f.writes.join("");
  assert.match(out, /1\. \[x\] One -> old/);
  assert.match(out, /3\. \[ \] Three {2}\(3 items\)/);
  assert.ok(f.lines.includes("Toggle numbers (e.g. 2 5-7), e<number> to edit, Enter to confirm: "), "asks with the catalogue text");
  assert.equal(f.raw.length, 0, "raw mode never touched");
  assert.equal(r.confirmed, true);
  assert.equal(states(r), "xxx");
  assert.equal(r.items[0]!.editable!.value, "newname");
  assert.deepEqual(f.lines.filter((l) => /Name/.test(l)), ["Name [old] (Enter keeps it): "]);
  assert.doesNotMatch(out, /\x1b/);
});

test("plain mode: ranges, a, n, bad input is explained, q and a closed input cancel", async () => {
  const mk = (n: number): ListItem[] => Array.from({ length: n }, (_, i) => item(`i${i}`, `L${i + 1}`));
  const f = fakeTerm({ lines: ["a", "n", "2 5-7", "9", "zz", ""] });
  const r = await reviewList(f.term, { ...base, plain: true, items: mk(8) });
  assert.equal(states(r), "-x--xxx-");
  assert.match(f.writes.join(""), /Not understood: 9/);
  assert.match(f.writes.join(""), /Not understood: zz/);
  const g = fakeTerm({ lines: ["1", "q"] });
  assert.equal((await reviewList(g.term, { ...base, plain: true, items: mk(2) })).confirmed, false);
  const h = fakeTerm({ lines: [] }); // input closed
  assert.equal((await reviewList(h.term, { ...base, plain: true, items: mk(2) })).confirmed, false);
});

test("plain mode at 40 columns: every line and prompt fits, an item's continuation hangs under its text", async () => {
  const long = "A very long conversation title that goes on and on and on forever";
  const f = fakeTerm({ isTTY: false, columns: 40, lines: [""] });
  const r = await reviewList(f.term, { ...base, items: [item("1", long, { checked: true, meta: "pin", detail: `${long} ${long}` }), item("2", "short")] });
  assert.equal(r.confirmed, true);
  const out = f.writes.join("").split("\n");
  for (const l of out) assert.ok(l.length <= 40, `${l.length}: ${l}`);
  for (const q of f.lines) assert.ok(q.length <= 37, `prompt leaves room for the answer: ${q}`);
  const at = out.findIndex((l) => l.startsWith("1. [x] A very long"));
  assert.ok(at >= 0);
  assert.match(out[at + 1]!, /^ {7}\S/, "the item's next line hangs under its text");
  assert.ok(out.some((l) => /^ {3}A very long/.test(l)), "the detail keeps its indent");
});

test("plain mode edits a choice by number", async () => {
  const f = fakeTerm({ isTTY: false, lines: ["e1", "2", ""] });
  const r = await reviewList(f.term, { ...base, items: [item("1", "~/work", { editable: { prompt: "Destination", value: "keep", choices: ["keep", "rehome"] } })] });
  assert.equal(r.items[0]!.editable!.value, "rehome");
});

test("wraps at 40 columns: no line of any frame is wider, long text gets an ellipsis, the meta drops when it does not fit", async () => {
  const long = "A very long conversation title that goes on and on and on forever";
  const f = fakeTerm({ columns: 40, rows: 14 });
  const items = [item("1", long, { meta: "12 conv.", detail: long + " " + long }), item("2", "short", { meta: "2 conv." })];
  const p = reviewList(f.term, { ...base, title: "T".repeat(80), help: long, items });
  f.press(K.down, K.up, chr("/"), ...typed("a"), K.enter, chr("?"), chr("x"));
  for (const frame of f.frames()) for (const line of frame.split("\n")) assert.ok([...line].length <= 40, `too wide (${[...line].length}): ${line}`);
  assert.match(f.frames().at(-1)!, /\.\.\./);
  assert.match(f.frames().at(-1)!, /short +2 conv\./);
  f.press(K.esc);
  await p;
  const wide = fakeTerm({ columns: 100 });
  const q = reviewList(wide.term, { ...base, items: [item("1", "x", { meta: "12 conv." })] });
  assert.match(wide.frame(), /x +12 conv\./);
  wide.press(K.esc);
  await q;
  const narrow = fakeTerm({ columns: 10 }); // never narrower than 40 columns of layout
  const s = reviewList(narrow.term, { ...base, items: [item("1", "x")] });
  assert.ok(narrow.frame().split("\n").every((l) => [...l].length <= 40));
  narrow.press(K.esc);
  await s;
});

test("no ANSI colour without color (NO_COLOR); colour only when the terminal allows it; the frame redraws in place", async () => {
  const plain = fakeTerm({ color: false });
  const p = reviewList(plain.term, { ...base, items: three() });
  plain.press(K.down, chr("?"), chr("x"), K.enter);
  await p;
  assert.doesNotMatch(plain.writes.join(""), /\x1b\[[0-9;]*m/, "no SGR colour or style");
  const col = fakeTerm({ color: true });
  const q = reviewList(col.term, { ...base, items: three() });
  assert.match(col.writes.join(""), /\x1b\[[0-9;]*m/);
  col.press(K.down);
  assert.match(col.writes.at(-1)!, /\x1b\[\d+A/, "moves up over the previous frame");
  col.press(K.esc);
  await q;
});

test("ASCII symbols without unicode, symbols with it", async () => {
  const a = fakeTerm({ unicode: false });
  const p = reviewList(a.term, { ...base, items: three() });
  assert.match(a.frame(), /> \[x\] Alpha/);
  assert.doesNotMatch(a.frame(), /[^\x00-\x7f]/);
  a.press(K.esc);
  await p;
  const u = fakeTerm({ unicode: true });
  const q = reviewList(u.term, { ...base, items: three() });
  assert.match(u.frame(), /› \[✓\] Alpha/);
  assert.match(u.frame(), /\[ \] Beta/);
  u.press(K.esc);
  await q;
});

test("labels, details, meta, edit values and titles are sanitized: no escape or bidi character reaches the terminal", async () => {
  const evil = "\x1b[31mred\x1b]0;pwned\x07‮gnp.exe\u0085x";
  const f = fakeTerm({ color: false });
  const p = reviewList(f.term, {
    title: `T${evil}`, help: `H${evil}`, lang: "en",
    items: [item("1", `L${evil}`, { detail: `D${evil}`, meta: `M${evil}`, editable: { prompt: `P${evil}`, value: `V${evil}` } })],
  });
  f.press(chr("e"), ...typed(evil.replace(/[\x00-\x1f]/g, "")));
  f.press(K.enter);
  const out = f.frames().join("\n");
  assert.doesNotMatch(out, /[\x00-\x08\x0b-\x1f\x7f‮\u0085]/);
  assert.doesNotMatch(f.writes.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""), /\x1b|\x07/);
  f.press(K.enter);
  const r = await p;
  assert.doesNotMatch(r.items[0]!.editable!.value, /[\x00-\x1f\x7f‮\u0085]/);
});

test("5000 items: one page per frame, the filter is one pass over the items, each item sanitized once", async () => {
  const items = Array.from({ length: 5000 }, (_, i) => item(`i${i}`, `Conversation ${i}`, { detail: i % 100 === 0 ? "special" : "plain", meta: `${i} msgs` }));
  const stats: ListStats = { frames: 0, rowsRendered: 0, maxRowsInFrame: 0, filterPasses: 0, filterVisits: 0, sanitized: 0 };
  const f = fakeTerm({ rows: 30 });
  const p = reviewList(f.term, { ...base, items, stats });
  const page = 30 - 7;
  assert.equal(stats.sanitized, 5000);
  assert.equal(stats.frames, 1);
  assert.equal(stats.rowsRendered, page);
  f.press(K.pgdn, K.pgdn, K.down, K.space, chr("a"));
  assert.ok(stats.maxRowsInFrame <= page, `max ${stats.maxRowsInFrame} rows`);
  assert.equal(stats.rowsRendered, stats.frames * page, "every frame rendered exactly one page");
  assert.equal(stats.filterPasses, 0);
  f.press(chr("/"));
  const before = stats.filterVisits;
  f.press(...typed("special"));
  assert.equal(stats.filterPasses, 7, "one pass per typed character");
  assert.equal(stats.filterVisits - before, 7 * 5000, "each pass visits every item exactly once");
  assert.equal(stats.sanitized, 5000, "nothing is sanitized again while filtering");
  f.press(K.enter);
  assert.match(f.frame(), /50 shown/);
  assert.ok(stats.maxRowsInFrame <= page);
  f.press(K.esc);
  await p;
});

test("raw mode and the cursor come back after an exception while drawing", async () => {
  const f = fakeTerm();
  const p = reviewList(f.term, { ...base, items: three() });
  assert.equal(f.rawNow(), true);
  assert.equal(f.cursorHidden(), true);
  f.failWrites.after = f.writes.length; // the next frame fails
  f.press(K.down);
  await assert.rejects(p, /boom: write failed/);
  assert.equal(f.rawNow(), false);
  assert.equal(f.cursorHidden(), false);
  assert.equal(f.listeners(), 0, "the key listener is gone");
});

test("raw mode and the cursor come back when the very first frame fails", async () => {
  const f = fakeTerm();
  f.failWrites.after = 1; // write #0 hides the cursor, #1 is the first frame
  await assert.rejects(reviewList(f.term, { ...base, items: three() }), /boom/);
  assert.equal(f.rawNow(), false);
  assert.equal(f.raw.length >= 2, true);
});

test("an empty list says so and Enter confirms it", async () => {
  const f = fakeTerm();
  const p = reviewList(f.term, { ...base, items: [] });
  assert.match(f.frame(), /Nothing to review\./);
  f.press(K.down, K.space, chr("e"), K.enter);
  const r = await p;
  assert.deepEqual([r.confirmed, r.items.length], [true, 0]);
});

test("keys pressed after the list finished are ignored", async () => {
  const f = fakeTerm();
  const p = reviewList(f.term, { ...base, items: three() });
  f.press(K.enter, K.space, K.down);
  assert.equal(states(await p), "x--");
  assert.equal(CATALOGUES.en.listFooterShort, "? help, Esc cancel");
});

test("input closing mid-list cancels: confirmed false, raw mode off, cursor shown, no listeners left", async () => {
  const f = fakeTerm();
  const p = reviewList(f.term, { ...base, items: three() });
  f.press(K.down, K.space);
  f.end();
  const r = await p;
  assert.equal(r.confirmed, false);
  assert.equal(states(r), "x--");
  assert.equal(f.rawNow(), false);
  assert.equal(f.cursorHidden(), false);
  assert.equal(f.listeners(), 0);
});
