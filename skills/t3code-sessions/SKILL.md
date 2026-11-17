---
name: t3code-sessions
description: Use when the user wants to import, sync or merge AI coding-agent sessions (Claude Code, Codex, Pi, OpenCode) into T3 Code, bring old or terminal history into T3 Code threads, pick which Claude account or subscription a T3 Code project or thread uses, or fix T3 Code history that is missing, duplicated, stale or under the wrong account. Also when they mention t3sm or t3code-session-manager.
---

# T3 Code sessions (t3sm)

`t3sm` brings the user's agent sessions into T3 Code as resumable threads, each under
the Claude account it was run with. It reviews before it writes, journals every change
and can undo a run. This skill runs it for the user. It never decides for them.

## How to run t3sm

Use `t3sm` if `t3sm --version` works. Otherwise use the pinned release:

```bash
npx -y github:brunobola-portfolio/t3code-session-manager#v0.4.1 <command>
```

Below, `t3sm` means whichever of the two works. T3 Code must be open (exit code 3 means
it is not running: ask the user to open it from the Start menu or their desktop launcher,
never from a shell that sets `CLAUDE_CONFIG_DIR`).

**Run t3sm with `CLAUDE_CONFIG_DIR` removed.** t3sm reads every Claude account itself, so the
account folder of the conversation you are in must not reach it. Bash:
`env -u CLAUDE_CONFIG_DIR t3sm <command>`. PowerShell:
`Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; t3sm <command>`. A thread
in T3 Code on a second account has its own `CLAUDE_CONFIG_DIR` set, which is why this matters.

