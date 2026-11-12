// Typed façade over T3 Code: every command reads and changes T3 only through here, and every response is decoded
// strictly (decode.ts) so a changed nightly shape stops t3sm (exit 4) instead of being acted on blindly.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { T3AuthError, T3HttpError, T3Incompatible, T3NotRunning, ShapeError, pinSecret } from "./errors.ts";
import { isT3Running, parseLocalOrigin, readServerRuntime, resolveT3Cli } from "./runtime.ts";
import { DEFAULT_SCOPES, issueSessionToken, mintWsTicket, revokeSession, type Runner } from "./auth.ts";
import { RpcClient, buildWsUrl, webSocketTransport, type Transport } from "./rpc.ts";
import { compatGate } from "./compat.ts";
import {
  decodeArchivedShell, decodeConfig, decodeDispatch, decodeEnvironment, decodeImport, decodeProject, decodeProjects, decodeScan,
  decodeServerSettings, decodeShell,
  type ModelSelection, type ProviderInstanceEntry, type T3Config, type T3Project, type T3ScanResult, type T3Thread,
} from "./decode.ts";
import { normalizeCwd, sameCwd } from "../core/paths.ts";
import type { InstanceSpec } from "../core/types.ts";

export type { T3Project, T3Thread, T3Config, T3ScanResult } from "./decode.ts";

const HTTP_TIMEOUT_MS = 15_000;
const AGENT_SESSIONS_TIMEOUT_MS = 120_000;
const INSTANCE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
const ENV_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const GROUP_KEY_HOME_RE = /^[^:]+:home:(.+)$/s;

/** The part of RpcClient the API uses (a fake replays fixtures in tests). */
export interface RpcLike {
  call<T>(tag: string, payload: unknown, decode: (u: unknown) => T, timeoutMs?: number): Promise<T>;
  close(): void;
}

export interface ProviderInstanceInfo {
  instanceId: string; driver: string; homePath: string | null; displayName: string; accentColor: string | null;
  email: string | null; authStatus: string | null; enabled: boolean;
  /** From providers[].availability; "unavailable" also for settings entries with no live snapshot. */
  availability: "available" | "unavailable";
}

export interface T3Api {
  /** T3 Code server version (environment descriptor `serverVersion`). */
  version: string;
  /** Projects not deleted (archived ones included, flagged). */
  listProjects(): Promise<T3Project[]>;
  /** Active threads (HTTP shell) + archived threads (orchestration.getArchivedShellSnapshot), archived wins on overlap. */
  listThreads(): Promise<T3Thread[]>;
  createProject(root: string, title: string): Promise<T3Project>;
  setProjectDefault(projectId: string, instanceId: string | null, model?: string): Promise<{ previous: unknown }>;
  getConfig(): Promise<T3Config>;
  providerInstances(): Promise<ProviderInstanceInfo[]>;
  addInstance(spec: InstanceSpec): Promise<void>;
  pinInstanceHome(instanceId: string, homePath: string): Promise<{ previous: unknown; changed: boolean }>;
  /** Changes only displayName/accentColor (S4 upsert-full-entry rule). previous = explicit entry before (null if implicit). */
  updateInstanceAppearance(instanceId: string, a: { displayName?: string; accentColor?: string }): Promise<{ previous: unknown; changed: boolean }>;
  archiveThread(threadId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<void>;
  scanSessions(): Promise<T3ScanResult>;
  importSessions(projectId: string, root: string): Promise<{ importedCount: number; skippedCount: number }>;
  /** Closes the socket and revokes the bearer session once. Idempotent; never rejects (a revoke failure is a notice). */
  close(): Promise<void>;
}

export interface T3ApiDeps {
  origin: string;
  token: string;
  rpc: RpcLike;
  version: string;
  fetchImpl?: typeof fetch;
  /** Id factory for commandId/projectId (default crypto.randomUUID). */
  newId?: () => string;
  platform?: NodeJS.Platform;
  /** Runs once on close(), after the socket is closed (connectT3: revoke the session). */
  onClose?: () => Promise<void>;
  /** One-line notices (e.g. a failed revoke). Default: one line on stderr. */
  onNotice?: (line: string) => void;
}

const isObj = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u);
const str = (u: unknown): string | null => (typeof u === "string" ? u : null);

