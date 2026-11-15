// The error to exit-code mapping and the plain-text message of every typed error (English: logs, --quiet, --json).
// Lives under ops/ so the operations (doctor, sync) use it without importing the CLI; src/cli/errors.ts draws the panel.
import { homedir } from "node:os";
import { ConfigError } from "../core/config.ts";
import { RpcClosed, RpcError, RpcTimeout, ShapeError, T3AuthError, T3HttpError, T3Incompatible, T3NotRunning, redact } from "../t3/errors.ts";
import { InstanceHomeDrift } from "./accounts.ts";
import { ApplyRefusal } from "../apply/apply.ts";
import { JournalWriteError } from "./quarantine.ts";

/** An unexpected error's text, safe to print and log: tokens redacted, the user's home folder shown as ~. */
export function redactUnexpected(message: string): string {
  const home = homedir();
  const variants = [home, home.replaceAll("\\", "/"), home.replaceAll("/", "\\")].filter((h) => h.length > 1);
  let out = message;
  for (const h of [...new Set(variants)]) out = out.split(h).join("~");
  return redact(out);
}

/** T3 Code unreachable mid-run, whichever transport noticed: the WebSocket closed or stopped answering, or no HTTP response. */
export const lostContact = (e: unknown): e is Error => e instanceof RpcClosed || e instanceof RpcTimeout || (e instanceof T3HttpError && e.status === null);

/** Central error to exit-code mapping: 2 usage/config, 3 T3 not running, 4 incompatible/shape, 1 unexpected. */
export function describeError(e: unknown): { code: number; message: string } {
  if (e instanceof T3NotRunning) return { code: 3, message: "T3 Code is not running. Open it from the Start menu and try again." };
  if (e instanceof T3Incompatible || e instanceof ShapeError) return { code: 4, message: e.message };
  if (e instanceof JournalWriteError) return { code: 1, message: e.message };
  if (e instanceof ConfigError || e instanceof InstanceHomeDrift || e instanceof ApplyRefusal) return { code: 2, message: e.message };
  if (e instanceof T3AuthError) return { code: 1, message: `${e.message}${e.hint ? `\n${e.hint}` : ""}` };
  // Exit 3, like "not running".
  if (lostContact(e)) return { code: 3, message: `Lost contact with T3 Code (${e.message}). Is it still running? Try again.` };
  if (e instanceof T3HttpError || e instanceof RpcError) return { code: 1, message: `T3 Code rejected the request: ${e.message}` };
  return { code: 1, message: `Unexpected error: ${redactUnexpected(e instanceof Error ? e.message : String(e))}` };
}

/** The message on one line (for --quiet and scheduler logs). */
export function oneLine(message: string): string {
  return message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" ");
}

