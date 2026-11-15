# Troubleshooting

t3sm explains its own messages, in English or European Portuguese: every screen that shows a problem names the
`t3sm help <topic>` that explains it, and `t3sm help` lists the topics. They ship with t3sm (`docs/help/` in the
repository, `dist/help/` in the installed package), so they always match the installed version. This page is the
index of those topics, then a reference for `t3sm doctor`'s checks, the common messages and the exit codes.

Start with `t3sm doctor`. It prints one row per check, then every warning and failure in full with what to do, and
exits 1 when a check fails. `t3sm doctor --json` gives the same as JSON for an issue report (always English; emails are
masked and your home folder is shown as `~`, but read it before you paste it).

## Help topics

| Topic | What it explains | English | Portuguese |
| :-- | :-- | :-- | :-- |
| `not-imported` | T3 Code did not take a conversation; what to try | [not-imported.md](help/not-imported.md) | [not-imported.pt.md](help/not-imported.pt.md) |
| `cwd-unreadable` | T3 Code cannot see the folder a conversation ran in | [cwd-unreadable.md](help/cwd-unreadable.md) | [cwd-unreadable.pt.md](help/cwd-unreadable.pt.md) |
| `instance-unavailable` | The conversation's account (or agent) is off in T3 Code | [instance-unavailable.md](help/instance-unavailable.md) | [instance-unavailable.pt.md](help/instance-unavailable.pt.md) |
| `project-mismatch` | T3 Code filed a conversation under another project | [project-mismatch.md](help/project-mismatch.md) | [project-mismatch.pt.md](help/project-mismatch.pt.md) |
| `convert` | OpenCode and compressed Codex sessions, and why a conversion fails | [convert.md](help/convert.md) | [convert.pt.md](help/convert.pt.md) |
| `held` | A project waits while one of its conversations is in use | [held.md](help/held.md) | [held.pt.md](help/held.pt.md) |
| `decisions` | Conversations that wait for your answer in `t3sm start` | [decisions.md](help/decisions.md) | [decisions.pt.md](help/decisions.pt.md) |
| `orphaned` | Conversations you deleted in T3 Code: copied back after your yes, or left out | [orphaned.md](help/orphaned.md) | [orphaned.pt.md](help/orphaned.pt.md) |
| `t3-native` | Conversations started in T3 Code that t3sm never copies | [t3-native.md](help/t3-native.md) | [t3-native.pt.md](help/t3-native.pt.md) |
| `history` | Which conversations stay shown in each project, and how to change it | [history.md](help/history.md) | [history.pt.md](help/history.pt.md) |
| `watcher` | The background sync that is not running or late | [watcher.md](help/watcher.md) | [watcher.pt.md](help/watcher.pt.md) |
| `updates` | How t3sm updates itself, and when an update fails | [updates.md](help/updates.md) | [updates.pt.md](help/updates.pt.md) |
| `errors` | When a command stops: the common errors and their exit codes | [errors.md](help/errors.md) | [errors.pt.md](help/errors.pt.md) |

A new topic is a pair of files in `docs/help/` (English, and the `.pt.md` twin) plus its name in `HELP_TOPICS`
(`src/cli/helpTopics.ts`); `test/cli/help.test.ts` checks that every topic a screen can name exists in both languages
and that every command a topic shows exists.

## Doctor checks

Each entry: what you see, why, what to do.

### This machine

**`node-version`** fail: Node is older than 22.18. Install Node 22.18 or newer (`node --version`).

**`state-dir`** fail: the state folder (`~/.t3code-session-manager`, or `T3SM_HOME`) is not writable. Fix its
permissions, or set `T3SM_HOME` to a writable folder.

**`config`** fail: `config.json` is not valid JSON, or a field is wrong; the message names the field. Fix it with
[configuration.md](configuration.md), or delete the file and run `t3sm accounts --init`. `ok` with "no config.json
yet" is normal: commands use the discovered accounts.

**`lock`** warn: another t3sm run has held the lock for a long time, or it is held from another machine (shared state
folder). A lock left by a process that no longer exists, or by a run from before the machine's last restart, is taken
over by the next run on its own (`ok`). If no t3sm command is running, delete the lock file the fix names; never
delete it while a t3sm run is working.

