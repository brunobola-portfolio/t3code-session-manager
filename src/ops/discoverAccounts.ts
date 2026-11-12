// Account discovery: where on this machine do Claude Code accounts (config dirs) live? Read-only.
// Evidence: ~/.claude (default), ~/.claude-* folders, CLAUDE_CONFIG_DIR assignments in shell profiles (PowerShell,
// bash, zsh, fish) with the enclosing alias/function name, `.vscode/settings.json` pins of known project roots, the
// current process CLAUDE_CONFIG_DIR, and homes of existing T3 Claude instances. A candidate is an account only when the
// directory exists and holds `projects/` (~/.claude counts whenever it exists: T3's default instance always reads it).
// Profile parsing is line-based and tolerant: anything it cannot resolve to an absolute path is ignored.

import { readdir, readFile } from "node:fs/promises";
import { parseJsonc, pinFromSettings } from "../plan/ownership.ts";
import { normalizeCwd } from "../core/paths.ts";
import { detectAccounts } from "../core/config.ts";
import type { AccountConfig, InstanceSpec } from "../core/types.ts";

export type DiscoverySource = "default" | "folder" | "shell-profile" | "vscode-pin" | "env" | "t3-instance";
export interface DiscoveredHome { home: string; sources: DiscoverySource[]; alias: string | null }

export interface DiscoveryEnv {
  home: string;
  platform: NodeJS.Platform;
  /** File content, or null when missing/unreadable. */
  readFile(p: string): Promise<string | null>;
  /** Names of the sub-directories of `p` ([] when missing). */
  listDirs(p: string): Promise<string[]>;
  /** Process environment of the user's shell (CLAUDE_CONFIG_DIR). Default: none. */
  env?: NodeJS.ProcessEnv;
  /** Homes of existing T3 Claude instances. */
  instanceHomes?: string[];
  /** Extra project roots whose `.vscode/settings.json` may pin an account (e.g. T3 projects). */
  projectRoots?: string[];
}

const SOURCE_ORDER: DiscoverySource[] = ["default", "folder", "shell-profile", "vscode-pin", "env", "t3-instance"];
const VAR = "CLAUDE_CONFIG_DIR";

type Kind = "ps" | "sh" | "fish";

const PS_PROFILES = ["Microsoft.PowerShell_profile.ps1", "profile.ps1"];
const PS_DIRS = ["Documents/PowerShell", "Documents/WindowsPowerShell"];
const SH_PROFILES = [".bashrc", ".bash_profile", ".bash_aliases", ".profile", ".zshrc", ".zprofile", ".zshenv"];

function join2(a: string, b: string): string {
  return a.replace(/[\\/]+$/, "") + "/" + b;
}

async function profileFiles(env: DiscoveryEnv): Promise<{ path: string; kind: Kind }[]> {
  const out: { path: string; kind: Kind }[] = [];
  // OneDrive redirects Documents (personal: "OneDrive", business: "OneDrive - <Org>").
  const roots = [env.home, ...(await env.listDirs(env.home)).filter((n) => /^OneDrive\b/i.test(n)).sort().map((n) => join2(env.home, n))];
  for (const r of roots) for (const d of PS_DIRS) for (const f of PS_PROFILES) out.push({ path: `${join2(r, d)}/${f}`, kind: "ps" });
  for (const f of PS_PROFILES) out.push({ path: `${join2(env.home, ".config/powershell")}/${f}`, kind: "ps" });
  for (const f of SH_PROFILES) out.push({ path: join2(env.home, f), kind: "sh" });
  out.push({ path: join2(env.home, ".config/fish/config.fish"), kind: "fish" });
  return out;
}

// ---------- line scanning ----------

/** Escape character inside "…": the backtick in PowerShell, the backslash in sh/fish. */
const escOf = (kind: Kind): string => (kind === "ps" ? "`" : "\\");

/** Removes a `#` comment that starts the line or follows whitespace, outside quotes. */
function stripComment(line: string, kind: Kind): string {
  const esc = escOf(kind);
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === q) q = null; else if (c === esc && q === '"') i++; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

/** Splits on `;` outside quotes (fish statements). */
function statements(line: string): string[] {
  const out: string[] = [];
  let q: string | null = null, start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === q) q = null; else if (c === "\\" && q === '"') i++; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === ";") { out.push(line.slice(start, i)); start = i + 1; }
  }
  out.push(line.slice(start));
  return out;
}

/** Net `{`/`}` events outside quotes and outside `${...}` expansions, in order. */
function braces(line: string, kind: Kind): ("{" | "}")[] {
  const esc = escOf(kind);
  const out: ("{" | "}")[] = [];
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === q) q = null; else if (c === esc && q === '"') i++; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "$" && line[i + 1] === "{") { const e = line.indexOf("}", i + 2); if (e !== -1) { i = e; continue; } }
    if (c === "{" || c === "}") out.push(c);
  }
  return out;
}

