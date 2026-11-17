// applyPlan's read-only checks and summaries, made before the first write: the T3 snapshot's shapes, --only, the
// instance homes, mirror copies, whether a run would write anything, and the dry-run report.

import type { Config, Plan, PlanItem } from "../core/types.ts";
import { CWD_SCAN_MAX_BYTES } from "../sources/types.ts";
import { inImportWindow } from "../core/activity.ts";
import { statSafe } from "../core/fsutil.ts";
import { sameCwd } from "../core/paths.ts";
import type { ProviderInstanceInfo, T3Project } from "../t3/api.ts";
import { T3Incompatible } from "../t3/errors.ts";
import { buildWaves, itemRoot, rootKey, waveItems } from "./waves.ts";
import type { FailReason } from "./importer.ts";
import { ApplyRefusal, STALE, type DryRunReport, type Tr } from "./applyTypes.ts";
import { asTargetItem, inside } from "./exposure.ts";
const isObj = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u);

/** The T3 responses this run acts on, re-checked field by field before the first write (exit 4 on drift). */
export function validateSnapshot(version: string, projects: unknown, threads: unknown, providers: unknown): void {
  const bad = (what: string): never => {
    throw new T3Incompatible(version, `T3 Code ${version} returned an unexpected ${what} shape; nothing was changed. Update t3sm or report it.`);
  };
  if (!Array.isArray(projects)) bad("project list");
  for (const p of projects as unknown[]) {
    if (!isObj(p) || typeof p.id !== "string" || typeof p.workspaceRoot !== "string" || typeof p.title !== "string" || typeof p.archived !== "boolean") bad("project");
  }
  if (!Array.isArray(threads)) bad("thread list");
  for (const t of threads as unknown[]) if (!isObj(t) || typeof t.id !== "string" || typeof t.projectId !== "string") bad("thread");
  if (!Array.isArray(providers)) bad("provider list");
  for (const i of providers as unknown[]) {
    if (!isObj(i) || typeof i.instanceId !== "string" || typeof i.driver !== "string" || !(i.homePath === null || typeof i.homePath === "string")
      || (i.availability !== "available" && i.availability !== "unavailable")) bad("provider instance");
  }
}

export function filterOnly(plan: Plan, only: string, platform: NodeJS.Platform): Plan {
  const keep = (r: string | null): boolean => r !== null && sameCwd(r, only, platform);
  const items = plan.items.filter((i) => keep(i.action.kind === "skip" ? i.session.cwd : i.action.projectRoot));
  const keptPaths = new Set(items.map((i) => i.session.file.path));
  const instancesUsed = new Set<string>([
    ...items.flatMap((i) => (i.action.kind === "skip" ? [] : [i.action.instanceId])),
    ...plan.projectDefaults.filter((d) => keep(d.root)).map((d) => d.instanceId),
  ]);
  return {
    ...plan,
    items,
    projectsToCreate: plan.projectsToCreate.filter((p) => keep(p.root)),
    projectDefaults: plan.projectDefaults.filter((d) => keep(d.root)),
    projectAccounts: plan.projectAccounts.filter((p) => keep(p.root)),
    instancesToCreate: plan.instancesToCreate.filter((s) => instancesUsed.has(s.id)),
    // A mirror whose kept copy is not in this root cannot be imported by this run's import calls.
    mirrorCopies: plan.mirrorCopies.filter((m) => keptPaths.has(m.keptPath) || !plan.items.some((i) => i.session.file.path === m.keptPath)),
  };
}

/**
 * The writes a run of `plan` (already --only-filtered, held projects' sessions removed; `held` adds their roots) would make, mirroring the write phase:
 * instances (ensureInstances), conversions (materializeConversions), projects (ensureProjects), defaults
 * (applyProjectDefaults: unchanged ones are skipped), up-front failures and waves (runWaves / buildWaves).
 */
