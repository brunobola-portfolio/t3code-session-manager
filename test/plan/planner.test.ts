import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { buildPlan, type PlanInput } from "../../src/plan/planner.ts";
import type { CopyRelation } from "../../src/plan/dedupe.ts";
import type { Config, DiscoveredSession, InstanceSpec, JournalEntry, OrganizeConfig, Plan, PlanItem, SessionFlag } from "../../src/core/types.ts";
import type { T3Project, T3Thread } from "../../src/t3/api.ts";
import type { FolderEnv } from "../../src/plan/folders.ts";
import { DAY, HOME, NOW, cfg, projectScratch, sess, uuid } from "./helpers.ts";

const personal: InstanceSpec = { id: "claudeAgent", driver: "claudeAgent", displayName: "Claude", accentColor: null, homePath: `${HOME}/.claude`, environment: [] };
const org: InstanceSpec = { id: "claude-org", driver: "claudeAgent", displayName: "Org", accentColor: null, homePath: `${HOME}/.claude-org`, environment: [] };
const providers = [{ instanceId: "codex", driver: "codex" }, { instanceId: "pi", driver: "pi" }];

interface Over {
  sessions: DiscoveredSession[]; config?: Partial<Config>; projects?: T3Project[]; threads?: T3Thread[];
  instances?: InstanceSpec[]; providers?: { instanceId: string; driver: string }[]; journal?: JournalEntry[];
  missing?: string[]; pins?: Record<string, string>; compare?: Record<string, CopyRelation>;
  labels?: Record<string, string[]>;
  folderEnv?: FolderEnv; lang?: "en" | "pt";
}

/** Deterministic folder classification for every planner test (never the machine's real tmpdir / env). */
const FENV: FolderEnv = {
  platform: "win32", home: HOME, tmpdir: `${HOME}/AppData/Local/Temp`,
  env: { WINDIR: "C:/Windows", ProgramFiles: "C:/Program Files", ProgramData: "C:/ProgramData" },
  t3BaseDir: `${HOME}/.t3`, t3WorktreesDir: `${HOME}/.t3/worktrees`,
};

function input(o: Over): PlanInput {
  return {
    sessions: o.sessions, config: cfg(o.config),
    t3: { version: "0.1.9", projects: o.projects ?? [], threads: o.threads ?? [], instances: o.instances ?? [personal, org], providers: o.providers ?? providers },
    journal: o.journal ?? [], now: NOW, runId: "run-1",
    existsDir: async (p) => !(o.missing ?? []).some((m) => m.toLowerCase() === p.toLowerCase()),
    readVscodePin: async (root) => o.pins?.[root] ?? null,
    compareCopies: async (a, b) => {
      const r = o.compare?.[`${a}|${b}`];
      if (r) return r;
      const rev = o.compare?.[`${b}|${a}`];
      if (!rev) throw new Error(`unexpected compare ${a} vs ${b}`);
      return rev === "a-extends-b" ? "b-extends-a" : rev === "b-extends-a" ? "a-extends-b" : rev;
    },
    labelRecords: async (p) => new Set(o.labels?.[p] ?? []),
    platform: "win32", home: HOME, folderEnv: o.folderEnv ?? FENV, ...(o.lang ? { lang: o.lang } : {}),
  };
}
const plan = (o: Over): Promise<Plan> => buildPlan(input(o));
const only = (p: Plan): PlanItem => { assert.equal(p.items.length, 1); return p.items[0]!; };
const project = (id: string, root: string, over: Partial<T3Project> = {}): T3Project =>
  ({ id, title: root.split("/").pop()!, workspaceRoot: root, defaultModelSelection: null, archived: false, deleted: false, pinned: false, createdAt: null, ...over });
const thread = (id: string, over: Partial<T3Thread> = {}): T3Thread => ({ id, projectId: "p1", instanceId: "claudeAgent", archived: false, title: "t", ...over });

// ---------- skip rules (table, in precedence order) ----------
const skipCases: { name: string; s: () => DiscoveredSession; over?: Partial<Over>; want: string }[] = [
  { name: "exclude glob on cwd", s: () => sess({ cwd: "C:/work/secret/x" }), over: { config: { exclude: ["C:/work/secret/**"] } }, want: "excluded" },
  { name: "exclude beats backup", s: () => sess({ cwd: "C:/work/secret", flags: ["backup-copy"] }), over: { config: { exclude: ["**/secret"] } }, want: "excluded" },
  { name: "backup-copy", s: () => sess({ flags: ["backup-copy", "active"] }), want: "backup-copy" },
  { name: "subagent beats active", s: () => sess({ flags: ["subagent", "active"] }), want: "subagent" },
  { name: "subagent beats compressed", s: () => sess({ harness: "codex", flags: ["subagent", "compressed"] }), want: "subagent" },
  { name: "compressed beats active", s: () => sess({ harness: "codex", cwd: null, flags: ["compressed", "active", "no-session-id", "no-cwd"] }), want: "compressed" },
  { name: "active beats non-uuid", s: () => sess({ flags: ["active", "non-uuid-id"] }), want: "active" },
  { name: "non-uuid-id (claude)", s: () => sess({ nativeId: "not-a-uuid", flags: ["non-uuid-id", "no-session-id"] }), want: "non-uuid-id" },
  { name: "no-session-id", s: () => sess({ harness: "codex", flags: ["no-session-id", "only-hidden"] }), want: "no-session-id" },
  { name: "only-hidden", s: () => sess({ flags: ["only-hidden", "over-4gib"] }), want: "only-hidden" },
  { name: "over-4gib", s: () => sess({ flags: ["over-4gib", "no-cwd"], cwd: null }), want: "over-4gib" },
  { name: "no-cwd", s: () => sess({ cwd: null, flags: ["no-cwd", "cwd-unreadable"] }), want: "no-cwd" },
  { name: "cwd-unreadable", s: () => sess({ flags: ["cwd-unreadable"] }), want: "cwd-unreadable" },
  { name: "cwd-missing", s: () => sess({ cwd: "C:/gone/x" }), over: { missing: ["C:/gone/x"] }, want: "cwd-missing" },
  { name: "cwd-missing checks the remapped cwd", s: () => sess({ cwd: "E:/old/x" }), over: { config: { remap: [{ from: "E:/old", to: "C:/gone" }] }, missing: ["C:/gone/x"] }, want: "cwd-missing" },
  { name: "harness-unavailable: codex without a codex instance", s: () => sess({ harness: "codex" }), over: { providers: [] }, want: "harness-unavailable" },
  { name: "harness-unavailable: claude account not in config", s: () => sess({ accountId: "claude-ghost" }), want: "harness-unavailable" },
];
for (const c of skipCases) {
  test(`buildPlan skip: ${c.name}`, async () => {
    const it = only(await plan({ sessions: [c.s()], ...c.over }));
    assert.deepEqual(it.action, { kind: "skip", reason: c.want });
  });
}

test("buildPlan: a compressed Codex rollout is skipped without a copy compare against its uncompressed twin, and is not counted toward the T3 cap", async () => {
  const id = uuid(77);
  const plain = sess({ harness: "codex", nativeId: id, path: "C:/Users/demo/.codex/sessions/2026/01/01/a.jsonl" });
  const zst = sess({ harness: "codex", nativeId: id, cwd: null, path: "C:/Users/demo/.codex/sessions/2026/01/01/a.jsonl.zst", flags: ["compressed"] });
  const p = await plan({ sessions: [plain, zst] }); // compareCopies throws on any unexpected compare
  assert.deepEqual(p.items.find((i) => i.session === zst)!.action, { kind: "skip", reason: "compressed" });
  assert.equal(p.items.find((i) => i.session === plain)!.action.kind, "import");
  assert.deepEqual(p.items.find((i) => i.session === plain)!.notes, []);
  // T3 only lists rollout-*.jsonl, so compressed files never count toward its 5000-per-source scan cap.
  const many = Array.from({ length: 5001 }, (_, n) => sess({ harness: "codex", cwd: null, path: `C:/x/${n}.jsonl.zst`, flags: ["compressed"] }));
  assert.deepEqual((await plan({ sessions: many })).warnings, []);
});

// ---------- Codex compressed rollouts (convert mode per session) ----------
const zstPath = (id: string) => `C:/Users/demo/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-${id}.jsonl.zst`;
const compressed = (id: string, over: Partial<DiscoveredSession> = {}): DiscoveredSession =>
  ({ ...sess({ harness: "codex", nativeId: id, accountId: null, path: zstPath(id), flags: ["compressed"] }), mode: "convert", cwdOffsetBytes: 0, ...over });

test("buildPlan: a convertible compressed Codex session is convert-import into its project's account, uuid from codex:<id>", async () => {
  const { uuidV5 } = await import("../../src/core/uuid.ts");
  const id = uuid(500);
  const it = only(await plan({ sessions: [compressed(id)], pins: { "C:/work/demo": "~/.claude-org" }, providers: [] }));
  const u = uuidV5(`codex:${id}`);
  if (it.action.kind !== "convert-import") throw new Error(`expected convert-import, got ${JSON.stringify(it.action)}`);
  const { targetFile, ...rest } = it.action;
  assert.deepEqual(rest, { kind: "convert-import", projectRoot: "C:/work/demo", instanceId: "claude-org", expectedThreadId: `import:claude-org:${u}`, uuid: u });
  assert.equal(targetFile.replace(/\\/g, "/"), `${HOME}/.claude-org/projects/C--work-demo/${u}.jsonl`);
});

test("buildPlan: compressed sessions keep their skip reasons (subagent, no-session-id, too-large); conversion off -> compressed", async () => {
  const id = uuid(501);
  const reasons = async (s: DiscoveredSession) => only(await plan({ sessions: [s] })).action;
  assert.deepEqual(await reasons(compressed(id, { flags: ["compressed", "subagent"], cwd: null })), { kind: "skip", reason: "subagent" });
  assert.deepEqual(await reasons(compressed(id, { flags: ["compressed", "no-session-id"] })), { kind: "skip", reason: "no-session-id" });
  assert.deepEqual(await reasons(compressed(id, { flags: ["compressed", "too-large"] })), { kind: "skip", reason: "too-large" });
  assert.deepEqual(await reasons(compressed(id, { flags: ["compressed", "active"] })), { kind: "skip", reason: "active" });
  // A second rollout file of one session (discovery planned the other): duplicate, before anything else about it.
  assert.deepEqual(await reasons(compressed(id, { flags: ["compressed", "duplicate-file", "subagent"] })), { kind: "skip", reason: "duplicate" });
  const off = { ...compressed(id, { cwd: null }) } as DiscoveredSession;
  delete off.mode;
  assert.deepEqual(await reasons(off), { kind: "skip", reason: "compressed" });
});

