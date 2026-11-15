import { defaultDoctorDeps, runDoctor, sayText, type Check, type DoctorDeps } from "../../ops/doctor.ts";
import { shownText } from "../../plan/names.ts";
import { callout, panel, table, type Column } from "../../ui/components.ts";
import { snugWidth, textLines } from "../screen.ts";
import { FLAG_SPECS } from "../flags.ts";
import type { Io } from "../main.ts";
import { cliUi, type CliKey, type CliUi, unknownOption } from "../ui.ts";

export interface DoctorCommandDeps {
  /** Complete deps (tests). */
  deps?: DoctorDeps;
  home?: string;
  /** Replace parts of the real deps (tests). */
  overrides?: Partial<DoctorDeps>;
}

/** Io plus the terminal width when known (the launcher may set it; tests do). */
export type DoctorIo = Io & { columns?: number };

const KNOWN = new Set<string>(FLAG_SPECS.doctor.bool);

/** Each check's name on screen (the id stays in --json). */
const CHECK_NAME: Record<string, CliKey> = {
  "node-version": "doctor.check.nodeVersion", "state-dir": "doctor.check.stateDir", config: "doctor.check.config",
  lock: "doctor.check.lock", "pending-mtimes": "doctor.check.pendingMtimes", "future-mtimes": "doctor.check.futureMtimes",
  "claude-env": "doctor.check.claudeEnv", "t3-runtime": "doctor.check.t3Runtime", "t3-reachable": "doctor.check.t3Reachable",
  "t3-version": "doctor.check.t3Version", "t3-cli": "doctor.check.t3Cli", "t3-token": "doctor.check.t3Token",
  instances: "doctor.check.instances", "instance-home-drift": "doctor.check.instanceHomeDrift",
  "instance-unpinned": "doctor.check.instanceUnpinned", "instance-accounts": "doctor.check.instanceAccounts",
  "accounts-undiscovered": "doctor.check.accountsUndiscovered", "backups-present": "doctor.check.backupsPresent",
  "quarantine-orphans": "doctor.check.quarantineOrphans", harnesses: "doctor.check.harnesses",
  "t3sm-plugin": "doctor.check.t3smPlugin", schedule: "doctor.check.schedule", "sync-watcher": "doctor.check.syncWatcher",
  "merge-pending": "doctor.check.mergePending",
};
const HARNESS_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode" };

/** A check's name in the user's language: `harness:codex` -> "Codex sessions"; an unknown id stays as it is. */
export function checkName(ui: CliUi, id: string): string {
  const h = /^harness:(.+)$/.exec(id);
  if (h) return ui.t("doctor.check.harness", { name: HARNESS_NAME[h[1]!] ?? shownText(h[1], 40) });
  const k = CHECK_NAME[id];
  return k ? ui.t(k) : shownText(id, 40);
}

interface Row { sym: string; name: string; message: string }

/** A check's result and fix in the user's language: worded from the catalogue (English: the --json message and fix). */
export function checkWords(c: Check, lang: CliUi["lang"]): { message: string; fix: string | undefined } {
  return { message: c.say ? sayText(c.say, lang) : c.message, fix: c.sayFix ? sayText(c.sayFix, lang) : c.fix };
}

/**
 * The checks as one table (symbol, check, result cut to the width), then every warning and failure in full with what
 * to do, then the verdict as a panel as wide as it needs. Results and fixes in the user's language (checkWords).
 */
export function renderDoctor(checks: Check[], ui: CliUi): string {
  const { s, t } = ui;
  const width = Math.max(1, ui.width);
  const symOf = (c: Check): string => c.status === "ok" ? s("ok", s.sym.ok) : c.status === "warn" ? s("warn", s.sym.warn) : c.status === "fail" ? s("err", s.sym.err) : s("muted", s.sym.ring);
  // A warning or failure is told once, in full, below the table: its row only points there.
  const rows: Row[] = checks.map((c) => ({
    sym: symOf(c), name: checkName(ui, c.id),
    message: c.status === "warn" || c.status === "fail" ? s("muted", t("doctor.seeBelow")) : shownText(checkWords(c, ui.lang).message, 400),
  }));
  const cols: Column[] = [
    { header: "", get: (r) => (r as Row).sym, priority: 9, min: 1 },
    { header: t("doctor.col.check"), get: (r) => (r as Row).name, priority: 8, min: 10 },
    { header: t("doctor.col.result"), get: (r) => (r as Row).message, priority: 5, min: 10 },
  ];
  const out = table(s, cols, rows, width);
  // What is wrong, in full: the message and the fix, never cut.
  for (const c of checks.filter((x) => x.status === "fail" || x.status === "warn")) {
    const w = checkWords(c, ui.lang);
    // `backticked` commands are shown whole, in the key style, without their backticks.
    const body = [...textLines(s, shownText(w.message, 1000), Math.max(1, width - 2)), ...(w.fix ? textLines(s, t("doctor.whatToDo", { fix: shownText(w.fix, 1000) }), Math.max(1, width - 2)) : [])];
    out.push("", ...callout(s, { kind: c.status === "fail" ? "needs-you" : "warn", title: checkName(ui, c.id), body }, width));
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const v = fails > 0
    ? { tone: "err" as const, title: t("doctor.problems", { n: fails }), body: [t("doctor.problemsBody", { sym: s.sym.err })] }
    : { tone: "ok" as const, title: warns > 0 ? t("doctor.readyWarnings", { n: warns }) : t("doctor.ready"), body: [t("doctor.next")] };
  // As wide as its content (like the other panels), never wider than the window.
  const verdict = panel(s, v, snugWidth(`${s.sym.ok} ${v.title}`, v.body, width));
  out.push("", ...verdict);
  return out.join("\n") + "\n";
}

export async function doctorCommand(args: string[], io: DoctorIo, d: DoctorCommandDeps = {}): Promise<number> {
  for (const a of args) {
    if (!KNOWN.has(a)) { unknownOption(io, a, "doctor"); return 2; }
  }
  const repair = args.includes("--repair");
  const deps: DoctorDeps = d.deps
    ? { ...d.deps, repair: d.deps.repair || repair }
    : { ...defaultDoctorDeps({ home: d.home, env: io.env, repair }), ...(d.overrides ?? {}) };
  const { checks } = await runDoctor(deps);
  // --json is unchanged: the English message and fix, never the screen's wording parts.
  if (args.includes("--json")) io.stdout(JSON.stringify(checks.map(({ say: _s, sayFix: _f, ...c }) => c), null, 2) + "\n");
  else {
    const ui = cliUi(io);
    io.stdout(renderDoctor(checks, io.columns !== undefined ? { ...ui, width: io.columns } : ui));
  }
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}
