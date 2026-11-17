import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError, HISTORY_V2, applyOrganizePatch, defaultConfig, detectAccounts, expandConfig, historyRule, isDecided, legacyHistory, loadConfig, organizeSettings, resolveRemap, routeAccount, saveConfig, updateAuto, validateConfig,
} from "../../src/core/config.ts";
import type { AccountConfig, Config, InstanceSpec, OrganizeConfig } from "../../src/core/types.ts";

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

test("organizeSettings fills spec defaults", () => {
  const want = {
    folders: { home: "rehome", "t3-refused": "rehome", temp: "skip", system: "skip" },
    sessions: { automated: "skip", orphaned: "copy" },
    overrides: [],
    names: { maxLength: 40 },
    history: { days: 90, minPerProject: 10 },
    titles: true,
    aiTitles: { enabled: false, maxPerRun: 50 },
    archiveAutomated: true,
    pinRecent: { enabled: true, count: 5 },
    decided: [],
  };
  assert.deepEqual(organizeSettings(cfg(), "pt"), { ...want, generalFolder: "~/T3 Geral" });
  assert.deepEqual(organizeSettings(cfg(), "en"), { ...want, generalFolder: "~/T3 General" });
  assert.equal(cfg().organize, undefined, "organize stays optional: defaultConfig does not write it");
});

test("organizeSettings: partial values override per field; lang only picks the default generalFolder", () => {
  const c = cfg({
    organize: { folders: { temp: "import" } as OrganizeConfig["folders"], names: { maxLength: 60 }, pinRecent: { count: 3 } as OrganizeConfig["pinRecent"], generalFolder: "~/Mine" },
  });
  const s = organizeSettings(c, "pt");
  assert.equal(s.folders.temp, "import");
  assert.equal(s.folders.home, "rehome");
  assert.equal(s.names.maxLength, 60);
  assert.deepEqual(s.pinRecent, { enabled: true, count: 3 });
  assert.equal(s.generalFolder, "~/Mine");
  assert.deepEqual(organizeSettings(cfg({ organize: { aiTitles: { enabled: true } } }), "en").aiTitles, { enabled: true, maxPerRun: 50 });
});

test("validateConfig: organize and notify are optional and accept valid values", () => {
  const organize = {
    folders: { home: "import", "t3-refused": "skip", temp: "rehome", system: "skip" },
    sessions: { automated: "import", orphaned: "skip" },
    generalFolder: "~/T3 Geral",
    overrides: [{ match: "C:/work/demo/**", action: "skip" }, { match: "~/code/app", action: "rehome:~/code/hub" }, { match: "x", action: "import" }],
    names: { maxLength: 16 },
    history: "days:90",
    titles: false, archiveAutomated: false,
    aiTitles: { enabled: true, maxPerRun: 500 },
    pinRecent: { enabled: false, count: 20 },
    decided: ["home", "notify"],
  };
  for (const notify of ["attention", "all", "off"]) assert.equal(validateConfig({ ...cfg(), organize, notify }).ok, true, notify);
  for (const history of ["all", "off", "days:1"]) assert.equal(validateConfig({ ...cfg(), organize: { history } }).ok, true, history);
  assert.equal(validateConfig({ ...cfg(), organize: {} }).ok, true);
  assert.equal(validateConfig(cfg()).ok, true);
});

test("validateConfig: update.auto is optional, a boolean, on by default", () => {
  for (const update of [{ auto: true }, { auto: false }, {}]) assert.equal(validateConfig({ ...cfg(), update }).ok, true, JSON.stringify(update));
  assert.ok(errorsOf({ ...cfg(), update: { auto: "no" } }).includes("update.auto: must be a boolean"));
  assert.ok(errorsOf({ ...cfg(), update: true }).includes("update: must be an object"));
  assert.equal(updateAuto(cfg()), true);
  assert.equal(updateAuto(null), true);
  assert.equal(updateAuto(cfg({ update: { auto: false } })), false);
  const r = validateConfig({ ...cfg(), update: { auto: false } });
  assert.ok(r.ok && r.config.update?.auto === false, "kept as written");
});

