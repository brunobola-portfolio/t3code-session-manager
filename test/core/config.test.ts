import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError, defaultConfig, detectAccounts, expandConfig, loadConfig, resolveRemap, routeAccount, saveConfig, validateConfig,
} from "../../src/core/config.ts";
import type { AccountConfig, Config, InstanceSpec } from "../../src/core/types.ts";

const accounts: AccountConfig[] = [
  { id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null },
  { id: "claude-org", home: "~/.claude-org", displayName: "Claude · org", accentColor: "#00AAFF" },
];

function cfg(over: Partial<Config> = {}): Config {
  return { ...defaultConfig(accounts), ...over };
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "t3sm-cfg-"));
}

test("defaultConfig: exact defaults", () => {
  const c = defaultConfig(accounts);
  assert.deepEqual(c, {
    version: 1, accounts, defaultAccount: "claudeAgent", routes: [], remap: [], exclude: [], includeBackups: false,
    batch: { filesPerProject: 50, projectsPerWave: 5 }, schedule: { everyMinutes: 15 },
    sync: { autoMerge: false, watchDebounceMs: 30_000, maxUnattendedImports: 200 },
  });
});

test("validateConfig: sync.autoMerge is optional and defaults to false", () => {
  const r = validateConfig({ ...cfg(), sync: { watchDebounceMs: 30_000 } });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.config.sync.autoMerge, false);
});

test("validateConfig: sync.maxUnattendedImports is optional (default 200) and validated 1..100000", () => {
  for (const n of [1, 200, 100_000]) assert.equal(validateConfig(cfg({ sync: { autoMerge: true, watchDebounceMs: 30_000, maxUnattendedImports: n } })).ok, true);
  for (const n of [0, 100_001, 1.5, "200"]) {
    assert.ok(errorsOf(cfg({ sync: { autoMerge: true, watchDebounceMs: 30_000, maxUnattendedImports: n as number } })).some((e) => e.startsWith("sync.maxUnattendedImports:")), String(n));
  }
  assert.equal(validateConfig(cfg({ sync: { autoMerge: true, watchDebounceMs: 30_000 } })).ok, true, "older config.json without the field");
});

test("validateConfig: codex.convertCompressed is optional (absent = convert) and must be a boolean", () => {
  const r = validateConfig(cfg());
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.config.codex?.convertCompressed ?? true, true, "absent: compressed Codex sessions are converted");
  for (const v of [true, false]) {
    const ok = validateConfig({ ...cfg(), codex: { convertCompressed: v } });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.config.codex?.convertCompressed, v);
  }
  assert.equal(validateConfig({ ...cfg(), codex: {} }).ok, true);
  assert.ok(errorsOf({ ...cfg(), codex: { convertCompressed: "no" } }).includes("codex.convertCompressed: must be a boolean"));
  assert.ok(errorsOf({ ...cfg(), codex: [] }).includes("codex: must be an object"));
  assert.ok(errorsOf({ ...cfg(), codex: null }).includes("codex: must be an object"));
});

test("validateConfig: default config is valid", () => {
  const r = validateConfig(defaultConfig(accounts));
  assert.equal(r.ok, true);
});

function errorsOf(u: unknown, platform?: NodeJS.Platform): string[] {
  const r = validateConfig(u, platform);
  assert.equal(r.ok, false);
  return r.ok ? [] : r.errors;
}

test("validateConfig: unknown account in routes", () => {
  const errs = errorsOf(cfg({ routes: [{ match: "D:/x/**", account: "x" }] }));
  assert.ok(errs.includes('routes[0].account: unknown account "x"'), errs.join("|"));
});

test("validateConfig: duplicate homes after expandHome + normalizeCwd", () => {
  const dup = [
    { id: "a", home: "C:\\Users\\u\\.claude", displayName: "A", accentColor: null },
    { id: "b", home: "C:/Users/u/.claude/", displayName: "B", accentColor: null },
  ];
  const errs = errorsOf({ ...defaultConfig(dup), accounts: dup }, "win32");
  assert.ok(errs.some((e) => e.startsWith("accounts[1].home:") && e.includes("duplicate")), errs.join("|"));
});

test("validateConfig: defaultAccount must exist", () => {
  const errs = errorsOf(cfg({ defaultAccount: "nope" }));
  assert.ok(errs.some((e) => e.startsWith("defaultAccount:")), errs.join("|"));
});

