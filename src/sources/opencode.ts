// OpenCode source adapter (convert mode): OpenCode keeps every session in one SQLite database,
// `$XDG_DATA_HOME/opencode/opencode.db` (default `~/.local/share/opencode/opencode.db`, the same path on Windows).
// T3 Code cannot import it, so its sessions are converted into Claude transcripts (apply/claudeWriter.ts) and imported
// as Claude threads. Schema and tested version: docs/harnesses.md.
//
// The source is NEVER opened, not even read-only: OpenCode runs the db in WAL mode, and a read-only SQLite connection
// to a WAL db still writes the shared-memory index (`-shm`) and needs `-wal`/`-shm` to exist. Instead (takeSnapshot):
//   1. the db and its `-wal` are stream-copied, owner-only (0o600, created exclusively), into `<cache>/tmp/`;
//   2. if the source changed while it was copied, the copy is discarded and retaken (3 attempts, then SourceBusyError);
//   3. the raw copy is opened (its WAL replays), its schema is checked, and a FRESH database is built next to it with
//      `CREATE TABLE … AS SELECT <only the columns read here>` from session / message / part. Nothing else of
//      OpenCode's db (account tokens, credentials, share secrets, permissions, metadata) ever reaches the kept file;
//   4. the raw copy and its -wal/-shm/-journal are deleted in `finally`; the fresh one is published no-clobber as
//      `<cache>/opencode-s2-<source identity>.db` (`s2` = snapshot format; older formats are deleted on entry) and
//      opened `readOnly: true` from then on. It carries the indexes every query below needs (no full scans).
// `<cache>/tmp/` is swept on entry (anything older than 5 minutes or left by a dead process), so a crash never leaves a
// raw copy behind for long. `<cache>` is `<stateDir>/cache/opencode`, or, for read-only envs (`sync --dry-run`,
// `doctor`), one OS temp dir per process, removed after discovery or at exit (stale ones are swept too).
//
// One snapshot per run: discovery pins its snapshot (source path + identity) and `read()` reuses it, so every session
// of a run is read from the same consistent state. Without a discovery in the process (apply reads plan.json), the
// first `read()` takes and pins one. A reused snapshot is touched (mtime = last use), so pruning by age never removes
// one in use; a reader whose pinned snapshot vanished anyway re-pins once.
//
// Convert-mode sessions share one source file: every DiscoveredSession's `file` is the db itself (its size/mtime
// change whenever any session does). Activity is per session (`session.time_updated`): the `active` flag, the read-time
// active check and continued-outside-t3 (the planner compares the updatedAt / messageCount journaled at conversion).
//
// Errors: HarnessSchemaError on schema drift (availability `{drift}`, discovery error, `read` throws it);
// SourceBusyError when the db kept changing while copied; SessionActiveError when a session read was updated within
// ACTIVE_WINDOW_MS. The last two are deferrals, not failures (see SourceAdapter.read).

import { createReadStream, rmSync } from "node:fs";
import { chmod, link, mkdir, open, readdir, rm, stat, unlink, utimes } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CanonicalMessage, CanonicalTranscript, DiscoveredSession, SessionFlag, SourceFile } from "../core/types.ts";
import { publishNoClobber, statSafe } from "../core/fsutil.ts";
import { stateDir } from "../core/paths.ts";
import { isActive } from "../core/activity.ts";
import { pidAlive } from "../core/pid.ts";
import {
  HarnessSchemaError, SessionActiveError, SourceBusyError, type Availability, type Env, type SourceAdapter,
} from "./types.ts";
import { TOOL_TEXT_MAX, clip, toolInput, toolLine } from "./flatten.ts";

/** Tables and columns read here (OpenCode 1.19.5). Anything missing is schema drift; nothing else is ever copied. */
export const OPENCODE_REQUIRED: Readonly<Record<"session" | "message" | "part", readonly string[]>> = {
  session: ["id", "parent_id", "directory", "title", "time_created", "time_updated"],
  message: ["id", "session_id", "time_created", "data"],
  part: ["id", "message_id", "session_id", "data"],
};

