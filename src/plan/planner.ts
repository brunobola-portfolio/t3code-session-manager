// buildPlan: for every discovered session, which T3 project and which subscription (instance) it goes to, or why it is
// skipped. Pure apart from the injected readers (existsDir, readVscodePin, compareCopies, labelRecords); never calls T3.

import { homedir } from "node:os";
import path from "node:path";
import type {
  AccountConfig, AccountSource, Config, DiscoveredSession, HarnessId, InstanceSpec, JournalEntry, Plan, PlanItem, PlanNote, ProjectSpec,
  SkipReason, Action,
} from "../core/types.ts";
import { encodeClaudeProjectDir, expandHome, normalizeCwd, pathKey as pathKeyOf, sameCwd } from "../core/paths.ts";
import { inImportWindow } from "../core/activity.ts";
import { globToRegExp } from "../core/glob.ts";
import { resolveRemap } from "../core/config.ts";
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

function lastSegment(root: string): string {
  const parts = root.split("/").filter((x) => x !== "");
  return parts.length === 0 ? root : parts[parts.length - 1]!;
}

export async function buildPlan(input: PlanInput): Promise<Plan> {
  const { config, t3, now } = input;
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
  const rootKey = (p: string): string => pathKeyOf(p, platform);
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
  for (const t of t3.threads) {
    const m = /^import:([^:]+):(.+)$/.exec(t.id);
    for (const [inst, id] of [...(m ? [[m[1]!, m[2]!]] : []), ...(t.nativeSessionId ? [[t.instanceId, t.nativeSessionId]] : [])]) {
      const set = instancesOfSession.get(id!) ?? new Set<string>();
      set.add(inst!);
      instancesOfSession.set(id!, set);
    }
  }
  const imported = importedIndex(input.journal);
  const converted = new Map<string, { updatedAt: string; messageCount: number }>();
  for (const e of effectiveWrites(input.journal)) if (e.source) converted.set(`${e.source.harness}:${e.source.nativeId}`, e.source);
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
  const convertedPaths = new Set(effectiveWrites(input.journal, pathKey).flatMap((e) => (e.source && converts(e.source.harness) ? [pathKey(e.path)] : [])));
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
    if (s.harness === "claude" && (convertedPaths.has(pathKey(s.file.path)) || await looksConverted(s.file.path, s.nativeId))) {
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
    if (!(await existsDir(ncwd))) return skip("cwd-missing");

    const root = canonicalRoot(ncwd);
    let instanceId: string | null;
    let convertAccount: AccountConfig | null = null;
    if (convert) {
      const acct = accountById.get((await finalAccount(root)).accountId);
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
    const own = convert ? uuidV5(`${s.harness}:${s.nativeId}`) : s.nativeId;
    if (!instancesOfSession.has(own) && otherForms(s, own).some((f) => instancesOfSession.has(f))) {
      rootsUsed.set(rootKey(root), root);
      note(s, "in-t3-as-other-form");
      if (continuedSinceOtherForm(s, convert)) note(s, "continued-outside-t3");
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

    const uuid = convert ? uuidV5(`${s.harness}:${s.nativeId}`) : null;
    const expectedThreadId = `import:${instanceId}:${uuid ?? s.nativeId}`;
    rootsUsed.set(rootKey(root), root);
    if (threadIds.has(expectedThreadId) || nativeRefs.has(`${instanceId}:${uuid ?? s.nativeId}`)) {
      if (convert) {
        // Convert-mode sessions share one source file (the harness db): compare the session's own activity with what
        // the last conversion recorded.
        const w = converted.get(`${s.harness}:${s.nativeId}`);
        if (w && (w.updatedAt !== s.updatedAt || w.messageCount !== s.messageCount)) note(s, "continued-outside-t3");
        return skip("already-in-t3");
      }
      const j = imported.get(`${s.harness}:${s.nativeId}`) ?? importedByPath.get(pathKey(s.file.path));
      if (j && (j.source.size !== s.file.size || !near(s.file.mtimeMs, j.source.mtimeMs)) && !mergedRevs.has(revisionUuid(s.nativeId, s.file.size))) {
        note(s, "continued-outside-t3");
      }
      return skip("already-in-t3");
    }
    // The same session already in T3 under another instance (imported earlier under another account): importing it
    // here would make a second thread of one session. Listed in the report for review instead.
    if ([...(instancesOfSession.get(uuid ?? s.nativeId) ?? [])].some((i) => i !== instanceId)) {
      note(s, "in-t3-under-other-account");
      return skip("already-in-t3");
    }
    if (s.harness === "claude" && unmergedRevisions.has(pathKey(s.file.path))) return skip("revision");
    importRoots.add(rootKey(root));
    if (convert) {
      const p = platform === "win32" ? path.win32 : path.posix;
      const targetFile = p.join(accountHome(convertAccount!), "projects", encodeClaudeProjectDir(root), `${uuid}.jsonl`);
      return { kind: "convert-import", projectRoot: root, instanceId, expectedThreadId, uuid: uuid!, targetFile };
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
      projectsToCreate.push({ root, title: lastSegment(root), defaultInstanceId: inst });
      if (inst !== null) projectDefaults.push({ root, instanceId: inst });
    }
  }

  return {
    version: 1, runId: input.runId, createdAt: new Date(now).toISOString(), t3Version: t3.version,
    instancesToCreate, projectsToCreate, projectAccounts, projectDefaults,
    mirrorCopies: mirrorCopies.sort((a, b) => cmp(a.path, b.path)),
    items: items.map(({ sortRoot: _r, ...it }) => it),
    warnings: [...new Set(warnings)],
  };
}

/** A run's start time from its id (`YYYYMMDD-HHMMSS-…`, UTC), or null. */
function runTime(runId: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(runId);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : null;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
