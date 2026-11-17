import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  decodeEnvironment, decodeProjects, decodeProject, decodeShell, decodeConfig, decodeServerSettings,
  decodeScan, decodeImport, decodeDispatch, decodeArchivedShell,
} from "../../src/t3/decode.ts";
import { ShapeError } from "../../src/t3/errors.ts";

const fx = async (n: string) => JSON.parse(await readFile(new URL(`../fixtures/t3-wire/${n}`, import.meta.url), "utf8"));
const exitValue = async (n: string) => (await fx(n)).exit.value;

type Seg = string | number;
/** Deep-cloned copy of `o` with the value at `path` removed (`op` = undefined) or replaced. */
function mutate(o: unknown, path: Seg[], op: { remove: true } | { set: unknown }): unknown {
  const c = structuredClone(o) as Record<string | number, unknown>;
  let cur = c as Record<string | number, unknown>;
  for (const s of path.slice(0, -1)) cur = cur[s] as Record<string | number, unknown>;
  const last = path[path.length - 1]!;
  if ("remove" in op) delete cur[last];
  else cur[last] = op.set;
  return c;
}

function expectShape(fn: () => unknown, endpoint: string, path: string) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof ShapeError, `expected ShapeError, got ${String(e)}`);
    assert.equal(e.endpoint, endpoint);
    assert.equal(e.path, path);
    assert.equal(typeof e.expected, "string");
    assert.ok(e.message.includes(path));
    return true;
  });
}

test("environment: accepts the fixture, rejects removed or retyped fields", async () => {
  const env = await fx("http-environment.json");
  assert.deepEqual(decodeEnvironment(env), { serverVersion: "0.1.9-nightly.20261110.4465", orchestrationProtocolVersion: 2 });
  const ep = "GET /.well-known/t3/environment";
  expectShape(() => decodeEnvironment(mutate(env, ["serverVersion"], { remove: true })), ep, "$.serverVersion");
  expectShape(() => decodeEnvironment(mutate(env, ["orchestrationProtocolVersion"], { set: "2" })), ep, "$.orchestrationProtocolVersion");
  expectShape(() => decodeEnvironment(null), ep, "$");
});

test("projects: accepts the fixture (extra fields allowed), rejects missing/retyped required fields", async () => {
  const body = await fx("http-projects.json");
  const ps = decodeProjects(body);
  assert.deepEqual(ps, [{ id: "00000000-0000-4000-8000-000000000002", title: "Demo project demo-1", workspaceRoot: "D:\\work\\demo-1", defaultModelSelection: null, archived: false, deleted: false, pinned: false, createdAt: "2026-04-21T09:00:38.013Z" }]);
  const flagged = decodeProjects(mutate(mutate(body, ["projects", 0, "archivedAt"], { set: "2026-11-01T00:00:00.000Z" }), ["projects", 0, "deletedAt"], { set: "2026-11-02T00:00:00.000Z" }))[0]!;
  assert.deepEqual([flagged.archived, flagged.deleted], [true, true]);
  const ep = "GET /api/projects";
  expectShape(() => decodeProjects(mutate(body, ["projects", 0, "workspaceRoot"], { remove: true })), ep, "$.projects[0].workspaceRoot");
  expectShape(() => decodeProjects(mutate(body, ["projects", 0, "id"], { set: 2 })), ep, "$.projects[0].id");
  expectShape(() => decodeProjects(mutate(body, ["projects"], { set: {} })), ep, "$.projects");
  expectShape(() => decodeProjects(mutate(body, ["projects", 0, "defaultModelSelection"], { remove: true })), ep, "$.projects[0].defaultModelSelection");
  expectShape(() => decodeProjects(mutate(body, ["projects", 0, "defaultModelSelection"], { set: "claudeAgent" })), ep, "$.projects[0].defaultModelSelection");
  expectShape(() => decodeProjects(mutate(body, ["projects", 0, "defaultModelSelection"], { set: { instanceId: "claudeAgent" } })), ep, "$.projects[0].defaultModelSelection.model");
  // a model selection survives untouched (no coercion), extra field included
  const sel = { instanceId: "claudeAgent", model: "claude-opus-4-6", options: [{ id: "effort", value: "high" }] };
  assert.deepEqual(decodeProjects(mutate(body, ["projects", 0, "defaultModelSelection"], { set: sel }))[0]!.defaultModelSelection, sel);
  const legacy = { provider: "claudeAgent", model: "claude-opus-4-6" };
  assert.deepEqual(decodeProjects(mutate(body, ["projects", 0, "defaultModelSelection"], { set: legacy }))[0]!.defaultModelSelection, legacy);
  assert.equal(decodeProjects(mutate(body, ["projects", 0, "futureField"], { set: 1 })).length, 1);
  expectShape(() => decodeProjects(mutate(body, ["projects", 0, "deletedAt"], { set: 0 })), ep, "$.projects[0].deletedAt");
  expectShape(() => decodeProjects(mutate(body, ["projects", 0, "archivedAt"], { set: false })), ep, "$.projects[0].archivedAt");
});

