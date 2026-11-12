# Architecture

t3sm is a command-line tool in TypeScript with no runtime dependencies. It runs beside T3 Code and talks to it only
through the surfaces T3 Code supports: its `t3` CLI (to get a session token), its WebSocket RPC API and a few HTTP
routes. It never opens T3 Code's database or edits its settings file. The facts below about T3 Code's importer were
read from its source and measured live in the spikes under [spikes/](spikes/).

## Why not a fork of T3 Code

T3 Code ships a nightly build every day and asks contributors to agree features with its maintainers first. A fork
would lose those updates and need daily maintenance. An external tool that uses the supported surfaces keeps working
across nightlies, and stops with a clear message (exit code 4) when a response no longer has the shape it expects,
before it writes anything.

## Pipeline

```
discover → plan → (review) → materialise → register → import in waves → verify → journal
```

1. **Discover** (`src/sources/`). One adapter per agent lists its sessions: id, folder, dates, message count, account,
   size and flags (`active`, `subagent`, `backup-copy`, …). Native adapters read exactly what T3 Code's scanner reads.
   Results are cached per file (size and time), so a second plan is fast.
2. **Plan** (`src/plan/`). For each session: the T3 Code project (one per existing folder), the instance (the account
   rules in [accounts.md](accounts.md)), and an action: `import`, `convert-import`, or `skip` with a reason. Copies of a
   session in two accounts are compared by content. The plan is written to `runs/<runId>/plan.json` and a readable
   `plan.md`. Besides those, only `config.json` (on the first run, from the discovered accounts) and the discovery
   cache are written, in the state folder; nothing outside it.
3. **Review.** You read `plan.md`; `apply --dry-run` runs every check against T3 Code (read-only) and prints what
   would be done. `apply` refuses a plan older than 24 hours or made against another T3 Code version (exit 2).
4. **Materialise** (`src/apply/materialize.ts`). Convert-mode sessions (OpenCode) are written as Claude Code
   transcripts in the project's account: `<account home>/projects/<encoded folder>/<uuid>.jsonl`, with a deterministic
   UUID v5 from the source id. A file t3sm did not write, or one resumed since, is never overwritten.
5. **Register** (`src/ops/accounts.ts`). T3 Code's default instance is pinned to `~/.claude` when its settings name no
   folder, missing instances are created with `server.updateSettings`, missing projects through T3 Code's API, and
   each new project's default instance is set. Each change is journaled with its previous value.
6. **Import in waves** (`src/apply/importer.ts`), described below.
7. **Verify.** After each wave the project's threads are listed; every planned session must have its thread
   `import:<instance>:<session id>`. A session T3 Code did not take is retried once in a later wave, then reported
   with a reason. If threads cannot be listed, no further wave starts.
8. **Journal** (`src/core/journal.ts`). `~/.t3code-session-manager/journal.jsonl`, append-only: the base of `sync`,
   `runs` and `rollback`.

## What T3 Code's importer does, and why waves

From [spike S2](spikes/S2-import.md): `agentSessions.import` takes a project, and imports the transcripts whose
recorded folder is that project's folder **and** whose file time is within the last 30 days, at most 100 per call. It
uses the list from the last `agentSessions.scan`, so a scan must run after file times change. It never appends
messages to a thread that already exists, and re-importing is idempotent.

So to import an old session, its file time must be inside the window for one scan and one import. And because the
import takes every eligible transcript of the project, from every account, anything else in the window would be
imported too.

### The file-time rule

For each wave (at most `batch.projectsPerWave` projects, at most 90 sessions of a project):

1. **Re-check.** Each file is stat'ed again. One that changed since planning, or was written in the last 10 minutes,
   is left alone this run. A file another program keeps locked (EBUSY, EPERM, EACCES) is retried after 100, 300 and
   1000 ms; still locked, it holds its project for the run (`file-busy`) and the other projects go on.
2. **Hold.** If any transcript of a wave's project is in use (written in the last 10 minutes), the whole project waits
   for the next run, because T3 Code would import it now.
3. **Journal, then bump.** The original access and modification times of every file about to move are appended to the
   journal **before** any change. Files of the wave move to just before now, in their original order.
4. **Park.** Every other transcript T3 Code could see for those projects (mirror and backup copies, excluded ones,
   sessions of later waves, files that appeared since planning) gets a file time **7 days in the future**. T3 Code
   skips future times (S2 §3), which was verified live with a synthetic file. T3 Code reads metadata newest first, so
   parked files are read before the bumped ones and spend the same 64 MiB per source: a wave whose bumped and parked
   cost would pass 56 MiB takes fewer projects (one project over it on its own goes alone, with a warning line).
5. **Scan, import, restore.** One scan, one import per project, then every bumped and parked file gets its original
   times back (in `finally`, also on errors and on Ctrl+C), and the restore is journaled. A file written during the
   wave is never moved backwards.
6. **Clock check.** T3 Code judges file times with its own clock when it imports. Before the scan and before each
   import call, t3sm reads the clock again: more than 30 minutes past the bump (the machine slept) or earlier than
   before (the clock was set back) stops the wave there. Its files are restored as usual and its projects not yet
   imported wait for the next wave or run. The 7-day lead covers a suspend during a single call.

**Why the future and not the past.** An earlier design parked files 31 days in the past. Claude Code deletes
transcripts by file age (its `cleanupPeriodDays`, 30 days by default), so a crash at the wrong moment could have left
a parked file old enough to be cleaned up for good. A future time cannot be selected by that cleanup. The cost: until
the times are restored, `claude --continue` may pick a parked session, because it looks newest.

### Journal and recovery

