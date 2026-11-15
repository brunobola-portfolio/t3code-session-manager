// Display-width-correct text helpers (plain text in, plain text out; ANSI is only stripped for measuring). One shared
// Intl.Segmenter. Width: East-Asian Wide/Fullwidth and emoji presentation = 2; combining marks, format and control
// characters = 0; an emoji cluster (ZWJ sequence, VS16, flag, keycap) counts once, as 2.

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s: string): string[] => [...segmenter.segment(s)].map((g) => g.segment);

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
export function stripAnsi(s: string): string { return s.replace(ANSI, ""); }

/** [from, to] code point ranges drawn two cells wide, sorted. */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f1e6, 0x1f1ff], [0x1f200, 0x1f251],
  [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7], [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1faff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function isWide(cp: number): boolean {
  let lo = 0;
  let hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = WIDE[mid]!;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

const ZERO = /^[\p{M}\p{Cc}\p{Cf}]$/u;
const EMOJI_MARK = /‍|️|⃣|\p{Emoji_Modifier}/u;
const EMOJI_BASE = /\p{Extended_Pictographic}|[#*0-9]️?⃣/u;

function graphemeWidth(g: string): number {
  if (EMOJI_MARK.test(g) && EMOJI_BASE.test(g)) return 2;
  let w = 0;
  for (const ch of g) {
    const cw = ZERO.test(ch) ? 0 : isWide(ch.codePointAt(0)!) ? 2 : 1;
    if (cw > w) w = cw;
  }
  return w;
}

const PLAIN = /^[\x20-\x7e]*$/;

export function displayWidth(s: string): number {
  const t = stripAnsi(s);
  if (PLAIN.test(t)) return t.length;
  let w = 0;
  for (const g of graphemes(t)) w += graphemeWidth(g);
  return w;
}

/**
 * At most `w` cells, cut at the end with `ellipsis` (callers pass `style.sym.ellipsis`, so an ASCII console gets "...").
 * The ellipsis's own display width is budgeted. When even the ellipsis does not fit, as much of it as fits.
 */
export function truncateEnd(s: string, w: number, ellipsis = "…"): string {
  if (w <= 0) return "";
  if (displayWidth(s) <= w) return s;
  const ew = displayWidth(ellipsis);
  if (ew >= w) return cutEnd(ellipsis, w);
  let out = "";
  let used = 0;
  for (const g of graphemes(s)) {
    const gw = graphemeWidth(g);
    if (used + gw > w - ew) break;
    out += g;
    used += gw;
  }
  return out + ellipsis;
}

function cutEnd(s: string, w: number): string {
  let out = "";
  let used = 0;
  for (const g of graphemes(s)) {
    const gw = graphemeWidth(g);
    if (used + gw > w) break;
    out += g;
    used += gw;
  }
  return out;
}

/** At most `w` cells, cut in the middle with `ellipsis` so the start and the end stay visible (paths, titles). `w <= 0` gives "". */
export function truncateMiddle(s: string, w: number, ellipsis = "…"): string {
  if (w <= 0) return "";
  if (displayWidth(s) <= w) return s;
  const ew = displayWidth(ellipsis);
  if (ew >= w) return cutEnd(ellipsis, w);
  const keep = w - ew;
  const headBudget = Math.ceil(keep / 2);
  const tailBudget = keep - headBudget;
  const g = graphemes(s);
  let head = "";
  let used = 0;
  let i = 0;
  for (; i < g.length; i++) {
    const gw = graphemeWidth(g[i]!);
    if (used + gw > headBudget) break;
    head += g[i];
    used += gw;
  }
  let tail = "";
  used = 0;
  for (let j = g.length - 1; j >= i; j--) {
    const gw = graphemeWidth(g[j]!);
    if (used + gw > tailBudget) break;
    tail = g[j] + tail;
    used += gw;
  }
  return head + ellipsis + tail;
}

export function padEnd(s: string, w: number): string { return s + " ".repeat(Math.max(0, w - displayWidth(s))); }
export function padStart(s: string, w: number): string { return " ".repeat(Math.max(0, w - displayWidth(s))) + s; }

/**
 * Wraps plain text to `w` cells: words stay whole, a word wider than the line is broken by grapheme, `hang` spaces
 * indent every continuation line, "\n" starts a new paragraph. A line is never wider than `w`, except when one
 * character is itself wider than `w` (a CJK character at w = 1), which stands alone. `w < 1` is treated as 1. The same
 * holds when `hang` leaves less than 2 columns of room: a single wide character (CJK, emoji) then overflows the line
 * by one cell rather than being split. Callers that need a strict bound keep `hang <= w - 2`.
 */
export function wrapText(s: string, w: number, o: { hang?: number } = {}): string[] {
  const width = Math.max(1, Math.floor(w) || 1);
  const hang = Math.min(Math.max(0, Math.floor(o.hang ?? 0)), width - 1);
  const out: string[] = [];
  for (const para of s.split(/\r?\n/)) {
    let line = "";
    let lineW = 0;
    let indent = 0; // the first line has none, continuation lines `hang`
    const next = (): void => { out.push(line); indent = hang; line = " ".repeat(hang); lineW = hang; };
    for (const word of para.split(/ +/)) {
      if (word === "") continue;
      const ww = displayWidth(word);
      if (lineW > indent) {
        if (lineW + 1 + ww <= width) { line += " " + word; lineW += 1 + ww; continue; }
        next();
      }
      if (lineW + ww <= width) { line += word; lineW += ww; continue; }
      for (const g of graphemes(word)) {
        const gw = graphemeWidth(g);
        if (lineW + gw > width && lineW > indent) next();
        line += g;
        lineW += gw;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Text wrapped to `w` cells, each of its lines on its own: a short line stays as it is; a line's leading spaces are kept
 * on every piece; a bullet ("- ", "• ", "* ", "1. ") hangs its continuation under its text, or `hang` columns when
 * given; a word longer than the line (a long path) is broken. ANSI styling inside a word is kept.
 */
export function wrapTo(text: string, w: number, o: { hang?: number } = {}): string[] {
  const width = Math.max(1, Math.floor(w) || 1);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (displayWidth(line) <= width) { out.push(line.trimEnd()); continue; }
    const lead = /^ */.exec(line)![0].length;
    const ind = lead < width - 8 ? lead : 0;
    const bullet = /^(?:[-•*] |\d+\. )/.exec(line.slice(lead));
    const want = o.hang ?? (bullet ? bullet[0].length : 0);
    const hang = Math.min(Math.max(0, want), Math.max(0, width - ind - 2));
    for (const l of wrapText(line.slice(lead), width - ind, { hang })) out.push((" ".repeat(ind) + l).trimEnd());
  }
  return out;
}