test("project (mutate response): accepts the fixture, rejects a missing id", async () => {
  const body = await fx("http-project-mutate.response.json");
  assert.equal(decodeProject(body, "POST /api/projects/mutate").workspaceRoot, "D:\\work\\demo-3");
  expectShape(() => decodeProject(mutate(body, ["id"], { remove: true }), "POST /api/projects/mutate"), "POST /api/projects/mutate", "$.id");
  expectShape(() => decodeProject(mutate(body, ["title"], { set: null }), "POST /api/projects/mutate"), "POST /api/projects/mutate", "$.title");
});

test("shell: accepts both fixtures; archived threads come from archivedThreads or archivedAt", async () => {
  const body = await fx("http-orchestration-shell.json");
  assert.deepEqual(decodeShell(body), [{
    id: "00000000-0000-4000-8000-000000000003", projectId: "00000000-0000-4000-8000-000000000002",
    instanceId: "claudeAgent", archived: false, title: "Demo thread title", nativeSessionId: null, latestUserMessageAt: "2026-04-21T09:06:52.292Z",
    settledOverride: "settled", settledAt: "2026-04-21T09:06:52.292Z", unsettledAt: null, pinnedAt: null,
    latestRunRequestedAt: null, latestRunStartedAt: null, latestRunCompletedAt: null, createdAt: "2026-04-21T09:00:38.042Z",
    titleRegeneration: null,
  }]);
  const imported = decodeShell(await fx("http-orchestration-shell-imported.json"));
  assert.equal(imported.length, 3);
  assert.ok(imported.every((t) => t.id.startsWith("import:claudeAgent:") && t.instanceId === "claudeAgent" && !t.archived));
  // activeProviderThreadId "provider-thread:...:native-thread:<sessionId>" names the native session behind the thread
  assert.ok(imported.every((t) => t.nativeSessionId === t.id.slice("import:claudeAgent:".length)));
  assert.equal(decodeShell(mutate(body, ["threads", 0, "activeProviderThreadId"], { remove: true }))[0]!.nativeSessionId, null, "absent field tolerated");
  assert.equal(decodeShell(mutate(body, ["threads", 0, "activeProviderThreadId"], { set: "something-else" }))[0]!.nativeSessionId, null);
  expectShape(() => decodeShell(mutate(body, ["threads", 0, "activeProviderThreadId"], { set: 5 })), "GET /api/orchestration/shell", "$.threads[0].activeProviderThreadId");

  const archived = structuredClone(body);
  archived.archivedThreads = [{ ...archived.threads[0], id: "t-arch", archivedAt: "2026-11-10T00:00:00.000Z" }];
  archived.threads[0].archivedAt = "2026-11-10T00:00:00.000Z";
  assert.deepEqual(decodeShell(archived).map((t) => [t.id, t.archived]), [["00000000-0000-4000-8000-000000000003", true], ["t-arch", true]]);

  const ep = "GET /api/orchestration/shell";
  // ProviderInstanceId is never null in OrchestrationV2ThreadShell
  expectShape(() => decodeShell(mutate(body, ["threads", 0, "providerInstanceId"], { set: null })), ep, "$.threads[0].providerInstanceId");
  expectShape(() => decodeShell(mutate(body, ["threads", 0, "projectId"], { remove: true })), ep, "$.threads[0].projectId");
  expectShape(() => decodeShell(mutate(body, ["threads", 0, "title"], { set: 7 })), ep, "$.threads[0].title");
  expectShape(() => decodeShell(mutate(body, ["threads", 0, "archivedAt"], { set: 5 })), ep, "$.threads[0].archivedAt");
  expectShape(() => decodeShell(mutate(body, ["threads", 0, "providerInstanceId"], { remove: true })), ep, "$.threads[0].providerInstanceId");
  expectShape(() => decodeShell(mutate(body, ["archivedThreads"], { set: null })), ep, "$.archivedThreads");
  expectShape(() => decodeShell(mutate(body, ["schemaVersion"], { set: 3 })), ep, "$.schemaVersion");
  expectShape(() => decodeShell(mutate(body, ["threads"], { remove: true })), ep, "$.threads");
});

