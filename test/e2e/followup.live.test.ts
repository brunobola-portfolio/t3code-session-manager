// Gated live measurements for t3sm 0.3 (T3_E2E=1, Windows): docs/spikes/S7-followup-and-backdate.md.
//   S7a. A faithful synthetic transcript is imported into a disposable `.spike/` project; 2 records are appended to the
//        file; `agentSessions.import` runs again for the same project. Records what T3 did (same thread grew, nothing, error).
//   S7b. Same, but the thread is first continued inside T3 (`t3 thread send`), then the file gets 2 more records.
//   S8.  `thread.settle` is dispatched RAW with an optional `settledAt` (T3Api.settleThread is not used: it sends no
//        optional fields). Records the `settledAt` T3 stores.
// Nothing here fails on either outcome: each case prints ONE JSON line `{"case":..,"outcome":..}` that says which value
// FOLLOW_MODE and SETTLE_BACKDATE (src/t3/compat.ts) should have. Only a broken harness (preflight, setup) fails a case.
// Synthetic data only, in the PERSONAL account home (<homedir>/.claude, verified to be claudeAgent's home first), under
// `.spike/` roots; everything this run created (and only that) is removed in `finally`; a refused preflight removes nothing.
// The records are dated 60 days back (S8 needs an old thread), but the FILE time is set about an hour back before every
// import (`idle`): inside T3's 30-day import window (S2: an older file is not imported at all, which would measure
// nothing), outside the 10-minute active window, and never older than invariant 4's 20 days (Claude Code's cleanup
// deletes old transcripts by file time). Run with CLAUDE_CONFIG_DIR unset; it refuses otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { encodeClaudeProjectDir, sameCwd } from "../../src/core/paths.ts";
import { connectT3, type T3Api } from "../../src/t3/api.ts";
import { defaultRunner } from "../../src/t3/auth.ts";
import { webSocketTransport, type Transport } from "../../src/t3/rpc.ts";
import { resolveT3Cli } from "../../src/t3/runtime.ts";

const DAY = 86_400_000;
const live = process.env.T3_E2E === "1" && process.platform === "win32";
const log = (s: string): void => console.log(`live: ${s}`);
const record = (o: Record<string, unknown>): void => console.log(JSON.stringify(o));

interface Rec { type: "user" | "assistant"; text: string }

/** Appends chained records (user / assistant) to a transcript file; creates it when absent. Chains from the last uuid. */
function appendRecords(path: string, o: { cwd: string; sid: string; t0: number; recs: Rec[] }): void {
  let parent: string | null = null;
  if (existsSync(path)) {
    for (const l of readFileSync(path, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l) as { uuid?: unknown }; if (typeof r.uuid === "string") parent = r.uuid; } catch { /* skip */ }
    }
  }
  const lines: string[] = [];
  o.recs.forEach((r, i) => {
    const uuid = randomUUID();
    lines.push(JSON.stringify({
      parentUuid: parent, isSidechain: false, userType: "external", entrypoint: "cli", cwd: o.cwd, sessionId: o.sid, version: "2.1.0", type: r.type,
      message: r.type === "user" ? { role: "user", content: r.text } : { role: "assistant", content: [{ type: "text", text: r.text }] },
      uuid, timestamp: new Date(o.t0 + i * 1000).toISOString(),
    }));
    parent = uuid;
  });
  appendFileSync(path, lines.join("\n") + "\n", "utf8");
}

const HOUR = 3_600_000;
/** The file time an hour back: importable (T3's 30-day window), idle (not the 10-minute active window), never old. */
const idle = (f: string): void => { const m = (Date.now() - HOUR) / 1000; utimesSync(f, m, m); };

/** `t3 ...` through the shell (a .cmd shim on Windows), optional stdin, 3-minute cap; never throws. */
function runCli(cli: string, args: string[], input: string | null, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    let stdout = "", stderr = "";
    const child = spawn(`"%T3SM_CLI%" ${args.join(" ")}`, { env: { ...env, T3SM_CLI: cli }, shell: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill(); }, 180_000); // our own child, by handle
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); res({ code: null, stdout, stderr: stderr + String(e) }); });
    child.on("close", (code) => { clearTimeout(timer); res({ code, stdout, stderr }); });
    child.stdin.end(input ?? "");
  });
}