**`pending-mtimes`** warn: a run was interrupted (crash, power cut, killed process) while transcript file times were
moved. Any t3sm command that writes restores them first, or run `t3sm doctor --repair`. Until then a parked
transcript has a time in the future, so `claude --continue` may pick that session as the newest; nothing is deleted.
"edited since (left alone)" means you changed the file after t3sm moved its time, so t3sm keeps your version.
`--repair` does only this: it takes the lock and puts back the file times the journal says are still moved. It is the
only write `doctor` makes.

**`future-mtimes`** warn: transcripts have a file time more than 10 minutes in the future that no interrupted t3sm run
explains (a parked file whose journal entry was lost, or a clock that was wrong when the file was written). T3 Code
skips them, and `claude --continue` may pick them first. t3sm cannot know their real time, so it only lists them; set
each file's modification time back (to its last activity, or to now) when nothing is writing it. `apply` and `sync`
print the count once per run. The check only reads file times (no transcript is opened); warn "could not finish
checking file times in 45 s (N files checked, none in the future so far)" means a very large home ran out of time:
run `doctor` again.

**`claude-env`** warn: this shell sets `CLAUDE_CONFIG_DIR`. Running t3sm from it is fine, but T3 Code started from it
would read that folder as its default account. Start T3 Code from the Start menu or your desktop launcher.

### T3 Code

**`t3-runtime`** fail: there is no usable `~/.t3/userdata/server-runtime.json`. T3 Code never ran as this user, or
not with its server. Open T3 Code once.

**`t3-reachable`** fail: the runtime file exists but nothing answers at that address. Open T3 Code (the file is left
behind when it quits). Commands that need T3 Code exit 3.

**`t3-version`** warn: this T3 Code build is not one t3sm was tested against. Nothing is blocked: commands print
one warning and proceed, every change is journaled and `t3sm rollback` undoes it, and responses are still checked
strictly (an unexpected shape stops before any write, exit 4). Pass `--allow-untested` to hide the warning.

**`t3-cli`** fail: T3 Code's `t3` command is not in `~/.t3/bin` or on `PATH`. Reinstall T3 Code, or add `~/.t3/bin`
to `PATH`. t3sm uses it only to get a short-lived session token.

**`t3-token`** fail: t3sm could not get a read-only session from T3 Code. Usually T3 Code is still starting or was
just updated: wait a minute and run `doctor` again. If it persists, run `t3 auth session issue --token-only` yourself
to see T3 Code's error. `doctor` revokes its session before it exits.

**`instances`** fail: two T3 Code instances read the same account folder. Keep one per folder: remove the extra
instance in T3 Code's settings (Providers). warn "no T3 instance for …": an account has no instance yet; run
`t3sm accounts --apply`, or let `t3sm apply` create it.

**`instance-home-drift`** fail: T3 Code's default instance (`claudeAgent`) reads another folder than `~/.claude`
(the account whose home is `~/.claude` in `config.json`, whatever its id), because T3 Code was started from a shell
with `CLAUDE_CONFIG_DIR` set. `plan`, `apply` and `sync` refuse to run (exit 2) rather than import into the wrong
account. Without a `~/.claude` account in `config.json` they refuse too when the default instance, not set in T3
Code's settings, reads another configured account's folder (it would stand in for that account). Close T3 Code and open it from the Start menu or your launcher. "configured to read …": the folder is set
in T3 Code's settings, so a restart does not change it; change it in T3 Code settings (Providers), or run
`t3sm accounts --apply` (it sets `~/.claude` back, journaled; `t3sm rollback --instances` undoes it).

**`instance-unpinned`** warn: T3 Code's default instance (`claudeAgent`) has no folder set in T3 Code's settings, so a
T3 Code started from a shell with `CLAUDE_CONFIG_DIR` would read another account. Run `t3sm accounts --apply`; the
next `t3sm apply` also pins it to `~/.claude` (shown in its confirmation). `sync` never changes it.

**`instance-accounts`** warn: two instances are signed in to the same email (one subscription for both), or an
instance is signed out or unavailable. Sign the folder in to the right account: run `claude` with
`CLAUDE_CONFIG_DIR` set to that folder and use `/login`, or sign in from T3 Code.

### Accounts on disk

**`accounts-undiscovered`** warn: an account folder was found (by folder name, shell alias, VS Code pin, the
current shell or a T3 instance) but is not in `config.json`. Add it, or rewrite the file with
`t3sm accounts --init --force`. Its sessions are not planned until then.