test("validateConfig: batch ranges", () => {
  assert.ok(errorsOf(cfg({ batch: { filesPerProject: 0, projectsPerWave: 5 } })).some((e) => e.startsWith("batch.filesPerProject:")));
  assert.ok(errorsOf(cfg({ batch: { filesPerProject: 101, projectsPerWave: 5 } })).some((e) => e.startsWith("batch.filesPerProject:")));
  assert.ok(errorsOf(cfg({ batch: { filesPerProject: 50, projectsPerWave: 51 } })).some((e) => e.startsWith("batch.projectsPerWave:")));
  assert.ok(errorsOf(cfg({ batch: { filesPerProject: 1.5, projectsPerWave: 5 } })).some((e) => e.startsWith("batch.filesPerProject:")));
  assert.equal(validateConfig(cfg({ batch: { filesPerProject: 100, projectsPerWave: 50 } })).ok, true);
});

test("validateConfig: account id format and accent colour", () => {
  const bad = [
    { id: "1bad", home: "~/.a", displayName: "A", accentColor: null },
    { id: "ok", home: "~/.b", displayName: "B", accentColor: "red" },
  ];
  const errs = errorsOf({ ...defaultConfig(bad), accounts: bad, defaultAccount: "ok" });
  assert.ok(errs.some((e) => e.startsWith("accounts[0].id:")), errs.join("|"));
  assert.ok(errs.some((e) => e.startsWith("accounts[1].accentColor:")), errs.join("|"));
  const long = [{ id: "a".repeat(65), home: "~/.a", displayName: "A", accentColor: null }];
  assert.ok(errorsOf({ ...defaultConfig(long), accounts: long }).some((e) => e.startsWith("accounts[0].id:")));
});

test("validateConfig: sync, schedule, version, strings", () => {
  assert.ok(errorsOf(cfg({ sync: { autoMerge: "yes" as unknown as boolean, watchDebounceMs: 30_000 } })).some((e) => e.startsWith("sync.autoMerge:")));
  assert.ok(errorsOf(cfg({ sync: { autoMerge: true, watchDebounceMs: 999 } })).some((e) => e.startsWith("sync.watchDebounceMs:")));
  assert.ok(errorsOf(cfg({ sync: { autoMerge: true, watchDebounceMs: 600_001 } })).some((e) => e.startsWith("sync.watchDebounceMs:")));
  assert.ok(errorsOf(cfg({ schedule: { everyMinutes: 0 } })).some((e) => e.startsWith("schedule.everyMinutes:")));
  assert.ok(errorsOf(cfg({ schedule: { everyMinutes: 1441 } })).some((e) => e.startsWith("schedule.everyMinutes:")));
  assert.ok(errorsOf({ ...cfg(), version: 2 }).some((e) => e.startsWith("version:")));
  assert.ok(errorsOf(cfg({ exclude: [""] })).some((e) => e.startsWith("exclude[0]:")));
  assert.ok(errorsOf(cfg({ routes: [{ match: "", account: "claudeAgent" }] })).some((e) => e.startsWith("routes[0].match:")));
  assert.ok(errorsOf(cfg({ remap: [{ from: "", to: "x" }] })).some((e) => e.startsWith("remap[0].from:")));
  assert.ok(errorsOf(cfg({ remap: [{ from: "x", to: "" }] })).some((e) => e.startsWith("remap[0].to:")));
});

test("validateConfig: only version, accounts and defaultAccount are required; the rest defaults to defaultConfig", () => {
  const r = validateConfig({ version: 1, accounts, defaultAccount: "claude-org" });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.config, { ...defaultConfig(accounts), defaultAccount: "claude-org" });
  const missing = errorsOf({ version: 1 });
  assert.ok(missing.includes("accounts: must be an array"), missing.join("|"));
  assert.ok(missing.some((e) => e.startsWith("defaultAccount:")), missing.join("|"));
  assert.ok(errorsOf({ accounts, defaultAccount: "claudeAgent" }).includes("version: must be 1"));
});