/** Part types the reader knows (rendered or deliberately dropped). Others are counted in discovery's lastErrors. */
export const KNOWN_PART_TYPES: ReadonlySet<string> = new Set([
  "text", "tool", "file", "subtask", "reasoning", "step-start", "step-finish", "snapshot", "patch", "compaction", "retry", "agent",
]);

export { TOOL_TEXT_MAX } from "./flatten.ts";
const COPY_ATTEMPTS = 3;
/** Leftovers in a snapshot tmp dir (or a read-only temp dir) older than this are removed even if their process lives. */
export const STALE_TMP_MS = 5 * 60_000;
const TEMP_PREFIX = "t3sm-opencode-";
/** Kept snapshot names: `opencode-s2-<16 hex>.db` (s2 = stripped + indexed). */
const SNAPSHOT_PREFIX = "opencode-s2-";
const SNAPSHOT_RE = /^opencode-s2-[0-9a-f]{16}\.db$/;

/** SQLite could not open the file (SQLITE_CANTOPEN = 14) or it is gone. */
function vanished(e: unknown): boolean {
  const o = e as { code?: string; errcode?: number; message?: string };
  return o.code === "ENOENT" || o.errcode === 14 || /unable to open/i.test(o.message ?? "");
}

/** Marks a snapshot as used now (its age is time since last use). Never throws. */
async function touch(path: string): Promise<void> {
  const now = new Date();
  await utimes(path, now, now).catch(() => {});
}

export function openCodeDbPath(env: Env): string {
  const xdg = (env.env ?? process.env)["XDG_DATA_HOME"];
  return join(xdg ? xdg : join(env.home, ".local", "share"), "opencode", "opencode.db");
}

// ---------- snapshot ----------

export interface Snapshot {
  /** The kept, stripped, read-only copy. */
  path: string;
  /** The source's identity (path + size/mtime of db and WAL) the copy was taken from. */
  identity: string;
}

/** Test hooks for takeSnapshot (fault injection). */
export interface SnapshotHooks {
  /** Called after the raw copy is complete, before the stripped db is built. */
  afterRawCopy?(): void | Promise<void>;
}

export type Snapshotter = (db: string, cacheDir: string) => Promise<Snapshot>;

async function signature(db: string): Promise<string | null> {
  const main = await statSafe(db);
  if (!main) return null;
  const wal = await statSafe(`${db}-wal`);
  return `${db}|${main.size}|${main.mtimeMs}|${wal?.size ?? -1}|${wal?.mtimeMs ?? -1}`;
}

let sqlite: Promise<typeof import("node:sqlite")> | null = null;
/** node:sqlite is loaded only when an OpenCode db exists (it prints an ExperimentalWarning on Node 22/24). */
function loadSqlite(): Promise<typeof import("node:sqlite")> {
  sqlite ??= import("node:sqlite");
  return sqlite;
}

/** Removes entries named `<prefix><pid>-…` whose process is gone, and any older than STALE_TMP_MS. Never throws. */
async function sweep(dir: string, prefix: RegExp): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const m = prefix.exec(name);
    if (!m) continue;
    const p = join(dir, name);
    const st = await stat(p).catch(() => null);
    if (!st) continue;
    if (!pidAlive(Number(m[1])) || Date.now() - st.mtimeMs > STALE_TMP_MS) await rm(p, { recursive: true, force: true }).catch(() => {});
  }
}

/** Copies `src` into a NEW file `dst` (exclusive create, owner-only from the first byte). */
async function copyPrivate(src: string, dst: string): Promise<void> {
  const fh = await open(dst, "wx", 0o600);
  // The write stream owns the handle from here (closed on finish and on error).
  await pipeline(createReadStream(src), fh.createWriteStream());
}

