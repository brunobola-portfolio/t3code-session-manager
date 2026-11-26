// The only way t3sm reaches Claude Code's cloud sessions: the user's own `claude` binary, started for one account, asked
// through the SDK control requests it reads on stdin (spec 2026-11-26 §2 S1, §3.3). t3sm never sees a token: the child
// uses the login stored in that account's folder. Nothing here asks the model anything, so nothing costs tokens.
//
// Framing: one JSON object per line. t3sm writes {"type":"control_request","request_id","request":{subtype,...}} and
// reads {"type":"control_response","response":{"subtype":"success"|"error","request_id","response"|"error"}}; other
// lines (system messages) are ignored. `initialize` must come first.
//
// The child's environment: the caller's, without CLAUDE_CONFIG_DIR (any case), CLAUDECODE, ANTHROPIC_* and the other
// CLAUDE_* variables a parent Claude Code session sets (they would make the child refuse, or read another account),
// then CLAUDE_CONFIG_DIR set to the account's home unless that home is the default ~/.claude (invariant 11's second
// deliberate exception, approved by the owner on 2026-11-26). Each request has its own time limit; on a timeout, or
// when t3sm stops, only this child's own process tree is killed (invariant 15).

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { sameCwd } from "../core/paths.ts";
import { killTree, trackChild } from "../t3/auth.ts";
import { CloudRequestError, CloudUnavailable, decodeListPage, decodeSessionDetails, decodeTranscriptPage, type CloudEntry, type CloudSession } from "./decode.ts";

/** How long one control request may take. */
export const REQUEST_TIMEOUT_MS = 60_000;
/** Pages at most: a list (200 rows a page) and a transcript (1000 entries a page). */
export const MAX_LIST_PAGES = 50;
export const MAX_TRANSCRIPT_PAGES = 200;
/** Entries per transcript page (the most Claude Code accepts). */
export const TRANSCRIPT_PAGE = 1000;

export const CLOUD_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] as const;

/** Variables a child keeps although they start with CLAUDE_ (they locate tools, not accounts). */
const KEEP = new Set(["CLAUDE_CODE_GIT_BASH_PATH"]);

/** The environment of one account's `claude` child (see the header). */
export function cloudChildEnv(base: NodeJS.ProcessEnv, accountHome: string, home: string, platform: NodeJS.Platform): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const u = k.toUpperCase();
    if (u === "CLAUDECODE" || u.startsWith("ANTHROPIC_") || (u.startsWith("CLAUDE_") && !KEEP.has(u))) continue;
    env[k] = v;
  }
  if (!sameCwd(accountHome, join(home, ".claude"), platform)) env["CLAUDE_CONFIG_DIR"] = accountHome;
  return env;
}

/** The running child, as the client uses it (tests pass a fake). */
export interface CloudProc {
  write(line: string): void;
  end(): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null, stderr: string) => void): void;
  kill(): void;
}
export type SpawnCloud = (bin: string, args: readonly string[], env: Record<string, string>) => CloudProc;

/** The real child: no window, its stderr kept (last 4 KiB) for the error text, tracked so Ctrl+C never orphans it. */
export const spawnCloud: SpawnCloud = (bin, args, env) => {
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  if (shell && /["\r\n\0!%]/.test(bin)) throw new CloudUnavailable("unsafe path to claude");
  // A .cmd shim: the path travels in the env and the arguments are constants, as defaultRunner does it.
  const child: ChildProcess = shell
    ? spawn(`"%T3SM_CLI%" ${args.join(" ")}`, { shell: true, env: { ...env, T3SM_CLI: bin }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(bin, [...args], { env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  const untrack = trackChild(() => killTree(child));
  let buf = "", stderr = "";
  const lines: ((l: string) => void)[] = [];
  const exits: ((c: number | null, e: string) => void)[] = [];
  let exited: { code: number | null } | null = null;
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      for (const cb of lines) cb(l);
    }
  });
  child.stderr!.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-4096); });
  child.stdin!.on("error", () => {}); // a child that exits early: its stdin closes under us
  const done = (code: number | null): void => {
    if (exited) return;
    exited = { code };
    untrack();
    for (const cb of exits) cb(code, stderr);
  };
  child.on("error", () => done(null));
  child.on("close", (code) => done(code));
  return {
    write: (l) => { if (!exited) child.stdin!.write(l); },
    end: () => { try { child.stdin!.end(); } catch { /* gone */ } },
    onLine: (cb) => { lines.push(cb); },
    onExit: (cb) => { if (exited) cb(exited.code, stderr); else exits.push(cb); },
    kill: () => killTree(child),
  };
};

