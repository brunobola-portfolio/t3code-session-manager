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

export async function scanCommand(args: string[], io: Io, deps: ScanDeps = {}): Promise<number> {
  const json = args.includes("--json");
  const bad = args.find((a) => a !== "--json");
  if (bad !== undefined) {
    io.stderr(`Unknown option: ${bad}. Run \`t3sm scan --help\`.\n`);
    return 2;
  }
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  // scan needs no T3: without a config, the detected accounts stand in (nothing is saved).
  const config = (await loadConfig(stateDir(io.env, home), home)) ?? defaultConfig(await resolveAccounts(home, [], io.env));
  if (await runInProgress(stateDir(io.env, home))) io.stderr(`${RUN_IN_PROGRESS_NOTE}\n`);
  const adapters = deps.adapters ?? allAdapters();
  const d = await discoverAll(adapters, makeEnv(io, home, config, now));

  if (json) {
    io.stdout(JSON.stringify(d.sessions, null, 2) + "\n");
    return 0;
  }
  const groups = new Map<string, { harness: string; account: string; n: number; flagged: number }>();
  for (const s of d.sessions) {
    const k = `${s.harness}\u0000${s.accountId ?? "-"}`;
    const g = groups.get(k) ?? groups.set(k, { harness: s.harness, account: s.accountId ?? "-", n: 0, flagged: 0 }).get(k)!;
    g.n++;
    if (s.flags.length > 0) g.flagged++;
  }
  const rows = [...groups.values()].sort((a, b) => a.harness.localeCompare(b.harness) || a.account.localeCompare(b.account));
  const w1 = Math.max(7, ...rows.map((r) => r.harness.length));
  const w2 = Math.max(7, ...rows.map((r) => r.account.length));
  const lines = [`${"Harness".padEnd(w1)}  ${"Account".padEnd(w2)}  ${"Sessions".padStart(8)}  ${"Flagged".padStart(7)}`];
  for (const r of rows) lines.push(`${r.harness.padEnd(w1)}  ${r.account.padEnd(w2)}  ${String(r.n).padStart(8)}  ${String(r.flagged).padStart(7)}`);
  if (rows.length === 0) lines.push("(no sessions found)");
  lines.push("", `Total ${d.sessions.length} sessions, ${rows.reduce((n, r) => n + r.flagged, 0)} flagged, ${d.errors} read errors.`);
  if (d.unavailable.length > 0) lines.push(`Not installed: ${d.unavailable.join(", ")}.`);
  io.stdout(lines.join("\n") + "\n");
  return 0;
}
