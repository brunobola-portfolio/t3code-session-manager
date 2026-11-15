// The t3sm Claude Code plugin per Claude account: whether it is installed (read-only: <home>/plugins/installed_plugins.json)
// and how to install it (two `claude plugin` child processes, run only after the user's yes, each with CLAUDE_CONFIG_DIR
// set to that account's home and nothing inherited from the shell). Network access happens only in those children.

import type { Lang } from "../assistant/i18n.ts";
import { cliT } from "../i18n/cli.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const PLUGIN_NAME = "t3sm";
export const MARKETPLACE = "t3code-session-manager";
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE}`;
/** GitHub owner/name `claude plugin marketplace add` reads (the repository this plugin is published from). */
export const MARKETPLACE_SOURCE = "brunobola-portfolio/t3code-session-manager";
/** What removes it again. */
export const UNINSTALL_COMMAND = `claude plugin uninstall ${PLUGIN_ID}`;

export type PluginState = { state: "installed" | "outdated"; version: string } | { state: "missing" };

const num = (v: string): number[] => v.split(".").map((p) => Number.parseInt(p, 10) || 0);
function older(a: string, b: string): boolean {
  const x = num(a), y = num(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

/**
 * `<accountHome>/plugins/installed_plugins.json` (`{version, plugins: {"name@marketplace": [{version, ...}]}}`), read only.
 * A missing or unreadable file, or any other shape, reads as "missing". `expected` is this t3sm's version: an older
 * installed plugin is "outdated" (a newer one is fine).
 */
export async function readPluginState(accountHome: string, expected: string): Promise<PluginState> {
  let data: unknown;
  try { data = JSON.parse((await readFile(join(accountHome, "plugins", "installed_plugins.json"), "utf8")).replace(/^\uFEFF/, "")); } catch { return { state: "missing" }; }
  const plugins = data && typeof data === "object" ? (data as { plugins?: unknown }).plugins : undefined;
  const list = plugins && typeof plugins === "object" ? (plugins as Record<string, unknown>)[PLUGIN_ID] : undefined;
  if (!Array.isArray(list) || list.length === 0) return { state: "missing" };
  const first = list[0] as { version?: unknown } | null;
  const version = first && typeof first.version === "string" && first.version !== "" ? first.version : "unknown";
  return { state: version !== "unknown" && older(version, expected) ? "outdated" : "installed", version };
}

export function describePlugin(s: PluginState, expected: string, lang: Lang = "en"): string {
  if (s.state === "installed") return cliT(lang, "status.plugin.installed", { version: s.version });
  if (s.state === "outdated") return cliT(lang, "status.plugin.outdated", { version: s.version, expected, id: PLUGIN_ID });
  return cliT(lang, "status.plugin.missing");
}

/** Runs one child and resolves with its exit code and output; never throws for a failing child. */
export type PluginExec = (file: string, args: string[], env: Record<string, string>) => Promise<{ code: number | null; output: string }>;

export interface InstallOptions {
  exec: PluginExec;
  /** Path of the `claude` executable (null: not found). */
  claudeBin: string | null;
  /** The environment the children start from; CLAUDE_CONFIG_DIR (any case) is dropped and set to the account's home. */
  env: NodeJS.ProcessEnv;
}

export interface InstallResult { ok: boolean; step?: "claude" | "marketplace" | "install"; output: string }

/** The environment for one account's child: the caller's, without any CLAUDE_CONFIG_DIR, plus the account's own. */
export function accountEnv(base: NodeJS.ProcessEnv, accountHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && k.toUpperCase() !== "CLAUDE_CONFIG_DIR") env[k] = v;
  env["CLAUDE_CONFIG_DIR"] = accountHome;
  return env;
}

/**
 * `claude plugin marketplace add <repo>` then `claude plugin install t3sm@<marketplace>`, both for this one account. A
 * marketplace that is already added is fine; any other failure stops there and reports the child's output.
 */
export async function installPlugin(accountHome: string, o: InstallOptions): Promise<InstallResult> {
  if (o.claudeBin === null) return { ok: false, step: "claude", output: "claude was not found on PATH" };
  const env = accountEnv(o.env, accountHome);
  const steps: ["marketplace" | "install", string[]][] = [
    ["marketplace", ["plugin", "marketplace", "add", MARKETPLACE_SOURCE]],
    ["install", ["plugin", "install", PLUGIN_ID]],
  ];
  let output = "";
  for (const [step, args] of steps) {
    let r: { code: number | null; output: string };
    try { r = await o.exec(o.claudeBin, args, env); } catch (e) { return { ok: false, step, output: output + (e as Error).message }; }
    output += r.output;
    if (r.code !== 0 && !(step === "marketplace" && /already (been )?(added|exists?|installed)/i.test(r.output))) return { ok: false, step, output };
  }
  return { ok: true, output };
}

/** This install's version (src/core/version.ts). */
export { packageVersion } from "../core/version.ts";
