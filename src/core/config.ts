import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, Config, InstanceSpec } from "./types.ts";
import { expandHome, normalizeCwd, sameCwd } from "./paths.ts";
import { globToRegExp } from "./glob.ts";
import { atomicWrite } from "./fsutil.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
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

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: withDefaults(u, accs as AccountConfig[]) };
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
  try { disk = JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, "")); } catch { return c; }
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
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
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
