// The T3 projects of a run: found by root (sameCwd), else created and journaled.

import path from "node:path";
import type { Plan, PlanItem } from "../core/types.ts";
import type { Journal } from "../core/journal.ts";
import { normalizeCwd } from "../core/paths.ts";
import type { T3Api, T3Project } from "../t3/api.ts";
import { T3HttpError } from "../t3/errors.ts";
import { itemRoot, rootKey } from "./waves.ts";
export function lastSegment(root: string): string {
  const parts = root.split("/").filter((x) => x !== "");
  return parts.length === 0 ? root : parts[parts.length - 1]!;
}

export function nativeRoot(root: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.win32.normalize(root) : root;
}

/** root key -> T3 project for every root with an import item: existing projects first (sameCwd), else created and journaled. */
export async function ensureProjects(
  api: T3Api, plan: Plan, liveProjects: T3Project[], toImport: PlanItem[], journal: Journal, runId: string, platform: NodeJS.Platform,
): Promise<Map<string, T3Project>> {
  const out = new Map<string, T3Project>();
  const find = (ps: T3Project[], k: string): T3Project | undefined => ps.find((p) => !p.deleted && rootKey(p.workspaceRoot, platform) === k);
  const needed = new Map<string, string>();
  for (const i of toImport) needed.set(rootKey(itemRoot(i), platform), itemRoot(i));
  for (const d of plan.projectDefaults) {
    const k = rootKey(d.root, platform);
    const p = find(liveProjects, k);
    if (p) out.set(k, p);
  }
  for (const [k, root] of needed) {
    const existing = find(liveProjects, k);
    if (existing) { out.set(k, existing); continue; }
    const spec = plan.projectsToCreate.find((p) => rootKey(p.root, platform) === k);
    const title = spec?.title ?? lastSegment(normalizeCwd(root, platform));
    let p: T3Project;
    try {
      p = await api.createProject(nativeRoot(root, platform), title);
    } catch (e) {
      // 400 invalid_command = a project already owns this root (S2 §7): re-read and use it.
      const again = e instanceof T3HttpError && e.status === 400 ? find(await api.listProjects(), k) : undefined;
      if (!again) throw e;
      out.set(k, again);
      continue;
    }
    await journal.append({ t: "project-created", runId, projectId: p.id, root: p.workspaceRoot, title: p.title });
    out.set(k, p);
  }
  return out;
}
