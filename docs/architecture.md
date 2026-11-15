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
   for the next run, because T3 Code would import it now. A project held from the start of the run is still created,
   empty, with its default instance (creating a project imports nothing: spike [S6](spikes/S6-organize.md)); `apply`
   and `sync` name the conversation that holds it, its title and how long ago it was written.
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

A Claude conversation from a folder T3 Code refuses (the home folder, `~/Documents/Codex`, ...) is not converted but
copied whole (`src/apply/copyTranscript.ts`): every line kept, only `cwd` and `sessionId` swapped into the target
project, plus a provenance record at the end (spike [S6](spikes/S6-organize.md)). It is written, journaled
(`file-written` with `rehomeOf`, the original as copied), refreshed, imported through the same waves and rolled back
exactly like a conversion; the original is only read, and waits while it is in use. Once T3 Code holds the copy, a
later change to the original (or work on the copy outside T3 Code) is noted `continued-after-rehome`. `sync` then lets
the copy follow its original (`src/ops/follow.ts`, whatever `sync.autoMerge` says): when the original grew, the copy
is untouched since t3sm wrote it and neither file was written in the last 10 minutes, the grown original is copied
again as a revision (`<revisionUuid(first copy id, original size)>.jsonl` in the same folder), imported as a new
thread that gets the old thread's title and settled state, and only then is the old thread archived, with the same
write, import and archive steps (and journal entries) as a merge, plus `followed`; at most `FOLLOWS_PER_CYCLE` (10) a
cycle. A copy that was itself continued is a conflict: nothing is written, `sync` reports it. A compacted original is
refused (`compacted`). `FOLLOW_MODE` (`src/t3/compat.ts`) can switch to rewriting the copy in place and importing it
again, if spike S7 shows T3 Code growing the same thread; it is `"revision"` until then.

## Folder categories and rehome copies