test("shell: titleRegeneration and lastTitleRegeneration (T3 Code's own title writer) are decoded when present, strictly", async () => {
  const body = await fx("http-orchestration-shell.json");
  const ep = "GET /api/orchestration/shell";
  assert.equal(decodeShell(body)[0]!.titleRegeneration, null, "the fixture: none in progress");
  const plain = decodeShell(mutate(body, ["threads", 0, "titleRegeneration"], { remove: true }))[0]!;
  assert.equal("titleRegeneration" in plain, false, "absent: no key");
  assert.equal("lastTitleRegeneration" in plain, false);
  const pending = { requestId: "00000000-0000-4000-8000-00000000aa01", startedAt: "2026-11-14T12:00:00.000Z" };
  assert.deepEqual(decodeShell(mutate(body, ["threads", 0, "titleRegeneration"], { set: pending }))[0]!.titleRegeneration, pending);
  assert.equal(decodeShell(mutate(body, ["threads", 0, "titleRegeneration"], { set: null }))[0]!.titleRegeneration, null);
  const last = { requestId: "00000000-0000-4000-8000-00000000aa01", status: "renamed", completedAt: "2026-11-14T12:00:05.000Z" };
  assert.deepEqual(decodeShell(mutate(body, ["threads", 0, "lastTitleRegeneration"], { set: { ...last, message: "x" } }))[0]!.lastTitleRegeneration, last);
  for (const status of ["unchanged", "failed"]) {
    assert.equal(decodeShell(mutate(body, ["threads", 0, "lastTitleRegeneration"], { set: { ...last, status } }))[0]!.lastTitleRegeneration?.status, status);
  }
  // A status a newer T3 Code added: "unknown", never a renamed title t3sm would record.
  assert.equal(decodeShell(mutate(body, ["threads", 0, "lastTitleRegeneration"], { set: { ...last, status: "queued" } }))[0]!.lastTitleRegeneration?.status, "unknown");
  expectShape(() => decodeShell(mutate(body, ["threads", 0, "titleRegeneration"], { set: "yes" })), ep, "$.threads[0].titleRegeneration");
  expectShape(() => decodeShell(mutate(body, ["threads", 0, "titleRegeneration"], { set: { startedAt: pending.startedAt } })), ep, "$.threads[0].titleRegeneration.requestId");
  expectShape(() => decodeShell(mutate(body, ["threads", 0, "lastTitleRegeneration"], { set: { ...last, requestId: 5 } })), ep, "$.threads[0].lastTitleRegeneration.requestId");
  expectShape(() => decodeShell(mutate(body, ["threads", 0, "lastTitleRegeneration"], { set: { requestId: last.requestId, completedAt: last.completedAt } })), ep, "$.threads[0].lastTitleRegeneration.status");
});

