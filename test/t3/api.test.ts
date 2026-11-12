import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createT3Api, connectT3, instancesFromConfig, type RpcLike } from "../../src/t3/api.ts";
import { decodeConfig } from "../../src/t3/decode.ts";
import { ShapeError, T3AuthError, T3HttpError, T3Incompatible, T3NotRunning, RpcError } from "../../src/t3/errors.ts";
import { normalizeCwd } from "../../src/core/paths.ts";
import type { Transport } from "../../src/t3/rpc.ts";
import type { RunOptions, RunResult } from "../../src/t3/auth.ts";

const fx = async (n: string) => JSON.parse(await readFile(new URL(`../fixtures/t3-wire/${n}`, import.meta.url), "utf8"));
const exitValue = async (n: string) => (await fx(n)).exit.value;
const ORIGIN = "http://127.0.0.1:3773";
const TOKEN = "test-bearer-token-0123456789";

interface FetchCall { url: string; method: string; headers: Record<string, string>; body: string | null; redirect: unknown; signal: unknown }
type Route = (call: FetchCall) => Response | Promise<Response>;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

function fakeFetch(routes: Record<string, Route>) {
  const calls: FetchCall[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const u = new URL(url);
    const headers: Record<string, string> = {};
    for (const [k, v] of new Headers(init.headers).entries()) headers[k] = v;
    const call: FetchCall = { url, method: init.method ?? "GET", headers, body: typeof init.body === "string" ? init.body : null, redirect: init.redirect, signal: init.signal };
    calls.push(call);
    const r = routes[`${call.method} ${u.pathname}`];
    if (!r) return new Response("not found", { status: 404 });
    return r(call);
  }) as typeof fetch;
  return { fetch: f, calls };
}

interface RpcCall { tag: string; payload: unknown; timeoutMs: number | undefined }
class FakeRpc implements RpcLike {
  calls: RpcCall[] = [];
  closed = 0;
  replies: Record<string, unknown> = {};
  call<T>(tag: string, payload: unknown, decode: (u: unknown) => T, timeoutMs?: number): Promise<T> {
    this.calls.push({ tag, payload, timeoutMs });
    const r = this.replies[tag];
    if (r === undefined) return Promise.reject(new Error(`no reply for ${tag}`));
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve().then(() => decode(structuredClone(typeof r === "function" ? (r as (p: unknown) => unknown)(payload) : r)));
  }
  close() { this.closed++; }
}

function ids(...xs: string[]) {
  const q = [...xs];
  return () => { const v = q.shift(); if (!v) throw new Error("id factory exhausted"); return v; };
}

async function makeApi(opts: { routes?: Record<string, Route>; replies?: Record<string, unknown>; newId?: () => string; onClose?: () => Promise<void>; origin?: string } = {}) {
  const ff = fakeFetch(opts.routes ?? {});
  const rpc = new FakeRpc();
  Object.assign(rpc.replies, opts.replies ?? {});
  const api = createT3Api({ origin: opts.origin ?? ORIGIN, token: TOKEN, rpc, fetchImpl: ff.fetch, version: "0.1.9-nightly.20261110.4465", newId: opts.newId ?? ids(), platform: "win32", onClose: opts.onClose });
  return { api, rpc, calls: ff.calls };
}

function assertHttpBasics(c: FetchCall) {
  assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(c.redirect, "error");
  assert.ok(c.signal instanceof AbortSignal, "every request carries a timeout signal");
}

