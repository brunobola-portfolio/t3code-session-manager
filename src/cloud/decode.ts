// Strict decoders for the answers of the `claude` binary's cloud control requests (spec 2026-11-26 §2, S2 and S4).
// These requests are internal to Claude Code and may change: any shape other than the one measured raises
// CloudSchemaError (exit 4), and nothing is written.

/** A response of `claude` that is not the shape t3sm knows (the control requests changed). */
export class CloudSchemaError extends Error {
  override name = "CloudSchemaError";
}

/** A request `claude` answered with an error (not logged in, no such session, the service refused). */
export class CloudRequestError extends Error {
  override name = "CloudRequestError";
}

/** `claude` cannot be used: not found, it would not start, it stopped answering, or it exited. */
export class CloudUnavailable extends Error {
  override name = "CloudUnavailable";
}

export interface CloudRepo { owner: string; name: string }

/** One session row of `list_cloud_sessions`, as t3sm uses it. */
export interface CloudSession {
  id: string;
  title: string;
  /** `idle`, `running`, `archived`, ... (as Claude Code reports it). */
  status: string;
  /** `anthropic_cloud`, `bridge` (Remote Control: already on a PC), another kind, or null when absent. */
  kind: string | null;
  repo: CloudRepo | null;
  /** The session's working branch (`branch`, else `current_branch`), or null. */
  branch: string | null;
  lastEventAt: string | null;
  createdAt: string | null;
  origin: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const optStr = (o: Record<string, unknown>, k: string, where: string): string | null => {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new CloudSchemaError(`${where}.${k}: expected a string`);
  return v;
};

/** The body of a response: `status` must be "ok" (another status is the service's answer, not a shape change). */
function okBody(body: unknown, what: string): Record<string, unknown> {
  if (!isObj(body)) throw new CloudSchemaError(`${what}: expected an object`);
  if (body["status"] !== "ok") {
    const why = [body["message"], body["error"], body["reason"], body["status"]].find((x) => typeof x === "string" && x !== "");
    if (typeof body["status"] !== "string") throw new CloudSchemaError(`${what}.status: expected a string`);
    throw new CloudRequestError(`${what}: ${String(why)}`);
  }
  return body;
}

function cursorOf(body: Record<string, unknown>, what: string): string | null {
  const c = body["next_cursor"];
  if (c === undefined || c === null || c === "") return null;
  if (typeof c !== "string") throw new CloudSchemaError(`${what}.next_cursor: expected a string`);
  return c;
}

export function decodeSession(v: unknown, where = "session"): CloudSession {
  if (!isObj(v)) throw new CloudSchemaError(`${where}: expected an object`);
  const id = v["id"];
  if (typeof id !== "string" || id === "") throw new CloudSchemaError(`${where}.id: expected a string`);
  let repo: CloudRepo | null = null;
  const r = v["repository"];
  if (r !== undefined && r !== null) {
    if (!isObj(r) || typeof r["owner"] !== "string" || typeof r["name"] !== "string") throw new CloudSchemaError(`${where}.repository: expected {owner, name}`);
    repo = { owner: r["owner"], name: r["name"] };
  }
  const status = optStr(v, "status", where) ?? "unknown";
  return {
    id,
    title: optStr(v, "title", where) ?? "",
    status,
    kind: optStr(v, "environment_kind", where),
    repo,
    branch: optStr(v, "branch", where) ?? optStr(v, "current_branch", where),
    lastEventAt: optStr(v, "last_event_at", where) ?? optStr(v, "updated_at", where),
    createdAt: optStr(v, "created_at", where),
    origin: optStr(v, "origin", where),
  };
}

/** One page of `list_cloud_sessions`. */
export function decodeListPage(body: unknown): { sessions: CloudSession[]; next: string | null } {
  const b = okBody(body, "list_cloud_sessions");
  const rows = b["sessions"];
  if (!Array.isArray(rows)) throw new CloudSchemaError("list_cloud_sessions.sessions: expected an array");
  return { sessions: rows.map((x, i) => decodeSession(x, `list_cloud_sessions.sessions[${i}]`)), next: cursorOf(b, "list_cloud_sessions") };
}

/** `get_cloud_session`: its `session` object (older answers put the fields at the top). */
export function decodeSessionDetails(body: unknown): CloudSession {
  const b = okBody(body, "get_cloud_session");
  return decodeSession(isObj(b["session"]) ? b["session"] : b, "get_cloud_session.session");
}

/** A transcript entry: a Claude Code record (an object with a string `type`). Everything else in it is kept as is. */
export type CloudEntry = Record<string, unknown> & { type: string };

/** One page of `get_cloud_session_transcript`. */
export function decodeTranscriptPage(body: unknown): { entries: CloudEntry[]; next: string | null } {
  const b = okBody(body, "get_cloud_session_transcript");
  const entries = b["entries"];
  if (!Array.isArray(entries)) throw new CloudSchemaError("get_cloud_session_transcript.entries: expected an array");
  entries.forEach((e, i) => {
    if (!isObj(e) || typeof e["type"] !== "string") throw new CloudSchemaError(`get_cloud_session_transcript.entries[${i}]: expected a record with a type`);
  });
  return { entries: entries as CloudEntry[], next: cursorOf(b, "get_cloud_session_transcript") };
}

/** The rows that are cloud sessions to bring to this PC: not Remote Control (`bridge`: already local). */
export function isCloudOnly(s: CloudSession): boolean {
  return s.kind !== "bridge";
}

export function isArchived(s: CloudSession): boolean {
  return s.status === "archived";
}