test("buildPlan: the converted transcript of a compressed Codex session is not rediscovered as a native session; once in T3 both are already-in-t3", async () => {
  const id = uuid(502);
  const cx = compressed(id);
  const first = only(await plan({ sessions: [cx] }));
  if (first.action.kind !== "convert-import") throw new Error("expected convert-import");
  const target = first.action.targetFile;
  const claudeCopy = sess({ nativeId: first.action.uuid, path: target, accountId: "claudeAgent" });
  const journal: JournalEntry[] = [{ t: "file-written", runId: "r0", path: target, sha256: "0".repeat(64), mtimeMs: 1,
    source: { harness: "codex", nativeId: id, updatedAt: cx.updatedAt, messageCount: cx.messageCount } }];
  const p = await plan({ sessions: [cx, claudeCopy], journal });
  assert.equal(p.items.find((i) => i.session === cx)!.action.kind, "convert-import");
  assert.deepEqual(p.items.find((i) => i.session === claudeCopy)!.action, { kind: "skip", reason: "converted" });
  const p2 = await plan({ sessions: [cx, claudeCopy], journal, threads: [thread(first.action.expectedThreadId)] });
  assert.deepEqual(p2.items.map((i) => i.action), [{ kind: "skip", reason: "already-in-t3" }, { kind: "skip", reason: "already-in-t3" }]);
  assert.deepEqual(p2.items.flatMap((i) => i.notes), []);
  // Continued in Codex after the conversion (compressed again with more messages): continued-outside-t3.
  const more = compressed(id, { messageCount: cx.messageCount + 2, updatedAt: new Date(NOW - DAY).toISOString() });
  const p3 = await plan({ sessions: [more], journal, threads: [thread(first.action.expectedThreadId)] });
  assert.deepEqual(only(p3).notes, ["continued-outside-t3"]);
});

// One Codex session, two forms: its native id (a Codex thread) and its convert uuid (a converted Claude thread).
test("E1: a Codex session imported natively and later compressed by Codex stays one thread (in-t3-as-other-form, never a Claude copy)", async () => {
  const id = uuid(900);
  const plainPath = zstPath(id).replace(".zst", "");
  const imported = (runId: string): JournalEntry => ({ t: "imported", runId, harness: "codex", nativeId: id, threadId: `import:codex:${id}`, source: { path: plainPath, size: 10, mtimeMs: 1 } });
  const s = compressed(id, { updatedAt: new Date(NOW - 60 * DAY).toISOString() });
  // Imported natively on 2026-10-01; last activity 2026-09-12: nothing new since.
  const it = only(await plan({ sessions: [s], threads: [thread(`import:codex:${id}`, { instanceId: "codex" })], journal: [imported("20261001-000000-aaaa")] }));
  assert.deepEqual(it.action, { kind: "skip", reason: "already-in-t3" });
  assert.deepEqual(it.notes, ["in-t3-as-other-form"]);
  // Continued in Codex after that import (its activity is newer than the import run): continued-outside-t3 too.
  const later = compressed(id, { updatedAt: new Date(NOW - DAY).toISOString() });
  const it2 = only(await plan({ sessions: [later], threads: [thread(`import:codex:${id}`, { instanceId: "codex" })], journal: [imported("20261001-000000-aaaa")] }));
  assert.deepEqual(it2.action, { kind: "skip", reason: "already-in-t3" });
  assert.deepEqual(it2.notes, ["continued-outside-t3", "in-t3-as-other-form"]);
  // Under any instance: the thread of another Codex instance counts too.
  const it3 = only(await plan({ sessions: [s], threads: [thread(`import:codexWork:${id}`, { instanceId: "codexWork" })] }));
  assert.deepEqual([it3.action, it3.notes], [{ kind: "skip", reason: "already-in-t3" }, ["in-t3-as-other-form"]]);
});

test("E2: a Codex session started inside T3 (nativeSessionId) and later compressed is already in T3", async () => {
  const id = uuid(901);
  const it = only(await plan({ sessions: [compressed(id)], threads: [thread("some-t3-thread", { instanceId: "codex", nativeSessionId: id } as Partial<T3Thread>)] }));
  assert.deepEqual([it.action, it.notes], [{ kind: "skip", reason: "already-in-t3" }, ["in-t3-as-other-form"]]);
});

test("E3: a converted compressed session later seen as a plain .jsonl is not imported a second time natively", async () => {
  const { uuidV5 } = await import("../../src/core/uuid.ts");
  const id = uuid(902);
  const u = uuidV5(`codex:${id}`);
  const plain = sess({ harness: "codex", nativeId: id, accountId: null, path: `C:/Users/demo/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-${id}.jsonl` });
  const written = (messageCount: number): JournalEntry => ({ t: "file-written", runId: "r0", path: `C:/Users/demo/.claude/projects/C--work-demo/${u}.jsonl`, sha256: "0".repeat(64), mtimeMs: 1, source: { harness: "codex", nativeId: id, updatedAt: plain.updatedAt, messageCount } });
  const it = only(await plan({ sessions: [plain], journal: [written(plain.messageCount)], threads: [thread(`import:claudeAgent:${u}`)] }));
  assert.deepEqual([it.action, it.notes], [{ kind: "skip", reason: "already-in-t3" }, ["in-t3-as-other-form"]]);
  const more = only(await plan({ sessions: [plain], journal: [written(plain.messageCount - 2)], threads: [thread(`import:claudeAgent:${u}`)] }));
  assert.deepEqual(more.notes, ["continued-outside-t3", "in-t3-as-other-form"]);
  // The converted thread under another Claude account counts as well; no thread at all: imported natively.
  const org = only(await plan({ sessions: [plain], threads: [thread(`import:claude-org:${u}`, { instanceId: "claude-org" })] }));
  assert.deepEqual(org.action, { kind: "skip", reason: "already-in-t3" });
  assert.equal(only(await plan({ sessions: [plain] })).action.kind, "import");
});

test("dual forms: only harnesses with both a native driver and a converter have two forms (OpenCode and Pi do not)", async () => {
  const { sessionForms } = await import("../../src/plan/planner.ts");
  const { uuidV5 } = await import("../../src/core/uuid.ts");
  assert.deepEqual(sessionForms("codex", "x"), ["x", uuidV5("codex:x")]);
  assert.deepEqual(sessionForms("opencode", "x"), [uuidV5("opencode:x")]);
  assert.deepEqual(sessionForms("pi", "x"), ["x"]);
  assert.deepEqual(sessionForms("claude", "x"), ["x"]);
});

test("buildPlan: compressed Codex sessions never count toward the T3 per-source cap, convertible or not", async () => {
  const many = Array.from({ length: 5001 }, (_, n) => compressed(uuid(10_000 + n), { cwd: null, flags: ["compressed", "no-cwd"] }));
  assert.deepEqual((await plan({ sessions: many })).warnings, []);
});

test("buildPlan: includeBackups imports a backup copy", async () => {
  const it = only(await plan({ sessions: [sess({ flags: ["backup-copy"] })], config: { includeBackups: true } }));
  assert.equal(it.action.kind, "import");
});

// ---------- import ----------
test("buildPlan: claude session imports to the instance whose home is its account home", async () => {
  const s = sess({ accountId: "claude-org", cwd: "c:\\work\\demo\\" });
  const it = only(await plan({ sessions: [s] }));
  assert.deepEqual(it.action, { kind: "import", projectRoot: "C:/work/demo", instanceId: "claude-org", expectedThreadId: `import:claude-org:${s.nativeId}` });
});

test("buildPlan: account matched by home, not by id (T3 instance id differs from config id)", async () => {
  const s = sess({ accountId: "claude-org" });
  const it = only(await plan({ sessions: [s], instances: [personal, { ...org, id: "orgInstance", homePath: `${HOME}/.Claude-Org/` }] }));
  assert.equal(it.action.kind === "import" && it.action.instanceId, "orgInstance");
});

test("buildPlan: codex and pi use the T3 instance of their driver", async () => {
  const c = sess({ harness: "codex", nativeId: "codex-id" });
  const p = sess({ harness: "pi", nativeId: "pi-id", cwd: "C:/work/pi" });
  const out = await plan({ sessions: [c, p], providers: [{ instanceId: "codexMain", driver: "codex" }, { instanceId: "pi", driver: "pi" }] });
  const by = new Map(out.items.map((i) => [i.session.nativeId, i.action]));
  assert.deepEqual(by.get("codex-id"), { kind: "import", projectRoot: "C:/work/demo", instanceId: "codexMain", expectedThreadId: "import:codexMain:codex-id" });
  assert.deepEqual(by.get("pi-id"), { kind: "import", projectRoot: "C:/work/pi", instanceId: "pi", expectedThreadId: "import:pi:pi-id" });
});

test("buildPlan: convert-mode (opencode) uses the project account's instance and a uuid", async () => {
  const s = sess({ harness: "opencode", nativeId: "ses_1", accountId: null });
  const it = only(await plan({ sessions: [s], pins: { "C:/work/demo": "~/.claude-org" } }));
  assert.equal(it.action.kind, "convert-import");
  if (it.action.kind !== "convert-import") return;
  assert.equal(it.action.instanceId, "claude-org");
  assert.match(it.action.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5/);
  assert.equal(it.action.expectedThreadId, `import:claude-org:${it.action.uuid}`);
  assert.equal(it.action.targetFile.replace(/\\/g, "/"), `${HOME}/.claude-org/projects/C--work-demo/${it.action.uuid}.jsonl`);
});

// ---------- already in T3 ----------
test("buildPlan: expected thread present (archived counts) -> already-in-t3", async () => {
  const s = sess();
  const it = only(await plan({ sessions: [s], threads: [thread(`import:claudeAgent:${s.nativeId}`, { archived: true })] }));
  assert.deepEqual(it.action, { kind: "skip", reason: "already-in-t3" });
  assert.deepEqual(it.notes, []);
});

test("buildPlan: a session started inside T3 (thread's native ref = this session, same instance) -> already-in-t3", async () => {
  const s = sess();
  const it = only(await plan({ sessions: [s], threads: [thread("t3-own-uuid", { nativeSessionId: s.nativeId })] }));
  assert.deepEqual(it.action, { kind: "skip", reason: "already-in-t3" });
  // Under another instance it is the same session too (B12): never imported a second time, listed for review.
  const other = only(await plan({ sessions: [s], threads: [thread("t3-own-uuid", { nativeSessionId: s.nativeId, instanceId: "claude-org" })] }));
  assert.deepEqual([other.action, other.notes], [{ kind: "skip", reason: "already-in-t3" }, ["in-t3-under-other-account"]]);
});