test("getConfig: textGenerationModelSelection (the model T3 Code writes titles with) is decoded when present", async () => {
  const v = await exitValue("ws-getconfig-unavailable.synthetic.json");
  const ep = "server.getConfig";
  assert.equal("textGenerationModelSelection" in decodeConfig(v).settings, false);
  const sel = { instanceId: "claudeAgent", model: "claude-haiku-4-5" };
  assert.deepEqual(decodeConfig(mutate(v, ["settings", "textGenerationModelSelection"], { set: sel })).settings.textGenerationModelSelection, sel);
  assert.equal(decodeConfig(mutate(v, ["settings", "textGenerationModelSelection"], { set: null })).settings.textGenerationModelSelection, null);
  expectShape(() => decodeConfig(mutate(v, ["settings", "textGenerationModelSelection"], { set: "haiku" })), ep, "$.settings.textGenerationModelSelection");
  expectShape(() => decodeConfig(mutate(v, ["settings", "textGenerationModelSelection"], { set: { instanceId: "x" } })), ep, "$.settings.textGenerationModelSelection.model");
});

test("archived shell snapshot: every thread archived; strict on shape", async () => {
  const shell = await fx("http-orchestration-shell-imported.json");
  const snap = { schemaVersion: 2, snapshotSequence: 441, projects: shell.projects, threads: shell.threads.slice(0, 2) };
  const ts = decodeArchivedShell(snap);
  assert.deepEqual(ts.map((t) => [t.id, t.archived, t.instanceId]), [
    ["import:claudeAgent:00000000-0000-4000-8000-000000000012", true, "claudeAgent"],
    ["import:claudeAgent:00000000-0000-4000-8000-000000000013", true, "claudeAgent"],
  ]);
  assert.deepEqual(decodeArchivedShell({ ...snap, threads: [] }), []);
  const ep = "orchestration.getArchivedShellSnapshot";
  expectShape(() => decodeArchivedShell(mutate(snap, ["threads"], { remove: true })), ep, "$.threads");
  expectShape(() => decodeArchivedShell(mutate(snap, ["snapshotSequence"], { set: "441" })), ep, "$.snapshotSequence");
  expectShape(() => decodeArchivedShell(mutate(snap, ["schemaVersion"], { set: 3 })), ep, "$.schemaVersion");
  expectShape(() => decodeArchivedShell(mutate(snap, ["threads", 1, "id"], { set: 5 })), ep, "$.threads[1].id");
});

test("getConfig: unavailable instances, missing continuation/displayName and runtimePaths are valid states", async () => {
  const v = await exitValue("ws-getconfig-unavailable.synthetic.json");
  const cfg = decodeConfig(v);
  const gone = cfg.providers.find((p) => p.instanceId === "claude-gone")!;
  assert.deepEqual([gone.availability, gone.continuation, gone.auth.status, gone.auth.email, gone.models], ["unavailable", null, "unknown", null, []]);
  const rt = cfg.providers.find((p) => p.instanceId === "claude-rt")!;
  assert.deepEqual([rt.displayName, rt.continuation, rt.runtimeHomePath, rt.availability], [null, null, "C:\\Users\\demo\\.claude-rt", "available"]);
  assert.equal(cfg.providers[0]!.availability, "available");
  const ep = "server.getConfig";
  const gi = v.providers.findIndex((p: { instanceId: string }) => p.instanceId === "claude-gone");
  const ri = v.providers.findIndex((p: { instanceId: string }) => p.instanceId === "claude-rt");
  expectShape(() => decodeConfig(mutate(v, ["providers", gi, "availability"], { set: "gone" })), ep, `$.providers[${gi}].availability`);
  expectShape(() => decodeConfig(mutate(v, ["providers", gi, "auth"], { remove: true })), ep, `$.providers[${gi}].auth`);
  expectShape(() => decodeConfig(mutate(v, ["providers", ri, "runtimePaths", "homePath"], { set: 1 })), ep, `$.providers[${ri}].runtimePaths.homePath`);
  expectShape(() => decodeConfig(mutate(v, ["providers", ri, "displayName"], { set: 1 })), ep, `$.providers[${ri}].displayName`);
});