The planner (`src/plan/folders.ts`, `categories.ts`) classifies the folder of every session before it decides
anything: `project` (an ordinary folder, imported as before), `home`, `t3-refused` (Downloads, `Documents/Codex`,
T3 Code's own folders, the exact temp folder: T3 Code rejects them as projects, per version, in `src/t3/compat.ts`),
`temp`, `system` and `missing` (`cwd-missing`). Sessions are also `automated` (the first record's `entrypoint`
starts with `sdk-`) or `human`. The planner never plans a native import from a folder T3 Code refuses.

Each category has a decision in `config.json` (`organize.folders`, `organize.sessions`): `import`, `skip` or
`rehome`. Until a category is in `organize.decided` its sessions are skipped as `undecided`, and `t3sm start` asks.
The order is fixed: an `automated` session is decided by `organize.sessions.automated` alone (a folder override never
imports it), then `organize.overrides`, then the category. A `rehome` session goes to the project it worked in,
inferred from the paths in its tool calls (`src/plan/rehome.ts`: at least 60% of the paths and at least 5 hits, and
only a project that exists in T3 Code or in the plan), else to the General folder; the copy itself is described under
Conversions. The destination is read from the transcript only for a session that will be imported (a copy already in
T3 Code is never read again). A `rehome:<folder>` override must name an absolute folder T3 Code accepts
(`config.json` validation) and, in the plan, not a temp or system one either; otherwise its sessions are skipped with a
warning. When an interactive `t3sm apply` finds a destination folder missing on disk (the General folder, an override's
folder), it checks the folder's category, creates it before writing the copies and journals `folder-created`;
`rollback` removes such folders, deepest first, only while they are empty. A folder it cannot use or create fails only
its own sessions ("cannot create <folder>: <reason>"). `sync` never creates one (invariant 13).

## Sessions started in T3 Code

A Claude transcript whose **first** record carrying `entrypoint` says `t3-code` was started in T3 Code
(`startedIn: "t3"`); an imported session later continued in T3 Code has such records too, but not first, and stays an
ordinary session. The transcript names its T3 thread in T3 Code's handoff text (`Thread: <uuid>`). The planner
(`src/plan/planner.ts`) checks that id against T3 Code's active and archived threads of every instance:

- **thread still there**: skipped as `already-in-t3` with the note `started-in-t3`, and never given a file-time bump
  (it used to take slots in T3 Code's 100-per-call window);
- **no thread id in the transcript**: skipped as `t3-native-unknown` and never copied, so a live conversation is never
  duplicated;
- **thread deleted** (T3 Code still ties the session to it and refuses to import it again): orphaned. Until the
  `orphaned` question is answered it waits as `undecided`; with `organize.sessions.orphaned: "copy"` (the default answer)
  it is brought back as a faithful copy with a new session id, through the same copy path as a rehome copy (in its own
  folder, or the rehome target when T3 Code refuses that folder); with `"skip"` it is reported as `orphaned-in-t3`.

t3sm never opens T3 Code's database to decide this, not even to read. A copy t3sm wrote keeps the original's records
but is recognised as t3sm's own and never treated as one of these.

## Decisions are a gate

Questions about what to bring in (home folder, refused, temp and system folders, automated sessions, orphaned
sessions) are answered once and kept in `organize.decided`. Every plan lists the open ones (`decisionsPending`). In the
guided assistant they are a gate, not a step: whenever a step has a fresh plan with open questions, the assistant
goes to the Decisions step first ("N new questions before the import") and comes back. `apply` and `sync` never
import an undecided session; `sync` records the count per question (`undecided` in `sync-status.json`) and
`t3sm status` turns it into a "needs you" item with `t3sm start`.

## Organize flow

`t3sm organize` (`src/organize/`) is a separate pass over what is already in T3 Code, never part of `apply`:

1. **Read.** One snapshot of T3 Code (`GET` shell and projects) and the journal. Only threads whose id starts with
   `import:` and projects with a `project-created` journal entry are candidates; native T3 Code threads are never in
   the list. Pinning is the one change that may involve any project.
2. **Plan** (`plan.ts`, pure): one line per kind (archive automated, titles, history, pin, delete empty), each with
   a count, a reason and its undo. A thread or project whose state differs from what t3sm last set (a journal entry
   exists and T3 Code shows something else) is skipped for good: the user's choice wins. An empty project is never
   deleted when t3sm created it in the last 24 hours or its sessions still wait to import (the latest plan's imports
   not in T3 Code yet, or a project `sync-status.json` lists as held): `apply` creates a held root's project empty.
3. **Confirm.** Summary, then a question (`d` opens the review list; unchecked changes are dropped). `--dry-run`
   stops here and writes nothing.
4. **Apply** (`apply.ts`) through supported surfaces only: `orchestration.dispatchCommand` (archive, settle and
   unsettle with `reason: "user"`, titles), the project API (`POST /api/projects/mutate`) and `server.updateSettings`
   (`--auto-settle <1..90|off>`). A `run-start` entry goes in the journal before the first change and each change is journaled
   with what it replaced as soon as T3 Code accepts it; if the journal cannot be written the run stops. Before each
   change t3sm re-reads T3 Code and skips what no longer matches the plan. A command T3 Code refuses is counted and
   skipped. One run, under the lock.
5. **Undo.** `t3sm organize --undo [<run>]` and `t3sm rollback --run <run>` run the same code: they revert a change
   only where T3 Code still shows what t3sm set. A deleted empty project is re-created.

The history step (`src/organize/history.ts`) applies the per-project rule (spec §5.2). A thread's activity date is
T3 Code's own inactivity clock: the latest of `latestUserMessageAt`, `latestRunRequestedAt`, `latestRunStartedAt` and
`latestRunCompletedAt`, else `createdAt`; a date in the future counts as now. Every thread active in the last `days`
is shown (`thread.unsettle`); if the project then shows fewer than `minPerProject` (every shown thread counts: native,
pinned and rehome copies too), the most recent settled imported ones are shown until it does; every other imported
thread is settled (`thread.settle`). Only imported threads move, and a thread whose state differs from what t3sm last
journaled is the user's choice and is never moved again. Unsettles come before settles, both oldest activity first, so
the Settled shelf and the working shelf end up in history order. `--history` and `--min` override `organize.history`
for one run. T3 Code's `thread.settle` schema has an optional `settledAt` that would date the settle in the past;
`SETTLE_BACKDATE` in `src/t3/compat.ts` says whether t3sm sends it, and it stays `false` until the live spike S8
([S7-followup-and-backdate.md](spikes/S7-followup-and-backdate.md)) shows T3 Code honours it. Until then the oldest-first
order is what keeps the shelf in history order.

T3 Code's own auto-settle setting (`sidebarAutoSettleAfterDays`, 1..90 or off) covers the threads started in T3 Code.
It changes only with `--auto-settle <1..90|off>` (a journaled, reversible change); the guided assistant offers to set
it to the same days, or, when `days` is above 90 or `"all"`, to leave it or turn it off.

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

Conversations copied from a folder T3 Code refuses (`continued-after-rehome`, see Conversions) are never merge
candidates: `t3sm merge` lists them as skipped (`rehomed-copy`); `sync` follows them instead.

`t3sm rollback --run <id>` deletes an untouched revision, unarchives the old thread and archives the revision's
thread. A revision you continued since is kept. Rollback never leaves a session without an active thread. Threads of
plain imports are only archived when you ask (`--archive-threads`). `sync` only counts candidates unless
`sync.autoMerge` is `true`.

## Sync and the watcher

`t3sm sync` is one unattended cycle: fresh plan, apply without asking, under the same lock. It never creates
instances, never quarantines or dedupes, never overrides a default you set in T3 Code, holds sessions that have a
mirror copy in the window, waits for projects in use, does not retry a failed session until it changes, and refuses
to import more than `sync.maxUnattendedImports` sessions (default 200) in one cycle. With nothing to import it writes
nothing. Each cycle appends one line to `<state>/logs/sync.log` (counts only, never titles or paths).

What `sync` may do with the organize settings (safety invariant 13, approved on 2026-11-14) stays narrow, and it never
asks a question. Sessions of a category nobody has answered yet are not imported; they are counted per question and
`needsAttention` says so. A new project folder is created as before, with its clean name. After an import it archives and
retitles **only the threads that import just made**, and applies the history rule to every imported thread of the
projects that got new ones; once a day (24 h after `lastHistoryAt` in `sync-status.json`) it applies the rule to every
project, also on a cycle with nothing to import. At most 200 history changes per cycle (`HISTORY_PER_CYCLE`): the
first pass after an upgrade continues over the next cycles. All of it in the cycle's run and under the same lock, so
`t3sm rollback <run>` undoes the import and the organize changes together. It writes a copy of a conversation from a folder T3 Code refuses **only to a destination that
already exists in T3 Code**; it never creates the General folder or a project for such a copy (those sessions wait as
`rehome-target-missing` until `t3sm start` or `t3sm organize` creates it). It never pins or unpins a project, never
deletes a project and never changes a T3 Code setting. If T3 Code refuses an organize change the import stands, the
failure is counted and it is not retried in a loop.

`t3sm sync --watch` watches the account folders and the other agents' storage, runs a cycle after changes settle
(`sync.watchDebounceMs`) and again once a changed session has been idle 10 minutes, plus every
`schedule.everyMinutes`. It waits while T3 Code is closed and writes a heartbeat to `<state>/sync-status.json`. Every cycle, one-shot or watched,
also records there what needs a person: `needsAttention` (`undecided`, `over-limit`, `signed-out`, `t3-incompatible`,
`repeated-failures` or `update-failed`, with a short detail, the command that fixes it and `since`, the first time that
same reason was seen), `undecided` (sessions waiting per question) and `heldRehome`. After a cycle the watcher also
runs the daily update check (`src/ops/autoUpdate.ts`): a newer patch or minor release is installed by a separate
detached `t3sm update --auto-run --yes` (the update stops the watcher, so it never runs inside it), a major one is
only announced, and a failed or rolled-back update is kept as `updateFailure` (versions only) behind `update-failed`.
`t3sm schedule install` registers `sync --quiet` (or, with `--watch`, the watcher at logon) with Task Scheduler, a
LaunchAgent or a tagged crontab line, as the current user. With `--watch`, Task Scheduler and cron also start it every
15 minutes (a keep-alive: a second watcher finds the single-instance pipe taken and exits 0; launchd uses `KeepAlive`).
The heartbeat names the watcher's version, install stamp (`dist/build.json`'s `builtAt`, or `checkout:<package.json
mtime>` in a checkout) and install root. After every cycle the watcher reads the install's stamp again; a newer one,
once complete (`bin/t3sm.mjs`, and `dist/cli/main.js` for a package) and left alone for 30 s, ends the loop
(`stoppedAt`, `reason: "restart"`) and releases the pipe. On Windows and Linux the watcher then starts a successor from
the new install, detached and hidden; if the successor cannot take the pipe, the keep-alive or the next logon starts
one. On macOS it exits 75 instead, and launchd's `KeepAlive` starts the new install. A keep-alive run that finds a
watcher running exits 0 without output under `--quiet`.

### Watcher lifecycle

1. **Start.** The scheduler (logon trigger, the 15-minute keep-alive, launchd's `KeepAlive`), `t3sm schedule
   install --watch` / `restart`, or a predecessor starts `t3sm sync --watch --quiet`. It takes the single-instance
   endpoint (a named pipe on Windows, a Unix socket elsewhere) or, when another watcher holds it, exits 0. It writes a
   fresh random token to `<state>/watcher.token` (owner-only) and its heartbeat (`pid`, `startedAt`, `version`, `stamp`,
   `installRoot`, `protocol`, the socket) to `sync-status.json`.
2. **Cycles.** After changes settle, after a changed session goes idle, and every `schedule.everyMinutes`. After each
   cycle: the daily history pass and the daily update check (below), then a look at the install's stamp.
3. **Restart into a new install.** A different stamp, once the new install is complete and has been left alone for 30
   s, ends the loop: `stoppedAt`, `reason: "restart"`, pipe released, successor started (`src/ops/successor.ts`), or
   exit 75 on macOS for launchd. `status` and `doctor` flag a watcher still on another version after it had a cycle to
   notice, and a restart with no successor after 20 minutes.
4. **Stop.** A stop request, Ctrl+C or the end of the process: the current cycle finishes, the heartbeat gets
   `stoppedAt`, the token file is removed.

### Stopping the watcher

`stopWatcher` (`src/ops/watcherControl.ts`), used by `schedule install --watch`, `remove`, `restart` and the update
engine:

1. **Ask it.** One line `stop <token>` over the endpoint, with the token from `watcher.token`. The watcher answers `ok`,
   finishes its cycle and exits. t3sm waits up to 30 s for the endpoint to be free.
2. **Only then, a verified pid.** If the request is not answered (a 0.2.1 watcher closes the connection without a reply,
   so it skips the wait) or the endpoint stays busy, t3sm reads the heartbeat's pid and kills it only if the process
   is alive, is not pid 0/1 or t3sm itself, its command line is `[conhost] node [flags] <t3sm|t3sm.mjs> sync ... --watch`
   (`isT3smWatcher`), and it started within 2 s after, or 2 minutes before, the heartbeat's `startedAt` (the guard
   against a reused pid). Never by image name or pattern.
3. **Report the truth.** A final probe of the endpoint decides `running`; `schedule remove` exits 1 with the pid when a
   watcher is still running.

### Updates

`src/ops/updater.ts` is the engine; `t3sm update` and the watcher's daily check (`src/ops/autoUpdate.ts`) drive it.

- **Source.** GitHub (`git ls-remote --tags --refs https://github.com/<repo>.git`, `npm view` when git fails: t3sm's
  only network calls besides the npm install itself and the optional plugin install through `claude plugin`) or a checkout on this computer (`git tag --merged main --list "v*"`, `master` when there
  is no `main`; a network path is refused). The source is remembered in `<state>/update.json` once an install from it
  went through; `update --from` / `--source github` choose it.
- **Which release.** The newest `vX.Y.Z` strictly newer than the installed version: never a downgrade. The daily check
  also leaves out the versions in the `skip` list (versions that were rolled back); a manual `t3sm update` can install
  one on purpose (`update --check` marks it). The daily check (every 24 h, an hour later after a failed lookup) installs a
  patch or minor release when `update.auto` is on; a major one is only announced (`available`, one notification per
  version). It runs the install in a separate hidden `t3sm update --auto-run --yes`, because the update stops the watcher.
- **Install.** Under the lock: journal `update` `pending`, write `update.pending.json` (the attempt, with how to
  reinstall the previous version), then `npm install -g --install-links github:<repo>#vX.Y.Z` (from a folder:
  `git clone --depth 1 --branch vX.Y.Z file://<folder>` into a temp folder, then `npm install -g --install-links .` in
  it). npm and git never get `CLAUDE_CONFIG_DIR` and git never prompts.
- **Restart and health check.** Stop the watcher (above), start it again (re-registering the scheduled entry), then wait
  up to 2 minutes for a heartbeat of the new version that started after the restart and has not stopped. None: reinstall
  the previous version, restart it, add the bad version to `skip`, outcome `rolled-back`. No watcher installed: nothing
  to check, `installed`.
- **Record.** Every outcome is journaled (`update`: from, to, source, outcome, error); `update.pending.json` is removed
  after the outcome. A watcher that starts and finds an attempt still pending journals it as interrupted;
  `t3sm status` shows a failed or interrupted update as "needs you" until a later one installs; a rolled-back one (the
  previous version runs again: t3sm recovered by itself) and a recent installed one as "worth knowing".
- **Never by itself:** a git checkout (it says to `git pull`) or the `npx` cache.

## Compatibility with T3 Code nightlies

`src/t3/compat.ts` lists the versions t3sm was tested against. t3sm does not refuse an untested T3 Code version: one not in the
list (same minor or not) prints one warning and proceeds, and `--allow-untested` only hides that warning. The only
version refusal is a server whose orchestration protocol is not 2 (exit 4). Every RPC response is decoded strictly
(`src/t3/decode.ts`): an unknown shape aborts with exit 4 before the first write, which is the real protection. Two
values a newer T3 Code may extend are read leniently, so they never stop an import: a thread's `settledOverride` that
t3sm does not know (organize plans nothing for that thread) and an auto-settle value outside 1..90 (organize neither
offers nor makes a change to that setting).

## State folder

```
~/.t3code-session-manager/          (T3SM_HOME)
  config.json                       optional settings (configuration.md)
  journal.jsonl                     every change, append-only
  lock                              one run at a time
  runs/<runId>/plan.json, plan.md   each plan
  cache/                            discovery caches, merge verdicts, stripped OpenCode copies
  logs/sync.log                     one line per sync cycle (rotated at 1 MiB, 3 kept)
  sync-status.json                  watcher heartbeat, what needs you, held projects
  watcher.token                     the running watcher's stop token (owner-only; removed when it stops)
  update.json                       update source, last check, previous version, skipped versions
  update.pending.json               an update in progress, or one that was interrupted
  schedule/                         the Windows task definition, when installed
```
