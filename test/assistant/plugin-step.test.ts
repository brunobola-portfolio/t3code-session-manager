// The assistant's last step offers the t3sm plugin per Claude account that lacks it: asks (default No) before each
// install, explains what it adds and how to remove it, and runs the children with that account's CLAUDE_CONFIG_DIR only.
// Scripted answers over fake dependencies; the real dependency is exercised with a fake child runner. Synthetic data.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { realAssistantDeps } from "../../src/assistant/deps.ts";
import { defaultConfig } from "../../src/core/config.ts";
import type { PluginRow } from "../../src/assistant/core.ts";
import type { PluginExec } from "../../src/ops/plugin.ts";
import type { Io } from "../../src/cli/main.ts";
import { harness, writesFollowYes } from "./helpers.ts";

/** The full happy path up to the last step (see assistant.test.ts); the plugin questions come after it. */
const HAPPY = ["y", "y", "y", "n", "1", "Personal", "4", "y", "n", "1", "1", "y", "c", "y", "y", "", "y", "y", "y", "y"];

const ORG: PluginRow = { id: "claude-org", displayName: "Claude · Org", home: "~/.claude-org", state: { state: "missing" } };
const PERSONAL: PluginRow = { id: "claudeAgent", displayName: "Claude · Personal", home: "~/.claude", state: { state: "installed", version: "0.3.0" } };

const temps: string[] = [];
after(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

test("every account has it: no question, nothing installed", async () => {
  const h = harness({ answers: HAPPY, plugins: [PERSONAL] });
  assert.equal(await h.run(), 0, h.text());
  assert.equal(h.left(), 0);
  assert.ok(!h.calls().some((c) => c.startsWith("installPlugin")));
  assert.doesNotMatch(h.flat(), /Install the plugin/);
  assert.doesNotMatch(h.flat(), /optional extra/);
});

test("a missing plugin: explains what it adds and how to remove it, asks (default No), installs only after y, lists it in the summary", async () => {
  const h = harness({ answers: [...HAPPY, "y"], plugins: [PERSONAL, ORG] });
  assert.equal(await h.run(), 0, h.text());
  assert.equal(h.left(), 0);
  const t = h.flat();
  assert.match(t, /\/t3sm:status, \/t3sm:sync, \/t3sm:organize and \/t3sm:import/);
  assert.match(t, /writes only after you say yes/);
  assert.match(t, /claude plugin uninstall t3sm@t3code-session-manager/);
  assert.match(h.prompts.join("\n"), /Install the plugin in Claude · Org \(~\/\.claude-org\)\? \[y\/N/);
  assert.deepEqual(h.writes().filter((w) => w.startsWith("installPlugin")), ["installPlugin claude-org"]);
  assert.deepEqual(writesFollowYes(h.events), []);
  assert.match(t, /Installed in Claude · Org\. Restart T3 Code/);
  assert.match(t, /✓ Installed the t3sm plugin in Claude · Org/);
  assert.match(t, /claude plugin uninstall t3sm@t3code-session-manager \(with ~\/\.claude-org as CLAUDE_CONFIG_DIR\)/);
});

test("n, or Enter, installs nothing and says how to add it later", async () => {
  for (const a of ["n", ""]) {
    const h = harness({ answers: [...HAPPY, a], plugins: [ORG] });
    assert.equal(await h.run(), 0, h.text());
    assert.ok(!h.calls().some((c) => c.startsWith("installPlugin")), `answer ${JSON.stringify(a)}`);
    assert.match(h.flat(), /You can add it later: t3sm start offers it again/);
  }
});

test("two accounts without it: asked one by one; yes to the first and no to the second installs only the first", async () => {
  const second: PluginRow = { id: "claude-x", displayName: "Claude · X", home: "~/.claude-x", state: { state: "missing" } };
  const h = harness({ answers: [...HAPPY, "y", "n"], plugins: [ORG, second] });
  assert.equal(await h.run(), 0, h.text());
  assert.deepEqual(h.writes().filter((w) => w.startsWith("installPlugin")), ["installPlugin claude-org"]);
  assert.equal(h.prompts.filter((q) => /Install the plugin in/.test(q)).length, 2);
});

test("an outdated plugin is only mentioned (the update command), never installed over", async () => {
  const old: PluginRow = { ...PERSONAL, state: { state: "outdated", version: "0.2.1" } };
  const h = harness({ answers: HAPPY, plugins: [old] });
  assert.equal(await h.run(), 0, h.text());
  assert.match(h.flat(), /Claude · Personal \(~\/\.claude\) has an old version of the plugin\. Update it with: claude plugin update t3sm@t3code-session-manager/);
  assert.ok(!h.calls().some((c) => c.startsWith("installPlugin")));
});

test("a failed install shows what Claude Code said and the manual commands, records nothing, and the assistant still finishes (0)", async () => {
  const h = harness({ answers: [...HAPPY, "y"], plugins: [ORG], install: () => ({ ok: false, step: "marketplace", output: "network is down" }) });
  assert.equal(await h.run(), 0, h.text());
  const t = h.flat();
  assert.match(t, /Could not install it in Claude · Org \(adding the marketplace\)\. Claude Code said: network is down/);
  assert.match(t, /with CLAUDE_CONFIG_DIR set to ~\/\.claude-org: claude plugin marketplace add brunobola-portfolio\/t3code-session-manager/);
  assert.doesNotMatch(t, /✓ Installed the t3sm plugin/);
});

test("failed install: escape sequences in the child's output and in the account's name never reach the terminal", async () => {
  const evil = "\u001b]8;;http://x\u0007click\u001b]8;;\u0007\n\u001b[2J\u001b[31mred\u001b[0m\u0007 done";
  const row: PluginRow = { ...ORG, displayName: "Org\u001b[2J\u0007", home: "~/.claude\u001b]0;pwn\u0007-org" };
  const h = harness({ answers: [...HAPPY, "y"], plugins: [row], install: () => ({ ok: false, step: "install", output: evil }) });
  assert.equal(await h.run(), 0, h.text());
  assert.doesNotMatch(h.text(), /[\u001b\u0007]/);
  assert.match(h.flat(), /Could not install it in Org/);
  assert.match(h.flat(), /done/);
});

test("Portuguese: Portuguese text, s counts as yes, same single write", async () => {
  const answers = [...HAPPY.map((a) => (a === "y" ? "s" : a)), "s"];
  const h = harness({ answers, lang: "pt", plugins: [ORG] });
  assert.equal(await h.run(), 0, h.text());
  assert.match(h.prompts.join("\n"), /Instalar o plugin em Claude · Org \(~\/\.claude-org\)\? \[s\/N/);
  assert.match(h.flat(), /só escreve depois de dizeres que sim/);
  assert.deepEqual(h.writes().filter((w) => w.startsWith("installPlugin")), ["installPlugin claude-org"]);
  assert.deepEqual(writesFollowYes(h.events), []);
});

// ---------------- the real dependency ----------------

function realDeps(execFn: PluginExec, bin: string | null = "/bin/claude") {
  const home = mkdtempSync(join(tmpdir(), "t3sm-plugin-step-"));
  temps.push(home);
  const state = join(home, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  mkdirSync(join(home, ".claude-org", "projects"), { recursive: true });
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "t3sm@t3code-session-manager": [{ version: "9.9.9" }] } }));
  writeFileSync(join(state, "config.json"), JSON.stringify(defaultConfig([
    { id: "claudeAgent", home: "~/.claude", displayName: "Personal", accentColor: null }, { id: "claude-org", home: "~/.claude-org", displayName: "Org", accentColor: null },
  ])));
  const io: Io = { stdout: () => {}, stderr: () => {}, isTTY: false, prompt: async () => "q", env: { T3SM_HOME: state, CLAUDE_CONFIG_DIR: "/shell/leak" } };
  const d = realAssistantDeps(io, { main: async () => { throw new Error("must not run a command"); }, home, noColor: true, pluginExec: execFn, claudeBin: () => bin });
  return { d, home };
}

