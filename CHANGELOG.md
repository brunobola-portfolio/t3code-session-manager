# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`t3sm update`**: updates an npm-installed t3sm to the newest release in one command. It asks first, waits while
  another t3sm run is in progress, runs `npm install -g github:<repository>#semver:*` (npm fetches the release; t3sm
  itself contacts nothing and never checks for updates on its own), prints the old and new versions, and says when
  the background sync needs `t3sm schedule install` again. In a git checkout or from npx it only explains how to
  update. `--dry-run` prints the npm command. Coming from 0.1.0, which has no `update`: run the install line from the
  README once; from then on `t3sm update` is enough.

### Changed

- **`t3sm --help`** groups the commands by what you want to do (start, import, accounts and projects, keep in sync,
  clean up and undo, maintenance) with one short line each; every command's own `--help` keeps the full options.
- **Docs**: the quick start is now "install once, then run `t3sm`", the same on Windows, macOS and Linux; the step-by-step
  commands use the short `t3sm` form, and `npx` stays as the no-install alternative.

## [0.1.0] - 2026-11-12

First public release.

### Added

- **`t3sm doctor`**: checks Node, the state folder, `config.json`, the lock, interrupted runs, the shell's
  `CLAUDE_CONFIG_DIR`, T3 Code (running, version, CLI, a read-only session), its Claude instances and the account each
  is signed in to (emails masked), whether T3 Code's default instance has an explicit home, undiscovered accounts,
  backup and quarantine folders, transcripts left with a future file time, each agent and the background sync.
  `--repair` restores file times left by an interrupted run.
- **`t3sm scan`** and **`t3sm plan`**: inventory of Claude Code, Codex, Pi and OpenCode sessions, and an import plan
  with a readable `plan.md` (summary, accounts, projects to create, the Project accounts table, duplicates across
  accounts, warnings, every skip with its reason, residual limits). Besides the report, only `config.json` (on the
  first run) and a discovery cache are written, all in t3sm's own folder.
- **`t3sm apply`**: creates missing instances and projects, sets per-project default accounts, converts OpenCode
  sessions, and imports through T3 Code's own importer in waves, beyond its 30-day window and 100-per-call limit.
  File times are journaled before they move, parked transcripts go 7 days into the future, a wave stops when the
  clock jumps (sleep), a locked file holds only its project, everything is restored after each wave and after a
  crash. T3 Code's default Claude instance is pinned to `~/.claude` when its settings name no folder. `--only <folder>` for a pilot; `--dry-run` runs every check and prints
  what would be done, writing nothing.
- **Accounts**: discovery from `~/.claude*` folders, shell aliases and functions (PowerShell, bash, zsh, fish), VS Code
  pins, the current shell and T3 Code instances; ownership by account folder, duplicates resolved by content,
  project defaults by route, VS Code pin, recent activity or default. `t3sm accounts` (emails masked,
  `--show-emails`; `--init`, `--apply`, `--rename`). In `config.json` only `version`, `accounts` and `defaultAccount`
  are required; every other key has a default.
- **`t3sm dedupe`** and **`t3sm quarantine`**: move mirror copies and `.bak` folders to a reversible quarantine with
  hard links (never copy-and-delete, never over an existing file).
- **`t3sm sync`**, **`sync --watch`** and **`t3sm schedule`**: unattended, cautious incremental imports (never more
  than 200 sessions per cycle by default) from Task Scheduler, a LaunchAgent or cron, or a watcher started at logon.
- **`t3sm merge`**: brings work continued in a terminal into T3 Code as a new thread from a new session file and
  archives the old thread, on positive evidence only; compacted sessions are skipped, and terminal work on a side
  branch is listed, never merged. `sync` reports both; merging in `sync` is off by default (`sync.autoMerge`).
- **`t3sm runs`** and **`t3sm rollback`**: undo a run (converted files, merges, quarantines, project defaults;
  imported threads listed or archived with `--archive-threads`); `--yes` requires `--run <id>`. A rollback never leaves a session without an
  active thread.
