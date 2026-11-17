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
  /** `automated`: started by the Agent SDK (Claude entrypoint `sdk-*`). Absent (other harnesses) = human. */
  origin?: "human" | "automated";
  /**
   * Claude only: `t3` when the first record carrying an `entrypoint` has "t3-code" (T3 Code started the session),
   * `elsewhere` for any other entrypoint. Absent when no record has one, and for other harnesses.
   */
  startedIn?: "t3" | "elsewhere";
  /** Claude only: the T3 thread id from the `Thread: <uuid>` handoff message T3 writes into sessions it starts. */
  t3ThreadId?: string;
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
  | "revision"
  // organize categories (spec §4.1-§4.4): an Agent SDK session, a temp or system folder, a folder T3 Code refuses that
  // t3sm does not move elsewhere, and a category whose question (`organize.decided`) was never answered.
  | "automated" | "temp-folder" | "system-folder" | "t3-refused" | "undecided"
  // A session started in T3 Code whose T3 thread was deleted (T3 Code will not import it again), kept out because
  // `organize.sessions.orphaned` is "skip"; and one started in T3 Code whose thread id is unknown (never copied).
  | "orphaned-in-t3" | "t3-native-unknown";
export type Action =
  | { kind: "import"; projectRoot: string; instanceId: string; expectedThreadId: string }
  | { kind: "convert-import"; projectRoot: string; instanceId: string; expectedThreadId: string; uuid: string; targetFile: string;
    /** "faithful": a Claude transcript copied record by record (only `cwd` and `sessionId` change), not converted. */
    copy?: "faithful";
    /** A rehomed session (spec §4.3): its own folder, which T3 Code refuses; `projectRoot` is where the copy goes. */
    rehomeFrom?: string;
    /** Set when `projectRoot` was inferred from the transcript (spec 4.3): hits of total absolute paths in that root. */
    rehomeShare?: { hits: number; total: number } }
  | { kind: "skip"; reason: SkipReason };
export type PlanNote = "duplicate-in-window" | "diverged-fork" | "truncated-over-32mib" | "continued-outside-t3" | "remapped-cwd"
  // A conversation copied from a folder T3 Code refuses (spec §4.3) that changed after the copy was imported (its
  // original, or the copy resumed outside T3 Code): the copy in T3 stays as it is and `t3sm merge` does not apply (R11).
  | "continued-after-rehome"
  | "label-only-in-mirror"
  // T3 already holds this session under another instance (account): skipped as already-in-t3, never a second copy.
  | "in-t3-under-other-account"
  // T3 already holds this session in its other form (Codex: a Codex thread, or a converted Claude thread): one session,
  // never a second thread.
  | "in-t3-as-other-form"
  // Started in T3 Code and its thread is still there (active or archived, any instance): nothing to import.
  | "started-in-t3"
  // Started in T3 Code with no thread id in it, and brought back by `t3sm recover`: its copy's thread is in T3 Code.
  | "recovered";
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
  /**
   * Questions (`organize.decided` keys) not answered yet, with the sessions skipped `undecided` for each and their
   * distinct folders. Absent when nothing is pending. `t3sm start` asks them.
   */
  decisionsPending?: { key: string; sessions: number; folders: number }[];
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
    revisionOf?: { harness: HarnessId; nativeId: string };
    /**
     * A faithful copy (spec §4.3) of the Claude transcript at `path` (session `nativeId`, folder `cwd`, which T3 Code
     * refuses). size / mtimeMs: that file as copied (the planner's baseline for "continued outside T3").
     */
    rehomeOf?: { path: string; nativeId: string; cwd: string; size: number; mtimeMs: number } }
  // A `file-written` whose file was never published (the target appeared meanwhile, or a refresh was skipped at the
  // last moment): cancels the latest `file-written` of the same run and path (journal.effectiveWrites).
  | { t: "file-write-aborted"; runId: string; path: string }
  | { t: "instance-created"; runId: string; instanceId: string; homePath: string | null }
  // A missing destination folder of rehome copies (the General folder, a `rehome:<folder>` override) that an
  // interactive apply created, journaled right after it was made: `path` the folder, `created` the topmost folder that
  // did not exist (path itself or an ancestor). Rollback removes them, deepest first, only while they are empty.
  | { t: "folder-created"; runId: string; path: string; created: string }
  // title: the title t3sm gave it (absent in older entries; `projects rename --suggest` then compares with the
  // folder's last segment, the title t3sm used to give).
  | { t: "project-created"; runId: string; projectId: string; root: string; title?: string }
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
  // A rehome copy that followed its original (src/ops/follow.ts, spec §5.1.4): `original` the transcript that grew,
  // `copy` the file this follow wrote (revision: the new revision file; refresh: the copy rewritten in place),
  // `oldThread` the copy's thread, `newThread` the revision's thread (null in refresh mode: the same thread grows).
  | { t: "followed"; runId: string; original: string; copy: string; oldThread: string; newThread: string | null; mode: "refresh" | "revision" }
  | { t: "thread-archived"; runId: string; threadId: string }
  | { t: "thread-unarchived"; runId: string; threadId: string }
  // One change t3sm organize made in T3 Code, journaled with the value before and after (src/organize/types.ts
  // documents previous/next per kind). A later organize compares the current state with `next`: a difference means
  // the user changed it since, and t3sm never acts on that target (that kind) again.
  | { t: "organize-change"; runId: string; kind: OrganizeKind; target: string; previous: unknown; next: unknown }
  // One organize change that failed (T3 refused it, could not be read, ...): the reason survives the run. error: redacted,
  // one line, at most 200 characters. projectId: the project the target belongs to (null for auto-settle). kind
  // "organize": a sync cycle's whole organize step failed (target "history" for the daily pass, else "*"; projectId null).
  | { t: "organize-failed"; runId: string; kind: OrganizeKind | "organize"; target: string; projectId: string | null; error: string }
  // One organize change put back by an undo (`t3sm organize --undo` / `t3sm rollback`); `runId` is the undo's own run.
  // previous: the value t3sm had set (the change's `next`); next: the value restored (the change's `previous`). Never an
  // organize-change, so the planner's user-touched rule keeps an undone target out of later plans (ruling R14).
  | { t: "organize-undone"; runId: string; targetRunId: string; kind: OrganizeKind; target: string; previous: unknown; next: unknown }
  // Written once at the end of a rollback run that changed something; `runId` is the rollback's own run.
  | { t: "rolled-back"; runId: string; targetRunId: string; at: string }
  // held: the projects the run left for later because a conversation of theirs was in use (apply; absent when none).
  | { t: "run-end"; runId: string; at: string; status: "ok" | "partial" | "aborted"; held?: number }
  // One t3sm update (src/ops/updater.ts runUpdate): "pending" before anything is installed, then the outcome in a
  // second entry of the same run. error: one line, why it failed or was rolled back.
  | { t: "update"; runId: string; from: string; to: string; source: UpdateSource; outcome: "pending" | "installed" | "rolled-back" | "failed"; error?: string }
  // One `t3sm journal compact` (src/core/compact.ts), inside its own run (run-start "journal compact" ... run-end):
  // `runs` finished runs older than `olderThanDays` lost their `entries` mtime-bump / mtime-restore entries (nothing
  // else is ever dropped); the journal went from `bytesBefore` to `bytesAfter`; `backup` is the file name, next to
  // journal.jsonl, of the full journal as it was (never deleted by t3sm). Readers that do not know this kind skip it.
  | { t: "journal-compacted"; runId: string; at: string; olderThanDays: number; runs: number; entries: number; bytesBefore: number; bytesAfter: number; backup: string };
