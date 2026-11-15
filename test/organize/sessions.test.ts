import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSessions } from "../../src/organize/sessions.ts";
import type { JournalEntry } from "../../src/core/types.ts";
import type { T3Thread } from "../../src/t3/api.ts";
import { sess } from "../plan/helpers.ts";

// Synthetic fixtures only: invented ids, `C:/Users/demo` homes.

const thread = (id: string, o: Partial<T3Thread> = {}): T3Thread => ({ id, projectId: "p1", instanceId: "x", archived: false, title: "<command-name>/clear</command-name>", ...o });
const instances = [
  { instanceId: "claudeAgent", driver: "claudeAgent", homePath: "C:\\Users\\demo\\.claude" },
  { instanceId: "work", driver: "claudeAgent", homePath: "C:/Users/demo/.claude-work" },
  { instanceId: "codex", driver: "codex", homePath: null },
];
const accounts = [{ id: "claudeAgent", home: "C:/Users/demo/.claude" }, { id: "claude-work", home: "C:/Users/demo/.claude-work" }];

test("matchSessions: by instance home and id (a backup copy only as a last resort), journal path as fallback; other drivers silent", async () => {
  const human = sess({ nativeId: "s1", accountId: "claudeAgent", path: "C:/Users/demo/.claude/projects/x/s1.jsonl" });
  const backup = { ...sess({ nativeId: "s1", accountId: "claudeAgent", path: "C:/Users/demo/.claude/projects/x.bak/s1.jsonl", flags: ["backup-copy"] }), origin: "automated" as const };
  const bot = { ...sess({ nativeId: "s2", accountId: "claude-work", path: "C:/Users/demo/.claude-work/projects/y/s2.jsonl" }), origin: "automated" as const };
  const moved = { ...sess({ nativeId: "other-id", accountId: "claudeAgent", path: "C:/Users/demo/.claude/projects/z/s3.jsonl" }), origin: "automated" as const };
  const journal: JournalEntry[] = [{ t: "imported", runId: "r", harness: "claude", nativeId: "s3", threadId: "import:claudeAgent:s3", source: { path: "c:\\users\\demo\\.claude\\projects\\z\\s3.jsonl", size: 1, mtimeMs: 1 } }];
  const read: string[] = [];
  const r = await matchSessions({
    threads: [
      thread("import:claudeAgent:s1"), thread("import:work:s2"), thread("import:claudeAgent:s3"),
      thread("import:codex:c1"), thread("import:claudeAgent:nowhere"), thread("native-1"),
      thread("import:claudeAgent:s1x", { title: "Already tidy" }),
    ],
    instances, accounts, discovered: [backup, human, bot, moved, sess({ nativeId: "s1x", accountId: "claudeAgent" })], journal,
    title: async (f) => { read.push(f); return `T ${f.split("/").pop()}`; }, platform: "win32",
  });
  assert.deepEqual([...r.sessions.entries()], [
    ["import:claudeAgent:s1", { origin: "human", title: "T s1.jsonl" }],
    ["import:work:s2", { origin: "automated", title: "T s2.jsonl" }],
    ["import:claudeAgent:s3", { origin: "automated", title: "T s3.jsonl" }],
    ["import:claudeAgent:nowhere", { origin: "human", title: null }],
    ["import:claudeAgent:s1x", { origin: "human", title: null }],
  ]);
  assert.equal(r.missing, 1);
  assert.equal(read.length, 3, "a tidy title is not re-read; nothing read for the missing one");
});

test("matchSessions: titles off reads no transcript; a title t3sm set earlier is read again", async () => {
  const s = sess({ nativeId: "s1", accountId: "claudeAgent", path: "C:/Users/demo/.claude/projects/x/s1.jsonl" });
  const off = await matchSessions({ threads: [thread("import:claudeAgent:s1")], instances, accounts, discovered: [s], journal: [], title: null, platform: "win32" });
  assert.deepEqual(off.sessions.get("import:claudeAgent:s1"), { origin: "human", title: null });
  const ours: JournalEntry = { t: "organize-change", runId: "r", kind: "title", target: "import:claudeAgent:s1", previous: "<x>", next: "Old proposal" };
  const again = await matchSessions({
    threads: [thread("import:claudeAgent:s1", { title: "Old proposal" })], instances, accounts, discovered: [s], journal: [ours],
    title: async () => "New proposal", platform: "win32",
  });
  assert.deepEqual(again.sessions.get("import:claudeAgent:s1"), { origin: "human", title: "New proposal" });
});

test("matchSessions: an instance T3 reports without a home (implicit, not resolved yet) maps to the account with its id", async () => {
  const bot = { ...sess({ nativeId: "s9", accountId: "claudeAgent", path: "C:/Users/demo/.claude/projects/x/s9.jsonl" }), origin: "automated" as const };
  const r = await matchSessions({
    threads: [thread("import:claudeAgent:s9"), thread("import:unknown:s9")],
    instances: [{ instanceId: "claudeAgent", driver: "claudeAgent", homePath: null }],
    accounts: [{ id: "claudeAgent", home: "~/.claude" }], userHome: "C:/Users/demo",
    discovered: [bot], journal: [], title: async () => "Summarize the file", platform: "win32",
  });
  assert.deepEqual(r.sessions.get("import:claudeAgent:s9"), { origin: "automated", title: "Summarize the file" });
  assert.equal(r.missing, 1, "an instance with no account at all is still reported");
});
