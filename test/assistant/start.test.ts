import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { commands, main, type Io } from "../../src/cli/main.ts";
import { startCommand } from "../../src/cli/commands/start.ts";
import { validateConfig } from "../../src/core/config.ts";
import { CATALOGUES, fmt, resolveLang, wrap } from "../../src/assistant/i18n.ts";
import { realAssistantDeps } from "../../src/assistant/deps.ts";
import { reportLockBusy } from "../../src/cli/locked.ts";
import { fakeT3, inst } from "../apply/fake-t3.ts";
import { harness } from "./helpers.ts";
import { sess } from "../plan/helpers.ts";
import type { SourceAdapter } from "../../src/sources/types.ts";

const temps: string[] = [];
after(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

function tmp(): { home: string; state: string } {
  const home = mkdtempSync(join(tmpdir(), "t3sm-start-"));
  temps.push(home);
  const state = join(home, "state");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  mkdirSync(state, { recursive: true });
  return { home, state };
}

function io(env: NodeJS.ProcessEnv, isTTY = false) {
  const out: string[] = [];
  const err: string[] = [];
  const x: Io = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY, prompt: async () => "q", env };
  return { io: x, out: () => out.join(""), err: () => err.join("") };
}

const noMain = async (): Promise<number> => { throw new Error("must not run a command"); };

test("language: English by default whatever the OS locale; --lang > T3SM_LANG > config.json > en", () => {
  assert.equal(resolveLang(null, { LANG: "pt_PT.UTF-8", LC_ALL: "pt_PT.UTF-8", LC_MESSAGES: "pt_PT" }, null), "en");
  assert.equal(resolveLang(null, {}, "pt"), "pt");
  assert.equal(resolveLang(null, { T3SM_LANG: "pt" }, null), "pt");
  assert.equal(resolveLang(null, { T3SM_LANG: "en" }, "pt"), "en", "env beats config");
  assert.equal(resolveLang("en", { T3SM_LANG: "pt" }, "pt"), "en", "flag beats env and config");
  assert.equal(resolveLang("pt", {}, "en"), "pt");
  assert.equal(resolveLang(null, { T3SM_LANG: "fr" }, null), "en", "an unknown env value is ignored");
});

test("config.json language: optional, \"en\" or \"pt\" only", () => {
  const base = { version: 1, accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "C", accentColor: null }], defaultAccount: "claudeAgent" };
  assert.equal(validateConfig(base).ok, true);
  const pt = validateConfig({ ...base, language: "pt" });
  assert.ok(pt.ok && pt.config.language === "pt");
  const bad = validateConfig({ ...base, language: "fr" });
  assert.ok(!bad.ok && bad.errors.some((e) => /language: must be "en" or "pt"/.test(e)));
});

test("not on a terminal: t3sm start prints the quick start (English by default) and exits 0", async () => {
  const t = tmp();
  const a = io({ T3SM_HOME: t.state, LANG: "pt_PT.UTF-8" });
  assert.equal(await startCommand([], a.io, { main: noMain, home: t.home }), 0);
  assert.match(a.out(), /^t3sm start is interactive, so it needs a terminal/);
  assert.match(a.out(), /t3sm apply --only "<folder>"/);
  const b = io({ T3SM_HOME: t.state });
  assert.equal(await startCommand(["--lang", "pt"], b.io, { main: noMain, home: t.home }), 0);
  assert.match(b.out(), /^t3sm start é interativo/);
  const c = io({ T3SM_HOME: t.state, T3SM_LANG: "pt" });
  assert.equal(await startCommand([], c.io, { main: noMain, home: t.home }), 0);
  assert.match(c.out(), /é interativo/);
  writeFileSync(join(t.state, "config.json"), JSON.stringify({ version: 1, accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "C", accentColor: null }], defaultAccount: "claudeAgent", language: "pt" }));
  const d = io({ T3SM_HOME: t.state });
  assert.equal(await startCommand([], d.io, { main: noMain, home: t.home }), 0);
  assert.match(d.out(), /é interativo/, "config.json language");
  const e = io({ T3SM_HOME: t.state });
  assert.equal(await startCommand(["--lang=en"], e.io, { main: noMain, home: t.home }), 0);
  assert.match(e.out(), /needs a terminal/, "the flag beats config.json");
  const f = io({ T3SM_HOME: t.state });
  assert.equal(await startCommand(["--lang", "fr"], f.io, { main: noMain, home: t.home }), 2);
  assert.equal(await startCommand(["--bogus"], f.io, { main: noMain, home: t.home }), 2);
});

