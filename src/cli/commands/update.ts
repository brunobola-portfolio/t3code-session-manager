// t3sm update: look for a newer t3sm and install it with the update engine (src/ops/updater.ts: lock, journal, stop and
// restart the watcher, 120 s health check, rollback). Modes:
//   --check           read-only: installed, latest and its kind, source, automatic updates, last check, an interrupted
//                     update (with how to go back). No lock, nothing written. Offline: says so, exit 0.
//   --auto on|off     config.json `update.auto`, under the lock.
//   --auto-run --yes  the background watcher's child (src/ops/autoUpdate.ts): a patch or minor only, never a major.
//   (none)            what is new (a folder: the target tag's CHANGELOG.md; GitHub: after the install, from the installed
//                     one), then asks (a terminal) or needs --yes (exit 2 otherwise), then installs with a progress line
//                     per step. --dry-run stops before installing. --from <folder> / --source github choose the source;
//                     it is remembered only once the new version is in (the engine's rule).
// A git checkout or npx's cache only gets instructions; nothing is installed.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "../../core/paths.ts";
import { DEFAULT_SCHEDULE_MINUTES, loadConfig, saveConfig, updateAuto } from "../../core/config.ts";
import { Journal } from "../../core/journal.ts";
import { acquireLock } from "../../core/lock.ts";
import type { CommandRunner } from "../../core/run.ts";
import { compareSemver, parseSemver } from "../../core/semver.ts";
import type { UpdateSource } from "../../core/types.ts";
import { renderSections, sectionsBetween } from "../../core/changelog.ts";
import { defaultUpdateSource, installKind, isRegistryInstall, ownPackageName, ownRepositoryUrl, updateRunner } from "../../ops/update.ts";
import {
  QUERY_TIMEOUT_MS, classify, newestRelease, parseReleaseSpec, readPendingUpdate, readUpdateState, releaseVersions, runUpdate, sourceProblem, watcherOps,
  type PendingUpdate, type TempDirs, type UpdateOutcome, type UpdateStep, type UpdaterDeps, type WatcherOps,
} from "../../ops/updater.ts";
import { UPDATE_CHECK_RETRY_MS, autoTarget, requestUpdateRetry } from "../../ops/autoUpdate.ts";
import { notifyOnce, systemNotifier, updateNotice, UPDATE_FAILED_REASON, type Notifier } from "../../ops/notify.ts";
import { recordUpdateOutcome } from "../../ops/syncStatus.ts";
import { appendSyncLog } from "../../ops/sync.ts";
import { defaultBinPath } from "../../ops/schedule.ts";
import { stopWatcher } from "../../ops/watcherControl.ts";
import { realClock, type Clock, type Heartbeat } from "../../ops/watch.ts";
import { defaultRunner } from "../../t3/auth.ts";
import { reportLockBusy } from "../locked.ts";
import { parseFlags } from "./quarantine.ts";
import { cliT, cliUi, confirm, langOf, usageLine, type CliKey, type CliUi } from "../ui.ts";
import type { Lang } from "../../assistant/i18n.ts";
import { flagsOf } from "../flags.ts";
import { callout, kv, panel } from "../../ui/components.ts";
import { fitLine, noteLines, snugWidth, textLines } from "../screen.ts";
import { renderMarkdown } from "./help.ts";
import { shownText } from "../../plan/names.ts";
import { realIsElevated, warnIfElevated } from "../../ops/elevated.ts";
import type { Io } from "../main.ts";
import { systemRoot } from "../../core/sysroot.ts";

export interface UpdateDeps {
  /** Package root: the folder holding bin/ and package.json (default: this install). */
  root?: string;
  home?: string;
  platform?: NodeJS.Platform;
  /** The installed version, read fresh from package.json on each call. */
  readVersion?: () => string;
  /** git and npm (default updateRunner: no prompts, time limits, no CLAUDE_CONFIG_DIR). */
  run?: CommandRunner;
  /** Stopping and starting the background watcher (default watcherOps: stop by its own control, never by name). */
  watcher?: WatcherOps;
  clock?: Clock;
  readHeartbeat?: (stateDir: string) => Promise<Heartbeat | null>;
  /** package.json's repository URL (default: this install's): the GitHub source when nothing else is known. */
  repositoryUrl?: string;
  /** package.json's name (default: this install's): the npm package a registry install updates from. */
  packageName?: string;
  /** Whether this install is the package published to npm (default: `channel` in `root`/dist/build.json). */
  fromRegistry?: boolean;
  /** The installed CHANGELOG.md, read after an update from GitHub (default: <root>/CHANGELOG.md). */
  readChangelog?: () => string | null;
  /** --auto-run: the OS notifier for a failed update (default: the real one, only when `home` is the real one). */
  notifier?: Notifier;
  /** Whether this shell runs as Administrator (default: `net session` on Windows, only for the real home). */
  elevated?: () => Promise<boolean>;
  tmp?: TempDirs;
}

