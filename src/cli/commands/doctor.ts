import { defaultDoctorDeps, runDoctor, type Check, type DoctorDeps } from "../../ops/doctor.ts";
import type { Io } from "../main.ts";

export interface DoctorCommandDeps {
  /** Complete deps (tests). */
  deps?: DoctorDeps;
  home?: string;
  /** Replace parts of the real deps (tests). */
  overrides?: Partial<DoctorDeps>;
}

/** Io plus the terminal width when known (the launcher may set it; tests do). */
export type DoctorIo = Io & { columns?: number };

const KNOWN = new Set(["--json", "--repair"]);
const MIN_TEXT = 20;

/** Greedy word wrap; a word longer than the width (a path, a URL) keeps its own line unbroken. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur === "") cur = w;
    else if (cur.length + 1 + w.length <= width) cur += " " + w;
    else { out.push(cur); cur = w; }
  }
  if (cur !== "") out.push(cur);
  return out.length ? out : [""];
}

export function renderDoctor(checks: Check[], opts: { fancy: boolean; color: boolean; columns?: number }): string {
  const sym: Record<Check["status"], string> = opts.fancy
    ? { ok: "✓", warn: "!", fail: "✗", skip: "-" }
    : { ok: "ok", warn: "warn", fail: "FAIL", skip: "skip" };
  const paint: Record<Check["status"], (s: string) => string> = opts.color
    ? { ok: (s) => `\x1b[32m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`, fail: (s) => `\x1b[31m${s}\x1b[0m`, skip: (s) => `\x1b[2m${s}\x1b[0m` }
    : { ok: (s) => s, warn: (s) => s, fail: (s) => s, skip: (s) => s };
  const symW = Math.max(...Object.values(sym).map((s) => s.length));
  const idW = Math.max(...checks.map((c) => c.id.length));
  const indentW = symW + 2 + idW + 2;
  const textW = Math.max(MIN_TEXT, (opts.columns ?? 80) - indentW);
  const indent = " ".repeat(indentW);
  const arrow = opts.fancy ? "→" : "->";
  const lines: string[] = [];
  for (const c of checks) {
    const [first, ...rest] = wrap(c.message, textW);
    lines.push(`${paint[c.status](sym[c.status].padEnd(symW))}  ${c.id.padEnd(idW)}  ${first}`.trimEnd());
    for (const l of rest) lines.push(indent + l);
    if (c.fix && (c.status === "warn" || c.status === "fail")) {
      const [f1, ...fr] = wrap(c.fix, Math.max(MIN_TEXT, textW - arrow.length - 1));
      lines.push(`${indent}${arrow} ${f1}`);
      for (const l of fr) lines.push(`${indent}${" ".repeat(arrow.length + 1)}${l}`);
    }
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const verdict = fails > 0
    ? `${fails} ${fails === 1 ? "problem" : "problems"} to fix. Fix the items marked ${sym.fail}, then run t3sm doctor again.`
    : warns > 0 ? `Ready (${warns} ${warns === 1 ? "warning" : "warnings"} above). Next: t3sm plan` : "Ready. Next: t3sm plan";
  return `${lines.join("\n")}\n\n${verdict}\n`;
}

export async function doctorCommand(args: string[], io: DoctorIo, d: DoctorCommandDeps = {}): Promise<number> {
  for (const a of args) {
    if (!KNOWN.has(a)) { io.stderr(`Unknown option: ${a}. Run \`t3sm doctor --help\`.\n`); return 2; }
  }
  const repair = args.includes("--repair");
  const deps: DoctorDeps = d.deps
    ? { ...d.deps, repair: d.deps.repair || repair }
    : { ...defaultDoctorDeps({ home: d.home, env: io.env, repair }), ...(d.overrides ?? {}) };
  const { checks } = await runDoctor(deps);
  if (args.includes("--json")) io.stdout(JSON.stringify(checks, null, 2) + "\n");
  else {
    const fancy = io.isTTY && !io.env["NO_COLOR"];
    const columns = io.columns ?? (io.isTTY ? process.stdout.columns : undefined) ?? 80;
    io.stdout(renderDoctor(checks, { fancy, color: fancy, columns }));
  }
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}
