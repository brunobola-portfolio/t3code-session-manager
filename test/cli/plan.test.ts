import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commands, main, type Io } from "../../src/cli/main.ts";
import { scanCommand } from "../../src/cli/commands/scan.ts";
import { planCommand, type PlanDeps } from "../../src/cli/commands/plan.ts";
import { RpcClosed, RpcError, RpcTimeout, T3AuthError, T3HttpError, T3Incompatible, T3NotRunning } from "../../src/t3/errors.ts";
import type { T3Api } from "../../src/t3/api.ts";
import type { DiscoveredSession } from "../../src/core/types.ts";
import type { SourceAdapter } from "../../src/sources/types.ts";
import { sess } from "../plan/helpers.ts";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "t3sm-cli-"));
  const state = join(home, "state");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  mkdirSync(join(home, "work", "demo"), { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: false, prompt: async () => "", env: { T3SM_HOME: state, LANG: "en_US.UTF-8" } };
  return { home, state, io, out: () => out.join(""), err: () => err.join("") };
}

function adapter(sessions: DiscoveredSession[], errors = 0): SourceAdapter {
  return {
    id: "claude", mode: "native", isAvailable: async () => true,
    async *discover() { for (const s of sessions) yield s; },
    ...({ lastErrors: Array.from({ length: errors }, () => ({ path: "x", error: "e" })) }),
  } as SourceAdapter;
}

function fakeApi(closed: { n: number }): T3Api {
  return {
    version: "0.0.30",
    listProjects: async () => [], listThreads: async () => [],
    providerInstances: async () => [{ instanceId: "claudeAgent", driver: "claudeAgent", homePath: null, displayName: "Claude", accentColor: null, email: null, authStatus: null, enabled: true, availability: "available" }],
    getConfig: async () => ({ settings: { providerInstances: { claudeAgent: { driver: "claudeAgent" } } }, providers: [] }),
    close: async () => void closed.n++,
  } as unknown as T3Api;
}

test("scan prints a table per harness and account and the error count", async () => {
  const s = setup();
  const code = await scanCommand([], s.io, { home: s.home, adapters: [adapter([sess(), sess({ flags: ["backup-copy"] }), sess({ accountId: "claude-org" })], 2)] });
  assert.equal(code, 0);
  const o = s.out();
  assert.match(o, /Agent\s+Account\s+Sessions\s+Flagged/);
  assert.match(o, /Claude Code\s+Claude\s+2\s+1/, "an account by its display name (here the detected default's)");
  assert.doesNotMatch(o, /claudeAgent/, "never the raw account id when the account has a name");
  assert.match(o, /Claude Code\s+claude-org\s+1\s+0/, "an account config.json does not know keeps its id");
  assert.match(o, /2 read errors/);
  assert.ok(!existsSync(s.state), "scan writes nothing");
});

test("scan --json prints the DiscoveredSession array", async () => {
  const s = setup();
  const a = sess();
  assert.equal(await scanCommand(["--json"], s.io, { home: s.home, adapters: [adapter([a])] }), 0);
  assert.deepEqual(JSON.parse(s.out()), [a]);
});

test("plan writes plan.json and plan.md, prints the path, closes the api and saves a default config", async () => {
  const s = setup();
  const closed = { n: 0 };
  const work = join(s.home, "work", "demo").replaceAll("\\", "/");
  const sessions = [sess({ cwd: work })];
  const deps: PlanDeps = { home: s.home, adapters: [adapter(sessions)], connect: async () => fakeApi(closed), now: () => Date.now() };
  const code = await planCommand([], s.io, deps);
  assert.equal(code, 0, s.err());
  assert.equal(closed.n, 1);
  const runs = readdirSync(join(s.state, "runs"));
  assert.equal(runs.length, 1);
  const dir = join(s.state, "runs", runs[0]!);
  const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
  assert.equal(plan.version, 1);
  assert.equal(plan.items.length, 1);
  assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /^# t3sm plan /);
  // A path longer than the window stands on its own lines, never indented (Task 21), so the pieces join back to it.
  assert.ok(s.out().replace(/\r?\n/g, "").includes(join(dir, "plan.md")), s.out());
  assert.match(s.err(), /No config found/);
  assert.match(s.err(), /\n  claudeAgent  ~\/\.claude  \(found via [a-z, -]+\)/, "each saved account with its home and where it was found");
  assert.ok(existsSync(join(s.state, "config.json")));
  const lines = s.out().trimEnd().split("\n");
  assert.ok(lines.length <= 25);
  assert.match(lines.at(-1)!, /^Next: /);
});

