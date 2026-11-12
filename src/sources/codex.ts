import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createZstdDecompress } from "node:zlib";
import type { CanonicalMessage, CanonicalTranscript, DiscoveredSession, SessionFlag } from "../core/types.ts";
import { isActive } from "../core/activity.ts";
import { createNativeAdapter, type NativeAdapter, type NativeAdapterOptions, type NativeScan } from "./native.ts";
import { LineTooLongError, entryKind, extractText, isoOrNull, listDir, obj, scanJsonlChunks, str, type ReadOptions } from "./jsonl.ts";
import { TOOL_TEXT_MAX, toolInput, toolLine } from "./flatten.ts";
import { CWD_SCAN_MAX_BYTES, CWD_SCAN_MAX_RECORDS, SessionActiveError, type Env } from "./types.ts";

/** Codex home: `CODEX_HOME` from the host environment, else `~/.codex` (T3 AgentSessionScanner.ts:1416-1447). */
export function codexHome(env: Env): string {
  const fromEnv = (env.env ?? process.env).CODEX_HOME;
  return fromEnv !== undefined && fromEnv.trim() !== "" ? resolve(fromEnv) : join(env.home, ".codex");
}

const COMPRESSED_EXT = ".jsonl.zst";
const isPlainRollout = (name: string): boolean => name.startsWith("rollout-") && name.endsWith(".jsonl");
const isCompressedRollout = (name: string): boolean => name.startsWith("rollout-") && name.endsWith(COMPRESSED_EXT);
const ROLLOUT_NAME_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Decompressed size above which a compressed rollout is not converted (flag / skip reason `too-large`). */
export const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
/** Longest line of a compressed rollout read; a longer one is `too-large` (it is never buffered whole). */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Display id of a compressed rollout (Codex CLI >= 0.167 compresses older rollouts to `rollout-*.jsonl.zst`), else
 * null: the id from a `rollout-<timestamp>-<uuid>` name, else the stem. T3 Code lists only `rollout-*.jsonl`, so t3sm
 * converts compressed ones (never writing into ~/.codex); with `codex.convertCompressed: false` they are listed
 * unopened under this id.
 */
export function compressedRolloutId(path: string): string | null {
  const name = basename(path);
  if (!isCompressedRollout(name)) return null;
  const stem = name.slice(0, -COMPRESSED_EXT.length);
  return ROLLOUT_NAME_RE.exec(stem)?.[1] ?? stem;
}

/** Whether compressed rollouts are converted in this env (`config.codex.convertCompressed`, default true). */
export const convertCompressed = (env: Env): boolean => env.config.codex?.convertCompressed !== false;

/**
 * Files: `sessions/<year>/<month>/<day>/rollout-*.jsonl`, regular files only (symlinks followed, as T3
 * stats every entry), no recursion beyond the day directory (T3 AgentSessionScanner.ts:1213-1270).
 * Compressed `rollout-*.jsonl.zst` files are listed too (t3sm only: converted, see native.ts).
 */
async function* files(env: Env, onError: (path: string, error: string) => void): AsyncGenerator<string> {
  const sessions = join(codexHome(env), "sessions");
  const names = async (dir: string, want: "dir" | "file"): Promise<string[]> => {
    const out: string[] = [];
    for (const d of await listDir(dir)) if ((await entryKind(dir, d, onError)) === want) out.push(d.name);
    return out.sort().reverse();
  };
  for (const y of await names(sessions, "dir")) {
    for (const m of await names(join(sessions, y), "dir")) {
      for (const d of await names(join(sessions, y, m), "dir")) {
        const dir = join(sessions, y, m, d);
        for (const f of await names(dir, "file")) {
          if (isPlainRollout(f) || isCompressedRollout(f)) yield join(dir, f);
        }
      }
    }
  }
}

const hash = (t: string): string => createHash("sha1").update(t).digest("hex");

// ---------- byte sources ----------

class TooLargeError extends Error {
  override name = "TooLargeError";
}

/**
 * The Frame_Content_Size of the zstd frame starting at `b` (RFC 8878 §3.1.1.1), or null when the header does not
 * carry one (or is not a zstd frame). Codex writes one frame per rollout with its size (measured on 108 real files).
 */
