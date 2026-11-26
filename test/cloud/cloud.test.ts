import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { CloudRequestError, CloudSchemaError, CloudUnavailable, decodeListPage, decodeTranscriptPage, isCloudOnly, type CloudEntry, type CloudSession } from "../../src/cloud/decode.ts";
import { cloudChildEnv, getCloudTranscript, listCloudSessions, openCloud, type CloudProc, type SpawnCloud } from "../../src/cloud/client.ts";
import { cloudLocalId, isCompacted, messageCount, toLocalTranscript, CLOUD_PROVENANCE_TYPE } from "../../src/cloud/transcript.ts";
import { githubRepoOf, originOf, findCheckout, planCheckout, plausibleBranch, prepareCheckout, safeSegment, CheckoutRefused, type Git, type GitResult } from "../../src/cloud/checkout.ts";
import { cloudWrites, localState } from "../../src/cloud/state.ts";
import { cloudTarget, previewPull, writePulls } from "../../src/cloud/pull.ts";
import { Journal } from "../../src/core/journal.ts";
import { isUuid } from "../../src/core/uuid.ts";
import { onlyThese, suggestBase } from "../../src/cli/commands/cloud.ts";
import { cloudCommand } from "../../src/cli/commands/cloud.ts";
import type { Io } from "../../src/cli/main.ts";
import type { AccountConfig, JournalEntry } from "../../src/core/types.ts";

const temps: string[] = [];
after(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), "t3sm-cloud-")); temps.push(d); return d; };
const P = process.platform;

const row = (o: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: "session_01AbCdEfGhIjKlMn", title: "Fix the login form", status: "idle", environment_kind: "anthropic_cloud",
  repository: { owner: "acme", name: "demo" }, branch: "claude/fix-login", last_event_at: "2026-11-20T10:00:00.000Z", created_at: "2026-11-19T10:00:00.000Z", origin: "android", ...o,
});
const session = (o: Partial<Record<string, unknown>> = {}): CloudSession => decodeListPage({ status: "ok", sessions: [row(o)] }).sessions[0]!;
const entries = (n: number): CloudEntry[] => Array.from({ length: n }, (_, i) => ({
  type: i % 2 === 0 ? "user" : "assistant", parentUuid: i === 0 ? null : `u${i - 1}`, uuid: `u${i}`, sessionId: "session_01AbCdEfGhIjKlMn", timestamp: `2026-11-20T09:00:0${i}.000Z`,
  message: { role: i % 2 === 0 ? "user" : "assistant", content: `invented text ${i}` },
}));

// ---------- decode ----------

test("decodeListPage: rows, cursor, bridge rows recognised, missing repository is null", () => {
  const p = decodeListPage({ status: "ok", sessions: [row(), row({ id: "session_2", environment_kind: "bridge" }), row({ id: "session_3", repository: undefined, branch: null, current_branch: "main" })], truncated: true, next_cursor: "c1" });
  assert.equal(p.next, "c1");
  assert.equal(p.sessions.length, 3);
  assert.deepEqual(p.sessions[0]!.repo, { owner: "acme", name: "demo" });
  assert.equal(isCloudOnly(p.sessions[1]!), false);
  assert.equal(p.sessions[2]!.repo, null);
  assert.equal(p.sessions[2]!.branch, "main");
});

test("decode: a non-ok status is the service's answer; a wrong shape is CloudSchemaError", () => {
  assert.throws(() => decodeListPage({ status: "error", message: "not signed in" }), (e: unknown) => e instanceof CloudRequestError && /not signed in/.test((e as Error).message));
  assert.throws(() => decodeListPage({ status: "ok", sessions: "x" }), CloudSchemaError);
  assert.throws(() => decodeListPage({ status: "ok", sessions: [{ title: "no id" }] }), CloudSchemaError);
  assert.throws(() => decodeListPage({ status: "ok", sessions: [row({ repository: { owner: 1 } })] }), CloudSchemaError);
  assert.throws(() => decodeTranscriptPage({ status: "ok", entries: [{ uuid: "x" }] }), CloudSchemaError);
  assert.equal(decodeTranscriptPage({ status: "ok", entries: entries(2), next_cursor: null }).next, null);
});

// ---------- client ----------

