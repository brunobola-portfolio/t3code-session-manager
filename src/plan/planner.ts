// buildPlan: for every discovered session, which T3 project and which subscription (instance) it goes to, or why it is
// skipped. Pure apart from the injected readers (existsDir, readVscodePin, compareCopies, labelRecords); never calls T3.

import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type {
  AccountConfig, AccountSource, Config, DiscoveredSession, HarnessId, InstanceSpec, JournalEntry, Plan, PlanItem, PlanNote, ProjectSpec,
  SkipReason, Action,
} from "../core/types.ts";
import { encodeClaudeProjectDir, expandHome, normalizeCwd, pathKey as pathKeyOf, sameCwd } from "../core/paths.ts";
import { inImportWindow } from "../core/activity.ts";
import { globToRegExp } from "../core/glob.ts";
import { resolveRemap } from "../core/config.ts";
import { projectTitle } from "./names.ts";
import { classifyFolder, isT3Refused, type FolderEnv } from "./folders.ts";
import { categoryRules, PENDING_KEYS, resolveGeneralFolder, routeOf, type PendingKey, type Route } from "./categories.ts";
import { inferProjectRoot as realInferRoot, type RehomeGuess } from "./rehome.ts";
import { effectiveWrites, importedIndex, near } from "../core/journal.ts";
import { revisionUuid, uuidV5 } from "../core/uuid.ts";
import type { T3Project, T3Thread } from "../t3/api.ts";
import { compareCopies as realCompare, labelRecords as realLabels, projectAccount, readVscodePin as realReadPin, type CopyRelation } from "./ownership.ts";
import { pickWinners, type Loser } from "./dedupe.ts";
import { hasConverter as registryHasConverter, isConvertHarness as registryIsConvert, isConvertSession, otherForms } from "../sources/registry.ts";
export { sessionForms } from "../sources/registry.ts";
import { isConvertedTranscript as realIsConverted } from "../apply/claudeWriter.ts";

/** T3 driver for each natively imported non-Claude harness. */
const NATIVE_DRIVER: Partial<Record<HarnessId, string>> = { codex: "codex", pi: "pi" };
/** T3's native importer only looks at transcripts modified in the last 30 days. */
/** T3 scans at most this many transcripts per source. */
const T3_SOURCE_CAP = 5000;
/** Errors worth retrying when comparing copies (file held open by a running agent, AV scan, fd pressure). */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "EAGAIN", "EMFILE", "EACCES"]);
const RETRY_BACKOFF_MS = [100, 300, 1000] as const;

export interface PlanInput {
  sessions: DiscoveredSession[];
  config: Config;
  t3: {
    version: string; projects: T3Project[]; threads: T3Thread[];
    /** Claude-driver instances (instancesFromConfig). */
    instances: InstanceSpec[];
    /** Every T3 provider instance (providerInstances): resolves the codex / pi instance ids. No fallback ids. */
    providers: { instanceId: string; driver: string; enabled?: boolean }[];
  };
  journal: JournalEntry[];
  now: number;
  existsDir(p: string): Promise<boolean>;
  runId: string;
  readVscodePin?(root: string): Promise<string | null>;
  compareCopies?(a: string, b: string): Promise<CopyRelation>;
  /** `custom-title` / `tag` values of a transcript (default: ownership.labelRecords). */
  labelRecords?(file: string): Promise<Set<string>>;
  /**
   * Harnesses converted by t3sm (default: the registry's convert-mode adapters). A session's own `mode` wins over it.
   * Given, it also decides which journaled conversions / provenance records are t3sm's (default: registry.hasConverter).
   */
  isConvertHarness?(id: HarnessId): boolean;
  /** Fallback when the journal is missing: a Claude transcript t3sm wrote by conversion (default: claudeWriter's check). */
  isConvertedTranscript?(file: string, nativeId: string): Promise<boolean>;
  platform?: NodeJS.Platform;
  home?: string;
  /** Folder classification inputs (default: this home and platform, os.tmpdir(), process.env, T3 Code under ~/.t3). */
  folderEnv?: FolderEnv;
  /**
   * Claude session ids `t3sm recover` brings back: a session started in T3 Code whose thread t3sm cannot find (no thread id
   * in its transcript, `t3-native-unknown`) is planned as an orphan's faithful copy, without the orphaned question.
   */
  recover?: { has(nativeId: string): boolean };
  /** Language of the General folder's default path and title ("T3 General" / "T3 Geral"); default "en". */
  lang?: "en" | "pt";
  /** The project a rehomed Claude transcript worked in (default: rehome.inferProjectRoot). */
  inferProjectRoot?(file: string, knownRoots: string[], o: { platform: NodeJS.Platform; home: string }): Promise<RehomeGuess | null>;
  /** Backoff timer for compare retries (tests inject). */
  sleep?(ms: number): Promise<void>;
}

function memo<T>(fn: (k: string) => Promise<T>, key: (k: string) => string): (k: string) => Promise<T> {
  const m = new Map<string, Promise<T>>();
  return (k) => {
    const kk = key(k);
    let p = m.get(kk);
    if (!p) {
      p = fn(k);
      m.set(kk, p);
    }
    return p;
  };
}

