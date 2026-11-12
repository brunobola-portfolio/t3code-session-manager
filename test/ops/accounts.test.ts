import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstances, applyProjectDefaults, InstanceHomeDrift } from "../../src/ops/accounts.ts";
import { accountsCommand } from "../../src/cli/commands/accounts.ts";
import { main, type Io } from "../../src/cli/main.ts";
import { Journal } from "../../src/core/journal.ts";
import type { InstanceSpec, JournalEntry } from "../../src/core/types.ts";
import type { ProviderInstanceInfo, T3Api } from "../../src/t3/api.ts";

const HOME = process.platform === "win32" ? "C:\\Users\\demo" : "/home/demo";
const P = join(HOME, ".claude");
const O = join(HOME, ".claude-org");

const spec = (id: string, home: string, extra: Partial<InstanceSpec> = {}): InstanceSpec =>
  ({ id, driver: "claudeAgent", displayName: id, accentColor: null, homePath: home, environment: [], ...extra });

function inst(id: string, home: string | null, extra: Partial<ProviderInstanceInfo> = {}): ProviderInstanceInfo {
  return { instanceId: id, driver: "claudeAgent", homePath: home, displayName: id, accentColor: null, email: null, authStatus: "authenticated", enabled: true, availability: "available", ...extra };
}

interface Fake { api: T3Api; calls: string[]; instances: ProviderInstanceInfo[]; explicit: Set<string>; projects: any[] }
function fake(instances: ProviderInstanceInfo[], explicit: string[] = [], projects: any[] = []): Fake {
  const f: Fake = { calls: [], instances, explicit: new Set(explicit), projects, api: null as never };
  f.api = {
    version: "0.0.0",
    providerInstances: async () => f.instances.map((i) => ({ ...i })),
    addInstance: async (s: InstanceSpec) => { f.calls.push(`add:${s.id}:${s.homePath}`); f.instances.push(inst(s.id, s.homePath)); f.explicit.add(s.id); },
    pinInstanceHome: async (id: string, home: string) => {
      if (f.explicit.has(id)) { f.calls.push(`pin-noop:${id}`); return { previous: { driver: "claudeAgent", config: { homePath: home } }, changed: false }; }
      f.calls.push(`pin:${id}:${home}`); f.explicit.add(id);
      return { previous: null, changed: true };
    },
    getConfig: async () => ({ settings: { providerInstances: Object.fromEntries([...f.explicit].map((i) => [i, { driver: "claudeAgent" }])) }, providers: [] }),
    listProjects: async () => f.projects,
    setProjectDefault: async (pid: string, iid: string | null) => {
      f.calls.push(`default:${pid}:${iid}`);
      const p = f.projects.find((x) => x.id === pid); const previous = p.defaultModelSelection; p.defaultModelSelection = iid ? { instanceId: iid, model: "m" } : null;
      return { previous };
    },
    close: async () => {},
  } as unknown as T3Api;
  return f;
}

function journal() {
  const dir = mkdtempSync(join(tmpdir(), "t3sm-acc-"));
  const j = new Journal(join(dir, "journal.jsonl"));
  return { j, dir, entries: (): Promise<JournalEntry[]> => j.readAll() };
}

test("claudeAgent implicit + spec ~/.claude -> nothing created, one instance-pinned with previous null", async () => {
  const f = fake([inst("claudeAgent", P)]);
  const { j, entries } = journal();
  const r = await ensureInstances(f.api, [spec("claudeAgent", P)], j, "r1");
  assert.deepEqual(r, { created: [], pinned: ["claudeAgent"], skipped: [] });
  assert.deepEqual(f.calls, [`pin:claudeAgent:${P}`]);
  const e = await entries();
  assert.equal(e.length, 1);
  assert.equal(e[0]!.t, "instance-pinned");
  assert.deepEqual((e[0] as any).previous, { homePath: null });
});

