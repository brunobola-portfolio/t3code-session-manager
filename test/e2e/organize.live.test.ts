// Gated live test (T3_E2E=1, Windows): `t3sm organize` end to end against the running T3 Code, through t3sm's real code
// (applyPlan, buildOrganize, applyOrganize, undoOrganize, the faithful rehome copy, deleteProject). Productizes the S6
// spike (docs/spikes/S6-organize.md). Synthetic data only, in the PERSONAL account home (<homedir>/.claude, verified
// to be claudeAgent's T3 home before anything is written), for the disposable roots `.spike/organize-e2e` (A),
// `.spike/organize-e2e-target` (B) and `.spike/organize-e2e-empty` (project.delete):
//   A. one human transcript (entrypoint "cli"), one human transcript whose first message is technical, one automated
//      transcript (entrypoint "sdk-py", technical first message) are imported with applyPlan; then buildOrganize (every
//      change it plans for the OTHER projects of the machine is dropped, so no user project can be changed or pinned)
//      -> archive the automated thread (its title stays: R16), show both human threads inside the project (unsettle),
//      retitle the technical human one, pin the project; a conversation of one command keeps its technical title, so T3
//      Code writes it (`--ai-titles`, synthetic text only); undoOrganize puts every one back.
//   B. a synthetic "home-folder" conversation (cwd = the home folder, which T3 Code refuses) is copied faithfully into
//      the target project by the real apply path, imported, and `claude --resume <copy id> -p` answers from the copied
//      history. The original is a file in a TEMP dir (the faithful copy reads a file); it is never under ~/.claude.
//   C. an empty project is created and deleted through `deleteProject` (the response decodes, the project is gone).
// Everything created is removed in `finally`: the T3 projects (by id, with their threads), the transcripts and the
// encoded dirs (none existed before), the roots and the temp dirs; leftovers are logged with the command to remove them.
// Run it with CLAUDE_CONFIG_DIR unset; it refuses otherwise. It spends a few tokens (one `claude --resume -p` turn).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyPlan, type SignalSource } from "../../src/apply/apply.ts";
import { PROVENANCE_TYPE } from "../../src/apply/copyTranscript.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { Journal, recoverPendingMtimes } from "../../src/core/journal.ts";
import { acquireLock } from "../../src/core/lock.ts";
import { encodeClaudeProjectDir, sameCwd } from "../../src/core/paths.ts";
import type { Config, DiscoveredSession } from "../../src/core/types.ts";
import { buildOrganize } from "../../src/cli/commands/organize.ts";
import type { Io } from "../../src/cli/main.ts";
import { applyOrganize, undoOrganize } from "../../src/organize/apply.ts";
import { isVisibleInProject } from "../../src/organize/plan.ts";
import type { OrganizePlan } from "../../src/organize/types.ts";
import { buildPlan } from "../../src/plan/planner.ts";
import { createClaudeAdapter, scanTranscript } from "../../src/sources/claude.ts";
import type { SourceAdapter } from "../../src/sources/types.ts";
import { connectT3, instancesFromConfig, type T3Api, type T3Thread } from "../../src/t3/api.ts";
import { defaultRunner } from "../../src/t3/auth.ts";
import { resolveT3Cli } from "../../src/t3/runtime.ts";

const DAY = 86_400_000;
const noSignals: SignalSource = { on: () => {}, off: () => {} };
const log = (s: string): void => console.log(`live: ${s}`);

/** One shell command (claude is a .cmd shim on Windows) in `cwd`, 3-minute cap; never throws. */
function runClaude(command: string, cwd: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    let stdout = "", stderr = "";
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill(); }, 180_000); // our own child, by handle
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); res({ code: null, stdout, stderr: stderr + String(e) }); });
    child.on("close", (code) => { clearTimeout(timer); res({ code, stdout, stderr }); });
  });
}