test("plan --json prints the plan", async () => {
  const s = setup();
  const code = await planCommand(["--json"], s.io, { home: s.home, adapters: [adapter([])], connect: async () => fakeApi({ n: 0 }) });
  assert.equal(code, 0);
  assert.equal(JSON.parse(s.out()).version, 1);
});

async function withPlan<T>(deps: PlanDeps, fn: () => Promise<T>): Promise<T> {
  const saved = commands["plan"];
  commands["plan"] = (a, io) => planCommand(a, io, deps);
  try { return await fn(); } finally { commands["plan"] = saved!; }
}

test("plan with T3 not running exits 3 through main and writes no files", async () => {
  const s = setup();
  const code = await withPlan({ home: s.home, adapters: [adapter([])], connect: async () => { throw new T3NotRunning(); } }, () => main(["plan"], s.io));
  assert.equal(code, 3);
  // The error panel: what happened, what to do, the command that helps.
  assert.match(s.err(), /T3 Code is not running/);
  assert.match(s.err(), /What to do: Open (it from the Start menu|T3 Code) and try again\./);
  assert.match(s.err(), /[›>] t3sm doctor/);
  assert.ok(!existsSync(s.state), "nothing written");
});

test("close() runs when discovery or planning throws after connect", async () => {
  const s = setup();
  const closed = { n: 0 };
  const boom: SourceAdapter = { id: "claude", mode: "native", isAvailable: async () => true, async *discover() { throw new Error("disk exploded"); } };
  const code = await withPlan({ home: s.home, adapters: [boom], connect: async () => fakeApi(closed) }, () => main(["plan"], s.io));
  assert.equal(code, 1);
  assert.match(s.err(), /disk exploded/);
  assert.equal(closed.n, 1);
  assert.ok(!existsSync(join(s.state, "runs")), "no run directory without a complete plan");
});