test("spec ~/.claude-org -> one addInstance and one instance-created; second run changes nothing", async () => {
  const f = fake([inst("claudeAgent", P)], ["claudeAgent"]);
  const { j, entries } = journal();
  const specs = [spec("claudeAgent", P), spec("claude-org", O, { displayName: "Claude · Work", accentColor: "#7C3AED" })];
  const r = await ensureInstances(f.api, specs, j, "r1");
  assert.deepEqual(r.created, ["claude-org"]);
  assert.deepEqual(r.pinned, []);
  assert.deepEqual(f.calls, ["pin-noop:claudeAgent", `add:claude-org:${O}`]);
  const e = await entries();
  assert.deepEqual(e.map((x) => x.t), ["instance-created"]);
  assert.equal((e[0] as any).homePath, O);
  f.calls.length = 0;
  const r2 = await ensureInstances(f.api, specs, j, "r2");
  assert.deepEqual(r2, { created: [], pinned: [], skipped: [{ id: "claude-org", reason: "already present" }] });
  assert.deepEqual(f.calls, ["pin-noop:claudeAgent"]);
  assert.equal((await entries()).length, 1);
});

test("a home that already has an instance under another id is never given a second instance", async () => {
  const f = fake([inst("claudeAgent", P), inst("my-org", O + (process.platform === "win32" ? "\\" : "/"))], ["claudeAgent", "my-org"]);
  const { j, entries } = journal();
  const r = await ensureInstances(f.api, [spec("claudeAgent", P), spec("claude-org", O)], j, "r1");
  assert.deepEqual(r.created, []);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0]!.id, "claude-org");
  assert.match(r.skipped[0]!.reason, /my-org/);
  assert.ok(!f.calls.some((c) => c.startsWith("add:")));
  assert.equal((await entries()).length, 0);
});

test("drift: claudeAgent reads ~/.claude-org -> InstanceHomeDrift, nothing written (no pin, no create, no journal)", async () => {
  const f = fake([inst("claudeAgent", O)]);
  const { j, entries } = journal();
  await assert.rejects(
    ensureInstances(f.api, [spec("claudeAgent", P), spec("claude-x", join(HOME, ".claude-x"))], j, "r1"),
    (e: Error) => e instanceof InstanceHomeDrift && e.message === `T3 Code's default Claude instance reads ${O} instead of ~/.claude. Close T3 Code and open it from the Start menu, then retry.`,
  );
  assert.deepEqual(f.calls, []);
  assert.equal((await entries()).length, 0);
});

test("drift messages: an EXPLICIT claudeAgent entry for another home -> InstanceHomeConfigured (settings advice, exit 2); implicit -> the Start-menu advice", async () => {
  const { InstanceHomeConfigured, assertDefaultInstanceHome } = await import("../../src/ops/accounts.ts");
  const { describeError } = await import("../../src/cli/errors.ts");
  const providers = [{ instanceId: "claudeAgent", driver: "claudeAgent", homePath: O }];
  const configured = `T3 Code's default Claude instance is configured to read ${O}. t3sm expects it to read ~/.claude. Change it in T3 Code settings (Providers) or run \`t3sm accounts --apply\`.`;
  const inherited = `T3 Code's default Claude instance reads ${O} instead of ~/.claude. Close T3 Code and open it from the Start menu, then retry.`;
  const explicit = { claudeAgent: { driver: "claudeAgent", config: { homePath: O } } };
  assert.throws(() => assertDefaultInstanceHome(providers, [P, O], HOME, process.platform, explicit), (e: Error) => e instanceof InstanceHomeConfigured && e.message === configured);
  assert.throws(() => assertDefaultInstanceHome(providers, [P, O], HOME, process.platform, {}), (e: Error) => !(e instanceof InstanceHomeConfigured) && e instanceof InstanceHomeDrift && e.message === inherited);
  assert.equal(describeError(new InstanceHomeConfigured(O)).code, 2);
  // The apply path (ensureInstances) refuses with the same distinct error before any write.
  const f = fake([inst("claudeAgent", O)]);
  f.api.getConfig = async () => ({ settings: { providerInstances: explicit }, providers: [] }) as never;
  const { j, entries } = journal();
  await assert.rejects(ensureInstances(f.api, [spec("claudeAgent", P)], j, "r1", P), (e: Error) => e instanceof InstanceHomeConfigured && e.message === configured);
  assert.deepEqual(f.calls, []);
  assert.equal((await entries()).length, 0);
});

