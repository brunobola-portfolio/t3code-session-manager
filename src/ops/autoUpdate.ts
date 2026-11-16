// The background watcher's daily update check (spec §5.3 point 3). After a cycle, at most once per 24 h
// (`lastCheckAt` in <state>/update.json), when `update.auto` is on (default) and this t3sm is a global npm install (a
// checkout is updated with git pull, the npx cache is not updated at all), it looks up the releases of the remembered
// source (or package.json's GitHub repository):
//   - a newer patch or minor release (same major; 0.x minors included) is installed by a detached, hidden child
//     `t3sm update --auto-run --yes`, started at most once per check: the update stops the watcher, so it must never
//     run in the watcher's own process; the child takes the lock and runs runUpdate (src/ops/updater.ts). A child that
//     finds the lock taken asks for another check within the hour (<state>/update.retry);
//   - a newer major release is only announced: kept in update.json's `available`, one notification per version;
//   - an answer counts as the day's check (no release at all included); offline (no answer): nothing is recorded, one
//     line in logs/sync.log per streak, tried again in 1 h.
// The lookup (git ls-remote / npm view) is the only network call t3sm makes. Never throws for a lookup; a write error
// propagates (the watcher ignores it) but cannot repeat the check sooner than in an hour.

import { spawn as nodeSpawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, updateAuto } from "../core/config.ts";
import { atomicWrite } from "../core/fsutil.ts";
import { acquireLock, type Lock } from "../core/lock.ts";
import type { CommandRunner } from "../core/run.ts";
import { compareSemver, parseSemver } from "../core/semver.ts";
import type { Config, UpdateSource } from "../core/types.ts";
import { installRoot, packageVersion } from "../core/version.ts";
import { notifyOnce, updateNotice, UPDATE_AVAILABLE_REASON, type Notifier } from "./notify.ts";
import { resolveLang } from "../assistant/i18n.ts";
import { defaultBinPath, detectConhost } from "./schedule.ts";
import { spawnSuccessor, type SpawnLike } from "./successor.ts";
import { appendSyncLog } from "./sync.ts";
import { defaultUpdateSource, installKind, isRegistryInstall, ownPackageName, ownRepositoryUrl, updateRunner, type InstallKind } from "./update.ts";
import { classify, newestRelease, readUpdateState, releaseVersions, writeUpdateState, type UpdateState } from "./updater.ts";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A check that got no answer (or found the lock taken) is tried again after this long. */
export const UPDATE_CHECK_RETRY_MS = 60 * 60 * 1000;

// ---------- the retry request (an update child that found the lock taken) ----------

const RETRY_FILE = "update.retry";

/** Asks the watcher's next check to run at `at` even when the day's check already ran (best effort). */
export async function requestUpdateRetry(stateDir: string, at: Date): Promise<void> {
  await atomicWrite(join(stateDir, RETRY_FILE), `${at.toISOString()}\n`).catch(() => { /* the next daily check comes anyway */ });
}

async function readRetry(stateDir: string): Promise<number | null> {
  try { const t = Date.parse((await readFile(join(stateDir, RETRY_FILE), "utf8")).trim()); return Number.isFinite(t) ? t : null; } catch { return null; }
}

/** update.json and the retry request (tests inject an in-memory one). */
export interface UpdateStore {
  read(): Promise<UpdateState | null>;
  write(s: UpdateState): Promise<void>;
  /** When a retry was asked for (epoch ms), or null. */
  retryAt?(): Promise<number | null>;
  clearRetry?(): Promise<void>;
}

/**
 * The release an automatic update installs: the newest one strictly newer than `installed` with the same major (a patch
 * or a minor; 0.x minors included), leaving out `skip` (rolled back before). null: none.
 */
export function autoTarget(installed: string, versions: readonly string[], skip: readonly string[] = []): string | null {
  const cur = parseSemver(installed);
  if (cur === null) return null;
  const same = versions.filter((v) => parseSemver(v)?.[0] === cur[0] && compareSemver(v, installed) > 0);
  return newestRelease(same, skip);
}

