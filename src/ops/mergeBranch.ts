// Reading the branch `claude --resume` would continue (S3 §6), streamed: see the header of merge.ts for the rules
// (nodes, leaf, chain, compaction, and the positive evidence of terminal work after the baseline).

import { createReadStream } from "node:fs";

const T3_ENTRYPOINT = "t3-code";

// unsettled: an unreadable line after the chain (a record being written, or a torn tail): skipped this run, like active.
export type BranchProblem = "broken-chain" | "corrupt-lines" | "compacted" | "unsettled";

export interface BranchNode {
  uuid: string; parent: string | null; type: string;
  /** A message the user sees: user/assistant, not isMeta / isCompactSummary / isVisibleInTranscriptOnly. */
  visible: boolean;
  /** A compaction boundary (`compact_boundary`, or `logicalParentUuid` set). */
  compact: boolean;
  entrypoint: string | null;
  /** Byte offset and length (newline included) of the record's line in the source. */
  offset: number; length: number;
  timestamp: string | null; cwd: string | null;
}

export interface TranscriptBranch {
  /** The record `claude --resume` continues from (null: no record with a uuid). */
  leaf: string | null;
  leafSource: "last-prompt" | "file-order" | null;
  /** Root -> leaf. */
  chain: BranchNode[];
  /** Why no revision may be written from this chain (null: it is whole). */
  problem: BranchProblem | null;
  /** Visible messages on the chain after the baseline whose entrypoint is a string other than "t3-code" (R1). */
  addedMessages: number;
  /** A record after the baseline carries entrypoint "t3-code". */
  t3MarkerAfter: boolean;
  /** Other leaves whose branch holds visible messages that are not on the chain (orphaned for T3 and the CLI alike). */
  divergedLeaves: number;
  /** Of those, the ones holding terminal work after the baseline (a visible message from an entrypoint other than T3). */
  orphanedTerminal: number;
  /** Newest timestamp on the chain. */
  lastActivity: string | null;
  corruptLines: number;
}

interface Line { offset: number; buf: Buffer }

/** Every line of a file with its byte offset, streamed (a line is held only while it is yielded). */
async function* fileLines(file: string): AsyncGenerator<Line> {
  const s = createReadStream(file, { highWaterMark: 1 << 20 });
  let pending: Buffer[] = [];
  let pendingLen = 0;
  let start = 0;
  for await (const chunk of s as AsyncIterable<Buffer>) {
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, from);
      if (nl === -1) {
        if (from < chunk.length) { pending.push(chunk.subarray(from)); pendingLen += chunk.length - from; }
        break;
      }
      const part = chunk.subarray(from, nl + 1);
      const buf = pendingLen > 0 ? Buffer.concat([...pending, part]) : part;
      yield { offset: start, buf };
      start += buf.length;
      pending = [];
      pendingLen = 0;
      from = nl + 1;
    }
  }
  if (pendingLen > 0) yield { offset: start, buf: Buffer.concat(pending) };
}

