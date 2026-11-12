# Harnesses

Which coding agents t3sm reads, how, and how far each one was verified. Native harnesses (Claude Code, Codex, Pi)
are imported by T3 Code itself; t3sm only plans and paces those imports. Convert-mode harnesses are read by t3sm and
written as Claude Code transcripts (`src/apply/claudeWriter.ts`, record format from [spike S3](spikes/S3-conversion.md)),
then imported as Claude threads.

## At a glance

| | Agent | Mode | Tested version | What was verified | Notes |
| :-: | :-- | :-- | :-- | :-- | :-- |
| ✅ | **Claude Code** | native | 2.1.322 | **Live**, Windows 11: two accounts (`~/.claude` and a second folder) discovered, planned and checked by `doctor` on a real machine (about 5,300 sessions); import, merge and rollback run against the real T3 Code on synthetic sessions (`test/e2e/*.live.test.ts`) | One T3 Code instance per account |
| ✅ | **OpenCode** | convert | 1.19.5 | **Live**: conversion, import into T3 Code and `claude --resume` of the converted session, on a synthetic session; discovery of a real database read-only (15 sessions, all readable) | Read from a stripped private copy, never the live database |
| 🟡 | **Codex CLI** | native, and convert for compressed sessions | rollout files of a Codex build from 2026-11 (compressed by Codex CLI 0.167+) | **Fixtures** for every case; read-only discovery on real files (4 uncompressed sessions earlier; 108 compressed files, 107 sessions, all readable); **live** conversion and import of one synthetic compressed session; no live native import | Codex CLI 0.167 and later compress older sessions to `rollout-*.jsonl.zst`, which T3 Code cannot read: t3sm converts them into Claude threads in the project's account, like OpenCode |
| 🟡 | **Pi** | native | session files of a Pi build from 2026-11 | **Fixtures** for every case; discovery on real files (8 sessions); no live import | Imported only when T3 Code has an enabled Pi instance; otherwise skipped as `harness-unavailable` and `doctor` warns |
| ⏳ | Gemini CLI, Cursor, Copilot CLI, Cline, Crush, goose, Amp, Grok Build, Qwen Code, Kilo, Antigravity | convert | | **Planned** | [Adding a harness](adding-a-harness.md) |

✅ verified live: run against the real agent data and the real T3 Code on a real machine (synthetic sessions where
something was written). 🟡 verified with fixtures, plus read-only discovery on real files. ⏳ planned: not
implemented. Only Windows 11 was used live; macOS and Linux run the unit tests in CI.

T3 Code versions: tested live with `0.1.9-nightly.20261110` and `0.1.9-nightly.20261111` on Windows 11; `0.1.8`
(`0.1.8-nightly.20261105`) is supported from reading its source, not run live; stable releases are not tested yet.
`src/t3/compat.ts` lists the builds t3sm accepts without a notice. Another build of a listed minor version runs with a
one-line notice; any other version stops with exit code 4 unless you pass `--allow-untested`. macOS and Linux are
covered by unit tests in CI only.

## Claude Code (native)

- **Storage:** `<account home>/projects/<encoded cwd>/<session uuid>.jsonl`, one folder per working directory. The
  account home is `~/.claude`, or whatever `CLAUDE_CONFIG_DIR` points at (`~/.claude-work`, …). Sub-agent transcripts
  live in `<session uuid>/subagents/` and are shown inside their parent session.
- **Accounts:** every account home becomes a T3 Code instance (`claudeAgent` stays the one for `~/.claude`, pinned to
  that folder). How homes are found and who owns a session: [accounts.md](accounts.md).
- **What T3 Code imports:** sessions whose id is a UUID, with a `cwd` in the first 1 MiB / 1000 records, at most 32 MiB
  of history read per file (larger files are flagged) and nothing over 4 GiB. Hidden records (`isSidechain`, `isMeta`,
  `isCompactSummary`) are not shown. Measured in [spike S2](spikes/S2-import.md).
- **Skipped and why:** non-UUID ids, transcripts with only hidden records, sub-agents, files written in the last
  10 minutes (`active`), copies in `.bak` folders (unless `includeBackups`), mirror copies of a session kept in another
  account, folders that no longer exist (`cwd-missing`; see `remap`). Every reason is listed in `plan.md`.