**`backups-present`** warn: backup folders (`.bak`, `.bak-YYYYMMDD-HHMMSS`) inside `projects/`. T3 Code reads them as
projects, so they can show up as duplicates. `t3sm quarantine --dry-run`, then `t3sm quarantine` (reversible).

**`quarantine-orphans`** warn: something sits in `session-manager-quarantine/` that the journal does not know (moved
by hand, or the journal was deleted). `rollback` cannot move it back; check it by hand.

### Agents

**`harness:claude`, `harness:codex`, `harness:pi`, `harness:opencode`**:

- "sessions found but T3 Code has no codex (or pi) instance": those sessions are skipped. Enable Codex or Pi in T3
  Code's settings (Providers), then `t3sm plan` again.
- "storage format changed: …": the agent's storage no longer has what the adapter reads (a newer or older version).
  Nothing of it is converted; check for a t3sm update and [harnesses.md](harnesses.md) for the tested version.
- "present but unreadable: …": the storage exists but could not be read (permissions, a locked file). Try again with
  the agent closed.
- "codex-cli … · N importable natively, M convertible (compressed), K skipped", sometimes followed by ", E read
  errors" and "; I already in T3 Code": Codex CLI 0.167 and later compress older sessions (`.jsonl.zst`), which
  T3 Code cannot read; t3sm converts them into Claude threads (the M). The K skipped are duplicate files of one
  session, sub-agents, sessions with no id or folder, files over 512 MiB decompressed, or every compressed one when
  `codex.convertCompressed` is `false`. Read errors (a warning) are files or folders that could not be read completely
  (corrupt or cut short); `t3sm scan` counts them too. "Already in T3 Code" (when T3 Code is reachable) counts a
  session under either form, Codex thread or converted Claude thread. Without an enabled Codex instance in T3 Code the
  line also says the N native sessions will be skipped (converted ones do not need it). See
  [harnesses.md](harnesses.md#codex-cli-native).

### Background sync

**`schedule`** warn "its command points at … which no longer exists": the scheduled task runs a t3sm that has moved
or was removed (common after an `npx` cache cleanup). Install the `t3sm` command
(`npm install -g --install-links github:brunobola-portfolio/t3code-session-manager#v0.3.0`) and run `t3sm schedule install` again.

**`sync-watcher`** warn: the watcher's process is gone without a clean stop, it stopped reporting, it still runs
another t3sm version than the one installed (after it had a cycle to notice), or it stopped to restart into a new
install and no new watcher followed within 20 minutes. `t3sm schedule restart` stops it safely (its own endpoint, then
a verified process id, never by name) and starts it again; with nothing installed, `t3sm schedule install --watch`.
`t3sm help watcher` explains it.

**Updates.** `t3sm status` says it needs you when an update did not go through: "Updating t3sm from X to Y failed; X is
still installed" or "The update of t3sm from X to Y was interrupted". An update that was rolled back (no healthy
heartbeat of Y within 2 minutes, so X was reinstalled and runs again) is only worth knowing: "t3sm Y was rolled back; X
is running (the automatic check skips Y)". `t3sm update` can still install Y on purpose. `t3sm update --check` shows the installed and newest versions, the last check, and how to go back
after an interrupted update; `t3sm help updates` explains each case. Offline, the daily check just tries again later.

**`merge-pending`** warn: sessions were continued in a terminal after t3sm imported them, and T3 Code does not show
that work. `t3sm merge` lists them; `t3sm merge --all` brings them in (reversible with `t3sm rollback`).

A check that takes too long (10 s each; 45 s for `future-mtimes`, 30 s for the agent listing) or cannot run is a `warn`
("did not finish within … s"), not a problem to fix: run `doctor` again. Only the checks that block t3sm (`node-version`,
`state-dir`, `config`, the T3 Code checks and `instance-home-drift`) report it as `fail`.

## Common messages