/** Errors runUpdate returns before journaling anything: nothing was attempted, nothing to report in status. */
const NOT_ATTEMPTED = new Set(["busy", "not-newer", "invalid-version", "no-source"]);

const describe = (s: UpdateSource, lang: Lang = "en"): string =>
  s.kind === "npm" ? `npm ${s.name}` : s.kind === "github" ? `GitHub ${s.repo}` : cliT(lang, "update.folder", { path: s.path });

interface Ctx {
  io: Io; dir: string; home: string; root: string; platform: NodeJS.Platform; run: CommandRunner; clock: Clock;
  readVersion: () => string; defaultSource: UpdateSource | null; repoUrl: string; packageName: string; deps: UpdateDeps;
}

export async function updateCommand(args: string[], io: Io, deps: UpdateDeps = {}): Promise<number> {
  const spec = flagsOf("update");
  const p = parseFlags(args, io, "update", spec.bool, spec.valued);
  if (!p) return 2;
  const has = (f: string): boolean => p.flags.has(f);
  const from = p.values.get("--from");
  const source = p.values.get("--source");
  const auto = p.values.get("--auto");
  const bad = (m: string): number => { io.stderr(`${m} Run \`t3sm update --help\`.\n`); return 2; };
  if (source !== undefined && source !== "github" && source !== "npm") return bad(`--source takes npm or github (a checkout on this computer: --from <folder>), not ${JSON.stringify(source)}.`);
  if (auto !== undefined && auto !== "on" && auto !== "off") return bad(`--auto takes on or off, not ${JSON.stringify(auto)}.`);
  if (from !== undefined && source !== undefined) return bad("Use either --from or --source.");
  const chooses = from !== undefined || source !== undefined;
  if (has("--check") && (chooses || auto !== undefined || has("--auto-run") || has("--yes") || has("--dry-run"))) return bad("--check only looks: it takes no other option.");
  if (auto !== undefined && (chooses || has("--auto-run"))) return bad("--auto on|off takes no other option than --dry-run (or --yes, which it does not need).");
  if (has("--auto-run") && (chooses || has("--dry-run"))) return bad("--auto-run takes no other option than --yes.");

  const root = deps.root ?? fileURLToPath(new URL("../../..", import.meta.url)).replace(/[\\/]+$/, "");
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;
  const repoUrl = deps.repositoryUrl ?? ownRepositoryUrl();
  const packageName = deps.packageName ?? ownPackageName();
  const fromRegistry = deps.fromRegistry ?? isRegistryInstall(root);
  const c: Ctx = {
    io, dir: stateDir(io.env, home), home, root, platform, deps, repoUrl, packageName,
    run: deps.run ?? updateRunner(platform, io.env),
    clock: deps.clock ?? realClock,
    readVersion: deps.readVersion ?? (() => (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version),
    defaultSource: defaultUpdateSource(repoUrl, { name: packageName, installed: fromRegistry }),
  };
  // The watcher's own child never warns: nobody reads its output.
  if (!has("--auto-run")) await warnIfElevated(io, deps.elevated ?? (deps.home === undefined ? realIsElevated : async () => false), "update");
  if (auto !== undefined) return setAuto(c, auto === "on", has("--dry-run"));
  if (has("--check")) return check(c);
  if (has("--auto-run")) {
    if (!has("--yes")) { usageLine(io, "usage.autoRunYes"); return 2; }
    return autoRun(c);
  }
  return manual(c, from !== undefined ? { kind: "folder", path: from } : source === "github" || source === "npm" ? source : null, has("--yes"), has("--dry-run"));
}

// ---------- --auto on|off ----------

async function setAuto(c: Ctx, on: boolean, dryRun: boolean): Promise<number> {
  const ui = cliUi(c.io);
  if (dryRun) { c.io.stdout(`${ui.t(on ? "update.auto.wouldOn" : "update.auto.wouldOff")}\n`); return 0; }
  // A preference toggle, like `projects unset`: the value itself is the confirmation, so no --yes is needed (and it is
  // accepted). It changes an existing config.json only: t3sm start writes the first one, with the accounts.
  const lock = await acquireLock(c.dir);
  if (!lock) { reportLockBusy(c.io); return 0; }
  try {
    const config = await loadConfig(c.dir, c.home);
    if (config === null) {
      c.io.stderr(`${ui.t("update.auto.noConfig")}\n`);
      return 1;
    }
    await saveConfig(c.dir, { ...config, update: { ...config.update, auto: on } }, c.home);
  } finally {
    await lock.release();
  }
  c.io.stdout(noteLines(ui.s, "ok", ui.t(on ? "update.auto.on" : "update.auto.off"), ui.width).join("\n") + "\n");
  return 0;
}

// ---------- --check ----------

function kindWords(ui: CliUi, installed: string, latest: string): string {
  const k = classify(installed, latest);
  if (k === "major") return ui.t("update.kind.major");
  if (k !== "none") return ui.t(k === "patch" ? "update.kind.patch" : "update.kind.minor");
  return parseSemver(installed) !== null && compareSemver(latest, installed) < 0 ? ui.t("update.kind.newer", { installed }) : ui.t("update.kind.none");
}

/** How to put `previous` back by hand (an interrupted update). */
function goBackHint(ui: CliUi, p: PendingUpdate): string | null {
  const r = parseReleaseSpec(p.previous.spec);
  if (r === null) return null;
  if (r.source.kind === "npm") return ui.t("update.goBackGithub", { version: r.version, command: `npm install -g ${r.source.name}@${r.version}` });
  if (r.source.kind === "github") return ui.t("update.goBackGithub", { version: r.version, command: `npm install -g --install-links github:${r.source.repo}#v${r.version}` });
  return ui.t("update.goBackFolder", { version: r.version, path: r.source.path });
}

/** What `t3sm update --check` found (read-only), for the screen. */
export interface UpdateCheckView {
  installed: string; kind: "checkout" | "npx" | "global"; root: string; latest: string | null; skipped: boolean; auto: string | null;
  source: UpdateSource | null; automatic: boolean | undefined; lastCheckAt: string | null;
  lastUpdate: { from: string; to: string; outcome: string; error?: string | undefined } | null; pending: PendingUpdate | null;
}

const OUTCOME_WORDS: Record<string, CliKey> = {
  installed: "update.outcome.installed", "rolled-back": "update.outcome.rolledBack", failed: "update.outcome.failed", interrupted: "update.outcome.interrupted",
};

/** The check as aligned rows, then an interrupted update (with how to go back) and how to install a newer release. */
export function renderUpdateCheck(ui: CliUi, v: UpdateCheckView, width: number = ui.width): string[] {
  const { s, t } = ui;
  const how = v.kind === "checkout" ? t("update.how.checkout", { path: v.root }) : v.kind === "npx" ? t("update.how.npx") : t("update.how.global");
  const rows: [string, string][] = [[t("update.label.installed"), `${v.installed} (${how})`]];
  if (v.latest === null) rows.push([t("update.label.latest"), t("update.latest.unknown")]);
  else {
    rows.push([t("update.label.latest"), `${v.latest} (${kindWords(ui, v.installed, v.latest)}${v.skipped ? t("update.latest.skipped") : ""})`]);
    if (v.auto !== null && v.auto !== v.latest) rows.push([t("update.label.auto"), t("update.auto.target", { version: v.auto, major: parseSemver(v.installed)?.[0] ?? 0 })]);
  }
  rows.push([t("update.label.source"), v.source === null ? t("update.source.unknown") : describe(v.source, ui.lang)]);
  rows.push([t("update.label.automatic"), v.kind === "checkout" ? t("update.automatic.checkout") : v.kind === "npx" ? t("update.automatic.npx")
    : v.automatic === undefined ? t("update.automatic.unknown") : v.automatic ? t("update.automatic.on") : t("update.automatic.off")]);
  rows.push([t("update.label.lastCheck"), v.lastCheckAt === null ? t("status.never") : `${ui.f.date(v.lastCheckAt)} (${ui.f.ago(v.lastCheckAt)})`]);
  if (v.lastUpdate) {
    const u = v.lastUpdate;
    const outcome = OUTCOME_WORDS[u.outcome] ? t(OUTCOME_WORDS[u.outcome]!) : shownText(u.outcome, 40);
    rows.push([t("update.label.lastUpdate"), `${u.from} -> ${u.to}, ${outcome}${u.error ? ` (${shownText(u.error, 200)})` : ""}`]);
  }
  const out = kv(s, rows, width);
  if (v.pending !== null) {
    const hint = goBackHint(ui, v.pending);
    out.push("", ...callout(s, {
      kind: "warn", title: t(v.pending.interrupted ? "update.pending.interrupted" : "update.pending.running", { target: v.pending.target, at: ui.f.date(v.pending.startedAt) }),
      body: hint ? textLines(s, hint, Math.max(1, width - 2)) : [],
    }, width));
  }
  if (v.latest !== null && classify(v.installed, v.latest) !== "none" && v.kind === "global") out.push("", ...noteLines(s, "info", t("update.toInstall"), width));
  return out;
}

async function check(c: Ctx): Promise<number> {
  const kind = installKind(c.root);
  const installed = c.readVersion();
  const state = await readUpdateState(c.dir);
  const source = state?.source ?? c.defaultSource;
  const config = await loadConfig(c.dir, c.home).catch(() => undefined);
  const versions = source === null ? null : await releaseVersions(source, c.run, c.platform);
  const latest = versions === null ? null : newestRelease(versions);
  const lastUpdate = (await new Journal(join(c.dir, "journal.jsonl")).readAll().catch(() => []))
    .filter((e) => e.t === "update" && e.outcome !== "pending").at(-1);
  const view: UpdateCheckView = {
    installed, kind, root: c.root, latest, skipped: latest !== null && (state?.skip ?? []).includes(latest),
    auto: versions === null ? null : autoTarget(installed, versions, state?.skip ?? []),
    source, automatic: config === undefined ? undefined : updateAuto(config), lastCheckAt: state?.lastCheckAt ?? null,
    lastUpdate: lastUpdate && lastUpdate.t === "update" ? { from: lastUpdate.from, to: lastUpdate.to, outcome: lastUpdate.outcome, error: lastUpdate.error } : null,
    pending: await readPendingUpdate(c.dir),
  };
  c.io.stdout(renderUpdateCheck(cliUi(c.io, { now: () => c.clock.now() }), view).join("\n") + "\n");
  return 0;
}

// ---------- the engine ----------

/**
 * What runUpdate needs. The watcher is stopped by its own control (never by name) and started again through the
 * scheduler entry, re-registered with config.json's interval (src/ops/updater.ts watcherOps).
 */
async function engine(c: Ctx, installed: string, source: UpdateSource | undefined, o: { onStep?: (s: UpdateStep) => void } = {}): Promise<UpdaterDeps> {
  let watcher = c.deps.watcher;
  if (!watcher) {
    const every = (await loadConfig(c.dir, c.home).catch(() => null))?.schedule.everyMinutes ?? DEFAULT_SCHEDULE_MINUTES;
    watcher = watcherOps({
      platform: c.platform, run: c.run, stateDir: c.dir, nodePath: process.execPath, binPath: defaultBinPath(), home: c.home,
      everyMinutes: every, systemRoot: systemRoot(c.io.env),
      // A restart follows every stop here: the stopped heartbeat says so (restart-lost if no successor comes).
      stop: () => stopWatcher({ stateDir: c.dir, platform: c.platform, kill: (pid) => process.kill(pid), clock: realClock, intent: "restart" }),
    });
  }
  return {
    stateDir: c.dir, installed, readInstalled: c.readVersion, run: c.run, platform: c.platform, clock: c.clock, watcher,
    ...(source !== undefined ? { source } : {}),
    ...(c.defaultSource !== null ? { defaultSource: c.defaultSource } : {}),
    ...(c.deps.readHeartbeat ? { readHeartbeat: c.deps.readHeartbeat } : {}),
    ...(c.deps.tmp ? { tmp: c.deps.tmp } : {}),
    ...(o.onStep ? { onStep: o.onStep } : {}),
  };
}

/** What status shows about the update (a failure needs attention until an update installs). Never throws. */
async function record(c: Ctx, r: UpdateOutcome): Promise<boolean> {
  if (r.outcome !== "installed" && NOT_ATTEMPTED.has(r.error ?? "")) return false;
  await recordUpdateOutcome(c.dir, { outcome: r.outcome, from: r.from, to: r.to }, new Date(c.clock.now())).catch(() => { /* status only */ });
  return true;
}

// ---------- --auto-run (the watcher's child) ----------

async function autoRun(c: Ctx): Promise<number> {
  if (installKind(c.root) !== "global") return 0; // a checkout or npx: never updated by itself
  const config = await loadConfig(c.dir, c.home).catch(() => undefined);
  if (config === undefined || !updateAuto(config)) return 0; // turned off since the watcher looked
  const installed = c.readVersion();
  const state = await readUpdateState(c.dir);
  const source = state?.source ?? c.defaultSource;
  if (source === null) return 0;
  const versions = await releaseVersions(source, c.run, c.platform);
  const target = versions === null ? null : autoTarget(installed, versions, state?.skip ?? []);
  if (target === null) return 0; // nothing newer within this major: a major is never installed by itself
  const r = await runUpdate(target, await engine(c, installed, state === null ? source : undefined));
  if (r.error === "busy") {
    // Another t3sm run holds the lock: the watcher's next check comes within the hour instead of tomorrow.
    await appendSyncLog(c.dir, `${new Date(c.clock.now()).toISOString()} update busy to=${target}`).catch(() => {});
    await requestUpdateRetry(c.dir, new Date(c.clock.now() + UPDATE_CHECK_RETRY_MS));
    return 0;
  }
  const attempted = await record(c, r);
  if (attempted) await appendSyncLog(c.dir, `${new Date(c.clock.now()).toISOString()} update ${r.outcome} from=${r.from} to=${r.to}`).catch(() => {});
  if (attempted && r.outcome !== "installed") {
    const notifier = c.deps.notifier ?? (c.deps.home === undefined ? systemNotifier(process.platform, defaultRunner) : undefined);
    if (notifier) {
      // Started by the watcher: the language comes from the env and config.json, as the cycle resolves it.
      const n = updateNotice(r.outcome === "rolled-back" ? "rolled-back" : "failed", { from: r.from, to: r.to }, langOf(c.io, config?.language ?? null));
      await notifyOnce({
        stateDir: c.dir, mode: config?.notify ?? "attention", notifier, now: c.clock.now(), key: `${UPDATE_FAILED_REASON}:${r.to}`, title: n.title, body: n.body,
      });
    }
  }
  return r.outcome === "installed" || r.error === "busy" ? 0 : 1;
}

// ---------- update (manual) ----------

const STEP: Record<UpdateStep, CliKey> = {
  installing: "update.step.installing", restarting: "update.step.restarting", checking: "update.step.checking", "rolling-back": "update.step.rollingBack",
};

/** Release notes (English, from a CHANGELOG.md) drawn like a help topic: headings, bullets, wrapped. */
export function renderNotes(ui: CliUi, sections: ReturnType<typeof sectionsBetween>, width: number = ui.width): string[] {
  return renderMarkdown(ui, renderSections(sections), width);
}

async function manual(c: Ctx, choice: UpdateSource | "github" | "npm" | null, yes: boolean, dryRun: boolean): Promise<number> {
  const { io } = c;
  const ui = cliUi(io);
  const { s, t } = ui;
  const say = (l: string[]): void => io.stdout(l.join("\n") + "\n");
  const note = (tone: "ok" | "warn" | "err" | "info", text: string): string[] => noteLines(s, tone, text, ui.width);
  const cmd = (line: string): string[] => fitLine("    " + s("key", line), ui.width, 6);
  const kind = installKind(c.root);
  const installed = c.readVersion();
  if (kind === "checkout") {
    say([...note("info", t("update.checkout", { version: installed, path: c.root })), ...cmd(`git -C "${c.root}" pull`)]);
    return 0;
  }
  if (kind === "npx") {
    say([...note("info", t("update.npx", { version: installed })), ...cmd(`npm install -g ${c.packageName || "t3code-session-manager"}`), ...textLines(s, t("update.npxThen"), ui.width, 2)]);
    return 0;
  }
  if (choice !== null && choice !== "github" && choice !== "npm") {
    const why = sourceProblem(choice, c.platform);
    if (why !== null) { io.stderr(`${why}\n`); return 2; }
  }
  if (!yes && !dryRun && !io.isTTY) {
    io.stderr(`${t("update.needsYes")}\n`);
    return 2;
  }
  const state = await readUpdateState(c.dir);
  const source = choice === "github" ? defaultUpdateSource(c.repoUrl)
    : choice === "npm" ? (c.packageName !== "" ? { kind: "npm" as const, name: c.packageName } : null)
    : choice ?? state?.source ?? c.defaultSource;
  if (source === null) {
    io.stderr(`${t("update.noSource")}\n`);
    return 1;
  }
  const versions = await releaseVersions(source, c.run, c.platform);
  if (versions === null) {
    io.stderr(`${t("update.lookupFailed", { source: describe(source, ui.lang), version: installed })}\n`);
    return 1;
  }
  const latest = newestRelease(versions);
  if (latest === null || classify(installed, latest) === "none") {
    const older = latest !== null && parseSemver(installed) !== null && compareSemver(latest, installed) < 0;
    say(note("ok", older ? t("update.newestOlder", { version: installed, source: describe(source, ui.lang), latest: latest! }) : t("update.newest", { version: installed })));
    return 0;
  }
  const level = classify(installed, latest);
  const levelWord = t(level === "major" ? "update.level.major" : level === "minor" ? "update.level.minor" : "update.level.patch");
  const head = `t3sm ${installed} -> ${latest} (${levelWord})`;
  const body = [t("update.from", { source: describe(source, ui.lang) }), ...(level === "major" ? [t("update.majorNote")] : [])];
  say(panel(s, { title: head, body, tone: level === "major" ? "warn" : "plain" }, snugWidth(head, body, ui.width)));
  if (source.kind === "folder") {
    const r = await c.run("git", ["-C", source.path, "show", `v${latest}:CHANGELOG.md`], { timeoutMs: QUERY_TIMEOUT_MS }).catch(() => null);
    const sections = r !== null && r.code === 0 ? sectionsBetween(r.stdout, installed, latest) : [];
    say(sections.length > 0 ? ["", ...fitLine(s("title", t("update.whatsNew")), ui.width), "", ...renderNotes(ui, sections)] : note("warn", t("update.noNotes", { version: latest })));
  } else {
    say(note("info", t("update.notesLater")));
  }
  if (dryRun) { say(["", ...note("ok", t("update.dryRun", { version: latest, source: describe(source, ui.lang) }))]); return 0; }
  if (!yes) {
    io.stdout("\n");
    if (!(await confirm(io, t("update.confirm", { version: latest })))) { io.stdout(`${t("common.nothingChanged")}\n`); return 0; }
  }

  const r = await runUpdate(latest, await engine(c, installed, source, { onStep: (st) => say(note("info", t(STEP[st], { to: latest, from: installed }))) }));
  await record(c, r);
  if (r.outcome === "installed") {
    say(note("ok", t("update.updated", { from: installed, to: latest })));
    // Installed, but the watcher could not be restarted into it (it did not stop, or the scheduler call failed).
    if (r.error !== undefined) say(note("warn", t("update.notRestarted", { error: shownText(r.error, 300) })));
    if (source.kind !== "folder") {
      const text = (c.deps.readChangelog ?? (() => { try { return readFileSync(join(c.root, "CHANGELOG.md"), "utf8"); } catch { return null; } }))();
      const sections = text === null ? [] : sectionsBetween(text, installed, latest);
      say(sections.length > 0 ? ["", ...fitLine(s("title", t("update.whatsNew")), ui.width), "", ...renderNotes(ui, sections)] : note("info", t("update.whatsNewLater", { version: installed })));
    }
    return 0;
  }
  if (r.error === "busy") { reportLockBusy(io); return 0; }
  if (r.error === "not-newer") { say(note("ok", t("update.notNewer", { version: r.from }))); return 0; }
  if (r.outcome === "rolled-back") {
    io.stderr(`${t("update.rolledBack", { to: latest, from: installed, error: shownText(r.error ?? t("update.noDetails"), 300) })}\n`);
    return 1;
  }
  io.stderr(`${t("update.failed", { to: latest, error: shownText(r.error ?? t("update.unknownError"), 300), from: installed })}\n`);
  return 1;
}
