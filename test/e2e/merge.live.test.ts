// Gated live test (T3_E2E=1, Windows): `t3sm merge` against the running T3 Code, on ONE synthetic Claude transcript in
// the PERSONAL account home (<homedir>/.claude, verified to be claudeAgent's T3 home before anything is written) for a
// disposable project dir `.spike/merge-e2e`. Steps: import it through applyPlan; append a terminal-style continuation by
// hand (two records chained from the current CLI leaf, S3 §6; the real `claude` CLI is NOT run: no tokens, no hook side
// files); merge; check the new thread, the archived old thread, the untouched original and the revision chain; roll
// the merge back; check the revision is gone and the old thread active again. Everything it creates is removed in
// `finally`: the T3 project by id (with its threads), the transcripts, the encoded dir (only if empty), the temp dirs.
// Run it with CLAUDE_CONFIG_DIR unset; it refuses otherwise. Findings: docs/spikes/S5-merge.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyPlan, type SignalSource } from "../../src/apply/apply.ts";
import { Journal } from "../../src/core/journal.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { encodeClaudeProjectDir, sameCwd } from "../../src/core/paths.ts";
import type { DiscoveredSession, JournalEntry } from "../../src/core/types.ts";
import { buildPlan } from "../../src/plan/planner.ts";
import { scanTranscript } from "../../src/sources/claude.ts";
import { connectT3, instancesFromConfig, type T3Api } from "../../src/t3/api.ts";
import { defaultRunner } from "../../src/t3/auth.ts";
import { resolveT3Cli } from "../../src/t3/runtime.ts";
import { executeMerges, findMergeCandidates, revisionUuid, type MergeDeps, type MergeResult } from "../../src/ops/merge.ts";
import type { PlanItem } from "../../src/core/types.ts";
/** find + execute in one call (what `t3sm merge --all` does). */
async function mergeSessions(items: PlanItem[], deps: MergeDeps): Promise<MergeResult> {
  const found = await findMergeCandidates(items, deps);
  const r = await executeMerges(found.candidates, deps);
  return { merged: r.merged, skipped: [...found.skipped, ...r.skipped] };
}

import { rollbackRun } from "../../src/ops/rollback.ts";

const DAY = 86_400_000;
const noSignals: SignalSource = { on: () => {}, off: () => {} };
const CODEWORD = "MERGE-E2E-HELIOTROPE";

type Rec = Record<string, unknown>;
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const parse = (p: string): Rec[] => readFileSync(p, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Rec);

async function discovered(p: string, sid: string): Promise<DiscoveredSession> {
  const st = statSync(p);
  const sc = await scanTranscript(p);
  return {
    harness: "claude", accountId: "claudeAgent", nativeId: sid, cwd: sc.cwd, startedAt: sc.startedAt, updatedAt: sc.updatedAt ?? new Date(st.mtimeMs).toISOString(),
    messageCount: sc.messageCount, corruptLines: sc.corruptLines, file: { path: p, size: st.size, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs }, flags: [],
    cwdOffsetBytes: sc.cwdOffsetBytes,
  };
}

