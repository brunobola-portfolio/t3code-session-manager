// `t3sm doctor`: the first command a new user runs. Read-only: it writes nothing except, with --repair, the restore of
// pending transcript file times (under the state-dir lock). It opens at most one T3 session (read-only scopes) and
// revokes it before returning. Every check is isolated and bounded by a timeout (its own, or the default 10 s): a throw
// or a timeout is `fail` only for the checks that block t3sm (CRITICAL_CHECKS); for every other check it is a `warn`, so
// a slow, large home never reads as a problem to fix.

import { statSync } from "node:fs";
import { access, constants, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, hostname, uptime } from "node:os";
import type { AccountConfig, Config, HarnessId, JournalEntry } from "../core/types.ts";
import { ConfigError, DEFAULT_SCHEDULE_MINUTES, defaultConfig, loadConfig } from "../core/config.ts";
import { expandHome, normalizeCwd, pathKey, sameCwd, stateDir as stateDirOf, tildePath } from "../core/paths.ts";
import { ACTIVE_WINDOW_MS } from "../core/activity.ts";
import { Journal, pendingMtimePaths, recoverPendingMtimes, type RecoverResult } from "../core/journal.ts";
import { acquireLock, lockInfo, rebootedSince, type LockInfo } from "../core/lock.ts";
import { probeServer, readServerRuntime, resolveT3Cli, type ServerRuntime } from "../t3/runtime.ts";
import { connectT3, type ProviderInstanceInfo, type T3Api } from "../t3/api.ts";
import { checkCompat, TESTED_VERSIONS } from "../t3/compat.ts";
import { defaultRunner } from "../t3/auth.ts";
import { redact } from "../t3/errors.ts";
import { describeError, oneLine } from "./errorCodes.ts";
import type { Lang } from "../assistant/i18n.ts";
import { cliT, type CliKey } from "../i18n/cli.ts";
import { STOP_SIGNALS, futureLeftovers } from "../apply/apply.ts";
import { discoverAccountHomes, formatSources, nodeDiscoveryEnv, resolveAccounts, type DiscoveredHome } from "./discoverAccounts.ts";
import { findBackupDirs, findOrphanedQuarantine, QUARANTINE_DIR, type OrphanedItem } from "./quarantine.ts";
import { defaultBinPath, realRunner, scheduleSpec, scheduleStatus } from "./schedule.ts";
import { pidAlive, readHeartbeat, type Heartbeat } from "./watch.ts";
import { readMergePending } from "./merge.ts";
import { PLUGIN_ID, packageVersion, readPluginState, type PluginState } from "./plugin.ts";
import { installChangedAt, installRoot, installStamp, type InstallStamp } from "../core/version.ts";
import { watcherHealth } from "./watcherHealth.ts";
import { allAdapters, sessionForms, sessionIdsInT3 } from "../sources/registry.ts";
import { countCodexSessions } from "../sources/codex.ts";
import type { Availability, FileTime } from "../sources/types.ts";
import { shownAccountName, shownText } from "../plan/names.ts";
import { maskEmail, maskEmailsIn } from "../core/mask.ts";

export interface SignalSource {
  once(ev: "SIGINT" | "SIGTERM" | "SIGHUP", fn: () => void): unknown;
  off(ev: "SIGINT" | "SIGTERM" | "SIGHUP", fn: () => void): unknown;
}

export interface HarnessStatus {
  id: HarnessId; available: boolean; problem?: string;
  /**
   * Codex: sessions T3 Code imports natively (plain rollouts), convertible ones (compressed `.jsonl.zst`, converted into
   * Claude threads), skipped ones (duplicate files, sub-agents, no id or cwd, too large, compressed with conversion
   * off) and read errors (files or folders that could not be read; not sessions). sessionIds: the native ids of the
   * importable and convertible ones (counted as already in T3 under either form when T3 is reachable).
   */
  importable?: number; convertible?: number; skipped?: number; readErrors?: number; sessionIds?: string[];
}

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

const part = (key: CliKey, vars?: SayPart["vars"], sep?: string): SayPart => ({ key, ...(vars ? { vars } : {}), ...(sep !== undefined ? { sep } : {}) });