test("buildPlan: already-in-t3 and the file changed since import -> continued-outside-t3", async () => {
  const s = sess({ size: 2000 });
  const journal: JournalEntry[] = [{ t: "imported", runId: "r0", harness: "claude", nativeId: s.nativeId, threadId: `import:claudeAgent:${s.nativeId}`, source: { path: s.file.path, size: 1000, mtimeMs: s.file.mtimeMs } }];
  const it = only(await plan({ sessions: [s], threads: [thread(`import:claudeAgent:${s.nativeId}`)], journal }));
  assert.deepEqual(it.notes, ["continued-outside-t3"]);
  const same = only(await plan({ sessions: [s], threads: [thread(`import:claudeAgent:${s.nativeId}`)], journal: [{ ...journal[0]!, source: { path: s.file.path, size: 2000, mtimeMs: s.file.mtimeMs } } as JournalEntry] }));
  assert.deepEqual(same.notes, []);
});

test("buildPlan: a converted session (shared source db) is continued-outside-t3 only when its own activity moved past the conversion", async () => {
  const s = sess({ harness: "opencode", nativeId: "ses_1", accountId: null, size: 9_999_999 });
  const first = only(await plan({ sessions: [s] }));
  assert.equal(first.action.kind, "convert-import");
  if (first.action.kind !== "convert-import") return;
  const tid = first.action.expectedThreadId;
  const written = (over: Partial<{ updatedAt: string; messageCount: number }> = {}): JournalEntry[] => [
    { t: "file-written", runId: "r0", path: first.action.kind === "convert-import" ? first.action.targetFile : "", sha256: "0".repeat(64), mtimeMs: Date.parse(s.updatedAt),
      source: { harness: "opencode", nativeId: "ses_1", updatedAt: s.updatedAt, messageCount: s.messageCount, ...over } },
    // the shared db's size/mtime always differ from the converted file's: never evidence on its own
    { t: "imported", runId: "r0", harness: "opencode", nativeId: "ses_1", threadId: tid, source: { path: first.action.kind === "convert-import" ? first.action.targetFile : "", size: 1234, mtimeMs: 1 } },
  ];
  const same = only(await plan({ sessions: [s], threads: [thread(tid)], journal: written() }));
  assert.deepEqual(same.action, { kind: "skip", reason: "already-in-t3" });
  assert.deepEqual(same.notes, []);
  const moreMessages = only(await plan({ sessions: [s], threads: [thread(tid)], journal: written({ messageCount: s.messageCount - 1 }) }));
  assert.deepEqual(moreMessages.notes, ["continued-outside-t3"]);
  const later = only(await plan({ sessions: [s], threads: [thread(tid)], journal: written({ updatedAt: new Date(Date.parse(s.updatedAt) - DAY).toISOString() }) }));
  assert.deepEqual(later.notes, ["continued-outside-t3"]);
});

test("buildPlan: re-planning with every expected thread present yields zero import items", async () => {
  const sessions = [sess(), sess({ accountId: "claude-org", cwd: "C:/work/b" }), sess({ harness: "codex", nativeId: "cx" }), sess({ harness: "opencode", nativeId: "ses_9", accountId: null })];
  const first = await plan({ sessions });
  const threads = first.items.flatMap((i) => (i.action.kind === "import" || i.action.kind === "convert-import" ? [thread(i.action.expectedThreadId)] : []));
  assert.equal(threads.length, 4);
  const again = await plan({ sessions, threads });
  assert.equal(again.items.filter((i) => i.action.kind !== "skip").length, 0);
  assert.ok(again.items.every((i) => i.action.kind === "skip" && i.action.reason === "already-in-t3"));
});

// ---------- projects ----------
test("buildPlan: roots d:/w/x and D:\\w\\x\\ produce one project to create", async () => {
  const out = await plan({ sessions: [sess({ cwd: "d:/w/x" }), sess({ cwd: "D:\\w\\x\\" })] });
  assert.deepEqual(out.projectsToCreate, [{ root: "D:/w/x", title: "x", defaultInstanceId: "claudeAgent" }]);
  assert.ok(out.items.every((i) => i.action.kind === "import" && i.action.projectRoot === "D:/w/x"));
});

test("buildPlan: cwd matching an existing T3 project differing only in case creates no project", async () => {
  const out = await plan({ sessions: [sess({ cwd: "c:/WORK/Demo" })], projects: [project("p1", "C:\\work\\demo")] });
  assert.deepEqual(out.projectsToCreate, []);
  assert.equal(only(out).action.kind === "import" && (only(out).action as { projectRoot: string }).projectRoot, "C:/work/demo");
});

test("buildPlan: an existing archived project is reused and warned about; deleted ones are ignored", async () => {
  const out = await plan({ sessions: [sess()], projects: [project("p1", "C:/work/demo", { archived: true })] });
  assert.deepEqual(out.projectsToCreate, []);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0]!, /archived/);
  const del = await plan({ sessions: [sess()], projects: [project("p1", "C:/work/demo", { deleted: true })] });
  assert.equal(del.projectsToCreate.length, 1);
});

test("buildPlan: project title is the last path segment", async () => {
  const out = await plan({ sessions: [sess({ cwd: "C:/work/My Project" })] });
  assert.equal(out.projectsToCreate[0]!.title, "My Project");
});

// ---------- ownership, end to end ----------
const ID = uuid(77);
const P = `${HOME}/.claude/projects/C--work-demo/${ID}.jsonl`;
const O = `${HOME}/.claude-org/projects/C--work-demo/${ID}.jsonl`;

test("buildPlan: identical in both, project pinned to org -> org imports, personal is mirror-copy", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent" });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org" });
  const out = await plan({ sessions: [p, o], pins: { "C:/work/demo": "C:\\Users\\demo\\.claude-org" }, compare: { [`${P}|${O}`]: "identical" } });
  const by = new Map(out.items.map((i) => [i.session.file.path, i]));
  assert.deepEqual(by.get(O)!.action, { kind: "import", projectRoot: "C:/work/demo", instanceId: "claude-org", expectedThreadId: `import:claude-org:${ID}` });
  assert.deepEqual(by.get(P)!.action, { kind: "skip", reason: "mirror-copy" });
  assert.deepEqual(out.mirrorCopies, [{ path: P, nativeId: ID, keptPath: O, relation: "identical" }]);
  assert.deepEqual(out.projectAccounts, [{ root: "C:/work/demo", accountId: "claude-org", source: "vscode-pin" }]);
});

test("buildPlan: identical in both, no pin, newest activity in personal -> personal wins", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent" });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org" });
  const recent = sess({ accountId: "claudeAgent", updatedAt: "2026-11-01T00:00:00Z" });
  const older = sess({ accountId: "claude-org", updatedAt: "2026-09-01T00:00:00Z" });
  const out = await plan({ sessions: [p, o, recent, older], compare: { [`${P}|${O}`]: "identical" } });
  const by = new Map(out.items.map((i) => [i.session.file.path, i]));
  assert.equal(by.get(P)!.action.kind, "import");
  assert.deepEqual(by.get(O)!.action, { kind: "skip", reason: "mirror-copy" });
  assert.deepEqual(out.projectAccounts, [{ root: "C:/work/demo", accountId: "claudeAgent", source: "recent-activity" }]);
});

test("buildPlan: org longer (stale personal mirror) -> org wins, relation prefix", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent", cwd: "c:\\work\\demo" });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org", size: 4000 });
  const out = await plan({ sessions: [p, o], compare: { [`${O}|${P}`]: "a-extends-b" } });
  assert.deepEqual(out.mirrorCopies, [{ path: P, nativeId: ID, keptPath: O, relation: "prefix" }]);
  const winner = out.items.find((i) => i.session === o)!;
  assert.equal(winner.action.kind === "import" && winner.action.instanceId, "claude-org");
});

test("buildPlan: diverged -> two winners with diverged-fork, each with its own instance", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent" });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org" });
  const out = await plan({ sessions: [p, o], compare: { [`${P}|${O}`]: "diverged" } });
  const insts = out.items.map((i) => (i.action.kind === "import" ? i.action.instanceId : null)).sort();
  assert.deepEqual(insts, ["claude-org", "claudeAgent"]);
  assert.ok(out.items.every((i) => i.notes.includes("diverged-fork")));
  assert.deepEqual(out.mirrorCopies, []);
});

test("buildPlan: project used by both accounts, no pin -> default from newest activity; sessions keep their own instance", async () => {
  const a = sess({ accountId: "claudeAgent", updatedAt: "2026-10-01T00:00:00Z" });
  const b = sess({ accountId: "claude-org", updatedAt: "2026-11-01T00:00:00Z" });
  const out = await plan({ sessions: [a, b] });
  assert.deepEqual(out.projectAccounts, [{ root: "C:/work/demo", accountId: "claude-org", source: "recent-activity" }]);
  assert.deepEqual(out.projectsToCreate, [{ root: "C:/work/demo", title: "demo", defaultInstanceId: "claude-org" }]);
  assert.deepEqual(out.projectDefaults, [{ root: "C:/work/demo", instanceId: "claude-org" }]);
  const inst = new Map(out.items.map((i) => [i.session, i.action.kind === "import" ? i.action.instanceId : null]));
  assert.equal(inst.get(a), "claudeAgent");
  assert.equal(inst.get(b), "claude-org");
});

test("buildPlan: projectDefaults only where the existing default differs", async () => {
  const sessions = [sess({ cwd: "C:/work/a" }), sess({ cwd: "C:/work/b" })];
  const out = await plan({
    sessions,
    projects: [
      project("pa", "C:/work/a", { defaultModelSelection: { instanceId: "claudeAgent", model: "m" } }),
      project("pb", "C:/work/b", { defaultModelSelection: { instanceId: "claude-org", model: "m" } }),
    ],
  });
  assert.deepEqual(out.projectDefaults, [{ root: "C:/work/b", instanceId: "claudeAgent" }]);
});

// ---------- dedupe notes ----------
test("buildPlan: mirror copy within 30 days adds duplicate-in-window to the winner; older does not", async () => {
  const mk = (age: number) => {
    const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent", mtimeMs: NOW - age });
    const o = sess({ nativeId: ID, path: O, accountId: "claude-org", mtimeMs: NOW - age, size: 5000 });
    return [p, o];
  };
  const recent = await plan({ sessions: mk(5 * DAY), compare: { [`${O}|${P}`]: "a-extends-b" } });
  assert.deepEqual(recent.items.find((i) => i.session.file.path === O)!.notes, ["duplicate-in-window"]);
  const old = await plan({ sessions: mk(40 * DAY), compare: { [`${O}|${P}`]: "a-extends-b" } });
  assert.deepEqual(old.items.find((i) => i.session.file.path === O)!.notes, []);
});

