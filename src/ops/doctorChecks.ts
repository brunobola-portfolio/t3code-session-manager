// Checks of runDoctor (src/ops/doctor.ts) that only word what it read: each takes the values and returns the check.

import type { AccountConfig, Config } from "../core/types.ts";
import { expandHome, normalizeCwd, sameCwd } from "../core/paths.ts";
import { maskEmail } from "../core/mask.ts";
import type { CliKey } from "../i18n/cli.ts";
import { shownAccountName, shownText } from "../plan/names.ts";
import type { ProviderInstanceInfo } from "../t3/api.ts";
import { PLUGIN_ID, type PluginState } from "./plugin.ts";
import type { WatcherHealth } from "./watcherHealth.ts";
import { ok, part, said, skip, type Check, type CheckData, type SayPart } from "./doctorCheck.ts";

/** `instances`: one T3 Code instance per Claude home, and one for every configured account. */
export function instancesCheck(list: ProviderInstanceInfo[], expanded: AccountConfig[], platform: NodeJS.Platform, t: (p: string) => string): Check {
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
}

/** `instance-accounts`: each Claude instance's account (signed in, available, not shared with another instance). */
export function instanceAccountsCheck(list: ProviderInstanceInfo[], effective: Config): Check {
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
}

/** `t3sm-plugin`: the /t3sm commands in each account's Claude Code. */
export async function pluginCheck(
  effective: Config, home: string, read: ((accountHome: string) => Promise<PluginState>) | undefined, version: string | undefined,
): Promise<Check> {
  if (!read || !version) return skip("t3sm-plugin", part("doctor.say.plugin.unchecked"));
  const states = await Promise.all(effective.accounts.map(async (a) => ({ id: shownAccountName(a.displayName || a.id), state: await read(expandHome(a.home, home)) })));
  if (states.length === 0) return skip("t3sm-plugin", part("doctor.say.plugin.noAccounts"));
  const stateWords = (s: PluginState): SayPart => s.state === "installed" ? part("status.plugin.installed", { version: s.version })
    : s.state === "outdated" ? part("status.plugin.outdated", { version: s.version, expected: version, id: PLUGIN_ID }) : part("status.plugin.missing");
  const line = states.map((x, n) => part("doctor.say.plugin.account", { id: x.id, state: [stateWords(x.state)] }, n > 0 ? "; " : undefined));
  if (states.some((x) => x.state.state === "outdated")) return said("t3sm-plugin", "warn", line, [part("doctor.fix.plugin", { id: PLUGIN_ID })]);
  const missing = states.some((x) => x.state.state === "missing");
  return said("t3sm-plugin", "ok", missing ? [...line, part("doctor.say.plugin.optional")] : line);
}

/** `schedule`: the scheduled sync, and the paths its command names that are gone. */
export function scheduleCheck(
  s: { kind: string; installed: boolean; nextRun: string | null; detail: string | null; missing?: string[] }, t: (p: string) => string,
): Check {
  if (!s.installed) return ok("schedule", part("doctor.say.schedule.none"));
  if (s.missing && s.missing.length > 0) {
    return said("schedule", "warn", [part("doctor.say.schedule.missing", { kind: s.kind, paths: s.missing.map(t).join(", "), n: s.missing.length })], [part("doctor.fix.schedule")]);
  }
  return said("schedule", "ok", [
    part("doctor.say.schedule.ok", { kind: s.kind }),
    ...(s.nextRun ? [part("doctor.say.schedule.next", { next: s.nextRun })] : []),
    ...(s.detail && s.kind !== "cron" ? [part("doctor.say.schedule.detail", { detail: s.detail })] : []),
  ]);
}

/** `sync-watcher`: the watcher's state, classified as `t3sm status` does (watcherHealth). */
export function watcherCheck(h: WatcherHealth, now: number, reachable: boolean): Check {
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
}

/** `merge-pending`: sessions continued in a terminal, as last counted by sync or merge. */
export function mergePendingCheck(p: { count: number; orphaned: number; at: string } | null): Check {
  if (p === null) return ok("merge-pending", part("doctor.say.merge.uncounted"));
  const data: CheckData = { continued: p.count, sideBranch: p.orphaned, at: p.at };
  if (p.count === 0 && p.orphaned === 0) return said("merge-pending", "ok", [part("doctor.say.merge.none", { at: p.at })], undefined, data);
  const parts: SayPart[] = [
    ...(p.count > 0 ? [part("doctor.say.merge.continued", { n: p.count })] : []),
    ...(p.orphaned > 0 ? [part("doctor.say.merge.sideBranch", { n: p.orphaned }, p.count > 0 ? "; " : undefined)] : []),
    part("doctor.say.merge.asOf", { at: p.at }),
  ];
  return said("merge-pending", "warn", parts, [part(p.count > 0 ? "doctor.fix.merge.continued" : "doctor.fix.merge.sideBranch")], data);
}