test("validateConfig rejects bad organize values", () => {
  const bad: [unknown, string][] = [
    [{ names: { maxLength: 8 } }, "organize.names.maxLength"],
    [{ names: { maxLength: 121 } }, "organize.names.maxLength"],
    [{ history: "days:3651" }, "organize.history"],
    [{ history: "days:0" }, "organize.history"],
    [{ history: "weekly" }, "organize.history"],
    [{ pinRecent: { count: 0 } }, "organize.pinRecent.count"],
    [{ pinRecent: { count: 21 } }, "organize.pinRecent.count"],
    [{ pinRecent: { enabled: "yes" } }, "organize.pinRecent.enabled"],
    [{ aiTitles: true }, "organize.aiTitles"],
    [{ aiTitles: { enabled: "yes" } }, "organize.aiTitles.enabled"],
    [{ aiTitles: { maxPerRun: 0 } }, "organize.aiTitles.maxPerRun"],
    [{ aiTitles: { maxPerRun: 501 } }, "organize.aiTitles.maxPerRun"],
    [{ folders: { temp: "delete" } }, "organize.folders.temp"],
    [{ folders: { project: "skip" } }, "organize.folders.project"],
    [{ sessions: { automated: "maybe" } }, "organize.sessions.automated"],
    [{ sessions: { orphaned: "import" } }, "organize.sessions.orphaned"],
    [{ generalFolder: "" }, "organize.generalFolder"],
    [{ overrides: [{ match: "a", action: "rehome:" }] }, "organize.overrides[0].action"],
    [{ overrides: [{ match: "a", action: "move" }] }, "organize.overrides[0].action"],
    [{ overrides: [{ match: "", action: "skip" }] }, "organize.overrides[0].match"],
    [{ titles: "yes" }, "organize.titles"],
    [{ archiveAutomated: 1 }, "organize.archiveAutomated"],
    [{ decided: [1] }, "organize.decided[0]"],
    [[], "organize"],
  ];
  for (const [organize, key] of bad) {
    assert.ok(errorsOf({ ...cfg(), organize }).some((e) => e.startsWith(key + ":")), JSON.stringify(organize));
  }
  assert.ok(errorsOf({ ...cfg(), notify: "sometimes" }).some((e) => e.startsWith("notify:")));
});

test("validateConfig: a rehome:<folder> override must name an absolute folder T3 Code accepts as a project", () => {
  const home = "C:/Users/demo";
  const errs = (action: string): string[] => {
    const r = validateConfig({ ...cfg(), organize: { overrides: [{ match: "~", action }] } }, "win32", home);
    return r.ok ? [] : r.errors.filter((e) => e.startsWith("organize.overrides[0].action:"));
  };
  for (const ok of ["rehome:~/code/hub", "rehome:D:/work/app", "rehome:~/T3 General"]) assert.deepEqual(errs(ok), [], ok);
  for (const refused of ["rehome:~", "rehome:~/Downloads/x", "rehome:C:/Users/demo/Documents/Codex/y", "rehome:~/.t3/worktrees/z"]) {
    assert.deepEqual(errs(refused), [`organize.overrides[0].action: ${refused} is a folder T3 Code does not accept as a project (the home folder, Downloads, Documents/Codex, T3 Code's own folders or the temp folder itself)`], refused);
  }
  assert.deepEqual(errs("rehome:code/hub"), ["organize.overrides[0].action: rehome:code/hub must name an absolute folder (or one starting with ~)"]);
  const posix = validateConfig({ ...cfg(), organize: { overrides: [{ match: "~", action: "rehome:/tmp" }] } }, "linux", "/home/demo");
  assert.ok(!posix.ok && posix.errors.some((e) => e.includes("rehome:/tmp is a folder T3 Code does not accept")));
});

test("validateConfig: organize.generalFolder must be an absolute folder T3 Code accepts as a project (R25)", () => {
  const home = "C:/Users/demo";
  const errs = (generalFolder: string): string[] => {
    const r = validateConfig({ ...cfg(), organize: { generalFolder } }, "win32", home);
    return r.ok ? [] : r.errors.filter((e) => e.startsWith("organize.generalFolder:"));
  };
  for (const ok of ["~/T3 General", "~/T3 Geral", "D:/T3 General"]) assert.deepEqual(errs(ok), [], ok);
  assert.deepEqual(errs("T3 General"), ["organize.generalFolder: T3 General must name an absolute folder (or one starting with ~)"]);
  for (const refused of ["~", "~/Downloads/General", "~/.t3/General"]) {
    assert.deepEqual(errs(refused), [`organize.generalFolder: ${refused} is a folder T3 Code does not accept as a project (the home folder, Downloads, Documents/Codex, T3 Code's own folders or the temp folder itself)`], refused);
  }
});