test("listProjects: GET /api/projects with Bearer, redirect error, timeout; decoded", async () => {
  const body = await fx("http-projects.json");
  const { api, calls } = await makeApi({ routes: { "GET /api/projects": () => json(body) } });
  const ps = await api.listProjects();
  assert.equal(ps.length, 1);
  assert.equal(ps[0]!.workspaceRoot, "D:\\work\\demo-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${ORIGIN}/api/projects`);
  assertHttpBasics(calls[0]!);
});

test("listThreads: shell with x-t3-orchestration-protocol: 2, plus the archived snapshot over RPC", async () => {
  const body = await fx("http-orchestration-shell-imported.json");
  const archivedThread = { ...body.threads[2], id: "import:claudeAgent:00000000-0000-4000-8000-0000000000aa", archivedAt: "2026-11-10T18:00:00.000Z" };
  const snap = { schemaVersion: 2, snapshotSequence: 441, projects: body.projects, threads: [archivedThread] };
  const { api, calls, rpc } = await makeApi({ routes: { "GET /api/orchestration/shell": () => json(body) }, replies: { "orchestration.getArchivedShellSnapshot": snap } });
  const ts = await api.listThreads();
  assert.equal(ts.length, 4);
  assert.deepEqual(ts.filter((t) => t.archived).map((t) => t.id), [archivedThread.id]);
  assert.equal(calls[0]!.headers["x-t3-orchestration-protocol"], "2");
  assertHttpBasics(calls[0]!);
  assert.deepEqual(rpc.calls.map((c) => [c.tag, JSON.stringify(c.payload)]), [["orchestration.getArchivedShellSnapshot", "{}"]]);
});

test("listThreads: a thread in both lists is reported once, archived", async () => {
  const body = await fx("http-orchestration-shell.json");
  const snap = { schemaVersion: 2, snapshotSequence: 1, projects: [], threads: [{ ...body.threads[0], archivedAt: "2026-11-10T18:00:00.000Z" }] };
  const { api } = await makeApi({ routes: { "GET /api/orchestration/shell": () => json(body) }, replies: { "orchestration.getArchivedShellSnapshot": snap } });
  const ts = await api.listThreads();
  assert.deepEqual(ts.map((t) => [t.id, t.archived]), [[body.threads[0].id, true]]);
});

test("listProjects excludes deleted projects, keeps archived ones flagged", async () => {
  const body = await fx("http-projects.json");
  body.projects.push({ ...body.projects[0], id: "p-del", deletedAt: "2026-11-01T00:00:00.000Z" }, { ...body.projects[0], id: "p-arch", archivedAt: "2026-11-01T00:00:00.000Z" });
  const { api } = await makeApi({ routes: { "GET /api/projects": () => json(body) } });
  assert.deepEqual((await api.listProjects()).map((p) => [p.id, p.archived]), [[body.projects[0].id, false], ["p-arch", true]]);
});

test("a changed response shape fails with ShapeError (exit 4 class)", async () => {
  const body = await fx("http-projects.json");
  delete body.projects[0].workspaceRoot;
  const { api } = await makeApi({ routes: { "GET /api/projects": () => json(body) } });
  await assert.rejects(api.listProjects(), (e: unknown) => e instanceof ShapeError && e.path === "$.projects[0].workspaceRoot" && e.exitCode === 4);
  const { api: api2 } = await makeApi({ routes: { "GET /api/projects": () => new Response("<html>", { status: 200 }) } });
  await assert.rejects(api2.listProjects(), (e: unknown) => e instanceof ShapeError && e.path === "$" && e.endpoint === "GET /api/projects");
});

test("createProject: body byte-matches the recorded request; response decoded", async () => {
  const rec = await fx("http-project-mutate-create.request.json");
  const resp = await fx("http-project-mutate.response.json");
  const { api, calls } = await makeApi({ routes: { "POST /api/projects/mutate": () => json(resp) }, newId: ids(rec.commandId, rec.projectId) });
  const p = await api.createProject("C:\\work\\demo", "demo");
  assert.equal(p.id, resp.id);
  assert.equal(calls[0]!.body, JSON.stringify(rec));
  assert.equal(calls[0]!.headers["content-type"], "application/json");
  assertHttpBasics(calls[0]!);
});

test("HTTP errors -> T3HttpError with status and code, never the token", async () => {
  const dup = await fx("http-project-mutate-create-duplicate-root.response.json");
  const { api } = await makeApi({ routes: { "POST /api/projects/mutate": () => json(dup, 400) }, newId: ids("c", "p") });
  await assert.rejects(api.createProject("C:\\work\\demo", "demo"), (e: unknown) => {
    assert.ok(e instanceof T3HttpError);
    assert.equal(e.status, 400);
    assert.equal(e.code, "invalid_request");
    assert.equal(e.reason, "invalid_command");
    assert.equal(e.endpoint, "POST /api/projects/mutate");
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
  const f403 = await fx("http-403-insufficient-scope.json");
  const { api: a2 } = await makeApi({ routes: { "GET /api/projects": () => json(f403, 403) } });
  await assert.rejects(a2.listProjects(), (e: unknown) => e instanceof T3HttpError && e.status === 403 && e.code === "insufficient_scope");
});

test("HTTP: a failed fetch (redirect/timeout/refused) is a T3HttpError without the token", async () => {
  const { api } = await makeApi({ routes: { "GET /api/projects": () => { throw new TypeError(`fetch failed ${TOKEN}`); } } });
  await assert.rejects(api.listProjects(), (e: unknown) => e instanceof T3HttpError && e.status === null && !e.message.includes(TOKEN));
});

test("non-local origin is refused before any request", async () => {
  const { api, calls } = await makeApi({ origin: "http://example.com:3773", routes: { "GET /api/projects": () => json({ projects: [] }) } });
  await assert.rejects(api.listProjects(), T3AuthError);
  assert.equal(calls.length, 0);
});

async function projectsWith(id: string, sel: unknown) {
  const body = await fx("http-projects.json");
  body.projects[0].id = id;
  body.projects[0].defaultModelSelection = sel;
  return body;
}

test("setProjectDefault: explicit model byte-matches the recorded project.update; previous read first", async () => {
  const rec = await fx("http-project-mutate-update.request.json");
  const resp = await fx("http-project-mutate.response.json");
  const prev = { instanceId: "codex", model: "gpt-6-luna" };
  const { api, calls, rpc } = await makeApi({
    routes: { "GET /api/projects": async () => json(await projectsWith(rec.projectId, prev)), "POST /api/projects/mutate": () => json(resp) },
    newId: ids(rec.commandId),
  });
  const r = await api.setProjectDefault(rec.projectId, "claudeAgent", "claude-opus-4-6");
  assert.deepEqual(r, { previous: prev });
  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), ["GET /api/projects", "POST /api/projects/mutate"]);
  assert.equal(calls[1]!.body, JSON.stringify(rec));
  assert.equal(rpc.calls.length, 0, "explicit model needs no getConfig");
});

test("setProjectDefault: model defaults to the instance's current default model", async () => {
  const resp = await fx("http-project-mutate.response.json");
  const cfg = await exitValue("ws-getconfig-instances.exit.json");
  const { api, calls } = await makeApi({
    routes: { "GET /api/projects": async () => json(await projectsWith("p1", null)), "POST /api/projects/mutate": () => json(resp) },
    replies: { "server.getConfig": cfg },
    newId: ids("c1"),
  });
  assert.deepEqual(await api.setProjectDefault("p1", "claude-org"), { previous: null });
  assert.deepEqual(JSON.parse(calls[1]!.body!), { type: "project.update", commandId: "c1", projectId: "p1", defaultModelSelection: { instanceId: "claude-org", model: "claude-opus-5-5" } });
});

test("setProjectDefault: instance only in settings (not yet probed) uses the driver's default model", async () => {
  const resp = await fx("http-project-mutate.response.json");
  const cfg = await exitValue("ws-getconfig-instances.exit.json");
  cfg.settings.providerInstances["claude-new"] = { driver: "claudeAgent", config: { homePath: "C:\\Users\\demo\\.claude-new" } };
  const { api, calls } = await makeApi({
    routes: { "GET /api/projects": async () => json(await projectsWith("p1", null)), "POST /api/projects/mutate": () => json(resp) },
    replies: { "server.getConfig": cfg },
    newId: ids("c1"),
  });
  await api.setProjectDefault("p1", "claude-new");
  assert.deepEqual(JSON.parse(calls[1]!.body!).defaultModelSelection, { instanceId: "claude-new", model: "claude-opus-5-5" });
});

test("setProjectDefault: null clears; unknown project or instance fails before writing", async () => {
  const resp = await fx("http-project-mutate.response.json");
  const cfg = await exitValue("ws-getconfig-instances.exit.json");
  const prev = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  const mk = () => makeApi({
    routes: { "GET /api/projects": async () => json(await projectsWith("p1", prev)), "POST /api/projects/mutate": () => json(resp) },
    replies: { "server.getConfig": cfg },
    newId: ids("c1"),
  });
  const a = await mk();
  assert.deepEqual(await a.api.setProjectDefault("p1", null), { previous: prev });
  assert.equal(a.calls[1]!.body, JSON.stringify({ type: "project.update", commandId: "c1", projectId: "p1", defaultModelSelection: null }));
  const b = await mk();
  await assert.rejects(b.api.setProjectDefault("nope", "claudeAgent", "m"), /not found/);
  assert.equal(b.calls.filter((c) => c.method === "POST").length, 0);
  const c = await mk();
  await assert.rejects(c.api.setProjectDefault("p1", "ghost"), /ghost/);
  assert.equal(c.calls.filter((x) => x.method === "POST").length, 0);
});

test("getConfig + providerInstances: homePath from groupKey, else settings config.homePath", async () => {
  const cfg = await exitValue("ws-getconfig-instances.exit.json");
  cfg.settings.providerInstances["claude-new"] = { driver: "claudeAgent", displayName: "New", accentColor: "#112233", config: { homePath: "C:\\Users\\demo\\.claude-new" } };
  const { api, rpc } = await makeApi({ replies: { "server.getConfig": cfg } });
  const list = await api.providerInstances();
  assert.equal(rpc.calls[0]!.tag, "server.getConfig");
  assert.deepEqual(rpc.calls[0]!.payload, {});
  assert.deepEqual(list, [
    { instanceId: "claudeAgent", driver: "claudeAgent", homePath: "C:\\Users\\demo\\.claude", displayName: "Claude", accentColor: null, email: "personal@example.com", authStatus: "authenticated", enabled: true, availability: "available" },
    { instanceId: "claude-org", driver: "claudeAgent", homePath: "C:\\Users\\demo\\.claude-org", displayName: "Claude · Work", accentColor: "#7C3AED", email: "org@example.com", authStatus: "authenticated", enabled: true, availability: "available" },
    { instanceId: "claude-new", driver: "claudeAgent", homePath: "C:\\Users\\demo\\.claude-new", displayName: "New", accentColor: "#112233", email: null, authStatus: null, enabled: true, availability: "unavailable" },
  ]);
  const base = await makeApi({ replies: { "server.getConfig": await exitValue("ws-getconfig.exit.json") } });
  const l2 = await base.api.providerInstances();
  assert.deepEqual(l2.map((i) => [i.instanceId, i.homePath]), [["codex", "C:\\Users\\demo\\.codex"], ["claudeAgent", "C:\\Users\\demo\\.claude-alt"]]);
});

test("providerInstances: unavailable instance never throws; homePath = config.homePath > runtimePaths > groupKey", async () => {
  const cfg = await exitValue("ws-getconfig-unavailable.synthetic.json");
  cfg.settings.providerInstances["claude-org"].config.homePath = "C:\\Users\\demo\\.claude-org-configured"; // configured wins over groupKey
  const { api } = await makeApi({ replies: { "server.getConfig": cfg } });
  const list = await api.providerInstances();
  const by = Object.fromEntries(list.map((i) => [i.instanceId, i]));
  assert.deepEqual([by["claude-gone"]!.availability, by["claude-gone"]!.homePath, by["claude-gone"]!.authStatus, by["claude-gone"]!.displayName], ["unavailable", "C:\\Users\\demo\\.claude-gone", "unknown", "Claude Gone"]);
  assert.equal(by["claude-org"]!.homePath, "C:\\Users\\demo\\.claude-org-configured");
  assert.deepEqual([by["claude-rt"]!.homePath, by["claude-rt"]!.displayName], ["C:\\Users\\demo\\.claude-rt", "claudeAgent"]);
  const base = await exitValue("ws-getconfig.exit.json");
  delete base.providers[1].continuation;
  const { api: a2 } = await makeApi({ replies: { "server.getConfig": base } });
  assert.equal((await a2.providerInstances())[1]!.homePath, null);
});

test("instancesFromConfig: Claude-driver instances only, homePath normalized", async () => {
  const cfg = decodeConfig(await exitValue("ws-getconfig.exit.json"));
  assert.deepEqual(instancesFromConfig(cfg, "win32"), [
    { id: "claudeAgent", driver: "claudeAgent", displayName: "Claude", accentColor: null, homePath: normalizeCwd("C:\\Users\\demo\\.claude-alt", "win32"), environment: [] },
  ]);
  const ci = decodeConfig(await exitValue("ws-getconfig-instances.exit.json"));
  const env = [{ name: "CLAUDE_SECURESTORAGE_CONFIG_DIR", value: "C:\\Users\\demo\\.claude-org", sensitive: false }];
  (ci.settings.providerInstances["claude-org"] as Record<string, unknown>).environment = env;
  const specs = instancesFromConfig(ci, "win32");
  assert.deepEqual(specs.map((s) => [s.id, s.homePath, s.accentColor]), [["claudeAgent", "C:/Users/demo/.claude", null], ["claude-org", "C:/Users/demo/.claude-org", "#7C3AED"]]);
  assert.deepEqual(specs[1]!.environment, env);
});

test("addInstance: payload byte-matches the recorded S4 create; uses mutation, never patch.providerInstances", async () => {
  const rec = await fx("ws-updatesettings.request.json");
  const { api, rpc } = await makeApi({ replies: { "server.updateSettings": await exitValue("ws-updatesettings.exit.json") } });
  await api.addInstance({ id: "claude-org", driver: "claudeAgent", displayName: "Claude · Work", accentColor: "#7C3AED", homePath: "C:/Users/demo/.claude-org", environment: [] });
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0]!.tag, "server.updateSettings");
  assert.equal(JSON.stringify(rpc.calls[0]!.payload), JSON.stringify(rec.payload));
});

