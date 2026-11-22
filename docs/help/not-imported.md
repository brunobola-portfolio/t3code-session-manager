# Not imported: T3 Code did not take a conversation

## What it means

t3sm asked T3 Code to import the conversation, checked twice, and it is not in T3 Code. Nothing was lost: the
session file is where it was, and t3sm put every file time back.

## Why it happens

- The folder recorded in the conversation does not match the project T3 Code opened (a renamed or moved folder).
- The conversation has no message from you that T3 Code can read (only tool output or a summary). A session of bare
  commands with no reply is skipped instead ("nothing to show").
- T3 Code logged an error for it (see its logs in `~/.t3/userdata/logs/`).

## What to do

1. Run `t3sm apply` again: it tries the failed conversations once more.
2. If it fails again, run `t3sm plan` and read `plan.md`: a folder that moved can be mapped with `remap` in
   config.json.
3. `t3sm runs` lists every run and what it imported; the conversation stays retryable.