Every command takes `--lang en|pt` (the language of what it prints; default: config.json "language",
then the system's) and `--no-color`. Pass `--lang en` when you read the output yourself;
`--json` output is always English.

## Inside T3 Code: the `/t3sm:*` commands

When this plugin is installed, T3 Code's "/" menu offers four short commands, each following
the rules below (read-only form first, then a question, then the write only after a yes):

- `/t3sm:status`: `t3sm status`, whether t3sm needs anything from the user: "All good", "Needs you (N)" with the
  command for each item, or "Working". Read-only. It exits 10 when something needs the user: that is an answer, not
  an error.
- `/t3sm:sync`: `t3sm sync --dry-run`, then `t3sm sync` (the unattended command: it never asks and takes no
  `--yes`; run it only after the user's yes).
- `/t3sm:organize`: `t3sm organize --dry-run`, then `t3sm organize --yes` (tidies the history t3sm
  imported: readable titles, archived automated chats and chats of projects t3sm created in
  temporary or system folders, pinned recent projects; undo with `t3sm organize --undo <run>`).
  Scope flags of `organize`: `--only <folder>`, `--no-pin <ids>`, `--no-delete`,
  `--no-archive-folders` (keeps the temporary / system folder chats unarchived),
  `--history <days|all|off>` and `--min <n>` (the history rule for this run only: the last
  1-3650 days, and at least 0-1000 chats per project) and `--auto-settle <1..90|off>` (changes
  T3 Code's own auto-settle setting); keep the ones of the dry run when you run it with `--yes`.
- `/t3sm:import`: `t3sm plan` and `t3sm apply --dry-run`, then `t3sm apply --yes`.

For `/t3sm:sync` and `/t3sm:import`, the conversation running them is "in use", so t3sm skips
it: that conversation's own project waits for the next cycle (it is retried once the
conversation has been idle for about ten minutes). To bring that project in too, suggest
running the command from a conversation in the General project. With T3 Code closed there are
no threads, so this does not arise. `/t3sm:organize` has no such hold: it may give the running
conversation a new title or show it inside its project.
`t3sm doctor` and `t3sm status` say which Claude accounts have the plugin;
`t3sm start` offers to install it. To remove it:
`claude plugin uninstall t3sm@t3code-session-manager`.

## The rule that matters most

These commands change files or T3 Code: `apply`, `dedupe`, `quarantine`, `merge --all`,
`merge --session <id>`, `recover <session id>`, `rollback`, `accounts --apply`, `accounts --rename`,
`accounts --init`, `schedule install`, `schedule remove`, `schedule restart`, `sync` (without `--dry-run`),
`organize`, `organize --undo`, `projects rename --suggest`, `projects set`, `projects unset`,
`doctor --repair` and `update` without `--check` or `--dry-run` (it reinstalls t3sm itself with npm;
also `update --from <folder>`, `update --source npm` and `update --source github`), and `update --auto on|off` (a preference switch in config.json, like `projects unset`: it needs no `--yes`,
but still ask first).

- Run them only after the user has said yes, in this conversation, to that exact command.
  A yes to an earlier command or to a plan "in general" is not a yes to the next one.
- Your shell is not a terminal, so they need `--yes` to proceed. Add `--yes` only after
  that explicit yes. `--allow-untested` only hides the untested-version warning; add it
  only if the user asks.
- Before `dedupe`, `quarantine`, `recover`, `rollback`, `organize`, `organize --undo` or
  `projects rename --suggest`, run the same command with `--dry-run` and show the user
  what would move, change or be undone.
- `rollback --yes` needs `--run <id>` and `organize --undo --yes` needs the run id
  (`organize --undo <run> --yes`): take it from `t3sm runs` or the dry run, and say which
  run it is.

Read-only, safe to run without asking: `doctor`, `scan`, `stats` (or `stats --json`), `plan` (or `plan --html`), `apply --dry-run`,
`accounts` (no option; emails are masked, do not add `--show-emails` unless asked), `runs`, `status` (or `status --json`), `merge` (no option) or `merge --dry-run`, `recover <session id> --dry-run`, `sync --dry-run`,
`organize --dry-run`, `organize --undo --dry-run`, `projects` (no option),
`projects rename --suggest --dry-run`, `schedule status`, `schedule install|remove|restart --dry-run`, `update --check`, `update --dry-run`, `changelog`
(or `changelog --since <version>`), `help` (or `help <topic>`: what a message means and what to do, in the user's
language), every `--help`. `update --check` and `update --dry-run` look up
the newest release online (t3sm's only network call besides installing a release with npm and the optional plugin
install through `claude plugin`); they install nothing.

## Workflow

1. **Check.** Run `t3sm doctor`. Report each `fail` and `warn` line with its `->` fix in
   plain words. Stop on a `fail` and help fix it first. Common ones:
   `instance-home-drift` (T3 Code was started from a shell with `CLAUDE_CONFIG_DIR`: close
   it and open it from the Start menu), `t3-version` (a warning: this T3 Code build was not tested, t3sm proceeds),
   `backups-present` (suggest `quarantine` later), `harness:pi` without a Pi instance.
2. **Plan.** Run `t3sm plan`. It prints a summary and `Full report: <path>/plan.md`.
   Read that `plan.md` and tell the user, briefly:
   - the totals (import, convert, skip) and the new instances and projects;
   - the **Project accounts** table: each project root, the account it will open with,
     and why (`route`, `vscode-pin`, `recent-activity`, `default`). Ask whether any
     project is under the wrong subscription. A wrong one is fixed with a `routes` entry
     in `config.json` (docs/configuration.md), then a new `t3sm plan`;
   - every line under **Warnings**, and diverged forks if any;
   - the biggest skip reasons, only if they look surprising.
3. **Clean up duplicates (optional, ask).** If the plan lists mirror copies, offer
   `t3sm dedupe` (moves stale copies of a session in a second account to a reversible
   quarantine). If doctor reported backup folders, offer `t3sm quarantine`. Show the
   `--dry-run` first. Both need a file system with hard links.
4. **Dry run (no need to ask).** `t3sm apply --dry-run` runs every check and prints what
   apply would do, writing nothing. Summarise it.
5. **Pilot (recommended, ask).** Offer one project first:
   `t3sm apply --only <project root> --yes`. Then ask the user to open that project in
   T3 Code and check the threads and the account picker.
6. **Apply (ask).** `t3sm apply --yes`. Exit 0 is success; exit 5 means some sessions
   failed (a table names each one's project, conversation, why and what to do, then the
   `t3sm help <topic>` that explains it; they stay retryable). Report the run id it prints.
   One progress bar covers the whole import; `--verbose` (apply and sync) also prints one
   line per import wave.
7. **Keep in sync (optional, ask).** `t3sm schedule install` (every 15 minutes) or
   `t3sm schedule install --watch` (a watcher started at logon). Unattended sync never
   creates instances, never moves files and imports nothing when more than 200
   sessions are pending.
8. **Terminal work.** If the user continued an imported session in a terminal, T3 Code
   does not see those turns. `t3sm merge` lists them (read-only). With a yes,
   `t3sm merge --session <id> --yes` or `t3sm merge --all --yes` creates a new session
   file next to the original, imports it as a new thread and archives the old one.
   Compacted sessions are not merged; terminal work on a side branch is listed with a
   `claude --resume <id>` hint and never merged.
9. **Undo.** `t3sm runs` lists runs. `t3sm rollback --run <id> --dry-run`, then with a
   yes `t3sm rollback --run <id> --yes`. Imported threads are listed, never deleted
   (`--archive-threads` archives them).

## What t3sm does by itself

Tell the user, when it matters, what the background sync (`schedule install --watch`) does without asking, each
change journaled and undone with `t3sm rollback --run <id>`:

- imports new sessions once idle, and organizes only what it just imported;
- applies the history rule (the last 90 days shown inside each project, at least 10 per project; `organize.history`)
  after an import and once a day, never moving a conversation the user changed by hand;
- brings in what the user adds, outside T3 Code, to the original of a home-folder conversation t3sm copied (a new
  thread with the same title; the old one archived);
- once a day, installs a newer patch or minor t3sm release by itself and restarts into it, rolling back if the new
  version does not start within 2 minutes (`update.auto`; `t3sm update --auto off` turns it off); a major release is
  only announced. The release lookup is t3sm's only network call (installing then downloads the release with npm; the
  optional plugin install goes through `claude plugin`). A rolled-back update is only worth knowing in `t3sm status`:
  the previous version runs again, and the automatic check skips that version (`t3sm update` can still install it).

Conversations started in T3 Code are never imported again; one whose thread the user deleted comes back as a copy
only after a yes in `t3sm start` (`organize.sessions.orphaned`). When its transcript names no T3 thread, t3sm cannot
tell that the thread is gone (`t3sm status` lists it under Worth knowing): `t3sm recover <session id>` brings that one
back, after `--dry-run` and the user's yes. Say that if the thread still exists in T3 Code, this makes a duplicate.

## Tell the user about the limits

- T3 Code shows at most 200 visible messages per imported thread; resuming still uses
  the full history.
- Tool activity (commands, file edits) is not in the imported timeline, only the text.
- Imported threads show the import time as their last activity.
- A thread stays on the account its session was run with. To use the other
  subscription, start a new thread in T3 Code and pick it there.
- Never keep the same session open in T3 Code and in a terminal at the same time.

## Exit codes

`0` ok, nothing to do, declined, or another run holds the lock; `1` unexpected error; `2` usage or config error, a
write command without `--yes` on a non-terminal, a stale plan (plan again), or T3 Code's default instance reading
another account folder (`instance-home-drift`: reopen T3 Code from the Start menu); `3` T3 Code not running; `4` T3 Code
speaking another protocol (or an unexpected response shape); `5` finished, but some sessions
failed; `10` (`t3sm status` only) something needs the user, not an error. `130` interrupted (file times were restored).

More: `t3sm help` lists the help topics (a screen that shows a problem names its topic: `t3sm help not-imported`,
`t3sm help held`, ...); the project README and `docs/` (configuration, accounts, troubleshooting).

In a shell run as Administrator (Windows), `start`, `schedule` and `update` print one warning: what they install (the
schedule, the plugin, t3sm itself) is for that user only. Nothing is blocked; suggest running t3sm from the user's own
account unless that is what they want.
