// Gated live test (T3_E2E=1, Windows): the conversion path end to end against the running T3 Code, on ONE synthetic
// OpenCode-style session (3 messages: a question, a flattened tool line, accented text) served by an in-memory
// adapter. It is converted into the PERSONAL account home (<homedir>/.claude, verified to be claudeAgent's T3 home
// before anything is written) for a disposable project dir `.spike/convert-e2e`, imported through the normal waves,
// and must appear as thread `import:claudeAgent:<uuid>`; then `claude --resume <uuid> -p` from the project dir must
// continue it (exit 0, the file grows); a second apply must change nothing. Everything it creates is removed in
// `finally`: the T3 project (with its thread), the converted file, the CLI/hook side files named after that session
// id, its encoded dir (only if empty) and the temp dirs. The real OpenCode database is never touched.
// A second test does the same with a synthetic COMPRESSED Codex rollout (`.jsonl.zst`) in a temp CODEX_HOME, read by
// the real Codex adapter (discovery + read): project dir `.spike/convert-codex-e2e`; the real ~/.codex is never read.
// Run it with CLAUDE_CONFIG_DIR unset; it refuses otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { createCodexAdapter } from "../../src/sources/codex.ts";
import { uuidV5 } from "../../src/core/uuid.ts";
import { applyPlan, type SignalSource } from "../../src/apply/apply.ts";
import { Journal } from "../../src/core/journal.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { sha256File } from "../../src/core/fsutil.ts";
import { encodeClaudeProjectDir, sameCwd } from "../../src/core/paths.ts";
import type { CanonicalTranscript, DiscoveredSession, JournalEntry } from "../../src/core/types.ts";
import { buildPlan } from "../../src/plan/planner.ts";
import type { SourceAdapter } from "../../src/sources/types.ts";
import { connectT3, instancesFromConfig, type T3Api } from "../../src/t3/api.ts";
import { defaultRunner } from "../../src/t3/auth.ts";
import { resolveT3Cli } from "../../src/t3/runtime.ts";

const DAY = 86_400_000;
const noSignals: SignalSource = { on: () => {}, off: () => {} };

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