/** A check worded from the catalogue: its English message and fix, and the parts the screen words in any language. */
function said(id: string, status: CheckStatus, msg: SayPart[], fix?: SayPart[], data?: CheckData): Check {
  return {
    id, status, message: sayText(msg, "en"), say: msg,
    ...(fix && fix.length > 0 ? { fix: sayText(fix, "en"), sayFix: fix } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

export interface DoctorDeps {
  home: string;
  platform: NodeJS.Platform;
  /** The user's shell environment (CLAUDE_CONFIG_DIR, NO_COLOR...). */
  env: NodeJS.ProcessEnv;
  stateDir: string;
  nodeVersion: string;
  now(): number;
  /** --repair: restore pending transcript file times (the only write doctor makes). */
  repair: boolean;
  /** Per-check budget (default 10 s). */
  timeoutMs?: number;
  /** Budgets of single checks, by id (default CHECK_TIMEOUTS_MS; the others use timeoutMs). */
  checkTimeoutsMs?: Partial<Record<string, number>>;
  /** Budget for revoking an open T3 session (default 3 s). */
  closeTimeoutMs?: number;
  /** This machine's host name (default os.hostname()): a lock from another host is reported as such. */
  hostname?: string;
  /** Ctrl+C / SIGTERM while a T3 session is open: revoke it, then exit 130 (default: process / process.exit). */
  signals?: SignalSource;
  exit?: (code: number) => void;
  /** Throws ConfigError when config.json is invalid. */
  loadConfig(): Promise<Config | null>;
  /** Accounts used when there is no config.json (what plan/scan would detect). */
  detectAccounts(): Promise<AccountConfig[]>;
  /** null when the state dir is (or can be created) writable, else the reason. Never writes. */
  stateWritable(): Promise<string | null>;
  lockInfo(): Promise<LockInfo | null>;
  /** Signal-0 probe only; never kills. */
  pidAlive(pid: number): boolean;
  /** Seconds since this machine booted (default os.uptime): a lock taken at a higher uptime predates the last restart. */
  uptime?: () => number;
  readJournal(): Promise<JournalEntry[]>;
  /**
   * Native transcripts (Claude, Codex, Pi) with their file times, for the future-mtimes check: streamed, so the check
   * can stop at its budget and report how far it got. Read-only, stat only (no transcript is opened).
   */
  futureMtimes?(config: Config): AsyncIterable<FileTime> | Promise<FileTime[]>;
  /** Takes the lock and runs recoverPendingMtimes; null when another run holds the lock. */
  repairMtimes(): Promise<RecoverResult | null>;
  readRuntime(): Promise<ServerRuntime | null>;
  probe(rt: ServerRuntime): Promise<boolean>;
  resolveCli(): string | null;
  /** One read-only T3 session (token + websocket ticket). Closed (revoked) by runDoctor. */
  connect(): Promise<T3Api>;
  discover(instanceHomes: string[]): Promise<DiscoveredHome[]>;
  findBackupDirs(accountHome: string): Promise<string[]>;
  findOrphanedQuarantine(accounts: { home: string }[], entries: JournalEntry[]): Promise<OrphanedItem[]>;
  /** Harness adapters with sessions on this machine (isAvailable). Codex: rollout files by kind (none opened). */
  harnesses(config: Config): Promise<HarnessStatus[]>;
  findBin(name: string): string | null;
  binVersion(path: string): Promise<string | null>;
  /** `missing`: paths in the installed command that no longer exist (when the scheduler module reports them). */
  scheduleStatus(): Promise<{ kind: string; installed: boolean; nextRun: string | null; detail: string | null; missing?: string[] }>;
  readHeartbeat(): Promise<Heartbeat | null>;
  /**
   * What an install root holds now (null root: this t3sm's own) and when that last changed on disk; null when it cannot
   * be read. The watcher's heartbeat is compared with it (stale version).
   */
  installStamp?(root: string | null): (InstallStamp & { changedAtMs: number | null }) | null;
  /** This t3sm's version (what an installed plugin is compared with). */
  packageVersion?: string;
  /** The t3sm plugin in one Claude account home (reads <home>/plugins/installed_plugins.json; never writes). */
  pluginState?(accountHome: string): Promise<PluginState>;
  /** Sessions continued in a terminal and waiting for `t3sm merge`, as last counted by sync / merge (cache only). */
  mergePending?(): Promise<{ count: number; orphaned: number; at: string } | null>;
}

const MIN_NODE: [number, number] = [22, 18];
const LOCK_OLD_MS = 6 * 3600_000;
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Checks with their own budget: future-mtimes stats every native transcript (thousands on a large home, cold), and
 * harnesses may snapshot the OpenCode db. Both degrade to a warn when they run out of time.
 */
export const CHECK_TIMEOUTS_MS: Readonly<Record<string, number>> = { "future-mtimes": 45_000, harnesses: 30_000 };
/** The only checks whose throw or timeout is a FAIL: without them t3sm cannot run (or would import wrongly). */
const CRITICAL_CHECKS = new Set(["node-version", "state-dir", "config", "t3-runtime", "t3-reachable", "t3-version", "t3-cli", "t3-token", "instances", "instance-home-drift"]);
const HARNESS_BIN: Record<HarnessId, string> = { claude: "claude", codex: "codex", pi: "pi", opencode: "opencode" };
const HARNESS_DRIVER: Partial<Record<HarnessId, string>> = { codex: "codex", pi: "pi" };

export { maskEmail };

export { pendingMtimePaths };

class CheckTimeout extends Error {}

const CLOSE_TIMEOUT_MS = 3_000;

/** Settles when `p` settles (either way) or after `ms`, whichever comes first; the timer is always cleared. */
function bounded(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.then(() => {}, () => {}), new Promise<void>((r) => { timer = setTimeout(r, ms); })]).finally(() => clearTimeout(timer));
}

export async function runDoctor(deps: DoctorDeps): Promise<{ checks: Check[] }> {
  const { home, platform } = deps;
  const budgetOf = (id: string): number => deps.checkTimeoutsMs?.[id] ?? CHECK_TIMEOUTS_MS[id] ?? deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t = (p: string) => tildePath(p, home, platform);
  const win = platform === "win32";
  const openT3 = [part(win ? "doctor.fix.openT3.win" : "doctor.fix.openT3.other")];
  const slowFix = [part("doctor.fix.slow")];
  const checks: Check[] = [];

  /** `onTimeout` (optional) builds the check's own result when its budget runs out (e.g. how far a walk got). */
  async function run(id: string, fn: () => Promise<Check | Check[]>, onTimeout?: (budgetMs: number) => Check): Promise<void> {
    const budget = budgetOf(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([
        fn(),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new CheckTimeout()), budget); }),
      ]);
      checks.push(...(Array.isArray(r) ? r : [r]));
    } catch (e) {
      if (e instanceof CheckTimeout && onTimeout) { checks.push(onTimeout(budget)); return; }
      const s = budget / 1000;
      const msg = e instanceof CheckTimeout ? [part("doctor.say.timeout", { s })] : [part("doctor.say.error", { error: oneLine(describeError(e).message.replace(/^Unexpected error: /, "")) })];
      if (CRITICAL_CHECKS.has(id)) checks.push(said(id, "fail", msg));
      else if (e instanceof CheckTimeout) checks.push(said(id, "warn", [part("doctor.say.timeoutWarn", { s })], slowFix));
      else checks.push(said(id, "warn", msg));
    } finally {
      clearTimeout(timer);
    }
  }
  const ok = (id: string, ...msg: SayPart[]): Check => said(id, "ok", msg);
  const skip = (id: string, ...msg: SayPart[]): Check => said(id, "skip", msg);
  const needsT3 = (id: string): Check => skip(id, part("doctor.say.needsT3"));
  const needs = (id: string, check: string): Check => skip(id, part("doctor.say.needs", { check }));

  // ---------- this machine ----------
  await run("node-version", async () => {
    const [maj = 0, min = 0] = deps.nodeVersion.split(".").map(Number);
    const good = maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
    return good ? ok("node-version", part("doctor.say.nodeVersion.ok", { version: deps.nodeVersion }))
      : said("node-version", "fail", [part("doctor.say.nodeVersion.old", { version: deps.nodeVersion, min: MIN_NODE.join(".") })], [part("doctor.fix.nodeVersion")]);
  });

  await run("state-dir", async () => {
    const why = await deps.stateWritable();
    return why === null ? ok("state-dir", part("doctor.say.stateDir.ok", { dir: t(deps.stateDir) }))
      : said("state-dir", "fail", [part("doctor.say.stateDir.fail", { dir: t(deps.stateDir), why })], [part("doctor.fix.stateDir")]);
  });

  let config: Config | null = null;
  let configValid = true;
  await run("config", async () => {
    try {
      config = await deps.loadConfig();
    } catch (e) {
      configValid = false;
      if (e instanceof ConfigError) {
        return said("config", "fail", [part("doctor.say.config.invalid", { error: oneLine(e.message.split("\n").slice(0, 2).join(" ")) })], [part("doctor.fix.config")]);
      }
      throw e;
    }
    if (config === null) return ok("config", part("doctor.say.config.none"));
    const c = config as Config;
    return ok("config", part("doctor.say.config.ok", { n: c.accounts.length, ids: c.accounts.map((a) => a.id).join(", "), default: c.defaultAccount }));
  });
  let accounts: AccountConfig[] = [];
  try { accounts = config !== null ? (config as Config).accounts : configValid ? await deps.detectAccounts() : []; } catch { accounts = []; }
  const expanded = accounts.map((a) => ({ ...a, home: expandHome(a.home, home) }));
  const effective: Config = config ?? defaultConfig(expanded);

  await run("lock", async () => {
    const info = await deps.lockInfo();
    if (info === null) return ok("lock", part("doctor.say.lock.free"));
    const file = t(join(deps.stateDir, "lock"));
    if (info.hostname !== (deps.hostname ?? hostname())) {
      // A shared state folder: the pid means nothing here, and t3sm never takes over another machine's lock.
      const what = part("doctor.say.lock.otherMachine", { pid: info.pid, ageMs: info.ageMs });
      return info.ageMs > LOCK_OLD_MS ? said("lock", "warn", [what], [part("doctor.fix.lock.otherMachine", { file })]) : ok("lock", what);
    }
    if (rebootedSince(info.uptimeSec, (deps.uptime ?? uptime)())) return ok("lock", part("doctor.say.lock.rebooted"));
    const alive = deps.pidAlive(info.pid);
    if (!alive) return ok("lock", part("doctor.say.lock.gone", { pid: info.pid }));
    if (info.ageMs > LOCK_OLD_MS) return said("lock", "warn", [part("doctor.say.lock.old", { ageMs: info.ageMs, pid: info.pid })], [part("doctor.fix.lock.old", { file })]);
    return ok("lock", part("doctor.say.lock.held", { pid: info.pid, ageMs: info.ageMs }));
  });

  let journal: JournalEntry[] = [];
  await run("pending-mtimes", async () => {
    journal = await deps.readJournal();
    const pending = pendingMtimePaths(journal, platform);
    if (pending.length === 0) return ok("pending-mtimes", part("doctor.say.pendingMtimes.none"));
    const what = part("doctor.say.pendingMtimes.left", { n: pending.length });
    if (!deps.repair) return said("pending-mtimes", "warn", [what], [part("doctor.fix.pendingMtimes")]);
    const r = await deps.repairMtimes();
    if (r === null) return said("pending-mtimes", "warn", [what, part("doctor.say.pendingMtimes.busy")], [part("doctor.fix.pendingMtimes.busy")]);
    const parts = [part("doctor.say.pendingMtimes.restored", { n: r.restored.length })];
    if (r.missing.length) parts.push(part("doctor.say.pendingMtimes.gone", { n: r.missing.length }, ", "));
    if (r.skippedModified.length) parts.push(part("doctor.say.pendingMtimes.edited", { n: r.skippedModified.length }, ", "));
    if (r.failed.length) {
      parts.push(part("doctor.say.pendingMtimes.failed", { n: r.failed.length, error: r.failed[0]!.error }, ", "));
      return said("pending-mtimes", "warn", parts, [part("doctor.fix.pendingMtimes.failed")]);
    }
    return said("pending-mtimes", "ok", parts);
  });

  {
    // Streamed: only files already ahead are kept. At its budget the walk is stopped and the check reports how far it got.
    let checked = 0;
    let stop = false;
    const ahead: FileTime[] = [];
    const leftovers = () => futureLeftovers(ahead, journal, deps.now(), platform);
    const list = (paths: string[]) => `${paths.slice(0, 3).map((p) => t(p)).join(", ")}${paths.length > 3 ? ", ..." : ""}`;
    const fix = [part("doctor.fix.futureMtimes")];
    await run("future-mtimes", async () => {
      if (!deps.futureMtimes) return ok("future-mtimes", part("doctor.say.futureMtimes.unchecked"));
      const src = deps.futureMtimes(effective);
      const horizon = deps.now() + ACTIVE_WINDOW_MS;
      for await (const f of src instanceof Promise ? await src : src) {
        if (stop) break;
        checked++;
        if (f.mtimeMs > horizon) ahead.push(f);
      }
      const found = leftovers();
      if (found.length === 0) return ok("future-mtimes", part("doctor.say.futureMtimes.none", { n: checked }));
      return said("future-mtimes", "warn", [part("doctor.say.futureMtimes.found", { n: found.length, list: list(found) })], fix);
    }, (ms) => {
      stop = true;
      const found = leftovers();
      const sofar = found.length === 0 ? part("doctor.say.futureMtimes.timeoutNone") : part("doctor.say.futureMtimes.timeoutSome", { n: found.length, list: list(found) });
      return said("future-mtimes", "warn", [part("doctor.say.futureMtimes.timeout", { s: ms / 1000, n: checked }), sofar], found.length === 0 ? slowFix : fix);
    });
  }

  await run("claude-env", async () => {
    const v = deps.env["CLAUDE_CONFIG_DIR"];
    if (!v) return ok("claude-env", part("doctor.say.claudeEnv.unset"));
    return said("claude-env", "warn", [part("doctor.say.claudeEnv.set", { dir: t(v) })], [part(win ? "doctor.fix.claudeEnv.win" : "doctor.fix.claudeEnv.other")]);
  });

  // ---------- T3 Code ----------
  let rt: ServerRuntime | null = null;
  let reachable = false;
  await run("t3-runtime", async () => {
    rt = await deps.readRuntime();
    if (rt === null) return said("t3-runtime", "fail", [part("doctor.say.t3Runtime.none")], openT3);
    return ok("t3-runtime", part("doctor.say.t3Runtime.ok", { version: rt.serverVersion, origin: rt.origin }));
  });
  await run("t3-reachable", async () => {
    if (rt === null) return needs("t3-reachable", "t3-runtime");
    reachable = await deps.probe(rt);
    const origin = (rt as ServerRuntime).origin;
    return reachable ? ok("t3-reachable", part("doctor.say.t3Reachable.ok", { origin }))
      : said("t3-reachable", "fail", [part("doctor.say.t3Reachable.fail", { origin })], openT3);
  });
  await run("t3-version", async () => {
    if (!reachable || rt === null) return needsT3("t3-version");
    const v = (rt as ServerRuntime).serverVersion;
    // Same minor or not, an untested version warns with one wording (as compatGate does when a command connects).
    if (checkCompat(v) === "tested") return ok("t3-version", part("doctor.say.t3Version.tested", { version: v }));
    return said("t3-version", "warn", [part("doctor.say.t3Version.untested", { version: v, tested: TESTED_VERSIONS.join(", ") })], [part("doctor.fix.t3Version")]);
  });
  let cli: string | null = null;
  await run("t3-cli", async () => {
    cli = deps.resolveCli();
    return cli !== null ? ok("t3-cli", part("doctor.say.t3Cli.ok", { path: t(cli) }))
      : said("t3-cli", "fail", [part("doctor.say.t3Cli.missing")], [part("doctor.fix.t3Cli")]);
  });

  // ---- the one T3 session: revoked when the T3 checks end, or on Ctrl+C / SIGTERM (bounded), never awaited unboundedly.
  let connecting: Promise<T3Api> | null = null;
  let api: T3Api | null = null;
  let closing: Promise<void> | null = null;
  const closeBudget = deps.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  /** wait=true (signal): give a pending connect the close budget too. wait=false (normal end): a pending connect is closed whenever it arrives. */
  const closeSession = (wait: boolean): Promise<void> => {
    if (closing) return closing;
    const open = api as T3Api | null;
    const pending = connecting as Promise<T3Api> | null;
    if (open !== null) closing = bounded(open.close(), closeBudget);
    else if (pending !== null && wait) closing = bounded(pending.then((a) => a.close()), closeBudget);
    else if (pending !== null) { void pending.then((a) => a.close(), () => {}); closing = Promise.resolve(); }
    else closing = Promise.resolve();
    return closing;
  };
  const signals = deps.signals ?? (process as unknown as SignalSource);
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let listening = false;
  const onSignal = () => { void closeSession(true).then(() => exit(130)); };

  /** The session the API checks may use: only when t3-token reported ok (a connect landing after its timeout is not used). */
  let live: T3Api | null = null;
  let instancesP: Promise<ProviderInstanceInfo[]> | null = null;
  let threadIdsP: Promise<Set<string> | null> | null = null;
  const instances = (): Promise<ProviderInstanceInfo[]> => (instancesP ??= (live as T3Api).providerInstances());
  const claudeInstances = async () => (await instances()).filter((i) => i.driver === "claudeAgent");
  const needApi = (id: string) => (reachable ? needs(id, "t3-token") : needsT3(id));

  try {
    await run("t3-token", async () => {
      if (!reachable) return needsT3("t3-token");
      if (cli === null) return needs("t3-token", "t3-cli");
      for (const s of STOP_SIGNALS) signals.once(s, onSignal);
      listening = true;
      connecting = deps.connect();
      const a = await connecting;
      api = a;
      return ok("t3-token", part("doctor.say.t3Token.ok"));
    });
    if (checks.at(-1)?.id === "t3-token" && checks.at(-1)?.status === "ok") live = api;
    // The session ids T3 holds (read-only; for harness:codex's "already in T3"), fetched while the session is open.
    if (live !== null && typeof (live as Partial<T3Api>).listThreads === "function") {
      threadIdsP = (live as T3Api).listThreads().then((ts) => sessionIdsInT3(ts), () => null);
    }

    await run("instances", async () => {
      if (live === null) return needApi("instances");
      const list = await claudeInstances();
      const problems: SayPart[] = [];
      const seen = new Map<string, string[]>();
      for (const i of list) {
        if (i.homePath === null) continue;
        const k = normalizeCwd(i.homePath, platform).toLowerCase();
        seen.set(k, [...(seen.get(k) ?? []), i.instanceId]);
      }
      for (const [, ids] of seen) {
        if (ids.length < 2) continue;
        const h = list.find((i) => i.instanceId === ids[0])!.homePath!;
        problems.push(part("doctor.say.instances.shared", { ids: ids.slice(0, -1).join(", "), last: ids.at(-1)!, home: t(h) }, problems.length > 0 ? "; " : undefined));
      }
      if (problems.length) return said("instances", "fail", problems, [part("doctor.fix.instances.shared")]);
      const missing = expanded.filter((a) => !list.some((i) => i.homePath !== null && sameCwd(i.homePath, a.home, platform)));
      if (missing.length) {
        return said("instances", "warn", [part("doctor.say.instances.missing", { list: missing.map((a) => `${a.id} (${t(a.home)})`).join(", ") })], [part("doctor.fix.instances.missing")]);
      }
      return ok("instances", part("doctor.say.instances.ok", { n: expanded.length }));
    });

    await run("instance-home-drift", async () => {
      if (live === null) return needApi("instance-home-drift");
      const def = (await claudeInstances()).find((i) => i.instanceId === "claudeAgent");
      if (!def) return ok("instance-home-drift", part("doctor.say.defaultInstance.none"));
      if (def.homePath === null) return ok("instance-home-drift", part("doctor.say.homeDrift.unreported"));
      if (sameCwd(def.homePath, `${home}/.claude`, platform)) return ok("instance-home-drift", part("doctor.say.homeDrift.ok"));
      if (Object.hasOwn((await (live as T3Api).getConfig()).settings.providerInstances, "claudeAgent")) {
        return said("instance-home-drift", "fail", [part("doctor.say.homeDrift.configured", { home: t(def.homePath) })], [part("doctor.fix.homeDrift.configured")]);
      }
      return said("instance-home-drift", "fail", [part("doctor.say.homeDrift.shell", { home: t(def.homePath) })], [part(win ? "doctor.fix.homeDrift.win" : "doctor.fix.homeDrift.other")]);
    });

    await run("instance-unpinned", async () => {
      if (live === null) return needApi("instance-unpinned");
      const def = (await claudeInstances()).find((i) => i.instanceId === "claudeAgent");
      if (!def) return ok("instance-unpinned", part("doctor.say.defaultInstance.none"));
      const explicit = Object.hasOwn((await (live as T3Api).getConfig()).settings.providerInstances, "claudeAgent");
      if (explicit) return ok("instance-unpinned", part("doctor.say.unpinned.ok"));
      return said("instance-unpinned", "warn", [part("doctor.say.unpinned.warn")], [part("doctor.fix.unpinned")]);
    });

    await run("instance-accounts", async () => {
      if (live === null) return needApi("instance-accounts");
      const list = await claudeInstances();
      if (list.length === 0) return said("instance-accounts", "warn", [part("doctor.say.instanceAccounts.none")], [part("doctor.fix.instanceAccounts.none")]);
      const issues: SayPart[] = [];
      const fixes: CliKey[] = [];
      // Each account by its name (config.json's display name, else T3 Code's), never a bare id when it has one.
      const baseName = (i: { instanceId: string; displayName: string }): string =>
        shownAccountName(effective.accounts.find((a) => a.id === i.instanceId)?.displayName || i.displayName || i.instanceId);
      // Two accounts with the same name are told apart by their id.
      const nameCount = new Map<string, number>();
      for (const i of list) nameCount.set(baseName(i), (nameCount.get(baseName(i)) ?? 0) + 1);
      const nameOf = (i: { instanceId: string; displayName: string }): string => {
        const n = baseName(i);
        return (nameCount.get(n) ?? 0) > 1 && n !== i.instanceId ? `${n} (${shownText(i.instanceId, 40)})` : n;
      };
      const byEmail = new Map<string, string[]>();
      for (const i of list) if (i.email) byEmail.set(i.email.toLowerCase(), [...(byEmail.get(i.email.toLowerCase()) ?? []), nameOf(i)]);
      const sep = (): string | undefined => (issues.length > 0 ? "; " : undefined);
      for (const [email, ids] of byEmail) {
        if (ids.length < 2) continue;
        issues.push(part("doctor.say.instanceAccounts.shared", { ids: ids.join(" and "), email: maskEmail(email) }, sep()));
        fixes.push("doctor.fix.instanceAccounts.shared");
      }
      for (const i of list) {
        if (i.authStatus === "unauthenticated") { issues.push(part("doctor.say.instanceAccounts.signedOut", { id: nameOf(i) }, sep())); fixes.push("doctor.fix.instanceAccounts.signedOut"); }
        else if (i.availability === "unavailable") { issues.push(part("doctor.say.instanceAccounts.unavailable", { id: nameOf(i) }, sep())); fixes.push("doctor.fix.instanceAccounts.unavailable"); }
      }
      const summary = list.map((i, n) => part(
        i.email ? "doctor.say.instanceAccounts.email" : i.authStatus === "unauthenticated" ? "doctor.say.instanceAccounts.signedOutShort" : "doctor.say.instanceAccounts.noEmail",
        { id: nameOf(i), ...(i.email ? { email: maskEmail(i.email) } : {}) }, n > 0 ? ", " : undefined,
      ));
      if (issues.length) {
        const fix = [...new Set(fixes)].map((k, n): SayPart => ({ ...part(k, undefined, n > 0 ? "; " : undefined), ...(n === 0 ? { cap: true } : {}) }));
        return said("instance-accounts", "warn", [...issues, part("doctor.say.instanceAccounts.summary", { summary })], fix);
      }
      return said("instance-accounts", "ok", summary);
    });
  } finally {
    // Revoke the session as soon as T3 is no longer needed: an open one within closeTimeoutMs; a connect that outlived
    // its timeout is closed whenever it arrives (never awaited here, so a connect that never settles cannot hang doctor).
    await closeSession(false);
    if (listening) for (const s of STOP_SIGNALS) signals.off(s, onSignal);
  }

  // ---------- accounts on disk ----------
  await run("accounts-undiscovered", async () => {
    const instHomes = instancesP ? (await (instancesP as Promise<ProviderInstanceInfo[]>).catch(() => [] as ProviderInstanceInfo[])).filter((i) => i.driver === "claudeAgent" && i.homePath !== null).map((i) => i.homePath!) : [];
    const found = await deps.discover(instHomes);
    const missing = found.filter((f) => !expanded.some((a) => sameCwd(a.home, f.home, platform)));
    if (missing.length === 0) return ok("accounts-undiscovered", part(config ? "doctor.say.undiscovered.ok" : "doctor.say.undiscovered.okDetected", { n: found.length }));
    const list = missing.map((f) => `${t(f.home)} (${formatSources(f)})`).join(", ");
    return said("accounts-undiscovered", "warn", [part(config ? "doctor.say.undiscovered.missing" : "doctor.say.undiscovered.missingDetected", { list, n: missing.length })],
      [part(config ? "doctor.fix.undiscovered" : "doctor.fix.undiscovered.init")]);
  });

  await run("backups-present", async () => {
    const per: string[] = [];
    let n = 0;
    for (const a of expanded) {
      const dirs = await deps.findBackupDirs(a.home);
      if (dirs.length) { n += dirs.length; per.push(`${t(a.home)}: ${dirs.length}`); }
    }
    if (n === 0) return ok("backups-present", part("doctor.say.backups.none"));
    return said("backups-present", "warn", [part("doctor.say.backups.found", { n, per: per.join(", ") })], [part("doctor.fix.backups")]);
  });

  await run("quarantine-orphans", async () => {
    const items = await deps.findOrphanedQuarantine(expanded, journal);
    if (items.length === 0) return ok("quarantine-orphans", part("doctor.say.quarantine.ok"));
    const homes = [...new Set(items.map((i) => t(i.accountHome)))];
    return said("quarantine-orphans", "warn", [part("doctor.say.quarantine.orphans", { n: items.length, dirs: homes.map((h) => `${h}/${QUARANTINE_DIR}`).join(", ") })], [part("doctor.fix.quarantine")]);
  });

  // ---------- harnesses ----------
  let harnessList: HarnessStatus[] = [];
  await run("harnesses", async () => { harnessList = await deps.harnesses(effective); return []; });
  const providerDrivers = instancesP ? (await (instancesP as Promise<ProviderInstanceInfo[]>).catch(() => null)) : null;
  for (const h of harnessList) {
    const id = `harness:${h.id}`;
    await run(id, async () => {
      const bin = deps.findBin(HARNESS_BIN[h.id]);
      const version = bin !== null ? await deps.binVersion(bin) : null;
      const name = HARNESS_BIN[h.id];
      const versionText = version ? (version.toLowerCase().startsWith(name) ? version : `${name} ${version}`) : null;
      const ver: SayPart[] = versionText !== null ? [part("doctor.say.harness.version", { version: versionText })] : bin !== null ? [part("doctor.say.harness.onPath", { name })] : [];
      const counted0 = h.importable !== undefined && h.convertible !== undefined;
      const sessions = counted0 ? h.importable! + h.convertible! : h.available ? null : 0;
      const data = (noInstance: boolean): CheckData => ({ harness: h.id, sessions, readErrors: h.readErrors ?? 0, noInstance });
      if (h.problem) {
        return said(id, "warn", [part("doctor.say.harness.problem", { problem: h.problem }), ...ver, part("doctor.say.harness.notConverted")], [part("doctor.fix.harness.problem", { name })], data(false));
      }
      if (!h.available) return said(id, "ok", [part("doctor.say.harness.none"), ...ver], undefined, data(false));
      // Codex: sessions by how they reach T3 (native import, conversion of compressed rollouts, skipped).
      const counted = h.importable !== undefined && h.convertible !== undefined && h.skipped !== undefined;
      const readErrors = h.readErrors ?? 0;
      const inT3 = counted && h.sessionIds && threadIdsP ? await (threadIdsP as Promise<Set<string> | null>) : null;
      const already = inT3 ? (h.sessionIds ?? []).filter((x) => sessionForms(h.id, x).some((f) => inT3.has(f))).length : null;
      const counts: SayPart[] | null = counted
        ? [
          versionText !== null ? part("doctor.say.harness.countsVersion", { version: versionText }) : bin !== null ? part("doctor.say.harness.countsOnPath", { name }) : part("doctor.say.harness.countsFound"),
          part("doctor.say.harness.counts", { importable: h.importable!, convertible: h.convertible!, skipped: h.skipped! }),
          ...(readErrors > 0 ? [part("doctor.say.harness.readErrors", { n: readErrors })] : []),
          ...(already !== null ? [part("doctor.say.harness.already", { n: already })] : []),
        ]
        : null;
      const driver = HARNESS_DRIVER[h.id];
      // Converted sessions become Claude threads: only native imports need the harness's own T3 instance.
      const needsDriver = !counted || (h.importable ?? 0) > 0;
      const noDriver = driver !== undefined && needsDriver && providerDrivers !== null && !providerDrivers.some((p) => p.driver === driver && p.enabled);
      const enableFix = part("doctor.fix.harness.enable", { agent: driver === "codex" ? "Codex" : "Pi" });
      if (noDriver && counts === null) return said(id, "warn", [part("doctor.say.harness.noDriver", { driver: driver! })], [enableFix], data(true));
      if (counts !== null && (noDriver || readErrors > 0)) {
        // Every problem is reported: one warn, messages and fixes combined.
        const fixes = [
          ...(noDriver ? [enableFix] : []),
          ...(readErrors > 0 ? [part("doctor.fix.harness.readErrors", undefined, noDriver ? ". " : undefined)] : []),
        ];
        const message = noDriver ? [...counts, part("doctor.say.harness.noDriverCounts", { driver: driver!, n: h.importable! })] : counts;
        return said(id, "warn", message, fixes, data(noDriver));
      }
      const unchecked = driver && providerDrivers === null ? [part("doctor.say.harness.unchecked")] : [];
      return said(id, "ok", counts !== null ? [...counts, ...unchecked] : [part("doctor.say.harness.found"), ...ver, ...unchecked], undefined, data(false));
    });
  }

  // ---------- the /t3sm commands inside T3 Code ----------
  await run("t3sm-plugin", async () => {
    const read = deps.pluginState, version = deps.packageVersion;
    if (!read || !version) return skip("t3sm-plugin", part("doctor.say.plugin.unchecked"));
    const states = await Promise.all(effective.accounts.map(async (a) => ({ id: shownAccountName(a.displayName || a.id), state: await read(expandHome(a.home, home)) })));
    if (states.length === 0) return skip("t3sm-plugin", part("doctor.say.plugin.noAccounts"));
    const stateWords = (s: PluginState): SayPart => s.state === "installed" ? part("status.plugin.installed", { version: s.version })
      : s.state === "outdated" ? part("status.plugin.outdated", { version: s.version, expected: version, id: PLUGIN_ID }) : part("status.plugin.missing");
    const line = states.map((x, n) => part("doctor.say.plugin.account", { id: x.id, state: [stateWords(x.state)] }, n > 0 ? "; " : undefined));
    if (states.some((x) => x.state.state === "outdated")) return said("t3sm-plugin", "warn", line, [part("doctor.fix.plugin", { id: PLUGIN_ID })]);
    const missing = states.some((x) => x.state.state === "missing");
    return said("t3sm-plugin", "ok", missing ? [...line, part("doctor.say.plugin.optional")] : line);
  });

  // ---------- background sync ----------
  await run("schedule", async () => {
    const s = await deps.scheduleStatus();
    if (!s.installed) return ok("schedule", part("doctor.say.schedule.none"));
    if (s.missing && s.missing.length > 0) {
      return said("schedule", "warn", [part("doctor.say.schedule.missing", { kind: s.kind, paths: s.missing.map(t).join(", "), n: s.missing.length })], [part("doctor.fix.schedule")]);
    }
    return said("schedule", "ok", [
      part("doctor.say.schedule.ok", { kind: s.kind }),
      ...(s.nextRun ? [part("doctor.say.schedule.next", { next: s.nextRun })] : []),
      ...(s.detail && s.kind !== "cron" ? [part("doctor.say.schedule.detail", { detail: s.detail })] : []),
    ]);
  });

  await run("sync-watcher", async () => {
    const hb = await deps.readHeartbeat();
    const now = deps.now();
    // The same classification as `t3sm status` (src/ops/watcherHealth.ts): the two never disagree.
    const h = watcherHealth(hb, { now, pidAlive: deps.pidAlive, install: (r) => deps.installStamp?.(r) ?? null, everyMinutes: effective.schedule.everyMinutes });
    const watcherFix = [part("doctor.fix.watcher.start")];
    if (h.state === "none") return ok("sync-watcher", part("doctor.say.watcher.none"));
    if (h.state === "stopped") return ok("sync-watcher", part("doctor.say.watcher.stopped", { at: h.stoppedAt }));
    const restartFix = [part("doctor.fix.watcher.restart", { pid: h.pid })];
    if (h.state === "restart-lost") return said("sync-watcher", "warn", [part("doctor.say.watcher.restartLost", { at: h.stoppedAt })], [part("doctor.fix.watcher.restartLost")]);
    if (h.state === "gone") return said("sync-watcher", "warn", [part("doctor.say.watcher.gone", { pid: h.pid, last: h.lastCycleAt ?? [part("doctor.say.watcher.never")] })], watcherFix);
    if (h.state === "no-version") return said("sync-watcher", "warn", [part("doctor.say.watcher.noVersion", { pid: h.pid })], restartFix);
    if (h.state === "no-stamp") return said("sync-watcher", "warn", [part("doctor.say.watcher.noStamp", { pid: h.pid, version: h.version })], restartFix);
    if (h.state === "stale-version") {
      return said("sync-watcher", "warn", [part(h.rebuilt ? "doctor.say.watcher.staleRebuilt" : "doctor.say.watcher.stale", { pid: h.pid, version: h.version, installed: h.installed })], restartFix);
    }
    const pending = h.pendingVersion !== null ? [part("doctor.say.watcher.pending", { version: h.pendingVersion })] : [];
    const last = [h.lastCycleAt ? part("doctor.say.watcher.lastCycle", { ageMs: now - Date.parse(h.lastCycleAt) }) : part("doctor.say.watcher.noCycle")];
    if (h.fresh) return said("sync-watcher", "ok", [part("doctor.say.watcher.running", { pid: h.pid, last }), ...pending]);
    if (!reachable) return said("sync-watcher", "ok", [part("doctor.say.watcher.running", { pid: h.pid, last }), part("doctor.say.watcher.waitingT3"), ...pending]);
    return said("sync-watcher", "warn", [part("doctor.say.watcher.late", { pid: h.pid, last, due: h.nextCycleAt ?? "-" })], [part("doctor.fix.watcher.late", { pid: h.pid })]);
  });

  await run("merge-pending", async () => {
    const p = deps.mergePending ? await deps.mergePending() : null;
    if (p === null) return ok("merge-pending", part("doctor.say.merge.uncounted"));
    const data: CheckData = { continued: p.count, sideBranch: p.orphaned, at: p.at };
    if (p.count === 0 && p.orphaned === 0) return said("merge-pending", "ok", [part("doctor.say.merge.none", { at: p.at })], undefined, data);
    const parts: SayPart[] = [
      ...(p.count > 0 ? [part("doctor.say.merge.continued", { n: p.count })] : []),
      ...(p.orphaned > 0 ? [part("doctor.say.merge.sideBranch", { n: p.orphaned }, p.count > 0 ? "; " : undefined)] : []),
      part("doctor.say.merge.asOf", { at: p.at }),
    ];
    return said("merge-pending", "warn", parts, [part(p.count > 0 ? "doctor.fix.merge.continued" : "doctor.fix.merge.sideBranch")], data);
  });

  return { checks: checks.map((c) => scrub(c, home)) };
}

