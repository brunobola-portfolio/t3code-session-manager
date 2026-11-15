// Where Windows' own programs live. t3sm starts powershell.exe, taskkill.exe, schtasks.exe, conhost.exe, cmd.exe and
// net.exe by their absolute path under %SystemRoot%\System32, never by bare name: without a shell, Windows resolves a
// bare name in the current folder before PATH, so a planted `powershell.exe` there would run instead.

import { win32 } from "node:path";

/** The Windows folder when no environment variable names one. */
export const DEFAULT_SYSTEM_ROOT = "C:\\Windows";

/**
 * %SystemRoot% (else %windir%) when it is a drive path such as `C:\Windows`; null when it is set to anything else (a
 * relative folder, a drive-less `\Windows`, a network share or a device path would choose where the program comes
 * from). Neither set: DEFAULT_SYSTEM_ROOT. A trailing separator is dropped.
 */
export function driveSystemRoot(env: Record<string, string | undefined>): string | null {
  const v = env["SystemRoot"] || env["windir"];
  if (v === undefined || v === "") return DEFAULT_SYSTEM_ROOT;
  return /^[A-Za-z]:\\/.test(v) ? v.replace(/[\\/]+$/, "") : null;
}

/** driveSystemRoot, or DEFAULT_SYSTEM_ROOT when the environment's value is not a drive path. */
export function systemRoot(env: Record<string, string | undefined>): string {
  return driveSystemRoot(env) ?? DEFAULT_SYSTEM_ROOT;
}

/** `<systemRoot>\System32\<parts...>`: the absolute path of a Windows program. */
export function system32(env: Record<string, string | undefined>, ...parts: string[]): string {
  return win32.join(systemRoot(env), "System32", ...parts);
}
