import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Options forwarded to createReadStream (tests shrink highWaterMark to force chunk boundaries). */
export interface ReadOptions { highWaterMark?: number }

export interface RecordInfo {
  /** Bytes consumed including this record and its newline (exact, multi-byte and CRLF safe). */
  offset: number;
  /** 1-based line index, blank and corrupt lines included (T3 counts every line against its record budget). */
  recordIndex: number;
}

export interface JsonlTotals { corruptLines: number; totalBytes: number }

/**
 * Stream a JSONL file once without loading it whole. Lines are split on raw bytes (LF; a trailing
 * CR is stripped before parsing). Unparseable and non-object lines are counted as corrupt.
 */
export function scanJsonl(
  path: string,
  readOpts: ReadOptions,
  onRecord: (rec: Record<string, unknown>, info: RecordInfo) => void | "stop",
): Promise<JsonlTotals> {
  return scanJsonlChunks(createReadStream(path, readOpts) as AsyncIterable<Buffer>, onRecord);
}

/** A line longer than the scan's `maxLineBytes`: the scan stops before buffering more of it. */
export class LineTooLongError extends Error {
  override name = "LineTooLongError";
}

/**
 * scanJsonl over any byte stream (a decompressed one, for instance). `onRecord` returning "stop" ends the scan there
 * (the source is released; totals cover what was read). `maxLineBytes`: a longer line throws LineTooLongError as soon
 * as that much of it is buffered (one giant line never sits whole in memory).
 */
export async function scanJsonlChunks(
  chunks: AsyncIterable<Buffer>,
  onRecord: (rec: Record<string, unknown>, info: RecordInfo) => void | "stop",
  opts: { maxLineBytes?: number } = {},
): Promise<JsonlTotals> {
  const maxLine = opts.maxLineBytes ?? Infinity;
  const tooLong = (n: number): void => {
    if (n > maxLine) throw new LineTooLongError(`a line longer than ${maxLine} bytes`);
  };
  const totals: JsonlTotals = { corruptLines: 0, totalBytes: 0 };
  let offset = 0;
  let recordIndex = 0;
  let firstLine = true;
  let stopped = false;

  const handle = (line: Buffer): void => {
    let text = line.toString("utf8");
    if (firstLine) {
      firstLine = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (text.endsWith("\r")) text = text.slice(0, -1);
    // T3 reserves one record per line split on LF, blank ones included (AgentSessionScanner.ts:947-957,
    // 988-991), so blank lines count toward the 1000-record window.
    recordIndex++;
    if (text.trim() === "") return;
    let rec: unknown;
    try {
      rec = JSON.parse(text);
    } catch {
      totals.corruptLines++;
      return;
    }
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
      totals.corruptLines++;
      return;
    }
    if (onRecord(rec as Record<string, unknown>, { offset, recordIndex }) === "stop") stopped = true;
  };

  let pending: Buffer[] = [];
  let pendingLen = 0;
  for await (const chunk of chunks) {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl < 0) break;
      const piece = chunk.subarray(start, nl);
      tooLong(pendingLen + piece.length);
      const line = pending.length ? Buffer.concat([...pending, piece], pendingLen + piece.length) : piece;
      offset += line.length + 1;
      handle(line);
      pending = [];
      pendingLen = 0;
      start = nl + 1;
      if (stopped) break;
    }
    if (stopped) {
      totals.totalBytes = offset;
      return totals; // leaving the loop releases (destroys) the source
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      tooLong(pendingLen + rest.length);
      pending.push(rest);
      pendingLen += rest.length;
    }
  }
  if (pendingLen > 0) {
    const line = Buffer.concat(pending, pendingLen);
    offset += line.length;
    handle(line);
  }
  totals.totalBytes = offset;
  return totals;
}

export async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Entry type following symlinks, as T3 does (it stats every entry). A link that cannot be resolved
 * is reported through `onError` and skipped.
 */
export async function entryKind(
  dir: string,
  d: Dirent,
  onError: (path: string, error: string) => void,
): Promise<"dir" | "file" | null> {
  if (d.isDirectory()) return "dir";
  if (d.isFile()) return "file";
  if (!d.isSymbolicLink()) return null;
  const full = join(dir, d.name);
  try {
    const s = await stat(full);
    return s.isDirectory() ? "dir" : s.isFile() ? "file" : null;
  } catch (e) {
    onError(full, `broken symlink: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    return null;
  }
}

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const isStrOrNull = (v: unknown): boolean => v === null || typeof v === "string";

export function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** T3 `extractText`: string content trimmed, or the non-empty text of text/input_text/output_text blocks joined by newline. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text?: unknown } =>
      b !== null && typeof b === "object" && ["text", "input_text", "output_text"].includes((b as { type?: unknown }).type as string))
    .map((b) => (typeof b.text === "string" ? b.text.trim() : ""))
    .filter((t) => t.length > 0)
    .join("\n");
}

export const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
export const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
