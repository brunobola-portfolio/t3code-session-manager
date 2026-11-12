// toClaudeJsonl: a CanonicalTranscript (any harness) as a Claude Code transcript that T3 Code imports and
// `claude --resume` continues. The record shape is exactly what spike S3 measured live (docs/spikes/S3-conversion.md,
// fixture test/fixtures/claude/converted-minimal.jsonl):
//
//   {"parentUuid", "type", ["isMeta",] "message": {"role", "content"}, "uuid", "timestamp", "cwd", "sessionId"}
//
// - Record 0 is the provenance: a `user` record with isMeta: true (hidden in T3's timeline and title, seen by the
//   model). Then one record per message. All 7 fields on every record (the smallest set that works for both T3 and
//   the CLI without relying on accidental behaviour, S3 §1).
// - User content is a string; assistant content is one text block.
// - Chain: strictly linear, parentUuid null on record 0, then the previous record's uuid (the CLI needs it, S3 §2).
//   Record uuids are uuidV5(`<session uuid>:<record index>`): re-conversion is byte-identical.
// - Timestamps: ISO-8601 UTC with ms, strictly increasing (+1 ms on ties or reversals, S3 §3), so the CLI's leaf is
//   unambiguous and T3's createdAt is the first message's real time.
// - Consecutive same-role messages are MERGED into one record (blank line between). S3 shows consecutive user records
//   work (the loader joins them, §4), but consecutive assistant records were never tested; merging keeps the
//   user/assistant alternation the API expects for both roles and costs nothing in T3 (one bubble per turn).
// - Tool calls and attachments arrive already flattened into text by the source adapter.

import { open } from "node:fs/promises";
import type { CanonicalMessage, CanonicalTranscript, HarnessId } from "../core/types.ts";
import { isUuid, uuidV5 } from "../core/uuid.ts";
import { hasConverter } from "../sources/registry.ts";

/** Default history budget: the size above which a native transcript is flagged `over-32mib` (truncated-over-32mib). */
export const DEFAULT_MAX_HISTORY_BYTES = 32 * 1024 * 1024;
/** Text of a message that has no text at all (T3 renders nothing for an empty bubble; the model needs a turn). */
export const NO_TEXT_PLACEHOLDER = "[no text content]";
/** Appended to a first user message clipped to fit the size limit. */
export const CLIP_MARKER = "… [truncated by t3code-session-manager]";

export interface ClaudeJsonlOptions {
  /** The Claude session id: file stem and `sessionId` (a lowercase UUID; T3 ignores non-UUID ids). */
  uuid: string;
  /** Written on every record: the T3 project root in the platform's native spelling. */
  cwd: string;
  /** Serialized size limit in bytes (default 32 MiB). */
  maxHistoryBytes?: number;
}

interface Turn { role: "user" | "assistant"; text: string; ms: number }

function provenanceText(t: CanonicalTranscript, omitted: number): string {
  const base = `Imported from ${t.harness} session ${t.nativeId} (started ${t.startedAt}) by t3code-session-manager.`;
  return omitted > 0 ? `${base} ${omitted} earlier messages were left out to fit the size limit.` : base;
}

/** Each message's time in ms: its own timestamp, or startedAt + index ms when it is not a valid date. */
function turns(t: CanonicalTranscript, base: number): Turn[] {
  const out: Turn[] = [];
  t.messages.forEach((m: CanonicalMessage, i) => {
    const own = Date.parse(m.timestamp);
    const ms = Number.isFinite(own) ? own : base + i;
    const text = m.text.trim() === "" ? "" : m.text;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      prev.text = [prev.text, text].filter((x) => x !== "").join("\n\n");
      prev.ms = Math.max(prev.ms, ms);
    } else out.push({ role: m.role, text, ms });
  });
  return out;
}

function record(
  i: number, parent: string | null, role: "user" | "assistant", text: string, ms: number, o: ClaudeJsonlOptions, meta = false,
): { line: string; uuid: string } {
  const uuid = uuidV5(`${o.uuid}:${i}`);
  const body = text === "" ? NO_TEXT_PLACEHOLDER : text;
  const message = role === "user" ? { role, content: body } : { role, content: [{ type: "text", text: body }] };
  const r = meta
    ? { parentUuid: parent, type: role, isMeta: true, message, uuid, timestamp: new Date(ms).toISOString(), cwd: o.cwd, sessionId: o.uuid }
    : { parentUuid: parent, type: role, message, uuid, timestamp: new Date(ms).toISOString(), cwd: o.cwd, sessionId: o.uuid };
  return { line: JSON.stringify(r) + "\n", uuid };
}