Every writing command first takes the lock, then restores any file time a previous run left moved (for example after
a crash or a power cut), and only then contacts T3 Code. This runs even while T3 Code is closed. The rules:

- the earliest original time recorded for a file wins, across runs;
- a file whose time is no longer the one t3sm set (you edited it since) is never moved back;
- a file that is gone is reported and marked done;
- `t3sm doctor` reports leftovers (`pending-mtimes`), and `t3sm doctor --repair` restores them; that is the only write
  `doctor` ever does.

A run interrupted with Ctrl+C restores the current wave and stops (a second Ctrl+C says so, a third restores at once
and exits 130). Run `t3sm apply` again to continue: what is already in T3 Code is skipped.

### The lock

`<state>/lock` holds one run at a time on a machine. A second run exits 0 without touching anything, so a scheduled
`sync` and a manual `apply` never overlap. A lock left by a process that is gone is taken over, and so is one whose
run started before the machine's last boot (its process cannot have survived the restart, even if Windows has since
given its pid to another program). The lock records the machine's uptime; a lower uptime now means a restart since,
whatever the wall clock did (a lock from an older t3sm, without it, is judged by its pid only). One from another
machine (shared state folder) is never taken over.

## Exposure, mirror copies and holds

The set of files T3 Code could import for a project, the **exposure**, is computed per wave from fresh listings of
every instance's folder, not from the plan: new files count too. That is why mirror copies are a warning, not a
refusal, for `apply`: they are parked while their project imports. `t3sm dedupe` is still recommended, because T3
Code's own Welcome import ignores t3sm and could pick a stale copy up later.

## Conversions

Convert-mode adapters implement `read()`, returning a canonical transcript (user and assistant text, tool calls
flattened to `[tool <name>] <input> → <output>`, attachments as names). The Claude writer turns it into records T3
Code and `claude --resume` both accept (spike [S3](spikes/S3-conversion.md)): a hidden provenance record first, then
the conversation, chained by `parentUuid`. The file's time is the session's last activity, but never in the future and
never older than 20 days, so a converted file never starts inside Claude Code's cleanup zone (30 days by default); the
chosen time is journaled. Merge revisions follow the same rule. The file then goes through the same waves. The OpenCode adapter never opens OpenCode's database: it copies it, keeps only the conversation tables
in a fresh file, and opens that read-only ([harnesses.md](harnesses.md#opencode-convert-mode)).

## Merge revisions

T3 Code continues an imported thread from the last message it knows. Turns added later in a terminal sit on a branch
it never sees (spike [S3](spikes/S3-conversion.md) §6). `t3sm merge` ([S5](spikes/S5-merge.md)):

1. **Finds candidates on positive evidence only:** a session t3sm imported whose file grew since, where a visible
   message after the imported size was written by another entrypoint than T3 Code (`entrypoint` other than
   `"t3-code"`). Records without an entrypoint prove nothing. Sessions idle for less than 10 minutes wait.
2. **Writes a revision:** a new file `<revision uuid>.jsonl` next to the original, with a provenance record and the
   branch `claude --resume` would continue, root to leaf. The UUID is derived from the session id and size, so a
   re-run produces the same file. The original is never edited.
3. **Imports it** through the same waves as a new thread, and only once that thread is listed, **archives the old
   thread** (`thread.archive`, reversible).
4. **Refuses** what it cannot copy whole: compacted sessions (`/compact` after the import), broken chains, corrupt
   lines inside the branch. Terminal work on a side branch (not the one `claude --resume` continues) is listed with
   a `claude --resume <id>` hint and never merged; `sync` and `doctor` report it too.

`t3sm rollback --run <id>` deletes an untouched revision, unarchives the old thread and archives the revision's
thread. A revision you continued since is kept. Rollback never leaves a session without an active thread. Threads of
plain imports are only archived when you ask (`--archive-threads`). `sync` only counts candidates unless
`sync.autoMerge` is `true`.

## Sync and the watcher

`t3sm sync` is one unattended cycle: fresh plan, apply without asking, under the same lock. It never creates
instances, never quarantines or dedupes, never overrides a default you set in T3 Code, holds sessions that have a
mirror copy in the window, waits for projects in use, does not retry a failed session until it changes, and refuses
to import more than `sync.maxUnattendedImports` sessions (default 200) in one cycle. With nothing to import it writes
nothing. Each cycle appends one line to `<state>/logs/sync.log`.

`t3sm sync --watch` watches the account folders and the other agents' storage, runs a cycle after changes settle
(`sync.watchDebounceMs`) and again once a changed session has been idle 10 minutes, plus every
`schedule.everyMinutes`. It waits while T3 Code is closed and writes a heartbeat to `<state>/sync-status.json`.
`t3sm schedule install` registers `sync --quiet` (or, with `--watch`, the watcher at logon) with Task Scheduler, a
LaunchAgent or a tagged crontab line, as the current user.

## Compatibility with T3 Code nightlies

`src/t3/compat.ts` lists the versions t3sm was tested against. Same minor version: proceed with a notice. Anything
else: exit 4 unless `--allow-untested`. Independently, every RPC response is decoded strictly (`src/t3/decode.ts`);
an unknown shape aborts with exit 4 before the first write.

## State folder

```
~/.t3code-session-manager/          (T3SM_HOME)
  config.json                       optional settings (configuration.md)
  journal.jsonl                     every change, append-only
  lock                              one run at a time
  runs/<runId>/plan.json, plan.md   each plan
  cache/                            discovery caches, merge verdicts, stripped OpenCode copies
  logs/sync.log                     one line per sync cycle (rotated at 1 MiB, 3 kept)
  sync-status.json                  watcher heartbeat
  schedule/                         the Windows task definition, when installed
```