export function dryRunReport(
  plan: Plan, held: PlanItem[], projects: T3Project[], providers: ProviderInstanceInfo[], threadIds: Set<string>, batch: Config["batch"], platform: NodeJS.Platform,
): Omit<DryRunReport, "pendingRecovery" | "held" | "pinDefault" | "foldersToCreate" | "failUpFront"> & { failUpFront: { item: PlanItem; reason: FailReason }[] } {
  const live = plan.items.filter((i) => i.action.kind !== "skip");
  const pending = live.filter((i) => !threadIds.has((i.action as { expectedThreadId: string }).expectedThreadId));
  const existing = (root: string): T3Project | undefined => projects.find((p) => !p.deleted && rootKey(p.workspaceRoot, platform) === rootKey(root, platform));
  const projectsToCreate: string[] = [];
  for (const i of [...pending, ...held]) { // a held project is created too (empty)
    const r = itemRoot(i);
    if (!existing(r) && !projectsToCreate.some((x) => rootKey(x, platform) === rootKey(r, platform))) projectsToCreate.push(r);
  }
  const defaultsToSet = plan.projectDefaults.filter((d) => {
    const p = existing(d.root);
    if (p) return p.defaultModelSelection?.instanceId !== d.instanceId;
    return projectsToCreate.some((x) => rootKey(x, platform) === rootKey(d.root, platform));
  }).map((d) => ({ root: d.root, instanceId: d.instanceId }));
  const availability = new Map(providers.map((p) => [p.instanceId, p.availability] as const));
  const failUpFront: { item: PlanItem; reason: FailReason }[] = [];
  const waveable: PlanItem[] = [];
  for (const i of pending) {
    const id = (i.action as { instanceId: string }).instanceId;
    const reason: FailReason | null = i.action.kind === "import" && i.session.cwdOffsetBytes > CWD_SCAN_MAX_BYTES ? "cwd-unreadable-in-t3"
      : availability.get(id) === "unavailable" ? "instance-unavailable" : null;
    if (reason) failUpFront.push({ item: i, reason });
    else waveable.push(asTargetItem(i));
  }
  const waves = buildWaves(waveable, batch, (i) => i.session.cwdOffsetBytes, { platform });
  return {
    plan,
    instancesToCreate: plan.instancesToCreate.filter((s) => !providers.some((p) => p.instanceId === s.id)).map((s) => s.id),
    projectsToCreate, defaultsToSet,
    conversions: pending.filter((i) => i.action.kind === "convert-import").length,
    waves: waves.length,
    waveSessions: waves.reduce((n, w) => n + waveItems(w).length, 0),
    alreadyInT3: live.length - pending.length,
    failUpFront,
  };
}

/** No instance to create, no import pending in T3, no project default that would change: a run would write nothing. */
export function nothingToWrite(plan: Plan, projects: T3Project[], threadIds: ReadonlySet<string>, platform: NodeJS.Platform): boolean {
  if (plan.instancesToCreate.length > 0) return false;
  if (plan.items.some((i) => i.action.kind !== "skip" && !threadIds.has(i.action.expectedThreadId))) return false;
  for (const d of plan.projectDefaults) {
    const k = rootKey(d.root, platform);
    const p = projects.find((x) => !x.deleted && rootKey(x.workspaceRoot, platform) === k);
    // A project that does not exist is only created for imports (none pending here), so its default is not set either.
    if (p && p.defaultModelSelection?.instanceId !== d.instanceId) return false;
  }
  return true;
}

/**
 * A mirror copy inside the 30-day window is parked during every wave of its project (runWaves' exposure), so this run
 * never imports it under the wrong account. T3's own Welcome import could still take it: warn, recommend dedupe.
 */
export async function warnMirrors(plan: Plan, now: number, notice: (l: string) => void, tr: Tr): Promise<void> {
  let live = 0;
  for (const m of plan.mirrorCopies) {
    const st = await statSafe(m.path).catch(() => null);
    if (st && inImportWindow(st.mtimeMs, now)) live++;
  }
  if (live > 0) {
    notice(tr("apply.notice.mirrors", { n: live }));
  }
}

/** Every Claude item must still live in the home its instance reads (S4: an inherited CLAUDE_CONFIG_DIR moves homes). */
export function checkInstanceHomes(plan: Plan, providers: ProviderInstanceInfo[], platform: NodeJS.Platform): void {
  const toCreate = new Set(plan.instancesToCreate.map((s) => s.id));
  for (const it of plan.items) {
    if (it.action.kind === "skip") continue;
    const id = it.action.instanceId;
    const live = providers.find((p) => p.instanceId === id);
    if (!live) {
      if (toCreate.has(id)) continue;
      throw new ApplyRefusal(`T3 instance ${id} no longer exists. ${STALE}`);
    }
    if (it.action.kind === "convert-import") {
      if (live.homePath !== null && !inside(it.action.targetFile, live.homePath, platform)) {
        throw new ApplyRefusal(`T3 instance ${id} now reads ${live.homePath}, not the home session ${it.session.nativeId} would be converted into; converting would file it under the wrong account. Check \`t3sm accounts\`, then run \`t3sm plan\` again.`);
      }
      continue;
    }
    if (it.session.harness !== "claude" || it.action.kind !== "import" || live.homePath === null) continue;
    if (!inside(it.session.file.path, live.homePath, platform)) {
      throw new ApplyRefusal(`T3 instance ${id} now reads ${live.homePath}, which does not hold session ${it.session.nativeId}; importing would file it under the wrong account. Check \`t3sm accounts\`, then run \`t3sm plan\` again.`);
    }
  }
}
