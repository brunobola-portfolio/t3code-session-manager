// `t3sm stats`: a usage summary of what is on this machine, read-only. Discovery runs with `readOnly` (no cache saved),
// the journal and the latest plan are only read, T3 Code is never contacted and nothing is sent anywhere.

import { homedir } from "node:os";
import { join } from "node:path";
import { Journal } from "../../core/journal.ts";
import { stateDir } from "../../core/paths.ts";
import { loadConfig, defaultConfig } from "../../core/config.ts";
import type { Plan } from "../../core/types.ts";
import { resolveAccounts } from "../../ops/discoverAccounts.ts";
import { computeStats, type Stats } from "../../ops/stats.ts";
import { allAdapters } from "../../sources/registry.ts";
import type { SourceAdapter } from "../../sources/types.ts";
import { shownText } from "../../plan/names.ts";
import { SKIP_WORDS } from "../../plan/report.ts";
import { kv, panel, table } from "../../ui/components.ts";
import { padStart } from "../../ui/text.ts";
import { snugWidth, textLines } from "../screen.ts";
import { FLAG_SPECS } from "../flags.ts";
import type { Io } from "../main.ts";
import { cliUi, type CliUi, unknownOption } from "../ui.ts";
import { discoverAll, makeEnv } from "./scan.ts";
import { latestPlan, readPlan } from "./apply.ts";

export interface StatsDeps {
  adapters?: SourceAdapter[];
  home?: string;
  now?: () => number;
}

const AGENT_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode" };
/** Months shown on screen (--json has them all). */
const MONTHS_SHOWN = 12;
const BAR_MAX = 20;

/** A bar of `n` against `max`, at most `cells` wide (at least one cell for any n > 0). */
function bar(ui: CliUi, n: number, max: number, cells: number): string {
  if (max <= 0 || n <= 0 || cells <= 0) return "";
  const k = Math.max(1, Math.round((n / max) * cells));
  return ui.s("accent", ui.s.sym.barFull.repeat(k));
}

