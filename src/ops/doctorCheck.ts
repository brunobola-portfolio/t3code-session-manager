// A doctor check (src/ops/doctor.ts) and its wording: English for --json, catalogue parts for the screen in any
// language, and the scrub every check goes through before it is shown.

import type { Lang } from "../assistant/i18n.ts";
import { cliT, type CliKey } from "../i18n/cli.ts";
import { redact } from "../t3/errors.ts";
import { maskEmailsIn } from "../core/mask.ts";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";
/**
 * What a check found, for a screen that words it itself (the guided assistant) instead of reading the English message:
 * merge-pending: sessions continued in a terminal, sessions with work on a side branch, when they were counted (ISO);
 * harness:<agent>: the agent, its sessions (null: not counted for this agent), unreadable files, and whether T3 Code
 * lacks the agent's own instance for sessions that need it. Additive: `--json` shows it too.
 */
export type CheckData =
  | { continued: number; sideBranch: number; at: string }
  | { harness: string; sessions: number | null; readErrors: number; noInstance: boolean };

/**
 * One piece of a check's text for the screen, in the user's language: a catalogue key (src/i18n/messages.*.ts), its
 * values (a value may itself be parts, worded in the same language), literal punctuation before it (`sep`), and `cap`
 * to start it with a capital. A value named `<x>Ms` (a duration) also gives `<x>` ("3 h", "2 days").
 */
export interface SayPart { key: CliKey; vars?: Record<string, string | number | SayPart[]>; sep?: string; cap?: boolean }

/**
 * A check. `message` and `fix` are English (what --json prints, unchanged); `say` and `sayFix` word the same text from
 * the catalogues for the screen (English gives exactly `message` and `fix`). --json leaves `say` and `sayFix` out.
 */
export interface Check { id: string; status: CheckStatus; message: string; fix?: string; data?: CheckData; say?: SayPart[]; sayFix?: SayPart[] }

/** A duration the way doctor words it: minutes under an hour, hours under two days, then days. */
function ageText(ms: number, lang: Lang): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return cliT(lang, "doctor.age.min", { n: m });
  const h = Math.round(m / 60);
  return h < 48 ? cliT(lang, "doctor.age.h", { n: h }) : cliT(lang, "doctor.age.days", { n: Math.round(h / 24) });
}

/** Parts as one text in `lang`. */
export function sayText(parts: SayPart[], lang: Lang): string {
  return parts.map((p) => {
    const vars: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(p.vars ?? {})) {
      vars[k] = Array.isArray(v) ? sayText(v, lang) : v;
      if (/Ms$/.test(k) && typeof v === "number") vars[k.slice(0, -2)] = ageText(v, lang);
    }
    const text = cliT(lang, p.key, vars);
    return (p.sep ?? "") + (p.cap ? text.replace(/^./, (c) => c.toUpperCase()) : text);
  }).join("");
}

export const part = (key: CliKey, vars?: SayPart["vars"], sep?: string): SayPart => ({ key, ...(vars ? { vars } : {}), ...(sep !== undefined ? { sep } : {}) });

/** A check worded from the catalogue: its English message and fix, and the parts the screen words in any language. */
export function said(id: string, status: CheckStatus, msg: SayPart[], fix?: SayPart[], data?: CheckData): Check {
  return {
    id, status, message: sayText(msg, "en"), say: msg,
    ...(fix && fix.length > 0 ? { fix: sayText(fix, "en"), sayFix: fix } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

export const ok = (id: string, ...msg: SayPart[]): Check => said(id, "ok", msg);
export const skip = (id: string, ...msg: SayPart[]): Check => said(id, "skip", msg);

/** Last line of defence: emails masked, the home folder shown as ~, tokens redacted. */
export function scrub(c: Check, home: string): Check {
  const h = home.replace(/[\\/]+$/, "");
  const variants = [...new Set([h, h.replace(/\\/g, "/"), h.replace(/\//g, "\\")])].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?:${variants.join("|")})(?=[\\\\/]|\\b|$)`, "gi");
  // Control and format characters go first, so an invisible character inside an address cannot hide it from the mask.
  const clean = (s: string) => redact(maskEmailsIn(s.replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" ? c : "")))).replace(re, "~");
  // The screen's wording carries the same values: cleaned the same way.
  const cleanParts = (ps: SayPart[]): SayPart[] => ps.map((x) => ({
    ...x, ...(x.vars ? { vars: Object.fromEntries(Object.entries(x.vars).map(([k, v]) => [k, typeof v === "string" ? clean(v) : Array.isArray(v) ? cleanParts(v) : v])) } : {}),
  }));
  const out: Check = { id: c.id, status: c.status, message: clean(c.message) };
  if (c.fix !== undefined) out.fix = clean(c.fix);
  if (c.data !== undefined) out.data = c.data;
  if (c.say !== undefined) out.say = cleanParts(c.say);
  if (c.sayFix !== undefined) out.sayFix = cleanParts(c.sayFix);
  return out;
}
