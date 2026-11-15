// Small layout helpers the command screens share on top of the UI kit (src/ui/components.ts): a line that may be wider
// than the window is wrapped (its styling dropped, as the components do), and a lead line is a symbol plus a word.

import type { Style, Token } from "./style.ts";
import { kv, table, type Column } from "./components.ts";
import { displayWidth, stripAnsi, truncateEnd, wrapText } from "./text.ts";

/** `line` as it is when it fits `width`, else wrapped plain (continuation lines indented by `hang`). */
export function fitLine(line: string, width: number, hang = 0): string[] {
  const w = Math.max(1, width);
  if (displayWidth(line) <= w) return [line];
  const plain = stripAnsi(line).replace(/[\r\n\t]+/g, " ");
  // A leading indent stays on every line (when it leaves room to wrap in).
  const lead = /^ */.exec(plain)![0].length;
  const ind = lead > 0 && w - lead >= 8 ? lead : 0;
  return wrapText(plain.slice(ind), w - ind, { hang: Math.min(hang, Math.max(0, w - ind - 2)) }).map((l) => (" ".repeat(ind) + l).replace(/ +$/, ""));
}

/** Every line fitted to `width`. */
export function fitAll(lines: string[], width: number, hang = 0): string[] {
  return lines.flatMap((l) => fitLine(l, width, hang));
}

/**
 * `✓ All good · t3sm does not need anything from you`: the symbol and the word in the tone, then a muted note on the
 * same line when it fits; on a narrow window the note goes on the lines below, indented under the word and wrapped,
 * never cut.
 */
export function leadLines(s: Style, o: { sym: string; tone: Token; word: string; note?: string }, width: number): string[] {
  const w = Math.max(1, width);
  const head = `${o.sym} ${o.word}`;
  if (displayWidth(head) >= w) return [s(o.tone, truncateEnd(head, w, s.sym.ellipsis))];
  const first = s(o.tone, o.sym) + " " + s("title", o.word);
  if (!o.note) return [first];
  const sep = ` ${s.sym.sep} `;
  if (displayWidth(head) + displayWidth(sep) + displayWidth(o.note) <= w) return [first + s("muted", sep + o.note)];
  const hang = displayWidth(`${o.sym} `);
  return [first, ...wrapText(o.note, Math.max(1, w - hang)).map((l) => " ".repeat(hang) + s("muted", l))];
}

/**
 * Atoms laid out to `width`, one space between them: an atom (a command, a help topic) is never split across lines, a
 * continuation line is indented by `hang`. Only an atom wider than a whole line is broken (plain).
 */
export function flowAtoms(atoms: string[], width: number, hang = 2): string[] {
  const w = Math.max(1, width);
  const h = Math.min(Math.max(0, hang), Math.max(0, w - 2));
  const out: string[] = [];
  let line = "";
  for (const a of atoms) {
    if (a === "") continue;
    if (line !== "" && line.trim() !== "" && displayWidth(line) + 1 + displayWidth(a) <= w) { line += " " + a; continue; }
    if (line.trim() !== "") { out.push(line); line = " ".repeat(h); }
    if (displayWidth(line) + displayWidth(a) <= w) { line += a; continue; }
    // Wider than a line: broken plain, the rest continues after it.
    const pieces = wrapText(stripAnsi(a), Math.max(1, w - displayWidth(line)));
    line += pieces[0]!;
    for (const p of pieces.slice(1)) { out.push(line); line = " ".repeat(h) + p; }
  }
  if (line.trim() !== "") out.push(line);
  return out.map((l) => l.replace(/ +$/, ""));
}

/**
 * Text with `backticked` commands as atoms: the words, and each command whole and in the `key` style, without its
 * backticks (punctuation right after a command stays with it).
 */
