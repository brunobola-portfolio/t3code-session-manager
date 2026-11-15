// The guided assistant's catalogue and the text helpers every step uses. The language itself (Lang, resolveLang, fmt)
// lives in src/i18n/lang.ts, shared with the commands' catalogues (src/i18n/cli.ts); re-exported here.

import { en } from "./messages.en.ts";
import { pt } from "./messages.pt.ts";

export { fmt, isLang, resolveLang, type Lang } from "../i18n/lang.ts";
import type { Lang } from "../i18n/lang.ts";

export type Key = keyof typeof en;
export type Catalogue = Record<Key, string>;

export const CATALOGUES: Record<Lang, Catalogue> = { en, pt };

export const WIDTH = 80;

/**
 * Greedy word wrap of every line of `text` to `width` columns. A line keeps its leading spaces, and a bullet ("- ")
 * hangs its continuation lines under the text. A single word longer than the width (a long path) keeps its own line.
 */
export function wrap(text: string, width: number = WIDTH): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= width) { out.push(line.trimEnd()); continue; } // short lines keep their own spacing (aligned columns)
    const lead = /^\s*/.exec(line)![0];
    const bullet = /^\s*(?:- |\d+\. )/.exec(line);
    const hang = bullet ? " ".repeat(bullet[0].length) : lead;
    const words = line.slice(lead.length).split(/ +/).filter((w) => w !== "");
    if (words.length === 0) { out.push(""); continue; }
    let cur = lead + words[0];
    for (const w of words.slice(1)) {
      if (cur.length + 1 + w.length <= width) cur += " " + w;
      else { out.push(cur); cur = hang + w; }
    }
    out.push(cur);
  }
  return out;
}