export interface DailyCheckDeps {
  stateDir: string;
  /** The installed version, read fresh (package.json). */
  installed: () => string;
  kind: InstallKind;
  /** config.json, read fresh for every check (`t3sm update --auto off` takes effect at the next one). */
  config: () => Promise<Config | null>;
  /** Where to look when update.json remembers nothing (package.json's GitHub repository). */
  defaultSource: UpdateSource | null;
  run: CommandRunner;
  platform: NodeJS.Platform;
  now: () => number;
  /** Starts the detached `t3sm update --auto-run --yes` child. */
  spawnUpdate: () => void;
  /** One line for logs/sync.log (English, stable, no paths). */
  log: (line: string) => void | Promise<void>;
  /** Announces a newly found major release (the watcher: one notification per version). */
  announce?: (version: string) => Promise<void>;
  store?: UpdateStore;
  lock?: (dir: string) => Promise<Lock | null>;
}

export type DailyCheckResult =
  | { kind: "skipped"; why: "not-installed" | "auto-off" | "not-due" | "no-source" | "busy" | "stopping" }
  | { kind: "unavailable" }
  /** latest: the newest release (null: none yet); install: what the child was started for; major: a newer major. */
  | { kind: "checked"; latest: string | null; install: string | null; major: string | null };

/** The check, holding its own retry time and "logged once" streak for the life of the watcher. */
export function dailyUpdateCheck(d: DailyCheckDeps): { check(stopped?: () => boolean): Promise<DailyCheckResult> } {
  const store: UpdateStore = d.store ?? {
    read: () => readUpdateState(d.stateDir),
    write: (s) => writeUpdateState(d.stateDir, s),
    retryAt: () => readRetry(d.stateDir),
    clearRetry: () => rm(join(d.stateDir, RETRY_FILE), { force: true }),
  };
  let notBefore = -Infinity; // in memory too: a failed update.json write never turns into a check (and a child) per cycle
  let unavailableLogged = false;
  return {
    /** `stopped`: the watcher was asked to stop meanwhile (`schedule remove`, an update): no update child is started. */
    async check(stopped?: () => boolean) {
      if (d.kind !== "global") return { kind: "skipped", why: "not-installed" };
      // A config.json that cannot be read: no automatic install (it may say `"auto": false`).
      const config = await d.config().then((c) => c, () => undefined);
      if (config === undefined || !updateAuto(config)) return { kind: "skipped", why: "auto-off" };
      const now = d.now();
      if (now < notBefore) return { kind: "skipped", why: "not-due" };
      const state = await store.read();
      const retry = (await store.retryAt?.().catch(() => null)) ?? null;
      const last = Date.parse(state?.lastCheckAt ?? "");
      const checkedToday = Number.isFinite(last) && now - last >= 0 && now - last < UPDATE_CHECK_INTERVAL_MS;
      if (checkedToday && !(retry !== null && now >= retry)) return { kind: "skipped", why: "not-due" };
      const source = state?.source ?? d.defaultSource;
      if (source === null) return { kind: "skipped", why: "no-source" };
      notBefore = now + UPDATE_CHECK_RETRY_MS;

      const versions = await releaseVersions(source, d.run, d.platform);
      if (versions === null) {
        if (!unavailableLogged) { unavailableLogged = true; await d.log("update-check unavailable"); }
        return { kind: "unavailable" };
      }
      unavailableLogged = false;
      const skip = state?.skip ?? [];
      const latest = newestRelease(versions, skip);
      const installed = d.installed();
      const install = autoTarget(installed, versions, skip);
      const major = latest !== null && classify(installed, latest) === "major" ? latest : null;

      const lock = await (d.lock ?? acquireLock)(d.stateDir);
      if (!lock) return { kind: "skipped", why: "busy" }; // a manual update or a sync holds it: in an hour
      let announcedBefore: string | null;
      try {
        // Read again under the lock: an update that just ran may have changed the source or the previous version.
        const cur = (await store.read()) ?? { source, lastCheckAt: null, previous: null, available: null, skip: [] };
        announcedBefore = cur.available;
        await store.write({ ...cur, lastCheckAt: new Date(now).toISOString(), available: major });
        await store.clearRetry?.().catch(() => { /* asked again by the next busy child, if any */ });
      } finally {
        await lock.release();
      }
      if (major !== null && announcedBefore !== major) {
        await d.log(`update-check available to=${major}`);
        await d.announce?.(major).catch(() => { /* an announcement never fails the check */ });
      }
      if (install !== null && stopped?.() === true) return { kind: "skipped", why: "stopping" }; // the next watcher checks again
      if (install !== null) {
        await d.log(`update-check start to=${install}`);
        d.spawnUpdate();
      }
      return { kind: "checked", latest, install, major };
    },
  };
}