/** A Claude transcript: `texts` alternate user / assistant; every record carries `entrypoint`, `cwd` and the session id. */
function writeTranscript(path: string, o: { cwd: string; sid: string; entrypoint: string; t0: number; texts: string[] }): void {
  const recs: Record<string, unknown>[] = [];
  let parent: string | null = null;
  o.texts.forEach((text, i) => {
    const uuid = randomUUID();
    const user = i % 2 === 0;
    recs.push({
      parentUuid: parent, isSidechain: false, userType: "external", entrypoint: o.entrypoint, cwd: o.cwd, sessionId: o.sid, version: "2.1.0",
      type: user ? "user" : "assistant",
      message: user ? { role: "user", content: text } : { role: "assistant", content: [{ type: "text", text }] },
      uuid, timestamp: new Date(o.t0 + i * 1000).toISOString(),
    });
    parent = uuid;
  });
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

/** The discovery record of a transcript file, measured by the real scanner. */
async function discovered(path: string, accountId: string, origin: "human" | "automated"): Promise<DiscoveredSession> {
  const st = statSync(path);
  const sc = await scanTranscript(path);
  return {
    harness: "claude", accountId, nativeId: sc.sessionId ?? "", cwd: sc.cwd, startedAt: sc.startedAt ?? new Date(st.mtimeMs).toISOString(),
    updatedAt: sc.updatedAt ?? new Date(st.mtimeMs).toISOString(), messageCount: sc.messageCount, corruptLines: sc.corruptLines,
    file: { path, size: st.size, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs }, flags: [], cwdOffsetBytes: sc.cwdOffsetBytes, origin,
  };
}

async function snap(api: T3Api) {
  return { version: api.version, projects: await api.listProjects(), threads: await api.listThreads(), providers: await api.providerInstances(), instances: instancesFromConfig(await api.getConfig()) };
}

/** Polls `read` until `ok` holds (T3's projections settle a moment after a command); throws with `what` otherwise. */
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) assert.fail(`${what} (last: ${JSON.stringify(v)})`);
    await new Promise((r) => setTimeout(r, 750));
  }
}

const existsDir = async (d: string): Promise<boolean> => { try { return (await stat(d)).isDirectory(); } catch { return false; } };

