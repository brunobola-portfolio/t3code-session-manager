import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../../src/cli/main.ts";
import { planCommand } from "../../src/cli/commands/plan.ts";
import { accountsOf } from "../../src/cli/commands/quarantine.ts";
import { sameCwd } from "../../src/core/paths.ts";
import type { T3Api } from "../../src/t3/api.ts";
import type { SourceAdapter } from "../../src/sources/types.ts";

const temps: string[] = [];
after(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

function setup() {
  const home = mkdtempSync(join(tmpdir(), "t3sm-pdisc-"));
  temps.push(home);
  const state = join(home, "state");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  const work = join(home, "accts", "work");
  mkdirSync(join(work, "projects"), { recursive: true });
  writeFileSync(join(home, ".bashrc"), "alias cw='CLAUDE_CONFIG_DIR=~/accts/work claude'\n");
  const out: string[] = [], err: string[] = [];
  const io: Io = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: false, prompt: async () => "", env: { T3SM_HOME: state } };
  return { home, state, work, io, err: () => err.join("") };
}

const noSessions: SourceAdapter = { id: "claude", mode: "native", isAvailable: async () => true, async *discover() { /* none */ } } as SourceAdapter;

const api = {
  version: "0.0.30",
  listProjects: async () => [], listThreads: async () => [],
  providerInstances: async () => [{ instanceId: "claudeAgent", driver: "claudeAgent", homePath: null, displayName: "Claude", accentColor: null, email: null, authStatus: null, enabled: true, availability: "available" }],
  getConfig: async () => ({ settings: { providerInstances: { claudeAgent: { driver: "claudeAgent" } } }, providers: [] }),
  close: async () => {},
} as unknown as T3Api;

test("first plan with no config.json includes an alias-only account (not ~/.claude-*, no T3 instance)", async () => {
  const s = setup();
  assert.equal(await planCommand([], s.io, { home: s.home, adapters: [noSessions], connect: async () => api, now: () => Date.now() }), 0, s.err());
  const cfg = JSON.parse(readFileSync(join(s.state, "config.json"), "utf8"));
  const cw = cfg.accounts.find((a: { id: string }) => a.id === "cw");
  assert.ok(cw, JSON.stringify(cfg.accounts));
  assert.ok(sameCwd(cw.home, s.work));
});

test("quarantine/rollback accounts without config.json include the alias-only account", async () => {
  const s = setup();
  const accs = await accountsOf(s.state, s.home, s.io.env);
  assert.deepEqual(accs.map((a) => a.id), ["claudeAgent", "cw"]);
});
