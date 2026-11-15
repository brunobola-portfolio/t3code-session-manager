---
description: Show whether t3sm needs anything from you (decisions, the background watcher, updates, held projects, last sync, plugin). Read-only.
---

Tell the user, in plain words, whether t3sm needs anything from them. This command only reads; it never writes.

1. Run the read-only command and show its output to the user:
   - Bash: `env -u CLAUDE_CONFIG_DIR t3sm status`
   - PowerShell: `Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; t3sm status`

   Always run t3sm with `CLAUDE_CONFIG_DIR` removed, as above: t3sm reads every Claude account itself, and this
   conversation's own account folder must not leak into it. If `t3sm` is not installed, use the pinned release
   described in the `t3code-sessions` skill instead.
   Exit code 10 means "something needs you", not an error: read the output as usual. Only another non-zero code
   (1, 2) is a failure of the command itself.
2. Explain what it says in two or three short sentences. The first line is the level: "All good", "Needs you (N)"
   or "Working" (a t3sm run is in progress). For each item that needs the user, say what it is and quote the
   command shown under it (the line starting with `›`, or `>` in a plain console); for a conversation continued
   twice, say what it says (continue the one they want in T3 Code, archive the other). Mention the "Worth knowing"
   lines only briefly. If the user asks what an item means, `t3sm help <topic>` (read-only; `t3sm help` lists the
   topics) explains it in their language.
3. Do not run any command that writes (`sync` without `--dry-run`, `organize`, `apply`, `rollback`, ...) from here.
   If the user wants one, point them to `/t3sm:sync`, `/t3sm:organize` or `/t3sm:import`. A writing command runs
   only after the user says yes to that exact command, in this conversation.
