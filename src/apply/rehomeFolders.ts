// Rehome destination folders (interactive runs only; spec 4.3): checked read-only before the confirmation, then the
// missing ones are created and journaled (`folder-created`) right before the copies are written.

import { mkdir, stat } from "node:fs/promises";
import type { PlanItem } from "../core/types.ts";
import type { Journal } from "../core/journal.ts";
import { tildePath } from "../core/paths.ts";
import { classifyFolder } from "../plan/folders.ts";
import { shownText } from "../plan/names.ts";
import type { T3Project } from "../t3/api.ts";
import { rootKey } from "./waves.ts";
import { nativeRoot } from "./projects.ts";
import type { RehomeFolders, Tr } from "./applyTypes.ts";
/** A rehome destination folder as checked before a run: kept as it is, to create, or unusable (and why). */
type FolderCheck = { root: string; key: string; native: string; shown: string } & (
  | { state: "ok" } | { state: "create" } | { state: "blocked"; verb: "cannot create" | "cannot use"; reason: string });

/** An absolute folder as normalizeCwd spells it (a drive or UNC root on Windows). */
function isAbsoluteRoot(root: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? /^[A-Za-z]:\//.test(root) || root.startsWith("//") : root.startsWith("/");
}

/**
 * Read-only: the destination folder of each rehome copy among `items` (distinct roots). A folder that exists is used
 * as it is when T3 Code has its project, else it must be a folder T3 Code accepts (not temp / system) and a directory.
 * A missing one, whether or not T3 Code still has its project (rolled back, deleted by hand), is to be created once it
 * passes the same checks. A relative root is never used (it would land in the current folder).
 */
export async function checkRehomeFolders(items: PlanItem[], projects: T3Project[], o: RehomeFolders, platform: NodeJS.Platform): Promise<FolderCheck[]> {
  const out: FolderCheck[] = [];
  const seen = new Set<string>();
  const code = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e);
  for (const i of items) {
    if (i.action.kind !== "convert-import" || i.action.rehomeFrom === undefined) continue;
    const root = i.action.projectRoot;
    const key = rootKey(root, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    const base = { root, key, native: nativeRoot(root, platform), shown: shownText(tildePath(root, o.env.home, platform)) };
    const blocked = (verb: "cannot create" | "cannot use", reason: string): FolderCheck => ({ ...base, state: "blocked", verb, reason });
    if (!isAbsoluteRoot(root, platform)) { out.push(blocked("cannot create", "it is not an absolute folder")); continue; }
    if (/[\p{Cc}\p{Cf}]/u.test(root)) { out.push(blocked("cannot create", "its name contains control or invisible characters")); continue; }
    let st: Awaited<ReturnType<typeof stat>> | null = null;
    try { st = await stat(base.native); } catch (e) {
      if (code(e) !== "ENOENT") { out.push(blocked("cannot use", code(e))); continue; }
    }
    const inT3 = projects.some((p) => !p.deleted && rootKey(p.workspaceRoot, platform) === key);
    if (st !== null && inT3) { out.push({ ...base, state: "ok" }); continue; } // T3 Code has it, and its folder is there
    const verb = st === null ? "cannot create" : "cannot use";
    const cat = classifyFolder(root, o.env);
    if (cat === "temp" || cat === "system") { out.push(blocked(verb, "it is a temporary or system folder")); continue; }
    if (cat !== "project") { out.push(blocked(verb, "T3 Code does not accept it as a project")); continue; }
    if (st === null) out.push({ ...base, state: "create" });
    else out.push(st.isDirectory() ? { ...base, state: "ok" } : blocked("cannot create", "a file with that name is in the way"));
  }
  return out;
}

/**
 * The writes of checkRehomeFolders: a missing folder is created (and journaled) right before the copies; an unusable
 * one is reported once ("cannot create <folder>: <reason>", home shown as ~). Returns root key -> why it cannot be used.
 */
export async function prepareRehomeFolders(
  items: PlanItem[], projects: T3Project[], o: RehomeFolders, journal: Journal, runId: string, platform: NodeJS.Platform, notice: (l: string) => void, tr: Tr,
): Promise<Map<string, string>> {
  const blocked = new Map<string, string>();
  const make = o.mkdir ?? ((p: string) => mkdir(p, { recursive: true }));
  const code = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e);
  for (const c of await checkRehomeFolders(items, projects, o, platform)) {
    const block = (verb: "cannot create" | "cannot use", reason: string): void => {
      blocked.set(c.key, reason);
      notice(tr(verb === "cannot create" ? "apply.notice.cannotCreate" : "apply.notice.cannotUse", { path: c.shown, reason: shownText(reason) }));
    };
    if (c.state === "blocked") { block(c.verb, c.reason); continue; }
    if (c.state === "ok") continue;
    let created: string | undefined;
    try { created = await make(c.native); } catch (e) {
      block("cannot create", code(e) === "EEXIST" || code(e) === "ENOTDIR" ? "a file with that name is in the way" : code(e));
      continue;
    }
    if (created === undefined) continue; // made meanwhile by someone else: not t3sm's
    await journal.append({ t: "folder-created", runId, path: c.native, created });
    notice(tr("apply.notice.folderCreated", { path: c.shown }));
  }
  return blocked;
}