export function zstdFrameContentSize(b: Buffer): number | null {
  if (b.length < 6 || b.readUInt32LE(0) !== 0xfd2fb528) return null;
  const d = b[4]!;
  const flag = d >> 6, single = (d >> 5) & 1;
  const at = 5 + (single ? 0 : 1) + [0, 1, 2, 4][d & 3]!;
  const size = flag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][flag]!;
  if (size === 0 || b.length < at + size) return null;
  if (size === 1) return b[at]!;
  if (size === 2) return b.readUInt16LE(at) + 256;
  if (size === 4) return b.readUInt32LE(at);
  return Number(b.readBigUInt64LE(at));
}

const zstdError = (code: "ZSTD_truncated" | "ZSTD_corrupt", message: string): Error => Object.assign(new Error(message), { code });

interface ZstdFrame { start: number; end: number; contentSize: number | null }

/**
 * The zstd frames of a file, from their headers and block headers only (RFC 8878 §3.1; no decompression): where each
 * frame starts and ends and the size it declares. Skippable frames are stepped over. Strict: a frame or block that runs
 * past the end of the file is `ZSTD_truncated`; bytes that are not a frame, or a reserved block type, `ZSTD_corrupt`.
 * Node's zstd stream decodes only the first frame and ends silently on a truncated one, so this is what makes a
 * partial read impossible.
 */
async function zstdFrames(path: string): Promise<ZstdFrame[]> {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    const read = async (pos: number, n: number): Promise<Buffer> => {
      const b = Buffer.alloc(n);
      const { bytesRead } = await fh.read(b, 0, n, pos);
      return b.subarray(0, bytesRead);
    };
    const cut = (what: string): Error => zstdError("ZSTD_truncated", `truncated zstd file: ${what} runs past its end (${size} bytes)`);
    if (size === 0) throw zstdError("ZSTD_truncated", "empty zstd file");
    const frames: ZstdFrame[] = [];
    let pos = 0;
    while (pos < size) {
      const head = await read(pos, 18);
      if (head.length < 4) throw cut(`the frame at byte ${pos}`);
      const magic = head.readUInt32LE(0);
      if ((magic & 0xfffffff0) === 0x184d2a50) { // skippable frame: 4-byte magic, 4-byte size, data
        if (head.length < 8) throw cut(`the skippable frame at byte ${pos}`);
        pos += 8 + head.readUInt32LE(4);
        if (pos > size) throw cut("a skippable frame");
        continue;
      }
      if (magic !== 0xfd2fb528) throw zstdError("ZSTD_corrupt", `not a zstd frame at byte ${pos}`);
      if (head.length < 5) throw cut(`the frame header at byte ${pos}`);
      const d = head[4]!;
      if ((d >> 3) & 1) throw zstdError("ZSTD_corrupt", `reserved bit set in the frame header at byte ${pos}`);
      const flag = d >> 6, single = (d >> 5) & 1;
      const headerSize = 5 + (single ? 0 : 1) + [0, 1, 2, 4][d & 3]! + (flag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][flag]!);
      if (head.length < headerSize) throw cut(`the frame header at byte ${pos}`);
      const contentSize = zstdFrameContentSize(head);
      let p = pos + headerSize;
      for (;;) {
        const bh = await read(p, 3);
        if (bh.length < 3) throw cut(`a block header at byte ${p}`);
        const v = bh[0]! | (bh[1]! << 8) | (bh[2]! << 16);
        const type = (v >> 1) & 3;
        if (type === 3) throw zstdError("ZSTD_corrupt", `reserved block type at byte ${p}`);
        p += 3 + (type === 1 ? 1 : v >>> 3); // RLE blocks carry one byte
        if (p > size) throw cut(`a block`);
        if (v & 1) break; // last block
      }
      if ((d >> 2) & 1) { // content checksum
        p += 4;
        if (p > size) throw cut("the frame checksum");
      }
      frames.push({ start: pos, end: p, contentSize });
      pos = p;
    }
    return frames;
  } finally {
    await fh.close();
  }
}

/**
 * The decompressed bytes of a `.jsonl.zst`, streamed frame after frame; throws TooLargeError once more than `maxBytes`
 * came out. Completeness is strict: the frame structure must be whole (zstdFrames), each frame must decode to the
 * size it declares, and a file with a frame that declares no size (a streaming compressor) must end with a newline.
 */
