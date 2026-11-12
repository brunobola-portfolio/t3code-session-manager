// Language of the guided assistant, and the text helpers every step uses. Only the assistant is translated; every
// other command prints English.

import { en } from "./messages.en.ts";
import { pt } from "./messages.pt.ts";

export type Lang = "en" | "pt";
export type Key = keyof typeof en;
export type Catalogue = Record<Key, string>;

export const CATALOGUES: Record<Lang, Catalogue> = { en, pt };

export function isLang(v: unknown): v is Lang {
  return v === "en" || v === "pt";
}

/**
 * English unless Portuguese was asked for explicitly: `--lang` > env T3SM_LANG > config.json "language" > "en". The OS
 * locale is never read (decided 2026-11-11). An unknown env value is ignored.
 */
export function resolveLang(flag: Lang | null, env: NodeJS.ProcessEnv, configLang: unknown): Lang {
  if (flag) return flag;
  const e = env["T3SM_LANG"]?.trim().toLowerCase();
  if (isLang(e)) return e;
  if (isLang(configLang)) return configLang;
  return "en";
}

/** `{name}` placeholders replaced by `vars` (unknown placeholders are left as they are). */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{([a-zA-Z0-9_-]+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

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
