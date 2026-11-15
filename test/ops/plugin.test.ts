// The t3sm plugin per Claude account: reading installed_plugins.json (read-only) and installing it in one account with a
// fake child runner. Temp folders only; nothing real is read or installed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_ID, describePlugin, installPlugin, readPluginState, type PluginExec } from "../../src/ops/plugin.ts";

const temps: string[] = [];
after(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

function accountHome(json: string | null): string {
  const h = mkdtempSync(join(tmpdir(), "t3sm-plugin-"));
  temps.push(h);
  if (json !== null) { mkdirSync(join(h, "plugins")); writeFileSync(join(h, "plugins", "installed_plugins.json"), json); }
  return h;
}
const file = (plugins: unknown) => JSON.stringify({ version: 2, plugins });

test("readPluginState: installed, outdated, missing, and every unreadable shape counts as missing", async () => {
  const entry = (v: unknown) => [{ scope: "user", installPath: "C:/x", version: v }];
  assert.deepEqual(await readPluginState(accountHome(file({ [PLUGIN_ID]: entry("0.3.0") })), "0.3.0"), { state: "installed", version: "0.3.0" });
  assert.deepEqual(await readPluginState(accountHome(file({ [PLUGIN_ID]: entry("0.2.1") })), "0.3.0"), { state: "outdated", version: "0.2.1" });
  assert.deepEqual(await readPluginState(accountHome(file({ [PLUGIN_ID]: entry("0.10.0") })), "0.9.0"), { state: "installed", version: "0.10.0" }, "a newer one is not outdated; compared as numbers");
  assert.deepEqual(await readPluginState(accountHome(file({ "other@market": entry("1.0.0") })), "0.3.0"), { state: "missing" });
  assert.deepEqual(await readPluginState(accountHome(file({ [PLUGIN_ID]: [] })), "0.3.0"), { state: "missing" });
  assert.deepEqual(await readPluginState(accountHome(file({ [PLUGIN_ID]: entry(7) })), "0.3.0"), { state: "installed", version: "unknown" });
  assert.deepEqual(await readPluginState(accountHome(null), "0.3.0"), { state: "missing" });
  assert.deepEqual(await readPluginState(accountHome("{not json"), "0.3.0"), { state: "missing" });
  assert.deepEqual(await readPluginState(accountHome("[]"), "0.3.0"), { state: "missing" });
});

test("describePlugin words each state", () => {
  assert.equal(describePlugin({ state: "installed", version: "0.3.0" }, "0.3.0"), "installed (0.3.0)");
  assert.match(describePlugin({ state: "outdated", version: "0.2.1" }, "0.3.0"), /outdated.*0\.2\.1.*0\.3\.0/);
  assert.match(describePlugin({ state: "missing" }, "0.3.0"), /not installed/);
});

test("installPlugin: marketplace add then install, CLAUDE_CONFIG_DIR set to that account for the child only", async () => {
  const calls: { file: string; args: string[]; env: Record<string, string> }[] = [];
  const exec: PluginExec = async (f, args, env) => { calls.push({ file: f, args, env }); return { code: 0, output: "ok\n" }; };
  const base = { PATH: "/bin", CLAUDE_CONFIG_DIR: "/shell/other", claude_config_dir: "/shell/lower" };
  const r = await installPlugin("/home/u/.claude-org", { exec, claudeBin: "/bin/claude", env: base });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => [c.file, ...c.args]), [
    ["/bin/claude", "plugin", "marketplace", "add", "brunobola-portfolio/t3code-session-manager"],
    ["/bin/claude", "plugin", "install", "t3sm@t3code-session-manager"],
  ]);
  for (const c of calls) {
    assert.equal(c.env["CLAUDE_CONFIG_DIR"], "/home/u/.claude-org");
    assert.equal(c.env["PATH"], "/bin");
    assert.equal(Object.keys(c.env).filter((k) => k.toUpperCase() === "CLAUDE_CONFIG_DIR").length, 1, "the shell's value is never passed on");
  }
  assert.equal(base.CLAUDE_CONFIG_DIR, "/shell/other", "the caller's environment is not touched");
});

test("installPlugin: a failing step stops there; 'already added' on the marketplace is fine; no claude is reported", async () => {
  const seq = (codes: [number, string][]): { exec: PluginExec; n: () => number } => {
    let i = 0;
    return { exec: async () => { const [code, output] = codes[i++]!; return { code, output }; }, n: () => i };
  };
  const a = seq([[1, "network down"]]);
  const r1 = await installPlugin("/h", { exec: a.exec, claudeBin: "claude", env: {} });
  assert.deepEqual([r1.ok, r1.step, a.n()], [false, "marketplace", 1]);
  assert.match(r1.output, /network down/);
  const b = seq([[1, "Marketplace already added"], [0, "installed"]]);
  assert.equal((await installPlugin("/h", { exec: b.exec, claudeBin: "claude", env: {} })).ok, true);
  const b2 = seq([[1, "Marketplace t3code-session-manager already exists"], [0, "ok"]]);
  assert.equal((await installPlugin("/h", { exec: b2.exec, claudeBin: "claude", env: {} })).ok, true);
  const b3 = seq([[1, "fatal: destination already in use by another process, permission denied"]]);
  const rb = await installPlugin("/h", { exec: b3.exec, claudeBin: "claude", env: {} });
  assert.deepEqual([rb.ok, rb.step, b3.n()], [false, "marketplace", 1], "'already' in another sense is a failure");
  const c = seq([[0, "added"], [1, "boom"]]);
  const r3 = await installPlugin("/h", { exec: c.exec, claudeBin: "claude", env: {} });
  assert.deepEqual([r3.ok, r3.step], [false, "install"]);
  const r4 = await installPlugin("/h", { exec: async () => { throw new Error("no"); }, claudeBin: null, env: {} });
  assert.deepEqual([r4.ok, r4.step], [false, "claude"]);
});
