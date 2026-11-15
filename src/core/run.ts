/** The command-runner contract shared by core and ops (the real implementation is realRunner in ops/schedule.ts). */
export interface RunResult { code: number; stdout: string; stderr: string }
/** timeoutMs: kill the command (its own pid) after this long and report exit 124; runners without a timer ignore it. */
export type CommandRunner = (cmd: string, args: string[], opts?: { input?: string; cwd?: string; timeoutMs?: number }) => Promise<RunResult>;
