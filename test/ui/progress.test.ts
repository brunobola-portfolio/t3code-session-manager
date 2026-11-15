import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { makeStyle } from "../../src/ui/style.ts";
import { makeFmt } from "../../src/ui/locale.ts";
import { displayWidth, stripAnsi } from "../../src/ui/text.ts";
import type { Term } from "../../src/ui/terminal.ts";
import { progressBar, spinner } from "../../src/ui/progress.ts";

function fakeTerm(o: { tty?: boolean; columns?: number; unicode?: boolean; cursor?: boolean } = {}) {
  const out: string[] = [];
  const tty = o.tty ?? true;
  const caps = { color: 0 as const, unicode: o.unicode ?? true, isTTY: tty, columns: o.columns ?? 80, ...(o.cursor === undefined ? {} : { cursor: o.cursor }) };
  const term = { isTTY: tty, columns: o.columns ?? 80, rows: 24, color: false, unicode: o.unicode ?? true, ...(o.cursor === undefined ? {} : { caps }), write: (s: string) => void out.push(s) } as unknown as Term;
  return { term, out, style: makeStyle(caps), text: () => out.join("") };
}
function fakeProc() {
  const em = new EventEmitter();
  const exits: number[] = [];
  return { em, exits, proc: { once: (e: string, cb: () => void) => em.once(e, cb), off: (e: string, cb: () => void) => em.off(e, cb), listenerCount: (e: string) => em.listenerCount(e), exit: (c: number) => void exits.push(c) } };
}
const fmt = makeFmt("en", () => 0);
const W = { left: "left" };
const clockOf = (ref: { t: number }) => () => ref.t;

