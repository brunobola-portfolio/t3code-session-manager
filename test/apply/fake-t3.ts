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
}

export interface FakeT3 {
  api: T3Api;
  files: FakeFile[];
  projects: T3Project[];
  threads: Map<string, T3Thread & { updatedAt: number }>;
  calls: string[];
  scanned: Map<string, number>;
  opts: FakeOpts;
}

export function inst(id: string, home: string | null, extra: Partial<ProviderInstanceInfo> = {}): ProviderInstanceInfo {
  return { instanceId: id, driver: "claudeAgent", homePath: home, displayName: id, accentColor: null, email: null, authStatus: "authenticated", enabled: true, availability: "available", ...extra };
}

export function fakeT3(opts: FakeOpts = {}): FakeT3 {
  const f: FakeT3 = { files: [], projects: [], threads: new Map(), calls: [], scanned: new Map(), opts, api: null as never };
  let seq = 0;
  f.api = {
    version: opts.version ?? "0.1.9-nightly.20261110.4465",
    listProjects: async () => f.projects.map((p) => ({ ...p })),
    listThreads: async () => [...f.threads.values()].map(({ updatedAt: _u, ...t }) => ({ ...t })),
    providerInstances: async () => (opts.instances ?? [inst("claudeAgent", null)]).map((i) => ({ ...i })),
    createProject: async (root: string, title: string) => {
      f.calls.push(`create:${root}`);
      const p: T3Project = { id: `p${++seq}`, title, workspaceRoot: root, defaultModelSelection: null, archived: false, deleted: false };
      f.projects.push(p);
      return { ...p };
    },
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
      if (!sameCwd(p.workspaceRoot, root)) throw new Error("root changed");
      const now = Date.now();
      let n = 0;
      for (const x of f.files) {
        if (!sameCwd(x.root, p.workspaceRoot)) continue;
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
    archiveThread: async () => {},
    unarchiveThread: async () => {},
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