/** The summary on screen: totals in a panel, then sessions per agent, per Claude account and per month, the latest plan. */
export function renderStats(ui: CliUi, st: Stats, width: number = ui.width): string[] {
  const { s, t, f } = ui;
  const w = Math.max(1, width);
  if (st.sessions === 0 && st.imported.threads === 0) {
    const out = textLines(s, t("stats.none"), w);
    if (st.notInstalled.length > 0) out.push(...textLines(s, t("scan.notInstalled", { list: st.notInstalled.map((u) => AGENT_NAME[u] ?? u).join(", ") }), w));
    out.push("", ...textLines(s, t("stats.local"), w));
    return out;
  }
  const counts: [string, number][] = [
    [t("stats.label.sessions"), st.sessions],
    [t("stats.label.imported"), st.imported.threads],
    [t("stats.label.converted"), st.imported.converted],
    [t("stats.label.failed"), st.imported.failed],
  ];
  const nw = Math.max(...counts.map(([, n]) => f.n(n).length));
  const rows: [string, string][] = counts.map(([k, n]) => [k, s("num", padStart(f.n(n), nw))]);
  rows.push([t("stats.label.lastImport"), st.imported.lastAt === null ? t("stats.never") : f.date(st.imported.lastAt)]);
  const body = kv(s, rows, Math.max(1, w - 4));
  const title = t("stats.title");
  const out = panel(s, { title, body }, snugWidth(title, body, w));

  const cells = Math.max(0, Math.min(BAR_MAX, w - 30));
  const num = (r: unknown): string => f.n((r as { n: number }).n);
  const section = (heading: string, rowsOf: { label: string; n: number }[], labelHeader: string, withBar: boolean): void => {
    if (rowsOf.length === 0) return;
    const max = Math.max(...rowsOf.map((r) => r.n));
    out.push("", ...textLines(s, s("title", heading), w));
    out.push(...table(s, [
      { header: labelHeader, get: (r) => (r as { label: string }).label, priority: 8, truncate: "middle" },
      { header: t("stats.col.sessions"), get: num, align: "right", priority: 9 },
      ...(withBar && cells > 0 ? [{ header: "", get: (r: unknown) => bar(ui, (r as { n: number }).n, max, cells), priority: 1, min: 1 }] : []),
    ], rowsOf, w));
  };
  section(t("stats.head.agents"), st.agents.map((a) => ({ label: AGENT_NAME[a.agent] ?? shownText(a.agent, 30), n: a.sessions })), t("stats.col.agent"), true);
  section(t("stats.head.accounts"), st.accounts.map((a) => ({ label: a.name ?? shownText(a.accountId, 60), n: a.sessions })), t("stats.col.account"), true);
  const months = st.months.slice(-MONTHS_SHOWN);
  section(st.months.length > MONTHS_SHOWN ? t("stats.head.monthsLast", { n: MONTHS_SHOWN }) : t("stats.head.months"),
    months.map((m) => ({ label: m.month, n: m.sessions })), t("stats.col.month"), true);
  if (st.undated > 0) out.push(...textLines(s, t("stats.undated", { n: st.undated, count: f.n(st.undated) }), w));

  out.push("");
  const p = st.latestPlan;
  if (p === null) out.push(...textLines(s, t("stats.noPlan"), w));
  else {
    out.push(...textLines(s, t("stats.plan", { date: f.date(p.createdAt), i: f.n(p.import), c: f.n(p.convert), s: f.n(p.skip) }), w));
    const top = p.skipped.slice(0, 3).map((x) => `${t(SKIP_WORDS[x.reason])} ${f.n(x.sessions)}`);
    if (top.length > 0) out.push(...textLines(s, t("stats.planTop", { parts: top.join(", ") }), w, 2));
  }
  if (st.readErrors > 0) out.push(...textLines(s, t("stats.readErrors", { e: st.readErrors, count: f.n(st.readErrors) }), w));
  if (st.notInstalled.length > 0) out.push(...textLines(s, t("scan.notInstalled", { list: st.notInstalled.map((u) => AGENT_NAME[u] ?? u).join(", ") }), w));
  out.push("", ...textLines(s, s("muted", t("stats.local")), w));
  return out;
}

/** The newest plan.json, or null (none, or unreadable: stats only reports, it never fails over an old plan). */
async function readLatestPlan(dir: string): Promise<Plan | null> {
  const p = await latestPlan(dir).catch(() => null);
  if (p === null) return null;
  return readPlan(p).catch(() => null);
}

export async function statsCommand(args: string[], io: Io, deps: StatsDeps = {}): Promise<number> {
  const bad = args.find((a) => !(FLAG_SPECS.stats.bool as readonly string[]).includes(a));
  if (bad !== undefined) {
    unknownOption(io, bad, "stats");
    return 2;
  }
  const json = args.includes("--json");
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const dir = stateDir(io.env, home);
  // Like scan: without a config, the detected accounts stand in (nothing is saved).
  const config = (await loadConfig(dir, home)) ?? defaultConfig(await resolveAccounts(home, [], io.env));
  const d = await discoverAll(deps.adapters ?? allAdapters(), { ...makeEnv(io, home, config, now), readOnly: true });
  const journal = await new Journal(join(dir, "journal.jsonl")).readAll().catch(() => []);
  const st = computeStats({
    sessions: d.sessions, journal, latestPlan: await readLatestPlan(dir),
    names: Object.fromEntries(config.accounts.map((a) => [a.id, a.displayName])), unavailable: d.unavailable, readErrors: d.errors,
  });
  if (json) io.stdout(JSON.stringify(st, null, 2) + "\n");
  else io.stdout(renderStats(cliUi(io, { now }), st).join("\n") + "\n");
  return 0;
}