test("addInstance: environment travels as an array; null accent omitted", async () => {
  const settings = await exitValue("ws-updatesettings.exit.json");
  settings.providerInstances.x1 = { driver: "claudeAgent" };
  const { api, rpc } = await makeApi({ replies: { "server.updateSettings": settings } });
  await api.addInstance({ id: "x1", driver: "claudeAgent", displayName: "X", accentColor: null, homePath: "C:\\h\\x", environment: [{ name: "A_B", value: "v", sensitive: false }] });
  assert.equal(JSON.stringify(rpc.calls[0]!.payload), JSON.stringify({ patch: {}, providerInstanceMutation: { operation: "create", instanceId: "x1", instance: { driver: "claudeAgent", displayName: "X", enabled: true, config: { homePath: "C:\\h\\x" }, environment: [{ name: "A_B", value: "v", sensitive: false }] } } }));
});

test("addInstance: invalid id / accent / env / relative home rejected before any call", async () => {
  const { api, rpc } = await makeApi({ replies: { "server.updateSettings": await exitValue("ws-updatesettings.exit.json") } });
  const ok = { id: "claude-org", driver: "claudeAgent" as const, displayName: "X", accentColor: "#7C3AED", homePath: "C:\\h", environment: [] };
  for (const bad of [
    { ...ok, id: "1abc" }, { ...ok, id: "a b" }, { ...ok, id: "a".repeat(65) }, { ...ok, id: "" },
    { ...ok, accentColor: "red" }, { ...ok, accentColor: "#7C3AE" },
    { ...ok, environment: [{ name: "1X", value: "v", sensitive: false }] },
    { ...ok, homePath: "relative\\dir" }, { ...ok, displayName: "  " },
  ]) await assert.rejects(api.addInstance(bad), Error);
  assert.equal(rpc.calls.length, 0);
  await api.addInstance({ ...ok, id: "a".repeat(64) }).catch(() => {}); // valid id length; reply lacks it -> rejects after the call
  assert.equal(rpc.calls.length, 1);
});

