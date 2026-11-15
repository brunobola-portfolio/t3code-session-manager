// Terminal components: pure functions from (style, data, width) to lines. They never write, every returned line is at
// most `width` cells wide (`displayWidth`), no line has trailing spaces, there is no ESC when `s.caps.color` is 0, and
// every glyph comes from `s.sym`, so the ASCII fallback draws the same layout. Text that does not fit is cut with
// `s.sym.ellipsis`. Content passed in may carry ANSI (it is measured by its visible width); when such a line has to be
// wrapped or cut, its styling is dropped rather than split mid-sequence. Callers sanitise untrusted text (session
// titles, paths from disk) with `shownText` (src/plan/names.ts) before passing it in; here only line breaks and tabs
// are flattened.

import type { Style } from "./style.ts";
import { displayWidth, padEnd, stripAnsi, truncateEnd, truncateMiddle, wrapText } from "./text.ts";

const flat = (s: string): string => s.replace(/[\r\n\t]+/g, " ");
const rtrim = (s: string): string => s.replace(/ +$/, "");
const cap = (w: number): number => Math.max(1, Math.floor(w) || 1);

/** One logical line as lines of at most `w` cells: kept as is when it fits, else wrapped (plain). */
function wrapLine(line: string, w: number): string[] {
  const t = flat(line);
  return displayWidth(t) <= w ? [t] : wrapText(stripAnsi(t), w);
}

/** `t3sm 0.3.0 · subtitle` over a rule. */
export function appHeader(s: Style, o: { version: string; subtitle?: string }, width: number): string[] {
  const w = cap(width);
  const name = `t3sm ${o.version}`;
  const sep = ` ${s.sym.sep} `;
  const room = w - displayWidth(name) - displayWidth(sep);
  let line: string;
  if (displayWidth(name) > w) line = s("title", truncateEnd(name, w, s.sym.ellipsis));
  else if (o.subtitle && room >= 4) line = s("title", "t3sm") + " " + s("muted", o.version + sep + truncateEnd(flat(o.subtitle), room, s.sym.ellipsis));
  else line = s("title", "t3sm") + " " + s("muted", o.version);
  return [line, s("muted", s.sym.h.repeat(w))];
}

/** `● ● ● ○ ○  Step 3 of 11 · Accounts`; under 60 columns (or when it cannot fit) `3/11 · Accounts`. */
export function stepHeader(
  s: Style,
  o: { n: number; total: number; title: string; done: number[]; word: { step: string; of: string } },
  width: number,
): string[] {
  const w = cap(width);
  const sep = ` ${s.sym.sep} `;
  const word = o.word;
  const label = `${word.step} ${o.n} ${word.of} ${o.total}`;
  const title = flat(o.title);
  const railW = Math.max(0, 2 * o.total - 1);
  const room = w - railW - 2;
  if (w >= 60 && room >= displayWidth(label) + displayWidth(sep) + 4) {
    const dots: string[] = [];
    for (let i = 1; i <= o.total; i++) dots.push(i === o.n ? s("title", s.sym.cur) : o.done.includes(i) ? s("accent", s.sym.dot) : s("muted", s.sym.ring));
    const text = truncateEnd(label + sep + title, room, s.sym.ellipsis);
    return [dots.join(" ") + "  " + s("title", text)];
  }
  const short = `${o.n}/${o.total}`;
  const rest = w - displayWidth(short) - displayWidth(sep);
  if (rest < 1) return [s("accent", truncateEnd(short, w, s.sym.ellipsis))];
  return [s("accent", short) + s("muted", sep) + s("title", truncateEnd(title, rest, s.sym.ellipsis))];
}