/** A fake `claude`: answers control requests with `answer(request)` (null: stays silent). */
function fakeSpawn(answer: (req: Record<string, unknown>) => unknown, seen: { args?: readonly string[]; env?: Record<string, string>; killed?: number; reqs: Record<string, unknown>[] } = { reqs: [] }): { spawn: SpawnCloud; seen: typeof seen } {
  const spawn: SpawnCloud = (_bin, args, env) => {
    seen.args = args; seen.env = env;
    let line: (l: string) => void = () => {};
    const exits: ((c: number | null, e: string) => void)[] = [];
    let done = false;
    const exit = (c: number | null): void => { if (done) return; done = true; for (const x of exits) x(c, "bye"); };
    const proc: CloudProc = {
      write(l) {
        const m = JSON.parse(l) as { request_id: string; request: Record<string, unknown> };
        seen.reqs.push(m.request);
        const a = answer(m.request);
        if (a === null) return;
        queueMicrotask(() => {
          line("{\"type\":\"system\",\"subtype\":\"noise\"}");
          line(JSON.stringify({ type: "control_response", response: a instanceof Error ? { subtype: "error", request_id: m.request_id, error: a.message } : { subtype: "success", request_id: m.request_id, response: a } }));
        });
      },
      end: () => queueMicrotask(() => exit(0)),
      onLine: (cb) => { line = cb; },
      onExit: (cb) => { if (done) cb(0, ""); else exits.push(cb); },
      kill: () => { seen.killed = (seen.killed ?? 0) + 1; exit(null); },
    };
    return proc;
  };
  return { spawn, seen };
}