test("drift without a ~/.claude account: the IMPLICIT default instance reading another configured account's home is refused (InstanceHomeDrift); explicit or unrelated homes pass", async () => {
  const { assertDefaultInstanceHome, InstanceHomeConfigured } = await import("../../src/ops/accounts.ts");
  const X = join(HOME, ".claude-x");
  const reads = (h: string) => [{ instanceId: "claudeAgent", driver: "claudeAgent", homePath: h }];
  assert.throws(() => assertDefaultInstanceHome(reads(O), [O], HOME, process.platform, {}),
    (e: Error) => e instanceof InstanceHomeDrift && !(e instanceof InstanceHomeConfigured) && e.message.includes(O));
  assert.throws(() => assertDefaultInstanceHome(reads(O), [O, X], HOME, process.platform), InstanceHomeDrift, "settings unknown: treated as implicit");
  assert.doesNotThrow(() => assertDefaultInstanceHome(reads(O), [O], HOME, process.platform, { claudeAgent: { driver: "claudeAgent", config: { homePath: O } } }), "explicitly configured: the user chose it");
  assert.doesNotThrow(() => assertDefaultInstanceHome(reads(X), [O], HOME, process.platform, {}), "not a configured account's home");
  assert.doesNotThrow(() => assertDefaultInstanceHome(reads(P), [O], HOME, process.platform, {}));
  assert.doesNotThrow(() => assertDefaultInstanceHome([{ instanceId: "claudeAgent", driver: "claudeAgent", homePath: null }], [O], HOME, process.platform, {}));
});

test("accounts --apply re-pins an explicit claudeAgent entry that reads another home (as its message advises), journaled", async () => {
  const s = setup();
  await accountsCommand(["--init"], s.io, { home: s.home });
  const org = join(s.home, ".claude-org");
  const f = fake([inst("claudeAgent", org), inst("claude-org", org)], ["claude-org"]);
  let entry: Record<string, unknown> = { driver: "claudeAgent", config: { homePath: org } };
  f.api.getConfig = async () => ({ settings: { providerInstances: { claudeAgent: entry, "claude-org": { driver: "claudeAgent", config: { homePath: org } } } }, providers: [] }) as never;
  f.api.pinInstanceHome = async (id: string, home: string) => {
    f.calls.push(`pin:${id}:${home}`);
    const previous = entry;
    entry = { driver: "claudeAgent", config: { homePath: home } };
    return { previous, changed: true };
  };
  assert.equal(await accountsCommand(["--apply", "--yes"], s.io, deps(s, f)), 0);
  assert.deepEqual(f.calls, [`pin:claudeAgent:${join(s.home, ".claude")}`]);
  const es = new Journal(join(s.state, "journal.jsonl"));
  const pinned = (await es.readAll()).find((e) => e.t === "instance-pinned") as Extract<JournalEntry, { t: "instance-pinned" }>;
  assert.deepEqual(pinned.previous, { homePath: org });
});

test("applyProjectDefaults journals previous, skips equal, second run is a no-op", async () => {
  const f = fake([], [], [{ id: "p1", defaultModelSelection: null }, { id: "p2", defaultModelSelection: { instanceId: "claude-org", model: "m" } }]);
  const { j, entries } = journal();
  const d = [{ projectId: "p1", instanceId: "claude-org" }, { projectId: "p2", instanceId: "claude-org" }];
  await applyProjectDefaults(f.api, d, j, "r1");
  assert.deepEqual(f.calls, ["default:p1:claude-org"]);
  const e = await entries();
  assert.equal(e.length, 1);
  assert.deepEqual(e[0], { t: "project-default-set", runId: "r1", projectId: "p1", previous: null, next: { instanceId: "claude-org" } });
  await applyProjectDefaults(f.api, d, j, "r2");
  assert.equal(f.calls.length, 1);
});