/** Connects and exposes `raw(tag, payload)`: one raw RPC request on the same socket, resolved with the Exit frame's `exit` (never decoded). */
async function connectRaw(home: string): Promise<{ api: T3Api; raw: (tag: string, payload: unknown) => Promise<unknown> }> {
  let inner: Transport | null = null;
  const listeners = new Map<string, (m: Record<string, unknown>) => void>();
  const api = await connectT3(home, {
    allowUntested: false, onNotice: (l) => log(`notice: ${l}`),
    transportFactory: async (url) => {
      const t = await webSocketTransport(url);
      inner = t;
      return {
        send: (f) => t.send(f), onClose: (cb) => t.onClose(cb), close: () => t.close(),
        onFrame: (cb) => t.onFrame((f) => {
          cb(f);
          try {
            const p: unknown = JSON.parse(f);
            for (const m of Array.isArray(p) ? p : [p]) {
              const id = (m as { requestId?: unknown }).requestId;
              if (typeof id === "string" && listeners.has(id)) listeners.get(id)!(m as Record<string, unknown>);
            }
          } catch { /* not ours */ }
        }),
      };
    },
  });
  let n = 0;
  const raw = (tag: string, payload: unknown): Promise<unknown> => new Promise((res, rej) => {
    if (!inner) { rej(new Error("no transport")); return; }
    const id = `raw-${++n}`;
    const timer = setTimeout(() => { listeners.delete(id); rej(new Error(`raw ${tag} timed out`)); }, 30_000);
    listeners.set(id, (m) => { if (m._tag === "Exit") { clearTimeout(timer); listeners.delete(id); res(m.exit); } });
    inner.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
  });
  return { api, raw };
}

async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 750));
  }
}

interface Ctx {
  api: T3Api; raw: (tag: string, payload: unknown) => Promise<unknown>; cli: string; childEnv: Record<string, string>;
  root: string; encoded: string; projectId: string; sid: string; file: string; threadId: string;
}

/**
 * One disposable project with one imported synthetic faithful transcript (2 records, 60 days old). Everything is removed
 * afterwards, whatever `body` does.
 */
