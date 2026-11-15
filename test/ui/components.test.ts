import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStyle } from "../../src/ui/style.ts";
import type { Caps } from "../../src/ui/caps.ts";
import { displayWidth, stripAnsi } from "../../src/ui/text.ts";
import { appHeader, callout, kv, panel, stepHeader, table, type Column } from "../../src/ui/components.ts";
import { assertSnapshot } from "./snapshot.ts";

const WORD = { step: "Step", of: "of" };
const caps = (o: Partial<Caps> = {}): Caps => ({ color: 0, unicode: true, isTTY: true, columns: 80, ...o });
const st = (o: Partial<Caps> = {}) => makeStyle(caps(o));

interface Row { name: string; path: string; n: number; note: string }
const ROWS: Row[] = [
  { name: "app", path: "C:/work/demo/packages/app/src/index.ts", n: 1234, note: "ready to import" },
  { name: "api", path: "~/code/api/services/orders/handlers/create.ts", n: 56, note: "waiting" },
  { name: "docs", path: "~/code/docs", n: 7, note: "" },
];
const COLS: Column[] = [
  { header: "Project", get: (r) => (r as Row).name, priority: 10 },
  { header: "Path", get: (r) => (r as Row).path, truncate: "middle", priority: 5, min: 30 },
  { header: "Count", get: (r) => String((r as Row).n), align: "right", priority: 8 },
  { header: "Note", get: (r) => (r as Row).note, priority: 1, min: 15 },
];

type Render = (s: ReturnType<typeof st>, w: number) => string[];
const SAMPLES: Record<string, Render> = {
  appHeader: (s, w) => [...appHeader(s, { version: "0.3.0", subtitle: "Bring your sessions into T3 Code" }, w), ...appHeader(s, { version: "0.3.0" }, w)],
  stepHeader: (s, w) => [...stepHeader(s, { n: 3, total: 11, title: "Accounts", done: [1, 2], word: WORD }, w), ...stepHeader(s, { n: 1, total: 3, title: "A very long step title that never fits in the line", done: [], word: WORD }, w)],
  panel: (s, w) => [
    ...panel(s, { title: "Here is what I will do", body: ["Import 5 conversations into 4 projects.", "A long line that needs wrapping inside the box because it is longer than forty columns."] }, w),
    ...panel(s, { body: ["no title"], tone: "ok" }, w), ...panel(s, { title: "Careful", body: ["x"], tone: "warn" }, w), ...panel(s, { title: "Failed", body: [], tone: "err" }, w),
  ],
  kv: (s, w) => kv(s, [["Accounts", "2"], ["Last run", "15/11 at 10:20"], ["Path", "C:/work/demo/packages/app/src/some/very/deep/path/index.ts and then some more words to wrap"]], w),
  table: (s, w) => table(s, COLS, ROWS, w),
  callout: (s, w) => [
    ...callout(s, { kind: "info", title: "Worth knowing", body: ["Pi sessions exist (3) but no Pi instance was found."] }, w),
    ...callout(s, { kind: "warn", title: "Continued in a terminal", body: ["Two conversations moved on after the import."], command: "t3sm merge --project app" }, w),
    ...callout(s, { kind: "needs-you", title: "Needs you", body: ["3 undecided conversations. Decide where they belong, then run the command below to settle them all at once."], command: "t3sm start --resume" }, w),
  ],
};

for (const [name, render] of Object.entries(SAMPLES)) {
  for (const w of [40, 80, 120]) {
    test(`${name} at ${w} columns (snapshot; colour only adds ANSI; ASCII mode stays ASCII)`, () => {
      const out: string[] = [];
      for (const unicode of [true, false]) {
        const plain = render(st({ unicode, color: 0 }), w);
        const colour = render(st({ unicode, color: 1 }), w);
        out.push(`--- unicode ${unicode ? "on" : "off"}`, ...plain);
        assert.ok(plain.every((l) => displayWidth(l) <= w), `overflow in ${name}@${w}\n${plain.join("\n")}`);
        assert.ok(colour.every((l) => displayWidth(l) <= w));
        assert.ok(plain.every((l) => !l.includes("\x1b")));
        assert.deepEqual(colour.map(stripAnsi), plain);
        if (!unicode) assert.ok(plain.every((l) => /^[\x20-\x7e]*$/.test(l)), `non-ASCII in ${name}@${w}`);
        assert.ok(plain.every((l) => !/\s$/.test(l)), "no trailing spaces");
      }
      assertSnapshot(`components/${name}-${w}`, out.join("\n"));
    });
  }
}