test("live convert: a synthetic OpenCode session is converted into ~/.claude, imported as import:claudeAgent:<uuid>, re-apply is a no-op (T3_E2E=1)", {
  skip: process.env.T3_E2E !== "1" || process.platform !== "win32", timeout: 300_000,
}, async () => {
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined, "run with CLAUDE_CONFIG_DIR unset");
  const home = homedir();
  const claudeHome = join(home, ".claude");
  const root = resolve(import.meta.dirname, "..", "..", ".spike", "convert-e2e");
  const encodedDir = join(claudeHome, "projects", encodeClaudeProjectDir(root));
  const cli = resolveT3Cli(home, process.platform, process.env.PATH ?? "");
  assert.ok(cli, "t3 cli found");
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k.toUpperCase() !== "CLAUDE_CONFIG_DIR") childEnv[k] = v;

  // ---------- read-only preflight: nothing is written unless all of this holds ----------
  const pre = await connectT3(home, { allowUntested: false, onNotice: (l) => console.log(`live notice: ${l}`) });
  let snapshot: { version: string; projects: Awaited<ReturnType<T3Api["listProjects"]>>; threads: Awaited<ReturnType<T3Api["listThreads"]>>; providers: Awaited<ReturnType<T3Api["providerInstances"]>>; instances: ReturnType<typeof instancesFromConfig> };
  try {
    const providers = await pre.providerInstances();
    const ca = providers.find((p) => p.instanceId === "claudeAgent");
    assert.ok(ca && ca.homePath !== null && sameCwd(ca.homePath, claudeHome), `claudeAgent must read ${claudeHome} (got ${ca?.homePath})`);
    const projects = await pre.listProjects();
    assert.ok(!projects.some((p) => sameCwd(p.workspaceRoot, root)), `a T3 project for ${root} already exists (leftover?); remove it by hand first`);
    snapshot = { version: pre.version, projects, threads: await pre.listThreads(), providers, instances: instancesFromConfig(await pre.getConfig()) };
  } finally { await pre.close(); }
  assert.ok(!existsSync(encodedDir), `${encodedDir} already exists; refusing to write next to unknown files`);
  assert.ok(!existsSync(root), `${root} already exists (leftover?)`);

  const state = mkdtempSync(join(tmpdir(), "t3sm-convert-e2e-"));
  let target: string | null = null;
  let resumedUuid: string | null = null;
  let original: unknown = null;
  let mayRemoveProject = false;
  try {
    mkdirSync(root, { recursive: true });
    mayRemoveProject = true;
    const now = Date.now();
    const updated = now - 2 * DAY;
    const nativeId = `ses_t3sm_e2e_${randomBytes(6).toString("hex")}`;
    const transcript: CanonicalTranscript = {
      harness: "opencode", nativeId, cwd: root, title: "t3sm convert e2e", startedAt: new Date(updated - 120_000).toISOString(),
      messages: [
        { role: "user", text: "t3sm convert e2e: list the files and remember the codeword MANGO-17.", timestamp: new Date(updated - 90_000).toISOString() },
        { role: "assistant", text: "[tool bash] ls -la → total 8\n-rw-r--r-- 1 demo demo 120 notas.txt\n\nThere is one file: notas.txt. Codeword noted.", timestamp: new Date(updated - 60_000).toISOString() },
        { role: "user", text: "Agora em português: ação, coração, pão 🍞✅ — obrigado!", timestamp: new Date(updated).toISOString() },
      ],
    };
    const reads: string[] = [];
    const adapter: SourceAdapter = {
      id: "opencode", mode: "convert", isAvailable: async () => true, discover: async function* () { /* the session below */ },
      read: async (s) => { reads.push(s.nativeId); assert.equal(s.nativeId, nativeId); return structuredClone(transcript); },
    };
    const session: DiscoveredSession = {
      harness: "opencode", accountId: null, nativeId, cwd: root, startedAt: transcript.startedAt, updatedAt: new Date(updated).toISOString(),
      messageCount: 3, corruptLines: 0, file: { path: join(state, "opencode.db"), size: 0, mtimeMs: now, atimeMs: now }, flags: [], cwdOffsetBytes: 0,
    };

    const config = defaultConfig([{ id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }]);
    const plan = await buildPlan({
      sessions: [session], config, journal: [], now: Date.now(), runId: "e2e-convert", home,
      t3: { version: snapshot.version, projects: snapshot.projects, threads: snapshot.threads, instances: snapshot.instances, providers: snapshot.providers },
      existsDir: async (d) => { try { return (await stat(d)).isDirectory(); } catch { return false; } },
    });
    assert.deepEqual(plan.instancesToCreate, []);
    const action = plan.items[0]!.action;
    assert.equal(action.kind, "convert-import");
    if (action.kind !== "convert-import") return;
    target = action.targetFile;
    assert.ok(sameCwd(join(action.targetFile, ".."), encodedDir), `target ${action.targetFile} is in ${encodedDir}`);
    assert.equal(action.expectedThreadId, `import:claudeAgent:${action.uuid}`);
    assert.ok(plan.projectsToCreate.some((p) => sameCwd(p.root, root)), "the convert-only root gets a project");

    const counts = { import: 0, scan: 0 };
    const connect = async (h: string, o: Parameters<typeof connectT3>[1]): Promise<T3Api> => {
      const api = await connectT3(h, o);
      return {
        ...api,
        importSessions: (pid, r) => { counts.import++; return api.importSessions(pid, r); },
        scanSessions: () => { counts.scan++; return api.scanSessions(); },
      };
    };
    const deps = {
      stateDir: state, home, only: root, connect, signals: noSignals, adapters: [adapter], accountHomes: () => ({ claudeAgent: claudeHome }),
      onProgress: (l: string) => console.log(`live: ${l}`), onNotice: (l: string) => console.log(`live notice: ${l}`),
    };

    const t0 = Date.now();
    const r1 = await applyPlan(plan, deps);
    console.log(`live: apply #1 ${Date.now() - t0} ms: ${JSON.stringify({ status: r1.status, converted: r1.converted, imported: r1.imported, failures: r1.failures, deferred: r1.deferred, restoreErrors: r1.restoreErrors })}`);
    assert.equal(r1.status, "ok");
    assert.equal(r1.converted, 1);
    assert.equal(r1.imported, 1);
    assert.equal(counts.scan, 1, "one wave");
    assert.ok(Math.abs(statSync(target).mtimeMs - updated) <= 2, "converted file back at the source's last activity after the wave");

    const es: JournalEntry[] = await new Journal(join(state, "journal.jsonl")).readAll();
    const written = es.filter((e) => e.t === "file-written") as Extract<JournalEntry, { t: "file-written" }>[];
    assert.equal(written.length, 1);
    assert.equal(written[0]!.sha256, await sha256File(target));
    const check = await connectT3(home, { allowUntested: false });
    try {
      const t = (await check.listThreads()).find((x) => x.id === action.expectedThreadId);
      assert.ok(t, `thread ${action.expectedThreadId} exists in T3`);
      console.log(`live: thread ${t.id} title=${JSON.stringify(t.title)}`);
    } finally { await check.close(); }

    // The terminal can continue the converted session too: one short `claude --resume` turn from the project dir
    // against the personal account (explicit CLAUDE_CONFIG_DIR). Not on PATH or an auth failure: recorded, not retried.
    resumedUuid = action.uuid;
    const before = statSync(target).size;
    const resume = await runClaude(`claude --resume ${action.uuid} -p "Reply with the single word OK."`, root, { ...childEnv, CLAUDE_CONFIG_DIR: claudeHome });
    console.log(`live: claude --resume -> code ${resume.code}; stdout=${JSON.stringify(resume.stdout.trim().slice(0, 200))}${resume.code === 0 ? "" : ` stderr=${JSON.stringify(resume.stderr.trim().slice(0, 300))}`}`);
    if (resume.code === null || /not recognized|command not found|ENOENT/i.test(resume.stderr)) console.log("live: RECORDED: claude is not on PATH; resume check not run");
    else if (resume.code !== 0 && /auth|login|credential|401|403/i.test(resume.stdout + resume.stderr)) console.log("live: RECORDED: claude --resume failed for auth reasons; not retried");
    else {
      assert.equal(resume.code, 0, "claude --resume exits 0");
      const after = statSync(target).size;
      console.log(`live: converted file ${before} -> ${after} bytes after the resumed turn`);
      assert.ok(after > before, "the resumed turn was appended to the converted transcript");
    }

    counts.import = 0; counts.scan = 0;
    const r2 = await applyPlan(plan, deps);
    console.log(`live: apply #2: ${JSON.stringify({ status: r2.status, converted: r2.converted, imported: r2.imported, alreadyInT3: r2.alreadyInT3 })} importSessions=${counts.import} scan=${counts.scan}`);
    assert.equal(r2.status, "ok");
    assert.equal(r2.converted, 0);
    assert.equal(r2.alreadyInT3, 1);
    assert.equal(counts.import, 0);
    assert.deepEqual(reads, [nativeId], "the second apply reads nothing (the thread is already in T3)");
  } catch (e) {
    original = e;
  }
  await cleanupLive({ cli, childEnv, home, claudeHome, root, encodedDir, target, resumedUuid, mayRemoveProject, temps: [state], original });
});