test("validateConfig: partial nested objects are deep-merged with the defaults, per field", () => {
  const r = validateConfig({ version: 1, accounts, defaultAccount: "claudeAgent", sync: { autoMerge: true }, batch: { projectsPerWave: 2 }, schedule: {}, exclude: ["**/tmp/**"] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.config.sync, { autoMerge: true, watchDebounceMs: 30_000, maxUnattendedImports: 200 });
  assert.deepEqual(r.config.batch, { filesPerProject: 50, projectsPerWave: 2 });
  assert.deepEqual(r.config.schedule, { everyMinutes: 15 });
  assert.deepEqual(r.config.exclude, ["**/tmp/**"]);
  assert.deepEqual(r.config.routes, []);
  assert.equal(r.config.includeBackups, false);
});

test("validateConfig: a present key is still type- and bounds-checked with the same field paths", () => {
  const base = { version: 1, accounts, defaultAccount: "claudeAgent" };
  assert.ok(errorsOf({ ...base, routes: "x" }).includes("routes: must be an array"));
  assert.ok(errorsOf({ ...base, remap: {} }).includes("remap: must be an array"));
  assert.ok(errorsOf({ ...base, exclude: null }).includes("exclude: must be an array"));
  assert.ok(errorsOf({ ...base, includeBackups: "no" }).includes("includeBackups: must be a boolean"));
  assert.ok(errorsOf({ ...base, batch: [] }).includes("batch: must be an object"));
  assert.ok(errorsOf({ ...base, batch: { filesPerProject: 0 } }).some((e) => e.startsWith("batch.filesPerProject:")));
  assert.ok(errorsOf({ ...base, schedule: { everyMinutes: 0 } }).some((e) => e.startsWith("schedule.everyMinutes:")));
  assert.ok(errorsOf({ ...base, sync: null }).includes("sync: must be an object"));
  assert.ok(errorsOf({ ...base, sync: { watchDebounceMs: 5 } }).some((e) => e.startsWith("sync.watchDebounceMs:")));
  assert.ok(errorsOf({ ...base, sync: { autoMerge: 1 } }).some((e) => e.startsWith("sync.autoMerge:")));
  assert.ok(errorsOf({ ...base, routes: [{ match: "D:/x/**", account: "x" }] }).includes('routes[0].account: unknown account "x"'));
});

test("loadConfig: a minimal file loads with defaults; saveConfig writes every key explicitly", async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, "config.json"), JSON.stringify({ version: 1, accounts, defaultAccount: "claudeAgent", sync: { autoMerge: true } }));
    const c = await loadConfig(dir, "/home/demo");
    assert.deepEqual(c, expandConfig({ ...defaultConfig(accounts), sync: { autoMerge: true, watchDebounceMs: 30_000, maxUnattendedImports: 200 } }, "/home/demo"));
    await saveConfig(dir, c!);
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    assert.deepEqual(Object.keys(raw).sort(), ["accounts", "batch", "defaultAccount", "exclude", "includeBackups", "remap", "routes", "schedule", "sync", "version"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateConfig: non-object input", () => {
  assert.equal(validateConfig(null).ok, false);
  assert.equal(validateConfig([]).ok, false);
});

test("routeAccount: first matching glob, case-insensitive on win32", () => {
  const c = cfg({ routes: [{ match: "D:/Projects/**", account: "claude-org" }] });
  assert.equal(routeAccount("d:/Projects/X", c, "win32"), "claude-org");
  assert.equal(routeAccount("D:/Projects", c, "win32"), "claude-org");
  assert.equal(routeAccount("D:\\Projects\\X\\", c, "win32"), "claude-org");
  assert.equal(routeAccount("D:/Other/X", c, "win32"), null);
});

test("routeAccount: first match wins", () => {
  const c = cfg({ routes: [
    { match: "/w/a/**", account: "claude-org" },
    { match: "/w/**", account: "claudeAgent" },
  ] });
  assert.equal(routeAccount("/w/a/x", c, "linux"), "claude-org");
  assert.equal(routeAccount("/w/b", c, "linux"), "claudeAgent");
});

test("resolveRemap: prefix swap", () => {
  const c = cfg({ remap: [{ from: "D:/Old", to: "E:/New" }] });
  assert.deepEqual(resolveRemap("D:/Old/App/src", c, "win32"), { cwd: "E:/New/App/src", remapped: true });
  assert.deepEqual(resolveRemap("D:/Old", c, "win32"), { cwd: "E:/New", remapped: true });
});

test("resolveRemap: whole segments only, case-insensitive on win32", () => {
  const c = cfg({ remap: [{ from: "D:/Old", to: "E:/New" }] });
  assert.deepEqual(resolveRemap("D:/Older/App", c, "win32"), { cwd: "D:/Older/App", remapped: false });
  assert.deepEqual(resolveRemap("d:\\old\\App", c, "win32"), { cwd: "E:/New/App", remapped: true });
  assert.equal(resolveRemap("/Old/x", cfg({ remap: [{ from: "/old", to: "/n" }] }), "linux").remapped, false);
});

test("resolveRemap: first matching entry wins; no match is identity", () => {
  const c = cfg({ remap: [{ from: "/a", to: "/b" }, { from: "/a/x", to: "/c" }] });
  assert.deepEqual(resolveRemap("/a/x/y", c, "linux"), { cwd: "/b/x/y", remapped: true });
  assert.deepEqual(resolveRemap("/z", c, "linux"), { cwd: "/z", remapped: false });
});