/** The raw copy -> a fresh db holding only OPENCODE_REQUIRED (schema checked on the raw copy first). */
async function buildStripped(raw: string, out: string): Promise<void> {
  const { DatabaseSync } = await loadSqlite();
  await (await open(out, "wx", 0o600)).close(); // exists, owner-only, before SQLite writes to it
  // Foreign keys OFF: node:sqlite turns them on, and nothing here may cascade.
  const c = new DatabaseSync(raw, { enableForeignKeyConstraints: false });
  try {
    checkSchema(c);
    c.exec(`ATTACH DATABASE '${out.replaceAll("'", "''")}' AS out`);
    try {
      for (const [table, cols] of Object.entries(OPENCODE_REQUIRED)) {
        c.exec(`CREATE TABLE out.${table} AS SELECT ${cols.join(", ")} FROM main.${table}`);
      }
      // One index per access path of OPENCODE_QUERIES (asserted with EXPLAIN QUERY PLAN in the tests).
      c.exec("CREATE UNIQUE INDEX out.session_id ON session (id)");
      c.exec("CREATE INDEX out.session_created ON session (time_created, id)");
      c.exec("CREATE INDEX out.message_session ON message (session_id, time_created, id)");
      c.exec("CREATE INDEX out.part_message ON part (message_id, id)");
      c.exec("CREATE INDEX out.part_session ON part (session_id, message_id, id)");
    } finally {
      c.exec("DETACH DATABASE out");
    }
  } finally {
    c.close();
  }
}

/**
 * A private, consistent, stripped copy of the db, reused while the source is unchanged (same identity). Throws an
 * ENOENT error when the db does not exist, HarnessSchemaError on drift, SourceBusyError when it kept changing.
 */
export async function takeSnapshot(db: string, cacheDir: string, hooks: SnapshotHooks = {}): Promise<Snapshot> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await chmod(cacheDir, 0o700).catch(() => {});
  const tmp = join(cacheDir, "tmp");
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  await chmod(tmp, 0o700).catch(() => {});
  await sweep(tmp, /^(?:raw|out)-(\d+)-/);
  // Snapshots of an older format (unindexed `opencode-<hash>.db`) and their old temp files: never reused, deleted.
  for (const f of await readdir(cacheDir).catch(() => [] as string[])) {
    if (/^opencode-[0-9a-f]{16}\.db$/.test(f) || /^opencode-.*\.db\.\d+\.[0-9a-f]+\.tmp$/.test(f)) await rm(join(cacheDir, f), { force: true }).catch(() => {});
  }
  for (let attempt = 0; attempt < COPY_ATTEMPTS; attempt++) {
    const before = await signature(db);
    if (before === null) throw Object.assign(new Error(`${db} not found`), { code: "ENOENT" });
    const name = `${SNAPSHOT_PREFIX}${createHash("sha256").update(before).digest("hex").slice(0, 16)}.db`;
    const dest = join(cacheDir, name);
    if (await statSafe(dest)) { // only ever published complete
      await touch(dest);
      return { path: dest, identity: before };
    }
    const tag = `${process.pid}-${randomBytes(6).toString("hex")}`;
    const raw = join(tmp, `raw-${tag}.db`);
    const out = join(tmp, `out-${tag}.db`);
    try {
      await copyPrivate(db, raw);
      if (await statSafe(`${db}-wal`)) await copyPrivate(`${db}-wal`, `${raw}-wal`);
      if ((await signature(db)) !== before) continue; // written while copying: take it again
      await hooks.afterRawCopy?.();
      await buildStripped(raw, out);
      try {
        await publishNoClobber(out, dest, { link, unlink });
      } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") throw e; // another t3sm process published the same identity
      }
      // Snapshots of other source states: removed once unused for 5 minutes (mtime = last use, see touch), so a
      // concurrent run's pinned one survives; one still open on Windows stays until next time.
      for (const f of await readdir(cacheDir).catch(() => [] as string[])) {
        if (f === name || !SNAPSHOT_RE.test(f)) continue;
        const st = await stat(join(cacheDir, f)).catch(() => null);
        if (st && Date.now() - st.mtimeMs > STALE_TMP_MS) await rm(join(cacheDir, f), { force: true }).catch(() => {});
      }
      return { path: dest, identity: before };
    } finally {
      await Promise.all([raw, `${raw}-wal`, `${raw}-shm`, `${raw}-journal`, out, `${out}-journal`].map((p) => rm(p, { force: true, maxRetries: 3 })));
    }
  }
  throw new SourceBusyError(`${db} kept changing while it was copied (${COPY_ATTEMPTS} attempts); deferred to the next run`);
}

