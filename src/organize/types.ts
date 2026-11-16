// Types of `t3sm organize` (spec §5): the plan of what to archive, retitle, show (unsettle), settle and pin in T3 Code.
import type { FolderCategory, JournalEntry, OrganizeConfig, OrganizeKind } from "../core/types.ts";
import type { T3Project, T3Thread } from "../t3/decode.ts";

export type { OrganizeKind } from "../core/types.ts";

/**
 * One change to make in T3 Code. `previous` / `next` are what the journal's `organize-change` records, per kind:
 * - archive: thread `archived` flag, false -> true (target: thread id)
 * - title: thread title, current -> proposal (target: thread id)
 * - unsettle: thread `settledOverride`, "settled" (or null: no override) -> "active" (target: thread id)
 * - settle: thread `settledOverride`, "active" (or null) -> "settled", or `{ settledAt }` (ISO, the activity date) when
 *   the settle is backdated (target: thread id). `settleShown` (src/organize/history.ts) is how both kinds compare with
 *   T3's state: `{ settledAt }` is "settled", and a null `previous` (T3 cannot clear an override) is the side the
 *   change left ("active" for settle, "settled" for unsettle).
 * - pin / unpin: project `pinned` flag, false -> true / true -> false (target: project id)
 * - project-delete: `{ title, workspaceRoot }` -> null (target: project id)
 * - auto-settle: `sidebarAutoSettleAfterDays`, current -> wanted (target: "sidebarAutoSettleAfterDays")
 * - project-title: project title, current -> clean title (target: project id); planned by `t3sm projects rename
 *   --suggest` (src/organize/rename.ts), never by buildOrganizePlan.
 */
export interface OrganizeAction {
  kind: OrganizeKind; target: string;
  /** The project the target belongs to (the project itself for project kinds); null for auto-settle. */
  projectId: string | null;
  previous: unknown; next: unknown;
  /** Short English why, for review screens ("automated session (Agent SDK)", "history: all", "top 5 recent"). */
  reason: string;
}

export interface OrganizePlan {
  runId: string;
  actions: OrganizeAction[];
  counts: Record<OrganizeKind, number>;
  /**
   * Every project with at least one thread: threads T3 shows inside it (not archived, not settled) today and after
   * the plan's archive / unsettle / settle actions. Sorted by visibleAfter (most first), then title.
   */
  byProject: { projectId: string; title: string; visibleBefore: number; visibleAfter: number }[];
}

export interface OrganizeInput {
  runId: string;
  threads: T3Thread[]; projects: T3Project[]; journal: JournalEntry[]; config: OrganizeConfig;
  /** Key: thread id. title: the cleaned title proposal (Task 11) or null. A thread without an entry counts as human. */
  sessions: Map<string, { origin: "human" | "automated"; title: string | null }>;
  /** Epoch ms. */
  now: number;
  /**
   * onlyThreads: thread actions (archive, title, unsettle, settle) only for these ids (sync: the threads it just imported).
   * historyThreads: the history rule (unsettle, settle) only for these ids instead (sync: every imported thread of the
   * projects that got new ones, or of all projects once a day); default: the same threads as archive and title.
   * allowPins: pin / unpin. allowDeletes: project-delete.
   */
  scope: { onlyThreads?: ReadonlySet<string>; historyThreads?: ReadonlySet<string>; allowPins: boolean; allowDeletes: boolean };
  /** Folder category per project id (absent: "project"). */
  projectCategory?: Map<string, FolderCategory>;
  /** A title T3 derived from a technical first message. Default: starts with "<" or "[external". */
  isTechnicalTitle?: (title: string) => boolean;
  /** T3 Code's own auto-settle days now (null: off; undefined: not reported): whether the history rule marks (history.ts step 6). */
  t3AutoSettleDays?: number | null;
  /** Asked change of T3's global auto-settle (days, null = off): one action when want !== current. */
  autoSettle?: { want: number | null; current: number | null };
  /**
   * Project ids with sessions still waiting to import (a root held because a conversation is in use: apply created its
   * project empty and imports later): never deleted. Projects t3sm created in the last 24 h are kept as well.
   */
  keepProjects?: ReadonlySet<string>;
  /** false: the conversations of t3sm's projects in temp / system folders are not archived (`--no-archive-folders`). */
  archiveFolders?: boolean;
  /** Settle with the conversation's activity date (`next: { settledAt }`). Default SETTLE_BACKDATE (src/t3/compat.ts). */
  backdate?: boolean;
}
