// Write-phase helpers of applyPlan: the import baseline backfill, held projects' entries, the orphan-copy re-check and
// what conversions need (their adapters and the homes they may write into).

import type { AccountConfig, HarnessId, JournalEntry, PlanItem } from "../core/types.ts";
import type { SourceAdapter } from "../sources/types.ts";
import { near, type Journal } from "../core/journal.ts";
import { statSafe } from "../core/fsutil.ts";
import { shownText } from "../plan/names.ts";
import { conversationTitle } from "../plan/ownership.ts";
import type { ProviderInstanceInfo, T3Api } from "../t3/api.ts";
import type { ApplyResult, Tr } from "./applyTypes.ts";
import type { ActiveFile } from "./exposure.ts";

const isObj = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u);
/** A held root's entry: its project's name, the active transcript, its title (Claude transcripts only; never message content), its time. */
export async function heldEntry(project: string, root: string, f: ActiveFile): Promise<ApplyResult["held"][number]> {
  const title = f.harness === null || f.harness === "claude" ? await conversationTitle(f.path) : null;
  return { project, root, file: f.path, title, modifiedAt: new Date(f.mtimeMs).toISOString() };
}

/**
 * A wave that died before it could verify (crash, T3's thread list unreachable) left `import-attempt` items without an
 * `imported` entry. For each whose thread exists now and whose file is still exactly as attempted (size + mtime), the
 * missing `imported` is journaled under the attempt's run (merge reads it as the session's import baseline; `runs`
 * counts it). A file changed since is left without one: what T3 holds of it is unknown. Idempotent.
 */
export async function backfillImported(journal: Journal, threadIds: Set<string>): Promise<number> {
  const es = await journal.readAll();
  const have = new Set(es.flatMap((e) => (e.t === "imported" ? [`${e.harness}:${e.nativeId}`] : [])));
  let n = 0;
  for (const e of es) {
    if (e.t !== "import-attempt" || !Array.isArray(e.items)) continue;
    for (const x of e.items as unknown[]) {
      if (!isObj(x) || typeof x.threadId !== "string" || typeof x.nativeId !== "string" || typeof x.harness !== "string" || !isObj(x.source)) continue;
      const src = x.source;
      if (typeof src.path !== "string" || typeof src.size !== "number" || typeof src.mtimeMs !== "number") continue;
      const k = `${x.harness}:${x.nativeId}`;
      if (have.has(k) || !threadIds.has(x.threadId)) continue;
      const st = await statSafe(src.path).catch(() => null);
      if (!st || st.size !== src.size || !near(st.mtimeMs, src.mtimeMs)) continue;
      const item = x as unknown as Extract<JournalEntry, { t: "import-attempt" }>["items"][number];
      await journal.append({ t: "imported", runId: e.runId, harness: item.harness, nativeId: item.nativeId, threadId: item.threadId, source: { path: src.path, size: src.size, mtimeMs: src.mtimeMs } });
      have.add(k);
      n++;
    }
  }
  return n;
}

/** The adapters that convert sessions (`read`), by harness: convert-mode ones, and Codex for compressed rollouts. */
export function adapterMap(adapters: SourceAdapter[]): Map<HarnessId, SourceAdapter> {
  return new Map(adapters.filter((a) => typeof a.read === "function").map((a) => [a.id, a]));
}

/** The homes conversions may write into: every Claude instance home T3 reports, plus the config accounts' homes. */
export function conversionAccounts(providers: ProviderInstanceInfo[], homes: Record<string, string>): AccountConfig[] {
  const out: AccountConfig[] = [];
  for (const p of providers) if (p.driver === "claudeAgent" && p.homePath !== null) out.push({ id: p.instanceId, home: p.homePath, displayName: p.displayName, accentColor: null });
  for (const [id, home] of Object.entries(homes)) out.push({ id, home, displayName: id, accentColor: null });
  return out;
}

/** A faithful copy of a session T3 Code started (its thread gone from T3's lists: an "orphan", src/plan/planner.ts). */
export function isOrphanCopy(i: PlanItem): boolean {
  return i.action.kind === "convert-import" && i.action.copy === "faithful" && i.session.harness === "claude" && i.session.startedIn === "t3";
}

/**
 * Orphan copies (a session T3 Code started whose thread it no longer lists) rely on T3's thread lists being
 * complete: listed once more before anything is written for them (their folder, project or copy), and one whose
 * thread (its handoff id, or a thread of the session itself) is listed now is not copied. It waits for the next
 * plan, which sees it in T3. A listing that fails defers every orphan copy (nothing journaled for them); the
 * rest of the run goes on.
 * Returns the convert items still to write and the held orphan copies (their project is not created).
 */
export async function recheckOrphans(
  api: T3Api, toConvert: PlanItem[], heldItems: PlanItem[], result: ApplyResult, notice: (l: string) => void, tr: Tr,
): Promise<{ toConvert: PlanItem[]; orphanHeld: Set<PlanItem> }> {
  let orphanHeld = new Set<PlanItem>();
  let fresh: Awaited<ReturnType<T3Api["listThreads"]>> | null = null;
  try { fresh = await api.listThreads(); } catch (e) {
    const waiting = toConvert.filter(isOrphanCopy);
    result.deferred += waiting.length;
    orphanHeld = new Set(heldItems.filter(isOrphanCopy));
    const why = shownText(((e as Error)?.message ?? String(e)).split(/\r?\n/)[0] ?? "");
    notice(tr("apply.notice.orphanCheckFailed", { n: waiting.length + orphanHeld.size, error: why }));
    toConvert = toConvert.filter((i) => !isOrphanCopy(i));
  }
  if (fresh !== null) {
    const ids = new Set(fresh.flatMap((t) => [t.id, /^import:[^:]+:(.+)$/s.exec(t.id)?.[1] ?? "", t.nativeSessionId ?? ""]).filter((x) => x !== ""));
    const listed = (i: PlanItem): boolean => isOrphanCopy(i) && (ids.has(i.session.nativeId) || (i.session.t3ThreadId !== undefined && ids.has(i.session.t3ThreadId)));
    const live = toConvert.filter(listed);
    orphanHeld = new Set(heldItems.filter(listed));
    if (live.length > 0) {
      result.deferred += live.length;
      notice(tr("apply.notice.orphanListed", { n: live.length }));
      toConvert = toConvert.filter((i) => !live.includes(i));
    }
  }
  return { toConvert, orphanHeld };
}
