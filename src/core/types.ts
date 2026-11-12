// Shared types. Types only: no runtime code here.
// src/core/types.ts
export type HarnessId = "claude" | "codex" | "pi" | "opencode";
export type SessionFlag = "corrupt-lines" | "no-cwd" | "cwd-unreadable" | "non-uuid-id" | "only-hidden"
  | "over-32mib" | "over-4gib" | "backup-copy" | "active" | "subagent" | "no-session-id"
  // A Codex rollout compressed by Codex CLI (rollout-*.jsonl.zst). T3 Code cannot read it: t3sm converts it (session
  // mode "convert"), or, with codex.convertCompressed false, lists it unopened and skips it.
  | "compressed"
  // Larger than 512 MiB once decompressed (a compressed Codex rollout): too big to convert.
  | "too-large"
  // Another file holds the same session (Codex: a plain and a compressed copy, or a `<id>_<child>` rollout carrying the
  // parent's id): discovery planned the other file; this one is listed and skipped as `duplicate`.
  | "duplicate-file"
  // A Claude transcript whose records carry another session id than its file name: nativeId is the id inside (T3's
  // rule), which is what T3 Code names the thread after.
  | "id-mismatch";
export interface SourceFile { path: string; size: number; mtimeMs: number; atimeMs: number }
export interface DiscoveredSession {
  harness: HarnessId; accountId: string | null; nativeId: string;
  cwd: string | null; startedAt: string | null; updatedAt: string;
  messageCount: number; corruptLines: number; file: SourceFile; flags: SessionFlag[];
  cwdOffsetBytes: number; // bytes read until the first record carrying cwd (T3 metadata budget cost, S2)
  /**
   * How this session reaches T3: `native` (T3 imports the file itself) or `convert` (t3sm reads it and writes a Claude
   * transcript). Absent: its adapter's mode. Set per session where one harness has both (Codex: compressed rollouts).
   */
  mode?: "native" | "convert";
}
export interface CanonicalMessage { role: "user" | "assistant"; text: string; timestamp: string }
export interface CanonicalTranscript {
  harness: HarnessId; nativeId: string; cwd: string; title: string | null;
  startedAt: string; messages: CanonicalMessage[];
  /** The session's activity as this read saw it (convert-mode adapters; same measure as discovery). */
  activity?: { updatedAt: string; messageCount: number };
}
export type SkipReason = "already-in-t3" | "cwd-missing" | "duplicate" | "mirror-copy" | "backup-copy" | "active"
  | "non-uuid-id" | "only-hidden" | "over-4gib" | "no-cwd" | "cwd-unreadable" | "excluded" | "harness-unavailable"
  | "subagent" | "compressed" | "too-large" | "no-session-id" | "compare-failed"
  // A Claude transcript t3sm itself wrote by converting another harness's session (imported through that item).
  | "converted"
  // A merge revision t3sm wrote (t3sm merge) that was never merged: `t3sm merge` reuses or removes it.
  | "revision";
export type Action =
  | { kind: "import"; projectRoot: string; instanceId: string; expectedThreadId: string }
  | { kind: "convert-import"; projectRoot: string; instanceId: string; expectedThreadId: string; uuid: string; targetFile: string }
  | { kind: "skip"; reason: SkipReason };
export type PlanNote = "duplicate-in-window" | "diverged-fork" | "truncated-over-32mib" | "continued-outside-t3" | "remapped-cwd"
  | "label-only-in-mirror"
  // T3 already holds this session under another instance (account): skipped as already-in-t3, never a second copy.
  | "in-t3-under-other-account"
  // T3 already holds this session in its other form (Codex: a Codex thread, or a converted Claude thread): one session,
  // never a second thread.
  | "in-t3-as-other-form";