test("addInstance: a reply whose providerInstances lacks the new id is rejected", async () => {
  const { api } = await makeApi({ replies: { "server.updateSettings": { providerInstances: {} } } });
  await assert.rejects(api.addInstance({ id: "claude-org", driver: "claudeAgent", displayName: "X", accentColor: null, homePath: "C:\\h", environment: [] }), ShapeError);
});

test("pinInstanceHome: implicit instance (empty settings map) -> upsert {driver, config:{homePath}} (S4 §6), previous null", async () => {
  const cfg = await exitValue("ws-getconfig.exit.json");
  const { api, rpc } = await makeApi({ replies: { "server.getConfig": cfg, "server.updateSettings": (p: any) => ({ providerInstances: { [p.providerInstanceMutation.instanceId]: p.providerInstanceMutation.instance } }) } });
  const r = await api.pinInstanceHome("claudeAgent", "C:\\Users\\demo\\.claude");
  assert.deepEqual(r, { previous: null, changed: true });
  assert.equal(rpc.calls[1]!.tag, "server.updateSettings");
  assert.equal(JSON.stringify(rpc.calls[1]!.payload), '{"patch":{},"providerInstanceMutation":{"operation":"upsert","instanceId":"claudeAgent","instance":{"driver":"claudeAgent","config":{"homePath":"C:\\\\Users\\\\demo\\\\.claude"}}}}');
});

