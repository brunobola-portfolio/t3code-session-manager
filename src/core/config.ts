import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, Config, InstanceSpec, OrganizeConfig } from "./types.ts";
import { DEFAULT_HISTORY } from "./history.ts";
import { expandHome, normalizeCwd, sameCwd } from "./paths.ts";
import { globToRegExp } from "./glob.ts";
import { atomicWrite } from "./fsutil.ts";
import { isT3Refused } from "../plan/folders.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** A command that needs a saved plan found none (the screen words it; the message is for logs). */
export class NoPlanError extends ConfigError {
  override name = "NoPlanError";
  constructor() { super("No plan found. Run `t3sm plan` first."); }
}

const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ID_MAX = 64;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const HINT = "Fix the file, or delete it to regenerate defaults with `t3sm accounts --init`.";
const CONFIG_FILE = "config.json";

/** Wave packing defaults (S2 §5 estimates); every caller without a config uses these. */
export const DEFAULT_BATCH: Readonly<Config["batch"]> = Object.freeze({ filesPerProject: 50, projectsPerWave: 5 });
/** `t3sm schedule` and doctor's schedule check without a config. */
export const DEFAULT_SCHEDULE_MINUTES = 15;

export function defaultConfig(accounts: AccountConfig[]): Config {
  return {
    version: 1,
    accounts,
    defaultAccount: accounts[0]?.id ?? "",
    routes: [],
    remap: [],
    exclude: [],
    includeBackups: false,
    batch: { ...DEFAULT_BATCH },
    schedule: { everyMinutes: DEFAULT_SCHEDULE_MINUTES },
    // autoMerge off by default: sync only reports sessions continued in a terminal; `t3sm merge` brings them in.
    sync: { autoMerge: false, watchDebounceMs: 30_000, maxUnattendedImports: 200 },
  };
}

function sanitizeId(suffix: string): string {
  const clean = suffix.replace(/[^a-zA-Z0-9_-]/g, "");
  const id = "claude-" + (clean === "" ? "account" : clean);
  return id.slice(0, ID_MAX);
}

