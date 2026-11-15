---
description: Tidy the history t3sm imported into T3 Code (the last 90 days shown in each project, readable titles, archive automated chats, pin recent projects), after a preview.
argument-hint: [--only <project folder>]
---

Organize the history t3sm imported into T3 Code. It only touches imported conversations and projects t3sm created
(pinning aside), never a conversation started in T3 Code, and never anything the user changed afterwards. Preview
first, write only after a yes.

1. Run the read-only form (a dry run: it changes nothing in T3 Code or in your sessions) and show the output to the user. If the user gave
   arguments (`$ARGUMENTS`), add them, but only scope options of this command such as `--only <folder>`. Never add `--yes`, `--undo` or any other writing flag from `$ARGUMENTS` to the preview:
   - Bash: `env -u CLAUDE_CONFIG_DIR t3sm organize --dry-run`
   - PowerShell: `Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; t3sm organize --dry-run`

   Always run t3sm with `CLAUDE_CONFIG_DIR` removed, as above: t3sm reads every Claude account itself. If `t3sm` is not installed, use the pinned release described in the `t3code-sessions` skill instead. Exit code 3
   means T3 Code is not running: ask the user to open it from the Start menu or their launcher.
2. Summarise the preview in plain words: one line per kind of change (how many, why), and the projects whose
   sidebar changes most. Say that every change is journaled and can be undone.
3. Say what this means for the conversation you are in. Organize has no "in use" hold (that applies to import and
   sync): it may give this conversation a new title or show it inside its project, like any other imported
   conversation. If the preview lists it, say so before asking.
4. Ask the user whether to go ahead. The writing form is exactly the dry-run command you ran, with `--dry-run`
   replaced by `--yes` (keep `--only` and any other scope flags, so a scoped preview never becomes a run over every
   project). Show that full command to the user and run it only after the user says yes to THAT command, in this
   conversation. With no arguments it is:
   - Bash: `env -u CLAUDE_CONFIG_DIR t3sm organize --yes`
   - PowerShell: `Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; t3sm organize --yes`

   `--yes` is needed because this shell is not a terminal; add it only after that yes. Report the run id.
5. To undo, run the read-only form first and show it:
   - Bash: `env -u CLAUDE_CONFIG_DIR t3sm organize --undo --dry-run`
   - PowerShell: `Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; t3sm organize --undo --dry-run`

   Show the full command (`env -u CLAUDE_CONFIG_DIR t3sm organize --undo <run id> --yes`, with the run id from that
   dry run or from `t3sm runs`) and run it only after the user says yes to that exact command, in this conversation.
   Say which run it is.