test("client: initialize first, then every list page and every transcript page", async () => {
  const pages: Record<string, unknown> = { "": { status: "ok", sessions: [row()], next_cursor: "p2" }, p2: { status: "ok", sessions: [row({ id: "session_2" })], next_cursor: null } };
  const { spawn, seen } = fakeSpawn((r) => {
    if (r["subtype"] === "initialize") return {};
    if (r["subtype"] === "list_cloud_sessions") return pages[(r["cursor"] as string | undefined) ?? ""];
    if (r["subtype"] === "get_cloud_session_transcript") return r["cursor"] ? { status: "ok", entries: entries(1) } : { status: "ok", entries: entries(2), next_cursor: "t2" };
    return new Error("unexpected");
  });
  const c = await openCloud({ bin: "claude", env: {}, spawn });
  assert.deepEqual((await listCloudSessions(c)).map((s) => s.id), ["session_01AbCdEfGhIjKlMn", "session_2"]);
  assert.equal((await getCloudTranscript(c, "session_2")).length, 3);
  await c.close();
  assert.equal(seen.reqs[0]!["subtype"], "initialize");
  assert.equal(seen.reqs[1]!["user_initiated"], true);
  assert.deepEqual(seen.args, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
  assert.equal(seen.reqs.find((r) => r["subtype"] === "get_cloud_session_transcript")!["limit"], 1000);
});

test("client: an error answer is CloudRequestError; silence is a timeout that kills only this child", async () => {
  const { spawn, seen } = fakeSpawn((r) => (r["subtype"] === "initialize" ? {} : r["subtype"] === "get_cloud_session" ? new Error("no such session") : null));
  const c = await openCloud({ bin: "claude", env: {}, spawn, timeoutMs: 30 });
  await assert.rejects(c.request({ subtype: "get_cloud_session", session_id: "x" }), CloudRequestError);
  await assert.rejects(c.request({ subtype: "list_cloud_sessions" }), CloudUnavailable);
  assert.equal(seen.killed, 1);
  await assert.rejects(c.request({ subtype: "list_cloud_sessions" }), CloudUnavailable); // gone stays gone
});

test("cloudChildEnv: no inherited account, no parent session, no API keys; the account's own home unless it is ~/.claude", () => {
  const base = { PATH: "/bin", claude_config_dir: "/elsewhere", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_GIT_BASH_PATH: "C:/git/bash.exe" };
  const home = P === "win32" ? "C:\\Users\\demo" : "/home/demo";
  const def = cloudChildEnv(base, join(home, ".claude"), home, P);
  assert.deepEqual(Object.keys(def).sort(), ["CLAUDE_CODE_GIT_BASH_PATH", "PATH"]);
  const org = cloudChildEnv(base, join(home, ".claude-org"), home, P);
  assert.equal(org["CLAUDE_CONFIG_DIR"], join(home, ".claude-org"));
  assert.equal(org["ANTHROPIC_API_KEY"], undefined);
});

// ---------- transcript ----------

test("toLocalTranscript: local ids in place, missing keys appended, provenance last, deterministic", () => {
  const e = entries(3);
  const id = cloudLocalId("session_01AbCdEfGhIjKlMn");
  assert.ok(isUuid(id));
  assert.notEqual(cloudLocalId("session_01AbCdEfGhIjKlMn", 3), id);
  const o = { sessionId: id, cwd: "C:\\work\\demo", gitBranch: "claude/fix-login", provenance: { fromCloudSession: "session_01AbCdEfGhIjKlMn", fromAccount: "default", lastEventAt: "2026-11-20T10:00:00.000Z", entries: 3 } };
  const text = toLocalTranscript(e, o);
  assert.equal(text, toLocalTranscript(e, o));
  const lines = text.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(lines.length, 4);
  assert.deepEqual(Object.keys(lines[0]!), ["type", "parentUuid", "uuid", "sessionId", "timestamp", "message", "cwd", "gitBranch"]);
  assert.equal(lines[1]!["sessionId"], id);
  assert.equal(lines[1]!["uuid"], "u1");
  assert.equal(lines[3]!["type"], CLOUD_PROVENANCE_TYPE);
  assert.equal(lines[3]!["uuid"], undefined);
  assert.equal(messageCount(e), 3);
  assert.equal(isCompacted(e), false);
  assert.equal(isCompacted([{ type: "system", subtype: "compact_boundary" }, ...e]), true);
});

// ---------- checkout ----------

test("names: untrusted segments, branches and remotes", () => {
  assert.equal(safeSegment("../../etc"), "etc");
  assert.equal(safeSegment(".."), null);
  assert.equal(safeSegment("my repo!"), "my-repo");
  assert.equal(plausibleBranch("claude/fix-login"), true);
  assert.equal(plausibleBranch("-x"), false);
  assert.equal(plausibleBranch("a..b"), false);
  assert.equal(plausibleBranch("a b"), false);
  assert.deepEqual(githubRepoOf("https://github.com/Acme/Demo.git"), { owner: "acme", name: "demo" });
  assert.deepEqual(githubRepoOf("git@github.com:acme/demo.git"), { owner: "acme", name: "demo" });
  assert.equal(githubRepoOf("https://gitlab.com/acme/demo.git"), null);
});

function fakeRepo(root: string, url: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
}

test("planCheckout: reuse a checkout found by origin, else clone under the base; worktree under .worktrees", async () => {
  const d = scratch();
  const mine = join(d, "code", "demo");
  fakeRepo(mine, "git@github.com:acme/demo.git");
  assert.equal(await originOf(mine), "git@github.com:acme/demo.git");
  const s = session();
  const found = await findCheckout(s.repo!, [join(d, "nothing"), mine]);
  assert.equal(found, mine);
  const reuse = await planCheckout(s, join(d, "base"), found, P);
  assert.ok(reuse.kind === "repo" && !reuse.clone && reuse.main === mine);
  assert.ok(reuse.kind === "repo" && reuse.worktree === join(d, "base", ".worktrees", "acme", "demo", "claude-fix-login"));
  const clone = await planCheckout(s, join(d, "base"), null, P);
  assert.ok(clone.kind === "repo" && clone.clone && clone.main === join(d, "base", "acme", "demo") && clone.url === "https://github.com/acme/demo.git");
  const folder = await planCheckout(session({ repository: null }), join(d, "base"), null, P);
  assert.deepEqual(folder, { kind: "folder", cwd: join(d, "base", "cloud-sessions", "01AbCdEfGhIj") });
  // Something else in the way is refused, never reused.
  mkdirSync(join(d, "base2", "acme", "demo"), { recursive: true });
  await assert.rejects(planCheckout(s, join(d, "base2"), null, P), (e: unknown) => e instanceof CheckoutRefused && e.reason === "not-a-checkout");
  await assert.rejects(planCheckout(session({ branch: "-rf" }), join(d, "base"), null, P), (e: unknown) => e instanceof CheckoutRefused && e.reason === "bad-branch");
});

const okr = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const bad = (stderr: string): GitResult => ({ code: 128, stdout: "", stderr, timedOut: false });

test("prepareCheckout: clone, fetch the branch, add a tracking worktree (never in the main tree)", async () => {
  const d = scratch();
  const calls: string[][] = [];
  const git: Git = async (a) => { calls.push(a); return a[2] === "rev-parse" ? bad("") : okr(a[2] === "worktree" && a[3] === "list" ? `worktree ${join(d, "acme", "demo")}\nHEAD abc\nbranch refs/heads/main\n\n` : ""); };
  const plan = await planCheckout(session(), d, null, P);
  const r = await prepareCheckout(plan, git, P);
  assert.equal(r.cwd, join(d, ".worktrees", "acme", "demo", "claude-fix-login"));
  assert.equal(r.cloned, join(d, "acme", "demo"));
  assert.equal(r.worktreeAdded, r.cwd);
  assert.deepEqual(calls[0], ["clone", "--", "https://github.com/acme/demo.git", join(d, "acme", "demo")]);
  assert.deepEqual(calls[1], ["-C", join(d, "acme", "demo"), "fetch", "origin", "+refs/heads/claude/fix-login:refs/remotes/origin/claude/fix-login"]);
  assert.deepEqual(calls.at(-1), ["-C", join(d, "acme", "demo"), "worktree", "add", "--track", "-b", "claude/fix-login", r.cwd, "origin/claude/fix-login"]);
});

test("prepareCheckout: a branch already checked out is used where it is; a branch gone falls back to the main checkout", async () => {
  const d = scratch();
  const main = join(d, "acme", "demo");
  fakeRepo(main, "https://github.com/acme/demo");
  const plan = await planCheckout(session(), d, main, P);
  const there: Git = async (a) => okr(a[2] === "worktree" ? `worktree ${main}\nHEAD abc\nbranch refs/heads/claude/fix-login\n` : "");
  assert.equal((await prepareCheckout(plan, there, P)).cwd, path.normalize(main));
  const gone: Git = async (a) => (a[2] === "fetch" ? bad("fatal: couldn't find remote ref refs/heads/claude/fix-login") : okr());
  const g = await prepareCheckout(plan, gone, P);
  assert.equal(g.cwd, main);
  assert.equal(g.branchGone, true);
});

// ---------- state, preview and write ----------

const account = (home: string): AccountConfig => ({ id: "default", home, displayName: "Personal", accentColor: null });

test("writePulls: journaled before publish, file time from the cloud, then nothing / newer / continued / conflict", async () => {
  const d = scratch();
  const home = join(d, ".claude");
  const base = join(d, "base");
  const journal = new Journal(join(d, "state", "journal.jsonl"));
  mkdirSync(join(d, "state"), { recursive: true });
  const now = Date.parse("2026-11-26T12:00:00.000Z");
  const git: Git = async (a) => (a[2] === "rev-parse" ? bad("") : okr());
  let served = entries(4);
  const conn = async () => ({ request: async (r: Record<string, unknown>) => (r["subtype"] === "get_cloud_session_transcript" ? { status: "ok", entries: served } : {}), close: async () => {} });
  const deps = { journal, runId: "run-1", now: () => now, platform: P, conn, git };

  const s1 = session();
  const t = { account: account(home), session: s1 };
  let items = await previewPull([t], { base, roots: [], writes: cloudWrites(await journal.readAll()), platform: P });
  assert.equal(items[0]!.todo, "pull");
  const [first] = await writePulls(items, deps);
  assert.equal(first!.outcome.kind, "written");
  const w = first!.outcome.kind === "written" ? first!.outcome : null!;
  assert.equal(w.localId, cloudLocalId(s1.id));
  assert.equal(w.file, cloudTarget(home, w.cwd, w.localId, P));
  assert.equal(statSync(w.file).mtimeMs, Date.parse("2026-11-20T10:00:00.000Z"));
  const log = await journal.readAll();
  const kinds = log.map((e) => e.t);
  assert.deepEqual(kinds, ["cloud-checkout", "file-written"]);
  const fw = log[1] as Extract<JournalEntry, { t: "file-written" }>;
  assert.deepEqual(fw.cloudOf, { account: "default", sessionId: s1.id, lastEventAt: s1.lastEventAt, entries: 4 });
  assert.equal(readFileSync(w.file, "utf8").split("\n")[0]!.includes(JSON.stringify(w.cwd).slice(1, -1).replaceAll("\\\\", "\\\\")), true);

  // Nothing new in the cloud: nothing to do.
  const writes = cloudWrites(await journal.readAll());
  assert.equal((await localState(s1, writes.get(s1.id))).state, "local");
  items = await previewPull([t], { base, roots: [], writes, platform: P });
  assert.equal(items[0]!.todo, "nothing");

  // The cloud went on: a new revision with its own id.
  served = entries(6);
  const s2 = session({ last_event_at: "2026-11-21T10:00:00.000Z" });
  items = await previewPull([{ account: account(home), session: s2 }], { base, roots: [], writes, platform: P });
  assert.equal(items[0]!.todo, "update");
  const [second] = await writePulls(items, { ...deps, runId: "run-2" });
  assert.ok(second!.outcome.kind === "written" && second!.outcome.revisionOf === w.localId && second!.outcome.localId === cloudLocalId(s1.id, 6));

  // Continued here (the newest copy changed) and newer in the cloud: a conflict, nothing written.
  const latest = second!.outcome.kind === "written" ? second!.outcome.file : "";
  writeFileSync(latest, readFileSync(latest, "utf8") + "{\"type\":\"user\",\"uuid\":\"local\"}\n");
  const s3 = session({ last_event_at: "2026-11-22T10:00:00.000Z" });
  const w3 = cloudWrites(await journal.readAll());
  assert.equal((await localState(s3, w3.get(s1.id))).state, "continued");
  items = await previewPull([{ account: account(home), session: s3 }], { base, roots: [], writes: w3, platform: P });
  assert.equal(items[0]!.todo, "conflict");
  assert.equal((await writePulls(items, deps))[0]!.outcome.kind, "skipped");
});

test("writePulls: active in the cloud in the last 10 minutes waits; a file t3sm did not write is never replaced", async () => {
  const d = scratch();
  const home = join(d, ".claude");
  const journal = new Journal(join(d, "journal.jsonl"));
  const now = Date.parse("2026-11-26T12:00:00.000Z");
  const git: Git = async (a) => (a[2] === "rev-parse" ? bad("") : okr());
  const conn = async () => ({ request: async () => ({ status: "ok", entries: entries(2) }), close: async () => {} });
  const busy = session({ last_event_at: "2026-11-26T11:58:00.000Z" });
  let items = await previewPull([{ account: account(home), session: busy }], { base: join(d, "b"), roots: [], writes: new Map(), platform: P });
  assert.deepEqual((await writePulls(items, { journal, runId: "r", now: () => now, platform: P, conn, git }))[0]!.outcome, { kind: "deferred", why: "active" });

  const s = session({ repository: null });
  items = await previewPull([{ account: account(home), session: s }], { base: join(d, "b"), roots: [], writes: new Map(), platform: P });
  const cwd = join(d, "b", "cloud-sessions", "01AbCdEfGhIj");
  const target = cloudTarget(home, cwd, cloudLocalId(s.id), P);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "someone else's\n");
  const r = (await writePulls(items, { journal, runId: "r", now: () => now, platform: P, conn, git }))[0]!.outcome;
  assert.equal(r.kind, "failed");
  assert.equal(readFileSync(target, "utf8"), "someone else's\n");
  assert.ok(existsSync(cwd));
});