function checkInstanceId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.length > 64 || !INSTANCE_ID_RE.test(id)) {
    throw new Error(`invalid T3 instance id ${JSON.stringify(id)}: must match ${INSTANCE_ID_RE} and be at most 64 chars`);
  }
}

/** Absolute native path for T3 (S4: never build homePath from string literals; a typo path is silently accepted). */
function nativeHome(p: string, platform: NodeJS.Platform): string {
  if (typeof p !== "string" || p.trim() === "") throw new Error("homePath must be a non-empty absolute path");
  if (platform === "win32") {
    if (!/^[A-Za-z]:[\\/]/.test(p) && !/^[\\/]{2}[^\\/]/.test(p)) throw new Error(`homePath must be absolute: ${p}`);
    return path.win32.normalize(p);
  }
  if (!path.posix.isAbsolute(p)) throw new Error(`homePath must be absolute: ${p}`);
  return path.posix.normalize(p);
}

function homeFromGroupKey(groupKey: string | undefined): string | null {
  const m = groupKey ? GROUP_KEY_HOME_RE.exec(groupKey) : null;
  return m ? m[1]! : null;
}

function configuredHome(entry: ProviderInstanceEntry | undefined): string | null {
  const c = entry?.config;
  return isObj(c) && typeof c.homePath === "string" && c.homePath !== "" ? c.homePath : null;
}

/**
 * Every instance T3 knows: live `providers[]` first (implicit and unavailable ones included), then explicit settings
 * entries not (yet) in providers[]. homePath = configured `config.homePath`, else `runtimePaths.homePath`, else the
 * `<kind>:home:<dir>` parse of `continuation.groupKey` (server.ts 240-245), else null.
 */
function listInstances(cfg: T3Config): ProviderInstanceInfo[] {
  const map = cfg.settings.providerInstances;
  const out: ProviderInstanceInfo[] = [];
  const seen = new Set<string>();
  for (const p of cfg.providers) {
    seen.add(p.instanceId);
    const entry = Object.hasOwn(map, p.instanceId) ? map[p.instanceId] : undefined;
    out.push({
      instanceId: p.instanceId, driver: p.driver,
      homePath: configuredHome(entry) ?? p.runtimeHomePath ?? homeFromGroupKey(p.continuation?.groupKey),
      displayName: p.displayName ?? entry?.displayName ?? p.driver, accentColor: p.accentColor ?? entry?.accentColor ?? null,
      email: p.auth.email, authStatus: p.auth.status, enabled: p.enabled, availability: p.availability,
    });
  }
  for (const [id, entry] of Object.entries(map)) {
    if (seen.has(id)) continue;
    out.push({
      instanceId: id, driver: entry.driver, homePath: configuredHome(entry), displayName: entry.displayName ?? entry.driver,
      accentColor: entry.accentColor ?? null, email: null, authStatus: null, enabled: entry.enabled ?? true, availability: "unavailable",
    });
  }
  return out;
}

/** Claude-driver instances as planner specs (homePath normalized with normalizeCwd; env entries with string values only). */
export function instancesFromConfig(cfg: T3Config, platform: NodeJS.Platform = process.platform): InstanceSpec[] {
  const map = cfg.settings.providerInstances;
  const out: InstanceSpec[] = [];
  for (const i of listInstances(cfg)) {
    if (i.driver !== "claudeAgent" || i.homePath === null) continue;
    const entry = Object.hasOwn(map, i.instanceId) ? map[i.instanceId] : undefined;
    const environment = (entry?.environment ?? [])
      .filter((e): e is { name: string; value: string; sensitive: boolean } => typeof e.value === "string")
      .map((e) => ({ name: e.name, value: e.value, sensitive: e.sensitive }));
    out.push({ id: i.instanceId, driver: "claudeAgent", displayName: i.displayName, accentColor: i.accentColor, homePath: normalizeCwd(i.homePath, platform), environment });
  }
  return out;
}

