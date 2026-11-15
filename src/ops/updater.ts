// The update engine (spec §5.3 points 3-4): find the newest release of the remembered source, never downgrade, install
// it with npm, restart the watcher into it, check that it is healthy within HEALTH_MS, roll back if it is not, and
// journal every update. `t3sm update` and the watcher's daily check (Task 14) drive it.
//
// Sources: GitHub (`git ls-remote --tags --refs https://github.com/<repo>.git`, npm as the fallback when git itself
// fails; the only network calls t3sm makes) or a local checkout (its `vX.Y.Z` tags merged into `main`, or `master` when
// there is no `main`). Every external command goes through the injected CommandRunner as an argument array with a time
// limit (QUERY_TIMEOUT_MS, INSTALL_TIMEOUT_MS); versions are checked with parseSemver, repository slugs with REPO_RE and
// folders must be absolute before anything runs. npm and git never get CLAUDE_CONFIG_DIR and git never prompts
// (updateRunner in src/ops/update.ts). State: `<state>/update.json`, written atomically.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { atomicWrite } from "../core/fsutil.ts";
import { Journal, newRunId } from "../core/journal.ts";
import { acquireLock, type Lock } from "../core/lock.ts";
import type { CommandRunner, RunResult } from "../core/run.ts";
import { compareSemver, parseSemver } from "../core/semver.ts";
import type { UpdateSource } from "../core/types.ts";
import { detectConhost, installSchedule, scheduleSpec, scheduleStatus, type ScheduleFs } from "./schedule.ts";
import { spawnSuccessor, type SpawnLike } from "./successor.ts";
import { readHeartbeat as realReadHeartbeat, type Clock, type Heartbeat } from "./watch.ts";
import type { StopResult } from "./watcherControl.ts";

export type { UpdateSource };

export interface UpdateState {
  source: UpdateSource;
  /** When the newest release was last looked up (ISO), null before the first check. */
  lastCheckAt: string | null;
  /** The version installed before the last update and how to reinstall it (rollback). */
  previous: { version: string; spec: string } | null;
  /** A newer release found but not installed (a major, or auto-update off), null when none. */
  available: string | null;
  /**
   * Versions that were rolled back: latestRelease skips them, so the daily check does not install the same bad release
   * again every day. Installing a newer release clears every version up to it. Absent in older files: [].
   */
  skip: string[];
}

/** How long a new version has to write a healthy heartbeat (counted from when the restart returned) before rollback. */
export const HEALTH_MS = 120_000;
/** Time limit of a lookup (ls-remote, npm view, git tag). */
export const QUERY_TIMEOUT_MS = 60_000;
/** Time limit of a clone or an npm install. */
export const INSTALL_TIMEOUT_MS = 600_000;
const POLL_MS = 2000;
/** A heartbeat's startedAt comes from another process's clock: this much before the restart still counts. */
const START_SLACK_MS = 2000;
const UPDATE_FILE = "update.json";
/** GitHub `owner/name`: owners are letters, digits and hyphens; names add `_` and `.` (never `.` or `..` alone). */
const REPO_RE = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
/** npm without the extra network calls and banners nobody sees in a background install. */
const NPM_INSTALL = ["install", "-g", "--install-links", "--no-audit", "--no-fund", "--no-update-notifier"];

export class UpdateError extends Error {
  override name = "UpdateError";
}

// ---------- update.json ----------

const isObj = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u);
const strOrNull = (u: unknown): u is string | null => u === null || typeof u === "string";

function decodeSource(u: unknown): UpdateSource | null {
  if (!isObj(u)) return null;
  if (u["kind"] === "github" && typeof u["repo"] === "string" && REPO_RE.test(u["repo"])) return { kind: "github", repo: u["repo"] };
  if (u["kind"] === "folder" && typeof u["path"] === "string" && u["path"] !== "") return { kind: "folder", path: u["path"] };
  return null;
}

