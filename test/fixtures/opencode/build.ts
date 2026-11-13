// Builds a synthetic OpenCode database for the adapter tests, generated at test time into a temp dir (no binary is
// committed). The DDL is copied verbatim from OpenCode 1.19.5 (the tables the adapter reads; see docs/harnesses.md);
// the rows are synthetic (no personal data, `C:/work/demo` style paths).
//
// Sessions:
//   ses_a      C:/work/demo   user (text + attachment), assistant (reasoning + tool + text, step parts),
//                             user (text, plus a synthetic text part), assistant (text)
//   ses_b      C:/work/other  user (accented text), assistant (text)
//   ses_empty  C:/work/demo   no messages at all (ignored by discovery)
//   ses_child  C:/work/demo   a subagent session (parent_id = ses_a)
//   ses_hidden C:/work/demo   only an assistant message (no user text)
//
// Run directly (`node test/fixtures/opencode/build.ts <out.db>`) to inspect the fixture by hand.

import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);

/** OpenCode 1.19.5 DDL for the tables the adapter reads (plus `project`, which `session` references). */
export const OPENCODE_1_19_DDL = [
  `CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        )`,
  `CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        )`,
  `CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        )`,
  "CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`)",
  `CREATE TABLE \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        )`,
  "CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`)",
  "CREATE INDEX `part_session_idx` ON `part` (`session_id`)",
  "CREATE INDEX `session_parent_idx` ON `session` (`parent_id`)",
  // Not read by the adapter; present so the tests can prove its secrets never reach t3sm's cache.
  `CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        )`,
];

/** Secret-looking values planted in columns and tables the adapter never reads (byte-level leak tests). */
export const MARKERS = {
  accessToken: "MARKER-ACCESS-TOKEN-7f3a9c",
  refreshToken: "MARKER-REFRESH-TOKEN-51be02",
  shareUrl: "MARKER-SHARE-URL-c0ffee",
  permission: "MARKER-PERMISSION-d00d",
  metadata: "MARKER-METADATA-feed42",
} as const;

export const TOOL_OUTPUT = `total 8\n${"-rw-r--r-- 1 demo demo 120 notas.txt\n".repeat(20)}`;

interface Msg { id: string; role: "user" | "assistant"; at: number; parts: Record<string, unknown>[] }
interface Ses { id: string; parent?: string; dir: string; title: string; created: number; updated: number; messages: Msg[] }

const user = (id: string, at: number, ...parts: Record<string, unknown>[]): Msg => ({ id, role: "user", at, parts });
const asst = (id: string, at: number, ...parts: Record<string, unknown>[]): Msg => ({ id, role: "assistant", at, parts });
const text = (t: string, extra: Record<string, unknown> = {}) => ({ type: "text", text: t, ...extra });
const step = (kind: "start" | "finish") => (kind === "start" ? { type: "step-start", snapshot: "0" } : { type: "step-finish", reason: "stop", snapshot: "0", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 }, total: 2 } });

export const SESSIONS: Ses[] = [
  {
    id: "ses_a", dir: "C:/work/demo", title: "List the files", created: T0, updated: T0 + 40_000,
    messages: [
      user("msg_a1", T0 + 1000, text("List the files, please."), { type: "file", mime: "text/plain", filename: "notes.txt", url: "file:///C:/work/demo/notes.txt" }),
      asst("msg_a2", T0 + 2000, step("start"), { type: "reasoning", text: "I should run ls.", time: { start: T0 + 2000, end: T0 + 2100 } },
        { type: "tool", callID: "call_1", tool: "bash", state: { status: "completed", input: { command: "ls -la" }, output: TOOL_OUTPUT, title: "ls", metadata: { exit: 0, output: TOOL_OUTPUT, truncated: false }, time: { start: T0 + 2100, end: T0 + 2200 } } },
        text("There is one file: notas.txt."), step("finish")),
      user("msg_a3", T0 + 30_000, text("Thanks!"), text("<file contents injected by OpenCode>", { synthetic: true })),
      asst("msg_a4", T0 + 40_000, step("start"),
        { type: "tool", callID: "call_2", tool: "grep", state: { status: "error", input: { pattern: "TODO", include: "*.ts" }, error: "No files found", time: { start: T0 + 39_000, end: T0 + 39_100 } } },
        text("You're welcome."), step("finish")),
    ],
  },
  {
    id: "ses_b", dir: "C:/work/other", title: "Ação", created: T0 + 100_000, updated: T0 + 102_000,
    messages: [
      user("msg_b1", T0 + 101_000, text("Olá: ação, coração, pão 🍞✅")),
      asst("msg_b2", T0 + 102_000, text("Tudo certo — ação concluída.")),
    ],
  },
  { id: "ses_empty", dir: "C:/work/demo", title: "New session", created: T0 + 200_000, updated: T0 + 200_000, messages: [] },
  {
    id: "ses_child", parent: "ses_a", dir: "C:/work/demo", title: "Subagent", created: T0 + 2100, updated: T0 + 2900,
    messages: [user("msg_c1", T0 + 2200, text("Find the files.")), asst("msg_c2", T0 + 2900, text("notas.txt"))],
  },
  {
    id: "ses_hidden", dir: "C:/work/demo", title: "Hidden", created: T0 + 300_000, updated: T0 + 301_000,
    messages: [asst("msg_h1", T0 + 301_000, text("Hello?"))],
  },
];

