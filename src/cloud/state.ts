// Where each cloud session stands on this PC (spec 2026-11-26 §4.1), from the journal and the disk only: no network.
// The newest standing `file-written` with `cloudOf` for a cloud session is its local copy.

import type { JournalEntry } from "../core/types.ts";
import { effectiveWrites } from "../core/journal.ts";
import { sha256File, statSafe } from "../core/fsutil.ts";
import type { CloudSession } from "./decode.ts";

type Written = Extract<JournalEntry, { t: "file-written" }>;
export type CloudWrite = Written & { cloudOf: NonNullable<Written["cloudOf"]> };

/**
 * - `remote`: not on this PC (never pulled, rolled back, or its file is gone);
 * - `local`: pulled, and nothing newer in the cloud;
 * - `newer`: the cloud went on after the pull (`last_event_at` is later);
 * - `continued`: the local copy changed since t3sm wrote it (resumed here). A later cloud turn is then a conflict.
 */
export type CloudLocalState = "remote" | "local" | "newer" | "continued";

/** The standing cloud writes by cloud session id: the newest one of each (rolled-back runs left out). */
export function cloudWrites(entries: JournalEntry[]): Map<string, CloudWrite> {
  const rolledBack = new Set(entries.flatMap((e) => (e.t === "rolled-back" ? [e.targetRunId] : [])));
  const out = new Map<string, CloudWrite>();
  for (const w of effectiveWrites(entries)) {
    if (!w.cloudOf || rolledBack.has(w.runId)) continue;
    out.set(w.cloudOf.sessionId, w as CloudWrite);
  }
  return out;
}

const later = (a: string | null, b: string | null): boolean => {
  const x = a === null ? NaN : Date.parse(a), y = b === null ? NaN : Date.parse(b);
  return Number.isFinite(x) && (!Number.isFinite(y) || x > y + 1000);
};

/** One session's state, reading its local file's hash when there is one. */
export async function localState(s: CloudSession, w: CloudWrite | undefined): Promise<{ state: CloudLocalState; write: CloudWrite | null }> {
  if (!w || (await statSafe(w.path)) === null) return { state: "remote", write: null };
  const sha = await sha256File(w.path).catch(() => null);
  if (sha !== w.sha256) return { state: "continued", write: w };
  return { state: later(s.lastEventAt, w.cloudOf.lastEventAt) ? "newer" : "local", write: w };
}