test("review regressions: newer only by its time writes no revision; a transcript cut short is never written", async () => {
  const d = scratch();
  const home = join(d, ".claude");
  const journal = new Journal(join(d, "journal.jsonl"));
  const now = Date.parse("2026-11-26T12:00:00.000Z");
  const git: Git = async (a) => (a[2] === "rev-parse" || a[2] === "symbolic-ref" ? bad("") : okr());
  const conn = async () => ({ request: async () => ({ status: "ok", entries: entries(4) }), close: async () => {} });
  const deps = { journal, runId: "r1", now: () => now, platform: P, conn, git };
  const s = session({ repository: null });
  let items = await previewPull([{ account: account(home), session: s }], { base: join(d, "b"), roots: [], writes: new Map(), platform: P });
  assert.equal((await writePulls(items, deps))[0]!.outcome.kind, "written");
  const bumped = session({ repository: null, last_event_at: "2026-11-23T10:00:00.000Z" });
  items = await previewPull([{ account: account(home), session: bumped }], { base: join(d, "b"), roots: [], writes: cloudWrites(await journal.readAll()), platform: P });
  assert.equal(items[0]!.todo, "update");
  assert.deepEqual((await writePulls(items, { ...deps, runId: "r2" }))[0]!.outcome, { kind: "skipped", why: "nothing" });

  const { spawn } = fakeSpawn((r) => (r["subtype"] === "initialize" ? {} : { status: "ok", entries: entries(1), next_cursor: "more" }));
  const c = await openCloud({ bin: "claude", env: {}, spawn });
  await assert.rejects(getCloudTranscript(c, "session_x"), CloudUnavailable);
});