test("table drops the lowest priority column at 60 cols", () => {
  const wide = table(st(), COLS, ROWS, 120);
  assert.ok(wide[0]!.includes("Note") && wide[0]!.includes("Path"));
  const mid = table(st(), COLS, ROWS, 60);
  assert.ok(!mid[0]!.includes("Note"), mid.join("\n"));
  assert.ok(mid[0]!.includes("Project") && mid[0]!.includes("Count") && mid[0]!.includes("Path"));
  const narrow = table(st(), COLS, ROWS, 24);
  assert.ok(narrow.every((l) => displayWidth(l) <= 24));
  assert.ok(narrow[0]!.includes("Project"));
  assert.ok(!narrow[0]!.includes("Path"));
});

test("table: numbers right-aligned, never wraps, header plus rule plus one line per row", () => {
  const t = table(st(), COLS, ROWS, 100);
  assert.equal(t.length, 2 + ROWS.length);
  const idx = t[0]!.indexOf("Count") + "Count".length;
  assert.ok(t.slice(2).every((l, i) => l.slice(0, idx).trimEnd().endsWith(String(ROWS[i]!.n))), t.join("\n"));
});

test("middle ellipsis for paths", () => {
  const t = table(st(), COLS, ROWS, 50);
  const row = t[2]!;
  assert.ok(row.includes("…"), row);
  assert.ok(row.includes("C:/work") && row.includes("index.ts"), row);
  const a = table(st({ unicode: false }), COLS, ROWS, 50);
  assert.ok(a[2]!.includes("..."));
});

test("table with no rows still renders the header; no columns render nothing", () => {
  assert.equal(table(st(), COLS, [], 80).length, 2);
  assert.deepEqual(table(st(), [], ROWS, 80), []);
});

test("step header: rail, done and current marked, shortened under 60 columns", () => {
  const w = stepHeader(st(), { n: 3, total: 11, title: "Contas", done: [1, 2], word: WORD }, 100)[0]!;
  assert.equal(w, "● ● ◉ ○ ○ ○ ○ ○ ○ ○ ○  Step 3 of 11 · Contas");
  assert.equal(stepHeader(st({ unicode: false }), { n: 3, total: 5, title: "X", done: [1, 2], word: WORD }, 100)[0], "* * @ o o  Step 3 of 5 - X");
  const s = stepHeader(st(), { n: 3, total: 11, title: "Contas", done: [1, 2], word: WORD }, 50)[0]!;
  assert.ok(s.startsWith("3/11") && s.includes("Contas") && !s.includes("○"), s);
  const pt = stepHeader(st(), { n: 2, total: 4, title: "Contas", done: [1], word: { step: "Passo", of: "de" } }, 80)[0]!;
  assert.ok(pt.endsWith("Passo 2 de 4 · Contas"), pt);
});

test("panel: rounded box, tone symbol, body wrapped inside", () => {
  const p = panel(st(), { title: "T", body: ["hello"] }, 20);
  assert.deepEqual(p, ["╭─ T ──────────────╮", "│ hello            │", "╰──────────────────╯"]);
  const a = panel(st({ unicode: false }), { title: "T", body: ["hello"], tone: "ok" }, 20);
  assert.equal(a[0], "+- v T ------------+");
  assert.ok(panel(st(), { body: ["x ".repeat(40)] }, 30).every((l) => displayWidth(l) === 30));
  const s1 = st({ color: 1 });
  const c = panel(s1, { body: [s1("ok", "green text")] }, 30);
  assert.ok(c.every((l) => displayWidth(l) === 30));
});

test("kv aligns labels and wraps values under the value column", () => {
  const l = kv(st(), [["A", "1"], ["Longer", "value that is quite long and must wrap around the end of the line"]], 40);
  assert.equal(l[0], "A       1");
  assert.ok(l[1]!.startsWith("Longer  value"));
  assert.ok(l.slice(2).every((x) => x.startsWith("        ")));
  assert.ok(l.every((x) => displayWidth(x) <= 40));
  assert.deepEqual(kv(st(), [], 40), []);
});