test("TTY: one line redrawn with CR and clear-to-end, count, rate and time left", () => {
  const f = fakeTerm();
  const clk = { t: 0 };
  const p = fakeProc();
  const bar = progressBar(f.term, f.style, fmt, clockOf(clk), { proc: p.proc, words: W });
  bar.start(4007, "Importing");
  clk.t = 40_000;
  bar.tick(1234, "app");
  const last = f.out.filter((x) => x.startsWith("\r")).at(-1)!;
  const line = last.replace(/^\r/, "").replace(/\x1b\[K$/, "");
  assert.ok(line.includes("1,234/4,007"), line);
  assert.ok(line.includes("31/s"), line);
  assert.ok(line.includes("left 1 min"), line);
  assert.ok(line.includes("▕") && line.includes("█") && line.includes("░"));
  assert.ok(displayWidth(line) <= 79);
  assert.ok(!line.includes("\n"));
  assert.ok(f.text().includes("\x1b[?25l"), "cursor hidden");
  bar.end("Done: 4,007");
  assert.ok(f.text().endsWith("\r\x1b[KDone: 4,007\n\x1b[?25h"));
  assert.equal(p.em.listenerCount("exit"), 0, "exit hook removed");
});

test("Portuguese wording follows the formatter", () => {
  const f = fakeTerm();
  const clk = { t: 0 };
  const bar = progressBar(f.term, f.style, makeFmt("pt", () => 0), clockOf(clk), { proc: fakeProc().proc, words: { left: "faltam" } });
  bar.start(4007, "A importar");
  clk.t = 40_000;
  bar.tick(1234);
  assert.ok(f.text().includes("1 234/4 007") && f.text().includes("faltam"));
});

test("ASCII bar", () => {
  const f = fakeTerm({ unicode: false });
  const clk = { t: 0 };
  const bar = progressBar(f.term, f.style, fmt, clockOf(clk), { proc: fakeProc().proc, words: W });
  bar.start(10, "x");
  clk.t = 100;
  bar.tick(5);
  const line = f.out.filter((x) => x.startsWith("\r")).at(-1)!;
  assert.ok(/\[#+\.+\]/.test(line), line);
  assert.ok(/^[\x20-\x7e\r\x1b\[K]*$/.test(line));
});

test("resize mid-bar re-fits", () => {
  const f = fakeTerm({ columns: 100 });
  const clk = { t: 0 };
  const bar = progressBar(f.term, f.style, fmt, clockOf(clk), { proc: fakeProc().proc, words: W });
  bar.start(4007, "Importing a long label");
  clk.t = 10_000;
  bar.tick(500, "some/long/project/name");
  const wide = stripAnsi(f.out.filter((x) => x.startsWith("\r")).at(-1)!).replace(/^\r/, "");
  (f.term as { columns: number }).columns = 40;
  clk.t = 11_000;
  bar.tick(600, "some/long/project/name");
  const narrow = f.out.filter((x) => x.startsWith("\r")).at(-1)!.replace(/^\r/, "").replace(/\x1b\[K$/, "");
  assert.ok(displayWidth(wide) > 40 && displayWidth(wide) <= 99);
  assert.ok(displayWidth(narrow) <= 39, `${narrow} (${displayWidth(narrow)})`);
  assert.ok(narrow.includes("600"));
  (f.term as { columns: number }).columns = 12;
  bar.tick(700);
  assert.ok(displayWidth(f.out.filter((x) => x.startsWith("\r")).at(-1)!.replace(/^\r/, "").replace(/\x1b\[K$/, "")) <= 11);
});

test("progress without TTY prints at most 12 lines", () => {
  const f = fakeTerm({ tty: false });
  const bar = progressBar(f.term, f.style, fmt, () => 0, { proc: fakeProc().proc, words: W });
  bar.start(1000, "Importing");
  for (let i = 1; i <= 1000; i++) bar.tick(i, `item ${i}`);
  bar.end("Done");
  const lines = f.text().split("\n").filter((l) => l !== "");
  assert.ok(lines.length <= 12, String(lines.length));
  assert.ok(lines.length >= 10);
  assert.ok(!f.text().includes("\r") && !f.text().includes("\x1b"));
  assert.ok(lines[0]!.includes("Importing") && lines.at(-1) === "Done");
  assert.ok(lines.some((l) => l.includes("50%")));
  // a tiny total and a zero total
  const g = fakeTerm({ tty: false });
  const b2 = progressBar(g.term, g.style, fmt, () => 0, { proc: fakeProc().proc, words: W });
  b2.start(0, "Nothing");
  b2.end("Done");
  assert.deepEqual(g.text().split("\n").filter((l) => l !== ""), ["Nothing", "Done"]);
});

test("no TTY: lines longer than the terminal are truncated", () => {
  const f = fakeTerm({ tty: false, columns: 40 });
  const bar = progressBar(f.term, f.style, fmt, () => 0, { proc: fakeProc().proc, words: W });
  bar.start(10, "A".repeat(100));
  bar.tick(5, "B".repeat(100));
  assert.ok(f.text().split("\n").every((l) => displayWidth(l) <= 40));
});

test("process exit during a bar: the exit hook restores the cursor and finishes the line", () => {
  const f = fakeTerm();
  const p = fakeProc();
  const bar = progressBar(f.term, f.style, fmt, () => 0, { proc: p.proc, words: W });
  bar.start(10, "x");
  bar.tick(3);
  const before = f.out.length;
  p.em.emit("exit");
  assert.equal(f.out.slice(before).join(""), "\x1b[?25h\n");
  p.em.emit("exit"); // a second time does nothing
  assert.equal(f.out.length, before + 1);
  void bar;
});

test("SIGINT cleans up and exits 130 only when nobody else handles it", () => {
  const f = fakeTerm();
  const p = fakeProc();
  progressBar(f.term, f.style, fmt, () => 0, { proc: p.proc, words: W }).start(10, "x");
  p.em.emit("SIGINT");
  assert.ok(f.text().endsWith("\x1b[?25h\n"));
  assert.deepEqual(p.exits, [130]);
  const g = fakeTerm();
  const q = fakeProc();
  q.em.on("SIGINT", () => {});
  progressBar(g.term, g.style, fmt, () => 0, { proc: q.proc, words: W }).start(10, "x");
  q.em.emit("SIGINT");
  assert.deepEqual(q.exits, []);
});

test("spinner silent under 300 ms", async () => {
  const f = fakeTerm();
  const clk = { t: 1000 };
  const sp = spinner(f.term, f.style, "Reading", clockOf(clk), { intervalMs: 5, proc: fakeProc().proc });
  clk.t = 1200;
  await new Promise((r) => setTimeout(r, 40));
  sp.stop("done");
  assert.equal(f.text(), "done\n", "never shown: just the final line, nothing to clear");
});

test("spinner shows after 300 ms on a TTY, and stop replaces it with the final line", async () => {
  const f = fakeTerm();
  const clk = { t: 1000 };
  const sp = spinner(f.term, f.style, "Reading", clockOf(clk), { intervalMs: 5, proc: fakeProc().proc });
  clk.t = 1400;
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(f.text().includes("Reading") && f.text().includes("\r"));
  sp.stop("Read 12 files");
  sp.stop(); // twice is safe
  assert.ok(f.text().endsWith("\r\x1b[KRead 12 files\n\x1b[?25h"));
});

test("spinner never writes off a TTY", async () => {
  const f = fakeTerm({ tty: false });
  const clk = { t: 0 };
  const sp = spinner(f.term, f.style, "Reading", clockOf(clk), { intervalMs: 5, proc: fakeProc().proc });
  clk.t = 5000;
  await new Promise((r) => setTimeout(r, 30));
  sp.stop("x");
  assert.equal(f.text(), "x\n");
  const g = fakeTerm({ tty: false });
  spinner(g.term, g.style, "Reading", () => 0, { proc: fakeProc().proc }).stop();
  assert.equal(g.text(), "");
});

test("TERM=dumb (TTY without cursor control): bar uses milestone lines, spinner never draws", async () => {
  const f = fakeTerm({ cursor: false });
  const bar = progressBar(f.term, f.style, fmt, () => 0, { proc: fakeProc().proc, words: W });
  bar.start(10, "Importing");
  for (let i = 1; i <= 10; i++) bar.tick(i);
  bar.end("Done");
  assert.ok(!f.text().includes("\x1b") && !f.text().includes("\r"));
  assert.ok(f.text().split("\n").filter((l) => l).length <= 12);
  const clk = { t: 0 };
  const sp = spinner(f.term, f.style, "x", clockOf(clk), { intervalMs: 5, proc: fakeProc().proc });
  clk.t = 5000;
  await new Promise((r) => setTimeout(r, 30));
  const before = f.text();
  sp.stop();
  assert.equal(f.text(), before);
});

test("another SIGINT owner keeps the bar alive: no abort, no exit, tick and end still render", () => {
  const f = fakeTerm();
  const p = fakeProc();
  p.em.on("SIGINT", () => {});
  const bar = progressBar(f.term, f.style, fmt, () => 0, { proc: p.proc, words: W });
  bar.start(10, "x");
  p.em.emit("SIGINT");
  assert.deepEqual(p.exits, []);
  assert.ok(f.text().includes("[?25h"), "cursor given back at once, in case the owner re-raises");
  bar.tick(10);
  bar.end("Stopped after this wave");
  assert.ok(f.text().includes("Stopped after this wave"));
  assert.ok(f.text().endsWith("\x1b[?25h"));
});

test("another SIGINT owner keeps the spinner alive too", async () => {
  const f = fakeTerm();
  const p = fakeProc();
  p.em.on("SIGINT", () => {});
  const clk = { t: 0 };
  const sp = spinner(f.term, f.style, "Reading", clockOf(clk), { intervalMs: 5, proc: p.proc });
  clk.t = 1000;
  await new Promise((r) => setTimeout(r, 40));
  p.em.emit("SIGINT");
  assert.deepEqual(p.exits, []);
  sp.stop("Done");
  assert.ok(f.text().includes("Done\n"));
});

test("Ctrl+C with the bar as the only owner: terminal restored, exit 130", () => {
  const f = fakeTerm();
  const p = fakeProc();
  progressBar(f.term, f.style, fmt, () => 0, { proc: p.proc, words: W }).start(5, "x");
  p.em.emit("SIGINT");
  assert.deepEqual(p.exits, [130]);
  assert.ok(f.text().endsWith("\x1b[?25h\n"));
});

test("start twice does not leak listeners; dispose releases them (bar)", () => {
  const f = fakeTerm();
  const p = fakeProc();
  const bar = progressBar(f.term, f.style, fmt, () => 0, { proc: p.proc, words: W });
  bar.start(5, "a");
  bar.start(5, "b");
  assert.equal(p.em.listenerCount("exit"), 1);
  assert.equal(p.em.listenerCount("SIGINT"), 1);
  bar.end("ok");
  assert.equal(p.em.listenerCount("exit") + p.em.listenerCount("SIGINT"), 0);
  bar.start(5, "c");
  bar.dispose();
  bar.dispose();
  assert.equal(p.em.listenerCount("exit") + p.em.listenerCount("SIGINT"), 0);
  assert.ok(f.text().endsWith("\x1b[?25h\n"));
});

test("spinner dispose releases the hook and the timer", async () => {
  const f = fakeTerm();
  const p = fakeProc();
  const clk = { t: 0 };
  const sp = spinner(f.term, f.style, "x", clockOf(clk), { intervalMs: 5, proc: p.proc });
  clk.t = 1000;
  await new Promise((r) => setTimeout(r, 30));
  sp.dispose();
  assert.equal(p.em.listenerCount("exit") + p.em.listenerCount("SIGINT"), 0);
  const n = f.out.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.out.length, n, "timer stopped");
});

test("note(): clears the bar, prints the line, redraws the bar", () => {
  const f = fakeTerm();
  const clk = { t: 0 };
  const bar = progressBar(f.term, f.style, fmt, clockOf(clk), { proc: fakeProc().proc, words: W });
  bar.start(10, "x");
  clk.t = 100;
  bar.tick(4);
  const n = f.out.length;
  bar.note("! worth knowing");
  const after = f.out.slice(n).join("");
  const head = "\r\x1b[K! worth knowing\n";
  assert.ok(after.startsWith(head), after);
  assert.ok(/\r.*4\/10/.test(after.slice(head.length)));
  const g = fakeTerm({ tty: false });
  const b2 = progressBar(g.term, g.style, fmt, () => 0, { proc: fakeProc().proc, words: W });
  b2.start(10, "x");
  b2.note("hello");
  assert.ok(g.text().includes("hello\n"));
});

test("no TTY: a long summary is cut to two lines so the 12-line cap holds", () => {
  const f = fakeTerm({ tty: false, columns: 40 });
  const bar = progressBar(f.term, f.style, fmt, () => 0, { proc: fakeProc().proc, words: W });
  bar.start(10, "x");
  for (let i = 1; i <= 10; i++) bar.tick(i);
  bar.end("word ".repeat(60));
  const lines = f.text().split("\n").filter((l) => l);
  assert.ok(lines.length <= 12 && lines.every((l) => displayWidth(l) <= 40));
});

test("a SIGINT owner registered after the bar that re-raises the signal: the cursor is shown before the process dies", () => {
  const f = fakeTerm();
  const p = fakeProc();
  const bar = progressBar(f.term, f.style, fmt, () => 0, { proc: p.proc, words: W });
  bar.start(10, "x");
  p.em.on("SIGINT", () => { /* kills children, then re-raises: no exit event follows */ });
  p.em.emit("SIGINT");
  assert.ok(f.text().includes("\x1b[?25h"), "cursor restored right away");
  assert.deepEqual(p.exits, []);
  bar.end("Stopped");
  assert.ok(f.text().includes("Stopped"));
});

test("same for the spinner", async () => {
  const f = fakeTerm();
  const p = fakeProc();
  const clk = { t: 0 };
  const sp = spinner(f.term, f.style, "Reading", clockOf(clk), { intervalMs: 5, proc: p.proc });
  clk.t = 1000;
  await new Promise((r) => setTimeout(r, 40));
  p.em.on("SIGINT", () => {});
  p.em.emit("SIGINT");
  assert.ok(f.text().includes("\x1b[?25h"));
  sp.stop();
});

test("detached stop/dispose of a spinner still work", () => {
  const f = fakeTerm();
  const { dispose } = spinner(f.term, f.style, "x", () => 0, { proc: fakeProc().proc, intervalMs: 5 });
  dispose();
});

test("no TTY: the summary may take two lines, the cap still holds", () => {
  const f = fakeTerm({ tty: false, columns: 40 });
  const bar = progressBar(f.term, f.style, fmt, () => 0, { proc: fakeProc().proc, words: W });
  bar.start(10, "x");
  for (let i = 1; i <= 10; i++) bar.tick(i);
  bar.end("word ".repeat(30));
  const lines = f.text().split("\n").filter((l) => l);
  assert.equal(lines.length, 12);
  assert.ok(lines.every((l) => displayWidth(l) <= 40));
  assert.ok(lines.at(-1)!.endsWith("...") || lines.at(-1)!.endsWith("…"));
});

test("text written by the bar and the spinner never carries ESC or bidi controls", async () => {
  const evil = "a" + String.fromCharCode(27) + "[31mred" + String.fromCharCode(0x202e) + "b";
  const bad = (t: string): boolean => /[\u001b\u202e\u0000-\u0008]/.test(t.replace(/\u001b\[\?25[lh]|\u001b\[K/g, ""));
  for (const tty of [true, false]) {
    const f = fakeTerm({ tty });
    const clk = { t: 0 };
    const bar = progressBar(f.term, f.style, fmt, clockOf(clk), { proc: fakeProc().proc, words: W });
    bar.start(10, evil);
    clk.t = 1000;
    bar.tick(5, evil);
    bar.note(evil);
    bar.end(evil);
    assert.ok(!bad(f.text()), JSON.stringify(f.text()));
    assert.ok(f.text().includes("red"));
  }
  const f = fakeTerm();
  const clk = { t: 0 };
  const sp = spinner(f.term, f.style, evil, clockOf(clk), { intervalMs: 5, proc: fakeProc().proc });
  clk.t = 1000;
  await new Promise((r) => setTimeout(r, 40));
  sp.stop(evil);
  assert.ok(!bad(f.text()), JSON.stringify(f.text()));
});

test("line and paragraph separators (U+2028, U+2029) and other non-printables fold to a space; a ZWJ emoji stays whole", () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  for (const tty of [true, false]) {
    const f = fakeTerm({ tty, columns: 80 });
    const bar = progressBar(f.term, f.style, fmt, () => 0, { proc: fakeProc().proc, words: W });
    bar.start(10, "x");
    bar.note(`one\u2028two\u2029three\u{E000}four ${family} done`);
    bar.end("ok");
    const t = f.text();
    assert.ok(t.includes("one two three four"), JSON.stringify(t));
    assert.doesNotMatch(t, /[\u2028\u2029\u{E000}]/u);
    assert.ok(t.includes(family), "the family emoji (joined by U+200D) is kept as one cluster");
  }
});

test("a subdivision flag (emoji tag characters U+E0020 to U+E007F) is kept whole", () => {
  const england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
  const f = fakeTerm({ tty: false, columns: 80 });
  const bar = progressBar(f.term, f.style, fmt, () => 0, { proc: fakeProc().proc, words: W });
  bar.start(10, "x");
  bar.note(`flag ${england} here`);
  bar.end("ok");
  assert.ok(f.text().includes(`flag ${england} here`), JSON.stringify(f.text()));
});

test("progress.ts writes no invisible character literally (the ZWJ is an escape)", () => {
  const src = readFileSync(new URL("../../src/ui/progress.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/);
});

test("the time-left words are a template (\"{t} left\" / \"faltam {t}\"); the milestone start can leave out the total", () => {
  for (const [left, want] of [["{t} left", "1 min 29 s left"], ["faltam {t}", "faltam 1 min 29 s"]] as const) {
    const f = fakeTerm();
    const clk = { t: 0 };
    const bar = progressBar(f.term, f.style, fmt, clockOf(clk), { proc: fakeProc().proc, words: { left } });
    bar.start(4007, "Importing");
    clk.t = 40_000;
    bar.tick(1234);
    const line = f.out.filter((x) => x.startsWith("\r")).at(-1)!;
    assert.ok(line.includes(want), line);
    bar.dispose();
  }
  const pipe = fakeTerm({ tty: false });
  const a = progressBar(pipe.term, pipe.style, fmt, () => 0, { proc: fakeProc().proc, words: W, showTotal: false });
  a.start(5, "Importing 5 conversations");
  a.dispose();
  assert.equal(pipe.text(), "Importing 5 conversations\n");
  const pipe2 = fakeTerm({ tty: false });
  const b = progressBar(pipe2.term, pipe2.style, fmt, () => 0, { proc: fakeProc().proc, words: W });
  b.start(5, "Importing");
  b.dispose();
  assert.equal(pipe2.text(), "Importing (5)\n", "the default keeps the total");
});