test("on a terminal: start runs the assistant (with --no-color); plain t3sm starts it too, but prints the usage when not on a terminal", async () => {
  const t = tmp();
  const h = harness({ answers: ["q"] });
  const a = io({ T3SM_HOME: t.state }, true);
  assert.equal(await startCommand(["--no-color"], a.io, { main: noMain, home: t.home, assistant: h.deps }), 0);
  assert.match(h.text(), /Step 1 of 9 · Welcome/);
  assert.doesNotMatch(h.text(), /\x1b\[/);
  const saved = commands["start"]!;
  let started = 0;
  commands["start"] = async () => { started++; return 0; };
  try {
    assert.equal(await main([], io({}, true).io), 0);
    assert.equal(started, 1);
    const plain = io({});
    assert.equal(await main([], plain.io), 0);
    assert.match(plain.out(), /^Usage: t3sm/);
    assert.match(plain.out(), /\n  start \[--lang en\|pt\]/);
    assert.equal(started, 1);
  } finally {
    commands["start"] = saved;
  }
  const help = io({});
  assert.equal(await main(["start", "--help"], help.io), 0);
  assert.match(help.out(), /^Usage: t3sm start \[--lang en\|pt\] \[--no-color\]/);
  assert.match(help.out(), /every other command\nprints English/);
});

test("every catalogue message wraps to 80 columns, even with long values in its placeholders", () => {
  for (const [lang, cat] of Object.entries(CATALOGUES)) {
    for (const [k, v] of Object.entries(cat)) {
      const filled = fmt(v, new Proxy({}, { get: () => "x".repeat(24), has: () => true }) as Record<string, string>);
      for (const line of wrap(filled)) assert.ok(line.length <= 80, `${lang}.${k}: ${line}`);
    }
  }
  assert.deepEqual(wrap("- one two three", 9), ["- one two", "  three"], "a bullet hangs its continuation");
  assert.deepEqual(wrap("  a    b"), ["  a    b"], "a short line keeps its spacing");
});

test("real dependencies: plan and clean-up counts over fakes; the language is saved under the lock", async () => {
  const t = tmp();
  const { utimesSync } = await import("node:fs");
  writeFileSync(join(t.state, "config.json"), JSON.stringify({ version: 1, accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "Claude · Personal", accentColor: null }], defaultAccount: "claudeAgent" }));
  const bak = join(t.home, ".claude", "projects", "C--work-demo.bak-20260101-101010");
  mkdirSync(bak, { recursive: true });
  writeFileSync(join(bak, "a.jsonl"), "{}\n");
  const old = (Date.now() - 40 * 86_400_000) / 1000;
  utimesSync(join(bak, "a.jsonl"), old, old);
  const work = join(t.home, "work", "demo").replaceAll("\\", "/");
  mkdirSync(work, { recursive: true });
  const f = fakeT3({ instances: [inst("claudeAgent", join(t.home, ".claude"))] });
  const s = sess({ cwd: work, mtimeMs: Date.now() - 40 * 86_400_000 });
  const adapter = { id: "claude", mode: "native", isAvailable: async () => true, async *discover() { yield s; } } as SourceAdapter;
  const errs: string[] = [];
  const d = realAssistantDeps({ ...io({ T3SM_HOME: t.state }).io, stderr: (x) => void errs.push(x) }, { main: noMain, home: t.home, noColor: true, connect: async () => f.api, adapters: [adapter] });
  const p = await d.plan(false);
  assert.equal(p.plan.items.length, 1);
  assert.ok(existsSync(p.planPath) && existsSync(p.planPath.replace(/plan\.md$/, "plan.json")), "plan.md and plan.json written");
  assert.deepEqual(await d.cleanupCounts(p.plan), { backupFolders: 1, mirrorCopies: 0 });
  assert.ok(existsSync(join(bak, "a.jsonl")), "counting moves nothing");
  assert.equal((await d.config()).hasPlan, true);
  writeFileSync(join(t.state, "lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname() }));
  assert.equal(await d.saveLanguage("pt"), false, "the lock is held: nothing saved");
  assert.equal(JSON.parse(readFileSync(join(t.state, "config.json"), "utf8")).language, undefined);
  rmSync(join(t.state, "lock"));
  assert.equal(await d.saveLanguage("pt"), true);
  assert.equal(JSON.parse(readFileSync(join(t.state, "config.json"), "utf8")).language, "pt");
});

test("real dependencies: emails masked in the accounts view, a stale lock is not held, a live one is", async () => {
  const t = tmp();
  writeFileSync(join(t.state, "config.json"), JSON.stringify({ version: 1, accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "Claude · Personal", accentColor: null }], defaultAccount: "claudeAgent" }));
  const f = fakeT3({ instances: [inst("claudeAgent", join(t.home, ".claude"), { email: "someone.real@example.com" })] });
  const d = realAssistantDeps(io({ T3SM_HOME: t.state }).io, { main: noMain, home: t.home, noColor: true, connect: async () => f.api });
  const rows = await d.accounts(false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.email, "s***@example.com");
  assert.equal(rows[0]!.home, "~/.claude");
  assert.equal(rows[0]!.hasInstance, true);
  assert.ok(f.calls.includes("close"));
  assert.equal(await d.lockHolder(), null);
  writeFileSync(join(t.state, "lock"), JSON.stringify({ pid: 2 ** 31 - 2, startedAt: new Date().toISOString(), hostname: hostname() }));
  assert.equal(await d.lockHolder(), null, "a lock whose process is gone");
  writeFileSync(join(t.state, "lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname() }));
  assert.deepEqual(await d.lockHolder(), { pid: process.pid });
  rmSync(join(t.state, "lock"));
  await d.saveLanguage("pt");
  assert.equal(JSON.parse(readFileSync(join(t.state, "config.json"), "utf8")).language, "pt");
  assert.equal(JSON.parse(readFileSync(join(t.state, "config.json"), "utf8")).accounts[0].home, "~/.claude", "the file's spelling is kept");
  const out: string[] = [];
  const r = await realAssistantDeps({ ...io({ T3SM_HOME: t.state }).io, stdout: (s) => void out.push(s) }, {
    main: async (argv, x) => { x.stdout(`ran ${argv.join(" ")} ${x.env["NO_COLOR"] ?? ""}\n`); return 5; }, home: t.home, noColor: true,
  }).run(["apply", "--yes"]);
  assert.deepEqual(r, { code: 5, output: "ran apply --yes 1\n", locked: false });
  const busy = await realAssistantDeps(io({ T3SM_HOME: t.state }).io, { main: async (_argv, x) => { reportLockBusy(x); return 0; }, home: t.home, noColor: true }).run(["quarantine", "--yes"]);
  assert.deepEqual(busy, { code: 0, output: "Another t3sm run is in progress.\n", locked: true }, "the lock-busy signal reaches the assistant");
  assert.equal(out.join(""), "ran apply --yes 1\n", "shown to the user as it runs");
});
