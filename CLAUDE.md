@AGENTS.md

# Claude Code specifics

Everything above applies. This part covers only what is different when you work here as Claude Code.

## The skill and the plugin

- `skills/t3code-sessions/SKILL.md` is the skill users install; `.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json` publish it as the plugin `t3sm`. Their versions move with `package.json`
  (`npm run release:check` compares them).
- When you add, rename or remove a command or flag, update the skill's lists of writing and read-only commands in
  the same change. The skill must never run a writing command without the user's yes to that exact command.

## Your shell and the live tests

- Your Bash tool inherits Claude Code's environment, which holds `CLAUDE_CONFIG_DIR` when Claude Code was started
  for a non-default account. Run tests and the CLI with it removed. Bash: `env -u CLAUDE_CONFIG_DIR npm test`.
  PowerShell: `Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; npm test`. A child process you
  start (`claude`, `t3`, `node`) must never inherit it.
- Never start T3 Code from your shell: it would inherit your environment and read the wrong account. Ask the user
  to open it from the Start menu, Dock or desktop launcher.
- Live tests only after the user says yes, one file at a time. Bash:
  `env -u CLAUDE_CONFIG_DIR T3_E2E=1 node --test --test-timeout=180000 test/e2e/apply.live.test.ts`. PowerShell:
  `Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; $env:T3_E2E=1; node --test --test-timeout=180000 test/e2e/apply.live.test.ts`.
  Tell the user first that the writing ones add and then remove synthetic sessions in their real `~/.claude` and
  T3 Code, and that `convert.live.test.ts` spends a few tokens of their subscription (`claude --resume -p`).

## Ask, every time

- Never dispatch a destructive or writing action (a t3sm writing command, a live test, `git push`, a tag, deleting
  files outside a temp folder) without the user's explicit yes in this conversation. A yes covers that one action.

## Subagents

- Put the never-do rules in every brief: no killing processes by image name or pattern, only PIDs the subagent
  started (a hung test: kill its own process tree); no writes to real agent folders or a real T3 Code.
- When several agents share this checkout, each stages its own files by explicit path and commits only those. Do
  not run `npm ci`, `git stash`, `git checkout -- .` or `git reset` there: they disturb the others' work.

## Design history

Design context lives in [docs/architecture.md](docs/architecture.md) and [docs/spikes/](docs/spikes/).
