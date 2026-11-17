// `t3sm doctor`: the first command a new user runs. Read-only: it writes nothing except, with --repair, the restore of
// pending transcript file times (under the state-dir lock). It opens at most one T3 session (read-only scopes) and
// revokes it before returning. Every check is isolated and bounded by a timeout (its own, or the default 10 s): a throw
// or a timeout is `fail` only for the checks that block t3sm (CRITICAL_CHECKS); for every other check it is a `warn`, so
// a slow, large home never reads as a problem to fix.
//
// Next to it: doctorCheck.ts (a check and its wording), doctorChecks.ts (checks that only word what was read) and
// doctorDeps.ts (what doctor reads through, and defaultDoctorDeps).

import { join } from "node:path";
import { hostname, uptime } from "node:os";
import type { AccountConfig, Config, HarnessId, JournalEntry } from "../core/types.ts";
import { ConfigError, defaultConfig } from "../core/config.ts";
import { expandHome, sameCwd, tildePath } from "../core/paths.ts";
import { ACTIVE_WINDOW_MS } from "../core/activity.ts";
import { pendingMtimePaths } from "../core/journal.ts";
import { rebootedSince } from "../core/lock.ts";
import type { ServerRuntime } from "../t3/runtime.ts";
import type { ProviderInstanceInfo, T3Api } from "../t3/api.ts";
import { checkCompat, TESTED_VERSIONS } from "../t3/compat.ts";
import { describeError, oneLine } from "./errorCodes.ts";
import { STOP_SIGNALS } from "../apply/applyTypes.ts";
import { futureLeftovers } from "../apply/exposure.ts";
import { formatSources } from "./discoverAccounts.ts";
import { QUARANTINE_DIR } from "./quarantine.ts";
import { watcherHealth } from "./watcherHealth.ts";
import { sessionForms, sessionIdsInT3 } from "../sources/registry.ts";
import type { FileTime } from "../sources/types.ts";
import { maskEmail } from "../core/mask.ts";
import { ok, part, said, scrub, skip, type Check, type CheckData, type SayPart } from "./doctorCheck.ts";
import { instanceAccountsCheck, instancesCheck, mergePendingCheck, pluginCheck, scheduleCheck, watcherCheck } from "./doctorChecks.ts";
import type { DoctorDeps, HarnessStatus, SignalSource } from "./doctorDeps.ts";

export { sayText, type Check, type CheckData, type CheckStatus, type SayPart } from "./doctorCheck.ts";
export { defaultDoctorDeps, type DoctorDeps, type DoctorOptions, type HarnessStatus, type SignalSource } from "./doctorDeps.ts";

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
      return instancesCheck(await claudeInstances(), expanded, platform, t);
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
      return instanceAccountsCheck(await claudeInstances(), effective);
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
  await run("t3sm-plugin", () => pluginCheck(effective, home, deps.pluginState, deps.packageVersion));

  // ---------- background sync ----------
  await run("schedule", async () => scheduleCheck(await deps.scheduleStatus(), t));

  await run("sync-watcher", async () => {
    const hb = await deps.readHeartbeat();
    const now = deps.now();
    // The same classification as `t3sm status` (src/ops/watcherHealth.ts): the two never disagree.
    const h = watcherHealth(hb, { now, pidAlive: deps.pidAlive, install: (r) => deps.installStamp?.(r) ?? null, everyMinutes: effective.schedule.everyMinutes });
    return watcherCheck(h, now, reachable);
  });

  await run("merge-pending", async () => mergePendingCheck(deps.mergePending ? await deps.mergePending() : null));

  return { checks: checks.map((c) => scrub(c, home)) };
}