async function* zstdChunks(path: string, readOpts: ReadOptions, maxBytes: number): AsyncGenerator<Buffer> {
  const frames = await zstdFrames(path);
  let total = 0;
  let lastByte = -1;
  let undeclared = false;
  for (const f of frames) {
    const src = createReadStream(path, { ...readOpts, start: f.start, end: f.end - 1 });
    const z = createZstdDecompress();
    src.on("error", (e) => z.destroy(e));
    src.pipe(z);
    let n = 0;
    try {
      for await (const c of z as AsyncIterable<Buffer>) {
        n += c.length;
        total += c.length;
        if (total > maxBytes) throw new TooLargeError(`more than ${maxBytes} bytes decompressed`);
        if (c.length > 0) lastByte = c[c.length - 1]!;
        yield c;
      }
    } finally {
      src.destroy();
      z.destroy();
    }
    if (f.contentSize === null) undeclared = true;
    else if (n !== f.contentSize) throw zstdError("ZSTD_truncated", `zstd frame at byte ${f.start} decoded to ${n} of ${f.contentSize} bytes`);
  }
  if (total === 0) throw zstdError("ZSTD_truncated", "no data in the zstd file");
  if (undeclared && lastByte !== 0x0a) throw zstdError("ZSTD_truncated", "the decompressed rollout does not end with a complete line");
}

/** A rollout's bytes: decompressed for `.jsonl.zst`, as they are for `.jsonl`. */
function rolloutChunks(path: string, readOpts: ReadOptions, maxBytes: number): AsyncIterable<Buffer> {
  return path.endsWith(COMPRESSED_EXT) ? zstdChunks(path, readOpts, maxBytes) : (createReadStream(path, readOpts) as AsyncIterable<Buffer>);
}

// ---------- the message rules (one implementation for discovery and conversion) ----------

interface ToolCall { name: string; input: string; output: string | null }
type SegItem =
  | { k: "event"; text: string; ts: string }
  | { k: "user"; text: string; turn: string | null; ts: string }
  | { k: "tool"; tool: ToolCall; ts: string };
type Out = { role: "user" | "assistant"; text: string; ts: string } | { role: "assistant"; tool: ToolCall; ts: string };

/** What one pass over a rollout yields: the scan (discovery's measure), plus the messages when collected. */
export interface RolloutRead extends NativeScan { messages: CanonicalMessage[] }

/** At most this much of a tool input or output is kept: TOOL_TEXT_MAX of the joined text is all that is shown. */
const keep = (s: string): string => (s.length > TOOL_TEXT_MAX + 1 ? s.slice(0, TOOL_TEXT_MAX + 1) : s);

function toolOutput(v: unknown): string {
  if (typeof v === "string") return v;
  const o = obj(v);
  if (o && typeof o.output === "string") return o.output;
  if (o && typeof o.content === "string") return o.content;
  const t = extractText(o?.content ?? v);
  return t !== "" ? t : v === undefined ? "" : JSON.stringify(v);
}

/** A function_call's `arguments` (a JSON string) as the user would recognise it. */
function argsInput(v: unknown): string {
  if (typeof v !== "string") return toolInput(v);
  try {
    return toolInput(JSON.parse(v));
  } catch {
    return v;
  }
}

/**
 * One pass over a rollout's records. Rules copied from T3 (apps/server/src/project/AgentSessionScanner.ts):
 * - session id: the first `session_meta` record with a non-empty `payload.id`, else `payload.session_id`
 *   (lines 541-543). The rollout file name is NOT the id and T3 never imports a rollout without one
 *   (lines 409-410, 600), so `id` stays null here (flag `no-session-id`; no stem fallback for Codex).
 * - cwd: first record with a non-blank top-level `cwd`, else (after the subagent check) `payload.cwd`
 *   (extractCwd, 677-712). A `session_meta` whose `payload.source` has a `subagent`/`subAgent` key and
 *   no top-level cwd stops discovery (686-697): flag `subagent`, cwd null.
 * - cwd window: first 1 MiB and 1000 lines, blank lines included (lines 59, 68, 947-957, 988-991).
 * - messages (parseAgentSessionRecords, 433-476 pre-pass and 541-596 main pass), replayed per segment,
 *   a segment being the records up to and including an assistant response_item message:
 *   pre-pass: a response-item user message with a turn_id (and text) whose text equals a non-empty
 *   event_msg user_message text of the segment makes that turn_id canonical, and every response-item
 *   user message of the segment with a canonical turn_id is dropped (433-446). Main pass: an event
 *   user_message also removes an earlier retained response-item user copy with the same text (554-560);
 *   a response-item user message is dropped when canonical or when a retained event message with the
 *   same text precedes it in the segment (583-588, 494-509). Response items need non-empty extracted
 *   text. Simplification: an assistant message with empty text also closes the segment here, while T3
 *   closes it only in the pre-pass (negligible).
 * Conversion (`collect`) keeps the same messages, in order, plus t3sm's own additions for the converted transcript:
 * tool calls (function_call, custom_tool_call, local_shell_call, web_search_call with their outputs) as assistant
 * text `[tool <name>] <input> → <output>`; reasoning and every other record are dropped. Tool lines are not counted
 * (messageCount stays T3's measure, the one discovery reports).
 */
