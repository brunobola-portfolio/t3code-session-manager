import { homedir } from "node:os";
import { join } from "node:path";
import { Journal, pendingMtimePaths } from "../../core/journal.ts";
import { lockInfo } from "../../core/lock.ts";
import type { Config, DiscoveredSession } from "../../core/types.ts";
import { stateDir } from "../../core/paths.ts";
import { loadConfig, defaultConfig } from "../../core/config.ts";
import { resolveAccounts } from "../../ops/discoverAccounts.ts";
import { allAdapters } from "../../sources/registry.ts";
import type { Env, SourceAdapter } from "../../sources/types.ts";
import type { Io } from "../main.ts";
import { cliUi, type CliUi, unknownOption } from "../ui.ts";
import { table } from "../../ui/components.ts";
import { textLines } from "../screen.ts";
import { shownAccountName, shownText } from "../../plan/names.ts";
import { FLAG_SPECS } from "../flags.ts";

export interface ScanDeps {
  adapters?: SourceAdapter[];
  home?: string;
  now?: () => number;
}

export interface Discovery { sessions: DiscoveredSession[]; errors: number; unavailable: string[] }

/** One line for scan / plan when a run holds the lock or left file times bumped: bumped files read as recent. */
export const RUN_IN_PROGRESS_NOTE = "Note: a t3sm run is in progress or was interrupted; results may show sessions as active — run `t3sm doctor`.";

/** True when another run holds (or left) the lock, or the journal has file times not restored yet. Read-only. */
export async function runInProgress(dir: string): Promise<boolean> {
  if ((await lockInfo(dir).catch(() => null)) !== null) return true;
  const entries = await new Journal(join(dir, "journal.jsonl")).readAll().catch(() => []);
  return pendingMtimePaths(entries).length > 0;
}

export function makeEnv(io: Io, home: string, config: Config, now: () => number): Env {
  return { home, platform: process.platform, now, config, stateDir: stateDir(io.env, home), env: io.env };
}

/** Runs every available adapter and collects sessions plus the number of per-file errors they recorded. */
export async function discoverAll(adapters: SourceAdapter[], env: Env): Promise<Discovery> {
  const sessions: DiscoveredSession[] = [];
  const unavailable: string[] = [];
  let errors = 0;
  for (const a of adapters) {
    if (!(await a.isAvailable(env))) {
      unavailable.push(a.id);
      continue;
    }
    for await (const s of a.discover(env)) sessions.push(s);
    errors += (a as { lastErrors?: unknown[] }).lastErrors?.length ?? 0;
  }
  return { sessions, errors, unavailable };
}

const AGENT_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode" };

interface ScanRow { agent: string; account: string; n: number; flagged: number }

/**
 * The sessions per agent and account as a table (sessions and flagged ones right-aligned), then the totals and the
 * agents that are not installed, in the user's language. An account shows its display name from config.json
 * (`names`, by account id); one without a name shows its id. --json keeps the ids.
 */
export function renderScan(ui: CliUi, d: Discovery, width: number = ui.width, names: Readonly<Record<string, string>> = {}): string[] {
  const { s, t, f } = ui;
  const groups = new Map<string, ScanRow & { harness: string }>();
  for (const x of d.sessions) {
    const k = `${x.harness}\u0000${x.accountId ?? "-"}`;
    const g = groups.get(k) ?? groups.set(k, { harness: x.harness, agent: AGENT_NAME[x.harness] ?? shownText(x.harness, 30), account: shownText(x.accountId === null ? "-" : names[x.accountId] ? shownAccountName(names[x.accountId]!) : x.accountId, 60), n: 0, flagged: 0 }).get(k)!;
    g.n++;
    if (x.flags.length > 0) g.flagged++;
  }
  // Two accounts of one agent with the same name are told apart by their id.
  const ids = new Map<string, Set<string>>();
  for (const x of d.sessions) if (x.accountId !== null) {
    const name = `${x.harness}\u0000${groups.get(`${x.harness}\u0000${x.accountId}`)!.account}`;
    (ids.get(name) ?? ids.set(name, new Set()).get(name)!).add(x.accountId);
  }
  for (const [k, g] of groups) {
    const id = k.split("\u0000")[1]!;
    if (id !== "-" && g.account !== id && (ids.get(`${g.harness}\u0000${g.account}`)?.size ?? 0) > 1) g.account = `${g.account} (${shownText(id, 40)})`;
  }
  const rows = [...groups.values()].sort((a, b) => a.harness.localeCompare(b.harness) || a.account.localeCompare(b.account));
  const out: string[] = rows.length === 0 ? textLines(s, t("scan.none"), width) : table(s, [
    { header: t("scan.col.agent"), get: (r) => (r as ScanRow).agent, priority: 8 },
    { header: t("scan.col.account"), get: (r) => (r as ScanRow).account, priority: 6, truncate: "middle" },
    { header: t("scan.col.sessions"), get: (r) => f.n((r as ScanRow).n), align: "right", priority: 9 },
    { header: t("scan.col.flagged"), get: (r) => f.n((r as ScanRow).flagged), align: "right", priority: 5 },
  ], rows, width);
  out.push("", ...textLines(s, t("scan.total", { n: d.sessions.length, count: f.n(d.sessions.length), f: rows.reduce((n, r) => n + r.flagged, 0), e: d.errors }), width));
  if (d.unavailable.length > 0) out.push(...textLines(s, t("scan.notInstalled", { list: d.unavailable.map((u) => AGENT_NAME[u] ?? u).join(", ") }), width));
  return out;
}

export async function scanCommand(args: string[], io: Io, deps: ScanDeps = {}): Promise<number> {
  const json = args.includes("--json");
  const bad = args.find((a) => !(FLAG_SPECS.scan.bool as readonly string[]).includes(a));
  if (bad !== undefined) {
    unknownOption(io, bad, "scan");
    return 2;
  }
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  // scan needs no T3: without a config, the detected accounts stand in (nothing is saved).
  const config = (await loadConfig(stateDir(io.env, home), home)) ?? defaultConfig(await resolveAccounts(home, [], io.env));
  if (await runInProgress(stateDir(io.env, home))) io.stderr(`${cliUi(io).t("scan.runInProgress")}\n`);
  const adapters = deps.adapters ?? allAdapters();
  const d = await discoverAll(adapters, makeEnv(io, home, config, now));

  if (json) {
    io.stdout(JSON.stringify(d.sessions, null, 2) + "\n");
    return 0;
  }
  io.stdout(renderScan(cliUi(io), d, undefined, Object.fromEntries(config.accounts.map((a) => [a.id, a.displayName]))).join("\n") + "\n");
  return 0;
}