/** An alias or folder name as an account id: kept when it is already a valid id start, else prefixed `claude-`. */
function idFromName(name: string): string | null {
  const clean = name.replace(/^\.+/, "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (clean === "") return null;
  return (/^[a-zA-Z]/.test(clean) ? clean : "claude-" + clean).slice(0, ID_MAX);
}

function lastSegment(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find Claude account directories under `home`: `~/.claude` and every `~/.claude-<suffix>`
 * that holds a `projects/` directory, plus `extra` candidate homes (account discovery: aliases, profiles, pins) that
 * hold a `projects/` directory. Id: existing T3 instance id for that home (which also keeps its display name and accent
 * colour) -> `claudeAgent` for ~/.claude -> the alias name -> the folder name; made unique with -2, -3.
 */
export async function detectAccounts(
  home: string, existingInstances: InstanceSpec[], extra: { home: string; alias: string | null }[] = [],
): Promise<AccountConfig[]> {
  const dirs: { dir: string; suffix: string | null; alias: string | null }[] = [];
  if (await isDir(join(home, ".claude"))) dirs.push({ dir: join(home, ".claude"), suffix: null, alias: null });
  const names = await readdir(home).catch(() => [] as string[]);
  for (const name of names.sort()) {
    if (!name.startsWith(".claude-") || name.length <= ".claude-".length) continue;
    const dir = join(home, name);
    if (await isDir(join(dir, "projects"))) dirs.push({ dir, suffix: name.slice(".claude-".length), alias: null });
  }
  for (const x of extra) {
    const known = dirs.find((d) => sameCwd(d.dir, x.home));
    if (known) { known.alias ??= x.alias; continue; }
    if (await isDir(join(x.home, "projects"))) dirs.push({ dir: x.home, suffix: lastSegment(x.home), alias: x.alias });
  }
  const used = new Set<string>();
  const out: AccountConfig[] = [];
  for (const { dir, suffix, alias } of dirs) {
    const existing = existingInstances.find((i) => i.homePath !== "" && sameCwd(normalizeCwd(i.homePath), normalizeCwd(dir)));
    const aliasId = alias === null ? null : idFromName(alias);
    let acc: AccountConfig;
    if (existing) {
      acc = { id: existing.id, home: dir, displayName: existing.displayName, accentColor: existing.accentColor };
    } else if (suffix === null) {
      acc = { id: "claudeAgent", home: dir, displayName: "Claude", accentColor: null };
    } else if (aliasId !== null) {
      acc = { id: aliasId, home: dir, displayName: `Claude · ${alias!.replace(/^claude[-_]?/i, "") || alias}`, accentColor: null };
    } else if (sameCwd(dir, join(home, `.claude-${suffix}`))) {
      acc = { id: sanitizeId(suffix), home: dir, displayName: `Claude · ${suffix}`, accentColor: null };
    } else {
      acc = { id: idFromName(suffix) ?? "claude-account", home: dir, displayName: `Claude · ${suffix}`, accentColor: null };
    }
    const base = acc.id;
    for (let n = 2; used.has(acc.id); n++) acc.id = `${base.slice(0, ID_MAX - 4)}-${n}`;
    used.add(acc.id);
    out.push(acc);
  }
  return out.sort((a, b) => {
    if (a.id === "claudeAgent") return -1;
    if (b.id === "claudeAgent") return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function isObj(u: unknown): u is Record<string, unknown> {
  return typeof u === "object" && u !== null && !Array.isArray(u);
}

function intIn(v: unknown, lo: number, hi: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

const NOTIFY = ["attention", "all", "off"];
const FOLDER_CATEGORIES = ["home", "t3-refused", "temp", "system"] as const;
const FOLDER_ACTIONS = ["import", "skip", "rehome"];

/** A folder written in config.json (`~` allowed) is absolute once expanded. */
function absoluteFolder(p: string, platform: NodeJS.Platform, home: string): string | null {
  const n = normalizeCwd(expandHome(p.trim(), home), platform);
  const abs = platform === "win32" ? /^[A-Za-z]:\//.test(n) || n.startsWith("//") : n.startsWith("/");
  return abs ? n : null;
}

/** Why a folder written in config.json cannot hold a T3 Code project (not absolute, or refused by T3 Code), or null. */
function projectFolderError(p: string, platform: NodeJS.Platform, home: string): string | null {
  const target = absoluteFolder(p, platform, home);
  if (target === null) return "must name an absolute folder (or one starting with ~)";
  const t3Base = normalizeCwd(expandHome("~/.t3", home), platform);
  if (isT3Refused(target, { platform, home, tmpdir: tmpdir(), env: {}, t3BaseDir: t3Base, t3WorktreesDir: `${t3Base}/worktrees` })) {
    return "is a folder T3 Code does not accept as a project (the home folder, Downloads, Documents/Codex, T3 Code's own folders or the temp folder itself)";
  }
  return null;
}

/**
 * Every field optional; present means checked. Errors name the key (`organize.names.maxLength: ...`). A
 * `rehome:<folder>` override must name an absolute folder T3 Code accepts as a project (spec 4.3, 3.4).
 */
function validateOrganize(o: unknown, errors: string[], platform: NodeJS.Platform, home: string): void {
  if (!isObj(o)) return void errors.push("organize: must be an object");
  const has = (x: Record<string, unknown>, k: string): boolean => x[k] !== undefined;
  const sub = (k: string): Record<string, unknown> | null => {
    if (!has(o, k)) return null;
    if (isObj(o[k])) return o[k];
    errors.push(`organize.${k}: must be an object`);
    return null;
  };

  const folders = sub("folders");
  if (folders) {
    for (const k of Object.keys(folders)) {
      if (!(FOLDER_CATEGORIES as readonly string[]).includes(k)) errors.push(`organize.folders.${k}: unknown folder category (use ${FOLDER_CATEGORIES.join(", ")})`);
      else if (!FOLDER_ACTIONS.includes(folders[k] as string)) errors.push(`organize.folders.${k}: must be "import", "skip" or "rehome"`);
    }
  }
  const sessions = sub("sessions");
  if (sessions && has(sessions, "automated") && sessions["automated"] !== "skip" && sessions["automated"] !== "import") {
    errors.push(`organize.sessions.automated: must be "skip" or "import"`);
  }
  if (sessions && has(sessions, "orphaned") && sessions["orphaned"] !== "copy" && sessions["orphaned"] !== "skip") {
    errors.push(`organize.sessions.orphaned: must be "copy" or "skip"`);
  }
  if (has(o, "generalFolder")) {
    const g = o["generalFolder"];
    if (!nonEmpty(g)) errors.push("organize.generalFolder: must be a non-empty string");
    else {
      const why = projectFolderError(g, platform, home);
      if (why !== null) errors.push(`organize.generalFolder: ${g} ${why}`);
    }
  }

  const overrides = o["overrides"];
  if (has(o, "overrides")) {
    if (!Array.isArray(overrides)) errors.push("organize.overrides: must be an array");
    else overrides.forEach((r: unknown, i) => {
      const p = `organize.overrides[${i}]`;
      if (!isObj(r)) return void errors.push(`${p}: must be an object`);
      if (!nonEmpty(r["match"])) errors.push(`${p}.match: must be a non-empty string`);
      const a = r["action"];
      const ok = a === "import" || a === "skip" || (typeof a === "string" && a.startsWith("rehome:") && a.slice(7).trim() !== "");
      if (!ok) return void errors.push(`${p}.action: must be "import", "skip" or "rehome:<folder>" with a folder`);
      if (typeof a !== "string" || !a.startsWith("rehome:")) return;
      const why = projectFolderError(a.slice(7), platform, home);
      if (why !== null) errors.push(`${p}.action: ${a} ${why}`);
    });
  }

  const names = sub("names");
  if (names && has(names, "maxLength") && !intIn(names["maxLength"], 16, 120)) errors.push("organize.names.maxLength: must be an integer 16..120");

  if (has(o, "history")) {
    const h = o["history"];
    if (isObj(h)) {
      if (has(h, "days") && h["days"] !== "all" && !intIn(h["days"], 1, 3650)) errors.push(`organize.history.days: must be "all" or an integer 1..3650`);
      if (has(h, "minPerProject") && !intIn(h["minPerProject"], 0, 1000)) errors.push("organize.history.minPerProject: must be an integer 0..1000");
    } else {
      const m = typeof h === "string" ? /^days:(\d+)$/.exec(h) : null;
      const ok = h === "all" || h === "off" || (m !== null && Number(m[1]) >= 1 && Number(m[1]) <= 3650);
      if (!ok) errors.push(`organize.history: must be {days, minPerProject}, or "all", "off" or "days:N" with N 1..3650`);
    }
  }
  for (const k of ["titles", "archiveAutomated"]) {
    if (has(o, k) && typeof o[k] !== "boolean") errors.push(`organize.${k}: must be a boolean`);
  }
  const ai = sub("aiTitles");
  if (ai) {
    if (has(ai, "enabled") && typeof ai["enabled"] !== "boolean") errors.push("organize.aiTitles.enabled: must be a boolean");
    if (has(ai, "maxPerRun") && !intIn(ai["maxPerRun"], 1, AI_TITLES_MAX)) errors.push(`organize.aiTitles.maxPerRun: must be an integer 1..${AI_TITLES_MAX}`);
  }
  const pin = sub("pinRecent");
  if (pin) {
    if (has(pin, "enabled") && typeof pin["enabled"] !== "boolean") errors.push("organize.pinRecent.enabled: must be a boolean");
    if (has(pin, "count") && !intIn(pin["count"], 1, 20)) errors.push("organize.pinRecent.count: must be an integer 1..20");
  }
  const decided = o["decided"];
  if (has(o, "decided")) {
    if (!Array.isArray(decided)) errors.push("organize.decided: must be an array");
    else decided.forEach((d: unknown, i) => { if (!nonEmpty(d)) errors.push(`organize.decided[${i}]: must be a non-empty string`); });
  }
}

export { DEFAULT_HISTORY, HISTORY_V2, historyRule, legacyHistory, normalizeHistory } from "./history.ts";

/** Titles T3 Code writes in one organize run at most: the default, and the highest `--ai-titles-max` / `maxPerRun`. */
export const DEFAULT_AI_TITLES_PER_RUN = 50;
export const AI_TITLES_MAX = 500;

/** `organize` with every omitted field filled from the spec defaults (nested objects per field). `lang` only picks the default `generalFolder`. */
export function organizeSettings(c: Config, lang: "en" | "pt"): OrganizeConfig {
  const o = c.organize ?? {};
  return {
    folders: { home: "rehome", "t3-refused": "rehome", temp: "skip", system: "skip", ...o.folders },
    sessions: { automated: "skip", orphaned: "copy", ...o.sessions },
    generalFolder: o.generalFolder ?? (lang === "pt" ? "~/T3 Geral" : "~/T3 General"),
    overrides: o.overrides ?? [],
    names: { maxLength: 40, ...o.names },
    history: o.history ?? { ...DEFAULT_HISTORY },
    titles: o.titles ?? true,
    aiTitles: { enabled: false, maxPerRun: DEFAULT_AI_TITLES_PER_RUN, ...o.aiTitles },
    archiveAutomated: o.archiveAutomated ?? true,
    pinRecent: { enabled: true, count: 5, ...o.pinRecent },
    decided: o.decided ?? [],
  };
}

/** What the guided assistant saves under `organize`: each field only when answered; nested objects merge per field. */
export interface OrganizePatch {
  folders?: Partial<OrganizeConfig["folders"]>;
  sessions?: Partial<OrganizeConfig["sessions"]>;
  /** Replaces the whole list (the caller merges with what config.json holds). */
  overrides?: OrganizeConfig["overrides"];
  history?: OrganizeConfig["history"];
  titles?: boolean;
  archiveAutomated?: boolean;
  pinRecent?: Partial<OrganizeConfig["pinRecent"]>;
  /** Question keys to add to `decided` (never removed, never duplicated). */
  decided?: string[];
}

/** `c` with `patch` applied to its `organize` section; the rest of the config, and `c` itself, are untouched. */
export function applyOrganizePatch(c: Config, patch: OrganizePatch): Config {
  const o = c.organize ?? {};
  const next: NonNullable<Config["organize"]> = { ...o };
  if (patch.folders) next.folders = { ...o.folders, ...patch.folders } as OrganizeConfig["folders"];
  if (patch.sessions) next.sessions = { ...o.sessions, ...patch.sessions };
  if (patch.overrides) next.overrides = patch.overrides.map((r) => ({ ...r }));
  if (patch.history !== undefined) next.history = patch.history;
  if (patch.titles !== undefined) next.titles = patch.titles;
  if (patch.archiveAutomated !== undefined) next.archiveAutomated = patch.archiveAutomated;
  if (patch.pinRecent) next.pinRecent = { ...o.pinRecent, ...patch.pinRecent } as OrganizeConfig["pinRecent"];
  if (patch.decided) next.decided = [...new Set([...(o.decided ?? []), ...patch.decided])];
  return { ...c, organize: next };
}

/** True when the question `key` (see `OrganizeConfig.decided`) was already asked. */
export function isDecided(c: Config, key: string): boolean {
  return c.organize?.decided?.includes(key) ?? false;
}

export function validateConfig(
  u: unknown,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): { ok: true; config: Config } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(u)) return { ok: false, errors: ["config: must be an object"] };

  if (u["version"] !== 1) errors.push("version: must be 1");

  const ids = new Set<string>();
  const homes: string[] = [];
  const accs = u["accounts"];
  if (!Array.isArray(accs)) {
    errors.push("accounts: must be an array");
  } else {
    if (accs.length === 0) errors.push("accounts: must not be empty");
    accs.forEach((a: unknown, i) => {
      const p = `accounts[${i}]`;
      if (!isObj(a)) {
        errors.push(`${p}: must be an object`);
        return;
      }
      const id = a["id"];
      if (typeof id !== "string" || !ID_RE.test(id) || id.length > ID_MAX) {
        errors.push(`${p}.id: must match ${ID_RE.source} and be at most ${ID_MAX} characters`);
      } else if (ids.has(id)) {
        errors.push(`${p}.id: duplicate account id "${id}"`);
      } else {
        ids.add(id);
      }
      if (!nonEmpty(a["home"])) {
        errors.push(`${p}.home: must be a non-empty string`);
      } else {
        const h = normalizeCwd(expandHome(a["home"], home), platform);
        if (homes.some((x) => sameCwd(x, h, platform))) errors.push(`${p}.home: duplicate home "${a["home"]}"`);
        else homes.push(h);
      }
      if (!nonEmpty(a["displayName"])) errors.push(`${p}.displayName: must be a non-empty string`);
      const c = a["accentColor"];
      if (c !== null && !(typeof c === "string" && COLOR_RE.test(c))) errors.push(`${p}.accentColor: must be null or #RRGGBB`);
    });
  }

  if (typeof u["defaultAccount"] !== "string" || !ids.has(u["defaultAccount"])) {
    errors.push(`defaultAccount: unknown account "${String(u["defaultAccount"])}"`);
  }

  // Every key below is optional: absent means defaultConfig's value (nested objects per field); present means checked.
  const has = (o: Record<string, unknown>, k: string): boolean => o[k] !== undefined;
  const routes = u["routes"];
  if (!has(u, "routes")) { /* default [] */ } else if (!Array.isArray(routes)) errors.push("routes: must be an array");
  else routes.forEach((r: unknown, i) => {
    if (!isObj(r)) return void errors.push(`routes[${i}]: must be an object`);
    if (!nonEmpty(r["match"])) errors.push(`routes[${i}].match: must be a non-empty string`);
    if (typeof r["account"] !== "string" || !ids.has(r["account"])) errors.push(`routes[${i}].account: unknown account "${String(r["account"])}"`);
  });

  const remap = u["remap"];
  if (!has(u, "remap")) { /* default [] */ } else if (!Array.isArray(remap)) errors.push("remap: must be an array");
  else remap.forEach((r: unknown, i) => {
    if (!isObj(r)) return void errors.push(`remap[${i}]: must be an object`);
    if (!nonEmpty(r["from"])) errors.push(`remap[${i}].from: must be a non-empty string`);
    if (!nonEmpty(r["to"])) errors.push(`remap[${i}].to: must be a non-empty string`);
  });

  const exclude = u["exclude"];
  if (!has(u, "exclude")) { /* default [] */ } else if (!Array.isArray(exclude)) errors.push("exclude: must be an array");
  else exclude.forEach((e: unknown, i) => {
    if (!nonEmpty(e)) errors.push(`exclude[${i}]: must be a non-empty string`);
  });

  if (has(u, "includeBackups") && typeof u["includeBackups"] !== "boolean") errors.push("includeBackups: must be a boolean");

  const batch = u["batch"];
  if (!has(u, "batch")) { /* defaults */ } else if (!isObj(batch)) errors.push("batch: must be an object");
  else {
    if (has(batch, "filesPerProject") && !intIn(batch["filesPerProject"], 1, 100)) errors.push("batch.filesPerProject: must be an integer 1..100");
    if (has(batch, "projectsPerWave") && !intIn(batch["projectsPerWave"], 1, 50)) errors.push("batch.projectsPerWave: must be an integer 1..50");
  }

  const schedule = u["schedule"];
  if (!has(u, "schedule")) { /* defaults */ } else if (!isObj(schedule)) errors.push("schedule: must be an object");
  else if (has(schedule, "everyMinutes") && !intIn(schedule["everyMinutes"], 1, 1440)) errors.push("schedule.everyMinutes: must be an integer 1..1440");

  const sync = u["sync"];
  if (!has(u, "sync")) { /* defaults */ } else if (!isObj(sync)) errors.push("sync: must be an object");
  else {
    if (has(sync, "autoMerge") && typeof sync["autoMerge"] !== "boolean") errors.push("sync.autoMerge: must be a boolean");
    if (has(sync, "watchDebounceMs") && !intIn(sync["watchDebounceMs"], 1000, 600_000)) errors.push("sync.watchDebounceMs: must be an integer 1000..600000");
    if (has(sync, "maxUnattendedImports") && !intIn(sync["maxUnattendedImports"], 1, 100_000)) errors.push("sync.maxUnattendedImports: must be an integer 1..100000");
  }

  const codex = u["codex"];
  if (!has(u, "codex")) { /* default: convert compressed rollouts */ } else if (!isObj(codex)) errors.push("codex: must be an object");
  else if (has(codex, "convertCompressed") && typeof codex["convertCompressed"] !== "boolean") errors.push("codex.convertCompressed: must be a boolean");

  if (has(u, "language") && u["language"] !== "en" && u["language"] !== "pt") errors.push(`language: must be "en" or "pt"`);

  if (has(u, "notify") && !NOTIFY.includes(u["notify"] as string)) errors.push(`notify: must be "attention", "all" or "off"`);

  const update = u["update"];
  if (!has(u, "update")) { /* default: automatic updates on */ } else if (!isObj(update)) errors.push("update: must be an object");
  else if (has(update, "auto") && typeof update["auto"] !== "boolean") errors.push("update.auto: must be a boolean");
  if (has(u, "organize")) validateOrganize(u["organize"], errors, platform, home);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: withDefaults(u, accs as AccountConfig[]) };
}

/** Whether the watcher installs newer patch and minor releases by itself (`update.auto`, default true; spec §5.3). */
export function updateAuto(c: Config | null): boolean {
  return c?.update?.auto ?? true;
}

/** Fills every omitted key from defaultConfig; nested objects (batch, schedule, sync) per field. Input is not mutated. */
function withDefaults(u: Record<string, unknown>, accounts: AccountConfig[]): Config {
  const d = defaultConfig(accounts);
  const pick = <T>(k: string, dv: T): T => (u[k] === undefined ? dv : (u[k] as T));
  const merge = <T extends object>(k: string, dv: T): T => {
    const o = (u[k] ?? {}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(dv).map(([f, v]) => [f, o[f] === undefined ? v : o[f]]).concat(
      Object.entries(o).filter(([f, v]) => !(f in dv) && v !== undefined))) as T;
  };
  return {
    ...(u as object),
    version: 1,
    accounts,
    defaultAccount: u["defaultAccount"] as string,
    routes: pick("routes", d.routes),
    remap: pick("remap", d.remap),
    exclude: pick("exclude", d.exclude),
    includeBackups: pick("includeBackups", d.includeBackups),
    batch: merge("batch", d.batch),
    schedule: merge("schedule", d.schedule),
    sync: merge("sync", d.sync),
  } as Config;
}

/** A glob whose first segment is `~`: that segment becomes the user home (forward slashes, as globs are written). */
function expandGlobHome(g: string, home: string, platform: NodeJS.Platform): string {
  if (g !== "~" && !g.startsWith("~/") && !g.startsWith("~\\")) return g;
  return normalizeCwd(home, platform).replace(/\/+$/, "") + g.slice(1).replaceAll("\\", "/");
}

/**
 * Every path of the config as an absolute path: account homes, remap from/to, and route / exclude globs whose first
 * segment is `~`. Done once at load, so every consumer sees the same absolute paths. Pure.
 */
export function expandConfig(c: Config, home: string, platform: NodeJS.Platform = process.platform): Config {
  return {
    ...c,
    accounts: c.accounts.map((a) => ({ ...a, home: expandHome(a.home, home) })),
    remap: c.remap.map((r) => ({ ...r, from: expandHome(r.from, home), to: expandHome(r.to, home) })),
    routes: c.routes.map((r) => ({ ...r, match: expandGlobHome(r.match, home, platform) })),
    exclude: c.exclude.map((g) => expandGlobHome(g, home, platform)),
  };
}

/**
 * `c` as the user wrote it: every path that equals the expansion of the same field's value in the config file on disk
 * goes back to the file's spelling (e.g. `~/.claude`). Anything new or changed is written as it is.
 */
async function asWritten(file: string, c: Config, home: string, platform: NodeJS.Platform): Promise<Config> {
  let disk: unknown;
  try { disk = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")); } catch { return c; }
  if (!isObj(disk)) return c;
  const raw = new Map<string, string>();
  const strs = (u: unknown, f: (x: Record<string, unknown>) => unknown[]): string[] =>
    Array.isArray(u) ? u.flatMap((x) => (isObj(x) ? f(x) : [x])).filter((x): x is string => typeof x === "string") : [];
  for (const p of [...strs(disk["accounts"], (a) => [a["home"]]), ...strs(disk["remap"], (r) => [r["from"], r["to"]])]) raw.set(expandHome(p, home), p);
  for (const g of [...strs(disk["routes"], (r) => [r["match"]]), ...strs(disk["exclude"], () => [])]) raw.set(expandGlobHome(g, home, platform), g);
  const back = (s: string): string => raw.get(s) ?? s;
  return {
    ...c,
    accounts: c.accounts.map((a) => ({ ...a, home: back(a.home) })),
    remap: c.remap.map((r) => ({ ...r, from: back(r.from), to: back(r.to) })),
    routes: c.routes.map((r) => ({ ...r, match: back(r.match) })),
    exclude: c.exclude.map(back),
  };
}

/** Reads and validates `<dir>/config.json` (null when absent); `~` paths come back expanded against `home`. */
export async function loadConfig(dir: string, home: string = homedir(), platform: NodeJS.Platform = process.platform): Promise<Config | null> {
  const file = join(dir, CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new ConfigError(`${file}: invalid JSON (${(e as Error).message}). ${HINT}`);
  }
  const r = validateConfig(parsed, platform, home);
  if (!r.ok) throw new ConfigError(`${file}: invalid config:\n  ${r.errors.join("\n  ")}\n${HINT}`);
  return expandConfig(r.config, home, platform);
}

/** Writes config.json; paths loadConfig expanded are written back as the existing file spells them. */
export async function saveConfig(dir: string, c: Config, home: string = homedir(), platform: NodeJS.Platform = process.platform): Promise<void> {
  const file = join(dir, CONFIG_FILE);
  await atomicWrite(file, JSON.stringify(await asWritten(file, c, home, platform), null, 2) + "\n");
}

/** First `remap` entry whose `from` is a whole-segment path prefix of `cwd` wins. */
export function resolveRemap(
  cwd: string,
  c: Config,
  platform: NodeJS.Platform = process.platform,
): { cwd: string; remapped: boolean } {
  const n = normalizeCwd(cwd, platform);
  const fold = platform === "win32" || platform === "darwin";
  const key = (s: string): string => (fold ? s.toLowerCase() : s);
  for (const r of c.remap) {
    const from = normalizeCwd(r.from, platform);
    const rest = key(n).startsWith(key(from)) ? n.slice(from.length) : null;
    if (rest === null) continue;
    if (rest === "" || rest.startsWith("/") || from.endsWith("/")) {
      const to = normalizeCwd(r.to, platform);
      const tail = rest.startsWith("/") || rest === "" ? rest : "/" + rest;
      return { cwd: normalizeCwd(to + tail, platform), remapped: true };
    }
  }
  return { cwd: n, remapped: false };
}

export function routeAccount(cwd: string, c: Config, platform: NodeJS.Platform = process.platform): string | null {
  const n = normalizeCwd(cwd, platform);
  for (const r of c.routes) {
    if (globToRegExp(r.match, platform).test(n)) return r.account;
  }
  return null;
}