test("pinInstanceHome: explicit entry -> upsert of the FULL entry with only config.homePath changed", async () => {
  const cfg = await exitValue("ws-getconfig-instances.exit.json");
  cfg.settings.providerInstances["claude-org"].config.binaryPath = "C:\\bin\\claude.exe";
  cfg.settings.providerInstances["claude-org"].environment = [{ name: "X", value: "y", sensitive: false }];
  const before = structuredClone(cfg.settings.providerInstances["claude-org"]);
  const { api, rpc } = await makeApi({ replies: { "server.getConfig": cfg, "server.updateSettings": (p: any) => ({ providerInstances: { [p.providerInstanceMutation.instanceId]: p.providerInstanceMutation.instance } }) } });
  const r = await api.pinInstanceHome("claude-org", "D:/alt/home");
  assert.deepEqual(r.previous, before);
  assert.equal(r.changed, true);
  const sent = (rpc.calls[1]!.payload as any).providerInstanceMutation;
  assert.equal(sent.operation, "upsert");
  assert.deepEqual(Object.keys(sent.instance), Object.keys(before));
  assert.deepEqual(sent.instance, { ...before, config: { ...before.config, homePath: "D:\\alt\\home" } });
});

test("pinInstanceHome: already pinned to that home -> no write, changed:false", async () => {
  const cfg = await exitValue("ws-getconfig-instances.exit.json");
  const { api, rpc } = await makeApi({ replies: { "server.getConfig": cfg, "server.updateSettings": {} } });
  const r = await api.pinInstanceHome("claudeAgent", "c:/Users/demo/.claude/");
  assert.deepEqual(r, { previous: cfg.settings.providerInstances.claudeAgent, changed: false });
  assert.deepEqual(rpc.calls.map((c) => c.tag), ["server.getConfig"]);
});

test("pinInstanceHome: unknown instance fails before any write", async () => {
  const { api, rpc } = await makeApi({ replies: { "server.getConfig": await exitValue("ws-getconfig.exit.json"), "server.updateSettings": {} } });
  await assert.rejects(api.pinInstanceHome("ghost", "C:\\h"), /ghost/);
  await assert.rejects(api.pinInstanceHome("bad id", "C:\\h"), Error);
  assert.deepEqual(rpc.calls.map((c) => c.tag), ["server.getConfig"]);
});