/** One open child for one account. */
export interface CloudConn {
  request(req: Record<string, unknown> & { subtype: string }): Promise<unknown>;
  close(): Promise<void>;
}

export interface OpenCloudOptions {
  bin: string;
  env: Record<string, string>;
  spawn?: SpawnCloud;
  timeoutMs?: number;
}

const tail = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 300);

/** Starts the child and sends `initialize`; resolves once it answered. */
export async function openCloud(o: OpenCloudOptions): Promise<CloudConn> {
  const proc = (o.spawn ?? spawnCloud)(o.bin, CLOUD_ARGS, o.env);
  const limit = o.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const waiting = new Map<string, { ok: (v: unknown) => void; no: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let gone: Error | null = null;
  let n = 0;
  const failAll = (e: Error): void => {
    gone ??= e;
    for (const [id, w] of waiting) { clearTimeout(w.timer); waiting.delete(id); w.no(e); }
  };
  proc.onLine((line) => {
    let m: unknown;
    try { m = JSON.parse(line); } catch { return; }
    if (m === null || typeof m !== "object" || (m as { type?: unknown }).type !== "control_response") return;
    const r = (m as { response?: unknown }).response;
    if (r === null || typeof r !== "object") return;
    const { request_id: id, subtype, response, error } = r as { request_id?: unknown; subtype?: unknown; response?: unknown; error?: unknown };
    if (typeof id !== "string") return;
    const w = waiting.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    waiting.delete(id);
    if (subtype === "success") w.ok(response ?? {});
    else w.no(new CloudRequestError(typeof error === "string" && error !== "" ? error : "claude refused the request"));
  });
  proc.onExit((code, stderr) => failAll(new CloudUnavailable(`claude exited${code === null ? "" : ` with code ${code}`}${tail(stderr) ? `: ${tail(stderr)}` : ""}`)));

  const request = (req: Record<string, unknown> & { subtype: string }): Promise<unknown> => {
    if (gone) return Promise.reject(gone);
    const id = `t3sm-${++n}`;
    return new Promise((ok, no) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        proc.kill();
        failAll(new CloudUnavailable(`claude did not answer ${req.subtype} within ${Math.round(limit / 1000)} s`));
        no(gone!);
      }, limit);
      waiting.set(id, { ok, no, timer });
      proc.write(JSON.stringify({ type: "control_request", request_id: id, request: req }) + "\n");
    });
  };
  const close = async (): Promise<void> => {
    proc.end();
    await new Promise<void>((res) => {
      const t = setTimeout(() => { proc.kill(); res(); }, 3000);
      proc.onExit(() => { clearTimeout(t); res(); });
    });
  };
  try {
    await request({ subtype: "initialize" });
  } catch (e) {
    proc.kill();
    throw e;
  }
  return { request, close };
}

/** Every session row of the account, all pages. */
export async function listCloudSessions(c: CloudConn): Promise<CloudSession[]> {
  const out: CloudSession[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const p = decodeListPage(await c.request({ subtype: "list_cloud_sessions", user_initiated: true, ...(cursor ? { cursor } : {}) }));
    out.push(...p.sessions);
    if (p.next === null) break;
    cursor = p.next;
  }
  return out;
}

export async function getCloudSession(c: CloudConn, id: string): Promise<CloudSession> {
  return decodeSessionDetails(await c.request({ subtype: "get_cloud_session", session_id: id }));
}

/** Every transcript entry of one session, all pages, oldest first. */
export async function getCloudTranscript(c: CloudConn, id: string): Promise<CloudEntry[]> {
  const out: CloudEntry[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_TRANSCRIPT_PAGES; page++) {
    const p = decodeTranscriptPage(await c.request({ subtype: "get_cloud_session_transcript", session_id: id, limit: TRANSCRIPT_PAGE, ...(cursor ? { cursor } : {}) }));
    out.push(...p.entries);
    if (p.next === null) return out;
    cursor = p.next;
  }
  // Never write a conversation cut short as if it were whole.
  throw new CloudUnavailable(`the transcript of ${id} has more than ${MAX_TRANSCRIPT_PAGES * TRANSCRIPT_PAGE} entries; t3sm does not bring it here`);
}