// ---------- command ----------

function io(o: { isTTY?: boolean } = {}): Io & { out: string[]; err: string[] } {
  const out: string[] = [], err: string[] = [];
  return { out, err, stdout: (s) => out.push(s), stderr: (s) => err.push(s), isTTY: o.isTTY ?? false, prompt: async () => "", env: { T3SM_HOME: scratch() }, lang: "en" };
}

test("cloud pull without a terminal and without --yes exits 2 before anything; bad ids and options exit 2", async () => {
  const deps = { home: scratch(), findBin: () => "claude", spawn: (() => { throw new Error("must not start"); }) as unknown as SpawnCloud };
  const i = io();
  assert.equal(await cloudCommand(["pull", "01AbCdEfGh"], i, deps), 2);
  assert.equal(await cloudCommand(["pull"], io(), deps), 2);
  assert.equal(await cloudCommand(["pull", "x!"], io(), deps), 2);
  assert.equal(await cloudCommand(["--nope"], io(), deps), 2);
  assert.equal(await cloudCommand(["pull", "--yes", "--dry-run", "01AbCdEfGh"], io(), deps), 2);
});

const homeWithClaude = (): string => { const h = scratch(); mkdirSync(join(h, ".claude", "projects"), { recursive: true }); return h; };

test("cloud (list) reads only: rows per account, bridge left out, --json", async () => {
  const { spawn } = fakeSpawn((r) => (r["subtype"] === "initialize" ? {} : { status: "ok", sessions: [row(), row({ id: "session_bridge1", environment_kind: "bridge" }), row({ id: "session_old12345", status: "archived" })] }));
  const i = io();
  assert.equal(await cloudCommand(["--json"], i, { home: homeWithClaude(), findBin: () => "claude", spawn }), 0);
  const j = JSON.parse(i.out.join("")) as { sessions: { id: string; state: string }[] };
  assert.deepEqual(j.sessions.map((s) => [s.id, s.state]), [["session_01AbCdEfGhIjKlMn", "remote"]]);
  const k = io();
  assert.equal(await cloudCommand([], k, { home: homeWithClaude(), findBin: () => "claude", spawn }), 0);
  assert.match(k.out.join(""), /Fix the login form/);
  assert.match(k.out.join(""), /cloud only/);
});

test("suggestBase and onlyThese", () => {
  const roots = P === "win32" ? ["D:\\code\\a", "D:\\code\\b", "E:\\x\\c"] : ["/srv/code/a", "/srv/code/b", "/x/c"];
  assert.equal(suggestBase(roots, P === "win32" ? "C:\\Users\\demo" : "/home/demo", P), P === "win32" ? "D:\\code" : "/srv/code");
  const plan = {
    items: [
      { session: { harness: "claude", nativeId: "keep" }, action: { kind: "import", projectRoot: roots[0], instanceId: "i1" } },
      { session: { harness: "claude", nativeId: "other" }, action: { kind: "import", projectRoot: roots[1], instanceId: "i2" } },
    ],
    projectsToCreate: [{ root: roots[0] }, { root: roots[1] }], instancesToCreate: [{ id: "i1" }, { id: "i2" }], projectDefaults: [], mirrorCopies: [{}], pinDefault: {},
  } as never;
  const r = onlyThese(plan, new Set(["keep"]), P);
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.projectsToCreate, [{ root: roots[0] }]);
  assert.deepEqual(r.instancesToCreate, [{ id: "i1" }]);
  assert.equal(r.pinDefault, null);
});