/** What `t3sm organize` changes in T3 Code (spec §5); re-exported by src/organize/types.ts. */
export type OrganizeKind = "archive" | "title" | "unsettle" | "settle" | "pin" | "unpin" | "project-delete" | "project-title" | "auto-settle";
export interface AccountConfig { id: string; home: string; displayName: string; accentColor: string | null }
/** Where a session's folder came from (spec §4): `project` is always imported as is. */
export type FolderCategory = "project" | "home" | "t3-refused" | "temp" | "system";
export type FolderAction = "import" | "skip" | "rehome";
/** The history rule: the last `days` days (1..3650, or "all") stay visible, and at least `minPerProject` (0..1000) per project. */
export interface HistoryRule { days: number | "all"; minPerProject: number }
/** What config.json may hold for `organize.history`: the rule, or a 0.2 string kept readable ("off" = no history rule). */
export type HistoryConfig = HistoryRule | "all" | "off" | `days:${number}`;
/** The `organize` settings of config.json, every field filled (see `organizeSettings`). */
export interface OrganizeConfig {
  folders: Record<Exclude<FolderCategory, "project">, FolderAction>;
  /** orphaned: a session started in T3 Code whose thread was deleted; "copy" brings it back as a copy with a new id. */
  sessions: { automated: "skip" | "import"; orphaned: "copy" | "skip" };
  /** Folder for sessions without a project; kept with `~` as written (expanded where used). */
  generalFolder: string;
  overrides: { match: string; action: "import" | "skip" | `rehome:${string}` }[];
  /** Project name length, 16..120. */
  names: { maxLength: number };
  /** Which history organize shows: a rule (days 1..3650 or "all", minimum per project 0..1000), or a legacy 0.2 string ("all", "off", "days:N"; read through `historyRule`). */
  history: HistoryConfig;
  titles: boolean;
  archiveAutomated: boolean;
  /** count: 1..20. */
  pinRecent: { enabled: boolean; count: number };
  /** Keys of the questions already asked (never asked again). */
  decided: string[];
}
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
  /** Optional in config.json; each field defaults on its own (`organizeSettings`), each `sessions` field too. */
  organize?: Partial<Omit<OrganizeConfig, "sessions">> & { sessions?: Partial<OrganizeConfig["sessions"]> };
  /** Optional in config.json. Which sync results raise a notification; default "attention". */
  notify?: "attention" | "all" | "off";
  /** Optional in config.json. auto (default true): the watcher installs newer patch and minor releases by itself. */
  update?: { auto?: boolean };
}
/**
 * Where t3sm updates come from (remembered in `<state>/update.json`): the npm registry's published versions, GitHub's
 * tags, or a local checkout's tags.
 */
export type UpdateSource = { kind: "npm"; name: string } | { kind: "github"; repo: string } | { kind: "folder"; path: string };