// ---- CLI ----
function setup(opts: { tty?: boolean; answer?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "t3sm-acccli-"));
  const home = join(dir, "home");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  mkdirSync(join(home, ".claude-org", "projects"), { recursive: true });
  const state = join(dir, "state");
  const out: string[] = []; const err: string[] = []; const prompts: string[] = [];
  const io: Io = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), isTTY: opts.tty ?? false, prompt: async (q) => { prompts.push(q); return opts.answer ?? ""; }, env: { T3SM_HOME: state } };
  return { home, state, io, out: () => out.join(""), err: () => err.join(""), prompts };
}
const deps = (s: ReturnType<typeof setup>, f: Fake) => ({ home: s.home, connect: async () => f.api });

test("accounts: table with masked emails, warns on shared email, missing instance and signed-out instance", async () => {
  const s = setup();
  const f = fake([inst("claudeAgent", join(s.home, ".claude"), { email: "same@x.com" }), inst("extra", join(s.home, ".claude-z"), { email: "SAME@x.com", authStatus: "unauthenticated" })]);
  assert.equal(await accountsCommand([], s.io, deps(s, f)), 0);
  const o = s.out();
  assert.match(o, /claudeAgent/);
  assert.match(o, /s\*\*\*@x\.com/);
  assert.ok(!/same@/i.test(o), "emails are masked by default (table and warnings)");
  assert.match(o, /share the same email \(s\*\*\*@x\.com\)/i); // compared unmasked, case-insensitively
  assert.match(o, /claude-org.*no T3 instance/s);
  assert.match(o, /extra.*signed out/s);
  assert.ok(!existsSync(s.state), "read-only: writes nothing");
});

test("accounts --show-emails prints the signed-in emails in full", async () => {
  const s = setup();
  const f = fake([inst("claudeAgent", join(s.home, ".claude"), { email: "same@x.com" }), inst("extra", join(s.home, ".claude-z"), { email: "SAME@x.com" })]);
  assert.equal(await accountsCommand(["--show-emails"], s.io, deps(s, f)), 0);
  const o = s.out();
  assert.match(o, /same@x\.com/);
  assert.match(o, /SAME@x\.com/);
  assert.match(o, /share the same email \(same@x\.com\)/);
  const bad = setup();
  assert.equal(await accountsCommand(["--init", "--show-emails"], bad.io, { home: bad.home }), 2);
});

test("accounts --init writes config from detected accounts, refuses to overwrite without --force; no email on disk", async () => {
  const s = setup();
  assert.equal(await accountsCommand(["--init"], s.io, { home: s.home }), 0);
  const raw = readFileSync(join(s.state, "config.json"), "utf8");
  const cfg = JSON.parse(raw);
  assert.deepEqual(cfg.accounts.map((a: any) => a.id), ["claudeAgent", "claude-org"]);
  assert.ok(!raw.includes("@"));
  writeFileSync(join(s.state, "config.json"), raw.replace('"everyMinutes": 15', '"everyMinutes": 30'));
  assert.equal(await accountsCommand(["--init"], s.io, { home: s.home }), 2);
  assert.match(s.err(), /--force/);
  assert.match(readFileSync(join(s.state, "config.json"), "utf8"), /30/);
  assert.equal(await accountsCommand(["--init", "--force"], s.io, { home: s.home }), 0);
  assert.match(readFileSync(join(s.state, "config.json"), "utf8"), /15/);
});

test("accounts --apply without --yes on a non-TTY exits 2 before connecting", async () => {
  const s = setup();
  let connected = 0;
  const code = await accountsCommand(["--apply"], s.io, { home: s.home, connect: async () => { connected++; return fake([]).api; } });
  assert.equal(code, 2);
  assert.equal(connected, 0);
});