function decodeState(u: unknown): UpdateState | null {
  if (!isObj(u)) return null;
  const source = decodeSource(u["source"]);
  const prev = u["previous"];
  if (source === null || !strOrNull(u["lastCheckAt"]) || !strOrNull(u["available"])) return null;
  if (u["available"] !== null && parseSemver(u["available"] as string) === null) return null;
  let previous: UpdateState["previous"] = null;
  if (prev !== null) {
    if (!isObj(prev) || typeof prev["version"] !== "string" || parseSemver(prev["version"]) === null || typeof prev["spec"] !== "string") return null;
    previous = { version: prev["version"], spec: prev["spec"] };
  }
  const skip = u["skip"] ?? [];
  if (!Array.isArray(skip) || !skip.every((v): v is string => typeof v === "string" && parseSemver(v) !== null)) return null;
  return { source, lastCheckAt: u["lastCheckAt"] as string | null, previous, available: u["available"] as string | null, skip: skip.map(release) };
}

/** `<state>/update.json`, or null when it is absent or not valid (strictly decoded). */
export async function readUpdateState(stateDir: string): Promise<UpdateState | null> {
  try { return decodeState(JSON.parse(await readFile(join(stateDir, UPDATE_FILE), "utf8"))); } catch { return null; }
}

export async function writeUpdateState(stateDir: string, s: UpdateState): Promise<void> {
  await atomicWrite(join(stateDir, UPDATE_FILE), JSON.stringify(s, null, 2) + "\n");
}

// ---------- versions ----------

/** Never "downgrade": an older or equal (or unreadable) latest is "none". Majors are only announced (the caller's rule). */
export function classify(installed: string, latest: string): "none" | "patch" | "minor" | "major" {
  const a = parseSemver(installed);
  const b = parseSemver(latest);
  if (a === null || b === null || compareSemver(latest, installed) <= 0) return "none";
  return b[0] !== a[0] ? "major" : b[1] !== a[1] ? "minor" : "patch";
}

/** The release version of `v`, without the `v` ("0.3.1"); throws when it is not one. */
function release(v: string): string {
  const p = parseSemver(v);
  if (p === null) throw new UpdateError(`not a release version: ${JSON.stringify(v)}`);
  return p.join(".");
}

/** The newest of `versions` (release versions only, without the `v`) that is not in `skip`, or null. */
export function newestRelease(versions: readonly string[], skip: readonly string[] = []): string | null {
  const skipped = new Set(skip.filter((v) => parseSemver(v) !== null).map(release));
  const ok = versions.filter((v) => parseSemver(v) !== null).map(release).filter((v) => !skipped.has(v));
  return ok.length === 0 ? null : ok.sort(compareSemver).at(-1)!;
}

/**
 * A local absolute folder on `platform`, never one that could be read as an option. Windows: a drive path
 * (`D:\code\t3sm`) only, never a network or device path (`\\server\share`, `\\?\UNC\...`, `//host/...`, `\\?\C:\...`)
 * or a drive-relative one (`\code`). POSIX: a path starting with a single `/` (`//host/...` is refused too). An update
 * installs and runs code from this folder, so it must be the user's own checkout on this machine. This only refuses
 * network paths written out as such: a mapped network drive letter (Windows) or an NFS/SMB mount point (POSIX) looks
 * local and still passes.
 */
function absoluteFolder(p: string, platform: NodeJS.Platform): boolean {
  if (/[\0\r\n]/.test(p)) return false;
  return platform === "win32" ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith("/") && !p.startsWith("//");
}

/** Why `src` cannot be used on `platform` (a slug that is not owner/name, a folder that is not local and absolute), or null. */
export function sourceProblem(src: UpdateSource, platform: NodeJS.Platform): string | null {
  try { checkSource(src, platform); return null; } catch (e) { return (e as Error).message; }
}

function checkSource(src: UpdateSource, platform: NodeJS.Platform): void {
  if (src.kind === "github" && !REPO_RE.test(src.repo)) throw new UpdateError(`the GitHub repository must be owner/name: ${JSON.stringify(src.repo)}`);
  if (src.kind === "folder" && !absoluteFolder(src.path, platform)) {
    const example = platform === "win32" ? "D:\\code\\t3sm" : "/home/you/code/t3sm";
    throw new UpdateError(`the update folder must be a local absolute path (such as ${example}); network folders are not accepted: ${JSON.stringify(src.path)}`);
  }
}

/** `file://` URL of a local checkout (absoluteFolder) for git clone (`--depth` needs a URL, not a path); git takes it unencoded. */
function fileUrl(p: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `file:///${p.replace(/\\/g, "/")}` : `file://${p}`;
}

