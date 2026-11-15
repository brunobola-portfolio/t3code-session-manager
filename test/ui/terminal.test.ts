// The Node side of the terminal: key mapping, unicode and colour detection, raw mode. Fake streams only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { detectUnicode, nodeTerm, toTermKey } from "../../src/ui/terminal.ts";

function streams(o: { tty?: boolean } = {}) {
  const calls: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: o.tty ?? true,
    setRawMode(on: boolean) { calls.push(`raw:${on}`); },
    resume() { calls.push("resume"); }, pause() { calls.push("pause"); },
  });
  const out: string[] = [];
  const stdout = { isTTY: o.tty ?? true, columns: 100, rows: 30, write: (s: string) => { out.push(s); return true; } };
  return { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, emitter: stdin, calls, out, raw: stdout };
}

test("toTermKey: special keys by name, typed text in ch, control combinations carry no text", () => {
  assert.deepEqual(toTermKey("\u001b[A", { name: "up", sequence: "\u001b[A" }), { name: "up", ch: "", ctrl: false, meta: false });
  assert.deepEqual(toTermKey("j", { name: "j" }), { name: "j", ch: "j", ctrl: false, meta: false });
  assert.deepEqual(toTermKey(" ", { name: "space" }), { name: "space", ch: " ", ctrl: false, meta: false });
  assert.deepEqual(toTermKey("\u0003", { name: "c", ctrl: true }), { name: "c", ch: "", ctrl: true, meta: false });
  assert.equal(toTermKey("\r", { name: "return" }).ch, "");
  assert.equal(toTermKey("\x7f", { name: "backspace" }).ch, "");
  assert.equal(toTermKey("é", undefined).ch, "é");
});

test("detectUnicode: Windows Terminal and VS Code yes, bare conhost no; elsewhere by the UTF-8 locale", () => {
  assert.equal(detectUnicode({ WT_SESSION: "x" }, "win32"), true);
  assert.equal(detectUnicode({ TERM_PROGRAM: "vscode" }, "win32"), true);
  assert.equal(detectUnicode({}, "win32"), false);
  assert.equal(detectUnicode({ LANG: "pt_PT.UTF-8" }, "linux"), true);
  assert.equal(detectUnicode({ LANG: "C" }, "linux"), false);
  assert.equal(detectUnicode({}, "darwin"), true);
});

test("nodeTerm: size, NO_COLOR, writes, raw mode on and off, keys until unsubscribed", () => {
  const s = streams();
  const t = nodeTerm({ stdin: s.stdin, stdout: s.stdout, env: {}, platform: "linux" });
  assert.deepEqual([t.isTTY, t.columns, t.rows, t.color], [true, 100, 30, true]);
  s.raw.columns = 0; // a terminal that does not say: defaults
  assert.deepEqual([t.columns, t.rows], [80, 30]);
  t.write("hi");
  assert.deepEqual(s.out, ["hi"]);
  t.setRaw(true);
  const keys: string[] = [];
  const off = t.onKey((k) => keys.push(k.name));
  s.emitter.emit("keypress", "j", { name: "j" });
  off();
  s.emitter.emit("keypress", "k", { name: "k" });
  t.setRaw(false);
  assert.deepEqual(keys, ["j"]);
  assert.deepEqual(s.calls, ["raw:true", "resume", "raw:false", "pause"]);
  assert.equal(nodeTerm({ stdin: s.stdin, stdout: s.stdout, env: { NO_COLOR: "1" }, platform: "linux" }).color, false);
  assert.equal(nodeTerm({ stdin: s.stdin, stdout: s.stdout, env: { TERM: "dumb" }, platform: "linux" }).color, false);
});

test("nodeTerm without a TTY: not a TTY, no colour, raw mode never touched", () => {
  const s = streams({ tty: false });
  const t = nodeTerm({ stdin: s.stdin, stdout: s.stdout, env: {}, platform: "linux" });
  t.setRaw(true);
  t.setRaw(false);
  assert.deepEqual([t.isTTY, t.color, s.calls], [false, false, []]);
});

const sink = () => { const out: string[] = []; return { out, stdout: { isTTY: false, columns: 80, rows: 24, write: (s: string) => { out.push(s); return true; } } as unknown as NodeJS.WriteStream }; };

test("readLine keeps lines that arrive together on piped input", async () => {
  const stdin = new PassThrough();
  const k = sink();
  const t = nodeTerm({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: k.stdout, env: {}, platform: "linux" });
  stdin.write("2 3\n" + "\n");
  assert.equal(await t.readLine("q1: "), "2 3");
  assert.equal(await t.readLine("q2: "), "");
  stdin.write("late\n");
  assert.equal(await t.readLine("q3: "), "late");
  assert.deepEqual(k.out, ["q1: ", "q2: ", "q3: "]);
  const pending = t.readLine("q4: ");
  stdin.end();
  assert.equal(await pending, null, "closed input answers null");
  assert.equal(await t.readLine("q5: "), null);
  t.dispose?.();
});

test("keys through the real keypress path: CR and LF are return, PgUp is pageup; end of input calls onEnd", async () => {
  const stdin = new PassThrough();
  const t = nodeTerm({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: sink().stdout, env: {}, platform: "linux" });
  const names: string[] = [];
  let ended = 0;
  const off = t.onKey((k) => names.push(k.name), () => ended++);
  stdin.write("\r");
  stdin.write("\n");
  stdin.write("\x1b[5~");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(names, ["return", "return", "pageup"]);
  stdin.end();
  await new Promise((r) => setImmediate(r));
  assert.equal(ended, 1);
  off();
});

test("raw mode: an exit hook shows the cursor and leaves raw mode; normal cleanup removes it", () => {
  const s = streams();
  const proc = new EventEmitter();
  const t = nodeTerm({ stdin: s.stdin, stdout: s.stdout, env: {}, platform: "linux", proc });
  t.setRaw(true);
  assert.equal(proc.listenerCount("exit"), 1);
  proc.emit("exit");
  assert.deepEqual(s.out, ["\x1b[?25h"]);
  assert.equal(s.calls.at(-1), "raw:false");
  t.setRaw(false);
  assert.equal(proc.listenerCount("exit"), 0);
  t.setRaw(true);
  t.setRaw(false);
  assert.equal(proc.listenerCount("exit"), 0);
});

test("nodeTerm: colour and unicode follow detectCaps (FORCE_COLOR works off a TTY)", () => {
  const s = streams({ tty: false });
  const t = nodeTerm({ stdin: s.stdin, stdout: s.stdout, env: { FORCE_COLOR: "3" }, platform: "linux" });
  assert.deepEqual([t.isTTY, t.color, t.caps?.color, t.unicode], [false, true, 3, true]);
});
