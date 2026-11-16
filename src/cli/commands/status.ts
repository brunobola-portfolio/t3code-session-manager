// `t3sm status`: the one place that says whether t3sm needs you. Strictly read-only: no lock, no journal write, no
// discovery cache, no T3 Code (it never connects, and never probes the network; "T3 Code is not running" comes from
// T3's own runtime file and its pid). Reads <state>/sync-status.json (the watcher's heartbeat and what each sync cycle
// recorded), logs/sync.log, the journal, the newest plan, update.json / update.pending.json, the lock file and the
// install's package.json / build stamp.
//
// It leads with one level: "ok" (all good), "needs-you" (with the count) or "working" (a run holds the lock), then the
// items, every needs-you item before every info item, each with the command that settles it (spec §5.5). Info items
// never raise the level. Exit 0, or 10 when the level is "needs-you"; a usage error is 2.

import { homedir } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SCHEDULE_MINUTES, loadConfig } from "../../core/config.ts";
import { expandHome, stateDir } from "../../core/paths.ts";
import { describePlugin, packageVersion as ownVersion, readPluginState, type PluginState } from "../../ops/plugin.ts";
import type { Lang } from "../../assistant/i18n.ts";
import { cliT, cliUi, type CliKey, type CliUi } from "../ui.ts";
import { fitLine, leadLines } from "../screen.ts";
import { DECISION_WORDS } from "../words.ts";
import { callout, kv } from "../../ui/components.ts";
import { wrapText } from "../../ui/text.ts";
import { Journal, organizeFailures } from "../../core/journal.ts";
import { lockInfo } from "../../core/lock.ts";
import { compareSemver, parseSemver } from "../../core/semver.ts";
import { installChangedAt, installRoot, installStamp, type InstallStamp } from "../../core/version.ts";
import type { Config, JournalEntry, Plan } from "../../core/types.ts";
import { REPEATED_FAILURES, readSyncStatus, readUpdateFailure, recordsUndecided, updateFailureText, type NeedsAttention, type UpdateFailure } from "../../ops/syncStatus.ts";
import { pidAlive, readHeartbeat } from "../../ops/watch.ts";
import { watcherHealth, type WatcherHealth } from "../../ops/watcherHealth.ts";
import { classify, readPendingUpdate, readUpdateState } from "../../ops/updater.ts";
import { listRuns } from "../../ops/rollback.ts";
import { readServerRuntime, type ServerRuntime } from "../../t3/runtime.ts";
import { shownAccountName, shownText } from "../../plan/names.ts";
import { parseFlags } from "./quarantine.ts";
import { latestPlan, readPlan } from "./apply.ts";
import { attentionText } from "../../ops/notify.ts";
import { FLAG_SPECS } from "../flags.ts";
import type { Io } from "../main.ts";

export interface StatusDeps {
  home?: string;
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  /** T3 Code's runtime file (no network). */
  readRuntime?: (home: string) => Promise<ServerRuntime | null>;
  /** The Claude accounts to report the t3sm plugin for (default: config.json's, else ~/.claude). Read-only. */
  accounts?: () => Promise<{ id: string; home: string; name?: string }[]>;
  /** This t3sm's version, and the plugin reader (default: <home>/plugins/installed_plugins.json). */
  packageVersion?: string;
  pluginState?: (accountHome: string) => Promise<PluginState>;
  /** What an install root holds now (null: this t3sm's own) and when it changed; null when unreadable (as doctor's). */
  installStamp?: (root: string | null) => (InstallStamp & { changedAtMs: number | null }) | null;
}

export type StatusLevel = "ok" | "needs-you" | "working";
export interface StatusItem { level: "needs-you" | "info"; key: string; text: string; command: string | null }

export interface StatusReport {
  version: 2;
  ran: true;
  /** "needs-you" when any item needs you; else "working" while a run holds the lock; else "ok". */
  level: StatusLevel;
  /** Most important first: every needs-you item before every info item. */
  items: StatusItem[];
  needsAttention: NeedsAttention | null;
  /** Projects held because one of their conversations is in use, as of the last cycle that saw it. */
  waiting: { project: string; title: string | null; modifiedAt: string; since: string }[];
  /** Copies from refused folders waiting for a destination folder that is not in T3 Code yet. */
  heldRehome: number;
  /** Organize question key -> sessions waiting for the answer (from the newer of the last cycle and the newest plan). */
  decisionsPending: Record<string, number>;
  pendingImports: { count: number; source: "sync" | "plan"; at: string | null } | null;
  lastSync: { at: string; outcome: string; runId: string | null } | null;
  nextSync: { at: string; source: "watcher" } | null;
  /** stale: it will not catch up by itself (another version, cannot restart into an upgrade, or cycles overdue). */
  watcher: { running: boolean; pid: number; version: string | null; stale: boolean } | null;
  update: {
    installed: string;
    /** A newer release the daily check found and did not install (a major, or automatic updates off). */
    available: string | null;
    /** The last update that did not install, while the installed version is still older than its target. */
    failure: UpdateFailure | null;
    lastInstalled: { from: string; to: string; at: string | null } | null;
  };
  /** A live process holding the state lock (a run in progress). */
  runInProgress: { pid: number; startedAt: string } | null;
  lastOrganize: { runId: string; at: string | null; changes: number; reverted: number; rolledBackBy: string | null } | null;
  /** The t3sm plugin (the /t3sm commands inside T3 Code) per Claude account; empty when the accounts could not be read. */
  plugin: { account: string; name?: string; state: "installed" | "outdated" | "missing"; version: string | null }[];
  t3Code: { running: boolean; version: string | null };
}