function checkSchema(db: DatabaseSync): void {
  for (const [table, cols] of Object.entries(OPENCODE_REQUIRED)) {
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    if (have.size === 0) throw new HarnessSchemaError("opencode", `opencode: table ${table} is missing (OpenCode schema changed; tested with 1.19.5)`);
    const missing = cols.filter((c) => !have.has(c));
    if (missing.length > 0) throw new HarnessSchemaError("opencode", `opencode: table ${table} lacks column(s) ${missing.join(", ")} (OpenCode schema changed; tested with 1.19.5)`);
  }
}

// ---------- discovery ----------

interface SessionRow {
  id: string; parent_id: string | null; directory: string | null; time_created: number; time_updated: number;
  messages: number; user_texts: number;
}

// A user message counts as visible when it has a non-empty text part OpenCode did not synthesize (file contents
// it injects are `synthetic`). Malformed JSON rows are skipped by json_valid instead of failing the query.
const SESSIONS_SQL = `
SELECT s.id, s.parent_id, s.directory, s.time_created, s.time_updated,
  (SELECT count(*) FROM message m WHERE m.session_id = s.id) AS messages,
  (SELECT count(*) FROM message m
    WHERE m.session_id = s.id AND json_valid(m.data) AND json_extract(m.data, '$.role') = 'user'
      AND EXISTS (SELECT 1 FROM part p WHERE p.message_id = m.id AND json_valid(p.data)
        AND json_extract(p.data, '$.type') = 'text'
        AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0 AND coalesce(json_extract(p.data, '$.ignored'), 0) = 0
        AND trim(coalesce(json_extract(p.data, '$.text'), '')) <> '')) AS user_texts
FROM session s
ORDER BY s.time_created, s.id`;

const PART_TYPES_SQL = "SELECT coalesce(json_extract(data, '$.type'), '?') AS type, count(*) AS n FROM part WHERE json_valid(data) GROUP BY 1 ORDER BY 1";
const SESSION_BY_ID_SQL = "SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ?";
const PARTS_OF_SESSION_SQL = "SELECT message_id, data FROM part WHERE session_id = ? ORDER BY message_id, id";
const MESSAGES_OF_SESSION_SQL = "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id";

/**
 * Every query the adapter runs on a snapshot. `partTypes` deliberately reads all parts (one aggregate per discovery);
 * every other access must be an index lookup (tests run EXPLAIN QUERY PLAN on each).
 */
export const OPENCODE_QUERIES = {
  sessions: SESSIONS_SQL, partTypes: PART_TYPES_SQL, sessionById: SESSION_BY_ID_SQL,
  partsOfSession: PARTS_OF_SESSION_SQL, messagesOfSession: MESSAGES_OF_SESSION_SQL,
} as const;

const iso = (ms: number): string => new Date(ms).toISOString();

// ---------- reading ----------

type Part = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** One part as text, or null when it carries nothing worth keeping (reasoning, step markers, snapshots, ...). */
function renderPart(p: Part): string | null {
  switch (p.type) {
    case "text":
      if (p.synthetic === true || p.ignored === true) return null;
      return str(p.text);
    case "tool": {
      const state = (p.state ?? {}) as Part;
      const output = state.status === "completed" ? str(state.output) ?? ""
        : state.status === "error" ? `error: ${str(state.error) ?? "unknown"}`
        : `(${str(state.status) ?? "unknown"})`;
      return toolLine(str(p.tool) ?? "unknown", toolInput(state.input), output);
    }
    case "file": {
      const url = str(p.url);
      const name = str(p.filename) ?? (url && !url.startsWith("data:") ? basename(url) : null) ?? str(p.mime) ?? "file";
      return `[attachment: ${name}]`;
    }
    case "subtask":
      return `[subtask ${str(p.agent) ?? "agent"}] ${clip(str(p.description) ?? str(p.prompt) ?? "", TOOL_TEXT_MAX)}`;
    default:
      return null; // reasoning, step-start, step-finish, snapshot, patch, compaction, retry, agent, unknown types
  }
}

function parse(json: string): Part | null {
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Part) : null;
  } catch {
    return null;
  }
}

