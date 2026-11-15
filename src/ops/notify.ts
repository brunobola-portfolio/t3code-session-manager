// Optional system notifications for an unattended `sync` (spec 4.8): one OS notification per reason per 24 h (a failed send is retried after 1 h) when t3sm
// needs a person (`needsAttention`, see syncStatus.ts), and with notify "all" a summary after a cycle that imported
// something. Both the watcher and the scheduled `sync --quiet` go through notifyAfterCycle (called by runSyncCycle).
//   - text is in the user's language (the catalogues, src/i18n/cli.ts; the caller resolves the language from env and
//     config.json as the cycle does) and holds counts and project names only (shownText, max 40 each), never session text;
//   - the title and body reach the OS as DATA, never spliced into a script: Windows gets them base64-encoded in
//     environment variables and decodes them inside the script; macOS gets them as osascript arguments; Linux as
//     notify-send arguments after `--`;
//   - nothing here throws: a missing notifier, a failing process or an unwritable status file just means "no notification".
// Rate limit: `lastNotified` (reason -> ISO time) lives in sync-status.json, written by markNotified. A reason is marked
// when a notification was ATTEMPTED (a platform without a notifier must not retry on every cycle). Updates notify once
// per version instead (notifyOnce): a major release found by the daily check (`update-available`), and an automatic
// update that failed or was rolled back (`update-failed`, which the cycles then leave alone).

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { defaultRunner, type Runner } from "../t3/auth.ts";
import { system32 } from "../core/sysroot.ts";
import { shownText } from "../plan/names.ts";
import type { Lang } from "../assistant/i18n.ts";
import { cliT, type CliKey } from "../i18n/cli.ts";
import { markNotified, readLastNotified, type AttentionFacts, type AttentionReason, type NeedsAttention } from "./syncStatus.ts";

export type NotifyMode = "attention" | "all" | "off";
export interface Notifier { notify(title: string, body: string): Promise<boolean> }