/**
 * Render `t` as Claude Code JSONL. When the result would exceed `maxHistoryBytes`, keeps the provenance record (which
 * then says how many messages were left out), the first user message and the newest contiguous messages that fit,
 * and reports `truncated: true`. Pure and deterministic.
 */
export function toClaudeJsonl(t: CanonicalTranscript, o: ClaudeJsonlOptions): { text: string; truncated: boolean } {
  if (!isUuid(o.uuid)) throw new Error(`toClaudeJsonl: session id must be a UUID (got ${o.uuid})`);
  const max = o.maxHistoryBytes ?? DEFAULT_MAX_HISTORY_BYTES;
  const started = Date.parse(t.startedAt);
  // An invalid startedAt: the first valid message time (else the epoch, the last resort).
  const firstValid = t.messages.map((m) => Date.parse(m.timestamp)).find((x) => Number.isFinite(x));
  const base = Number.isFinite(started) ? started : firstValid ?? 0;
  const all = turns(t, base);
  const provMs = all.length > 0 ? Math.min(base, all[0]!.ms) : base;

  const render = (kept: Turn[], omitted: number): string => {
    let parent: string | null = null;
    let last = provMs;
    let out = "";
    const p = record(0, null, "user", provenanceText(t, omitted), provMs, o, true);
    out += p.line;
    parent = p.uuid;
    kept.forEach((m, k) => {
      last = Math.max(m.ms, last + 1);
      const r = record(k + 1, parent, m.role, m.text, last, o);
      out += r.line;
      parent = r.uuid;
    });
    return out;
  };

  const full = render(all, 0);
  if (Buffer.byteLength(full, "utf8") <= max) return { text: full, truncated: false };

  // Every record's size is independent of its neighbours except for the uuids (fixed 36 chars) and the timestamp
  // (fixed 24 chars), so per-turn sizes measured once are exact for any selection.
  const size = (m: Turn, k: number): number => Buffer.byteLength(record(k + 1, "", m.role, m.text, m.ms, o).line, "utf8") + 36;
  const firstUser = all.findIndex((m) => m.role === "user");
  const head = firstUser >= 0 ? [{ ...all[firstUser]! }] : [];
  // The provenance's length depends on the omitted count; reserve the longest it can be.
  let budget = max - Buffer.byteLength(record(0, null, "user", provenanceText(t, all.length), provMs, o, true).line, "utf8");
  if (head.length > 0 && size(head[0]!, 0) > budget) {
    // The first user message alone does not fit: keep the longest prefix that does, marked as clipped.
    const full = head[0]!.text;
    const fits = (k: number): boolean => size({ ...head[0]!, text: full.slice(0, k) + CLIP_MARKER }, 0) <= budget;
    let lo = 0, hi = full.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid; else hi = mid - 1;
    }
    head[0]!.text = full.slice(0, lo) + CLIP_MARKER;
  }
  budget -= head.reduce((n, m) => n + size(m, 0), 0);
  const tail: Turn[] = [];
  for (let i = all.length - 1; i > Math.max(firstUser, -1); i--) {
    const s = size(all[i]!, 1);
    if (s > budget) break; // contiguous newest slice only
    budget -= s;
    tail.unshift(all[i]!);
  }
  const kept = [...head, ...tail];
  return { text: render(kept, all.length - kept.length), truncated: true };
}

/**
 * True when `path` (Claude session `nativeId`) is a transcript t3sm wrote by converting another harness's session:
 * its id is a version-5 UUID and its first record is t3sm's provenance (isMeta user, parentUuid null, record uuid
 * derived in t3sm's namespace, "Imported from <harness with a converter> session …"). Cheap: a non-v5 id never opens the
 * file, and only the first 64 KiB are read. Never throws.
 */
export async function isConvertedTranscript(path: string, nativeId: string, isConvert: (h: HarnessId) => boolean = hasConverter): Promise<boolean> {
  if (!isUuid(nativeId) || nativeId[14] !== "5") return false;
  let first: string;
  try {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(65_536);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const text = buf.subarray(0, bytesRead).toString("utf8");
      const nl = text.indexOf("\n");
      if (nl < 0) return false;
      first = text.slice(0, nl);
    } finally {
      await fh.close();
    }
    const r = JSON.parse(first) as { parentUuid?: unknown; type?: unknown; isMeta?: unknown; uuid?: unknown; message?: { content?: unknown } };
    if (r.parentUuid !== null || r.type !== "user" || r.isMeta !== true || r.uuid !== uuidV5(`${nativeId.toLowerCase()}:0`)) return false;
    const m = typeof r.message?.content === "string" ? /^Imported from (\S+) session .* by t3code-session-manager\./.exec(r.message.content) : null;
    return m !== null && isConvert(m[1] as HarnessId);
  } catch {
    return false;
  }
}
