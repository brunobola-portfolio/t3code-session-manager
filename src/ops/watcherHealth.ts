// What state the background watcher is in, from its heartbeat alone (pure: no file, no process, no T3 Code). `doctor`
// (the sync-watcher check) and `status` both classify through this one function, so they never disagree.
//
//   none            no heartbeat: no watcher ever ran (sync runs on the schedule or by hand)
//   stopped         stopped cleanly (a stop request, `schedule remove`)
//   restart-lost    stopped to restart into a newer install, and no successor wrote a heartbeat within RESTART_LOST_MS
//   gone            its pid is gone without a clean stop
//   no-version      running, but from a t3sm that does not record its version (0.2.1): it never restarts after an upgrade
//   no-stamp        running, recorded its version but could not read its install stamp: it does not restart either
//   stale-version   running on another version (or another build) than the install holds, and it had a cycle after
//                   the install settled (INSTALL_SETTLE_MS) without restarting into it
//   running         running on what the install holds (or a new install it has not had a cycle to notice yet:
//                   `pendingVersion`); `fresh`: its cycles are on time (a late one is stale unless T3 Code is closed)

import { parseSemver } from "../core/semver.ts";
import { INSTALL_SETTLE_MS, type InstallStamp } from "../core/version.ts";
import type { Heartbeat } from "./watch.ts";

/**
 * How long a watcher that stopped to restart into a new install may stay without a successor. Longer than the scheduled
 * task's 15-minute keep-alive trigger, which starts a watcher when none holds the pipe.
 */
export const RESTART_LOST_MS = 20 * 60_000;
/** How late a cycle may be (past nextCycleAt, or two intervals after the last cycle) before the watcher counts as stale. */
export const CYCLE_SLACK_MS = 10 * 60_000;

export type WatcherHealth =
  | { state: "none" }
  | { state: "stopped"; pid: number; stoppedAt: string }
  | { state: "restart-lost"; pid: number; stoppedAt: string }
  | { state: "gone"; pid: number; lastCycleAt: string | null }
  | { state: "no-version"; pid: number }
  | { state: "no-stamp"; pid: number; version: string }
  | { state: "stale-version"; pid: number; version: string; installed: string; rebuilt: boolean }
  | { state: "running"; pid: number; version: string; fresh: boolean; pendingVersion: string | null; lastCycleAt: string | null; nextCycleAt: string | null };

export interface WatcherHealthInput {
  now: number;
  pidAlive(pid: number): boolean;
  /** What an install root holds now (null: this t3sm's own) and when it last changed; null when it cannot be read. */
  install(root: string | null): (InstallStamp & { changedAtMs: number | null }) | null;
  /** schedule.everyMinutes: the interval between cycles. */
  everyMinutes: number;
}

export function watcherHealth(hb: Heartbeat | null, o: WatcherHealthInput): WatcherHealth {
  if (hb === null) return { state: "none" };
  if (hb.stoppedAt) {
    const at = Date.parse(hb.stoppedAt);
    if (hb.reason === "restart" && Number.isFinite(at) && o.now - at > RESTART_LOST_MS) return { state: "restart-lost", pid: hb.pid, stoppedAt: hb.stoppedAt };
    return { state: "stopped", pid: hb.pid, stoppedAt: hb.stoppedAt };
  }
  if (!o.pidAlive(hb.pid)) return { state: "gone", pid: hb.pid, lastCycleAt: hb.lastCycleAt ?? null };
  // Stale version: the watcher checks the install after every cycle and restarts into a new one. One that had a cycle
  // since the install changed and still runs the old one will not (a 0.2.1 watcher, without a version, never does).
  // A version that is not a release version (a hand-edited or hostile file) is unknown: never shown, never compared.
  if (typeof hb.version !== "string" || parseSemver(hb.version) === null) return { state: "no-version", pid: hb.pid };
  if (typeof hb.stamp !== "string") return { state: "no-stamp", pid: hb.pid, version: hb.version };
  let pendingVersion: string | null = null;
  const read = o.install(typeof hb.installRoot === "string" ? hb.installRoot : null);
  const inst = read && parseSemver(read.version) !== null ? read : null; // an unreadable version: as an unreadable install
  if (inst && (inst.version !== hb.version || inst.stamp !== hb.stamp)) {
    const since = Date.parse(hb.lastCycleAt ?? hb.startedAt);
    // The watcher deliberately skips a restart while the install changed less than INSTALL_SETTLE_MS before its cycle ended.
    if (inst.changedAtMs === null || !Number.isFinite(since) || inst.changedAtMs + INSTALL_SETTLE_MS <= since) {
      return { state: "stale-version", pid: hb.pid, version: hb.version, installed: inst.version, rebuilt: inst.version === hb.version };
    }
    pendingVersion = inst.version;
  }
  const every = o.everyMinutes * 60_000;
  const next = hb.nextCycleAt ? Date.parse(hb.nextCycleAt) : NaN;
  const last = Date.parse(hb.lastCycleAt ?? hb.startedAt);
  const fresh = Number.isFinite(next) ? o.now <= next + CYCLE_SLACK_MS : Number.isFinite(last) && o.now - last <= 2 * every + CYCLE_SLACK_MS;
  return { state: "running", pid: hb.pid, version: hb.version, fresh, pendingVersion, lastCycleAt: hb.lastCycleAt ?? null, nextCycleAt: hb.nextCycleAt ?? null };
}