export function richAtoms(s: Style, text: string): string[] {
  const atoms: string[] = [];
  const parts = text.split(/`([^`]*)`/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // Punctuation right before a command stays with it too ("(`t3sm runs`)").
      if (atoms.length > 0 && parts[i - 1] !== "" && !/\s$/.test(parts[i - 1]!)) atoms[atoms.length - 1] += s("key", part);
      else atoms.push(s("key", part));
      return;
    }
    const glue = atoms.length > 0 && part !== "" && !/^\s/.test(part);
    const words = part.split(/\s+/).filter((x) => x !== "");
    if (glue && words.length > 0) atoms[atoms.length - 1] += words.shift()!;
    atoms.push(...words);
  });
  return atoms;
}

/** A panel as wide as its content (title and body) needs, up to `width`: no wide empty block beside short rows. */
export function snugWidth(title: string, body: string[], width: number): number {
  const content = Math.max(0, ...body.map(displayWidth)) + 4;
  const head = displayWidth(title) + 8;
  return Math.max(1, Math.min(width, Math.max(content, head, 24)));
}

/**
 * Atoms (styled words, commands) wrapped greedily: the first line holds at most `first` cells, every other `rest`. An
 * atom is never split unless it is wider than a whole line: a command then wraps at its own spaces (plain, each word
 * whole: `t3sm rollback --run <id>` never cuts the run id), and only a single word wider than a line is broken. Lines
 * carry no indent and no trailing space; the caller indents them.
 */
export function wrapAtoms(atoms: string[], first: number, rest: number): string[] {
  const out: string[] = [];
  let line = "";
  const room = (): number => Math.max(1, out.length === 0 ? first : rest);
  const queue = [...atoms];
  while (queue.length > 0) {
    const a = queue.shift()!;
    if (a === "") continue;
    if (line !== "" && displayWidth(line) + 1 + displayWidth(a) <= room()) { line += " " + a; continue; }
    if (displayWidth(a) > room() && /\S\s+\S/.test(stripAnsi(a))) {
      // A command wider than a line: its words, plain, wrapped like the others (the first may still join this line).
      queue.unshift(...stripAnsi(a).trim().split(/\s+/));
      continue;
    }
    if (line !== "") { out.push(line); line = ""; }
    if (displayWidth(a) <= room()) { line = a; continue; }
    // Wider than a line: broken plain; what is left continues after it.
    let rem = stripAnsi(a);
    while (displayWidth(rem) > room()) {
      const piece = truncateEnd(rem, room(), "") || [...rem][0]!;
      out.push(piece);
      rem = rem.slice(piece.length);
    }
    line = rem;
  }
  if (line !== "") out.push(line);
  return out.map((l) => l.replace(/ +$/, ""));
}

/** A bullet: `  • text`, wrapped with the text hanging under itself; `backticked` commands stay whole, in the key style. */
export function bulletLines(s: Style, text: string, width: number, indent = 2): string[] {
  const lead = " ".repeat(indent) + s.sym.bullet + " ";
  const hang = displayWidth(lead);
  return wrapAtoms(richAtoms(s, text), width - hang, width - hang).map((l, i) => (i === 0 ? s("muted", lead) : " ".repeat(hang)) + l);
}

/**
 * A titled list: "Title (n)" in bold, then each item as a bullet; at most `max` items (default 50), then "… and N
 * more" (`more`, already worded in the user's language). An empty list gives no lines.
 */
export function sectionLines(s: Style, title: string, items: string[], width: number, o: { max?: number; more?: (n: number) => string } = {}): string[] {
  if (items.length === 0) return [];
  const max = o.max ?? 50;
  const out = fitLine(s("title", `${title} (${items.length})`), width, 2);
  for (const x of items.slice(0, max)) out.push(...bulletLines(s, x, width));
  if (items.length > max) out.push(...fitLine(s("muted", `  ${s.sym.ellipsis} ${o.more ? o.more(items.length - max) : `+${items.length - max}`}`), width, 4));
  return out;
}

/** One statement with its symbol (✓ done, ! warning, ✗ failed, › next), wrapped; `backticked` commands in the key style. */
export function noteLines(s: Style, tone: "ok" | "warn" | "err" | "info", text: string, width: number): string[] {
  const sym = tone === "ok" ? s("ok", s.sym.ok) : tone === "warn" ? s("warn", s.sym.warn) : tone === "err" ? s("err", s.sym.err) : s("accent", s.sym.arrow);
  return wrapAtoms(richAtoms(s, text), width - 2, width - 2).map((l, i) => (i === 0 ? sym + " " : "  ") + l);
}

/**
 * `prefix` then `text` (a path: no spaces to wrap at), broken wherever the width ends; continuation lines are indented
 * by `hang`. Used where a path must be shown whole.
 */
export function hardLines(prefix: string, text: string, width: number, hang: number): string[] {
  const out: string[] = [];
  let line = prefix;
  for (const ch of text) {
    if (displayWidth(line) + displayWidth(ch) > Math.max(hang + 1, width)) { out.push(line); line = " ".repeat(hang); }
    line += ch;
  }
  out.push(line);
  return out;
}

/** Plain text wrapped to `width` (commands in the key style), no symbol. */
export function textLines(s: Style, text: string, width: number, indent = 0): string[] {
  return wrapAtoms(richAtoms(s, text), width - indent, width - indent).map((l) => " ".repeat(indent) + l);
}

/** Every spelling of the home folder in `text` (either separator, any case) shown as `~`: shorter, and no user name. */
export function homeAsTilde(text: string, home: string): string {
  const h = home.replace(/[\\/]+$/, "");
  if (h === "") return text;
  const esc = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const variants = [...new Set([h, h.replace(/\\/g, "/"), h.replace(/\//g, "\\")])].map(esc);
  // Followed by a separator, the end, or anything that ends a word (a quote, a bracket, a space): never a longer name.
  return text.replace(new RegExp(`(?:${variants.join("|")})(?=[\\\\/]|\\b|$)`, "gi"), "~");
}

/**
 * Rows as a table when it fits, else one block per row (its first column as the heading, the others as aligned
 * "header  value" rows), so a narrow window never cuts a value or loses a column. It fits when every column has its
 * full width, or, with `allowMin`, its `min` (only for a column whose cut is harmless, such as a path cut in the
 * middle: the table shrinks it).
 */
export function tableOrBlocks(s: Style, cols: Column[], rows: unknown[], width: number, o: { allowMin?: boolean } = {}): string[] {
  const w = Math.max(1, width);
  const need = cols.reduce((n, c) => {
    const natural = Math.max(displayWidth(c.header), ...rows.map((r) => displayWidth(c.get(r))));
    return n + (o.allowMin && c.min !== undefined ? Math.min(natural, c.min) : natural) + 2;
  }, -2);
  if (need <= w) return table(s, cols, rows, w);
  const out: string[] = [];
  for (const r of rows) {
    if (out.length > 0) out.push("");
    const [head, ...rest] = cols;
    out.push(...fitLine(s("title", head!.get(r)), w, 2));
    out.push(...kv(s, rest.filter((c) => c.header !== "" && c.get(r) !== "").map((c): [string, string] => [c.header, c.get(r)]), Math.max(1, w - 2)).map((l) => "  " + l));
  }
  return out;
}
