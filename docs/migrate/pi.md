# From Pi

[Português](pi.pt.md) · Status: 🟡 verified with fixtures ([harnesses.md](../harnesses.md#pi-native))

`t3sm` is the command you install once ([install.md](../install.md)); `t3sm update` keeps it current.

## What gets imported

- Pi sessions from `PI_CODING_AGENT_SESSION_DIR`, else `<PI_CODING_AGENT_DIR>/sessions`, else `~/.pi/agent/sessions`,
  whatever their age, into T3 Code's Pi instance, by T3 Code's own Pi importer.
- Discovery was verified on real files, and every case is covered by synthetic fixtures. A live import has **not**
  been run: the T3 Code used for testing had no Pi instance.

## What does not

- Anything, while T3 Code has no enabled Pi instance: the sessions are skipped as `harness-unavailable`, and `doctor`
  warns on `harness:pi`. Enable Pi in T3 Code's settings, under providers (see
  [T3 Code's documentation](https://github.com/pingdotgg/t3code/tree/main/docs/user)), then plan again.
- Sessions without a working folder or with only hidden records.

## Commands

```bash
t3sm doctor        # harness:pi: "sessions found", without the missing-instance warning
t3sm plan
t3sm apply --dry-run   # what apply would do; writes nothing
t3sm apply
```

## Verify

`plan.md` counts the Pi sessions under the `pi` harness; after `apply` they are threads of their projects in T3 Code.

## Undo

`t3sm rollback --run <id>` lists the imported threads (`--archive-threads` archives them). Pi's files are never
written.
