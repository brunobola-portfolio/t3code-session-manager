// The history rule's stored values (spec §5.2), read without any I/O: src/organize/plan.ts uses it, and plan.ts is pure.
// src/core/config.ts re-exports these, so `import { historyRule } from "../core/config.ts"` keeps working.
import type { Config, HistoryConfig, HistoryRule } from "./types.ts";

export const DEFAULT_HISTORY: Readonly<HistoryRule> = Object.freeze({ days: 90, minPerProject: 10 });

/** A stored history value as a rule: 0.2 strings map ("all" -> all days, "days:N" -> N days, minimum 10), "off" is null. */
export function normalizeHistory(h: HistoryConfig | undefined): HistoryRule | null {
  if (h === undefined) return { ...DEFAULT_HISTORY };
  if (h === "off") return null;
  if (h === "all") return { days: "all", minPerProject: DEFAULT_HISTORY.minPerProject };
  if (typeof h === "string") return { days: Number(h.slice("days:".length)), minPerProject: DEFAULT_HISTORY.minPerProject };
  return { days: h.days ?? DEFAULT_HISTORY.days, minPerProject: h.minPerProject ?? DEFAULT_HISTORY.minPerProject };
}

/** The history rule of `c` (defaults filled); null = history off. */
export function historyRule(c: Config): HistoryRule | null {
  return normalizeHistory(c.organize?.history);
}