const VALUE = String.raw`("[^"]*"|'[^']*'|[^\s;&|"'\x60)]+)`;
const SH_ASSIGN = new RegExp(String.raw`(?:^|[\s;&|("'\x60])(?:export\s+|local\s+|declare\s+-x\s+)?${VAR}=` + VALUE, "g");
/** A PowerShell argument: "…" (backtick escapes), '…', or a bare token. */
const PS_DQ = String.raw`"(?:[^"\x60]|\x60.)*"`;
const PS_ARG = String.raw`(?:${PS_DQ}|'[^']*'|[^\s;)'"]+)`;
const PS_JOIN = String.raw`Join-Path\s+(?:-Path\s+)?(${PS_ARG})\s+(?:-ChildPath\s+)?(${PS_ARG})`;
const PS_ASSIGN = new RegExp(String.raw`\$env:${VAR}\s*=\s*\(?\s*(Join-Path\s+(?:-Path\s+)?${PS_ARG}\s+(?:-ChildPath\s+)?${PS_ARG}|${PS_DQ}|'[^']*'|[^\s;)]+)`, "gi");
const PS_SETENV = new RegExp(String.raw`(?:SetEnvironmentVariable\(\s*['"]${VAR}['"]\s*,\s*|Set-Item\s+(?:-Path\s+)?env:${VAR}\s+(?:-Value\s+)?)(${PS_DQ}|'[^']*'|[^\s;),]+)`, "gi");
const FISH_SET = new RegExp(String.raw`^\s*set\s+(?:-{1,2}[A-Za-z]+\s+)*${VAR}\s+` + VALUE);
const NAME = String.raw`([A-Za-z0-9_][A-Za-z0-9_.:+-]*)`;
/** Lines that only print text: an assignment shown there is not evidence. */
const PRINT_LINE = /^\s*(?:echo|printf|Write-Host|Write-Output|Write-Verbose|Write-Information|Write-Warning)(?![\w-])/i;
/** sh heredoc start (`<<EOF`, `<<-'END'`), not the `<<<` here-string. */
const HEREDOC = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

