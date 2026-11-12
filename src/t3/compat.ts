import { T3Incompatible } from "./errors.ts";

/** T3 Code server versions t3sm was verified against (spike S1 source + S1..S4 live). */
export const TESTED_VERSIONS: readonly string[] = Object.freeze(["0.1.8-nightly.20261105.4218", "0.1.9-nightly.20261110.4465"]);

export type Compat = "tested" | "same-minor" | "untested";

function majorMinor(v: string): string | null {
  const m = /^(\d+)\.(\d+)\.\d+/.exec(v) ?? /^(\d+)\.(\d+)$/.exec(v);
  return m ? `${m[1]}.${m[2]}` : null;
}

/** exact tested -> "tested"; same major.minor as a tested version -> "same-minor"; anything else (or unparseable) -> "untested". */
export function checkCompat(version: string): Compat {
  if (TESTED_VERSIONS.includes(version)) return "tested";
  const mm = majorMinor(version);
  if (mm !== null && TESTED_VERSIONS.some((t) => majorMinor(t) === mm)) return "same-minor";
  return "untested";
}

export interface CompatOptions { allowUntested: boolean; onNotice?: (line: string) => void }

/**
 * Applies the gate: "tested" is silent, "same-minor" proceeds with one notice line, "untested" throws T3Incompatible
 * (exit 4) unless allowUntested, in which case it proceeds with one notice line.
 */
export function compatGate(version: string, opts: CompatOptions): Compat {
  const c = checkCompat(version);
  const tested = TESTED_VERSIONS.join(", ");
  const v = version.replace(/[\r\n]/g, " ");
  if (c === "same-minor") opts.onNotice?.(`T3 Code ${v} was not tested exactly (tested: ${tested}); same minor version, proceeding.`);
  if (c === "untested") {
    if (!opts.allowUntested) throw new T3Incompatible(version, `T3 Code ${v} is untested (tested: ${tested}). Rerun with --allow-untested to proceed anyway.`);
    opts.onNotice?.(`T3 Code ${v} is untested (tested: ${tested}); proceeding because of --allow-untested.`);
  }
  return c;
}
