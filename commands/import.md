---
description: Bring old Claude Code, Codex, Pi and OpenCode history into T3 Code: plan, review, then import after a yes.
---

Import the user's existing agent sessions into T3 Code as resumable threads, each under the Claude account it was
run with. Review first, write only after a yes.

1. Run the read-only form (it changes nothing in T3 Code or in your sessions; it only saves the plan in t3sm's own folder) and show the result to the user:
   - Bash: `env -u CLAUDE_CONFIG_DIR t3sm plan`
   - PowerShell: `Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; t3sm plan`

   Always run t3sm with `CLAUDE_CONFIG_DIR` removed, as above: t3sm reads every Claude account itself. If `t3sm` is not installed, use the pinned release described in the `t3code-sessions` skill instead. Exit code 3
   means T3 Code is not running: ask the user to open it from the Start menu or their launcher.
2. Read the `plan.md` it names and tell the user, briefly: the totals (import, convert, skip), the new projects,
   which account each project opens with, and every warning. Ask whether any project is under the wrong account.
3. Run the dry run of the import (it changes nothing in T3 Code or in your sessions; it only takes t3sm's lock for a moment, so no need to ask) and summarise it:
   `env -u CLAUDE_CONFIG_DIR t3sm apply --dry-run` (PowerShell: remove `CLAUDE_CONFIG_DIR` first, as above).
4. Mention the one limit that comes from where this runs: this T3 Code conversation is "in use", so t3sm leaves its
   own project for the next cycle. To import that project too, run `/t3sm:import` from a conversation in the
   General project, or later when this one is idle.
5. Ask the user whether to go ahead, and offer to try one project first (`--only <project folder>`). Run the writing
   form only after the user says yes to that exact command, in this conversation:
   - Bash: `env -u CLAUDE_CONFIG_DIR t3sm apply --yes`
   - PowerShell: `Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; t3sm apply --yes`

   `--yes` is needed because this shell is not a terminal; add it only after that yes. Exit 0 is success; exit 5
   means some sessions failed and stay retryable: a table names each one's project, why and what to do, then the
   `t3sm help <topic>` that explains the reason (read-only; run it if the user wants to know more). Report the run id
   (undo: `t3sm rollback --run <id> --archive-threads`, dry run first).
6. Suggest `/t3sm:organize` afterwards to tidy what was imported.
