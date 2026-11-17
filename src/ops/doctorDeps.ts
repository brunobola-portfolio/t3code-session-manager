// What runDoctor (src/ops/doctor.ts) reads through, and the real implementations (defaultDoctorDeps). Read-only, apart
// from repairMtimes (--repair). A child process never inherits CLAUDE_CONFIG_DIR (binVersion's childEnv).

import { statSync } from "node:fs";
import { access, constants, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AccountConfig, Config, HarnessId, JournalEntry } from "../core/types.ts";
import { DEFAULT_SCHEDULE_MINUTES, loadConfig } from "../core/config.ts";
import { pathKey, stateDir as stateDirOf } from "../core/paths.ts";
import { ACTIVE_WINDOW_MS } from "../core/activity.ts";
import { Journal, recoverPendingMtimes, type RecoverResult } from "../core/journal.ts";
import { acquireLock, lockInfo, type LockInfo } from "../core/lock.ts";
import { probeServer, readServerRuntime, resolveT3Cli, type ServerRuntime } from "../t3/runtime.ts";
import { connectT3, type T3Api } from "../t3/api.ts";
import { defaultRunner } from "../t3/auth.ts";
import { discoverAccountHomes, nodeDiscoveryEnv, resolveAccounts, type DiscoveredHome } from "./discoverAccounts.ts";
import { findBackupDirs, findOrphanedQuarantine, type OrphanedItem } from "./quarantine.ts";
import { defaultBinPath, realRunner, scheduleSpec, scheduleStatus } from "./schedule.ts";
import { pidAlive, readHeartbeat, type Heartbeat } from "./watch.ts";
import { readMergePending } from "./mergeCache.ts";
import { packageVersion, readPluginState, type PluginState } from "./plugin.ts";
import { installChangedAt, installRoot, installStamp, type InstallStamp } from "../core/version.ts";
import { allAdapters } from "../sources/registry.ts";
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