test("getConfig: accepts both fixtures, keeps raw settings entries, rejects removed/retyped fields", async () => {
  const v = await exitValue("ws-getconfig.exit.json");
  const cfg = decodeConfig(v);
  assert.deepEqual(cfg.settings.providerInstances, {});
  assert.deepEqual(cfg.settings.defaultModelSelection, { instanceId: "claudeAgent", model: "claude-opus-5-5" });
  assert.deepEqual(cfg.providers.map((p) => [p.instanceId, p.driver, p.continuation?.groupKey, p.auth?.status, p.auth?.email]), [
    ["codex", "codex", "codex:home:C:\\Users\\demo\\.codex", "authenticated", "user@example.com"],
    ["claudeAgent", "claudeAgent", "claude:home:C:\\Users\\demo\\.claude-alt", "authenticated", "user@example.com"],
  ]);
  assert.deepEqual(cfg.providers[1]!.models.map((m) => [m.slug, m.isDefault]), [["claude-opus-5-5", true]]);

  const vi = await exitValue("ws-getconfig-instances.exit.json");
  const ci = decodeConfig(vi);
  assert.deepEqual(ci.settings.providerInstances, vi.settings.providerInstances); // raw entries, nothing dropped
  assert.equal(ci.settings.defaultModelSelection, undefined);

  const ep = "server.getConfig";
  assert.equal(decodeConfig(mutate(v, ["providers", 1, "continuation"], { remove: true })).providers[1]!.continuation, null);
  expectShape(() => decodeConfig(mutate(v, ["providers", 1, "continuation"], { set: "claude:home:x" })), ep, "$.providers[1].continuation");
  expectShape(() => decodeConfig(mutate(v, ["providers", 1, "continuation", "groupKey"], { remove: true })), ep, "$.providers[1].continuation.groupKey");
  expectShape(() => decodeConfig(mutate(v, ["providers", 1, "auth", "status"], { set: 1 })), ep, "$.providers[1].auth.status");
  expectShape(() => decodeConfig(mutate(v, ["providers", 0, "enabled"], { set: "true" })), ep, "$.providers[0].enabled");
  expectShape(() => decodeConfig(mutate(v, ["providers", 1, "models", 0, "slug"], { remove: true })), ep, "$.providers[1].models[0].slug");
  expectShape(() => decodeConfig(mutate(v, ["providers"], { remove: true })), ep, "$.providers");
  expectShape(() => decodeConfig(mutate(v, ["settings", "providerInstances"], { set: [] })), ep, "$.settings.providerInstances");
  expectShape(() => decodeConfig(mutate(vi, ["settings", "providerInstances", "claude-org", "driver"], { remove: true })), ep, '$.settings.providerInstances["claude-org"].driver');
  expectShape(() => decodeConfig(mutate(vi, ["settings", "providerInstances", "claudeAgent", "environment"], { set: { A: "b" } })), ep, "$.settings.providerInstances.claudeAgent.environment");
  expectShape(() => decodeConfig(mutate(vi, ["providers", 1, "accentColor"], { set: 7 })), ep, "$.providers[1].accentColor");
});

test("updateSettings response: accepts the fixture, rejects a broken entry", async () => {
  const v = await exitValue("ws-updatesettings.exit.json");
  assert.deepEqual(Object.keys(decodeServerSettings(v).providerInstances), ["claude-org"]);
  const ep = "server.updateSettings";
  expectShape(() => decodeServerSettings(mutate(v, ["providerInstances", "claude-org", "driver"], { remove: true })), ep, '$.providerInstances["claude-org"].driver');
  expectShape(() => decodeServerSettings(mutate(v, ["providerInstances"], { remove: true })), ep, "$.providerInstances");
});