/** A rounded box (`╭─ Title ──╮`) around `body`; the tone colours the border and puts a symbol before the title. */
export function panel(s: Style, o: { title?: string; body: string[]; tone?: "plain" | "ok" | "warn" | "err" }, width: number): string[] {
  const w = cap(width);
  const tone = o.tone ?? "plain";
  const tok = tone === "plain" ? "muted" : tone;
  const toneSym = tone === "ok" ? s.sym.ok : tone === "warn" ? s.sym.warn : tone === "err" ? s.sym.err : "";
  const heading = [toneSym, o.title ? flat(o.title) : ""].filter((x) => x !== "").join(" ");
  const sym = s.sym;
  if (w < 6) return [...(heading ? [truncateEnd(heading, w, sym.ellipsis)] : []), ...o.body.flatMap((b) => wrapLine(b, w))];
  const inner = w - 4;
  // A title too long for the top border is wrapped at a word, never cut: the rest opens the body, in bold. A title made
  // of parts ("Plan R1 · T3 Code 0.1.9") breaks between its parts first, so a part ("T3 Code") stays together.
  const parts = heading.split(` ${sym.sep} `);
  const titleLines = heading === "" ? []
    : displayWidth(heading) > w - 6 && parts.length > 1 ? parts.flatMap((x, i) => wrapText(x, i === 0 ? w - 6 : inner))
    : wrapText(heading, w - 6);
  const first = titleLines[0] ?? "";
  const top = heading !== ""
    ? s(tok, sym.tl + sym.h + " ") + s("title", first) + s(tok, " " + sym.h.repeat(Math.max(0, w - 5 - displayWidth(first))) + sym.tr)
    : s(tok, sym.tl + sym.h.repeat(w - 2) + sym.tr);
  const out = [top];
  for (const l of titleLines.slice(1).flatMap((x) => wrapLine(x, inner))) out.push(s(tok, sym.v) + " " + padEnd(s("title", l), inner) + " " + s(tok, sym.v));
  for (const b of o.body) for (const l of wrapLine(b, inner)) out.push(s(tok, sym.v) + " " + padEnd(l, inner) + " " + s(tok, sym.v));
  out.push(s(tok, sym.bl + sym.h.repeat(w - 2) + sym.br));
  return out;
}

/**
 * Aligned `label  value` rows. A label is never cut: the label column is as wide as the longest label, and values wrap
 * under the value column. When that leaves the values less than 10 cells, every label stands over its value instead.
 */
export function kv(s: Style, rows: [string, string][], width: number): string[] {
  const w = cap(width);
  if (rows.length === 0) return [];
  const labels = rows.map(([k]) => flat(k));
  const labelW = Math.max(...labels.map(displayWidth));
  const valueW = w - labelW - 2;
  // A value's longest word (an id, a path, a command) is never broken when stacking keeps it whole: only the rows that
  // need it stand over their value; the others stay aligned.
  const longest = (v: string): number => Math.max(0, ...stripAnsi(flat(v)).split(" ").map(displayWidth));
  const out: string[] = [];
  const ind = w >= 4 ? 2 : 0;
  const stacked = (label: string, v: string): void => {
    out.push(s("muted", truncateEnd(label, w, s.sym.ellipsis)));
    for (const l of wrapLine(v, w - ind)) if (l !== "") out.push(" ".repeat(ind) + l);
  };
  if (valueW < 10) {
    rows.forEach(([, v], i) => stacked(labels[i]!, v));
    return out.map(rtrim);
  }
  rows.forEach(([, v], i) => {
    const word = longest(v);
    if (word > valueW && word <= w - ind) { stacked(labels[i]!, v); return; }
    const label = truncateEnd(labels[i]!, labelW, s.sym.ellipsis);
    const lines = wrapLine(v, valueW);
    out.push(rtrim(s("muted", label) + " ".repeat(labelW - displayWidth(label) + 2) + lines[0]!));
    for (const l of lines.slice(1)) out.push(rtrim(" ".repeat(labelW + 2) + l));
  });
  return out;
}

export interface Column {
  header: string;
  get(r: unknown): string;
  align?: "left" | "right";
  /** Narrowest width this column accepts before it is dropped (default: 8; 16 for `truncate: "middle"` columns; the natural width for right-aligned ones). */
  min?: number;
  /** Higher stays longer: when the table is too narrow the lowest priority column goes first (ties: the rightmost). Default 0. */
  priority?: number;
  truncate?: "end" | "middle";
}