test("accounts --apply --yes creates the missing instance, journals it, second run does nothing", async () => {
  const s = setup();
  await accountsCommand(["--init"], s.io, { home: s.home });
  const f = fake([inst("claudeAgent", join(s.home, ".claude"))], ["claudeAgent"]);
  assert.equal(await accountsCommand(["--apply", "--yes"], s.io, deps(s, f)), 0);
  assert.equal(f.calls.filter((c) => c.startsWith("add:")).length, 1);
  assert.match(s.out(), /created.*claude-org/is);
  const lines = readFileSync(join(s.state, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.t), ["instance-created"]);
  assert.equal(existsSync(join(s.state, "lock")), false, "lock released");
  f.calls.length = 0;
  assert.equal(await accountsCommand(["--apply", "--yes"], s.io, deps(s, f)), 0);
  assert.ok(!f.calls.some((c) => c.startsWith("add:")));
});

test("accounts --apply interactive: shows the list first; 'no' changes nothing", async () => {
  const s = setup({ tty: true, answer: "no" });
  await accountsCommand(["--init"], s.io, { home: s.home });
  const f = fake([inst("claudeAgent", join(s.home, ".claude"))], ["claudeAgent"]);
  assert.equal(await accountsCommand(["--apply"], s.io, deps(s, f)), 0);
  assert.match(s.out(), /claude-org/);
  assert.equal(s.prompts.length, 1);
  assert.ok(!f.calls.some((c) => c.startsWith("add:")));
});

test("accounts --apply on drift: InstanceHomeDrift (exit 2 via main), nothing written", async () => {
  const s = setup();
  await accountsCommand(["--init"], s.io, { home: s.home });
  const f = fake([inst("claudeAgent", join(s.home, ".claude-org"))]);
  await assert.rejects(accountsCommand(["--apply", "--yes"], s.io, deps(s, f)), InstanceHomeDrift);
  assert.deepEqual(f.calls, []);
  assert.equal(existsSync(join(s.state, "lock")), false, "lock released");
  void main;
});

test("accounts --rename updates T3 and config, journals instance-updated; bad color exits 2", async () => {
  const s = setup();
  await accountsCommand(["--init"], s.io, { home: s.home });
  const calls: any[] = [];
  const api = { ...fake([inst("claude-org", join(s.home, ".claude-org"))]).api, updateInstanceAppearance: async (id: string, a: any) => { calls.push([id, a]); return { previous: { driver: "claudeAgent", displayName: "old" }, changed: true }; } } as unknown as T3Api;
  assert.equal(await accountsCommand(["--rename", "claude-org", "Claude · Work", "--color", "#7C3AED"], s.io, { home: s.home, connect: async () => api }), 0);
  assert.deepEqual(calls, [["claude-org", { displayName: "Claude · Work", accentColor: "#7C3AED" }]]);
  const cfg = JSON.parse(readFileSync(join(s.state, "config.json"), "utf8"));
  const a = cfg.accounts.find((x: any) => x.id === "claude-org");
  assert.equal(a.displayName, "Claude · Work");
  assert.equal(a.accentColor, "#7C3AED");
  const lines = readFileSync(join(s.state, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].t, "instance-updated");
  assert.equal(await accountsCommand(["--rename", "claude-org", "X", "--color", "red"], s.io, { home: s.home, connect: async () => api }), 2);
  assert.equal(calls.length, 1);
});

test("--apply and --rename with the lock held: exit 0, 'in progress', and NO T3 connection", async () => {
  for (const argv of [["--apply", "--yes"], ["--rename", "claude-org", "X"]]) {
    const s = setup();
    await accountsCommand(["--init"], s.io, { home: s.home });
    const { acquireLock } = await import("../../src/core/lock.ts");
    const held = await acquireLock(s.state);
    assert.ok(held);
    let connected = 0;
    try {
      assert.equal(await accountsCommand(argv, s.io, { home: s.home, connect: async () => { connected++; return fake([]).api; } }), 0);
    } finally { await held!.release(); }
    assert.equal(connected, 0);
    assert.match(s.out(), /Another t3sm run is in progress\./);
  }
});

