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
npx -y github:brunobola-portfolio/t3code-session-manager#v0.1.0 <command>
```

Below, `t3sm` means whichever of the two works. T3 Code must be open (exit code 3 means
it is not running: ask the user to open it from the Start menu or their desktop launcher,
never from a shell that sets `CLAUDE_CONFIG_DIR`).

## The rule that matters most

These commands change files or T3 Code: `apply`, `dedupe`, `quarantine`, `merge --all`,
`merge --session <id>`, `rollback`, `accounts --apply`, `accounts --rename`,
`accounts --init`, `schedule install`, `schedule remove`, `sync` (without `--dry-run`),
`doctor --repair` and `update` (reinstalls t3sm itself with npm).

- Run them only after the user has said yes, in this conversation, to that exact command.
  A yes to an earlier command or to a plan "in general" is not a yes to the next one.
- Your shell is not a terminal, so they need `--yes` to proceed. Add `--yes` only after
  that explicit yes. Never add `--allow-untested` unless the user agrees after you have
  explained exit code 4.
- Before `dedupe`, `quarantine` or `rollback`, run the same command with `--dry-run` and
  show the user what would move or be undone.

Read-only, safe to run without asking: `doctor`, `scan`, `plan`, `apply --dry-run`,
`accounts` (no option; emails are masked, do not add `--show-emails` unless asked), `runs`, `merge` (no option) or `merge --dry-run`, `sync --dry-run`,
`schedule status`, `update --dry-run`, every `--help`.

## Workflow

1. **Check.** Run `t3sm doctor`. Report each `fail` and `warn` line with its `->` fix in
   plain words. Stop on a `fail` and help fix it first. Common ones:
   `instance-home-drift` (T3 Code was started from a shell with `CLAUDE_CONFIG_DIR`: close
   it and open it from the Start menu), `t3-version` (untested T3 Code build),
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
   failed (they are listed and stay retryable). Report the run id it prints.
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
version not tested (or an unexpected response shape); `5` finished, but some sessions
failed. `130` interrupted (file times were restored).

More: the project README and `docs/` (configuration, accounts, troubleshooting).
