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
import { T3NotRunning } from "../../src/t3/errors.ts";
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
  const x: Io = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY, prompt: async () => "q", env: { LANG: "en_US.UTF-8", ...env } }; // pinned: the OS locale must not leak into the tests
  return { io: x, out: () => out.join(""), err: () => err.join("") };
}

const noMain = async (): Promise<number> => { throw new Error("must not run a command"); };

test("language: --lang > T3SM_LANG > config.json > environment locale > en", () => {
  assert.equal(resolveLang(null, { LANG: "pt_PT.UTF-8", LC_ALL: "pt_PT.UTF-8", LC_MESSAGES: "pt_PT" }, null, "en-US"), "pt");
  assert.equal(resolveLang(null, {}, null, "en-US"), "en");
  assert.equal(resolveLang(null, {}, "pt", "en-US"), "pt");
  assert.equal(resolveLang(null, { T3SM_LANG: "pt" }, null, "en-US"), "pt");
  assert.equal(resolveLang(null, { T3SM_LANG: "en" }, "pt", "pt-PT"), "en", "env beats config");
  assert.equal(resolveLang("en", { T3SM_LANG: "pt" }, "pt", "pt-PT"), "en", "flag beats env and config");
  assert.equal(resolveLang("pt", {}, "en", "en-US"), "pt");
  assert.equal(resolveLang(null, { T3SM_LANG: "fr" }, null, "en-US"), "en", "an unknown env value is ignored");
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
  const a = io({ T3SM_HOME: t.state, LANG: "de_DE.UTF-8" });
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
  assert.match(h.text(), /Step 1 of 11 · Welcome/);
  assert.doesNotMatch(h.text(), /\x1b\[/);
  const saved = commands["start"]!;
  let started = 0;
  commands["start"] = async () => { started++; return 0; };
  try {
    assert.equal(await main([], io({}, true).io), 0);
    assert.equal(started, 1);
    const plain = io({});
    assert.equal(await main([], plain.io), 0);
    assert.match(plain.out(), /\nUsage: t3sm /);
    assert.match(plain.out(), /\n  t3sm start +Guided set-up.*\(also plain t3sm; --lang pt/);
    assert.equal(started, 1);
  } finally {
    commands["start"] = saved;
  }
  const help = io({});
  assert.equal(await main(["start", "--help"], help.io), 0);
  assert.match(help.out(), /^Usage: t3sm start \[--lang en\|pt\] \[--no-color\]/);
  assert.match(help.out(), /--lang en\|pt   Language \(see the global options below\)/);
  assert.match(help.out(), /Global options \(every command\):\n  --lang en\|pt   The language of what t3sm prints\. Default: env T3SM_LANG/);
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
  const p = await d.plan(false, "en");
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

test("real dependencies: without a TTY the assistant's prompts read from the same terminal as the review lists; on a TTY they use io.prompt", async () => {
  const t = tmp();
  const lines = ["first", "second"];
  let asked = "";
  const term = { isTTY: false, columns: 80, rows: 24, color: false, unicode: false, write: () => undefined, onKey: () => () => undefined, setRaw: () => undefined,
    readLine: async (q: string) => { asked += q; return lines.shift() ?? null; } };
  const piped = realAssistantDeps(io({ T3SM_HOME: t.state }).io, { main: noMain, home: t.home, noColor: true, term });
  assert.equal(piped.term, term, "one terminal for lists and prompts");
  assert.equal(await piped.prompt("a? "), "first");
  assert.equal(await piped.term.readLine("b? "), "second", "a list reads the next piped line, never a line the prompt already took");
  assert.equal(await piped.prompt("c? "), "\u0003", "input closed counts as quit");
  assert.equal(asked, "a? b? c? ");
  const tty = realAssistantDeps({ ...io({ T3SM_HOME: t.state }, true).io, prompt: async () => "from io" }, { main: noMain, home: t.home, noColor: true, term });
  assert.equal(await tty.prompt("x? "), "from io");
});

test("real dependencies: saveOrganize merges into config.json under the lock and keeps the rest; a held lock writes nothing", async () => {
  const t = tmp();
  writeFileSync(join(t.state, "config.json"), JSON.stringify({ version: 1, accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }], defaultAccount: "claudeAgent", organize: { decided: ["home"], titles: false } }));
  const d = realAssistantDeps(io({ T3SM_HOME: t.state }).io, { main: noMain, home: t.home, noColor: true });
  writeFileSync(join(t.state, "lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname() }));
  assert.equal(await d.saveOrganize({ decided: ["temp"], folders: { temp: "import" } }), false);
  assert.deepEqual(JSON.parse(readFileSync(join(t.state, "config.json"), "utf8")).organize, { decided: ["home"], titles: false }, "nothing written");
  rmSync(join(t.state, "lock"));
  assert.equal(await d.saveOrganize({ decided: ["temp"], folders: { temp: "import" }, overrides: [{ match: "~/a", action: "skip" }] }), true);
  const saved = JSON.parse(readFileSync(join(t.state, "config.json"), "utf8"));
  assert.deepEqual(saved.organize, { decided: ["home", "temp"], titles: false, folders: { temp: "import" }, overrides: [{ match: "~/a", action: "skip" }] });
  assert.equal(saved.accounts[0].home, "~/.claude");
  assert.equal(existsSync(join(t.state, "lock")), false, "the lock is released");
  assert.equal(validateConfig(saved, process.platform, t.home).ok, true);
});

test("real dependencies: organizePreview is read-only (the dry run) and null when nothing was imported; config() reports pending decisions from the newest plan", async () => {
  const t = tmp();
  writeFileSync(join(t.state, "config.json"), JSON.stringify({ version: 1, accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }], defaultAccount: "claudeAgent" }));
  const f = fakeT3({ instances: [inst("claudeAgent", join(t.home, ".claude"))] });
  f.projects.push({ id: "p1", title: "demo", workspaceRoot: join(t.home, "work", "demo").replaceAll("\\", "/"), defaultModelSelection: null, archived: false, deleted: false, pinned: false, createdAt: null });
  const adapter = { id: "claude", mode: "native", isAvailable: async () => true, async *discover() { /* no transcripts */ } } as SourceAdapter;
  const d = realAssistantDeps(io({ T3SM_HOME: t.state }).io, { main: noMain, home: t.home, noColor: true, connect: async () => f.api, adapters: [adapter] });
  assert.equal(await d.organizePreview(false), null, "no imported conversation: nothing to organize");
  f.threads.set("import:claudeAgent:x1", { id: "import:claudeAgent:x1", projectId: "p1", instanceId: "claudeAgent", archived: false, title: "Fix the form", latestUserMessageAt: "2026-11-10T10:00:00.000Z", settledOverride: "settled", settledAt: "2026-11-11T10:00:00.000Z", unsettledAt: null, updatedAt: 0 });
  const p = await d.organizePreview(false);
  assert.ok(p);
  assert.equal(p.threads.length, 1);
  assert.equal(p.projects.length, 1);
  assert.equal(p.autoSettleDays, 7);
  assert.equal(p.plan.counts.unsettle, 1, "a human conversation put away at import is shown again");
  assert.equal(p.legacyHistory, undefined, "no 0.2 history value");
  // T3 Code's option as the run will set it is planned too (a dry run: nothing written).
  const withT3 = await d.organizePreview(false, undefined, 30);
  assert.deepEqual(withT3?.plan.actions.filter((a) => a.kind === "auto-settle").map((a) => [a.previous, a.next]), [[7, 30]]);
  // A 0.2.1-shaped config: organize.history "all", answered for 0.2 only.
  writeFileSync(join(t.state, "config.json"), JSON.stringify({ version: 1, accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }], defaultAccount: "claudeAgent", organize: { history: "all", decided: ["history"] } }));
  assert.equal((await d.organizePreview(false))?.legacyHistory, "all");
  writeFileSync(join(t.state, "config.json"), JSON.stringify({ version: 1, accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }], defaultAccount: "claudeAgent" }));
  assert.deepEqual(f.calls.filter((c) => c !== "close"), [], "nothing written to T3 Code");
  assert.equal(existsSync(join(t.state, "journal.jsonl")), false, "no journal, no lock: a dry run");
  // config(): the plan's own decisionsPending
  const runDir = join(t.state, "runs", "20261114-100000-aaaa");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "plan.json"), JSON.stringify({ version: 1, items: [], decisionsPending: [{ key: "temp", sessions: 2, folders: 1 }] }));
  // T3 Code is reachable: the fresh plan decides (this saved plan says "temp", the fresh one has nothing pending)
  assert.equal((await d.config()).decisionsPending, false, "the fresh plan wins over the saved one");
  // T3 Code down: the newest saved plan answers
  const down = realAssistantDeps(io({ T3SM_HOME: t.state }).io, { main: noMain, home: t.home, noColor: true, connect: async () => { throw new T3NotRunning("down"); }, adapters: [adapter] });
  assert.equal((await down.config()).decisionsPending, true);
  writeFileSync(join(runDir, "plan.json"), JSON.stringify({ version: 1, items: [] }));
  assert.equal((await down.config()).decisionsPending, false);
});

test("real dependencies: config() sees new pending questions in a fresh read-only plan that the saved plan lacks", async () => {
  const t = tmp();
  writeFileSync(join(t.state, "config.json"), JSON.stringify({ version: 1, accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }], defaultAccount: "claudeAgent" }));
  const runDir = join(t.state, "runs", "20261114-100000-aaaa");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "plan.json"), JSON.stringify({ version: 1, items: [] }));
  const f = fakeT3({ instances: [inst("claudeAgent", join(t.home, ".claude"))] });
  mkdirSync(join(t.home, "work", "demo"), { recursive: true });
  // One automated session (started by the Agent SDK) that the config has not decided on.
  const adapter = { id: "claude", mode: "native", isAvailable: async () => true, async *discover() { yield { ...sess({ cwd: join(t.home, "work", "demo") }), origin: "automated" as const }; } } as SourceAdapter;
  const d = realAssistantDeps(io({ T3SM_HOME: t.state }).io, { main: noMain, home: t.home, noColor: true, connect: async () => f.api, adapters: [adapter] });
  assert.equal((await d.config()).decisionsPending, true);
  assert.deepEqual(f.calls.filter((c) => c !== "close"), [], "nothing written to T3 Code");
});
