// Strict, hand-written decoders for every T3 Code response t3sm reads (wire truth: docs/spikes/S1, S2, S4).
// Rules: each decoder is `(u: unknown) => T` and throws ShapeError{endpoint, path, expected} on a missing or mistyped
// required field; unknown extra fields are allowed; values are never coerced ("2" is not 2); arrays are checked
// element by element. A nightly that changes a shape therefore stops t3sm (exit 4) before it acts on it.

import { ShapeError } from "./errors.ts";

type Obj = Record<string, unknown>;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (p: string, k: string) => (IDENT.test(k) ? `${p}.${k}` : `${p}[${JSON.stringify(k)}]`);
const idx = (p: string, i: number) => `${p}[${i}]`;

const isObj = (u: unknown): u is Obj => typeof u === "object" && u !== null && !Array.isArray(u);

class D {
  ep: string;
  constructor(endpoint: string) { this.ep = endpoint; }
  fail(path: string, expected: string): never { throw new ShapeError(this.ep, path, expected); }
  obj(u: unknown, path: string): Obj { return isObj(u) ? u : this.fail(path, "object"); }
  /** Required key (must be present) holding a string. */
  str(o: Obj, k: string, path: string): string {
    const v = o[k];
    return typeof v === "string" ? v : this.fail(key(path, k), "string");
  }
  /** Required key holding string or null. */
  strOrNull(o: Obj, k: string, path: string): string | null {
    if (!(k in o)) this.fail(key(path, k), "string or null");
    const v = o[k];
    return v === null || typeof v === "string" ? v : this.fail(key(path, k), "string or null");
  }
  /** Optional key: absent -> undefined; present must be string (or null when nullable). */
  optStr(o: Obj, k: string, path: string, nullable = false): string | null | undefined {
    if (!(k in o) || o[k] === undefined) return undefined;
    const v = o[k];
    if (typeof v === "string") return v;
    if (nullable && v === null) return null;
    return this.fail(key(path, k), nullable ? "string or null" : "string");
  }
  bool(o: Obj, k: string, path: string): boolean {
    const v = o[k];
    return typeof v === "boolean" ? v : this.fail(key(path, k), "boolean");
  }
  optBool(o: Obj, k: string, path: string): boolean | undefined {
    if (!(k in o) || o[k] === undefined) return undefined;
    return this.bool(o, k, path);
  }
  /** Non-negative integer. */
  count(o: Obj, k: string, path: string): number {
    const v = o[k];
    return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : this.fail(key(path, k), "non-negative integer");
  }
  arr<T>(o: Obj, k: string, path: string, el: (u: unknown, path: string) => T): T[] {
    const v = o[k];
    const p = key(path, k);
    if (!Array.isArray(v)) return this.fail(p, "array");
    return v.map((x, i) => el(x, idx(p, i)));
  }
}

// ---------- environment ----------

export interface T3Environment { serverVersion: string; orchestrationProtocolVersion: number }

/** GET /.well-known/t3/environment (S1 §1). */
export function decodeEnvironment(u: unknown): T3Environment {
  const d = new D("GET /.well-known/t3/environment");
  const o = d.obj(u, "$");
  const serverVersion = d.str(o, "serverVersion", "$");
  const v = o.orchestrationProtocolVersion;
  if (typeof v !== "number" || !Number.isInteger(v)) return d.fail("$.orchestrationProtocolVersion", "integer");
  return { serverVersion, orchestrationProtocolVersion: v };
}

// ---------- projects ----------

/** `{instanceId, model, options?}` on the wire; legacy `{provider, model}` is accepted too (S1 §6). Returned untouched. */
export type ModelSelection = Obj & { model: string };

export interface T3Project {
  id: string; title: string; workspaceRoot: string; defaultModelSelection: ModelSelection | null;
  /** archivedAt != null */ archived: boolean;
  /** deletedAt != null (listProjects drops these) */ deleted: boolean;
}