/** The exit code when something needs the user (so scripts and notifications can tell "needs you" from an error). */
export const NEEDS_YOU_EXIT = 10;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** An install this recent is mentioned (info) with the way to read what changed. */
const RECENT_INSTALL_MS = 7 * DAY;
/** Titles named in one item at most. */
const NAMES_SHOWN = 3;
/** Caps for an item's text and command (shownText cuts the middle). */
const ITEM_TEXT_MAX = 400;
const ITEM_COMMAND_MAX = 120;

/** "just now", "5 min ago", "2 hours ago", "3 days ago"; a future time reads "in 7 min" (Portuguese: "há 5 min", "daqui a 7 min"). */
export function relative(ms: number, lang: Lang = "en"): string {
  const future = ms < 0;
  const m = Math.floor(Math.abs(ms) / MIN);
  if (m < 1) return cliT(lang, future ? "status.rel.inUnderMinute" : "status.rel.justNow");
  const t = m < 60 ? cliT(lang, "status.rel.minutes", { n: m })
    : m < 24 * 60 ? cliT(lang, "status.rel.hours", { n: Math.floor(m / 60) })
    : cliT(lang, "status.rel.days", { n: Math.floor(m / (24 * 60)) });
  return cliT(lang, future ? "status.rel.in" : "status.rel.ago", { time: t });
}

/** "today", "yesterday", "3 days ago" (whole days elapsed). */
export function relativeDay(ms: number, lang: Lang = "en"): string {
  const d = Math.floor(Math.max(0, ms) / DAY);
  return cliT(lang, d === 0 ? "status.day.today" : d === 1 ? "status.day.yesterday" : "status.day.daysAgo", { n: d });
}

/** The words of one language an item is told in: the catalogue, relative times and a short list of names. */
export interface Words { lang: Lang; t(key: CliKey, vars?: Record<string, string | number>): string; ago(ms: number): string; day(ms: number): string; list(names: string[]): string }

function words(lang: Lang): Words {
  return {
    lang,
    t: (key, vars = {}) => cliT(lang, key, vars),
    ago: (ms) => relative(ms, lang),
    day: (ms) => relativeDay(ms, lang),
    list: (names) => {
      const shown = names.slice(0, NAMES_SHOWN).join(", ");
      return names.length > NAMES_SHOWN ? cliT(lang, "status.andMore", { names: shown, n: names.length - NAMES_SHOWN }) : shown;
    },
  };
}

const EN_WORDS = words("en");


/** An item's text as a function of the language: English is the --json `text`, the screen tells it in the user's language. */
type Say = (w: Words) => string;

/** Each item's `say`, beside the item rather than on it: --json carries only the English `text`. */
const SAYS = new WeakMap<StatusItem, Say>();
function withSay<T extends StatusItem>(i: T, say: Say | undefined): T {
  if (say) SAYS.set(i, say);
  return i;
}
const sayOf = (i: StatusItem): Say | undefined => SAYS.get(i);

function item(level: StatusItem["level"], key: string, say: Say, command: string | null, text: string = say(EN_WORDS)): StatusItem {
  return withSay({ level, key, text, command }, say);
}

/**
 * The "conversations wait for your decision" item. --json keeps the question keys ("automated 2", byte-identical); the
 * screen names each question in words ("automated sessions 2").
 */
export function undecidedItem(decisionsPending: Record<string, number>): StatusItem {
  const questions = Object.entries(decisionsPending);
  const n = questions.reduce((a, [, x]) => a + x, 0);
  const parts = questions.map(([k, x]) => `${shownText(k, 40)} ${x}`).join(", ");
  const said = (w: Words): string => questions.map(([k, x]) => `${DECISION_WORDS[k] ? w.t(DECISION_WORDS[k]) : shownText(k, 40)} ${x}`).join(", ");
  return item("needs-you", "undecided", (w) => w.t("status.undecided", { n, parts: said(w) }), "t3sm start", EN_WORDS.t("status.undecided", { n, parts }));
}

/** An item told by one catalogue entry (the screen registry and tests build reports with it). */
export function sayingItem(level: StatusItem["level"], key: string, msg: CliKey, vars: Record<string, string | number>, command: string | null): StatusItem {
  return item(level, key, (w) => w.t(msg, vars), command);
}