export const NOTIFY_TIMEOUT_MS = 10_000;
export const NOTIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A send that failed is retried after this long (the stamp is back-dated by INTERVAL - RETRY). */
export const NOTIFY_RETRY_MS = 60 * 60 * 1000;
/** The reason key of the "all" summary. */
export const SUMMARY_REASON = "imported";
export const NOTIFY_TITLE = "t3sm needs attention";
export const SUMMARY_TITLE = "t3sm";
const NAME_MAX = 40;
const DETAIL_MAX = 160;
const POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const WIN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:T3SM_NOTIFY_TITLE))",
  "$b = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:T3SM_NOTIFY_BODY))",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
  "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$n = $x.GetElementsByTagName('text')",
  "$n.Item(0).AppendChild($x.CreateTextNode($t)) | Out-Null",
  "$n.Item(1).AppendChild($x.CreateTextNode($b)) | Out-Null",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($x)",
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show($toast)`,
].join("; ");

export interface SystemNotifierOptions {
  /** Linux: is this program on PATH? (default: looks through PATH without spawning anything). */
  which?: (name: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    try { accessSync(join(dir, name), constants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

/** The environment a notifier child gets: ours, without an account home (CLAUDE_CONFIG_DIR never leaks into children). */
function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && k.toUpperCase() !== "CLAUDE_CONFIG_DIR") env[k] = v;
  return { ...env, ...extra };
}

/** notify-send renders Pango markup: & < > must be entities (Linux only). */
const pango = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

export function systemNotifier(platform: NodeJS.Platform, run: Runner = defaultRunner, o: SystemNotifierOptions = {}): Notifier {
  const base = o.env ?? process.env;
  const which = o.which ?? ((n: string) => onPath(n, base));
  return {
    async notify(title, body) {
      // Control and escape characters never reach an OS notification (and no argument can be empty or start a new option).
      const t = shownText(title, 120), b = shownText(body, 400);
      try {
        if (platform === "win32") {
          const r = await run(system32(base, "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WIN_SCRIPT],
            { shell: false, timeoutMs: NOTIFY_TIMEOUT_MS, env: childEnv(base, { T3SM_NOTIFY_TITLE: b64(t), T3SM_NOTIFY_BODY: b64(b) }) });
          return r.code === 0 && !r.timedOut;
        }
        if (platform === "darwin") {
          const r = await run("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", t, b],
            { shell: false, timeoutMs: NOTIFY_TIMEOUT_MS, env: childEnv(base) });
          return r.code === 0 && !r.timedOut;
        }
        if (platform === "linux") {
          if (!which("notify-send")) return false;
          const r = await run("notify-send", ["--", pango(t), pango(b)], { shell: false, timeoutMs: NOTIFY_TIMEOUT_MS, env: childEnv(base) });
          return r.code === 0 && !r.timedOut;
        }
        return false;
      } catch { return false; }
    },
  };
}

/** One notification per reason per 24 h; mode "attention" never sends the import summary; "off" and --dry-run never send. */
export function shouldNotify(o: { mode: NotifyMode; reason: string; lastNotified: Record<string, string>; now: number; dryRun?: boolean }): boolean {
  if (o.dryRun === true || o.mode === "off") return false;
  if (o.mode === "attention" && o.reason === SUMMARY_REASON) return false;
  const last = Date.parse(o.lastNotified[o.reason] ?? "");
  return !(Number.isFinite(last) && o.now - last >= 0 && o.now - last < NOTIFY_INTERVAL_MS);
}

/** The title of an attention notification, in `lang`. */
export function attentionTitle(lang: Lang = "en"): string {
  return cliT(lang, "notify.attentionTitle");
}

/** The title of the import summary, in `lang`. */
export function summaryTitle(lang: Lang = "en"): string {
  return cliT(lang, "notify.summaryTitle");
}

/** What an attention notification or a status item is told from: its reason, the recorded English detail and facts. */
export type AttentionLike = Pick<NeedsAttention, "reason" | "detail"> & { facts?: AttentionFacts | undefined };

/**
 * What needs the user, in `lang`, worded from the facts the producer recorded (sync.ts attentionOf,
 * incompatibleAttention; syncStatus.ts streakAttention, the update failure). A record without facts (written by an
 * older t3sm) keeps its English detail in English, and gets a sentence without the numbers in any other language.
 */
export function attentionText(a: AttentionLike, lang: Lang): string {
  const f = a.facts;
  const t = (k: CliKey, v: Record<string, string | number> = {}): string => cliT(lang, k, v);
  const num = (x: number | undefined): boolean => typeof x === "number";
  const known = ((): string | null => {
    if (!f) return null;
    switch (a.reason) {
      case "undecided": return num(f.n) && num(f.q) ? t("notify.undecided", { n: f.n!, q: f.q! }) : null;
      case "signed-out": return num(f.n) ? t("notify.signedOut", { n: f.n! }) : null;
      case "over-limit": return num(f.n) && num(f.limit) ? t("notify.overLimit", { n: f.n!, limit: f.limit! }) : null;
      case "t3-incompatible": return typeof f.version === "string" ? t("notify.incompatible", { version: shownText(f.version, 40) }) : null;
      case "repeated-failures": return num(f.n) ? t("notify.failures", { n: f.n! }) : null;
      case "update-failed": {
        if (typeof f.from !== "string" || typeof f.to !== "string") return null;
        const v = { from: shownText(f.from, 40), to: shownText(f.to, 40) };
        return t(f.outcome === "rolled-back" ? "status.update.rolledBack" : f.outcome === "interrupted" ? "status.update.interrupted" : "status.update.failed", v);
      }
    }
  })();
  if (known !== null) return known;
  if (lang === "en") return a.detail;
  const any: Record<AttentionReason, CliKey> = {
    undecided: "notify.undecidedAny", "signed-out": "notify.signedOutAny", "over-limit": "notify.overLimitAny",
    "t3-incompatible": "notify.incompatibleAny", "repeated-failures": "notify.failuresAny", "update-failed": "notify.updateAny",
  };
  return t(any[a.reason]);
}

/**
 * The body of an attention notification: what needs the user, then where to see it, in `lang`. A plain string is an
 * English detail (no facts): told as it is.
 */
export function attentionBody(a: AttentionLike | string, lang: Lang = "en"): string {
  const text = typeof a === "string" ? a : attentionText(a, lang);
  const d = shownText(text, DETAIL_MAX).trim();
  return `${/[.!?]$/.test(d) ? d : `${d}.`} ${cliT(lang, "notify.howTo")}`;
}

export interface ImportSummary { imported: number; projects: number; newProjects: string[] }

export function summaryBody(s: ImportSummary, lang: Lang = "en"): string {
  const head = s.projects > 0 ? cliT(lang, "notify.importedIn", { n: s.imported, p: s.projects }) : cliT(lang, "notify.importedOnly", { n: s.imported });
  const names = s.newProjects.map((n) => shownText(n, NAME_MAX)).filter((n) => n !== "");
  if (names.length === 0) return head;
  const shown = names.length > 3 ? cliT(lang, "notify.andMore", { names: names.slice(0, 3).join(", "), n: names.length - 3 }) : names.join(", ");
  return `${head} ${cliT(lang, "notify.newProjects", { n: names.length, names: shown })}`;
}

/** What an update notification says (an automatic update that failed, was rolled back or interrupted; a major release). */
export function updateNotice(kind: "rolled-back" | "failed" | "interrupted" | "available", v: { from?: string; to: string }, lang: Lang = "en"): { title: string; body: string } {
  const vars = { from: v.from ?? "?", to: v.to };
  if (kind === "available") return { title: cliT(lang, "notify.update.availableTitle", vars), body: cliT(lang, "notify.update.available") };
  const key: CliKey = kind === "rolled-back" ? "notify.update.rolledBack" : kind === "failed" ? "notify.update.failed" : "notify.update.interrupted";
  return { title: attentionTitle(lang), body: cliT(lang, key, vars) };
}

export interface NotifyCycleInput {
  stateDir: string;
  mode: NotifyMode;
  notifier: Notifier;
  now: number;
  dryRun?: boolean;
  attention: NeedsAttention | null;
  summary?: ImportSummary | null;
  /** The language of the texts (default English). */
  lang?: Lang;
}

/** After a cycle. Never throws. Returns the reasons a notification was attempted for. */
export async function notifyAfterCycle(i: NotifyCycleInput): Promise<string[]> {
  const sent: string[] = [];
  try {
    if (i.dryRun === true || i.mode === "off") return sent;
    const last = await readLastNotified(i.stateDir);
    const jobs: { reason: string; title: string; body: string }[] = [];
    // update-failed was announced once by the update itself (notifyOnce): the cycles never repeat it.
    const lang = i.lang ?? "en";
    if (i.attention && i.attention.reason !== "update-failed") jobs.push({ reason: i.attention.reason, title: attentionTitle(lang), body: attentionBody(i.attention, lang) });
    if (i.summary && i.summary.imported > 0) jobs.push({ reason: SUMMARY_REASON, title: summaryTitle(lang), body: summaryBody(i.summary, lang) });
    for (const j of jobs) {
      if (!shouldNotify({ mode: i.mode, reason: j.reason, lastNotified: last, now: i.now })) continue;
      // Marked before sending: even a crash or a timeout inside the OS call must not turn into one per cycle.
      await markNotified(i.stateDir, j.reason, new Date(i.now));
      sent.push(j.reason);
      const ok = await i.notifier.notify(j.title, j.body).catch(() => false);
      // A failed send is stamped as if sent 23 h ago: retried in 1 h, not silenced for a day and not every cycle.
      if (!ok) await markNotified(i.stateDir, j.reason, new Date(i.now - (NOTIFY_INTERVAL_MS - NOTIFY_RETRY_MS)));
    }
  } catch { /* a notification never fails a cycle */ }
  return sent;
}

/** The info reason of a major release announced by the daily update check (keys: `update-available:<version>`). */
export const UPDATE_AVAILABLE_REASON = "update-available";
/** A failed or rolled-back automatic update (keys: `update-failed:<version>`); also an attention reason (syncStatus.ts). */
export const UPDATE_FAILED_REASON = "update-failed";
/** An automatic update found interrupted at the watcher's start (keys: `update-interrupted:<version>`): its own key, so a
 * later failure of the same version still notifies. */
export const UPDATE_INTERRUPTED_REASON = "update-interrupted";

export interface NotifyOnceInput { stateDir: string; mode: NotifyMode; notifier: Notifier; now: number; key: string; title: string; body: string }

/**
 * One notification per key, ever (an update announcement or failure: the key names the version), unless mode is "off".
 * The key is marked in lastNotified before sending, like the cycle notifications, so a crash or a failed send never
 * turns into a repeat. Never throws. Returns whether a notification was attempted.
 */
export async function notifyOnce(i: NotifyOnceInput): Promise<boolean> {
  try {
    if (i.mode === "off") return false;
    if ((await readLastNotified(i.stateDir))[i.key] !== undefined) return false;
    await markNotified(i.stateDir, i.key, new Date(i.now));
    await i.notifier.notify(i.title, i.body).catch(() => false);
    return true;
  } catch { return false; }
}