test("real deps: pluginAccounts reads each configured account's installed_plugins.json (read-only, no child)", async () => {
  const calls: string[] = [];
  const { d } = realDeps(async (f) => { calls.push(f); return { code: 0, output: "" }; });
  const rows = await d.pluginAccounts();
  assert.deepEqual(rows.map((r) => [r.id, r.home, r.state.state]), [["claudeAgent", "~/.claude", "installed"], ["claude-org", "~/.claude-org", "missing"]]);
  assert.deepEqual(calls, []);
});

test("real deps: installPlugin runs claude with that account's CLAUDE_CONFIG_DIR, replacing the shell's", async () => {
  const seen: { args: string[]; env: Record<string, string> }[] = [];
  const { d, home } = realDeps(async (_f, args, env) => { seen.push({ args, env }); return { code: 0, output: "done" }; });
  const r = await d.installPlugin("claude-org");
  assert.equal(r.ok, true);
  assert.deepEqual(seen.map((s) => s.args.join(" ")), ["plugin marketplace add brunobola-portfolio/t3code-session-manager", "plugin install t3sm@t3code-session-manager"]);
  for (const s of seen) assert.equal(normalize(s.env["CLAUDE_CONFIG_DIR"]!), normalize(join(home, ".claude-org")));
  assert.equal((await realDeps(async () => ({ code: 0, output: "" }), null).d.installPlugin("claude-org")).step, "claude");
  assert.equal((await d.installPlugin("nope")).ok, false);
});
