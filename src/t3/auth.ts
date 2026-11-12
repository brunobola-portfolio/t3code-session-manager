import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { registerSecret, pinSecret, unregisterSecret, T3AuthError } from "./errors.ts";
import { parseLocalOrigin } from "./runtime.ts";

export interface RunOptions { shell: boolean; timeoutMs: number; env: Record<string, string> }
export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type Runner = (file: string, args: string[], opts: RunOptions) => Promise<RunResult>;

const MAX_CAPTURE = 1024 * 1024; // per stream

function quoteWin(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Kill the child and its whole tree, synchronously (it must also work inside a process `exit` handler).
 * POSIX: the child leads its own (detached) group, so the group gets SIGKILL. win32: `taskkill /T /F` must run while
 * the child still exists, so child.kill() only follows it.
 */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const plain = () => { try { child.kill(); } catch { /* ignore */ } };
  if (child.pid === undefined) return plain();
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); } catch { plain(); }
    return;
  }
  try { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 }); } catch { /* ignore */ }
  plain();
}

/** The parts of `process` the child cleanup needs (injectable for tests). */
export interface ProcessLike {
  pid: number;
  on(ev: string, fn: (...a: any[]) => void): unknown;
  off(ev: string, fn: (...a: any[]) => void): unknown;
  listenerCount(ev: string): number;
  kill(pid: number, sig: string): unknown;
}

const running = new Set<() => void>(); // kill functions of children still running
let hooks: { proc: ProcessLike; onExit: () => void; onSignal: (sig: string) => void } | null = null;

function uninstall(): void {
  if (!hooks) return;
  const { proc, onExit, onSignal } = hooks;
  hooks = null;
  proc.off("exit", onExit);
  proc.off("SIGINT", onSignal);
  proc.off("SIGTERM", onSignal);
}

function killAll(): void {
  const all = [...running];
  running.clear();
  for (const k of all) { try { k(); } catch { /* keep killing the others */ } }
  uninstall();
}

/**
 * Track a running child so Ctrl+C, SIGTERM or process exit cannot orphan it. Handlers are installed once, lazily, only
 * while at least one child runs, and removed when the set empties. After a signal kills the children, the signal is
 * re-raised on ourselves (now with no listener of ours) so the default behaviour still happens: Ctrl+C is not swallowed.
 * If another SIGINT/SIGTERM listener exists it already received this signal and owns the decision, so we do not re-raise.
 * Returns an idempotent untrack function.
 */
export function trackChild(kill: () => void, proc: ProcessLike = process as unknown as ProcessLike): () => void {
  running.add(kill);
  if (!hooks) {
    const onExit = () => killAll();
    const onSignal = (sig: string) => {
      killAll();
      if (proc.listenerCount(sig) === 0) proc.kill(proc.pid, sig);
    };
    hooks = { proc, onExit, onSignal };
    proc.on("exit", onExit);
    proc.on("SIGINT", onSignal);
    proc.on("SIGTERM", onSignal);
  }
  return () => {
    running.delete(kill);
    if (running.size === 0) uninstall();
  };
}

/**
 * Runs a CLI. For .cmd/.bat (shell:true) the path travels in the child env as T3SM_CLI and the command line is
 * `"%T3SM_CLI%" <quoted constant args>`: cmd expands the variable once, so `&`, `^`, `%` or spaces in the path
 * can neither break nor inject anything. The timeout settles from the timer and kills the whole process tree.
 */