test("--rename of an id T3 does not know: exit-2 style ConfigError, nothing written", async () => {
  const s = setup();
  await accountsCommand(["--init"], s.io, { home: s.home });
  const calls: any[] = [];
  const api = { ...fake([inst("claudeAgent", join(s.home, ".claude"))]).api, updateInstanceAppearance: async (...a: any[]) => { calls.push(a); return { previous: null, changed: true }; } } as unknown as T3Api;
  const io2 = { ...s.io };
  const { ConfigError } = await import("../../src/core/config.ts");
  await assert.rejects(accountsCommand(["--rename", "claude-org", "X"], io2, { home: s.home, connect: async () => api }), (e: Error) => e instanceof ConfigError && /No T3 Code instance named claude-org\. Run `t3sm accounts` to list them\./.test(e.message));
  assert.equal(calls.length, 0);
  assert.equal(existsSync(join(s.state, "lock")), false);
});

test("--rename never pins a drifted home: claudeAgent implicit+drifted -> InstanceHomeDrift; other implicit id with another home -> refused; no write", async () => {
  const s = setup();
  await accountsCommand(["--init"], s.io, { home: s.home });
  const calls: any[] = [];
  const mk = (instances: ProviderInstanceInfo[]) => ({ ...fake(instances).api, updateInstanceAppearance: async (...a: any[]) => { calls.push(a); return { previous: null, changed: true }; } }) as unknown as T3Api;
  const drifted = mk([inst("claudeAgent", join(s.home, ".claude-org"))]);
  await assert.rejects(accountsCommand(["--rename", "claudeAgent", "Claude · Pessoal"], s.io, { home: s.home, connect: async () => drifted }), InstanceHomeDrift);
  const other = mk([inst("claude-org", join(s.home, ".claude-elsewhere"))]);
  await assert.rejects(accountsCommand(["--rename", "claude-org", "X"], s.io, { home: s.home, connect: async () => other }), /Refusing to rename claude-org/);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(join(s.state, "lock")), false);
  // implicit with the right home is allowed
  const ok = mk([inst("claudeAgent", join(s.home, ".claude"))]);
  assert.equal(await accountsCommand(["--rename", "claudeAgent", "Claude · Pessoal"], s.io, { home: s.home, connect: async () => ok }), 0);
  assert.equal(calls.length, 1);
});

test("journal never stores environment or other config keys: pin and rename of entries holding a secret", async () => {
  const secretEntry = { driver: "claudeAgent", displayName: "Old", accentColor: "#111111", environment: [{ name: "API_KEY", value: "sekret", sensitive: false }], config: { homePath: O, binaryPath: "C:\bin\sekret.exe" } };
  const f = fake([inst("claudeAgent", P)]);
  f.api.pinInstanceHome = async () => ({ previous: secretEntry, changed: true });
  const { j, dir, entries } = journal();
  await ensureInstances(f.api, [spec("claudeAgent", P)], j, "r1");
  assert.deepEqual((await entries())[0], { t: "instance-pinned", runId: "r1", instanceId: "claudeAgent", previous: { homePath: O }, next: { homePath: P } });

  const s = setup();
  await accountsCommand(["--init"], s.io, { home: s.home });
  const api = { ...fake([inst("claude-org", join(s.home, ".claude-org"))], ["claude-org"]).api, updateInstanceAppearance: async () => ({ previous: secretEntry, changed: true }) } as unknown as T3Api;
  assert.equal(await accountsCommand(["--rename", "claude-org", "New", "--color", "#7C3AED"], s.io, { home: s.home, connect: async () => api }), 0);
  const raw = readFileSync(join(s.state, "journal.jsonl"), "utf8");
  assert.ok(!raw.includes("sekret") && !raw.includes("API_KEY") && !raw.includes("binaryPath"));
  const e = JSON.parse(raw.trim().split("\n")[0]!);
  assert.deepEqual(e.previous, { displayName: "Old", accentColor: "#111111", homePath: O });
  assert.deepEqual(Object.keys(e.next).sort(), ["accentColor", "displayName", "homePath"]);
  assert.ok(!readFileSync(join(dir, "journal.jsonl"), "utf8").includes("sekret"));
});