interface LiveCleanup {
  cli: string; childEnv: Record<string, string>; home: string; claudeHome: string; root: string; encodedDir: string;
  target: string | null; resumedUuid: string | null; mayRemoveProject: boolean; temps: string[]; original: unknown;
}

/**
 * Removes everything a live convert test created: the T3 project (with its thread), the converted file, the CLI/hook
 * side files of a resumed session, the encoded dir (only if empty), the project dir and the temp dirs. Cleanup never
 * masks the original failure: each step is guarded, errors are collected and thrown only after it.
 */
async function cleanupLive(o: LiveCleanup): Promise<void> {
  const { cli, childEnv, home, claudeHome, root, encodedDir, target, resumedUuid, mayRemoveProject, original } = o;
  const cleanupErrors: unknown[] = [];
  const step = async (name: string, fn: () => unknown): Promise<void> => {
    try { await fn(); } catch (e) { cleanupErrors.push(e); console.log(`live cleanup: ${name} failed: ${String(e)}`); }
  };
  if (mayRemoveProject) await step("remove T3 project", async () => {
    // Same as apply.live.test.ts: the root as given, then by project id (T3 matches roots case-sensitively).
    const remove = async (t: string) => {
      const rm = await defaultRunner(cli, ["project", "remove", "--force", t], { shell: true, env: childEnv, timeoutMs: 60_000 });
      console.log(`live cleanup: t3 project remove --force ${t} -> code ${rm.code}${rm.code === 0 ? "" : ` stdout=${rm.stdout.trim().slice(0, 300)} stderr=${rm.stderr.trim().slice(0, 300)}`}`);
      return rm.code === 0;
    };
    const findLeft = async () => {
      const api = await connectT3(home, { allowUntested: false, onNotice: () => {} });
      try { return (await api.listProjects()).filter((p) => sameCwd(p.workspaceRoot, root)); } finally { await api.close(); }
    };
    if (!(await remove(root))) {
      for (const p of await findLeft()) await remove(p.id);
    }
    const left = await findLeft();
    if (left.length > 0) console.log(`live cleanup: PROJECT STILL IN T3: ${left.map((p) => p.id).join(", ")} (remove with t3 project remove --force <id>)`);
    assert.equal(left.length, 0, "disposable T3 project removed");
  });
  if (target !== null) await step(`delete ${target}`, () => { if (existsSync(target!)) unlinkSync(target!); });
  if (resumedUuid !== null) await step("remove side files of the resumed session", () => {
    // Only entries named after THIS session id (hooks and the CLI create them per session: session-env/<id>,
    // security_warnings_state_<id>.json, session-namer/state/<id>.json, file-history/<id>, todos/<id>-*, the
    // project's <id>/ folder, ...).
    const id = resumedUuid!;
    for (const d of [claudeHome, "session-env", "security", join("session-namer", "state"), "file-history", "todos", "debug", "sessions", "tasks", join("projects", encodeClaudeProjectDir(root))].map((x) => (x === claudeHome ? x : join(claudeHome, x)))) {
      if (!existsSync(d)) continue;
      for (const name of readdirSync(d)) {
        if (!name.includes(id)) continue;
        rmSync(join(d, name), { recursive: true, force: true });
        console.log(`live cleanup: removed ${join(d, name)}`);
      }
    }
  });
  await step(`remove ${encodedDir}`, () => { if (existsSync(encodedDir) && readdirSync(encodedDir).length === 0) rmdirSync(encodedDir); });
  if (existsSync(encodedDir)) console.log(`live cleanup: ${encodedDir} not empty, left in place`);
  await step(`remove ${root}`, () => rmSync(root, { recursive: true, force: true }));
  for (const t of o.temps) await step(`remove ${t}`, () => rmSync(t, { recursive: true, force: true }));
  if (original !== null) throw original;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `live cleanup failed (${cleanupErrors.length} step(s))`);
}

