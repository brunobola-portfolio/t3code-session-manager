// A cloud session's transcript as a local Claude Code transcript (spec 2026-11-26 §4.3), the way `claude --teleport`
// writes it but without the model and without touching git: every entry keeps its keys and values; `sessionId`, `cwd`
// and `gitBranch` take the local values (in place when the entry has the key, appended when not); one provenance record
// (no uuid: Claude Code and T3 Code ignore its type) is appended last. Pure and deterministic: the same entries give the
// same bytes.

import { uuidV5 } from "../core/uuid.ts";
import { WRITTEN_BY } from "../apply/copyTranscript.ts";
import type { CloudEntry } from "./decode.ts";

export const CLOUD_PROVENANCE_TYPE = "t3sm-cloud-provenance";

/** The local session id of a cloud session: the first pull, or the revision holding `entries` entries. */
export function cloudLocalId(cloudId: string, entries?: number): string {
  return uuidV5(entries === undefined ? `cloud:${cloudId}` : `cloud:${cloudId}:${entries}`);
}

export interface CloudProvenance {
  fromCloudSession: string;
  fromAccount: string;
  lastEventAt: string | null;
  entries: number;
}

export interface LocalTranscriptOptions {
  sessionId: string;
  cwd: string;
  gitBranch: string | null;
  provenance: CloudProvenance;
}

export function cloudProvenanceLine(p: CloudProvenance): string {
  return JSON.stringify({ type: CLOUD_PROVENANCE_TYPE, fromCloudSession: p.fromCloudSession, fromAccount: p.fromAccount, lastEventAt: p.lastEventAt, entries: p.entries, writtenBy: WRITTEN_BY });
}

/** One entry with the local values: existing keys keep their position, missing ones are appended. */
function localEntry(e: CloudEntry, o: LocalTranscriptOptions): Record<string, unknown> {
  const r: Record<string, unknown> = { ...e };
  r["sessionId"] = o.sessionId;
  r["cwd"] = o.cwd;
  if (o.gitBranch !== null) r["gitBranch"] = o.gitBranch;
  return r;
}

/** The transcript text (one JSON line per entry, then the provenance line), and how many entries it holds. */
export function toLocalTranscript(entries: readonly CloudEntry[], o: LocalTranscriptOptions): string {
  let out = "";
  for (const e of entries) out += JSON.stringify(localEntry(e, o)) + "\n";
  return out + cloudProvenanceLine(o.provenance) + "\n";
}

/** The transcript starts after a compaction: the turns before it were not returned (spec §2 S4). */
export function isCompacted(entries: readonly CloudEntry[]): boolean {
  return entries.some((e) => (e.type === "system" && e["subtype"] === "compact_boundary") || e["isCompactSummary"] === true);
}

/** Messages a person reads (user and assistant records that are not meta): the count the screens show. */
export function messageCount(entries: readonly CloudEntry[]): number {
  return entries.filter((e) => (e.type === "user" || e.type === "assistant") && e["isMeta"] !== true).length;
}