test("main maps T3 errors to friendly messages and exit codes", async () => {
  // Task 21: an error panel (title = what happened, the error's own detail, what to do, a command); exit codes unchanged.
  const cases: [Error, number, RegExp[]][] = [
    [new T3Incompatible("9.9.9", "too new"), 4, [/T3 Code answered in a way t3sm does not know/, /too new/]],
    [new T3AuthError("no token", { hint: "run t3 auth login" }), 1, [/T3 Code refused t3sm's sign-in/, /no token run t3 auth login/]],
    [new RpcClosed(), 3, [/Lost contact with T3 Code/, /connection to T3 Code closed/, /[›>] t3sm doctor/]],
    [new RpcTimeout("orchestration.x", 5000), 3, [/Lost contact with T3 Code/]],
    [new T3HttpError("GET /x", 500), 1, [/T3 Code rejected the request/, /GET \/x returned HTTP 500/]],
    [new RpcError("orchestration.x", { _tag: "Bad" }), 1, [/T3 Code rejected the request/]],
    [new Error("boom"), 1, [/Unexpected error/, /boom/, /[›>] t3sm doctor/]],
  ];
  for (const [err, exp, msgs] of cases) {
    const s = setup();
    const code = await withPlan({ connect: async () => { throw err; } }, () => main(["plan"], s.io));
    assert.equal(code, exp, err.name);
    for (const msg of msgs) assert.match(s.err().replace(/\s*[|│]\s*\n\s*[|│]\s*/g, " "), msg, err.name);
    assert.match(s.err(), /What to do: /, err.name);
  }
});

test("per-command help: t3sm <cmd> --help and t3sm -h <cmd>", async () => {
  for (const argv of [["scan", "--help"], ["-h", "scan"], ["scan", "-h"]]) {
    const s = setup();
    assert.equal(await main(argv, s.io), 0);
    assert.match(s.out(), /^Usage: t3sm scan \[--json\]/);
  }
  const s = setup();
  assert.equal(await main(["plan", "--help"], s.io), 0);
  assert.match(s.out(), /^Usage: t3sm plan .*--allow-untested/);
  const u = setup();
  assert.equal(await main(["scan", "--x"], u.io), 2);
  assert.match(u.err(), /t3sm scan --help/);
});

test("plan rejects unknown options with exit 2", async () => {
  const s = setup();
  assert.equal(await planCommand(["--nope"], s.io, { home: s.home }), 2);
});

test("scan and plan read a config whose account home is written with ~ (expanded once at load)", async () => {
  const s = setup();
  const { writeFileSync, utimesSync } = await import("node:fs");
  const proj = join(s.home, ".claude", "projects", "C--work-demo");
  mkdirSync(proj, { recursive: true });
  mkdirSync(s.state, { recursive: true });
  const id = "11111111-1111-4111-8111-111111111111";
  const work = join(s.home, "work", "demo").replaceAll("\\", "/");
  const f = join(proj, `${id}.jsonl`);
  writeFileSync(f, JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "hi" }, uuid: "a", timestamp: "2026-01-01T00:00:00Z", cwd: work, sessionId: id }) + "\n");
  const old = (Date.now() - 40 * 86400000) / 1000;
  utimesSync(f, old, old);
  // The test home lives under os.tmpdir(): its folders are temp ones, imported once that question is answered.
  const cfgText = JSON.stringify({ version: 1, accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }], defaultAccount: "claudeAgent",
    organize: { decided: ["temp"], folders: { temp: "import" } } });
  writeFileSync(join(s.state, "config.json"), cfgText);
  assert.equal(await scanCommand([], s.io, { home: s.home }), 0);
  assert.match(s.out(), /Claude Code\s+Claude\s+1\s+0/, "the session under ~/.claude is found (its account by display name)");
  const closed = { n: 0 };
  assert.equal(await planCommand(["--json"], s.io, { home: s.home, connect: async () => fakeApi(closed), now: () => Date.now() }), 0, s.err());
  const plan = JSON.parse(s.out().slice(s.out().indexOf("{")));
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].session.accountId, "claudeAgent");
  assert.equal(plan.items[0].action.kind, "import");
  assert.equal(readFileSync(join(s.state, "config.json"), "utf8"), cfgText, "the user's config file is untouched");
});

test("plan: T3's default instance reading another home than the config's ~/.claude account (custom id) is InstanceHomeDrift (exit 2); an implicit one is planned for pinning", async () => {
  const s = setup();
  const { writeFileSync } = await import("node:fs");
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, "config.json"), JSON.stringify({ version: 1, accounts: [{ id: "personal", home: "~/.claude", displayName: "Me", accentColor: null }], defaultAccount: "personal" }));
  const api = (homePath: string | null): T3Api => ({
    ...fakeApi({ n: 0 }),
    providerInstances: async () => [{ instanceId: "claudeAgent", driver: "claudeAgent", homePath, displayName: "Claude", accentColor: null, email: null, authStatus: null, enabled: true, availability: "available" }],
    getConfig: async () => ({ settings: { providerInstances: {} }, providers: [] }),
  }) as unknown as T3Api;
  const { InstanceHomeDrift } = await import("../../src/ops/accounts.ts");
  const { describeError } = await import("../../src/cli/errors.ts");
  const drift = await planCommand([], s.io, { home: s.home, adapters: [adapter([])], connect: async () => api(join(s.home, ".claude-org")), now: () => Date.now() }).catch((e: unknown) => e);
  assert.ok(drift instanceof InstanceHomeDrift, String(drift));
  assert.equal(describeError(drift).code, 2);
  assert.ok(!existsSync(join(s.state, "runs")), "no plan written");
  assert.equal(await planCommand(["--json"], s.io, { home: s.home, adapters: [adapter([])], connect: async () => api(join(s.home, ".claude")), now: () => Date.now() }), 0, s.err());
  const plan = JSON.parse(s.out().slice(s.out().indexOf("{")));
  assert.deepEqual(plan.pinDefault, { instanceId: "claudeAgent", homePath: join(s.home, ".claude").replaceAll("\\", "/") });
});