/**
 * Creates `path` with the OpenCode 1.19.5 tables and the synthetic sessions above. `ddl` swaps the schema (drift tests).
 * One transaction: autocommit would sync the disk once per row (~40 per db), which on a slow CI disk made
 * opencode.test.ts outrun its 60 s file budget.
 */
export function buildOpenCodeDb(path: string, o: { ddl?: string[]; sessions?: Ses[]; wal?: boolean } = {}): void {
  const db = new DatabaseSync(path);
  try {
    if (o.wal) db.exec("PRAGMA journal_mode=WAL"); // not allowed inside a transaction
    db.exec("BEGIN");
    fill(db, o);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

function fill(db: DatabaseSync, o: { ddl?: string[]; sessions?: Ses[] }): void {
  {
    for (const sql of o.ddl ?? OPENCODE_1_19_DDL) db.exec(sql);
    if (o.ddl) return;
    db.prepare("INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (?, ?, 'git', ?, ?, '[]')").run("prj_demo", "C:/work/demo", T0, T0);
    db.prepare("INSERT INTO account (id, email, url, access_token, refresh_token, time_created, time_updated) VALUES ('acc_1', 'demo@example.com', 'https://example.com', ?, ?, ?, ?)")
      .run(MARKERS.accessToken, MARKERS.refreshToken, T0, T0);
    const ses = db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, share_url, permission, metadata)
      VALUES (?, 'prj_demo', ?, ?, ?, ?, '1.19.5', ?, ?, '${MARKERS.shareUrl}', '${MARKERS.permission}', '${MARKERS.metadata}')`);
    const msg = db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)");
    const part = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)");
    for (const s of o.sessions ?? SESSIONS) {
      ses.run(s.id, s.parent ?? null, s.id.replace("ses_", "slug-"), s.dir, s.title, s.created, s.updated);
      for (const m of s.messages) {
        const data = m.role === "user"
          ? { role: "user", time: { created: m.at }, agent: "build", model: { providerID: "demo", modelID: "demo-1" }, summary: { diffs: [] } }
          : { role: "assistant", time: { created: m.at, completed: m.at }, parentID: "x", modelID: "demo-1", providerID: "demo", mode: "build", agent: "build", path: { cwd: s.dir, root: s.dir }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 }, total: 2 }, finish: "stop" };
        msg.run(m.id, s.id, m.at, m.at, JSON.stringify(data));
        m.parts.forEach((p, k) => part.run(`prt_${m.id.slice(4)}_${String(k).padStart(2, "0")}`, m.id, s.id, m.at, m.at, JSON.stringify(p)));
      }
    }
  }
}

/** A large synthetic db (perf tests): `sessions` x `messages` x `parts`, alternating user/assistant, text + tool parts. */
export function buildBulkOpenCodeDb(path: string, n: { sessions: number; messages: number; parts: number }): void {
  const db = new DatabaseSync(path);
  try {
    for (const sql of OPENCODE_1_19_DDL) db.exec(sql);
    db.exec("BEGIN");
    db.prepare("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('prj_bulk', 'C:/work/bulk', 0, 0, '[]')").run();
    const ses = db.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'prj_bulk', 's', 'C:/work/bulk', 't', '1.19.5', ?, ?)");
    const msg = db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)");
    const part = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)");
    for (let s = 0; s < n.sessions; s++) {
      const sid = `ses_${String(s).padStart(6, "0")}`;
      ses.run(sid, T0 + s, T0 + s + n.messages);
      for (let m = 0; m < n.messages; m++) {
        const mid = `msg_${sid}_${String(m).padStart(4, "0")}`;
        const at = T0 + s + m;
        msg.run(mid, sid, at, at, JSON.stringify({ role: m % 2 ? "assistant" : "user", time: { created: at } }));
        for (let p = 0; p < n.parts; p++) {
          const data = p === 0 ? { type: "text", text: `message ${m} of ${sid}` }
            : { type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "a.txt" } };
          part.run(`prt_${mid}_${p}`, mid, sid, at, at, JSON.stringify(data));
        }
      }
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) buildOpenCodeDb(process.argv[2] ?? "opencode.db");
