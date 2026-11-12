// Typed errors for everything that talks to T3 Code. Messages never carry tokens or tickets.

const MAX_SECRETS = 64;
const MAX_TEXT = 8192;
/**
 * The exact-value pass (split/join per registered secret) is O(input x secrets). Its input is cut to 1 MiB first so a huge
 * WebSocket failure payload stays cheap. Output is truncated to MAX_TEXT anyway, so nothing past 1 MiB is ever shown.
 */
export const MAX_EXACT_SCAN = 1024 * 1024;
const secrets = new Map<string, true>(); // LRU, insertion-ordered: oldest evicted first (tickets, misc)
const pinned = new Set<string>(); // active session tokens: never evicted until unregisterSecret

/** Register an exact secret value so redact() removes it wherever it appears. Tickets and the like live in a 64-entry LRU. */
export function registerSecret(s: string): void {
  if (typeof s !== "string" || s.length < 8 || pinned.has(s)) return;
  secrets.delete(s);
  secrets.set(s, true);
  while (secrets.size > MAX_SECRETS) secrets.delete(secrets.keys().next().value as string);
}

/** Pin a session token: it is redacted until unregisterSecret, whatever else is registered meanwhile. */
export function pinSecret(s: string): void {
  if (typeof s !== "string" || s.length < 8) return;
  secrets.delete(s);
  pinned.add(s);
}

export function unregisterSecret(s: string): void {
  secrets.delete(s);
  pinned.delete(s);
}

// Narrow, linear patterns: safe for structured data too.
const NARROW: RegExp[] = [
  /Bearer\s+\S+/gi,
  /wsTicket=[^&\s]+/g,
  /token["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}/gi,
  /eyJ[A-Za-z0-9_\-.]{8,}/g,
];
const LONG_RUN = /[A-Za-z0-9_-]{32,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function strip(s: string): string {
  let out = s.length > MAX_EXACT_SCAN ? s.slice(0, MAX_EXACT_SCAN) : s;
  // exact values first, before the MAX_TEXT cut (on up to MAX_EXACT_SCAN chars), so a secret straddling the cut cannot survive
  for (const v of pinned) if (out.includes(v)) out = out.split(v).join("<redacted>");
  for (const v of secrets.keys()) if (out.includes(v)) out = out.split(v).join("<redacted>");
  if (out.length > MAX_TEXT) out = `${out.slice(0, MAX_TEXT)}...`;
  for (const p of NARROW) out = out.replace(p, "<redacted>");
  return out;
}

/** Free-text redaction (messages, stderr): registered values, narrow patterns, and long token-like runs that contain a digit and are not UUIDs. */
export function redact(s: string): string {
  return strip(s).replace(LONG_RUN, (m) => (/\d/.test(m) && !UUID.test(m) ? "<redacted>" : m));
}

/** Structured-data redaction (RpcError.cause): registered values and narrow patterns only, so ids and file names survive. */
export function redactStructured(s: string): string {
  return strip(s);
}

function errorTagOf(cause: unknown): string | null {
  if (cause && typeof cause === "object" && typeof (cause as { _tag?: unknown })._tag === "string") return (cause as { _tag: string })._tag;
  return null;
}

function causeMessage(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause && typeof cause === "object") {
    const o = cause as { message?: unknown; defect?: unknown };
    if (typeof o.message === "string") return o.message;
    if (typeof o.defect === "string") return o.defect;
    if (o.defect && typeof o.defect === "object" && typeof (o.defect as { message?: unknown }).message === "string") return (o.defect as { message: string }).message;
  }
  return "";
}

export class T3AuthError extends Error {
  hint: string | null;
  /** No `detail`: auth CLI failures never carry child stdout/stderr in any field. */
  constructor(message: string, opts: { hint?: string } = {}) {
    super(redact(message));
    this.name = "T3AuthError";
    this.hint = opts.hint ?? null;
  }
}

export class T3NotRunning extends Error {
  constructor(message = "T3 Code is not running") {
    super(message);
    this.name = "T3NotRunning";
  }
}

/** The server answered a call with a failure. `cause` is the typed error (or defect) from the wire. */
export class RpcError extends Error {
  tag: string;
  declare cause: unknown;
  constructor(tag: string, cause: unknown) {
    const et = errorTagOf(cause);
    const m = causeMessage(cause);
    super(redact(`${tag} failed${et ? `: ${et}` : ""}${m ? `: ${m}` : ""}`));
    this.name = "RpcError";
    this.tag = tag;
    this.cause = redactDeep(cause);
  }
  get errorTag(): string | null { return errorTagOf(this.cause); }
}

export class RpcTimeout extends Error {
  tag: string;
  timeoutMs: number;
  constructor(tag: string, timeoutMs: number) {
    super(`${tag} timed out after ${timeoutMs} ms`);
    this.name = "RpcTimeout";
    this.tag = tag;
    this.timeoutMs = timeoutMs;
  }
}

export class RpcClosed extends Error {
  constructor(message = "connection to T3 Code closed") {
    super(redact(message));
    this.name = "RpcClosed";
  }
}

function redactDeep(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redactStructured(v);
  if (v === null || typeof v !== "object") return typeof v === "function" ? undefined : v;
  if (depth > 12) return "<truncated>";
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = redactDeep(x, depth + 1);
  return out;
}

/**
 * A T3 response did not have the shape t3sm was built against (a nightly changed it). Exit 4, before any write.
 * The message names endpoint, JSON path and expected type only: never the offending value.
 */
export class ShapeError extends Error {
  readonly exitCode = 4;
  endpoint: string;
  path: string;
  expected: string;
  constructor(endpoint: string, path: string, expected: string) {
    super(`unexpected T3 Code response shape from ${endpoint} at ${path}: expected ${expected}`);
    this.name = "ShapeError";
    this.endpoint = endpoint;
    this.path = path;
    this.expected = expected;
  }
}

/** The running T3 Code is a version t3sm was not tested against (and --allow-untested was not given), or speaks another protocol. Exit 4. */
export class T3Incompatible extends Error {
  readonly exitCode = 4;
  version: string;
  constructor(version: string, message: string) {
    super(redact(message));
    this.name = "T3Incompatible";
    this.version = version;
  }
}

/** An HTTP call to T3 Code failed: non-2xx (`status`) or no response at all (`status` null). Carries T3's error tag/code/reason, never the token. */
export class T3HttpError extends Error {
  endpoint: string;
  status: number | null;
  errorTag: string | null;
  code: string | null;
  reason: string | null;
  constructor(endpoint: string, status: number | null, detail: { errorTag?: string | null; code?: string | null; reason?: string | null; message?: string } = {}) {
    const bits = [detail.errorTag, detail.code, detail.reason].filter((x): x is string => typeof x === "string" && x !== "");
    super(redact(`${endpoint} ${status === null ? `failed: ${detail.message ?? "no response"}` : `returned HTTP ${status}`}${bits.length ? ` (${bits.join(", ")})` : ""}`));
    this.name = "T3HttpError";
    this.endpoint = endpoint;
    this.status = status;
    this.errorTag = detail.errorTag ?? null;
    this.code = detail.code ?? null;
    this.reason = detail.reason ?? null;
  }
}