| Message | What to do |
| :-- | :-- |
| `T3 Code is not running. Open it from the Start menu and try again.` (exit 3) | Open T3 Code, wait until its window is up, run the command again |
| `Warning: T3 Code … has not been tested with t3sm (tested: …). Proceeding; …` | Only a warning, the command continues. Update t3sm when a release lists your version, or pass `--allow-untested` to hide it |
| `T3 Code … speaks orchestration protocol N; t3sm needs protocol 2.` (exit 4) | This T3 Code is incompatible; update t3sm |
| `Plan is stale; run t3sm plan again.` (exit 2) | The plan is older than 24 hours; plan again |
| `T3 Code changed from X to Y since the plan. Plan is stale; …` (exit 2) | T3 Code was updated after the plan; plan again |
| `Refusing to roll back without naming the run: pass --run <id> with --yes` (exit 2) | `t3sm runs` lists the runs; pass the one you mean, so a scheduled `sync` is never undone by mistake |
| `The system clock jumped during an import (sleep or a time change)` | The machine slept or its clock changed mid-wave. That wave stopped (file times restored) and its sessions wait for the next run (`clock-jump`). Keep the machine awake |
| `Warning: N transcripts have a file time more than 10 minutes in the future …` | See `future-mtimes` above |
| `Warning: <project>: its sessions and the copies parked while it imports cost … MiB` | That project's transcripts are large where T3 Code looks for their folder; it imports alone, and a session T3 Code could not read in the budget fails as `not-imported` and is retried |
| `Lost contact with T3 Code (…)` (exit 3) | T3 Code closed or stopped answering mid-run. File times are restored; open T3 Code and run the command again |
| `Another t3sm run is in progress.` (exit 0) | Wait for it (a scheduled `sync`, for example); `t3sm schedule status` shows the last cycle |
| A writing command exits 2 without asking | It ran without a terminal (a script, an agent). Run it in a terminal to answer the prompt, or add `--yes` once you have read the plan |
| `this filesystem cannot hard-link (…); not moved` | `dedupe`, `quarantine` and conversions need hard links. Move the state folder or the account folder off exFAT/FAT32 or a network share without them |
| `N sessions pending; run t3sm apply once to import them.` from `sync` | More than `sync.maxUnattendedImports` (200) sessions wait. Do the big import by hand: `t3sm plan`, read it, `t3sm apply` |
| `waiting: <project> — '<conversation>' written N min ago; retried after 10 min idle` | That conversation of the project was written in the last 10 minutes, so its sessions wait (the project itself is already in T3 Code, empty). Close it or wait, then run again; `sync` retries on its own |
| `Held (a session is in use): …` | A file of that project stayed locked or was in use. Close it or wait, then run again |
| `deferred N (in use, changed or locked; next run)` | Those sessions changed since the plan, are in use, or a file of their project stayed locked by another program (antivirus, OneDrive: `file-busy`). The next run retries them |
| `Interrupted: file times restored, no further waves started.` (exit 130) | Run `t3sm apply` again to continue |
| `Could not verify imports with T3 Code; stopped.` (exit 5) | T3 Code stopped answering after a wave. Run `t3sm plan` and `t3sm apply` again |

## Sessions that failed to import (exit 5)

`apply` and `sync` list each conversation that could not be imported: its project and title, why and what to do, then
the `t3sm help` topics that explain the reasons (`not-imported`, `cwd-unreadable`, `instance-unavailable`,
`project-mismatch`, `convert`; see the table above). The next run retries them once they change.

Skipped sessions (`plan.md`, "Skipped by reason") are not failures: each reason is explained there. Two warnings in
`plan.md` are worth reading: sessions **already in T3 Code under another account** are never imported a second time
(archive that thread in T3 Code and plan again if its account is wrong), and sessions **whose file name differs from
the session id inside** are imported under the id inside, as T3 Code does.

## Exit codes

`0` done, nothing to do, declined, or another run holds the lock; `1` unexpected error, a failed doctor check, an update
that failed or was rolled back, or `schedule install --watch`, `restart` or `remove` that could not stop the running
watcher;
`2` usage or config error, a writing command without `--yes` on a non-terminal, a plan refused as stale, or T3 Code's
default instance reading another account folder (`instance-home-drift`); `3` T3 Code not running, or lost mid-run; `4`
T3 Code speaking another protocol, or an unexpected response; `5` finished with per-session failures; `10` (`t3sm status` only) something needs you, not an error; `130` interrupted.

## Still stuck

Open an issue with the output of `t3sm status --json` and `t3sm doctor --json` (checked for anything private), the
command you ran and its output, and, for the background sync, the last lines of `~/.t3code-session-manager/logs/sync.log`
(counts and run ids only). Never paste conversation content. Security problems: [SECURITY.md](../SECURITY.md).