async function withSyntheticThread(name: string, body: (c: Ctx) => Promise<void>): Promise<void> {
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined, "run with CLAUDE_CONFIG_DIR unset");
  const home = homedir();
  const claudeHome = join(home, ".claude");
  const root = join(resolve(import.meta.dirname, "..", "..", ".spike"), name);
  const encoded = join(claudeHome, "projects", encodeClaudeProjectDir(root));
  const cli = resolveT3Cli(home, process.platform, process.env.PATH ?? "");
  assert.ok(cli, "t3 cli found");
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k.toUpperCase() !== "CLAUDE_CONFIG_DIR") childEnv[k] = v;

  const { api, raw } = await connectRaw(home);
  const sid = randomUUID();
  // Read-only preflight, OUTSIDE the cleanup scope: when it refuses, nothing was created, so nothing may be removed.
  try {
    const ca = (await api.providerInstances()).find((p) => p.instanceId === "claudeAgent");
    assert.ok(ca && ca.homePath !== null && sameCwd(ca.homePath, claudeHome), `claudeAgent must read ${claudeHome} (got ${ca?.homePath})`);
    assert.ok(!(await api.listProjects()).some((p) => sameCwd(p.workspaceRoot, root)), `a T3 project for ${root} already exists (leftover?)`);
    assert.ok(!existsSync(encoded), `${encoded} already exists; refusing to write next to unknown files`);
    assert.ok(!existsSync(root), `${root} already exists (leftover?)`);
  } catch (e) { await api.close(); throw e; }

  // Cleanup only removes what this run created, each flag set right after the creation.
  let createdRoot = false, createdEncoded = false, createdProjectId: string | null = null;
  const startMs = Date.now();
  let original: unknown = null;
  try {
    mkdirSync(root, { recursive: true }); createdRoot = true;
    mkdirSync(encoded, { recursive: true }); createdEncoded = true;
    const file = join(encoded, `${sid}.jsonl`);
    appendRecords(file, { cwd: root, sid, t0: Date.now() - 60 * DAY, recs: [{ type: "user", text: `t3sm followup e2e (${name}): remember the codeword KIWI-41.` }, { type: "assistant", text: "Remembered: KIWI-41." }] });
    idle(file);
    const project = await api.createProject(root, `t3sm-${name}`);
    createdProjectId = project.id;
    const imp = await api.importSessions(project.id, root);
    log(`${name}: first import ${JSON.stringify(imp)}`);
    const threadId = `import:claudeAgent:${sid}`;
    const seen = await eventually(() => api.listThreads(), (ts) => ts.some((t) => t.id === threadId));
    assert.ok(seen, `thread ${threadId} appears after the first import`);
    await body({ api, raw, cli, childEnv, root, encoded, projectId: project.id, sid, file, threadId });
  } catch (e) {
    original = e;
  } finally {
    const errors: unknown[] = [];
    const step = async (what: string, fn: () => unknown): Promise<void> => { try { await fn(); } catch (e) { errors.push(e); log(`cleanup: ${what} failed: ${String(e)}`); } };
    await step("close T3 connection", () => api.close());
    await step("remove T3 project", async () => {
      if (createdProjectId === null) return;
      const rm = await defaultRunner(cli, ["project", "remove", "--force", createdProjectId], { shell: true, env: childEnv, timeoutMs: 60_000 });
      log(`cleanup: t3 project remove --force ${createdProjectId} -> code ${rm.code}`);
    });
    if (createdEncoded) await step(`remove ${encoded}`, () => rmSync(encoded, { recursive: true, force: true }));
    await step("remove side files of the session", () => {
      for (const d of [claudeHome, ...["session-env", "security", join("session-namer", "state"), "file-history", "todos", "debug", "sessions", "tasks"].map((x) => join(claudeHome, x))]) {
        if (!existsSync(d)) continue;
        for (const n of readdirSync(d)) if (n.includes(sid)) rmSync(join(d, n), { recursive: true, force: true });
      }
    });
    // Not deleted (not provably ours): entries newer than the test start, so leftovers of a T3 turn are visible.
    await step("list new file-history/todos entries", () => {
      for (const x of ["file-history", "todos"]) {
        const d = join(claudeHome, x);
        if (!existsSync(d)) continue;
        for (const n of readdirSync(d)) if (statSync(join(d, n)).mtimeMs >= startMs) log(`cleanup: NEW ${join(d, n)} (not removed; check by hand)`);
      }
    });
    if (createdRoot) await step(`remove ${root}`, () => rmSync(root, { recursive: true, force: true }));
    for (const p of [createdEncoded ? encoded : null, createdRoot ? root : null]) if (p && existsSync(p)) log(`cleanup: LEFT BEHIND: ${p}: delete it by hand`);
    if (original !== null) throw original;
    if (errors.length > 0) throw new AggregateError(errors, "live cleanup incomplete");
  }
}

/** What T3 shows for the thread now: message count (by `"role"` occurrences in `t3 thread show --json`) and codeword presence. */
async function observe(c: Ctx, words: string[]): Promise<Record<string, unknown>> {
  const show = await runCli(c.cli, ["thread", "show", "--json", c.threadId], null, c.childEnv);
  const out = show.stdout;
  const threads = (await c.api.listThreads()).filter((t) => t.projectId === c.projectId);
  return {
    showCode: show.code, roleCount: (out.match(/"role"/g) ?? []).length, words: Object.fromEntries(words.map((w) => [w, out.includes(w)])),
    threadsInProject: threads.map((t) => t.id), latestUserMessageAt: threads.find((t) => t.id === c.threadId)?.latestUserMessageAt ?? null,
  };
}

/** The second import, recording the outcome rather than asserting one. */
async function reimport(c: Ctx): Promise<{ result: unknown; error: string | null }> {
  try { return { result: await c.api.importSessions(c.projectId, c.root), error: null }; } catch (e) { return { result: null, error: String(e) }; }
}

