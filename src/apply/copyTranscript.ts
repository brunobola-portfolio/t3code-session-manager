// faithfulCopy: the text of a faithful copy of a Claude transcript (spec §4.3), for a conversation whose folder T3 Code
// refuses (the home folder, ~/Documents/Codex...). Unlike claudeWriter (which flattens a canonical transcript), every
// line of the source is kept as it is, so the copy resumes with the full history (tools, thinking, titles); only
// the top-level `cwd` and `sessionId` of the records that carry them change, so T3 Code files it under the target
// project with a new id. A provenance record (no `uuid`: Claude Code and T3 Code ignore its unknown type, S6 §8.4)
// is appended once and links the copy to its original.
//
// faithfulCopy is pure apart from reading the source (once, whole). readFaithfulCopy adds the checks every caller needs
// (the source stat'd before and after the read: in use or changed meanwhile -> wait) and discovery's measure of the
// original. Writing, journaling and publishing are the callers' job: materialize (the first copy, and a refresh in
// place) and follow (a revision of a copy that follows its original, src/ops/follow.ts).
// Line rules: lines are split on LF; a record without top-level cwd / sessionId, a blank line and a corrupt line are
// kept byte for byte (as UTF-8 text); a record that carries them is re-serialized with the same keys in the same order
// (its other values are equal, though JSON escapes may be spelled differently), keeping a BOM and a trailing CR.

import { readFile } from "node:fs/promises";
import { statSafe } from "../core/fsutil.ts";
import { isActive } from "../core/activity.ts";
import { scanTranscriptChunks } from "../sources/claude.ts";

export interface FaithfulCopyOptions {
  /** The new working directory (the target project, as Claude Code would write it on this platform). */
  cwd: string;
  /** The new session id (the copy's file name, the T3 thread's native id). */
  sessionId: string;
  /** The original: written into the provenance record. */
  provenance: { fromPath: string; fromSessionId: string; fromCwd: string };
}

export const PROVENANCE_TYPE = "t3sm-provenance";
export const WRITTEN_BY = "t3code-session-manager";

/** The provenance record of a faithful copy (one JSON line, no newline). */
export function provenanceLine(p: FaithfulCopyOptions["provenance"]): string {
  return JSON.stringify({ type: PROVENANCE_TYPE, fromPath: p.fromPath, fromSessionId: p.fromSessionId, fromCwd: p.fromCwd, writtenBy: WRITTEN_BY });
}

/**
 * The copy's text and how many source lines it holds (blank lines not counted; the provenance record not counted).
 * The source file is only read.
 */
export async function faithfulCopy(source: string, o: FaithfulCopyOptions): Promise<{ text: string; records: number }> {
  const raw = await readFile(source, "utf8");
  const pieces = raw.split("\n");
  // A final newline leaves an empty last piece: not a line.
  if (pieces.length > 0 && pieces[pieces.length - 1] === "") pieces.pop();
  let records = 0;
  const out: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const line = pieces[i]!;
    if (line.trim() !== "") records++;
    out.push(swap(line, i === 0, o));
  }
  out.push(provenanceLine(o.provenance));
  return { text: out.join("\n") + "\n", records };
}

/** The line with its top-level cwd / sessionId swapped, or the line itself when it carries neither or is not a record. */
function swap(line: string, first: boolean, o: FaithfulCopyOptions): string {
  let body = line;
  const bom = first && body.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  if (bom) body = body.slice(1);
  const cr = body.endsWith("\r") ? "\r" : "";
  if (cr) body = body.slice(0, -1);
  if (!body.includes(`"cwd"`) && !body.includes(`"sessionId"`)) return line; // cheap: most lines are not parsed twice
  let rec: unknown;
  try {
    rec = JSON.parse(body);
  } catch {
    return line; // corrupt: copied as it is
  }
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return line;
  const r = rec as Record<string, unknown>;
  const hasCwd = Object.hasOwn(r, "cwd");
  const hasId = Object.hasOwn(r, "sessionId");
  if (!hasCwd && !hasId) return line; // only nested fields of that name (tool input): content, never rewritten
  // Assigning existing keys keeps their position: same keys, same order.
  if (hasCwd) r.cwd = o.cwd;
  if (hasId) r.sessionId = o.sessionId;
  return bom + JSON.stringify(r) + cr;
}

/** The original as copied (journaled as `file-written.rehomeOf`): the planner's and the follow's baseline. */
export interface CopiedOriginal { path: string; nativeId: string; cwd: string; size: number; mtimeMs: number }

async function* once(b: Buffer): AsyncIterable<Buffer> {
  yield b;
}

/**
 * A faithful copy of the Claude transcript at `source.path` (session `source.nativeId`, folder `o.fromCwd`), checked
 * against the file it was read from, or why it has to wait: written within ACTIVE_WINDOW_MS (in use) -> `active`;
 * changed while it was read -> `source-busy`. Throws when the source cannot be read. Shared by materialize (the first
 * copy) and follow (a copy that follows its original).
 *
 * activity: discovery's measure of the original (only cwd / sessionId differ in the copy, and the provenance record
 * has no timestamp and is no message; no timestamp at all: the file's time). cwdOffsetBytes: bytes up to and
 * including the copy's first record that carries cwd, as discovery counts them.
 */
export async function readFaithfulCopy(
  source: { path: string; nativeId: string }, o: { cwd: string; sessionId: string; fromCwd: string }, now: number,
): Promise<{ defer: "active" | "source-busy" } | { text: string; activity: { updatedAt: string; messageCount: number }; rehomeOf: CopiedOriginal; cwdOffsetBytes: number }> {
  const before = await statSafe(source.path);
  if (before === null) throw new Error(`${source.path} no longer exists`);
  if (isActive(before.mtimeMs, now)) return { defer: "active" };
  const { text } = await faithfulCopy(source.path, { cwd: o.cwd, sessionId: o.sessionId, provenance: { fromPath: source.path, fromSessionId: source.nativeId, fromCwd: o.fromCwd } });
  const after = await statSafe(source.path);
  if (after === null || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { defer: "source-busy" };
  const m = await scanTranscriptChunks(once(Buffer.from(text, "utf8")));
  return {
    text,
    activity: { updatedAt: m.updatedAt ?? new Date(before.mtimeMs).toISOString(), messageCount: m.messageCount },
    rehomeOf: { path: source.path, nativeId: source.nativeId, cwd: o.fromCwd, size: before.size, mtimeMs: before.mtimeMs },
    cwdOffsetBytes: m.cwdOffsetBytes,
  };
}
