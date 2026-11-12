// Gated live test (T3_E2E=1, Windows): the full apply write path against the running T3 Code, on 3 synthetic Claude
// transcripts in the PERSONAL account home (<homedir>/.claude, verified to be claudeAgent's T3 home before anything is
// written) for a disposable project dir `.spike/apply-e2e`, plus a 4th in-window transcript the plan never sees: it
// must be parked in the future during the wave, not imported, and get its mtime back. Everything it creates is
// removed in `finally`: the T3 project (with its threads), the 4 transcripts, their encoded dir (only if empty) and
// the temp dirs.
// Run it with CLAUDE_CONFIG_DIR unset; it refuses otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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

const DAY = 86_400_000;
const noSignals: SignalSource = { on: () => {}, off: () => {} };

function transcript(path: string, cwd: string, sid: string, t0: number, n: number): void {
  const recs: Record<string, unknown>[] = [];
  const texts = [`t3sm apply e2e session ${n}: what is ${n} + ${n}?`, `${n + n}.`];
  let parent: string | null = null;
  texts.forEach((text, i) => {
    const uuid = randomUUID();
    const user = i % 2 === 0;
    recs.push({
      parentUuid: parent, type: user ? "user" : "assistant",
      message: user ? { role: "user", content: text } : { role: "assistant", content: [{ type: "text", text }] },
      uuid, timestamp: new Date(t0 + i * 1000).toISOString(), cwd, sessionId: sid,
    });
    parent = uuid;
  });
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

test("live apply: 3 old Claude transcripts are imported through one wave, mtimes restored, re-apply is a no-op (T3_E2E=1)", {
  skip: process.env.T3_E2E !== "1" || process.platform !== "win32", timeout: 300_000,
}, async () => {
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined, "run with CLAUDE_CONFIG_DIR unset");
  const home = homedir();
  const claudeHome = join(home, ".claude");
  const root = resolve(import.meta.dirname, "..", "..", ".spike", "apply-e2e");
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

  const state = mkdtempSync(join(tmpdir(), "t3sm-apply-e2e-"));
  const files: string[] = [];
  const extraFiles: string[] = [];
  let original: unknown = null;
  let mayRemoveProject = false;
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(encodedDir, { recursive: true });
    mayRemoveProject = true;
    const now = Date.now();
    const sessions: DiscoveredSession[] = [];
    for (let n = 1; n <= 3; n++) {
      const sid = randomUUID();
      const p = join(encodedDir, `${sid}.jsonl`);
      const m = now - (61 - n) * DAY; // 60, 59, 58 days old
      transcript(p, root, sid, m - 60_000, n);
      utimesSync(p, m / 1000, m / 1000);
      files.push(p);
      const st = statSync(p);
      const sc = await scanTranscript(p);
      sessions.push({
        harness: "claude", accountId: "claudeAgent", nativeId: sid, cwd: sc.cwd, startedAt: sc.startedAt, updatedAt: sc.updatedAt ?? new Date(m).toISOString(),
        messageCount: sc.messageCount, corruptLines: sc.corruptLines, file: { path: p, size: st.size, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs }, flags: [],
        cwdOffsetBytes: sc.cwdOffsetBytes,
      });
    }
    const originals = sessions.map((s) => ({ path: s.file.path, mtimeMs: s.file.mtimeMs, atimeMs: s.file.atimeMs }));

    // One more synthetic transcript of the same project, inside T3's 30-day window, that is NOT a wave item: the plan
    // never sees it (written after the sessions were collected). T3 would import it with the wave's project, so the
    // wave-time listing must find it and park it in the FUTURE; it must not be imported and must get its mtime back.
    const extraSid = randomUUID();
    const extra = join(encodedDir, `${extraSid}.jsonl`);
    const extraM = now - 5 * DAY;
    transcript(extra, root, extraSid, extraM - 60_000, 4);
    utimesSync(extra, extraM / 1000, extraM / 1000);
    extraFiles.push(extra);
    const extraOrig = statSync(extra).mtimeMs;
    const extraThread = `import:claudeAgent:${extraSid}`;

    const config = defaultConfig([{ id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }]);
    const plan = await buildPlan({
      sessions, config, journal: [], now: Date.now(), runId: "e2e-apply", home,
      t3: { version: snapshot.version, projects: snapshot.projects, threads: snapshot.threads, instances: snapshot.instances, providers: snapshot.providers },
      existsDir: async (d) => { try { return (await stat(d)).isDirectory(); } catch { return false; } },
    });
    assert.deepEqual(plan.instancesToCreate, [], "no instance is created");
    const ids = sessions.map((s) => `import:claudeAgent:${s.nativeId}`);
    assert.deepEqual(plan.items.map((i) => i.action.kind), ["import", "import", "import"]);
    assert.deepEqual(plan.items.map((i) => (i.action as { expectedThreadId: string }).expectedThreadId).sort(), [...ids].sort());

    const counts = { import: 0, scan: 0 };
    const connect = async (h: string, o: Parameters<typeof connectT3>[1]): Promise<T3Api> => {
      const api = await connectT3(h, o);
      return {
        ...api,
        importSessions: (pid, r) => { counts.import++; return api.importSessions(pid, r); },
        scanSessions: () => { counts.scan++; return api.scanSessions(); },
      };
    };
    const lines: string[] = [];
    const deps = {
      stateDir: state, home, only: root, connect, signals: noSignals,
      onProgress: (l: string) => { lines.push(l); console.log(`live: ${l}`); }, onNotice: (l: string) => console.log(`live notice: ${l}`),
    };

    const t0 = Date.now();
    const r1 = await applyPlan(plan, deps);
    console.log(`live: apply #1 ${Date.now() - t0} ms: ${JSON.stringify({ status: r1.status, imported: r1.imported, failed: r1.failures, deferred: r1.deferred, restoreErrors: r1.restoreErrors })}`);
    assert.equal(r1.status, "ok");
    assert.equal(r1.imported, 3);
    assert.equal(counts.scan, 1, "one wave");

    for (const o of originals) {
      const s = statSync(o.path);
      assert.ok(Math.abs(s.mtimeMs - o.mtimeMs) <= 2, `mtime restored for ${o.path} (${s.mtimeMs} vs ${o.mtimeMs})`);
      console.log(`live: atime delta ${Math.round(s.atimeMs - o.atimeMs)} ms`);
    }

    const es: JournalEntry[] = await new Journal(join(state, "journal.jsonl")).readAll();
    const bump = es.filter((e) => e.t === "mtime-bump") as Extract<JournalEntry, { t: "mtime-bump" }>[];
    const restore = es.filter((e) => e.t === "mtime-restore") as Extract<JournalEntry, { t: "mtime-restore" }>[];
    const imported = es.filter((e) => e.t === "imported") as Extract<JournalEntry, { t: "imported" }>[];
    assert.equal(bump.length, 1);
    const parkedEntry = bump[0]!.files.find((f) => f.path === extra);
    const extraNow = statSync(extra).mtimeMs;
    const check = await connectT3(home, { allowUntested: false });
    let extraImported: boolean;
    try {
      const have = new Set((await check.listThreads()).map((t) => t.id));
      for (const id of ids) assert.ok(have.has(id), `thread ${id} exists in T3`);
      extraImported = have.has(extraThread);
    } finally { await check.close(); }
    console.log(`live: extra transcript parked=${parkedEntry ? `target-${parkedEntry.targetMtimeMs > t0 ? "future" : "PAST"} (+${Math.round((parkedEntry.targetMtimeMs - t0) / 3_600_000)} h)` : "NO"} imported=${extraImported} mtimeRestored=${Math.abs(extraNow - extraOrig) <= 2}`);
    if (parkedEntry && parkedEntry.targetMtimeMs > t0 && extraImported) {
      console.log("live: BLOCKED: T3 imported a transcript whose mtime was in the future during the wave");
    }
    assert.ok(parkedEntry, "the extra in-window transcript was parked in the wave (found by the wave-time listing)");
    assert.ok(parkedEntry.targetMtimeMs > t0 + 23 * 3_600_000, "parked in the future");
    assert.equal(extraImported, false, "T3 did not import the parked (future-mtime) transcript");
    assert.ok(Math.abs(extraNow - extraOrig) <= 2, `extra transcript mtime restored (${extraNow} vs ${extraOrig})`);
    assert.deepEqual(bump[0]!.files.map((f) => f.path).sort(), [...files, extra].sort());
    assert.deepEqual(restore.flatMap((x) => x.paths).sort(), [...files, extra].sort());
    assert.deepEqual(imported.map((x) => x.threadId).sort(), [...ids].sort());
    for (const x of imported) assert.ok(Math.abs(x.source.mtimeMs - originals.find((o) => o.path === x.source.path)!.mtimeMs) <= 2, "imported carries the original mtime");
    assert.ok(es.some((e) => e.t === "project-created"));

    counts.import = 0; counts.scan = 0;
    const r2 = await applyPlan(plan, deps);
    console.log(`live: apply #2: ${JSON.stringify({ status: r2.status, imported: r2.imported, alreadyInT3: r2.alreadyInT3 })} importSessions=${counts.import} scan=${counts.scan}`);
    assert.equal(r2.status, "ok");
    assert.equal(counts.import, 0, "second apply: zero importSessions calls");
    assert.equal(counts.scan, 0);
    assert.equal(r2.alreadyInT3, 3);
  } catch (e) {
    original = e;
  }
  // Cleanup never masks the original failure: each step is guarded, errors are collected and thrown only after it.
  const cleanupErrors: unknown[] = [];
  const step = async (name: string, fn: () => unknown): Promise<void> => {
    try { await fn(); } catch (e) { cleanupErrors.push(e); console.log(`live cleanup: ${name} failed: ${String(e)}`); }
  };
  if (mayRemoveProject) await step("remove T3 project", async () => {
    // `t3 project remove <root>` matches the root case-sensitively: `import.meta.dirname` may spell the drive `d:`
    // while T3 stores `D:` (ProjectNotFoundError on stdout, exit 1; seen in runs 1 and 2). So: log both streams,
    // retry by project id, then verify the project is really gone.
    const remove = async (target: string) => {
      const rm = await defaultRunner(cli, ["project", "remove", "--force", target], { shell: true, env: childEnv, timeoutMs: 60_000 });
      console.log(`live cleanup: t3 project remove --force ${target} -> code ${rm.code}${rm.code === 0 ? "" : ` stdout=${rm.stdout.trim().slice(0, 300)} stderr=${rm.stderr.trim().slice(0, 300)}`}`);
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
  for (const f of [...files, ...extraFiles]) await step(`delete ${f}`, () => { if (existsSync(f)) unlinkSync(f); });
  await step(`remove ${encodedDir}`, () => { if (existsSync(encodedDir) && readdirSync(encodedDir).length === 0) rmdirSync(encodedDir); });
  if (existsSync(encodedDir)) console.log(`live cleanup: ${encodedDir} not empty, left in place`);
  await step(`remove ${root}`, () => rmSync(root, { recursive: true, force: true }));
  await step(`remove ${state}`, () => rmSync(state, { recursive: true, force: true }));
  if (original !== null) throw original;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `live cleanup failed (${cleanupErrors.length} step(s))`);
});