test("scan: accepts the fixture, rejects retyped fields", async () => {
  const v = await exitValue("ws-scan.exit.json");
  const s = decodeScan(v);
  assert.equal(s.candidates.length, 2);
  assert.equal(s.truncated, true);
  assert.equal(s.candidates[0]!.projectId, "00000000-0000-4000-8000-000000000002");
  assert.equal(s.candidates[1]!.projectId, null);
  assert.equal(decodeScan(mutate(v, ["truncated"], { remove: true })).truncated, false);
  const ep = "agentSessions.scan";
  expectShape(() => decodeScan(mutate(v, ["candidates", 1, "alreadyImported"], { set: "false" })), ep, "$.candidates[1].alreadyImported");
  expectShape(() => decodeScan(mutate(v, ["scannedAt"], { remove: true })), ep, "$.scannedAt");
  expectShape(() => decodeScan(mutate(v, ["candidates", 0, "sources", 0], { set: 1 })), ep, "$.candidates[0].sources[0]");
  expectShape(() => decodeScan(mutate(v, ["candidates", 0, "path"], { remove: true })), ep, "$.candidates[0].path");
});

test("import: accepts the fixture, rejects negative/stringly counts", async () => {
  const v = await exitValue("ws-import.exit.json");
  assert.deepEqual(decodeImport(v), { importedCount: 3, skippedCount: 2 });
  const ep = "agentSessions.import";
  expectShape(() => decodeImport(mutate(v, ["importedCount"], { set: -1 })), ep, "$.importedCount");
  expectShape(() => decodeImport(mutate(v, ["importedCount"], { set: "3" })), ep, "$.importedCount");
  expectShape(() => decodeImport(mutate(v, ["skippedCount"], { remove: true })), ep, "$.skippedCount");
  expectShape(() => decodeImport(mutate(v, ["skippedCount"], { set: 1.5 })), ep, "$.skippedCount");
});

test("dispatchCommand: {sequence} only", () => {
  assert.deepEqual(decodeDispatch({ sequence: 412 }), { sequence: 412 });
  expectShape(() => decodeDispatch({}), "orchestration.dispatchCommand", "$.sequence");
  expectShape(() => decodeDispatch({ sequence: "412" }), "orchestration.dispatchCommand", "$.sequence");
});

test("ShapeError message never carries the offending value", async () => {
  const body = await fx("http-projects.json");
  try {
    decodeProjects(mutate(body, ["projects", 0, "id"], { set: { secret: "eyJ2Ijox-super-secret-token-value" } }));
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof ShapeError);
    assert.ok(!e.message.includes("super-secret"));
  }
});

test("project: pinned/createdAt come from pinnedAt/createdAt; absent -> false/null; wrong type -> ShapeError", async () => {
  const body = await fx("http-projects-pinned.json");
  const ps = decodeProjects(body);
  assert.deepEqual(ps.map((p) => [p.title, p.pinned, p.createdAt]), [
    ["Demo A", true, "2026-10-01T09:00:00.000Z"], ["Demo B", false, "2026-10-02T09:00:00.000Z"], ["Demo C", false, "2026-10-03T09:00:00.000Z"],
  ]);
  const old = mutate(mutate(body, ["projects", 0, "pinnedAt"], { remove: true }), ["projects", 0, "createdAt"], { remove: true });
  assert.deepEqual([decodeProjects(old)[0]!.pinned, decodeProjects(old)[0]!.createdAt], [false, null]);
  const ep = "GET /api/projects";
  expectShape(() => decodeProjects(mutate(body, ["projects", 0, "pinnedAt"], { set: true })), ep, "$.projects[0].pinnedAt");
  expectShape(() => decodeProjects(mutate(body, ["projects", 0, "createdAt"], { set: 3 })), ep, "$.projects[0].createdAt");
  assert.equal(decodeProject(mutate(body.projects[0], ["pinnedAt"], { set: "2026-11-12T10:00:00.000Z" })).pinned, true);
});