test("archive/unarchive dispatch thread.archive / thread.unarchive via orchestration.dispatchCommand", async () => {
  const { api, rpc } = await makeApi({ replies: { "orchestration.dispatchCommand": { sequence: 9 } }, newId: ids("cmd-1", "cmd-2") });
  await api.archiveThread("import:claudeAgent:00000000-0000-4000-8000-000000000011");
  await api.unarchiveThread("import:claudeAgent:00000000-0000-4000-8000-000000000011");
  assert.deepEqual(rpc.calls.map((c) => [c.tag, JSON.stringify(c.payload)]), [
    ["orchestration.dispatchCommand", '{"type":"thread.archive","commandId":"cmd-1","threadId":"import:claudeAgent:00000000-0000-4000-8000-000000000011"}'],
    ["orchestration.dispatchCommand", '{"type":"thread.unarchive","commandId":"cmd-2","threadId":"import:claudeAgent:00000000-0000-4000-8000-000000000011"}'],
  ]);
  const { api: bad } = await makeApi({ replies: { "orchestration.dispatchCommand": { seq: 1 } }, newId: ids("c") });
  await assert.rejects(bad.archiveThread("t"), ShapeError);
});

test("scanSessions / importSessions: tags, payload byte-match, 120 s timeouts, decoded", async () => {
  const rec = await fx("ws-import.request.json");
  const scanReq = await fx("ws-request-scan.json");
  const { api, rpc } = await makeApi({ replies: { "agentSessions.scan": await exitValue("ws-scan.exit.json"), "agentSessions.import": await exitValue("ws-import.exit.json") } });
  const s = await api.scanSessions();
  assert.equal(s.candidates.length, 2);
  assert.deepEqual(await api.importSessions(rec.payload.projectId, rec.payload.expectedWorkspaceRoot), { importedCount: 3, skippedCount: 2 });
  assert.equal(JSON.stringify(rpc.calls[0]!.payload), JSON.stringify(scanReq.payload));
  assert.equal(JSON.stringify(rpc.calls[1]!.payload), JSON.stringify(rec.payload));
  assert.deepEqual(rpc.calls.map((c) => [c.tag, c.timeoutMs]), [["agentSessions.scan", 120_000], ["agentSessions.import", 120_000]]);
});

test("RPC failures propagate unchanged", async () => {
  const { api } = await makeApi({ replies: { "agentSessions.import": new RpcError("agentSessions.import", { _tag: "AgentSessionImportProjectNotFoundError", projectId: "p" }) } });
  await assert.rejects(api.importSessions("p", "C:\\x"), (e: unknown) => e instanceof RpcError && e.errorTag === "AgentSessionImportProjectNotFoundError");
});

test("close(): closes the socket and revokes once, idempotent; revoke failure never throws", async () => {
  let revokes = 0;
  const { api, rpc } = await makeApi({ onClose: async () => { revokes++; } });
  await api.close();
  await api.close();
  assert.equal(rpc.closed, 1);
  assert.equal(revokes, 1);
  const { api: a2 } = await makeApi({ onClose: async () => { throw new Error("revoke failed"); } });
  await a2.close(); // resolves
  // a thrown error in the caller survives a failing close in finally
  const { api: a3 } = await makeApi({ onClose: async () => { throw new Error("revoke failed"); } });
  await assert.rejects((async () => { try { throw new Error("original"); } finally { await a3.close(); } })(), /original/);
});

test("close(): without onNotice a failed revoke writes exactly one line to stderr", async () => {
  const { api } = await makeApi({ onClose: async () => { throw new Error(`revoke failed ${TOKEN}`); } });
  const lines: string[] = [];
  const orig = process.stderr.write;
  (process.stderr as { write: unknown }).write = (chunk: unknown) => { lines.push(String(chunk)); return true; };
  try { await api.close(); await api.close(); } finally { process.stderr.write = orig; }
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.endsWith("\n") && lines[0]!.indexOf("\n") === lines[0]!.length - 1);
  assert.ok(!lines[0]!.includes(TOKEN));
});

// ---------- connectT3 ----------

class FakeTransport implements Transport {
  closed = 0;
  send() {}
  onFrame() {}
  onClose() {}
  close() { this.closed++; }
}

async function tempHome(version = "0.1.9-nightly.20261110.4465") {
  const home = await mkdtemp(join(tmpdir(), "t3sm-api-"));
  await mkdir(join(home, ".t3", "userdata"), { recursive: true });
  await mkdir(join(home, ".t3", "bin"), { recursive: true });
  await writeFile(join(home, ".t3", "bin", process.platform === "win32" ? "t3.cmd" : "t3"), "");
  await writeFile(join(home, ".t3", "userdata", "server-runtime.json"), JSON.stringify({ version: 1, pid: 1, port: 3773, origin: ORIGIN, serverVersion: version }));
  return home;
}