test("kv never cuts a label: the label column is the longest label, and stacks over the values when they get under 10", () => {
  const rows: [string, string][] = [["Could not import", "6"], ["Next run", "1 (in use, changed or locked)"]];
  const l = kv(st(), rows, 36);
  assert.equal(l[0], "Could not import  6");
  assert.ok(l[1]!.startsWith("Next run          1 (in use,"), l[1]);
  assert.ok(l.every((x) => displayWidth(x) <= 36));
  const stacked = kv(st(), [["Contas por omissão a definir", "0"], ["Já no T3 Code", "3"]], 36);
  assert.deepEqual(stacked, ["Contas por omissão a definir", "  0", "Já no T3 Code", "  3"]);
});

test("kv stacks only the rows whose longest word does not fit beside the label (Task 22); the others stay aligned", () => {
  const rows: [string, string][] = [["Run", "20261115-093125-c3d4"], ["Report", "~/.t3code-session-manager/runs/20261115/plan.md"], ["Next", "t3sm apply"]];
  const l = kv(st(), rows, 50);
  assert.equal(l[0], "Run     20261115-093125-c3d4");
  assert.equal(l[1], "Report");
  assert.ok(l[2]!.startsWith("  ~/.t3code"), l[2]);
  assert.equal(l.at(-1), "Next    t3sm apply");
  assert.ok(l.every((x) => displayWidth(x) <= 50));
});

test("callout carries a symbol and a word, and the exact command", () => {
  const c = callout(st(), { kind: "needs-you", title: "Needs you", body: ["Do this."], command: "t3sm status" }, 60);
  assert.equal(c[0], "✗ Needs you");
  assert.ok(c.some((l) => l.includes("t3sm status")));
  assert.equal(callout(st(), { kind: "warn", title: "W", body: [] }, 60)[0], "! W");
  assert.equal(callout(st({ unicode: false }), { kind: "needs-you", title: "N", body: [] }, 60)[0], "x N");
});

test("components survive absurdly small widths without overflow", () => {
  const s = st();
  for (const w of [1, 2, 3, 5, 8]) {
    const all = [
      ...appHeader(s, { version: "0.3.0", subtitle: "sub" }, w), ...stepHeader(s, { n: 1, total: 3, title: "Title", done: [], word: WORD }, w),
      ...panel(s, { title: "Title", body: ["body text here"] }, w), ...kv(s, [["k", "value value"]], w), ...table(s, COLS, ROWS, w),
      ...callout(s, { kind: "info", title: "Title", body: ["body"], command: "cmd arg" }, w),
    ];
    assert.ok(all.every((l) => displayWidth(l) <= w), `w=${w}\n${all.join("\n")}`);
  }
});

test("table: a lower priority column is dropped before a higher priority one is cut below its readable width", () => {
  const cols: Column[] = [
    { header: "Project", get: (r) => (r as Row).name, priority: 10 },
    { header: "Path", get: (r) => (r as Row).path, truncate: "middle", priority: 5 },
    { header: "Note", get: (r) => (r as Row).note, priority: 1 },
  ];
  const t = table(st(), cols, ROWS, 28);
  assert.ok(!t[0]!.includes("Note"), t.join("\n"));
  const path = t[2]!.slice(t[0]!.indexOf("Path")).trim();
  assert.ok(displayWidth(path) >= 16, `Path stays readable: ${path}`);
  assert.ok(path.includes("…") && path.endsWith("index.ts"));
});

test("table: when shrinking, the lowest priority column gives way first", () => {
  const cols: Column[] = [
    { header: "A", get: () => "a".repeat(30), priority: 9, min: 4 },
    { header: "B", get: () => "b".repeat(30), priority: 1, min: 4 },
  ];
  const l = table(st(), cols, [0], 40)[2]!;
  const [a, b] = l.split("  ");
  assert.equal(a!.length, 30);
  assert.ok(b!.length < 30 && b!.length >= 4);
});

test("panel: a title made of parts breaks between them first, so a part such as 'T3 Code' stays together", () => {
  const out = panel(st(), { title: "Plan 20261115-093012-a1b2 · T3 Code 0.1.9", body: ["x"] }, 40).map(stripAnsi);
  assert.match(out[0]!, /^╭─ Plan 20261115-093012-a1b2 ─+╮$/);
  assert.match(out[1]!, /^│ T3 Code 0\.1\.9 +│$/);
  assert.ok(out.every((l) => displayWidth(l) === 40));
  // A title that fits keeps its parts on the border.
  assert.match(panel(st(), { title: "Plan R1 · T3 Code 0.1.9", body: ["x"] }, 40).map(stripAnsi)[0]!, /^╭─ Plan R1 · T3 Code 0\.1\.9 ─+╮$/);
});