test("detectAccounts: .claude, .claude-org with projects, skips .claude-empty", async () => {
  const home = await tmp();
  try {
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".claude-org", "projects"), { recursive: true });
    await mkdir(join(home, ".claude-empty"), { recursive: true });
    const found = await detectAccounts(home, []);
    assert.deepEqual(found.map((a) => [a.id, a.displayName, a.accentColor]), [
      ["claudeAgent", "Claude", null],
      ["claude-org", "Claude · org", null],
    ]);
    assert.equal(found[0]!.home, join(home, ".claude"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("detectAccounts: sanitizes ids", async () => {
  const home = await tmp();
  try {
    await mkdir(join(home, ".claude-my acct!", "projects"), { recursive: true });
    await mkdir(join(home, ".claude-" + "x".repeat(80), "projects"), { recursive: true });
    const found = await detectAccounts(home, []);
    const ids = found.map((a) => a.id);
    assert.ok(ids.includes("claude-myacct"), ids.join());
    for (const id of ids) assert.match(id, /^[a-zA-Z][a-zA-Z0-9_-]*$/);
    for (const id of ids) assert.ok(id.length <= 64);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("detectAccounts: existing instance keeps id, displayName, accent", async () => {
  const home = await tmp();
  try {
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".claude-org", "projects"), { recursive: true });
    const existing: InstanceSpec[] = [{
      id: "work", driver: "claudeAgent", displayName: "Trabalho", accentColor: "#112233",
      homePath: join(home, ".claude-org").replace(/\\/g, "/") + "/", environment: [],
    }];
    const found = await detectAccounts(home, existing);
    const org = found.find((a) => a.home === join(home, ".claude-org"));
    assert.ok(org);
    assert.deepEqual([org.id, org.displayName, org.accentColor], ["work", "Trabalho", "#112233"]);
    assert.equal(found[0]!.id, "claudeAgent");
    assert.deepEqual(found.map((a) => a.id), ["claudeAgent", "work"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("loadConfig: missing file is null; save then load round-trips", async () => {
  const dir = await tmp();
  try {
    assert.equal(await loadConfig(dir), null);
    const c = cfg();
    await saveConfig(dir, c);
    assert.deepEqual(await loadConfig(dir, "/home/demo"), expandConfig(c, "/home/demo"), "loaded with ~ expanded");
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(dir, "config.json"), "utf8");
    assert.equal(raw, JSON.stringify(c, null, 2) + "\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig: invalid JSON names the file and position", async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, "config.json"), '{ "version": 1,\n  oops }');
    await assert.rejects(loadConfig(dir), (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.ok(e.message.includes("config.json"), e.message);
      assert.match(e.message, /line \d+|position \d+/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig: schema-invalid lists the errors", async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, "config.json"), JSON.stringify({ ...cfg(), defaultAccount: "nope" }));
    await assert.rejects(loadConfig(dir), (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.ok(e.message.includes("defaultAccount"), e.message);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateConfig: accepts a valid non-default config", () => {
  const c: Config = {
    version: 1, accounts, defaultAccount: "claude-org",
    routes: [{ match: "D:/Projects/**", account: "claude-org" }, { match: "/w/*", account: "claudeAgent" }],
    remap: [{ from: "D:/Old", to: "E:/New" }], exclude: ["**/node_modules/**"], includeBackups: true,
    batch: { filesPerProject: 10, projectsPerWave: 2 }, schedule: { everyMinutes: 30 },
    sync: { autoMerge: false, watchDebounceMs: 5000 },
  };
  const r = validateConfig(c);
  assert.equal(r.ok, true);
});

test("validateConfig: positive boundaries", () => {
  for (const ms of [1000, 600_000]) assert.equal(validateConfig(cfg({ sync: { autoMerge: true, watchDebounceMs: ms } })).ok, true);
  for (const m of [1, 1440]) assert.equal(validateConfig(cfg({ schedule: { everyMinutes: m } })).ok, true);
  for (const f of [1, 100]) assert.equal(validateConfig(cfg({ batch: { filesPerProject: f, projectsPerWave: 5 } })).ok, true);
  for (const p of [1, 50]) assert.equal(validateConfig(cfg({ batch: { filesPerProject: 50, projectsPerWave: p } })).ok, true);
});

test("validateConfig: whitespace-only exclude and match are rejected", () => {
  assert.ok(errorsOf(cfg({ exclude: ["   "] })).some((e) => e.startsWith("exclude[0]:")));
  assert.ok(errorsOf(cfg({ routes: [{ match: " \t", account: "claudeAgent" }] })).some((e) => e.startsWith("routes[0].match:")));
});

test("validateConfig: duplicate homes, case variants on win32 and ~ vs absolute", () => {
  const w = [
    { id: "a", home: "C:/Users/U/.claude", displayName: "A", accentColor: null },
    { id: "b", home: "c:\\users\\u\\.claude\\", displayName: "B", accentColor: null },
  ];
  const r = validateConfig({ ...defaultConfig(w), accounts: w }, "win32", "C:/Users/U");
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.startsWith("accounts[1].home:")));
  const t = [
    { id: "a", home: "~/.claude", displayName: "A", accentColor: null },
    { id: "b", home: "/home/u/.claude", displayName: "B", accentColor: null },
  ];
  const r2 = validateConfig({ ...defaultConfig(t), accounts: t }, "linux", "/home/u");
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.ok(r2.errors.some((e) => e.startsWith("accounts[1].home:")));
});

test("resolveRemap: trailing slash, drive roots, posix root", () => {
  assert.deepEqual(resolveRemap("D:/Old/App", cfg({ remap: [{ from: "D:/Old/", to: "E:/New" }] }), "win32"), { cwd: "E:/New/App", remapped: true });
  assert.deepEqual(resolveRemap("D:/Old/App", cfg({ remap: [{ from: "D:/", to: "E:/" }] }), "win32"), { cwd: "E:/Old/App", remapped: true });
  assert.deepEqual(resolveRemap("D:/", cfg({ remap: [{ from: "D:/", to: "E:/" }] }), "win32"), { cwd: "E:/", remapped: true });
  assert.deepEqual(resolveRemap("/a/b", cfg({ remap: [{ from: "/", to: "/mnt" }] }), "linux"), { cwd: "/mnt/a/b", remapped: true });
});

test("detectAccounts: file named .claude-x ignored; missing home gives []", async () => {
  const home = await tmp();
  try {
    await writeFile(join(home, ".claude-x"), "not a dir");
    assert.deepEqual(await detectAccounts(home, []), []);
    assert.deepEqual(await detectAccounts(join(home, "does-not-exist"), []), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ConfigError messages carry the recovery hint", async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, "config.json"), "{");
    await assert.rejects(loadConfig(dir), /t3sm accounts --init/);
    await writeFile(join(dir, "config.json"), JSON.stringify({ ...cfg(), defaultAccount: "nope" }));
    await assert.rejects(loadConfig(dir), /t3sm accounts --init/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig expands ~ in account homes, remap and leading-~ globs; saveConfig writes back what the user wrote", async () => {
  const dir = await tmp();
  try {
    const home = process.platform === "win32" ? "C:\Users\demo" : "/home/demo";
    const user = {
      version: 1, defaultAccount: "claudeAgent",
      accounts: [{ id: "claudeAgent", home: "~/.claude", displayName: "Claude", accentColor: null }, { id: "org", home: `${home}/.claude-org`, displayName: "Org", accentColor: null }],
      routes: [{ match: "~/work/**", account: "org" }, { match: "**/x/**", account: "org" }],
      remap: [{ from: "~/old", to: "~/new" }],
      exclude: ["~/scratch/**", "C:/tmp/**"],
    };
    await writeFile(join(dir, "config.json"), JSON.stringify(user));
    const c = (await loadConfig(dir, home))!;
    const n = (p: string) => p.replaceAll("\\", "/");
    assert.equal(n(c.accounts[0]!.home), `${n(home)}/.claude`);
    assert.equal(c.accounts[1]!.home, `${home}/.claude-org`);
    assert.equal(n(c.routes[0]!.match), `${n(home)}/work/**`);
    assert.equal(c.routes[1]!.match, "**/x/**");
    assert.deepEqual([n(c.remap[0]!.from), n(c.remap[0]!.to)], [`${n(home)}/old`, `${n(home)}/new`]);
    assert.equal(n(c.exclude[0]!), `${n(home)}/scratch/**`);
    // A command that edits the config (accounts --rename) and saves it keeps the user's spelling of every path.
    await saveConfig(dir, { ...c, accounts: c.accounts.map((a) => (a.id === "org" ? { ...a, displayName: "Work" } : a)) }, home);
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    assert.equal(raw.accounts[0].home, "~/.claude");
    assert.equal(raw.accounts[1].displayName, "Work");
    assert.equal(raw.routes[0].match, "~/work/**");
    assert.deepEqual(raw.remap, [{ from: "~/old", to: "~/new" }]);
    assert.deepEqual(raw.exclude, ["~/scratch/**", "C:/tmp/**"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