export function createT3Api(deps: T3ApiDeps): T3Api {
  const { origin, token, rpc, version } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const notice = deps.onNotice ?? ((line: string) => { try { process.stderr.write(`${line.replace(/[\r\n]+/g, " ")}\n`); } catch { /* ignore */ } });
  const newId = deps.newId ?? randomUUID;
  const platform = deps.platform ?? process.platform;
  pinSecret(token);

  async function http<T>(method: "GET" | "POST", pathname: string, decode: (u: unknown) => T, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const endpoint = `${method} ${pathname}`;
    const base = parseLocalOrigin(origin);
    if (!base) throw new T3AuthError("refusing to send credentials to a non-local origin");
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) };
    let body: string | undefined;
    if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }
    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(new URL(pathname, base).href, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      text = await res.text();
    } catch (e) {
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new T3HttpError(endpoint, null, { message: timeout ? `timed out after ${HTTP_TIMEOUT_MS / 1000} s` : "could not reach T3 Code (refused, reset or redirected)" });
    }
    if (!res.ok) {
      let b: unknown = null;
      try { b = JSON.parse(text); } catch { /* empty or non-JSON error body */ }
      const o = isObj(b) ? b : {};
      throw new T3HttpError(endpoint, res.status, { errorTag: str(o._tag), code: str(o.code), reason: str(o.reason) });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new ShapeError(endpoint, "$", "JSON body"); }
    return decode(parsed);
  }

  const getConfig = () => rpc.call("server.getConfig", {}, decodeConfig);
  const listProjects = async () => (await http("GET", "/api/projects", decodeProjects)).filter((p) => !p.deleted);

  async function defaultModelFor(instanceId: string): Promise<string> {
    const cfg = await getConfig();
    const prov = cfg.providers.find((p) => p.instanceId === instanceId);
    const own = prov?.models.find((m) => m.isDefault);
    if (own) return own.slug;
    const map = cfg.settings.providerInstances;
    const driver = prov?.driver ?? (Object.hasOwn(map, instanceId) ? map[instanceId]!.driver : undefined);
    if (!driver) throw new Error(`T3 instance ${instanceId} not found`);
    // Not probed yet (just created): the default model T3 reports for the same driver.
    for (const p of cfg.providers) {
      if (p.driver !== driver) continue;
      const m = p.models.find((x) => x.isDefault);
      if (m) return m.slug;
    }
    throw new Error(`no default model known for T3 instance ${instanceId} (driver ${driver}); pass a model explicitly`);
  }

  async function updateInstance(instanceId: string, mutation: Record<string, unknown>): Promise<void> {
    // Per-entry mutation only. NEVER patch.providerInstances: it replaces the whole map (S4 §2).
    const settings = await rpc.call("server.updateSettings", { patch: {}, providerInstanceMutation: mutation }, decodeServerSettings);
    if (!Object.hasOwn(settings.providerInstances, instanceId)) {
      throw new ShapeError("server.updateSettings", `$.providerInstances[${JSON.stringify(instanceId)}]`, "the mutated instance");
    }
  }

  const dispatch = async (type: "thread.archive" | "thread.unarchive", threadId: string): Promise<void> => {
    if (typeof threadId !== "string" || threadId === "") throw new Error("threadId must be a non-empty string");
    await rpc.call("orchestration.dispatchCommand", { type, commandId: newId(), threadId }, decodeDispatch);
  };

  let closing: Promise<void> | null = null;

  return {
    version,
    listProjects,
    async listThreads() {
      const active = await http("GET", "/api/orchestration/shell", decodeShell, { headers: { "x-t3-orchestration-protocol": "2" } });
      const archived = await rpc.call("orchestration.getArchivedShellSnapshot", {}, decodeArchivedShell);
      const byId = new Map<string, T3Thread>();
      for (const t of active) byId.set(t.id, t);
      for (const t of archived) byId.set(t.id, t); // archived snapshot wins
      return [...byId.values()];
    },

    createProject: (root, title) =>
      http("POST", "/api/projects/mutate", (u) => decodeProject(u), {
        body: { type: "project.create", commandId: newId(), projectId: newId(), title, workspaceRoot: root, createWorkspaceRootIfMissing: false },
      }),

    async setProjectDefault(projectId, instanceId, model) {
      const current = (await listProjects()).find((p) => p.id === projectId);
      if (!current) throw new Error(`T3 project ${projectId} not found`);
      let selection: ModelSelection | null = null;
      if (instanceId !== null) {
        checkInstanceId(instanceId);
        selection = { instanceId, model: model ?? (await defaultModelFor(instanceId)) };
      }
      await http("POST", "/api/projects/mutate", (u) => decodeProject(u), {
        body: { type: "project.update", commandId: newId(), projectId, defaultModelSelection: selection },
      });
      return { previous: current.defaultModelSelection };
    },

    getConfig,
    providerInstances: async () => listInstances(await getConfig()),

    async addInstance(spec) {
      checkInstanceId(spec.id);
      if (spec.driver !== "claudeAgent") throw new Error(`unsupported driver ${String(spec.driver)}`);
      if (typeof spec.displayName !== "string" || spec.displayName.trim() === "") throw new Error("displayName must be non-empty");
      if (spec.accentColor !== null && !ACCENT_RE.test(spec.accentColor)) throw new Error(`accentColor must be #RRGGBB, got ${JSON.stringify(spec.accentColor)}`);
      for (const e of spec.environment) {
        if (!ENV_NAME_RE.test(e.name) || e.name.length > 128 || typeof e.value !== "string" || typeof e.sensitive !== "boolean") throw new Error(`invalid environment entry ${JSON.stringify(e.name)}`);
      }
      const instance: Record<string, unknown> = { driver: spec.driver, displayName: spec.displayName.trim() };
      if (spec.accentColor !== null) instance.accentColor = spec.accentColor;
      instance.enabled = true;
      instance.config = { homePath: nativeHome(spec.homePath, platform) };
      if (spec.environment.length) instance.environment = spec.environment.map((e) => ({ name: e.name, value: e.value, sensitive: e.sensitive }));
      await updateInstance(spec.id, { operation: "create", instanceId: spec.id, instance });
    },

    /**
     * Upsert replaces the entry whole (S4 §2), so the FULL entry is sent:
     * - explicit entry in settings.providerInstances: that entry unchanged except `config.homePath` (other config keys kept);
     * - implicit instance (settings map has no such id; it exists only in providers[]): `{driver, config:{homePath}}`,
     *   exactly the S4 §6 pin. No displayName/accentColor/enabled are invented, so nothing is renamed or re-enabled.
     * previous = the explicit entry before the change, or null when the instance was implicit.
     * An explicit entry whose config.homePath already equals the requested home is left alone: {previous, changed:false}.
     */
    async pinInstanceHome(instanceId, homePath) {
      checkInstanceId(instanceId);
      const home = nativeHome(homePath, platform);
      const cfg = await getConfig();
      const map = cfg.settings.providerInstances;
      const existing = Object.hasOwn(map, instanceId) ? map[instanceId]! : null;
      let instance: Record<string, unknown>;
      if (existing && isObj(existing.config) && typeof existing.config.homePath === "string" && sameCwd(existing.config.homePath, home, platform)) {
        return { previous: structuredClone(existing), changed: false };
      }
      if (existing) {
        const c = existing.config;
        if (c !== undefined && c !== null && !isObj(c)) throw new Error(`T3 instance ${instanceId} has a non-object config; refusing to overwrite it`);
        instance = { ...structuredClone(existing), config: { ...(isObj(c) ? structuredClone(c) : {}), homePath: home } };
      } else {
        const p = cfg.providers.find((x) => x.instanceId === instanceId);
        if (!p) throw new Error(`T3 instance ${instanceId} not found`);
        instance = { driver: p.driver, config: { homePath: home } };
      }
      await updateInstance(instanceId, { operation: "upsert", instanceId, instance });
      return { previous: existing ? structuredClone(existing) : null, changed: true };
    },

    async updateInstanceAppearance(instanceId, ap) {
      checkInstanceId(instanceId);
      if (ap.displayName !== undefined && (typeof ap.displayName !== "string" || ap.displayName.trim() === "")) throw new Error("displayName must be non-empty");
      if (ap.accentColor !== undefined && !ACCENT_RE.test(ap.accentColor)) throw new Error(`accentColor must be #RRGGBB, got ${JSON.stringify(ap.accentColor)}`);
      const cfg = await getConfig();
      const map = cfg.settings.providerInstances;
      const existing = Object.hasOwn(map, instanceId) ? map[instanceId]! : null;
      let instance: Record<string, unknown>;
      if (existing) instance = structuredClone(existing) as unknown as Record<string, unknown>;
      else {
        const p = cfg.providers.find((x) => x.instanceId === instanceId);
        if (!p) throw new Error(`T3 instance ${instanceId} not found`);
        // Implicit instance: pin its home in the same upsert so the explicit entry cannot drift (S4 §6).
        const home = listInstances(cfg).find((x) => x.instanceId === instanceId)?.homePath ?? null;
        instance = home !== null ? { driver: p.driver, config: { homePath: nativeHome(home, platform) } } : { driver: p.driver };
      }
      const next = { ...instance };
      if (ap.displayName !== undefined) next.displayName = ap.displayName.trim();
      if (ap.accentColor !== undefined) next.accentColor = ap.accentColor;
      if (existing && JSON.stringify(next) === JSON.stringify(instance)) return { previous: structuredClone(existing), changed: false };
      await updateInstance(instanceId, { operation: "upsert", instanceId, instance: next });
      return { previous: existing ? structuredClone(existing) : null, changed: true };
    },

    archiveThread: (threadId) => dispatch("thread.archive", threadId),
    unarchiveThread: (threadId) => dispatch("thread.unarchive", threadId),

    scanSessions: () => rpc.call("agentSessions.scan", {}, decodeScan, AGENT_SESSIONS_TIMEOUT_MS),
    importSessions: (projectId, root) =>
      rpc.call("agentSessions.import", { projectId, expectedWorkspaceRoot: root }, decodeImport, AGENT_SESSIONS_TIMEOUT_MS),

    close() {
      closing ??= (async () => {
        try { rpc.close(); } catch { /* already closed */ }
        if (!deps.onClose) return;
        try { await deps.onClose(); } catch {
          notice("t3sm: could not revoke the T3 Code bearer session; it expires on its own within 1 h.");
        }
      })();
      return closing;
    },
  };
}