- **OpenCode** conversion (tested with 1.19.5), reading a stripped private copy of its database.
- A **Claude Code skill** (`t3code-sessions`) and plugin marketplace that run t3sm and ask before every write.
- Docs: switching guide from VS Code (English and Portuguese), migration guides per source, configuration
  reference, accounts, architecture, troubleshooting per doctor check, adding a harness.
- **`t3sm start`**: a guided assistant for people who would rather not learn the commands (also plain `t3sm` on a
  terminal). Nine short steps (check, accounts with optional names and colours, plan and the project-to-account table
  with a way to change a project's account, clean-up, a pilot import of one project with an offer to undo it, the
  full import, background sync, a summary with run ids). It only runs t3sm's own commands, asks before every write
  (Enter means no), and `?`, `b` and `q` work at every question. Each write question says how to undo that change,
  and every exit after a write lists what was done, with run ids and how to undo each. A step whose command found
  another t3sm run holding the lock (a background sync) is reported as not done, never with the other run's id. It
  resumes where you stopped (a partial or interrupted full import, a pilot still to check, a clean-up half done),
  worked out from the journal, plan, config and scheduler. English by default; Portuguese with `--lang pt`, `T3SM_LANG=pt` or
  `"language": "pt"` in `config.json` (new optional key). Only the assistant is translated. Not on a terminal it
  prints the quick start. At any confirmation prompt, Ctrl+C or closed input now answers "no" instead of ending with
  an error. Every message now spells "T3 Code" the same way.
- **`t3sm projects`**: every project folder with its account, the reason (route, VS Code pin, recent activity,
  default), the sessions waiting, whether it is in T3 Code and whether a session is in use; with T3 Code closed it
  shows what the machine knows and says so. `projects set "<folder>" <account>` writes an exact-folder route (in place,
  or right before the first wildcard route matching the folder, so no other folder's account changes) and, when the folder is already a T3 Code project, sets its default account there
  (journaled, undone by `t3sm rollback --run <id>`); `projects unset "<folder>"` removes the route. The folder always
  ends on the account asked for (a route of its own in another spelling, or shadowed by an earlier wildcard, is
  rewritten and moved); a folder whose name contains `*` or `?` is refused.
- **Codex compressed sessions**: rollouts Codex CLI 0.167+ compressed to `rollout-*.jsonl.zst`, which T3 Code cannot
  read, are decompressed in memory (Node's built-in zstd; Codex's files are never changed), converted with the same
  message rules as T3 Code's Codex importer (tool calls as one-line summaries, reasoning left out) and imported as
  Claude threads in the project's account. A session T3 Code already holds as a Codex thread stays that one thread
  once Codex compresses it (and a converted one is not imported again as a Codex thread). Sessions over 512 MiB
  decompressed, or with a line over 64 MiB, are skipped (`too-large`); every zstd frame is decoded and must be complete,
  so corrupt or cut-short files are read errors, never partial conversions. A second file of the same session is listed
  as `duplicate` (a plain `.jsonl` wins; among compressed copies the parent rollout). `config.json`
  `codex.convertCompressed` (default `true`) turns it off. `plan.md` says how many are converted; `doctor`
  (`harness:codex`) counts sessions importable natively, convertible, skipped, read errors and already in T3 Code.
  Verified with fixtures, read-only discovery of 108 real compressed files and one synthetic compressed session
  converted and imported live.

### Known limits

- T3 Code shows at most 200 visible messages per imported thread, without tool activity, with the import time as the
  last activity.
- Compressed Codex sessions and OpenCode sessions are converted, so they continue as Claude threads, not in their
  original agent. Plain (uncompressed) Codex imports and Pi imports were not run live.
- Tested live: T3 Code `0.1.9-nightly.20261110` and `0.1.9-nightly.20261111` on Windows 11. `0.1.8` is supported from
  reading its source; stable releases are not tested yet. macOS and Linux are covered by unit tests in CI only.
- No full-size `apply` has been timed yet; first-run figures will be added here after the pilot.
- Roadmap: the largest modules (merge, rollback, apply, doctor, importer, the OpenCode adapter, sync) are to be split
  after 0.1.0; journal compaction; OneDrive conflict-copy handling.