export type AccountSource = "route" | "vscode-pin" | "recent-activity" | "default";
export interface PlanItem { session: DiscoveredSession; action: Action; notes: PlanNote[] }
export interface InstanceSpec { id: string; driver: "claudeAgent"; displayName: string; accentColor: string | null; homePath: string; environment: { name: string; value: string; sensitive: boolean }[] }
export interface ProjectSpec { root: string; title: string; defaultInstanceId: string | null }
export interface Plan {
  version: 1; runId: string; createdAt: string; t3Version: string;
  instancesToCreate: InstanceSpec[]; projectsToCreate: ProjectSpec[];
  projectAccounts: { root: string; accountId: string; source: AccountSource }[];
  projectDefaults: { root: string; instanceId: string }[];
  mirrorCopies: { path: string; nativeId: string; keptPath: string; relation: "identical" | "prefix" }[];
  items: PlanItem[];
  /** Human-readable warnings for the report (archived project reused, per-source T3 cap exceeded, instance id clash). */
  warnings: string[];
  /**
   * T3's default Claude instance has no explicit home in T3's settings (implicit): `apply` pins it to this home
   * (`~/.claude`) so an inherited CLAUDE_CONFIG_DIR can never move it. Absent or null: nothing to pin.
   */
  pinDefault?: { instanceId: string; homePath: string } | null;
}
export type JournalEntry =
  | { t: "run-start"; runId: string; at: string; command: string }
  | { t: "mtime-bump"; runId: string; files: { path: string; atimeMs: number; mtimeMs: number; targetMtimeMs: number }[] }
  | { t: "mtime-restore"; runId: string; paths: string[] }
  // A converted transcript t3sm wrote (materializeConversions), journaled BEFORE the write. mtimeMs: the time it was
  // given (the source session's last activity, so it is not "in use"). source: the converted session as discovered
  // (convert-mode sessions share one source file, so continued-outside-t3 compares these instead of file size).
  | { t: "file-written"; runId: string; path: string; sha256: string; mtimeMs?: number;
    source?: { harness: HarnessId; nativeId: string; updatedAt: string; messageCount: number };
    /** A merge revision (t3sm merge) of this session. */
    revisionOf?: { harness: HarnessId; nativeId: string } }
  // A `file-written` whose file was never published (the target appeared meanwhile, or a refresh was skipped at the
  // last moment): cancels the latest `file-written` of the same run and path (journal.effectiveWrites).
  | { t: "file-write-aborted"; runId: string; path: string }
  | { t: "instance-created"; runId: string; instanceId: string; homePath: string | null }
  | { t: "project-created"; runId: string; projectId: string; root: string }
  | { t: "project-default-set"; runId: string; projectId: string; previous: unknown; next: unknown }
  | { t: "imported"; runId: string; harness: HarnessId; nativeId: string; threadId: string; source: { path: string; size: number; mtimeMs: number } }
  | { t: "import-failed"; runId: string; harness: HarnessId; nativeId: string; reason: string }
  // Written before a wave's import calls: the threads T3 may create in that wave (rollback finds them even when the
  // run dies before `imported` could be verified). parked: the copies parked (future mtime) for that wave, never meant
  // to be imported: a rollback lists an existing thread of theirs for review only, never as imported.
  // items[].source: the file as attempted (original size and mtime), so a later run can journal `imported` for a thread
  // that exists while the file is unchanged (the wave died before it could verify).
  | { t: "import-attempt"; runId: string; items: { harness: HarnessId; nativeId: string; threadId: string; source?: { path: string; size: number; mtimeMs: number } }[];
    parked?: { harness: HarnessId; nativeId: string; threadId: string }[] }
  | { t: "quarantined"; runId: string; from: string; to: string; reason: "backup-dir" | "mirror-copy" }
  // Deltas only, never a whole settings entry (no environment / secrets): pinned {homePath}, updated {displayName, accentColor, homePath}.
  | { t: "instance-pinned"; runId: string; instanceId: string; previous: { homePath: string | null }; next: { homePath: string } }
  | { t: "instance-updated"; runId: string; instanceId: string; previous: { displayName: string | null; accentColor: string | null; homePath: string | null }; next: { displayName: string | null; accentColor: string | null; homePath: string | null } }
  | { t: "unquarantined"; runId: string; from: string; to: string }
  // sourceSize / sourceMtimeMs: the original transcript as merged (the baseline for "continued outside T3" afterwards).
  | { t: "merged"; runId: string; harness: HarnessId; nativeId: string; revisionUuid: string; revisionFile: string; oldThreadId: string; newThreadId: string;
    sourceSize?: number; sourceMtimeMs?: number }
  | { t: "thread-archived"; runId: string; threadId: string }
  | { t: "thread-unarchived"; runId: string; threadId: string }
  // Written once at the end of a rollback run that changed something; `runId` is the rollback's own run.
  | { t: "rolled-back"; runId: string; targetRunId: string; at: string }
  | { t: "run-end"; runId: string; at: string; status: "ok" | "partial" | "aborted" };
export interface AccountConfig { id: string; home: string; displayName: string; accentColor: string | null }
export interface Config {
  version: 1; accounts: AccountConfig[]; defaultAccount: string;
  routes: { match: string; account: string }[];
  remap: { from: string; to: string }[];
  exclude: string[]; includeBackups: boolean;
  batch: { filesPerProject: number; projectsPerWave: number };
  schedule: { everyMinutes: number };
  /** maxUnattendedImports: optional in config.json (default 200); `sync` imports nothing when more are pending. */
  sync: { autoMerge: boolean; watchDebounceMs: number; maxUnattendedImports?: number };
  /** Optional in config.json. convertCompressed (default true): convert Codex's compressed rollouts into Claude threads. */
  codex?: { convertCompressed?: boolean };
  /** Optional in config.json. Language of the guided assistant (`t3sm start`) only; default "en". */
  language?: "en" | "pt";
}