function unquote(v: string, kind: Kind = "sh"): string {
  const t = v.trim();
  if (t.length >= 2 && t[0] === '"' && t.at(-1) === '"') return kind === "ps" ? t.slice(1, -1).replace(/`(.)/g, "$1") : t.slice(1, -1);
  if (t.length >= 2 && t[0] === "'" && t.at(-1) === "'") return t.slice(1, -1);
  return t;
}

function psValue(v: string): string {
  const jp = new RegExp(`^${PS_JOIN}$`, "i").exec(v.trim());
  if (jp) return `${unquote(jp[1]!, "ps")}/${unquote(jp[2]!, "ps")}`;
  return unquote(v, "ps");
}

/** Raw CLAUDE_CONFIG_DIR values with the alias/function that encloses each (exported for tests). */
export function scanProfile(text: string, kind: Kind): { value: string; alias: string | null }[] {
  const out: { value: string; alias: string | null }[] = [];
  const stack: { name: string | null; depth: number }[] = []; // ps/sh: brace scopes; fish: block scopes
  let depth = 0;
  let pending: string | null = null; // function header seen, body brace not yet
  let inBlock = false; // PowerShell <# ... #>
  let bodyEnd: ((l: string) => boolean) | null = null; // inside a heredoc / here-string body: its terminator test
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    let line = raw;
    if (bodyEnd) {
      if (bodyEnd(line)) bodyEnd = null;
      continue;
    }
    if (kind === "ps") {
      if (inBlock) {
        const e = line.indexOf("#>");
        if (e === -1) continue;
        line = line.slice(e + 2);
        inBlock = false;
      }
      for (let s = line.indexOf("<#"); s !== -1; s = line.indexOf("<#")) {
        const e = line.indexOf("#>", s + 2);
        if (e === -1) { line = line.slice(0, s); inBlock = true; break; }
        line = line.slice(0, s) + line.slice(e + 2);
      }
    }
    line = stripComment(line, kind);
    if (line.trim() === "") continue;
    if (kind === "ps") {
      const hs = /@(["'])\s*$/.exec(line);
      if (hs) { const end = `${hs[1]}@`; bodyEnd = (l) => l.trimStart().startsWith(end); }
    } else if (kind === "sh") {
      const hd = HEREDOC.exec(line);
      if (hd) { const word = hd[2]!; bodyEnd = (l) => l.trim() === word; }
    }
    const printing = PRINT_LINE.test(line);

    if (kind === "fish") {
      for (const st of statements(line)) {
        const words = st.trim().split(/\s+/);
        const w0 = words[0] ?? "";
        if (PRINT_LINE.test(st)) continue;
        const alias = new RegExp(String.raw`^\s*alias\s+${NAME}(?:\s*=|\s+)`).exec(st)?.[1] ?? null;
        const current = alias ?? ([...stack].reverse().find((s) => s.name !== null)?.name ?? null);
        const fm = FISH_SET.exec(st);
        if (fm) out.push({ value: unquote(fm[1]!), alias: current });
        for (const m of st.matchAll(SH_ASSIGN)) out.push({ value: unquote(m[1]!), alias: current });
        if (w0 === "function") stack.push({ name: words[1] ?? null, depth: 0 });
        else if (["if", "for", "while", "switch", "begin"].includes(w0)) stack.push({ name: null, depth: 0 });
        else if (w0 === "end") stack.pop();
      }
      continue;
    }

    const header = new RegExp(String.raw`^\s*function\s+${NAME}`, "i").exec(line)
      ?? (kind === "sh" ? new RegExp(String.raw`^\s*${NAME}\s*\(\s*\)`).exec(line) : null);
    const isHeader = header !== null;
    if (header) pending = header[1]!;
    const alias = kind === "sh" ? new RegExp(String.raw`^\s*alias\s+${NAME}=`).exec(line)?.[1] ?? null : null;
    const current = alias ?? pending ?? stack.at(-1)?.name ?? null;
    const regs = kind === "ps" ? [PS_ASSIGN, PS_SETENV] : [SH_ASSIGN];
    if (!printing) for (const re of regs) for (const m of line.matchAll(re)) out.push({ value: kind === "ps" ? psValue(m[1]!) : unquote(m[1]!), alias: current });
    for (const b of braces(line, kind)) {
      if (b === "{") {
        if (pending !== null) { stack.push({ name: pending, depth }); pending = null; }
        depth++;
      } else {
        depth = Math.max(0, depth - 1);
        while (stack.length && stack.at(-1)!.depth >= depth) stack.pop();
      }
    }
    if (pending !== null && !isHeader) pending = null; // header without a body brace on the next line
  }
  return out;
}

// ---------- expansion ----------

const isAbsolute = (p: string, platform: NodeJS.Platform): boolean =>
  platform === "win32" ? /^[A-Za-z]:\//.test(p) || p.startsWith("//") : p.startsWith("/");

/** `$HOME`, `${HOME}`, `~`, `$env:USERPROFILE`, `%USERPROFILE%`, `${userHome}` expanded; null if unresolvable or relative. */
export function expandProfilePath(raw: string, home: string, platform: NodeJS.Platform): string | null {
  const h = home.replace(/\\/g, "/").replace(/\/+$/, "");
  let v = raw.trim();
  if (v === "") return null;
  v = v
    .replace(/\$\{(?:env:)?(?:USERPROFILE|HOME|userHome)\}/gi, h)
    .replace(/\$env:(?:USERPROFILE|HOME)(?![A-Za-z0-9_])/gi, h)
    .replace(/\$HOME(?![A-Za-z0-9_])/gi, h)
    .replace(/%USERPROFILE%/gi, h)
    .replace(/%HOMEDRIVE%%HOMEPATH%/gi, h);
  if (v === "~" || v.startsWith("~/") || v.startsWith("~\\")) v = h + v.slice(1);
  if (/[$%`]/.test(v)) return null;
  v = v.replace(/\\/g, "/");
  if (!isAbsolute(v, platform)) return null;
  return normalizeCwd(v, platform);
}

// ---------- discovery ----------

const foldCase = (platform: NodeJS.Platform) => platform === "win32" || platform === "darwin";

function claudeJsonRoots(text: string | null): string[] {
  if (text === null) return [];
  try {
    const j = JSON.parse(text.replace(/^﻿/, "")) as { projects?: unknown };
    return j && typeof j.projects === "object" && j.projects !== null && !Array.isArray(j.projects) ? Object.keys(j.projects) : [];
  } catch { return []; }
}

