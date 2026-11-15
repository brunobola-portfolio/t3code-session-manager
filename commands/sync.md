---
description: Import the agent sessions that are new since the last sync into T3 Code, after showing what would change.
---

Bring new Claude Code, Codex, Pi and OpenCode sessions into T3 Code. Review first, write only after a yes.

1. Run the read-only form (a dry run: it changes nothing in T3 Code or in your sessions) and show the output to the user:
   - Bash: `env -u CLAUDE_CONFIG_DIR t3sm sync --dry-run`
   - PowerShell: `Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; t3sm sync --dry-run`

   Always run t3sm with `CLAUDE_CONFIG_DIR` removed, as above: t3sm reads every Claude account itself. If `t3sm` is not installed, use the pinned release described in the `t3code-sessions` skill instead. Exit code 3
   means T3 Code is not running: ask the user to open it from the Start menu or their launcher, not from a shell
   that sets `CLAUDE_CONFIG_DIR`.
2. Summarise it briefly: how many sessions would be imported, which projects they go to, and anything it holds back.
3. Mention the one limit that comes from where this runs: this T3 Code conversation is "in use", so t3sm leaves its
   own project for the next cycle (it is retried once the conversation has been idle for about ten minutes). To
   bring that project in too, run `/t3sm:sync` from a conversation in the General project.
4. Ask the user whether to go ahead. Run the writing form only after the user says yes to that exact command, in
   this conversation (a yes to an earlier question does not count):
   - Bash: `env -u CLAUDE_CONFIG_DIR t3sm sync`
   - PowerShell: `Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; t3sm sync`

   `sync` is the unattended command: it never asks and takes no `--yes` (it refuses an option it does not know), so
   the user's yes here is the only confirmation. Report the run id it prints and say it can be undone with
   `t3sm rollback --run <id>` (dry run first). If some conversations could not be imported, the output names the
   `t3sm help <topic>` that explains each reason; run that (read-only) and summarise it.