test("thread: settle/pin fields decode from the shell; absent -> null; wrong type -> ShapeError", async () => {
  const shell = await fx("http-orchestration-shell-imported.json");
  const t0 = decodeShell(shell)[0]!;
  assert.deepEqual([t0.settledOverride, t0.settledAt, t0.unsettledAt, t0.pinnedAt], ["settled", "2026-11-10T15:59:55.122Z", null, null]);
  const active = mutate(mutate(shell, ["threads", 0, "settledOverride"], { set: "active" }), ["threads", 0, "unsettledAt"], { set: "2026-11-11T00:00:00.000Z" });
  const a = decodeShell(active)[0]!;
  assert.deepEqual([a.settledOverride, a.unsettledAt], ["active", "2026-11-11T00:00:00.000Z"]);
  const none = decodeShell(mutate(mutate(mutate(shell, ["threads", 0, "settledOverride"], { remove: true }), ["threads", 0, "settledAt"], { remove: true }), ["threads", 0, "pinnedAt"], { remove: true }))[0]!;
  assert.deepEqual([none.settledOverride, none.settledAt, none.pinnedAt], [null, null, null]);
  const ep = "GET /api/orchestration/shell";
  // A newer T3 Code may add override values: decoded as "unknown" (organize leaves that thread alone), never a stop.
  assert.equal(decodeShell(mutate(shell, ["threads", 0, "settledOverride"], { set: "snoozed-forever" }))[0]!.settledOverride, "unknown");
  assert.equal(decodeArchivedShell({ schemaVersion: 2, snapshotSequence: 1, threads: [(mutate(shell, ["threads", 0, "settledOverride"], { set: "snoozed-forever" }) as { threads: unknown[] }).threads[0]] })[0]!.settledOverride, "unknown");
  expectShape(() => decodeShell(mutate(shell, ["threads", 0, "settledOverride"], { set: 3 })), ep, "$.threads[0].settledOverride");
  expectShape(() => decodeShell(mutate(shell, ["threads", 0, "settledAt"], { set: 1 })), ep, "$.threads[0].settledAt");
  expectShape(() => decodeShell(mutate(shell, ["threads", 0, "unsettledAt"], { set: false })), ep, "$.threads[0].unsettledAt");
  expectShape(() => decodeShell(mutate(shell, ["threads", 0, "pinnedAt"], { set: 1 })), ep, "$.threads[0].pinnedAt");
});

test("sidebarAutoSettleAfterDays: read from getConfig and updateSettings; integer 1..90 or null; absent stays undefined", async () => {
  const cfg = (await fx("ws-getconfig.exit.json")).exit.value;
  assert.equal(decodeConfig(cfg).settings.sidebarAutoSettleAfterDays, 7);
  assert.equal(decodeConfig(mutate(cfg, ["settings", "sidebarAutoSettleAfterDays"], { set: null })).settings.sidebarAutoSettleAfterDays, null);
  assert.equal(decodeConfig(mutate(cfg, ["settings", "sidebarAutoSettleAfterDays"], { remove: true })).settings.sidebarAutoSettleAfterDays, undefined);
  for (const bad of ["7", 1.5]) {
    expectShape(() => decodeConfig(mutate(cfg, ["settings", "sidebarAutoSettleAfterDays"], { set: bad })), "server.getConfig", "$.settings.sidebarAutoSettleAfterDays");
  }
  // An integer outside 1..90 (a newer T3 Code's range): no value, flagged, never a stop for the other commands.
  for (const future of [120, 0]) {
    const s = decodeConfig(mutate(cfg, ["settings", "sidebarAutoSettleAfterDays"], { set: future })).settings;
    assert.equal(s.sidebarAutoSettleAfterDays, undefined, String(future));
    assert.equal(s.sidebarAutoSettleUnknown, true, String(future));
  }
  assert.equal(decodeConfig(cfg).settings.sidebarAutoSettleUnknown, undefined);
  const upd = (await fx("ws-updatesettings.exit.json")).exit.value;
  assert.equal(decodeServerSettings(upd).sidebarAutoSettleAfterDays, 7);
  const later = decodeServerSettings(mutate(upd, ["sidebarAutoSettleAfterDays"], { set: 120 }));
  assert.deepEqual([later.sidebarAutoSettleAfterDays, later.sidebarAutoSettleUnknown, typeof later.providerInstances], [undefined, true, "object"]);
  expectShape(() => decodeServerSettings(mutate(upd, ["sidebarAutoSettleAfterDays"], { set: "x" })), "server.updateSettings", "$.sidebarAutoSettleAfterDays");
});

