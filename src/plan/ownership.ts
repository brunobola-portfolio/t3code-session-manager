// Which subscription owns a copy or a project (spec §4.3): content comparison between copies of one session,
// and the project-account rule route -> .vscode pin -> most recent activity -> default.

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AccountSource, Config, DiscoveredSession } from "../core/types.ts";
import { expandHome, normalizeCwd, sameCwd } from "../core/paths.ts";
import { routeAccount } from "../core/config.ts";

export type CopyRelation = "identical" | "a-extends-b" | "b-extends-a" | "diverged";

// The /vscode-account skill rewrites the drive letter in `cwd` when it mirrors a session (spec §4.3); one real mirror
// also differs in the case of a path segment. On case-insensitive platforms (win32, darwin) `cwd` values are compared
// case-insensitively; on linux they are compared exactly (two spellings are two different directories there).
const CWD_VALUE_RE = /("cwd"\s*:\s*")((?:[^"\\]|\\.)*)(")/g;

const foldsCase = (platform: NodeJS.Platform): boolean => platform === "win32" || platform === "darwin";

function normLine(l: string, fold: boolean): string {
  if (!fold || l.indexOf('"cwd"') === -1) return l;
  return l.replace(CWD_VALUE_RE, (_m, a: string, v: string, c: string) => a + v.toLowerCase() + c);
}

/**
 * Bookkeeping records Claude Code writes beside the conversation (titles, queue, last prompt, mode). Measured
 * 2026-11-11: a mirror and its continuation differ in these at the top of the file while the conversation is a
 * strict prefix, so they are not compared.
 */
const METADATA_TYPES: ReadonlySet<string> = new Set([
  "queue-operation", "ai-title", "custom-title", "last-prompt", "mode", "permission-mode", "summary", "agent-name", "tag",
]);
const METADATA_HINT_RE = /"type"\s*:\s*"(queue-operation|ai-title|custom-title|last-prompt|mode|permission-mode|summary|agent-name|tag)"/;
const METADATA_MAX_LINE = 65_536;

function isMetadata(l: string): boolean {
  if (l.length > METADATA_MAX_LINE || !METADATA_HINT_RE.test(l)) return false;
  try {
    const o = JSON.parse(l) as unknown;
    return typeof o === "object" && o !== null && METADATA_TYPES.has((o as { type?: unknown }).type as string);
  } catch {
    return false;
  }
}

function parses(l: string): boolean {
  try {
    JSON.parse(l);
    return true;
  } catch {
    return false;
  }
}

// Takes the readline iterator, created synchronously with the interface: lines emitted before an iterator is attached
// are lost, so it must never be created lazily inside the generator.
async function* conversationLines(it: AsyncIterator<string>): AsyncGenerator<string> {
  for (let r = await it.next(); !r.done; r = await it.next()) if (!isMetadata(r.value)) yield r.value;
}

/**
 * Compares two copies of one transcript line by line, streaming (never loads a file whole). CRLF equals LF, metadata
 * records (METADATA_TYPES) are skipped, and `cwd` case is ignored on win32/darwin. A partial (unparseable) last line
 * counts only when it is a prefix of the other copy's line at the same position; when the only extra content of the
 * longer copy is such a partial line, the copies are identical. Rejects on I/O errors (ENOENT, EBUSY, EISDIR).
 */
export async function compareCopies(a: string, b: string, platform: NodeJS.Platform = process.platform): Promise<CopyRelation> {
  const fold = foldsCase(platform);
  const sa = createReadStream(a);
  const sb = createReadStream(b);
  const ra = createInterface({ input: sa, crlfDelay: Infinity });
  const rb = createInterface({ input: sb, crlfDelay: Infinity });
  const ia = conversationLines(ra[Symbol.asyncIterator]());
  const ib = conversationLines(rb[Symbol.asyncIterator]());
  // Readline does not surface stream errors to its iterator in every Node version; race them in explicitly.
  let fail: ((e: unknown) => void) | null = null;
  const failed = new Promise<never>((_r, rej) => { fail = rej; });
  failed.catch(() => {});
  sa.on("error", (e) => fail!(e));
  sb.on("error", (e) => fail!(e));
  const next = (it: AsyncGenerator<string>) => Promise.race([it.next(), failed]);
  /** The other copy ran out: its remaining content is one garbage partial line -> identical, else it extends. */
  const tail = async (it: AsyncGenerator<string>, line: string, ext: CopyRelation): Promise<CopyRelation> => {
    const after = await next(it);
    return after.done === true && !parses(line) ? "identical" : ext;
  };
  try {
    let na = await next(ia);
    let nb = await next(ib);
    for (;;) {
      if (na.done && nb.done) return "identical";
      if (na.done) return await tail(ib, nb.value as string, "b-extends-a");
      if (nb.done) return await tail(ia, na.value as string, "a-extends-b");
      const la = na.value as string;
      const lb = nb.value as string;
      const nextA = await next(ia);
      const nextB = await next(ib);
      if (la !== lb) {
        const xa = normLine(la, fold);
        const xb = normLine(lb, fold);
        if (xa !== xb) {
          const aPartial = nextA.done === true && !parses(la);
          const bPartial = nextB.done === true && !parses(lb);
          if (aPartial && xb.startsWith(xa)) return "b-extends-a";
          if (bPartial && xa.startsWith(xb)) return "a-extends-b";
          return "diverged";
        }
      }
      na = nextA;
      nb = nextB;
    }
  } finally {
    // Every return above awaits inside the try: the streams are closed only after the last read finished.
    ra.close();
    rb.close();
    sa.destroy();
    sb.destroy();
  }
}

const LABEL_HINT_RE = /"type"\s*:\s*"(custom-title|tag)"/;

/**
 * User-set labels in a transcript (`custom-title` and `tag` records), as `"<type>:<value>"`. Streaming. Used to warn
 * when the copy dedupe quarantines holds a label the kept copy lacks (nothing is lost: quarantine is reversible).
 */
export async function labelRecords(file: string): Promise<Set<string>> {
  const out = new Set<string>();
  const st = createReadStream(file);
  const rl = createInterface({ input: st, crlfDelay: Infinity });
  const it = rl[Symbol.asyncIterator]();
  let fail: ((e: unknown) => void) | null = null;
  const failed = new Promise<never>((_r, rej) => { fail = rej; });
  failed.catch(() => {});
  st.on("error", (e) => fail!(e));
  try {
    for (let r = await Promise.race([it.next(), failed]); !r.done; r = await Promise.race([it.next(), failed])) {
      const l = r.value as string;
      if (l.length > METADATA_MAX_LINE || !LABEL_HINT_RE.test(l)) continue;
      try {
        const o = JSON.parse(l) as Record<string, unknown>;
        if (o["type"] === "custom-title" && typeof o["customTitle"] === "string") out.add(`custom-title:${o["customTitle"]}`);
        else if (o["type"] === "tag" && typeof o["tag"] === "string") out.add(`tag:${o["tag"]}`);
      } catch {
        // not a record
      }
    }
  } finally {
    rl.close();
    st.destroy();
  }
  return out;
}

/** JSON with comments (// and /* *\/ outside strings) and trailing commas, as VS Code writes settings.json. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas, string-aware.
  let res = "";
  for (let k = 0; k < out.length; k++) {
    const c = out[k]!;
    if (c === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      res += out.slice(k, j + 1);
      k = j;
    } else if (c === ",") {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j]!)) j++;
      if (out[j] !== "}" && out[j] !== "]") res += c;
    } else {
      res += c;
    }
  }
  return JSON.parse(res);
}

const isObj = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u);

/** `CLAUDE_CONFIG_DIR` from `claudeCode.environmentVariables` (array of {name, value} or an object), else null. */
export function pinFromSettings(settings: unknown): string | null {
  if (!isObj(settings)) return null;
  let ev: unknown = settings["claudeCode.environmentVariables"];
  if (ev === undefined && isObj(settings["claudeCode"])) ev = settings["claudeCode"]["environmentVariables"];
  if (Array.isArray(ev)) {
    for (const e of ev) {
      if (isObj(e) && e["name"] === "CLAUDE_CONFIG_DIR" && typeof e["value"] === "string" && e["value"] !== "") return e["value"];
    }
    return null;
  }
  if (isObj(ev) && typeof ev["CLAUDE_CONFIG_DIR"] === "string" && ev["CLAUDE_CONFIG_DIR"] !== "") return ev["CLAUDE_CONFIG_DIR"];
  return null;
}

/** Reads `<root>/.vscode/settings.json` only (never a parent). Missing or unparseable -> null. */
export async function readVscodePin(root: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(join(root, ".vscode", "settings.json"), "utf8");
  } catch {
    return null;
  }
  try {
    return pinFromSettings(parseJsonc(text.replace(/^﻿/, "")));
  } catch {
    return null;
  }
}