export function parseLine(buf: Buffer, offset: number): Record<string, unknown> | null {
  let text = buf.toString("utf8");
  if (offset === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r?\n$/, "");
  if (text.trim() === "") return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The branch `claude --resume` would continue (S3 §6), whether it can be copied whole, and the positive evidence of
 * terminal work on it after `importedSize` (the baseline: the transcript's size when t3sm imported or last merged it).
 */
export async function readBranch(file: string, opts: { importedSize?: number | null } = {}): Promise<TranscriptBranch> {
  const nodes = new Map<string, BranchNode>();
  const lastPrompts: string[] = [];
  const corruptAt: number[] = [];
  let lastNode: string | null = null;
  let t3MarkerAfter = false;
  const baseline = opts.importedSize ?? 0;
  for await (const { offset, buf } of fileLines(file)) {
    const o = parseLine(buf, offset);
    if (o === null) {
      if (buf.toString("utf8").trim() !== "") corruptAt.push(offset);
      continue;
    }
    if (offset >= baseline && o.entrypoint === T3_ENTRYPOINT) t3MarkerAfter = true;
    if (o.type === "last-prompt") {
      if (typeof o.leafUuid === "string" && o.leafUuid !== "") lastPrompts.push(o.leafUuid);
      continue; // never a node
    }
    if (typeof o.uuid !== "string" || o.uuid === "" || o.isSidechain === true) continue;
    if (!nodes.has(o.uuid)) {
      const type = typeof o.type === "string" ? o.type : "";
      nodes.set(o.uuid, {
        uuid: o.uuid, parent: typeof o.parentUuid === "string" && o.parentUuid !== "" ? o.parentUuid : null, type,
        visible: (type === "user" || type === "assistant") && o.isMeta !== true && o.isCompactSummary !== true && o.isVisibleInTranscriptOnly !== true,
        compact: o.subtype === "compact_boundary" || (typeof o.logicalParentUuid === "string" && o.logicalParentUuid !== ""),
        entrypoint: typeof o.entrypoint === "string" ? o.entrypoint : null,
        offset, length: buf.length,
        timestamp: typeof o.timestamp === "string" ? o.timestamp : null, cwd: typeof o.cwd === "string" ? o.cwd : null,
      });
    }
    lastNode = o.uuid;
  }

  const res: TranscriptBranch = {
    leaf: null, leafSource: null, chain: [], problem: null, addedMessages: 0, t3MarkerAfter, divergedLeaves: 0, orphanedTerminal: 0, lastActivity: null,
    corruptLines: corruptAt.length,
  };
  // The newest last-prompt whose leafUuid resolves wins; an unresolvable newer one does not hide an older valid one.
  let fromPrompt: string | null = null;
  for (let i = lastPrompts.length - 1; i >= 0 && fromPrompt === null; i--) if (nodes.has(lastPrompts[i]!)) fromPrompt = lastPrompts[i]!;
  const leaf = fromPrompt ?? lastNode;
  if (leaf === null) return res;
  res.leaf = leaf;
  res.leafSource = fromPrompt !== null ? "last-prompt" : "file-order";

  const chain: BranchNode[] = [];
  const seen = new Set<string>();
  let id: string | null = leaf;
  while (id !== null) {
    if (seen.has(id)) { res.problem = "broken-chain"; break; } // cycle
    const n = nodes.get(id);
    if (!n) { res.problem = "broken-chain"; break; } // a parent that is not in the file
    seen.add(id);
    chain.push(n);
    id = n.parent;
  }
  res.chain = chain.reverse();
  if (res.problem === null && res.chain.some((n) => n.compact)) res.problem = "compacted";
  if (res.problem === null && corruptAt.length > 0) {
    const lo = Math.min(...res.chain.map((n) => n.offset));
    const hi = Math.max(...res.chain.map((n) => n.offset + n.length));
    if (corruptAt.some((o) => o >= lo && o < hi)) res.problem = "corrupt-lines";
    else if (corruptAt.some((o) => o >= hi)) res.problem = "unsettled";
  }
  const onChain = new Set(res.chain.map((n) => n.uuid));
  res.addedMessages = res.chain.filter((n) => n.visible && n.offset >= baseline && n.entrypoint !== null && n.entrypoint !== T3_ENTRYPOINT).length;
  for (let i = res.chain.length - 1; i >= 0 && res.lastActivity === null; i--) res.lastActivity = res.chain[i]!.timestamp;

  // Other leaves: report the ones whose own segment (up to the chain or an already walked node) holds messages.
  const parents = new Set<string>();
  for (const n of nodes.values()) if (n.parent !== null) parents.add(n.parent);
  const walked = new Set<string>(onChain);
  for (const n of nodes.values()) {
    if (parents.has(n.uuid) || n.uuid === leaf) continue;
    let msg = false;
    let terminal = false;
    for (let x: BranchNode | undefined = n; x && !walked.has(x.uuid); x = x.parent !== null ? nodes.get(x.parent) : undefined) {
      walked.add(x.uuid);
      if (x.visible) msg = true;
      if (x.visible && x.offset >= baseline && x.entrypoint !== null && x.entrypoint !== T3_ENTRYPOINT) terminal = true;
    }
    if (msg) res.divergedLeaves++;
    if (terminal) res.orphanedTerminal++;
  }
  return res;
}

export async function firstLineLength(file: string): Promise<number> {
  for await (const { buf } of fileLines(file)) return buf.length;
  return 0;
}
