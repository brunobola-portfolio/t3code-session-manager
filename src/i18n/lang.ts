// The language t3sm speaks (English, the primary one, or European Portuguese, chosen by --lang or the locale) and the
// one placeholder filler every catalogue uses. Shared by the commands (src/i18n/cli.ts) and the guided assistant
// (src/assistant/i18n.ts, which re-exports this), without either depending on the other.

export type Lang = "en" | "pt";
export function isLang(v: unknown): v is Lang {
  return v === "en" || v === "pt";
}

let intlLocaleCache: string | undefined;
/** The OS locale as Node sees it (on Windows, where no LANG is set, this is the only OS signal). Read once. */
function systemIntlLocale(): string {
  if (intlLocaleCache === undefined) {
    try { intlLocaleCache = new Intl.DateTimeFormat().resolvedOptions().locale; } catch { intlLocaleCache = ""; }
  }
  return intlLocaleCache;
}

/** A language tag ("pt_PT.UTF-8", "pt-BR", "en") gives "pt" for Portuguese and "en" otherwise; empty, "C", "POSIX" or unparsable gives null (skip). */
function langOfLocale(raw: string | undefined): Lang | null {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "c" || v === "posix" || /^(c|posix)[.@]/.test(v)) return null;
  const m = /^([a-z]{2,3})(?:[-_.@]|$)/.exec(v);
  if (!m) return null;
  return m[1] === "pt" ? "pt" : "en";
}

/**
 * `--lang` > env T3SM_LANG > config.json "language" > LC_ALL > LC_MESSAGES > LANG > the OS locale from Intl > "en". A
 * Portuguese tag (pt, pt_PT.UTF-8, pt-BR) gives "pt", any other parsable tag "en"; empty, "C" and "POSIX" values are
 * skipped. An unknown T3SM_LANG is ignored. The OS locale is read (approved 0.3 spec, section 5.4; this supersedes the
 * 2026-11-11 decision never to read it) because Windows sets no LANG. `intlLocale` is injectable for tests.
 */
export function resolveLang(flag: Lang | null, env: NodeJS.ProcessEnv, configLang: unknown, intlLocale?: string): Lang {
  if (flag) return flag;
  const e = env["T3SM_LANG"]?.trim().toLowerCase();
  if (isLang(e)) return e;
  if (isLang(configLang)) return configLang;
  for (const k of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const l = langOfLocale(env[k]);
    if (l) return l;
  }
  return langOfLocale(intlLocale ?? systemIntlLocale()) ?? "en";
}

/**
 * `{name}` placeholders replaced by `vars` (unknown placeholders are left as they are). `{name|one|many}` picks a form by
 * the number in `name`: `one` when it is 1, `many` otherwise ("{n} {n|file|files}"); a placeholder with no value stays.
 */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  const plural = template.replace(/\{([a-zA-Z0-9_-]+)\|([^|}]*)\|([^}]*)\}/g, (m, k: string, one: string, many: string) =>
    (Object.hasOwn(vars, k) ? (Number(vars[k]) === 1 ? one : many) : m));
  return plural.replace(/\{([a-zA-Z0-9_-]+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