export interface ProjectAccountEvidence {
  /** Winner sessions; only Claude sessions whose cwd is sameCwd to root count for rule 3. */
  sessions: DiscoveredSession[];
  config: Config;
  readVscodePin(root: string): Promise<string | null>;
  platform?: NodeJS.Platform;
  /** User home for `~` in account homes and pins (default os.homedir()). */
  home?: string;
}

function expandVars(p: string, home: string): string {
  return expandHome(p.replace(/^\$\{(?:userHome|env:USERPROFILE|env:HOME)\}/, home).replace(/^%USERPROFILE%/i, home), home);
}

/** Account id whose home equals `dir` (after ~ expansion), or null. */
export function accountForHome(dir: string, config: Config, home: string, platform: NodeJS.Platform): string | null {
  const d = expandVars(dir, home);
  for (const a of config.accounts) {
    if (sameCwd(expandVars(a.home, home), d, platform)) return a.id;
  }
  return null;
}

/** Spec §4.3 rule 3: route -> `.vscode/settings.json` pin -> newest activity -> default. */
export async function projectAccount(root: string, ev: ProjectAccountEvidence): Promise<{ accountId: string; source: AccountSource }> {
  const platform = ev.platform ?? process.platform;
  const home = ev.home ?? homedir();
  const routed = routeAccount(root, ev.config, platform);
  if (routed !== null) return { accountId: routed, source: "route" };
  const pin = await ev.readVscodePin(root);
  if (pin !== null) {
    const acct = accountForHome(pin, ev.config, home, platform);
    if (acct !== null) return { accountId: acct, source: "vscode-pin" };
  }
  const known = new Set(ev.config.accounts.map((a) => a.id));
  let best: DiscoveredSession | null = null;
  const nroot = normalizeCwd(root, platform);
  for (const s of ev.sessions) {
    if (s.harness !== "claude" || s.accountId === null || !known.has(s.accountId) || s.cwd === null) continue;
    if (!sameCwd(s.cwd, nroot, platform)) continue;
    if (best === null || newer(s, best, ev.config)) best = s;
  }
  if (best !== null) return { accountId: best.accountId!, source: "recent-activity" };
  return { accountId: ev.config.defaultAccount, source: "default" };
}

/** Newest updatedAt, then newest mtime, then the default account, then config order (deterministic). */
function newer(a: DiscoveredSession, b: DiscoveredSession, c: Config): boolean {
  const ta = Date.parse(a.updatedAt) || 0;
  const tb = Date.parse(b.updatedAt) || 0;
  if (ta !== tb) return ta > tb;
  if (a.file.mtimeMs !== b.file.mtimeMs) return a.file.mtimeMs > b.file.mtimeMs;
  if ((a.accountId === c.defaultAccount) !== (b.accountId === c.defaultAccount)) return a.accountId === c.defaultAccount;
  const order = (s: DiscoveredSession) => c.accounts.findIndex((x) => x.id === s.accountId);
  if (order(a) !== order(b)) return order(a) < order(b);
  return a.file.path < b.file.path;
}