test("buildPlan: backup losers never add duplicate-in-window", async () => {
  const live = sess({ nativeId: ID, path: P, mtimeMs: NOW - DAY });
  const bak = sess({ nativeId: ID, path: `${HOME}/.claude/projects/C--work-demo.bak-1/${ID}.jsonl`, mtimeMs: NOW - DAY, flags: ["backup-copy"] });
  const out = await plan({ sessions: [live, bak] });
  assert.deepEqual(out.items.find((i) => i.session === live)!.notes, []);
  assert.deepEqual(out.items.find((i) => i.session === bak)!.action, { kind: "skip", reason: "backup-copy" });
});

test("buildPlan: case-variant loser -> skip duplicate, not a mirror copy", async () => {
  const small = sess({ nativeId: ID, path: `${HOME}/.claude/projects/c--work-demo/${ID}.jsonl`, size: 10 });
  const large = sess({ nativeId: ID, path: P, size: 99 });
  const out = await plan({ sessions: [small, large] });
  assert.deepEqual(out.items.find((i) => i.session === small)!.action, { kind: "skip", reason: "duplicate" });
  assert.deepEqual(out.mirrorCopies, []);
});

test("buildPlan: an active mirror loser is skipped as active and not listed for dedupe", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent", flags: ["active"] });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org", size: 5000 });
  const out = await plan({ sessions: [p, o], compare: { [`${O}|${P}`]: "a-extends-b" } });
  assert.deepEqual(out.items.find((i) => i.session === p)!.action, { kind: "skip", reason: "active" });
  assert.deepEqual(out.mirrorCopies, []);
});

test("buildPlan: over-32mib and remap notes", async () => {
  const s = sess({ cwd: "E:/old/demo", flags: ["over-32mib" as SessionFlag] });
  const it = only(await plan({ sessions: [s], config: { remap: [{ from: "E:/old", to: "C:/work" }] } }));
  assert.equal(it.action.kind === "import" && it.action.projectRoot, "C:/work/demo");
  assert.deepEqual([...it.notes].sort(), ["remapped-cwd", "truncated-over-32mib"]);
});

// ---------- instances, warnings, determinism ----------
test("buildPlan: instancesToCreate = config accounts with no T3 instance of the same home", async () => {
  const out = await plan({ sessions: [sess({ accountId: "claude-org" })], instances: [personal] });
  assert.deepEqual(out.instancesToCreate, [{ id: "claude-org", driver: "claudeAgent", displayName: "Claude · Org", accentColor: "#00AAFF", homePath: `${HOME}/.claude-org`, environment: [] }]);
  assert.equal(only(out).action.kind === "import" && (only(out).action as { instanceId: string }).instanceId, "claude-org");
});

test("buildPlan: warns when one source holds more than 5000 transcripts", async () => {
  const sessions = Array.from({ length: 5001 }, (_, i) => sess({ harness: "codex", nativeId: `c${i}`, accountId: null, path: `/c/${i}.jsonl` }));
  const out = await plan({ sessions });
  assert.ok(out.warnings.some((w) => /5000/.test(w) && /codex/.test(w)));
});

test("buildPlan: deterministic order (projectRoot, then updatedAt) and header fields", async () => {
  const s1 = sess({ cwd: "C:/work/b", updatedAt: "2026-01-02T00:00:00Z" });
  const s2 = sess({ cwd: "C:/work/a", updatedAt: "2026-01-03T00:00:00Z" });
  const s3 = sess({ cwd: "C:/work/a", updatedAt: "2026-01-01T00:00:00Z" });
  const out = await plan({ sessions: [s1, s2, s3] });
  assert.deepEqual(out.items.map((i) => i.session), [s3, s2, s1]);
  assert.equal(out.runId, "run-1");
  assert.equal(out.version, 1);
  assert.equal(out.t3Version, "0.1.9");
  assert.equal(out.createdAt, new Date(NOW).toISOString());
  const again = await plan({ sessions: [s2, s1, s3] });
  assert.deepEqual(again.items.map((i) => i.session), [s3, s2, s1]);
});