test("live organize: archive / show / retitle / pin / undo on imported synthetic threads, a faithful rehome copy imports and resumes, project.delete decodes (T3_E2E=1)", {
  skip: process.env.T3_E2E !== "1" || process.platform !== "win32", timeout: 480_000,
}, async () => {
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined, "run with CLAUDE_CONFIG_DIR unset");
  const home = homedir();
  const claudeHome = join(home, ".claude");
  const spike = resolve(import.meta.dirname, "..", "..", ".spike");
  const roots = { a: join(spike, "organize-e2e"), target: join(spike, "organize-e2e-target"), empty: join(spike, "organize-e2e-empty") };
  const encoded = { a: join(claudeHome, "projects", encodeClaudeProjectDir(roots.a)), target: join(claudeHome, "projects", encodeClaudeProjectDir(roots.target)) };
  const cli = resolveT3Cli(home, process.platform, process.env.PATH ?? "");
  assert.ok(cli, "t3 cli found");
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k.toUpperCase() !== "CLAUDE_CONFIG_DIR") childEnv[k] = v;

  // ---------- read-only preflight: nothing is written unless all of this holds ----------
  const pre = await connectT3(home, { allowUntested: false, onNotice: (l) => log(`notice: ${l}`) });
  try {
    const providers = await pre.providerInstances();
    const ca = providers.find((p) => p.instanceId === "claudeAgent");
    assert.ok(ca && ca.homePath !== null && sameCwd(ca.homePath, claudeHome), `claudeAgent must read ${claudeHome} (got ${ca?.homePath})`);
    const projects = await pre.listProjects();
    for (const r of Object.values(roots)) assert.ok(!projects.some((p) => sameCwd(p.workspaceRoot, r)), `a T3 project for ${r} already exists (leftover?); remove it by hand first`);
  } finally { await pre.close(); }
  for (const d of Object.values(encoded)) assert.ok(!existsSync(d), `${d} already exists; refusing to write next to unknown files`);
  for (const r of Object.values(roots)) assert.ok(!existsSync(r), `${r} already exists (leftover?)`);

  const state = mkdtempSync(join(tmpdir(), "t3sm-organize-e2e-"));
  const origDir = join(state, "orig"); // the "home-folder" original of B: a temp file, never under ~/.claude
  const journalFile = join(state, "journal.jsonl");
  const touchables = { cfg: join(claudeHome, ".claude.json"), hist: join(claudeHome, "history.jsonl") };
  const touch = (): string => {
    const f = (p: string): string => { try { const st = statSync(p); return `${st.size} bytes, mtime ${st.mtime.toISOString()}`; } catch { return "absent"; } };
    return `.claude.json: ${f(touchables.cfg)}; history.jsonl: ${f(touchables.hist)}`;
  };
  const touchBefore = touch();
  const createdProjects = new Set<string>();
  const copyIds: string[] = [];
  let api: T3Api | null = null;
  let original: unknown = null;
  try {
    for (const r of Object.values(roots)) mkdirSync(r, { recursive: true });
    mkdirSync(encoded.a, { recursive: true });
    mkdirSync(origDir, { recursive: true });
    api = await connectT3(home, { allowUntested: false, onNotice: (l) => log(`notice: ${l}`) });
    const t3 = api;
    const config: Config = {
      ...defaultConfig([{ id: "claudeAgent", home: claudeHome, displayName: "Claude", accentColor: null }]),
      // The automated session is imported (default: skipped) so there is a thread for organize to archive; "home" is
      // answered (rehome) so the home-folder copy of B is planned.
      organize: { sessions: { automated: "import" }, decided: ["automated", "home"] },
    };
    const deps = {
      stateDir: state, home, signals: noSignals, accountHomes: () => ({ claudeAgent: claudeHome }),
      onProgress: (l: string) => log(l), onNotice: (l: string) => log(`notice: ${l}`),
    };
    const now = Date.now();

    // =============== A: import, then organize and undo through the real code ===============
    const sidH1 = randomUUID(), sidH2 = randomUUID(), sidH3 = randomUUID(), sidA1 = randomUUID();
    const files = { h1: join(encoded.a, `${sidH1}.jsonl`), h2: join(encoded.a, `${sidH2}.jsonl`), h3: join(encoded.a, `${sidH3}.jsonl`), a1: join(encoded.a, `${sidA1}.jsonl`) };
    const recent = now - 120_000; // user messages two minutes old: project A is the most recently active, so it is pinned
    writeTranscript(files.h1, { cwd: roots.a, sid: sidH1, entrypoint: "cli", t0: recent, texts: ["t3sm organize e2e: what is 2 + 2?", "4."] });
    writeTranscript(files.h2, { cwd: roots.a, sid: sidH2, entrypoint: "cli", t0: recent + 10_000, texts: [
      "<command-name>/model</command-name>", "Model set.", "t3sm organize e2e: explain the codeword KIWI-23 in one line.", "KIWI-23 is a codeword.",
    ] });
    writeTranscript(files.a1, { cwd: roots.a, sid: sidA1, entrypoint: "sdk-py", t0: recent + 20_000, texts: [
      "<command-name>/model</command-name>", "Model set.", "t3sm organize e2e: nightly digest of the build.", "Digest ready.",
    ] });
    // Only a command: no title can come from the transcript, so T3 Code is asked for one.
    writeTranscript(files.h3, { cwd: roots.a, sid: sidH3, entrypoint: "cli", t0: recent + 30_000, texts: [
      "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args></command-args>",
      "I reviewed the synthetic change to the date formatting helper: it now handles leap years.",
    ] });
    // Old file times (outside T3's 30-day window): the wave imports them (as apply.live does); mtimes are restored.
    for (const [i, f] of [files.h1, files.h2, files.h3, files.a1].entries()) { const m = (now - (60 - i) * DAY) / 1000; utimesSync(f, m, m); }
    const tH1 = `import:claudeAgent:${sidH1}`, tH2 = `import:claudeAgent:${sidH2}`, tH3 = `import:claudeAgent:${sidH3}`, tA1 = `import:claudeAgent:${sidA1}`;

    // Only the four synthetic files are visible to discovery; the real adapter reads them (origin from the entrypoint).
    const real = createClaudeAdapter();
    const mine = (p: string): boolean => sameCwd(join(p, ".."), encoded.a);
    const adapterA: SourceAdapter = { ...real, discover: async function* (e) { for await (const s of real.discover(e)) if (mine(s.file.path)) yield s; } };
    const sessionsA: DiscoveredSession[] = [];
    for await (const s of adapterA.discover({ home, platform: process.platform, now: Date.now, config, stateDir: state, env: process.env })) sessionsA.push(s);
    assert.deepEqual(sessionsA.map((s) => [s.nativeId, s.origin]).sort(), [[sidA1, "automated"], [sidH1, "human"], [sidH2, "human"], [sidH3, "human"]].sort(), "discovery tells human from automated");
    const originalsA = sessionsA.map((s) => ({ path: s.file.path, mtimeMs: s.file.mtimeMs }));

    const planA = await buildPlan({ sessions: sessionsA, config, journal: [], now: Date.now(), runId: "e2e-organize-a", home, t3: await snap(t3), existsDir });
    assert.deepEqual(planA.items.map((i) => i.action.kind), ["import", "import", "import", "import"]);
    assert.ok(planA.projectsToCreate.some((p) => sameCwd(p.root, roots.a)), "project A is created by the apply");
    const rA = await applyPlan(planA, { ...deps, only: roots.a });
    log(`apply A: ${JSON.stringify({ status: rA.status, imported: rA.imported, failures: rA.failures, deferred: rA.deferred })}`);
    assert.equal(rA.status, "ok");
    assert.equal(rA.imported, 4);
    for (const o of originalsA) assert.ok(Math.abs(statSync(o.path).mtimeMs - o.mtimeMs) <= 2, `mtime restored for ${o.path}`);
    const projA = (await t3.listProjects()).find((p) => sameCwd(p.workspaceRoot, roots.a));
    assert.ok(projA, "project A exists in T3");
    createdProjects.add(projA.id);
    const byId = (ts: T3Thread[], id: string): T3Thread | undefined => ts.find((t) => t.id === id);
    const imported = await eventually(() => t3.listThreads(), (ts) => [tH1, tH2, tH3, tA1].every((id) => byId(ts, id)), "the four imported threads appear");
    log(`titles T3 Code gave them: H2=${JSON.stringify(byId(imported, tH2)!.title)} H3=${JSON.stringify(byId(imported, tH3)!.title)} A1=${JSON.stringify(byId(imported, tA1)!.title)}`);
    // T3 Code cleans these titles itself since 0.1.11: an import of an older T3 Code, with its raw markup, is what t3sm retitles.
    for (const id of [tH2, tA1]) await t3.setThreadTitle(id, "<command-name>/model</command-name>");
    await t3.setThreadTitle(tH3, "/review");
    const before = await eventually(() => t3.listThreads(), (ts) => [tH2, tA1].every((id) => byId(ts, id)?.title.startsWith("<command-name>")) && byId(ts, tH3)?.title === "/review", "the old titles show in T3");
    const titleH2 = byId(before, tH2)!.title, titleA1 = byId(before, tA1)!.title;
    log(`imported titles: H2=${JSON.stringify(titleH2)} A1=${JSON.stringify(titleA1)}; settledOverride H1=${byId(before, tH1)!.settledOverride}`);

    // buildOrganize over the whole machine (the pins span every project), but the plan applied is cut down to project A:
    // no thread, pin, unpin or other change of any other project, and no project delete at all (noDelete).
    const journal = new Journal(journalFile);
    const io: Io = { stdout: () => {}, stderr: (s) => log(`notice: ${s.trim()}`), isTTY: false, prompt: async () => "", env: { ...process.env, T3SM_HOME: state } };
    const built = await buildOrganize(t3, journal, config, { only: null, dryRun: true, noDelete: true, aiTitles: { max: 10_000 } }, io, { adapters: [adapterA] }, home, Date.now);
    // The cap above only lets the synthetic thread in; every other project's ai-title is dropped with the rest.
    const actions = built.plan.actions.filter((a) => a.projectId === projA.id);
    const plan: OrganizePlan = {
      ...built.plan, actions, byProject: built.plan.byProject.filter((p) => p.projectId === projA.id),
      counts: Object.fromEntries(Object.keys(built.plan.counts).map((k) => [k, actions.filter((a) => a.kind === k).length])) as OrganizePlan["counts"],
    };
    log(`organize plan for project A: ${JSON.stringify(actions.map((a) => `${a.kind} ${a.target} (${a.reason})`))}`);
    const of = (k: string): string[] => actions.filter((a) => a.kind === k).map((a) => a.target).sort();
    assert.deepEqual(of("archive"), [tA1], "the automated thread is archived");
    assert.deepEqual(of("unsettle"), [tH1, tH2, tH3].sort(), "the human threads are shown inside the project, the automated one is not");
    assert.deepEqual(of("title"), [tH2], "only the human thread with a technical title is retitled (the archived automated one keeps its title: R16)");
    assert.deepEqual(of("ai-title"), [tH3], "only the title the transcript cannot improve is handed to T3 Code");
    assert.deepEqual(of("pin"), [projA.id], "the project is pinned");
    assert.equal(actions.length, 7, `nothing else is planned for project A: ${JSON.stringify(actions)}`);
    const newTitle = actions.find((a) => a.kind === "title")!.next as string;
    assert.match(newTitle, /KIWI-23/, "the clean title comes from the first real message");

    const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      const lock = await acquireLock(state);
      assert.ok(lock, "state-dir lock");
      try { await recoverPendingMtimes(journal); return await fn(); } finally { await lock.release(); }
    };
    const ro = await withLock(() => applyOrganize(plan, { api: t3, journal, runId: plan.runId, allowAiTitles: true, onProgress: (l) => log(l), onNotice: (l) => log(`notice: ${l}`) }));
    log(`organize: ${JSON.stringify({ done: ro.done, skippedChanged: ro.skippedChanged, failed: ro.failed, status: ro.status, ai: ro.aiTitles })}`);
    assert.equal(ro.status, "ok");
    assert.equal(ro.skippedChanged, 0);

    const after = await eventually(() => t3.listThreads(), (ts) => byId(ts, tA1)?.archived === true && byId(ts, tH2)?.title === newTitle && byId(ts, tH3)?.title !== "/review", "the organize changes show in T3");
    log(`title T3 Code wrote: H3=${JSON.stringify(byId(after, tH3)!.title)}`);
    assert.equal(byId(after, tA1)!.archived, true);
    assert.equal(byId(after, tA1)!.title, titleA1, "R16: the archived automated thread keeps its (technical) title");
    for (const id of [tH1, tH2, tH3]) {
      const t = byId(after, id)!;
      assert.equal(t.archived, false);
      assert.equal(t.settledOverride, "active", `${id} unsettled`);
      assert.ok(isVisibleInProject(t), `${id} is shown inside its project`);
    }
    assert.equal(byId(after, tH2)!.title, newTitle);
    assert.equal(byId(after, tH1)!.title, byId(before, tH1)!.title, "a plain title is left alone");
    assert.equal((await t3.listProjects()).find((p) => p.id === projA.id)!.pinned, true, "project A is pinned");
    const pinnedElsewhere = (await t3.listProjects()).filter((p) => p.pinned && p.id !== projA.id).length;
    log(`other pinned projects (not touched by this test): ${pinnedElsewhere}`);

    const undo = await withLock(() => undoOrganize(plan.runId, { api: t3, journal, now: Date.now, onProgress: (l) => log(l), onNotice: (l) => log(`notice: ${l}`) }));
    log(`undo: ${JSON.stringify({ reverted: undo.reverted, skippedUserChanged: undo.skippedUserChanged, alreadyRestored: undo.alreadyRestored, failed: undo.failed })}`);
    assert.deepEqual(undo.failed, []);
    assert.equal(undo.reverted, 7);
    const restored = await eventually(() => t3.listThreads(), (ts) => byId(ts, tA1)?.archived === false && byId(ts, tH2)?.title === titleH2 && byId(ts, tH3)?.title === "/review", "the undo shows in T3");
    assert.equal(byId(restored, tA1)!.title, titleA1);
    for (const id of [tH1, tH2, tH3]) assert.ok(!isVisibleInProject(byId(restored, id)!), `${id} is back on the settled shelf`);
    assert.equal((await t3.listProjects()).find((p) => p.id === projA.id)!.pinned, false, "project A is unpinned again");

    // =============== B: a faithful rehome copy of a home-folder conversation imports and resumes ===============
    const projTarget = await t3.createProject(roots.target, "t3sm-organize-e2e-target");
    createdProjects.add(projTarget.id);
    const sidOrig = randomUUID();
    const origFile = join(origDir, `${sidOrig}.jsonl`);
    writeTranscript(origFile, { cwd: home, sid: sidOrig, entrypoint: "cli", t0: now - 15 * DAY, texts: [
      "t3sm organize e2e (home): remember the codeword ZEBRA-58.", "Remembered: ZEBRA-58.",
    ] });
    const om = (now - 15 * DAY) / 1000;
    utimesSync(origFile, om, om);
    const origSha = readFileSync(origFile, "utf8");
    const sessionB = await discovered(origFile, "claudeAgent", "human");
    assert.ok(sameCwd(sessionB.cwd ?? "", home), "the original's folder is the home folder");
    const planB = await buildPlan({
      sessions: [sessionB], config, journal: [], now: Date.now(), runId: "e2e-organize-b", home, t3: await snap(t3), existsDir,
      // The copy goes to the target project (no inference over the machine's projects).
      inferProjectRoot: async () => ({ root: roots.target, hits: 9, total: 9, share: 1 }),
    });
    const action = planB.items[0]!.action;
    assert.equal(action.kind, "convert-import", JSON.stringify(planB.items[0]));
    assert.ok(action.kind === "convert-import");
    assert.equal(action.copy, "faithful");
    assert.ok(sameCwd(action.projectRoot, roots.target));
    assert.ok(sameCwd(join(action.targetFile, ".."), encoded.target), `target ${action.targetFile} is in ${encoded.target}`);
    copyIds.push(action.uuid);
    const rB = await applyPlan(planB, { ...deps, only: roots.target, adapters: [] });
    log(`apply B: ${JSON.stringify({ status: rB.status, converted: rB.converted, imported: rB.imported, failures: rB.failures, deferred: rB.deferred })}`);
    assert.equal(rB.status, "ok");
    assert.equal(rB.converted, 1);
    assert.equal(rB.imported, 1);
    assert.equal(readFileSync(origFile, "utf8"), origSha, "the original is never changed");
    const lines = readFileSync(action.targetFile, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(lines.length >= 3);
    assert.ok(sameCwd(String(lines[0]!["cwd"]), roots.target), "cwd swapped to the target project");
    assert.equal(lines[0]!["sessionId"], action.uuid, "session id swapped");
    assert.equal(lines.at(-1)!["type"], PROVENANCE_TYPE);
    const tCopy = await eventually(() => t3.listThreads(), (ts) => byId(ts, action.expectedThreadId) !== undefined, `thread ${action.expectedThreadId} appears`);
    assert.equal(byId(tCopy, action.expectedThreadId)!.projectId, projTarget.id, "the copy is in the target project");

    const sizeBefore = statSync(action.targetFile).size;
    const resume = await runClaude(
      `claude --resume ${action.uuid} -p "Which codeword did I ask you to remember earlier in this conversation? Reply with the codeword only."`,
      roots.target, { ...childEnv, CLAUDE_CONFIG_DIR: claudeHome },
    );
    const touchAfter = touch();
    log(touchAfter === touchBefore ? "claude --resume left .claude.json and history.jsonl as they were" : `claude --resume changed ~/.claude files (not a failure): before [${touchBefore}] after [${touchAfter}]`);
    log(`claude --resume -> code ${resume.code}; stdout=${JSON.stringify(resume.stdout.trim().slice(0, 200))}${resume.code === 0 ? "" : ` stderr=${JSON.stringify(resume.stderr.trim().slice(0, 300))}`}`);
    if (resume.code === null || /not recognized|command not found|ENOENT/i.test(resume.stderr)) log("RECORDED: claude is not on PATH; resume check not run");
    else if (resume.code !== 0 && /auth|login|credential|401|403/i.test(resume.stdout + resume.stderr)) log("RECORDED: claude --resume failed for auth reasons; not retried");
    else {
      assert.equal(resume.code, 0, "claude --resume exits 0");
      assert.match(resume.stdout, /ZEBRA/i, "the resumed copy answers from the copied history");
      assert.ok(statSync(action.targetFile).size > sizeBefore, "the resumed turn was appended to the copy");
    }

    // =============== C: project.delete: the response decodes and the project is gone ===============
    const empty = await t3.createProject(roots.empty, "t3sm-organize-e2e-empty");
    createdProjects.add(empty.id);
    assert.ok((await t3.listProjects()).some((p) => p.id === empty.id), "the empty project exists");
    await t3.deleteProject(empty.id); // rejects with ShapeError when the mutate reply does not decode
    await eventually(() => t3.listProjects(), (ps) => !ps.some((p) => p.id === empty.id), "the deleted project is gone from the list");
    log("project.delete: reply decoded, project gone");
  } catch (e) {
    original = e;
  } finally {
    // Always runs (assertion failure, early exit, error); throws the original failure first, else any cleanup problem.
    await cleanup({ api, cli, childEnv, home, claudeHome, roots: Object.values(roots), encoded: Object.values(encoded), createdProjects, copyIds, temps: [state], original });
  }
});