export interface ConnectOptions {
  allowUntested: boolean;
  /** Adds providers:manage to the token (only for instance create/upsert). */
  manageProviders?: boolean;
  onNotice?: (line: string) => void;
  fetchImpl?: typeof fetch;
  run?: Runner;
  transportFactory?: (url: string) => Promise<Transport>;
  /** Override the resolved t3 CLI path. */
  cli?: string;
  newId?: () => string;
}

/**
 * Connects to the running T3 Code: liveness (T3NotRunning, exit 3) -> environment read + compatibility gate
 * (T3Incompatible / ShapeError, exit 4; done before any token exists, so a refused version leaves no session behind)
 * -> least-privilege token -> ws ticket -> socket. If anything after the token fails, the session is revoked
 * (best effort) and the original error is rethrown.
 */
export async function connectT3(home: string, opts: ConnectOptions): Promise<T3Api> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const rt = await readServerRuntime(home);
  if (!rt || !(await isT3Running(home, fetchImpl))) throw new T3NotRunning();

  const env = await readEnvironment(rt.origin, fetchImpl);
  if (env.orchestrationProtocolVersion !== 2) {
    throw new T3Incompatible(env.serverVersion, `T3 Code ${env.serverVersion} speaks orchestration protocol ${env.orchestrationProtocolVersion}; t3sm needs protocol 2.`);
  }
  compatGate(env.serverVersion, { allowUntested: opts.allowUntested, onNotice: opts.onNotice });

  const cli = opts.cli ?? resolveT3Cli(home, process.platform, process.env.PATH ?? "");
  if (!cli) throw new T3AuthError("T3 Code CLI (t3) not found in ~/.t3/bin or PATH");
  const scopes = opts.manageProviders ? [...DEFAULT_SCOPES, "providers:manage"] : DEFAULT_SCOPES;
  const { token, sessionId } = await issueSessionToken(cli, { scopes, run: opts.run });
  const revoke = () => revokeSession(cli, sessionId, opts.run, token);

  let transport: Transport;
  try {
    const ticket = await mintWsTicket(rt.origin, token, fetchImpl);
    transport = await (opts.transportFactory ?? webSocketTransport)(buildWsUrl(rt.origin, ticket));
  } catch (e) {
    try { await revoke(); } catch { /* never mask the original error */ }
    throw e;
  }
  return createT3Api({
    origin: rt.origin, token, rpc: new RpcClient(transport), version: env.serverVersion, fetchImpl,
    newId: opts.newId, onClose: revoke, onNotice: opts.onNotice,
  });
}

async function readEnvironment(origin: string, fetchImpl: typeof fetch) {
  const endpoint = "GET /.well-known/t3/environment";
  const base = parseLocalOrigin(origin);
  if (!base) throw new T3NotRunning();
  let text: string;
  let res: Response;
  try {
    res = await fetchImpl(new URL("/.well-known/t3/environment", base).href, { redirect: "error", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    text = await res.text();
  } catch { throw new T3NotRunning(); }
  if (!res.ok) throw new T3HttpError(endpoint, res.status);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ShapeError(endpoint, "$", "JSON body"); }
  return decodeEnvironment(parsed);
}
