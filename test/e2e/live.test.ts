import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { readServerRuntime, probeServer, resolveT3Cli } from "../../src/t3/runtime.ts";
import { issueSessionToken, mintWsTicket, revokeSession } from "../../src/t3/auth.ts";
import { RpcClient, buildWsUrl, webSocketTransport } from "../../src/t3/rpc.ts";

// Read-only: server.getConfig + agentSessions.scan against the live local T3Code.
test("live T3Code: getConfig + scan (T3_E2E=1)", { skip: process.env.T3_E2E !== "1", timeout: 180_000 }, async () => {
  const home = homedir();
  const rt = await readServerRuntime(home);
  assert.ok(rt, "server-runtime.json present");
  assert.equal(await probeServer(rt), true, "T3Code answers /.well-known/t3/environment");
  const cli = resolveT3Cli(home, process.platform, process.env.PATH ?? "");
  assert.ok(cli, "t3 cli found");
  const step = async <T,>(name: string, f: () => Promise<T>): Promise<T> => { const t0 = Date.now(); try { return await f(); } finally { console.log(`live: ${name} ${Date.now() - t0} ms`); } };
  const { token, sessionId } = await step("issue token", () => issueSessionToken(cli));
  try {
    const ticket = await step("mint ticket", () => mintWsTicket(rt.origin, token));
    const client = new RpcClient(await step("ws connect", () => webSocketTransport(buildWsUrl(rt.origin, ticket))));
    try {
      const cfg = await step("getConfig", () => client.call("server.getConfig", {}, (u) => u as { providers: unknown[] }));
      assert.ok(Array.isArray(cfg.providers));
      const scan = await step("scan", () => client.call("agentSessions.scan", {}, (u) => u as { candidates: unknown[] }));
      assert.ok(Array.isArray(scan.candidates));
      console.log(`live: providers=${cfg.providers.length} candidates=${scan.candidates.length}`);
    } finally { client.close(); }
  } finally { await step("revoke session", () => revokeSession(cli, sessionId, undefined, token)); }
});

// Read-only through the typed API: getConfig, providerInstances, listProjects, listThreads, scanSessions, then close()
// must revoke the bearer session exactly once. Skips when T3Code is not running.
test("live T3Code: typed API reads + close() revokes (T3_E2E=1)", { skip: process.env.T3_E2E !== "1", timeout: 240_000 }, async (t) => {
  const { connectT3 } = await import("../../src/t3/api.ts");
  const { isT3Running } = await import("../../src/t3/runtime.ts");
  const { defaultRunner } = await import("../../src/t3/auth.ts");
  const home = homedir();
  if (!(await isT3Running(home))) { t.skip("T3Code is not running"); return; }
  const revokes: (number | null)[] = [];
  const run: typeof defaultRunner = async (file, args, opts) => {
    const r = await defaultRunner(file, args, opts);
    if (args.includes("revoke")) revokes.push(r.code);
    return r;
  };
  const api = await connectT3(home, { allowUntested: false, run, onNotice: (l) => console.log(`live notice: ${l}`) });
  try {
    console.log(`live: T3Code ${api.version}`);
    const cfg = await api.getConfig();
    assert.ok(cfg.providers.length > 0);
    const inst = await api.providerInstances();
    assert.ok(inst.some((i) => i.driver === "claudeAgent" && i.homePath !== null));
    const projects = await api.listProjects();
    const threads = await api.listThreads();
    const scan = await api.scanSessions();
    console.log(`live: instances=${inst.length} projects=${projects.length} threads=${threads.length} candidates=${scan.candidates.length}`);
  } finally {
    await api.close();
    await api.close();
  }
  assert.deepEqual(revokes, [0], "close() revoked the session exactly once");
});
