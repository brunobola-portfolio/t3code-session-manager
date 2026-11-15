// Semantic style tokens on Node's util.styleText, and the symbols (Unicode with an ASCII fallback). Components use
// tokens, never raw ANSI. `validateStream: false` (typed in @types/node 22, honoured by Node >= 22.13) makes styleText
// emit ANSI whatever process.stdout is, so FORCE_COLOR works through a pipe; the NO_COLOR / no-TTY rules live in
// detectCaps, and colour 0 is the identity here.

import { styleText } from "node:util";
import type { Caps } from "./caps.ts";

export type Token = "title" | "accent" | "muted" | "ok" | "warn" | "err" | "key" | "path" | "num";

export interface Symbols {
  ok: string; err: string; warn: string; dot: string; ring: string; arrow: string; ellipsis: string;
  h: string; v: string; tl: string; tr: string; bl: string; br: string; barFull: string; barEmpty: string;
  /** Progress bar edges, the spinner frames (one cell each, concatenated) and the separator between fragments of one line. */
  barL: string; barR: string; spin: string; sep: string; cur: string;
  /** A list item's mark (help topics, release notes). */
  bullet: string;
}

export interface Style { (t: Token, s: string): string; sym: Symbols; caps: Caps }

const FORMAT: Record<Token, Parameters<typeof styleText>[0]> = {
  title: "bold", accent: "green", muted: "gray", ok: "green", warn: "yellow", err: "red", key: "cyan", path: "blue", num: "magenta",
};

const UNICODE: Symbols = { ok: "✓", err: "✗", warn: "!", dot: "●", ring: "○", arrow: "›", ellipsis: "…", h: "─", v: "│", tl: "╭", tr: "╮", bl: "╰", br: "╯", barFull: "█", barEmpty: "░", barL: "▕", barR: "▏", spin: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏", sep: "·", cur: "◉", bullet: "•" };
const ASCII: Symbols = { ok: "v", err: "x", warn: "!", dot: "*", ring: "o", arrow: ">", ellipsis: "...", h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+", barFull: "#", barEmpty: ".", barL: "[", barR: "]", spin: "|/-\\", sep: "-", cur: "@", bullet: "-" };

export function makeStyle(c: Caps): Style {
  const paint = (t: Token, s: string): string => (c.color === 0 ? s : styleText(FORMAT[t], s, { validateStream: false }));
  return Object.assign(paint, { sym: c.unicode ? UNICODE : ASCII, caps: c });
}