async function reduceRollout(chunks: AsyncIterable<Buffer>, o: { collect: boolean; stopAtSubagent: boolean; maxLineBytes?: number }): Promise<RolloutRead> {
  const r: RolloutRead = {
    id: null, cwd: null, startedAt: null, updatedAt: null, messageCount: 0, visibleUserCount: 0,
    corruptLines: 0, cwdOffsetBytes: 0, cwdReadable: false, subagent: false, messages: [],
  };
  const out: Out[] = [];
  const calls = new Map<string, ToolCall>();
  let seg: SegItem[] = [];
  let lastTs = "";

  const flushSegment = (): void => {
    const eventTexts = new Set<string>();
    for (const it of seg) if (it.k === "event") eventTexts.add(hash(it.text));
    const canonical = new Set<string>();
    for (const it of seg) if (it.k === "user" && it.turn !== null && eventTexts.has(hash(it.text))) canonical.add(it.turn);
    const retained: ({ fromResponse: boolean; key: string; it: SegItem } | { key: null; it: SegItem })[] = [];
    for (const it of seg) {
      if (it.k === "tool") { retained.push({ key: null, it }); continue; }
      const key = hash(it.text);
      if (it.k === "event") {
        for (let i = retained.length - 1; i >= 0; i--) {
          const x = retained[i]!;
          if (x.key !== null && x.fromResponse && x.key === key) {
            retained.splice(i, 1);
            r.messageCount--;
            break;
          }
        }
        retained.push({ fromResponse: false, key, it });
        r.messageCount++;
        r.visibleUserCount++;
      } else {
        if (it.turn !== null && canonical.has(it.turn)) continue;
        if (retained.some((m) => m.key !== null && !m.fromResponse && m.key === key)) continue;
        retained.push({ fromResponse: true, key, it });
        r.messageCount++;
        r.visibleUserCount++;
      }
    }
    if (o.collect) {
      for (const { it } of retained) out.push(it.k === "tool" ? { role: "assistant", tool: it.tool, ts: it.ts } : { role: "user", text: it.text, ts: it.ts });
    }
    seg = [];
  };

  try {
    const totals = await scanJsonlChunks(chunks, (rec, info): void | "stop" => {
      const payload = obj(rec.payload);
      if (r.id === null && rec.type === "session_meta" && payload) {
        r.id = str(payload.id) || str(payload.session_id) || null;
      }
      if (!r.cwd && !r.subagent) {
        let cwd: string | null = typeof rec.cwd === "string" && rec.cwd.trim() !== "" ? rec.cwd : null;
        if (cwd === null && rec.type === "session_meta" && payload) {
          const src = obj(payload.source);
          if (src && (Object.hasOwn(src, "subagent") || Object.hasOwn(src, "subAgent"))) {
            r.subagent = true;
            if (o.stopAtSubagent) return "stop"; // skipped whatever follows
          }
        }
        if (cwd === null && !r.subagent && payload && typeof payload.cwd === "string" && payload.cwd.trim() !== "") cwd = payload.cwd;
        if (cwd !== null) {
          r.cwd = cwd;
          r.cwdOffsetBytes = info.offset;
          r.cwdReadable = info.offset <= CWD_SCAN_MAX_BYTES && info.recordIndex <= CWD_SCAN_MAX_RECORDS;
        }
      }
      const ts = isoOrNull(rec.timestamp);
      if (ts !== null) {
        r.startedAt ??= ts;
        r.updatedAt = ts;
        lastTs = ts;
      }
      if (!payload) return;
      if (rec.type === "event_msg" && payload.type === "user_message") {
        const text = typeof payload.message === "string" ? payload.message.trim() : "";
        if (text !== "") seg.push({ k: "event", text, ts: lastTs });
        return;
      }
      if (rec.type !== "response_item") return;
      if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
        if (payload.role === "assistant") {
          flushSegment();
          const text = extractText(payload.content);
          if (text !== "") {
            r.messageCount++;
            if (o.collect) out.push({ role: "assistant", text, ts: lastTs });
          }
          return;
        }
        const text = extractText(payload.content);
        if (text === "") return;
        const turnRaw = obj(payload.internal_chat_message_metadata_passthrough)?.turn_id;
        const turn = typeof turnRaw === "string" && turnRaw.trim() !== "" ? turnRaw : null;
        seg.push({ k: "user", text, turn, ts: lastTs });
        return;
      }
      if (!o.collect) return;
      const call = (name: string, input: string): void => {
        const tool: ToolCall = { name: name || "unknown", input: keep(input), output: null };
        const id = str(payload.call_id);
        if (id !== "") calls.set(id, tool);
        seg.push({ k: "tool", tool, ts: lastTs });
      };
      switch (payload.type) {
        case "function_call": call(str(payload.name), argsInput(payload.arguments)); break;
        case "custom_tool_call": call(str(payload.name), typeof payload.input === "string" ? payload.input : toolInput(payload.input)); break;
        case "local_shell_call": {
          const cmd = obj(payload.action)?.command;
          call("shell", Array.isArray(cmd) ? cmd.join(" ") : toolInput(payload.action));
          break;
        }
        case "web_search_call": {
          const q = obj(payload.action)?.query;
          call("web_search", typeof q === "string" ? q : toolInput(payload.action));
          break;
        }
        case "function_call_output":
        case "custom_tool_call_output": {
          const t = calls.get(str(payload.call_id));
          if (t) t.output = keep(toolOutput(payload.output));
          break;
        }
        default: break; // reasoning and everything else: dropped
      }
    }, { maxLineBytes: o.maxLineBytes });
    r.corruptLines = totals.corruptLines;
    if (r.cwd === null) r.cwdOffsetBytes = totals.totalBytes;
  } catch (e) {
    if (!(e instanceof TooLargeError) && !(e instanceof LineTooLongError)) throw e;
    r.tooLarge = true;
  }
  flushSegment();
  if (o.collect) {
    r.messages = out.map((m) => ({
      role: m.role,
      text: "tool" in m ? toolLine(m.tool.name, m.tool.input, m.tool.output ?? "(no output)") : m.text,
      timestamp: m.ts,
    }));
  }
  return r;
}

