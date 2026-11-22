/** T3 Code server versions t3sm was verified against (spikes S1..S6; source or live). */
export const TESTED_VERSIONS: readonly string[] = Object.freeze([
  "0.1.8-nightly.20261105.4218",
  "0.1.9-nightly.20261110.4465",
  "0.1.10-nightly.20261113.4630", // spike S6 + two real imports, 2026-11-14
]);

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

/** The one wording every command uses for a T3 Code version not in TESTED_VERSIONS. */
export function untestedNotice(version: string): string {
  const v = version.replace(/[\r\n]/g, " ");
  return `Warning: T3 Code ${v} has not been tested with t3sm (tested: ${TESTED_VERSIONS.join(", ")}). Proceeding; every change is journaled and can be undone with t3sm rollback.`;
}

/**
 * Applies the gate (owner decision 2026-11-14: t3sm works with any T3 Code version). It never throws: a version in
 * TESTED_VERSIONS is silent; any other (same minor or not) emits one untested warning and proceeds, silent with
 * allowUntested. What protects an unknown version is strict response decoding (decode.ts), and the one thing that
 * still refuses is a server whose orchestration protocol is not 2 (checked in connectT3, T3Incompatible).
 */
export function compatGate(version: string, opts: CompatOptions): Compat {
  const c = checkCompat(version);
  if (c !== "tested" && !opts.allowUntested) opts.onNotice?.(untestedNotice(version));
  return c;
}

/**
 * Same gate for the organize commands and their undo, which connect with allowUntested so the connection stays quiet and
 * this speaks once (ruling R18; identical wording, so a command that runs both prints it once). Never throws.
 */
export function organizeGate(version: string, opts: CompatOptions): void {
  compatGate(version, opts);
}

/**
 * How a rehome copy follows its original when the original grows. Spike S5 (docs/spikes/S5-merge.md): T3 only continues a
 * thread from records it wrote; a merge imports a new revision and archives the old thread (proven). "refresh" (append in
 * place) is right only if S7a/S7b show the same thread growing: see docs/spikes/S7-followup-and-backdate.md.
 */
export const FOLLOW_MODE: "refresh" | "revision" = "revision";

/**
 * Whether `thread.settle` honours an optional `settledAt` (spike S8, docs/spikes/S7-followup-and-backdate.md).
 * Measured live on 2026-11-16 (T3 Code 0.1.10-nightly.20261113): `honoured`, the stored `settledAt` equals the one sent.
 */
export const SETTLE_BACKDATE = true;