/**
 * The `vX.Y.Z` releases of `src` (without the `v`; prereleases and junk left out), or null when they cannot be looked
 * up. Never throws: offline, a timeout, git or npm missing, or an unusable source all give null. GitHub asks npm (which
 * only knows the newest) only when git itself failed: an answer without release tags is an empty list.
 */
export async function releaseVersions(src: UpdateSource, run: CommandRunner, platform: NodeJS.Platform = process.platform): Promise<string[] | null> {
  const attempt = async (cmd: string, args: string[]): Promise<RunResult | null> => {
    try { const r = await run(cmd, args, { timeoutMs: QUERY_TIMEOUT_MS }); return r.code === 0 ? r : null; } catch { return null; }
  };
  const releases = (tags: string[]): string[] => tags.filter((t) => t.startsWith("v") && parseSemver(t) !== null).map(release);
  try { checkSource(src, platform); } catch { return null; }
  if (src.kind === "github") {
    const r = await attempt("git", ["ls-remote", "--tags", "--refs", `https://github.com/${src.repo}.git`]);
    if (r !== null) return releases(r.stdout.split(/\r?\n/).map((l) => /\trefs\/tags\/(.+)$/.exec(l.trim())?.[1] ?? ""));
    const v = await attempt("npm", ["view", `github:${src.repo}`, "version"]);
    if (v === null) return null;
    const one = v.stdout.trim().replace(/^['"]|['"]$/g, "");
    return parseSemver(one) === null ? [] : [release(one)];
  }
  for (const branch of ["main", "master"]) {
    const r = await attempt("git", ["-C", src.path, "tag", "--merged", branch, "--list", "v*"]);
    if (r) return releases(r.stdout.split(/\r?\n/).map((l) => l.trim()));
  }
  return null;
}

/**
 * The newest `vX.Y.Z` release of `src` (without the `v`), leaving out the versions in `skip` (rolled back before), or
 * null when none can be found (see releaseVersions). Never throws.
 */
export async function latestRelease(src: UpdateSource, run: CommandRunner, platform: NodeJS.Platform = process.platform, skip: readonly string[] = []): Promise<string | null> {
  const v = await releaseVersions(src, run, platform);
  return v === null ? null : newestRelease(v, skip);
}

// ---------- installing ----------

/** The npm spec rollback reinstalls: `github:<repo>#v<version>` or `folder:<path>#v<version>`. */
export function releaseSpecOf(src: UpdateSource, version: string): string {
  return `${src.kind === "github" ? `github:${src.repo}` : `folder:${src.path}`}#v${release(version)}`;
}

/** The source and version of a releaseSpecOf spec, or null when it is not one. */
export function parseReleaseSpec(spec: string): { source: UpdateSource; version: string } | null {
  const at = spec.lastIndexOf("#v");
  if (at < 0 || parseSemver(spec.slice(at + 1)) === null) return null;
  const head = spec.slice(0, at);
  const version = release(spec.slice(at + 1));
  if (head.startsWith("github:")) return { source: { kind: "github", repo: head.slice(7) }, version };
  if (head.startsWith("folder:") && head.length > 7) return { source: { kind: "folder", path: head.slice(7) }, version };
  return null;
}

/** Temporary folders for a folder install's clone (tests inject their own). */
export interface TempDirs { make(): Promise<string>; remove(p: string): Promise<void> }
const realTemp: TempDirs = {
  make: () => mkdtemp(join(tmpdir(), "t3sm-update-")),
  remove: (p) => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
};

export interface InstallDeps {
  /** git and npm (default for real use: updateRunner from src/ops/update.ts). */
  run: CommandRunner;
  platform: NodeJS.Platform;
  tmp?: TempDirs;
}

function failure(tool: "npm" | "git", what: string, r: RunResult): UpdateError {
  if (r.code === 127) {
    return new UpdateError(tool === "npm"
      ? "npm was not found on PATH. Install Node.js (it includes npm), then try again."
      : "git was not found on PATH. Install Git (https://git-scm.com), then try again.");
  }
  if (r.code === 124) return new UpdateError(`${what} timed out after ${Math.round(INSTALL_TIMEOUT_MS / 1000)} s (no network, a proxy that does not answer, or a credential prompt)`);
  const why = (r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? "";
  return new UpdateError(`${what} failed (exit ${r.code})${why ? `: ${why}` : ""}`);
}

/**
 * Installs release `version` of `src` globally. GitHub: `npm install -g --install-links ... github:<repo>#v<version>`.
 * Folder: `git clone --depth 1 --branch v<version> file://<path> <tmp>`, then `npm install -g --install-links ... .` run
 * in the clone (npm resolves `.` against its working folder, so no path reaches npm's command line, which on Windows
 * goes through a shell), and the clone is removed in finally. `--install-links` makes npm copy the package instead of
 * linking to a folder that is about to be deleted. Each command has INSTALL_TIMEOUT_MS. Throws UpdateError (with the
 * install hint when npm or git is missing).
 */
export async function installRelease(src: UpdateSource, version: string, d: InstallDeps): Promise<void> {
  const v = release(version);
  checkSource(src, d.platform);
  const limit = { timeoutMs: INSTALL_TIMEOUT_MS };
  if (src.kind === "github") {
    const r = await d.run("npm", [...NPM_INSTALL, `github:${src.repo}#v${v}`], limit);
    if (r.code !== 0) throw failure("npm", "npm install", r);
    return;
  }
  const tmp = d.tmp ?? realTemp;
  const dir = await tmp.make();
  try {
    const c = await d.run("git", ["-c", "advice.detachedHead=false", "clone", "--depth", "1", "--branch", `v${v}`, "--", fileUrl(src.path, d.platform), dir], limit);
    if (c.code !== 0) throw failure("git", `git clone of v${v}`, c);
    const r = await d.run("npm", [...NPM_INSTALL, "."], { cwd: dir, ...limit });
    if (r.code !== 0) throw failure("npm", "npm install", r);
  } finally {
    await tmp.remove(dir).catch(() => { /* a leftover temp folder is harmless */ });
  }
}

// ---------- restarting the watcher ----------

/** Stopping and starting the background watcher around an install (tests inject a fake; watcherOps is the real one). */
export interface WatcherOps {
  /** Stops the running watcher by its own control (ops/watcherControl stopWatcher): never by name. */
  stop(): Promise<StopResult>;
  /**
   * Starts the watcher again from what is installed now. reinstallSchedule: re-register the scheduled watcher first
   * (a 0.2.1 schedule gains the keep-alive trigger). Resolves true when a watcher should now come up (a scheduled
   * watcher exists, or one was running), false when there is none to bring back.
   */
  restart(o: { wasRunning: boolean; reinstallSchedule: boolean }): Promise<boolean>;
}

export interface RestartOptions {
  platform: NodeJS.Platform;
  run: CommandRunner;
  stateDir: string;
  /** The node and bin/t3sm.mjs the scheduler and a spawned successor run (the global install's own). */
  nodePath: string;
  binPath: string;
  everyMinutes: number;
  home?: string;
  uid?: number;
  /** win32: conhost.exe for a hidden window, null for the `start /min` fallback (undefined: detected). */
  conhost?: string | null;
  systemRoot?: string;
  userId?: string;
  spawn?: SpawnLike;
  fs?: ScheduleFs;
  stop: () => Promise<StopResult>;
}

/**
 * The real WatcherOps. Every scheduler call has QUERY_TIMEOUT_MS (a hung schtasks.exe or launchctl must not hold the
 * state lock forever). With a scheduled watcher (`sync --watch` registered with the scheduler):
 * - win32: the task is re-created (`schtasks /Create`, only when reinstalling), then `schtasks /Run`, and the successor
 *   is spawned as well, whatever /Run said: Task Scheduler drops a /Run (exit 0, IgnoreNew) while it still counts a
 *   task instance as running (the stopped watcher's conhost exiting, or the automatic update's own task tree), and a
 *   duplicate finds the single-instance pipe taken and exits 0 (the keep-alive trigger is the safety net either way);
 * - darwin: reinstalling = bootout + bootstrap of the LaunchAgent (RunAtLoad starts the new code); otherwise
 *   `launchctl kickstart -k gui/<uid>/dev.t3sm.sync`, and bootstrap when it is not loaded. A release that crashes at
 *   start is relaunched by KeepAlive about every 60 s until the rollback reinstalls the previous one, which launchd
 *   then runs;
 * - cron: the crontab is rewritten (only when reinstalling), then the successor is spawned (@reboot waits for a reboot).
 * Without one: the successor is spawned only when a watcher was running.
 */
export function watcherOps(o: RestartOptions): WatcherOps {
  const run: CommandRunner = (cmd, args, op) => o.run(cmd, args, { timeoutMs: QUERY_TIMEOUT_MS, ...op });
  const spec = () => scheduleSpec(o.platform, o.nodePath, o.binPath, o.everyMinutes, {
    watch: true, home: o.home, uid: o.uid, conhost: o.conhost, stateDir: o.stateDir, systemRoot: o.systemRoot, userId: o.userId,
  });
  const successor = (): void => spawnSuccessor({
    platform: o.platform, nodePath: o.nodePath, binPath: o.binPath, systemRoot: o.systemRoot,
    conhost: o.conhost !== undefined ? o.conhost : o.platform === "win32" ? detectConhost() : null,
    spawn: o.spawn ?? (nodeSpawn as unknown as SpawnLike),
  });
  return {
    stop: o.stop,
    async restart({ wasRunning, reinstallSchedule }) {
      const s = spec();
      const st = await scheduleStatus(s, run).catch(() => null);
      const scheduled = st !== null && st.installed && (st.command === null || st.command.includes("--watch"));
      if (!scheduled) {
        if (!wasRunning) return false;
        successor();
        return true;
      }
      if (s.kind === "schtasks") {
        if (reinstallSchedule) await installSchedule({ ...s, install: [s.install[0]!] }, run, o.fs);
        await run(s.install[1]![0]!, s.install[1]!.slice(1));
        successor();
        return true;
      }
      if (s.kind === "launchd") {
        if (reinstallSchedule) { await installSchedule(s, run, o.fs); return true; }
        const r = await run("launchctl", ["kickstart", "-k", s.remove[0]![2]!]);
        if (r.code !== 0) await installSchedule(s, run, o.fs);
        return true;
      }
      if (reinstallSchedule) await installSchedule(s, run, o.fs);
      successor();
      return true;
    },
  };
}

// ---------- the update ----------

export interface UpdaterDeps extends InstallDeps {
  stateDir: string;
  /** The version installed now (read fresh from package.json). */
  installed: string;
  /** Reads the installed version again once the lock is held (default: `installed`). */
  readInstalled?: () => string;
  /**
   * Where to update from; default: update.json's remembered source. A new source is remembered only after an
   * "installed" outcome: a failed or rolled-back update never changes (or creates) the remembered one.
   */
  source?: UpdateSource;
  clock: Clock;
  watcher: WatcherOps;
  journal?: Journal;
  lock?: (dir: string) => Promise<Lock | null>;
  readHeartbeat?: (stateDir: string) => Promise<Heartbeat | null>;
  /** Writes update.json (default writeUpdateState; tests inject failures). */
  writeState?: (stateDir: string, s: UpdateState) => Promise<void>;
  /**
   * The source t3sm updates from when nothing is remembered (the caller's default: package.json's GitHub repository).
   * Used only to keep a rolled-back version in `skip` when no update.json exists yet: an unconfirmed `source` (a
   * `--from` that never installed) is never remembered.
   */
  defaultSource?: UpdateSource;
  /** Each step as it starts, for a live progress line (`t3sm update`). */
  onStep?: (step: UpdateStep) => void;
  healthMs?: number;
  pollMs?: number;
}

/** installing: npm (and git for a folder); restarting: stop and start the watcher; checking: the health wait; rolling-back. */
export type UpdateStep = "installing" | "restarting" | "checking" | "rolling-back";

export type UpdateOutcome = { outcome: "installed" | "rolled-back" | "failed"; from: string; to: string; error?: string };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0]!.slice(0, 300);

// ---------- the attempt on disk (update.pending.json) ----------

const PENDING_FILE = "update.pending.json";

/**
 * An update that started installing: written (atomically) before the install, removed after its outcome is journaled.
 * Still there at the next start: t3sm was killed mid-update (power loss, a killed watcher). `interrupted` is set once
 * that was journaled; `previous` says what to reinstall to roll it back.
 */
export interface PendingUpdate {
  runId: string;
  previous: { version: string; spec: string };
  source: UpdateSource;
  target: string;
  startedAt: string;
  interrupted?: true;
}

function decodePending(u: unknown): PendingUpdate | null {
  if (!isObj(u) || typeof u["runId"] !== "string" || typeof u["startedAt"] !== "string" || typeof u["target"] !== "string" || parseSemver(u["target"]) === null) return null;
  const prev = u["previous"];
  const source = decodeSource(u["source"]);
  if (source === null || !isObj(prev) || typeof prev["version"] !== "string" || parseSemver(prev["version"]) === null || typeof prev["spec"] !== "string") return null;
  return {
    runId: u["runId"], previous: { version: prev["version"], spec: prev["spec"] }, source, target: u["target"], startedAt: u["startedAt"],
    ...(u["interrupted"] === true ? { interrupted: true as const } : {}),
  };
}

/** `<state>/update.pending.json`: an update in progress, or one that was interrupted (read-only; for status). */
export async function readPendingUpdate(stateDir: string): Promise<PendingUpdate | null> {
  try { return decodePending(JSON.parse(await readFile(join(stateDir, PENDING_FILE), "utf8"))); } catch { return null; }
}

const writePending = (stateDir: string, p: PendingUpdate): Promise<void> => atomicWrite(join(stateDir, PENDING_FILE), JSON.stringify(p, null, 2) + "\n");
const removePending = (stateDir: string): Promise<void> => rm(join(stateDir, PENDING_FILE), { force: true }).catch(() => { /* best effort */ });

/**
 * A leftover update.pending.json from an update that never journaled its outcome: journals it once as `failed` with
 * error "interrupted" and keeps the record (marked `interrupted`, with `previous` for a rollback) until the next update
 * replaces it. One whose outcome was journaled (t3sm died just before removing the file) is simply removed. Call it
 * under the state lock (runUpdate does, before its own attempt). Returns the interrupted record, or null.
 */
export async function recoverInterruptedUpdate(stateDir: string, journal: Journal): Promise<PendingUpdate | null> {
  const p = await readPendingUpdate(stateDir);
  if (p === null) return null;
  if (p.interrupted) return p;
  const entries = await journal.readAll();
  const ended = entries.some((e) => e.t === "update" && e.runId === p.runId && e.outcome !== "pending");
  if (ended) { await removePending(stateDir); return null; }
  await journal.append({ t: "update", runId: p.runId, from: p.previous.version, to: p.target, source: p.source, outcome: "failed", error: "interrupted" });
  const marked: PendingUpdate = { ...p, interrupted: true };
  await writePending(stateDir, marked).catch(() => { /* journaled; the record is only a hint */ });
  return marked;
}

/**
 * Installs release `target` over the installed version, in this order: lock (busy: "failed" with error "busy", the next
 * check retries), report an interrupted earlier update (recoverInterruptedUpdate), journal `update` pending, record the
 * attempt in update.pending.json and `previous` in update.json, install, stop the watcher, start it again
 * (re-registering the scheduled watcher), then wait HEALTH_MS (from when the restart returned) for a heartbeat of
 * `target` that started after the restart and has not stopped; none: reinstall `previous`, stop and start again
 * ("rolled-back", and `target` goes into `skip`). Only evidence against the new version rolls it back: when the restart
 * itself did not happen (the old watcher would not stop, or the scheduler call failed), a missing heartbeat says nothing
 * about the release, so it stays: "installed" with that reason as `error`, no skip (status then shows the watcher's own
 * state: an old one restarts itself into the install after its cycle; a stopped one is restart-lost). Then the outcome is
 * journaled. A target that is not strictly newer is
 * refused ("not-newer") before anything runs: never a downgrade. Once the pending entry is written, every error ends in
 * a journaled outcome; update.json writes after the install are best effort (they never change what happened).
 */
export async function runUpdate(target: string, d: UpdaterDeps): Promise<UpdateOutcome> {
  const asked = { from: d.installed, to: target };
  if (parseSemver(target) === null || parseSemver(d.installed) === null) return { outcome: "failed", ...asked, error: "invalid-version" };
  if (compareSemver(target, d.installed) <= 0) return { outcome: "failed", ...asked, error: "not-newer" };
  const lock = await (d.lock ?? acquireLock)(d.stateDir);
  if (!lock) return { outcome: "failed", ...asked, error: "busy" };
  try {
    // Read again under the lock: another update may have installed it (or something newer) while this one waited.
    let from: string;
    try { from = d.readInstalled?.() ?? d.installed; } catch { return { outcome: "failed", ...asked, error: "invalid-version" }; }
    const base = { from, to: target };
    if (parseSemver(from) === null) return { outcome: "failed", ...base, error: "invalid-version" };
    if (compareSemver(target, from) <= 0) return { outcome: "failed", ...base, error: "not-newer" };
    const journal = d.journal ?? new Journal(join(d.stateDir, "journal.jsonl"));
    await recoverInterruptedUpdate(d.stateDir, journal);
    const state = await readUpdateState(d.stateDir);
    const source = d.source ?? state?.source;
    if (!source) return { outcome: "failed", ...base, error: "no-source" };
    const runId = newRunId(new Date(d.clock.now()));
    const { previous, confirmed } = previousOf(from, state, source);
    let attemptOnDisk = false;
    const done = async (outcome: UpdateOutcome["outcome"], error?: string): Promise<UpdateOutcome> => {
      await journal.append({ t: "update", runId, from, to: target, source, outcome, ...(error !== undefined ? { error } : {}) });
      if (attemptOnDisk) await removePending(d.stateDir); // after the outcome: a crash in between is not "interrupted"
      return { outcome, ...base, ...(error !== undefined ? { error } : {}) };
    };
    // The attempt on disk first, then the pending entry: a crash after the entry always leaves the record that
    // recoverInterruptedUpdate reports. Nothing is installed yet, so a record that cannot be written ends here.
    try {
      await writePending(d.stateDir, { runId, previous, source, target: release(target), startedAt: new Date(d.clock.now()).toISOString() });
      attemptOnDisk = true;
    } catch (e) {
      return done("failed", message(e));
    }
    await journal.append({ t: "update", runId, from, to: target, source, outcome: "pending" });
    try {
      return await update(target, d, source, state, previous, confirmed, done);
    } catch (e) {
      // Not expected (every step below catches its own errors), but the pending entry must never stay alone.
      return done("failed", message(e));
    }
  } finally {
    await lock.release();
  }
}

const sameSource = (a: UpdateSource, b: UpdateSource): boolean =>
  a.kind === b.kind && (a.kind === "github" ? a.repo === (b as { repo: string }).repo : a.path === (b as { path: string }).path);

/**
 * How to reinstall the installed version `from` (the rollback target), and whether that is known (`confirmed`) or a
 * guess. update.json's `previous` is written only once an install went through (see update), so an update.json that
 * has one remembers the source that installed `from`: confirmed. Its `previous` already naming `from` (an attempt that
 * did not install) keeps its spec, but only when that spec's source is the remembered one or this update's. Without a
 * `previous` (the daily check's update.json under the default source) or without update.json, nothing says how `from`
 * came: the guess is this update's own source, kept only in update.pending.json, never in update.json.
 */
function previousOf(from: string, state: UpdateState | null, source: UpdateSource): { previous: { version: string; spec: string }; confirmed: boolean } {
  const v = release(from);
  const confirmed = state !== null && state.previous !== null;
  const kept = state?.previous ? parseReleaseSpec(state.previous.spec) : null;
  if (state?.previous && kept !== null && release(state.previous.version) === v && (sameSource(kept.source, state.source) || sameSource(kept.source, source))) {
    return { previous: { version: v, spec: state.previous.spec }, confirmed: confirmed && sameSource(kept.source, state.source) };
  }
  return { previous: { version: v, spec: releaseSpecOf(confirmed ? state.source : source, from) }, confirmed };
}

async function update(
  target: string, d: UpdaterDeps, source: UpdateSource, state: UpdateState | null, previous: { version: string; spec: string },
  confirmed: boolean, done: (outcome: UpdateOutcome["outcome"], error?: string) => Promise<UpdateOutcome>,
): Promise<UpdateOutcome> {
  const write = d.writeState ?? writeUpdateState;
  const bestEffort = (s: UpdateState): Promise<void> => write(d.stateDir, s).catch(() => { /* never changes the outcome */ });
  const step = (s: UpdateStep): void => { try { d.onStep?.(s); } catch { /* progress output never stops an update */ } };
  // The remembered source stays until the new version is in (a new --from only applies to the new version), and so
  // does a guessed `previous`: it goes into update.json only once the install went through.
  const old: UpdateState = {
    source: state?.source ?? source, lastCheckAt: state?.lastCheckAt ?? null, previous: confirmed ? previous : state?.previous ?? null,
    available: state?.available ?? null, skip: state?.skip ?? [],
  };

  // Nothing is touched yet: a failure here (or in the install) leaves the installed version and the watcher alone.
  try {
    // Without an update.json no source was ever confirmed: update.json is not created until the new version is in.
    if (state !== null) await write(d.stateDir, old);
    step("installing");
    await installRelease(source, target, d);
  } catch (e) {
    return done("failed", message(e)); // npm leaves the previous install in place; the watcher was not touched
  }

  const since = d.clock.now();
  step("restarting");
  const { expected, problem } = await restart(d, true);
  if (expected) step("checking");
  const ok = !expected || (await healthy(d, target, since, d.clock.now()));
  if (ok || problem !== null) {
    // A newer release clears every rolled-back version up to it.
    await bestEffort({ ...old, source, previous, available: null, skip: old.skip.filter((v) => compareSemver(v, target) > 0) });
    // Not healthy because the restart did not happen: nothing says the release is bad, so it is neither rolled back nor
    // skipped; the reason is kept with the outcome.
    return ok ? done("installed") : done("installed", `${problem}; ${release(target)} is installed and starts with the next watcher`);
  }

  const why = `no healthy heartbeat from ${release(target)} within ${Math.round((d.healthMs ?? HEALTH_MS) / 1000)} s`;
  step("rolling-back");
  try {
    const p = parseReleaseSpec(previous.spec);
    if (p === null) throw new UpdateError(`cannot read ${JSON.stringify(previous.spec)}`);
    await installRelease(p.source, p.version, d);
  } catch (e) {
    // The reinstall failed: the watcher is left as it is (the new version, unhealthy, or none). Its own restart on a
    // newer install, the keep-alive trigger or launchd brings one back; status reports the failed update.
    return done("failed", `${why}; reinstalling ${previous.version} failed: ${message(e)}`);
  }
  // The previous version is not health-checked again: it is the one that ran before this update.
  await restart(d, false);
  // Keep the bad version out of later checks. Without an update.json, only under the caller's default source: an
  // unconfirmed --from is never remembered, not even as the way to reinstall the previous version (previous: null);
  // without a default the skip cannot be kept.
  const skip = [...new Set([...old.skip, release(target)])];
  if (state !== null) await bestEffort({ ...old, skip });
  else if (d.defaultSource !== undefined) await bestEffort({ ...old, source: d.defaultSource, previous: null, skip });
  return done("rolled-back", `${why}; reinstalled ${previous.version}`);
}

/**
 * Stop, then start. A stop or start that throws, or a watcher that is still running after the stop, is not fatal: the
 * start still runs and the health check still waits; `problem` names what kept the restart from happening (then a
 * missing heartbeat is no evidence against the new version).
 */
async function restart(d: UpdaterDeps, reinstallSchedule: boolean): Promise<{ expected: boolean; problem: string | null }> {
  let problem: string | null = null;
  const s = await d.watcher.stop().catch((e: unknown): StopResult => {
    problem = `the running watcher could not be stopped (${message(e)})`;
    return { how: "none", pid: null, running: true };
  });
  if (s.running && problem === null) problem = `the running watcher${s.pid !== null ? ` (pid ${s.pid})` : ""} did not stop`;
  const wasRunning = s.how !== "none" || s.running || !reinstallSchedule;
  const expected = await d.watcher.restart({ wasRunning, reinstallSchedule }).catch((e: unknown) => {
    problem ??= `the watcher could not be started again (${message(e)})`;
    return true;
  });
  return { expected, problem };
}

/**
 * Polls the heartbeat until one of `target` that started after `since` (minus clock slack) and has not stopped shows
 * up, or HEALTH_MS passes after `start` (when the restart returned: a slow scheduler call does not eat the wait).
 */
async function healthy(d: UpdaterDeps, target: string, since: number, start: number): Promise<boolean> {
  const read = d.readHeartbeat ?? realReadHeartbeat;
  const want = release(target);
  const end = start + (d.healthMs ?? HEALTH_MS);
  for (;;) {
    const hb = await read(d.stateDir).catch(() => null);
    const started = hb ? Date.parse(hb.startedAt) : Number.NaN;
    if (hb && typeof hb.version === "string" && parseSemver(hb.version) !== null && release(hb.version) === want && !hb.stoppedAt
      && Number.isFinite(started) && started >= since - START_SLACK_MS) return true;
    if (d.clock.now() >= end) return false;
    await new Promise<void>((ok) => { d.clock.setTimer(ok, d.pollMs ?? POLL_MS); });
  }
}