function modelSelection(d: D, u: unknown, path: string): ModelSelection {
  const o = d.obj(u, path);
  d.str(o, "model", path);
  if ("instanceId" in o) d.str(o, "instanceId", path);
  else d.str(o, "provider", path);
  return o as ModelSelection;
}

function project(d: D, u: unknown, path: string): T3Project {
  const o = d.obj(u, path);
  const id = d.str(o, "id", path);
  const title = d.str(o, "title", path);
  const workspaceRoot = d.str(o, "workspaceRoot", path);
  if (!("defaultModelSelection" in o)) d.fail(key(path, "defaultModelSelection"), "model selection or null");
  const sel = o.defaultModelSelection;
  if (sel !== null && !isObj(sel)) d.fail(key(path, "defaultModelSelection"), "model selection or null");
  const defaultModelSelection = sel === null ? null : modelSelection(d, sel, key(path, "defaultModelSelection"));
  const archivedAt = d.optStr(o, "archivedAt", path, true) ?? null;
  const deletedAt = d.optStr(o, "deletedAt", path, true) ?? null;
  return { id, title, workspaceRoot, defaultModelSelection, archived: archivedAt !== null, deleted: deletedAt !== null };
}

/** GET /api/projects -> `{projects: Project[], updatedAt}`. */
export function decodeProjects(u: unknown): T3Project[] {
  const d = new D("GET /api/projects");
  const o = d.obj(u, "$");
  return d.arr(o, "projects", "$", (x, p) => project(d, x, p));
}

/** One `Project` (POST /api/projects/mutate success). */
export function decodeProject(u: unknown, endpoint = "POST /api/projects/mutate"): T3Project {
  return project(new D(endpoint), u, "$");
}

// ---------- shell ----------

export interface T3Thread {
  id: string; projectId: string; instanceId: string; archived: boolean; title: string;
  /**
   * The native session behind the thread, from `activeProviderThreadId` ("provider-thread:...:native-thread:<id>",
   * fixture http-orchestration-shell-imported.json). Lets a session started inside T3 (thread id is T3's own) count as
   * already in T3. Null when absent, null, or in another format.
   */
  nativeSessionId?: string | null;
  /**
   * Time of the newest user message T3 shows (`latestUserMessageAt`). For an imported thread it is the transcript's
   * newest user message; a later value means a turn was sent in T3 (t3sm merge's "T3 evidently wrote" check).
   */
  latestUserMessageAt?: string | null;
}

const NATIVE_THREAD_RE = /:native-thread:(.+)$/s;

function shellThread(d: D, u: unknown, path: string, inArchived: boolean): T3Thread {
  const o = d.obj(u, path);
  const id = d.str(o, "id", path);
  const projectId = d.str(o, "projectId", path);
  const title = d.str(o, "title", path);
  const instanceId = d.str(o, "providerInstanceId", path); // ProviderInstanceId: never null in OrchestrationV2ThreadShell
  const archivedAt = d.strOrNull(o, "archivedAt", path);
  const ref = d.optStr(o, "activeProviderThreadId", path, true);
  const nativeSessionId = typeof ref === "string" ? (NATIVE_THREAD_RE.exec(ref)?.[1] ?? null) : null;
  const latestUserMessageAt = d.optStr(o, "latestUserMessageAt", path, true) ?? null;
  return { id, projectId, instanceId, archived: inArchived || archivedAt !== null, title, nativeSessionId, latestUserMessageAt };
}

/**
 * GET /api/orchestration/shell (protocol 2). The server hard-codes `archivedThreads: []` here (ShellStream.ts), so this
 * yields active threads only; archived ones come from decodeArchivedShell.
 */
export function decodeShell(u: unknown): T3Thread[] {
  const d = new D("GET /api/orchestration/shell");
  const o = d.obj(u, "$");
  if (o.schemaVersion !== 2) d.fail("$.schemaVersion", "2");
  const active = d.arr(o, "threads", "$", (x, p) => shellThread(d, x, p, false));
  const archived = d.arr(o, "archivedThreads", "$", (x, p) => shellThread(d, x, p, true));
  return [...active, ...archived];
}