const time = (s: unknown): number | null => (typeof s === "string" && Number.isFinite(Date.parse(s)) ? Date.parse(s) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** When a run id (newRunId: `YYYYMMDD-HHMMSS-xxxx`, UTC) was made; null for any other id. */
export function runIdTime(runId: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(runId);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(t) ? t : null;
}

/** The home folder shown as ~ (an import failure's reason may name a file). */
function maskHome(s: string, home: string): string {
  const h = home.replace(/[\\/]+$/, "");
  if (h === "") return s;
  const variants = [...new Set([h, h.replace(/\\/g, "/"), h.replace(/\//g, "\\")])].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return s.replace(new RegExp(`(?:${variants.join("|")})(?=[\\\\/]|\\b|$)`, "gi"), "~");
}

interface SyncSeen { at: string; outcome: string; runId: string | null; pending: number | null; rest?: string }

async function lastLogLine(dir: string): Promise<SyncSeen | null> {
  let text: string;
  try { text = await readFile(join(dir, "logs", "sync.log"), "utf8"); } catch { return null; }
  const line = text.split("\n").map((l) => l.trim()).filter((l) => l !== "").pop();
  const m = line ? /^(\S+) (\S+)(.*)$/.exec(line) : null;
  if (!m || time(m[1]) === null) return null;
  const run = /\brun=(\S+)/.exec(m[3]!)?.[1];
  const pending = /\bpending=(\d+)/.exec(m[3]!)?.[1];
  return { at: m[1]!, outcome: m[2]!, runId: run && run !== "-" ? run : null, pending: pending ? Number(pending) : null, rest: m[3]!.trim() };
}

/** What sync.log records when a watcher stops at start-up, before its first heartbeat (src/cli/commands/sync.ts). */
const START_FAILURES = new Set(["startup-error", "socket-dir-unsafe"]);

async function newestPlan(dir: string): Promise<Plan | null> {
  try {
    const p = await latestPlan(dir);
    return p === null ? null : await readPlan(p);
  } catch { return null; }
}

const sessionKey = (harness: string, nativeId: string): string => `${harness}:${nativeId}`;

/** Plan skip reasons that are failures themselves: such a session still counts as failing to import. */
const FAILURE_SKIPS: ReadonlySet<string> = new Set(["compare-failed"]);

/** Sessions whose import failed in two or more runs since they were last imported, grouped by reason. */
function repeatedFailures(entries: JournalEntry[]): Map<string, { harness: string; nativeId: string }[]> {
  const failing = new Map<string, { harness: string; nativeId: string; reason: string; runs: Set<string> }>();
  for (const e of entries) {
    if (e.t === "imported") failing.delete(sessionKey(e.harness, e.nativeId));
    else if (e.t === "import-failed") {
      const k = sessionKey(e.harness, e.nativeId);
      const f = failing.get(k) ?? { harness: e.harness, nativeId: e.nativeId, reason: e.reason, runs: new Set<string>() };
      f.reason = e.reason;
      f.runs.add(e.runId);
      failing.set(k, f);
    }
  }
  const byReason = new Map<string, { harness: string; nativeId: string }[]>();
  for (const f of failing.values()) {
    if (f.runs.size < 2) continue;
    const list = byReason.get(f.reason) ?? [];
    list.push({ harness: f.harness, nativeId: f.nativeId });
    byReason.set(f.reason, list);
  }
  return byReason;
}

function watcherItems(h: WatcherHealth, t3Running: boolean, now: number): StatusItem[] {
  const restart = "t3sm schedule restart";
  switch (h.state) {
    case "none": return [];
    case "stopped": {
      const ago = now - (time(h.stoppedAt) ?? now);
      return [item("info", "watcher-stopped", (w) => w.t("status.watcher.stopped", { ago: w.ago(ago) }), null)];
    }
    case "restart-lost": {
      const ago = now - (time(h.stoppedAt) ?? now);
      return [item("needs-you", "watcher-not-running", (w) => w.t("status.watcher.restartLost", { ago: w.ago(ago) }), restart)];
    }
    case "gone": {
      const last = h.lastCycleAt === null ? null : now - (time(h.lastCycleAt) ?? now);
      return [item("needs-you", "watcher-not-running", (w) => w.t("status.watcher.gone", { pid: h.pid, last: last === null ? w.t("status.never") : w.ago(last) }), restart)];
    }
    case "no-version":
      return [item("needs-you", "watcher-stale-version", (w) => w.t("status.watcher.noVersion", { pid: h.pid }), restart)];
    case "no-stamp":
      return [item("needs-you", "watcher-stale-version", (w) => w.t("status.watcher.noStamp", { pid: h.pid, version: h.version }), restart)];
    case "stale-version":
      return [item("needs-you", "watcher-stale-version", (w) => w.t(h.rebuilt ? "status.watcher.staleRebuilt" : "status.watcher.staleVersion", { pid: h.pid, version: h.version, installed: h.installed }), restart)];
    case "running": {
      const out: StatusItem[] = [];
      if (!h.fresh && t3Running) {
        const last = h.lastCycleAt === null ? null : now - (time(h.lastCycleAt) ?? now);
        out.push(item("needs-you", "watcher-late", (w) => (last === null ? w.t("status.watcher.lateNoCycle", { pid: h.pid }) : w.t("status.watcher.late", { pid: h.pid, ago: w.ago(last) })), restart));
      }
      const pending = h.pendingVersion;
      if (pending !== null) out.push(item("info", "watcher-switching", (w) => w.t("status.watcher.switching", { version: pending }), null));
      return out;
    }
  }
}

export async function collectStatus(dir: string, home: string, d: Required<StatusDeps>): Promise<StatusReport> {
  const now = d.now();
  let plugin: StatusReport["plugin"] = [];
  try {
    plugin = await Promise.all((await d.accounts()).map(async (a) => {
      const s = await d.pluginState(a.home);
      return { account: shownText(a.id, 40), ...(a.name ? { name: shownAccountName(a.name) } : {}), state: s.state, version: s.state === "missing" ? null : s.version };
    }));
  } catch { plugin = []; }
  const fields = await readSyncStatus(dir);
  const hb = await readHeartbeat(dir);
  const alive = hb !== null && !hb.stoppedAt && d.pidAlive(hb.pid);
  const result = hb && hb.lastResult && typeof hb.lastResult === "object" ? hb.lastResult : null;
  // A config.json that cannot be used is a need of its own: every sync (and the watcher, at start-up) stops on it.
  let config: Config | null = null;
  let configError: string | null = null;
  try { config = await loadConfig(dir, home); } catch (e) { configError = (e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0]!; }
  const entries = await new Journal(join(dir, "journal.jsonl")).readAll().catch(() => [] as JournalEntry[]);
  const plan = await newestPlan(dir);

  const fromHb: SyncSeen | null = hb && time(hb.lastCycleAt) !== null
    ? { at: hb.lastCycleAt!, outcome: str(result?.["outcome"]) ?? "unknown", runId: str(result?.["runId"]), pending: result?.["outcome"] === "over-limit" && typeof result["pending"] === "number" ? result["pending"] : null }
    : null;
  const fromLog = await lastLogLine(dir);
  const seen = fromHb && fromLog ? (time(fromLog.at)! > time(fromHb.at)! ? fromLog : fromHb) : fromHb ?? fromLog;

  // Only the per-cycle field: each cycle that looked replaces it, so a stopped watcher's old result is never shown.
  const waiting: StatusReport["waiting"] = fields.held.map((h) => ({ project: shownText(h.project, 120), title: h.title === null ? null : shownText(h.title, 120), modifiedAt: h.modifiedAt, since: h.since ?? h.modifiedAt }));

  let pendingImports: StatusReport["pendingImports"] = null;
  if (seen && seen.pending !== null) pendingImports = { count: seen.pending, source: "sync", at: seen.at };
  else if (plan) pendingImports = { count: plan.items.filter((i) => i.action.kind !== "skip").length, source: "plan", at: plan.createdAt };

  // Undecided: whichever looked last, the last cycle or the newest plan; the plan whenever no cycle can have recorded
  // them (a 0.2.1 watcher, without a version, never writes `undecided`; nor does a file no cycle wrote it into).
  const planAt = plan ? time(plan.createdAt) : null;
  const cycleAt = seen ? time(seen.at) : null;
  const cycleRecords = (await recordsUndecided(dir)) && !(hb !== null && (typeof hb.version !== "string" || parseSemver(hb.version) === null));
  const fromPlan = plan !== null && (!cycleRecords || (planAt !== null && (cycleAt === null || planAt > cycleAt)));
  const decisionsPending: Record<string, number> = fromPlan
    ? Object.fromEntries((plan!.decisionsPending ?? []).filter((q) => q.sessions > 0).map((q) => [q.key, q.sessions]))
    : fields.undecided;

  const runs = listRuns(entries);
  const orgRuns = runs.filter((r) => r.command === "organize");
  const org = orgRuns[orgRuns.length - 1];
  const lastOrganize: StatusReport["lastOrganize"] = org ? { runId: org.runId, at: org.at, changes: org.counts.organized, reverted: org.counts.organizeReverted, rolledBackBy: org.rolledBackBy } : null;

  const rt = await d.readRuntime(home).catch(() => null);
  const t3Running = rt !== null && d.pidAlive(rt.pid);
  const next = alive ? time(hb?.nextCycleAt) : null;

  const health = watcherHealth(hb, { now, pidAlive: d.pidAlive, install: d.installStamp, everyMinutes: config?.schedule.everyMinutes ?? DEFAULT_SCHEDULE_MINUTES });
  const stale = health.state === "no-version" || health.state === "no-stamp" || health.state === "stale-version" || (health.state === "running" && !health.fresh && t3Running);

  const lock = await lockInfo(dir).catch(() => null);
  const runInProgress = lock && d.pidAlive(lock.pid) ? { pid: lock.pid, startedAt: lock.startedAt } : null;

  // ---------- updates ----------
  const installed = d.packageVersion;
  // Unknown versions (not release versions) cannot be compared: the record is still shown.
  const notReached = (to: string): boolean => parseSemver(installed) === null || parseSemver(to) === null || compareSemver(installed, to) < 0;
  const recorded = await readUpdateFailure(dir);
  const failure = recorded && notReached(recorded.to) ? recorded : null;
  const updateState = await readUpdateState(dir);
  const available = updateState?.available && parseSemver(updateState.available) !== null && notReached(updateState.available) ? updateState.available : null;
  const lastUpdate = [...entries].reverse().find((e): e is Extract<JournalEntry, { t: "update" }> => e.t === "update" && e.outcome === "installed"
    && typeof e.from === "string" && typeof e.to === "string" && parseSemver(e.from) !== null && parseSemver(e.to) !== null);
  const installedAt = lastUpdate ? runIdTime(lastUpdate.runId) : null;
  const lastInstalled = lastUpdate ? { from: lastUpdate.from, to: lastUpdate.to, at: installedAt === null ? null : new Date(installedAt).toISOString() } : null;
  const pending = await readPendingUpdate(dir);

  // ---------- items, in the order of spec §5.5 ----------
  const items: StatusItem[] = [];
  const na = fields.needsAttention;
  items.push(...watcherItems(health, t3Running, now));
  // A watcher that stopped at start-up never wrote a heartbeat: the clean stop before it (or nothing) would read as
  // "All good". sync.log's last line says it, when it is newer than anything the heartbeat records.
  const hbLatest = hb === null ? null : Math.max(...[hb.startedAt, hb.lastCycleAt, hb.stoppedAt].map((x) => time(x) ?? -Infinity));
  if (fromLog && START_FAILURES.has(fromLog.outcome) && !alive && (hbLatest === null || time(fromLog.at)! > hbLatest)
    && !(configError !== null && /\bConfigError\b/.test(fromLog.rest ?? ""))) {
    const ago = now - time(fromLog.at)!;
    const name = shownText(/\b(\w*Error)\b/.exec(fromLog.rest ?? "")?.[1] ?? "Error", 40);
    items.push(fromLog.outcome === "socket-dir-unsafe"
      ? item("needs-you", "watcher-cannot-start", (w) => w.t("status.watcher.socketUnsafe", { ago: w.ago(ago) }), "t3sm doctor")
      : item("needs-you", "watcher-cannot-start", (w) => w.t("status.watcher.cannotStart", { ago: w.ago(ago), name }), "t3sm doctor"));
  }
  if (configError !== null) {
    const error = shownText(maskHome(configError, home), 200);
    items.push(item("needs-you", "config-error", (w) => w.t("status.configError", { error }), "t3sm doctor"));
  }
  if (fields.failures >= REPEATED_FAILURES || na?.reason === "repeated-failures") {
    const n = fields.failures;
    items.push(item("needs-you", "sync-failing", (w) => (n >= REPEATED_FAILURES ? w.t("status.syncFailing.count", { n }) : w.t("status.syncFailing.repeated")), "t3sm doctor"));
  }
  // What only a cycle can see (T3 Code's answers): shown as sync recorded it, with its own command.
  if (na && (na.reason === "t3-incompatible" || na.reason === "signed-out")) {
    items.push(item("needs-you", `attention:${na.reason}`, (w) => shownText(attentionText(na, w.lang), 300), shownText(na.command, 200), shownText(na.detail, 300)));
  }

  if (failure && failure.outcome === "rolled-back") {
    // Rolled back: the previous version was reinstalled and is running, so t3sm recovered by itself. Worth knowing
    // (which version runs, and that the automatic check skips the bad one), never a need. The notification was sent
    // once by the update itself.
    const running = parseSemver(installed) !== null ? installed : failure.from;
    items.push(item("info", "update-rolled-back", (w) => w.t("status.update.rolledBackInfo", { to: failure.to, installed: running }), "t3sm update --check"));
  }
  else if (failure) {
    const key: CliKey = failure.outcome === "interrupted" ? "status.update.interrupted" : "status.update.failed";
    items.push(item("needs-you", "update-failed", (w) => w.t(key, { from: failure.from, to: failure.to }), "t3sm update --check", updateFailureText(failure)));
  }
  // A run holding the lock hides the attempt only when it may be that update itself: the update takes the lock before it
  // writes the attempt, so a lock taken after the attempt started belongs to another run (the attempt's own died).
  else if (pending && !pending.interrupted && notReached(pending.target)
    && (runInProgress === null || (time(runInProgress.startedAt) ?? -Infinity) > (time(pending.startedAt) ?? Infinity))
    && !entries.some((e) => e.t === "update" && e.runId === pending.runId && e.outcome !== "pending")) {
    // An attempt on disk that nobody is running and that never recorded an outcome: it was interrupted.
    const v = { from: pending.previous.version, to: pending.target };
    items.push(item("needs-you", "update-interrupted", (w) => w.t("status.update.interrupted", v), "t3sm update --check"));
  }
  if (available) {
    // Announced only (spec §5.3: a major release is never installed by itself, and it never needs you).
    const major = classify(installed, available) === "major";
    items.push(major
      ? item("info", "update-major", (w) => w.t("status.update.major", { version: available }), "t3sm update")
      : item("info", "update-available", (w) => w.t("status.update.available", { version: available }), "t3sm update"));
  }
  if (lastUpdate && installedAt !== null && now - installedAt <= RECENT_INSTALL_MS && lastUpdate.to === installed) {
    const to = lastUpdate.to;
    const since = now - installedAt;
    items.push(item("info", "update-installed", (w) => w.t("status.update.installed", { version: to, day: w.day(since) }), "t3sm changelog"));
  }

  const questions = Object.entries(decisionsPending);
  const undecided = questions.reduce((a, [, n]) => a + n, 0);
  if (undecided > 0) {
    items.push(undecidedItem(decisionsPending));
  }
  if (na?.reason === "over-limit") items.push(item("needs-you", "attention:over-limit", (w) => shownText(attentionText(na, w.lang), 300), shownText(na.command, 200), shownText(na.detail, 300)));

  // Sessions are named by their project folder (the plan knows it; a folder name, never its path) and a short id.
  const folders = new Map<string, string>();
  for (const i of plan?.items ?? []) {
    const s = i.session as Partial<Plan["items"][number]["session"]> | undefined;
    const folder = typeof s?.cwd === "string" ? s.cwd.split(/[\\/]+/).filter((x) => x !== "").pop() : undefined;
    if (s && typeof s.harness === "string" && typeof s.nativeId === "string" && folder) folders.set(sessionKey(s.harness, s.nativeId), folder);
  }
  const nameOf = (harness: string, nativeId: string): string => {
    const id = `${shownText(harness, 20)} ${shownText(nativeId.slice(0, 8), 8)}`;
    const f = folders.get(sessionKey(harness, nativeId));
    return f !== undefined ? `${shownText(f, 60)} (${id})` : id;
  };
  // The plan's items with a readable session (plan.json is read as written, item by item it may hold anything).
  const planItems = (plan?.items ?? []).filter((i) => i && typeof i === "object" && i.session && typeof i.session.harness === "string"
    && typeof i.session.nativeId === "string" && i.action && typeof i.action === "object");
  // Only sessions the newest plan still tries to import (one deleted since, or no plan at all, is nothing to act on). A
  // session it skips for a reason other than a failure (started in T3 Code, already in T3 Code, in use, ...) is not
  // failing now, whatever earlier runs journaled: the plan's own item says why it stays out.
  const inPlan = new Set(planItems
    .filter((i) => i.action.kind !== "skip" || FAILURE_SKIPS.has(i.action.reason))
    .map((i) => sessionKey(i.session.harness, i.session.nativeId)));
  for (const [reason, all] of repeatedFailures(entries)) {
    const sessions = all.filter((x) => inPlan.has(sessionKey(x.harness, x.nativeId)));
    if (sessions.length === 0) continue;
    const why = shownText(maskHome(reason, home), 120);
    const names = sessions.map((s) => nameOf(s.harness, s.nativeId));
    items.push(item("needs-you", `import-failing:${why}`, (w) => w.t("status.importFailing", { n: sessions.length, why, names: w.list(names) }), "t3sm doctor"));
  }
  const skipped = (reason: string): string[] => planItems
    .filter((i) => i.action.kind === "skip" && i.action.reason === reason)
    .map((i) => nameOf(i.session.harness, i.session.nativeId));
  const orphaned = skipped("orphaned-in-t3");
  if (orphaned.length > 0) {
    items.push(item("info", "orphaned-in-t3", (w) => w.t("status.orphaned", { n: orphaned.length, names: w.list(orphaned) }), null));
  }
  const unknown = skipped("t3-native-unknown");
  if (unknown.length > 0) {
    items.push(item("info", "t3-native-unknown", (w) => w.t("status.nativeUnknown", { n: unknown.length, names: w.list(unknown) }), null));
  }
  for (const c of fields.followConflicts ?? []) {
    // No resolve command yet (ruling): name both conversations and how to choose by hand.
    const v = { original: shownText(c.originalTitle, 80), copy: shownText(c.copyTitle, 80) };
    items.push(item("needs-you", `follow-conflict:${shownText(c.copyId, 80)}`, (w) => w.t("status.followConflict", v), null));
  }

  for (const w of waiting) {
    const title = w.title === null ? null : shownText(w.title, 80);
    const project = w.project;
    const since = now - (time(w.since) ?? now);
    items.push(item("info", `held:${project}`, (x) => (title === null ? x.t("status.heldUntitled", { project, ago: x.ago(since) }) : x.t("status.held", { project, title, ago: x.ago(since) })), null));
  }
  if (fields.heldRehome > 0) {
    const n = fields.heldRehome;
    items.push(item("needs-you", "held-rehome", (w) => w.t("status.heldRehome", { n }), "t3sm start"));
  }

  // Organize failures of the last organize run: the newest `organize` run (even one with nothing to change), or a newer
  // run of any command that journaled organize entries (sync, journaled as `sync <runId>`, organizes what it imported
  // and carries follow settles; `projects rename` writes project titles). Only that run's failures count.
  const organizedIn = new Set(entries.filter((e) => e.t === "organize-change" || e.t === "organize-failed").map((e) => e.runId));
  const lastOrg = [...runs].reverse().find((r) => r.command === "organize" || organizedIn.has(r.runId));
  const orgFailed = lastOrg && lastOrg.rolledBackBy === null ? organizeFailures(entries, lastOrg.runId) : [];
  if (lastOrg && orgFailed.length > 0) {
    const kinds = new Map<string, number>();
    for (const f of orgFailed) kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
    const byKind = [...kinds].map(([k, n]) => `${n} ${k}`).join(", ");
    const v = { n: orgFailed.length, runId: shownText(lastOrg.runId, 60), kinds: byKind, error: shownText(maskHome(orgFailed[0]!.error, home), 120) };
    items.push(item("needs-you", "organize-failed", (w) => w.t("status.organizeFailed", v), "t3sm organize"));
  }

  // Every text and command once more through shownText (no control, bidi or format characters; one line; capped).
  const clean = (i: StatusItem): StatusItem => withSay({ level: i.level, key: shownText(i.key, 120), text: shownText(i.text, ITEM_TEXT_MAX), command: i.command === null ? null : shownText(i.command, ITEM_COMMAND_MAX) }, sayOf(i));
  const ordered = [...items.filter((i) => i.level === "needs-you"), ...items.filter((i) => i.level === "info")].map(clean);
  const level: StatusLevel = ordered.some((i) => i.level === "needs-you") ? "needs-you" : runInProgress ? "working" : "ok";

  return {
    version: 2,
    ran: true,
    level,
    items: ordered,
    needsAttention: na && { ...na, detail: shownText(na.detail, 300), command: shownText(na.command, 200) },
    waiting,
    heldRehome: fields.heldRehome,
    decisionsPending,
    pendingImports,
    lastSync: seen ? { at: seen.at, outcome: seen.outcome, runId: seen.runId } : null,
    nextSync: next !== null ? { at: new Date(next).toISOString(), source: "watcher" } : null,
    watcher: hb ? { running: alive, pid: hb.pid, version: typeof hb.version === "string" && parseSemver(hb.version) !== null ? hb.version : null, stale } : null,
    update: { installed, available, failure, lastInstalled },
    runInProgress,
    lastOrganize,
    plugin,
    t3Code: { running: t3Running, version: t3Running ? rt!.serverVersion : null },
  };
}

/**
 * The screen: one lead line (all good, needs you with the count, or working), the needs-you items as callouts with
 * their command, then the info items, then the details as aligned label-value rows; in `ui`'s language and width.
 */
export function renderStatus(r: StatusReport, o: { ui: CliUi; now: number; version: string }): string {
  const { ui } = o;
  const { s, t } = ui;
  const width = Math.max(1, ui.width);
  const w = words(ui.lang);
  const age = (iso: string | null): string => { const x = time(iso); return x === null ? t("status.unknownTime") : w.ago(o.now - x); };
  const out: string[] = [];

  const needs = r.items.filter((i) => i.level === "needs-you");
  const info = r.items.filter((i) => i.level === "info");
  if (r.level === "needs-you") out.push(...leadLines(s, { sym: s.sym.warn, tone: "warn", word: t("status.needsYou", { n: needs.length }) }, width));
  else if (r.level === "working") {
    out.push(...leadLines(s, { sym: s.sym.dot, tone: "accent", word: t("status.working"), note: t("status.workingNote", { pid: r.runInProgress!.pid, age: age(r.runInProgress!.startedAt) }) }, width));
  } else out.push(...leadLines(s, { sym: s.sym.ok, tone: "ok", word: t("status.allGood"), note: t("status.allGoodNote") }, width));
  // Sanitized here too: a report is not always built by collectStatus. An item without words of its own (a detail a
  // sync cycle recorded) keeps its English text. The sentence is wrapped so nothing is cut: its first line is the
  // callout's title, the rest its body.
  const say = (kind: "needs-you" | "info", i: StatusItem): void => {
    const sayer = sayOf(i);
    const text = shownText(sayer ? sayer(w) : i.text, ITEM_TEXT_MAX);
    const [first = "", ...rest] = wrapText(text, Math.max(1, width - 2));
    out.push("", ...callout(s, { kind, title: first, body: rest, ...(i.command !== null ? { command: shownText(i.command, ITEM_COMMAND_MAX) } : {}) }, width));
  };
  for (const i of needs) say("needs-you", i);
  if (info.length > 0) {
    out.push("", ...fitLine(s("muted", t("status.worthKnowing")), width));
    for (const i of info) say("info", i);
  }

  const rows: [string, string][] = [];
  if (r.pendingImports) {
    const p = r.pendingImports;
    rows.push([t("status.label.pending"), p.count === 0 ? t("status.pending.none")
      : p.source === "plan" ? t("status.pending.fromPlan", { n: p.count, age: age(p.at) }) : t("status.pending.sessions", { n: p.count })]);
  }
  const ls = r.lastSync;
  rows.push([t("status.label.lastSync"), ls
    ? ls.runId ? t("status.lastSync.valueRun", { age: age(ls.at), outcome: shownText(ls.outcome, 40), runId: shownText(ls.runId, 60) }) : t("status.lastSync.value", { age: age(ls.at), outcome: shownText(ls.outcome, 40) })
    : t("status.lastSync.never")]);
  if (r.nextSync) rows.push([t("status.label.nextSync"), t("status.nextSync.value", { when: w.ago(o.now - Date.parse(r.nextSync.at)) })]);
  if (r.watcher) {
    const wt = r.watcher;
    // Not running: the short word. What it means and what to do is the item above (or its stop was clean).
    rows.push([t("status.label.watcher"), !wt.running ? t("status.watcher.notRunningShort")
      : wt.version === null ? t("status.watcher.running", { pid: wt.pid }) : t("status.watcher.runningVersion", { pid: wt.pid, version: shownText(wt.version, 20) })]);
  }
  rows.push([t("status.label.t3sm"), shownText(r.update.installed, 20)]);
  if (r.lastOrganize) {
    const l = r.lastOrganize;
    rows.push([t("status.label.lastOrganize"), t("status.organize.value", { runId: shownText(l.runId, 60), age: age(l.at), n: l.changes })
      + (l.reverted ? t("status.organize.undone", { n: l.reverted }) : "")
      + (l.rolledBackBy ? t("status.organize.rolledBack", { runId: shownText(l.rolledBackBy, 60) }) : "")]);
  }
  if (r.plugin.length > 0) {
    const state = (p: StatusReport["plugin"][number]): string =>
      describePlugin(p.state === "missing" ? { state: "missing" } : { state: p.state, version: p.version ?? "unknown" }, o.version, ui.lang);
    // By the account's display name (its id only when it has none); --json keeps the id.
    const plugins = r.plugin.map((p) => `${p.name !== undefined ? shownAccountName(p.name) : shownText(p.account, 60)}: ${state(p)}`).join("; ");
    rows.push([t("status.label.plugin"), r.plugin.some((p) => p.state === "missing") ? t("status.plugin.offer", { plugins }) : plugins]);
  }
  rows.push([t("status.label.t3Code"), r.t3Code.running ? t("status.t3.running", { version: shownText(r.t3Code.version ?? t("status.t3.unknownVersion"), 40) }) : t("status.t3.notRunning")]);
  out.push("", ...kv(s, rows, width));
  return out.join("\n") + "\n";
}

export async function statusCommand(args: string[], io: Io, deps: StatusDeps = {}): Promise<number> {
  const p = parseFlags(args, io, "status", [...FLAG_SPECS.status.bool]);
  if (!p) return 2;
  const json = p.flags.has("--json");
  const now = deps.now ?? Date.now;
  const ui = cliUi(io, { now });
  const home = deps.home ?? homedir();
  const dir = stateDir(io.env, home);
  try { await stat(dir); } catch {
    io.stdout(json ? JSON.stringify({ version: 2, ran: false }, null, 2) + "\n" : `${ui.t("status.notRun")}\n`);
    return 0;
  }
  const version = deps.packageVersion ?? ownVersion();
  const report = await collectStatus(dir, home, {
    home, now, pidAlive: deps.pidAlive ?? pidAlive, readRuntime: deps.readRuntime ?? readServerRuntime, packageVersion: version,
    accounts: deps.accounts ?? (async () => {
      const c = await loadConfig(dir, home).catch(() => null);
      return c ? c.accounts.map((a) => ({ id: a.id, home: expandHome(a.home, home), name: a.displayName })) : [{ id: "default", home: join(home, ".claude"), name: "~/.claude" }];
    }),
    pluginState: deps.pluginState ?? ((h) => readPluginState(h, version)),
    installStamp: deps.installStamp ?? ((root) => {
      const r = root ?? installRoot();
      try { return { ...installStamp(r), changedAtMs: installChangedAt(r) }; } catch { return null; }
    }),
  });
  const code = report.level === "needs-you" ? NEEDS_YOU_EXIT : 0;
  // --json keeps its keys: the plugin entries by account id only (the display name is for the screen).
  if (json) { io.stdout(JSON.stringify({ ...report, plugin: report.plugin.map(({ name: _n, ...p }) => p) }, null, 2) + "\n"); return code; }
  io.stdout(renderStatus(report, { ui, now: now(), version }));
  return code;
}