function classify(again: { error: string | null }, before: Record<string, unknown>, after: Record<string, unknown>, word: string): string {
  if (again.error !== null) return "error";
  const grew = (after.roleCount as number) > (before.roleCount as number) || (after.words as Record<string, boolean>)[word] === true;
  if (grew) return "grew-same-thread";
  return JSON.stringify(before.threadsInProject) === JSON.stringify(after.threadsInProject) ? "nothing-happened" : "other";
}

test("live S7a: append to an imported faithful copy, import again, record what T3 does (T3_E2E=1)", { skip: !live, timeout: 300_000 }, async () => {
  await withSyntheticThread("followup-e2e-a", async (c) => {
    const before = await observe(c, ["KIWI-41", "PEAR-77"]);
    appendRecords(c.file, { cwd: c.root, sid: c.sid, t0: Date.now() - 59 * DAY, recs: [{ type: "user", text: "Also remember PEAR-77." }, { type: "assistant", text: "Remembered: PEAR-77." }] });
    idle(c.file);
    const again = await reimport(c);
    await new Promise((r) => setTimeout(r, 3_000));
    const after = await observe(c, ["KIWI-41", "PEAR-77"]);
    record({ case: "S7a", outcome: classify(again, before, after, "PEAR-77"), reimport: again, before, after });
  });
});

test("live S7b: continue the thread in T3 (t3 thread send), append to the file, import again, record (T3_E2E=1)", { skip: !live, timeout: 480_000 }, async () => {
  await withSyntheticThread("followup-e2e-b", async (c) => {
    // t3 thread send is the pattern of docs/spikes/S2-import.md: --wait --json, message on stdin ("-"). It spends one turn.
    const send = await runCli(c.cli, ["thread", "send", "--wait", "--json", c.threadId, "-"], "Which codeword did I ask you to remember? Reply with the codeword only.", c.childEnv);
    log(`S7b: t3 thread send -> code ${send.code}; ${JSON.stringify(send.stdout.trim().slice(0, 200))}`);
    if (send.code !== 0) { record({ case: "S7b", outcome: "send-failed", code: send.code, stderr: send.stderr.trim().slice(0, 300) }); return; }
    const before = await observe(c, ["KIWI-41", "PEAR-88"]);
    appendRecords(c.file, { cwd: c.root, sid: c.sid, t0: Date.now(), recs: [{ type: "user", text: "Also remember PEAR-88." }, { type: "assistant", text: "Remembered: PEAR-88." }] });
    idle(c.file);
    const again = await reimport(c);
    await new Promise((r) => setTimeout(r, 3_000));
    const after = await observe(c, ["KIWI-41", "PEAR-88"]);
    record({ case: "S7b", outcome: classify(again, before, after, "PEAR-88"), reimport: again, before, after });
  });
});

test("live S8: thread.settle with an optional settledAt, record the settledAt T3 stores (T3_E2E=1)", { skip: !live, timeout: 300_000 }, async () => {
  await withSyntheticThread("followup-e2e-s8", async (c) => {
    const target = "2026-01-01T00:00:00.000Z";
    const settledOf = async (): Promise<string | null> => (await c.api.listThreads()).find((t) => t.id === c.threadId)?.settledAt ?? null;
    // An imported old thread may already be settled: unsettle first so the settle below is a real transition.
    await c.api.unsettleThread(c.threadId);
    await eventually(settledOf, (v) => v === null);
    const exit = (await c.raw("orchestration.dispatchCommand", { type: "thread.settle", commandId: randomUUID(), threadId: c.threadId, settledAt: target })) as { _tag?: string } | null;
    const ok = exit?._tag === "Success";
    const stored = ok ? await eventually(settledOf, (v) => v !== null) : await settledOf();
    const outcome = !ok ? "rejected" : stored === null ? "no-settledAt-seen" : stored === target ? "honoured" : "ignored";
    record({ case: "S8", outcome, sent: target, stored, exit: exit?._tag ?? null, exitDetail: ok ? undefined : JSON.stringify(exit).slice(0, 400) });
  });
});