test("thread: pending:run:thread:<id>:ordinal:1 gives no nativeSessionId", async () => {
  const shell = await fx("http-orchestration-shell-imported.json");
  const pending = mutate(shell, ["threads", 0, "activeProviderThreadId"], { set: "pending:run:thread:x:ordinal:1" });
  assert.equal(decodeShell(pending)[0]!.nativeSessionId, null);
});

test("thread: latestRun* timestamps and createdAt decode when present; absent fields are undefined; wrong type -> ShapeError", async () => {
  const shell = await fx("http-orchestration-shell-imported.json");
  const ep = "GET /api/orchestration/shell";
  const t0 = decodeShell(shell)[0]!;
  assert.deepEqual([t0.latestRunRequestedAt, t0.latestRunStartedAt, t0.latestRunCompletedAt, t0.createdAt], [null, null, null, "2026-09-10T15:59:29.081Z"]);
  let m: unknown = mutate(shell, ["threads", 0, "latestRunRequestedAt"], { set: "2026-11-11T10:00:00.000Z" });
  m = mutate(m, ["threads", 0, "latestRunStartedAt"], { set: "2026-11-11T10:00:01.000Z" });
  m = mutate(m, ["threads", 0, "latestRunCompletedAt"], { set: "2026-11-11T10:00:09.000Z" });
  const t = decodeShell(m)[0]!;
  assert.deepEqual([t.latestRunRequestedAt, t.latestRunStartedAt, t.latestRunCompletedAt], ["2026-11-11T10:00:00.000Z", "2026-11-11T10:00:01.000Z", "2026-11-11T10:00:09.000Z"]);
  let gone: unknown = shell;
  for (const k of ["latestRunRequestedAt", "latestRunStartedAt", "latestRunCompletedAt", "createdAt"]) gone = mutate(gone, ["threads", 0, k], { remove: true });
  const g = decodeShell(gone)[0]!;
  assert.deepEqual([g.latestRunRequestedAt, g.latestRunStartedAt, g.latestRunCompletedAt, g.createdAt], [undefined, undefined, undefined, undefined]);
  for (const k of ["latestRunRequestedAt", "latestRunStartedAt", "latestRunCompletedAt", "createdAt"]) {
    expectShape(() => decodeShell(mutate(shell, ["threads", 0, k], { set: 1 })), ep, `$.threads[0].${k}`);
  }
});

test("thread lists in pages are refused: t3sm reads them as complete (an orphan copy relies on it)", async () => {
  const shell = await fx("http-orchestration-shell.json");
  const snap = { schemaVersion: 2, snapshotSequence: 441, projects: shell.projects, threads: shell.threads };
  for (const [key, value] of [["hasMore", true], ["nextCursor", "c-2"], ["nextPageToken", "p-2"], ["truncated", true], ["pageInfo", { endCursor: "c-2" }]] as const) {
    expectShape(() => decodeShell({ ...shell, [key]: value }), "GET /api/orchestration/shell", `$.${key}`);
    expectShape(() => decodeArchivedShell({ ...snap, [key]: value }), "orchestration.getArchivedShellSnapshot", `$.${key}`);
  }
  // Absent, null or false: one complete page, as today.
  for (const value of [null, false]) {
    assert.equal(decodeShell({ ...shell, hasMore: value, nextCursor: null }).length, 1);
    assert.equal(decodeArchivedShell({ ...snap, truncated: value }).length, 1);
  }
});