/** orchestration.getArchivedShellSnapshot -> `{schemaVersion, snapshotSequence, projects, threads}`; every thread is archived. */
export function decodeArchivedShell(u: unknown): T3Thread[] {
  const d = new D("orchestration.getArchivedShellSnapshot");
  const o = d.obj(u, "$");
  if (o.schemaVersion !== 2) d.fail("$.schemaVersion", "2");
  d.count(o, "snapshotSequence", "$");
  return d.arr(o, "threads", "$", (x, p) => shellThread(d, x, p, true));
}

// ---------- server config / settings ----------

export interface EnvVar { name: string; value: unknown; sensitive: boolean }
/** A `settings.providerInstances` entry, returned as the raw object (extra fields kept) after validation. */
export type ProviderInstanceEntry = Obj & {
  driver: string; displayName?: string; accentColor?: string; enabled?: boolean; environment?: EnvVar[]; config?: unknown;
};

export interface T3Provider {
  instanceId: string; driver: string;
  /** Optional in ServerProvider (server.ts); null when absent. */
  displayName: string | null;
  enabled: boolean; accentColor: string | null;
  /** "unavailable" for buildUnavailableProviderSnapshot instances (no driver ran); absent means "available". */
  availability: "available" | "unavailable";
  /** Optional in the contract; unavailable instances have none. */
  continuation: { groupKey: string } | null;
  /** runtimePaths.homePath when the driver reports it. */
  runtimeHomePath: string | null;
  auth: { status: string; email: string | null };
  models: { slug: string; isDefault: boolean }[];
}

export interface T3Config {
  settings: { providerInstances: Record<string, ProviderInstanceEntry>; defaultModelSelection?: ModelSelection | null };
  providers: T3Provider[];
}

function instanceEntry(d: D, u: unknown, path: string): ProviderInstanceEntry {
  const o = d.obj(u, path);
  d.str(o, "driver", path);
  d.optStr(o, "displayName", path);
  d.optStr(o, "accentColor", path);
  d.optBool(o, "enabled", path);
  if ("environment" in o && o.environment !== undefined) {
    d.arr(o, "environment", path, (x, p) => {
      const e = d.obj(x, p);
      d.str(e, "name", p);
      if (!("value" in e)) d.fail(key(p, "value"), "string or secret reference");
      d.bool(e, "sensitive", p);
      return e;
    });
  }
  return o as ProviderInstanceEntry;
}

function instanceMap(d: D, o: Obj, path: string): Record<string, ProviderInstanceEntry> {
  const m = o.providerInstances;
  const p = key(path, "providerInstances");
  if (!isObj(m)) return d.fail(p, "object map");
  for (const [k, v] of Object.entries(m)) instanceEntry(d, v, key(p, k));
  return m as Record<string, ProviderInstanceEntry>;
}

function provider(d: D, u: unknown, path: string): T3Provider {
  // Field optionality follows ServerProvider (packages/contracts/src/server.ts); a valid but degraded state
  // (unavailable instance, no continuation, no displayName) must never stop t3sm.
  const o = d.obj(u, path);
  const instanceId = d.str(o, "instanceId", path);
  const driver = d.str(o, "driver", path);
  const displayName = (d.optStr(o, "displayName", path) as string | undefined) ?? null;
  const enabled = d.bool(o, "enabled", path);
  const accentColor = d.optStr(o, "accentColor", path, true) ?? null;
  let availability: T3Provider["availability"] = "available";
  if ("availability" in o && o.availability !== undefined) {
    if (o.availability !== "available" && o.availability !== "unavailable") d.fail(key(path, "availability"), '"available" or "unavailable"');
    availability = o.availability;
  }
  let continuation: T3Provider["continuation"] = null;
  if ("continuation" in o && o.continuation !== undefined) {
    const c = d.obj(o.continuation, key(path, "continuation"));
    continuation = { groupKey: d.str(c, "groupKey", key(path, "continuation")) };
  }
  let runtimeHomePath: string | null = null;
  if ("runtimePaths" in o && o.runtimePaths !== undefined) {
    const r = d.obj(o.runtimePaths, key(path, "runtimePaths"));
    runtimeHomePath = d.str(r, "homePath", key(path, "runtimePaths"));
  }
  const a = d.obj(o.auth, key(path, "auth"));
  const auth = { status: d.str(a, "status", key(path, "auth")), email: d.optStr(a, "email", key(path, "auth"), true) ?? null };
  const models = d.arr(o, "models", path, (x, p) => {
    const m = d.obj(x, p);
    return { slug: d.str(m, "slug", p), isDefault: d.optBool(m, "isDefault", p) ?? false };
  });
  return { instanceId, driver, displayName, enabled, accentColor, availability, continuation, runtimeHomePath, auth, models };
}