test("scan and plan warn in one line when a run holds the lock or left file times bumped (read anyway)", async () => {
  const s = setup();
  const { writeFileSync } = await import("node:fs");
  const { hostname } = await import("node:os");
  const NOTE = /a t3sm run is in progress or was interrupted; results may show sessions as active — run `t3sm doctor`/;
  assert.equal(await scanCommand([], s.io, { home: s.home, adapters: [adapter([])] }), 0);
  assert.doesNotMatch(s.err(), NOTE);
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, "lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname() }));
  assert.equal(await scanCommand([], s.io, { home: s.home, adapters: [adapter([])] }), 0);
  assert.equal(s.err().split("\n").filter((l) => NOTE.test(l)).length, 1);
  const { rmSync } = await import("node:fs");
  rmSync(join(s.state, "lock"));
  writeFileSync(join(s.state, "journal.jsonl"), JSON.stringify({ t: "mtime-bump", runId: "r1", files: [{ path: join(s.home, "x.jsonl"), atimeMs: 1, mtimeMs: 1, targetMtimeMs: 2 }] }) + "\n");
  assert.equal(await planCommand([], s.io, { home: s.home, adapters: [adapter([])], connect: async () => fakeApi({ n: 0 }), now: () => Date.now() }), 0);
  assert.equal(s.err().split("\n").filter((l) => NOTE.test(l)).length, 2, "plan warns too");
});

test("scan and plan help say what they write", async () => {
  const s = setup();
  await main(["scan", "--help"], s.io);
  await main(["plan", "--help"], s.io);
  assert.match(s.out(), /discovery cache/);
  assert.match(s.out(), /config\.json/);
  assert.doesNotMatch(s.out(), /writes nothing/);
});

test("plan: the General folder follows the language (the assistant's or --lang, else config.json's, else the system's)", async () => {
  const run = async (language: string | null, lang?: "en" | "pt", env: NodeJS.ProcessEnv = { LANG: "en_US.UTF-8" }, ioLang?: "en" | "pt"): Promise<string[]> => {
    const s = setup();
    Object.assign(s.io.env, env);
    if (ioLang) s.io.lang = ioLang;
    mkdirSync(s.state, { recursive: true });
    writeFileSync(join(s.state, "config.json"), JSON.stringify({
      version: 1, accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }], defaultAccount: "claudeAgent",
      routes: [], ...(language ? { language } : {}), organize: { decided: ["home"] },
    }));
    const home = s.home.replaceAll("\\", "/");
    const deps: PlanDeps = { home: s.home, adapters: [adapter([sess({ cwd: home })])], connect: async () => fakeApi({ n: 0 }), now: () => Date.now(), ...(lang ? { lang } : {}) };
    assert.equal(await planCommand(["--json"], s.io, deps), 0, s.err());
    const plan = JSON.parse(s.out());
    return plan.projectsToCreate.map((p: { title: string }) => p.title);
  };
  assert.deepEqual(await run(null, "pt"), ["Geral"], "the assistant's language");
  assert.deepEqual(await run("pt"), ["Geral"], "config.json's language");
  assert.deepEqual(await run(null), ["General"], "an English system");
  assert.deepEqual(await run(null, undefined, { LANG: "pt_PT.UTF-8" }), ["Geral"], "a Portuguese system (no language in config.json)");
  assert.deepEqual(await run("en", undefined, { LANG: "pt_PT.UTF-8" }), ["General"], "config.json beats the system");
  assert.deepEqual(await run("en", undefined, {}, "pt"), ["Geral"], "main's language (--lang) beats config.json");
  assert.deepEqual(await run("pt", "en"), ["General"], "the explicit language wins");
});

test("plan --json masks an email-shaped display name of an instance to create (plan.json keeps the file as written)", async () => {
  const { planForJson } = await import("../../src/cli/commands/plan.ts");
  const plan = { instancesToCreate: [{ id: "org", driver: "claudeAgent", displayName: "demouser@example.com", accentColor: null, homePath: "C:/h/.claude-org", environment: [] }], items: [] } as never;
  const out = JSON.stringify(planForJson(plan));
  assert.match(out, /"displayName":"d\*\*\*@example\.com"/);
  assert.doesNotMatch(out, /demouser/);
  assert.equal((plan as { instancesToCreate: { displayName: string }[] }).instancesToCreate[0]!.displayName, "demouser@example.com", "a copy: the plan itself is unchanged");
});