function readTranscript(db: DatabaseSync, id: string, now: number): CanonicalTranscript {
  const s = db.prepare(SESSION_BY_ID_SQL).get(id) as
    { id: string; directory: string | null; title: string | null; time_created: number; time_updated: number } | undefined;
  if (!s) throw new Error(`opencode session ${id} not found`);
  if (isActive(s.time_updated, now)) throw new SessionActiveError(`opencode session ${id} was updated ${Math.max(0, Math.round((now - s.time_updated) / 1000))} s ago; it may be in use`);
  const parts = new Map<string, string[]>();
  for (const r of db.prepare(PARTS_OF_SESSION_SQL).all(id) as { message_id: string; data: string }[]) {
    const p = parse(r.data);
    const text = p ? renderPart(p) : null;
    if (text === null || text.trim() === "") continue;
    (parts.get(r.message_id) ?? parts.set(r.message_id, []).get(r.message_id)!).push(text);
  }
  const messages: CanonicalMessage[] = [];
  const rows = db.prepare(MESSAGES_OF_SESSION_SQL).all(id) as { id: string; time_created: number; data: string }[];
  for (const m of rows) {
    const role = parse(m.data)?.role;
    if (role !== "user" && role !== "assistant") continue;
    const texts = parts.get(m.id);
    if (!texts) continue; // nothing renderable (a reasoning-only step): no empty bubble
    messages.push({ role, text: texts.join("\n\n"), timestamp: iso(m.time_created) });
  }
  return {
    harness: "opencode", nativeId: s.id, cwd: s.directory ?? "", title: s.title, startedAt: iso(s.time_created), messages,
    activity: { updatedAt: iso(s.time_updated), messageCount: rows.length },
  };
}

// ---------- adapter ----------

export interface OpenCodeAdapter extends SourceAdapter {
  /** Problems met during the last `discover` (schema drift, unreadable db, unknown part types); never thrown. */
  lastErrors: { path: string; error: string }[];
  availability(env: Env): Promise<Availability>;
  read(s: DiscoveredSession): Promise<CanonicalTranscript>;
}

export interface OpenCodeAdapterOptions {
  /** Snapshot dir for `read()` when no discovery pinned one (default: the last discovery's, else `<t3sm state>/cache/opencode`). */
  snapshotDir?: string;
  /** Clock for read()'s active check (default Date.now). */
  now?: () => number;
  /** Replaces takeSnapshot (tests: a busy source, call counting). */
  snapshot?: Snapshotter;
}