test("loadConfig: a bad organize value is a ConfigError naming the key", async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, "config.json"), JSON.stringify({ ...cfg(), organize: { names: { maxLength: 8 } } }));
    await assert.rejects(loadConfig(dir, "/h", "linux"), (e: Error) => e instanceof ConfigError && e.message.includes("organize.names.maxLength"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("config round-trips organize with ~ kept as written", async () => {
  const dir = await tmp();
  try {
    const organize = { generalFolder: "~/T3 Geral", overrides: [{ match: "~/code/app", action: "rehome:~/code/hub" }], decided: ["home"] };
    await writeFile(join(dir, "config.json"), JSON.stringify({ ...cfg(), organize, notify: "off" }));
    const c = await loadConfig(dir, "/home/u", "linux");
    assert.equal(c?.organize?.generalFolder, "~/T3 Geral");
    assert.equal(c?.notify, "off");
    await saveConfig(dir, c!, "/home/u", "linux");
    const back = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    assert.deepEqual(back.organize, organize);
    assert.equal(back.notify, "off");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isDecided reads decided", () => {
  assert.equal(isDecided(cfg(), "home"), false);
  assert.equal(isDecided(cfg({ organize: {} }), "home"), false);
  const c = cfg({ organize: { decided: ["home", "notify"] } });
  assert.equal(isDecided(c, "home"), true);
  assert.equal(isDecided(c, "notify"), true);
  assert.equal(isDecided(c, "temp"), false);
});

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

test("applyOrganizePatch: only the answered fields change, nested objects merge, decided only grows, the input is untouched", () => {
  const c = cfg({ organize: { folders: { home: "skip" } as OrganizeConfig["folders"], titles: false, decided: ["home"], overrides: [{ match: "~/a", action: "skip" }] } });
  const before = JSON.stringify(c);
  const n = applyOrganizePatch(c, { folders: { temp: "import" }, decided: ["home", "temp"], pinRecent: { enabled: false }, history: "days:30" });
  assert.deepEqual(n.organize, {
    folders: { home: "skip", temp: "import" }, titles: false, decided: ["home", "temp"], overrides: [{ match: "~/a", action: "skip" }],
    pinRecent: { enabled: false }, history: "days:30",
  });
  assert.equal(JSON.stringify(c), before, "input not mutated");
  assert.equal(n.accounts, c.accounts, "the rest of the config is untouched");
  const fresh = applyOrganizePatch(cfg(), { sessions: { automated: "import" }, overrides: [{ match: "~/b", action: "rehome:~/c" }] });
  assert.deepEqual(fresh.organize, { sessions: { automated: "import" }, overrides: [{ match: "~/b", action: "rehome:~/c" }] });
  assert.equal(validateConfig(JSON.parse(JSON.stringify(n)), "linux", "/home/u").ok, true, "the result is a valid config");
});

test("defaults are 90 days and 10 per project", () => {
  assert.deepEqual(historyRule(cfg()), { days: 90, minPerProject: 10 });
  assert.deepEqual(historyRule(cfg({ organize: { history: { days: "all", minPerProject: 0 } } })), { days: "all", minPerProject: 0 });
  assert.deepEqual(historyRule(cfg({ organize: { history: { days: 30, minPerProject: 3 } } })), { days: 30, minPerProject: 3 });
});

test("reads 0.2.1 config values", () => {
  const h = (history: OrganizeConfig["history"]) => historyRule(cfg({ organize: { history } }));
  assert.deepEqual(h("all"), { days: "all", minPerProject: 10 });
  assert.deepEqual(h("days:30"), { days: 30, minPerProject: 10 });
  assert.equal(h("off"), null);
  for (const history of ["all", "off", "days:30", "days:3650", { days: 1, minPerProject: 0 }, { days: "all", minPerProject: 1000 }, { days: 3650, minPerProject: 10 }]) {
    assert.equal(validateConfig({ ...cfg(), organize: { history } }).ok, true, JSON.stringify(history));
  }
});

test("rejects days 0, 3651, min -1, 1001", () => {
  const bad: [unknown, string][] = [
    [{ days: 0, minPerProject: 10 }, "organize.history.days"],
    [{ days: 3651, minPerProject: 10 }, "organize.history.days"],
    [{ days: "weekly", minPerProject: 10 }, "organize.history.days"],
    [{ days: 90, minPerProject: -1 }, "organize.history.minPerProject"],
    [{ days: 90, minPerProject: 1001 }, "organize.history.minPerProject"],
    [{ days: 90, minPerProject: 1.5 }, "organize.history.minPerProject"],
  ];
  for (const [history, key] of bad) {
    const r = validateConfig({ ...cfg(), organize: { history } });
    assert.equal(r.ok, false, key);
    if (!r.ok) assert.ok(r.errors.some((e) => e.startsWith(key)), `${key}: ${r.errors.join("; ")}`);
  }
});

test("legacyHistory: a 0.2 string until the 0.3 history question is answered (history-v2); a 0.3 rule never", () => {
  const c = (organize: Record<string, unknown> | undefined): Config => ({ ...defaultConfig([]), ...(organize ? { organize: organize as Config["organize"] } : {}) });
  assert.equal(legacyHistory(c(undefined)), null);
  assert.equal(legacyHistory(c({ history: "all", decided: ["history"] })), "all", "0.2.1: answered for 0.2 only");
  assert.equal(legacyHistory(c({ history: "days:30" })), "days:30");
  assert.equal(legacyHistory(c({ history: "off", decided: ["history"] })), "off");
  assert.equal(legacyHistory(c({ history: "off", decided: ["history", HISTORY_V2] })), null, "0.3's own off");
  assert.equal(legacyHistory(c({ history: { days: 90, minPerProject: 10 }, decided: ["history"] })), null);
});
