// The two time windows every part of t3sm judges transcripts by. One definition each.

/** A transcript written within this long is in use: never bumped, imported, converted or rewritten this run. */
export const ACTIVE_WINDOW_MS = 600_000;
/** T3's importer window: transcripts modified in the last 30 days are eligible (S2 §3). */
export const IMPORT_WINDOW_MS = 30 * 86_400_000;

/** Written within ACTIVE_WINDOW_MS of `now` (any future time counts as recent). */
export function isActive(mtimeMs: number, now: number): boolean {
  return now - mtimeMs < ACTIVE_WINDOW_MS;
}

/** Inside T3's importer window as seen at `now` (a future time passes this check; T3 itself skips the future). */
export function inImportWindow(mtimeMs: number, now: number): boolean {
  return now - mtimeMs <= IMPORT_WINDOW_MS;
}
