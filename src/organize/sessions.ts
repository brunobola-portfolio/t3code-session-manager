// The `sessions` input of buildOrganizePlan (ruling R13-4): for every `import:*` thread, its transcript's origin
// (human / automated) and a title proposal. Shared by `t3sm organize`, the assistant and sync.
//
// A thread `import:<instance>:<nativeId>` belongs to the Claude account whose home is that instance's home (no home
// reported, as for an implicit instance T3 has not resolved: the account with the instance's id); its
// transcript is the discovered Claude session of that account with that id (a backup copy only when nothing else has
// it), else the file the journal's `imported` entry names. A thread of another driver's instance (Codex, ...) is left
// out silently (no Claude transcript to read: human, no title). A Claude thread whose transcript is not found counts
// in `missing` (human, no title).

import type { DiscoveredSession, JournalEntry } from "../core/types.ts";
import { expandHome, pathKey, sameCwd } from "../core/paths.ts";
import type { T3Thread } from "../t3/decode.ts";
import { isTechnicalTitle } from "./titles.ts";
import type { OrganizeInput } from "./types.ts";

const IMPORT_RE = /^import:([^:]+):(.+)$/s;

export interface SessionMatchInput {
  threads: T3Thread[];
  /** T3's instances (driver and home as T3 reports them). */
  instances: { instanceId: string; driver: string; homePath: string | null }[];
  /** Config accounts (`~` in a home is expanded against `userHome` when given). */
  accounts: { id: string; home: string }[];
  userHome?: string;
  /** Discovered Claude sessions. */
  discovered: DiscoveredSession[];
  journal: JournalEntry[];
  /** Reads a title proposal from a transcript (proposeTitle); null: titles are off, none is read. */
  title: ((file: string) => Promise<string | null>) | null;
  platform: NodeJS.Platform;
}

export interface SessionMatch {
  sessions: OrganizeInput["sessions"];
  /** Claude threads whose transcript is not on this machine (counted human, title kept). */
  missing: number;
}

/**
 * Threads buildOrganizePlan may retitle: not archived, and the title is technical or still the one t3sm set (the
 * latest `organize-change` title). A superset of the planner's title rule, so only these transcripts are read for a
 * title; the others get `title: null`, which the planner treats the same way for them.
 */
export function mayRetitle(journal: JournalEntry[]): (t: T3Thread) => boolean {
  const ours = new Map<string, unknown>();
  for (const e of journal) if (e.t === "organize-change" && e.kind === "title") ours.set(e.target, e.next);
  return (t) => !t.archived && (isTechnicalTitle(t.title) || (ours.has(t.id) && ours.get(t.id) === t.title));
}

export async function matchSessions(i: SessionMatchInput): Promise<SessionMatch> {
  const key = (p: string): string => pathKey(p, i.platform);
  const better = (a: DiscoveredSession, b: DiscoveredSession): boolean => {
    const ab = a.flags.includes("backup-copy"), bb = b.flags.includes("backup-copy");
    if (ab !== bb) return !ab;
    return a.updatedAt > b.updatedAt;
  };
  const byId = new Map<string, DiscoveredSession>();
  const byPath = new Map<string, DiscoveredSession>();
  for (const s of i.discovered) {
    if (s.harness !== "claude") continue;
    byPath.set(key(s.file.path), s);
    const k = `${s.accountId ?? ""}\u0000${s.nativeId}`;
    const prev = byId.get(k);
    if (!prev || better(s, prev)) byId.set(k, s);
  }
  const importedPath = new Map<string, string>();
  for (const e of i.journal) if (e.t === "imported" && typeof e.source?.path === "string") importedPath.set(e.threadId, e.source.path);
  const accounts = i.accounts.map((a) => ({ id: a.id, home: i.userHome !== undefined ? expandHome(a.home, i.userHome) : a.home }));
  /**
   * The config account of an instance: the one whose home is the instance's home. T3 reports no home for an implicit
   * instance it has not resolved (apply and doctor fall back the same way): then the account with the instance's id.
   */
  const accountOf = (instanceId: string): string | null => {
    const home = i.instances.find((x) => x.instanceId === instanceId)?.homePath ?? null;
    if (home !== null) return accounts.find((a) => sameCwd(a.home, home, i.platform))?.id ?? null;
    return accounts.find((a) => a.id === instanceId)?.id ?? null;
  };
  const retitle = mayRetitle(i.journal);

  const sessions: SessionMatch["sessions"] = new Map();
  let missing = 0;
  for (const t of i.threads) {
    const m = IMPORT_RE.exec(t.id);
    if (!m) continue;
    const inst = i.instances.find((x) => x.instanceId === m[1]);
    if (inst && inst.driver !== "claudeAgent") continue;
    const account = accountOf(m[1]!);
    const path = importedPath.get(t.id);
    const s = (account !== null ? byId.get(`${account}\u0000${m[2]}`) : undefined) ?? (path !== undefined ? byPath.get(key(path)) : undefined);
    if (!s) {
      missing++;
      sessions.set(t.id, { origin: "human", title: null });
      continue;
    }
    const title = i.title !== null && retitle(t) ? await i.title(s.file.path) : null;
    sessions.set(t.id, { origin: s.origin ?? "human", title });
  }
  return { sessions, missing };
}
