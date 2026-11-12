// Account instances and per-project default subscription in T3 Code.
// Writing functions here REQUIRE the caller to hold the state-dir lock (acquireLock) and to have run
// recoverPendingMtimes first; they never take the lock themselves.

import type { InstanceSpec, JournalEntry } from "../core/types.ts";
import type { Journal } from "../core/journal.ts";
import { sameCwd } from "../core/paths.ts";
import type { T3Api } from "../t3/api.ts";
import { join } from "node:path";
import { ConfigError } from "../core/config.ts";

/** claudeAgent (T3's default Claude instance) reads a home other than ~/.claude (inherited CLAUDE_CONFIG_DIR). Exit 2. */
export class InstanceHomeDrift extends Error {
  override name = "InstanceHomeDrift";
  readonly actualHome: string;
  constructor(actualHome: string) {
    super(`T3 Code's default Claude instance reads ${actualHome} instead of ~/.claude. Close T3 Code and open it from the Start menu, then retry.`);
    this.actualHome = actualHome;
  }
}

/**
 * claudeAgent has an EXPLICIT settings entry (T3 Code settings, Providers) for a home other than ~/.claude: restarting
 * T3 Code does not change it, so the advice is to change the setting (or let `t3sm accounts --apply` re-pin it). Exit 2.
 */
export class InstanceHomeConfigured extends InstanceHomeDrift {
  override name = "InstanceHomeConfigured";
  constructor(configuredHome: string) {
    super(configuredHome);
    this.message = `T3 Code's default Claude instance is configured to read ${configuredHome}. t3sm expects it to read ~/.claude. Change it in T3 Code settings (Providers) or run \`t3sm accounts --apply\`.`;
  }
}

const isObj = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u);

/** The drift error for claudeAgent reading `effectiveHome`: configured (explicit settings entry) or inherited. */
export function driftError(settings: Record<string, unknown> | undefined, effectiveHome: string): InstanceHomeDrift {
  if (settings !== undefined && Object.hasOwn(settings, DEFAULT_ID)) return new InstanceHomeConfigured(entryHome(settings[DEFAULT_ID]) ?? effectiveHome);
  return new InstanceHomeDrift(effectiveHome);
}

/** config.homePath of a provider settings entry, or null. Journals never carry anything else from an entry. */
export function entryHome(entry: unknown): string | null {
  const c = isObj(entry) ? entry.config : undefined;
  return isObj(c) && typeof c.homePath === "string" ? c.homePath : null;
}

/** The delta journaled for instance-updated: displayName/accentColor/homePath only (never environment or other config keys). */
export function appearanceDelta(entry: unknown): { displayName: string | null; accentColor: string | null; homePath: string | null } {
  const e = isObj(entry) ? entry : {};
  return { displayName: typeof e.displayName === "string" ? e.displayName : null, accentColor: typeof e.accentColor === "string" ? e.accentColor : null, homePath: entryHome(entry) };
}

export interface InstancePlan {
  create: InstanceSpec[];
  /** Specs for claudeAgent that still need an explicit pin (not yet known to be pinned). */
  pin: InstanceSpec[];
  skipped: { id: string; reason: string }[];
}

export const DEFAULT_ID = "claudeAgent";

/** The home T3's default Claude instance must read: `<user home>/.claude`. */
export function defaultClaudeHome(home: string): string {
  return join(home, ".claude");
}

/**
 * T3's default Claude instance (claudeAgent) must read the config account whose home is ~/.claude, matched by HOME
 * (the account may have any id). Its effective home anywhere else (e.g. T3 started with CLAUDE_CONFIG_DIR set) ->
 * InstanceHomeDrift (InstanceHomeConfigured when `settings`, T3's providerInstances map, has an explicit entry for it).
 * Nothing to check without such an account, or while T3 reports no home for the instance.
 */
export function assertDefaultInstanceHome(
  providers: { instanceId: string; driver: string; homePath: string | null }[], accountHomes: string[], home: string, platform: NodeJS.Platform = process.platform,
  settings?: Record<string, unknown>,
): void {
  const want = defaultClaudeHome(home);
  const def = providers.find((p) => p.instanceId === DEFAULT_ID && p.driver === "claudeAgent");
  if (!accountHomes.some((h) => sameCwd(h, want, platform))) {
    // No ~/.claude account: the IMPLICIT default instance (inherited CLAUDE_CONFIG_DIR) must still never stand in for
    // another configured account, or that account's sessions would be imported twice (once per instance). Settings
    // unknown count as implicit; an explicit entry is the user's choice.
    const implicit = settings === undefined || !Object.hasOwn(settings, DEFAULT_ID);
    if (def && def.homePath !== null && implicit && accountHomes.some((h) => sameCwd(h, def.homePath!, platform))) throw new InstanceHomeDrift(def.homePath);
    return;
  }
  if (def && def.homePath !== null && !sameCwd(def.homePath, want, platform)) throw driftError(settings, def.homePath);
}

/**
 * Read-only: decides what ensureInstances would do. The spec for T3's default instance is the one whose home is
 * `defaultHome` (~/.claude; any id), or, without `defaultHome`, the spec with id claudeAgent. Throws InstanceHomeDrift
 * before anything is written when claudeAgent's effective home is not that spec's home (InstanceHomeConfigured when it
 * has an explicit settings entry), except that `repinExplicit` (`t3sm accounts --apply`) re-pins an explicit entry to
 * the spec's home instead. "pin" lists claudeAgent whenever it exists; the write path asks pinInstanceHome, which
 * reports changed:false when it is already pinned.
 */