async function connectHarness(o: { envVersion?: string; envProtocol?: number; alive?: boolean; revokeFails?: boolean; transportFails?: boolean } = {}) {
  const home = await tempHome();
  const env = await fx("http-environment.json");
  if (o.envVersion) env.serverVersion = o.envVersion;
  if (o.envProtocol !== undefined) env.orchestrationProtocolVersion = o.envProtocol;
  const ff = fakeFetch({
    "GET /.well-known/t3/environment": () => (o.alive === false ? Promise.reject(new TypeError("ECONNREFUSED")) : json(env)),
    "POST /api/auth/websocket-ticket/rpc": () => json({ ticket: "ticket-abcdefgh-123", expiresAt: "x" }),
  });
  const runs: { args: string[] }[] = [];
  const run = async (_file: string, args: string[], _opts: RunOptions): Promise<RunResult> => {
    runs.push({ args });
    if (args.includes("issue")) return { code: 0, stdout: JSON.stringify({ token: TOKEN, sessionId: "sess-0001-abcdef" }), stderr: "", timedOut: false };
    if (args.includes("revoke")) return o.revokeFails ? { code: 1, stdout: "", stderr: "", timedOut: false } : { code: 0, stdout: "", stderr: "", timedOut: false };
    return { code: 1, stdout: "", stderr: "", timedOut: false };
  };
  const transports: FakeTransport[] = [];
  const urls: string[] = [];
  const transportFactory = async (url: string) => {
    urls.push(url);
    if (o.transportFails) throw new Error("socket refused");
    const t = new FakeTransport();
    transports.push(t);
    return t;
  };
  const cleanup = () => rm(home, { recursive: true, force: true });
  return { home, ff, run, runs, transports, urls, transportFactory, cleanup };
}

test("connectT3: not running -> T3NotRunning, no token issued", async () => {
  const h = await connectHarness({ alive: false });
  try {
    await assert.rejects(connectT3(h.home, { allowUntested: false, fetchImpl: h.ff.fetch, run: h.run, transportFactory: h.transportFactory }), T3NotRunning);
    assert.equal(h.runs.length, 0);
    const empty = await mkdtemp(join(tmpdir(), "t3sm-empty-"));
    await assert.rejects(connectT3(empty, { allowUntested: false, fetchImpl: h.ff.fetch, run: h.run }), T3NotRunning);
    await rm(empty, { recursive: true, force: true });
  } finally { await h.cleanup(); }
});

test("connectT3: tested version connects with least-privilege scopes; close revokes once with the token", async () => {
  const h = await connectHarness();
  try {
    const api = await connectT3(h.home, { allowUntested: false, fetchImpl: h.ff.fetch, run: h.run, transportFactory: h.transportFactory });
    assert.equal(api.version, "0.1.9-nightly.20261110.4465");
    const issue = h.runs.find((r) => r.args.includes("issue"))!;
    assert.ok(!issue.args.includes("providers:manage"));
    assert.ok(!issue.args.includes("settings:write"), "least privilege: no settings:write");
    assert.ok(issue.args.includes("orchestration:read"));
    assert.equal(h.urls.length, 1);
    assert.ok(h.urls[0]!.startsWith("ws://127.0.0.1:3773/ws?orchestrationProtocol=2&wsTicket="));
    const ticketCall = h.ff.calls.find((c) => c.url.endsWith("/api/auth/websocket-ticket/rpc"))!;
    assert.equal(ticketCall.headers.authorization, `Bearer ${TOKEN}`);
    await api.close();
    await api.close();
    assert.equal(h.transports[0]!.closed, 1);
    assert.deepEqual(h.runs.filter((r) => r.args.includes("revoke")).map((r) => r.args.at(-1)), ["sess-0001-abcdef"]);
  } finally { await h.cleanup(); }
});

test("connectT3: manageProviders adds providers:manage", async () => {
  const h = await connectHarness();
  try {
    const api = await connectT3(h.home, { allowUntested: false, manageProviders: true, fetchImpl: h.ff.fetch, run: h.run, transportFactory: h.transportFactory });
    assert.ok(h.runs[0]!.args.includes("providers:manage"));
    await api.close();
  } finally { await h.cleanup(); }
});

test("connectT3: untested version -> T3Incompatible before any token; allowUntested proceeds with a notice", async () => {
  const h = await connectHarness({ envVersion: "0.2.0-nightly.1" });
  try {
    await assert.rejects(connectT3(h.home, { allowUntested: false, fetchImpl: h.ff.fetch, run: h.run, transportFactory: h.transportFactory }), T3Incompatible);
    assert.equal(h.runs.length, 0);
    const notes: string[] = [];
    const api = await connectT3(h.home, { allowUntested: true, onNotice: (l) => notes.push(l), fetchImpl: h.ff.fetch, run: h.run, transportFactory: h.transportFactory });
    assert.equal(notes.length, 1);
    await api.close();
  } finally { await h.cleanup(); }
});

