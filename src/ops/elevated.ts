// An elevated shell on Windows (Run as Administrator): `t3sm start`, `schedule` and `update` still work, but what they
// install (the scheduled task, the /t3sm plugin, the global t3sm) belongs to the user that runs them, which may not be
// the account the person signs in with. t3sm warns once and never blocks. Detected with `net session`, which only an
// elevated shell may run (exit 0): by its absolute path under System32 (never through PATH or a shell), with a time
// limit and without CLAUDE_CONFIG_DIR. Anything else (another platform, a failure, a timeout) counts as not elevated.

import type { Lang } from "../assistant/i18n.ts";
import { cliT, type CliKey } from "../i18n/cli.ts";
import { defaultRunner, type Runner } from "../t3/auth.ts";
import { system32 } from "../core/sysroot.ts";

export const NET_SESSION_TIMEOUT_MS = 5_000;

export async function isElevated(platform: NodeJS.Platform, run: Runner, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (platform !== "win32") return false;
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k.toUpperCase() !== "CLAUDE_CONFIG_DIR") childEnv[k] = v;
  try {
    const r = await run(system32(env, "net.exe"), ["session"], { shell: false, timeoutMs: NET_SESSION_TIMEOUT_MS, env: childEnv });
    return r.code === 0 && !r.timedOut;
  } catch { return false; }
}

/** The real check: this process's platform and environment. */
export const realIsElevated = (): Promise<boolean> => isElevated(process.platform, defaultRunner, process.env);

let warned = false;

/** Forget that the warning was given (tests). */
export function resetElevatedWarning(): void { warned = false; }

/** What a command installs, which the warning names: start (the schedule and the /t3sm commands), schedule, update. */
export type ElevatedCommand = "start" | "schedule" | "update";
const WARNING: Record<ElevatedCommand, CliKey> = { start: "elevated.start", schedule: "elevated.schedule", update: "elevated.update" };

/**
 * One line on stderr naming what `command` installs for this user only, at most once per process (`t3sm start` runs
 * schedule and update itself), when `check` says the shell is elevated. Never throws and never blocks the command.
 */
export async function warnIfElevated(io: { stderr(s: string): void; lang?: Lang }, check: () => Promise<boolean>, command: ElevatedCommand): Promise<void> {
  if (warned) return;
  let elevated = false;
  try { elevated = await check(); } catch { elevated = false; }
  if (!elevated || warned) return;
  warned = true;
  io.stderr(`! ${cliT(io.lang ?? "en", WARNING[command])}\n`);
}
