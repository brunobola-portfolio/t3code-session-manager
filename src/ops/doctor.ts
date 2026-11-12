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
import { describeError, oneLine } from "../cli/errors.ts";
import { STOP_SIGNALS, futureLeftovers } from "../apply/apply.ts";
import { discoverAccountHomes, formatSources, nodeDiscoveryEnv, resolveAccounts, type DiscoveredHome } from "./discoverAccounts.ts";
import { findBackupDirs, findOrphanedQuarantine, QUARANTINE_DIR, type OrphanedItem } from "./quarantine.ts";
import { defaultBinPath, realRunner, scheduleSpec, scheduleStatus } from "./schedule.ts";
import { pidAlive, readHeartbeat, type Heartbeat } from "./watch.ts";
import { readMergePending } from "./merge.ts";
import { allAdapters, sessionForms, sessionIdsInT3 } from "../sources/registry.ts";
import { countCodexSessions } from "../sources/codex.ts";
import type { Availability, FileTime } from "../sources/types.ts";

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
export interface Check { id: string; status: CheckStatus; message: string; fix?: string }

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
const SLOW_FIX = "Not a problem to fix by itself: run t3sm doctor again (a large home can be slow the first time)";
const HARNESS_BIN: Record<HarnessId, string> = { claude: "claude", codex: "codex", pi: "pi", opencode: "opencode" };
const HARNESS_DRIVER: Partial<Record<HarnessId, string>> = { codex: "codex", pi: "pi" };

