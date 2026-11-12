# Several Claude accounts

[Português](multiple-accounts.pt.md) · Status: ✅ verified live with two accounts ([accounts.md](../accounts.md))

For when you use two or more Claude subscriptions on one machine, each in its own config folder: for example
`~/.claude` (personal) and `~/.claude-work` (work), with an alias or function that sets `CLAUDE_CONFIG_DIR`, or VS
Code projects pinned to one of them. `t3sm` below is
`npx -y github:brunobola-portfolio/t3code-session-manager#v0.1.0`, or the installed command.

## What you get

- One T3 Code instance per account, with its own name and colour in the model picker. T3 Code's default instance
  stays on `~/.claude`; t3sm pins it there so a stray `CLAUDE_CONFIG_DIR` cannot move it.
- Every session imported into the account it was run with. A session that exists in both accounts is compared:
  identical or older copies become one thread, real forks become two.
- A default account per project (route, VS Code pin, most recent session, `defaultAccount`), so new threads open on
  the right subscription.

## What it does not do

- Move a thread to another account: a thread stays on the account its session ran with. Start a new thread and pick
  the other account in the composer.
- Sign anything in. Each folder keeps its own login; `t3sm accounts` shows the email of each instance (masked;
  `--show-emails` for the full address) and warns when two share one.

## Commands

```bash
t3sm accounts                   # what was found, where, and which instance exists
t3sm accounts --init            # write config.json; set displayName and accentColor there
t3sm plan                       # check the Project accounts table in plan.md
t3sm dedupe --dry-run           # if the plan lists mirror copies
t3sm dedupe
t3sm apply                      # creates the missing instances, then imports
t3sm accounts --rename claude-work "Claude · Work" --color "#6A42C9"
```

To put a project on the other account, add a route to `~/.t3code-session-manager/config.json` and plan again:

```json
"routes": [{ "match": "C:/work/clients/**", "account": "claude-work" }]
```

## Verify

`t3sm doctor`: `instances` says each account has its own instance, `instance-accounts` shows a different email per
instance, `instance-home-drift` says `claudeAgent reads ~/.claude` and `instance-unpinned` says it has an explicit
home (the first `apply` sets it). In T3 Code the picker shows both accounts,
and a new thread in a work project starts on the work account.

## Undo

`t3sm rollback --run <id>` restores project defaults and moves deduplicated copies back. Instances it created are
listed, not removed (`--instances` restores names, colours and folders it changed); remove an instance in T3 Code's
settings if you no longer want it.