export interface RolloutReadOptions extends ReadOptions { maxDecompressedBytes?: number; maxLineBytes?: number }

/** Reducer options for a path: compressed rollouts get the per-line cap and stop at a subagent meta (when scanning). */
const capsFor = (path: string, ro: RolloutReadOptions): { maxLineBytes?: number } =>
  (path.endsWith(COMPRESSED_EXT) ? { maxLineBytes: ro.maxLineBytes ?? MAX_LINE_BYTES } : {});

/**
 * Discovery's scan of a rollout (`.jsonl`, or `.jsonl.zst` decompressed while streaming). A compressed rollout stops
 * at a subagent meta (skipped anyway) and at the decompressed-size cap (`tooLarge`); a corrupt stream throws.
 */
export async function scanRollout(path: string, readOpts: RolloutReadOptions = {}): Promise<NativeScan> {
  const max = readOpts.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES;
  const { messages: _m, ...scan } = await reduceRollout(rolloutChunks(path, readOpts, max), { collect: false, stopAtSubagent: path.endsWith(COMPRESSED_EXT), ...capsFor(path, readOpts) });
  return scan;
}

/** The whole rollout (`.jsonl` or `.jsonl.zst`): the scan plus the canonical messages (the conversion's input). */
export function readRollout(path: string, readOpts: RolloutReadOptions = {}): Promise<RolloutRead> {
  const max = readOpts.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES;
  return reduceRollout(rolloutChunks(path, readOpts, max), { collect: true, stopAtSubagent: false, ...capsFor(path, readOpts) });
}

// ---------- adapter ----------

export interface CodexAdapter extends NativeAdapter {
  /** Compressed rollouts (sessions in convert mode): the session as a CanonicalTranscript (SourceAdapter.read). */
  read(s: DiscoveredSession): Promise<CanonicalTranscript>;
}