export async function planInstances(api: T3Api, specs: InstanceSpec[], defaultHome?: string, opts: { repinExplicit?: boolean } = {}): Promise<InstancePlan> {
  const claude = (await api.providerInstances()).filter((i) => i.driver === "claudeAgent");
  const plan: InstancePlan = { create: [], pin: [], skipped: [] };
  const def = specs.find((s) => (defaultHome !== undefined ? sameCwd(s.homePath, defaultHome) : s.id === DEFAULT_ID));
  const defInst = claude.find((i) => i.instanceId === DEFAULT_ID);
  if (def && defInst && defInst.homePath !== null && !sameCwd(defInst.homePath, def.homePath)) {
    const settings = (await api.getConfig()).settings.providerInstances;
    const err = driftError(settings, defInst.homePath);
    if (!(err instanceof InstanceHomeConfigured && opts.repinExplicit)) throw err;
  }
  if (def && defInst) plan.pin.push({ ...def, id: DEFAULT_ID });
  const taken: { instanceId: string; homePath: string | null }[] = claude.map((i) => ({ instanceId: i.instanceId, homePath: i.homePath }));
  for (const s of specs) {
    if ((s === def && defInst) || s.id === DEFAULT_ID) continue; // served by claudeAgent: never a second instance for ~/.claude
    const byId = taken.find((i) => i.instanceId === s.id);
    const byHome = taken.find((i) => i.homePath !== null && sameCwd(i.homePath, s.homePath));
    if (byId && (byId.homePath === null || sameCwd(byId.homePath, s.homePath))) { plan.skipped.push({ id: s.id, reason: "already present" }); continue; }
    if (byId) { plan.skipped.push({ id: s.id, reason: `instance id already used with another home (${byId.homePath})` }); continue; }
    if (byHome) { plan.skipped.push({ id: s.id, reason: `home already served by instance ${byHome.instanceId}` }); continue; }
    plan.create.push(s);
    taken.push({ instanceId: s.id, homePath: s.homePath });
  }
  return plan;
}

export async function ensureInstances(
  api: T3Api, specs: InstanceSpec[], j: Journal, runId: string, defaultHome?: string, opts: { repinExplicit?: boolean } = {},
): Promise<{ created: string[]; pinned: string[]; skipped: { id: string; reason: string }[] }> {
  const plan = await planInstances(api, specs, defaultHome, opts); // may throw InstanceHomeDrift: nothing written yet
  const out = { created: [] as string[], pinned: [] as string[], skipped: plan.skipped };
  for (const s of plan.pin) {
    const r = await api.pinInstanceHome(s.id, s.homePath);
    if (!r.changed) continue;
    out.pinned.push(s.id);
    await j.append({ t: "instance-pinned", runId, instanceId: s.id, previous: { homePath: entryHome(r.previous) }, next: { homePath: s.homePath } } satisfies JournalEntry);
  }
  for (const s of plan.create) {
    await api.addInstance(s);
    out.created.push(s.id);
    await j.append({ t: "instance-created", runId, instanceId: s.id, homePath: s.homePath } satisfies JournalEntry);
  }
  return out;
}

export async function applyProjectDefaults(
  api: T3Api, defaults: { projectId: string; instanceId: string }[], j: Journal, runId: string,
): Promise<{ set: string[]; unchanged: string[] }> {
  const projects = await api.listProjects();
  const res = { set: [] as string[], unchanged: [] as string[] };
  for (const d of defaults) {
    const p = projects.find((x) => x.id === d.projectId);
    if (p && p.defaultModelSelection?.instanceId === d.instanceId) { res.unchanged.push(d.projectId); continue; }
    const { previous } = await api.setProjectDefault(d.projectId, d.instanceId);
    res.set.push(d.projectId);
    await j.append({ t: "project-default-set", runId, projectId: d.projectId, previous, next: { instanceId: d.instanceId } });
  }
  return res;
}

/**
 * Run before renaming an instance: the api pins an IMPLICIT instance's detected home in the same upsert, so a drifted
 * home must never reach it. claudeAgent drifted -> InstanceHomeDrift; another implicit id -> only when its detected
 * home equals the config account's home. Explicit entries are not pinned by a rename and pass.
 */
export async function assertRenameSafe(api: T3Api, instanceId: string, accountHome: string): Promise<string | null> {
  const cfg = await api.getConfig();
  if (Object.hasOwn(cfg.settings.providerInstances, instanceId)) return null; // explicit entry: a rename pins nothing
  const eff = (await api.providerInstances()).find((i) => i.instanceId === instanceId)?.homePath ?? null;
  if (eff === null || sameCwd(eff, accountHome)) return eff; // the home an implicit instance will be pinned to
  if (instanceId === DEFAULT_ID) throw new InstanceHomeDrift(eff);
  throw new ConfigError(`Refusing to rename ${instanceId}: it has no settings entry and its detected home ${eff} differs from the configured ${accountHome}; renaming would pin the wrong home. Run \`t3sm accounts --apply\` first.`);
}