export async function discoverAccountHomes(env: DiscoveryEnv): Promise<DiscoveredHome[]> {
  const { platform } = env;
  const home = normalizeCwd(env.home.replace(/\\/g, "/"), platform);
  const key = (p: string) => (foldCase(platform) ? p.toLowerCase() : p);
  const cands = new Map<string, { home: string; sources: Set<DiscoverySource>; aliases: string[] }>();
  const add = (p: string | null, source: DiscoverySource, alias: string | null = null) => {
    if (p === null) return;
    const n = normalizeCwd(p.replace(/\\/g, "/"), platform);
    let c = cands.get(key(n));
    if (!c) cands.set(key(n), (c = { home: n, sources: new Set(), aliases: [] }));
    c.sources.add(source);
    if (alias && !c.aliases.includes(alias)) c.aliases.push(alias);
  };

  const top = await env.listDirs(home);
  const defaultHome = join2(home, ".claude");
  if (top.includes(".claude")) add(defaultHome, "default");
  for (const n of [...top].sort()) if (n.startsWith(".claude-") && n.length > ".claude-".length) add(join2(home, n), "folder");

  for (const f of await profileFiles(env)) {
    const text = await env.readFile(f.path);
    if (text === null) continue;
    for (const a of scanProfile(text, f.kind)) add(expandProfilePath(a.value, home, platform), "shell-profile", a.alias);
  }

  const cur = env.env?.[VAR];
  if (cur) add(expandProfilePath(cur, home, platform), "env");
  for (const h of env.instanceHomes ?? []) add(expandProfilePath(h, home, platform), "t3-instance");

  // vscode pins of known project roots: Claude's own project lists (~/.claude.json and <account>/.claude.json) + extras.
  const roots = new Map<string, string>();
  const addRoot = (r: string) => { const n = normalizeCwd(r.replace(/\\/g, "/"), platform); if (n && isAbsolute(n, platform)) roots.set(key(n), n); };
  for (const r of claudeJsonRoots(await env.readFile(join2(home, ".claude.json")))) addRoot(r);
  for (const c of [...cands.values()]) for (const r of claudeJsonRoots(await env.readFile(join2(c.home, ".claude.json")))) addRoot(r);
  for (const r of env.projectRoots ?? []) addRoot(r);
  const list = [...roots.values()];
  for (let i = 0; i < list.length; i += 32) {
    const pins = await Promise.all(list.slice(i, i + 32).map(async (r) => {
      const text = await env.readFile(`${r}/.vscode/settings.json`);
      if (text === null) return null;
      try { return pinFromSettings(parseJsonc(text.replace(/^﻿/, ""))); } catch { return null; }
    }));
    for (const p of pins) if (p) add(expandProfilePath(p, home, platform), "vscode-pin");
  }

  const out: DiscoveredHome[] = [];
  for (const c of cands.values()) {
    const isDefault = key(c.home) === key(defaultHome);
    if (isDefault) { if (!top.includes(".claude")) continue; c.sources.add("default"); }
    else {
      const subs = await env.listDirs(c.home);
      if (!subs.some((s) => key(s) === "projects")) continue;
    }
    const alias = c.aliases.find((a) => /claude/i.test(a)) ?? c.aliases[0] ?? null;
    out.push({ home: c.home, sources: SOURCE_ORDER.filter((s) => c.sources.has(s)), alias });
  }
  return out.sort((a, b) => {
    const da = a.sources.includes("default") ? 0 : 1, db = b.sources.includes("default") ? 0 : 1;
    if (da !== db) return da - db;
    return key(a.home) < key(b.home) ? -1 : key(a.home) > key(b.home) ? 1 : 0;
  });
}

/** "folder, shell-profile (claude-org)" */
export function formatSources(d: Pick<DiscoveredHome, "sources" | "alias">): string {
  return d.sources.map((s) => (s === "shell-profile" && d.alias ? `${s} (${d.alias})` : s)).join(", ");
}

/**
 * The accounts to use when there is no config.json: discovery (folders, aliases, profiles, pins, the shell, T3 instance
 * homes) fed into detectAccounts, so ids follow T3 instance -> claudeAgent -> alias -> folder name. Read-only.
 */
export async function resolveAccounts(
  home: string, instances: InstanceSpec[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform,
): Promise<AccountConfig[]> {
  return (await resolveAccountsWithSources(home, instances, env, platform)).accounts;
}

/** resolveAccounts plus the discovered homes and where each was found (for the first plan's notice). */
export async function resolveAccountsWithSources(
  home: string, instances: InstanceSpec[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform,
): Promise<{ accounts: AccountConfig[]; found: DiscoveredHome[] }> {
  const found = await discoverAccountHomes(nodeDiscoveryEnv({ home, platform, env, instanceHomes: instances.map((i) => i.homePath) }));
  return { accounts: await detectAccounts(home, instances, found.map((f) => ({ home: f.home, alias: f.alias }))), found };
}

export function nodeDiscoveryEnv(o: { home: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; instanceHomes?: string[]; projectRoots?: string[] }): DiscoveryEnv {
  return {
    home: o.home,
    platform: o.platform ?? process.platform,
    env: o.env ?? {},
    instanceHomes: o.instanceHomes,
    projectRoots: o.projectRoots,
    readFile: async (p) => { try { return await readFile(p, "utf8"); } catch { return null; } },
    listDirs: async (p) => {
      try {
        return (await readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
      } catch { return []; }
    },
  };
}