- **Merge:** terminal work after an import comes back with `t3sm merge` ([architecture.md](architecture.md#merge-revisions)).

## Codex CLI (native)

- **Storage:** `$CODEX_HOME/sessions/<year>/<month>/<day>/rollout-*.jsonl` (default `~/.codex`), the files T3 Code's
  own scanner reads. The session id comes from the first `session_meta` record, the `cwd` from the first record
  carrying one.
- **Imported by:** T3 Code's Codex importer, into its Codex instance. Without an enabled Codex instance the sessions
  are skipped (`harness-unavailable`).
- **Skipped:** sub-agent rollouts, rollouts with no session id, no `cwd` or only hidden records.
- **Compressed sessions (convert mode):** Codex CLI 0.167 and later compress older rollouts to
  `rollout-*.jsonl.zst`. T3 Code's own scanner reads only `rollout-*.jsonl`, and t3sm never writes into `~/.codex`, so
  t3sm converts them like OpenCode sessions: it decompresses each file while streaming it (Node's built-in zstd; the
  file is never changed and never decompressed to disk), applies the same message rules as T3 Code's Codex importer,
  writes a Claude Code transcript into the account of the session's project and imports it as a **Claude thread**
  (`import:<instance>:<uuidV5("codex:<id>")>`).
  - **What "continues as a Claude thread" means:** the converted thread runs on the project's Claude account. Replying
    to it in T3 Code (or `claude --resume <uuid>`) continues it in Claude Code, with the Codex conversation as its
    history; the Codex session itself is left as it is, and work done later in Codex does not flow into that thread.
  - **One session, one thread:** a session T3 Code already holds as a Codex thread (imported while it was a plain
    `.jsonl`, or started inside T3 Code) stays that thread after Codex compresses it: it is skipped as `already-in-t3`
    (note `in-t3-as-other-form`), never converted into a second, Claude thread. The same holds the other way round: a
    session converted earlier and seen later as a plain `.jsonl` is not imported again as a Codex thread. `plan.md`
    lists each one ("already in T3 Code as a Codex thread" / "as a converted Claude thread").
  - What is kept: user and assistant messages, chosen exactly as T3 Code would (its `turn_id` rule for duplicated user
    messages); tool calls as `[tool <name>] <input> → <output>`, at most 500 characters after the name. Reasoning and
    every other record are left out. The same code reads plain and compressed rollouts.
  - Discovery reads each compressed file once and caches the result (path, size and time); a sub-agent rollout stops
    at its first record. A file larger than 512 MiB once decompressed, or with a single line over 64 MiB, is skipped
    (`too-large`). Every frame of a file is decoded (a file written in several zstd frames included) and must be
    complete: a frame or block that runs past the end of the file, a frame that decodes to less than its declared size,
    or (when no size is declared) a file that does not end with a complete line is reported as a read error (`scan`
    counts it) and skipped, never a crash and never a partial conversion.
  - **Duplicate files:** one file is planned per session id and every other copy is listed, skipped as `duplicate`
    ("a second rollout file for the same Codex session (for example a sub-agent copy)"), counted by `scan`, `plan` and
    `doctor`. A plain `.jsonl` always wins over a `.jsonl.zst` of the same session. Among compressed copies (Codex writes
    `rollout-<time>-<id>_<child>.jsonl.zst` files that carry the parent's id): a usable copy (not a sub-agent, not too
    large, with a working folder) first, then the parent rollout (the one whose file name carries the id), then the
    path; activity never decides, so the choice is the same on every run.
  - `config.json` `"codex": { "convertCompressed": false }` turns this off: compressed files are then listed without
    being opened and skipped (`compressed`).
  - `plan.md` and the terminal summary say e.g. "107 Codex sessions were compressed by Codex; they are converted and
    continue as Claude threads." `doctor` reports e.g. `codex-cli 0.167.1 · 4 importable natively, 107 convertible
    (compressed), 1 skipped; 30 already in T3 Code` (the last part when T3 Code is reachable; files that cannot be
    read are reported as read errors, with a warning).
  - Verified: fixtures for every case above, read-only discovery of 108 real compressed files (107 sessions plus one
    duplicate file, none unreadable), and one synthetic compressed session converted and imported into a live T3 Code
    (`test/e2e/convert.live.test.ts`).

## Pi (native)

- **Storage:** `PI_CODING_AGENT_SESSION_DIR`, else `<PI_CODING_AGENT_DIR>/sessions`, else `~/.pi/agent/sessions`; one
  folder per working directory (or flat files in a custom directory), as T3 Code resolves it.
- **Imported by:** T3 Code's Pi importer, only when T3 Code has an enabled Pi instance (`doctor` warns otherwise:
  enable Pi in T3 Code's settings, Providers, then run `t3sm plan` again).

## OpenCode (convert mode)

- **Tested with:** OpenCode `1.19.5` (`opencode --version`), Windows 11, 2026-11-11. Schema recorded from a read-only
  copy of the installed database.
- **Storage:** one SQLite database, `$XDG_DATA_HOME/opencode/opencode.db`, default `~/.local/share/opencode/opencode.db`.
  OpenCode uses the same `~/.local/share` path on Windows (`C:\Users\<user>\.local\share\opencode\opencode.db`). The
  database runs in WAL mode (`opencode.db-wal`, `opencode.db-shm` next to it).
- **Adapter:** `src/sources/opencode.ts` (`opencodeAdapter`, `mode: "convert"`).

### How t3sm reads it (never the live file)

t3sm never opens `opencode.db`, not even read-only: a read-only SQLite connection to a WAL database still writes the
shared-memory index (`-shm`), and it fails when `-wal`/`-shm` cannot be created. Instead:

1. `opencode.db` and `opencode.db-wal` are stream-copied into `~/.t3code-session-manager/cache/opencode/tmp/`, each
   into a new file created exclusively with mode 0600 (the folders are 0700). If the source changes while it is
   copied, the copy is discarded and taken again (3 attempts; then the affected sessions are **deferred** to the next
   run, reason `source-busy`, not failed).
2. The raw copy is opened (its WAL replays), its schema is checked, and a **fresh** database is built next to it with
   `CREATE TABLE … AS SELECT` of only the columns listed below. Nothing else of OpenCode's database reaches the kept
   file: no `account` / `credential` tokens, no `share_url`, `permission` or `metadata`. Foreign keys are off (node:sqlite
   enables them by default; nothing may cascade).
3. The raw copy and its `-wal`/`-shm`/`-journal` are deleted in a `finally`; the fresh file is published without
   clobbering (hard link + unlink) as `cache/opencode/opencode-s2-<source identity>.db` (`s2`: the snapshot format;
   files of an older format are deleted on entry) and opened with `new DatabaseSync(copy, { readOnly: true })`. It
   carries one index per query the adapter runs (session id; session creation order; messages by session; parts by
   message and by session), so discovery never scans `part` per message. It is reused until the source's size/mtime
   (db and WAL) change; each reuse touches it, and other snapshots are removed once unused for 5 minutes.
4. `cache/opencode/tmp/` is swept on every snapshot: anything older than 5 minutes or left by a process that is gone
   is removed, so a crash never leaves a raw copy behind for long.

Read-only commands (`sync --dry-run`, `doctor`) use one OS temp folder per process (`t3sm-opencode-<pid>-…`), removed
after discovery or at exit; stale ones are swept the same way. Within one run, discovery **pins** its snapshot and every
`read()` uses that same snapshot (one consistent state per run); `apply`, which reads `plan.json` instead of
discovering, pins the snapshot its first `read()` takes; a reader whose pinned snapshot vanished re-pins once. A
session whose `time_updated`, as of that pinned snapshot, is within the last 10 minutes is deferred (`active`).

### Tables and columns used

| table | columns read | meaning |
|---|---|---|
| `session` | `id` | session id (`ses_…`): the `nativeId` |
| | `parent_id` | set on child sessions (subagents): flagged `subagent`, skipped |
| | `directory` | working directory (OpenCode writes forward slashes on Windows, `C:/…`): the `cwd` |
| | `title` | session title |
| | `time_created`, `time_updated` | ms since epoch: `startedAt`, `updatedAt` (activity, `active` flag) |
| `message` | `id`, `session_id`, `time_created` | one row per user or assistant message; order = `time_created, id` |
| | `data` | JSON; `$.role` = `user` / `assistant` |
| `part` | `id`, `message_id`, `session_id` | the message's content parts; order = `id` |
| | `data` | JSON; `$.type` selects the rendering below |

Other columns and tables (`project`, `workspace`, `session_message`, `session_input`, `event`, `todo`, `permission`,
`account`, `credential`, …) are not read. If `session`, `message` or `part` (or a column above) is missing, the adapter
raises `HarnessSchemaError`: `isAvailable` is false (doctor: no OpenCode sessions), `discover` records the error and
yields nothing, and nothing is converted.

The full 1.19.5 DDL of these tables is in `test/fixtures/opencode/build.ts` (the test fixture is built from it at test
time; no database is committed).

### Part rendering (`read()`)

| part `type` | becomes |
|---|---|
| `text` | its `text`; parts with `synthetic: true` (content OpenCode injects, such as file contents) or `ignored: true` are dropped |
| `tool` | `[tool <tool>] <input> → <output>`, the part after the tool name clipped to 500 characters (`…` appended). `<input>` is the only string argument when there is one (`ls -la`), else compact JSON. `<output>`: `state.output` when completed, `error: <state.error>` on error, `(<status>)` otherwise |
| `file` | `[attachment: <filename>]` (else the URL's last segment, else the MIME type); the file content is not copied |
| `subtask` | `[subtask <agent>] <description>` (clipped to 500) |
| `reasoning`, `step-start`, `step-finish`, `snapshot`, `patch`, `compaction`, `retry`, `agent`, unknown | dropped |

Parts of one message are joined with a blank line. A message with nothing left after this (a reasoning-only step) is
dropped rather than written as an empty bubble. Consecutive messages of the same role (OpenCode writes one assistant
message per step) are merged into one record by the Claude writer.

### Discovery

- One `DiscoveredSession` per OpenCode session that has at least one message (sessions opened and abandoned are not
  listed). `messageCount` = its user + assistant messages.
- Flags: `subagent` (has `parent_id`), `no-cwd` (empty `directory`), `only-hidden` (no user message with real text),
  `active` (`time_updated` within the last 10 minutes).
- `file` is the database itself (path, size, mtime): **every OpenCode session shares one source file**, whose size and
  mtime change when any session changes. So per-session activity comes from `time_updated`, and `continued-outside-t3`
  for an already imported OpenCode session compares its `updatedAt` / `messageCount` with the values journaled in the
  conversion's `file-written` entry, not the file size.
- `cwdOffsetBytes` is 0: the converted transcript carries `cwd` on its first record.

### Unknown part types

Part types not in the table above are counted during discovery and reported once (scan / plan read errors:
`opencode: N part(s) of unknown type (…) are left out of conversions`). A new OpenCode part type therefore shows up
as a warning, never as a crash or a silently half-converted session.

### Conversion target

`<account home>/projects/<encoded project root>/<uuid>.jsonl`, `uuid = uuidV5("opencode:<session id>")`, account = the
project's account. The file's mtime is set to the session's `updatedAt`, then it goes through the same import waves as
any Claude transcript. t3sm never overwrites a file there that it did not write, nor one it wrote that was resumed
since; `t3sm rollback` deletes converted files only while their sha256 is unchanged.

## Adding a convert harness

The full guide, with the `SourceAdapter` interface, fixture rules and a worked example, is
[adding-a-harness.md](adding-a-harness.md). The short checklist for the next converter (OpenCode is the reference
implementation):

1. **Adapter** `src/sources/<harness>.ts` with `mode: "convert"`, registered in `allAdapters()`
   (`src/sources/registry.ts`). Planner and apply decide convert vs native per session through
   `isConvertSession(s)`: the session's own `mode` when it has one (Codex compressed rollouts carry `mode: "convert"`
   from a native adapter that also has `read()`), else `isConvertHarness(id)`. Add the id to `HarnessId` in
   `src/core/types.ts`. Tool calls are flattened with `src/sources/flatten.ts`.
2. **Never write the source.** If it cannot be read without side effects (SQLite in WAL mode, lock files), read a
   private copy that keeps only what you read, owner-only, cleaned in `finally` and swept on entry.
3. **`discover`**: one `DiscoveredSession` per conversation with `cwd`, `startedAt`/`updatedAt` (per-session activity),
   `messageCount` (the same measure `read()` reports), flags `subagent` / `no-cwd` / `only-hidden` / `active`; problems
   go to `lastErrors`, never thrown. Sessions with nothing to convert are not listed.
4. **`read`** honours the contract documented on `SourceAdapter.read` (`src/sources/types.ts`): conversation order,
   roles `user` | `assistant`, ISO-8601 timestamps, tools flattened `[tool <name>] <input> → <output>` (≤ 500 chars),
   attachments `[attachment: <name>]`, reasoning dropped, `activity` filled, `HarnessSchemaError` on drift,
   `SourceBusyError` / `SessionActiveError` to defer.
5. **`availability`** (`absent` / `ok` / `{drift}` / `{unreadable}`) so `doctor` can warn; read-only envs leave no
   persistent state.
6. **Record the schema** you read here (storage path, tables/fields, tested version) and build the test fixture from it
   at test time (synthetic rows only, no binary committed).
7. **Tests**: discovery flags, `read()` rendering (tool flattening, attachments, accents), schema drift, a busy source,
   an active session, never writing the source (byte-identical before/after), and no secret from the source in t3sm's
   cache (byte-level markers).