/** server.getConfig success value (S1 §5). Only the parts t3sm reads are checked; `settings.providerInstances` entries stay raw. */
export function decodeConfig(u: unknown): T3Config {
  const d = new D("server.getConfig");
  const o = d.obj(u, "$");
  const s = d.obj(o.settings, "$.settings");
  const providerInstances = instanceMap(d, s, "$.settings");
  const settings: T3Config["settings"] = { providerInstances };
  if ("defaultModelSelection" in s && s.defaultModelSelection !== undefined) {
    settings.defaultModelSelection = s.defaultModelSelection === null ? null : modelSelection(d, s.defaultModelSelection, "$.settings.defaultModelSelection");
  }
  const providers = d.arr(o, "providers", "$", (x, p) => provider(d, x, p));
  return { settings, providers };
}

/** server.updateSettings success value: the full ServerSettings; t3sm checks `providerInstances` (S4 §1). */
export function decodeServerSettings(u: unknown): { providerInstances: Record<string, ProviderInstanceEntry> } {
  const d = new D("server.updateSettings");
  const o = d.obj(u, "$");
  return { providerInstances: instanceMap(d, o, "$") };
}

// ---------- agentSessions ----------

export interface ScanCandidate {
  path: string; title: string; projectId: string | null; sources: string[];
  threadCount: number; lastActiveAt: string | null; alreadyImported: boolean;
}
export interface T3ScanResult { candidates: ScanCandidate[]; scannedAt: string; truncated: boolean }

/** agentSessions.scan -> `{candidates, scannedAt, truncated?: true}` (S1 §5). */
export function decodeScan(u: unknown): T3ScanResult {
  const d = new D("agentSessions.scan");
  const o = d.obj(u, "$");
  const candidates = d.arr(o, "candidates", "$", (x, p) => {
    const c = d.obj(x, p);
    return {
      path: d.str(c, "path", p),
      title: d.str(c, "title", p),
      projectId: (d.optStr(c, "projectId", p) as string | undefined) ?? null,
      sources: d.arr(c, "sources", p, (s, sp) => (typeof s === "string" ? s : d.fail(sp, "string"))),
      threadCount: d.count(c, "threadCount", p),
      lastActiveAt: d.strOrNull(c, "lastActiveAt", p),
      alreadyImported: d.bool(c, "alreadyImported", p),
    };
  });
  const scannedAt = d.str(o, "scannedAt", "$");
  const truncated = d.optBool(o, "truncated", "$") ?? false;
  return { candidates, scannedAt, truncated };
}

/** agentSessions.import -> `{importedCount, skippedCount}` (non-negative integers). */
export function decodeImport(u: unknown): { importedCount: number; skippedCount: number } {
  const d = new D("agentSessions.import");
  const o = d.obj(u, "$");
  return { importedCount: d.count(o, "importedCount", "$"), skippedCount: d.count(o, "skippedCount", "$") };
}

/** orchestration.dispatchCommand -> `{sequence}` (S1 addendum). */
export function decodeDispatch(u: unknown): { sequence: number } {
  const d = new D("orchestration.dispatchCommand");
  const o = d.obj(u, "$");
  return { sequence: d.count(o, "sequence", "$") };
}
