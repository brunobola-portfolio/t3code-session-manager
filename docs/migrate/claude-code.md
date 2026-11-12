# From Claude Code

[Português](claude-code.pt.md) · Status: ✅ verified live ([harnesses.md](../harnesses.md))

For sessions you ran with `claude` in a terminal or with the Claude Code extension in VS Code, in one account or
several. `t3sm` below is `npx -y github:brunobola-portfolio/t3code-session-manager#v0.1.0`, or the installed command.

## What gets imported

- Every session in `<account home>/projects/`, whatever its age, as a T3 Code thread that resumes the original
  session (T3 Code's own Claude importer does the import).
- Each session into the instance of the account folder it lives in. Accounts are found from `~/.claude` and
  `~/.claude-*` folders, aliases and functions in your shell profile that set `CLAUDE_CONFIG_DIR`, and the VS Code
  extension's per-project pins (`claudeCode.environmentVariables` in `.vscode/settings.json`). More than one account:
  [multiple-accounts.md](multiple-accounts.md).
- Sub-agent transcripts show inside their parent session, not as threads.

## What does not

- Sessions whose folder no longer exists (`cwd-missing`), sessions with a non-UUID id or only hidden records, files
  written in the last 10 minutes (they come with the next run), copies in `.bak` folders and mirror copies of a
  session kept in another account. `plan.md` lists each one with its reason.
- Tool activity (commands run, files edited) in the timeline: T3 Code imports the conversation text. Only the last 200
  visible messages show; resuming uses everything.

## Commands

```bash
t3sm doctor
t3sm plan                         # read the plan.md it names
t3sm quarantine --dry-run         # if doctor reports backup folders
t3sm apply --dry-run              # what apply would do; writes nothing
t3sm apply --only C:/work/demo    # optional pilot on one project
t3sm apply
```

## Verify

In T3 Code, open a project from the plan: its sessions are threads. Send a message in one; it continues the session
with its full context. `t3sm plan` again shows them as `already-in-t3`.

## Undo

`t3sm runs`, then `t3sm rollback --run <id>`. Your transcripts were never edited; rollback restores project defaults
and moves quarantined folders back. Imported threads are listed; archive them with `--archive-threads` or delete them
in T3 Code.
