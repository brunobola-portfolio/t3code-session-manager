// A stateful fake T3Code for the apply tests: importSessions applies S2's eligibility rule to real temp files
// (cached scan mtime in [now - 30 d, now], cwd = project root). Never touches a real home.
import { stat } from "node:fs/promises";
import { utimesSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { after } from "node:test";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { PlanItem } from "../../src/core/types.ts";
import type { ProviderInstanceInfo, T3Api, T3Project, T3Thread } from "../../src/t3/api.ts";
import { sameCwd } from "../../src/core/paths.ts";
import { T3HttpError } from "../../src/t3/errors.ts";
import { sess } from "../plan/helpers.ts";

export const DAY = 86_400_000;

/**
 * A transcript T3's importer can see. threadId omitted: T3 stamps the thread with the instance whose homePath holds
 * the file (`import:<instance>:<file stem>`); a file under no instance home is not read by T3 at all.
 */
export interface FakeFile { path: string; root: string; threadId?: string }

const inHome = (file: string, home: string): boolean => {
  const n = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return n(file).startsWith(`${n(home)}/`);
};
export interface FakeOpts {
  version?: string;
  never?: Set<string>;
  importError?: (projectId: string) => unknown;
  onScan?: () => void | Promise<void>;
  onImport?: (projectId: string) => void | Promise<void>;
  instances?: ProviderInstanceInfo[];
  /** The platform this T3 Code runs on: how it compares workspace roots (default: the host). */
  platform?: NodeJS.Platform;
  /**
   * Organize writes (archive, unarchive, settle, unsettle, title, pin, delete-project, auto-settle, create): called with
   * the call string (as pushed to `calls`) before the write. A returned error is thrown; `applied: true` applies the
   * change first and throws afterwards (T3 accepted it, the response was lost or did not decode).
   */
  writeError?: (call: string) => { error: unknown; applied?: boolean } | undefined;
}

export interface FakeT3 {
  api: T3Api;
  files: FakeFile[];
  projects: T3Project[];
  threads: Map<string, T3Thread & { updatedAt: number }>;
  calls: string[];
  scanned: Map<string, number>;
  opts: FakeOpts;
  /** The fake T3's sidebarAutoSettleAfterDays (T3's default is 7). */
  autoSettleDays: number | null;
}

export function inst(id: string, home: string | null, extra: Partial<ProviderInstanceInfo> = {}): ProviderInstanceInfo {
  return { instanceId: id, driver: "claudeAgent", homePath: home, displayName: id, accentColor: null, email: null, authStatus: "authenticated", enabled: true, availability: "available", ...extra };
}

export function fakeT3(opts: FakeOpts = {}): FakeT3 {
  const f: FakeT3 = { files: [], projects: [], threads: new Map(), calls: [], scanned: new Map(), opts, autoSettleDays: 7, api: null as never };
  let seq = 0;
  const threadOf = (id: string): T3Thread & { updatedAt: number } => {
    const t = f.threads.get(id);
    if (!t) throw new Error(`thread ${id} not found`);
    return t;
  };
  /** Records `call`, then applies `change` unless `opts.writeError` says to fail (before or after applying it). */
  async function write<T>(call: string, change: () => T): Promise<T> {
    f.calls.push(call);
    const w = opts.writeError?.(call);
    if (w && !w.applied) throw w.error;
    const out = change();
    if (w) throw w.error;
    return out;
  }
  f.api = {
    version: opts.version ?? "0.1.9-nightly.20261110.4465",
    listProjects: async () => f.projects.filter((p) => !p.deleted).map((p) => ({ ...p })), // T3's listProjects drops deleted ones
    listThreads: async () => [...f.threads.values()].map(({ updatedAt: _u, ...t }) => ({ ...t })),
    providerInstances: async () => (opts.instances ?? [inst("claudeAgent", null)]).map((i) => ({ ...i })),
    createProject: (root: string, title: string) => write(`create:${root}`, () => {
      const p: T3Project = { id: `p${++seq}`, title, workspaceRoot: root, defaultModelSelection: null, archived: false, deleted: false, pinned: false, createdAt: null };
      f.projects.push(p);
      return { ...p };
    }),
    setProjectDefault: async (projectId: string, instanceId: string | null) => {
      f.calls.push(`default:${projectId}:${instanceId}`);
      const p = f.projects.find((x) => x.id === projectId)!;
      const previous = p.defaultModelSelection;
      p.defaultModelSelection = instanceId === null ? null : { instanceId, model: "m" } as never;
      return { previous };
    },
    getConfig: async () => ({ settings: { providerInstances: {} }, providers: [] }),
    addInstance: async (s: { id: string; homePath: string; displayName?: string }) => {
      f.calls.push(`add:${s.id}`);
      opts.instances = [...(opts.instances ?? [inst("claudeAgent", null)]), inst(s.id, s.homePath)];
    },
    pinInstanceHome: async () => ({ previous: null, changed: false }),
    async scanSessions() {
      f.calls.push("scan");
      if (opts.onScan) await opts.onScan();
      f.scanned.clear();
      for (const x of f.files) {
        try { f.scanned.set(x.path, (await stat(x.path)).mtimeMs); } catch { /* gone */ }
      }
      return { candidates: [], scannedAt: new Date().toISOString(), truncated: true };
    },
    async importSessions(projectId: string, root: string) {
      f.calls.push(`import:${projectId}`);
      if (opts.onImport) await opts.onImport(projectId);
      const err = opts.importError?.(projectId);
      if (err) throw err;
      const p = f.projects.find((x) => x.id === projectId);
      if (!p) throw new Error("project not found");
      if (!sameCwd(p.workspaceRoot, root, opts.platform)) throw new Error("root changed");
      const now = Date.now();
      let n = 0;
      for (const x of f.files) {
        if (!sameCwd(x.root, p.workspaceRoot, opts.platform)) continue;
        const m = f.scanned.get(x.path);
        if (m === undefined || m < now - 30 * DAY || m > now) continue;
        let threadId = x.threadId;
        let instanceId = threadId?.split(":")[1] ?? "claudeAgent";
        if (threadId === undefined) {
          const owner = (opts.instances ?? [inst("claudeAgent", null)]).find((i) => i.homePath !== null && inHome(x.path, i.homePath));
          if (!owner) continue; // no instance reads this home
          instanceId = owner.instanceId;
          threadId = `import:${owner.instanceId}:${basename(x.path, ".jsonl")}`;
        }
        if (opts.never?.has(threadId)) continue;
        n++;
        if (!f.threads.has(threadId)) f.threads.set(threadId, { id: threadId, projectId, instanceId, archived: false, title: "t", updatedAt: m });
      }
      return { importedCount: n, skippedCount: 0 };
    },
    settleThread: (id: string, settledAt?: string) => write(`settle:${id}`, () => {
      const t = threadOf(id);
      t.settledOverride = "settled";
      t.settledAt = settledAt ?? new Date().toISOString();
    }),
    unsettleThread: (id: string) => write(`unsettle:${id}`, () => {
      const t = threadOf(id);
      t.settledOverride = "active";
      t.settledAt = null;
      t.unsettledAt = new Date().toISOString();
    }),
    setThreadTitle: (id: string, title: string) => write(`title:${id}:${title}`, () => { threadOf(id).title = title; }),
    setProjectPinned: (id: string, pinned: boolean) => write(`pin:${id}:${pinned}`, () => {
      const p = f.projects.find((x) => x.id === id);
      if (p) p.pinned = pinned;
    }),
    setProjectTitle: (id: string, title: string) => write(`project-title:${id}:${title}`, () => {
      const p = f.projects.find((x) => x.id === id && !x.deleted);
      if (!p) throw new T3HttpError("POST /api/projects/mutate", 404, { errorTag: "ProjectNotFoundError" });
      p.title = title;
    }),
    // T3 refuses to delete a project that still holds a thread (archived included) without `force` (S6 addendum).
    deleteProject: (id: string) => write(`delete-project:${id}`, () => {
      const p = f.projects.find((x) => x.id === id);
      if (!p) throw new T3HttpError("POST /api/projects/mutate", 404, { errorTag: "ProjectNotFoundError" });
      if ([...f.threads.values()].some((t) => t.projectId === id)) throw new T3HttpError("POST /api/projects/mutate", 409, { errorTag: "ProjectNotEmptyError" });
      p.deleted = true;
    }),
    getServerSetting: async () => f.autoSettleDays,
    setAutoSettleAfterDays: (days: number | null) => write(`auto-settle:${days}`, () => {
      const previous = f.autoSettleDays;
      f.autoSettleDays = days;
      return { previous };
    }),
    archiveThread: (id: string) => write(`archive:${id}`, () => { threadOf(id).archived = true; }),
    unarchiveThread: (id: string) => write(`unarchive:${id}`, () => { threadOf(id).archived = false; }),
    updateInstanceAppearance: async () => ({ previous: null, changed: false }),
    close: async () => void f.calls.push("close"),
  } as unknown as T3Api;
  return f;
}

const temps: string[] = [];
// Every temp home made by a test file is removed when that file's tests end.
after(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A temp dir with an `<encoded>` folder for synthetic transcripts (removed after the test file). */
export function tempHome(): { home: string; dir: string; state: string } {
  const home = mkdtempSync(join(tmpdir(), "t3sm-apply-"));
  temps.push(home);
  const dir = join(home, ".claude", "projects", "C--work-demo");
  mkdirSync(dir, { recursive: true });
  return { home, dir, state: join(home, "state") };
}

/** Writes a synthetic transcript with the given mtime and returns its plan item (import into `root`). */
export function transcript(f: FakeT3 | null, dir: string, root: string, mtimeMs: number, extra: { cost?: number; instanceId?: string } = {}): PlanItem {
  const s = sess({ cwd: root, mtimeMs });
  const path = join(dir, `${s.nativeId}.jsonl`);
  const body = `{"type":"user","cwd":"C:/work/demo","sessionId":"${s.nativeId}","message":{"role":"user","content":"hi"}}\n`;
  writeFileSync(path, body);
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  s.file = { path, size: Buffer.byteLength(body), mtimeMs, atimeMs: mtimeMs };
  s.cwdOffsetBytes = extra.cost ?? 100;
  const instanceId = extra.instanceId ?? "claudeAgent";
  const threadId = `import:${instanceId}:${s.nativeId}`;
  f?.files.push({ path, root, threadId });
  return { session: s, action: { kind: "import", projectRoot: root, instanceId, expectedThreadId: threadId }, notes: [] };
}