test("connectT3: same-minor proceeds with one notice; protocol != 2 is always incompatible", async () => {
  const h = await connectHarness({ envVersion: "0.1.9-nightly.20261201.9" });
  try {
    const notes: string[] = [];
    const api = await connectT3(h.home, { allowUntested: false, onNotice: (l) => notes.push(l), fetchImpl: h.ff.fetch, run: h.run, transportFactory: h.transportFactory });
    assert.equal(notes.length, 1);
    await api.close();
  } finally { await h.cleanup(); }
  const p = await connectHarness({ envProtocol: 3 });
  try {
    await assert.rejects(connectT3(p.home, { allowUntested: true, fetchImpl: p.ff.fetch, run: p.run, transportFactory: p.transportFactory }), T3Incompatible);
    assert.equal(p.runs.length, 0);
  } finally { await p.cleanup(); }
});

test("connectT3: a changed environment shape is a ShapeError before any token", async () => {
  const h = await connectHarness();
  try {
    const ff = fakeFetch({ "GET /.well-known/t3/environment": () => json({ serverVersion: 19 }) });
    await assert.rejects(connectT3(h.home, { allowUntested: true, fetchImpl: ff.fetch, run: h.run, transportFactory: h.transportFactory }), ShapeError);
    assert.equal(h.runs.length, 0);
  } finally { await h.cleanup(); }
});

test("connectT3: a failed connect revokes the session; a failing revoke never masks the original error", async () => {
  const h = await connectHarness({ transportFails: true, revokeFails: true });
  try {
    await assert.rejects(connectT3(h.home, { allowUntested: false, fetchImpl: h.ff.fetch, run: h.run, transportFactory: h.transportFactory }), /socket refused/);
    assert.equal(h.runs.filter((r) => r.args.includes("revoke")).length, 1);
  } finally { await h.cleanup(); }
});

test("updateInstanceAppearance: explicit entry -> upsert of the FULL entry with only displayName/accentColor changed", async () => {
  const cfg = await exitValue("ws-getconfig-instances.exit.json");
  const before = structuredClone(cfg.settings.providerInstances["claude-org"]);
  const { api, rpc } = await makeApi({ replies: { "server.getConfig": cfg, "server.updateSettings": (p: any) => ({ providerInstances: { [p.providerInstanceMutation.instanceId]: p.providerInstanceMutation.instance } }) } });
  const r = await api.updateInstanceAppearance("claude-org", { displayName: "Claude · Trabalho", accentColor: "#112233" });
  assert.deepEqual(r, { previous: before, changed: true });
  const sent = (rpc.calls[1]!.payload as any).providerInstanceMutation;
  assert.equal(sent.operation, "upsert");
  assert.deepEqual(sent.instance, { ...before, displayName: "Claude · Trabalho", accentColor: "#112233" });
});

test("updateInstanceAppearance: nothing to change -> no write; bad color / unknown id rejected before any write", async () => {
  const cfg = await exitValue("ws-getconfig-instances.exit.json");
  const cur = cfg.settings.providerInstances["claude-org"];
  const { api, rpc } = await makeApi({ replies: { "server.getConfig": cfg, "server.updateSettings": {} } });
  assert.equal((await api.updateInstanceAppearance("claude-org", { displayName: cur.displayName })).changed, false);
  await assert.rejects(api.updateInstanceAppearance("claude-org", { accentColor: "red" }), /#RRGGBB/);
  await assert.rejects(api.updateInstanceAppearance("ghost", { displayName: "x" }), /ghost/);
  assert.ok(rpc.calls.every((c) => c.tag === "server.getConfig"));
});

test("updateInstanceAppearance: implicit claudeAgent is pinned to its home in the same upsert", async () => {
  const cfg = await exitValue("ws-getconfig.exit.json");
  assert.equal(Object.keys(cfg.settings.providerInstances).length, 0);
  const { api, rpc } = await makeApi({ replies: { "server.getConfig": cfg, "server.updateSettings": (p: any) => ({ providerInstances: { [p.providerInstanceMutation.instanceId]: p.providerInstanceMutation.instance } }) } });
  const home = (await api.providerInstances()).find((i) => i.instanceId === "claudeAgent")!.homePath!;
  const r = await api.updateInstanceAppearance("claudeAgent", { displayName: "Claude · Pessoal" });
  assert.deepEqual(r, { previous: null, changed: true });
  const sent = (rpc.calls.find((c) => c.tag === "server.updateSettings")!.payload as any).providerInstanceMutation;
  assert.equal(sent.operation, "upsert");
  assert.equal(JSON.stringify(sent.instance), JSON.stringify({ driver: "claudeAgent", config: { homePath: home.replaceAll("/", "\\") }, displayName: "Claude · Pessoal" }));
});