export function createOpenCodeAdapter(opts: OpenCodeAdapterOptions = {}): OpenCodeAdapter {
  const snap: Snapshotter = opts.snapshot ?? ((db, dir) => takeSnapshot(db, dir));
  const now = opts.now ?? Date.now;
  /** The snapshot this run reads from (pinned by discovery or the first read). */
  let pin: (Snapshot & { source: string; dir: string }) | null = null;
  let lastDir: string | null = null;
  /** The per-process temp cache of read-only envs (removed after discovery and at exit). */
  let tempDir: string | null = null;

  const readOnlyDir = async (): Promise<string> => {
    if (tempDir) return tempDir;
    await sweep(tmpdir(), new RegExp(`^${TEMP_PREFIX}(\\d+)-`));
    const d = join(tmpdir(), `${TEMP_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}`);
    await mkdir(d, { recursive: true, mode: 0o700 });
    tempDir = d;
    process.once("exit", () => { try { rmSync(d, { recursive: true, force: true }); } catch { /* swept next time */ } });
    return d;
  };
  const dropReadOnlyDir = async (): Promise<void> => {
    if (!tempDir) return;
    const d = tempDir;
    tempDir = null;
    if (pin?.dir === d) pin = null;
    await rm(d, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  };
  /** Snapshot the env's db and pin it for this run. */
  const pinFor = async (env: Env, db: string): Promise<Snapshot> => {
    const dir = env.readOnly ? await readOnlyDir() : join(env.stateDir, "cache", "opencode");
    if (!env.readOnly) lastDir = dir;
    const s = await snap(db, dir);
    pin = { ...s, source: db, dir };
    return s;
  };
  const openReadOnly = async (path: string): Promise<DatabaseSync> => {
    const { DatabaseSync } = await loadSqlite();
    return new DatabaseSync(path, { readOnly: true });
  };

  const adapter: OpenCodeAdapter = {
    id: "opencode",
    mode: "convert",
    lastErrors: [],
    async availability(env: Env): Promise<Availability> {
      const db = openCodeDbPath(env);
      if (!(await statSafe(db).catch(() => null))) return "absent";
      try {
        await pinFor(env, db);
        return "ok";
      } catch (e) {
        if (e instanceof HarnessSchemaError) return { drift: e.message };
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
        return { unreadable: e instanceof Error ? e.message : String(e) };
      }
    },
    async isAvailable(env: Env): Promise<boolean> {
      return (await adapter.availability(env)) === "ok";
    },
    async watchRoots(env: Env): Promise<string[]> {
      const db = openCodeDbPath(env);
      return (await statSafe(db)) ? [dirname(db)] : [];
    },
    async *discover(env: Env): AsyncGenerator<DiscoveredSession> {
      adapter.lastErrors = [];
      const path = openCodeDbPath(env);
      let rows: SessionRow[];
      let file: SourceFile | null;
      try {
        file = await statSafe(path);
        if (!file) return;
        // Reuse the pin isAvailable just took for this env (read-only: one temp copy for both), else take one.
        const s = pin && pin.source === path && (env.readOnly ? pin.dir === tempDir : pin.dir === join(env.stateDir, "cache", "opencode")) && (await statSafe(pin.path))
          ? pin : await pinFor(env, path);
        const db = await openReadOnly(s.path);
        try {
          rows = db.prepare(SESSIONS_SQL).all() as unknown as SessionRow[];
          const unknown = (db.prepare(PART_TYPES_SQL).all() as { type: string; n: number }[]).filter((r) => !KNOWN_PART_TYPES.has(r.type));
          if (unknown.length > 0) {
            adapter.lastErrors.push({ path, error: `opencode: ${unknown.reduce((n, r) => n + r.n, 0)} part(s) of unknown type (${unknown.map((r) => r.type).join(", ")}) are left out of conversions` });
          }
        } finally {
          db.close();
        }
      } catch (e) {
        adapter.lastErrors.push({ path, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
        if (env.readOnly) await dropReadOnlyDir();
        return;
      }
      if (env.readOnly) await dropReadOnlyDir(); // read-only discovery leaves nothing behind
      for (const r of rows) {
        if (r.messages === 0) continue; // an opened-and-abandoned session: nothing to convert
        const flags: SessionFlag[] = [];
        if (r.parent_id) flags.push("subagent"); // a subagent's child session belongs to its parent's conversation
        if (!r.directory) flags.push("no-cwd");
        if (r.user_texts === 0) flags.push("only-hidden");
        if (isActive(r.time_updated, env.now())) flags.push("active");
        yield {
          harness: "opencode", accountId: null, nativeId: r.id, cwd: r.directory ? r.directory : null,
          startedAt: iso(r.time_created), updatedAt: iso(r.time_updated),
          messageCount: r.messages, corruptLines: 0, file: { ...file }, flags,
          cwdOffsetBytes: 0, // the converted transcript carries cwd on its first record
        };
      }
    },
    async read(s: DiscoveredSession): Promise<CanonicalTranscript> {
      const repin = async (): Promise<string> => {
        const dir = pin?.source === s.file.path ? pin.dir : opts.snapshotDir ?? lastDir ?? join(stateDir(process.env, homedir()), "cache", "opencode");
        const taken = await snap(s.file.path, dir);
        pin = { ...taken, source: s.file.path, dir };
        return taken.path;
      };
      let snapPath: string;
      if (pin && pin.source === s.file.path) {
        snapPath = pin.path;
        await touch(snapPath); // in use: age = time since last use
      } else snapPath = await repin();
      for (let attempt = 0; ; attempt++) {
        let db: DatabaseSync;
        try {
          db = await openReadOnly(snapPath);
        } catch (e) {
          // The pinned snapshot vanished (pruned by a concurrent run, removed by hand): re-pin once, then fail.
          if (attempt === 0 && vanished(e)) { snapPath = await repin(); continue; }
          throw e;
        }
        try {
          return readTranscript(db, s.nativeId, now());
        } finally {
          db.close();
        }
      }
    },
  };
  return adapter;
}

export const opencodeAdapter: OpenCodeAdapter = createOpenCodeAdapter();