export interface CodexAdapterOptions extends NativeAdapterOptions {
  /** Decompressed size cap (default MAX_DECOMPRESSED_BYTES; tests shrink it). */
  maxDecompressedBytes?: number;
  /** Per-line cap of compressed rollouts (default MAX_LINE_BYTES; tests shrink it). */
  maxLineBytes?: number;
  /** Clock for read()'s active check (default Date.now). */
  now?: () => number;
}

export function createCodexAdapter(opts: CodexAdapterOptions = {}): CodexAdapter {
  const max = opts.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES;
  const now = opts.now ?? Date.now;
  const native = createNativeAdapter({
    id: "codex",
    cacheFile: "codex-discovery.json",
    // 4: compressed rollouts are scanned (decompressed) and carry `tooLarge`. 5: every zstd frame decoded, strict
    // completeness, per-line cap (results of version 4 may be partial reads).
    cacheVersion: 5,
    root: (env) => join(codexHome(env), "sessions"),
    files,
    scan: (p, ro) => scanRollout(p, { ...ro, maxDecompressedBytes: max, maxLineBytes: opts.maxLineBytes }),
    stemFallback: false,
    compressed: { id: compressedRolloutId, convert: convertCompressed },
  }, opts);
  const adapter: CodexAdapter = Object.assign(native, {
    async read(s: DiscoveredSession): Promise<CanonicalTranscript> {
      const st = await stat(s.file.path);
      if (isActive(st.mtimeMs, now())) {
        throw new SessionActiveError(`codex session ${s.nativeId} was written ${Math.max(0, Math.round((now() - st.mtimeMs) / 1000))} s ago; it may be in use`);
      }
      const r = await readRollout(s.file.path, { ...opts.readOptions, maxDecompressedBytes: max, maxLineBytes: opts.maxLineBytes });
      if (r.tooLarge) throw new Error(`codex session ${s.nativeId} is larger than ${Math.round(max / 1048576)} MiB decompressed (too-large)`);
      if (r.id !== s.nativeId) throw new Error(`${s.file.path} holds session ${r.id ?? "(no id)"}, not ${s.nativeId}`);
      if (r.cwd === null) throw new Error(`codex session ${s.nativeId} records no working directory`);
      const mtimeIso = new Date(st.mtimeMs).toISOString();
      return {
        harness: "codex", nativeId: r.id, cwd: r.cwd, title: null, startedAt: r.startedAt ?? mtimeIso, messages: r.messages,
        activity: { updatedAt: r.updatedAt ?? mtimeIso, messageCount: r.messageCount },
      };
    },
  });
  return adapter;
}

export const codexAdapter: CodexAdapter = createCodexAdapter();

/** Flags that make a Codex session skipped whatever T3 holds (doctor's count; the planner decides the same way). */
const SKIPPING: readonly SessionFlag[] = ["duplicate-file", "subagent", "no-session-id", "only-hidden", "no-cwd", "cwd-unreadable", "over-4gib", "too-large"];

/**
 * Codex sessions by how they reach T3 (doctor): `importable` natively (plain rollouts), `convertible` (compressed,
 * converted into Claude threads), `skipped` (duplicate files, sub-agents, no id / cwd, too large, compressed with
 * conversion off) and `readErrors` (files or folders that could not be read: not sessions). `sessionIds`: the native
 * ids of the importable and convertible ones (doctor counts those already in T3, under either form). Read-only:
 * discovery reads its cache (a warm cache decompresses nothing) and never saves it; nothing else is written.
 */
export async function countCodexSessions(env: Env, adapter: CodexAdapter = createCodexAdapter()): Promise<{ importable: number; convertible: number; skipped: number; readErrors: number; sessionIds: string[] }> {
  const n = { importable: 0, convertible: 0, skipped: 0, readErrors: 0, sessionIds: [] as string[] };
  for await (const s of adapter.discover({ ...env, readOnly: true })) {
    if (s.flags.some((f) => SKIPPING.includes(f))) n.skipped++;
    else if (s.mode === "convert") { n.convertible++; n.sessionIds.push(s.nativeId); }
    else if (s.flags.includes("compressed")) n.skipped++;
    else { n.importable++; n.sessionIds.push(s.nativeId); }
  }
  n.readErrors = adapter.lastErrors.length;
  return n;
}
