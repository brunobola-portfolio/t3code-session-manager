// What a writing command does when another t3sm run holds the lock: it writes nothing, says so and exits 0. The line
// and the structured signal (Io.onLockBusy, used by the guided assistant) live here, in one place.

import type { Io } from "./main.ts";

export const LOCK_BUSY_LINE = "Another t3sm run is in progress.";

/** Prints LOCK_BUSY_LINE (unless `quiet`) and tells the caller through io.onLockBusy. The command then returns 0. */
export function reportLockBusy(io: Io, quiet = false): void {
  if (!quiet) io.stdout(`${LOCK_BUSY_LINE}\n`);
  io.onLockBusy?.();
}