// ---------- the watcher's real check ----------

export interface WatcherCheckOptions {
  stateDir: string;
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  now: () => number;
  /** The OS notifier (absent: no announcement, `available` is still recorded). */
  notifier?: Notifier;
  /** Tests: the git/npm runner (default updateRunner), the install's kind and version, the default source, the spawn. */
  run?: CommandRunner;
  kind?: InstallKind;
  installed?: () => string;
  defaultSource?: UpdateSource | null;
  spawn?: SpawnLike;
  /** win32: conhost.exe for a hidden window, or null for the `start /min` fallback (default: detected). */
  conhost?: string | null;
}

/**
 * The daily check as the watcher runs it: this install's kind and version, config.json read fresh, the npm registry
 * (an install that came from it) or package.json's GitHub repository as the default source, git and npm through
 * updateRunner, the update child started like a successor
 * (detached, hidden, without CLAUDE_CONFIG_DIR) from this install's bin, a major announced once per version, and the
 * log lines in logs/sync.log.
 */
/** The default source of this install: its npm package when npm installed it from the registry, else GitHub. */
function registryAwareDefault(): UpdateSource | null {
  const name = ownPackageName();
  return defaultUpdateSource(ownRepositoryUrl(), { name, installed: isRegistryInstall(installRoot().replace(/[\\/]+$/, "")) });
}

export function watcherUpdateCheck(o: WatcherCheckOptions): (stopped?: () => boolean) => Promise<DailyCheckResult> {
  const c = dailyUpdateCheck({
    stateDir: o.stateDir,
    installed: o.installed ?? packageVersion,
    kind: o.kind ?? installKind(installRoot().replace(/[\\/]+$/, "")),
    config: () => loadConfig(o.stateDir, o.home),
    defaultSource: o.defaultSource !== undefined ? o.defaultSource : registryAwareDefault(),
    run: o.run ?? updateRunner(o.platform, o.env),
    platform: o.platform,
    now: o.now,
    spawnUpdate: () => spawnSuccessor({
      platform: o.platform, nodePath: process.execPath, binPath: defaultBinPath(), env: o.env,
      conhost: o.conhost !== undefined ? o.conhost : o.platform === "win32" ? detectConhost() : null,
      spawn: o.spawn ?? (nodeSpawn as unknown as SpawnLike),
      argv: ["update", "--auto-run", "--yes"],
    }),
    log: (line) => appendSyncLog(o.stateDir, `${new Date(o.now()).toISOString()} ${line}`).catch(() => { /* never fails the check */ }),
    announce: async (v) => {
      if (!o.notifier) return;
      const config = await loadConfig(o.stateDir, o.home).catch(() => null);
      // The watcher has no Io: the language is resolved as the cycle does (env, then config.json "language").
      const { title, body } = updateNotice("available", { to: v }, resolveLang(null, o.env, config?.language ?? null));
      await notifyOnce({ stateDir: o.stateDir, mode: config?.notify ?? "attention", notifier: o.notifier, now: o.now(), key: `${UPDATE_AVAILABLE_REASON}:${v}`, title, body });
    },
  });
  return (stopped) => c.check(stopped);
}