test("live convert: a synthetic COMPRESSED Codex rollout (temp CODEX_HOME) is discovered, converted into ~/.claude, imported as import:claudeAgent:<uuidV5(codex:<id>)>, re-apply is a no-op (T3_E2E=1)", {
  skip: process.env.T3_E2E !== "1" || process.platform !== "win32", timeout: 300_000,
}, async () => {
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined, "run with CLAUDE_CONFIG_DIR unset");
  const home = homedir();
  const claudeHome = join(home, ".claude");
  const root = resolve(import.meta.dirname, "..", "..", ".spike", "convert-codex-e2e");
  const encodedDir = join(claudeHome, "projects", encodeClaudeProjectDir(root));
  const cli = resolveT3Cli(home, process.platform, process.env.PATH ?? "");
  assert.ok(cli, "t3 cli found");
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k.toUpperCase() !== "CLAUDE_CONFIG_DIR") childEnv[k] = v;

  // ---------- read-only preflight: nothing is written unless all of this holds ----------
  const pre = await connectT3(home, { allowUntested: false, onNotice: (l) => console.log(`live notice: ${l}`) });
  let snapshot: { version: string; projects: Awaited<ReturnType<T3Api["listProjects"]>>; threads: Awaited<ReturnType<T3Api["listThreads"]>>; providers: Awaited<ReturnType<T3Api["providerInstances"]>>; instances: ReturnType<typeof instancesFromConfig> };
  try {
    const providers = await pre.providerInstances();
    const ca = providers.find((p) => p.instanceId === "claudeAgent");
    assert.ok(ca && ca.homePath !== null && sameCwd(ca.homePath, claudeHome), `claudeAgent must read ${claudeHome} (got ${ca?.homePath})`);
    const projects = await pre.listProjects();
    assert.ok(!projects.some((p) => sameCwd(p.workspaceRoot, root)), `a T3 project for ${root} already exists (leftover?); remove it by hand first`);
    snapshot = { version: pre.version, projects, threads: await pre.listThreads(), providers, instances: instancesFromConfig(await pre.getConfig()) };
  } finally { await pre.close(); }
  assert.ok(!existsSync(encodedDir), `${encodedDir} already exists; refusing to write next to unknown files`);
  assert.ok(!existsSync(root), `${root} already exists (leftover?)`);

  const state = mkdtempSync(join(tmpdir(), "t3sm-convert-codex-e2e-"));
  // A TEMP Codex home: the real ~/.codex is never read or written by this test.
  const codexHome = mkdtempSync(join(tmpdir(), "t3sm-codex-home-e2e-"));
  let target: string | null = null;
  let original: unknown = null;
  let mayRemoveProject = false;
  try {
    mkdirSync(root, { recursive: true });
    mayRemoveProject = true;
    const now = Date.now();
    const updated = now - 2 * DAY;
    const id = randomUUID();
    const at = (back: number) => new Date(updated - back).toISOString();
    const recs = [
      { timestamp: at(120_000), type: "session_meta", payload: { id, cwd: root, originator: "t3sm-e2e" } },
      { timestamp: at(90_000), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "t3sm codex e2e: list the files and remember the codeword KIWI-23." }] } },
      { timestamp: at(80_000), type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "synthetic reasoning, dropped" }] } },
      { timestamp: at(70_000), type: "response_item", payload: { type: "function_call", call_id: "c1", name: "shell", arguments: JSON.stringify({ command: "ls -la" }) } },
      { timestamp: at(65_000), type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "total 8\n-rw-r--r-- 1 demo demo 120 notas.txt" } },
      { timestamp: at(60_000), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "There is one file: notas.txt. Codeword noted." }] } },
      { timestamp: at(0), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Agora em português: ação, coração, pão 🍞✅ — obrigado!" }] } },
    ];
    const day = join(codexHome, "sessions", "2026", "11", "09");
    mkdirSync(day, { recursive: true });
    const zst = join(day, `rollout-2026-11-09T10-00-00-${id}.jsonl.zst`);
    writeFileSync(zst, zstdCompressSync(Buffer.from(recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8")));
    utimesSync(zst, (now - DAY) / 1000, (now - DAY) / 1000);
    const zstSha = await sha256File(zst);

    const config = defaultConfig([{ id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }]);
    const codex = createCodexAdapter();
    const env = { home, platform: process.platform, now: Date.now, config, stateDir: state, env: { ...process.env, CODEX_HOME: codexHome } };
    const sessions: DiscoveredSession[] = [];
    for await (const s of codex.discover(env)) sessions.push(s);
    assert.deepEqual(codex.lastErrors, []);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.mode, "convert");
    assert.equal(sessions[0]!.nativeId, id);
    assert.ok(sessions[0]!.file.path.startsWith(codexHome), "discovered in the temp Codex home only");

    const plan = await buildPlan({
      sessions, config, journal: [], now: Date.now(), runId: "e2e-convert-codex", home,
      t3: { version: snapshot.version, projects: snapshot.projects, threads: snapshot.threads, instances: snapshot.instances, providers: snapshot.providers },
      existsDir: async (d) => { try { return (await stat(d)).isDirectory(); } catch { return false; } },
    });
    assert.deepEqual(plan.instancesToCreate, []);
    const action = plan.items[0]!.action;
    assert.equal(action.kind, "convert-import", JSON.stringify(action));
    if (action.kind !== "convert-import") return;
    target = action.targetFile;
    assert.equal(action.uuid, uuidV5(`codex:${id}`));
    assert.ok(sameCwd(join(action.targetFile, ".."), encodedDir), `target ${action.targetFile} is in ${encodedDir}`);
    assert.equal(action.expectedThreadId, `import:claudeAgent:${action.uuid}`);

    const counts = { import: 0, scan: 0 };
    const connect = async (h: string, o: Parameters<typeof connectT3>[1]): Promise<T3Api> => {
      const api = await connectT3(h, o);
      return {
        ...api,
        importSessions: (pid, r) => { counts.import++; return api.importSessions(pid, r); },
        scanSessions: () => { counts.scan++; return api.scanSessions(); },
      };
    };
    const deps = {
      stateDir: state, home, only: root, connect, signals: noSignals, adapters: [codex], accountHomes: () => ({ claudeAgent: claudeHome }),
      onProgress: (l: string) => console.log(`live: ${l}`), onNotice: (l: string) => console.log(`live notice: ${l}`),
    };

    const t0 = Date.now();
    const r1 = await applyPlan(plan, deps);
    console.log(`live: codex apply #1 ${Date.now() - t0} ms: ${JSON.stringify({ status: r1.status, converted: r1.converted, imported: r1.imported, failures: r1.failures, deferred: r1.deferred, restoreErrors: r1.restoreErrors })}`);
    assert.equal(r1.status, "ok");
    assert.equal(r1.converted, 1);
    assert.equal(r1.imported, 1);
    assert.equal(counts.scan, 1, "one wave");
    const first = JSON.parse(readFileSync(target, "utf8").split("\n")[0]!) as { message: { content: string } };
    assert.match(first.message.content, new RegExp(`^Imported from codex session ${id} `));
    assert.match(readFileSync(target, "utf8"), /\[tool shell\] ls -la → total 8/);
    assert.doesNotMatch(readFileSync(target, "utf8"), /synthetic reasoning/);
    assert.equal(await sha256File(zst), zstSha, "the compressed rollout is never modified");

    const check = await connectT3(home, { allowUntested: false });
    try {
      const t = (await check.listThreads()).find((x) => x.id === action.expectedThreadId);
      assert.ok(t, `thread ${action.expectedThreadId} exists in T3`);
      console.log(`live: codex thread ${t.id} title=${JSON.stringify(t.title)}`);
    } finally { await check.close(); }

    counts.import = 0; counts.scan = 0;
    const r2 = await applyPlan(plan, deps);
    console.log(`live: codex apply #2: ${JSON.stringify({ status: r2.status, converted: r2.converted, imported: r2.imported, alreadyInT3: r2.alreadyInT3 })} importSessions=${counts.import} scan=${counts.scan}`);
    assert.equal(r2.status, "ok");
    assert.equal(r2.converted, 0);
    assert.equal(r2.alreadyInT3, 1);
    assert.equal(counts.import, 0);
  } catch (e) {
    original = e;
  }
  await cleanupLive({ cli, childEnv, home, claudeHome, root, encodedDir, target, resumedUuid: null, mayRemoveProject, temps: [state, codexHome], original });
});