test("buildPlan: 5000 synthetic sessions plan in under 2 s of CPU (compare injected)", async () => {
  const sessions: DiscoveredSession[] = [];
  for (let i = 0; i < 5000; i++) {
    const acct = i % 3 === 0 ? "claude-org" : "claudeAgent";
    sessions.push(sess({ accountId: acct, cwd: `C:/work/p${i % 400}`, nativeId: uuid(500_000 + (i % 4500)), path: `${HOME}/${acct}/p${i % 400}/${i}.jsonl`, updatedAt: new Date(NOW - i * 1000).toISOString(), size: i }));
  }
  const inp = input({ sessions });
  inp.compareCopies = async () => "identical";
  // CPU time of this process, not the wall clock: on a loaded machine the wall clock also counts the time the process
  // waits for a CPU (seen at 10x the work), while the CPU time only grows with the work done (a quadratic planner).
  const c0 = process.cpuUsage();
  const out = await buildPlan(inp);
  const { user, system } = process.cpuUsage(c0);
  const ms = (user + system) / 1000;
  assert.equal(out.items.length, 5000);
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms of CPU`);
});

// ---------- review fixes ----------
test("buildPlan (I2): session only in personal, project pinned to org via .vscode/settings.json", async () => {
  const dir = projectScratch("t3sm-pin-"); // a project folder: on Linux one under /tmp would be a temp one
  try {
    await mkdir(join(dir, ".vscode"));
    await writeFile(join(dir, ".vscode", "settings.json"), `{
  // org project
  "claudeCode.environmentVariables": [ { "name": "CLAUDE_CONFIG_DIR", "value": "~/.claude-org" }, ],
}`);
    const s = sess({ accountId: "claudeAgent", cwd: dir });
    const inp = input({ sessions: [s] });
    delete inp.readVscodePin; // real reader
    inp.platform = process.platform;
    const out = await buildPlan(inp);
    const it = only(out);
    assert.equal(it.action.kind, "import");
    if (it.action.kind !== "import") return;
    assert.equal(it.action.instanceId, "claudeAgent");
    assert.equal(it.action.expectedThreadId, `import:claudeAgent:${s.nativeId}`);
    const root = it.action.projectRoot;
    assert.deepEqual(out.projectAccounts, [{ root, accountId: "claude-org", source: "vscode-pin" }]);
    assert.deepEqual(out.projectDefaults, [{ root, instanceId: "claude-org" }]);
    assert.equal(out.projectsToCreate.length, 1);
    assert.equal(out.projectsToCreate[0]!.defaultInstanceId, "claude-org");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildPlan (M2): mirror loser holding a custom title the winner lacks -> label-only-in-mirror on the winner", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent" });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org" });
  const base = { sessions: [p, o], pins: { "C:/work/demo": "~/.claude-org" }, compare: { [`${P}|${O}`]: "identical" as CopyRelation } };
  const lost = await plan({ ...base, labels: { [P]: ["custom-title:Mine"], [O]: [] } });
  assert.deepEqual(lost.items.find((i) => i.session === o)!.notes, ["label-only-in-mirror"]);
  const kept = await plan({ ...base, labels: { [P]: ["custom-title:Mine"], [O]: ["custom-title:Mine"] } });
  assert.deepEqual(kept.items.find((i) => i.session === o)!.notes, []);
  const none = await plan({ ...base, labels: {} });
  assert.deepEqual(none.items.find((i) => i.session === o)!.notes, []);
});

test("buildPlan (M3, round 2): ENOENT -> no retry, both copies skipped compare-failed, one warning", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent" });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org" });
  const other = sess({ accountId: "claude-org" });
  const inp = input({ sessions: [p, o, other] });
  let calls = 0;
  inp.compareCopies = async () => { calls++; throw Object.assign(new Error("gone"), { code: "ENOENT" }); };
  inp.sleep = async () => {};
  const out = await buildPlan(inp);
  assert.equal(calls, 1);
  for (const s of [p, o]) assert.deepEqual(out.items.find((i) => i.session === s)!.action, { kind: "skip", reason: "compare-failed" });
  assert.equal(out.items.find((i) => i.session === other)!.action.kind, "import");
  assert.ok(out.items.every((i) => !i.notes.includes("diverged-fork")));
  assert.deepEqual(out.mirrorCopies, []);
  assert.deepEqual(out.warnings, [`could not compare copies of ${ID} (ENOENT); skipped both, will retry next run`]);
});

test("buildPlan (M3, round 2): persistent EBUSY -> retried with 100/300/1000 ms backoff, then skipped", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent" });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org" });
  const inp = input({ sessions: [p, o] });
  let calls = 0;
  const waits: number[] = [];
  inp.compareCopies = async () => { calls++; throw Object.assign(new Error("busy"), { code: "EBUSY" }); };
  inp.sleep = async (ms) => { waits.push(ms); };
  const out = await buildPlan(inp);
  assert.equal(calls, 4);
  assert.deepEqual(waits, [100, 300, 1000]);
  assert.ok(out.items.every((i) => i.action.kind === "skip" && i.action.reason === "compare-failed"));
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0]!, /EBUSY/);
});

test("buildPlan (M3, round 2): first attempt EBUSY, retry succeeds -> normal relation", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent" });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org", size: 5000 });
  const inp = input({ sessions: [p, o] });
  let calls = 0;
  inp.compareCopies = async (a) => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return a === O ? "a-extends-b" : "b-extends-a";
  };
  inp.sleep = async () => {};
  const out = await buildPlan(inp);
  assert.equal(calls, 2);
  assert.deepEqual(out.mirrorCopies, [{ path: P, nativeId: ID, keptPath: O, relation: "prefix" }]);
  assert.deepEqual(out.warnings, []);
});

test("buildPlan: case-variant loser holding a label the winner lacks -> label-only-in-mirror", async () => {
  const small = sess({ nativeId: ID, path: `${HOME}/.claude/projects/c--work-demo/${ID}.jsonl`, size: 10 });
  const large = sess({ nativeId: ID, path: P, size: 99 });
  const out = await plan({ sessions: [small, large], labels: { [small.file.path]: ["tag:wip"], [P]: [] } });
  assert.deepEqual(out.items.find((i) => i.session === large)!.notes, ["label-only-in-mirror"]);
});

test("buildPlan: warnings are deduplicated", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent" });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org" });
  const o2 = sess({ nativeId: ID, path: O.replace("C--", "x--"), accountId: "claude-org", size: 1 });
  const inp = input({ sessions: [p, o, o2], compare: { [`${P}|${O}`]: "identical" }, labels: {} });
  inp.labelRecords = async () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); };
  const out = await buildPlan(inp);
  assert.equal(new Set(out.warnings).size, out.warnings.length);
});

test("buildPlan (M2): a labelRecords failure never aborts the plan", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent" });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org" });
  const inp = input({ sessions: [p, o], compare: { [`${P}|${O}`]: "identical" } });
  inp.labelRecords = async () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); };
  const out = await buildPlan(inp);
  assert.equal(out.mirrorCopies.length, 1);
});

test("buildPlan: a converted transcript rediscovered by the Claude adapter is skipped (converted): one item per conversation", async () => {
  const oc = sess({ harness: "opencode", nativeId: "ses_1", accountId: null });
  const first = only(await plan({ sessions: [oc] }));
  assert.equal(first.action.kind, "convert-import");
  if (first.action.kind !== "convert-import") return;
  const target = first.action.targetFile;
  const claudeCopy = sess({ nativeId: first.action.uuid, path: target, accountId: "claudeAgent" });
  const journal: JournalEntry[] = [{ t: "file-written", runId: "r0", path: target.toUpperCase(), sha256: "0".repeat(64), mtimeMs: 1,
    source: { harness: "opencode", nativeId: "ses_1", updatedAt: oc.updatedAt, messageCount: oc.messageCount } }];
  const p = await plan({ sessions: [oc, claudeCopy], journal });
  const live = p.items.filter((i) => i.action.kind !== "skip");
  assert.equal(live.length, 1);
  assert.equal(live[0]!.session.harness, "opencode");
  assert.deepEqual(p.items.find((i) => i.session.harness === "claude")!.action, { kind: "skip", reason: "converted" });

  // Journal lost: the provenance check (injected here) still recognises it.
  const seen: string[] = [];
  const p2 = await buildPlan({ ...input({ sessions: [oc, claudeCopy] }), isConvertedTranscript: async (f, id) => { seen.push(id); return f === target; } });
  assert.deepEqual(p2.items.find((i) => i.session.harness === "claude")!.action, { kind: "skip", reason: "converted" });
  assert.deepEqual(seen, [first.action.uuid]);

  // A merge revision (file-written without a convert source) is NOT skipped as converted.
  const rev = sess({ nativeId: uuid(4242), accountId: "claudeAgent" });
  const p3 = await plan({ sessions: [rev], journal: [{ t: "file-written", runId: "r1", path: rev.file.path, sha256: "1".repeat(64), mtimeMs: 1 }] });
  assert.equal(only(p3).action.kind, "import");
});

test("buildPlan: a converted transcript already in T3 is the Claude session it became: already-in-t3, continued-outside-t3 after terminal work", async () => {
  const oc = sess({ harness: "opencode", nativeId: "ses_2", accountId: null });
  const first = only(await plan({ sessions: [oc] }));
  if (first.action.kind !== "convert-import") throw new Error("expected convert-import");
  const target = first.action.targetFile;
  const uuid = first.action.uuid;
  const journal: JournalEntry[] = [
    { t: "file-written", runId: "r0", path: target, sha256: "0".repeat(64), mtimeMs: 1, source: { harness: "opencode", nativeId: "ses_2", updatedAt: oc.updatedAt, messageCount: oc.messageCount } },
    { t: "imported", runId: "r0", harness: "opencode", nativeId: "ses_2", threadId: `import:claudeAgent:${uuid}`, source: { path: target, size: 1000, mtimeMs: NOW - 10 * DAY } },
  ];
  // Resumed in a terminal: the file grew since the import.
  const claudeCopy = sess({ nativeId: uuid, path: target, accountId: "claudeAgent", size: 5000, mtimeMs: NOW - DAY });
  const threads = [thread(`import:claudeAgent:${uuid}`)];
  const p = await plan({ sessions: [oc, claudeCopy], journal, threads });
  const cl = p.items.find((i) => i.session.harness === "claude")!;
  assert.deepEqual(cl.action, { kind: "skip", reason: "already-in-t3" });
  assert.deepEqual(cl.notes, ["continued-outside-t3"], "merge can see the terminal work");
  // Not resumed (same size/mtime as imported): already-in-t3, no note.
  const same = sess({ nativeId: uuid, path: target, accountId: "claudeAgent", size: 1000, mtimeMs: NOW - 10 * DAY });
  const p2 = await plan({ sessions: [oc, same], journal, threads });
  assert.deepEqual(p2.items.find((i) => i.session.harness === "claude")!.notes, []);
  // No thread yet: still `converted` (its convert-import item imports it).
  const p3 = await plan({ sessions: [oc, same], journal });
  assert.deepEqual(p3.items.find((i) => i.session.harness === "claude")!.action, { kind: "skip", reason: "converted" });
});

test("buildPlan: an aborted write (file-write-aborted) does not mark its path as a converted transcript", async () => {
  const rev = sess({ nativeId: uuid(4343), accountId: "claudeAgent" });
  const journal: JournalEntry[] = [
    { t: "file-written", runId: "r1", path: rev.file.path, sha256: "1".repeat(64), mtimeMs: 1, source: { harness: "opencode", nativeId: "ses_x", updatedAt: rev.updatedAt, messageCount: 1 } },
    { t: "file-write-aborted", runId: "r1", path: rev.file.path },
  ];
  assert.equal(only(await plan({ sessions: [rev], journal })).action.kind, "import");
});

test("B12: a session whose thread exists under ANOTHER instance is already in T3 (note in-t3-under-other-account), never imported twice", async () => {
  const s = sess({ accountId: "claudeAgent" });
  const p = await plan({ sessions: [s], threads: [thread(`import:claude-org:${s.nativeId}`, { instanceId: "claude-org" })] });
  const it = only(p);
  assert.deepEqual(it.action, { kind: "skip", reason: "already-in-t3" });
  assert.deepEqual(it.notes, ["in-t3-under-other-account"]);
  const byRef = only(await plan({ sessions: [s], threads: [thread("t3-native", { instanceId: "claude-org", nativeSessionId: s.nativeId } as Partial<T3Thread>)] }));
  assert.deepEqual([byRef.action, byRef.notes], [{ kind: "skip", reason: "already-in-t3" }, ["in-t3-under-other-account"]]);
  const { renderPlanMarkdown } = await import("../../src/plan/report.ts");
  assert.match(renderPlanMarkdown(p), new RegExp(`already in T3 Code under another account[^\n]*${s.nativeId}`));
});

test("buildPlan: projectsToCreate titles are unique against T3 projects and each other", async () => {
  const out = await plan({
    sessions: [sess({ cwd: "C:/work/TPB/ADDON V10" }), sess({ cwd: "C:/work/PZO/ADDON V10" }), sess({ cwd: "C:/work/VOA/ADDON V10" })],
    projects: [project("p1", "C:/work/OLD/ADDON V10", { title: "ADDON V10" })],
  });
  const titles = out.projectsToCreate.map((p) => p.title).sort();
  assert.equal(new Set(titles.map((t) => t.toLowerCase())).size, 3);
  assert.deepEqual(titles, ["ADDON V10 · PZO", "ADDON V10 · TPB", "ADDON V10 · VOA"]);
});

// ---------- folder and session categories (organize, spec §4.1–§4.4) ----------
const DECIDED: Partial<Config> = { organize: { decided: ["home", "t3-refused", "temp", "system", "automated"] } };
const TMP = `${HOME}/AppData/Local/Temp`;
const GENERAL_EN = `${HOME}/T3 General`;
/** organize.folders with the spec defaults, `over` replacing some. */
const folders = (over: Partial<OrganizeConfig["folders"]>): OrganizeConfig["folders"] =>
  ({ home: "rehome", "t3-refused": "rehome", temp: "skip", system: "skip", ...over });

/** A synthetic Claude transcript in a temp folder: records in `cwd`, one Edit tool_use per path in `paths`. */
async function transcript(cwd: string, paths: string[]): Promise<{ file: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "t3sm-plan-rehome-"));
  const file = join(dir, "t.jsonl");
  const recs: unknown[] = [{ type: "user", cwd, message: { role: "user", content: "synthetic question" } }];
  for (const p of paths) recs.push({ type: "assistant", cwd, message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: p } }] } });
  await writeFile(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { file, done: () => rm(dir, { recursive: true, force: true }) };
}

test("categories: a home-folder Claude session becomes a faithful convert-import into the inferred root", async () => {
  const { uuidV5 } = await import("../../src/core/uuid.ts");
  const paths = Array.from({ length: 6 }, (_, n) => `C:/work/app/src/f${n}.ts`);
  const t = await transcript(HOME, paths);
  try {
    const s = sess({ cwd: HOME, path: t.file, accountId: "claude-org" });
    const p = await plan({ sessions: [s], config: DECIDED, projects: [project("p1", "C:/work/app")] });
    const u = uuidV5(`claude:${s.nativeId}`);
    const it = only(p);
    if (it.action.kind !== "convert-import") throw new Error(`expected convert-import, got ${JSON.stringify(it.action)}`);
    const { targetFile, ...rest } = it.action;
    assert.deepEqual(rest, {
      kind: "convert-import", projectRoot: "C:/work/app", instanceId: "claude-org", expectedThreadId: `import:claude-org:${u}`,
      uuid: u, copy: "faithful", rehomeFrom: HOME, rehomeShare: { hits: 6, total: 6 },
    });
    assert.equal(targetFile.replace(/\\/g, "/"), `${HOME}/.claude-org/projects/C--work-app/${u}.jsonl`);
    assert.deepEqual(p.projectsToCreate, [], "an existing T3 project, no General folder");
    // Planning again gives the same target (uuid derived from the source id).
    const again = only(await plan({ sessions: [s], config: DECIDED, projects: [project("p1", "C:/work/app")] }));
    assert.deepEqual(again.action, it.action);
  } finally { await t.done(); }
});

test("categories: a home-folder Claude session goes to the General folder when nothing is inferred (title per language, never cwd-missing)", async () => {
  const t = await transcript(HOME, ["C:/work/a/x.ts", "C:/work/b/y.ts"]);
  try {
    const s = sess({ cwd: HOME, path: t.file });
    for (const [lang, root, title] of [["en", GENERAL_EN, "General"], ["pt", `${HOME}/T3 Geral`, "Geral"]] as const) {
      const p = await plan({ sessions: [s], config: DECIDED, lang, missing: [root], projects: [project("p1", "C:/work/a")] });
      const it = only(p);
      assert.equal(it.action.kind, "convert-import", JSON.stringify(it.action));
      if (it.action.kind !== "convert-import") return;
      assert.equal(it.action.projectRoot, root);
      assert.equal(it.action.copy, "faithful");
      assert.equal(it.action.targetFile.replace(/\\/g, "/").startsWith(`${HOME}/.claude/projects/${root.replace(/[^A-Za-z0-9]/g, "-")}/`), true);
      assert.deepEqual(p.projectsToCreate, [{ root, title, defaultInstanceId: "claudeAgent" }]);
    }
    // Already a T3 project: not created again.
    const p2 = await plan({ sessions: [s], config: DECIDED, projects: [project("g", GENERAL_EN, { title: "Mine" })] });
    assert.deepEqual(p2.projectsToCreate, []);
  } finally { await t.done(); }
});

test("categories: inference never rehomes into a folder that no longer exists (plan folder or T3 project): General instead", async () => {
  // C:/work/gone: a plan `project` folder (its session is cwd-missing); C:/work/old: a T3 project whose folder is gone.
  for (const gone of ["C:/work/gone", "C:/work/old"]) {
    const t = await transcript(HOME, Array.from({ length: 6 }, (_, n) => `${gone}/f${n}.ts`));
    try {
      const home = sess({ cwd: HOME, path: t.file });
      const p = await plan({
        sessions: [home, sess({ cwd: "C:/work/gone" })], config: DECIDED,
        projects: [project("p-old", "C:/work/old")], missing: ["C:/work/gone", "C:/work/old"],
      });
      const it = p.items.find((i) => i.session === home)!;
      assert.equal(it.action.kind, "convert-import", JSON.stringify(it.action));
      if (it.action.kind === "convert-import") assert.equal(it.action.projectRoot, GENERAL_EN, gone);
      assert.ok(!p.projectsToCreate.some((x) => x.root === gone), `${gone} is not created`);
    } finally { await t.done(); }
  }
  // Defensive: an injected inference naming a missing folder falls back to General too.
  const s = sess({ cwd: HOME, path: "C:/nope/x.jsonl" });
  const p = await buildPlan({ ...input({ sessions: [s], config: DECIDED, missing: ["C:/work/vanished"] }),
    inferProjectRoot: async () => ({ root: "C:/work/vanished", hits: 9, total: 9, share: 1 }) });
  const a = only(p).action;
  assert.equal(a.kind === "convert-import" ? a.projectRoot : a.kind, GENERAL_EN);
  assert.deepEqual(p.projectsToCreate.map((x) => x.root), [GENERAL_EN]);
});

test("categories: only one General folder: an existing T3 project at ~/T3 Geral or ~/T3 General is reused whatever the language; organize.generalFolder wins", async () => {
  const s = sess({ cwd: HOME, path: "C:/nope/g.jsonl" });
  const target = async (o: Partial<Over>) => {
    const p = await plan({ sessions: [s], config: DECIDED, ...o });
    const it = only(p);
    if (it.action.kind !== "convert-import") throw new Error(JSON.stringify(it.action));
    return { root: it.action.projectRoot, create: p.projectsToCreate };
  };
  // Fresh: the language picks the default.
  assert.deepEqual(await target({ lang: "pt" }), { root: `${HOME}/T3 Geral`, create: [{ root: `${HOME}/T3 Geral`, title: "Geral", defaultInstanceId: "claudeAgent" }] });
  // A PT General project exists; the plan is in EN: reuse it, create nothing.
  assert.deepEqual(await target({ lang: "en", projects: [project("g", `${HOME}/T3 Geral`, { title: "Geral" })] }), { root: `${HOME}/T3 Geral`, create: [] });
  // An EN General project exists; the plan is in PT: reuse it.
  assert.deepEqual(await target({ lang: "pt", projects: [project("g", `${HOME}/T3 General`, { title: "General" })] }), { root: `${HOME}/T3 General`, create: [] });
  // A deleted T3 project there does not count.
  assert.equal((await target({ lang: "en", projects: [project("g", `${HOME}/T3 Geral`, { deleted: true })] })).root, GENERAL_EN);
  // organize.generalFolder set: used even when a default General project exists.
  const own = { organize: { decided: DECIDED.organize!.decided!, generalFolder: "~/code/inbox" } };
  assert.deepEqual(await target({ config: own, projects: [project("g", `${HOME}/T3 Geral`)] }),
    { root: `${HOME}/code/inbox`, create: [{ root: `${HOME}/code/inbox`, title: "General", defaultInstanceId: "claudeAgent" }] });
});

test("categories: a t3-refused Codex session converts into the target; Pi (no converter) is skipped t3-refused", async () => {
  const { uuidV5 } = await import("../../src/core/uuid.ts");
  const cx = sess({ harness: "codex", accountId: null, cwd: `${HOME}/Documents/Codex/2026-01-01/new-chat` });
  const it = only(await plan({ sessions: [cx], config: DECIDED }));
  const u = uuidV5(`codex:${cx.nativeId}`);
  if (it.action.kind !== "convert-import") throw new Error(`expected convert-import, got ${JSON.stringify(it.action)}`);
  const { targetFile, ...rest } = it.action;
  assert.deepEqual(rest, {
    kind: "convert-import", projectRoot: GENERAL_EN, instanceId: "claudeAgent", expectedThreadId: `import:claudeAgent:${u}`, uuid: u,
    rehomeFrom: `${HOME}/Documents/Codex/2026-01-01/new-chat`,
  });
  assert.equal(targetFile.replace(/\\/g, "/"), `${HOME}/.claude/projects/C--Users-demo-T3-General/${u}.jsonl`);
  const pi = sess({ harness: "pi", accountId: null, cwd: `${HOME}/Downloads/x` });
  assert.deepEqual(only(await plan({ sessions: [pi], config: DECIDED })).action, { kind: "skip", reason: "t3-refused" });
  // folders["t3-refused"] = "skip"
  const off = { organize: { decided: ["t3-refused"], folders: folders({ "t3-refused": "skip" }) } };
  assert.deepEqual(only(await plan({ sessions: [cx], config: off })).action, { kind: "skip", reason: "t3-refused" });
});

test("categories: an automated session is skipped as automated when decided, undecided otherwise, imported when chosen", async () => {
  const auto = (): DiscoveredSession => ({ ...sess(), origin: "automated" });
  assert.deepEqual(only(await plan({ sessions: [auto()], config: DECIDED })).action, { kind: "skip", reason: "automated" });
  assert.deepEqual(only(await plan({ sessions: [auto()] })).action, { kind: "skip", reason: "undecided" });
  const yes = { organize: { decided: ["automated"], sessions: { automated: "import" as const } } };
  assert.equal(only(await plan({ sessions: [auto()], config: yes })).action.kind, "import");
  // A human session in a project folder is imported with a fresh config (nothing to decide).
  assert.equal(only(await plan({ sessions: [{ ...sess(), origin: "human" }] })).action.kind, "import");
});

test("categories: temp and system folders are skipped by default once decided; import when chosen", async () => {
  const temp = () => sess({ cwd: `${TMP}/scratch1` });
  const sys = () => sess({ cwd: "C:/Program Files/Tool" });
  const p = await plan({ sessions: [temp(), sys()], config: DECIDED });
  assert.deepEqual(p.items.map((i) => i.action).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1),
    [{ kind: "skip", reason: "system-folder" }, { kind: "skip", reason: "temp-folder" }]);
  assert.deepEqual(p.projectsToCreate, []);
  const fresh = await plan({ sessions: [temp(), sys()] });
  assert.deepEqual(fresh.items.map((i) => i.action), [{ kind: "skip", reason: "undecided" }, { kind: "skip", reason: "undecided" }]);
  const imp = { organize: { decided: ["temp"], folders: folders({ temp: "import" }) } };
  assert.equal(only(await plan({ sessions: [temp()], config: imp })).action.kind, "import");
});

test("categories: an override import beats the temp category; skip and rehome:<root> overrides too", async () => {
  const s = sess({ cwd: `${TMP}/keep/me` });
  const over = (action: "import" | "skip" | `rehome:${string}`) => ({ organize: { overrides: [{ match: `${TMP}/keep/**`, action }, { match: "**", action: "skip" as const }] } });
  const it = only(await plan({ sessions: [s], config: over("import") }));
  assert.equal(it.action.kind, "import");
  if (it.action.kind === "import") assert.equal(it.action.projectRoot, `${TMP}/keep/me`);
  assert.deepEqual(only(await plan({ sessions: [s], config: over("skip") })).action, { kind: "skip", reason: "excluded" });
  const r = only(await plan({ sessions: [s], config: over("rehome:~/code/app") }));
  assert.equal(r.action.kind, "convert-import");
  if (r.action.kind === "convert-import") {
    assert.equal(r.action.projectRoot, `${HOME}/code/app`);
    assert.equal(r.action.rehomeFrom, `${TMP}/keep/me`);
  }
  // First match wins: the catch-all skip applies to another folder.
  assert.deepEqual(only(await plan({ sessions: [sess({ cwd: "C:/work/demo" })], config: over("import") })).action, { kind: "skip", reason: "excluded" });
});

test("categories: no native import item ever has a home or refused cwd", async () => {
  const { isT3Refused } = await import("../../src/plan/folders.ts");
  const cwds = [HOME, `${HOME}/Downloads/a`, `${HOME}/Documents/Codex/x/new-chat`, TMP, `${HOME}/.t3/worktrees/w`];
  const sessions = cwds.flatMap((cwd) => [sess({ cwd }), sess({ harness: "codex", accountId: null, cwd }), sess({ harness: "pi", accountId: null, cwd })]);
  const configs: Partial<Config>[] = [
    {}, DECIDED,
    { organize: { decided: ["home", "t3-refused"], folders: folders({ home: "import", "t3-refused": "import" }) } },
    { organize: { overrides: [{ match: "**", action: "import" }] } },
  ];
  for (const c of configs) {
    const p = await plan({ sessions, config: c });
    for (const it of p.items) {
      if (it.action.kind === "import") assert.ok(!isT3Refused(it.session.cwd!, FENV), `${JSON.stringify(c)}: native import of ${it.session.cwd}`);
    }
    assert.ok(!p.projectsToCreate.some((x) => isT3Refused(x.root, FENV)), "no project at a refused folder");
  }
});

test("categories: decisionsPending counts sessions and folders per key; sessions already in T3 or with a missing folder are not pending", async () => {
  const inT3 = sess({ cwd: `${TMP}/c` });
  const p = await plan({
    sessions: [
      sess({ cwd: HOME, path: "C:/nope/a.jsonl" }), sess({ cwd: HOME, path: "C:/nope/b.jsonl" }),
      sess({ cwd: `${TMP}/a` }), sess({ cwd: `${TMP}/a` }), sess({ cwd: `${TMP}/b` }),
      { ...sess(), origin: "automated" }, sess({ cwd: "C:/work/demo" }),
      inT3, sess({ cwd: `${TMP}/gone` }),
    ],
    threads: [thread(`import:claudeAgent:${inT3.nativeId}`)],
    missing: [`${TMP}/gone`],
  });
  assert.deepEqual(p.decisionsPending, [
    { key: "home", sessions: 2, folders: 1 },
    { key: "temp", sessions: 3, folders: 2 },
    { key: "automated", sessions: 1, folders: 1 },
  ]);
  const reasons = p.items.map((i) => (i.action.kind === "skip" ? i.action.reason : i.action.kind)).sort();
  assert.deepEqual(reasons, ["already-in-t3", "cwd-missing", "import", "undecided", "undecided", "undecided", "undecided", "undecided", "undecided"]);
  assert.equal((await plan({ sessions: [sess()] })).decisionsPending, undefined, "nothing pending: absent");
});

test("categories: the faithful copy of a rehomed session is never planned as a second native import", async () => {
  const { uuidV5 } = await import("../../src/core/uuid.ts");
  const s = sess({ cwd: HOME, path: "C:/nope/orig.jsonl" });
  const u = uuidV5(`claude:${s.nativeId}`);
  const target = `${HOME}/.claude/projects/C--Users-demo-T3-General/${u}.jsonl`;
  const copy = sess({ cwd: GENERAL_EN, nativeId: u, path: target });
  const p = await plan({ sessions: [s, copy], config: DECIDED });
  assert.deepEqual(p.items.find((i) => i.session === copy)!.action, { kind: "skip", reason: "converted" });
  // Journaled by an earlier run (file-written with a claude source): converted until its thread exists.
  const journal: JournalEntry[] = [{ t: "file-written", runId: "r0", path: target, sha256: "0".repeat(64), mtimeMs: 1, source: { harness: "claude", nativeId: s.nativeId, updatedAt: s.updatedAt, messageCount: 4 } }];
  assert.deepEqual(only(await plan({ sessions: [copy], config: DECIDED, journal })).action, { kind: "skip", reason: "converted" });
  const done = only(await plan({ sessions: [copy], config: DECIDED, journal, threads: [thread(`import:claudeAgent:${u}`)] }));
  assert.deepEqual(done.action, { kind: "skip", reason: "already-in-t3" });
});

test("categories (R11): a rehomed session whose copy is in T3 is noted continued-after-rehome (never continued-outside-t3) once its original changed since it was copied (activity, size or time)", async () => {
  const { uuidV5 } = await import("../../src/core/uuid.ts");
  const s = sess({ cwd: HOME, path: "C:/nope/orig.jsonl", size: 5000, mtimeMs: NOW - 2 * DAY });
  const u = uuidV5(`claude:${s.nativeId}`);
  const target = `${HOME}/.claude/projects/C--Users-demo-T3-General/${u}.jsonl`;
  const written = (over: { updatedAt?: string; messageCount?: number; size?: number; mtimeMs?: number } = {}, rehome = true): JournalEntry[] => [{
    t: "file-written", runId: "r0", path: target, sha256: "0".repeat(64), mtimeMs: 1,
    source: { harness: "claude", nativeId: s.nativeId, updatedAt: over.updatedAt ?? s.updatedAt, messageCount: over.messageCount ?? s.messageCount },
    ...(rehome ? { rehomeOf: { path: s.file.path, nativeId: s.nativeId, cwd: HOME, size: over.size ?? s.file.size, mtimeMs: over.mtimeMs ?? s.file.mtimeMs } } : {}),
  }];
  const threads = [thread(`import:claudeAgent:${u}`)];
  const notesOf = async (journal: JournalEntry[]): Promise<string[]> => {
    const it = only(await plan({ sessions: [s], config: DECIDED, journal, threads }));
    assert.deepEqual(it.action, { kind: "skip", reason: "already-in-t3" });
    return it.notes;
  };
  assert.deepEqual(await notesOf(written()), [], "unchanged since copied");
  assert.deepEqual(await notesOf(written({ messageCount: 3 })), ["continued-after-rehome"], "new messages");
  // A record without a timestamp (a rename: custom-title) changes neither updatedAt nor messageCount, only the file.
  assert.deepEqual(await notesOf(written({ size: 4000 })), ["continued-after-rehome"], "grew");
  assert.deepEqual(await notesOf(written({ mtimeMs: NOW - 3 * DAY })), ["continued-after-rehome"], "written since");
  assert.deepEqual(await notesOf(written({ mtimeMs: s.file.mtimeMs + 1 })), [], "a time within the journal's tolerance is the same time");
  assert.deepEqual(await notesOf(written({ size: 4000 }, false)), [], "no rehomeOf (a conversion): activity only");
});

test("categories (R11): a rehome copy resumed outside T3 Code is noted continued-after-rehome; a native session keeps continued-outside-t3", async () => {
  const { uuidV5 } = await import("../../src/core/uuid.ts");
  const orig = sess({ cwd: HOME, path: "C:/nope/orig.jsonl" });
  const u = uuidV5(`claude:${orig.nativeId}`);
  const target = `${HOME}/.claude/projects/C--work-demo/${u}.jsonl`;
  const journal: JournalEntry[] = [
    { t: "file-written", runId: "r0", path: target, sha256: "0".repeat(64), mtimeMs: 1, source: { harness: "claude", nativeId: orig.nativeId, updatedAt: orig.updatedAt, messageCount: orig.messageCount } },
    { t: "imported", runId: "r0", harness: "claude", nativeId: orig.nativeId, threadId: `import:claudeAgent:${u}`, source: { path: target, size: 1000, mtimeMs: NOW - 10 * DAY } },
  ];
  // The copy grew since the import (resumed in a terminal); journaled under the original's id, found by its path.
  const copy = sess({ cwd: "C:/work/demo", nativeId: u, path: target, size: 5000, mtimeMs: NOW - DAY });
  const p = await plan({ sessions: [copy], config: DECIDED, journal, threads: [thread(`import:claudeAgent:${u}`)] });
  assert.deepEqual([only(p).action, only(p).notes], [{ kind: "skip", reason: "already-in-t3" }, ["continued-after-rehome"]]);
  // The same shape for an ordinary Claude session (no copy): merge handles it.
  const native = sess({ cwd: "C:/work/demo", size: 5000, mtimeMs: NOW - DAY });
  const nj: JournalEntry[] = [{ t: "imported", runId: "r0", harness: "claude", nativeId: native.nativeId, threadId: `import:claudeAgent:${native.nativeId}`, source: { path: native.file.path, size: 1000, mtimeMs: NOW - 10 * DAY } }];
  const n = only(await plan({ sessions: [native], config: DECIDED, journal: nj, threads: [thread(`import:claudeAgent:${native.nativeId}`)] }));
  assert.deepEqual(n.notes, ["continued-outside-t3"]);
});

test("categories: a rehome:<folder> override that names a folder T3 Code refuses (or a temp / system one) skips its sessions, with a warning", async () => {
  for (const target of [`${HOME}/Downloads/x`, `${HOME}/AppData/Local/Temp/x`, "C:/Windows/x", HOME]) {
    const s = sess({ cwd: HOME, path: "C:/nope/x.jsonl" });
    const p = await plan({ sessions: [s], config: { organize: { ...DECIDED.organize, overrides: [{ match: HOME, action: `rehome:${target}` }] } } });
    assert.deepEqual(only(p).action, { kind: "skip", reason: "t3-refused" }, target);
    assert.ok(p.warnings.includes(`organize.overrides: rehome:${target} is not a folder T3 Code can hold a project in (refused, temporary or system); its sessions are skipped`), p.warnings.join("\n"));
  }
  const fine = await plan({ sessions: [sess({ cwd: HOME, path: "C:/nope/y.jsonl" })], config: { organize: { ...DECIDED.organize, overrides: [{ match: HOME, action: "rehome:D:/work/hub" }] } } });
  const a = only(fine).action;
  assert.ok(a.kind === "convert-import" && a.projectRoot === "D:/work/hub");
});

test("categories: a rehomed session whose copy is already in T3 Code is never read to infer its project; only sessions to import are", async () => {
  const { uuidV5 } = await import("../../src/core/uuid.ts");
  const done = sess({ cwd: HOME, path: "C:/nope/done.jsonl" });
  const todo = sess({ cwd: HOME, path: "C:/nope/todo.jsonl" });
  const reads: string[] = [];
  const p = await buildPlan({
    ...input({
      sessions: [done, todo], config: DECIDED, projects: [project("p1", "C:/work/a")],
      threads: [thread(`import:claudeAgent:${uuidV5(`claude:${done.nativeId}`)}`)],
    }),
    inferProjectRoot: async (file) => { reads.push(file); return { root: "C:/work/a", hits: 7, total: 8, share: 0.875 }; },
  });
  assert.deepEqual(reads, ["C:/nope/todo.jsonl"], "one inference read, for the session that will be imported");
  const byPath = (f: string) => p.items.find((i) => i.session.file.path === f)!;
  assert.deepEqual(byPath("C:/nope/done.jsonl").action, { kind: "skip", reason: "already-in-t3" });
  assert.equal(byPath("C:/nope/todo.jsonl").action.kind, "convert-import");
  // The copy's project in T3 Code still gets its account (as before), read from where T3 Code holds the thread.
  assert.ok(p.projectAccounts.some((x) => x.root === "C:/work/a"));
});

test("categories: an inferred rehome target carries its share (hits of total); a General fallback carries none", async () => {
  const s = sess({ cwd: HOME, path: "C:/nope/x.jsonl" });
  const inferred = await buildPlan({ ...input({ sessions: [s], config: DECIDED, projects: [project("p1", "C:/work/a")], missing: [] }),
    inferProjectRoot: async () => ({ root: "C:/work/a", hits: 7, total: 8, share: 0.875 }) });
  const a = only(inferred).action;
  assert.ok(a.kind === "convert-import");
  assert.equal(a.projectRoot, "C:/work/a");
  assert.deepEqual(a.rehomeShare, { hits: 7, total: 8 });
  const none = await buildPlan({ ...input({ sessions: [s], config: DECIDED }), inferProjectRoot: async () => null });
  const b = only(none).action;
  assert.ok(b.kind === "convert-import");
  assert.equal(b.rehomeShare, undefined);
});

// ---------- sessions started in T3 Code (startedIn "t3"): already there, orphaned, unknown ----------
const ORPHAN_YES: Partial<Config> = { organize: { decided: ["orphaned"] } };
/** A Claude session T3 Code started; `tid` its T3 thread id (handoff), or none. */
const t3sess = (tid: string | undefined, over: Parameters<typeof sess>[0] = {}): DiscoveredSession =>
  ({ ...sess(over), startedIn: "t3", ...(tid !== undefined ? { t3ThreadId: tid } : {}) });

test("T3-started session with its thread present is already in T3 and never bumped", async () => {
  const tid = uuid(7001);
  const s = t3sess(tid);
  const other = sess();
  const p = await plan({ sessions: [s, other], threads: [thread(tid)] });
  const it = p.items.find((i) => i.session === s)!;
  assert.deepEqual([it.action, it.notes], [{ kind: "skip", reason: "already-in-t3" }, ["started-in-t3"]]);
  assert.equal(p.items.find((i) => i.session === other)!.action.kind, "import");
  // A skip is what keeps it from ever being bumped: apply builds its waves from the `import` items only (src/apply/
  // apply.ts), and the importer bumps only wave items (test/apply/importer.test.ts). Filtering the skips here and
  // checking the waves would only test this test.
  assert.equal(p.decisionsPending, undefined);
});

test("thread archived still counts as present", async () => {
  const tid = uuid(7002);
  const it = only(await plan({ sessions: [t3sess(tid)], threads: [thread(tid, { archived: true })] }));
  assert.deepEqual([it.action, it.notes], [{ kind: "skip", reason: "already-in-t3" }, ["started-in-t3"]]);
});

test("thread in another instance still counts", async () => {
  const tid = uuid(7003);
  const it = only(await plan({ sessions: [t3sess(tid)], threads: [thread(tid, { instanceId: "claude-org", projectId: "p9" })] }));
  assert.deepEqual([it.action, it.notes], [{ kind: "skip", reason: "already-in-t3" }, ["started-in-t3"]]);
  // Held by its native ref instead (T3's own record of the session): present too, never copied.
  const s = t3sess(uuid(7004));
  const byRef = only(await plan({ sessions: [s], config: ORPHAN_YES, threads: [thread(uuid(7005), { instanceId: "claude-org", nativeSessionId: s.nativeId })] }));
  assert.deepEqual([byRef.action, byRef.notes], [{ kind: "skip", reason: "already-in-t3" }, ["started-in-t3"]]);
});

test("deleted thread: undecided, then copy after a yes", async () => {
  const { uuidV5 } = await import("../../src/core/uuid.ts");
  const s = t3sess(uuid(7010));
  const gone = await plan({ sessions: [s], threads: [thread(uuid(7011))] });
  assert.deepEqual(only(gone).action, { kind: "skip", reason: "undecided" });
  assert.deepEqual(gone.decisionsPending, [{ key: "orphaned", sessions: 1, folders: 1 }]);

  const u = uuidV5(`claude-orphan:${s.nativeId}`);
  const yes = only(await plan({ sessions: [s], config: ORPHAN_YES }));
  if (yes.action.kind !== "convert-import") throw new Error(`expected convert-import, got ${JSON.stringify(yes.action)}`);
  const { targetFile, ...rest } = yes.action;
  assert.deepEqual(rest, { kind: "convert-import", projectRoot: "C:/work/demo", instanceId: "claudeAgent", expectedThreadId: `import:claudeAgent:${u}`, uuid: u, copy: "faithful" });
  const dir = (f: string): string => f.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  assert.equal(targetFile.replace(/\\/g, "/"), `${HOME}/.claude/projects/C--work-demo/${u}.jsonl`);
  assert.equal(dir(targetFile), dir(s.file.path), "the copy sits next to the original (same project folder)");

  const no = only(await plan({ sessions: [s], config: { organize: { decided: ["orphaned"], sessions: { automated: "skip", orphaned: "skip" } } } }));
  assert.deepEqual(no.action, { kind: "skip", reason: "orphaned-in-t3" });

  // A temp folder (any category) keeps its own folder; a folder T3 Code refuses goes to the rehome target instead.
  const temp = only(await plan({ sessions: [t3sess(uuid(7012), { cwd: `${TMP}/x` })], config: ORPHAN_YES }));
  assert.deepEqual([temp.action.kind, (temp.action as { projectRoot?: string }).projectRoot], ["convert-import", `${TMP}/x`]);
  const refused = await buildPlan({ ...input({ sessions: [t3sess(uuid(7013), { cwd: HOME, path: "C:/nope/o.jsonl" })], config: ORPHAN_YES }), inferProjectRoot: async () => null });
  const ra = only(refused).action;
  if (ra.kind !== "convert-import") throw new Error(`expected convert-import, got ${JSON.stringify(ra)}`);
  assert.deepEqual([ra.projectRoot, ra.rehomeFrom, ra.copy], [GENERAL_EN, HOME, "faithful"]);
});

test("no thread id: t3-native-unknown, never copied", async () => {
  for (const config of [undefined, ORPHAN_YES]) {
    const p = await plan({ sessions: [t3sess(undefined)], ...(config ? { config } : {}) });
    assert.deepEqual([only(p).action, only(p).notes], [{ kind: "skip", reason: "t3-native-unknown" }, []]);
    assert.equal(p.decisionsPending, undefined);
  }
});

test("copy of an orphan is not re-detected as T3-native", async () => {
  const { uuidV5 } = await import("../../src/core/uuid.ts");
  const tid = uuid(7020);
  const s = t3sess(tid);
  const u = uuidV5(`claude-orphan:${s.nativeId}`);
  const target = `${HOME}/.claude/projects/C--work-demo/${u}.jsonl`;
  // The copy keeps every record (entrypoint t3-code, the handoff naming the deleted thread): only cwd and id change.
  const copy = t3sess(tid, { nativeId: u, path: target });
  const journal: JournalEntry[] = [{
    t: "file-written", runId: "r0", path: target, sha256: "0".repeat(64), mtimeMs: 1,
    source: { harness: "claude", nativeId: s.nativeId, updatedAt: s.updatedAt, messageCount: s.messageCount },
    rehomeOf: { path: s.file.path, nativeId: s.nativeId, cwd: "C:/work/demo", size: s.file.size, mtimeMs: s.file.mtimeMs },
  }];
  const act = (p: Plan, x: DiscoveredSession): PlanItem => p.items.find((i) => i.session === x)!;
  // Written, not imported yet: the original's item imports it; the copy is t3sm's own (converted).
  const before = await plan({ sessions: [s, copy], config: ORPHAN_YES, journal });
  assert.equal(act(before, s).action.kind, "convert-import");
  assert.deepEqual(act(before, copy).action, { kind: "skip", reason: "converted" });
  // Imported: both are in T3; no second copy, no question, with or without the journal (copy id fallback).
  for (const j of [journal, []]) {
    const after = await plan({ sessions: [s, copy], config: ORPHAN_YES, journal: j, threads: [thread(`import:claudeAgent:${u}`)] });
    assert.deepEqual([act(after, s).action, act(after, s).notes], [{ kind: "skip", reason: "already-in-t3" }, []]);
    assert.deepEqual([act(after, copy).action, act(after, copy).notes], [{ kind: "skip", reason: "already-in-t3" }, []]);
    assert.equal(after.decisionsPending, undefined);
    assert.equal(after.items.filter((i) => i.action.kind !== "skip").length, 0);
  }
  // The copy resumed outside T3 Code is a rehome copy (isRehomeCopy): never offered to `t3sm merge`.
  const resumed: DiscoveredSession = { ...copy, file: { ...copy.file, size: 5000 } };
  const imported: JournalEntry = { t: "imported", runId: "r0", harness: "claude", nativeId: s.nativeId, threadId: `import:claudeAgent:${u}`, source: { path: target, size: 1000, mtimeMs: copy.file.mtimeMs } };
  const later = await plan({ sessions: [s, resumed], config: ORPHAN_YES, journal: [...journal, imported], threads: [thread(`import:claudeAgent:${u}`)] });
  assert.deepEqual(act(later, resumed).notes, ["continued-after-rehome"]);
});

test("a mirror copy of a T3-started session stays a mirror copy (dedupe still sees it); its kept copy is already in T3", async () => {
  const tid = uuid(7030);
  const p = { ...sess({ nativeId: ID, path: P, accountId: "claudeAgent" }), startedIn: "t3" as const, t3ThreadId: tid };
  const o = { ...sess({ nativeId: ID, path: O, accountId: "claude-org" }), startedIn: "t3" as const, t3ThreadId: tid };
  const out = await plan({ sessions: [p, o], pins: { "C:/work/demo": "C:\\Users\\demo\\.claude-org" }, compare: { [`${P}|${O}`]: "identical" }, threads: [thread(tid)] });
  const by = new Map(out.items.map((i) => [i.session.file.path, i]));
  assert.deepEqual([by.get(O)!.action, by.get(O)!.notes], [{ kind: "skip", reason: "already-in-t3" }, ["started-in-t3"]]);
  assert.deepEqual(by.get(P)!.action, { kind: "skip", reason: "mirror-copy" });
  assert.deepEqual(out.mirrorCopies, [{ path: P, nativeId: ID, keptPath: O, relation: "identical" }]);
});

test("an orphan under a skip override is excluded, whatever the orphaned answer", async () => {
  const config: Partial<Config> = { organize: { decided: ["orphaned"], overrides: [{ match: "C:/work/demo/**", action: "skip" }, { match: `${HOME}`, action: "skip" }] } };
  for (const cwd of ["C:/work/demo/x", HOME]) {
    const p = await plan({ sessions: [t3sess(uuid(7040), { cwd, path: "C:/nope/x.jsonl" })], config });
    assert.deepEqual(only(p).action, { kind: "skip", reason: "excluded" }, cwd);
    assert.equal(p.decisionsPending, undefined, cwd);
  }
  // Undecided too: the user's own rule wins over the question.
  const undecided = await plan({ sessions: [t3sess(uuid(7041), { cwd: "C:/work/demo/x" })], config: { organize: { overrides: [{ match: "C:/work/demo/**", action: "skip" }] } } });
  assert.deepEqual([only(undecided).action, undecided.decisionsPending], [{ kind: "skip", reason: "excluded" }, undefined]);
});

test("an orphan under a rehome:<folder> override is copied into that folder", async () => {
  const { uuidV5 } = await import("../../src/core/uuid.ts");
  for (const cwd of ["C:/work/demo/x", HOME]) {
    const s = t3sess(uuid(7050), { cwd, path: "C:/nope/r.jsonl" });
    const config: Partial<Config> = { organize: { decided: ["orphaned"], overrides: [{ match: cwd, action: "rehome:~/code/app" }] } };
    const a = only(await plan({ sessions: [s], config })).action;
    if (a.kind !== "convert-import") throw new Error(`expected convert-import, got ${JSON.stringify(a)}`);
    const u = uuidV5(`claude-orphan:${s.nativeId}`);
    assert.deepEqual([a.projectRoot, a.rehomeFrom, a.copy, a.uuid], [`${HOME}/code/app`, cwd, "faithful", u], cwd);
    assert.equal(a.targetFile.replace(/\\/g, "/"), `${HOME}/.claude/projects/C--Users-demo-code-app/${u}.jsonl`);
  }
});
