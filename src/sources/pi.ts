import { join, resolve } from "node:path";
import { createNativeAdapter, type NativeAdapter, type NativeAdapterOptions, type NativeScan } from "./native.ts";
import { entryKind, extractText, isoOrNull, listDir, obj, scanJsonl, str, type ReadOptions } from "./jsonl.ts";
import { CWD_SCAN_MAX_BYTES, CWD_SCAN_MAX_RECORDS, type Env } from "./types.ts";

export type PiAdapter = NativeAdapter;

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

/**
 * Pi sessions directory, as T3 resolves it (resolvePiSessionsDir, packages/provider-pi/src/server/usage.ts:164-176):
 * `PI_CODING_AGENT_SESSION_DIR`, else `<PI_CODING_AGENT_DIR>/sessions`, else `~/.pi/agent/sessions`;
 * `~` is expanded and the result resolved.
 */
export function piSessionsDir(env: Env): string {
  const e = env.env ?? process.env;
  const sessionDir = e.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (sessionDir) return resolve(expandHome(sessionDir, env.home));
  const agentDir = e.PI_CODING_AGENT_DIR?.trim();
  return resolve(agentDir ? expandHome(agentDir, env.home) : join(env.home, ".pi", "agent"), "sessions");
}

/**
 * Pi nests sessions in one directory per cwd, but a custom session directory holds them flat:
 * entries ending in `.jsonl` are transcripts, any other entry is read as a directory whose `.jsonl`
 * children are (T3 AgentSessionScanner.ts:1278-1330, discoverPiTranscripts).
 */
async function* files(env: Env, onError: (path: string, error: string) => void): AsyncGenerator<string> {
  const root = piSessionsDir(env);
  for (const e of await listDir(root)) {
    const p = join(root, e.name);
    const kind = await entryKind(root, e, onError);
    if (e.name.endsWith(".jsonl")) {
      if (kind === "file") yield p;
      continue;
    }
    if (kind !== "dir") continue;
    for (const f of await listDir(p)) {
      if (f.name.endsWith(".jsonl") && (await entryKind(p, f, onError)) === "file") yield join(p, f.name);
    }
  }
}

interface Entry { id: string | undefined; parentId: string | undefined; kind: 0 | 1 | 2 } // 0 other, 1 assistant, 2 user

/**
 * Rules copied from T3 (apps/server/src/project/AgentSessionScanner.ts):
 * - session id (`providerSessionId`): the first `type:"session"` record id, trimmed, else the file
 *   stem (lines 411-413, 1745). T3 resumes Pi by file path, which we keep in `file.path` (spike S2).
 * - cwd: first record with a non-blank top-level `cwd` or `payload.cwd` (extractCwd, 677-712), within
 *   1 MiB / 1000 records.
 * - messages: only the active branch counts (activePiBranch, 352-372): from the last non-session entry
 *   up its `parentId` chain; legacy v1 files whose last entry has no `id` are linear. A message is a
 *   `type:"message"` entry with role user or assistant and non-empty text (isPiConversationRecord, 374-383; 511-523).
 */
export async function scanPiSession(path: string, readOpts: ReadOptions = {}): Promise<NativeScan> {
  const r: NativeScan = {
    id: null, cwd: null, startedAt: null, updatedAt: null, messageCount: 0, visibleUserCount: 0,
    corruptLines: 0, cwdOffsetBytes: 0, cwdReadable: false, subagent: false,
  };
  let sawSession = false;
  const entries: Entry[] = [];
  const totals = await scanJsonl(path, readOpts, (o, info) => {
    if (!sawSession && o.type === "session") {
      sawSession = true;
      r.id = str(o.id) || null;
    }
    if (!r.cwd) {
      const payload = obj(o.payload);
      const top = typeof o.cwd === "string" && o.cwd.trim() !== "" ? o.cwd : null;
      const nested = payload && typeof payload.cwd === "string" && payload.cwd.trim() !== "" ? payload.cwd : null;
      const cwd = top ?? nested;
      if (cwd !== null) {
        r.cwd = cwd;
        r.cwdOffsetBytes = info.offset;
        r.cwdReadable = info.offset <= CWD_SCAN_MAX_BYTES && info.recordIndex <= CWD_SCAN_MAX_RECORDS;
      }
    }
    const ts = isoOrNull(o.timestamp);
    if (ts !== null) {
      r.startedAt ??= ts;
      r.updatedAt = ts;
    }
    if (o.type === "session") return;
    const msg = obj(o.message);
    let kind: 0 | 1 | 2 = 0;
    if (o.type === "message" && msg && (msg.role === "user" || msg.role === "assistant") && extractText(msg.content) !== "") {
      kind = msg.role === "user" ? 2 : 1;
    }
    entries.push({
      id: typeof o.id === "string" ? o.id : undefined,
      parentId: typeof o.parentId === "string" && o.parentId !== "" ? o.parentId : undefined,
      kind,
    });
  });
  r.corruptLines = totals.corruptLines;
  if (r.cwd === null) r.cwdOffsetBytes = totals.totalBytes;

  const leaf = entries.at(-1);
  let branch: Entry[];
  if (leaf === undefined) branch = [];
  else if (leaf.id === undefined) branch = entries;
  else {
    const byId = new Map<string, Entry>();
    for (const e of entries) if (e.id !== undefined) byId.set(e.id, e);
    branch = [];
    for (let e: Entry | undefined = leaf; e !== undefined && branch.length < entries.length;
      e = e.parentId !== undefined ? byId.get(e.parentId) : undefined) branch.push(e);
  }
  for (const e of branch) {
    if (e.kind === 0) continue;
    r.messageCount++;
    if (e.kind === 2) r.visibleUserCount++;
  }
  return r;
}

export function createPiAdapter(opts: NativeAdapterOptions = {}): PiAdapter {
  return createNativeAdapter({
    id: "pi",
    cacheFile: "pi-discovery.json",
    root: piSessionsDir,
    files,
    scan: scanPiSession,
    stemFallback: true,
  }, opts);
}

export const piAdapter: PiAdapter = createPiAdapter();