test("live merge: a session continued outside T3 becomes a revision thread, the old one is archived; rollback undoes it (T3_E2E=1)", {
  skip: process.env.T3_E2E !== "1" || process.platform !== "win32", timeout: 300_000,
}, async () => {
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined, "run with CLAUDE_CONFIG_DIR unset");
  const home = homedir();
  const claudeHome = join(home, ".claude");
  const root = resolve(import.meta.dirname, "..", "..", ".spike", "merge-e2e");
  const encodedDir = join(claudeHome, "projects", encodeClaudeProjectDir(root));
  const cli = resolveT3Cli(home, process.platform, process.env.PATH ?? "");
  assert.ok(cli, "t3 cli found");
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k.toUpperCase() !== "CLAUDE_CONFIG_DIR") childEnv[k] = v;
  const connect = (): Promise<T3Api> => connectT3(home, { allowUntested: false, onNotice: (l) => console.log(`live notice: ${l}`) });

  // ---------- read-only preflight ----------
  const pre = await connect();
  let snap: { version: string; projects: Awaited<ReturnType<T3Api["listProjects"]>>; threads: Awaited<ReturnType<T3Api["listThreads"]>>; providers: Awaited<ReturnType<T3Api["providerInstances"]>>; instances: ReturnType<typeof instancesFromConfig> };
  try {
    const providers = await pre.providerInstances();
    const ca = providers.find((p) => p.instanceId === "claudeAgent");
    assert.ok(ca && ca.homePath !== null && sameCwd(ca.homePath, claudeHome), `claudeAgent must read ${claudeHome} (got ${ca?.homePath})`);
    const projects = await pre.listProjects();
    assert.ok(!projects.some((p) => sameCwd(p.workspaceRoot, root)), `a T3 project for ${root} already exists (leftover?); remove it by hand first`);
    snap = { version: pre.version, projects, threads: await pre.listThreads(), providers, instances: instancesFromConfig(await pre.getConfig()) };
  } finally { await pre.close(); }
  assert.ok(!existsSync(encodedDir), `${encodedDir} already exists; refusing to write next to unknown files`);
  assert.ok(!existsSync(root), `${root} already exists (leftover?)`);

  const state = mkdtempSync(join(tmpdir(), "t3sm-merge-e2e-"));
  const journal = new Journal(join(state, "journal.jsonl"));
  const sid = randomUUID();
  const src = join(encodedDir, `${sid}.jsonl`);
  let revFile: string | null = null;
  let original: unknown = null;
  let mayRemoveProject = false;
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(encodedDir, { recursive: true });
    mayRemoveProject = true;

    // ---------- 1. a synthetic session (S3 minimal records), imported through apply ----------
    const t0 = Date.now() - 3 * DAY;
    const u0 = randomUUID(), u1 = randomUUID();
    const base: Rec[] = [
      { parentUuid: null, type: "user", message: { role: "user", content: "t3sm merge e2e: what is 2 + 2?" }, uuid: u0, timestamp: new Date(t0).toISOString(), cwd: root, sessionId: sid },
      { parentUuid: u0, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "4." }] }, uuid: u1, timestamp: new Date(t0 + 1000).toISOString(), cwd: root, sessionId: sid },
    ];
    writeFileSync(src, base.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    utimesSync(src, (t0 + 2000) / 1000, (t0 + 2000) / 1000);
    const config = defaultConfig([{ id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }]);
    const existsDir = async (d: string) => { try { return (await stat(d)).isDirectory(); } catch { return false; } };
    const plan1 = await buildPlan({
      sessions: [await discovered(src, sid)], config, journal: [], now: Date.now(), runId: "e2e-merge-plan1", home,
      t3: { version: snap.version, projects: snap.projects, threads: snap.threads, instances: snap.instances, providers: snap.providers }, existsDir,
    });
    assert.deepEqual(plan1.items.map((i) => i.action.kind), ["import"]);
    const a = await applyPlan(plan1, { stateDir: state, home, only: root, signals: noSignals, onProgress: (l) => console.log(`live: ${l}`), onNotice: (l) => console.log(`live notice: ${l}`) });
    console.log(`live: apply ${JSON.stringify({ status: a.status, imported: a.imported, failures: a.failures })}`);
    assert.equal(a.status, "ok");
    assert.equal(a.imported, 1);
    const oldThread = `import:claudeAgent:${sid}`;

    // ---------- 2. a terminal-style continuation, appended by hand from the CLI leaf (u1: no last-prompt yet) ----------
    const t1 = Date.now() - DAY;
    const u2 = randomUUID(), u3 = randomUUID();
    const more: Rec[] = [
      { parentUuid: u1, isSidechain: false, type: "user", message: { role: "user", content: `Terminal turn: remember the codeword ${CODEWORD}.` }, uuid: u2, timestamp: new Date(t1).toISOString(), cwd: root, sessionId: sid, entrypoint: "cli" },
      { parentUuid: u2, isSidechain: false, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Noted: ${CODEWORD}.` }] }, uuid: u3, timestamp: new Date(t1 + 1000).toISOString(), cwd: root, sessionId: sid, entrypoint: "cli" },
      { type: "last-prompt", lastPrompt: "Terminal turn", leafUuid: u3, sessionId: sid },
    ];
    appendFileSync(src, more.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    utimesSync(src, (t1 + 2000) / 1000, (t1 + 2000) / 1000);
    const before = { sha: sha(src), size: statSync(src).size, mtimeMs: statSync(src).mtimeMs };
    const rev = revisionUuid(sid, before.size);
    revFile = join(encodedDir, `${rev}.jsonl`);
    const newThread = `import:claudeAgent:${rev}`;

    // ---------- 3. merge ----------
    const api = await connect();
    let mergeRun: string;
    try {
      const plan2 = await buildPlan({
        sessions: [await discovered(src, sid)], config, journal: await journal.readAll(), now: Date.now(), runId: "e2e-merge-plan2", home,
        t3: { version: api.version, projects: await api.listProjects(), threads: await api.listThreads(), instances: snap.instances, providers: await api.providerInstances() }, existsDir,
      });
      assert.deepEqual(plan2.items.map((i) => [i.action.kind === "skip" ? i.action.reason : i.action.kind, i.notes]), [["already-in-t3", ["continued-outside-t3"]]]);
      mergeRun = `e2e-merge-${Date.now()}`;
      await journal.append({ t: "run-start", runId: mergeRun, at: new Date().toISOString(), command: "merge --session e2e" });
      const t = Date.now();
      const r = await mergeSessions(plan2.items, { api, journal, runId: mergeRun, exposureItems: plan2.items, accountHomes: { claudeAgent: claudeHome } });
      await journal.append({ t: "run-end", runId: mergeRun, at: new Date().toISOString(), status: "ok" });
      console.log(`live: merge ${Date.now() - t} ms: ${JSON.stringify(r)}`);
      assert.deepEqual(r.skipped, []);
      assert.equal(r.merged.length, 1);
      assert.equal(r.merged[0]!.newThreadId, newThread);
      assert.equal(r.merged[0]!.addedMessages, 2);
    } finally { await api.close(); }

    const check = await connect();
    try {
      const threads = new Map((await check.listThreads()).map((t) => [t.id, t] as const));
      console.log(`live: after merge new=${JSON.stringify(threads.get(newThread))} old=${JSON.stringify(threads.get(oldThread))}`);
      assert.equal(threads.get(newThread)?.archived, false, "revision thread exists, active");
      assert.equal(threads.get(oldThread)?.archived, true, "old thread archived");
    } finally { await check.close(); }
    assert.equal(sha(src), before.sha, "original byte-identical");
    assert.ok(Math.abs(statSync(src).mtimeMs - before.mtimeMs) <= 2, "original mtime unchanged");
    assert.ok(Math.abs(statSync(revFile).mtimeMs - before.mtimeMs) <= 2, "revision mtime = source mtime (restored after the wave)");
    const out = parse(revFile);
    assert.equal(out[0]!.isMeta, true);
    assert.equal(out[0]!.parentUuid, null);
    assert.deepEqual(out.slice(1).map((x) => x.uuid), [u0, u1, u2, u3]);
    for (let i = 1; i < out.length; i++) assert.equal(out[i]!.parentUuid, out[i - 1]!.uuid, `chain link ${i}`);
    assert.ok(out.every((x) => x.sessionId === rev && x.type !== "last-prompt"));

    // T3's own view of the revision thread (read-only CLI): the terminal turn must be in its timeline.
    const show = await defaultRunner(cli, ["thread", "show", newThread, "--json"], { shell: true, env: childEnv, timeoutMs: 60_000 });
    console.log(`live: t3 thread show -> code ${show.code}, codeword ${show.stdout.includes(CODEWORD) ? "PRESENT" : "absent"}${show.code === 0 ? "" : ` stderr=${show.stderr.trim().slice(0, 300)}`}`);

    // ---------- 4. rollback of the merge run ----------
    const rb = await rollbackRun(mergeRun, { journal, accountHomes: [claudeHome], connect });
    console.log(`live: rollback ${JSON.stringify({ removed: rb.filesRemoved, unarchived: rb.threadsUnarchived, archived: rb.threadsArchived, kept: rb.mergesKept, errors: rb.errors })}`);
    assert.deepEqual(rb.errors, []);
    assert.ok(!existsSync(revFile), "revision deleted");
    const after = await connect();
    try {
      const threads = new Map((await after.listThreads()).map((t) => [t.id, t] as const));
      console.log(`live: after rollback new=${JSON.stringify(threads.get(newThread))} old=${JSON.stringify(threads.get(oldThread))}`);
      assert.equal(threads.get(oldThread)?.archived, false, "old thread unarchived");
      assert.equal(threads.get(newThread)?.archived, true, "revision thread archived");
    } finally { await after.close(); }
    assert.equal(sha(src), before.sha, "original still byte-identical");
    const es: JournalEntry[] = await journal.readAll();
    console.log(`live: journal kinds ${es.map((e) => e.t).join(",")}`);
  } catch (e) {
    original = e;
  }
  const cleanupErrors: unknown[] = [];
  const step = async (name: string, fn: () => unknown): Promise<void> => {
    try { await fn(); } catch (e) { cleanupErrors.push(e); console.log(`live cleanup: ${name} failed: ${String(e)}`); }
  };
  if (mayRemoveProject) await step("remove T3 project", async () => {
    const remove = async (target: string) => {
      const rm = await defaultRunner(cli, ["project", "remove", "--force", target], { shell: true, env: childEnv, timeoutMs: 60_000 });
      console.log(`live cleanup: t3 project remove --force ${target} -> code ${rm.code}${rm.code === 0 ? "" : ` stdout=${rm.stdout.trim().slice(0, 300)} stderr=${rm.stderr.trim().slice(0, 300)}`}`);
      return rm.code === 0;
    };
    const findLeft = async () => {
      const api = await connectT3(home, { allowUntested: false, onNotice: () => {} });
      try { return (await api.listProjects()).filter((p) => sameCwd(p.workspaceRoot, root)); } finally { await api.close(); }
    };
    for (const p of await findLeft()) await remove(p.id);
    const left = await findLeft();
    if (left.length > 0) console.log(`live cleanup: PROJECT STILL IN T3: ${left.map((p) => p.id).join(", ")} (remove with t3 project remove --force <id>)`);
    assert.equal(left.length, 0, "disposable T3 project removed");
  });
  for (const f of [src, ...(revFile ? [revFile] : [])]) await step(`delete ${f}`, () => { if (existsSync(f)) unlinkSync(f); });
  await step(`remove ${encodedDir}`, () => {
    if (!existsSync(encodedDir)) return;
    const left = readdirSync(encodedDir);
    if (left.length === 0) rmdirSync(encodedDir);
    else console.log(`live cleanup: ${encodedDir} not empty (${left.join(", ")}), left in place`);
  });
  await step(`remove ${root}`, () => rmSync(root, { recursive: true, force: true }));
  await step(`remove ${state}`, () => rmSync(state, { recursive: true, force: true }));
  if (original !== null) throw original;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `live cleanup failed (${cleanupErrors.length} step(s))`);
});