export async function buildPlan(input: PlanInput): Promise<Plan> {
  const { config, t3, now } = input;
  /** A Claude session `t3sm recover` names: brought back as an orphan's faithful copy when T3 Code holds no thread of it. */
  const recovering = (s: DiscoveredSession): boolean => s.harness === "claude" && input.recover?.has(s.nativeId) === true;
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
  const rootKey = (p: string): string => pathKeyOf(p, platform);
  const lang = input.lang ?? "en";
  const pp = platform === "win32" ? path.win32 : path.posix;
  // T3 Code's own folders (default ~/.t3): only compared with session folders, never opened.
  const t3Base = normalizeCwd(expandHome("~/.t3", home), platform);
  const folderEnv: FolderEnv = input.folderEnv ?? {
    platform, home, tmpdir: tmpdir(), env: process.env, t3BaseDir: t3Base, t3WorktreesDir: `${t3Base}/worktrees`,
  };
  // One General folder only (R10): the configured one, else an existing T3 project at either default, else lang's.
  const generalFolder = resolveGeneralFolder(config, lang, t3.projects.filter((p) => !p.deleted).map((p) => p.workspaceRoot), { platform, home });
  const rules = categoryRules(config, lang, folderEnv, generalFolder);
  const generalKey = rootKey(rules.generalFolder);
  const readPin = memo(input.readVscodePin ?? realReadPin, rootKey);
  const existsDir = memo(input.existsDir, rootKey);
  const warnings: string[] = [];
  const rawCompare = input.compareCopies ?? ((a: string, b: string) => realCompare(a, b, platform));
  const sessionByPath = new Map(input.sessions.map((s) => [s.file.path, s]));
  const errCode = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // A copy that cannot be read never aborts the plan and never imports on a guess (importing both after a transient
  // EBUSY could leave a permanent duplicate thread in the wrong account). Transient errors are retried with backoff;
  // if the compare still fails, both copies of that session are skipped as `compare-failed` and retried next run.
  // pickWinners sees `diverged` for a failed pair; its sessions are removed from winners/forks afterwards.
  const failedIds = new Map<string, string>(); // "harness:nativeId" -> error code
  const compare = async (a: string, b: string): Promise<CopyRelation> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await rawCompare(a, b);
      } catch (e) {
        const code = errCode(e);
        if (TRANSIENT_CODES.has(code) && attempt < RETRY_BACKOFF_MS.length) {
          await sleep(RETRY_BACKOFF_MS[attempt]!);
          continue;
        }
        const s = sessionByPath.get(a) ?? sessionByPath.get(b);
        if (s) {
          const k = `${s.harness}:${s.nativeId}`;
          if (!failedIds.has(k)) failedIds.set(k, code);
        }
        return "diverged";
      }
    }
  };
  const readLabels = input.labelRecords ?? realLabels;
  const labelsOf = async (file: string): Promise<Set<string> | null> => {
    try {
      return await readLabels(file);
    } catch (e) {
      warnings.push(`could not read labels of a ${sessionByPath.get(file)?.harness ?? ""} transcript ${sessionByPath.get(file)?.nativeId ?? ""} (${errCode(e)})`);
      return null;
    }
  };

  // ---------- instances ----------
  const accountById = new Map<string, AccountConfig>(config.accounts.map((a) => [a.id, a]));
  const accountHome = (a: AccountConfig): string => normalizeCwd(expandHome(a.home, home), platform);
  const instancesToCreate: InstanceSpec[] = [];
  const instanceOfAccount = new Map<string, string>();
  for (const a of config.accounts) {
    const existing = t3.instances.find((i) => sameCwd(i.homePath, accountHome(a), platform));
    if (existing) {
      instanceOfAccount.set(a.id, existing.id);
      continue;
    }
    if (t3.instances.some((i) => i.id === a.id)) {
      warnings.push(`account ${a.id}: a T3 instance with this id points at another home; fix config.json or the instance before applying`);
    }
    instancesToCreate.push({ id: a.id, driver: "claudeAgent", displayName: a.displayName, accentColor: a.accentColor, homePath: accountHome(a), environment: [] });
    instanceOfAccount.set(a.id, a.id);
  }
  const driverInstance = (driver: string): string | null => {
    const ps = t3.providers.filter((p) => p.driver === driver && p.enabled !== false);
    return (ps.find((p) => p.instanceId === driver) ?? ps[0])?.instanceId ?? null;
  };

  // ---------- per-source cap warning ----------
  const perSource = new Map<string, number>();
  for (const s of input.sessions) {
    if (s.flags.includes("compressed")) continue; // T3 lists only plain rollouts: compressed ones never count
    const k = s.harness === "claude" ? `claude account ${s.accountId ?? "?"}` : s.harness;
    perSource.set(k, (perSource.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...perSource].sort()) {
    if (n > T3_SOURCE_CAP) warnings.push(`${k}: ${n} transcripts; T3 scans at most ${T3_SOURCE_CAP} per source, the rest are not seen by its importer`);
  }

  // ---------- effective cwd (remap) ----------
  const eff = new Map<DiscoveredSession, { cwd: string | null; remapped: boolean }>();
  for (const s of input.sessions) {
    if (s.cwd === null || s.cwd === "") eff.set(s, { cwd: null, remapped: false });
    else eff.set(s, resolveRemap(s.cwd, config, platform));
  }
  const withEff = (s: DiscoveredSession): DiscoveredSession => {
    const e = eff.get(s)!;
    return e.cwd === s.cwd ? s : { ...s, cwd: e.cwd };
  };
  const indexByRoot = (xs: DiscoveredSession[]): Map<string, DiscoveredSession[]> => {
    const m = new Map<string, DiscoveredSession[]>();
    for (const s of xs) {
      const c = eff.get(s)?.cwd ?? null;
      if (c === null || s.harness !== "claude") continue;
      const k = rootKey(c);
      const g = m.get(k);
      if (g) g.push(withEff(s));
      else m.set(k, [withEff(s)]);
    }
    return m;
  };

  // ---------- dedupe ----------
  // Evidence for "newest activity" while choosing between identical copies: sessions that live in one account only.
  const accountsOfId = new Map<string, Set<string>>();
  for (const s of input.sessions) {
    if (s.accountId === null || s.flags.includes("backup-copy")) continue;
    const k = `${s.harness}:${s.nativeId}`;
    (accountsOfId.get(k) ?? accountsOfId.set(k, new Set()).get(k)!).add(s.accountId);
  }
  const unambiguous = indexByRoot(input.sessions.filter((s) =>
    !s.flags.includes("backup-copy") && (accountsOfId.get(`${s.harness}:${s.nativeId}`)?.size ?? 0) <= 1));
  const preAccount = memo((root: string) => projectAccount(root, { sessions: unambiguous.get(rootKey(root)) ?? [], config, readVscodePin: readPin, platform, home }), rootKey);
  // Compressed rollouts are never compared byte for byte: discovery already keeps one session per id (a plain twin
  // wins), and the rest are converted or skipped `compressed`.
  const picked = await pickWinners(input.sessions.filter((s) => !s.flags.includes("compressed")), config, { compareCopies: compare, projectAccount: preAccount, platform });
  const failedKey = (s: DiscoveredSession): string | undefined => failedIds.has(`${s.harness}:${s.nativeId}`) ? `${s.harness}:${s.nativeId}` : undefined;
  const winners = picked.winners.filter((s) => failedKey(s) === undefined);
  const losers = picked.losers.filter((l) => failedKey(l.session) === undefined);
  const forks = picked.forks.filter((f) => f.every((s) => failedKey(s) === undefined));
  for (const [k, code] of failedIds) warnings.push(`could not compare copies of ${k.slice(k.indexOf(":") + 1)} (${code}); skipped both, will retry next run`);

  const winnersByRoot = indexByRoot(winners);
  const finalAccount = memo((root: string) => projectAccount(root, { sessions: winnersByRoot.get(rootKey(root)) ?? [], config, readVscodePin: readPin, platform, home }), rootKey);

  const loserOf = new Map<DiscoveredSession, Loser>(losers.map((l) => [l.session, l]));
  const notes = new Map<DiscoveredSession, Set<PlanNote>>();
  const note = (s: DiscoveredSession, n: PlanNote): void => {
    (notes.get(s) ?? notes.set(s, new Set()).get(s)!).add(n);
  };
  const inWindow = (s: DiscoveredSession): boolean => inImportWindow(s.file.mtimeMs, now);
  for (const f of forks) {
    for (const s of f) {
      note(s, "diverged-fork");
      if (f.some((o) => o !== s && inWindow(o))) note(s, "duplicate-in-window");
    }
  }

  // ---------- projects (existing) ----------
  const liveProjects = t3.projects.filter((p) => !p.deleted);
  const projectByKey = new Map<string, T3Project>();
  for (const p of liveProjects) {
    const k = rootKey(p.workspaceRoot);
    if (!projectByKey.has(k)) projectByKey.set(k, p);
  }
  const threadIds = new Set(t3.threads.map((t) => t.id));
  // Sessions started inside T3 carry T3's own thread id; their native ref (instance + native session) identifies them.
  const nativeRefs = new Set(t3.threads.flatMap((t) => (t.nativeSessionId ? [`${t.instanceId}:${t.nativeSessionId}`] : [])));
  /** native session id -> the instances T3 holds a thread of it under (`import:<instance>:<id>` or its native ref). */
  const instancesOfSession = new Map<string, Set<string>>();
  /** native session id -> the project T3 holds a thread of it in (the first one listed). */
  const projectOfSession = new Map<string, string>();
  /** Every thread by id (listThreads: active and archived, every instance). */
  const threadById = new Map(t3.threads.map((t) => [t.id, t]));
  /** native session id -> the first thread T3 holds of it (`import:<instance>:<id>` or its native ref). */
  const threadOfSession = new Map<string, T3Thread>();
  for (const t of t3.threads) {
    const m = /^import:([^:]+):(.+)$/.exec(t.id);
    for (const [inst, id] of [...(m ? [[m[1]!, m[2]!]] : []), ...(t.nativeSessionId ? [[t.instanceId, t.nativeSessionId]] : [])]) {
      const set = instancesOfSession.get(id!) ?? new Set<string>();
      set.add(inst!);
      instancesOfSession.set(id!, set);
      if (!projectOfSession.has(id!)) projectOfSession.set(id!, t.projectId);
      if (!threadOfSession.has(id!)) threadOfSession.set(id!, t);
    }
  }
  /**
   * The thread of a session T3 Code started: the one its handoff names (T3-native thread ids are plain uuids, matched
   * exactly), else one T3 holds of the session itself. Active or archived, any instance; undefined when none is left.
   */
  const t3ThreadOf = (s: DiscoveredSession): T3Thread | undefined =>
    (s.t3ThreadId !== undefined ? threadById.get(s.t3ThreadId) : undefined) ?? threadOfSession.get(s.nativeId);
  /** The root of the live project T3 holds a thread of session `id` in, or null. */
  const t3RootOf = (id: string): string | null => {
    const pid = projectOfSession.get(id);
    const p = pid === undefined ? undefined : liveProjects.find((x) => x.id === pid);
    return p ? canonicalRoot(p.workspaceRoot) : null;
  };
  const imported = importedIndex(input.journal);
  const converted = new Map<string, { updatedAt: string; messageCount: number }>();
  // Faithful copies (spec §4.3): the original as copied. A record without a timestamp (a rename) changes neither
  // updatedAt nor messageCount, so its size and time are compared too.
  const copiedFile = new Map<string, { size: number; mtimeMs: number }>();
  for (const e of effectiveWrites(input.journal)) {
    if (!e.source) continue;
    const k = `${e.source.harness}:${e.source.nativeId}`;
    converted.set(k, e.source);
    const r = e.rehomeOf;
    if (r && typeof r.size === "number" && typeof r.mtimeMs === "number") copiedFile.set(k, { size: r.size, mtimeMs: r.mtimeMs });
    else copiedFile.delete(k);
  }
  // Revisions merged into T3 (t3sm merge): a session merged at its current size is not "continued outside" any more.
  const rolledBack = new Set(input.journal.flatMap((e) => (e.t === "rolled-back" ? [e.targetRunId] : [])));
  const standing = input.journal.filter((e): e is Extract<JournalEntry, { t: "merged" }> => e.t === "merged" && !rolledBack.has(e.runId));
  const mergedRevs = new Set(standing.map((e) => e.revisionUuid));
  const excludeRes = config.exclude.map((g) => globToRegExp(g, platform));
  const isConvert = input.isConvertHarness ?? registryIsConvert;
  // Per session: Codex compressed rollouts are converted while plain Codex rollouts stay native.
  const convertSession = (s: DiscoveredSession): boolean => isConvertSession(s, isConvert);
  // Provenance: conversions of any harness t3sm converts sessions of (OpenCode; Codex compressed rollouts).
  const converts = input.isConvertHarness ?? registryHasConverter;
  // Converted transcripts t3sm wrote (journaled targets of a convert-mode session): the Claude adapter rediscovers them
  // as native sessions; they are imported through their convert-import item, never twice.
  const pathKey = (p: string): string => pathKeyOf(p, platform);
  // Merge revisions t3sm wrote that no standing merge uses (import failed / unverified / interrupted): never imported
  // on their own; `t3sm merge` reuses or removes them. One T3 already holds a thread for (a merge kept by a partial
  // rollback, an archive that failed) is an ordinary already-in-t3 session and stays mergeable.
  const usedRevisions = new Set(standing.map((e) => pathKey(e.revisionFile)));
  const unmergedRevisions = new Set(effectiveWrites(input.journal, pathKey).flatMap((e) => (e.revisionOf && !usedRevisions.has(pathKey(e.path)) ? [pathKey(e.path)] : [])));
  // A file-written with a Claude source is a rehomed copy (spec §4.3): t3sm's own, like a conversion.
  const convertedPaths = new Set(effectiveWrites(input.journal, pathKey).flatMap((e) => (e.source && (converts(e.source.harness) || e.source.harness === "claude") ? [pathKey(e.path)] : [])));
  // Rehomed copies are named uuidV5("claude:<source id>"), copies of orphaned T3 sessions uuidV5("claude-orphan:<source
  // id>"): one whose source is also discovered is that copy.
  const copyIds = new Set(input.sessions.flatMap((s) => (s.harness === "claude" ? [uuidV5(`claude:${s.nativeId}`), orphanUuid(s.nativeId)] : [])));
  const rehomeCopyPaths = new Set(effectiveWrites(input.journal, pathKey).flatMap((e) => (e.source?.harness === "claude" ? [pathKey(e.path)] : [])));
  /** A faithful copy t3sm wrote of a conversation from a refused folder (`t3sm merge` cannot handle it: R11). */
  const isRehomeCopy = (s: DiscoveredSession): boolean => s.harness === "claude" && (rehomeCopyPaths.has(pathKey(s.file.path)) || copyIds.has(s.nativeId));
  // Imports journaled by the file T3 read (a converted transcript was imported under its convert-mode session's id).
  const importedByPath = new Map<string, Extract<JournalEntry, { t: "imported" }>>();
  for (const e of input.journal) if (e.t === "imported" && typeof e.source?.path === "string") importedByPath.set(pathKey(e.source.path), e);
  const looksConverted = input.isConvertedTranscript ?? ((f: string, id: string) => realIsConverted(f, id, converts));

  // Canonical spelling of each new root: most frequent normalized variant, then lexicographic.
  const variantCount = new Map<string, Map<string, number>>();
  for (const s of input.sessions) {
    const c = eff.get(s)!.cwd;
    if (c === null) continue;
    const k = rootKey(c);
    const vm = variantCount.get(k) ?? variantCount.set(k, new Map()).get(k)!;
    vm.set(c, (vm.get(c) ?? 0) + 1);
  }
  const canonicalRoot = (c: string): string => {
    const k = rootKey(c);
    const p = projectByKey.get(k);
    if (p) return normalizeCwd(p.workspaceRoot, platform);
    const vm = variantCount.get(k);
    if (!vm) return normalizeCwd(c, platform);
    return [...vm].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]![0];
  };

  // ---------- categories (spec §4.1-§4.4) ----------
  // Known roots for rehome inference: live T3 projects and this plan's `project` folders, never the home folder, and
  // only folders that still exist (a missing folder is `missing`, not a project: never a rehome target).
  // Built once, on the first inference (a plan with nothing to rehome checks no extra folders).
  let knownRoots: Promise<string[]> | null = null;
  const knownRootsOnce = (): Promise<string[]> => (knownRoots ??= (async () => {
    const out = new Map<string, string>();
    for (const r of [...liveProjects.map((p) => p.workspaceRoot), ...[...eff.values()].flatMap((e) => (e.cwd === null ? [] : [e.cwd]))]) {
      const k = rootKey(r);
      if (out.has(k) || classifyFolder(r, folderEnv) !== "project") continue;
      if (await existsDir(normalizeCwd(r, platform))) out.set(k, canonicalRoot(r));
    }
    return [...out.values()];
  })());
  const inferRoot = input.inferProjectRoot ?? realInferRoot;
  let lastShare: { hits: number; total: number } | null = null;
  async function rehomeTarget(s: DiscoveredSession, route: Extract<Route, { kind: "rehome" }>): Promise<string> {
    lastShare = null;
    if (route.target !== null) return route.target;
    if (s.harness !== "claude") return rules.generalFolder; // inference reads Claude transcripts only
    try {
      const g = await inferRoot(s.file.path, await knownRootsOnce(), { platform, home });
      // Defensive: an inferred folder that does not exist is never a target.
      if (g !== null && await existsDir(normalizeCwd(g.root, platform))) { lastShare = { hits: g.hits, total: g.total }; return g.root; }
      return rules.generalFolder;
    } catch (e) {
      warnings.push(`could not read Claude transcript ${s.nativeId} to find its project (${errCode(e)}); it goes to the General folder`);
      return rules.generalFolder;
    }
  }
  const pending = new Map<PendingKey, { sessions: number; folders: Set<string> }>();

  // ---------- items ----------
  const items: (PlanItem & { sortRoot: string })[] = [];
  const mirrorCopies: Plan["mirrorCopies"] = [];
  const rootsUsed = new Map<string, string>(); // key -> canonical root (import / convert / already-in-t3)
  const importRoots = new Set<string>();
  const skip = (reason: SkipReason): Action => ({ kind: "skip", reason });

  for (const s of input.sessions) {
    const e = eff.get(s)!;
    if (e.remapped) note(s, "remapped-cwd");
    if (s.flags.includes("over-32mib")) note(s, "truncated-over-32mib");
    const action = await decide(s, e.cwd);
    items.push({ session: s, action, notes: [], sortRoot: e.cwd === null ? "" : canonicalRoot(e.cwd) });
  }

  /**
   * Work after T3 got the session in its other form. Converted now, native thread before: the session's activity is
   * newer than the run that imported it natively (journal; a session started inside T3 has no record: no note).
   * Native now, converted thread before: its activity differs from what the conversion recorded.
   */
  function continuedSinceOtherForm(s: DiscoveredSession, convert: boolean): boolean {
    if (convert) {
      const j = imported.get(`${s.harness}:${s.nativeId}`);
      if (!j || !j.threadId.endsWith(`:${s.nativeId}`)) return false;
      const at = runTime(j.runId);
      return at !== null && Date.parse(s.updatedAt) > at;
    }
    const w = converted.get(`${s.harness}:${s.nativeId}`);
    return w !== undefined && (w.updatedAt !== s.updatedAt || w.messageCount !== s.messageCount);
  }

  async function checkLabels(loser: DiscoveredSession, winner: DiscoveredSession): Promise<void> {
    const mine = await labelsOf(loser.file.path);
    if (mine === null || mine.size === 0) return;
    const kept = await labelsOf(winner.file.path);
    if (kept !== null && [...mine].some((x) => !kept.has(x))) note(winner, "label-only-in-mirror");
  }

  async function decide(s: DiscoveredSession, cwd: string | null): Promise<Action> {
    const has = (f: DiscoveredSession["flags"][number]): boolean => s.flags.includes(f);
    const filePath = normalizeCwd(s.file.path, platform);
    const ncwd = cwd === null ? null : normalizeCwd(cwd, platform);
    const ownCopy = s.harness === "claude" && (convertedPaths.has(pathKey(s.file.path)) || copyIds.has(s.nativeId) || await looksConverted(s.file.path, s.nativeId));
    if (ownCopy) {
      // Not in T3 yet: its convert-import item imports it (never two candidates for one path). Already in T3: from now
      // on it is the Claude session it became (resumable in a terminal), so it takes the normal already-in-t3 path
      // below, where continued-outside-t3 lets `t3sm merge` see terminal work on it.
      const inst = s.accountId !== null ? instanceOfAccount.get(s.accountId) : undefined;
      const inT3 = inst !== undefined && (threadIds.has(`import:${inst}:${s.nativeId}`) || nativeRefs.has(`${inst}:${s.nativeId}`));
      if (!inT3) return skip("converted");
    }
    if (excludeRes.some((re) => (ncwd !== null && re.test(ncwd)) || re.test(filePath))) return skip("excluded");
    if (has("backup-copy") && !config.includeBackups) return skip("backup-copy");
    if (has("duplicate-file")) return skip("duplicate"); // discovery planned another file of this session
    if (has("subagent")) return skip("subagent");
    const convert = convertSession(s);
    // A compressed rollout T3 cannot read and t3sm does not convert (codex.convertCompressed false): never opened.
    if (has("compressed") && !convert) return skip("compressed");
    if (has("active")) return skip("active");
    if (s.harness === "claude" && has("non-uuid-id")) return skip("non-uuid-id");
    if (has("no-session-id")) return skip("no-session-id");
    if (has("only-hidden")) return skip("only-hidden");
    if (has("over-4gib")) return skip("over-4gib");
    if (has("too-large")) return skip("too-large");
    if (ncwd === null || has("no-cwd")) return skip("no-cwd");
    if (has("cwd-unreadable")) return skip("cwd-unreadable");
    // A session T3 Code started (before the folder category). Its thread still there (active or archived, any
    // instance): already in T3. No thread id: t3sm cannot tell, and never copies it. Its thread deleted: T3 Code will
    // not import it again, so after a yes (`organize.sessions.orphaned`) it comes back as a faithful copy with a new
    // id, in its own folder (a folder T3 Code refuses: the rehome target). A copy t3sm wrote is never one of these:
    // it keeps the original's records (entrypoint t3-code, the handoff) and is recognised as t3sm's own above. A
    // mirror of a copy kept in another account stays a mirror copy (below), for `t3sm dedupe`.
    const fromT3 = s.harness === "claude" && s.startedIn === "t3" && !ownCopy && !loserOf.has(s);
    if (fromT3) {
      const held = t3ThreadOf(s);
      if (held !== undefined) {
        const p = liveProjects.find((x) => x.id === held.projectId);
        if (p) rootsUsed.set(rootKey(p.workspaceRoot), canonicalRoot(p.workspaceRoot));
        note(s, "started-in-t3");
        return skip("already-in-t3");
      }
      // Brought back already (`t3sm recover`): its copy's thread is in T3 Code (any instance, archived or not).
      if (s.t3ThreadId === undefined && instancesOfSession.has(orphanUuid(s.nativeId))) {
        const r = t3RootOf(orphanUuid(s.nativeId));
        if (r !== null) rootsUsed.set(rootKey(r), r);
        note(s, "recovered");
        return skip("already-in-t3");
      }
      // `t3sm recover <id>` names one: the user says its thread is gone, so it is treated as orphaned (below).
      if (s.t3ThreadId === undefined && !recovering(s)) return skip("t3-native-unknown");
    }
    /** Started in T3 Code and its thread is gone (every other case returned above). */
    const orphan = fromT3;
    // A category skip applies last (below): only to sessions that would otherwise be imported.
    const category = routeOf(s, ncwd, rules, s.harness === "claude" || convert || converts(s.harness));
    // An orphan ignores the folder category, never an `organize.overrides` rule: a `rehome:<folder>` one (a route
    // with a target) sends its copy there; a `skip` one (`excluded`, or a bad rehome target) keeps it out.
    const overrideSkip = category.kind === "skip" && (category.reason === "excluded" || category.badTarget !== undefined);
    const route: Route = !orphan ? category
      : category.kind === "rehome" && category.target !== null ? category
      : !isT3Refused(ncwd, folderEnv) ? { kind: "native" }
      : category.kind === "rehome" ? category : { kind: "rehome", target: null };
    /** Why an orphaned session waits or stays out (applied where a category skip would be). */
    const orphanHold: Extract<Route, { kind: "skip" }> | null = !orphan ? null
      : overrideSkip ? category
      : recovering(s) ? null // asked for by name (`t3sm recover`): no question, whatever organize.sessions.orphaned says
      : !rules.decided("orphaned") ? { kind: "skip", reason: "undecided", pending: "orphaned" }
      : rules.organize.sessions.orphaned === "skip" ? { kind: "skip", reason: "orphaned-in-t3" } : null;
    // A rehomed session's own folder does not matter (and its target may not exist yet: created on apply). R9: a
    // session from a deleted refused folder is still rehomed.
    if (route.kind !== "rehome" && !(await existsDir(ncwd))) return skip("cwd-missing");

    const rehome = route.kind === "rehome";
    const asCopy = convert || rehome || orphan;
    /** The id of the copy (convert-mode, rehomed or orphaned session). */
    const copyUuid = orphan ? orphanUuid(s.nativeId) : uuidV5(`${s.harness}:${s.nativeId}`);
    // Where the session goes. A rehomed Claude transcript's project is inferred by reading the whole transcript
    // (rehomeTarget), so it is resolved only for a session that will be imported; one already in T3 (or skipped below)
    // is never read for it.
    let target: { root: string; share: { hits: number; total: number } | null } | null = null;
    const resolveTarget = async (): Promise<{ root: string; share: { hits: number; total: number } | null }> => {
      if (target === null) {
        if (route.kind !== "rehome") target = { root: canonicalRoot(ncwd), share: null };
        else {
          const r = canonicalRoot(await rehomeTarget(s, route));
          target = { root: r, share: lastShare };
        }
      }
      return target;
    };
    const lazyTarget = rehome && s.harness === "claude";
    /** The project this item counts for (rootsUsed) when T3 already holds it: for a lazy target, where T3 holds its thread. */
    const useRootInT3 = async (id: string): Promise<void> => {
      const r = lazyTarget ? t3RootOf(id) : (await resolveTarget()).root;
      if (r !== null) rootsUsed.set(rootKey(r), r);
    };
    let instanceId: string | null;
    let convertAccount: AccountConfig | null = null;
    if (lazyTarget || orphan) {
      // A faithful copy stays in its own account.
      convertAccount = s.accountId !== null ? accountById.get(s.accountId) ?? null : null;
      instanceId = convertAccount ? instanceOfAccount.get(convertAccount.id) ?? null : null;
    } else if (asCopy) {
      const acct = accountById.get((await finalAccount((await resolveTarget()).root)).accountId);
      convertAccount = acct ?? null;
      instanceId = acct ? instanceOfAccount.get(acct.id) ?? null : null;
    } else if (s.harness === "claude") {
      instanceId = s.accountId !== null && accountById.has(s.accountId) ? instanceOfAccount.get(s.accountId) ?? null : null;
    } else {
      const driver = NATIVE_DRIVER[s.harness];
      instanceId = driver ? driverInstance(driver) : null;
    }
    // One session, two forms (Codex: its native id and its converted uuid). Already in T3 under the other form (any
    // instance) and not under this one: it is in T3; importing this form would make a second thread of one session.
    const own = asCopy ? copyUuid : s.nativeId;
    if (!instancesOfSession.has(own) && otherForms(s, own).some((f) => instancesOfSession.has(f))) {
      await useRootInT3(own);
      note(s, "in-t3-as-other-form");
      if (continuedSinceOtherForm(s, asCopy)) note(s, "continued-outside-t3");
      return skip("already-in-t3");
    }
    if (instanceId === null) return skip("harness-unavailable");

    if (failedKey(s) !== undefined) return skip("compare-failed");
    const l = loserOf.get(s);
    if (l) {
      if (l.relation === "identical" || l.relation === "prefix") {
        mirrorCopies.push({ path: s.file.path, nativeId: s.nativeId, keptPath: l.winner.file.path, relation: l.relation });
        if (inWindow(s)) note(l.winner, "duplicate-in-window");
        // Metadata-only differences stay mirror copies (dedupe quarantines reversibly); flag a user label that only
        // the mirror holds so the report can say where it is.
        await checkLabels(s, l.winner);
        return skip("mirror-copy");
      }
      if (l.relation === "case-variant") {
        if (inWindow(s)) note(l.winner, "duplicate-in-window");
        await checkLabels(s, l.winner);
      }
      return skip("duplicate");
    }

    const uuid = asCopy ? copyUuid : null;
    const expectedThreadId = `import:${instanceId}:${uuid ?? s.nativeId}`;
    if (threadIds.has(expectedThreadId) || nativeRefs.has(`${instanceId}:${uuid ?? s.nativeId}`)) {
      await useRootInT3(uuid ?? s.nativeId);
      if (asCopy) {
        // Convert-mode sessions share one source file (the harness db): compare the session's own activity with what
        // the last conversion recorded. A faithful copy's original is a file of its own: its size and time too. The
        // copy in T3 is never rewritten (T3 never adds messages to an existing thread): the note is the signal, and
        // for a rehomed Claude original it is its own note (R11: `t3sm merge` cannot bring that work into T3).
        const w = converted.get(`${s.harness}:${s.nativeId}`);
        const f = copiedFile.get(`${s.harness}:${s.nativeId}`);
        if ((w && (w.updatedAt !== s.updatedAt || w.messageCount !== s.messageCount))
          || (f && (f.size !== s.file.size || !near(s.file.mtimeMs, f.mtimeMs)))) {
          note(s, (rehome || orphan) && s.harness === "claude" ? "continued-after-rehome" : "continued-outside-t3");
        }
        return skip("already-in-t3");
      }
      const j = imported.get(`${s.harness}:${s.nativeId}`) ?? importedByPath.get(pathKey(s.file.path));
      if (j && (j.source.size !== s.file.size || !near(s.file.mtimeMs, j.source.mtimeMs)) && !mergedRevs.has(revisionUuid(s.nativeId, s.file.size))) {
        // A rehomed copy resumed outside T3 Code: merge cannot handle it either (R11).
        note(s, isRehomeCopy(s) ? "continued-after-rehome" : "continued-outside-t3");
      }
      return skip("already-in-t3");
    }
    // The same session already in T3 under another instance (imported earlier under another account): importing it
    // here would make a second thread of one session. Listed in the report for review instead.
    if ([...(instancesOfSession.get(uuid ?? s.nativeId) ?? [])].some((i) => i !== instanceId)) {
      await useRootInT3(uuid ?? s.nativeId);
      note(s, "in-t3-under-other-account");
      return skip("already-in-t3");
    }
    const hold = orphanHold ?? (route.kind === "skip" ? route : null);
    if (hold !== null) {
      if (hold.badTarget !== undefined) warnings.push(`organize.overrides: rehome:${hold.badTarget} is not a folder T3 Code can hold a project in (refused, temporary or system); its sessions are skipped`);
      if (hold.pending) {
        const p = pending.get(hold.pending) ?? pending.set(hold.pending, { sessions: 0, folders: new Set() }).get(hold.pending)!;
        p.sessions++;
        p.folders.add(rootKey(ncwd));
      }
      return skip(hold.reason);
    }
    // T3 Code imports nothing of it (a bare command no reply followed): planned, it would fail in every run. After the
    // already-in-t3 checks: a session an older T3 Code did import stays one.
    if (has("no-reply")) return skip("only-hidden");
    const { root, share } = await resolveTarget();
    rootsUsed.set(rootKey(root), root);
    if (s.harness === "claude" && unmergedRevisions.has(pathKey(s.file.path))) return skip("revision");
    importRoots.add(rootKey(root));
    if (asCopy) {
      const targetFile = pp.join(accountHome(convertAccount!), "projects", encodeClaudeProjectDir(root), `${uuid}.jsonl`);
      const action: Action = { kind: "convert-import", projectRoot: root, instanceId, expectedThreadId, uuid: uuid!, targetFile };
      if (rehome) Object.assign(action, s.harness === "claude" ? { copy: "faithful", rehomeFrom: ncwd } : { rehomeFrom: ncwd }, share ? { rehomeShare: share } : {});
      else if (orphan) Object.assign(action, { copy: "faithful" });
      return action;
    }
    return { kind: "import", projectRoot: root, instanceId, expectedThreadId };
  }

  for (const it of items) it.notes = [...(notes.get(it.session) ?? [])].sort();
  items.sort((a, b) =>
    cmp(a.sortRoot, b.sortRoot) || cmp(a.session.updatedAt, b.session.updatedAt) || cmp(a.session.harness, b.session.harness)
    || cmp(a.session.nativeId, b.session.nativeId) || cmp(a.session.file.path, b.session.file.path));

  // ---------- projects ----------
  const projectsToCreate: ProjectSpec[] = [];
  const projectAccounts: Plan["projectAccounts"] = [];
  const projectDefaults: Plan["projectDefaults"] = [];
  const nameLimit = rules.organize.names.maxLength;
  const takenTitles = new Set(liveProjects.map((p) => p.title.toLowerCase()));
  for (const [k, root] of [...rootsUsed].sort((a, b) => cmp(a[1], b[1]))) {
    const pa = await finalAccount(root);
    projectAccounts.push({ root, accountId: pa.accountId, source: pa.source as AccountSource });
    const inst = instanceOfAccount.get(pa.accountId) ?? null;
    const existing = projectByKey.get(k);
    if (existing) {
      if (existing.archived && importRoots.has(k)) warnings.push(`project "${existing.title}" is archived in T3; sessions are imported into it anyway (unarchive it to see them)`);
      const cur = existing.defaultModelSelection?.["instanceId"];
      if (inst !== null && cur !== inst) projectDefaults.push({ root, instanceId: inst });
    } else if (importRoots.has(k)) {
      // The General folder (rehomed sessions with no project of their own) has a fixed title.
      const title = k === generalKey ? (lang === "pt" ? "Geral" : "General") : projectTitle(root, takenTitles, { maxLength: nameLimit, platform });
      takenTitles.add(title.toLowerCase());
      projectsToCreate.push({ root, title, defaultInstanceId: inst });
      if (inst !== null) projectDefaults.push({ root, instanceId: inst });
    }
  }

  return {
    version: 1, runId: input.runId, createdAt: new Date(now).toISOString(), t3Version: t3.version,
    instancesToCreate, projectsToCreate, projectAccounts, projectDefaults,
    mirrorCopies: mirrorCopies.sort((a, b) => cmp(a.path, b.path)),
    items: items.map(({ sortRoot: _r, ...it }) => it),
    warnings: [...new Set(warnings)],
    ...(pending.size > 0 ? {
      decisionsPending: PENDING_KEYS.flatMap((key) => {
        const p = pending.get(key);
        return p ? [{ key, sessions: p.sessions, folders: p.folders.size }] : [];
      }),
    } : {}),
  };
}

/** The id of the copy of an orphaned T3 session (its thread deleted): distinct from a rehome copy's `claude:<id>`. */
export function orphanUuid(nativeId: string): string {
  return uuidV5(`claude-orphan:${nativeId}`);
}

/** A run's start time from its id (`YYYYMMDD-HHMMSS-…`, UTC), or null. */
function runTime(runId: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(runId);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : null;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
