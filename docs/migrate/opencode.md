# From OpenCode

[Português](opencode.pt.md) · Status: ✅ verified live with OpenCode 1.19.5 ([harnesses.md](../harnesses.md#opencode-convert-mode))

T3 Code cannot read OpenCode's sessions, so t3sm **converts** them into Claude Code sessions and T3 Code imports
those. A converted session continues in Claude (in T3 Code, or with `claude --resume <id>`), not in OpenCode.
`t3sm` below is `npx -y github:brunobola-portfolio/t3code-session-manager#v0.1.0`, or the installed command.

## What gets imported

- Every OpenCode session with at least one message, from `$XDG_DATA_HOME/opencode/opencode.db` (default
  `~/.local/share/opencode/opencode.db`, also on Windows).
- The conversation text. Tool calls become one line each, `[tool <name>] <input> → <output>` (clipped to 500
  characters); attachments become `[attachment: <name>]`.
- Each session goes to the account of its project (the project-account rules in [accounts.md](../accounts.md)), as
  `<account home>/projects/<encoded folder>/<uuid>.jsonl`.

## What does not

- Reasoning, step markers, patches and snapshots; the contents of attached files.
- Sub-agent sessions, sessions without a folder or without a real user message, and sessions updated in the last
  10 minutes (next run).
- OpenCode's database itself is never opened: t3sm copies it, keeps only the conversation tables in a private copy
  under `~/.t3code-session-manager/cache/opencode/` (no account tokens or credentials), and reads that.

## Commands

```bash
t3sm doctor        # harness:opencode: "sessions found; opencode <version>"
t3sm plan          # the summary counts them under "Convert + import"
t3sm apply --dry-run   # what apply would do; writes nothing
t3sm apply
```

## Verify

In T3 Code the sessions are Claude threads in their projects, titled from their first message. In a terminal, from
the project folder, `claude --resume` lists them too.

## Undo

`t3sm rollback --run <id>` deletes the converted files that are unchanged since (one you continued is kept and
listed) and lists the imported threads. OpenCode's own data was never touched. You can delete
`~/.t3code-session-manager/cache/opencode/` at any time; it is rebuilt when needed.