test("accounts: 'Found via' column per account, and a warning for a discovered home missing from config.json", async () => {
  const s = setup();
  mkdirSync(join(s.home, "accts", "work", "projects"), { recursive: true });
  writeFileSync(join(s.home, ".bashrc"), "alias claude-org=\"CLAUDE_CONFIG_DIR=~/.claude-org claude\"\nalias cw='CLAUDE_CONFIG_DIR=~/accts/work claude'\n");
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, "config.json"), JSON.stringify({
    version: 1, accounts: [
      { id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null },
      { id: "claude-org", home: "~/.claude-org", displayName: "Org", accentColor: null },
    ], defaultAccount: "claudeAgent", routes: [], remap: [], exclude: [], includeBackups: false,
    batch: { filesPerProject: 50, projectsPerWave: 5 }, schedule: { everyMinutes: 15 }, sync: { autoMerge: true, watchDebounceMs: 30000 },
  }));
  const f = fake([inst("claudeAgent", join(s.home, ".claude"), { email: "me@x.com" })]);
  assert.equal(await accountsCommand([], s.io, deps(s, f)), 0);
  const o = s.out();
  assert.match(o.split("\n")[0]!, /Found via/);
  assert.match(o, /claudeAgent.*default/);
  assert.match(o, /claude-org.*folder, shell-profile \(claude-org\)/);
  assert.match(o, /Found ~\/accts\/work \(shell-profile \(cw\)\) but it is not in config\.json/);
  assert.ok(!o.includes(s.home), "home shown ~-relative");
});

test("accounts --init writes every discovered account (alias ids), never emails", async () => {
  const s = setup();
  mkdirSync(join(s.home, "accts", "work", "projects"), { recursive: true });
  mkdirSync(join(s.home, "Documents", "PowerShell"), { recursive: true });
  writeFileSync(join(s.home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"), "function claude-work {\n  $env:CLAUDE_CONFIG_DIR = \"$HOME\\accts\\work\"\n  claude $args\n}\n");
  assert.equal(await accountsCommand(["--init"], { ...s.io, env: { ...s.io.env, CLAUDE_CONFIG_DIR: join(s.home, ".claude-org") } }, { home: s.home }), 0);
  const raw = readFileSync(join(s.state, "config.json"), "utf8");
  assert.deepEqual(JSON.parse(raw).accounts.map((a: any) => a.id), ["claudeAgent", "claude-org", "claude-work"]);
  assert.ok(!raw.includes("@"));
});

test("journal file is created owner-only (0o600; ignored on win32)", { skip: process.platform === "win32" }, async () => {
  const { statSync } = await import("node:fs");
  const { j } = journal();
  await j.append({ t: "run-start", runId: "r", at: "x", command: "c" });
  assert.equal(statSync(j.file).mode & 0o777, 0o600);
});

test("B2: the account whose home is ~/.claude under a custom id pins claudeAgent (matched by home), never a second instance", async () => {
  const f = fake([inst("claudeAgent", P)]);
  const { j, entries } = journal();
  const r = await ensureInstances(f.api, [spec("personal", P), spec("work", O)], j, "r1", P);
  assert.deepEqual(r.pinned, ["claudeAgent"]);
  assert.deepEqual(r.created, ["work"]);
  assert.ok(!f.calls.some((c) => c.startsWith("add:personal")), "no second instance for ~/.claude");
  assert.equal((await entries()).filter((e) => e.t === "instance-pinned").length, 1);
});

test("B2: drift with a custom id for ~/.claude -> InstanceHomeDrift before any write", async () => {
  const f = fake([inst("claudeAgent", O)]);
  const { j, entries } = journal();
  await assert.rejects(ensureInstances(f.api, [spec("personal", P)], j, "r1", P), InstanceHomeDrift);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await entries(), []);
});