interface Cleanup {
  api: T3Api | null; cli: string; childEnv: Record<string, string>; home: string; claudeHome: string; roots: string[]; encoded: string[];
  createdProjects: Set<string>; copyIds: string[]; temps: string[]; original: unknown;
}

/** Cleanup never masks the original failure: each step is guarded, errors are collected and thrown only after it. */
async function cleanup(o: Cleanup): Promise<void> {
  const errors: unknown[] = [];
  const left: string[] = [];
  const step = async (name: string, fn: () => unknown): Promise<void> => {
    try { await fn(); } catch (e) { errors.push(e); log(`cleanup: ${name} failed: ${String(e)}`); }
  };
  if (o.api) await step("close T3 connection", () => o.api!.close());
  await step("remove T3 projects", async () => {
    const listMine = async () => {
      const api = await connectT3(o.home, { allowUntested: false, onNotice: () => {} });
      try { return (await api.listProjects()).filter((p) => o.createdProjects.has(p.id) || o.roots.some((r) => sameCwd(p.workspaceRoot, r))); } finally { await api.close(); }
    };
    const remove = async (id: string): Promise<void> => {
      const rm = await defaultRunner(o.cli, ["project", "remove", "--force", id], { shell: true, env: o.childEnv, timeoutMs: 60_000 });
      log(`cleanup: t3 project remove --force ${id} -> code ${rm.code}${rm.code === 0 ? "" : ` stdout=${rm.stdout.trim().slice(0, 300)} stderr=${rm.stderr.trim().slice(0, 300)}`}`);
    };
    // Every project this test created, by id (T3 matches roots case-sensitively: `d:` vs `D:`), and any project at a disposable root.
    let mine: { id: string; workspaceRoot: string }[];
    try { mine = await listMine(); } catch (e) {
      // T3 cannot be listed: still try every created id, and name each one so it can be removed by hand.
      log(`cleanup: could not list T3 projects (${String(e)})`);
      for (const id of o.createdProjects) {
        await remove(id).catch((err) => log(`cleanup: remove ${id} failed: ${String(err)}`));
        left.push(`T3 project ${id} (not verified, T3 could not be listed): t3 project remove --force ${id}`);
      }
      throw e;
    }
    for (const p of mine) await remove(p.id);
    for (const p of await listMine()) left.push(`T3 project ${p.id} (${p.workspaceRoot}): t3 project remove --force ${p.id}`);
  });
  // The encoded dirs did not exist before the test: everything in them is ours (transcripts, a resumed session's folder).
  for (const d of o.encoded) await step(`remove ${d}`, () => { if (existsSync(d)) { rmSync(d, { recursive: true, force: true }); log(`cleanup: removed ${d}`); } });
  await step("remove side files of the resumed session", () => {
    // Only entries named after the copy's session id (hooks and the CLI create them per session).
    for (const id of o.copyIds) {
      for (const d of [o.claudeHome, ...["session-env", "security", join("session-namer", "state"), "file-history", "todos", "debug", "sessions", "tasks"].map((x) => join(o.claudeHome, x))]) {
        if (!existsSync(d)) continue;
        for (const name of readdirSync(d)) {
          if (!name.includes(id)) continue;
          rmSync(join(d, name), { recursive: true, force: true });
          log(`cleanup: removed ${join(d, name)}`);
        }
      }
    }
  });
  for (const r of o.roots) await step(`remove ${r}`, () => rmSync(r, { recursive: true, force: true }));
  for (const t of o.temps) await step(`remove ${t}`, () => rmSync(t, { recursive: true, force: true }));
  for (const p of [...o.encoded, ...o.roots, ...o.temps]) if (existsSync(p)) left.push(`${p}: delete it by hand`);
  for (const l of left) log(`cleanup: LEFT BEHIND: ${l}`);
  if (o.original !== null) throw o.original;
  if (errors.length > 0 || left.length > 0) throw new AggregateError(errors, `live cleanup incomplete (${errors.length} error(s), ${left.length} leftover(s): ${left.join("; ")})`);
}