/** A table fitted to `width`: whole low-priority columns are dropped first, then the widest columns are cut. Never wraps. */
export function table(s: Style, cols: Column[], rows: unknown[], width: number): string[] {
  const w = cap(width);
  if (cols.length === 0) return [];
  const GAP = 2;
  const cells = cols.map((c) => rows.map((r) => flat(c.get(r))));
  const natural = cols.map((c, i) => Math.max(displayWidth(flat(c.header)), ...cells[i]!.map(displayWidth)));
  const min = cols.map((c, i) => Math.max(1, Math.min(natural[i]!, c.min ?? (c.align === "right" ? natural[i]! : c.truncate === "middle" ? 16 : 8))));
  let visible = cols.map((_, i) => i);
  const need = (v: number[]): number => v.reduce((a, i) => a + min[i]!, 0) + GAP * (v.length - 1);
  while (visible.length > 1 && need(visible) > w) {
    let drop = visible[0]!;
    for (const i of visible) if ((cols[i]!.priority ?? 0) < (cols[drop]!.priority ?? 0) || ((cols[i]!.priority ?? 0) === (cols[drop]!.priority ?? 0) && i > drop)) drop = i;
    visible = visible.filter((i) => i !== drop);
  }
  const widths = new Map<number, number>(visible.map((i) => [i, natural[i]!]));
  let excess = visible.reduce((a, i) => a + widths.get(i)!, 0) + GAP * (visible.length - 1) - w;
  // Shrink the lowest priority columns first (each down to its min), the widest of equal priority first.
  const prio = (i: number): number => cols[i]!.priority ?? 0;
  for (const level of [...new Set(visible.map(prio))].sort((x, y) => x - y)) {
    while (excess > 0) {
      let pick = -1;
      for (const i of visible) if (prio(i) === level && widths.get(i)! > (visible.length === 1 ? 1 : min[i]!) && (pick < 0 || widths.get(i)! > widths.get(pick)!)) pick = i;
      if (pick < 0) break;
      widths.set(pick, widths.get(pick)! - 1);
      excess--;
    }
  }
  const last = visible[visible.length - 1]!;
  const put = (i: number, text: string, tok?: "muted"): string => {
    const col = cols[i]!;
    const cw = widths.get(i)!;
    let t = text;
    if (displayWidth(t) > cw) t = (col.truncate === "middle" ? truncateMiddle : truncateEnd)(stripAnsi(t), cw, s.sym.ellipsis);
    const styled = tok ? s(tok, t) : t;
    const pad = " ".repeat(Math.max(0, cw - displayWidth(t)));
    return col.align === "right" ? pad + styled : i === last ? styled : styled + pad;
  };
  const join = (f: (i: number) => string): string => rtrim(visible.map(f).join(" ".repeat(GAP)));
  const total = visible.reduce((a, i) => a + widths.get(i)!, 0) + GAP * (visible.length - 1);
  return [
    join((i) => put(i, flat(cols[i]!.header), "muted")),
    s("muted", s.sym.h.repeat(total)),
    ...rows.map((_, r) => join((i) => put(i, cells[i]![r]!))),
  ];
}

const KIND = {
  // Not the arrow: that marks the callout's command, so an item and its command never look alike.
  info: { sym: (s: Style) => s.sym.sep, tok: "accent" },
  warn: { sym: (s: Style) => s.sym.warn, tok: "warn" },
  "needs-you": { sym: (s: Style) => s.sym.err, tok: "err" },
} as const;

/** `✗ Needs you`, what is going on, and the exact command to run. */
export function callout(s: Style, o: { kind: "info" | "warn" | "needs-you"; title: string; body: string[]; command?: string }, width: number): string[] {
  const w = cap(width);
  const k = KIND[o.kind];
  const sym = k.sym(s);
  const title = flat(o.title);
  // A long title wraps at a word, under itself (never cut): the reader needs all of what it says.
  const out = w < 8 ? [truncateEnd(`${sym} ${title}`, w, s.sym.ellipsis)]
    : wrapText(title, w - 2).map((l, i) => (i === 0 ? s(k.tok, sym) + " " : "  ") + s("title", l));
  const ind = w >= 8 ? 2 : 0;
  for (const b of o.body) for (const l of wrapLine(b, w - ind)) out.push(l === "" ? "" : " ".repeat(ind) + l);
  if (o.command) {
    const lead = w >= 8 ? `  ${s.sym.arrow} ` : "";
    wrapText(flat(o.command), w - displayWidth(lead), { hang: 0 }).forEach((l, i) => out.push(i === 0 ? s("muted", lead) + s("key", l) : " ".repeat(displayWidth(lead)) + s("key", l)));
  }
  return out.map(rtrim);
}
