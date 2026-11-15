// The commands' catalogues and the one lookup into them, in a module of their own: ops/, plan/ and the notifications
// word things in the user's language without importing the CLI (src/cli/ui.ts re-exports all of this for the commands).
// The guided assistant keeps its own catalogue (src/assistant/i18n.ts); both share src/i18n/lang.ts.

import { fmt, type Lang } from "./lang.ts";
import type { Caps } from "../ui/caps.ts";
import { makeFmt, type Fmt } from "../ui/locale.ts";
import { makeStyle, type Style } from "../ui/style.ts";
import { en } from "./messages.en.ts";
import { pt } from "./messages.pt.ts";

export type CliKey = keyof typeof en;
export type CliCatalogue = Record<CliKey, string>;

export const CLI_CATALOGUES: Record<Lang, CliCatalogue> = { en, pt };

/** The catalogue lookup alone, for code that has a language but no Io. */
export function cliT(lang: Lang, key: CliKey, vars: Record<string, string | number> = {}): string {
  return fmt(CLI_CATALOGUES[lang][key], vars);
}

/** Whether `key` is a key of the catalogues (for keys built at runtime, such as a doctor check's id and state). */
export function isCliKey(key: string): key is CliKey {
  return Object.hasOwn(en, key);
}

export interface CliUi {
  s: Style;
  f: Fmt;
  lang: Lang;
  m: CliCatalogue;
  /** Columns to lay out for (80 when unknown). */
  width: number;
  t(key: CliKey, vars?: Record<string, string | number>): string;
}

/** A CliUi from capabilities and a language directly (the screen registry renders every screen this way). */
export function makeCliUi(caps: Caps, lang: Lang, now: () => number = Date.now): CliUi {
  const m = CLI_CATALOGUES[lang];
  return { s: makeStyle(caps), f: makeFmt(lang, now), lang, m, width: caps.columns || 80, t: (key, vars = {}) => fmt(m[key], vars) };
}