/** Last line of defence: emails masked, the home folder shown as ~, tokens redacted. */
function scrub(c: Check, home: string): Check {
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

// ---------- real dependencies ----------

function findOnPath(name: string, platform: NodeJS.Platform, pathEnv: string, pathExt: string | undefined): string | null {
  const win = platform === "win32";
  const exts = win ? (pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of pathEnv.split(win ? ";" : ":").filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, name + ext.toLowerCase());
      if (isFile(p)) return p;
    }
  }
  return null;
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

async function nearestWritable(dir: string): Promise<string | null> {
  let d = dir;
  for (;;) {
    try {
      await access(d, constants.F_OK);
    } catch {
      const up = dirname(d);
      if (up === d) return "no existing parent folder";
      d = up;
      continue;
    }
    try { await access(d, constants.W_OK); return null; } catch (e) { return (e as NodeJS.ErrnoException).code ?? "not writable"; }
  }
}

export interface DoctorOptions { home?: string; env: NodeJS.ProcessEnv; repair: boolean; platform?: NodeJS.Platform }

export function defaultDoctorDeps(o: DoctorOptions): DoctorDeps {
  const home = o.home ?? homedir();
  const platform = o.platform ?? process.platform;
  const dir = stateDirOf(o.env, home);
  const journal = new Journal(join(dir, "journal.jsonl"));
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k.toUpperCase() !== "CLAUDE_CONFIG_DIR") childEnv[k] = v;
  return {
    home, platform, env: o.env, stateDir: dir, nodeVersion: process.versions.node, now: Date.now, repair: o.repair,
    loadConfig: () => loadConfig(dir, home, platform),
    detectAccounts: () => resolveAccounts(home, [], o.env, platform),
    stateWritable: () => nearestWritable(dir),
    lockInfo: () => lockInfo(dir),
    pidAlive,
    readJournal: () => journal.readAll(),
    async repairMtimes() {
      const lock = await acquireLock(dir);
      if (!lock) return null;
      try { return await recoverPendingMtimes(journal); } finally { await lock.release(); }
    },
    readRuntime: () => readServerRuntime(home),
    probe: (rt) => probeServer(rt),
    resolveCli: () => resolveT3Cli(home, platform, process.env.PATH ?? ""),
    connect: () => connectT3(home, { allowUntested: true, manageProviders: false, onNotice: () => {} }),
    discover: (instanceHomes) => discoverAccountHomes(nodeDiscoveryEnv({ home, platform, env: o.env, instanceHomes })),
    findBackupDirs: (h) => findBackupDirs(h),
    findOrphanedQuarantine: (accs, entries) => findOrphanedQuarantine(accs, entries, platform),
    async harnesses(config) {
      // readOnly: doctor leaves no persistent state (an OpenCode snapshot lives in a temp dir removed at exit).
      const env = { home, platform, now: Date.now, config, stateDir: dir, env: o.env, readOnly: true };
      const out: HarnessStatus[] = [];
      for (const a of allAdapters()) {
        if (a.availability) {
          const v = await a.availability(env).catch((e: unknown): Availability => ({ unreadable: e instanceof Error ? e.message : String(e) }));
          if (v === "ok" || v === "absent") out.push({ id: a.id, available: v === "ok" });
          else out.push({ id: a.id, available: false, problem: "drift" in v ? `storage format changed: ${v.drift}` : `present but unreadable: ${v.unreadable}` });
        } else {
          const available = await a.isAvailable(env).catch(() => false);
          // Codex: sessions by kind (read-only discovery: the cache is read, never saved).
          const counts = a.id === "codex" && available ? await countCodexSessions(env).catch(() => null) : null;
          out.push({ id: a.id, available, ...(counts ?? {}) });
        }
      }
      return out;
    },
    findBin: (name) => findOnPath(name, platform, process.env.PATH ?? "", process.env.PATHEXT),
    async binVersion(path) {
      const shell = platform === "win32" && /\.(cmd|bat)$/i.test(path);
      if (shell && /["\r\n\0!%]/.test(path)) return null;
      const r = await defaultRunner(path, ["--version"], { shell, timeoutMs: 8000, env: childEnv });
      if (r.timedOut || r.code !== 0) return null;
      const line = (r.stdout || r.stderr).replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      return line ? line.slice(0, 80) : null;
    },
    async scheduleStatus() {
      // Not a fresh literal: `stateDir` is newer than some SpecOptions versions (win32 needs it to name the task XML).
      const opts = { home, conhost: null, stateDir: dir };
      // The interval `t3sm schedule install` used: config.json's schedule.everyMinutes (default 15).
      const every = (await loadConfig(dir, home, platform).catch(() => null))?.schedule.everyMinutes ?? DEFAULT_SCHEDULE_MINUTES;
      const spec = scheduleSpec(platform, process.execPath, defaultBinPath(), every, opts);
      return { kind: spec.kind, ...(await scheduleStatus(spec, realRunner)) };
    },
    readHeartbeat: () => readHeartbeat(dir),
    installStamp: (root) => {
      const r = root ?? installRoot();
      try { return { ...installStamp(r), changedAtMs: installChangedAt(r) }; } catch { return null; }
    },
    packageVersion: packageVersion(),
    pluginState: (h) => readPluginState(h, packageVersion()),
    mergePending: () => readMergePending(dir),
    async *futureMtimes(config) {
      // The harnesses t3sm parks files of (native transcripts). Stat only: no transcript is opened, nothing written.
      // Warm discovery caches first: a file they last saw in the future is re-checked before the walk, so a known
      // leftover is reported even when the walk runs out of time on a large home.
      const env = { home, platform, now: Date.now, config, stateDir: dir, env: o.env, readOnly: true };
      const native = allAdapters().filter((x) => x.mode === "native");
      const seen = new Set<string>();
      const horizon = Date.now() + ACTIVE_WINDOW_MS;
      for (const a of native) {
        for (const c of (await a.cachedFileTimes?.(env).catch(() => [])) ?? []) {
          const k = pathKey(c.path, platform);
          if (c.mtimeMs <= horizon || seen.has(k)) continue;
          const st = await stat(c.path).catch(() => null);
          if (!st) continue;
          seen.add(k);
          yield { path: c.path, mtimeMs: st.mtimeMs };
        }
      }
      for (const a of native) {
        if (!a.fileTimes || !(await a.isAvailable(env).catch(() => false))) continue;
        for await (const f of a.fileTimes(env)) {
          const k = pathKey(f.path, platform);
          if (seen.has(k)) continue;
          seen.add(k);
          yield f;
        }
      }
    },
  };
}
