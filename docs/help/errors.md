# Errors: when a t3sm command stops

## What it means

The command stopped and says what happened. Nothing is left half done: file times are restored, and every change
made so far is journaled and can be undone with `t3sm rollback --run <id>`.

## The common ones

- T3 Code is not running (exit 3): open it from the Start menu or your launcher, then run the command again.
- Lost contact with T3 Code (exit 3): it closed or stopped answering; open it and run the command again.
- T3 Code answered in a way t3sm does not know (exit 4): nothing was changed; update t3sm with `t3sm update`.
- A usage or configuration problem (exit 2): do what the message says. A command that writes needs `--yes` when it
  does not run in a terminal.
- Another t3sm run is in progress (exit 0): wait for it; `t3sm status` shows what runs.

## What to do

Run `t3sm doctor`: it checks everything t3sm needs and says what to fix. For an issue report, add the output of
`t3sm doctor --json` (emails are masked and your home folder is shown as ~; read it before you share it).