export const defaultRunner: Runner = (file, args, opts) =>
  new Promise((res) => {
    let child: ChildProcess;
    try {
      child = opts.shell
        ? spawn(`"%T3SM_CLI%" ${args.map(quoteWin).join(" ")}`, { shell: true, env: { ...opts.env, T3SM_CLI: file }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
        : spawn(file, args, { env: opts.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      res({ code: null, stdout: "", stderr: "spawn failed", timedOut: false });
      return;
    }
    let stdout = "", stderr = "", done = false;
    const untrack = trackChild(() => killTree(child));
    const finish = (code: number | null, timedOut: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      untrack();
      res({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => { killTree(child); finish(null, true); }, opts.timeoutMs);
    child.stdout!.on("data", (d: Buffer) => { if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8", 0, MAX_CAPTURE - stdout.length); });
    child.stderr!.on("data", (d: Buffer) => { if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8", 0, MAX_CAPTURE - stderr.length); });
    child.on("error", () => finish(null, false));
    child.on("close", (code) => finish(code, false));
  });

/**
 * Default least-privilege scopes (S1 2.1: `--scope` REPLACES the default 16-permission set). No settings:write: t3sm sends
 * only empty patches with a providerInstanceMutation, which need providers:manage alone (RpcAuthorization.ts 244-250).
 * Add "providers:manage" only for instance mutations.
 */
export const DEFAULT_SCOPES = ["orchestration:read", "orchestration:operate"] as const;

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.toUpperCase() === "CLAUDE_CONFIG_DIR") continue; // never leak an account home into T3's CLI (env-inheritance incident class)
    env[k] = v;
  }
  return env;
}

/** Shell only for .cmd/.bat on Windows; the path must be safe to put inside one pair of double quotes. */
function useShell(cli: string): boolean {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(cli)) return false;
  if (/["\r\n\0!]/.test(cli)) throw new T3AuthError("refusing to run a CLI path containing quotes, '!' or control characters");
  return true;
}

const SCOPE_RE = /^[a-z][a-z0-9]*:[a-z][A-Za-z0-9]*$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/;
/**
 * Auth CLI failures (issue and revoke) never carry the child's stdout or stderr in any field: a failed issue may still
 * print the token, and no scrubbing heuristic is reliable for every token shape. The user reruns the command to see why.
 */
const FAIL_HINT = "Run `t3 auth session issue --token-only` yourself to see T3's message.";
/** The command to run by hand for a failed `t3 auth session <what>` (the revoke hint names revoke, not issue). */
const hintFor = (what: string, sessionId?: string): string =>
  what === "revoke" ? `Run \`t3 auth session revoke -- ${sessionId ?? "<session id>"}\` yourself to see T3's message (the session expires on its own within 1 h).` : FAIL_HINT;
const failed = (what: string, code: number | null, sessionId?: string) => {
  const hint = hintFor(what, sessionId);
  return new T3AuthError(`\`t3 auth session ${what}\` failed (exit ${code}). ${hint}`, { hint });
};
const timedOut = (what: string, sessionId?: string) => {
  const hint = hintFor(what, sessionId);
  return new T3AuthError(`\`t3 auth session ${what}\` timed out after 30 s. ${hint}`, { hint });
};

export interface IssuedSession { token: string; sessionId: string }
export interface IssueOptions { scopes?: readonly string[]; run?: Runner }

function parseIssueJson(stdout: string): unknown {
  const t = stdout.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  return null;
}

/** `t3 auth session issue --json` -> {token, sessionId}. Caller should revokeSession(sessionId, token) when done. */
export async function issueSessionToken(cli: string, opts: IssueOptions = {}): Promise<IssuedSession> {
  const run = opts.run ?? defaultRunner;
  const scopes = opts.scopes ?? DEFAULT_SCOPES;
  for (const s of scopes) if (!SCOPE_RE.test(s)) throw new T3AuthError("invalid scope requested");
  const shell = useShell(cli);
  const args = ["auth", "session", "issue", "--json", "--label", "t3sm", "--ttl", "1h", ...scopes.flatMap((s) => ["--scope", s])];
  const r = await run(cli, args, { shell, timeoutMs: 30_000, env: childEnv() });
  if (r.timedOut) throw timedOut("issue");
  if (r.code !== 0) throw failed("issue", r.code);
  const parsed = parseIssueJson(r.stdout) as { token?: unknown; sessionId?: unknown } | null;
  const token = parsed && typeof parsed.token === "string" && parsed.token && !/\s/.test(parsed.token) ? parsed.token : null;
  const sessionId = parsed && typeof parsed.sessionId === "string" && SESSION_ID_RE.test(parsed.sessionId) ? parsed.sessionId : null;
  if (!token || !sessionId) {
    // Exit 0 but unusable. A parsed token is pinned so later output cannot leak it. Without a valid session id it cannot
    // be revoked: residual risk is a live token until its TTL (`--ttl 1h`) expires.
    if (token) pinSecret(token);
    throw new T3AuthError("T3 returned an unexpected issue response", { hint: FAIL_HINT });
  }
  pinSecret(token);
  return { token, sessionId };
}

/** `t3 auth session revoke -- <id>`: stops sessions from accumulating. Pass the token to drop it from the redaction registry. */
export async function revokeSession(cli: string, sessionId: string, run: Runner = defaultRunner, token?: string): Promise<void> {
  if (!SESSION_ID_RE.test(sessionId)) throw new T3AuthError("invalid session id");
  const shell = useShell(cli);
  const r = await run(cli, ["auth", "session", "revoke", "--", sessionId], { shell, timeoutMs: 30_000, env: childEnv() });
  if (r.timedOut) throw timedOut("revoke", sessionId);
  if (r.code !== 0) throw failed("revoke", r.code, sessionId);
  if (token) unregisterSecret(token);
}

/** POST /api/auth/websocket-ticket/rpc (S1 2.3). Tickets live 5 min; mint one per connection. Local origins only; redirects are errors. */
export async function mintWsTicket(origin: string, token: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  pinSecret(token);
  const base = parseLocalOrigin(origin);
  if (!base) throw new T3AuthError("refusing to send credentials to a non-local origin");
  let res: Response;
  try {
    res = await fetchImpl(new URL("/api/auth/websocket-ticket/rpc", base).href, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new T3AuthError(timeout ? "websocket ticket request timed out after 10 s" : "could not reach T3 Code to mint a websocket ticket");
  }
  if (res.status === 401 || res.status === 403) {
    throw new T3AuthError(`websocket ticket refused (HTTP ${res.status}): token expired or lacks permissions`, { hint: "token expired or lacks permissions" });
  }
  if (!res.ok) throw new T3AuthError(`websocket ticket request failed (HTTP ${res.status})`);
  let body: unknown;
  try { body = await res.json(); } catch { throw new T3AuthError("websocket ticket response was not JSON"); }
  const ticket = (body as { ticket?: unknown } | null)?.ticket;
  if (typeof ticket !== "string" || !ticket) throw new T3AuthError("websocket ticket response had no ticket");
  registerSecret(ticket);
  return ticket;
}