export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***@${email.slice(at + 1)}`;
}

const EMAIL_RE = /([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

export { pendingMtimePaths };

class CheckTimeout extends Error {}

const CLOSE_TIMEOUT_MS = 3_000;

/** Settles when `p` settles (either way) or after `ms`, whichever comes first; the timer is always cleared. */
function bounded(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.then(() => {}, () => {}), new Promise<void>((r) => { timer = setTimeout(r, ms); })]).finally(() => clearTimeout(timer));
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

export async function runDoctor(deps: DoctorDeps): Promise<{ checks: Check[] }> {
  const { home, platform } = deps;
  const budgetOf = (id: string): number => deps.checkTimeoutsMs?.[id] ?? CHECK_TIMEOUTS_MS[id] ?? deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t = (p: string) => tildePath(p, home, platform);
  const openT3 = platform === "win32" ? "Open T3 Code from the Start menu" : "Open T3 Code";
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
      const message = e instanceof CheckTimeout ? `did not finish within ${budget / 1000} s` : oneLine(describeError(e).message.replace(/^Unexpected error: /, ""));
      if (CRITICAL_CHECKS.has(id)) checks.push({ id, status: "fail", message });
      else if (e instanceof CheckTimeout) checks.push({ id, status: "warn", message: `${message}; not checked this time`, fix: SLOW_FIX });
      else checks.push({ id, status: "warn", message });
    } finally {
      clearTimeout(timer);
    }
  }
  const ok = (id: string, message: string): Check => ({ id, status: "ok", message });
  const skip = (id: string, why: string): Check => ({ id, status: "skip", message: why });

  // ---------- this machine ----------
  await run("node-version", async () => {
    const [maj = 0, min = 0] = deps.nodeVersion.split(".").map(Number);
    const good = maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
    return good ? ok("node-version", `Node ${deps.nodeVersion}`)
      : { id: "node-version", status: "fail", message: `Node ${deps.nodeVersion} is too old (t3sm needs ${MIN_NODE.join(".")} or newer)`, fix: "Install Node 22.18 or newer" };
  });

  await run("state-dir", async () => {
    const why = await deps.stateWritable();
    return why === null ? ok("state-dir", `${t(deps.stateDir)} is writable`)
      : { id: "state-dir", status: "fail", message: `${t(deps.stateDir)} is not writable (${why})`, fix: "Fix the folder's permissions, or point T3SM_HOME at a writable folder" };
  });

  let config: Config | null = null;
  let configValid = true;
  await run("config", async () => {
    try {
      config = await deps.loadConfig();
    } catch (e) {
      configValid = false;
      if (e instanceof ConfigError) {
        return { id: "config", status: "fail", message: oneLine(e.message.split("\n").slice(0, 2).join(" ")), fix: "Fix config.json, or delete it and run `t3sm accounts --init`" };
      }
      throw e;
    }
    if (config === null) return ok("config", "no config.json yet: commands use the detected accounts (`t3sm accounts --init` writes one)");
    const c = config as Config;
    return ok("config", `${plural(c.accounts.length, "account")} (${c.accounts.map((a) => a.id).join(", ")}), default ${c.defaultAccount}`);
  });
  let accounts: AccountConfig[] = [];
  try { accounts = config !== null ? (config as Config).accounts : configValid ? await deps.detectAccounts() : []; } catch { accounts = []; }
  const expanded = accounts.map((a) => ({ ...a, home: expandHome(a.home, home) }));
  const effective: Config = config ?? defaultConfig(expanded);

  await run("lock", async () => {
    const info = await deps.lockInfo();
    if (info === null) return ok("lock", "free");
    if (info.hostname !== (deps.hostname ?? hostname())) {
      // A shared state folder: the pid means nothing here, and t3sm never takes over another machine's lock.
      const what = `held by pid ${info.pid} on another machine for ${ago(info.ageMs)}`;
      return info.ageMs > LOCK_OLD_MS
        ? { id: "lock", status: "warn", message: what, fix: `If no t3sm runs on that machine any more, delete ${t(join(deps.stateDir, "lock"))}` }
        : ok("lock", what);
    }
    if (rebootedSince(info.uptimeSec, (deps.uptime ?? uptime)())) {
      return ok("lock", `left by a run from before the last restart; the next t3sm run takes it over`);
    }
    const alive = deps.pidAlive(info.pid);
    if (!alive) return ok("lock", `left by pid ${info.pid}, which is gone; the next t3sm run takes it over`);
    if (info.ageMs > LOCK_OLD_MS) {
      return { id: "lock", status: "warn", message: `held for ${ago(info.ageMs)} by pid ${info.pid}`,
        fix: `If no t3sm command is running, delete ${t(join(deps.stateDir, "lock"))}` };
    }
    return ok("lock", `held by pid ${info.pid} for ${ago(info.ageMs)} (a t3sm run in progress)`);
  });

  let journal: JournalEntry[] = [];
  await run("pending-mtimes", async () => {
    journal = await deps.readJournal();
    const pending = pendingMtimePaths(journal, platform);
    if (pending.length === 0) return ok("pending-mtimes", "no transcript file time is left bumped");
    const what = `${plural(pending.length, "transcript file time")} still bumped by an interrupted run`;
    if (!deps.repair) return { id: "pending-mtimes", status: "warn", message: what, fix: "Run any t3sm command that writes, or t3sm doctor --repair" };
    const r = await deps.repairMtimes();
    if (r === null) return { id: "pending-mtimes", status: "warn", message: `${what}; another t3sm run holds the lock and restores them itself`, fix: "Run t3sm doctor --repair again when it has finished" };
    const parts = [`restored ${r.restored.length}`];
    if (r.missing.length) parts.push(`${r.missing.length} gone`);
    if (r.skippedModified.length) parts.push(`${r.skippedModified.length} edited since (left alone)`);
    if (r.failed.length) {
      return { id: "pending-mtimes", status: "warn", message: `${parts.join(", ")}, ${r.failed.length} failed (${r.failed[0]!.error})`, fix: "Close programs holding those transcripts, then run t3sm doctor --repair again" };
    }
    return ok("pending-mtimes", parts.join(", "));
  });

  {
    // Streamed: only files already ahead are kept. At its budget the walk is stopped and the check reports how far it got.
    let checked = 0;
    let stop = false;
    const ahead: FileTime[] = [];
    const leftovers = () => futureLeftovers(ahead, journal, deps.now(), platform);
    const list = (paths: string[]) => `${paths.slice(0, 3).map((p) => t(p)).join(", ")}${paths.length > 3 ? ", ..." : ""}`;
    const fix = "t3sm cannot know their real time: set each file's modification time back (to its last activity, or to now) when no program is writing it";
    await run("future-mtimes", async () => {
      if (!deps.futureMtimes) return ok("future-mtimes", "not checked");
      const src = deps.futureMtimes(effective);
      const horizon = deps.now() + ACTIVE_WINDOW_MS;
      for await (const f of src instanceof Promise ? await src : src) {
        if (stop) break;
        checked++;
        if (f.mtimeMs > horizon) ahead.push(f);
      }
      const found = leftovers();
      if (found.length === 0) return ok("future-mtimes", `no transcript has a file time in the future (${plural(checked, "file")} checked)`);
      return { id: "future-mtimes", status: "warn",
        message: `${plural(found.length, "transcript")} ${found.length === 1 ? "has" : "have"} a file time more than 10 minutes in the future, not from a pending t3sm run (${list(found)}); T3 Code skips ${found.length === 1 ? "it" : "them"}`,
        fix };
    }, (ms) => {
      stop = true;
      const found = leftovers();
      const sofar = found.length === 0 ? ", none in the future so far" : `; ${plural(found.length, "transcript")} in the future so far: ${list(found)}`;
      return { id: "future-mtimes", status: "warn", message: `could not finish checking file times in ${ms / 1000} s (${plural(checked, "file")} checked${sofar})`,
        fix: found.length === 0 ? SLOW_FIX : fix };
    });
  }

  await run("claude-env", async () => {
    const v = deps.env["CLAUDE_CONFIG_DIR"];
    if (!v) return ok("claude-env", "CLAUDE_CONFIG_DIR is not set in this shell");
    return { id: "claude-env", status: "warn", message: `T3 Code started from this shell would read ${t(v)} as its default account`,
      fix: platform === "win32" ? "Start T3 Code from the Start menu, not from this shell" : "Start T3 Code from your desktop launcher, not from this shell" };
  });

  // ---------- T3 Code ----------
  let rt: ServerRuntime | null = null;
  let reachable = false;
  await run("t3-runtime", async () => {
    rt = await deps.readRuntime();
    if (rt === null) return { id: "t3-runtime", status: "fail", message: "no usable ~/.t3/userdata/server-runtime.json (T3 Code never ran as this user?)", fix: openT3 };
    return ok("t3-runtime", `T3 Code ${rt.serverVersion} at ${rt.origin}`);
  });
  await run("t3-reachable", async () => {
    if (rt === null) return skip("t3-reachable", "needs t3-runtime");
    reachable = await deps.probe(rt);
    return reachable ? ok("t3-reachable", `answering at ${(rt as ServerRuntime).origin}`)
      : { id: "t3-reachable", status: "fail", message: `T3 Code is not answering at ${(rt as ServerRuntime).origin}`, fix: openT3 };
  });
  await run("t3-version", async () => {
    if (!reachable || rt === null) return skip("t3-version", "needs a running T3 Code");
    const v = (rt as ServerRuntime).serverVersion;
    const c = checkCompat(v);
    if (c === "tested") return ok("t3-version", `${v} (tested)`);
    if (c === "same-minor") return ok("t3-version", `${v} (same minor as a tested version; t3sm proceeds with a notice)`);
    return { id: "t3-version", status: "fail", message: `${v} is untested (tested: ${TESTED_VERSIONS.join(", ")})`, fix: "Update t3sm, or pass --allow-untested to plan and apply" };
  });
  let cli: string | null = null;
  await run("t3-cli", async () => {
    cli = deps.resolveCli();
    return cli !== null ? ok("t3-cli", t(cli))
      : { id: "t3-cli", status: "fail", message: "T3 Code's CLI (t3) is not in ~/.t3/bin or on PATH", fix: "Reinstall T3 Code, or add ~/.t3/bin to PATH" };
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
  const needApi = (id: string) => skip(id, reachable ? "needs t3-token" : "needs a running T3 Code");

  try {
    await run("t3-token", async () => {
      if (!reachable) return skip("t3-token", "needs a running T3 Code");
      if (cli === null) return skip("t3-token", "needs t3-cli");
      for (const s of STOP_SIGNALS) signals.once(s, onSignal);
      listening = true;
      connecting = deps.connect();
      const a = await connecting;
      api = a;
      return ok("t3-token", "issued a read-only session and a websocket ticket (revoked when doctor ends)");
    });
    if (checks.at(-1)?.id === "t3-token" && checks.at(-1)?.status === "ok") live = api;
    // The session ids T3 holds (read-only; for harness:codex's "already in T3"), fetched while the session is open.
    if (live !== null && typeof (live as Partial<T3Api>).listThreads === "function") {
      threadIdsP = (live as T3Api).listThreads().then((ts) => sessionIdsInT3(ts), () => null);
    }

    await run("instances", async () => {
      if (live === null) return needApi("instances");
      const list = await claudeInstances();
      const problems: string[] = [];
      const seen = new Map<string, string[]>();
      for (const i of list) {
        if (i.homePath === null) continue;
        const k = normalizeCwd(i.homePath, platform).toLowerCase();
        seen.set(k, [...(seen.get(k) ?? []), i.instanceId]);
      }
      for (const [, ids] of seen) {
        if (ids.length < 2) continue;
        const h = list.find((i) => i.instanceId === ids[0])!.homePath!;
        problems.push(`${ids.slice(0, -1).join(", ")} and ${ids.at(-1)} both read ${t(h)}`);
      }
      if (problems.length) return { id: "instances", status: "fail", message: problems.join("; "), fix: "Keep one instance per account home: remove the extra one in T3 Code settings (Providers)" };
      const missing = expanded.filter((a) => !list.some((i) => i.homePath !== null && sameCwd(i.homePath, a.home, platform)));
      if (missing.length) {
        return { id: "instances", status: "warn", message: `no T3 instance for ${missing.map((a) => `${a.id} (${t(a.home)})`).join(", ")}`, fix: "Run t3sm accounts --apply (or t3sm apply creates it)" };
      }
      return ok("instances", `${plural(expanded.length, "account")}, each with its own instance`);
    });

    await run("instance-home-drift", async () => {
      if (live === null) return needApi("instance-home-drift");
      const def = (await claudeInstances()).find((i) => i.instanceId === "claudeAgent");
      if (!def) return ok("instance-home-drift", "T3 Code has no default Claude instance (claudeAgent)");
      if (def.homePath === null) return ok("instance-home-drift", "claudeAgent's home is not reported yet");
      if (sameCwd(def.homePath, `${home}/.claude`, platform)) return ok("instance-home-drift", "claudeAgent reads ~/.claude");
      if (Object.hasOwn((await (live as T3Api).getConfig()).settings.providerInstances, "claudeAgent")) {
        return { id: "instance-home-drift", status: "fail", message: `T3 Code's default Claude instance is configured to read ${t(def.homePath)} instead of ~/.claude (T3 Code settings, Providers)`,
          fix: "Change it in T3 Code settings (Providers), or run t3sm accounts --apply" };
      }
      return { id: "instance-home-drift", status: "fail", message: `T3 Code's default Claude instance reads ${t(def.homePath)} instead of ~/.claude (T3 Code was started from a shell with CLAUDE_CONFIG_DIR set)`,
        fix: platform === "win32" ? "Close T3 Code and open it from the Start menu" : "Close T3 Code and open it from your desktop launcher" };
    });

    await run("instance-unpinned", async () => {
      if (live === null) return needApi("instance-unpinned");
      const def = (await claudeInstances()).find((i) => i.instanceId === "claudeAgent");
      if (!def) return ok("instance-unpinned", "T3 Code has no default Claude instance (claudeAgent)");
      const explicit = Object.hasOwn((await (live as T3Api).getConfig()).settings.providerInstances, "claudeAgent");
      if (explicit) return ok("instance-unpinned", "claudeAgent has an explicit home in T3 Code's settings");
      return { id: "instance-unpinned", status: "warn", message: "claudeAgent has no explicit home in T3 Code's settings: a T3 Code started with CLAUDE_CONFIG_DIR set would read another account",
        fix: "Run t3sm accounts --apply" };
    });

    await run("instance-accounts", async () => {
      if (live === null) return needApi("instance-accounts");
      const list = await claudeInstances();
      if (list.length === 0) return { id: "instance-accounts", status: "warn", message: "T3 Code has no Claude instance", fix: "Enable Claude in T3 Code settings (Providers)" };
      const issues: string[] = [];
      const fixes: string[] = [];
      const byEmail = new Map<string, string[]>();
      for (const i of list) if (i.email) byEmail.set(i.email.toLowerCase(), [...(byEmail.get(i.email.toLowerCase()) ?? []), i.instanceId]);
      for (const [email, ids] of byEmail) {
        if (ids.length < 2) continue;
        issues.push(`${ids.join(" and ")} share ${maskEmail(email)} (one subscription)`);
        fixes.push("sign one of them in to the other subscription (`claude` with CLAUDE_CONFIG_DIR set to its home, then /login)");
      }
      for (const i of list) {
        if (i.authStatus === "unauthenticated") { issues.push(`${i.instanceId} is signed out`); fixes.push("sign it in from T3 Code"); }
        else if (i.availability === "unavailable") { issues.push(`${i.instanceId} is unavailable`); fixes.push("check it in T3 Code settings (Providers)"); }
      }
      const summary = list.map((i) => `${i.instanceId} ${i.email ? maskEmail(i.email) : i.authStatus === "unauthenticated" ? "(signed out)" : "(no email)"}`).join(", ");
      if (issues.length) return { id: "instance-accounts", status: "warn", message: `${issues.join("; ")} [${summary}]`, fix: [...new Set(fixes)].join("; ").replace(/^./, (c) => c.toUpperCase()) };
      return ok("instance-accounts", summary);
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
    if (missing.length === 0) return ok("accounts-undiscovered", `${plural(found.length, "account")} found on this machine, all ${config ? "in config.json" : "detected"}`);
    const list = missing.map((f) => `${t(f.home)} (${formatSources(f)})`).join(", ");
    return { id: "accounts-undiscovered", status: "warn", message: `found ${list} but ${missing.length === 1 ? "it is" : "they are"} not ${config ? "in config.json" : "detected by default"}`,
      fix: config ? "Add it to config.json, or rewrite the file with `t3sm accounts --init --force`" : "Run `t3sm accounts --init` to write config.json with every discovered account" };
  });

  await run("backups-present", async () => {
    const per: string[] = [];
    let n = 0;
    for (const a of expanded) {
      const dirs = await deps.findBackupDirs(a.home);
      if (dirs.length) { n += dirs.length; per.push(`${t(a.home)}: ${dirs.length}`); }
    }
    if (n === 0) return ok("backups-present", "no backup folders inside projects/");
    return { id: "backups-present", status: "warn", message: `${plural(n, "backup folder")} inside projects/ (${per.join(", ")}); they can show up as duplicate sessions`, fix: "Run t3sm quarantine (reversible)" };
  });

  await run("quarantine-orphans", async () => {
    const items = await deps.findOrphanedQuarantine(expanded, journal);
    if (items.length === 0) return ok("quarantine-orphans", "every quarantined item is in the journal");
    const homes = [...new Set(items.map((i) => t(i.accountHome)))];
    return { id: "quarantine-orphans", status: "warn", message: `${plural(items.length, "item")} in ${homes.map((h) => `${h}/${QUARANTINE_DIR}`).join(", ")} with no journal record (moved by hand, or the journal was lost)`,
      fix: "Review them by hand: t3sm rollback cannot move them back" };
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
      const ver = version ? `; ${version.toLowerCase().startsWith(name) ? version : `${name} ${version}`}` : bin !== null ? `; ${name} on PATH` : "";
      if (h.problem) {
        return { id, status: "warn", message: `${h.problem}${ver}; its sessions are not converted`, fix: `Check for a t3sm update that supports this ${name} version (docs/harnesses.md lists the tested one)` };
      }
      if (!h.available) return ok(id, `no sessions on this machine${ver}`);
      // Codex: sessions by how they reach T3 (native import, conversion of compressed rollouts, skipped).
      const counted = h.importable !== undefined && h.convertible !== undefined && h.skipped !== undefined;
      const readErrors = h.readErrors ?? 0;
      const inT3 = counted && h.sessionIds && threadIdsP ? await (threadIdsP as Promise<Set<string> | null>) : null;
      const already = inT3 ? (h.sessionIds ?? []).filter((x) => sessionForms(h.id, x).some((f) => inT3.has(f))).length : null;
      const counts = counted
        ? `${version ? ver.slice(2) : bin !== null ? `${name} on PATH` : "sessions found"} · ${h.importable} importable natively, ${h.convertible} convertible (compressed), ${h.skipped} skipped`
          + (readErrors > 0 ? `, ${plural(readErrors, "read error")}` : "") + (already !== null ? `; ${already} already in T3 Code` : "")
        : null;
      const driver = HARNESS_DRIVER[h.id];
      // Converted sessions become Claude threads: only native imports need the harness's own T3 instance.
      const needsDriver = !counted || (h.importable ?? 0) > 0;
      const noDriver = driver !== undefined && needsDriver && providerDrivers !== null && !providerDrivers.some((p) => p.driver === driver && p.enabled);
      const enableFix = `Enable ${driver === "codex" ? "Codex" : "Pi"} in T3 Code settings (Providers), then run t3sm plan again`;
      if (noDriver && counts === null) {
        return { id, status: "warn", message: `sessions found but T3 Code has no ${driver} instance; they will be skipped`, fix: enableFix };
      }
      if (counts !== null && (noDriver || readErrors > 0)) {
        // Every problem is reported: one warn, messages and fixes combined.
        const fixes = [
          ...(noDriver ? [enableFix] : []),
          ...(readErrors > 0 ? ["Some Codex files could not be read (corrupt, cut short or unsupported); `t3sm scan` counts them as read errors. See docs/troubleshooting.md"] : []),
        ];
        const message = noDriver ? `${counts}; T3 Code has no ${driver} instance, so the ${h.importable} native sessions will be skipped` : counts;
        return { id, status: "warn", message, fix: fixes.join(". ") };
      }
      const unchecked = driver && providerDrivers === null ? " (T3 instance not checked: T3 Code unreachable)" : "";
      return ok(id, counts !== null ? `${counts}${unchecked}` : `sessions found${ver}${unchecked}`);
    });
  }

  // ---------- background sync ----------
  await run("schedule", async () => {
    const s = await deps.scheduleStatus();
    if (!s.installed) return ok("schedule", "not installed (optional: `t3sm schedule install` syncs in the background)");
    if (s.missing && s.missing.length > 0) {
      return { id: "schedule", status: "warn", message: `installed (${s.kind}), but its command points at ${s.missing.map(t).join(", ")}, which no longer ${s.missing.length === 1 ? "exists" : "exist"}; the scheduled sync cannot start`,
        fix: "Run t3sm schedule install again from the current t3sm" };
    }
    return ok("schedule", `installed (${s.kind})${s.nextRun ? `, next run ${s.nextRun}` : ""}${s.detail && s.kind !== "cron" ? `, ${s.detail}` : ""}`);
  });

  await run("sync-watcher", async () => {
    const hb = await deps.readHeartbeat();
    if (hb === null) return ok("sync-watcher", "no watcher (sync runs on the schedule or by hand)");
    if (hb.stoppedAt) return ok("sync-watcher", `stopped cleanly at ${hb.stoppedAt}`);
    const watcherFix = "Start it again with `t3sm sync --watch` (or `t3sm schedule install --watch`)";
    if (!deps.pidAlive(hb.pid)) return { id: "sync-watcher", status: "warn", message: `watcher pid ${hb.pid} is gone without a clean stop (last cycle ${hb.lastCycleAt ?? "never"})`, fix: watcherFix };
    const now = deps.now();
    const every = effective.schedule.everyMinutes * 60_000;
    const slack = 10 * 60_000;
    const next = hb.nextCycleAt ? Date.parse(hb.nextCycleAt) : NaN;
    const last = Date.parse(hb.lastCycleAt ?? hb.startedAt);
    const fresh = Number.isFinite(next) ? now <= next + slack : Number.isFinite(last) && now - last <= 2 * every + slack;
    const lastTxt = hb.lastCycleAt ? `last cycle ${ago(now - Date.parse(hb.lastCycleAt))} ago` : "no cycle yet";
    if (fresh) return ok("sync-watcher", `running (pid ${hb.pid}), ${lastTxt}`);
    if (!reachable) return ok("sync-watcher", `running (pid ${hb.pid}), ${lastTxt}; waiting for T3 Code`);
    return { id: "sync-watcher", status: "warn", message: `running (pid ${hb.pid}) but stale: ${lastTxt}, next cycle was due ${hb.nextCycleAt ?? "-"}`, fix: `End pid ${hb.pid} and ${watcherFix.replace(/^Start/, "start")}` };
  });

  await run("merge-pending", async () => {
    const p = deps.mergePending ? await deps.mergePending() : null;
    if (p === null) return ok("merge-pending", "not counted yet (t3sm sync or t3sm merge counts sessions continued in a terminal)");
    const orphaned = p.orphaned > 0 ? `${plural(p.orphaned, "session")} ${p.orphaned === 1 ? "has" : "have"} terminal work on a side branch that T3 Code cannot show` : "";
    if (p.count === 0 && orphaned === "") return ok("merge-pending", `no session continued in a terminal waits for a merge (as of ${p.at})`);
    const parts = [p.count > 0 ? `${plural(p.count, "session")} continued in a terminal since t3sm imported ${p.count === 1 ? "it" : "them"}; T3 Code does not show that work` : "", orphaned].filter((x) => x !== "");
    return { id: "merge-pending", status: "warn", message: `${parts.join("; ")} (as of ${p.at})`,
      fix: p.count > 0 ? "Run t3sm merge to list them, then t3sm merge --all (reversible with t3sm rollback)" : "Run t3sm merge to list them; recover side-branch work in a terminal with claude --resume <id>" };
  });

  return { checks: checks.map((c) => scrub(c, home)) };
}

/** Last line of defence: emails masked, the home folder shown as ~, tokens redacted. */
function scrub(c: Check, home: string): Check {
  const h = home.replace(/[\\/]+$/, "");
  const variants = [...new Set([h, h.replace(/\\/g, "/"), h.replace(/\//g, "\\")])].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?:${variants.join("|")})(?=[\\\\/]|\\b|$)`, "gi");
  const clean = (s: string) => redact(s.replace(EMAIL_RE, (_m, a: string, d: string) => `${a}***@${d}`)).replace(re, "~");
  const out: Check = { id: c.id, status: c.status, message: clean(c.message) };
  if (c.fix !== undefined) out.fix = clean(c.fix);
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
