// `t3sm projects rename --suggest` (spec §4.5.5): clean titles for the projects t3sm created whose title is still the
// one t3sm gave them. Pure: no I/O. Applied with applyOrganize (kind `project-title`), so `t3sm organize --undo` and
// `t3sm rollback` revert it.
//
// The title t3sm gave a project: the latest `organize-change` project-title `next` when t3sm renamed it before, else
// the `project-created` title, else (entries written before the title was journaled) the folder's last segment, which
// is what t3sm named projects then. A project whose current title differs was renamed by the user: never touched.

import type { JournalEntry } from "../core/types.ts";
import { sameCwd } from "../core/paths.ts";
import { projectTitle } from "../plan/names.ts";
import type { T3Project } from "../t3/decode.ts";
import type { OrganizeAction } from "./types.ts";

export interface RenameOptions {
  maxLength: number;
  platform: NodeJS.Platform;
  /** The General folder (fixed title "General" / "Geral"): never renamed. */
  generalFolder?: string;
}

const lastSegment = (root: string): string => root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || root;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function suggestProjectTitles(projects: T3Project[], journal: JournalEntry[], o: RenameOptions): OrganizeAction[] {
  /** projectId -> the title t3sm created it with (undefined: an entry from before the title was journaled). */
  const created = new Map<string, string | undefined>();
  const renamed = new Map<string, unknown>();
  for (const e of journal) {
    if (e.t === "project-created") created.set(e.projectId, typeof e.title === "string" ? e.title : undefined);
    else if (e.t === "organize-change" && e.kind === "project-title") renamed.set(e.target, e.next);
  }
  const live = projects.filter((p) => !p.deleted);
  // Titles in use (lower case) and how many projects carry each: T3 allows the same title twice.
  const taken = new Map<string, number>();
  const use = (t: string, d: number): void => {
    const k = t.toLowerCase();
    const n = (taken.get(k) ?? 0) + d;
    if (n > 0) taken.set(k, n); else taken.delete(k);
  };
  for (const p of live) use(p.title, 1);
  const out: OrganizeAction[] = [];
  for (const p of [...live].sort((a, b) => cmp(a.workspaceRoot, b.workspaceRoot) || cmp(a.id, b.id))) {
    if (!created.has(p.id)) continue;
    if (o.generalFolder !== undefined && sameCwd(p.workspaceRoot, o.generalFolder, o.platform)) continue;
    const ours = renamed.has(p.id) ? renamed.get(p.id) : created.get(p.id) ?? lastSegment(p.workspaceRoot);
    if (p.title !== ours) continue;
    use(p.title, -1);
    const next = projectTitle(p.workspaceRoot, new Set(taken.keys()), { maxLength: o.maxLength, platform: o.platform });
    use(next, 1);
    if (next === p.title) continue;
    out.push({ kind: "project-title", target: p.id, projectId: p.id, previous: p.title, next, reason: "created by t3sm, title not changed since" });
  }
  return out;
}
